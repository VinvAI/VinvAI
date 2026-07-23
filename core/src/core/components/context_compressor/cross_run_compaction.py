"""Vinv Engine / components / context_compressor / cross_run_compaction — Strategy 4.

Extracts durable knowledge from a completed pipeline run:
lessons learned, failure patterns, successful strategies, and artifacts.

Unlike the other 3 strategies, this is not about fitting into a context
window — it's about extracting signal from noise for long-term learning.
The output is injected into future runs via RunHistoryEngine.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)

try:
    import dspy
    DSPY_AVAILABLE = True
except ImportError:
    DSPY_AVAILABLE = False


@dataclass
class RunCompactionSummary:
    """Structured output of cross-run compaction."""
    lessons: list[str] = field(default_factory=list)
    pitfalls: list[str] = field(default_factory=list)
    successful_strategies: list[str] = field(default_factory=list)
    artifacts_created: list[str] = field(default_factory=list)
    goal_achieved: bool = False
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "lessons": self.lessons,
            "pitfalls": self.pitfalls,
            "successful_strategies": self.successful_strategies,
            "artifacts_created": self.artifacts_created,
            "goal_achieved": self.goal_achieved,
            "summary": self.summary,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunCompactionSummary":
        return cls(
            lessons=data.get("lessons", []),
            pitfalls=data.get("pitfalls", []),
            successful_strategies=data.get("successful_strategies", []),
            artifacts_created=data.get("artifacts_created", []),
            goal_achieved=data.get("goal_achieved", False),
            summary=data.get("summary", ""),
        )

    def render_for_prompt(self) -> str:
        parts: list[str] = []
        if self.summary:
            parts.append(f"Summary: {self.summary}")
        if self.lessons:
            parts.append("Lessons: " + "; ".join(self.lessons))
        if self.pitfalls:
            parts.append("Pitfalls: " + "; ".join(self.pitfalls))
        if self.successful_strategies:
            parts.append("Strategies that worked: " + "; ".join(self.successful_strategies))
        if self.artifacts_created:
            parts.append("Artifacts: " + ", ".join(self.artifacts_created))
        return "\n".join(parts)


if DSPY_AVAILABLE:

    class RunCompactionSignature(dspy.Signature):
        """Extract durable lessons from a completed pipeline run."""

        goal: str = dspy.InputField()
        task_outcomes: str = dspy.InputField(
            desc="JSON array of {task_name, status, output_summary, error}",
        )
        trajectory_summary: str = dspy.InputField(
            desc="High-level execution trajectory",
        )

        lessons: list[str] = dspy.OutputField(
            desc="What was learned that applies to future similar goals",
        )
        pitfalls: list[str] = dspy.OutputField(
            desc="Failure patterns to avoid",
        )
        successful_strategies: list[str] = dspy.OutputField(
            desc="Approaches that worked well",
        )
        artifacts: list[str] = dspy.OutputField(
            desc="File paths, URLs, endpoints created or discovered",
        )
        summary: str = dspy.OutputField(
            desc="2-3 sentence summary of what happened",
        )


async def compact_run(
    batch_result: dict,
    goal: str,
    max_tokens: int = 2000,
) -> RunCompactionSummary:
    """Compress a completed pipeline run into durable knowledge.

    Output is injected into future runs via _run_history.render_recent_for_prompt().
    Falls back to heuristic extraction when DSPy/LLM is unavailable.
    """
    task_outcomes = _extract_task_outcomes(batch_result)
    trajectory_summary = _extract_trajectory_summary(batch_result)
    artifacts = _extract_artifacts(batch_result)

    all_succeeded = all(t.get("status") == "success" for t in task_outcomes)

    if DSPY_AVAILABLE:
        try:
            return await _compact_with_dspy(
                goal, task_outcomes, trajectory_summary, artifacts, all_succeeded,
            )
        except Exception as exc:
            logger.warning("cross_run_compaction DSPy failed, using heuristic: %s", exc)

    return _compact_heuristic(goal, task_outcomes, trajectory_summary, artifacts, all_succeeded)


async def _compact_with_dspy(
    goal: str,
    task_outcomes: list[dict],
    trajectory_summary: str,
    artifacts: list[str],
    all_succeeded: bool,
) -> RunCompactionSummary:
    """Use DSPy LLM to extract structured knowledge from the run."""
    compactor = dspy.ChainOfThought(RunCompactionSignature)

    outcomes_str = json.dumps(task_outcomes, indent=2, default=str)

    result = await asyncio.to_thread(
        compactor,
        goal=goal,
        task_outcomes=outcomes_str,
        trajectory_summary=trajectory_summary,
    )

    lessons = _to_string_list(getattr(result, "lessons", []))
    pitfalls = _to_string_list(getattr(result, "pitfalls", []))
    strategies = _to_string_list(getattr(result, "successful_strategies", []))
    dspy_artifacts = _to_string_list(getattr(result, "artifacts", []))
    summary = str(getattr(result, "summary", ""))

    merged_artifacts = list(set(artifacts + dspy_artifacts))

    if len(summary) > 500:
        summary = summary[:497] + "..."

    return RunCompactionSummary(
        lessons=lessons,
        pitfalls=pitfalls,
        successful_strategies=strategies,
        artifacts_created=merged_artifacts,
        goal_achieved=all_succeeded,
        summary=summary,
    )


def _compact_heuristic(
    goal: str,
    task_outcomes: list[dict],
    trajectory_summary: str,
    artifacts: list[str],
    all_succeeded: bool,
) -> RunCompactionSummary:
    """Heuristic-based compaction without LLM. Extracts what it can from structure."""
    succeeded = [t for t in task_outcomes if t.get("status") == "success"]
    failed = [t for t in task_outcomes if t.get("status") != "success"]

    lessons: list[str] = []
    pitfalls: list[str] = []
    strategies: list[str] = []

    if failed:
        for t in failed:
            err = t.get("error", "unknown error")
            pitfalls.append(f"{t.get('task_name', 'unknown')}: {err[:200]}")
        lessons.append(f"{len(failed)}/{len(task_outcomes)} tasks failed")

    if succeeded:
        strategies.append(f"{len(succeeded)}/{len(task_outcomes)} tasks completed successfully")

    status = "achieved" if all_succeeded else "partially achieved"
    summary = f"Goal '{goal[:100]}' was {status}. {len(succeeded)}/{len(task_outcomes)} tasks succeeded."
    if len(summary) > 500:
        summary = summary[:497] + "..."

    return RunCompactionSummary(
        lessons=lessons,
        pitfalls=pitfalls,
        successful_strategies=strategies,
        artifacts_created=artifacts,
        goal_achieved=all_succeeded,
        summary=summary,
    )


def _extract_task_outcomes(batch_result: dict) -> list[dict]:
    """Extract task outcomes from a HeroBatchResult payload."""
    outcomes: list[dict] = []
    episodes = batch_result.get("episodes", [])
    for ep in episodes:
        task_name = ep.get("task_name", ep.get("task_id", "unknown"))
        success = ep.get("success", False)
        error = ep.get("error", "")
        output = ep.get("executor_output", {})
        output_summary = ""
        if isinstance(output, dict):
            output_summary = output.get("output_summary", output.get("result", ""))
            if not output_summary:
                output_summary = str(output)[:300]
        elif isinstance(output, str):
            output_summary = output[:300]

        outcomes.append({
            "task_name": task_name,
            "status": "success" if success else "failed",
            "output_summary": output_summary,
            "error": str(error)[:300] if error else "",
        })
    return outcomes


def _extract_trajectory_summary(batch_result: dict) -> str:
    """Build high-level trajectory summary from episodes."""
    parts: list[str] = []
    for ep in batch_result.get("episodes", []):
        task_name = ep.get("task_name", ep.get("task_id", "?"))
        actor = ep.get("actor_used", "?")
        traj = ep.get("trajectory_summary", "")
        retries = ep.get("retry_count", 0)
        success = ep.get("success", False)
        status = "OK" if success else "FAILED"
        line = f"- {task_name} ({actor}): {status}"
        if retries:
            line += f" [{retries} retries]"
        if traj:
            line += f" — {traj[:150]}"
        parts.append(line)
    return "\n".join(parts) if parts else "No trajectory data available."


def _extract_artifacts(batch_result: dict) -> list[str]:
    """Extract file paths and URLs from batch results."""
    artifacts: set[str] = set()
    text = json.dumps(batch_result, default=str)

    for prefix in ("https://", "http://"):
        start = 0
        while True:
            idx = text.find(prefix, start)
            if idx == -1:
                break
            end = idx + len(prefix)
            while end < len(text) and text[end] not in ' \t\n\r\'"<>,)':
                end += 1
            url = text[idx:end]
            if len(url) > len(prefix):
                artifacts.add(url)
            start = end

    for marker in ("/home/", "/Users/", "/tmp/", "/var/", "/opt/"):
        start = 0
        while True:
            idx = text.find(marker, start)
            if idx == -1:
                break
            end = idx
            while end < len(text) and text[end] not in ' \t\n\r\'"<>,)':
                end += 1
            path = text[idx:end]
            dot = path.rfind(".")
            if dot != -1 and dot < len(path) - 1:
                ext = path[dot + 1:]
                if 1 <= len(ext) <= 5 and ext.isalnum():
                    artifacts.add(path)
            start = end

    return sorted(artifacts)


def _to_string_list(value: Any) -> list[str]:
    """Coerce DSPy output to a list of strings."""
    if isinstance(value, list):
        return [str(v) for v in value if v]
    if isinstance(value, str):
        if value.startswith("["):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, list):
                    return [str(v) for v in parsed if v]
            except (json.JSONDecodeError, ValueError):
                pass
        return [v.strip() for v in value.split(";") if v.strip()]
    return []
