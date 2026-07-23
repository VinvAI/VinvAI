"""Request-scoped context for tracelens (Baggage + trace-derived ids)."""

from __future__ import annotations

import uuid
from typing import Any

from opentelemetry import baggage
from opentelemetry import context as otel_context


def synthetic_request_id_from_trace(trace_id_int: int) -> str:
    return f"ot-{trace_id_int:032x}"


def synthetic_request_id_from_span(trace_id_int: int, span_id_int: int) -> str:
    """Per-inbound-request id keyed to the HTTP SERVER span, not just the trace.

    When an instrumented long-lived entrypoint (e.g. ``app.start_server`` wrapping
    a blocking ``uvicorn.run()``) stays the current span, every request the ASGI
    server handles inherits that one trace_id — collapsing all requests into a
    single ``request_id`` if it is derived from the trace alone. Keying off the
    per-request SERVER span's id restores one-id-per-request segmentation while
    keeping the trace_id prefix for grouping/debuggability.
    """
    return f"ot-{trace_id_int:032x}-{span_id_int:016x}"


def get_request_id_from_baggage() -> str | None:
    try:
        c = otel_context.get_current()
        v = baggage.get_baggage("request_id", context=c)
        if v is None:
            return None
        return str(v)
    except Exception:
        return None


def set_request_id_baggage(request_id: str) -> Any:
    """Set Baggage request_id; returns token for context.detach."""
    c = otel_context.get_current()
    new_ctx = baggage.set_baggage("request_id", request_id, context=c)
    return otel_context.attach(new_ctx)


def new_request_id() -> str:
    return str(uuid.uuid4())
