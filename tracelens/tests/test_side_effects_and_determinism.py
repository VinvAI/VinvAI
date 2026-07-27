"""G1 + G3 + G4 + G5 — side_effects, parent fallback, determinism_sources, symbol_id.

These tests verify the *contract*: a spans-and-attributes input from the OTel SDK shape
maps to the new exit-event fields. They don't spin up a subprocess.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


def _exit_line(**overrides: Any) -> dict[str, Any]:
    base = {
        "ts": "2024-01-01T00:00:00.000Z",
        "request_id": "r1",
        "component": "x.y",
        "event": "exit",
        "level": "INFO",
        "depth": 0,
        "parent_component": None,
        "thread_id": 1,
        "duration_ms": 1.0,
        "status": "ok",
        "error_type": None,
        "error_message": None,
        "result_hash": None,
        "result_schema": None,
        "result_summary": None,
        "oracle_violations": [],
        "call_count_in_request": 1,
    }
    base.update(overrides)
    return base


def test_schema_accepts_new_optional_fields(tmp_path: Path) -> None:
    """All four new fields are optional and validate when present."""
    from importlib import resources

    import jsonschema

    schema = json.loads(
        resources.files("lens_contracts.schemas").joinpath("span_event.schema.json").read_text()
    )

    # Without new fields — still valid.
    jsonschema.validate(_exit_line(), schema)

    # With new fields — valid.
    jsonschema.validate(
        _exit_line(
            side_effects=[{"kind": "db", "hash": "ab" * 8, "target_id": "postgres:public.users"}],
            determinism_sources=["clock", "rng"],
            symbol_id=None,
            capture_scope="python_backend_only",
        ),
        schema,
    )


def test_side_effect_kind_constrained() -> None:
    """``kind`` must be one of the documented enum values."""
    from importlib import resources

    import jsonschema

    schema = json.loads(
        resources.files("lens_contracts.schemas").joinpath("span_event.schema.json").read_text()
    )
    bad = _exit_line(side_effects=[{"kind": "made_up", "hash": "f" * 16}])
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(bad, schema)


class _FakeParent:
    """Tiny stand-in for the OTel SpanContext on `span.parent`."""

    span_id = 0xDEAD


def _fake_span(
    *,
    attributes: dict,
    name: str,
    parent: object | None = _FakeParent(),
    kind: object | None = None,
):
    class FakeSpan:
        pass

    FakeSpan.attributes = attributes
    FakeSpan.name = name
    FakeSpan.parent = parent
    FakeSpan.kind = kind
    return FakeSpan()


def test_processor_classifies_db_span() -> None:
    """An OTel-shaped DB span attribute set produces a side_effect record."""
    from tracelens.otel.processor import _classify_span_for_side_effect

    span = _fake_span(
        attributes={
            "db.system": "postgresql",
            "db.statement": "SELECT * FROM users",
            "db.name": "app",
        },
        name="SELECT app.users",
    )
    result = _classify_span_for_side_effect(span)
    assert result is not None
    assert result["kind"] == "db"
    assert "postgresql" in result["target_id"]
    assert len(result["hash"]) == 16


def test_processor_classifies_http_span() -> None:
    from tracelens.otel.processor import _classify_span_for_side_effect

    span = _fake_span(
        attributes={"http.method": "GET", "http.url": "https://api.example.com/x"},
        name="GET /x",
    )
    result = _classify_span_for_side_effect(span)
    assert result is not None
    assert result["kind"] == "http"
    assert "GET https://api.example.com/x" in result["target_id"]


def test_processor_skips_non_io_span() -> None:
    """A function-call span (no DB/HTTP/cache attrs) should not become a side_effect."""
    from tracelens.otel.processor import _classify_span_for_side_effect

    span = _fake_span(
        attributes={"tracelens.depth": 0, "tracelens.request_id": "r1"},
        name="demo.x",
    )
    assert _classify_span_for_side_effect(span) is None


def test_processor_skips_root_span() -> None:
    """A span with no parent is never a side_effect — it IS the request."""
    from tracelens.otel.processor import _classify_span_for_side_effect

    span = _fake_span(
        attributes={"http.method": "GET", "http.url": "https://api.example.com/x"},
        name="GET /x",
        parent=None,
    )
    assert _classify_span_for_side_effect(span) is None


def test_processor_skips_server_side_http() -> None:
    """A server-kind HTTP span is the inbound request, not an outbound side effect."""
    from opentelemetry.trace import SpanKind

    from tracelens.otel.processor import _classify_span_for_side_effect

    span = _fake_span(
        attributes={"http.method": "GET", "http.url": "/health"},
        name="GET /health",
        kind=SpanKind.SERVER,
    )
    assert _classify_span_for_side_effect(span) is None


def test_determinism_record_drains_per_request() -> None:
    from tracelens.otel.processor import (
        clear_determinism_record,
        get_determinism_sources_for,
        record_determinism_source,
    )

    record_determinism_source("rid-A", "clock")
    record_determinism_source("rid-A", "rng")
    record_determinism_source("rid-B", "clock")
    assert get_determinism_sources_for("rid-A") == ["clock", "rng"]
    assert get_determinism_sources_for("rid-B") == ["clock"]
    clear_determinism_record("rid-A")
    clear_determinism_record("rid-B")
