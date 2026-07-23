"""Vinv Engine / components / context_compressor / engine — Context compression engine.

SmartContextGuard + UnifiedCompressor approach:
priority-aware compression that aggressively trims low-priority nodes
(trajectory internals) while preserving high-priority deliverables
(output paths, reasoning, task_complete flags).
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from typing import TYPE_CHECKING, List

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from core.components.context_compressor.chain import ContextNode

_MEDIUM_FLOOR = int(os.environ.get("VINV_ENGINE_COMPRESS_MEDIUM_FLOOR", "4000"))

_URL_TERMINATORS = frozenset(' \t\n\r\'"<>,)')


def _extract_urls(text: str) -> list[str]:
    """Extract URLs from text using character-level scanning (no regex)."""
    urls: list[str] = []
    for prefix in ("https://", "http://"):
        start = 0
        while True:
            idx = text.find(prefix, start)
            if idx == -1:
                break
            end = idx + len(prefix)
            while end < len(text) and text[end] not in _URL_TERMINATORS:
                end += 1
            url = text[idx:end]
            if len(url) > len(prefix):
                urls.append(url)
            start = end
    return urls


def _extract_file_paths(text: str) -> list[str]:
    """Extract file paths from text using character-level scanning (no regex).

    Looks for paths starting with '/' or drive letters like 'C:\\' that
    contain a dot-extension (e.g. /foo/bar.py, C:\\dir\\file.txt).
    """
    paths: list[str] = []
    terminators = frozenset(' \t\n\r\'"<>,)')
    i = 0
    while i < len(text):
        is_unix = text[i] == "/" and i + 1 < len(text) and text[i + 1].isalnum()
        is_win = (
            i + 2 < len(text)
            and text[i].isalpha()
            and text[i + 1] == ":"
            and text[i + 2] == "\\"
        )
        if is_unix or is_win:
            end = i + 1
            while end < len(text) and text[end] not in terminators:
                end += 1
            candidate = text[i:end]
            dot = candidate.rfind(".")
            if dot != -1 and dot < len(candidate) - 1:
                ext = candidate[dot + 1:]
                if 1 <= len(ext) <= 5 and ext.isalnum():
                    paths.append(candidate)
            i = end
        else:
            i += 1
    return paths


_BUILTIN_KEY_PRIORITY_MAP: dict[str, int] = {
    "output_path": 10,
    "task_complete": 10,
    "generated_script": 10,
    "result": 10,
    "file_path": 10,
    "document_path": 10,
    "error": 10,
    "reasoning": 8,
    "analysis": 8,
    "document_plan": 8,
    "plan": 8,
    "output_summary": 8,
    "collaboration_data": 8,
    "sources": 8,
    "urls": 8,
    "references": 8,
    "findings": 8,
    "citations": 8,
    "links": 8,
    "documentation_urls": 8,
    "setup_guides": 8,
    "official_website": 8,
    "github_repository": 8,
    "collaboration_actions": 6,
    "trajectory_summary": 5,
    "trajectory": 2,
}


def _load_key_priority_map() -> dict[str, int]:
    """Load key priority map from env-configured JSON file, falling back to built-in."""
    config_path = os.environ.get("VINV_ENGINE_COMPRESSOR_PRIORITY_FILE", "")
    if config_path and os.path.isfile(config_path):
        try:
            import json as _json
            with open(config_path) as f:
                loaded = _json.load(f)
            if isinstance(loaded, dict):
                logger.info("ContextCompressorEngine: loaded key priority map from %s (%d keys)", config_path, len(loaded))
                return {str(k): int(v) for k, v in loaded.items()}
        except Exception as exc:
            logger.warning("ContextCompressorEngine: failed to load priority file %s: %s, using built-in", config_path, exc)
            pass
    logger.debug("ContextCompressorEngine: using built-in key priority map")
    return dict(_BUILTIN_KEY_PRIORITY_MAP)


DEFAULT_KEY_PRIORITY_MAP: dict[str, int] = _load_key_priority_map()

MISC_PRIORITY = int(os.environ.get("VINV_ENGINE_COMPRESS_MISC_PRIORITY", "3"))
PRESERVED_REFS_PRIORITY = int(os.environ.get("VINV_ENGINE_COMPRESS_REFS_PRIORITY", "9"))


class ContextCompressorEngine:
    """Priority-aware context compression."""

    THRESHOLD = int(os.environ.get("VINV_ENGINE_COMPRESS_THRESHOLD", "12000"))

    def compress(self, text: str, max_chars: int = 240_000) -> str:
        """Compress text to fit within max_chars budget.

        Delegates to compress_with_priority for actual LLM compression.
        Never truncates — uses LLM-based compression when over budget.
        """
        if len(text) <= max_chars:
            return text
        from core.components.context_compressor.chain import ContextNode
        node = ContextNode(content=text, priority=5, label="direct_compress")
        return self.compress_with_priority([node], max_chars)

    @classmethod
    def get_threshold_for_model(cls, model_id: str | None = None) -> int:
        """Return the char threshold at which compression should trigger.

        Uses ModelContextRegistry for adaptive limit discovery.
        Threshold is 10% of the model's token limit * 4 (chars).
        """
        if not model_id:
            return cls.THRESHOLD
        try:
            from core.components.context_compressor.model_context_registry import (
                get_model_context_registry,
            )
            limit = get_model_context_registry().get_limit(model_id)
            if limit is not None:
                return int(limit * 4 * 0.10)
        except Exception:
            pass
        return cls.THRESHOLD

    def needs_compression(self, text: str, model_id: str | None = None) -> bool:
        """Return True if text exceeds compression threshold for given model."""
        threshold = self.get_threshold_for_model(model_id)
        needs = len(text) > threshold
        logger.debug("ContextCompressorEngine.needs_compression: len=%d threshold=%d -> %s", len(text), threshold, needs)
        return needs

    # ------------------------------------------------------------------
    # Priority-aware compression (used by ContextChain._compress_sync)
    # ------------------------------------------------------------------

    @staticmethod
    def compress_with_priority(
        nodes: List["ContextNode"], budget: int, purpose: str = "general",
    ) -> str:
        """Compress a list of ContextNodes into a single string that fits *budget*.

        IMPORTANT: *budget* is in CHARACTERS (char_count), not tokens.
        Callers that have token budgets must multiply by 4 before calling.

        Strategy (sorted low priority first):
        - LOW (1-3): Drop entirely when over budget.  These are trajectory
          noise, causal context, and misc keys that downstream tasks rarely
          need.
        - MEDIUM (4-7): Preserved after LOW nodes are dropped.
        - CRITICAL (8-10): Always preserved.

        If still over budget after dropping LOW nodes, delegates to
        UnifiedCompressor for LLM-based intelligent compression (NEVER
        truncates or string-slices).

        The *purpose* parameter is forwarded to the LLM compressor to
        guide what to preserve:
        - "upstream_output" → preserve deliverables, drop reasoning
        - "trajectory" → preserve decision points and errors
        - "architect_guidance" → preserve recommendations
        - "dependency_context" → preserve interface contracts
        """
        if not nodes:
            return ""

        total = sum(n.char_count for n in nodes)
        if total <= budget:
            logger.debug("ContextCompressorEngine.compress_with_priority: within budget, no compression needed")
            return "\n\n".join(n.content for n in nodes if n.content)

        logger.info("ContextCompressorEngine.compress_with_priority: %d nodes total=%d budget=%d, applying priority drop", len(nodes), total, budget)

        sorted_nodes = sorted(nodes, key=lambda n: n.priority)

        excess = total - budget
        parts: List[str] = []

        for node in sorted_nodes:
            if excess <= 0:
                parts.append(node.content)
                continue

            _drop_priority = int(os.environ.get("VINV_ENGINE_COMPRESS_DROP_PRIORITY", "3"))
            if node.priority <= _drop_priority:
                excess -= node.char_count
                continue

            parts.append(node.content)

        result = "\n\n".join(p for p in parts if p)

        if len(result) > budget:
            overshoot_ratio = (len(result) - budget) / budget
            _skip_ratio = float(os.environ.get("VINV_ENGINE_COMPRESS_LLM_SKIP_RATIO", "0.20"))
            if overshoot_ratio <= _skip_ratio:
                logger.info(
                    "ContextCompressorEngine.compress_with_priority: "
                    "overshoot %.1f%% <= skip threshold %.0f%%, "
                    "accepting without LLM compression (result=%d, budget=%d)",
                    overshoot_ratio * 100, _skip_ratio * 100, len(result), budget,
                )
            else:
                result = ContextCompressorEngine._llm_compress_remaining(
                    result, budget, purpose=purpose,
                )

        return result

    @staticmethod
    def _llm_compress_remaining(
        content: str, budget_chars: int, purpose: str = "general",
    ) -> str:
        """Use UnifiedCompressor (LLM AIOC) to compress remaining content.

        Called SYNCHRONOUSLY from compress_with_priority (which runs on the
        event loop thread). Must NOT use run_coroutine_threadsafe on the
        same loop — that causes a deadlock. Instead, run the async compress
        in a NEW thread with its own event loop.
        """
        import concurrent.futures
        chars_per_token = int(os.environ.get("VINV_ENGINE_CHARS_PER_TOKEN", "4"))

        _PURPOSE_PROMPTS = {
            "upstream_output": (
                "Compress while preserving deliverables (file paths, URLs, data). "
                "Drop reasoning chains and intermediate analysis."
            ),
            "trajectory": (
                "Compress while preserving decision points, errors, and outcomes. "
                "Drop routine successful steps and verbose tool outputs."
            ),
            "architect_guidance": (
                "Compress while preserving key recommendations and contingency plans. "
                "Drop exploratory analysis and rejected alternatives."
            ),
            # Documented alias for architect_guidance (context-builder callers)
            "context_builder_guidance": (
                "Compress while preserving key recommendations and contingency plans. "
                "Drop exploratory analysis and rejected alternatives."
            ),
            "dependency_context": (
                "Compress while preserving interface contracts and output schemas. "
                "Drop implementation details and internal logic."
            ),
        }
        task_desc = _PURPOSE_PROMPTS.get(
            purpose,
            "Compress context to fit within budget while preserving "
            "all critical information, references, and actionable data",
        )

        try:
            from core.components.context_compressor.unified_compression import (
                get_global_compressor,
            )

            compressor = get_global_compressor()
            target_tokens = max(1, budget_chars // chars_per_token)

            async def _do_compress():
                return await compressor.compress(
                    content,
                    max_tokens=target_tokens,
                    task_description=task_desc,
                    purpose=f"for_priority_compression_{purpose}",
                )

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(asyncio.run, _do_compress())
                return future.result()

        except ImportError:
            logger.debug("UnifiedCompressor unavailable — returning content as-is")
            return content
        except Exception:
            logger.exception("LLM compression failed in _llm_compress_remaining")
            return content

    # ------------------------------------------------------------------
    # Structured output compression (for dependency context)
    # ------------------------------------------------------------------

    @staticmethod
    def compress_output_dict(output: dict, budget: int) -> str:
        """Compress an executor output dict, prioritizing deliverables over trajectory.

        IMPORTANT: *budget* is in CHARACTERS, not tokens. Callers with token
        budgets must multiply by 4 before calling.

        Unlike naive str(output)[:N], this extracts actionable fields first
        (output_path, reasoning, task_complete, analysis, document_plan,
        collaboration_actions) and only includes trajectory data if budget allows.
        """
        if not isinstance(output, dict):
            logger.debug("ContextCompressorEngine.compress_output_dict: non-dict input, converting to str")
            return str(output)

        logger.debug("ContextCompressorEngine.compress_output_dict: compressing output dict with %d keys, budget=%d", len(output), budget)
        from core.components.context_compressor.chain import ContextNode
        import json as _json

        nodes: List[ContextNode] = []
        mapped_keys: set[str] = set()

        for key, priority in DEFAULT_KEY_PRIORITY_MAP.items():
            if key not in output or not output[key]:
                continue
            mapped_keys.add(key)
            val = output[key]
            content_str = (
                _json.dumps(val, default=str)
                if isinstance(val, (list, dict))
                else str(val)
            )
            nodes.append(ContextNode(
                content=f"{key}: {content_str}",
                priority=priority,
                label=key,
            ))

        for key, val in output.items():
            if key not in mapped_keys and val:
                nodes.append(ContextNode(
                    content=f"{key}: {val}",
                    priority=MISC_PRIORITY,
                    label=key,
                ))

        # Extract and preserve URLs/file paths from the entire output as a
        # safety net — even if individual keys are dropped, references survive
        import os as _os
        _all_text = str(output)
        _urls = list(set(_extract_urls(_all_text)))
        _file_paths = list(set(_extract_file_paths(_all_text)))
        _min_urls = int(_os.environ.get("VINV_ENGINE_COMPRESS_MAX_URLS", "500"))
        _min_paths = int(_os.environ.get("VINV_ENGINE_COMPRESS_MAX_PATHS", "200"))
        _effective_max_urls = min(len(_urls), max(_min_urls, int(len(_urls) * 4 // 5)))
        _effective_max_paths = min(len(_file_paths), max(_min_paths, int(len(_file_paths) * 4 // 5)))
        if _urls or _file_paths:
            _ref_parts = []
            if _urls:
                _ref_parts.append("URLs: " + " | ".join(_urls[:_effective_max_urls]))
            if _file_paths:
                _ref_parts.append("Files: " + " | ".join(_file_paths[:_effective_max_paths]))
            nodes.append(ContextNode(
                content="PRESERVED_REFERENCES: " + " ; ".join(_ref_parts),
                priority=PRESERVED_REFS_PRIORITY,
                label="preserved_references",
            ))

        if not nodes:
            return str(output)

        return ContextCompressorEngine.compress_with_priority(nodes, budget)

    # compress_context removed — was dead code (zero callers).
    # Use compress_with_priority directly for priority-aware compression,
    # or UnifiedCompressor.compress for LLM-based compression.
