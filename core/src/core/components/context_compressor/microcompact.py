"""Vinv Engine / components / context_compressor / microcompact — Strategy 1: Local dedup/trimming.

Zero-LLM-cost compression that runs before every DSPy call.
Removes redundancy accumulated between real compression passes:
  1. Deduplicate consecutive identical content blocks
  2. Replace completed-task inline output with ledger references
  3. Trim stale trajectory steps (keep last 3 + count)
  4. Collapse repeated tool-call patterns (3+ similar → summary)

MUST be idempotent: microcompact(microcompact(x)) == microcompact(x)
MUST be synchronous and fast: no LLM calls, no I/O.
"""

from __future__ import annotations

import logging
import re
from typing import Any, TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from core.components.hero.models import ContextLedger

logger = logging.getLogger(__name__)

_TRAJECTORY_STEP_RE = re.compile(
    r"(?:^|\n)"
    r"((?:(?:thought|action|observation|tool_call|tool_result|step)"
    r"[_\s]*\d+[:\s].*?))"
    r"(?=\n(?:thought|action|observation|tool_call|tool_result|step)[_\s]*\d+[:\s]|\Z)",
    re.IGNORECASE | re.DOTALL,
)

_TOOL_CALL_RE = re.compile(
    r"\[?(?:tool[_\s]*call|action)[:\s]*(\w+)\s*(?:\(([^)]*)\)|[\s:]+(.+?))"
    r"(?:\]|\n|$)",
    re.IGNORECASE,
)

_TASK_OUTPUT_BLOCK_RE = re.compile(
    r"(?:^|\n)(?:##?\s*)?(?:Task\s+)?(?:Output|Result)\s+(?:for\s+)?(?:task\s+)?[\"']?(\S+?)[\"']?\s*[:=\n]"
    r"(.*?)(?=\n##|\n(?:Task\s+)?(?:Output|Result)\s+(?:for\s+)?(?:task\s+)?|\Z)",
    re.IGNORECASE | re.DOTALL,
)


def microcompact(content: str, ledger: Optional["ContextLedger"] = None) -> str:
    """Fast, local-only compression. No LLM calls.

    Returns content with redundancy removed.
    Idempotent: microcompact(microcompact(x)) == microcompact(x)
    """
    if not content or not content.strip():
        return content

    original_len = len(content)

    content = _dedup_consecutive_blocks(content)
    content = _replace_completed_task_outputs(content, ledger)
    content = _trim_stale_trajectory_steps(content)
    content = _collapse_repeated_tool_calls(content)

    compressed_len = len(content)
    saved = original_len - compressed_len
    if saved > 0:
        logger.debug(
            "microcompact: removed %d chars (%.1f%% reduction)",
            saved,
            saved / original_len * 100,
        )

    return content


def _dedup_consecutive_blocks(content: str) -> str:
    """Remove consecutive identical content blocks.

    Splits on double-newlines (block boundaries) and removes adjacent
    duplicates. Already-deduped content is unchanged (idempotent).
    """
    blocks = content.split("\n\n")
    if len(blocks) <= 1:
        return content

    deduped: list[str] = [blocks[0]]
    for block in blocks[1:]:
        stripped = block.strip()
        if not stripped:
            continue
        if stripped != deduped[-1].strip():
            deduped.append(block)

    return "\n\n".join(deduped)


def _replace_completed_task_outputs(
    content: str, ledger: Optional["ContextLedger"],
) -> str:
    """Replace inline task outputs with ledger references when task is COMPLETE.

    If a task's full output appears inline AND the task is recorded as complete
    in the ledger, replace with a 1-line pointer. Skips if no ledger provided.
    """
    if ledger is None:
        return content

    try:
        entries = ledger.get_all()
    except Exception:
        return content

    for entry in entries:
        if not getattr(entry, "success", False):
            continue
        task_id = getattr(entry, "task_id", "")
        if not task_id:
            continue

        ref_line = f"[Task {task_id} output: see ledger]"
        if ref_line in content:
            continue

        raw_output_str = getattr(entry, "content", "")
        if raw_output_str and len(raw_output_str) > 100 and raw_output_str in content:
            content = content.replace(raw_output_str, ref_line, 1)

    return content


def _trim_stale_trajectory_steps(content: str) -> str:
    """For trajectory data with >5 steps, keep only last 3 + omission count.

    Handles common trajectory formats:
    - thought_N: / action_N: / observation_N:
    - step_N: / tool_call_N: / tool_result_N:
    """
    matches = _TRAJECTORY_STEP_RE.findall(content)
    if len(matches) <= 5:
        return content

    keep_count = 3
    omitted = len(matches) - keep_count
    steps_to_remove = matches[:omitted]

    omission_marker = f"[{omitted} earlier steps omitted]"
    if omission_marker in content:
        return content

    for step in steps_to_remove:
        content = content.replace(step, "", 1)

    content = content.lstrip("\n")
    content = omission_marker + "\n" + content

    content = re.sub(r"\n{3,}", "\n\n", content)

    return content


def _collapse_repeated_tool_calls(content: str) -> str:
    """Collapse 3+ consecutive identical tool calls into a summary.

    e.g., 5 consecutive `navigate` calls → `[navigate x5, last: {url}]`
    """
    matches = list(_TOOL_CALL_RE.finditer(content))
    if len(matches) < 3:
        return content

    groups: list[list[re.Match]] = []
    current_group: list[re.Match] = [matches[0]]

    for m in matches[1:]:
        if m.group(1).lower() == current_group[-1].group(1).lower():
            current_group.append(m)
        else:
            groups.append(current_group)
            current_group = [m]
    groups.append(current_group)

    replacements: list[tuple[str, str]] = []
    for group in groups:
        if len(group) < 3:
            continue

        tool_name = group[0].group(1)
        last_match = group[-1]
        last_args = (last_match.group(2) or last_match.group(3) or "").strip()

        summary = f"[{tool_name} x{len(group)}, last: {last_args}]" if last_args else f"[{tool_name} x{len(group)}]"

        if summary in content:
            continue

        full_text = content[group[0].start():group[-1].end()]
        replacements.append((full_text, summary))

    for old, new in replacements:
        content = content.replace(old, new, 1)

    return content


# ---------------------------------------------------------------------------
# Dict-based trajectory compaction (for DSPy ReAct trajectory dicts)
# ---------------------------------------------------------------------------

_OBS_COMPACT_LIMIT = 2000
_ARGS_COMPACT_LIMIT = 200


def microcompact_trajectory_dict(
    trajectory: dict[str, Any],
    keep_recent: int = 3,
) -> dict[str, Any]:
    """Compact a DSPy ReAct trajectory dict.

    Operates natively on the ``{thought_N, tool_name_N, tool_args_N,
    observation_N}`` structure without a format-then-parse round-trip.

    * Keeps the last *keep_recent* steps fully intact.
    * Older steps: truncates ``observation_N`` to *_OBS_COMPACT_LIMIT*
      (2000) chars and ``tool_args_N`` to *_ARGS_COMPACT_LIMIT* (200) chars.
    * Collapses consecutive identical tool calls into a summary.
    * Prepends a ``[N earlier steps compacted]`` marker as
      ``thought_0`` (idempotent — skipped if already present).

    Idempotent: ``microcompact_trajectory_dict(microcompact_trajectory_dict(t)) == microcompact_trajectory_dict(t)``
    Synchronous and fast: no LLM calls, no I/O.
    """
    if not trajectory:
        return trajectory

    max_step = _max_step_index(trajectory)
    if max_step < 0:
        return trajectory

    total_steps = max_step + 1
    if total_steps <= keep_recent:
        return trajectory

    compact_boundary = total_steps - keep_recent
    compacted = dict(trajectory)

    collapsed_runs: list[tuple[str, int]] = []
    prev_tool: str | None = None
    run_count = 0

    for i in range(compact_boundary):
        tool = str(compacted.get(f"tool_name_{i}", ""))

        obs_key = f"observation_{i}"
        if obs_key in compacted:
            obs = str(compacted[obs_key])
            if len(obs) > _OBS_COMPACT_LIMIT and not obs.startswith("[compacted"):
                compacted[obs_key] = obs[:_OBS_COMPACT_LIMIT] + "... [compacted]"

        args_key = f"tool_args_{i}"
        if args_key in compacted:
            args_val = compacted[args_key]
            if isinstance(args_val, dict):
                args_str = str(args_val)
                if len(args_str) > _ARGS_COMPACT_LIMIT:
                    compacted[args_key] = {
                        "_compacted": True,
                        "keys": list(args_val.keys()),
                    }
            elif isinstance(args_val, str) and len(args_val) > _ARGS_COMPACT_LIMIT:
                compacted[args_key] = args_val[:_ARGS_COMPACT_LIMIT] + "..."

        if tool == prev_tool:
            run_count += 1
        else:
            if prev_tool and run_count >= 3:
                collapsed_runs.append((prev_tool, run_count))
            prev_tool = tool
            run_count = 1

    if prev_tool and run_count >= 3:
        collapsed_runs.append((prev_tool, run_count))

    marker = f"[{compact_boundary} earlier steps compacted]"
    thought_0 = str(compacted.get("thought_0", ""))
    if not thought_0.startswith("[") or "compacted]" not in thought_0:
        collapse_note = ""
        if collapsed_runs:
            parts = [f"{name} x{cnt}" for name, cnt in collapsed_runs]
            collapse_note = f" (collapsed: {', '.join(parts)})"
        compacted["thought_0"] = marker + collapse_note

    return compacted


def _max_step_index(trajectory: dict[str, Any]) -> int:
    """Find the highest step index N across thought_N / tool_name_N keys."""
    mx = -1
    for key in trajectory:
        for prefix in ("thought_", "tool_name_", "observation_"):
            if key.startswith(prefix):
                try:
                    mx = max(mx, int(key[len(prefix):]))
                except ValueError:
                    pass
    return mx
