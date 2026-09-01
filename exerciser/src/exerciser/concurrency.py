"""Concurrency oracle — parallel copies of a target, diffed against a serial baseline.

The hang/deadlock class is dangerous to probe and invisible without trying: the
serial driver fires one request at a time, so shared state that only corrupts
under interleaving never interleaves, and a call that never returns stalls the
whole run rather than being reported.

WHAT THIS ACTUALLY DOES, stated plainly because the previous version of this
docstring did not. It named two oracles, ``run_schedule`` and
``run_timeout_probe``, and NEITHER FUNCTION HAS EVER EXISTED in this package;
the README repeated the same claim as "deterministic interleavings and timeout
injection". There is one entry point, ``run_concurrency``, and it does this:

* **Parallel batch vs serial baseline** — ``workers`` copies of the target are
  submitted to a thread pool and the batch is repeated ``repeats`` times. The
  REPEAT COUNT is what is fixed; the interleaving is not. Nothing pins a release
  order — no barrier, no schedule enumeration — so the OS scheduler chooses, and
  repetition is what gives a rare interleaving several chances rather than one.
  Divergence between the concurrent profile and the serial baseline is the
  finding: if calling something N times in parallel does not equal calling it N
  times in sequence, the target has shared mutable state it does not guard.
* **A deadline on OBSERVATION, not an injection** — the harness stops waiting on
  a call that blows ``call_timeout`` and reports it; the call itself is abandoned,
  not interrupted. Nothing is injected into the target. A target that returns in
  3 ms serially and never returns under contention is reported as
  ``concurrency-hang`` rather than hanging the engine.

The serial-vs-serial control is what keeps the first bullet honest: a target
whose values are clock- or entropy-derived differs from itself run twice, so its
disagreement says nothing about concurrency. See ``stability`` below.

Both batches run in an isolated worker (same discipline as the other oracles), so
a target that wedges its interpreter costs one subprocess.
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
    # assumes the distinct-result count is a property of the target rather than
    # of timing. It is not: a function returning anything clock- or
    # entropy-derived produces N distinct results serially (calls straddle a
    # tick) and 1 concurrently (they land in the same instant) — reported as
    # "updates were LOST" on a target with no shared state at all,
    # deterministically on every repeat, so it looks like a solidly reproduced
    # bug. `classify` compares the two batches by COUNT and by VALUE SET:
    # disagreeing counts mean the spread is timing and the comparison does not
    # apply at all, while agreeing counts over values that share nothing leave
    # the two explanations indistinguishable — and the verdict then says so
    # instead of asserting shared state.
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
    * ``values`` — those distinct values themselves. Only the two SERIAL
      batches are ever compared by value, and only to ask whether the distinct
      count is a property of the target at all (see ``classify``). Comparing
      serial against concurrent by value is the mistake this docstring opens
      with, and ``values`` must not be used for it.
    * ``failures`` — the exception types raised. Exceptions that appear only
      under concurrency are a finding by themselves.

    Order is deliberately ignored: concurrency reorders legitimately.
    """
    ok = [r for r in results if r.get("ok")]
    values = sorted({str(r.get("value")) for r in ok})
    return {
        "calls": len(results),
        "ok": len(ok),
        "distinct": len(values),
        "values": values,
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
    # batches decide it, and they must be compared by VALUE SET rather than by
    # count. Counts alone let the control pass on exactly the case it exists to
    # refuse: a clock- or entropy-derived return is all-unique within EVERY
    # serial batch, so both batches report N distinct, the counts agree while
    # the two batches share not one value — and a concurrent batch whose calls
    # all land inside one tick was then reported as "updates were LOST, so the
    # target has unguarded shared state" about a target with no shared state at
    # all.
    #
    # Disagreeing value sets cannot simply suppress the verdict, though: a
    # monotone counter — the canonical lost-update target, and the one this
    # oracle exists for — produces the identical shape (1,2,3,4 serially, then
    # 5,6,7,8, then a single value across the concurrent batch). The two are
    # not separable from return values alone, so that third state is NAMED
    # rather than guessed: the divergence is still reported, minus the claim
    # about shared state that the evidence does not support.
    control_row = next((r for r in rows if r.get("phase") == "serial-control"), None)
    control = _profile(control_row.get("results") or []) if control_row is not None else None
    if control is None:
        stability = "assumed"  # older worker output: keep the previous behaviour
    elif control["distinct"] != serial["distinct"]:
        stability = "timing"  # the spread itself moves between batches
    elif control["values"] != serial["values"]:
        stability = "values-differ"  # same count, no value in common: undecidable
    else:
        stability = "stable"

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
        collapsed = concurrent["ok"] and concurrent["distinct"] < serial["distinct"]
        if stability != "timing" and collapsed:
            observed = (
                f"{serial['distinct']} distinct results serially but only "
                f"{concurrent['distinct']} across the same number of concurrent calls"
            )
            if stability == "values-differ":
                detail = (
                    f"{observed} — but the two serial batches agree on the count while "
                    "sharing no value, which a lost update and a clock- or "
                    "entropy-derived return read inside one tick produce alike: check "
                    "whether the result comes from shared state or from the clock"
                )
            else:
                detail = f"{observed} — updates were LOST, so the target has unguarded shared state"
            out.append({"kind": "concurrency-divergence", "target": target, "detail": detail})
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
