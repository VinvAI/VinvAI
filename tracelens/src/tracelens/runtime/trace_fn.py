"""Per-call span enrichment: args/result hashes and external invariants.

Three per-call cost signals are captured, all bracketing the exact
``impl(*args, **kwargs)`` invocation the span wraps and all *inclusive* of nested
calls:

* **latency** — a raw ``perf_counter_ns`` pair around ONLY the user function
  (``tracelens.duration_ns``). Enrichment work (arg binding/hash/summarize on
  entry, result hash/summarize/invariant checks on exit) runs OUTSIDE this pair,
  so the exported ``duration_ms`` measures the user's code, not the tracer's
  observer effect. The OTel span start/end times still bound the whole wrapped
  call (enrichment included) and remain the source of the event timestamps; the
  exporter prefers ``tracelens.duration_ns`` for ``duration_ms`` when present.
* **cpu** — ``thread_time_ns`` across the same window (``tracelens.cpu_ns``).
  ``blocked_ms = wall − cpu`` on the exit event is the ground-truth I/O-wait /
  scheduling signal: a call that sleeps or waits on a socket shows blocked_ms ≈
  duration_ms, a busy loop shows ≈ 0. Caveat (documented, accepted): in async
  code the event loop may run *other* coroutines on this thread during an
  ``await``, so their CPU time lands in our window and blocked_ms is a lower
  bound there.
* **memory** — the net change in ``tracemalloc``-traced bytes across the call
  (``tracelens.mem_delta_bytes``). Net (allocations that survived minus frees), so
  a function that builds and returns a large object reports its size, one that
  allocates then frees a scratch buffer reports ~0, and one that releases a cached
  object reports negative. This composes cleanly across nesting because every frame
  reads the same process-global counter.
"""

from __future__ import annotations

import inspect
import json
import time
import tracemalloc
from collections.abc import Callable
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import Span

from tracelens import _health
from tracelens.enrich.external_invariants import check_invariants
from tracelens.enrich.hashing import canonical_hash, type_schema_str
from tracelens.enrich.summaries import summarize

# Memory attribution is opt-in because ``tracemalloc`` hooks every allocation and
# so carries real overhead. The launcher flips this on for its preset; when off we
# skip the counter reads entirely and emit no memory attribute.
_memory_enabled = False

# Bound at import time: the timed window around the user function must cost two
# attribute loads + two clock reads, nothing more.
_perf_ns = time.perf_counter_ns
_thread_ns = time.thread_time_ns


def set_memory_enabled(flag: bool) -> None:
    """Enable/disable per-call memory attribution. Starts ``tracemalloc`` (depth 1,
    the cheapest traceback depth — we only need the global byte counter, not stacks)
    the first time it is enabled. Idempotent."""
    global _memory_enabled
    _memory_enabled = flag
    if flag and not tracemalloc.is_tracing():
        tracemalloc.start(1)


def _mem_now() -> int | None:
    if not _memory_enabled:
        return None
    try:
        return tracemalloc.get_traced_memory()[0]
    except Exception:
        return None


def _apply_mem_attr(span: Span, before: int | None) -> None:
    if before is None:
        return
    try:
        after = tracemalloc.get_traced_memory()[0]
        span.set_attribute("tracelens.mem_delta_bytes", after - before)
    except Exception:
        pass


def _args_schema_str(bound: inspect.BoundArguments) -> str:
    parts = [f"{name}:{type_schema_str(val)}" for name, val in bound.arguments.items()]
    return "(" + ",".join(parts) + ")"


def _args_summary_dict(bound: inspect.BoundArguments) -> dict[str, Any]:
    return {k: summarize(v, label=k) for k, v in bound.arguments.items()}


def _args_hash_for_bound(bound: inspect.BoundArguments) -> str:
    return canonical_hash(tuple(bound.arguments.items()))


def _apply_exit_attrs(
    span: Span, bound: inspect.BoundArguments | None, out: Any, viol: list[str]
) -> None:
    span.set_attribute("tracelens.result_hash", canonical_hash(out))
    span.set_attribute("tracelens.result_schema", type_schema_str(out))
    span.set_attribute("tracelens.result_summary_json", json.dumps(summarize(out)))
    if viol:
        span.set_attribute("tracelens.oracle_violations_json", json.dumps(viol))
    else:
        span.set_attribute("tracelens.oracle_violations_json", "[]")


def _try_bind(
    impl: Callable[..., Any], args: tuple[Any, ...], kwargs: dict[str, Any]
) -> inspect.BoundArguments | None:
    """Best-effort ``sig.bind``. Enrichment must never break the wrapped call, so
    signatures we can't reconcile with the actual args (e.g. pydantic v1 validators
    invoked through descriptor machinery, C builtins with no signature) yield
    ``None`` and we simply skip arg-level attributes."""
    try:
        bound = inspect.signature(impl).bind(*args, **kwargs)
        bound.apply_defaults()
        return bound
    except (TypeError, ValueError):
        return None


def _apply_entry_attrs(span: Span, bound: inspect.BoundArguments | None, qual: str = "") -> None:
    if bound is None:
        return
    try:
        span.set_attribute("tracelens.args_hash", _args_hash_for_bound(bound))
        span.set_attribute("tracelens.args_schema", _args_schema_str(bound))
        span.set_attribute("tracelens.args_summary_json", json.dumps(_args_summary_dict(bound)))
    except BaseException as exc:  # noqa: BLE001 — arg summarization must never break the call
        _health.record("entry_enrichment_errors", note=f"{qual}: {exc!r}")
        _health.warn_once(
            "entry_enrichment",
            f"argument enrichment failed for {qual or '<span>'} ({type(exc).__name__}) — "
            "spans still record, without argument attributes",
        )


def _apply_result_enrichment(
    span: Span, bound: inspect.BoundArguments | None, out: Any, qual: str
) -> None:
    """Post-call enrichment (invariants + result attrs). MUST never raise into the
    wrapped call: before this guard, a pathological ``__repr__``/hash on the return
    value could surface as an exception the *user's* code never raised."""
    try:
        viol = check_invariants(qual, dict(bound.arguments) if bound else {}, out)
        _apply_exit_attrs(span, bound, out, viol)
    except BaseException as exc:  # noqa: BLE001 — see docstring
        _health.record("result_enrichment_errors", note=f"{qual}: {exc!r}")
        _health.warn_once(
            "result_enrichment",
            f"result enrichment failed for {qual} ({type(exc).__name__}) — "
            "spans still record, without result attributes",
        )


def _apply_timing_attrs(span: Span, wall_ns: int, cpu_ns: int) -> None:
    """Record the raw user-function timing window on the span.

    Runs *after* the stop clock reads, so it (like every other enrichment step)
    is outside the timed window. Must never raise into the wrapped call.
    """
    try:
        span.set_attribute("tracelens.duration_ns", wall_ns)
        span.set_attribute("tracelens.cpu_ns", cpu_ns)
    except BaseException as exc:  # noqa: BLE001 — timing attrs must never break the call
        _health.record("timing_attr_errors", note=repr(exc))


def wrap_call(qual: str, impl: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    bound = _try_bind(impl, args, kwargs)
    tracer = trace.get_tracer("tracelens.runtime")
    with tracer.start_as_current_span(qual) as span:
        _apply_entry_attrs(span, bound, qual)
        mem_before = _mem_now()
        # Timed window: ONLY the user function sits between the clock reads.
        # ``finally`` so an exception exit still carries an honest duration.
        cpu0 = _thread_ns()
        t0 = _perf_ns()
        try:
            out = impl(*args, **kwargs)
        finally:
            t1 = _perf_ns()
            cpu1 = _thread_ns()
            _apply_timing_attrs(span, t1 - t0, cpu1 - cpu0)
        _apply_mem_attr(span, mem_before)
        _apply_result_enrichment(span, bound, out, qual)
        return out


async def wrap_call_async(qual: str, impl: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    bound = _try_bind(impl, args, kwargs)
    tracer = trace.get_tracer("tracelens.runtime")
    with tracer.start_as_current_span(qual) as span:
        _apply_entry_attrs(span, bound, qual)
        mem_before = _mem_now()
        cpu0 = _thread_ns()
        t0 = _perf_ns()
        try:
            out = await impl(*args, **kwargs)
        finally:
            t1 = _perf_ns()
            cpu1 = _thread_ns()
            _apply_timing_attrs(span, t1 - t0, cpu1 - cpu0)
        _apply_mem_attr(span, mem_before)
        _apply_result_enrichment(span, bound, out, qual)
        return out
