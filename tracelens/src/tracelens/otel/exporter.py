"""Export OTel spans as two JSONL lines per span (enter + exit), spec §4 / §5.9."""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import weakref
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import StatusCode

from tracelens import _health
from tracelens.enrich.summaries import summarize

_log = logging.getLogger("tracelens.diag")

# Process-wide count of spans successfully written as JSONL pairs. Read by the
# launcher's capture self-check ("is anything actually flowing?") and folded into
# the summary's capture_health block.
_exported_count = 0


def exported_span_count() -> int:
    return _exported_count


def _iso_ms_utc(ns: int) -> str:
    if ns < 0:
        ns = 0
    sec = ns // 1_000_000_000
    ms = (ns % 1_000_000_000) // 1_000_000
    dt = datetime.fromtimestamp(sec, tz=UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}Z"


def _attr(attrs: Mapping[str, Any] | None, key: str, default: Any = None) -> Any:
    if not attrs:
        return default
    return attrs.get(key, default)


def _attr_str(attrs: Mapping[str, Any] | None, key: str, default: str = "") -> str:
    v = _attr(attrs, key, default)
    if v is None:
        return default
    return str(v)


def _attr_int(attrs: Mapping[str, Any] | None, key: str, default: int = 0) -> int:
    v = _attr(attrs, key, default)
    if isinstance(v, int):
        return v
    try:
        return int(str(v))
    except Exception:
        return default


def _parse_json_obj(s: str | None) -> dict[str, Any]:
    if not s:
        return {}
    try:
        o = json.loads(s)
        return o if isinstance(o, dict) else {}
    except Exception:
        return {}


# Bounded capture sizes for exception payloads. Env-tunable like every other
# capture knob; the defaults keep a single exit line small while preserving the
# full failure identity (message) and enough frames to localize the raise site.
def _env_cap(name: str, default: int) -> int:
    import os

    try:
        v = int(os.environ.get(name, ""))
        return v if v > 0 else default
    except ValueError:
        return default


_MESSAGE_CHARS = _env_cap("TRACELENS_ERROR_MESSAGE_CHARS", 500)
_STACK_CHARS = _env_cap("TRACELENS_ERROR_STACK_CHARS", 4000)


def _exception_from_events(span: ReadableSpan) -> tuple[str | None, str | None, str | None]:
    """(type, message, stacktrace) from the span's recorded exception event.

    OTel's SpanRecordException already carries the formatted traceback in
    `exception.stacktrace`; dropping it here made every downstream consumer
    (QnA, context packs, MCP runtime tools) blind to WHERE an error was raised.
    The tail of the stack is kept when truncating — the raise site lives there.
    """
    for ev in span.events or []:
        if ev.name == "exception":
            attrs = ev.attributes or {}
            et = attrs.get("exception.type")
            em = attrs.get("exception.message")
            st = attrs.get("exception.stacktrace")
            return (
                str(et) if et is not None else None,
                (str(em)[:_MESSAGE_CHARS] if em is not None else None),
                (str(st)[-_STACK_CHARS:] if st is not None else None),
            )
    return None, None, None


class JSONLFileSpanExporter(SpanExporter):
    def __init__(self, output_path: str, *, diagnostic_path: str | None = None) -> None:
        self._path = output_path
        self._diag_path = diagnostic_path
        self._lock = threading.Lock()
        self._fh: IO[str] | None = None
        self._diag: IO[str] | None = None
        if output_path == "-":
            self._fh = sys.stdout
        else:
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            self._fh = open(output_path, "a", encoding="utf-8")  # noqa: SIM115
        if diagnostic_path:
            Path(diagnostic_path).parent.mkdir(parents=True, exist_ok=True)
            self._diag = open(diagnostic_path, "a", encoding="utf-8")  # noqa: SIM115
        # os.fork() in the traced target (multiprocessing, gunicorn-style prefork,
        # bare os.fork) duplicates this exporter — including the buffered file
        # handle — into the child. Two processes writing one handle can interleave
        # partial lines and tear the parent's JSONL. Redirect the CHILD's spans to
        # a pid-suffixed sidecar file instead; the parent's file stays untouched.
        if output_path != "-" and hasattr(os, "register_at_fork"):
            ref = weakref.ref(self)

            def _after_fork_in_child() -> None:
                inst = ref()
                if inst is not None:
                    inst._reopen_in_child()

            os.register_at_fork(after_in_child=_after_fork_in_child)

    def _reopen_in_child(self) -> None:
        """Post-``fork`` (child side): abandon the inherited handle, open a sidecar.

        The inherited handle is deliberately NOT closed — closing would flush any
        buffered bytes duplicated from the parent into the shared file. On any
        failure the exporter disables itself in the child (``_fh = None``): losing
        the child's spans loudly beats corrupting the parent's trace.
        """
        try:
            self._lock = threading.Lock()  # the inherited lock may be held forever
            self._fh = None
            sidecar = f"{self._path}.fork-{os.getpid()}"
            self._fh = open(sidecar, "a", encoding="utf-8")  # noqa: SIM115
            self._path = sidecar
            _health.record("fork_sidecars", note=sidecar)
            _log.info("tracelens: fork child pid=%s spans go to sidecar %s", os.getpid(), sidecar)
        except BaseException as exc:  # noqa: BLE001 — never crash the forked child
            self._fh = None
            _health.record("fork_sidecar_open_errors", note=repr(exc))
            _health.warn_once(
                "fork_sidecar_open",
                f"could not open fork sidecar trace file ({type(exc).__name__}: {exc}) — "
                f"spans from forked child pid={os.getpid()} will be lost",
            )

    def _write_line(self, obj: dict[str, Any]) -> None:
        line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n"
        with self._lock:
            if self._path == "-":
                sys.stdout.write(line)
                sys.stdout.flush()
            elif self._fh:
                self._fh.write(line)
                self._fh.flush()

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        global _exported_count
        for span in spans:
            try:
                self._export_one(span)
                _exported_count += 1
            except BaseException as exc:
                # Degraded capture must be LOUD + accounted, never silently eaten:
                # a full disk / revoked handle here used to only reach a logger
                # nobody had configured while the run "succeeded" with a hole in
                # the trace.
                _health.record("export_errors", note=repr(exc))
                _health.warn_once(
                    "export_error",
                    f"span export to {self._path} failed ({type(exc).__name__}: {exc}) — "
                    "capture is degraded (disk full / file removed?); see "
                    "capture_health in the trace summary",
                )
                _log.exception("export span failed: %s", exc)
                try:
                    if self._diag:
                        self._diag.write(f"export error: {exc!r}\n")
                except OSError:
                    pass  # the diag sidecar is best-effort; the warning above is the signal
        return SpanExportResult.SUCCESS

    def _export_one(self, span: ReadableSpan) -> None:
        attrs = span.attributes or {}
        st = span.start_time or 0
        et = span.end_time or st
        duration_ms = max(0.0, (et - st) / 1_000_000.0)
        trace_id = span.context.trace_id
        request_id = _attr_str(attrs, "tracelens.request_id") or f"ot-{trace_id:032x}"
        component = span.name
        depth = _attr_int(attrs, "tracelens.depth", 0)
        parent_raw = _attr_str(attrs, "tracelens.parent_component", "")
        parent_component: str | None = None if not parent_raw else parent_raw
        thread_id = _attr_int(attrs, "thread.id", threading.get_ident())
        if thread_id == 0:
            thread_id = threading.get_ident()

        ah_raw = _attr_str(attrs, "tracelens.args_hash", "")
        if ah_raw:
            args_hash = ah_raw[:16]
        else:
            args_hash = "unhashable00000"[:16]
        args_schema = _attr_str(attrs, "tracelens.args_schema", "()")
        args_summary = _parse_json_obj(_attr_str(attrs, "tracelens.args_summary_json", ""))
        if not args_summary:
            args_summary = summarize(component)

        ok = span.status.status_code == StatusCode.OK or span.status.status_code == StatusCode.UNSET
        err_t, err_m, err_s = _exception_from_events(span)
        if span.status.status_code == StatusCode.ERROR:
            ok = False
        status_str = "ok" if ok else "error"
        level_enter = "INFO"
        level_exit = "ERROR" if not ok else "INFO"

        enter: dict[str, Any] = {
            "ts": _iso_ms_utc(st),
            "request_id": request_id,
            "component": component,
            "event": "enter",
            "level": level_enter,
            "depth": depth,
            "parent_component": parent_component,
            "thread_id": thread_id,
            "args_hash": args_hash[:16],
            "args_schema": args_schema,
            "args_summary": args_summary,
        }
        self._write_line(enter)

        violations_raw = _attr_str(attrs, "tracelens.oracle_violations_json", "[]")
        try:
            viol = json.loads(violations_raw)
            if not isinstance(viol, list):
                viol = []
        except Exception:
            viol = []

        result_hash: str | None = _attr_str(attrs, "tracelens.result_hash", "") or None
        result_schema: str | None = _attr_str(attrs, "tracelens.result_schema", "") or None
        result_summary: dict[str, Any] | None = _parse_json_obj(
            _attr_str(attrs, "tracelens.result_summary_json", "")
        )
        if ok:
            if not result_hash:
                result_hash = None
            if not result_schema:
                result_schema = None
            if not result_summary:
                result_summary = None
        else:
            result_hash = None
            result_schema = None
            result_summary = None

        # G1 — drain side_effects accumulator (read from processor side-channel, NOT from
        # span attributes, because the span is already ended and `set_attribute` no-ops).
        from tracelens.otel.processor import (
            clear_determinism_record,
            drain_side_effects_for,
            get_determinism_sources_for,
        )

        side_effects = drain_side_effects_for(trace_id, span.context.span_id)
        # G4 — determinism sources touched in this request. Cleared at root-span-exit time
        # so subsequent requests reusing the same trace id don't bleed state.
        determinism_sources = get_determinism_sources_for(request_id)
        if depth == 0 and request_id:
            clear_determinism_record(request_id)

        # G5 — symbol_id placeholder; nullable. Populated when the AST hook starts emitting
        # AST-content hashes (Series-A item; today every value is None).
        symbol_id_raw = _attr_str(attrs, "tracelens.symbol_id", "")
        symbol_id: str | None = symbol_id_raw or None

        exit_obj: dict[str, Any] = {
            "ts": _iso_ms_utc(et),
            "request_id": request_id,
            "component": component,
            "event": "exit",
            "level": level_exit,
            "depth": depth,
            "parent_component": parent_component,
            "thread_id": thread_id,
            "duration_ms": round(duration_ms, 4),
            # None when memory attribution is OFF (the span carries no
            # attribute) — a bare 0 here would be indistinguishable from a real
            # zero-delta call, and downstream consumers (e.g. the extension's
            # per-symbol memory overlay) treat "no memory data" as "omit the
            # memory axis", not "everything allocates nothing".
            "mem_delta_bytes": (
                _attr_int(attrs, "tracelens.mem_delta_bytes", 0)
                if _attr(attrs, "tracelens.mem_delta_bytes") is not None
                else None
            ),
            "status": status_str,
            "error_type": err_t if not ok else None,
            "error_message": err_m if not ok else None,
            "error_stack": err_s if not ok else None,
            "result_hash": result_hash,
            "result_schema": result_schema,
            "result_summary": result_summary,
            "oracle_violations": viol,
            "call_count_in_request": _attr_int(attrs, "tracelens.call_count_in_request", 1),
            "side_effects": side_effects,
            "determinism_sources": determinism_sources,
            "symbol_id": symbol_id,
            "capture_scope": "python_backend_only",
        }
        self._write_line(exit_obj)

    def shutdown(self) -> None:
        try:
            if self._fh and self._path != "-":
                self._fh.close()
        except Exception as exc:
            # close() flushes — a failure here (disk full at the very end) can
            # drop the trace tail, so it must not vanish into a bare pass.
            _health.record("shutdown_close_errors", note=repr(exc))
            _health.warn_once(
                "shutdown_close_error",
                f"closing trace output {self._path} failed ({type(exc).__name__}: {exc}) — "
                "the tail of the trace may be missing",
            )
        try:
            if self._diag:
                self._diag.close()
        except Exception:
            pass  # diag sidecar only; never capture-affecting
