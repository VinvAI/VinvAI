"""Regression replay — the accumulated behavior suite, diffed against baselines.

Every distinct ``(endpoint, input) → expected status + shape`` recorded by ``run``
becomes a permanent regression case (testflow's "every discovered behavior
becomes a permanent regression test"). ``regress`` replays them against the live
service and reports behaviour / perf / contract diffs, routing each verdict
through the SAME degraded/same/improved semantics ``probeBaseline.ts`` uses
(``baseline.py`` port).
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Callable

from . import state, store
from .baseline import apply_baselines, status_class
from .execute import ProbeResult, execute_probe
from .throughput import percentile

ProbeFn = Callable[..., ProbeResult]


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
        key = json.dumps(
            [ex["endpoint_id"], ex["strategy"], inp.get("path_params", {}), inp.get("query")],
            sort_keys=True, default=str,
        )
        probe_id = hashlib.sha256(key.encode()).hexdigest()[:16]
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
        }
    return list(seen.values())


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

    observations: list[dict[str, Any]] = []
    diffs: list[dict[str, Any]] = []
    for case in suite:
        inp = case["input"]
        result = probe_fn(
            base_url, case["method"], case["path"],
            body=inp.get("body"),
            path_params=inp.get("path_params") or {},
            query=inp.get("query") or {},
            exercise_id=exercise_id,
        )
        observations.append({
            "probeId": case["probeId"],
            "endpointId": case["endpoint_id"],
            "method": case["method"],
            "path": case["path"],
            "httpStatus": result.status,
            "handler": case.get("handler"),
            "shapeHash": result.shape_hash,
        })
        diff = _case_diff(case, result, latency_regression_factor)
        if diff and diff["kind"] == "perf":
            diff = _confirm_perf_diff(
                case, base_url, latency_regression_factor, probe_fn, exercise_id,
            )
        if diff and diff["kind"] == "behavior" and (
            state.input_values(inp) & planted
        ):
            # The replayed input contains data the exerciser planted in an
            # earlier run — the world changed, not the code. Report it as
            # drift; the next `run` re-goldens the baseline (newest wins).
            diff = {**diff, "kind": "environment",
                    "detail": diff["detail"] + " [input matches engine-planted state]"}
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
        "degraded": sum(1 for v in verdicts.values() if v["verdict"] == "degraded"),
        "improved": sum(1 for v in verdicts.values() if v["verdict"] == "improved"),
        "same": sum(1 for v in verdicts.values() if v["verdict"] == "same"),
        "diffs": diffs,
    }
    log.info("regress: %d cases, %d degraded, %d diffs",
             len(suite), summary["degraded"], len(diffs))
    return summary


def _confirm_perf_diff(
    case: dict[str, Any],
    base_url: str,
    latency_factor: float,
    probe_fn: ProbeFn,
    exercise_id: str,
    replays: int = 4,
) -> dict[str, Any] | None:
    """Re-measure a suspected perf regression before reporting it.

    A single replay's latency includes cold caches, connection setup, and
    first-hit warmup — measured live, one warm request dropped a "4.9ms →
    19.4ms" phantom to baseline. Replay a few more times and keep the diff
    only if the MEDIAN still exceeds the factor.
    """
    inp = case["input"]
    latencies: list[float] = []
    for _ in range(replays):
        res = probe_fn(
            base_url, case["method"], case["path"],
            body=inp.get("body"),
            path_params=inp.get("path_params") or {},
            query=inp.get("query") or {},
            exercise_id=exercise_id,
        )
        if isinstance(res.latency_ms, (int, float)):
            latencies.append(float(res.latency_ms))
    prev = case.get("prev_latency_ms")
    if not latencies or not isinstance(prev, (int, float)):
        return None
    median = percentile(latencies, 0.5)
    if median > prev * latency_factor:
        return {
            "kind": "perf",
            "endpoint": f"{case['method']} {case['path']}",
            "input_class": case["input_class"],
            "detail": (f"latency {prev}ms → median {median}ms over "
                       f"{len(latencies)} replays (>{latency_factor}x)"),
        }
    return None


def _case_diff(
    case: dict[str, Any], result: ProbeResult, latency_factor: float,
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
            "detail": f"status class {exp_class} (HTTP {exp_status}) → {got_class} (HTTP {result.status})",
        }
    if exp_class == "2xx-3xx" and case["expected_shape"] != result.shape_hash:
        return {
            "kind": "contract",
            "endpoint": f"{case['method']} {case['path']}",
            "input_class": case["input_class"],
            "detail": f"response shape {case['expected_shape']} → {result.shape_hash}",
        }
    prev = case.get("prev_latency_ms")
    if isinstance(prev, (int, float)) and prev > 1.0 and result.latency_ms > prev * latency_factor:
        return {
            "kind": "perf",
            "endpoint": f"{case['method']} {case['path']}",
            "input_class": case["input_class"],
            "detail": f"latency {prev}ms → {result.latency_ms}ms (>{latency_factor}x)",
        }
    return None
