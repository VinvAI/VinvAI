"""Vinv Engine / components / context_compressor / chain — Linked-list context builder.

Non-blocking, preemptive context compression using a priority-tagged node chain.
Nodes accumulate content; when total size reaches the trigger ratio of the budget
a background task compresses existing nodes into a single summary while new nodes
keep appending at the tail.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from dataclasses import dataclass, field
from typing import List, Optional

logger = logging.getLogger(__name__)

from core.components.context_compressor.engine import ContextCompressorEngine


# ---------------------------------------------------------------------------
# Priority constants — higher value = survives compression longer
# ---------------------------------------------------------------------------

PRIORITY_CRITICAL = 10     # executor_output / original_context
PRIORITY_METADATA = 8      # execution_metadata, action_args
PRIORITY_TRAJECTORY = 5    # trajectory items
PRIORITY_MEMORY = 3        # memory context
PRIORITY_CAUSAL = 2        # causal links
PRIORITY_LOW = 1           # shared insights, extra fields


# ---------------------------------------------------------------------------
# ContextNode
# ---------------------------------------------------------------------------

@dataclass
class ContextNode:
    """Single unit of context in the chain."""

    content: str
    priority: int
    label: str
    compressed: bool = False
    pin: bool = False
    char_count: int = field(init=False)

    def __post_init__(self) -> None:
        self.char_count = len(self.content)


# ---------------------------------------------------------------------------
# ContextChain
# ---------------------------------------------------------------------------

class ContextChain:
    """Priority-aware context accumulator with preemptive background compression.

    Usage::

        chain = ContextChain(budget_chars=480_000)
        chain.append(executor_output, priority=10, label="executor_output")
        chain.append(memory_text,     priority=3,  label="memory")
        ...
        context_str = await chain.materialize()  # or chain.materialize_sync()
    """

    DEFAULT_TRIGGER_RATIO = float(
        os.environ.get("VINV_ENGINE_COMPRESS_TRIGGER_RATIO", "0.85")
    )

    def __init__(
        self,
        budget_chars: int,
        trigger_ratio: float = DEFAULT_TRIGGER_RATIO,
        purpose: str = "general",
    ) -> None:
        self._nodes: List[ContextNode] = []
        self._budget = max(budget_chars, 1)
        self._trigger_ratio = trigger_ratio
        self._purpose = purpose
        self._total_chars = 0

        self._compress_task: Optional[asyncio.Task] = None  # type: ignore[type-arg]
        self._lock = threading.Lock()
        self._compressed_once = False

    # ------------------------------------------------------------------
    # Append
    # ------------------------------------------------------------------

    def append(self, content: str, priority: int, label: str, pin: bool = False) -> None:
        """Append a node.  Kicks off background compression when threshold is hit."""
        if not isinstance(content, str):
            content = json.dumps(content, default=str) if isinstance(content, (dict, list)) else str(content)
        if not content or not content.strip():
            return

        node = ContextNode(content=content, priority=priority, label=label, pin=pin)
        with self._lock:
            self._nodes.append(node)
            self._total_chars += node.char_count

        if self._should_trigger():
            logger.info("ContextChain: triggering background compression (total_chars=%d, budget=%d)", self._total_chars, self._budget)
            self._fire_background_compress()

    # ------------------------------------------------------------------
    # Size helpers
    # ------------------------------------------------------------------

    def total_chars(self) -> int:
        return self._total_chars

    def _should_trigger(self) -> bool:
        return (
            self._total_chars > int(self._budget * self._trigger_ratio)
            and not self._compressed_once
            and self._compress_task is None
        )

    # ------------------------------------------------------------------
    # Background compression
    # ------------------------------------------------------------------

    def _fire_background_compress(self) -> None:
        """Schedule compression on the running event loop (fire-and-forget)."""
        try:
            loop = asyncio.get_running_loop()
            self._compress_task = loop.create_task(self._compress_async())
        except RuntimeError:
            pass  # no running loop — materialize() will handle it synchronously

    async def _compress_async(self) -> None:
        """Compress nodes via UnifiedCompressor directly on the event loop.

        Previous implementation nested 3 thread layers:
          asyncio.to_thread(_compress_sync) → compress_with_priority() →
          ThreadPoolExecutor(asyncio.run(compress())) → asyncio.to_thread(DSPy)
        Now we call UnifiedCompressor.compress() (already async) directly,
        keeping only the single to_thread layer for the blocking DSPy call.
        """
        try:
            logger.debug("ContextChain._compress_async: starting background compression")

            with self._lock:
                snapshot = list(self._nodes)
                snapshot_len = len(snapshot)

            if not snapshot:
                logger.debug("ContextChain._compress_async: no nodes to compress")
                self._compressed_once = True
                self._compress_task = None
                return

            pinned = [n for n in snapshot if n.pin]
            compressible = [n for n in snapshot if not n.pin]
            pinned_chars = sum(n.char_count for n in pinned)
            compress_budget = max(self._budget - pinned_chars, 1)

            compressible_chars = sum(n.char_count for n in compressible)
            logger.info(
                "ContextChain._compress_async: compressing %d nodes "
                "(total_chars=%d, budget=%d, pinned=%d, purpose=%s)",
                len(compressible), compressible_chars,
                compress_budget, len(pinned), self._purpose,
            )

            if compressible_chars <= compress_budget:
                logger.debug("ContextChain._compress_async: within budget after pinned exclusion, skipping")
                self._compressed_once = True
                self._compress_task = None
                return

            joined = "\n\n".join(n.content for n in compressible if n.content)
            chars_per_token = int(os.environ.get("VINV_ENGINE_CHARS_PER_TOKEN", "4"))
            target_tokens = max(1, compress_budget // chars_per_token)

            from core.components.context_compressor.unified_compression import (
                get_global_compressor,
            )
            compressor = get_global_compressor()
            compressed_content = await compressor.compress(
                joined,
                max_tokens=target_tokens,
                purpose=f"for_context_chain_{self._purpose}",
            )

            merged = ContextNode(
                content=compressed_content,
                priority=PRIORITY_CRITICAL,
                label="compressed",
                compressed=True,
            )

            with self._lock:
                tail = self._nodes[snapshot_len:]
                self._nodes = pinned + [merged] + tail
                self._total_chars = sum(n.char_count for n in self._nodes)

            logger.debug("ContextChain._compress_async: compression complete")
            self._compressed_once = True

        except Exception as exc:
            logger.warning("ContextChain._compress_async: compression failed (best-effort): %s", exc)
        finally:
            self._compress_task = None

    def _compress_sync(self) -> None:
        """Snapshot current nodes, compress, and atomically replace them.

        Pinned nodes are extracted before compression and reattached after,
        so they survive unconditionally regardless of priority.
        """
        with self._lock:
            snapshot = list(self._nodes)
            snapshot_len = len(snapshot)

        if not snapshot:
            logger.debug("ContextChain._compress_sync: no nodes to compress")
            return

        pinned = [n for n in snapshot if n.pin]
        compressible = [n for n in snapshot if not n.pin]
        pinned_chars = sum(n.char_count for n in pinned)
        compress_budget = max(self._budget - pinned_chars, 1)

        logger.info(
            "ContextChain._compress_sync: compressing %d nodes "
            "(total_chars=%d, budget=%d, pinned=%d, purpose=%s)",
            len(compressible), sum(n.char_count for n in compressible),
            compress_budget, len(pinned), self._purpose,
        )
        compressed_content = ContextCompressorEngine.compress_with_priority(
            compressible, compress_budget, purpose=self._purpose,
        )

        merged = ContextNode(
            content=compressed_content,
            priority=PRIORITY_CRITICAL,
            label="compressed",
            compressed=True,
        )

        with self._lock:
            tail = self._nodes[snapshot_len:]
            self._nodes = pinned + [merged] + tail
            self._total_chars = sum(n.char_count for n in self._nodes)

    # ------------------------------------------------------------------
    # Materialize — called once right before the LLM call
    # ------------------------------------------------------------------

    async def materialize(self) -> str:
        """Return the final context string, awaiting any in-flight compression."""
        logger.debug("ContextChain.materialize: awaiting in-flight compression")
        if self._compress_task is not None:
            try:
                await self._compress_task
            except Exception:
                pass

        result = self._materialize_final()
        logger.debug("ContextChain.materialize: result %d chars", len(result))
        return result

    def materialize_sync(self) -> str:
        """Synchronous fallback when there is no running event loop."""
        if not self._compressed_once and self._total_chars > self._budget:
            self._compress_sync()
        return self._materialize_final()

    def _materialize_final(self) -> str:
        """Join nodes, applying a hard-cap safety net if still over budget."""
        with self._lock:
            nodes = list(self._nodes)

        parts = [n.content for n in nodes if n.content]
        result = "\n\n".join(parts)

        if len(result) > self._budget:
            result = self._hard_cap(result, nodes)

        return result

    def _hard_cap(self, text: str, nodes: List[ContextNode]) -> str:
        """Last-resort compression that respects priority ordering.

        Drops lowest-priority content first. Pinned nodes are never dropped.
        If the remaining content still exceeds the budget, delegates to
        UnifiedCompressor for LLM-based intelligent compression (NEVER truncates).
        """
        sorted_nodes = sorted(nodes, key=lambda n: n.priority)

        budget = self._budget
        drop_chars = len(text) - budget
        if drop_chars <= 0:
            return text

        kept: List[ContextNode] = list(nodes)
        for node in sorted_nodes:
            if drop_chars <= 0:
                break
            if node.priority >= PRIORITY_CRITICAL:
                break
            if node.pin:
                continue
            drop_chars -= node.char_count
            kept.remove(node)

        result = "\n\n".join(n.content for n in kept if n.content)

        if len(result) > budget:
            logger.info("ContextChain._hard_cap: still over budget after priority drop, using LLM compression")
            result = self._llm_compress_overflow(result, budget)

        return result

    def _llm_compress_overflow(self, content: str, budget_chars: int) -> str:
        """Use UnifiedCompressor (LLM AIOC) to compress content within budget.

        Called when priority-based node dropping alone is insufficient.
        Falls back to returning content as-is if compression is unavailable
        (never truncates).
        """
        import os

        chars_per_token = int(os.environ.get("VINV_ENGINE_CHARS_PER_TOKEN", "4"))

        try:
            from core.components.context_compressor.unified_compression import (
                get_global_compressor,
            )

            compressor = get_global_compressor()
            target_tokens = max(1, budget_chars // chars_per_token)

            return compressor.compress_sync(
                content,
                max_tokens=target_tokens,
                task_description=(
                    "Compress context to fit within budget while preserving "
                    "all critical information, references, and actionable data"
                ),
                purpose="for_context_chain_budget",
            )
        except ImportError:
            logger.debug("UnifiedCompressor unavailable — returning content as-is")
            return content
        except Exception:
            logger.exception("LLM compression failed in _llm_compress_overflow")
            return content

    # ------------------------------------------------------------------
    # Label-based retrieval & removal
    # ------------------------------------------------------------------

    def get_nodes_by_label(self, label: str) -> List[ContextNode]:
        """Return all nodes matching *label*."""
        with self._lock:
            return [n for n in self._nodes if n.label == label]

    def get_content_by_label(self, label: str) -> str:
        """Return the concatenated content of all nodes matching *label*."""
        nodes = self.get_nodes_by_label(label)
        return "\n\n".join(n.content for n in nodes if n.content)

    def remove_by_label(self, label: str) -> int:
        """Remove all nodes matching *label*. Returns count of removed nodes."""
        with self._lock:
            before = len(self._nodes)
            self._nodes = [n for n in self._nodes if n.label != label]
            removed = before - len(self._nodes)
            if removed:
                self._total_chars = sum(n.char_count for n in self._nodes)
            return removed

    def replace_by_label(self, label: str, content: str, priority: int) -> None:
        """Remove all nodes matching *label* and append a new node with the given content."""
        self.remove_by_label(label)
        if content and content.strip():
            self.append(content, priority, label)

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def stats(self) -> dict:
        with self._lock:
            return {
                "node_count": len(self._nodes),
                "total_chars": self._total_chars,
                "budget": self._budget,
                "utilization_pct": round(self._total_chars / self._budget * 100, 1),
                "compressed": self._compressed_once,
                "labels": [n.label for n in self._nodes],
            }
