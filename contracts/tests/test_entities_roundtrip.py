"""All five entities round-trip through pydantic → JSON → pydantic and validate against
their JSON Schema (regenerated on the fly to avoid drift)."""

from __future__ import annotations

import json
from typing import Any

import jsonschema
import pytest

from lens_contracts import (
    CodeVersion,
    DeterminismBoundaryRecord,
    ExternalCallEvent,
    ReplayCorpusRow,
    SampleEvent,
    SpanEvent,
)
from lens_contracts.replay_corpus_row import (
    ExternalCallSummary,
    InputFingerprint,
    OutputFingerprint,
)
from lens_contracts.sample_event import StackFrame
from lens_contracts.tools.gen_schemas import ENTITIES, render

_CV = CodeVersion(
    primary="abc123",
    primary_kind="git_sha",
    git_sha="abc123",
)


def _span() -> SpanEvent:
    return SpanEvent(
        ts="2026-04-28T10:00:00.000Z",
        request_id="-",
        component="x.y.z",
        event="enter",
        level="INFO",
        depth=0,
        parent_component=None,
        thread_id=1,
        args_hash="0" * 16,
        args_schema="()",
        args_summary={},
    )


def _sample() -> SampleEvent:
    return SampleEvent(
        process_id="pid-1-1",
        code_version=_CV,
        ts="2026-04-28T10:00:00.000Z",
        sample_kind="cpu",
        stack=[StackFrame(symbol="x.y.z", file="x.py", line=10)],
        value=1,
        weight_ms=10,
    )


def _external() -> ExternalCallEvent:
    return ExternalCallEvent(
        process_id="pid-1-1",
        code_version=_CV,
        ts="2026-04-28T10:00:00.000Z",
        trace_id="t1",
        span_id="s1",
        target_kind="http",
        target_id="GET https://api.example/x",
        request_summary="GET https://api.example/x",
        request_hash="a" * 16,
        duration_ns=1_000_000,
    )


def _replay_row() -> ReplayCorpusRow:
    return ReplayCorpusRow(
        code_version=_CV,
        request_id="r1",
        captured_at="2026-04-28T10:00:00.000Z",
        entry_component="x.y.entry",
        input=InputFingerprint(args_hash="a" * 16, args_schema="(int)"),
        expected_output=OutputFingerprint(result_hash="b" * 16, result_schema="dict"),
        external_calls=[
            ExternalCallSummary(
                span_id="s1",
                target_kind="db",
                target_id="public.users",
                request_hash="c" * 16,
                response_hash="d" * 16,
                duration_ns=10_000,
            )
        ],
    )


def _determinism() -> DeterminismBoundaryRecord:
    return DeterminismBoundaryRecord(
        request_id="r1",
        captured_at="2026-04-28T10:00:00.000Z",
        python_hash_seed="0",
    )


_FACTORIES = {
    "span_event": (SpanEvent, _span),
    "sample_event": (SampleEvent, _sample),
    "external_call_event": (ExternalCallEvent, _external),
    "replay_corpus_row": (ReplayCorpusRow, _replay_row),
    "determinism_boundary_record": (DeterminismBoundaryRecord, _determinism),
}


@pytest.mark.parametrize("name", list(_FACTORIES.keys()))
def test_pydantic_roundtrip(name: str) -> None:
    cls, mk = _FACTORIES[name]
    obj = mk()
    payload = json.loads(obj.model_dump_json())
    cls.model_validate(payload)


@pytest.mark.parametrize("name", list(_FACTORIES.keys()))
def test_jsonschema_validates_serialized(name: str) -> None:
    cls, mk = _FACTORIES[name]
    schema: dict[str, Any] = render(cls)
    payload = json.loads(mk().model_dump_json())
    jsonschema.validate(payload, schema)


def test_entities_table_complete() -> None:
    assert set(ENTITIES.keys()) == set(_FACTORIES.keys())
