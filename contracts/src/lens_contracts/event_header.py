"""EventHeader: common fields on every event (doc 01 §3.1)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from lens_contracts.code_version import CodeVersion


class EventHeader(BaseModel):
    """Embedded by every event. `tenant_id="default"` is allowed for single-tenant deploys."""

    model_config = ConfigDict(extra="ignore")

    schema_version: Literal["1"] = "1"
    tenant_id: UUID | Literal["default"] = "default"
    service_id: UUID | Literal["default"] = "default"
    process_id: str = Field(..., description="ephemeral; pid+boot_time")
    code_version: CodeVersion
    ts: datetime = Field(..., description="ISO 8601 UTC")
