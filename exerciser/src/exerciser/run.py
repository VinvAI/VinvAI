"""The coverage-guided execution loop.

Executes the plan against the LIVE traced service, round by round, choosing which
generation strategy to spend each probe on via the per-endpoint Thompson bandit
(``bandit.py``). After each round the freshly-captured spans are joined onto the
call trees (``coverage.py``) to score newly-covered symbols — the bandit's
reward. The loop stops when ``rounds`` consecutive rounds add no new symbol, or
the probe budget is exhausted.

Every execution is appended to ``results.jsonl`` (endpoint, input, strategy,
status, latency, shape-hash, error); the bandit posteriors land in
``bandit.json``; 5xx/crash/invariant failures cluster into ``issues.json``; and
healthy responses seed / compare the golden behavior baselines.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import state, store
from .bandit import STRATEGIES, EndpointBandit, Outcome, bandit_summary, seed_from_prior
from .baseline import apply_baselines, status_class
from .compaction import compact_artifacts
from .coverage import endpoint_coverage
from .execute import ProbeResult, execute_probe
from .invariants import check_monotonic_sequence, check_observation
from .issues import cluster_failures, clusters_from_baseline, issues_document
from .probe import input_size, probe_id_of
from .redact import is_id_shaped, redact
from .scenario import run_scenario, substitute

# Type of the injected probe executor (real one = execute.execute_probe), so the
# loop is unit-testable against a fake service.
ProbeFn = Callable[..., ProbeResult]
CoverageFn = Callable[..., dict[str, Any]]


@dataclass
class Candidate:
    """One executable input for an endpoint, tagged with its bandit strategy."""

    strategy: str
    provenance: str
    input_class: str
    body: Any
    path_params: dict[str, Any]
    query: dict[str, Any]
    headers: dict[str, str]


def _candidates_for_endpoint(ep: dict[str, Any]) -> dict[str, list[Candidate]]:
    """Group an endpoint plan's inputs by bandit strategy."""
    grouped: dict[str, list[Candidate]] = {s: [] for s in STRATEGIES}
    for inp in ep.get("inputs", []):
        strat = inp.get("strategy")
        if strat not in grouped:
            continue
        grouped[strat].append(
            Candidate(
                strategy=strat,
                provenance=inp.get("provenance", "schema"),
                input_class=inp.get("class", strat),
                body=inp.get("body"),
                path_params=inp.get("path_params") or {},
                query=inp.get("query") or {},
                headers=inp.get("headers") or {},
            )
        )
    # Semantic inputs (from a stored harness reply) feed the 'semantic' arm.
    for splan in ep.get("semantic_inputs", []) or []:
        inputs = splan.get("inputs") or {}
        grouped["semantic"].append(
            Candidate(
                strategy="semantic",
                provenance="semantic",
                input_class="semantic",
                body=inputs.get("body"),
                path_params=inputs.get("path_params") or {},
                query=inputs.get("query") or {},
                headers=inputs.get("headers") or {},
            )
        )
    return grouped


def _available_strategies(grouped: dict[str, list[Candidate]]) -> tuple[str, ...]:
    return tuple(s for s in STRATEGIES if grouped.get(s))


def _expected_class(candidate: Candidate) -> str:
    """The behavioural expectation for an input class (for issue evidence)."""
    if candidate.input_class == "negative":
        return "4xx (a correct service rejects this)"
    return "2xx-3xx (a valid call should succeed)"


def run_exercise(
    repo: Path,
    base_url: str,
    *,
    service: str | None = None,
    store_dir: str | None = None,
    budget: int = 200,
    rounds: int = 3,
    seed: int = 1729,
    exercise_id: str = "vinv-exercise",
    settle_s: float = 0.8,
    probe_fn: ProbeFn = execute_probe,
    coverage_fn: CoverageFn = endpoint_coverage,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Run the coverage-guided loop and persist all artifacts. Returns a summary.

    ``rounds`` is the no-improvement patience: the loop stops after that many
    consecutive rounds add zero new symbols (or the budget runs out). ``probe_fn``
    and ``coverage_fn`` are injectable so the loop is testable off a live service.
    """
    import random

    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()
    rng = random.Random(f"exercise {seed}")

    plan = store.read_json(store.plan_path(repo))
    if not isinstance(plan, dict):
        return {"status": "error", "error": "no plan.json — run `exerciser plan` first"}
    if not plan.get("endpoints"):
        # A present-but-empty plan is a different failure from a missing one:
        # route discovery found nothing to exercise. Say exactly that — a
        # silent (or mislabeled) zero must never look like a clean run.
        return {
            "status": "error",
            "error": (
                "plan.json has 0 endpoints — Vinv cannot exercise this repo "
                "over HTTP. Check identification's apis.json diagnostics; "
                "non-HTTP entry points are driven by the function-level "
                "harness instead."
            ),
        }
    endpoints = plan["endpoints"]

    # Generation compaction of the unbounded logs (results, state ledger,
    # optimize/regress attempt streams) BEFORE this run appends to them.
    # Idempotent; leaves a loud one-line compaction_summary.txt artifact.
    compaction = compact_artifacts(repo, plan, logger=log)

    # Warm-start each endpoint's posterior from the previous run's bandit.json,
    # DECAYED toward the uniform prior — learned strategy preferences persist
    # across runs but expire geometrically, so a stale lesson (learned against
    # an environment that has since changed) cannot dominate forever.
    prior_doc = store.read_json(store.bandit_path(repo)) or {}
    priors = prior_doc.get("per_endpoint", {})

    bandits: dict[str, EndpointBandit] = {}
    grouped_by_ep: dict[str, dict[str, list[Candidate]]] = {}
    covered_ids_by_ep: dict[str, set[str]] = {}
    # Handler symbol per endpoint, for the trace-primary handler_observed join.
    handler_by_id: dict[str, str | None] = {e["api_id"]: e.get("handler") for e in endpoints}
    for ep in endpoints:
        api_id = ep["api_id"]
        grouped = _candidates_for_endpoint(ep)
        avail = _available_strategies(grouped)
        if not avail:
            continue
        grouped_by_ep[api_id] = grouped
        bandits[api_id] = seed_from_prior(
            EndpointBandit(strategies=avail),
            priors.get(api_id),
        )
        covered_ids_by_ep[api_id] = set()

    # Learned invariants (from a prior `exerciser profile`), indexed by
    # "METHOD path" — the assertions this run will ENFORCE on every healthy
    # response. Empty on the first-ever run (nothing learned yet).
    inv_by_endpoint = store.read_invariants_by_endpoint(repo)

    # Environment canary: before spending the budget, dry-run the FIRST setup
    # step of every authored scenario (the login chains). A reset database, a
    # missing seed user, or rotated credentials fails HERE, loudly, with the
    # step and status — instead of silently 401-ing the whole run. Proven
    # necessary live: a reset Postgres with no seeded superuser degraded a
    # 23/23 run to 5/23 with zero signal about why.
    canary = _environment_canary(endpoints, base_url, exercise_id, probe_fn, log)

    # Re-attempt teardown of PRIOR runs' uncleaned planted values before this
    # run plants new ones — pollution must not accumulate. Credentials are
    # earned lazily (regress's fresh setup-chain capture) and only when stale
    # ledger rows actually exist.
    def _early_auth_headers() -> list[dict[str, str]]:
        from .regress import _fresh_auth_headers  # lazy: avoids an import cycle

        return _fresh_auth_headers(repo, base_url, probe_fn)

    reattempt = state.reattempt_teardown(
        repo,
        endpoints,
        base_url,
        probe_fn,
        auth_headers_fn=_early_auth_headers,
    )
    if reattempt["reattempted"]:
        log.info(
            "state ledger: re-attempted teardown of %d stale row(s), cleaned %d",
            reattempt["reattempted"],
            reattempt["cleaned"],
        )

    executions: list[dict[str, Any]] = []
    # How many of `executions` are already on disk (round checkpoints below), so
    # the terminal write appends only the remainder instead of duplicating them.
    persisted = 0
    spent = 0
    no_improve_rounds = 0
    round_no = 0
    # Round-robin cursor per (endpoint, strategy) so repeated plays of one arm
    # rotate through its candidate inputs deterministically.
    cursor: dict[tuple[str, str], int] = {}

    active_ids = list(grouped_by_ep)
    while spent < budget and no_improve_rounds < rounds and active_ids:
        round_no += 1
        round_new_symbols = 0
        round_violations = 0
        for api_id in list(active_ids):
            if spent >= budget:
                break
            ep = next(e for e in endpoints if e["api_id"] == api_id)
            bandit = bandits[api_id]
            grouped = grouped_by_ep[api_id]
            strategy = bandit.select(rng)
            cands = grouped.get(strategy) or []
            if not cands:
                continue
            idx = cursor.get((api_id, strategy), 0)
            candidate = cands[idx % len(cands)]
            cursor[(api_id, strategy)] = idx + 1

            try:
                result = probe_fn(
                    base_url,
                    ep["method"],
                    ep["path"],
                    body=candidate.body,
                    path_params=candidate.path_params,
                    query=candidate.query,
                    headers=candidate.headers,
                    # The encoding the SPEC declared. Omitting it JSON-encoded
                    # every form-only endpoint, so an OAuth2 password login
                    # 422'd on every probe and the whole authenticated pass was
                    # skipped for want of a token.
                    content_type=ep.get("content_type"),
                    exercise_id=exercise_id,
                )
            except Exception as exc:
                # The canary, scenario and auth-sweep probe sites all guard;
                # this one did not, and it is the one inside the round loop.
                # Nothing is persisted until the loop ends, so an escape here
                # cost every execution recorded so far. Record the probe as a
                # transport failure and keep going — that is what the other
                # three sites do, and it is what the evidence is worth.
                log.debug("probe raised for %s: %s", ep.get("api_id"), exc)
                result = ProbeResult(None, 0.0, None, "empty", str(exc), None, None)
            spent += 1
            row = _execution_row(
                round_no,
                ep,
                candidate,
                result,
            )
            # The learned invariants JUDGE every healthy response: a 2xx with a
            # plausible shape but a wrong value is a first-class failure, not a
            # pass. (Assertions learned by a prior `exerciser profile`.)
            _enforce_invariants(row, inv_by_endpoint)
            executions.append(row)
        # After the round, settle then re-join coverage for every active endpoint.
        if settle_s > 0:
            time.sleep(settle_s)
        for api_id in list(active_ids):
            cov = coverage_fn(
                repo,
                api_id,
                service=service,
                store_dir=store_dir,
                logger=log,
                handler=handler_by_id.get(api_id),
            )
            new_ids = set(cov.get("covered_ids", set())) - covered_ids_by_ep[api_id]
            covered_ids_by_ep[api_id] |= set(cov.get("covered_ids", set()))
            round_new_symbols += len(new_ids)
            # Attribute this round's outcome to the strategy last played for the
            # endpoint. The objective is ORACLE VIOLATIONS per unit cost —
            # coverage is the exploration bonus, not the goal — so the round's
            # violations for this endpoint are counted alongside the new symbols.
            # Retire an endpoint that produced only transport failures this
            # round. `active_ids` was never mutated — the name and the defensive
            # `list()` copies both implied retirement was implemented, but every
            # endpoint stayed in the rotation for the whole run, so an
            # unreachable one (a wrong verb, a collided id, a form-only login)
            # burned one probe per round out of a default budget of 200. This is
            # the multiplier that turned the coverage defects above into lost
            # budget. Only a total absence of any HTTP response retires it; a
            # 4xx/5xx is a real answer and stays in play.
            round_rows = [
                r for r in executions if r.get("api_id") == api_id and r.get("round") == round_no
            ]
            if round_rows and all(r.get("status") is None for r in round_rows):
                active_ids.remove(api_id)
                log.info(
                    "retiring %s: no HTTP response in round %d (%d probes); "
                    "it cannot be exercised and would otherwise consume budget "
                    "every remaining round",
                    api_id,
                    round_no,
                    len(round_rows),
                )
            last_strategy = _last_strategy(executions, api_id, round_no)
            if last_strategy:
                violations = _round_violations(executions, api_id, round_no)
                round_violations += violations
                bandits[api_id].update(
                    last_strategy,
                    Outcome(violations=violations, new_coverage=len(new_ids), cost=1.0),
                )
        if round_new_symbols == 0:
            no_improve_rounds += 1
        else:
            no_improve_rounds = 0
        log.info(
            "round %d: %d probes spent, %d new symbols, %d oracle violations (no-improve %d/%d)",
            round_no,
            spent,
            round_new_symbols,
            round_violations,
            no_improve_rounds,
            rounds,
        )
        # Checkpoint the round. Persistence used to be a terminal phase, so ANY
        # mid-loop exit — a probe escape, the harness's 180s SIGKILL, Ctrl-C —
        # threw away every execution of the run. Worse, the state those probes
        # planted in the live service was never written to the ledger either, so
        # it could never be torn down and silently poisoned later baselines.
        # Rows are appended as they are earned; the terminal write below persists
        # only what this checkpoint has not already taken.
        if executions[persisted:]:
            store.append_jsonl(store.results_path(repo), executions[persisted:])
            state.append_ledger(repo, state.record_creations(executions[persisted:]))
            persisted = len(executions)

    # Stateful sequential scenarios: any endpoint whose semantic plan carries
    # SETUP steps (authored by the harness) is a multi-step flow — execute it with
    # variable capture/substitution so token/id state flows between steps.
    scenarios, live_auth_headers = _run_scenarios(
        endpoints,
        base_url,
        exercise_id,
        probe_fn,
        log,
    )
    # A scenario whose SETUP failed (or whose endpoint step bounced on auth) is
    # EXPIRED: its harness-authored reply no longer matches the environment.
    # Mark it, and invalidate the stored reply so the next plan re-dispatches
    # the prompt (with the failure threaded in) instead of silently replaying a
    # dead scenario forever.
    expired = _mark_expired_scenarios(scenarios)
    for sc in expired:
        _expire_semantic_reply(repo, sc, log)
    # A scenario step that 5xx'd or crashed is a real behavioral failure too —
    # cluster it into issues.json, but keep these synthetic rows OUT of
    # results.jsonl/profile (they carry no replayable request shape and their
    # endpoint id is the raw "METHOD path", not an api_id).
    scenario_failures = _scenario_failure_rows(scenarios)

    # Authenticated permutation sweep: every endpoint replayed WITH the
    # credentials the scenarios captured (the "checked as superuser" pass),
    # substituting real created-resource ids into path params — a generated
    # UUID can never hit a real row, but an id WE created can, which is what
    # flips DELETE/PATCH-by-id endpoints from 0 coverage to real coverage.
    # Runs BEFORE persistence so its rows feed coverage, issues, and baselines.
    ledger_ids = sorted(
        {v for row in state.record_creations(executions) for v in row.get("response_values", [])}
        | {
            v
            for row in store.read_jsonl(state.ledger_path(repo))
            if not row.get("cleaned")
            for v in row.get("response_values", [])
        }
    )
    # No harness scenario captured a token? Bootstrap one deterministically from
    # the OpenAPI security scheme (OAuth2 password flow) so the authenticated
    # sweep still runs on a first pass — generic, no hardcoded login path.
    if not live_auth_headers and any(e.get("requires_auth") for e in endpoints):
        from .auth import bootstrap_auth_headers
        from .openapi import fetch_openapi

        boot = bootstrap_auth_headers(
            base_url,
            fetch_openapi(base_url),
            probe_fn=probe_fn,
            exercise_id=exercise_id,
            seed=seed,
            logger=log,
        )
        if boot:
            live_auth_headers = boot
            log.info(
                "auth: bootstrapped %d credential set(s) from the OpenAPI security scheme",
                len(boot),
            )

    authed_rows = _auth_sweep(
        endpoints,
        base_url,
        exercise_id,
        probe_fn,
        live_auth_headers,
        ledger_ids,
        log,
    )
    executions.extend(authed_rows)

    # Access-control oracle: a protected endpoint that serves an ANONYMOUS 2xx is
    # a broken auth guard (OWASP API1) — invisible to every 5xx/crash oracle.
    ac_rows = _access_control_sweep(endpoints, base_url, exercise_id, probe_fn, log)
    executions.extend(ac_rows)

    # Authed-hostile sweep: replay each protected endpoint's negatives UNDER the
    # token, so an authed-only crash (skip=-1 behind auth) surfaces instead of
    # bouncing off a 401 anonymously.
    executions.extend(
        _authed_negative_sweep(endpoints, base_url, exercise_id, probe_fn, live_auth_headers, log)
    )

    # Persist whatever the round checkpoints have not already written (scenario
    # rows, canary rows and the auth sweep all land after the loop).
    remaining = executions[persisted:]
    if store.results_path(repo).exists():
        store.append_jsonl(store.results_path(repo), remaining)
    else:
        store.write_jsonl(store.results_path(repo), remaining)
    if scenarios:
        store.write_json(
            store.exercise_dir(repo) / "scenarios.json", {"version": 1, "scenarios": scenarios}
        )

    # Coverage snapshot for the summary.
    coverage_rows = []
    for api_id in grouped_by_ep:
        cov = coverage_fn(
            repo,
            api_id,
            service=service,
            store_dir=store_dir,
            logger=log,
            handler=handler_by_id.get(api_id),
        )
        coverage_rows.append(
            {
                "api_id": api_id,
                "covered": cov.get("covered", 0),
                "total": cov.get("total", 0),
                "pct": cov.get("pct", 0.0),
                "uncovered": cov.get("uncovered", []),
                "handler_observed": cov.get("handler_observed", False),
            }
        )

    # Cross-call invariants (id_monotonic) judge the run's ordered responses.
    _enforce_monotonic(executions, inv_by_endpoint)

    # Golden behavior baselines from the healthy executions — applied BEFORE
    # clustering so a degraded verdict (status/shape/value regression with
    # nothing raised) becomes a first-class issue cluster.
    observations = _baseline_observations(executions)
    baseline_verdicts = apply_baselines(repo, observations)

    # Failure clustering → issues.json (deterministic probes + scenario
    # failures + assert-shaped baseline degradations).
    clusters = cluster_failures(executions + scenario_failures) + clusters_from_baseline(
        baseline_verdicts, observations
    )
    store.write_json(store.issues_path(repo), issues_document(clusters))

    # State ledger: what this run planted in the service, then best-effort
    # unwind through the service's own DELETE endpoints (captured auth first).
    # Whatever stays uncleaned is acknowledged pollution — regress reads the
    # ledger to tell environment drift from real behavior regressions.
    creations = state.record_creations(executions)
    cleaned = (
        state.attempt_teardown(
            creations,
            endpoints,
            base_url,
            probe_fn,
            auth_headers=live_auth_headers,
        )
        if creations
        else 0
    )
    # Teardown works over ALL creations (it runs once, at the end), but only the
    # rows the round checkpoints have not already written are appended — the
    # ledger is append-only, so re-adding them would double-count what the
    # engine planted and inflate the scorecard's pollution numbers.
    state.append_ledger(repo, state.record_creations(remaining))

    # Terminal credit pass: a DEGRADED baseline is an oracle violation, but it
    # is only knowable after the run (baselines are applied once, at the end),
    # so the arm that produced the degrading probe is credited here rather than
    # in the round loop. Without this the objective silently under-counts
    # exactly the assert-shaped class the value digest exists to find —
    # verified live: a 200 with an unchanged shape and a changed value scored
    # zero violations for its arm.
    degraded_probes = {
        probe_id for probe_id, v in baseline_verdicts.items() if v["verdict"] == "degraded"
    }
    if degraded_probes:
        by_probe = {o["probeId"]: o for o in observations}
        credited = 0
        for probe_id in degraded_probes:
            obs = by_probe.get(probe_id)
            if obs is None:
                continue
            api_id = obs.get("endpointId")
            bandit = bandits.get(api_id)
            strategy = _strategy_for_probe(executions, probe_id, api_id)
            if bandit is not None and strategy:
                bandit.update(strategy, Outcome(violations=1, cost=1.0))
                credited += 1
        log.info("baseline degradation credited to %d arm(s)", credited)

    # Bandit posteriors.
    summary = bandit_summary(bandits)
    store.write_json(store.bandit_path(repo), summary)

    result: dict[str, Any] = {
        "status": "ok",
        "repo": str(repo),
        "base_url": base_url,
        "environment_canary": canary,
        "compaction": compaction["line"],
        "state_reattempted": reattempt["reattempted"],
        "state_recleaned": reattempt["cleaned"],
        "rounds_run": round_no,
        "probes_spent": spent,
        "budget": budget,
        "endpoints_exercised": len(grouped_by_ep),
        "coverage": coverage_rows,
        "issue_clusters": len(clusters),
        "scenarios_run": len(scenarios),
        "scenarios_completed": sum(1 for s in scenarios if s.get("completed")),
        "scenarios_expired": len(expired),
        "auth_sweep_probes": len(authed_rows),
        "auth_credential_sets": len(live_auth_headers),
        "state_created": len(creations),
        "state_cleaned": cleaned,
        "baseline_recorded": sum(
            1 for v in baseline_verdicts.values() if v["verdict"] == "recorded"
        ),
        "baseline_degraded": sum(
            1 for v in baseline_verdicts.values() if v["verdict"] == "degraded"
        ),
        "bandit": summary["pooled"],
        "results_file": str(store.results_path(repo)),
        "issues_file": str(store.issues_path(repo)),
        "bandit_file": str(store.bandit_path(repo)),
    }
    return result


def _run_scenarios(
    endpoints: list[dict[str, Any]],
    base_url: str,
    exercise_id: str,
    probe_fn: ProbeFn,
    log: logging.Logger,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Execute each endpoint's authored stateful scenarios (setup + endpoint).

    Returns the scenario records plus every LIVE auth header set the scenarios
    captured (a step's headers that resolved through captured variables) —
    in-memory only, for the teardown pass; tokens are never persisted.
    """
    out: list[dict[str, Any]] = []
    auth_headers: list[dict[str, str]] = []
    for ep in endpoints:
        for splan in ep.get("semantic_inputs", []) or []:
            steps: list[dict[str, Any]] = []
            for s in splan.get("setup", []) or []:
                method, path = _split_endpoint(s.get("endpoint", ""))
                steps.append(
                    {
                        "method": method or ep["method"],
                        "path": path or ep["path"],
                        "inputs": s.get("inputs") or {},
                        "capture": s.get("capture") or {},
                        "expect": {"status": "2xx"},
                    }
                )
            # The endpoint itself as the final step.
            steps.append(
                {
                    "method": ep["method"],
                    "path": ep["path"],
                    "inputs": splan.get("inputs") or {},
                    "capture": {},
                    "expect": splan.get("expect") or {},
                }
            )
            try:
                res = run_scenario(
                    base_url,
                    f"{ep['method']} {ep['path']}",
                    steps,
                    exercise_id=exercise_id,
                    probe_fn=probe_fn,
                )
                record = res.to_json()
                record["api_id"] = ep["api_id"]
                record["planned_steps"] = len(steps)
                out.append(record)
                for hdrs in _resolved_auth_headers(steps, res.variables):
                    if hdrs not in auth_headers:
                        auth_headers.append(hdrs)
            except Exception as exc:  # a scenario never fails the run
                log.debug("scenario for %s failed: %s", ep["api_id"], exc)
    return out, auth_headers


def _environment_canary(
    endpoints: list[dict[str, Any]],
    base_url: str,
    exercise_id: str,
    probe_fn: ProbeFn,
    log: logging.Logger,
) -> dict[str, Any]:
    """Dry-run each authored scenario's first setup step; report failures loudly.

    Deduped by (method, path) so ten scenarios sharing one login chain cost one
    probe. Failure means the environment no longer satisfies the scenario's
    preconditions (reset database, unseeded credentials) — the run continues,
    but the summary and log carry the exact failing step and remediation hint.
    """
    seen: set[tuple[str, str]] = set()
    failed: list[dict[str, Any]] = []
    checked = 0
    for ep in endpoints:
        for splan in ep.get("semantic_inputs", []) or []:
            setup = splan.get("setup") or []
            if not setup:
                continue
            method, path = _split_endpoint(setup[0].get("endpoint", ""))
            if not method or (method, path) in seen:
                continue
            seen.add((method, path))
            inputs = setup[0].get("inputs") or {}
            try:
                res = probe_fn(
                    base_url,
                    method,
                    path,
                    body=inputs.get("body"),
                    path_params=inputs.get("path_params") or {},
                    query=inputs.get("query") or {},
                    headers=inputs.get("headers") or {},
                    content_type=inputs.get("content_type"),
                    exercise_id=exercise_id,
                )
            except Exception as exc:
                failed.append({"step": f"{method} {path}", "status": None, "error": str(exc)})
                continue
            checked += 1
            if not (isinstance(res.status, int) and 200 <= res.status < 300):
                failed.append({"step": f"{method} {path}", "status": res.status})
    if failed:
        log.warning(
            "environment canary FAILED for %d setup step(s): %s — the service "
            "environment no longer satisfies the authored scenarios' "
            "preconditions (reset database? unseeded credentials?). Re-run the "
            "service's seeding/prestart, or the scenarios will expire and be "
            "re-dispatched for authorship.",
            len(failed),
            "; ".join(f"{f['step']} -> {f.get('status') or f.get('error')}" for f in failed),
        )
    return {"checked": checked, "failed": failed}


def _auth_sweep(
    endpoints: list[dict[str, Any]],
    base_url: str,
    exercise_id: str,
    probe_fn: ProbeFn,
    auth_headers: list[dict[str, str]],
    ledger_ids: list[str],
    log: logging.Logger,
    max_id_substitutions: int = 2,
) -> list[dict[str, Any]]:
    """Replay every endpoint's valid input under each captured credential set.

    Rows carry ``strategy="authed"`` and ``auth=True``: regress replays them
    only after re-capturing fresh credentials (tokens in results.jsonl would
    be both a leak and expired), and the bandit never sees them — this is a
    deterministic completeness pass, not an explored arm.
    """
    if not auth_headers:
        return []
    # Creators before consumers: a 2xx authed POST mints a real id that the
    # GET/PATCH/DELETE-by-id endpoints later in the SAME sweep can target.
    method_order = {"POST": 0, "PUT": 1, "GET": 2, "PATCH": 3, "DELETE": 4}
    ordered = sorted(endpoints, key=lambda e: method_order.get(str(e.get("method")), 5))
    live_ids: list[str] = list(ledger_ids)
    rows: list[dict[str, Any]] = []
    for auth_index, hdrs in enumerate(auth_headers):
        for ep in ordered:
            valid = [i for i in ep.get("inputs", []) if i.get("class") == "valid"]
            if not valid:
                continue
            base = valid[0]
            variants: list[dict[str, Any]] = [base]
            pparams = base.get("path_params") or {}
            if pparams:
                # Real ids we created beat generated ones for hitting rows;
                # most recent first (this sweep's own creations).
                #
                # id-shaped ONLY: the ledger harvests every scalar a 2xx returned,
                # which on an auth endpoint includes the bearer token. Splicing that
                # into a path param issues DELETE /users/<jwt>, writing the credential
                # into the request line and the service's access log.
                usable = [v for v in reversed(live_ids) if is_id_shaped(v)]
                for vid in usable[:max_id_substitutions]:
                    variants.append({**base, "path_params": {k: vid for k in pparams}})
            for inp in variants:
                candidate = Candidate(
                    strategy="authed",
                    provenance="auth_permutation",
                    input_class="authed_valid",
                    body=inp.get("body"),
                    path_params=inp.get("path_params") or {},
                    query=inp.get("query") or {},
                    headers={**(inp.get("headers") or {}), **hdrs},
                )
                try:
                    result = probe_fn(
                        base_url,
                        ep["method"],
                        ep["path"],
                        body=candidate.body,
                        path_params=candidate.path_params,
                        query=candidate.query,
                        headers=candidate.headers,
                        content_type=ep.get("content_type"),
                        exercise_id=exercise_id,
                    )
                except Exception as exc:
                    log.debug("auth sweep probe failed for %s: %s", ep["api_id"], exc)
                    continue
                row = _execution_row(0, ep, candidate, result)
                row["auth"] = True
                # WHICH credential asked. Part of the probe id, so a superuser's
                # 200 and a normal user's 403 keep separate goldens instead of
                # overwriting each other; and regress replays each case under the
                # credential that recorded it instead of always the first.
                row["auth_index"] = auth_index
                rows.append(row)
                # Harvest ids minted by this sweep for later endpoints.
                if (
                    ep["method"] in state._MUTATING
                    and isinstance(result.status, int)
                    and 200 <= result.status < 300
                ):
                    for v in sorted(state.scalar_values(result.body)):
                        if v not in live_ids:
                            live_ids.append(v)
    log.info("auth sweep: %d probes across %d credential sets", len(rows), len(auth_headers))
    return rows


def _access_control_sweep(
    endpoints: list[dict[str, Any]],
    base_url: str,
    exercise_id: str,
    probe_fn: ProbeFn,
    log: logging.Logger,
) -> list[dict[str, Any]]:
    """Fire ONE anonymous valid request at every protected endpoint.

    A protected endpoint that answers an ANONYMOUS request with a 2xx has a
    broken access control (OWASP API1) — a bug no 5xx/crash oracle can catch,
    because the service did not error, it wrongly SUCCEEDED. Deterministic
    completeness pass (never a bandit arm); only the violations (anonymous 2xx)
    are returned, so a correct 401/403 never pollutes coverage or baselines.
    """
    rows: list[dict[str, Any]] = []
    checked = 0
    for ep in endpoints:
        if not ep.get("requires_auth"):
            continue
        valid = [i for i in ep.get("inputs", []) if i.get("class") == "valid"]
        if not valid:
            continue
        checked += 1
        base = valid[0]
        candidate = Candidate(
            strategy="anonymous",
            provenance="access-control",
            input_class="negative",  # a correct service rejects an anonymous call
            body=base.get("body"),
            path_params=base.get("path_params") or {},
            query=base.get("query") or {},
            headers={},  # explicitly no credentials
        )
        try:
            result = probe_fn(
                base_url,
                ep["method"],
                ep["path"],
                body=candidate.body,
                path_params=candidate.path_params,
                query=candidate.query,
                headers={},
                content_type=ep.get("content_type"),
                exercise_id=exercise_id,
            )
        except Exception as exc:
            log.debug("access-control sweep failed for %s: %s", ep["api_id"], exc)
            continue
        if isinstance(result.status, int) and 200 <= result.status < 300:
            row = _execution_row(0, ep, candidate, result)
            row["access_control_violation"] = True
            rows.append(row)
    log.info(
        "access-control sweep: %d protected endpoints checked, %d served an anonymous 2xx",
        checked,
        len(rows),
    )
    return rows


def _authed_negative_sweep(
    endpoints: list[dict[str, Any]],
    base_url: str,
    exercise_id: str,
    probe_fn: ProbeFn,
    auth_headers: list[dict[str, str]],
    log: logging.Logger,
) -> list[dict[str, Any]]:
    """Replay each protected endpoint's schema-NEGATIVE inputs UNDER a token.

    An anonymous hostile probe on a protected endpoint only ever earns a 401 —
    the malformed input (``skip=-1``, a bad body) never reaches the handler, so
    the authed-only crash it would trip stays invisible. Sending the same
    negatives WITH credentials is what surfaces them: a 5xx clusters as
    ``server-error``, while a 4xx (a correct rejection) is ignored. Uses the
    first credential set; deterministic completeness pass, never a bandit arm.
    """
    if not auth_headers:
        return []
    hdrs = auth_headers[0]
    rows: list[dict[str, Any]] = []
    for ep in endpoints:
        if not ep.get("requires_auth"):
            continue
        negatives = [
            i
            for i in ep.get("inputs", [])
            if i.get("class") == "negative" and i.get("provenance") == "schema"
        ]
        for inp in negatives:
            candidate = Candidate(
                strategy="authed_negative",
                provenance="auth_hostile",
                input_class="negative",
                body=inp.get("body"),
                path_params=inp.get("path_params") or {},
                query=inp.get("query") or {},
                headers={**(inp.get("headers") or {}), **hdrs},
            )
            try:
                result = probe_fn(
                    base_url,
                    ep["method"],
                    ep["path"],
                    body=candidate.body,
                    path_params=candidate.path_params,
                    query=candidate.query,
                    headers=candidate.headers,
                    content_type=ep.get("content_type"),
                    exercise_id=exercise_id,
                )
            except Exception as exc:
                log.debug("authed negative sweep failed for %s: %s", ep["api_id"], exc)
                continue
            row = _execution_row(0, ep, candidate, result)
            row["auth"] = True
            rows.append(row)
    log.info("authed negative sweep: %d hostile probes replayed under a token", len(rows))
    return rows


def _resolved_auth_headers(
    steps: list[dict[str, Any]],
    variables: dict[str, Any],
) -> list[dict[str, str]]:
    """Header sets that resolved through captured variables (live credentials)."""
    out: list[dict[str, str]] = []
    for step in steps:
        raw = (step.get("inputs") or {}).get("headers") or {}
        if not raw:
            continue
        resolved = substitute(raw, variables)
        if resolved == raw:
            continue  # static headers — nothing captured flowed in
        values = " ".join(str(v) for v in resolved.values())
        if "${" in values:
            continue  # a placeholder never resolved — not a live credential
        out.append({str(k): str(v) for k, v in resolved.items()})
    return out


def _mark_expired_scenarios(scenarios: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Mark scenarios whose authored steps no longer fit the environment.

    Expired = a SETUP step failed (the chain never reached its endpoint), or
    the endpoint step itself bounced on auth (401/403) — the captured
    credentials did not take. Either way the harness's authored reply is stale
    and needs re-authorship, not silent replay.
    """
    expired: list[dict[str, Any]] = []
    for sc in scenarios:
        if sc.get("completed"):
            continue
        steps = sc.get("steps", [])
        if not steps:
            continue
        last = steps[-1]
        planned = sc.get("planned_steps", len(steps))
        setup_failed = len(steps) < planned
        auth_bounced = last.get("status") in (401, 403)
        if setup_failed or auth_bounced:
            sc["expired"] = True
            sc["expired_reason"] = (
                f"{'setup' if setup_failed else 'endpoint'} step "
                f"{last.get('endpoint')} got "
                f"{last.get('status') if last.get('status') is not None else last.get('error')}"
            )
            expired.append(sc)
    return expired


def _expire_semantic_reply(
    repo: Path,
    scenario: dict[str, Any],
    log: logging.Logger,
) -> None:
    """Invalidate the stored harness reply behind an expired scenario.

    Stamps ``reply_expired`` on the prompt record; ``plan`` treats such a reply
    as absent (re-rendering the prompt for dispatch) while threading the
    failure reason into the new prompt so the retry learns from it.
    """
    api_id = scenario.get("api_id")
    if not api_id:
        return
    prompt_file = store.prompt_path(repo, api_id)
    record = store.read_json(prompt_file)
    if not isinstance(record, dict) or record.get("reply") is None:
        return
    record["reply_expired"] = scenario.get("expired_reason", "scenario failed")
    # Bind the expiry to THIS reply: when the harness authors a fresh one the
    # fingerprint no longer matches and the new reply feeds the plan again.
    record["reply_expired_for"] = store.reply_fingerprint(record.get("reply"))
    store.write_json(prompt_file, record)
    log.info("expired semantic reply for %s: %s", api_id, record["reply_expired"])


def _scenario_failure_rows(scenarios: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Execution-shaped rows for scenario steps that failed (for clustering).

    5xx / crashes are service failures; a failed SETUP step (any status) is a
    rig failure that silently zeroes the whole scenario's coverage — cluster
    both so they surface in issues.json instead of degrading the run quietly.
    """
    rows: list[dict[str, Any]] = []
    for sc in scenarios:
        planned = sc.get("planned_steps", len(sc.get("steps", [])))
        for idx, step in enumerate(sc.get("steps", [])):
            status = step.get("status")
            is_setup = idx < planned - 1
            is_failure = (
                (status is None and step.get("error"))
                or (isinstance(status, int) and status >= 500)
                or (is_setup and not step.get("ok"))
            )
            if not is_failure:
                continue
            method, path = _split_endpoint(step.get("endpoint", ""))
            rows.append(
                {
                    "round": 0,
                    "endpoint_id": step.get("endpoint", ""),
                    "api_id": step.get("endpoint", ""),
                    "method": method,
                    "path": path,
                    "handler": None,
                    "strategy": "semantic",
                    "provenance": "semantic",
                    "input_class": "semantic",
                    "input": {"scenario": sc.get("name")},
                    "expected": "2xx (a valid scenario step)",
                    "status": status,
                    "status_class": status_class(status),
                    "latency_ms": step.get("latency_ms"),
                    "shape_hash": step.get("shape_hash", "empty"),
                    "error": step.get("error"),
                    "request_id": None,
                    "output_size": 0,
                    "input_size": 0,
                    "body": None,
                }
            )
    return rows


def _split_endpoint(spec: str) -> tuple[str, str]:
    parts = spec.strip().split(None, 1)
    if len(parts) == 2:
        return parts[0].upper(), parts[1]
    return "", spec.strip()


def _execution_row(
    round_no: int,
    ep: dict[str, Any],
    candidate: Candidate,
    result: ProbeResult,
) -> dict[str, Any]:
    return {
        "round": round_no,
        "endpoint_id": ep["api_id"],
        "api_id": ep["api_id"],
        "method": ep["method"],
        "path": ep["path"],
        "handler": ep.get("handler"),
        # Persisted so regress replays with the same encoding the run used.
        "content_type": ep.get("content_type"),
        "strategy": candidate.strategy,
        "provenance": candidate.provenance,
        "input_class": candidate.input_class,
        "input": {
            "body": candidate.body,
            "path_params": candidate.path_params,
            "query": candidate.query,
        },
        "expected": _expected_class(candidate),
        "status": result.status,
        "status_class": status_class(result.status),
        "latency_ms": result.latency_ms,
        "shape_hash": result.shape_hash,
        "error": result.error,
        "request_id": result.request_id,
        "output_size": _size_of(result.body),
        "input_size": _input_size(candidate),
        # Redacted: this row is persisted to .vinv/exercise/results.jsonl INSIDE
        # the user's repo, and auth endpoints answer 2xx with bearer tokens and
        # password hashes. Shape and types survive, so the invariant oracle that
        # reads this field is unaffected; value_digest is computed upstream over
        # the raw body and is a one-way hash, so drift detection is unaffected too.
        "body": redact(result.body) if isinstance(result.body, dict | list) else None,
        "value_digest": result.value_digest,
    }


def _enforce_invariants(
    row: dict[str, Any], inv_by_endpoint: dict[str, list[dict[str, Any]]]
) -> None:
    """Judge one healthy execution row against its endpoint's learned invariants.

    Violations land in ``row["invariant_violation"]`` — the flag
    ``cluster_failures`` reads — so a wrong VALUE clusters exactly like a 5xx.
    Only 2xx responses are judged: invariants are learned over healthy outputs.
    """
    if row.get("status_class") != "2xx-3xx":
        return
    invs = inv_by_endpoint.get(f"{row.get('method')} {row.get('path')}")
    if not invs:
        return
    try:
        violations = check_observation(
            invs,
            row.get("body"),
            output_size=row.get("output_size", 0),
            input_size=row.get("input_size", 0),
        )
    except Exception:
        # Defence in depth behind store._enforceable. This call sits bare in the
        # round loop, and artifacts are not written until the loop ends, so any
        # exception here discards EVERY execution recorded so far. A judgement
        # the oracle cannot make is never worth losing the run's evidence over.
        return
    if violations:
        row["invariant_violation"] = "; ".join(violations)


def _enforce_monotonic(
    executions: list[dict[str, Any]], inv_by_endpoint: dict[str, list[dict[str, Any]]]
) -> None:
    """Cross-call ``id_monotonic`` enforcement over the run's ordered rows."""
    by_endpoint: dict[str, list[dict[str, Any]]] = {}
    for ex in executions:
        if ex.get("status_class") == "2xx-3xx" and ex.get("body") is not None:
            by_endpoint.setdefault(f"{ex.get('method')} {ex.get('path')}", []).append(ex)
    for key, rows in by_endpoint.items():
        invs = inv_by_endpoint.get(key)
        if not invs:
            continue
        for idx, violation in check_monotonic_sequence(invs, [r.get("body") for r in rows]):
            row = rows[idx]
            existing = row.get("invariant_violation")
            row["invariant_violation"] = f"{existing}; {violation}" if existing else violation


def _round_violations(executions: list[dict[str, Any]], api_id: str, round_no: int) -> int:
    """Oracle violations this endpoint produced in ``round_no``.

    A violation is the oracle SPEAKING: a 5xx, a transport crash, or a broken
    learned invariant. A 4xx on a negative-class probe is the endpoint working
    correctly — counting it would teach the loop to spam malformed inputs.
    """
    count = 0
    for ex in executions:
        if ex.get("api_id") != api_id or ex.get("round") != round_no:
            continue
        status = ex.get("status")
        if ex.get("invariant_violation"):
            count += 1
        elif ex.get("error") and status is None:
            count += 1
        elif isinstance(status, int) and status >= 500:
            count += 1
    return count


def _strategy_for_probe(
    executions: list[dict[str, Any]], probe_id: str, api_id: str | None
) -> str | None:
    """The strategy whose probe produced a given baseline observation.

    Derives each execution's id with the SHARED formula and credits the newest
    match. Re-deriving it locally is what let run's and regress's id spaces
    drift apart (see ``probe.py``).
    """
    for ex in reversed(executions):
        if ex.get("endpoint_id") != api_id:
            continue
        if probe_id_of(ex) == probe_id:
            return ex.get("strategy")
    return None


def _last_strategy(executions: list[dict[str, Any]], api_id: str, round_no: int) -> str | None:
    for ex in reversed(executions):
        if ex["api_id"] == api_id and ex["round"] == round_no:
            return ex["strategy"]
    return None


def _size_of(value: Any) -> int:
    if isinstance(value, dict | list | str):
        return len(value)
    return 0


def _input_size(candidate: Candidate) -> int:
    """Learned-side ``size_relation`` input size — shared with the replay side."""
    return input_size(candidate.body, candidate.path_params, candidate.query)


def _baseline_observations(executions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One baseline observation per (endpoint, concrete request), newest wins.

    The shared ``probe_id`` keeps the golden entry aligned across runs the way
    probeBaseline keys on its probe id — and, critically, aligned with the ids
    ``regress`` derives, which is the join this store depends on.
    """
    seen: dict[str, dict[str, Any]] = {}
    digests: dict[str, list[str | None]] = {}
    for ex in executions:
        # Only valid-class / observed / semantic requests seed a behaviour
        # baseline; negative probes intentionally provoke 4xx and must not.
        if ex["input_class"] in ("negative",):
            continue
        probe_id = probe_id_of(ex)
        digests.setdefault(probe_id, []).append(ex.get("value_digest"))
        seen[probe_id] = {
            "probeId": probe_id,
            "endpointId": ex["endpoint_id"],
            "method": ex["method"],
            "path": ex["path"],
            "httpStatus": ex["status"],
            "handler": ex.get("handler"),
            "shapeHash": ex["shape_hash"],
        }
    for probe_id, obs in seen.items():
        # A value digest is attached only when this run PROVED value stability:
        # the same probe fired at least twice and every response carried the
        # identical digest. Endpoints with dynamic output (timestamps, counters)
        # fail that bar and stay digest-free — no false "value changed" alarms.
        # ``valueStable`` marks the proof, gating baseline SEEDING; comparison
        # alone needs only the digest.
        ds = digests.get(probe_id, [])
        stable = len(ds) >= 2 and len(set(ds)) == 1 and ds[0] is not None
        obs["valueDigest"] = ds[0] if stable else None
        obs["valueStable"] = stable
    return list(seen.values())
