"""Vinv Engine / components / context_compressor / ptl_recovery — Strategy 3: Graduated PTL recovery.

Emergency recovery from context-length (prompt-too-long) errors.
Tries cheapest strategies first, escalates only if needed:

  Level 1: microcompact + drop priority <= 3 nodes           (0 LLM calls)
  Level 2: drop architect guidance, run history, enrichment   (0 LLM calls)
  Level 3: LLM-compress remaining to 60% of limit            (1 LLM call)
  Level 4: Nuclear — keep only task desc + goal + last error  (0 LLM calls)
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, List, Optional

if TYPE_CHECKING:
    from core.components.context_compressor.chain import ContextNode

logger = logging.getLogger(__name__)

_CHARS_PER_TOKEN = int(os.environ.get("VINV_ENGINE_CHARS_PER_TOKEN", "4"))

_LEVEL2_DROP_LABELS = frozenset({
    "architect_guidance",
    "run_history",
    "enrichment_context",
    "available_actors",
    "active_agent_context",
    "workspace_files",
    "contingency_approach",
    "q_learning_advisory",
    "skill_manual",
})

_NUCLEAR_KEEP_LABELS = frozenset({
    "task_description",
    "goal",
    "output_format_constraint",
})


@dataclass
class PTLRecoveryResult:
    content: str
    level_reached: int
    tokens_before: int
    tokens_after: int
    dropped_labels: list[str] = field(default_factory=list)


def _estimate_tokens(text: str) -> int:
    try:
        from core.components.context_compressor.token_utils import count_tokens
        return count_tokens(text)
    except ImportError:
        return len(text) // _CHARS_PER_TOKEN + 1


def _nodes_to_content(nodes: List["ContextNode"]) -> str:
    return "\n\n".join(n.content for n in nodes if n.content)


async def recover_from_ptl(
    nodes: List["ContextNode"],
    budget_tokens: int,
    model_id: str | None = None,
) -> PTLRecoveryResult:
    """Graduated context recovery after prompt-too-long error.

    Tries cheapest strategies first, escalates only if needed.
    Each level is attempted in order; if tokens drop below budget, we stop.
    """
    from core.components.context_compressor.microcompact import microcompact

    original_content = _nodes_to_content(nodes)
    tokens_before = _estimate_tokens(original_content)
    dropped_labels: list[str] = []

    # --- Level 1: microcompact + drop priority <= 3 ---
    level1_nodes: list["ContextNode"] = []
    for n in nodes:
        if n.priority <= 3 and not n.pin:
            dropped_labels.append(n.label)
        else:
            level1_nodes.append(n)

    content = _nodes_to_content(level1_nodes)
    content = microcompact(content)
    tokens_after = _estimate_tokens(content)

    logger.debug(
        "ptl_recovery level 1: %d → %d tokens (budget=%d, dropped=%d labels)",
        tokens_before, tokens_after, budget_tokens, len(dropped_labels),
    )

    if tokens_after <= budget_tokens:
        return PTLRecoveryResult(
            content=content,
            level_reached=1,
            tokens_before=tokens_before,
            tokens_after=tokens_after,
            dropped_labels=dropped_labels,
        )

    # --- Level 2: drop architect guidance, run history, enrichment ---
    level2_nodes: list["ContextNode"] = []
    for n in level1_nodes:
        if n.label in _LEVEL2_DROP_LABELS and not n.pin:
            dropped_labels.append(n.label)
        else:
            level2_nodes.append(n)

    content = _nodes_to_content(level2_nodes)
    tokens_after = _estimate_tokens(content)

    logger.debug(
        "ptl_recovery level 2: %d tokens (budget=%d, dropped=%d labels)",
        tokens_after, budget_tokens, len(dropped_labels),
    )

    if tokens_after <= budget_tokens:
        return PTLRecoveryResult(
            content=content,
            level_reached=2,
            tokens_before=tokens_before,
            tokens_after=tokens_after,
            dropped_labels=dropped_labels,
        )

    # --- Level 3: LLM-compress remaining to 60% of limit ---
    # Pinned nodes are extracted before compression and re-attached verbatim
    # afterwards — they survive unconditionally at every level.
    pinned_content = _nodes_to_content([n for n in level2_nodes if n.pin])
    unpinned_content = _nodes_to_content([n for n in level2_nodes if not n.pin])
    pinned_tokens = _estimate_tokens(pinned_content) if pinned_content else 0
    target_tokens = max(1, int(budget_tokens * 0.60) - pinned_tokens)
    try:
        from core.components.context_compressor.unified_compression import (
            get_global_compressor,
        )
        compressor = get_global_compressor()
        compressed = await compressor.compress(
            unpinned_content,
            max_tokens=target_tokens,
            task_description=(
                "Emergency compression: preserve task instructions, goals, "
                "error messages, and output format. Aggressively drop "
                "verbose reasoning, trajectory details, and redundant context."
            ),
            purpose="ptl_emergency_recovery",
        )
        content = (
            f"{pinned_content}\n\n{compressed}" if pinned_content else compressed
        )
        tokens_after = _estimate_tokens(content)

        logger.debug(
            "ptl_recovery level 3: %d tokens (budget=%d)",
            tokens_after, budget_tokens,
        )

        if tokens_after <= budget_tokens:
            return PTLRecoveryResult(
                content=content,
                level_reached=3,
                tokens_before=tokens_before,
                tokens_after=tokens_after,
                dropped_labels=dropped_labels,
            )
    except Exception as exc:
        logger.warning("ptl_recovery level 3 LLM compression failed: %s", exc)

    # --- Level 4: Nuclear — keep only task description + goal + last error + output format ---
    nuclear_parts: list[str] = []
    for n in nodes:
        if n.label in _NUCLEAR_KEEP_LABELS or n.pin:
            nuclear_parts.append(n.content)

    last_error = _extract_last_error(nodes)
    if last_error:
        nuclear_parts.append(f"## Last Error\n{last_error}")

    content = "\n\n".join(p for p in nuclear_parts if p)
    if not content:
        content = "Execute the assigned task."

    tokens_after = _estimate_tokens(content)

    all_labels = {n.label for n in nodes}
    kept_labels = _NUCLEAR_KEEP_LABELS | {"pinned"}
    dropped_labels = list(all_labels - kept_labels)

    logger.warning(
        "ptl_recovery level 4 (nuclear): %d → %d tokens (budget=%d)",
        tokens_before, tokens_after, budget_tokens,
    )

    return PTLRecoveryResult(
        content=content,
        level_reached=4,
        tokens_before=tokens_before,
        tokens_after=tokens_after,
        dropped_labels=dropped_labels,
    )


def recover_from_ptl_sync(
    nodes: List["ContextNode"],
    budget_tokens: int,
    model_id: str | None = None,
) -> PTLRecoveryResult:
    """Synchronous wrapper for recover_from_ptl.

    Runs the async version in a new thread with its own event loop to
    avoid deadlocking the caller's event loop.
    """
    import concurrent.futures

    async def _run():
        return await recover_from_ptl(nodes, budget_tokens, model_id)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(asyncio.run, _run())
            return future.result()
    else:
        return asyncio.run(_run())


def recover_from_ptl_string_fallback(
    prompt: str, budget_tokens: int,
) -> PTLRecoveryResult:
    """Fallback for when ContextNode list is unavailable.

    Applies microcompact, then truncates with head+tail preservation
    if still over budget.
    """
    from core.components.context_compressor.microcompact import microcompact

    tokens_before = _estimate_tokens(prompt)
    content = microcompact(prompt)
    tokens_after = _estimate_tokens(content)

    if tokens_after <= budget_tokens:
        return PTLRecoveryResult(
            content=content,
            level_reached=1,
            tokens_before=tokens_before,
            tokens_after=tokens_after,
        )

    budget_chars = budget_tokens * _CHARS_PER_TOKEN
    from core.components.context_compressor import _token_aware_fit
    content = _token_aware_fit(content, budget_chars, preserve_ends=True)
    tokens_after = _estimate_tokens(content)

    return PTLRecoveryResult(
        content=content,
        level_reached=4,
        tokens_before=tokens_before,
        tokens_after=tokens_after,
        dropped_labels=["string_truncation_fallback"],
    )


def _extract_last_error(nodes: List["ContextNode"]) -> str:
    """Extract the most recent error from node content."""
    for node in reversed(nodes):
        label_lower = node.label.lower()
        if "error" in label_lower or "failure" in label_lower:
            return node.content[:2000]
        content_lower = node.content.lower()
        if "error:" in content_lower or "traceback" in content_lower:
            lines = node.content.split("\n")
            error_lines = []
            capture = False
            for line in reversed(lines):
                if any(k in line.lower() for k in ("error:", "exception:", "traceback")):
                    capture = True
                if capture:
                    error_lines.insert(0, line)
                if len(error_lines) >= 20:
                    break
            if error_lines:
                return "\n".join(error_lines)
    return ""
