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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import store
from .bandit import STRATEGIES, EndpointBandit, bandit_summary
from .baseline import apply_baselines, status_class
from .coverage import endpoint_coverage
from .execute import ProbeResult, execute_probe
from .issues import cluster_failures, issues_document
from .scenario import run_scenario

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
        grouped[strat].append(Candidate(
            strategy=strat,
            provenance=inp.get("provenance", "schema"),
            input_class=inp.get("class", strat),
            body=inp.get("body"),
            path_params=inp.get("path_params") or {},
            query=inp.get("query") or {},
            headers=inp.get("headers") or {},
        ))
    # Semantic inputs (from a stored harness reply) feed the 'semantic' arm.
    for splan in ep.get("semantic_inputs", []) or []:
        inputs = splan.get("inputs") or {}
        grouped["semantic"].append(Candidate(
            strategy="semantic",
            provenance="semantic",
            input_class="semantic",
            body=inputs.get("body"),
            path_params=inputs.get("path_params") or {},
            query=inputs.get("query") or {},
            headers=inputs.get("headers") or {},
        ))
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
    if not isinstance(plan, dict) or not plan.get("endpoints"):
        return {"status": "error", "error": "no plan.json — run `exerciser plan` first"}
    endpoints = plan["endpoints"]

    bandits: dict[str, EndpointBandit] = {}
    grouped_by_ep: dict[str, dict[str, list[Candidate]]] = {}
    covered_ids_by_ep: dict[str, set[str]] = {}
    for ep in endpoints:
        api_id = ep["api_id"]
        grouped = _candidates_for_endpoint(ep)
        avail = _available_strategies(grouped)
        if not avail:
            continue
        grouped_by_ep[api_id] = grouped
        bandits[api_id] = EndpointBandit(strategies=avail)
        covered_ids_by_ep[api_id] = set()

    executions: list[dict[str, Any]] = []
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

            result = probe_fn(
                base_url, ep["method"], ep["path"],
                body=candidate.body,
                path_params=candidate.path_params,
                query=candidate.query,
                headers=candidate.headers,
                exercise_id=exercise_id,
            )
            spent += 1
            executions.append(_execution_row(
                round_no, ep, candidate, result,
            ))
        # After the round, settle then re-join coverage for every active endpoint.
        if settle_s > 0:
            time.sleep(settle_s)
        for api_id in list(active_ids):
            cov = coverage_fn(
                repo, api_id, service=service, store_dir=store_dir, logger=log,
            )
            new_ids = set(cov.get("covered_ids", set())) - covered_ids_by_ep[api_id]
            covered_ids_by_ep[api_id] |= set(cov.get("covered_ids", set()))
            round_new_symbols += len(new_ids)
            # Attribute this round's newly-covered symbols to the strategy last
            # played for the endpoint (the reward for that arm's probe).
            last_strategy = _last_strategy(executions, api_id, round_no)
            if last_strategy:
                bandits[api_id].update(last_strategy, len(new_ids))
        if round_new_symbols == 0:
            no_improve_rounds += 1
        else:
            no_improve_rounds = 0
        log.info("round %d: %d probes spent, %d new symbols (no-improve %d/%d)",
                 round_no, spent, round_new_symbols, no_improve_rounds, rounds)

    # Stateful sequential scenarios: any endpoint whose semantic plan carries
    # SETUP steps (authored by the harness) is a multi-step flow — execute it with
    # variable capture/substitution so token/id state flows between steps.
    scenarios = _run_scenarios(endpoints, base_url, exercise_id, probe_fn, log)
    # A scenario step that 5xx'd or crashed is a real behavioral failure too —
    # cluster it into issues.json, but keep these synthetic rows OUT of
    # results.jsonl/profile (they carry no replayable request shape and their
    # endpoint id is the raw "METHOD path", not an api_id).
    scenario_failures = _scenario_failure_rows(scenarios)

    # Persist executions (append-only durable record) + scenarios.
    if store.results_path(repo).exists():
        store.append_jsonl(store.results_path(repo), executions)
    else:
        store.write_jsonl(store.results_path(repo), executions)
    if scenarios:
        store.write_json(store.exercise_dir(repo) / "scenarios.json",
                         {"version": 1, "scenarios": scenarios})

    # Coverage snapshot for the summary.
    coverage_rows = []
    for api_id in grouped_by_ep:
        cov = coverage_fn(repo, api_id, service=service, store_dir=store_dir, logger=log)
        coverage_rows.append({
            "api_id": api_id,
            "covered": cov.get("covered", 0),
            "total": cov.get("total", 0),
            "pct": cov.get("pct", 0.0),
            "uncovered": cov.get("uncovered", []),
            "handler_observed": cov.get("handler_observed", False),
        })

    # Failure clustering → issues.json (deterministic probes + scenario failures).
    clusters = cluster_failures(executions + scenario_failures)
    store.write_json(store.issues_path(repo), issues_document(clusters))

    # Golden behavior baselines from the healthy executions.
    observations = _baseline_observations(executions)
    baseline_verdicts = apply_baselines(repo, observations)

    # Bandit posteriors.
    summary = bandit_summary(bandits)
    store.write_json(store.bandit_path(repo), summary)

    result: dict[str, Any] = {
        "status": "ok",
        "repo": str(repo),
        "base_url": base_url,
        "rounds_run": round_no,
        "probes_spent": spent,
        "budget": budget,
        "endpoints_exercised": len(grouped_by_ep),
        "coverage": coverage_rows,
        "issue_clusters": len(clusters),
        "scenarios_run": len(scenarios),
        "scenarios_completed": sum(1 for s in scenarios if s.get("completed")),
        "baseline_recorded": sum(1 for v in baseline_verdicts.values() if v["verdict"] == "recorded"),
        "baseline_degraded": sum(1 for v in baseline_verdicts.values() if v["verdict"] == "degraded"),
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
) -> list[dict[str, Any]]:
    """Execute each endpoint's authored stateful scenarios (setup + endpoint)."""
    out: list[dict[str, Any]] = []
    for ep in endpoints:
        for splan in ep.get("semantic_inputs", []) or []:
            steps: list[dict[str, Any]] = []
            for s in splan.get("setup", []) or []:
                method, path = _split_endpoint(s.get("endpoint", ""))
                steps.append({
                    "method": method or ep["method"],
                    "path": path or ep["path"],
                    "inputs": s.get("inputs") or {},
                    "capture": s.get("capture") or {},
                    "expect": {"status": "2xx"},
                })
            # The endpoint itself as the final step.
            steps.append({
                "method": ep["method"],
                "path": ep["path"],
                "inputs": splan.get("inputs") or {},
                "capture": {},
                "expect": splan.get("expect") or {},
            })
            try:
                res = run_scenario(
                    base_url, f"{ep['method']} {ep['path']}", steps,
                    exercise_id=exercise_id, probe_fn=probe_fn,
                )
                out.append(res.to_json())
            except Exception as exc:  # a scenario never fails the run
                log.debug("scenario for %s failed: %s", ep["api_id"], exc)
    return out


def _scenario_failure_rows(scenarios: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Execution-shaped rows for scenario steps that 5xx'd or crashed (for clustering)."""
    rows: list[dict[str, Any]] = []
    for sc in scenarios:
        for step in sc.get("steps", []):
            status = step.get("status")
            is_failure = (status is None and step.get("error")) or (
                isinstance(status, int) and status >= 500
            )
            if not is_failure:
                continue
            method, path = _split_endpoint(step.get("endpoint", ""))
            rows.append({
                "round": 0, "endpoint_id": step.get("endpoint", ""), "api_id": step.get("endpoint", ""),
                "method": method, "path": path, "handler": None,
                "strategy": "semantic", "provenance": "semantic", "input_class": "semantic",
                "input": {"scenario": sc.get("name")}, "expected": "2xx (a valid scenario step)",
                "status": status, "status_class": status_class(status),
                "latency_ms": step.get("latency_ms"), "shape_hash": step.get("shape_hash", "empty"),
                "error": step.get("error"), "request_id": None,
                "output_size": 0, "input_size": 0, "body": None,
            })
    return rows


def _split_endpoint(spec: str) -> tuple[str, str]:
    parts = spec.strip().split(None, 1)
    if len(parts) == 2:
        return parts[0].upper(), parts[1]
    return "", spec.strip()


def _execution_row(
    round_no: int, ep: dict[str, Any], candidate: Candidate, result: ProbeResult,
) -> dict[str, Any]:
    return {
        "round": round_no,
        "endpoint_id": ep["api_id"],
        "api_id": ep["api_id"],
        "method": ep["method"],
        "path": ep["path"],
        "handler": ep.get("handler"),
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
        "body": result.body if isinstance(result.body, (dict, list)) else None,
    }


def _last_strategy(executions: list[dict[str, Any]], api_id: str, round_no: int) -> str | None:
    for ex in reversed(executions):
        if ex["api_id"] == api_id and ex["round"] == round_no:
            return ex["strategy"]
    return None


def _size_of(value: Any) -> int:
    if isinstance(value, (dict, list, str)):
        return len(value)
    return 0


def _input_size(candidate: Candidate) -> int:
    n = 0
    if isinstance(candidate.body, (dict, list, str)):
        n += len(candidate.body)
    n += len(candidate.path_params) + len(candidate.query)
    return n


def _baseline_observations(executions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One baseline observation per (endpoint, concrete request), newest wins.

    A stable probeId over (endpoint, strategy, path_params) keeps the golden
    entry aligned across runs the way probeBaseline keys on its probe id.
    """
    import hashlib
    import json as _json

    seen: dict[str, dict[str, Any]] = {}
    for ex in executions:
        # Only valid-class / observed / semantic requests seed a behaviour
        # baseline; negative probes intentionally provoke 4xx and must not.
        if ex["input_class"] in ("negative",):
            continue
        key = _json.dumps(
            [ex["endpoint_id"], ex["strategy"], ex.get("input", {}).get("path_params", {})],
            sort_keys=True, default=str,
        )
        probe_id = hashlib.sha256(key.encode()).hexdigest()[:16]
        seen[probe_id] = {
            "probeId": probe_id,
            "endpointId": ex["endpoint_id"],
            "method": ex["method"],
            "path": ex["path"],
            "httpStatus": ex["status"],
            "handler": ex.get("handler"),
            "shapeHash": ex["shape_hash"],
        }
    return list(seen.values())
