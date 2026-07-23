"""SampleEvent: profiler / sampler events (doc 01 §3.3)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from lens_contracts.event_header import EventHeader


class StackFrame(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    symbol: str
    file: str | None = None
    line: int | None = None


class SampleEvent(EventHeader):
    model_config = ConfigDict(extra="ignore")

    kind: Literal["sample"] = "sample"
    sample_kind: Literal["cpu", "alloc", "dealloc", "event_loop_block", "gc_pause", "lock_wait"]
    trace_id: str | None = None
    span_id: str | None = None
    stack: list[StackFrame] = Field(default_factory=list)
    value: int = Field(..., description="bytes for alloc, 1 for cpu, ms for waits")
    weight_ms: int = Field(..., ge=1, description="sampling period in milliseconds")
