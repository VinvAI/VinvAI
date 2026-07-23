"""CodeVersion: resolution chain for the running code identifier (doc 01 §3.1)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class CodeVersion(BaseModel):
    """Source-of-truth identifier for the running code.

    Resolution priority (capture-side):
        1. git_sha            — `git rev-parse HEAD` succeeds in target's cwd
        2. build_id           — CI/CD env (BUILD_ID, etc.)
        3. container_digest   — sha256 of the OCI image
        4. content_hash       — sha256 of the target package's installed __file__ tree
        5. "unknown"          — last resort; replay corpora become hash-only
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    primary: str
    primary_kind: Literal["git_sha", "build_id", "container_digest", "content_hash", "unknown"]
    git_sha: str | None = None
    build_id: str | None = None
    container_digest: str | None = None
    content_hash: str | None = None
