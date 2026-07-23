"""Vinv Engine / components / context_compressor — Context compression component.

Full compression stack:
- ContextChain: Priority-tagged linked-list context builder
- ContextCompressorEngine: Priority-aware compression (non-LLM)
- SmartContextGuard: Priority-based budget management with LLM allocation
- UnifiedCompressor: LLM-powered compression with Shapley support
- UnifiedChunker: Token-accurate chunking with LLM relevance scoring
- ContentIngestionPipeline: Coordinator for chunk/compress decisions
- Token utilities: count_tokens, estimate_tokens_fast, fit_for_logging
- Model context registry: adaptive per-model limit learning
- smart_fit / smart_fit_sync: Universal compression helpers (replace ALL string slicing)
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from core.components.context_compressor.chain import (
    PRIORITY_CAUSAL,
    PRIORITY_CRITICAL,
    PRIORITY_LOW,
    PRIORITY_MEMORY,
    PRIORITY_METADATA,
    PRIORITY_TRAJECTORY,
    ContextChain,
    ContextNode,
)
from core.components.context_compressor.engine import ContextCompressorEngine
from core.components.context_compressor.microcompact import microcompact
from core.components.context_compressor.ptl_recovery import (
    PTLRecoveryResult,
    recover_from_ptl,
    recover_from_ptl_sync,
    recover_from_ptl_string_fallback,
)
from core.components.context_compressor.cross_run_compaction import (
    RunCompactionSummary,
    compact_run,
)
from core.components.context_compressor.signatures import ContextCompressionSignature

_logger = logging.getLogger(__name__)

_CHARS_PER_TOKEN = int(os.environ.get("VINV_ENGINE_CHARS_PER_TOKEN", "4"))


def _chars_to_tokens(chars: int) -> int:
    return max(1, chars // _CHARS_PER_TOKEN)


async def smart_fit(
    text: str,
    max_chars: int,
    *,
    purpose: str = "",
    goal: str | None = None,
    preserve_ends: bool = False,
    model_id: str | None = None,
) -> str:
    """Intelligently compress *text* to fit within *max_chars*.

    Uses the full LLM compression pipeline (ContentIngestionPipeline) so
    that semantic meaning, file paths, error messages, and structured data
    are preserved — unlike blind ``text[:N]`` slicing which causes random
    catastrophic information loss.

    Falls back to relevance-based chunking when LLM is unavailable, and
    only as a last resort to a head+tail token-aware split (never a raw
    character slice).

    Parameters
    ----------
    text        : source text to compress.
    max_chars   : character budget for the result.
    purpose     : human description passed to the compressor (e.g.
                  "trajectory_summary", "task_description").
    goal        : optional pipeline goal for goal-aware compression.
    preserve_ends : if True and LLM compression fails, keep head + tail
                    instead of head-only (useful for trajectories where
                    the final state matters).
    """
    if not text or len(text) <= max_chars:
        return text

    # ── Fast path for small inputs / small targets ──────────────────────
    _SMALL_INPUT_THRESHOLD = int(
        __import__("os").environ.get("VINV_ENGINE_SMART_FIT_SMALL_INPUT", "10000")
    )
    _SMALL_TARGET_THRESHOLD = int(
        __import__("os").environ.get("VINV_ENGINE_SMART_FIT_SMALL_TARGET", "2000")
    )
    if len(text) <= _SMALL_INPUT_THRESHOLD or max_chars <= _SMALL_TARGET_THRESHOLD:
        _logger.debug(
            "smart_fit: fast path for small text (len=%d, target=%d, purpose=%s)",
            len(text), max_chars, purpose,
        )
        return _token_aware_fit(text, max_chars, preserve_ends=preserve_ends)

    max_tokens = _chars_to_tokens(max_chars)

    try:
        from core.components.context_compressor.content_ingestion import (
            ContentIngestionPipeline,
        )

        pipeline = ContentIngestionPipeline()
        result = await pipeline.process(
            content=text,
            max_tokens=max_tokens,
            query=purpose or None,
            goal=goal,
            context_type=purpose or "general",
            model_id=model_id,
        )
        if len(result.content) <= max_chars:
            return result.content
        # LLM over-produced — re-compress with tighter budget instead of truncating
        result2 = await pipeline.process(
            content=result.content,
            max_tokens=max(1, max_tokens // 2),
            query=purpose or None,
            goal=goal,
            context_type=purpose or "general",
        )
        return result2.content
    except Exception as exc:
        _logger.debug("smart_fit LLM compression unavailable (%s), using token-aware fallback", exc)

    return _token_aware_fit(text, max_chars, preserve_ends=preserve_ends)


def smart_fit_sync(
    text: str,
    max_chars: int,
    *,
    purpose: str = "",
    goal: str | None = None,
    preserve_ends: bool = False,
    model_id: str | None = None,
) -> str:
    """Synchronous version of :func:`smart_fit`.

    For small inputs (≤ 10K chars) or small targets (≤ 2K chars), uses the
    fast token-aware fallback directly — LLM compression on tiny texts wastes
    minutes of API time for negligible quality gains.

    For larger inputs, attempts LLM compression only when there is no running
    event loop (to avoid deadlocks).
    """
    if not text or len(text) <= max_chars:
        return text

    # ── Fast path for small inputs / small targets ──────────────────────
    # LLM compression on ≤10K chars → 62-500 char targets was measured at
    # 160-358 seconds per call in production.  The token-aware fallback
    # produces adequate results in <1ms for these sizes.
    _SMALL_INPUT_THRESHOLD = int(
        __import__("os").environ.get("VINV_ENGINE_SMART_FIT_SMALL_INPUT", "10000")
    )
    _SMALL_TARGET_THRESHOLD = int(
        __import__("os").environ.get("VINV_ENGINE_SMART_FIT_SMALL_TARGET", "2000")
    )
    if len(text) <= _SMALL_INPUT_THRESHOLD or max_chars <= _SMALL_TARGET_THRESHOLD:
        _logger.debug(
            "smart_fit_sync: fast path for small text (len=%d, target=%d, purpose=%s)",
            len(text), max_chars, purpose,
        )
        return _token_aware_fit(text, max_chars, preserve_ends=preserve_ends)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    # Only attempt LLM compression when there is NO running event loop.
    # process_sync internally calls run_coroutine_threadsafe().result(300) which
    # blocks the current thread.  If that thread IS the event loop thread, the
    # submitted coroutine can never run → deterministic 300s deadlock.
    if loop is None:
        try:
            from core.components.context_compressor.content_ingestion import (
                ContentIngestionPipeline,
            )

            pipeline = ContentIngestionPipeline()
            result = pipeline.process_sync(
                text, _chars_to_tokens(max_chars),
                query=purpose or None, goal=goal,
                context_type=purpose or "general",
                model_id=model_id,
            )
            if len(result.content) <= max_chars:
                return result.content
            # LLM over-produced — re-compress with tighter budget
            result2 = pipeline.process_sync(
                result.content, max(1, _chars_to_tokens(max_chars) // 2),
                query=purpose or None, goal=goal,
                context_type=purpose or "general",
            )
            return result2.content
        except Exception as exc:
            _logger.debug("smart_fit_sync LLM compression unavailable (%s)", exc)

    return _token_aware_fit(text, max_chars, preserve_ends=preserve_ends)


def _token_aware_fit(
    text: str,
    max_chars: int,
    *,
    preserve_ends: bool = False,
) -> str:
    """Token-boundary-aware fallback that never blindly slices mid-word.

    When *preserve_ends* is True the result keeps the first ~60 % and
    last ~40 % of the budget so that both the beginning context and the
    final state / conclusion are retained.
    """
    if not text or len(text) <= max_chars:
        return text

    separator = "\n\n[...compressed...]\n\n"
    sep_len = len(separator)

    if preserve_ends and max_chars > sep_len + 40:
        head_budget = int((max_chars - sep_len) * 0.6)
        tail_budget = max_chars - sep_len - head_budget
        head = _break_at_boundary(text, head_budget)
        tail = _break_at_boundary_reverse(text, tail_budget)
        return head + separator + tail

    return _break_at_boundary(text, max_chars - 3) + "..."


def _break_at_boundary(text: str, budget: int) -> str:
    """Return text[:~budget] breaking at the last newline or space."""
    if len(text) <= budget:
        return text
    chunk = text[:budget]
    nl = chunk.rfind("\n")
    if nl > budget * 0.5:
        return chunk[:nl]
    sp = chunk.rfind(" ")
    if sp > budget * 0.5:
        return chunk[:sp]
    return chunk


def _break_at_boundary_reverse(text: str, budget: int) -> str:
    """Return text[-budget:] breaking at the first newline or space."""
    if len(text) <= budget:
        return text
    chunk = text[-budget:]
    nl = chunk.find("\n")
    if 0 < nl < budget * 0.5:
        return chunk[nl + 1:]
    sp = chunk.find(" ")
    if 0 < sp < budget * 0.5:
        return chunk[sp + 1:]
    return chunk


__all__ = [
    "ContextChain",
    "ContextCompressorEngine",
    "ContextCompressionSignature",
    "ContextNode",
    "PTLRecoveryResult",
    "RunCompactionSummary",
    "PRIORITY_CAUSAL",
    "PRIORITY_CRITICAL",
    "PRIORITY_LOW",
    "PRIORITY_MEMORY",
    "PRIORITY_METADATA",
    "PRIORITY_TRAJECTORY",
    "compact_run",
    "microcompact",
    "recover_from_ptl",
    "recover_from_ptl_sync",
    "recover_from_ptl_string_fallback",
    "smart_fit",
    "smart_fit_sync",
]
