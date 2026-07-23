"""Per-call span enrichment: args/result hashes and external invariants (spec §5.7).

Two per-call cost signals are captured the same way, both bracketing the exact
``impl(*args, **kwargs)`` invocation the span wraps and both *inclusive* of nested
calls (like the span's own wall-clock duration):

* **latency** — the span's start/end time (handled by OpenTelemetry).
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
import tracemalloc
from collections.abc import Callable
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import Span

from tracelens.enrich.external_invariants import check_invariants
from tracelens.enrich.hashing import canonical_hash, type_schema_str
from tracelens.enrich.summaries import summarize

# Memory attribution is opt-in because ``tracemalloc`` hooks every allocation and
# so carries real overhead. The launcher flips this on for its preset; when off we
# skip the counter reads entirely and emit no memory attribute.
_memory_enabled = False


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


def _apply_entry_attrs(span: Span, bound: inspect.BoundArguments | None) -> None:
    if bound is None:
        return
    try:
        span.set_attribute("tracelens.args_hash", _args_hash_for_bound(bound))
        span.set_attribute("tracelens.args_schema", _args_schema_str(bound))
        span.set_attribute("tracelens.args_summary_json", json.dumps(_args_summary_dict(bound)))
    except BaseException:  # noqa: BLE001 — arg summarization must never break the call
        pass


def wrap_call(qual: str, impl: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    bound = _try_bind(impl, args, kwargs)
    tracer = trace.get_tracer("tracelens.runtime")
    with tracer.start_as_current_span(qual) as span:
        _apply_entry_attrs(span, bound)
        mem_before = _mem_now()
        out = impl(*args, **kwargs)
        _apply_mem_attr(span, mem_before)
        viol = check_invariants(qual, dict(bound.arguments) if bound else {}, out)
        _apply_exit_attrs(span, bound, out, viol)
        return out


async def wrap_call_async(qual: str, impl: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    bound = _try_bind(impl, args, kwargs)
    tracer = trace.get_tracer("tracelens.runtime")
    with tracer.start_as_current_span(qual) as span:
        _apply_entry_attrs(span, bound)
        mem_before = _mem_now()
        out = await impl(*args, **kwargs)
        _apply_mem_attr(span, mem_before)
        viol = check_invariants(qual, dict(bound.arguments) if bound else {}, out)
        _apply_exit_attrs(span, bound, out, viol)
        return out
