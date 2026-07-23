"""The exporter persists the exception traceback (`error_stack`) on exit rows.

The stacktrace is what downstream consumers (QnA evidence, context packs, the
runtime MCP tools) cite to localize a failure; dropping it made every one of
them blind to WHERE an error was raised. Covers: presence, tail-truncation
(raise site preserved), absence on ok exits, and absence-tolerance of old rows.
"""

from __future__ import annotations

import json
from pathlib import Path

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import Status, StatusCode

from tracelens.otel.exporter import JSONLFileSpanExporter


def _capture_failing_span(tmp_path: Path) -> list[dict]:
    out = tmp_path / "trace.jsonl"
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(JSONLFileSpanExporter(str(out))))
    tracer = provider.get_tracer("test")

    def failing_io() -> None:
        raise OSError(5, "Input/output error")

    with tracer.start_as_current_span("demo.mod.failing_io") as span:
        try:
            failing_io()
        except OSError as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR))
    provider.shutdown()
    return [json.loads(line) for line in out.read_text().splitlines()]


def test_error_stack_persisted_with_raise_site(tmp_path: Path) -> None:
    rows = _capture_failing_span(tmp_path)
    exits = [r for r in rows if r.get("event") == "exit"]
    assert len(exits) == 1
    x = exits[0]
    assert x["status"] == "error"
    assert x["error_type"] == "OSError"
    assert x["error_message"] == "[Errno 5] Input/output error"
    stack = x["error_stack"]
    assert stack, "traceback must be persisted on error exits"
    assert "failing_io" in stack, "the raise site survives truncation (tail kept)"
    assert "OSError" in stack


def test_ok_exit_has_no_error_stack(tmp_path: Path) -> None:
    out = tmp_path / "trace.jsonl"
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(JSONLFileSpanExporter(str(out))))
    tracer = provider.get_tracer("test")
    with tracer.start_as_current_span("demo.mod.fine"):
        pass
    provider.shutdown()
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    exits = [r for r in rows if r.get("event") == "exit"]
    assert exits and exits[0]["status"] == "ok"
    assert exits[0]["error_stack"] is None


def test_span_event_contract_tolerates_missing_stack() -> None:
    # Old captures predate the field: the versioned contract must accept them.
    from lens_contracts import SpanEvent

    legacy = SpanEvent.model_validate(
        {
            "ts": "2026-01-01T00:00:00.000Z",
            "request_id": "r1",
            "component": "a.b.c",
            "event": "exit",
            "level": "ERROR",
            "depth": 0,
            "parent_component": None,
            "thread_id": 1,
            "duration_ms": 12.5,
            "call_count_in_request": 1,
            "status": "error",
            "error_type": "OSError",
            "error_message": "[Errno 5] Input/output error",
        }
    )
    assert legacy.error_stack is None
