"""ReplayCorpusRow: per-request entry that the equivalence verifier replays."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from lens_contracts.code_version import CodeVersion


class InputFingerprint(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    args_hash: str
    args_schema: str
    canonical_blob_ref: str | None = Field(
        None, description="object-store ref to KMS-encrypted full args; absent if hash-only"
    )


class OutputFingerprint(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    result_hash: str | None = None
    result_schema: str | None = None
    status: Literal["ok", "error"] = "ok"
    error_type: str | None = None
    canonical_blob_ref: str | None = None


class ExternalCallSummary(BaseModel):
    """Compact form of one ExternalCallEvent for replay verification (no full payload)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    span_id: str
    target_kind: Literal["db", "http", "cache", "queue", "llm", "fs", "other"]
    target_id: str
    request_hash: str
    response_hash: str | None
    duration_ns: int


class ReplayCorpusRow(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_version: Literal["1"] = "1"
    tenant_id: str = "default"
    service_id: str = "default"
    code_version: CodeVersion

    request_id: str
    captured_at: datetime
    entry_component: str = Field(..., description="FQN of the symbol that began the request")

    input: InputFingerprint
    expected_output: OutputFingerprint
    external_calls: list[ExternalCallSummary] = Field(default_factory=list)

    determinism_record_ref: str | None = Field(
        None, description="reference to the DeterminismBoundaryRecord row joined by request_id"
    )
