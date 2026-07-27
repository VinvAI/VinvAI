"""The campaign — one budget, allocated across every armed oracle by the bandit.

This is the module that makes ``bandit.py``'s enriched action space real. Before
it, ``ActionBandit`` was defined and advertised but never constructed outside its
own unit test: the HTTP loop ran a per-endpoint bandit over five input
strategies, and the five newer oracles (functions, differential, faults,
concurrency, environment) were standalone CLI commands that drove every target
they could find, exhaustively, with no budget and no exploration. Nothing chose
between them, so nothing could learn that on THIS repo the differential oracle
pays and another round of HTTP probes does not.

**An action is a triple** ``(target, technique, oracle)``, exactly as
``bandit.Action`` describes:

===============================  ==================================
``(endpoint, schema_valid, status)``          the HTTP loop
``(module:fn, deterministic, crash)``         the function harness
``(module:fn, ast-corpus, differential)``     the differential oracle
``(boundary, contract-faults, fault)``        fault injection
``(module:fn, schedule, concurrency)``        the concurrency prober
``(repo, resolution-matrix, environment)``    the environment matrix
===============================  ==================================

Actions are ENUMERATED from the existing discovery functions — nothing here
re-implements discovery — and an oracle contributes actions only when it is
actually armed for this repo (no boundaries declared, no fault actions; no
``--base-url``, no HTTP actions).

**The loop.** Draw an action by Thompson sampling, run that oracle for that
target, measure what it cost, convert the result into an ``Outcome``, update the
posterior. Cost is MEASURED — wall-clock seconds normalised to probe-equivalents
plus the subprocesses the play spawned — not assumed to be 1.0, so an oracle
that takes forty seconds to find one thing loses to one that finds the same
thing in one second. Posteriors warm-start from ``campaign.json`` and are
persisted back, so the allocation a repo learned survives the run.

**What is reported.** ``by_technique`` and ``by_oracle`` answer the question a
human actually asks — "which technique paid on my repo?" — rather than making
them read per-arm posteriors.
"""

from __future__ import annotations

import inspect
import logging
import random
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import exception_policy, store
from .bandit import Action, ActionBandit, Outcome, seed_actions_from_prior

# Wall-clock seconds that count as ONE probe-equivalent. An HTTP probe against a
# local traced service is the unit the budget was always denominated in, and it
# costs a quarter-second or so end to end; every other oracle is priced against
# it so techniques of different price compete on YIELD rather than on being
# cheap to call. This is a prior, and it is persisted with the posteriors.
SECONDS_PER_PROBE_EQUIVALENT = 0.25

# How much of a previous campaign's evidence survives into the next one, matching
# the bandit's and the exception policy's expiry discipline.
CAMPAIGN_DECAY = 0.5

DEFAULT_BUDGET = 20
# No-improvement patience: stop after this many consecutive plays that break
# nothing AND reach no new ground. The same stopping rule shape as `run`'s
# rounds, at the campaign level.
DEFAULT_PATIENCE = 8
# Per-oracle caps on how many targets become actions. A bandit with 400 arms and
# a budget of 20 is just sampling; keeping the action space commensurate with
# the budget is what lets the posteriors mean anything within one run.
DEFAULT_MAX_TARGETS = 50

HTTP_TECHNIQUES = ("schema_valid", "schema_boundary", "schema_negative")


def campaign_path(repo: Path) -> Path:
    return store.exercise_dir(repo) / "campaign.json"


# =========================================================================
# One play
# =========================================================================


@dataclass
class Play:
    """What one oracle invocation produced, before it is priced."""

    violations: int = 0
    # Ground this play touched. The campaign dedupes across plays, so the
    # exploration bonus is paid for genuinely NEW ground, never for revisiting.
    covered: tuple[str, ...] = ()
    subprocesses: int = 0
    detail: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


# A runner is bound to its repo/config by ``default_runners``; the campaign
# only ever hands it the action it drew.
OracleRunner = Callable[[Action], Play]


def probe_equivalents(elapsed_s: float, subprocesses: int = 0) -> float:
    """Price one play in probe-equivalents. A MEASURED cost, never a constant.

    Wall-clock is the honest denominator for "violations per unit cost" because
    it is what the budget is really spent in. Subprocess count is a floor: an
    oracle that forks a worker has paid for a worker even if it returned fast.
    """
    by_clock = max(0.0, elapsed_s) / SECONDS_PER_PROBE_EQUIVALENT
    return max(1.0, by_clock, float(max(0, subprocesses)))


# =========================================================================
# Enumerating the action space from the EXISTING discovery functions
# =========================================================================


@dataclass
class ActionSpace:
    actions: list[Action] = field(default_factory=list)
    # Boundaries keyed by target, so the fault runner can recover the contract
    # and baseline the enumeration already read.
    boundaries: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    armed: dict[str, int] = field(default_factory=dict)


def enumerate_actions(
    repo: Path,
    *,
    base_url: str | None = None,
    max_targets: int = DEFAULT_MAX_TARGETS,
    include_environment: bool = False,
    logger: logging.Logger | None = None,
) -> ActionSpace:
    """Every ``(target, technique, oracle)`` armed for this repo.

    Discovery is IMPORTED, never re-implemented: ``functions.discover_targets``,
    ``differential.propose_references``, ``faults.load_boundaries`` and
    ``openapi.endpoints_from_apis`` are the same functions the standalone
    commands use, so the campaign cannot drift from what they would have driven.
    """
    log = logger or logging.getLogger(__name__)
    space = ActionSpace()

    def _arm(oracle: str, actions: Sequence[Action]) -> None:
        space.actions.extend(actions)
        space.armed[oracle] = space.armed.get(oracle, 0) + len(actions)

    # ---- HTTP: (endpoint x strategy x status) -----------------------------
    if base_url:
        try:
            from . import openapi

            apis = openapi.load_apis_json(str(store.apis_json_path(repo)))
            endpoints = openapi.endpoints_from_apis(apis)[:max_targets]
            _arm(
                "status",
                [
                    Action(target=ep.api_id, technique=t, oracle="status")
                    for ep in endpoints
                    for t in HTTP_TECHNIQUES
                ],
            )
            if not endpoints:
                space.notes.append("no endpoints in apis.json — the HTTP oracle is not armed")
        except Exception as exc:  # a missing/!=shaped apis.json must not kill the campaign
            space.notes.append(f"HTTP oracle unavailable: {exc}")
    else:
        space.notes.append("no --base-url — the HTTP oracle is not armed")

    # ---- functions + concurrency: (module:fn x … ) ------------------------
    function_targets: list[str] = []
    try:
        from . import functions

        targets, _skipped = functions.discover_targets(repo, max_targets=max_targets, logger=log)
        function_targets = [t.id for t in targets]
        _arm(
            "crash",
            [Action(target=t, technique="deterministic", oracle="crash") for t in function_targets],
        )
        _arm(
            "concurrency",
            [
                Action(target=t, technique="schedule", oracle="concurrency")
                for t in function_targets
            ],
        )
        if not function_targets:
            space.notes.append(
                "0 function targets discovered — the crash and concurrency "
                "oracles are not armed (is the code index built?)"
            )
    except Exception as exc:
        space.notes.append(f"function oracles unavailable: {exc}")

    # ---- differential: (module:fn x ast-corpus x differential) ------------
    try:
        from . import differential

        doc = differential.propose_references(repo, logger=log)
        refs = [
            str(e["target"])
            for e in (doc.get("references") or [])
            if isinstance(e, dict) and e.get("target")
        ][:max_targets]
        _arm(
            "differential",
            [Action(target=t, technique="ast-corpus", oracle="differential") for t in refs],
        )
        if not refs:
            space.notes.append(
                "no differential references proposed — the differential oracle is not armed"
            )
    except Exception as exc:
        space.notes.append(f"differential oracle unavailable: {exc}")

    # ---- faults: (boundary x contract-faults x fault) ---------------------
    try:
        from . import faults

        boundaries = faults.load_boundaries(repo)[:max_targets]
        for b in boundaries:
            space.boundaries[b.target] = b
        _arm(
            "fault",
            [
                Action(target=b.target, technique="contract-faults", oracle="fault")
                for b in boundaries
            ],
        )
        if not boundaries:
            space.notes.append(
                "no boundaries.json — the fault oracle is not armed (declare "
                "boundaries or run `exerciser faults --auto-target` once)"
            )
    except Exception as exc:
        space.notes.append(f"fault oracle unavailable: {exc}")

    # ---- environment: one repo-level action, opt-in ----------------------
    if include_environment:
        _arm(
            "environment",
            [
                Action(
                    target=repo.name or "repo",
                    technique="resolution-matrix",
                    oracle="environment",
                )
            ],
        )

    log.info(
        "campaign: %d actions armed across %d oracle(s)",
        len(space.actions),
        len([k for k, v in space.armed.items() if v]),
    )
    return space


# =========================================================================
# Runners — thin adapters over the EXISTING run_* entry points
# =========================================================================


@dataclass
class OracleConfig:
    """Everything the runners need that is not the action itself."""

    repo: Path
    base_url: str | None = None
    python: str | None = None
    timeout_s: float = 60.0
    probes_per_play: int = 20
    workers: int = 4
    repeats: int = 3
    boundaries: dict[str, Any] = field(default_factory=dict)
    logger: logging.Logger = field(default_factory=lambda: logging.getLogger(__name__))
    # Cross-play state: HTTP issue clusters are cumulative in issues.json, so a
    # play's violations are the DELTA it caused.
    _http_clusters: int = 0
    _functions_cache: dict[str, Any] | None = None


def _accepts(fn: Callable[..., Any], name: str) -> bool:
    """Does ``fn`` take a keyword called ``name``? (Feature detection.)"""
    try:
        return name in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def _clusters_for(result: dict[str, Any], target: str) -> int:
    """Issue clusters this result attributes to ``target``."""
    total = 0
    for cluster in result.get("clusters") or []:
        if isinstance(cluster, dict) and cluster.get("endpoint_id") == target:
            total += 1
    return total


def _functions_runner(cfg: OracleConfig) -> OracleRunner:
    from .functions import run_functions

    per_target = _accepts(run_functions, "only_targets")

    def run(action: Action) -> Play:
        if per_target:
            # The precise form: spend this unit of budget on THIS target.
            result = run_functions(
                cfg.repo,
                only_targets=[action.target],
                python=cfg.python,
                logger=cfg.logger,
            )
            subprocesses = max(1, int(result.get("modules") or 1))
        else:
            # `run_functions` has no per-target selector yet, so the harness is
            # run once per campaign and its findings are ATTRIBUTED per target.
            # The bandit still allocates (it decides whether to spend budget on
            # this oracle at all), but the first crash play pays for the whole
            # sweep — which is exactly what the measured cost then records.
            if cfg._functions_cache is None:
                cfg._functions_cache = run_functions(cfg.repo, python=cfg.python, logger=cfg.logger)
                subprocesses = max(1, int(cfg._functions_cache.get("modules") or 1))
            else:
                subprocesses = 0
            result = cfg._functions_cache
        # Dispersion self-supervision: the run has just produced a fresh set of
        # sightings, so turn them into real posterior movement.
        try:
            policy = exception_policy.ExceptionPolicy.load(cfg.repo, decay=1.0)
            exception_policy.apply_dispersion_evidence(
                policy, total_targets=int(result.get("targets") or 0)
            )
            policy.save(cfg.repo, logger=cfg.logger)
        except Exception as exc:
            cfg.logger.warning("campaign: dispersion self-supervision skipped: %s", exc)
        return Play(
            violations=_clusters_for(result, action.target),
            covered=(action.target,),
            subprocesses=subprocesses,
            detail={"calls": result.get("calls"), "verdicts": result.get("verdicts")},
        )

    return run


def _differential_runner(cfg: OracleConfig) -> OracleRunner:
    from .differential import run_differential

    def run(action: Action) -> Play:
        result = run_differential(
            cfg.repo,
            target=action.target,
            timeout_s=cfg.timeout_s,
            python=cfg.python,
            logger=cfg.logger,
        )
        # Both self-supervised and adjudicated evidence live here: this oracle
        # is the one that can LABEL an exception without asking a human.
        try:
            _learn_from_differential(cfg, result)
        except Exception as exc:
            cfg.logger.warning("campaign: differential self-supervision skipped: %s", exc)
        return Play(
            violations=int(result.get("mismatch_clusters") or 0),
            covered=(action.target,),
            subprocesses=1,
            detail={
                "comparisons": result.get("comparisons"),
                "policy_limits": result.get("policy_limit_count"),
                "unadjudicated": result.get("unadjudicated_count"),
            },
        )

    return run


def _learn_from_differential(cfg: OracleConfig, result: dict[str, Any]) -> None:
    """Turn a differential run into exception-policy evidence. Both sources."""
    rows = store.read_jsonl(store.exercise_dir(cfg.repo) / "differential_results.jsonl")
    # The repo's own top-level packages, read off the TARGETS the rows name
    # ("pkg.mod:fn" -> "pkg"), so a repo-defined exception is recognised as the
    # repo's own contract rather than as an unknown third party.
    repo_packages = {
        str(row.get("target", "")).partition(":")[0].partition(".")[0]
        for row in rows
        if row.get("target")
    }
    repo_packages.discard("")
    policy = exception_policy.ExceptionPolicy.load(cfg.repo, decay=1.0)
    exception_policy.observe_differential_rows(policy, rows, repo_packages=repo_packages)
    policy.save(cfg.repo, logger=cfg.logger)
    # Any adjudication a human or the agent channel has answered since last run
    # is a LABEL, and this is the call that lands it.
    adj = store.read_json(store.exercise_dir(cfg.repo) / "adjudications.json")
    verdicts, skipped = exception_policy.feedback_from_adjudications(
        adj, repo_packages=repo_packages
    )
    if verdicts:
        exception_policy.apply_feedback(cfg.repo, verdicts, logger=cfg.logger)
    if skipped:
        cfg.logger.info(
            "campaign: %d adjudication(s) carried no exception type and could "
            "not be turned into feedback",
            skipped,
        )


def _faults_runner(cfg: OracleConfig) -> OracleRunner:
    from .faults import run_faults

    def run(action: Action) -> Play:
        boundary = cfg.boundaries.get(action.target)
        result = run_faults(
            cfg.repo,
            target=action.target,
            contract=dict(getattr(boundary, "contract", {}) or {}) or None,
            baseline=dict(getattr(boundary, "baseline", {}) or {}) or None,
            timeout_s=cfg.timeout_s,
            python=cfg.python,
            logger=cfg.logger,
        )
        return Play(
            violations=int(result.get("issue_clusters") or 0),
            covered=(action.target,),
            subprocesses=1,
            detail={"faults_injected": result.get("faults_injected")},
        )

    return run


def _concurrency_runner(cfg: OracleConfig) -> OracleRunner:
    from .concurrency import run_concurrency

    def run(action: Action) -> Play:
        result = run_concurrency(
            cfg.repo,
            target=action.target,
            workers=cfg.workers,
            repeats=cfg.repeats,
            python=cfg.python,
            logger=cfg.logger,
        )
        return Play(
            violations=int(result.get("issue_clusters") or 0),
            covered=(action.target,),
            subprocesses=1,
            detail={"worker_timed_out": result.get("worker_timed_out")},
        )

    return run


def _http_runner(cfg: OracleConfig) -> OracleRunner:
    from .run import run_exercise

    def run(action: Action) -> Play:
        if not cfg.base_url:
            return Play(error="no base_url")
        result = run_exercise(
            cfg.repo,
            cfg.base_url,
            budget=cfg.probes_per_play,
            rounds=1,
            logger=cfg.logger,
        )
        # issues.json is cumulative across plays, so only the DELTA is this
        # play's finding — otherwise every later HTTP play would be credited
        # with every earlier play's clusters.
        now = int(result.get("issue_clusters") or 0)
        gained = max(0, now - cfg._http_clusters)
        cfg._http_clusters = now
        return Play(
            violations=gained,
            covered=(action.target,),
            subprocesses=0,
            detail={"probes_spent": result.get("probes_spent")},
        )

    return run


def _environment_runner(cfg: OracleConfig) -> OracleRunner:
    from .environment import run_environment

    def run(action: Action) -> Play:
        result = run_environment(cfg.repo, timeout_s=cfg.timeout_s, logger=cfg.logger)
        return Play(
            violations=int(result.get("issue_clusters") or 0),
            covered=(action.target,),
            subprocesses=1,
            detail={"status": result.get("status")},
        )

    return run


def default_runners(cfg: OracleConfig) -> dict[str, OracleRunner]:
    """The oracle name → runner map the campaign dispatches through."""
    return {
        "crash": _functions_runner(cfg),
        "differential": _differential_runner(cfg),
        "fault": _faults_runner(cfg),
        "concurrency": _concurrency_runner(cfg),
        "status": _http_runner(cfg),
        "environment": _environment_runner(cfg),
    }


# =========================================================================
# The loop
# =========================================================================


def run_campaign(
    repo: Path,
    *,
    budget: int = DEFAULT_BUDGET,
    seed: int = 1729,
    patience: int = DEFAULT_PATIENCE,
    base_url: str | None = None,
    max_targets: int = DEFAULT_MAX_TARGETS,
    include_environment: bool = False,
    python: str | None = None,
    timeout_s: float = 60.0,
    probes_per_play: int = 20,
    actions: Iterable[Action] | None = None,
    runners: dict[str, OracleRunner] | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Spend ``budget`` plays across every armed oracle, allocated by the bandit.

    ``actions`` and ``runners`` are injectable so the loop is testable without
    driving a real repository, exactly as ``run_exercise`` injects its probe and
    coverage functions.
    """
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()

    space = ActionSpace(actions=list(actions)) if actions is not None else None
    if space is None:
        space = enumerate_actions(
            repo,
            base_url=base_url,
            max_targets=max_targets,
            include_environment=include_environment,
            logger=log,
        )

    if runners is None:
        cfg = OracleConfig(
            repo=repo,
            base_url=base_url,
            python=python,
            timeout_s=timeout_s,
            probes_per_play=probes_per_play,
            boundaries=space.boundaries,
            logger=log,
        )
        runners = default_runners(cfg)

    diagnostics = list(space.notes)
    if not space.actions:
        diagnostics.append(
            "0 actions armed — no oracle is available for this repo, so there "
            "is nothing to allocate a budget across. See the notes above for "
            "which oracle was missing what."
        )
        log.warning("campaign_empty %s", diagnostics[-1])
        return {
            "status": "ok",
            "diagnostics": diagnostics,
            "repo": str(repo),
            "actions": 0,
            "budget": budget,
            "plays": [],
            "plays_run": 0,
            "violations": 0,
            "stopped": "no-actions",
        }

    # Warm start: last campaign's posteriors, decayed, restricted to the actions
    # that are STILL armed — a target that has since vanished must not keep a
    # seat at the table.
    prior = store.read_json(campaign_path(repo)) or {}
    bandit = ActionBandit(actions=tuple(space.actions), bernoulli=True)
    seed_actions_from_prior(bandit, prior.get("bandit"), decay=CAMPAIGN_DECAY)
    live = {a.key for a in space.actions}
    bandit.actions = tuple(a for a in bandit.actions if a.key in live)
    bandit.arms = {k: v for k, v in bandit.arms.items() if k in live}
    warm_started = sum(1 for arm in bandit.arms.values() if arm.alpha != 1.0 or arm.beta != 1.0)

    rng = random.Random(seed)
    covered_ground: set[str] = set()
    plays: list[dict[str, Any]] = []
    stale = 0
    stopped = "budget-exhausted"
    total_violations = 0

    while len(plays) < budget:
        action = bandit.select(rng)
        if action is None:
            stopped = "no-actions"
            break
        runner = runners.get(action.oracle)
        if runner is None:
            # An unarmed oracle must not be drawn again, or the budget drains
            # into a no-op.
            bandit.actions = tuple(a for a in bandit.actions if a.oracle != action.oracle)
            bandit.arms.pop(action.key, None)
            diagnostics.append(f"no runner for oracle '{action.oracle}' — its actions were dropped")
            if not bandit.actions:
                stopped = "no-actions"
                break
            continue

        started = time.perf_counter()
        try:
            play = runner(action)
        except Exception as exc:  # one broken oracle must not end the campaign
            play = Play(error=f"{type(exc).__name__}: {exc}")
            log.warning("campaign: %s raised %s", action.key, exc)
        elapsed = time.perf_counter() - started

        fresh = [c for c in play.covered if c not in covered_ground]
        covered_ground.update(fresh)
        cost = probe_equivalents(elapsed, play.subprocesses)
        outcome = Outcome(violations=play.violations, new_coverage=len(fresh), cost=cost)
        # rng is threaded in so the credit is BERNOULLI-ISED — the genuine
        # conjugate update, and the one Thompson's regret bound is proved for.
        bandit.update(action, outcome, rng=rng)
        total_violations += play.violations

        plays.append(
            {
                "play": len(plays) + 1,
                **action.to_json(),
                "violations": play.violations,
                "new_coverage": len(fresh),
                "elapsed_s": round(elapsed, 4),
                "cost_probe_equivalents": round(cost, 4),
                "credit": round(outcome.credit(bandit.coverage_bonus), 4),
                "error": play.error,
                "detail": play.detail,
            }
        )

        if play.violations == 0 and not fresh:
            stale += 1
        else:
            stale = 0
        if stale >= patience:
            stopped = "no-improvement-patience"
            break

    preferred = bandit.preferred()
    bandit_doc = bandit.to_json()
    doc = {
        "version": 1,
        "repo": str(repo),
        "budget": budget,
        "seed": seed,
        "patience": patience,
        "priors": {"seconds_per_probe_equivalent": SECONDS_PER_PROBE_EQUIVALENT},
        "bandit": bandit_doc,
    }
    store.write_json(campaign_path(repo), doc)

    result: dict[str, Any] = {
        "status": "ok",
        "diagnostics": diagnostics,
        "repo": str(repo),
        "actions": len(bandit.actions),
        "armed": dict(sorted(space.armed.items())),
        "budget": budget,
        "plays_run": len(plays),
        "warm_started_arms": warm_started,
        "violations": total_violations,
        "new_ground": len(covered_ground),
        "stopped": stopped,
        # The question a human actually asks of the loop.
        "by_technique": bandit_doc["by_technique"],
        "by_oracle": bandit_doc["by_oracle"],
        "preferred": preferred.to_json() if preferred else None,
        "plays": plays,
        "campaign_file": str(campaign_path(repo)),
    }
    log.info(
        "campaign: %d/%d plays, %d violations, stopped=%s, preferred=%s",
        len(plays),
        budget,
        total_violations,
        stopped,
        preferred.key if preferred else "-",
    )
    return result
