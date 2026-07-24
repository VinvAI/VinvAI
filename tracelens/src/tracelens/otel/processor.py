"""SpanProcessor: depth/parent stack, call counts; per-call args/result set in trace_fn.

G1 / G3 / G4 — collects side_effects from child spans (DB / HTTP / cache / LLM contrib
attributes), tracks determinism_sources per request, and falls back to OTel parent span's
name for ``parent_component`` when our own contextvar stack is empty (which happens when
the contrib instrumenter starts the root span).
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from contextvars import ContextVar
from threading import Lock
from typing import Any

from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor

from tracelens import _health
from tracelens.context import (
    get_request_id_from_baggage,
    synthetic_request_id_from_span,
    synthetic_request_id_from_trace,
)

_log = logging.getLogger("tracelens.diag")
_dropped = 0
_stack_cv: ContextVar[tuple[tuple[int, str], ...]] = ContextVar(
    "tracelens_span_stack", default=tuple()
)
_cc_lock = Lock()
_cc: dict[tuple[int, str], int] = defaultdict(int)

# G1 — side-effect accumulator: maps (trace_id, span_id_of_parent) → list of side_effect
# dicts, written by child-span on_end. The EXPORTER reads from here for the parent's exit
# event because span attributes can no longer be set inside on_end (the span is already
# marked ended, and ``set_attribute`` on an ended span is a silent no-op).
_se_lock = Lock()
_se: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)

# G3 — span_id → span name, recorded in on_start, drained in on_end. Lets parent_component
# resolution work across OTel contrib instrumenters that don't share our contextvar stack.
_name_lock = Lock()
_span_name_by_id: dict[int, str] = {}

# G5 — span_id → request_id, propagated down the real parent-span chain (not the
# contextvar stack, which does not survive the contrib-instrumenter seam). A new
# request_id is minted at each HTTP SERVER span so that one inbound request maps to
# exactly one request_id even when all requests share a trace (collapsed entrypoint).
_rid_lock = Lock()
_request_id_by_span_id: dict[int, str] = {}


# HTTP contrib instrumenters name their inbound span "<METHOD> <route>" (e.g.
# "GET /v1/swarms"). We use that as a request boundary in addition to SpanKind.SERVER,
# because some ASGI/framework instrumenters (or a collapsed ``python -m app`` entrypoint
# with no ASGI middleware) emit these route spans as INTERNAL kind — in which case the
# SERVER-kind check alone never fires and every request collapses onto one trace-derived id.
_HTTP_ROUTE_NAME_RE = re.compile(r"^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+\S")

# A request_id minted from a SERVER/route span carries a span-id suffix
# ("ot-<32hex>-<16hex>"); a trace-derived id has only the trace prefix
# ("ot-<32hex>"). We use this to detect whether the parent span is already inside
# a minted request boundary so nested route-named spans (the ASGI "<route> http
# send/receive" children, which also match _HTTP_ROUTE_NAME_RE) inherit the
# parent's id instead of each minting a fresh one.
_SPAN_KEYED_RID_RE = re.compile(r"^ot-[0-9a-f]{32}-[0-9a-f]{16}$")


def _is_span_keyed_request_id(rid: str | None) -> bool:
    return bool(rid) and bool(_SPAN_KEYED_RID_RE.match(rid or ""))


def _is_http_route_span(span: Span) -> bool:
    """True when the span name looks like an HTTP contrib route span ("GET /path")."""
    try:
        return bool(_HTTP_ROUTE_NAME_RE.match(span.name or ""))
    except Exception:
        return False


def _is_request_root_span(span: Span) -> bool:
    """True for the per-request inbound boundary: an HTTP SERVER-kind span, or an
    HTTP route span ("<METHOD> <route>") regardless of kind (see ``_is_http_route_span``)."""
    try:
        from opentelemetry.trace import SpanKind

        if getattr(span, "kind", None) == SpanKind.SERVER:
            return True
    except Exception:
        pass
    return _is_http_route_span(span)


def drain_side_effects_for(trace_id: int, span_id: int) -> list[dict[str, Any]]:
    """EXPORTER-side helper: pop the side_effect list this span's children deposited."""
    with _se_lock:
        return _se.pop((trace_id, span_id), [])


def get_determinism_sources_for(request_id: str) -> list[str]:
    """EXPORTER-side helper: snapshot the determinism sources touched by this request_id."""
    if not request_id:
        return []
    with _det_lock:
        return sorted(_det.get(request_id, set()))


def clear_determinism_record(request_id: str) -> None:
    if not request_id:
        return
    with _det_lock:
        _det.pop(request_id, None)


# G4 — determinism touches per request; populated by determinism_capture wrappers, drained
# on the request root span's exit.
_det_lock = Lock()
_det: dict[str, set[str]] = defaultdict(set)


# Mapping of OTel span attribute names → side-effect kind. Covers what the standard
# contrib instrumenters emit; unrecognised spans are skipped (rather than misclassified).
_SIDE_EFFECT_ATTR_KIND: dict[str, str] = {
    "db.system": "db",
    "db.statement": "db",
    "db.name": "db",
    "http.method": "http",
    "http.url": "http",
    "http.target": "http",
    "messaging.system": "queue",
    "rpc.system": "http",
}


def record_determinism_source(request_id: str, source: str) -> None:
    """Called by determinism_capture's clock/RNG wrappers on every touch."""
    if not request_id:
        return
    with _det_lock:
        _det[request_id].add(source)


def _purge_cc_for_trace(trace_id: int) -> None:
    with _cc_lock:
        for k in list(_cc):
            if k[0] == trace_id:
                del _cc[k]


def _normalize_attr(v: object) -> str:
    s = str(v)
    return s[:200]


def _classify_span_for_side_effect(span: ReadableSpan) -> dict[str, Any] | None:
    """Heuristic: turn an OTel child span into a side_effect record if its attributes
    match a known contrib pattern. Returns None for spans that don't represent a side
    effect (function calls, route spans, server-side HTTP).

    Filtering rules:
        - Root spans (no parent) are never side effects — they ARE the request boundary.
        - Server-side HTTP spans are inbound traffic, not outbound side effects.
        - Only client-kind / producer-kind / internal DB spans count.
    """
    parent = getattr(span, "parent", None)
    if parent is None:
        return None
    kind = getattr(span, "kind", None)
    if kind is not None:
        try:
            from opentelemetry.trace import SpanKind

            if kind in (SpanKind.SERVER, SpanKind.CONSUMER):
                return None
        except Exception:
            pass
    attrs = span.attributes or {}
    for key, kind in _SIDE_EFFECT_ATTR_KIND.items():
        if key in attrs:
            target_parts = []
            if "db.system" in attrs:
                target_parts.append(_normalize_attr(attrs["db.system"]))
            if "db.name" in attrs:
                target_parts.append(_normalize_attr(attrs["db.name"]))
            if "http.method" in attrs and "http.url" in attrs:
                target_parts.append(
                    f"{_normalize_attr(attrs['http.method'])} {_normalize_attr(attrs['http.url'])}"
                )
            elif "http.url" in attrs:
                target_parts.append(_normalize_attr(attrs["http.url"]))
            target_id = " ".join(target_parts) or _normalize_attr(span.name)
            payload = " ".join(
                _normalize_attr(attrs[k]) for k in attrs if k.startswith(("db.", "http."))
            )
            # blake2b 8-byte fingerprint of the request payload
            try:
                import hashlib

                h = hashlib.blake2b(payload.encode("utf-8"), digest_size=8).hexdigest()
            except Exception:
                h = "unhashable000000"
            return {"kind": kind, "hash": h, "target_id": target_id}
    return None


class TracelensSpanProcessor(SpanProcessor):
    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        try:
            ctx = span.get_span_context()  # type: ignore[no-untyped-call]
            sid = ctx.span_id
            stack = _stack_cv.get()
            depth = len(stack)
            parent_comp = stack[-1][1] if stack else None
            # G3 — fallback: when our own contextvar stack is empty, look up the parent in
            # ``_span_by_id`` (populated below for every span we see). Works across the
            # contrib-instrumenter / AST-hook seam because both go through this processor.
            if parent_comp is None:
                cur_parent = getattr(span, "parent", None)
                if cur_parent is not None:
                    psid = getattr(cur_parent, "span_id", None)
                    if psid is not None:
                        with _name_lock:
                            parent_name = _span_name_by_id.get(int(psid))
                        if parent_name and parent_name != span.name:
                            parent_comp = parent_name
            span.set_attribute("tracelens.depth", depth)
            if parent_comp is not None:
                span.set_attribute("tracelens.parent_component", parent_comp)
            _stack_cv.set(stack + ((sid, span.name),))
            with _name_lock:
                _span_name_by_id[sid] = span.name

            tid = ctx.trace_id
            with _cc_lock:
                _cc[(tid, span.name)] += 1
                cc = _cc[(tid, span.name)]
            span.set_attribute("tracelens.call_count_in_request", cc)

            # request_id resolution (priority order):
            #   1. explicit Baggage (real cross-service propagation) wins.
            #   2. an HTTP SERVER span mints a fresh per-request id from its span_id.
            #   3. otherwise inherit the enclosing request's id via the parent-span
            #      chain (reliable across the contrib/AST seam, unlike contextvars).
            #   4. fall back to the trace-derived id (startup / non-HTTP roots).
            rid = get_request_id_from_baggage()
            if not rid:
                parent = getattr(span, "parent", None)
                psid = getattr(parent, "span_id", None) if parent else None
                parent_rid = None
                if psid is not None:
                    with _rid_lock:
                        parent_rid = _request_id_by_span_id.get(int(psid))
                if parent_rid is not None and _is_span_keyed_request_id(parent_rid):
                    # Already inside a minted request boundary — inherit it so the
                    # ASGI "<route> http send/receive" child spans (themselves named
                    # like route spans) don't each mint a fresh per-request id.
                    rid = parent_rid
                elif _is_request_root_span(span):
                    rid = synthetic_request_id_from_span(tid, sid)
                elif parent_rid:
                    rid = parent_rid
                else:
                    rid = synthetic_request_id_from_trace(tid)
            with _rid_lock:
                _request_id_by_span_id[sid] = rid
            span.set_attribute("tracelens.request_id", rid)
        except BaseException as exc:  # noqa: BLE001 — never break span start; count + warn once
            global _dropped
            _dropped += 1
            _health.record("span_bookkeeping_errors", note=repr(exc))
            _health.warn_once(
                "span_bookkeeping",
                f"span bookkeeping failed on start ({type(exc).__name__}: {exc}) — "
                "depth/parent/request_id annotations may be missing for some spans "
                "(counted as dropped_events in the trace summary)",
            )

    def on_end(self, span: ReadableSpan) -> None:
        try:
            ctx = span.get_span_context()  # type: ignore[no-untyped-call]
            sid = ctx.span_id
            tid = ctx.trace_id
            attrs = span.attributes or {}

            # G1 — if this span looks like a side effect, record it on the parent.
            se = _classify_span_for_side_effect(span)
            if se is not None:
                parent = getattr(span, "parent", None)
                if parent is not None:
                    psid = getattr(parent, "span_id", None)
                    if psid is not None:
                        with _se_lock:
                            _se[(tid, int(psid))].append(se)

            # NOTE: setting attributes inside on_end is a no-op (the span is already ended).
            # Side-effects + determinism are joined to the exit event by the EXPORTER, which
            # reads from ``drain_side_effects_for`` / ``get_determinism_sources_for``.
            d_raw = attrs.get("tracelens.depth", 0)
            if isinstance(d_raw, int) and not isinstance(d_raw, bool):
                depth = d_raw
            elif isinstance(d_raw, float):
                depth = int(d_raw)
            else:
                try:
                    depth = int(str(d_raw or 0))
                except Exception:
                    depth = 0
            stack = list(_stack_cv.get())
            while stack and stack[-1][0] != sid:
                stack.pop()
            if stack and stack[-1][0] == sid:
                stack.pop()
            _stack_cv.set(tuple(stack))
            if depth == 0 and not stack:
                _purge_cc_for_trace(tid)
                # G4 — DO NOT clear determinism here; the exporter still needs to read the
                # sources for the root span's exit event (BatchSpanProcessor exports after
                # on_end returns). The exporter calls ``clear_determinism_record`` after
                # writing the JSONL line.
            # G3 — drain span-name map; bounded by trace lifetime
            with _name_lock:
                _span_name_by_id.pop(sid, None)
            # G5 — drain request-id map; bounded by span lifetime
            with _rid_lock:
                _request_id_by_span_id.pop(sid, None)
        except BaseException as exc:  # noqa: BLE001 — never break span end; count + warn once
            global _dropped
            _dropped += 1
            _health.record("span_bookkeeping_errors", note=repr(exc))
            _health.warn_once(
                "span_bookkeeping",
                f"span bookkeeping failed on end ({type(exc).__name__}: {exc}) — "
                "side-effect/stack accounting may be incomplete for some spans "
                "(counted as dropped_events in the trace summary)",
            )

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def dropped_events() -> int:
    return _dropped
