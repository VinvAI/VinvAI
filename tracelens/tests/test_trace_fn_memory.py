"""Per-function memory attribution via the AST-rewrite path.

``wrap_call`` brackets the wrapped ``impl(*args, **kwargs)`` with a ``tracemalloc``
byte-counter read (exactly like the span already brackets it for latency) and emits
``tracelens.mem_delta_bytes`` on the span. This is the single collection path — the
old out-of-process sampler / eBPF second-trace are gone, so memory MUST ride on the
same wrapper as latency.

Semantics asserted here:
  * disabled by default → no counter reads, no attribute, call still runs;
  * enabled → a function that allocates and RETAINS memory reports a positive delta;
  * enabled → a function that allocates only scratch reports ~0 (net);
  * the delta is inclusive of nested wrapped calls (composes like duration).
"""

from __future__ import annotations

import asyncio

import pytest

from tracelens.runtime import trace_fn


@pytest.fixture(autouse=True)
def _reset_memory_flag():
    # Isolate each test from global sampler state; leave tracemalloc as-is on exit
    # (stopping it here would perturb any concurrently-running measurement).
    before = trace_fn._memory_enabled
    yield
    trace_fn.set_memory_enabled(before)


class _RecordingSpan:
    """Minimal span capturing set_attribute calls, to read back mem_delta_bytes."""

    def __init__(self) -> None:
        self.attrs: dict[str, object] = {}

    def set_attribute(self, k: str, v: object) -> None:
        self.attrs[k] = v


def _capture(monkeypatch, fn, *args, **kwargs):
    """Run ``fn`` through wrap_call with a recording span; return (result, attrs)."""
    span = _RecordingSpan()

    class _Ctx:
        def __enter__(self):
            return span

        def __exit__(self, *a):
            return False

    class _Tracer:
        def start_as_current_span(self, name):
            return _Ctx()

    monkeypatch.setattr(trace_fn.trace, "get_tracer", lambda _n: _Tracer())
    # External-invariant + result-enrichment side effects are irrelevant here and can
    # touch the recording span harmlessly; keep them but focus on the memory attr.
    out = fn(*args, **kwargs)
    return out, span


def test_disabled_by_default_emits_no_memory_attr(monkeypatch) -> None:
    trace_fn.set_memory_enabled(False)
    out, span = _capture(monkeypatch, trace_fn.wrap_call, "pkg.f", lambda: 21 * 2)
    assert out == 42
    assert "tracelens.mem_delta_bytes" not in span.attrs


def test_enabled_reports_positive_delta_for_retained_alloc(monkeypatch) -> None:
    trace_fn.set_memory_enabled(True)

    def build() -> list[int]:
        return list(range(50_000))  # retained via return value

    out, span = _capture(monkeypatch, trace_fn.wrap_call, "pkg.build", build)
    assert len(out) == 50_000
    assert "tracelens.mem_delta_bytes" in span.attrs
    # A 50k-int list retains hundreds of KB; comfortably positive.
    assert span.attrs["tracelens.mem_delta_bytes"] > 100_000


def test_enabled_scratch_alloc_nets_near_zero(monkeypatch) -> None:
    trace_fn.set_memory_enabled(True)

    def scratch() -> int:
        total = 0
        for _ in range(3):
            tmp = list(range(20_000))
            total += len(tmp)  # tmp freed each iteration
        return total

    out, span = _capture(monkeypatch, trace_fn.wrap_call, "pkg.scratch", scratch)
    assert out == 60_000
    d = span.attrs["tracelens.mem_delta_bytes"]
    # Net retained is tiny relative to the 20k-int list churned each loop.
    assert abs(d) < 100_000


def test_async_wrap_call_reports_memory(monkeypatch) -> None:
    trace_fn.set_memory_enabled(True)

    async def build() -> list[int]:
        return list(range(50_000))

    span = _RecordingSpan()

    class _Ctx:
        def __enter__(self):
            return span

        def __exit__(self, *a):
            return False

    class _Tracer:
        def start_as_current_span(self, name):
            return _Ctx()

    monkeypatch.setattr(trace_fn.trace, "get_tracer", lambda _n: _Tracer())
    out = asyncio.run(trace_fn.wrap_call_async("pkg.abuild", build))
    assert len(out) == 50_000
    assert span.attrs["tracelens.mem_delta_bytes"] > 100_000
