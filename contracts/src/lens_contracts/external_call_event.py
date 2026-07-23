"""ExternalCallEvent: DB / HTTP / cache / queue / LLM external boundary calls (doc 01 §3.4)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import ConfigDict, Field

from lens_contracts.event_header import EventHeader


class ExternalCallEvent(EventHeader):
    model_config = ConfigDict(extra="ignore")

    kind: Literal["external"] = "external"
    trace_id: str
    span_id: str
    request_id: str = "-"

    target_kind: Literal["db", "http", "cache", "queue", "llm", "fs", "other"]
    target_id: str = Field(..., description="db.table | host+path | model name | queue name")

    # request side
    request_summary: str = Field(
        ..., description="canonical summary: SQL fingerprint, METHOD URL, etc."
    )
    request_hash: str = Field(..., description="blake2b-8 hex of canonical request")
    request_size_bytes: int | None = Field(None, ge=0)

    # response side
    duration_ns: int = Field(..., ge=0)
    status: Literal["ok", "error", "timeout"] = "ok"
    response_hash: str | None = None
    response_size_bytes: int | None = Field(None, ge=0)

    # cost (LLM-specific; nullable for non-LLM)
    tokens_in: int | None = Field(None, ge=0)
    tokens_out: int | None = Field(None, ge=0)
    cost_usd: float | None = Field(None, ge=0.0)

    # debugging hints
    attributes: dict[str, Any] = Field(default_factory=dict)
