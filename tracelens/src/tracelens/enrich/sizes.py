"""T3.4 — bytes / tokens / rows enrichment helpers.

The OTel contrib instrumenters do not all populate ``bytes_in / bytes_out / tokens_in /
tokens_out`` consistently. This module provides:

  - ``record_size(span, *, bytes_in, bytes_out, tokens_in, tokens_out, rows_scanned, cost_usd)``
    — direct span attribute writer; idempotent.
  - ``llm_response_size(resp)`` — best-effort size extraction for common LLM client
    response shapes (OpenAI, Anthropic, LiteLLM dict).
  - ``http_response_size(resp)`` — bytes for ``requests``/``httpx`` Response.
  - ``db_rowcount(cursor)`` — rows scanned from psycopg2 / sqlalchemy cursor.

Callers can wire these into their own client wrappers OR a future ``analyze enrich-sizes``
post-processor can replay the JSONL and patch in counts from the original responses.

The cost-mapper (Phase 2.1) will read these attributes; without them, only CPU-time-based
$ projection is possible.
"""

from __future__ import annotations

from typing import Any


def record_size(
    span: Any,
    *,
    bytes_in: int | None = None,
    bytes_out: int | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    rows_scanned: int | None = None,
    cost_usd: float | None = None,
) -> None:
    if span is None:
        return
    if bytes_in is not None:
        span.set_attribute("tracelens.bytes_in", int(bytes_in))
    if bytes_out is not None:
        span.set_attribute("tracelens.bytes_out", int(bytes_out))
    if tokens_in is not None:
        span.set_attribute("tracelens.tokens_in", int(tokens_in))
    if tokens_out is not None:
        span.set_attribute("tracelens.tokens_out", int(tokens_out))
    if rows_scanned is not None:
        span.set_attribute("tracelens.rows_scanned", int(rows_scanned))
    if cost_usd is not None:
        span.set_attribute("tracelens.cost_usd", float(cost_usd))


def llm_response_size(resp: Any) -> dict[str, int]:
    """Best-effort LLM token counts. Handles OpenAI ``ChatCompletion``-style and dicts."""
    out: dict[str, int] = {}
    try:
        usage = getattr(resp, "usage", None) or (
            resp.get("usage") if isinstance(resp, dict) else None
        )
        if usage is None:
            return out
        if hasattr(usage, "model_dump"):
            usage = usage.model_dump()
        if isinstance(usage, dict):
            for key in ("prompt_tokens", "input_tokens"):
                if key in usage:
                    out["tokens_in"] = int(usage[key])
                    break
            for key in ("completion_tokens", "output_tokens"):
                if key in usage:
                    out["tokens_out"] = int(usage[key])
                    break
    except BaseException:  # noqa: BLE001
        pass
    return out


def http_response_size(resp: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    try:
        content = getattr(resp, "content", None)
        if isinstance(content, bytes | bytearray):
            out["bytes_out"] = len(content)
        cl = (
            getattr(resp, "headers", {}).get("content-length") if hasattr(resp, "headers") else None
        )
        if cl is not None and "bytes_out" not in out:
            out["bytes_out"] = int(cl)
    except BaseException:  # noqa: BLE001
        pass
    return out


def db_rowcount(cursor: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    try:
        rc = getattr(cursor, "rowcount", None)
        if isinstance(rc, int) and rc >= 0:
            out["rows_scanned"] = rc
    except BaseException:  # noqa: BLE001
        pass
    return out
