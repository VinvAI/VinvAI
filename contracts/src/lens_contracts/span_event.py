"""Canonical Tracelens enter/exit event written to ``trace.jsonl``."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SideEffect(BaseModel):
    kind: Literal["db", "http", "cache", "queue", "llm", "fs", "other"]
    hash: str
    target_id: str | None = None


class SpanEvent(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
        json_schema_extra={
            "allOf": [
                {
                    "if": {
                        "properties": {"event": {"const": "enter"}},
                        "required": ["event"],
                    },
                    "then": {
                        "required": ["args_hash", "args_schema", "args_summary"]
                    },
                },
                {
                    "if": {
                        "properties": {"event": {"const": "exit"}},
                        "required": ["event"],
                    },
                    "then": {
                        "required": [
                            "duration_ms",
                            "status",
                            "oracle_violations",
                            "call_count_in_request",
                        ]
                    },
                },
            ]
        },
    )

    ts: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}T")
    request_id: str
    component: str = Field(..., description="FQN: pkg.module.symbol")
    event: Literal["enter", "exit"]
    level: str
    depth: int = Field(..., ge=0)
    parent_component: str | None
    thread_id: int

    # enter-only
    args_hash: str | None = Field(None, description="blake2b-8 hex (16 chars)")
    args_schema: str | None = None
    args_summary: dict[str, Any] | None = Field(None, description="≤256 B serialized")

    # exit-only
    duration_ms: float | None = Field(None, ge=0)
    mem_delta_bytes: int | None = None
    status: Literal["ok", "error"] | None = None
    error_type: str | None = None
    error_message: str | None = Field(None, description="truncated to 500 chars")
    error_stack: str | None = Field(
        None, description="formatted traceback tail, truncated (raise site preserved)"
    )
    result_hash: str | None = None
    result_schema: str | None = None
    result_summary: dict[str, Any] | None = None
    oracle_violations: list[str] = Field(default_factory=list)
    call_count_in_request: int | None = Field(None, ge=1)
    side_effects: list[SideEffect] = Field(default_factory=list)
    determinism_sources: list[str] = Field(default_factory=list)
    symbol_id: str | None = None
    capture_scope: str | None = None

    @model_validator(mode="after")
    def _require_event_fields(self) -> SpanEvent:
        if self.event == "enter" and (
            self.args_hash is None
            or self.args_schema is None
            or self.args_summary is None
        ):
            raise ValueError("enter events require args_hash, args_schema, and args_summary")
        if self.event == "exit" and (
            self.duration_ms is None
            or self.status is None
            or self.call_count_in_request is None
        ):
            raise ValueError(
                "exit events require duration_ms, status, and call_count_in_request"
            )
        return self
