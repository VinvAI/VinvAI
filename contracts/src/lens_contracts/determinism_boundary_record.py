"""DeterminismBoundaryRecord: everything needed to replay a request bit-deterministically.

Doc 01 §3.6 / doc 09 §6. Captured by the launcher's determinism-boundary hooks (Phase 1.6 of
the roadmap). The verifier injects these on replay to detect divergence.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ClockCall(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    fn: Literal["time.time", "time.monotonic", "time.perf_counter", "datetime.datetime.now"]
    returned: float


class RngEvent(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    fn: Literal[
        "random.random",
        "random.randint",
        "random.getrandbits",
        "numpy.random.default_rng",
        "uuid.uuid4",
        "secrets.token_bytes",
        "secrets.token_hex",
    ]
    payload_hex: str = Field(..., description="returned bytes / int / float, hex-encoded")


class ExternalResponseRecord(BaseModel):
    """Recorded response for one external boundary call. Replayed by IOMock."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    span_id: str
    target_kind: Literal["db", "http", "cache", "queue", "llm", "fs"]
    target_id: str
    request_hash: str
    response_hash: str | None
    response_blob_ref: str | None = Field(
        None, description="object-store ref to canonical response; absent if hash-only"
    )


class ThreadingEvent(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    fn: Literal["threading.Thread.start", "asyncio.create_task"]
    name: str
    order: int


class DeterminismBoundaryRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_version: Literal["1"] = "1"
    tenant_id: str = "default"
    service_id: str = "default"
    request_id: str
    captured_at: datetime

    # process invariants captured at request entry
    python_hash_seed: str
    env_snapshot: dict[str, str] = Field(
        default_factory=dict,
        description="only the env vars actually read in the request scope",
    )

    # ordered streams (consumed sequentially on replay)
    clock_calls: list[ClockCall] = Field(default_factory=list)
    rng_events: list[RngEvent] = Field(default_factory=list)
    external_responses: list[ExternalResponseRecord] = Field(default_factory=list)
    threading_events: list[ThreadingEvent] = Field(default_factory=list)

    # things we know we cannot capture (doc 09 §6.4)
    capture_gaps: list[str] = Field(
        default_factory=list,
        description="documented limitations: native_clock | gpu | lock_order | retry_jitter | ...",
    )

    extra: dict[str, Any] = Field(default_factory=dict)
