"""Vinv Engine / components / context_compressor / unified_chunker — Token-accurate chunking.

Features:
1. Token-accurate chunking via binary search (no heuristics)
2. Sliding window with configurable overlap
3. LLM-based relevance scoring (semantic, not keyword)
4. Budget-aware chunk selection
5. Query/goal-aware (not blind chunking)
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

try:
    import dspy
    DSPY_AVAILABLE = True
except ImportError:
    DSPY_AVAILABLE = False
    dspy = None

from core.components.context_compressor.token_utils import (
    count_tokens,
    fit_for_logging,
)

logger = logging.getLogger(__name__)


@dataclass
class ContentChunk:
    content: str
    chunk_index: int
    total_chunks: int
    source_key: str
    token_count: int
    start_char: int
    end_char: int
    has_overlap_before: bool = False
    has_overlap_after: bool = False
    relevance_score: float = 0.0


class SlidingWindowChunker:
    """Token-accurate chunking using binary search."""

    def __init__(
        self,
        chunk_size: int | None = None,
        overlap: int | None = None,
    ):
        self.chunk_size = chunk_size if chunk_size is not None else int(
            os.environ.get("VINV_ENGINE_CHUNK_SIZE", "16000"),
        )
        self.overlap = overlap if overlap is not None else int(
            os.environ.get("VINV_ENGINE_CHUNK_OVERLAP", "100"),
        )

    def chunk_content(self, content: str, source_key: str = "default") -> List[ContentChunk]:
        if not content:
            logger.debug("SlidingWindowChunker.chunk_content: empty content")
            return []

        total_tokens = count_tokens(content)
        if total_tokens <= self.chunk_size:
            logger.debug("SlidingWindowChunker.chunk_content: single chunk %d tokens", total_tokens)
            return [ContentChunk(
                content=content, chunk_index=0, total_chunks=1,
                source_key=source_key, token_count=total_tokens,
                start_char=0, end_char=len(content),
            )]

        logger.info("SlidingWindowChunker.chunk_content: chunking %d tokens into size=%d overlap=%d", total_tokens, self.chunk_size, self.overlap)
        chunks: List[ContentChunk] = []
        start = 0
        idx = 0

        while start < len(content):
            end = self._find_chunk_end(content, start, self.chunk_size)
            chunk_text = content[start:end]
            chunks.append(ContentChunk(
                content=chunk_text, chunk_index=idx, total_chunks=-1,
                source_key=source_key, token_count=count_tokens(chunk_text),
                start_char=start, end_char=end,
                has_overlap_before=start > 0, has_overlap_after=end < len(content),
            ))
            # If this chunk reached the end of content, we're done.
            if end >= len(content):
                break
            if self.overlap > 0:
                overlap_chars = self._chars_for_tokens(chunk_text, self.overlap)
                # Advance by at least (chunk_size - overlap) in chars to avoid
                # producing hundreds of tiny tail chunks that each advance by
                # only 1 character.
                min_advance = max(end - start - overlap_chars, 1)
                start = start + min_advance
            else:
                start = end
            idx += 1

        for c in chunks:
            c.total_chunks = len(chunks)
        logger.debug("SlidingWindowChunker.chunk_content: produced %d chunks", len(chunks))
        return chunks

    def _find_chunk_end(self, content: str, start: int, target_tokens: int) -> int:
        low, high, best = start + 1, len(content), start + 1
        while low <= high:
            mid = (low + high) // 2
            if count_tokens(content[start:mid]) <= target_tokens:
                best = mid
                low = mid + 1
            else:
                high = mid - 1
        return best

    def _chars_for_tokens(self, text: str, target_tokens: int) -> int:
        if target_tokens <= 0:
            return 0
        low, high, best = 0, len(text), 0
        while low <= high:
            mid = (low + high) // 2
            if count_tokens(text[-mid:] if mid > 0 else "") <= target_tokens:
                best = mid
                low = mid + 1
            else:
                high = mid - 1
        return best


# ---------------------------------------------------------------------------
# LLM relevance scorer
# ---------------------------------------------------------------------------

if DSPY_AVAILABLE and dspy is not None:
    class RelevanceSignature(dspy.Signature):
        """Score relevance of chunks to a query using semantic understanding."""
        query: str = dspy.InputField(desc="The current query/goal")
        chunk_batch: str = dspy.InputField(desc="Batch of chunks to score (JSON)")
        context_hints: str = dspy.InputField(desc="Additional context about the task")

        reasoning: str = dspy.OutputField(desc="Semantic analysis of each chunk's relevance")
        scores: str = dspy.OutputField(
            desc="JSON object mapping chunk_index integers to relevance floats (0.0-1.0)",
        )


def _extract_json_scores(raw: str) -> dict | None:
    """Try multiple strategies to extract a JSON dict from LLM output.

    All strategies use structural parsing (no regex).
    """
    if not raw or not raw.strip():
        return None
    text = raw.strip()

    # Strategy 1: direct parse
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except (json.JSONDecodeError, ValueError):
        pass

    # Strategy 2: strip markdown code fences (string-based, no regex)
    fence_marker = "```"
    fence_start = text.find(fence_marker)
    if fence_start != -1:
        after_fence = fence_start + len(fence_marker)
        newline_after = text.find("\n", after_fence)
        if newline_after != -1:
            content_start = newline_after + 1
        else:
            content_start = after_fence
        fence_end = text.find(fence_marker, content_start)
        if fence_end != -1:
            inner = text[content_start:fence_end].strip()
            try:
                obj = json.loads(inner)
                if isinstance(obj, dict):
                    return obj
            except (json.JSONDecodeError, ValueError):
                pass

    # Strategy 3: find first { ... } block
    brace_start = text.find("{")
    brace_end = text.rfind("}")
    if brace_start != -1 and brace_end > brace_start:
        try:
            obj = json.loads(text[brace_start:brace_end + 1])
            if isinstance(obj, dict):
                return obj
        except (json.JSONDecodeError, ValueError):
            pass

    # Strategy 4: character-level key:value extraction (no regex)
    result: dict = {}
    i = 0
    while i < len(text):
        if text[i] in ('"', "'") or text[i].isdigit():
            key, i = _parse_kv_key(text, i)
            if key is not None:
                val, i = _parse_kv_value(text, i)
                if val is not None:
                    result[key] = val
                    continue
        i += 1
    if result:
        return result

    return None


def _parse_kv_key(text: str, pos: int) -> tuple:
    """Parse a numeric key from text at pos. Returns (key_str, new_pos) or (None, pos)."""
    if pos >= len(text):
        return None, pos
    if text[pos] in ('"', "'"):
        quote = text[pos]
        end_q = text.find(quote, pos + 1)
        if end_q == -1:
            return None, pos
        key = text[pos + 1:end_q]
        if key.isdigit():
            npos = end_q + 1
            npos = _skip_whitespace(text, npos)
            if npos < len(text) and text[npos] in (":", "="):
                return key, npos + 1
        return None, pos
    if text[pos].isdigit():
        end = pos
        while end < len(text) and text[end].isdigit():
            end += 1
        key = text[pos:end]
        npos = _skip_whitespace(text, end)
        if npos < len(text) and text[npos] in (":", "="):
            return key, npos + 1
    return None, pos


def _parse_kv_value(text: str, pos: int) -> tuple:
    """Parse a numeric value from text at pos. Returns (value_str, new_pos) or (None, pos)."""
    pos = _skip_whitespace(text, pos)
    if pos >= len(text):
        return None, pos
    start = pos
    has_dot = False
    while pos < len(text) and (text[pos].isdigit() or (text[pos] == "." and not has_dot)):
        if text[pos] == ".":
            has_dot = True
        pos += 1
    if pos > start:
        return text[start:pos], pos
    return None, pos


def _skip_whitespace(text: str, pos: int) -> int:
    while pos < len(text) and text[pos] in (" ", "\t", "\n", "\r"):
        pos += 1
    return pos


class LLMRelevanceScorer:
    """Pure LLM semantic scoring for chunk relevance."""

    def __init__(self, window_size: int | None = None, use_cot: bool = True):
        self.window_size = window_size if window_size is not None else int(
            os.environ.get("VINV_ENGINE_SCORING_WINDOW_SIZE", "10"),
        )
        self._max_retries = int(os.environ.get("VINV_ENGINE_SCORING_MAX_RETRIES", "5"))
        self.scorer = None
        if DSPY_AVAILABLE and dspy is not None:
            self.scorer = (
                dspy.ChainOfThought(RelevanceSignature) if use_cot
                else dspy.Predict(RelevanceSignature)
            )

    def score_chunks(
        self, query: str, chunks: List[ContentChunk], context_hints: str = "",
    ) -> Dict[int, float]:
        scorer = self.scorer
        if scorer is None:
            raise RuntimeError(
                "LLMRelevanceScorer requires a working LLM scorer. "
                "Cannot fall back to heuristic scoring."
            )

        all_scores: Dict[int, float] = {}
        for i in range(0, len(chunks), self.window_size):
            batch = chunks[i:i + self.window_size]
            _preview_chars = int(os.environ.get(
                "VINV_ENGINE_RELEVANCE_PREVIEW_CHARS", "8000",
            ))
            batch_data = [
                {
                    "chunk_index": c.chunk_index,
                    "content_preview": c.content[:_preview_chars],
                    "token_count": c.token_count,
                    "position": f"{c.chunk_index + 1}/{c.total_chunks}",
                }
                for c in batch
            ]
            batch_scores = self._score_batch_with_retry(
                scorer, query, batch, batch_data, context_hints, batch_index=i
            )
            all_scores.update(batch_scores)

        return all_scores

    def _score_batch_with_retry(
        self,
        scorer: Any,
        query: str,
        batch: List[ContentChunk],
        batch_data: list,
        context_hints: str,
        batch_index: int,
    ) -> Dict[int, float]:
        last_error = None
        for attempt in range(self._max_retries):
            try:
                retry_hint = ""
                if last_error:
                    retry_hint = (
                        f" PREVIOUS ATTEMPT FAILED: {last_error}. "
                        f"Return ONLY a raw JSON object (no markdown, no code "
                        f"fences, no explanation) mapping chunk_index integers "
                        f"to relevance floats between 0.0 and 1.0."
                    )
                result = scorer(
                    query=query,
                    chunk_batch=json.dumps(batch_data, ensure_ascii=False),
                    context_hints=context_hints + retry_hint,
                )
                scores_raw = getattr(result, "scores", "{}")
                if not scores_raw:
                    last_error = "LLM returned empty scores"
                    continue

                scores = (
                    _extract_json_scores(str(scores_raw))
                    if isinstance(scores_raw, str)
                    else scores_raw if isinstance(scores_raw, dict) else None
                )
                if scores is None:
                    last_error = f"Could not extract JSON from: {str(scores_raw)}"
                    continue

                parsed = {}
                for k, v in scores.items():
                    try:
                        parsed[int(k)] = max(0.0, min(1.0, float(v)))
                    except (ValueError, TypeError):
                        pass
                if parsed:
                    return parsed
                last_error = "All score entries failed to parse"
            except Exception as e:
                last_error = f"{type(e).__name__}: {e}"

        logger.warning(
            "All %d scoring attempts failed for batch %d. Last error: %s. "
            "Returning neutral scores.",
            self._max_retries, batch_index, last_error,
        )
        return {c.chunk_index: 0.5 for c in batch}

    async def score_chunks_async(self, query, chunks, context_hints=""):
        return self.score_chunks(query, chunks, context_hints)


# ---------------------------------------------------------------------------
# Unified Chunker (coordinator)
# ---------------------------------------------------------------------------

class UnifiedChunker:
    """Unified chunker: token-accurate chunking + LLM-based selection."""

    def __init__(
        self,
        chunk_size: int = 16000,
        overlap: int = 100,
        scorer_window: int = 10,
        use_cot: bool = True,
    ):
        self.chunker = SlidingWindowChunker(chunk_size=chunk_size, overlap=overlap)
        self.scorer = LLMRelevanceScorer(window_size=scorer_window, use_cot=use_cot)

    def chunk_content(self, content: str, source_key: str = "default") -> List[ContentChunk]:
        return self.chunker.chunk_content(content, source_key)

    async def chunk_and_select(
        self,
        content: str,
        query: str,
        goal: Optional[str] = None,
        max_tokens: int = 10000,
        context_hints: str = "",
        source_key: str = "default",
        **kwargs,
    ) -> str:
        logger.debug("UnifiedChunker.chunk_and_select: query=%s max_tokens=%d", query[:50] if query else "", max_tokens)
        if max_tokens < 1:
            max_tokens = 1
        effective_chunk_size = min(self.chunker.chunk_size, max_tokens)
        if effective_chunk_size < self.chunker.chunk_size:
            chunker = SlidingWindowChunker(
                chunk_size=effective_chunk_size,
                overlap=self.chunker.overlap,
            )
            chunks = chunker.chunk_content(content, source_key)
        else:
            chunks = self.chunker.chunk_content(content, source_key)
        if not chunks:
            return ""

        total_tokens = sum(c.token_count for c in chunks)
        if total_tokens <= max_tokens:
            logger.debug("UnifiedChunker.chunk_and_select: within budget, returning full content")
            return content

        logger.info("UnifiedChunker.chunk_and_select: scoring %d chunks for relevance (total=%d tokens, budget=%d)", len(chunks), total_tokens, max_tokens)
        ctx = f"Query: {query}"
        if goal:
            ctx += f"\nGoal: {goal}"
        if context_hints:
            ctx += f"\n{context_hints}"

        scores = await self.scorer.score_chunks_async(query, chunks, ctx)
        for c in chunks:
            c.relevance_score = scores.get(c.chunk_index, 0.5)

        selected, tokens_used = [], 0
        for c in sorted(chunks, key=lambda x: x.relevance_score, reverse=True):
            if tokens_used + c.token_count <= max_tokens:
                selected.append(c)
                tokens_used += c.token_count

        if not selected:
            best = max(chunks, key=lambda x: x.relevance_score)
            selected = [best]
            logger.warning(
                "chunk_and_select: no chunk fit budget (%d tokens), "
                "returning highest-relevance chunk (%d tokens, score=%.2f)",
                max_tokens, best.token_count, best.relevance_score,
            )

        selected.sort(key=lambda x: x.chunk_index)
        concatenated = "\n\n".join(c.content for c in selected)

        while count_tokens(concatenated) > max_tokens and len(selected) > 1:
            lowest = min(selected, key=lambda x: x.relevance_score)
            selected.remove(lowest)
            concatenated = "\n\n".join(c.content for c in selected)

        return concatenated

    def chunk_and_select_sync(self, content, query, **kwargs) -> str:
        import asyncio
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        return loop.run_until_complete(
            self.chunk_and_select(content, query, **kwargs)
        )


__all__ = [
    "ContentChunk",
    "SlidingWindowChunker",
    "LLMRelevanceScorer",
    "UnifiedChunker",
]
