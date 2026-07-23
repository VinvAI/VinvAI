"""Vinv Engine / components / context_compressor / unified_compression — LLM-powered compression.

ONE compressor for ALL Vinv Engine compression needs:
1. Goal + pending-task-aware compression — LLM decides what to keep
2. Reference extraction — paths, URLs, IDs extracted BEFORE compression
3. Parallel chunk compression — asyncio.gather for N chunks simultaneously
4. Line-boundary splitting — never splits mid-line
5. Capacity-fraction chunk sizing: chunk = K × fill / inflation, where K and
   inflation are LEARNED from provider overflow errors (recalibrating map/reduce)
6. Adaptive model-limit learning via ModelContextRegistry
7. Shapley credit support — prioritizes high-impact items
8. LRU caching — performance optimization
9. ZERO TRUNCATION — content is compressed or InfeasibleCompressionError raised
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import math
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

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
from core.components.context_compressor.model_context_registry import (
    get_model_context_registry,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Provider-agnostic context-overflow detection and recalibration signals
# ---------------------------------------------------------------------------
#
# ZERO TRUNCATION: when a provider rejects a request for context length, we
# do NOT slice content. We parse the provider's own numbers out of the error
# (its real input limit and its real token count for our request), teach the
# ModelContextRegistry, re-split the SAME content into smaller chunks sized
# from the learned capacity, and retry. All information is preserved — only
# chunk boundaries change.

_OVERFLOW_MESSAGE_PATTERNS = (
    "context_length_exceeded",
    "context length",
    "maximum context length",
    "context window",
    "context_window",
    "prompt is too long",
    "input is too long",
    "too many tokens",
    "token limit exceeded",
    "exceed the configured limit",
    "exceeds the maximum",
    "reduce the length",
)

_NUMBER_RE = re.compile(r"\d[\d,]*")

# The way providers phrase their two ground-truth numbers is remarkably
# uniform ("maximum … N", "limit of N", "N maximum" for the ceiling; "resulted
# in N", "too long: N", "requested N" for the rejected request's count). These
# anchors are linguistic, not provider-specific — any provider matching them
# is parsed; any provider matching none still triggers the multiplicative
# capacity shrink, so progress never depends on parsing succeeding.
_LIMIT_HINT_RES = (
    re.compile(r"maximum context length is\s+(\d[\d,]*)"),
    re.compile(r"limit(?:\s+of)?[:= ]+(\d[\d,]*)"),
    re.compile(r">\s*(\d[\d,]*)\s+maximum"),
    re.compile(r"(\d[\d,]*)\s+(?:token[s]?\s+)?maximum"),
    re.compile(r"maximum(?:\s+of)?[:= ]+(\d[\d,]*)"),
    re.compile(r"max(?:imum)?(?:\s+input)?\s+tokens?[:= ]+(\d[\d,]*)"),
)
_COUNT_HINT_RES = (
    re.compile(r"resulted in\s+(\d[\d,]*)"),
    re.compile(r"too long[:,]?\s+(\d[\d,]*)"),
    re.compile(r"requested\s+(\d[\d,]*)"),
    re.compile(r"your (?:messages|input|prompt)[^0-9]{0,40}?(\d[\d,]*)"),
    re.compile(r"(?:received|counted|got)\s+(\d[\d,]*)"),
)


def _collect_error_text(error: Exception) -> str:
    """Flatten an exception chain into one lowercase message string."""
    parts: List[str] = []
    exc: Optional[BaseException] = error
    for _ in range(5):
        if exc is None:
            break
        parts.append(getattr(exc, "message", None) or str(exc) or "")
        exc = exc.__cause__ or exc.__context__
    return " ".join(parts).lower()


def _first_number(msg: str, patterns) -> Optional[int]:
    for pat in patterns:
        m = pat.search(msg)
        if m:
            try:
                value = int(m.group(1).replace(",", ""))
                if value >= 1024:
                    return value
            except (ValueError, IndexError):
                continue
    return None


def _is_context_overflow(error: Exception) -> bool:
    """True when *error* is a context-length rejection from ANY provider.

    Checks litellm's typed exception when available, then falls back to
    message patterns so raw provider HTTP errors (OpenAI, Anthropic, Bedrock,
    self-hosted gateways, …) are recognized equally.
    """
    try:
        from litellm import ContextWindowExceededError
        if isinstance(error, ContextWindowExceededError):
            return True
    except ImportError:
        pass
    msg = _collect_error_text(error)
    return any(p in msg for p in _OVERFLOW_MESSAGE_PATTERNS)


def _parse_overflow_numbers(error: Exception) -> Tuple[Optional[int], Optional[int]]:
    """Extract ``(reported_tokens, provider_limit)`` from an overflow error.

    Provider messages state both numbers in prose (e.g. "This model's maximum
    context length is 272000 tokens. However, your messages resulted in
    277851 tokens", or "prompt is too long: 210000 tokens > 200000 maximum").
    Linguistic anchors are tried first; if they don't match, we fall back to
    ordering: the rejected request's count is by definition greater than the
    enforced limit, so of all plausible integers in the message the smallest
    is the limit and the largest is the count.
    """
    msg = _collect_error_text(error)

    limit = _first_number(msg, _LIMIT_HINT_RES)
    count = _first_number(msg, _COUNT_HINT_RES)
    if limit is not None or count is not None:
        # Sanity: a "count" at or below the limit isn't the rejected request.
        if count is not None and limit is not None and count <= limit:
            count = None
        return count, limit

    numbers = sorted(
        {int(m.replace(",", "")) for m in _NUMBER_RE.findall(msg)
         if int(m.replace(",", "")) >= 1024}
    )
    if not numbers:
        return None, None
    if len(numbers) == 1:
        return None, numbers[0]
    return numbers[-1], numbers[0]


class _ContextOverflow(RuntimeError):
    """Internal signal: one map/reduce request exceeded the provider's context.

    Carries the provider's ground-truth numbers plus our local estimate of the
    content we sent, so the planner can learn the true capacity and the
    inflation between local token estimates and provider token counts.
    """

    def __init__(
        self,
        estimated_tokens: int,
        reported_tokens: Optional[int],
        reported_limit: Optional[int],
        original: Exception,
    ):
        self.estimated_tokens = estimated_tokens
        self.reported_tokens = reported_tokens
        self.reported_limit = reported_limit
        self.original = original
        super().__init__(
            f"context overflow: sent≈{estimated_tokens} local tokens, provider "
            f"counted {reported_tokens}, limit {reported_limit}"
        )


# ---------------------------------------------------------------------------
# Structured Result + Error
# ---------------------------------------------------------------------------

@dataclass
class CompressionResult:
    """Structured output from every compression call.

    Callers can verify the output fits their budget without re-counting.
    """
    content: str
    input_tokens: int
    output_tokens: int
    target_tokens: int
    achieved_ratio: float
    processing_path: str
    chunks_used: int = 1
    model_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def fits_budget(self) -> bool:
        return self.output_tokens <= self.target_tokens


class InfeasibleCompressionError(RuntimeError):
    """Raised when compression cannot meet the target budget.

    The orchestrator should decompose the task into sub-tasks.
    Content is NEVER truncated — this error is the alternative.
    """

    def __init__(
        self,
        input_tokens: int,
        target_tokens: int,
        achieved_tokens: Optional[int] = None,
        min_achievable: Optional[int] = None,
        recommendation: str = "decompose task into sub-tasks",
        details: str = "",
    ):
        self.input_tokens = input_tokens
        self.target_tokens = target_tokens
        self.achieved_tokens = achieved_tokens
        self.min_achievable = min_achievable
        self.recommendation = recommendation
        msg = (
            f"InfeasibleCompression: cannot compress {input_tokens} tokens "
            f"to target {target_tokens}."
        )
        if achieved_tokens is not None:
            msg += f" Best achieved: {achieved_tokens}."
        if min_achievable is not None:
            msg += f" Estimated minimum: {min_achievable}."
        msg += f" Recommendation: {recommendation}."
        if details:
            msg += f" {details}"
        super().__init__(msg)


# ---------------------------------------------------------------------------
# DSPy Signatures
# ---------------------------------------------------------------------------

if DSPY_AVAILABLE:

    class ReferenceExtractionSignature(dspy.Signature):
        """Extract structured references from content BEFORE compression.

        Identify all file paths, URLs, task/dependency IDs, error messages,
        and critical data values that must survive compression intact.
        These will be preserved separately and re-attached after compression.
        """
        content = dspy.InputField(desc="Raw content to scan for references")
        goal = dspy.InputField(desc="Pipeline goal for relevance context")

        file_paths = dspy.OutputField(
            desc="JSON list of all file paths found (absolute and relative). "
                 "Include paths from tool outputs, saved files, generated artifacts."
        )
        urls = dspy.OutputField(
            desc="JSON list of all URLs found (http/https links, API endpoints)"
        )
        task_refs = dspy.OutputField(
            desc="JSON list of task/dependency IDs (e.g. task_1, task_1_sub0_a662b2)"
        )
        error_messages = dspy.OutputField(
            desc="JSON list of error messages, stack traces, or failure descriptions"
        )
        critical_data = dspy.OutputField(
            desc="JSON list of critical data values that must survive: "
                 "names, numbers, dates, structured results, tool output values"
        )

    class GoalAwareCompressionSignature(dspy.Signature):
        """Compress content for consumption by downstream tasks.

        Compression preserves data integrity while reducing redundancy.
        The LLM reasons about what to keep based on the goal and
        pending tasks — the strategy emerges from context, not rules.

        Protected references (paths, URLs, IDs) have been extracted
        separately and will be re-attached after compression.
        """
        content = dspy.InputField(desc="Content to compress")
        max_tokens = dspy.InputField(desc="Maximum token budget for compressed output")
        min_retention_pct = dspy.InputField(
            desc="Minimum percentage of original content length to retain in output"
        )
        goal = dspy.InputField(desc="Overall pipeline goal")
        pending_tasks = dspy.InputField(
            desc="JSON list of pending downstream tasks that will consume this output"
        )
        protected_references = dspy.InputField(
            desc="References already extracted and preserved separately"
        )
        high_impact_items = dspy.InputField(
            desc="Items with high Shapley credit scores (higher priority for retention)"
        )
        low_impact_items = dspy.InputField(
            desc="Items with low Shapley credit scores (lower priority for retention)"
        )

        compression_strategy = dspy.OutputField(
            desc="Reasoning about what to keep and remove, "
                 "justified by downstream task requirements"
        )
        compressed = dspy.OutputField(
            desc="Compressed content within the max_tokens budget"
        )
        what_was_removed = dspy.OutputField(
            desc="What was removed and why (for observability)"
        )

    class UnifiedCompressionSignature(dspy.Signature):
        """Compress content while preserving maximum information density.

        Compression reduces content size by removing redundancy while
        retaining all unique information. The strategy should be determined
        by reasoning about the content structure and the task context.
        """
        content = dspy.InputField(desc="Full content to compress")
        max_tokens = dspy.InputField(desc="Maximum tokens allowed in compressed output")
        min_retention_pct = dspy.InputField(
            desc="Minimum percentage of original content length to retain",
        )
        task_description = dspy.InputField(
            desc="What the agent needs to do with this content",
        )
        priority_keywords = dspy.InputField(
            desc="Keywords or concepts with high retention priority (comma-separated)",
        )
        high_impact_items = dspy.InputField(
            desc="Items with high Shapley credit scores (higher retention priority)",
        )
        low_impact_items = dspy.InputField(
            desc="Items with low Shapley credit scores (lower retention priority)",
        )
        purpose = dspy.InputField(
            desc="Compression context (e.g. for_validation, for_memory, for_retrieval)",
        )
        goal = dspy.InputField(desc="Overall system goal for relevance context")
        must_preserve = dspy.InputField(
            desc="Comma-separated list of information types that must not be removed",
        )

        compressed = dspy.OutputField(
            desc="Compressed content within the max_tokens budget",
        )
        compression_ratio = dspy.OutputField(
            desc="Fraction of original content retained (0.0 to 1.0)",
        )
        what_was_removed = dspy.OutputField(
            desc="Brief description of what was removed (for observability)",
        )

    class CrossChunkSynthesisSignature(dspy.Signature):
        """Synthesize independently compressed chunks into a coherent whole.

        You receive N chunks that were compressed independently from a larger
        document. Each chunk was compressed without visibility into the others,
        so cross-chunk relationships may be fragmented.

        Your task is to produce a single unified output that:
        1. Identifies entities, concepts, and references spanning multiple chunks
        2. Resolves dangling references where one chunk mentions something
           defined or elaborated in another
        3. Deduplicates information repeated across chunks
        4. Preserves all unique factual content within the token budget
        """
        compressed_chunks = dspy.InputField(
            desc="JSON array of independently compressed chunks in original order"
        )
        max_tokens = dspy.InputField(desc="Token budget for the unified output")
        goal = dspy.InputField(desc="The task goal for relevance context")

        cross_chunk_entities = dspy.OutputField(
            desc="Entities, concepts, and references that span multiple chunks"
        )
        synthesized = dspy.OutputField(
            desc="Unified coherent output within the token budget"
        )


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

@dataclass
class CompressionStats:
    total_compressions: int = 0
    total_time: float = 0.0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    chunked_compressions: int = 0

    @property
    def avg_time(self) -> float:
        return self.total_time / max(self.total_compressions, 1)

    @property
    def avg_compression_ratio(self) -> float:
        if self.total_input_tokens == 0:
            return 0.0
        return self.total_output_tokens / self.total_input_tokens

    @property
    def cache_hit_rate(self) -> float:
        total = self.cache_hits + self.cache_misses
        return self.cache_hits / total if total else 0.0


# ---------------------------------------------------------------------------
# Reference Extractor
# ---------------------------------------------------------------------------

class ReferenceExtractor:
    """LLM-based extraction of structured references before compression.

    Extracts file paths, URLs, task IDs, error messages, and critical data
    values into a protected set that bypasses compression entirely.
    """

    def __init__(self) -> None:
        self._extractor = (
            dspy.ChainOfThought(ReferenceExtractionSignature)
            if DSPY_AVAILABLE else None
        )

    # ── Regex patterns for zero-cost extraction (no LLM needed) ──
    _FILE_PATH_RE = re.compile(
        r'(?:^|[\s"\'`(,=:])(/(?:[\w._-]+/)+[\w._-]+(?:\.\w+)?)'  # absolute paths
        r'|(?:^|[\s"\'`(,=:])(\.{1,2}/(?:[\w._-]+/)*[\w._-]+(?:\.\w+)?)',  # relative paths
        re.MULTILINE,
    )
    _URL_RE = re.compile(
        r'https?://[^\s<>"\'`)\]},;]+',
    )
    _ERROR_RE = re.compile(
        r'(?:Error|Exception|Traceback|FAILED|FATAL)[:\s].*',
        re.IGNORECASE,
    )
    _TASK_REF_RE = re.compile(
        r'\btask_\d+\b',
        re.IGNORECASE,
    )

    def extract(self, content: str, goal: str = "") -> Dict[str, List[str]]:
        """Extract references using regex — zero LLM cost.

        The old approach sent the FULL content (100K+ tokens) through an
        LLM call just to find file paths and URLs, costing ~44s per call.
        File paths, URLs, task refs, and error messages have rigid patterns
        that regex matches perfectly.  No LLM needed.
        """
        refs: Dict[str, List[str]] = {}

        # File paths — deduplicated, max 30
        paths = set()
        for m in self._FILE_PATH_RE.finditer(content):
            p = m.group(1) or m.group(2)
            if p:
                paths.add(p)
        refs["file_paths"] = sorted(paths)[:30]

        # URLs — deduplicated, max 20
        urls = set(m.group(0).rstrip('.,;:)') for m in self._URL_RE.finditer(content))
        refs["urls"] = sorted(urls)[:20]

        # Task references
        task_refs = sorted(set(m.group(0) for m in self._TASK_REF_RE.finditer(content)))
        refs["task_refs"] = task_refs[:20]

        # Error messages — first 10 unique, truncated
        errors = []
        seen = set()
        for m in self._ERROR_RE.finditer(content):
            msg = m.group(0)[:200]
            if msg not in seen:
                seen.add(msg)
                errors.append(msg)
                if len(errors) >= 10:
                    break
        refs["error_messages"] = errors

        refs["critical_data"] = []
        return refs

    async def extract_async(self, content: str, goal: str = "") -> Dict[str, List[str]]:
        # Regex extraction is fast enough to run inline (no thread needed)
        return self.extract(content, goal)

    def format_header(self, refs: Dict[str, List[str]]) -> str:
        """Format extracted references as a preserved header block."""
        parts: List[str] = []
        if refs.get("file_paths"):
            parts.append("**Files:** " + ", ".join(refs["file_paths"]))
        if refs.get("urls"):
            parts.append("**URLs:** " + ", ".join(refs["urls"]))
        if refs.get("task_refs"):
            parts.append("**Task refs:** " + ", ".join(refs["task_refs"]))
        if refs.get("error_messages"):
            parts.append("**Errors:** " + "; ".join(refs["error_messages"]))
        if refs.get("critical_data"):
            parts.append("**Data:** " + "; ".join(refs["critical_data"]))
        if not parts:
            return ""
        return "## PRESERVED REFERENCES\n" + "\n".join(parts) + "\n"

    @staticmethod
    def _parse_result(result: Any) -> Dict[str, List[str]]:
        import json as _json
        refs: Dict[str, List[str]] = {}
        for field_name in ("file_paths", "urls", "task_refs", "error_messages", "critical_data"):
            raw = getattr(result, field_name, "[]")
            try:
                parsed = _json.loads(str(raw)) if raw else []
                refs[field_name] = [str(v) for v in parsed] if isinstance(parsed, list) else []
            except (_json.JSONDecodeError, TypeError):
                refs[field_name] = []
        return refs

    @staticmethod
    def _empty_refs() -> Dict[str, List[str]]:
        return {
            "file_paths": [], "urls": [], "task_refs": [],
            "error_messages": [], "critical_data": [],
        }


# ---------------------------------------------------------------------------
# Unified Compressor
# ---------------------------------------------------------------------------

class UnifiedCompressor:
    """ONE compressor for all Vinv Engine compression needs.

    Architecture:
    1. Extract references (paths, URLs, IDs) into protected set
    2. Goal+todo-conditioned LLM compression of body
    3. AIOC formula: N = ceil((S + T) / (C - H)) for optimal chunking
    4. Parallel chunk compression via asyncio.gather
    5. Line-boundary splitting (never mid-line)
    6. Adaptive model-limit learning via ModelContextRegistry
    7. ZERO TRUNCATION — compress or raise InfeasibleCompressionError
    """

    def __init__(
        self,
        lm: Optional[Any] = None,
        enable_caching: bool = True,
        cache_size: int = 128,
        min_retention_ratio: float = 0.01,
    ):
        self.lm = lm
        self.enable_caching = enable_caching
        self.cache_size = cache_size
        self.min_retention_ratio = max(0.01, min(1.0, float(min_retention_ratio)))
        self.stats = CompressionStats()
        self._ref_extractor = ReferenceExtractor()
        self._registry = get_model_context_registry()

        if lm is None and DSPY_AVAILABLE:
            if hasattr(dspy.settings, "lm") and dspy.settings.lm:
                self.lm = dspy.settings.lm

        self._goal_compressor = None
        self._legacy_compressor = None
        self._synthesizer = None
        if DSPY_AVAILABLE:
            self._goal_compressor = dspy.ChainOfThought(GoalAwareCompressionSignature)
            self._legacy_compressor = dspy.ChainOfThought(UnifiedCompressionSignature)
            self._synthesizer = dspy.ChainOfThought(CrossChunkSynthesisSignature)

        self._cache: Dict[Tuple[int, int, int], str] = {}
        self._cache_order: List[Tuple[int, int, int]] = []

    @property
    def compressor(self):
        return self._legacy_compressor

    # ----- async compress -----

    async def compress(
        self,
        content: str,
        max_tokens: int,
        task_description: Optional[str] = None,
        priority_keywords: Optional[List[str]] = None,
        shapley_credits: Optional[Dict[str, float]] = None,
        purpose: Optional[str] = None,
        goal: Optional[str] = None,
        pending_tasks: Optional[List[Dict[str, str]]] = None,
        model_id: Optional[str] = None,
        overhead_tokens: int = 0,
        context_limit: Optional[int] = None,
        cancel_event: Optional[asyncio.Event] = None,
        **kwargs,
    ) -> str:
        """Compress content using AIOC (Adaptive Information-Optimal Compression).

        Algorithm:
        1. Passthrough if already within budget
        2. Resolve K (real input ceiling): learned-from-traffic → catalog →
           caller → env fallback
        3. chunk_capacity = K × fill / inflation (fill defaults to 0.25;
           inflation is learned from provider overflow errors)
        4. If S ≤ chunk_capacity: single-pass; else recalibrating map/reduce —
           any provider overflow teaches the registry the real numbers and the
           SAME content is re-split into smaller chunks (zero truncation)
        """
        start_time = time.time()
        S = count_tokens(content)

        # Best-known provider input ceiling. Learned-from-traffic limits (from
        # actual provider rejections) take precedence over static catalog /
        # caller / env values, because the provider's own error message is the
        # only ground truth.
        _model_window = (
            self._registry.effective_input_limit(model_id)
            or (context_limit if context_limit and context_limit > 0 else None)
            or int(os.environ.get("VINV_ENGINE_COMPRESSION_CONTEXT_LIMIT", "0")) or None
            or int(os.environ.get("VINV_ENGINE_MODEL_FALLBACK_LIMIT", "200000"))
        )

        # 1. Passthrough
        if S <= max_tokens:
            logger.debug("UnifiedCompressor.compress: passthrough %d tokens (<= %d)", S, max_tokens)
            self._update_stats(start_time, S, S)
            return content

        # 2. Feasibility check — ADVISORY, not blocking.
        r_required = max_tokens / max(S, 1)
        if r_required < self.min_retention_ratio:
            min_achievable = int(S * self.min_retention_ratio)
            logger.warning(
                "Compression feasibility: target %d tokens from %d "
                "(ratio %.1f%%) is below min_retention_ratio %.1f%%. "
                "Adjusting target to min achievable: %d (advisory).",
                max_tokens, S, r_required * 100,
                self.min_retention_ratio * 100, min_achievable,
            )
            max_tokens = min_achievable

        # Cache check
        if self.enable_caching:
            cache_key = self._compute_cache_key(
                content, max_tokens, task_description, priority_keywords, shapley_credits,
                purpose=purpose or "", goal=goal or "",
            )
            if cache_key in self._cache:
                self.stats.cache_hits += 1
                # LRU touch — a hit keeps the entry from being evicted next
                try:
                    self._cache_order.remove(cache_key)
                    self._cache_order.append(cache_key)
                except ValueError:
                    pass
                logger.debug("UnifiedCompressor.compress: cache hit")
                return self._cache[cache_key]
            self.stats.cache_misses += 1
            logger.debug("UnifiedCompressor.compress: cache miss")

        # Extract references before compression
        refs = await self._ref_extractor.extract_async(
            content, goal=goal or task_description or "",
        )
        ref_header = self._ref_extractor.format_header(refs)
        ref_header_tokens = count_tokens(ref_header) if ref_header else 0
        body_budget = max(1, max_tokens - ref_header_tokens)

        # 3. Capacity-fraction chunk sizing (recalibrating).
        #
        # Per-request content is sized as a FRACTION of the provider's real
        # input capacity, corrected by the learned inflation between our
        # local token estimates and the provider's own counts:
        #
        #   chunk_capacity = K × fill_fraction / inflation
        #
        # ``fill_fraction`` defaults to 0.25: content occupies at most a
        # quarter of the window, leaving the remaining three quarters for
        # prompt/signature framing, reasoning, and output — so a request is
        # feasible even before any calibration has been observed. Both K and
        # inflation are LEARNED from provider overflow errors at runtime
        # (see ``record_overflow``); nothing here is provider-specific.
        #
        # The chunk count is defined ONLY by the splitter over this capacity
        # (one definition — no separate planning formula that can disagree
        # with the physical chunker).
        T = body_budget
        _fill = float(os.environ.get("VINV_ENGINE_COMPRESS_CHUNK_CAPACITY_FRACTION", "0.25"))
        _inflation = self._registry.token_inflation(model_id)
        chunk_capacity = max(1, int(_model_window * _fill / _inflation))

        logger.info(
            "AIOC: S=%d T=%d K=%d fill=%.2f inflation=%.3f chunk_capacity=%d",
            S, T, _model_window, _fill, _inflation, chunk_capacity,
        )

        # 4. Single-pass path — content fits one request's content budget.
        if S <= chunk_capacity:
            try:
                compressed_body = await self._compress_direct(
                    content=content,
                    max_tokens=T,
                    task_description=task_description or "",
                    priority_keywords=", ".join(priority_keywords or []),
                    shapley_credits=shapley_credits,
                    purpose=purpose or "",
                    goal=goal or "",
                    must_preserve=kwargs.get("must_preserve", ""),
                    pending_tasks=pending_tasks,
                    protected_refs=ref_header,
                )
            except _ContextOverflow as ov:
                # Learn the provider's real numbers, then fall through to the
                # multi-chunk path with recalibrated capacity.
                self._registry.record_overflow(
                    model_id, ov.estimated_tokens, ov.reported_tokens, ov.reported_limit,
                )
                logger.info(
                    "AIOC: single-pass overflow — recalibrated (limit=%s, "
                    "inflation=%.3f); splitting",
                    self._registry.effective_input_limit(model_id),
                    self._registry.token_inflation(model_id),
                )
            else:
                result = (ref_header + "\n" + compressed_body) if ref_header else compressed_body
                self._update_stats(start_time, S, count_tokens(result))
                if self.enable_caching:
                    self._add_to_cache(cache_key, result)
                return result

        # 5. Multi-chunk map/reduce with overflow recalibration.
        if cancel_event and cancel_event.is_set():
            logger.info("AIOC: cancellation requested before multi-chunk compression, returning content as-is")
            return content

        compressed_body = await self._map_reduce_recalibrating(
            content=content,
            max_tokens=T,
            task_description=task_description or goal or "",
            goal=goal or "",
            purpose=purpose or "",
            pending_tasks=pending_tasks,
            model_id=model_id,
            cancel_event=cancel_event,
            **kwargs,
        )

        result = (ref_header + "\n" + compressed_body) if ref_header else compressed_body
        self._update_stats(start_time, S, count_tokens(result))

        if self.enable_caching:
            self._add_to_cache(cache_key, result)

        return result

    # ----- sync compress -----

    def compress_sync(self, content: str, max_tokens: int, **kwargs) -> str:
        import concurrent.futures

        try:
            asyncio.get_running_loop()
            # Running on event loop thread — MUST use a new thread to avoid
            # asyncio deadlock.  No timeout — dspy.LM handles stuck LLM calls.
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(
                    asyncio.run, self.compress(content, max_tokens, **kwargs)
                )
                return future.result()
        except RuntimeError:
            # No running loop — safe to use asyncio.run directly
            return asyncio.run(self.compress(content, max_tokens, **kwargs))

    # ----- direct LLM compression -----

    _MAX_DIRECT_RETRIES = int(os.environ.get("VINV_ENGINE_COMPRESS_MAX_RETRIES", "3"))

    async def _compress_direct(
        self,
        content: str,
        max_tokens: int,
        task_description: str = "",
        priority_keywords: str = "",
        shapley_credits: Optional[Dict[str, float]] = None,
        purpose: str = "",
        goal: str = "",
        must_preserve: str = "",
        pending_tasks: Optional[List[Dict[str, str]]] = None,
        protected_refs: str = "",
    ) -> str:
        """Single-pass LLM compression. Raises on context-length errors."""
        import json as _json

        high_impact, low_impact = "", ""
        if shapley_credits:
            high_impact, low_impact = self._format_shapley(shapley_credits)

        input_tokens = count_tokens(content)
        target_retention_pct = max(
            1,
            int(100 * max_tokens / max(input_tokens, 1)),
        )

        use_goal_aware = (
            self._goal_compressor is not None
            and (goal or pending_tasks)
        )

        target_retention_ratio = target_retention_pct / 100.0
        min_acceptable = target_retention_ratio / 2.0

        last_error = None
        best_result: Optional[str] = None
        best_retention = 0.0

        for attempt in range(self._MAX_DIRECT_RETRIES):
            try:
                # DSPy ChainOfThought.__call__() is SYNCHRONOUS — it blocks
                # the event loop.  Wrapping in asyncio.to_thread() enables real
                # parallelism when multiple chunks are compressed via asyncio.gather.
                # Without this, 3 chunks × 220s run serially = 660s.
                # With to_thread: max(220s, 220s, 220s) = 220s.
                if use_goal_aware:
                    tasks_str = _json.dumps(
                        pending_tasks or [{"task": "downstream processing"}],
                        default=str,
                    )
                    result = await asyncio.to_thread(
                        self._goal_compressor,
                        content=content,
                        max_tokens=str(max_tokens),
                        min_retention_pct=str(target_retention_pct),
                        goal=goal or task_description,
                        pending_tasks=tasks_str,
                        protected_references=protected_refs or "none",
                        high_impact_items=high_impact,
                        low_impact_items=low_impact,
                    )
                    compressed = str(getattr(result, "compressed", content))
                else:
                    result = await asyncio.to_thread(
                        self._legacy_compressor,
                        content=content,
                        max_tokens=str(max_tokens),
                        min_retention_pct=str(target_retention_pct),
                        task_description=task_description or "",
                        priority_keywords=priority_keywords,
                        high_impact_items=high_impact,
                        low_impact_items=low_impact,
                        purpose=purpose,
                        goal=goal,
                        must_preserve=must_preserve,
                    )
                    compressed = str(getattr(result, "compressed", content))

                input_len = len(content)
                output_len = len(compressed)
                retention = output_len / max(input_len, 1)

                if retention > best_retention:
                    best_result = compressed
                    best_retention = retention

                _near_empty = int(os.environ.get("VINV_ENGINE_COMPRESS_NEAR_EMPTY_CHARS", "50"))
                _min_input = int(os.environ.get("VINV_ENGINE_COMPRESS_MIN_INPUT_CHARS", "500"))
                if output_len < _near_empty and input_len > _min_input:
                    last_error = (
                        f"Near-empty output ({output_len} chars from {input_len})"
                    )
                    continue

                if retention < min_acceptable and input_len > _min_input * 2:
                    last_error = (
                        f"Only {retention:.1%} retained ({output_len} from "
                        f"{input_len}), minimum acceptable {min_acceptable:.1%}"
                    )
                    continue

                removed = str(getattr(result, "what_was_removed", ""))
                if removed:
                    logger.info(
                        "compression_observability: retention=%.1f%% removed=%s",
                        retention * 100, removed,
                    )

                return compressed

            except Exception as e:
                if _is_context_overflow(e):
                    # Do NOT retry an oversized request — the same request can
                    # never succeed. Surface the provider's numbers so the
                    # planner recalibrates chunk sizes and re-splits.
                    reported, limit = _parse_overflow_numbers(e)
                    raise _ContextOverflow(input_tokens, reported, limit, e)
                last_error = str(e)
                logger.warning(
                    "LLM compression attempt %d/%d failed: %s",
                    attempt + 1, self._MAX_DIRECT_RETRIES, e,
                )

        if best_result is not None:
            return best_result

        # Transient (non-overflow) failure after retries: return the chunk
        # unchanged. This is LOSSLESS and BOUNDED — chunks are sized to a
        # fraction of the real context window by the recalibrating planner,
        # so an uncompressed chunk stays feasible for the reduce phase, which
        # packs groups by measured size.
        logger.warning(
            "AIOC: all %d compression attempts failed for a %d-token chunk; "
            "keeping the chunk verbatim (lossless). Last error: %s",
            self._MAX_DIRECT_RETRIES, input_tokens, last_error,
        )
        return content

    # ----- cross-chunk synthesis (REDUCE step) -----

    async def _synthesize_chunks(
        self,
        compressed_parts: List[str],
        max_tokens: int,
        goal: str = "",
    ) -> str:
        """Synthesize independently compressed chunks into a coherent whole.

        This is the REDUCE step of the MAP-REDUCE compression architecture.
        After parallel chunk compression (MAP), this merges the results by
        identifying cross-chunk entities, resolving dangling references, and
        deduplicating repeated information.

        The token budget is GUIDANCE for the model — an over-budget synthesis
        is accepted (no truncation). A provider context rejection raises
        ``_ContextOverflow`` so the reduce planner recalibrates group sizes
        and repacks; it is never swallowed here.
        """
        if not self._synthesizer:
            return "\n\n".join(compressed_parts)

        import json as _json
        chunks_json = _json.dumps(
            [{"chunk_index": i, "content": part} for i, part in enumerate(compressed_parts)],
            ensure_ascii=False,
        )

        try:
            result = await asyncio.to_thread(
                self._synthesizer,
                compressed_chunks=chunks_json,
                max_tokens=str(max_tokens),
                goal=goal or "Synthesize compressed chunks",
            )
            synthesized = str(getattr(result, "synthesized", ""))
            if not synthesized or len(synthesized.strip()) < 20:
                logger.warning(
                    "Cross-chunk synthesis produced near-empty result; "
                    "falling back to concatenation"
                )
                return "\n\n".join(compressed_parts)

            logger.info(
                "cross_chunk_synthesis: %d chunks -> synthesized %d chars "
                "(entities: %s)",
                len(compressed_parts),
                len(synthesized),
                str(getattr(result, "cross_chunk_entities", "")),
            )
            _syn_tokens = count_tokens(synthesized)
            if _syn_tokens > max_tokens:
                # Zero truncation: T_stop overshoot is logged and accepted,
                # not cut — budgets are advisory, destroying information is not.
                logger.info(
                    "cross_chunk_synthesis: result %d tokens exceeds target %d "
                    "(advisory overshoot accepted)",
                    _syn_tokens, max_tokens,
                )
            return synthesized

        except Exception as e:
            if _is_context_overflow(e):
                reported, limit = _parse_overflow_numbers(e)
                raise _ContextOverflow(count_tokens(chunks_json), reported, limit, e)
            logger.warning(
                "Cross-chunk synthesis failed (non-overflow), keeping parts "
                "verbatim for the next reduce round: %s", e,
            )
            return "\n\n".join(compressed_parts)

    # ----- recalibrating MAP/REDUCE (zero truncation, zero content loss) -----
    #
    # Recursive-abstractive design (in the family of RAPTOR / recursive
    # summarization trees): the ONLY size-reduction operator is LLM
    # summarization; the ONLY response to a provider context rejection is to
    # LEARN the provider's real numbers and RE-SPLIT the same content into
    # smaller chunks. Content is never sliced, sampled, or dropped.
    #
    #   MAP:    split content into chunks sized to (K × fill / inflation),
    #           compress each chunk in parallel (bounded concurrency).
    #           Any overflow → record numbers → re-split → retry.
    #   REDUCE: greedily pack compressed parts into the largest groups that
    #           fit one request, synthesize each group, repeat up the tree
    #           until one part remains. Any overflow → recalibrate → repack.

    def _chunk_capacity(self, model_id: Optional[str], fill: float) -> int:
        """Feasible per-request CONTENT tokens from learned capacity numbers."""
        window = (
            self._registry.effective_input_limit(model_id)
            or int(os.environ.get("VINV_ENGINE_COMPRESSION_CONTEXT_LIMIT", "0")) or None
            or int(os.environ.get("VINV_ENGINE_MODEL_FALLBACK_LIMIT", "200000"))
        )
        inflation = self._registry.token_inflation(model_id)
        return max(1, int(window * fill / inflation))

    def _split_to_capacity(self, content: str, capacity: int) -> List[str]:
        """Split *content* at line-aware boundaries into ≤capacity-token chunks."""
        _overlap = int(os.environ.get("VINV_ENGINE_COMPRESS_OVERLAP_TOKENS", "200"))
        _overlap = min(_overlap, max(capacity // 10, 0))
        try:
            from core.components.context_compressor.unified_chunker import (
                SlidingWindowChunker,
            )
            _chunker = SlidingWindowChunker(chunk_size=capacity, overlap=_overlap)
            chunk_objs = _chunker.chunk_content(content, source_key="compression")
            return [c.content for c in chunk_objs] if chunk_objs else [content]
        except Exception as _chunk_err:
            logger.warning(
                "SlidingWindowChunker failed, using line-boundary fallback: %s",
                _chunk_err,
            )
            num = max(1, math.ceil(count_tokens(content) / max(capacity, 1)))
            return self._split_at_line_boundaries(content, num)

    async def _map_reduce_recalibrating(
        self,
        content: str,
        max_tokens: int,
        task_description: str = "",
        goal: str = "",
        purpose: str = "",
        pending_tasks: Optional[List[Dict[str, str]]] = None,
        model_id: Optional[str] = None,
        cancel_event: Optional[asyncio.Event] = None,
        **kwargs,
    ) -> str:
        S = count_tokens(content)
        if S <= max_tokens:
            return content

        fill = float(os.environ.get("VINV_ENGINE_COMPRESS_CHUNK_CAPACITY_FRACTION", "0.25"))
        max_rounds = int(os.environ.get("VINV_ENGINE_COMPRESS_RECALIBRATION_ROUNDS", "6"))
        max_parallel = int(os.environ.get("VINV_ENGINE_COMPRESS_MAX_PARALLEL", "8"))
        # A single LLM call can reliably compress to ~this fraction of its
        # input — asking one call for 100:1 (e.g. a 38K chunk → 380 tokens)
        # destroys information and fails validation. Per-chunk output targets
        # are floored at input × retention; the REDUCE tree then converges
        # geometrically toward the final target over successive rounds.
        per_call_retention = float(
            os.environ.get("VINV_ENGINE_COMPRESS_PER_CALL_RETENTION", "0.25")
        )
        self.stats.chunked_compressions += 1

        compressed_parts: Optional[List[str]] = None
        for round_no in range(max_rounds):
            capacity = self._chunk_capacity(model_id, fill)
            parts = self._split_to_capacity(content, capacity)
            target_share = max(1, max_tokens // len(parts))
            logger.info(
                "map_recalibrating: round=%d chunks=%d capacity=%d "
                "target_share=%d per_call_retention=%.2f S=%d inflation=%.3f",
                round_no, len(parts), capacity, target_share,
                per_call_retention, S,
                self._registry.token_inflation(model_id),
            )

            if cancel_event and cancel_event.is_set():
                logger.info("map_recalibrating: cancelled before map round")
                return content

            sem = asyncio.Semaphore(max(1, max_parallel))

            async def _compress_one(i: int, part: str) -> Any:
                async with sem:
                    if cancel_event and cancel_event.is_set():
                        return part
                    part_tokens = count_tokens(part)
                    # Per-chunk budget: this chunk's share of the final
                    # target, floored at what one call can honestly achieve.
                    # Example (user's numbers): 280K window → 70K chunk →
                    # ≥17.5K output — never 380 tokens.
                    budget_i = max(
                        target_share, int(part_tokens * per_call_retention),
                    )
                    if part_tokens <= budget_i:
                        return part
                    try:
                        return await self._compress_direct(
                            content=part,
                            max_tokens=budget_i,
                            task_description=f"[Part {i+1}/{len(parts)}] {task_description}",
                            goal=goal,
                            purpose=purpose,
                            must_preserve=kwargs.get("must_preserve", ""),
                            pending_tasks=pending_tasks,
                        )
                    except _ContextOverflow as ov:
                        return ov

            results = await asyncio.gather(
                *[_compress_one(i, p) for i, p in enumerate(parts)]
            )
            overflows = [r for r in results if isinstance(r, _ContextOverflow)]
            if not overflows:
                compressed_parts = [str(r) for r in results]
                break

            # Recalibrate from the provider's own numbers, then re-split the
            # SAME content — zero loss, only smaller chunks. If the provider
            # exposed no numbers, shrink the fill fraction multiplicatively so
            # progress is still guaranteed.
            learned = False
            for ov in overflows:
                if ov.reported_tokens or ov.reported_limit:
                    self._registry.record_overflow(
                        model_id, ov.estimated_tokens, ov.reported_tokens, ov.reported_limit,
                    )
                    learned = True
            new_capacity = self._chunk_capacity(model_id, fill)
            if not learned or new_capacity >= capacity:
                fill = fill / 2.0
            logger.info(
                "map_recalibrating: %d/%d chunks overflowed — recalibrated "
                "(learned=%s, capacity %d → %d, fill=%.3f); re-splitting",
                len(overflows), len(parts), learned, capacity,
                self._chunk_capacity(model_id, fill), fill,
            )
        else:
            raise InfeasibleCompressionError(
                input_tokens=S,
                target_tokens=max_tokens,
                recommendation=(
                    "provider kept rejecting even minimal chunks after "
                    f"{max_rounds} recalibration rounds; check credentials/model"
                ),
            )

        if cancel_event and cancel_event.is_set():
            return "\n\n".join(compressed_parts)

        return await self._reduce_recalibrating(
            compressed_parts, max_tokens, goal=goal, model_id=model_id,
            fill=fill, cancel_event=cancel_event,
        )

    async def _reduce_recalibrating(
        self,
        parts: List[str],
        max_tokens: int,
        goal: str = "",
        model_id: Optional[str] = None,
        fill: float = 0.25,
        cancel_event: Optional[asyncio.Event] = None,
    ) -> str:
        """Tree-reduce compressed parts, packing groups by MEASURED size.

        Every group is preflighted against the learned per-request capacity
        before any network call, so a reduce request can only overflow if the
        calibration is stale — in which case the overflow teaches the registry
        and the round repacks with the corrected numbers. Rounds must shrink
        total tokens; if a round stalls, the parts are joined verbatim and the
        (advisory) budget overshoot is reported instead of destroying content.
        """
        if not parts:
            return ""
        max_rounds = int(os.environ.get("VINV_ENGINE_MAX_SYNTHESIS_ROUNDS", "6"))
        max_parallel = int(os.environ.get("VINV_ENGINE_COMPRESS_MAX_PARALLEL", "8"))
        per_call_retention = float(
            os.environ.get("VINV_ENGINE_COMPRESS_PER_CALL_RETENTION", "0.25")
        )

        current = [p for p in parts if p]
        for round_no in range(max_rounds):
            if len(current) <= 1:
                break
            if cancel_event and cancel_event.is_set():
                break

            capacity = self._chunk_capacity(model_id, fill)
            sizes = [count_tokens(p) for p in current]
            total = sum(sizes)

            # Greedy order-preserving packing: the largest groups that fit
            # one request each. Order preservation keeps narrative coherence.
            groups: List[List[str]] = []
            cur: List[str] = []
            cur_tokens = 0
            for p, sz in zip(current, sizes):
                if cur and cur_tokens + sz > capacity:
                    groups.append(cur)
                    cur, cur_tokens = [], 0
                cur.append(p)
                cur_tokens += sz
            if cur:
                groups.append(cur)

            target_share = max(1, max_tokens // len(groups))
            logger.info(
                "reduce_recalibrating: round=%d parts=%d groups=%d "
                "total_tokens=%d capacity=%d target_share=%d",
                round_no, len(current), len(groups), total, capacity,
                target_share,
            )

            sem = asyncio.Semaphore(max(1, max_parallel))

            async def _reduce_group(group: List[str]) -> Any:
                async with sem:
                    if len(group) == 1:
                        return group[0]
                    # Same honesty floor as the map phase: one synthesis call
                    # keeps ≥ per_call_retention of its input; the tree, not a
                    # single call, delivers the deep compression.
                    group_tokens = sum(count_tokens(p) for p in group)
                    budget_g = max(
                        target_share, int(group_tokens * per_call_retention),
                    )
                    try:
                        return await self._synthesize_chunks(
                            group, budget_g, goal=goal,
                        )
                    except _ContextOverflow as ov:
                        return ov
                    except Exception as syn_err:
                        # Non-overflow failure: keep the group verbatim
                        # (lossless); the no-progress guard bounds the loop.
                        logger.warning(
                            "reduce_recalibrating: group synthesis failed "
                            "(non-overflow), keeping %d parts verbatim: %s",
                            len(group), syn_err,
                        )
                        return "\n\n".join(group)

            results = await asyncio.gather(*[_reduce_group(g) for g in groups])
            overflows = [r for r in results if isinstance(r, _ContextOverflow)]
            if overflows:
                learned = False
                for ov in overflows:
                    if ov.reported_tokens or ov.reported_limit:
                        self._registry.record_overflow(
                            model_id, ov.estimated_tokens,
                            ov.reported_tokens, ov.reported_limit,
                        )
                        learned = True
                if not learned or self._chunk_capacity(model_id, fill) >= capacity:
                    fill = fill / 2.0
                logger.info(
                    "reduce_recalibrating: %d/%d groups overflowed — "
                    "recalibrated (fill=%.3f); repacking same parts",
                    len(overflows), len(groups), fill,
                )
                continue  # repack the SAME parts with corrected capacity

            new_parts = [str(r) for r in results]
            new_total = sum(count_tokens(p) for p in new_parts)
            if new_total >= total and len(new_parts) >= len(current):
                logger.warning(
                    "reduce_recalibrating: round made no progress "
                    "(%d → %d tokens); joining %d parts verbatim "
                    "(budget is advisory, content preserved)",
                    total, new_total, len(new_parts),
                )
                current = new_parts
                break
            current = new_parts

        result = "\n\n".join(current)

        # Final convergence: per-call honesty floors mean the last part can
        # still exceed the target. Keep compressing the single result while it
        # fits one request and each pass makes real progress — the geometric
        # series converges to the target without ever asking one call for an
        # impossible ratio (and without cutting anything).
        _slack = 1.25
        for _ in range(max_rounds):
            result_tokens = count_tokens(result)
            if result_tokens <= int(max_tokens * _slack):
                break
            if cancel_event and cancel_event.is_set():
                break
            if result_tokens > self._chunk_capacity(model_id, fill):
                break  # joined verbatim after a stall — accept advisory overshoot
            budget = max(max_tokens, int(result_tokens * per_call_retention))
            try:
                squeezed = await self._compress_direct(
                    content=result, max_tokens=budget, goal=goal,
                )
            except _ContextOverflow as ov:
                self._registry.record_overflow(
                    model_id, ov.estimated_tokens, ov.reported_tokens, ov.reported_limit,
                )
                break
            if count_tokens(squeezed) >= result_tokens:
                break  # no progress — stop, keep the better version
            result = squeezed

        result_tokens = count_tokens(result)
        if result_tokens > max_tokens:
            logger.info(
                "reduce_recalibrating: result=%d > target=%d (%.0f%% over) — "
                "accepting advisory overshoot (no truncation)",
                result_tokens, max_tokens,
                (result_tokens - max_tokens) / max(max_tokens, 1) * 100,
            )
        return result

    # Backwards-compatible alias: earlier code called _split_compress_concat.
    async def _split_compress_concat(
        self,
        content: str,
        max_tokens: int,
        num_chunks: int = 0,
        task_description: str = "",
        goal: str = "",
        purpose: str = "",
        pending_tasks: Optional[List[Dict[str, str]]] = None,
        model_id: Optional[str] = None,
        overhead_tokens: int = 0,
        _depth: int = 0,
        cancel_event: Optional[asyncio.Event] = None,
        **kwargs,
    ) -> str:
        kwargs.pop("_t_stop", None)
        kwargs.pop("_context_limit", None)
        kwargs.pop("_c_effective", None)
        kwargs.pop("_previous_result_tokens", None)
        return await self._map_reduce_recalibrating(
            content=content,
            max_tokens=max_tokens,
            task_description=task_description,
            goal=goal,
            purpose=purpose,
            pending_tasks=pending_tasks,
            model_id=model_id,
            cancel_event=cancel_event,
            **kwargs,
        )

        async def _compress_one(i: int, part: str) -> str:
            part_tokens = count_tokens(part)
            if part_tokens <= budget_per_chunk:
                return part
            try:
                return await self._compress_direct(
                    content=part,
                    max_tokens=budget_per_chunk,
                    task_description=f"[Part {i+1}/{len(parts)}] {task_description}",
                    goal=goal,
                    purpose=purpose,
                    must_preserve=kwargs.get("must_preserve", ""),
                    pending_tasks=pending_tasks,
                )
            except InfeasibleCompressionError:
                raise
            except Exception as e:
                if self._is_context_length_error(e):
                    if _depth >= max_depth:
                        # Deep fallback (spec: the only sanctioned slicer) —
                        # boundary-aware head+tail fit so the REDUCE step never
                        # receives an over-window part.
                        logger.warning(
                            "split_compress_concat: chunk %d/%d exceeded context "
                            "at max depth %d, using token-aware fit (advisory)",
                            i + 1, len(parts), max_depth,
                        )
                        from core.components.context_compressor import _token_aware_fit
                        _cpt = int(os.environ.get("VINV_ENGINE_CHARS_PER_TOKEN", "4"))
                        return _token_aware_fit(
                            part, budget_per_chunk * _cpt, preserve_ends=True,
                        )
                    _usable = _c_effective if _c_effective else max(1, (_context_limit or part_tokens) - overhead_tokens)
                    sub_N = max(2, math.ceil(
                        (part_tokens + budget_per_chunk) / max(_usable, 1)
                    ))
                    return await self._split_compress_concat(
                        content=part,
                        max_tokens=budget_per_chunk,
                        num_chunks=sub_N,
                        task_description=task_description,
                        goal=goal,
                        purpose=purpose,
                        pending_tasks=pending_tasks,
                        model_id=model_id,
                        overhead_tokens=overhead_tokens,
                        _depth=_depth + 1,
                        _t_stop=_t_stop,
                        _context_limit=_context_limit,
                        _c_effective=_c_effective,
                        _previous_result_tokens=part_tokens,
                        **kwargs,
                    )
                logger.warning(
                    "Compression of chunk %d/%d failed: %s",
                    i + 1, len(parts), e,
                )
                raise

        if cancel_event and cancel_event.is_set():
            logger.info("split_compress_concat: cancellation requested before chunk compression, returning content as-is")
            return content

        compressed_parts = await asyncio.gather(
            *[_compress_one(i, part) for i, part in enumerate(parts)]
        )

        if cancel_event and cancel_event.is_set():
            logger.info("split_compress_concat: cancellation requested after chunk compression, returning concatenated result")
            return "\n\n".join(compressed_parts)

        if len(compressed_parts) >= 2 and self._synthesizer:
            concat_tokens = sum(count_tokens(p) for p in compressed_parts)
            C_syn = _context_limit or self._registry.get_limit(model_id)
            if C_syn is None or concat_tokens < C_syn:
                result = await self._synthesize_chunks(
                    compressed_parts, max_tokens, goal=goal,
                )
            else:
                # Batch-reduce when combined output exceeds model context:
                # synthesize pairs in PARALLEL per round, iterate rounds
                # until within limits.
                batch_parts = list(compressed_parts)
                _max_synthesis_rounds = int(os.environ.get("VINV_ENGINE_MAX_SYNTHESIS_ROUNDS", "3"))
                _synthesis_round = 0
                while len(batch_parts) > 1 and _synthesis_round < _max_synthesis_rounds:
                    per_pair_budget = max_tokens // max(len(batch_parts) // 2, 1)
                    tasks: list = []
                    for j in range(0, len(batch_parts), 2):
                        if j + 1 < len(batch_parts):
                            tasks.append(self._synthesize_chunks(
                                [batch_parts[j], batch_parts[j + 1]],
                                per_pair_budget,
                                goal=goal,
                            ))
                        else:
                            async def _passthrough(part=batch_parts[j]):
                                return part
                            tasks.append(_passthrough())
                    new_parts = list(await asyncio.gather(*tasks))
                    _synthesis_round += 1
                    if len(new_parts) >= len(batch_parts):
                        break
                    batch_parts = new_parts
                result = "\n\n".join(batch_parts)
        else:
            result = "\n\n".join(compressed_parts)

        result_tokens = count_tokens(result)
        # T_stop is advisory — no truncation.  The model context is large
        # enough to handle moderate overages.  Hard truncation destroys
        # information and breaks the "no slicing" principle.

        # Structured diagnostic (A-Team S1): depth, tokens, decision
        logger.info(
            "split_compress_concat: depth=%d result_tokens=%d max_tokens=%d S=%d previous_result_tokens=%d",
            _depth, result_tokens, max_tokens, S, _previous_result_tokens,
        )

        # Single-pass only: return whatever the parallel chunk compression
        # produced.  The token target is ADVISORY — if the result is close
        # to budget, accept it.  No recursive re-compression.  The model
        # context window is large enough to absorb moderate overages, and
        # recursive compression wastes enormous latency for marginal gains.
        if result_tokens > max_tokens:
            logger.info(
                "split_compress_concat: result=%d > target=%d (%.0f%% over) — "
                "accepting advisory overshoot (no recursion)",
                result_tokens, max_tokens,
                (result_tokens - max_tokens) / max(max_tokens, 1) * 100,
            )

        return result

        return result

    @staticmethod
    def _split_at_line_boundaries(content: str, num_parts: int) -> List[str]:
        """Legacy fallback: split by character count at line boundaries.

        Prefer SlidingWindowChunker for token-accurate splitting.
        Kept as a fallback when the chunker is unavailable.
        """
        if num_parts <= 1:
            return [content]

        lines = content.split("\n")
        if len(lines) <= num_parts:
            return [content]

        total_chars = len(content)
        target_chars_per_part = total_chars // num_parts

        parts: List[str] = []
        current_lines: List[str] = []
        current_chars = 0

        for line in lines:
            current_lines.append(line)
            current_chars += len(line) + 1

            if current_chars >= target_chars_per_part and len(parts) < num_parts - 1:
                parts.append("\n".join(current_lines))
                current_lines = []
                current_chars = 0

        if current_lines:
            parts.append("\n".join(current_lines))

        return [p for p in parts if p.strip()]

    @staticmethod
    def _split_at_boundaries(content: str, num_parts: int) -> List[str]:
        """Legacy split method — delegates to line-boundary version."""
        return UnifiedCompressor._split_at_line_boundaries(content, num_parts)

    @staticmethod
    def _format_shapley(credits: Dict[str, float]) -> Tuple[str, str]:
        if not credits:
            return "", ""
        sorted_items = sorted(credits.items(), key=lambda x: x[1], reverse=True)
        n = len(sorted_items)
        high_threshold = int(n * 0.3)
        low_threshold = int(n * 0.7)
        high = [f"{item} ({score:.2f})" for item, score in sorted_items[:high_threshold]]
        low = [f"{item} ({score:.2f})" for item, score in sorted_items[low_threshold:]]
        return ", ".join(high), ", ".join(low)

    @staticmethod
    def _is_context_length_error(error: Exception) -> bool:
        """Provider-agnostic context-overflow check (typed + message patterns)."""
        return _is_context_overflow(error)

    def _compute_cache_key(self, content, max_tokens, task_desc, keywords, shapley,
                           purpose="", goal=""):
        # purpose + goal are part of the key: two audiences => different results.
        context_parts = [
            task_desc or "",
            ",".join(keywords or []),
            str(sorted(shapley.items()) if shapley else ""),
            purpose or "",
            goal or "",
        ]
        return (hash(content), max_tokens, hash("::".join(context_parts)))

    def _add_to_cache(self, key, value):
        if len(self._cache) >= self.cache_size:
            oldest = self._cache_order.pop(0)
            self._cache.pop(oldest, None)
            logger.debug("UnifiedCompressor._add_to_cache: evicted oldest entry (cache full)")
        self._cache[key] = value
        self._cache_order.append(key)

    def _update_stats(self, start_time, input_tokens, output_tokens):
        self.stats.total_compressions += 1
        self.stats.total_time += time.time() - start_time
        self.stats.total_input_tokens += input_tokens
        self.stats.total_output_tokens += output_tokens

    def get_stats(self) -> Dict[str, Any]:
        return {
            "total_compressions": self.stats.total_compressions,
            "total_time": self.stats.total_time,
            "avg_time": self.stats.avg_time,
            "cache_hit_rate": self.stats.cache_hit_rate,
            "chunked_compressions": self.stats.chunked_compressions,
        }


# ---------------------------------------------------------------------------
# Global convenience
# ---------------------------------------------------------------------------

_global_compressor: Optional[UnifiedCompressor] = None


def get_global_compressor() -> UnifiedCompressor:
    global _global_compressor
    if _global_compressor is None:
        logger.info("UnifiedCompressor: initializing global compressor")
        _global_compressor = UnifiedCompressor()
    return _global_compressor


async def compress(content: str, max_tokens: int, **kwargs) -> str:
    return await get_global_compressor().compress(content, max_tokens, **kwargs)


def compress_sync(content: str, max_tokens: int, **kwargs) -> str:
    return get_global_compressor().compress_sync(content, max_tokens, **kwargs)


__all__ = [
    "UnifiedCompressor",
    "UnifiedCompressionSignature",
    "GoalAwareCompressionSignature",
    "ReferenceExtractionSignature",
    "ReferenceExtractor",
    "CompressionStats",
    "CompressionResult",
    "InfeasibleCompressionError",
    "get_global_compressor",
    "compress",
    "compress_sync",
]
