"""Regression replay — the accumulated behavior suite, diffed against baselines.

Every distinct ``(endpoint, input) → expected status + shape`` recorded by ``run``
becomes a permanent regression case (testflow's "every discovered behavior
becomes a permanent regression test"). ``regress`` replays them against the live
service and reports behaviour / perf / contract diffs, routing each verdict
through the SAME degraded/same/improved semantics ``probeBaseline.ts`` uses
(``baseline.py`` port).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import state, store
from .baseline import apply_baselines, status_class
from .execute import ProbeResult, execute_probe
from .invariants import check_observation
from .optimize import bootstrap_median_ci
from .probe import input_size_of, probe_id_of
from .scenario import run_scenario
from .throughput import percentile

ProbeFn = Callable[..., ProbeResult]


def _size_of(value: Any) -> int:
    if isinstance(value, dict | list | str):
        return len(value)
    return 0


def _suite_from_results(executions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Distinct (endpoint, strategy, path_params) replay cases, newest wins.

    Negative-class probes are kept too — a service that STOPS rejecting a bad
    input has regressed just as surely as one that starts 500ing a good one.
    """
    seen: dict[str, dict[str, Any]] = {}
    for ex in executions:
        inp = ex.get("input", {})
        # Scenario-derived rows carry no replayable request shape — skip them.
        if "path_params" not in inp and "body" not in inp:
            continue
        # SHARED formula. This module and `run` both write baselines/<api_id>.json;
        # a locally-derived id lands in a disjoint space, so every replay compares
        # against a golden that does not exist and `degraded` is structurally zero.
        probe_id = probe_id_of(ex)
        seen[probe_id] = {
            "probeId": probe_id,
            "endpoint_id": ex["endpoint_id"],
            "method": ex["method"],
            "path": ex["path"],
            "handler": ex.get("handler"),
            "input": ex["input"],
            "input_class": ex["input_class"],
            "expected_status": ex["status"],
            "expected_shape": ex["shape_hash"],
            "prev_latency_ms": ex.get("latency_ms"),
            # Authed rows replay only under freshly-captured credentials —
            # the recorded run's tokens are gone (never persisted) and expired.
            "auth": bool(ex.get("auth")),
            # WHICH credential set recorded this expectation. Replaying every
            # case as fresh_auth[0] made a superuser-only 200, re-issued as the
            # normal user, come back 403 and be reported as a behavior
            # regression on completely unchanged code.
            "auth_index": ex.get("auth_index"),
            # Replay with the encoding the run used, or a form endpoint's replay
            # 422s and reads as a behaviour regression against its own golden.
            "content_type": ex.get("content_type"),
        }
    return list(seen.values())


def _fresh_auth_headers(
    repo: Path,
    base_url: str,
    probe_fn: ProbeFn,
) -> list[dict[str, str]]:
    """Re-capture live credentials by replaying the plan's scenario SETUP chains.

    Tokens are never persisted, so regress earns its own: run each authored
    scenario's setup steps (login chains) and resolve the header templates
    through the captured variables — same discipline as the run-side sweep.
    """
    from .run import _resolved_auth_headers, _split_endpoint

    plan = store.read_json(store.plan_path(repo)) or {}
    out: list[dict[str, str]] = []
    for ep in plan.get("endpoints", []):
        for splan in ep.get("semantic_inputs") or []:
            setup = splan.get("setup") or []
            if not setup:
                continue
            steps = []
            for s in setup:
                method, path = _split_endpoint(s.get("endpoint", ""))
                steps.append(
                    {
                        "method": method,
                        "path": path,
                        "inputs": s.get("inputs") or {},
                        "capture": s.get("capture") or {},
                        "expect": {"status": "2xx"},
                    }
                )
            res = run_scenario(
                base_url,
                "auth-refresh",
                steps,
                exercise_id="vinv-regress-auth",
                probe_fn=probe_fn,
            )
            template_steps = steps + [{"inputs": splan.get("inputs") or {}}]
            for hdrs in _resolved_auth_headers(template_steps, res.variables):
                if hdrs not in out:
                    out.append(hdrs)
    return out


def replay_suite(
    repo: Path,
    base_url: str,
    *,
    service: str | None = None,
    exercise_id: str = "vinv-regress",
    latency_regression_factor: float = 2.0,
    probe_fn: ProbeFn = execute_probe,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Replay the accumulated suite and report diffs. Returns a summary."""
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()

    executions = store.read_jsonl(store.results_path(repo))
    if not executions:
        return {"status": "error", "error": "no results.jsonl — run `exerciser run` first"}
    suite = _suite_from_results(executions)

    # Values the engine itself planted and never cleaned (state ledger): a diff
    # touching them is ENVIRONMENT drift (our own residue), not a regression.
    planted = state.planted_values(repo)

    # Learned invariants — ENFORCED on every replay: a healthy-looking reply
    # that breaks a learned assertion is an ``invariant`` diff, the class no
    # status code or exception ever surfaces.
    inv_by_endpoint = store.read_invariants_by_endpoint(repo)

    # Fresh credentials for authed cases (captured live, never from disk).
    fresh_auth = (
        _fresh_auth_headers(repo, base_url, probe_fn) if any(c.get("auth") for c in suite) else []
    )
    auth_skipped = 0

    observations: list[dict[str, Any]] = []
    diffs: list[dict[str, Any]] = []
    for case in suite:
        inp = case["input"]
        headers = None
        if case.get("auth"):
            if not fresh_auth:
                auth_skipped += 1  # credentials not reproducible right now
                continue
            # Replay under the credential that RECORDED the expectation. Using
            # index 0 for every case compared one identity's response against
            # another identity's golden — a deterministic, permanent, wholly
            # self-inflicted "regression" that never self-heals.
            idx = case.get("auth_index")
            if not isinstance(idx, int):
                idx = 0  # pre-`auth_index` suites: one identity is the best guess
            if idx >= len(fresh_auth):
                auth_skipped += 1  # that identity did not re-capture this time
                continue
            headers = fresh_auth[idx]
        result = probe_fn(
            base_url,
            case["method"],
            case["path"],
            body=inp.get("body"),
            path_params=inp.get("path_params") or {},
            query=inp.get("query") or {},
            headers=headers,
            content_type=case.get("content_type"),
            exercise_id=exercise_id,
        )
        observations.append(
            {
                "probeId": case["probeId"],
                "endpointId": case["endpoint_id"],
                "method": case["method"],
                "path": case["path"],
                "httpStatus": result.status,
                "handler": case.get("handler"),
                "shapeHash": result.shape_hash,
                # For comparison against a value-stable golden entry only; a
                # single replay proves no stability, so this never SEEDS one
                # (no valueStable flag).
                "valueDigest": result.value_digest,
            }
        )
        if result.status is not None and 200 <= result.status < 400:
            invs = inv_by_endpoint.get(f"{case['method']} {case['path']}")
            if invs:
                violations = check_observation(
                    invs,
                    result.body,
                    output_size=_size_of(result.body),
                    # Same measurement `run` learned with. `len(case["input"])`
                    # counts the {body, path_params, query} WRAPPER — always 3 —
                    # so a relation learned as out<=in was violated on every replay.
                    input_size=input_size_of(case.get("input")),
                )
                if violations:
                    diffs.append(
                        {
                            "kind": "invariant",
                            "probeId": case["probeId"],
                            "endpoint_id": case["endpoint_id"],
                            "method": case["method"],
                            "path": case["path"],
                            "detail": "; ".join(violations),
                        }
                    )
        diff = _case_diff(case, result, latency_regression_factor)
        if diff and diff["kind"] == "perf":
            diff = _confirm_perf_diff(
                case,
                base_url,
                latency_regression_factor,
                probe_fn,
                exercise_id,
                headers=fresh_auth[0] if case.get("auth") else None,
            )
        if (
            diff
            and diff["kind"] == "behavior"
            and _drift_can_explain(case["expected_status"], result.status)
            and (state.input_values(inp) & planted)
        ):
            # The replayed input contains data the exerciser planted in an
            # earlier run — the world changed, not the code. Report it as
            # drift; the next `run` re-goldens the baseline (newest wins).
            diff = {
                **diff,
                "kind": "environment",
                "detail": diff["detail"] + " [input matches engine-planted state]",
            }
        if diff:
            diffs.append(diff)

    verdicts = apply_baselines(repo, observations)

    summary: dict[str, Any] = {
        "status": "ok",
        "repo": str(repo),
        "base_url": base_url,
        "cases": len(suite),
        "behavior_diffs": sum(1 for d in diffs if d["kind"] == "behavior"),
        "contract_diffs": sum(1 for d in diffs if d["kind"] == "contract"),
        "perf_diffs": sum(1 for d in diffs if d["kind"] == "perf"),
        "environment_diffs": sum(1 for d in diffs if d["kind"] == "environment"),
        "invariant_diffs": sum(1 for d in diffs if d["kind"] == "invariant"),
        "auth_cases_skipped": auth_skipped,
        "degraded": sum(1 for v in verdicts.values() if v["verdict"] == "degraded"),
        "improved": sum(1 for v in verdicts.values() if v["verdict"] == "improved"),
        "same": sum(1 for v in verdicts.values() if v["verdict"] == "same"),
        "diffs": diffs,
    }
    log.info(
        "regress: %d cases, %d degraded, %d diffs", len(suite), summary["degraded"], len(diffs)
    )
    # Durable history: every replay appends its summary, so the findings view
    # (and any agent) can see diff kinds trend across runs, not just the last.
    store.append_jsonl(
        store.exercise_dir(repo) / "regress.jsonl",
        [{**summary, "at": time.time()}],
    )
    return summary


def _confirm_perf_diff(
    case: dict[str, Any],
    base_url: str,
    latency_factor: float,
    probe_fn: ProbeFn,
    exercise_id: str,
    replays: int = 4,
    headers: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Re-measure a suspected perf regression before reporting it.

    A single replay's latency includes cold caches, connection setup, and
    first-hit warmup — measured live, one warm request dropped a "4.9ms →
    19.4ms" phantom to baseline. Replay a few more times and keep the diff
    only when the MEDIAN exceeds the factor AND the bootstrap 95% CI of that
    median clears it too. The bare ``>factor`` comparison is only the SCREEN
    that triggers this confirmation; the CI is what makes the verdict — the
    same discipline as the optimization loop's paired-bootstrap acceptance
    (a drifting single sample cannot mint a perf diff on its own).
    """
    inp = case["input"]
    latencies: list[float] = []
    for _ in range(replays):
        res = probe_fn(
            base_url,
            case["method"],
            case["path"],
            body=inp.get("body"),
            path_params=inp.get("path_params") or {},
            query=inp.get("query") or {},
            headers=headers,
            exercise_id=exercise_id,
        )
        if isinstance(res.latency_ms, int | float):
            latencies.append(float(res.latency_ms))
    prev = case.get("prev_latency_ms")
    if not latencies or not isinstance(prev, int | float):
        return None
    median = percentile(latencies, 0.5)
    ci_low, _ = bootstrap_median_ci(latencies)
    if median > prev * latency_factor and ci_low > prev * latency_factor:
        return {
            "kind": "perf",
            "endpoint": f"{case['method']} {case['path']}",
            "input_class": case["input_class"],
            "detail": (
                f"latency {prev}ms → median {median}ms over "
                f"{len(latencies)} replays (95% CI low {round(ci_low, 1)}ms; "
                f">{latency_factor}x)"
            ),
        }
    return None


def _drift_can_explain(expected_status: Any, got_status: Any) -> bool:
    """Whether planted state could plausibly account for this status change.

    The value-intersection test alone is not a discriminator: the input
    generators are DETERMINISTIC (``_rng(seed, salt)`` with a fixed default
    seed), so a replay always sends exactly the strings the recording run sent,
    and the intersection with ``planted`` is therefore guaranteed for every
    mutating endpoint that ever 2xx'd. Every genuine behaviour regression on
    those endpoints was being relabelled ``environment`` and silently dropped —
    and since ``planted`` grows monotonically across runs, the exemption only
    ever widened.

    Direction is the real discriminator. Left-over state can make a service
    REJECT what it used to accept (2xx→4xx, a uniqueness conflict) or ACCEPT
    what it used to reject (4xx→2xx, the row now exists). It cannot make a
    service CRASH: a 5xx on either side is a defect, never our residue, and is
    always reported.
    """
    for status in (expected_status, got_status):
        if isinstance(status, int) and status >= 500:
            return False
    # An absent status is a transport failure, not a state effect.
    return isinstance(expected_status, int) and isinstance(got_status, int)


def _case_diff(
    case: dict[str, Any],
    result: ProbeResult,
    latency_factor: float,
) -> dict[str, Any] | None:
    """One replay case's diff vs. what run recorded, or None when unchanged."""
    exp_status = case["expected_status"]
    exp_class = status_class(exp_status)
    got_class = status_class(result.status)
    if exp_class != got_class:
        return {
            "kind": "behavior",
            "endpoint": f"{case['method']} {case['path']}",
            "input_class": case["input_class"],
            "detail": (
                f"status class {exp_class} (HTTP {exp_status}) "
                f"→ {got_class} (HTTP {result.status})"
            ),
        }
    if exp_class == "2xx-3xx" and case["expected_shape"] != result.shape_hash:
        return {
            "kind": "contract",
            "endpoint": f"{case['method']} {case['path']}",
            "input_class": case["input_class"],
            "detail": f"response shape {case['expected_shape']} → {result.shape_hash}",
        }
    prev = case.get("prev_latency_ms")
    if isinstance(prev, int | float) and prev > 1.0 and result.latency_ms > prev * latency_factor:
        return {
            "kind": "perf",
            "endpoint": f"{case['method']} {case['path']}",
            "input_class": case["input_class"],
            "detail": f"latency {prev}ms → {result.latency_ms}ms (>{latency_factor}x)",
        }
    return None
