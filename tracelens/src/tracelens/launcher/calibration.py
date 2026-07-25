"""Tracer overhead self-calibration (observer-effect honesty).

Every run measures, at launcher startup, what ONE wrapped call costs under the
capture configuration actually active for that run (enrichment always on;
tracemalloc on/off per the memory axis; determinism capture per its axis). The
measurement drives no behaviour — it makes the observer effect a recorded fact:

* a ``{"event": "tracer_calibration", ...}`` HEADER line is appended to the
  trace JSONL before the target runs, carrying the per-call overhead
  distribution (median + MAD, ns) and the active axes;
* the shutdown summary surfaces the same line (``summarize_jsonl`` passes it
  through), so ``summary.json`` is self-describing too.

Methodology: time ``wrap_call`` around a no-op through the REAL span pipeline —
the same global TracerProvider, span processor and batch exporter the run uses —
so the number includes bind/enrichment, span bookkeeping and queueing exactly as
a production call pays them. The synthetic spans are named under
``CALIBRATION_SPAN_PREFIX`` and dropped by the exporter (see
``tracelens.otel.exporter``), so calibration's only trace artifact is the header
line itself.

K (the number of timed calls) is adaptive: batches run until the running median
stabilizes — successive batch medians within a RELATIVE tolerance of each other,
never an absolute ns threshold, so fast and slow hosts both converge — bounded
by a call cap and a wall-clock budget so startup cost stays fixed and small.
Failures are loud (``_health``) and never block the run.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from tracelens import _health
from tracelens.otel.exporter import CALIBRATION_SPAN_PREFIX

# Stopping rule + budget knobs. Env-tunable like every other capture knob; the
# tolerance is relative (fraction of the current median), the bounds are budget
# caps that keep startup latency predictable.
_REL_TOL_ENV = "TRACELENS_CALIBRATION_REL_TOL"
_BUDGET_MS_ENV = "TRACELENS_CALIBRATION_BUDGET_MS"
_MAX_CALLS_ENV = "TRACELENS_CALIBRATION_MAX_CALLS"
_DISABLE_ENV = "TRACELENS_NO_CALIBRATION"

_DEFAULT_REL_TOL = 0.05
_DEFAULT_BUDGET_MS = 250.0
_DEFAULT_MAX_CALLS = 2048
_BATCH = 32  # calls per batch; the median is re-checked between batches


def _env_float(name: str, default: float) -> float:
    try:
        v = float(os.environ.get(name, ""))
        return v if v > 0 else default
    except ValueError:
        return default


def _noop(x: int = 0) -> int:
    return x


def measure_overhead() -> dict[str, Any]:
    """Time wrapped no-op calls until the median per-call cost stabilizes.

    Returns ``{"median_ns", "mad_ns", "n", "stabilized"}``. ``stabilized`` is
    False when the budget ran out before two consecutive batch medians agreed
    within the relative tolerance (still a usable estimate — just flagged).
    """
    from tracelens.runtime.trace_fn import wrap_call

    rel_tol = _env_float(_REL_TOL_ENV, _DEFAULT_REL_TOL)
    budget_ns = _env_float(_BUDGET_MS_ENV, _DEFAULT_BUDGET_MS) * 1_000_000.0
    max_calls = int(_env_float(_MAX_CALLS_ENV, float(_DEFAULT_MAX_CALLS)))

    perf = time.perf_counter_ns
    qual = CALIBRATION_SPAN_PREFIX + "noop"
    samples: list[int] = []
    started = perf()
    prev_median: float | None = None
    stabilized = False
    while True:
        for _ in range(_BATCH):
            t0 = perf()
            wrap_call(qual, _noop, 1)
            samples.append(perf() - t0)
        med = statistics.median(samples)
        if prev_median is not None and prev_median > 0:
            if abs(med - prev_median) / prev_median <= rel_tol:
                stabilized = True
                break
        prev_median = med
        if len(samples) >= max_calls or (perf() - started) >= budget_ns:
            break
    med = statistics.median(samples)
    mad = statistics.median([abs(s - med) for s in samples])
    return {
        "median_ns": int(med),
        "mad_ns": int(mad),
        "n": len(samples),
        "stabilized": stabilized,
    }


def _iso_now() -> str:
    dt = datetime.now(tz=UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{dt.microsecond // 1000:03d}Z"


def run_calibration(
    output: str,
    *,
    memory_enabled: bool,
    capture_determinism: bool,
) -> dict[str, Any] | None:
    """Measure and record startup overhead; returns the header dict (or ``None``).

    Appends the header line to ``output`` (stdout when the trace streams there).
    Must be called AFTER the span pipeline and the run's axes (memory /
    determinism) are configured — the measurement is only honest for the
    configuration that will actually trace the target. Never raises: a failed
    calibration records a loud ``_health`` entry and the run proceeds untimed.
    """
    if os.environ.get(_DISABLE_ENV) == "1":
        return None
    try:
        import tracemalloc

        overhead = measure_overhead()
        header: dict[str, Any] = {
            "event": "tracer_calibration",
            "ts": _iso_now(),
            "pid": os.getpid(),
            # The axes the measurement ran under. ``enrichment`` is always on
            # today (wrap_call has no enrichment-off mode); ``tracemalloc``
            # reads the live flag, not the preset, because tracemalloc hooks
            # user-code allocations and is the one axis whose cost cannot be
            # moved out of the timed window.
            "axes": {
                "enrichment": True,
                "tracemalloc": bool(memory_enabled and tracemalloc.is_tracing()),
                "determinism": bool(capture_determinism),
            },
            "per_call_overhead_ns": {
                "median": overhead["median_ns"],
                "mad": overhead["mad_ns"],
                "n": overhead["n"],
            },
            "stabilized": overhead["stabilized"],
        }
        line = json.dumps(header, separators=(",", ":"), ensure_ascii=False) + "\n"
        if output == "-":
            sys.stdout.write(line)
            sys.stdout.flush()
        else:
            path = Path(output)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line)
                fh.flush()
        return header
    except BaseException as exc:  # noqa: BLE001 — calibration must never block the run
        _health.record("calibration_errors", note=repr(exc))
        _health.warn_once(
            "calibration_failed",
            f"tracer overhead calibration failed ({type(exc).__name__}: {exc}) — "
            "the trace carries no tracer_calibration header; per-call overhead "
            "for this run is unmeasured",
        )
        return None
