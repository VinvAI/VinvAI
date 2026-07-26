"""Observer-effect isolation of the per-call timers (audit tasks 2 + 4).

``wrap_call`` brackets ONLY the user function with a raw ``perf_counter_ns`` /
``thread_time_ns`` pair; enrichment (arg bind/hash/summarize, result hash,
invariants) runs outside that window. Asserted here, all RELATIVE (no absolute
ns thresholds):

* a traced no-op's reported duration is a small fraction of the full wrapped
  call (which still pays enrichment) — i.e. enrichment cost no longer leaks
  into ``duration_ms`` — while the enrichment attributes still appear;
* an exception exit still records the timing attributes;
* ``blocked_ms = wall − cpu``: a sleeper is mostly blocked, a spinner is not;
* the exporter prefers ``tracelens.duration_ns`` over span wall-clock and emits
  a nullable additive ``blocked_ms`` (null when the attributes are absent, so
  contrib spans and pre-upgrade traces are unchanged).
"""

from __future__ import annotations

import json
import statistics
import time
from pathlib import Path

import pytest

from tracelens.runtime import trace_fn


class _RecordingSpan:
    def __init__(self) -> None:
        self.attrs: dict[str, object] = {}

    def set_attribute(self, k: str, v: object) -> None:
        self.attrs[k] = v


def _patch_tracer(monkeypatch: pytest.MonkeyPatch, span: _RecordingSpan) -> None:
    class _Ctx:
        def __enter__(self):
            return span

        def __exit__(self, *a):
            return False

    class _Tracer:
        def start_as_current_span(self, name):
            return _Ctx()

    monkeypatch.setattr(trace_fn.trace, "get_tracer", lambda _n: _Tracer())


def test_noop_duration_excludes_enrichment_but_enrichment_still_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def noop(x: int) -> int:
        return x

    ratios: list[float] = []
    last_span: _RecordingSpan | None = None
    for _ in range(50):
        span = _RecordingSpan()
        _patch_tracer(monkeypatch, span)
        t0 = time.perf_counter_ns()
        assert trace_fn.wrap_call("pkg.noop", noop, 7) == 7
        total_ns = time.perf_counter_ns() - t0
        inner_ns = span.attrs["tracelens.duration_ns"]
        assert isinstance(inner_ns, int) and inner_ns >= 0
        ratios.append(inner_ns / max(total_ns, 1))
        last_span = span
    # Enrichment (bind + hash + summarize + invariants + json) dominates a no-op,
    # so the user-function window must be a small fraction of the wrapped total.
    assert statistics.median(ratios) < 0.5
    # ... while enrichment still happened and landed on the span.
    assert last_span is not None
    assert "tracelens.args_hash" in last_span.attrs
    assert "tracelens.result_hash" in last_span.attrs
    assert "tracelens.result_summary_json" in last_span.attrs


def test_exception_exit_still_records_timing(monkeypatch: pytest.MonkeyPatch) -> None:
    span = _RecordingSpan()
    _patch_tracer(monkeypatch, span)

    def boom() -> None:
        raise ValueError("nope")

    with pytest.raises(ValueError):
        trace_fn.wrap_call("pkg.boom", boom)
    assert "tracelens.duration_ns" in span.attrs
    assert "tracelens.cpu_ns" in span.attrs


def test_blocked_signal_sleep_vs_spin(monkeypatch: pytest.MonkeyPatch) -> None:
    span_sleep = _RecordingSpan()
    _patch_tracer(monkeypatch, span_sleep)
    trace_fn.wrap_call("pkg.sleeper", lambda: time.sleep(0.05))
    wall = span_sleep.attrs["tracelens.duration_ns"]
    cpu = span_sleep.attrs["tracelens.cpu_ns"]
    assert isinstance(wall, int) and isinstance(cpu, int)
    # A sleeper burns almost no cpu: blocked fraction near 1.
    sleep_blocked_frac = (wall - cpu) / wall
    assert sleep_blocked_frac > 0.8

    def spin() -> int:
        deadline = time.perf_counter() + 0.05
        n = 0
        while time.perf_counter() < deadline:
            n += 1
        return n

    span_spin = _RecordingSpan()
    _patch_tracer(monkeypatch, span_spin)
    trace_fn.wrap_call("pkg.spinner", spin)
    wall = span_spin.attrs["tracelens.duration_ns"]
    cpu = span_spin.attrs["tracelens.cpu_ns"]
    # A spinner computes its window; under CPU contention (parallel test procs)
    # preemption inflates its wall time, so assert the relative ordering — the
    # spinner must be far less blocked than the sleeper — not an absolute bar.
    spin_blocked_frac = (wall - cpu) / wall
    assert sleep_blocked_frac - spin_blocked_frac > 0.3


def test_async_wrap_call_records_timing(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    async def asleep() -> int:
        await asyncio.sleep(0.03)
        return 3

    span = _RecordingSpan()
    _patch_tracer(monkeypatch, span)
    assert asyncio.run(trace_fn.wrap_call_async("pkg.asleep", asleep)) == 3
    wall = span.attrs["tracelens.duration_ns"]
    cpu = span.attrs["tracelens.cpu_ns"]
    assert isinstance(wall, int) and isinstance(cpu, int)
    # The await spans the sleep, and (with nothing else on this loop) the thread
    # is blocked for most of it.
    assert (wall - cpu) / wall > 0.5


# ---------------------------------------------------------------------------
# Exporter-side: duration_ms prefers the raw window; blocked_ms is additive.
# ---------------------------------------------------------------------------


def _one_exit_row(tmp_path: Path, attributes: dict, *, sleep_s: float = 0.0) -> dict:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor

    from tracelens.otel.exporter import JSONLFileSpanExporter

    out = tmp_path / "trace.jsonl"
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(JSONLFileSpanExporter(str(out))))
    tracer = provider.get_tracer("test")
    with tracer.start_as_current_span("demo.mod.fn") as span:
        for key, value in attributes.items():
            span.set_attribute(key, value)
        if sleep_s:
            time.sleep(sleep_s)
    provider.shutdown()
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    exits = [r for r in rows if r.get("event") == "exit"]
    assert len(exits) == 1
    return exits[0]


def test_exporter_prefers_raw_window_over_span_wall(tmp_path: Path) -> None:
    # Span wall-clock spans ~30ms (sleep inside), but the recorded user-function
    # window says 2ms — duration_ms must report the window, not the wall.
    row = _one_exit_row(
        tmp_path,
        {"tracelens.duration_ns": 2_000_000, "tracelens.cpu_ns": 500_000},
        sleep_s=0.03,
    )
    assert row["duration_ms"] == 2.0
    assert row["blocked_ms"] == 1.5


def test_exporter_blocked_ms_null_without_clock_attrs(tmp_path: Path) -> None:
    row = _one_exit_row(tmp_path, {}, sleep_s=0.005)
    assert "blocked_ms" in row, "additive field must be present (nullable) for stable consumers"
    assert row["blocked_ms"] is None
    # Without the raw window the exporter falls back to span wall-clock.
    assert row["duration_ms"] >= 4.0


def test_exporter_blocked_ms_clamps_negative_to_zero(tmp_path: Path) -> None:
    # thread_time can outrun the wall window by a rounding quantum; never negative.
    row = _one_exit_row(
        tmp_path,
        {"tracelens.duration_ns": 1_000_000, "tracelens.cpu_ns": 1_100_000},
    )
    assert row["blocked_ms"] == 0.0
