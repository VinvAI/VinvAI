"""Vinv Engine / components / context_compressor / content_ingestion — Content ingestion pipeline.

The SINGLE coordinator for compression decisions:
1. If content <= max_tokens → pass through (no processing)
2. Skip tiny compressions: if content and target are both a small fraction of
   model context (default 1% / 2%), pass through to avoid blocking on pointless
   LLM calls (e.g. 296→250 with 200k context). See VINV_ENGINE_SKIP_TINY_COMPRESS_*.
3. Otherwise → compress via UnifiedCompressor (AIOC handles any input size,
   including multi-chunk split-compress-concat for large inputs)
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

try:
    import dspy
    DSPY_AVAILABLE = True
except ImportError:
    DSPY_AVAILABLE = False

from core.components.context_compressor.token_utils import (
    count_tokens,
    fit_for_logging,
)
from core.components.context_compressor.model_context_registry import (
    get_model_context_registry,
)
from core.components.context_compressor.unified_compression import (
    InfeasibleCompressionError,
)

logger = logging.getLogger(__name__)

try:
    from core.components.common.thinking import ThinkingTracer
    _THINKING_AVAILABLE = True
except ImportError:
    _THINKING_AVAILABLE = False


def _emit_compress_trace(event: str, **fields) -> None:
    """Emit a thinking-trace entry so compression activity is visible in the UI."""
    if not _THINKING_AVAILABLE:
        return
    try:
        tracer = ThinkingTracer(actor="UnifiedCompressor", phase="compression")
        tracer._emit(event, **fields)
    except Exception:
        pass

MAX_RECURSION_DEPTH = int(
    __import__("os").environ.get("VINV_ENGINE_INGEST_MAX_DEPTH", "5")
)

# ── Fingerprint-based compression dedup cache ──────────────────────────
# Prevents re-compressing the same content when multiple consumers
# (upstream collection, record_completion, context guard) compress
# identical content.  Keyed on (content_hash, max_tokens_bucket).
# The max_tokens is bucketed (rounded to nearest 1000) so that
# slightly different target sizes share the cache entry.
import hashlib as _hashlib
import time as _time
from collections import OrderedDict as _OrderedDict

_COMPRESS_DEDUP_CACHE: _OrderedDict[tuple[str, int], tuple[float, str]] = _OrderedDict()
_COMPRESS_DEDUP_MAX = int(
    __import__("os").environ.get("VINV_ENGINE_COMPRESS_DEDUP_CACHE_SIZE", "64")
)
_COMPRESS_DEDUP_TTL = float(
    __import__("os").environ.get("VINV_ENGINE_COMPRESS_DEDUP_TTL", "300")  # 5 minutes
)


def _dedup_cache_key(content: str, max_tokens: int) -> tuple[str, int]:
    """Create a cache key from content fingerprint + bucketed target."""
    # Use first 1K + last 1K + length for fast fingerprint
    _sample = content[:1024] + content[-1024:] + str(len(content))
    _hash = _hashlib.sha256(_sample.encode("utf-8", errors="replace")).hexdigest()[:16]
    _bucket = max(1, (max_tokens // 1000) * 1000)  # round to nearest 1000
    return (_hash, _bucket)


def _dedup_cache_get(key: tuple[str, int]) -> str | None:
    """Return cached compressed content if still valid."""
    entry = _COMPRESS_DEDUP_CACHE.get(key)
    if entry is None:
        return None
    ts, cached_content = entry
    if _time.monotonic() - ts > _COMPRESS_DEDUP_TTL:
        _COMPRESS_DEDUP_CACHE.pop(key, None)
        return None
    # Move to end (LRU)
    _COMPRESS_DEDUP_CACHE.move_to_end(key)
    return cached_content


def _dedup_cache_put(key: tuple[str, int], compressed: str) -> None:
    """Store compressed result in the dedup cache."""
    _COMPRESS_DEDUP_CACHE[key] = (_time.monotonic(), compressed)
    _COMPRESS_DEDUP_CACHE.move_to_end(key)
    # Evict oldest if over capacity
    while len(_COMPRESS_DEDUP_CACHE) > _COMPRESS_DEDUP_MAX:
        _COMPRESS_DEDUP_CACHE.popitem(last=False)

COMPRESSION_SENTINEL = "<!-- VINV_ENGINE_COMPRESSED -->"


def content_already_compressed(text: str) -> bool:
    """Check if content has already been LLM-compressed."""
    if not text:
        return False
    return COMPRESSION_SENTINEL in text


def tag_as_compressed(text: str) -> str:
    """Add compression provenance tag if not already present."""
    if not text or content_already_compressed(text):
        return text
    return COMPRESSION_SENTINEL + "\n" + text


@dataclass
class IngestionResult:
    content: str
    original_tokens: int
    final_tokens: int
    processing_path: str
    chunks_used: int = 0
    chunks_total: int = 0
    compression_ratio: float = 1.0
    metadata: Dict[str, Any] = field(default_factory=dict)


class ContentIngestionPipeline:
    """Generic content ingestion coordinator."""

    def __init__(self):
        self._chunker = None
        self._compressor = None
        self._registry = get_model_context_registry()
        self.safety_margin = int(
            __import__("os").environ.get("VINV_ENGINE_INGEST_SAFETY_MARGIN", "2000")
        )

    @property
    def model_context_window(self) -> int:
        # Learned-from-traffic limits (from actual provider rejections) take
        # precedence over catalog/env figures — the provider's error message
        # is the only ground truth for its enforced input ceiling.
        limit = self._registry.effective_input_limit()
        if limit is not None:
            return limit
        return int(__import__("os").environ.get("VINV_ENGINE_MODEL_FALLBACK_LIMIT", "200000"))

    @property
    def chunker(self):
        if self._chunker is None:
            from core.components.context_compressor.unified_chunker import UnifiedChunker
            self._chunker = UnifiedChunker()
        return self._chunker

    @property
    def compressor(self):
        if self._compressor is None:
            from core.components.context_compressor.unified_compression import UnifiedCompressor
            self._compressor = UnifiedCompressor()
        return self._compressor

    async def process(
        self,
        content: str,
        max_tokens: int,
        query: Optional[str] = None,
        goal: Optional[str] = None,
        context_type: str = "general",
        _recursion_depth: int = 0,
        pending_tasks: Optional[list] = None,
        model_id: Optional[str] = None,
        cancel_event=None,
        **kwargs,
    ) -> IngestionResult:
        if not content:
            logger.debug("ContentIngestionPipeline.process: empty content")
            return IngestionResult("", 0, 0, "empty")

        _content_chars = len(content)
        _emit_compress_trace(
            "thinking",
            content=f"Compressing context: {_content_chars} chars → target {max_tokens} tokens (type={context_type})",
        )

        if _recursion_depth == 0 and content_already_compressed(content):
            current_tokens = count_tokens(content)
            if current_tokens <= max_tokens:
                return IngestionResult(
                    content, current_tokens, current_tokens,
                    "already_compressed_passthrough",
                )
            logger.info(
                "Content already compressed but still exceeds budget "
                "(%d > %d tokens). Proceeding with re-compression.",
                current_tokens, max_tokens,
            )

        if _recursion_depth >= MAX_RECURSION_DEPTH:
            # AIOC is advisory — return content as-is at max depth.
            logger.warning(
                "ContentIngestionPipeline: max recursion depth (%d) reached, "
                "returning content as-is (%d tokens, target %d)",
                _recursion_depth, count_tokens(content), max_tokens,
            )
            return IngestionResult(
                content, count_tokens(content), count_tokens(content),
                "max_depth_passthrough",
            )

        # Decision 0: microcompact (zero-cost local dedup) before token counting.
        # Removes consecutive duplicate blocks, stale trajectory steps, and
        # repeated tool calls.  Can shave 10-30% off large contexts for free,
        # potentially avoiding an expensive AIOC call entirely.
        try:
            from core.components.context_compressor.microcompact import microcompact
            _pre_len = len(content)
            content = microcompact(content)
            _post_len = len(content)
            if _post_len < _pre_len:
                logger.info(
                    "ContentIngestionPipeline: microcompact saved %d chars (%.1f%%)",
                    _pre_len - _post_len, (1 - _post_len / _pre_len) * 100,
                )
        except Exception:
            pass  # microcompact is best-effort

        current_tokens = count_tokens(content)

        # Decision 1: pass-through
        if current_tokens <= max_tokens:
            logger.debug("ContentIngestionPipeline.process: passthrough %d tokens (<= %d)", current_tokens, max_tokens)
            return IngestionResult(content, current_tokens, current_tokens, "passthrough")

        # Decision 1b: skip marginal compressions — avoid expensive LLM calls
        # for small overages.  A 28k→25k compression (11% reduction) takes
        # 250s and wastes more time than the token savings justify.
        model_limit = self.model_context_window
        _skip_marginal_pct = float(
            __import__("os").environ.get("VINV_ENGINE_SKIP_MARGINAL_COMPRESS_PCT", "0.35")
        )
        overshoot_ratio = (current_tokens - max_tokens) / max(max_tokens, 1)
        if 0 < overshoot_ratio <= _skip_marginal_pct:
            logger.info(
                "ContentIngestionPipeline.process: skip marginal compression "
                "(current=%d, target=%d, overshoot=%.1f%%, threshold=%.0f%%, context_type=%s)",
                current_tokens, max_tokens, overshoot_ratio * 100,
                _skip_marginal_pct * 100, context_type,
            )
            return IngestionResult(content, current_tokens, current_tokens, "skip_marginal_compression")

        skip_pct_content = float(__import__("os").environ.get("VINV_ENGINE_SKIP_TINY_COMPRESS_PCT_CONTENT", "0.01"))
        skip_pct_target = float(__import__("os").environ.get("VINV_ENGINE_SKIP_TINY_COMPRESS_PCT_TARGET", "0.02"))
        if model_limit and model_limit > 0:
            if current_tokens < model_limit * skip_pct_content and max_tokens < model_limit * skip_pct_target:
                logger.info(
                    "ContentIngestionPipeline.process: skip tiny compression (current_tokens=%d, max_tokens=%d, model_limit=%d, context_type=%s)",
                    current_tokens, max_tokens, model_limit, context_type,
                )
                return IngestionResult(content, current_tokens, current_tokens, "skip_tiny_compression")

        # Decision 2a: dedup cache check — avoid re-compressing identical content
        _cache_key = _dedup_cache_key(content, max_tokens)
        _cached = _dedup_cache_get(_cache_key)
        if _cached is not None:
            _cached_tokens = count_tokens(_cached)
            logger.info(
                "ContentIngestionPipeline.process: dedup cache HIT "
                "(current=%d, cached=%d tokens, context_type=%s)",
                current_tokens, _cached_tokens, context_type,
            )
            _emit_compress_trace(
                "action",
                action="dedup_cache_hit",
                content=f"Dedup cache hit: {current_tokens} → {_cached_tokens} tokens (saved LLM call)",
            )
            return IngestionResult(
                _cached, current_tokens, _cached_tokens, "dedup_cache_hit",
                compression_ratio=round(_cached_tokens / current_tokens, 2) if current_tokens else 1.0,
            )

        # Decision 2b: compress via AIOC (handles any input size internally)
        logger.info(
            "ContentIngestionPipeline.process: compressing current_tokens=%d max_tokens=%d model_limit=%s context_type=%s",
            current_tokens, max_tokens, model_limit or 0, context_type,
        )
        try:
            compressed = await self.compressor.compress(
                content=content,
                max_tokens=max_tokens,
                task_description=query or "Process content",
                goal=goal,
                pending_tasks=pending_tasks,
                purpose=f"ingestion_{context_type}",
                context_limit=self.model_context_window,
                model_id=model_id,
                cancel_event=cancel_event,
                _from_pipeline=True,
                **kwargs,
            )
            compressed = tag_as_compressed(compressed)
            final = count_tokens(compressed)
            # Store in dedup cache for future consumers of the same content
            _dedup_cache_put(_cache_key, compressed)
            logger.debug("ContentIngestionPipeline.process: compression complete %d -> %d tokens", current_tokens, final)
            _ratio = round(final / current_tokens, 2) if current_tokens else 1.0
            _emit_compress_trace(
                "action",
                action="compression_complete",
                content=f"Compression done: {current_tokens} → {final} tokens (ratio={_ratio})",
            )
            return IngestionResult(
                compressed, current_tokens, final, "compress",
                compression_ratio=_ratio,
            )
        except InfeasibleCompressionError:
            # AIOC is advisory — return original content.
            logger.warning(
                "ContentIngestionPipeline: compression infeasible, returning "
                "original content (%d tokens, target %d, type=%s)",
                current_tokens, max_tokens, context_type,
            )
            return IngestionResult(
                content, current_tokens, current_tokens,
                "infeasible_passthrough",
            )
        except Exception as e:
            logger.error(
                "ContentIngestionPipeline.process: compression failed current_tokens=%d max_tokens=%d context_type=%s error=%s",
                current_tokens, max_tokens, context_type, e,
            )
            # AIOC is advisory — return original content on failure.
            # The target is a SOFT LIMIT.  The caller must accept
            # over-budget results rather than retrying in a loop.
            return IngestionResult(
                content, current_tokens, current_tokens,
                "error_passthrough",
                compression_ratio=1.0,
            )

    def process_sync(self, content, max_tokens, **kwargs) -> IngestionResult:
        """Synchronous wrapper. Prefer ``process()`` in async contexts."""
        import concurrent.futures
        logger.debug("ContentIngestionPipeline.process_sync: max_tokens=%d", max_tokens)

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop is None:
            return asyncio.run(self.process(content, max_tokens, **kwargs))

        # Run in a NEW thread with its own event loop to avoid deadlocking
        # the caller's event loop.  No timeout — the dspy.LM per-call
        # timeout handles stuck LLM calls.  Adding a sync timeout here
        # just kills valid compression work.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(
                asyncio.run, self.process(content, max_tokens, **kwargs)
            )
            return future.result()


__all__ = [
    "IngestionResult",
    "ContentIngestionPipeline",
    "COMPRESSION_SENTINEL",
    "content_already_compressed",
    "tag_as_compressed",
]
