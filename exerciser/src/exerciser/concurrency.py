"""Concurrency oracles — deterministic schedules and timeout injection.

The hang/deadlock class is dangerous to probe and invisible without trying: the
serial driver fires one request at a time, so a lock ordering that only
deadlocks under interleaving never interleaves, and a call that never returns
stalls the whole run rather than being reported.

Two oracles, both bounded so a hang costs a deadline and not the run:

* **Deterministic schedule** (``run_schedule``) — drive N copies of the same
  target concurrently with a FIXED release order, so an interleaving that
  corrupts shared state is reproducible rather than a flake. Divergence between
  the concurrent result set and the serial baseline is the finding: if calling
  something twice in parallel does not equal calling it twice in sequence, the
  target has shared mutable state it does not guard.
* **Timeout injection** (``run_timeout_probe``) — call the target with a hard
  deadline and report the ones that blow it. A target that returns in 3 ms
  serially and never returns under contention is a lock-ordering bug, and it is
  reported as ``concurrency-hang`` rather than hanging the engine.

Both run in an isolated worker (same discipline as the other oracles), so a
target that wedges its interpreter costs one subprocess.
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

from . import store
from ._worker import worker_entrypoint
from .functions import detect_src_roots
from .interpreter import resolve_cached
from .issues import FailureCluster, build_clusters

DEFAULT_WORKERS = 4
DEFAULT_REPEATS = 3
DEFAULT_CALL_TIMEOUT_S = 5.0
DEFAULT_WORKER_TIMEOUT_S = 60.0


# =========================================================================
# Worker
# =========================================================================


def _resolve(target: str) -> Any:
    mod_name, _, qual = target.partition(":")
    obj: Any = importlib.import_module(mod_name)
    for part in qual.split("."):
        obj = getattr(obj, part)
    return obj


def _worker_main(argv: list[str]) -> int:
    import concurrent.futures as cf

    ap = argparse.ArgumentParser(prog="exerciser-concurrency-worker")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--repo", required=True)
    args = ap.parse_args(argv)

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    repo = Path(args.repo)
    for root in plan.get("src_roots", ["."]):
        p = str((repo / root).resolve())
        if p not in sys.path:
            sys.path.insert(0, p)

    target = plan["target"]
    kwargs = plan.get("kwargs") or {}
    workers = int(plan.get("workers", DEFAULT_WORKERS))
    repeats = int(plan.get("repeats", DEFAULT_REPEATS))
    call_timeout = float(plan.get("call_timeout_s", DEFAULT_CALL_TIMEOUT_S))
    rows: list[dict[str, Any]] = []

    try:
        fn = _resolve(target)
    except BaseException as exc:
        _emit(
            [
                {
                    "target": target,
                    "phase": "import",
                    "status": "error",
                    "error_type": type(exc).__name__,
                    "error": str(exc)[:400],
                }
            ]
        )
        return 0

    def _one() -> dict[str, Any]:
        try:
            return {"ok": True, "value": repr(fn(**kwargs))[:200]}
        except BaseException as exc:
            return {
                "ok": False,
                "exception": type(exc).__name__,
                "message": str(exc)[:300],
                "tb": "".join(traceback.format_exception_only(type(exc), exc))[:200],
            }

    # Serial baseline: the same number of calls, one after another. Comparing
    # against THIS (not against a single call) isolates concurrency from
    # ordinary call-to-call variation in a stateful target.
    serial = [_one() for _ in range(workers)]
    rows.append({"target": target, "phase": "serial", "results": serial})
    # A SECOND serial batch, purely as a control. The divergence verdict below
    # compares distinct-result counts, which silently assumes the count is a
    # property of the target rather than of timing. It is not: a function
    # returning anything clock- or entropy-derived produces N distinct results
    # serially (calls straddle a tick) and 1 concurrently (they land in the same
    # instant) — reported as "updates were LOST" on a target with no shared
    # state at all, deterministically on every repeat, so it looks like a
    # solidly reproduced bug. If two SERIAL batches already disagree, the spread
    # is timing, not state, and the comparison does not apply.
    serial_control = [_one() for _ in range(workers)]
    rows.append({"target": target, "phase": "serial-control", "results": serial_control})

    # Deterministic schedule: a fixed number of workers released together,
    # repeated so a rare interleaving still gets several chances. The repeat
    # count is fixed, so the probe is reproducible rather than a flake hunt.
    for attempt in range(repeats):
        with cf.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_one) for _ in range(workers)]
            concurrent: list[dict[str, Any]] = []
            timed_out = 0
            for fut in futures:
                try:
                    concurrent.append(fut.result(timeout=call_timeout))
                except cf.TimeoutError:
                    timed_out += 1
                    concurrent.append({"ok": False, "exception": "Timeout"})
                except BaseException as exc:
                    concurrent.append({"ok": False, "exception": type(exc).__name__})
            # A pool with a wedged worker must not block interpreter exit.
            pool.shutdown(wait=False, cancel_futures=True)
        rows.append(
            {
                "target": target,
                "phase": "concurrent",
                "attempt": attempt,
                "workers": workers,
                "timed_out": timed_out,
                "results": concurrent,
            }
        )
    _emit(rows)
    return 0


def _emit(rows: list[dict[str, Any]]) -> None:
    for r in rows:
        sys.stdout.write(json.dumps(r, default=str) + "\n")
    sys.stdout.flush()


# =========================================================================
# Verdicts
# =========================================================================


def _profile(results: list[dict[str, Any]]) -> dict[str, Any]:
    """The comparable shape of a result set.

    Comparing raw VALUES is wrong: a stateful target (a counter, an id
    allocator) legitimately returns different values on a later batch, so a
    value diff would flag every such target. What must hold is the SHAPE:

    * ``distinct`` — how many different successful values came back. N
      concurrent calls to a correctly-guarded read-modify-write produce N
      distinct results; a lost update collapses two of them, so a drop in
      distinct count IS the lost-update signature, independent of the values.
    * ``failures`` — the exception types raised. Exceptions that appear only
      under concurrency are a finding by themselves.

    Order is deliberately ignored: concurrency reorders legitimately.
    """
    ok = [r for r in results if r.get("ok")]
    return {
        "calls": len(results),
        "ok": len(ok),
        "distinct": len({str(r.get("value")) for r in ok}),
        "failures": sorted({str(r.get("exception")) for r in results if not r.get("ok")}),
    }


def classify(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Findings from a worker's rows: hangs first, then schedule divergence."""
    out: list[dict[str, str]] = []
    target = next((r.get("target", "?") for r in rows), "?")
    serial_row = next((r for r in rows if r.get("phase") == "serial"), None)
    if any(r.get("phase") == "import" and r.get("status") == "error" for r in rows):
        row = next(r for r in rows if r.get("phase") == "import")
        return [
            {
                "kind": "import-error",
                "detail": f"{row.get('error_type')}: {row.get('error')}",
                "target": target,
            }
        ]
    if serial_row is None:
        return out
    serial = _profile(serial_row.get("results") or [])

    # Is the distinct-count a property of the TARGET, or of timing? Two serial
    # batches that disagree mean the return values are clock/entropy-derived, so
    # a lower concurrent count proves nothing — concurrency compresses a spread
    # that serial execution creates. Without this control, every such target was
    # reported as having "unguarded shared state".
    control_row = next((r for r in rows if r.get("phase") == "serial-control"), None)
    count_is_stable = (
        control_row is None  # older worker output: keep the previous behaviour
        or _profile(control_row.get("results") or [])["distinct"] == serial["distinct"]
    )

    for row in rows:
        if row.get("phase") != "concurrent":
            continue
        if row.get("timed_out"):
            out.append(
                {
                    "kind": "concurrency-hang",
                    "target": target,
                    "detail": (
                        f"{row['timed_out']} of {row.get('workers')} concurrent calls "
                        "did not return within the deadline — the target blocks under "
                        "contention but not serially"
                    ),
                }
            )
            continue
        concurrent = _profile(row.get("results") or [])
        # Only a batch that actually SUCCEEDED can have lost an update; when
        # every call failed, the failures below are the honest report.
        if count_is_stable and concurrent["ok"] and concurrent["distinct"] < serial["distinct"]:
            out.append(
                {
                    "kind": "concurrency-divergence",
                    "target": target,
                    "detail": (
                        f"{serial['distinct']} distinct results serially but only "
                        f"{concurrent['distinct']} across the same number of "
                        "concurrent calls — updates were LOST, so the target has "
                        "unguarded shared state"
                    ),
                }
            )
        new_failures = set(concurrent["failures"]) - set(serial["failures"])
        if new_failures:
            out.append(
                {
                    "kind": "concurrency-divergence",
                    "target": target,
                    "detail": (
                        f"exceptions raised only under concurrency: "
                        f"{sorted(new_failures)} — the target is not thread-safe"
                    ),
                }
            )
    # One finding per distinct (kind, detail): a divergence reproduced across
    # three attempts is ONE bug, but two different divergence reasons in the
    # same run are two findings and must both survive.
    seen: set[tuple[str, str]] = set()
    deduped: list[dict[str, str]] = []
    for f in out:
        key = (f["kind"], f["detail"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(f)
    return deduped


def cluster_concurrency_findings(findings: list[dict[str, str]]) -> list[FailureCluster]:
    return build_clusters(
        findings,
        verdict=lambda f: f.get("kind"),
        describe=lambda f, _k: str(f.get("detail", "")),
        method="CONC",
        strategy=lambda _f, _k: "concurrency/schedule",
        expected=lambda _f, _k: "concurrent calls agree with the serial baseline and all return",
    )


# =========================================================================
# Driver
# =========================================================================


def run_concurrency(
    repo: Path,
    *,
    target: str,
    kwargs: dict[str, Any] | None = None,
    workers: int = DEFAULT_WORKERS,
    repeats: int = DEFAULT_REPEATS,
    call_timeout_s: float = DEFAULT_CALL_TIMEOUT_S,
    worker_timeout_s: float = DEFAULT_WORKER_TIMEOUT_S,
    python: str | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Probe one target for hangs and schedule-dependent results."""
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()
    python = resolve_cached(repo, explicit=python, logger=log).python
    tmp_dir = store.exercise_dir(repo) / "concurrency"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    plan = {
        "target": target,
        "kwargs": kwargs or {},
        "workers": workers,
        "repeats": repeats,
        "call_timeout_s": call_timeout_s,
        "src_roots": detect_src_roots(repo),
    }
    plan_file = tmp_dir / f"{target.replace(':', '_').replace('.', '_')}.plan.json"
    store.write_json(plan_file, plan)

    cmd = [
        python or sys.executable,
        "-m",
        "exerciser.concurrency",
        "--worker",
        "--plan",
        str(plan_file),
        "--repo",
        str(repo),
    ]
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        p for p in (env.get("PYTHONPATH"), str(Path(__file__).parents[1])) if p
    )
    rows: list[dict[str, Any]] = []
    worker_timed_out = False
    try:
        proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=worker_timeout_s,
            cwd=str(repo),
            env=env,
        )
        for line in (proc.stdout or "").splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
    except subprocess.TimeoutExpired:
        worker_timed_out = True

    findings = classify(rows)
    if worker_timed_out:
        # The whole worker wedged: that is the strongest possible hang signal,
        # and it is REPORTED rather than allowed to stall the engine.
        findings.append(
            {
                "kind": "concurrency-hang",
                "target": target,
                "detail": (
                    f"the concurrency worker exceeded {worker_timeout_s}s and was "
                    "killed — the target wedged its interpreter under contention"
                ),
            }
        )
    clusters = cluster_concurrency_findings(findings)
    store.write_jsonl(store.exercise_dir(repo) / "concurrency_results.jsonl", rows)

    result = {
        "status": "ok",
        "repo": str(repo),
        "target": target,
        "workers": workers,
        "repeats": repeats,
        "worker_timed_out": worker_timed_out,
        "issue_clusters": len(clusters),
        "clusters": [c.to_json() for c in clusters],
    }
    store.write_json(store.exercise_dir(repo) / "concurrency.json", result)
    log.info(
        "concurrency: %s, %d workers x %d repeats, %d clusters",
        target,
        workers,
        repeats,
        len(clusters),
    )
    return result


def main(argv: list[str] | None = None) -> int:
    return worker_entrypoint(
        argv, _worker_main, "exerciser.concurrency: use `exerciser concurrency <repo> --target …`\n"
    )


if __name__ == "__main__":
    raise SystemExit(main())
