"""Vinv Engine / components / context_compressor / context_guard — SmartContextGuard.

Priority-based context budget management:
- Priority-based compression (CRITICAL, HIGH, MEDIUM, LOW)
- LLM budget allocation via ContextAllocationSignature
- Emergency multi-layer compression
- Overflow detection and recovery
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

try:
    import dspy
    DSPY_AVAILABLE = True
except ImportError:
    DSPY_AVAILABLE = False
    dspy = None

from core.components.context_compressor.token_utils import count_tokens, fit_for_logging
from core.components.timeout_registry import get_timeout_seconds

logger = logging.getLogger(__name__)


def _safe_json_parse(value: Any) -> dict | list | Any:
    """Best-effort JSON parse that handles the ``str(dict)`` anti-pattern.

    * Already a dict/list  -> returned as-is.
    * Valid JSON string    -> decoded.
    * Python repr string (``{'k': v}``)  -> attempted ``ast.literal_eval``.
    * Anything else        -> returned unchanged.
    """
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        # Fallback: Python repr produced by str(dict) — e.g. "{'key': 0.5}"
        try:
            import ast
            parsed = ast.literal_eval(value)
            if isinstance(parsed, (dict, list)):
                logger.debug("context_guard_safe_json_parse_fallback used_ast_literal_eval=True")
                return parsed
        except (ValueError, SyntaxError):
            pass
    return value


# ---------------------------------------------------------------------------
# LLM Signatures
# ---------------------------------------------------------------------------

if DSPY_AVAILABLE and dspy is not None:
    class ContextAllocationSignature(dspy.Signature):
        """Allocate context budget across items (LLM-based, no heuristics)."""
        items = dspy.InputField(desc="JSON list of items with key, priority, size_tokens")
        required_keys = dspy.InputField(desc="JSON list of keys that must be included")
        max_tokens = dspy.InputField(desc="Maximum total tokens allowed")

        reasoning = dspy.OutputField(desc="How allocation was decided")
        allocation = dspy.OutputField(
            desc="JSON list of {key, max_tokens, compress} items to include",
        )

    class OverflowDetectionSignature(dspy.Signature):
        """Determine if an error indicates context overflow."""
        error_message = dspy.InputField(desc="Error message or summary")
        context_tokens = dspy.InputField(desc="Current context size in tokens")
        max_tokens = dspy.InputField(desc="Maximum allowed tokens")

        is_overflow = dspy.OutputField(desc="True if error indicates context overflow")
        reasoning = dspy.OutputField(desc="Why this is or is not an overflow")


class SmartContextGuard:
    """Priority-based context budget management."""

    CRITICAL = 0
    HIGH = 1
    MEDIUM = 2
    LOW = 3

    def __init__(self, max_tokens: int | None = None, safety_margin: int | None = None):
        import os as _os

        if max_tokens is None:
            _ratio = float(_os.environ.get("VINV_ENGINE_GUARD_MAX_TOKENS_RATIO", "0.15"))
            _fallback = int(_os.environ.get("VINV_ENGINE_GUARD_FALLBACK_TOKENS", "28000"))
            try:
                from core.components.context_compressor.model_context_registry import (
                    get_model_context_registry,
                )
                _limit = get_model_context_registry().get_limit()
                max_tokens = int(_limit * _ratio) if _limit else _fallback
            except Exception:
                max_tokens = _fallback
        if safety_margin is None:
            safety_margin = int(_os.environ.get("VINV_ENGINE_CONTEXT_GUARD_SAFETY_MARGIN", "2000"))
        self.max_tokens = max_tokens
        self.safety_margin = safety_margin
        self.usable_tokens = max_tokens - safety_margin

        self.buffers: Dict[int, List[Tuple[str, str, int]]] = {
            self.CRITICAL: [],
            self.HIGH: [],
            self.MEDIUM: [],
            self.LOW: [],
        }

        self._allocator = (
            dspy.ChainOfThought(ContextAllocationSignature)
            if (DSPY_AVAILABLE and dspy is not None)
            else None
        )
        self._overflow_detector = (
            dspy.ChainOfThought(OverflowDetectionSignature)
            if (DSPY_AVAILABLE and dspy is not None)
            else None
        )

    def estimate_tokens(self, text: str) -> int:
        return count_tokens(text)

    def register(self, key: str, content: str, priority: int):
        tokens = self.estimate_tokens(content)
        self.buffers[priority].append((key, content, tokens))
        logger.debug("SmartContextGuard.register: key=%s priority=%d tokens=%d", key, priority, tokens)

    def register_critical(self, key: str, content: str):
        self.register(key, content, self.CRITICAL)

    def clear(self):
        for p in self.buffers:
            self.buffers[p] = []
        logger.debug("SmartContextGuard.clear: buffers cleared")

    def build_context(self) -> Tuple[str, Dict[str, Any]]:
        logger.debug("SmartContextGuard.build_context: building context from %d buffer entries", sum(len(e) for e in self.buffers.values()))
        items = []
        required_keys = []
        for priority, entries in self.buffers.items():
            for key, content, tokens in entries:
                items.append({"key": key, "priority": priority, "size_tokens": tokens})
                if priority == self.CRITICAL:
                    required_keys.append(key)

        if not self._allocator:
            logger.debug("SmartContextGuard.build_context: LLM allocator unavailable, using critical-only")
            return self._build_critical_only()

        try:
            result = self._allocator(
                items=json.dumps(items),
                required_keys=json.dumps(required_keys),
                max_tokens=str(self.usable_tokens),
            )
            raw_alloc = _safe_json_parse(result.allocation) if hasattr(result, "allocation") else []
            allocation = raw_alloc if isinstance(raw_alloc, list) else []
        except Exception as exc:
            logger.warning("SmartContextGuard.build_context: allocator failed, using critical-only fallback: %s", exc)
            allocation = [
                {"key": k, "max_tokens": self.usable_tokens, "compress": False}
                for k in required_keys
            ]

        content_map = {
            key: content
            for entries in self.buffers.values()
            for key, content, _ in entries
        }
        token_map = {
            key: tokens
            for entries in self.buffers.values()
            for key, _, tokens in entries
        }

        # Floor per-section tokens so we never ask pipeline to compress to tiny targets (e.g. 250)
        import os as _os
        _min_section_tokens = int(_os.environ.get("VINV_ENGINE_GUARD_MIN_SECTION_TOKENS", "2000"))
        _min_section_ratio = float(_os.environ.get("VINV_ENGINE_GUARD_MIN_SECTION_RATIO", "0.01"))
        _section_floor = max(_min_section_tokens, int(self.usable_tokens * _min_section_ratio))

        parts, included, truncated, total = [], {}, {}, 0
        for item in allocation:
            if not isinstance(item, dict):
                continue
            key = item.get("key")
            if key not in content_map:
                continue
            max_t = int(item.get("max_tokens", token_map.get(key, 0)))
            if max_t < _section_floor:
                max_t = _section_floor
            compress = bool(item.get("compress", False))
            text = content_map[key]
            if compress:
                text = self._smart_compress(text, max_t)
                truncated[key] = (token_map.get(key, 0), max_t)
            parts.append(f"## {key}\n{text}\n")
            used = min(token_map.get(key, 0), max_t)
            total += used
            included[key] = used

        return "\n".join(parts), {
            "total_tokens": total,
            "max_tokens": self.usable_tokens,
            "included": included,
            "truncated": truncated,
            "utilization": total / max(1, self.usable_tokens),
        }

    def _build_critical_only(self) -> Tuple[str, Dict[str, Any]]:
        parts, total, included = [], 0, {}
        for key, content, tokens in self.buffers[self.CRITICAL]:
            parts.append(f"## {key}\n{content}\n")
            total += tokens
            included[key] = tokens
        return "\n".join(parts), {
            "total_tokens": total,
            "max_tokens": self.usable_tokens,
            "included": included,
            "truncated": {},
            "utilization": total / max(1, self.usable_tokens),
            "note": "LLM allocator unavailable; included CRITICAL only",
        }

    def process_large_document(self, document: str, query: str) -> str:
        doc_tokens = self.estimate_tokens(document)
        if doc_tokens <= self.usable_tokens:
            logger.debug("SmartContextGuard.process_large_document: within budget, passthrough")
            return document
        logger.info("SmartContextGuard.process_large_document: compressing %d tokens to %d", doc_tokens, self.usable_tokens)
        return self._smart_compress(document, self.usable_tokens)

    def catch_and_recover(self, error: Exception, current_context: str) -> Optional[str]:
        if not self._overflow_detector:
            return None
        try:
            result = self._overflow_detector(
                error_message=str(error),
                context_tokens=str(self.estimate_tokens(current_context)),
                max_tokens=str(self.usable_tokens),
            )
            if bool(getattr(result, "is_overflow", False)):
                logger.warning("Overflow detected; compressing context")
                return self._smart_compress(current_context, self.usable_tokens)
        except Exception:
            pass
        return None

    def _smart_compress(self, content: str, max_tokens: int, task_hint: str = "") -> str:
        try:
            from core.components.context_compressor.content_ingestion import ContentIngestionPipeline
            if not hasattr(self, "_pipeline"):
                self._pipeline = ContentIngestionPipeline()
            query = (
                f"Compress for task: {task_hint}. "
                "Preserve: file paths, error messages, tool outputs, data values. "
                "Remove: verbose logging, redundancy."
            ) if task_hint else (
                "Compress preserving critical information: file paths, errors, "
                "tool outputs, task details. Remove verbose logging and redundancy."
            )
            result = self._pipeline.process_sync(
                content=content, max_tokens=max_tokens, query=query,
                goal=task_hint or "Context compression", context_type="context",
            )
            return result.content
        except Exception as e:
            logger.debug(f"ContentIngestionPipeline failed: {e}")
            return content

    # emergency_compress removed — dead code (zero callers).
    # Use UnifiedCompressor.compress_sync() for all compression needs.


__all__ = [
    "SmartContextGuard",
    "ContextAllocationSignature",
    "OverflowDetectionSignature",
]
