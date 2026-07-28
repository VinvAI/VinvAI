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

**Credit is paid once per defect.** Every oracle reports its findings as issue
CLUSTERS with a stable signature, and the loop credits only signatures it has
never credited before — within the run and, through ``campaign.json``, across
runs. Without that, a deterministic oracle re-earns full credit every time the
bandit replays its arm: the posterior climbs on one bug, the no-improvement
counter never fires because the play never reports zero, and the campaign spends
its whole budget re-discovering something it already knew while reporting
sustained yield.

**What is reported.** ``by_technique`` and ``by_oracle`` answer the question a
human actually asks — "which technique paid on my repo?" — rather than making
them read per-arm posteriors.
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import exception_policy, store
from .bandit import Action, ActionBandit, Outcome, seed_actions_from_prior
from .interpreter import resolve_cached

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
# Upper bound on the credited-signature ledger persisted in ``campaign.json``.
# Large enough that a repo's real defect population fits; bounded so the file
# cannot grow without limit across years of runs.
#
# The ledger is kept LEAST-RECENTLY-USED, not sorted. Truncating a sorted set
# evicted by ALPHABET: past the cap, whichever signatures happened to sort last
# were dropped — including ones re-found on every single run — and a dropped
# signature is re-creditable, so the loop pays twice for the same defect. LRU
# evicts the signature nothing has re-found in the longest time, which is the
# only eviction order that matches what the ledger is for.
MAX_CREDITED_SIGNATURES = 5000

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
    # Cluster signatures this play's oracle reported. The campaign dedupes these
    # ACROSS plays and across runs, so `violations` is re-derived as the count of
    # signatures never credited before. A runner that reports no signatures keeps
    # its own `violations` (there is nothing to dedupe on).
    signatures: tuple[str, ...] = ()
    # Units of work the oracle actually performed — calls made, inputs compared,
    # faults injected. ``None`` means the oracle reports no such counter, which
    # is NOT the same as zero: unknown work is treated as conclusive, zero work
    # is not.
    #
    # Every runner claims ``covered=(action.target,)`` the moment it is invoked,
    # so a play whose worker never imported the target — the target's own
    # dependencies missing, the wrong ``--python``, a module that dies on import
    # — still collected the exploration bonus and still posted a Bernoulli
    # update. The bandit was learning a preference over arms it had never
    # measured, and the report said ``status: ok`` for a campaign that exercised
    # nothing. Distinguishing "ran and found nothing" from "never ran" is the
    # difference between evidence and noise.
    work: int | None = None
    # The cluster OBJECTS behind those signatures.
    #
    # Counting findings and being able to REPORT them are different things, and
    # only the first was ever wired: every oracle wrote its clusters to its own
    # artifact (functions.json, differential.json, …) and the campaign kept just
    # the signatures for credit accounting. Nothing merged them anywhere the
    # extension reads, and `exerciseStateFromArtifacts` reads exactly one file —
    # `issues.json`. So five complete oracles could run, find real defects, and
    # surface nothing: the dispatch path had no document to look at.
    clusters: tuple[dict[str, Any], ...] = ()
    # What the oracle said about the RUN rather than about a target. An oracle
    # that could not import the code under test reports it, and the campaign
    # dropped it on the floor: `_functions_runner` kept clusters, violations and
    # a two-key detail, so `status: "environment"` and the import canary died at
    # the runner boundary and the campaign still answered `status: "ok"` with
    # zero findings — the exact ambiguity the canary exists to remove, on the
    # command the extension actually runs.
    diagnostics: tuple[str, ...] = ()
    #: Non-"ok" only when the oracle says the run itself was not valid.
    status: str = "ok"


# A runner is bound to its repo/config by ``default_runners``; the campaign
# only ever hands it the action it drew.
OracleRunner = Callable[[Action], Play]


def _as_count(value: Any) -> int | None:
    """A work counter as a non-negative int, or ``None`` when the oracle omitted it.

    A missing key and a zero mean opposite things here — see ``Play.work`` — so
    ``None`` is preserved rather than coerced to 0. A negative or non-numeric
    value is treated as unreported for the same reason: it cannot support the
    claim that work happened.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 0 else None


def is_inconclusive(play: Play) -> bool:
    """The play produced no evidence either way, so it must not teach the bandit.

    Zero work AND nothing found. Either alone is not enough: an oracle that
    reports no work counter is unknown-not-zero, and a play that found a
    violation plainly ran whatever its counter says.
    """
    return play.work == 0 and play.violations == 0 and not play.signatures


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
    python: str | None = None,
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

        targets, _skipped, refusals = functions.discover_with_refusals(
            repo, max_targets=max_targets, logger=log
        )
        # The crash oracle drives the unverifiable set through containment now,
        # so those targets are BUDGETABLE: enumerating only the verified-pure
        # ones would hand the bandit an action space four fifths smaller than the
        # oracle it allocates to. Concurrency stays pure-only — it runs its
        # schedules IN PROCESS, and containment is not part of that path.
        function_targets = [t.id for t in targets]
        contained_targets = [r.id for r in refusals]
        _arm(
            "crash",
            [
                Action(target=t, technique="deterministic", oracle="crash")
                for t in [*function_targets, *contained_targets]
            ],
        )
        _arm(
            "concurrency",
            [
                Action(target=t, technique="schedule", oracle="concurrency")
                for t in function_targets
            ],
        )
        if not function_targets and not contained_targets:
            space.notes.append(
                "0 function targets discovered — the crash and concurrency "
                "oracles are not armed (is the code index built?)"
            )
        elif not function_targets:
            space.notes.append(
                f"0 verified-pure function targets — the crash oracle is armed on "
                f"{len(contained_targets)} target(s) driven under containment; "
                "the concurrency oracle (in-process) is not armed"
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
        if not boundaries:
            # A declaration is the preferred source, not the only one. Waiting
            # for a hand-written boundaries.json meant this oracle armed zero
            # actions on every repo nobody had prepared — and the campaign said
            # so in a note that no code path ever acted on. The drivable targets
            # are already catalogued and their annotations already declare a
            # domain, so derive from those instead of reporting the vacuum.
            derived = faults.derive_boundaries(repo, function_targets[:max_targets], python)
            if derived:
                space.notes.append(
                    f"no boundaries.json — derived {len(derived)} boundary(ies) from the "
                    "consumers' own annotations"
                )
            boundaries = derived
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
                "the fault oracle is not armed: no boundaries.json, and no catalogued "
                "target carries enough annotation to derive a contract from"
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


def _cluster_signature(cluster: dict[str, Any]) -> str:
    """A stable identity for one cluster.

    Every oracle's cluster document carries ``signature`` (``issues.normalize_
    signature``), which is exactly the digit-normalised identity the rest of Vinv
    dedupes on. The fallback exists only so a hand-written or older document
    still dedupes on SOMETHING rather than silently paying twice.
    """
    sig = cluster.get("signature")
    if isinstance(sig, str) and sig:
        return sig
    return "|".join(str(cluster.get(k, "")) for k in ("kind", "endpoint_id", "title"))


def _findings(
    result: dict[str, Any],
    count_key: str = "issue_clusters",
    *,
    target: str | None = None,
) -> tuple[int, tuple[str, ...]]:
    """``(violations, signatures)`` for one oracle result document.

    The signatures are what let the campaign credit a defect ONCE. Without them
    every runner returned the run's TOTAL cluster count, so a deterministic
    oracle re-earned full credit on every play of the same arm: alpha climbed
    monotonically, Thompson concentrated on the arm, and because the play never
    reported zero violations the no-improvement counter could never fire. The
    campaign then spent its whole budget re-finding one known bug and reported it
    as sustained yield.

    ``count_key`` is the result's own total, used only when the document carries
    no ``clusters`` list at all — then there is nothing to dedupe on and the
    total is the honest answer. It defaults to ``issue_clusters``, which every
    oracle now uses: this parameter existed ONLY because `differential` spelled
    its total `mismatch_clusters`, so one divergent dict key had propagated all
    the way into the orchestrator's signature.
    """
    clusters = result.get("clusters")
    if not isinstance(clusters, list):
        return int(result.get(count_key) or 0), ()
    sigs = [
        _cluster_signature(c)
        for c in clusters
        if isinstance(c, dict) and (target is None or c.get("endpoint_id") == target)
    ]
    return len(sigs), tuple(sigs)


def _merge_into_issues(
    repo: Path,
    clusters: dict[str, dict[str, Any]],
    *,
    logger: logging.Logger | None = None,
) -> int:
    """Publish the oracles' clusters into ``issues.json``. Returns how many were new.

    This is the step that was missing, and without it the five newer oracles
    were unreachable in practice however correct they were. Each writes its own
    artifact (``functions.json``, ``differential.json``, …), and the campaign
    kept only signatures for credit accounting — but the extension's dispatch
    path (``exerciseStateFromArtifacts`` → ``clustersToEpisodes`` →
    ``dispatchIssueEpisode``) reads exactly ONE file: ``issues.json``. So a
    campaign could find real defects and surface none of them.

    Merging rather than overwriting, keyed on signature, because ``run`` owns
    this file for the HTTP oracle and both sets of findings are real. The
    extension already dedupes dispatches by signature, so a cluster appearing
    here twice across passes costs nothing.

    ORDERING REQUIREMENT: the campaign must run AFTER ``run`` in a pass, since
    ``run`` rewrites this file wholesale. ``exerciseRunner`` invokes it last.
    """
    log = logger or logging.getLogger(__name__)
    if not clusters:
        return 0
    path = store.issues_path(repo)
    doc = store.read_json(path)
    existing = doc.get("clusters") if isinstance(doc, dict) else None
    by_sig: dict[str, dict[str, Any]] = {}
    if isinstance(existing, list):
        for c in existing:
            if isinstance(c, dict):
                by_sig[_cluster_signature(c)] = c
    before = len(by_sig)
    for sig, cluster in clusters.items():
        by_sig.setdefault(sig, cluster)
    ordered = sorted(by_sig.values(), key=lambda c: (str(c.get("kind")), str(c.get("path"))))
    store.write_json(
        path,
        {"version": 1, "cluster_count": len(ordered), "clusters": ordered},
    )
    added = len(by_sig) - before
    log.info(
        "campaign: published %d oracle cluster(s) into issues.json (%d new, %d total)",
        len(clusters),
        added,
        len(ordered),
    )
    return added


def _clusters_of(
    result: dict[str, Any], *, target: str | None = None
) -> tuple[dict[str, Any], ...]:
    """The cluster objects one oracle reported, filtered to ``target``.

    Same selection rule as ``_findings`` so the objects a play carries and the
    signatures it is credited for cannot disagree.
    """
    clusters = result.get("clusters")
    if not isinstance(clusters, list):
        return ()
    return tuple(
        c
        for c in clusters
        if isinstance(c, dict) and (target is None or c.get("endpoint_id") == target)
    )


def _diagnostics_of(result: dict[str, Any]) -> tuple[str, ...]:
    """What an oracle said about the RUN, carried up to the campaign's report.

    Every oracle already produced these and every runner threw them away, so a
    finding about the apparatus — no importable target, an interpreter without
    the repo installed, a shared unmet precondition — reached `functions.json`
    and stopped there. The campaign's own summary is what the CLI prints and
    what a human reads, and it said nothing.
    """
    found = result.get("diagnostics")
    if not isinstance(found, list):
        return ()
    return tuple(str(d) for d in found if isinstance(d, str) and d)


def _functions_runner(cfg: OracleConfig) -> OracleRunner:
    from .functions import run_functions

    def run(action: Action) -> Play:
        # Spend this unit of budget on THIS target. There used to be a
        # `_accepts(run_functions, "only_targets")` feature-detection here with
        # a whole-sweep fallback branch — but `run_functions` is a sibling in
        # this same package and declares `only_targets` unconditionally, so the
        # probe was always True and the fallback was unreachable. Runtime
        # feature-detection of your own module is defensive programming against
        # yourself, and its dead branch carried a comment asserting something
        # ("no per-target selector yet") that is no longer true.
        result = run_functions(
            cfg.repo,
            only_targets=[action.target],
            python=cfg.python,
            logger=cfg.logger,
        )
        subprocesses = max(1, int(result.get("modules") or 1))
        # No self-supervised mass is posted here any more. Dispersion is a
        # COVARIATE (it enters the structural prior, from the sightings
        # `run_functions` has just persisted), and posting it as α/β made a
        # never-labelled signature both suppressed and "confident" — an
        # absorbing state, because suppression is what prevents the label ever
        # arriving. `run_functions` explores instead: its Thompson draw
        # occasionally surfaces a thinly-labelled signature so the differential
        # oracle and the adjudication channel can put a real label on it.
        violations, signatures = _findings(result, target=action.target)
        clusters = _clusters_of(result, target=action.target)
        canary = result.get("import_canary") or {}
        return Play(
            clusters=clusters,
            violations=violations,
            signatures=signatures,
            covered=(action.target,),
            subprocesses=subprocesses,
            work=_as_count(result.get("calls")),
            diagnostics=_diagnostics_of(result),
            status=str(result.get("status") or "ok"),
            detail={
                "calls": result.get("calls"),
                "verdicts": result.get("verdicts"),
                # The one fact that decides whether this play's zero means
                # anything: a worker that never imported the target found
                # nothing BECAUSE it never ran it.
                "own_packages_unimportable": list(canary.get("own_packages_unimportable") or ()),
            },
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
        violations, signatures = _findings(result)
        clusters = _clusters_of(result)
        return Play(
            clusters=clusters,
            violations=violations,
            signatures=signatures,
            covered=(action.target,),
            subprocesses=1,
            diagnostics=_diagnostics_of(result),
            status=str(result.get("status") or "ok"),
            work=_as_count(result.get("comparisons")),
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
        violations, signatures = _findings(result)
        clusters = _clusters_of(result)
        return Play(
            clusters=clusters,
            violations=violations,
            signatures=signatures,
            covered=(action.target,),
            subprocesses=1,
            diagnostics=_diagnostics_of(result),
            status=str(result.get("status") or "ok"),
            work=_as_count(result.get("faults_injected")),
            detail={"faults_injected": result.get("faults_injected")},
        )

    return run


def _valid_kwargs_for(cfg: OracleConfig, target: str) -> dict[str, Any]:
    """A well-formed argument map for a target, from its own annotations.

    Without this the campaign called every concurrency target as ``fn()``. Any
    function with a required parameter then raised ``TypeError`` in BOTH the
    serial baseline and the concurrent batch — and because the two agreed, the
    oracle did not merely miss the bug, it actively CERTIFIED the target as
    concurrency-safe. ``functions`` already knows how to build these; the
    signature is read out-of-process by the same helper the faults oracle uses.
    """
    from .faults import infer_contract_from_signature
    from .functions import resolved_value_for

    try:
        contract = infer_contract_from_signature(target, cfg.python, cfg.repo)
    except Exception:  # a signature we cannot read is not worth failing a play
        return {}
    kwargs: dict[str, Any] = {}
    for name, annotation in contract.items():
        value, _resolved = resolved_value_for(annotation, "valid")
        kwargs[name] = value
    return kwargs


def _concurrency_runner(cfg: OracleConfig) -> OracleRunner:
    from .concurrency import run_concurrency

    def run(action: Action) -> Play:
        result = run_concurrency(
            cfg.repo,
            target=action.target,
            workers=cfg.workers,
            repeats=cfg.repeats,
            kwargs=_valid_kwargs_for(cfg, action.target),
            python=cfg.python,
            logger=cfg.logger,
        )
        violations, signatures = _findings(result)
        clusters = _clusters_of(result)
        return Play(
            clusters=clusters,
            violations=violations,
            signatures=signatures,
            covered=(action.target,),
            subprocesses=1,
            diagnostics=_diagnostics_of(result),
            status=str(result.get("status") or "ok"),
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
        # issues.json is cumulative across plays, so a play's finding is what is
        # NEW in it — otherwise every later HTTP play would be credited with
        # every earlier play's clusters. `run_exercise` reports only the count,
        # so the signatures come from the document it just wrote; when that
        # cannot be read, the count DELTA is the fallback (same intent, coarser).
        now = int(result.get("issue_clusters") or 0)
        issues = store.read_json(store.issues_path(cfg.repo)) or {}
        if isinstance(issues.get("clusters"), list):
            violations, signatures = _findings(issues, "cluster_count")
        else:
            violations, signatures = max(0, now - cfg._http_clusters), ()
        cfg._http_clusters = now
        return Play(
            violations=violations,
            signatures=signatures,
            covered=(action.target,),
            subprocesses=0,
            work=_as_count(result.get("probes_spent")),
            detail={"probes_spent": result.get("probes_spent")},
        )

    return run


def _environment_runner(cfg: OracleConfig) -> OracleRunner:
    from .environment import run_environment

    def run(action: Action) -> Play:
        result = run_environment(cfg.repo, timeout_s=cfg.timeout_s, logger=cfg.logger)
        violations, signatures = _findings(result)
        clusters = _clusters_of(result)
        return Play(
            clusters=clusters,
            violations=violations,
            signatures=signatures,
            covered=(action.target,),
            subprocesses=1,
            diagnostics=_diagnostics_of(result),
            status=str(result.get("status") or "ok"),
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

    # Resolved ONCE for the whole campaign and handed to every oracle: five
    # oracles independently defaulting to `sys.executable` was five separate
    # ways to spend a budget importing nothing.
    interpreter_choice = resolve_cached(repo, explicit=python, logger=log)
    python = interpreter_choice.python

    space = ActionSpace(actions=list(actions)) if actions is not None else None
    if space is None:
        space = enumerate_actions(
            repo,
            base_url=base_url,
            max_targets=max_targets,
            include_environment=include_environment,
            python=python,
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

    diagnostics = list(interpreter_choice.diagnostics) + list(space.notes)
    if not space.actions:
        diagnostics.append(
            "0 actions armed — no oracle is available for this repo, so there "
            "is nothing to allocate a budget across. See the notes above for "
            "which oracle was missing what."
        )
        log.warning("campaign_empty %s", diagnostics[-1])
        return {
            "status": "ok",
            # Same keys as the main return: a caller that reads `interpreter`
            # must not have to know which branch produced the document, and the
            # empty-action case is exactly when "which environment was this?" is
            # the question being asked.
            "own_packages_unimportable": [],
            "diagnostics": diagnostics,
            "interpreter": interpreter_choice.to_json(),
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

    # Defects already paid for. A cluster signature credits ONCE, ever: within a
    # run (a deterministic oracle re-finds the same thing on every play of the
    # arm) and across runs (a defect found yesterday must not pay again today).
    # An insertion-ordered ledger: oldest first, most recently re-found last.
    # `dict` rather than `set` precisely so eviction can be LRU (see
    # `MAX_CREDITED_SIGNATURES`).
    credited_signatures: dict[str, None] = dict.fromkeys(
        str(s) for s in (prior.get("credited_signatures") or []) if isinstance(s, str)
    )

    rng = random.Random(seed)
    covered_ground: set[str] = set()
    plays: list[dict[str, Any]] = []
    # An oracle's run-level findings, deduped: the campaign replays the same arm
    # many times, and one unimportable repo repeated twenty times is one fact.
    oracle_diagnostics: dict[str, None] = {}
    unimportable: dict[str, None] = {}
    environment_plays = 0
    # signature -> cluster object, for the issues document written at the end.
    reported_clusters: dict[str, dict[str, Any]] = {}
    stale = 0
    stopped = "budget-exhausted"
    total_violations = 0
    repeat_violations = 0
    inconclusive_plays = 0

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

        # What the oracle said about the run itself, kept once however many plays
        # repeat it. Dropping this is how a campaign over a repo it could not
        # import still answered `status: "ok"` with an empty `diagnostics`.
        for diag in play.diagnostics:
            oracle_diagnostics[diag] = None
        if play.status == "environment":
            environment_plays += 1
        for name in play.detail.get("own_packages_unimportable") or ():
            unimportable[str(name)] = None

        # An inconclusive play measured nothing, so it claims no ground and posts
        # no posterior update — it is billed for the time it burned (the budget
        # unit is spent either way) and counted, so the report can say plainly
        # that N plays never reached their target.
        inconclusive = is_inconclusive(play)
        fresh = [] if inconclusive else [c for c in play.covered if c not in covered_ground]
        covered_ground.update(fresh)
        # An oracle re-run on the same arm re-reports the same deterministic
        # defect. Only signatures never credited before are this play's finding;
        # the rest are counted as repeats and paid nothing, which is also what
        # lets the no-improvement counter reach `patience`.
        if play.signatures:
            unique = dict.fromkeys(play.signatures)
            new_signatures = [s for s in unique if s not in credited_signatures]
            for sig in unique:
                # Move-to-end on every sighting, not only the first: a signature
                # this run re-found is the LAST thing that should be evicted.
                credited_signatures.pop(sig, None)
                credited_signatures[sig] = None
            violations = len(new_signatures)
            repeats = len(play.signatures) - violations
        else:
            violations, repeats = play.violations, 0
        repeat_violations += repeats
        # Keep the cluster OBJECTS for the report, keyed by signature so a
        # signature re-found by a later play does not appear twice. Credit is
        # paid once; the finding is still worth SHOWING once.
        for cluster in play.clusters:
            reported_clusters.setdefault(_cluster_signature(cluster), cluster)

        cost = probe_equivalents(elapsed, play.subprocesses)
        outcome = Outcome(violations=violations, new_coverage=len(fresh), cost=cost)
        if inconclusive:
            inconclusive_plays += 1
        else:
            # rng is threaded in so the credit is BERNOULLI-ISED — the genuine
            # conjugate update, and the one Thompson's regret bound is proved for.
            bandit.update(action, outcome, rng=rng)
        total_violations += violations

        plays.append(
            {
                "play": len(plays) + 1,
                **action.to_json(),
                "violations": violations,
                # Findings this play re-reported that a previous play (or a
                # previous campaign) had already been paid for.
                "repeat_violations": repeats,
                "new_coverage": len(fresh),
                "elapsed_s": round(elapsed, 4),
                "cost_probe_equivalents": round(cost, 4),
                "credit": 0.0 if inconclusive else round(outcome.credit(bandit.coverage_bonus), 4),
                "inconclusive": inconclusive,
                "error": play.error,
                "detail": play.detail,
            }
        )

        if violations == 0 and not fresh:
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
        # Deliberately NOT decayed like the posteriors: a defect stays found.
        # Bounded so the file cannot grow without limit on a long-lived repo,
        # and bounded from the OLD end — the tail is what this run re-found.
        "credited_signatures": list(credited_signatures)[-MAX_CREDITED_SIGNATURES:],
    }
    store.write_json(campaign_path(repo), doc)
    merged = _merge_into_issues(repo, reported_clusters, logger=log)

    if inconclusive_plays:
        diagnostics.append(
            f"{inconclusive_plays}/{len(plays)} plays reached no target and were not "
            "scored — the oracle worker could not import the code under test. Point "
            "--python at the interpreter where the target's own dependencies are "
            "installed."
        )
    diagnostics.extend(oracle_diagnostics)

    # A campaign that could not load the code under test found nothing BECAUSE it
    # never ran it, and that is not the claim `status: "ok"` makes. The oracles
    # already decided this per play; until now the answer stopped at the runner
    # boundary and the campaign — the command the extension runs — reported a
    # clean zero anyway, which is the whole failure this branch exists to fix.
    blocked = bool(unimportable) and environment_plays > 0
    if blocked:
        diagnostics.append(
            f"{environment_plays}/{len(plays)} plays could not import the repo's own "
            f"package(s) {', '.join(sorted(unimportable))} under {python}. This run "
            "measured the environment, not the code — its zero is not a clean result."
        )
        log.warning("campaign_environment %s", diagnostics[-1])

    result: dict[str, Any] = {
        "status": "environment" if blocked else "ok",
        # The repo's own packages no play could import, empty on a healthy run.
        # `status` alone cannot be acted on; this says what to install where.
        "own_packages_unimportable": sorted(unimportable),
        "diagnostics": diagnostics,
        # The interpreter every oracle's workers ran under. `inconclusive_plays`
        # says budget reached no target; this says which environment it was spent
        # in, which is the first thing to check when that number is high.
        "interpreter": interpreter_choice.to_json(),
        "repo": str(repo),
        "actions": len(bandit.actions),
        "armed": dict(sorted(space.armed.items())),
        "budget": budget,
        "plays_run": len(plays),
        # Plays that never reached their target: budget spent, no evidence
        # produced, no posterior updated. Reported so `status: ok` cannot read as
        # "your code was exercised" when it was not.
        "inconclusive_plays": inconclusive_plays,
        # Oracle clusters published into issues.json — the file the extension's
        # dispatch path reads. Without this the five non-HTTP oracles surface
        # nothing however much they find.
        "issues_merged": merged,
        "warm_started_arms": warm_started,
        # NEW findings only. `repeat_violations` is the re-discovery this loop
        # refused to pay for — the number that used to be silently added in.
        "violations": total_violations,
        "repeat_violations": repeat_violations,
        "credited_signatures": len(credited_signatures),
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
        "campaign: %d/%d plays, %d new violations (%d repeats), stopped=%s, preferred=%s",
        len(plays),
        budget,
        total_violations,
        repeat_violations,
        stopped,
        preferred.key if preferred else "-",
    )
    return result
