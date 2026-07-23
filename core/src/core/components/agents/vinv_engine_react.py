"""Vinv Engine / components / agents / vinv_engine_react — Custom DSPy ReAct with proactive compression.

Subclasses ``dspy.ReAct`` to add post-observation hooks:

1. **Per-tool observation budget** — large observations (browser DOM snapshots)
   are immediately persisted to disk and replaced with a compact preview +
   file-path reference.  Zero LLM cost, sub-millisecond.
2. **Proactive microcompact** — after each tool call, compact older trajectory
   entries so the context window is managed proactively (not just reactively
   on ``ContextWindowExceededError``).
3. **Async background summarization** — while the LLM thinks about step N+1,
   a background task LLM-summarizes step N-1's observation.  Zero added
   latency when the LLM call takes longer than summarization.
4. **Blackboard delta injection** — pull only *new* scratchpad messages and
   stream chunks since the last iteration.  Never dumps the full blackboard;
   uses cursor-based reads for O(delta) cost.
5. **Incremental skill buffer** — collect structured per-step data for
   downstream skill extraction without needing the raw trajectory post-hoc.

DORMANT in the core closure: no caller constructs SharedScratchpad;
VinvEngineReAct is constructed without scratchpad/shared_context
(base_agent.py BaseSwarmAgent.__init__).  Kept as infrastructure for
hero-style orchestration; do not wire into single-agent runtimes
(bringup/handbook) — the sender!=self delta filter makes it a no-op there.

Environment variables:
  VINV_ENGINE_REACT_PROACTIVE_COMPACT_AFTER  — step index after which proactive
      compression begins (default: 1).
  VINV_ENGINE_REACT_COMPACT_KEEP_RECENT — number of recent steps to keep fully
      intact during compaction (default: 3, matching string microcompact).
  VINV_ENGINE_OBS_PERSIST_THRESHOLD — chars above which observations are persisted
      to disk and replaced with a preview (default: 20000).
  VINV_ENGINE_OBS_PERSIST_PREVIEW_CHARS — chars kept inline as preview when an
      observation is persisted (default: 2000, matching _OBS_COMPACT_LIMIT).
  VINV_ENGINE_OBS_BG_SUMMARIZE_AFTER — step index after which async background
      summarization of older observations begins (default: 3, aligned with
      proactive compact).
  VINV_ENGINE_OBS_BG_TARGET_TOKENS — token budget for background observation
      summaries (default: 1000).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional

import dspy
from dspy.predict.react import ReAct

from core.components.context_compressor.microcompact import (
    microcompact_trajectory_dict,
)

if TYPE_CHECKING:
    from core.components.hero.models import SharedContext, SharedScratchpad

logger = logging.getLogger(__name__)

_DEFAULT_COMPACT_AFTER = int(
    os.environ.get("VINV_ENGINE_REACT_PROACTIVE_COMPACT_AFTER", "1")
)
_DEFAULT_KEEP_RECENT = int(
    os.environ.get("VINV_ENGINE_REACT_COMPACT_KEEP_RECENT", "3")
)

_OBS_PERSIST_THRESHOLD = int(
    os.environ.get("VINV_ENGINE_OBS_PERSIST_THRESHOLD", "20000")
)
_OBS_PERSIST_PREVIEW_CHARS = int(
    os.environ.get("VINV_ENGINE_OBS_PERSIST_PREVIEW_CHARS", "2000")
)
_OBS_BG_SUMMARIZE_AFTER = int(
    os.environ.get("VINV_ENGINE_OBS_BG_SUMMARIZE_AFTER", "3")
)
_OBS_BG_TARGET_TOKENS = int(
    os.environ.get("VINV_ENGINE_OBS_BG_TARGET_TOKENS", "1000")
)

DEFAULT_VINV_ENGINE_SHARED_DIR = os.path.join(
    os.path.expanduser("~"), "vinv_engine_shared"
)

# Filesystem-safe run_id fragment for persisted-observation filenames.
_SAFE_RUN_ID_RE = re.compile(r"[^A-Za-z0-9._-]+")


# ---------------------------------------------------------------------------
# ObservationSummarizer — async background LLM compression of stale observations
# ---------------------------------------------------------------------------

class ObservationSummarizer:
    """Schedules background LLM compression of older trajectory observations.

    While the LLM thinks about step N+1, this compresses observation N-1 in
    the background.  Uses ``ContentIngestionPipeline.process`` with a tight
    token budget.  Failures are best-effort — the observation stays as-is.

    Only active in async (``aforward``) contexts.  The sync ``forward`` path
    relies on ``microcompact_trajectory_dict`` alone.
    """

    def __init__(
        self,
        target_tokens: int = _OBS_BG_TARGET_TOKENS,
        start_after_step: int = _OBS_BG_SUMMARIZE_AFTER,
        goal: str = "",
    ) -> None:
        self._target_tokens = target_tokens
        self._start_after_step = start_after_step
        self._goal = goal
        self._pending: list[asyncio.Task] = []
        self._lock = threading.Lock()

    def schedule(self, trajectory: dict[str, Any], current_idx: int) -> None:
        """Fire-and-forget background summarization of observation at ``current_idx - 1``.

        Does nothing if: not enough steps yet, no running event loop,
        or the target observation is already small / already compressed.
        """
        target_idx = current_idx - 1
        if target_idx < self._start_after_step:
            return

        obs_key = f"observation_{target_idx}"
        obs = trajectory.get(obs_key)
        if not obs or not isinstance(obs, str):
            return

        if len(obs) <= self._target_tokens * 4:
            return
        if obs.startswith("[compacted") or "<persisted-output>" in obs:
            return

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        task = loop.create_task(
            self._summarize(trajectory, obs_key, obs)
        )
        with self._lock:
            self._pending.append(task)

    async def _summarize(
        self, trajectory: dict[str, Any], obs_key: str, raw_obs: str,
    ) -> None:
        """Compress a single observation via ContentIngestionPipeline."""
        try:
            from core.components.context_compressor.content_ingestion import (
                ContentIngestionPipeline,
            )
            pipeline = ContentIngestionPipeline()
            result = await pipeline.process(
                content=raw_obs,
                max_tokens=self._target_tokens,
                query="Summarize this tool observation preserving URLs, "
                      "element references, error messages, and key data.",
                goal=self._goal,
                context_type="observation_bg_summary",
            )
            compressed = result.content
            if compressed and len(compressed) < len(raw_obs):
                trajectory[obs_key] = (
                    f"[bg-summarized from {len(raw_obs)} chars]\n{compressed}"
                )
                logger.info(
                    "ObservationSummarizer: %s compressed %d -> %d chars",
                    obs_key, len(raw_obs), len(compressed),
                )
        except Exception as exc:
            logger.debug(
                "ObservationSummarizer: %s failed (best-effort): %s",
                obs_key, exc,
            )

    async def await_pending(self) -> None:
        """Drain all in-flight summarization tasks.  Called before extract."""
        with self._lock:
            tasks = list(self._pending)
            self._pending.clear()

        for task in tasks:
            try:
                await asyncio.wait_for(task, timeout=10.0)
            except (asyncio.TimeoutError, Exception):
                pass


# ---------------------------------------------------------------------------
# Observation persistence — sync, zero-cost budget enforcement
# ---------------------------------------------------------------------------

def cap_large_observation(
    trajectory: dict[str, Any],
    idx: int,
    threshold: int = _OBS_PERSIST_THRESHOLD,
    preview_chars: int = _OBS_PERSIST_PREVIEW_CHARS,
) -> bool:
    """Persist a large observation to disk and replace with a compact preview.

    Returns True if the observation was persisted, False otherwise.
    """
    obs_key = f"observation_{idx}"
    obs = trajectory.get(obs_key)
    if not obs or not isinstance(obs, str):
        return False
    if len(obs) <= threshold:
        return False
    if "<persisted-output>" in obs:
        return False

    from core.components.common.offload_registry import (
        current_run_id,
        register_offload,
    )

    shared_dir = os.environ.get("VINV_ENGINE_SHARED_DIR", DEFAULT_VINV_ENGINE_SHARED_DIR)
    # Filename is keyed by run_id AND step index: a bare obs_step_{idx}.md let a
    # later run silently overwrite an earlier run's file while old trajectories
    # still held <persisted-output> pointers to it.
    run_id = _SAFE_RUN_ID_RE.sub("_", current_run_id())[:80] or "run"
    persist_path = os.path.join(shared_dir, f"obs_step_{run_id}_{idx}.md")

    try:
        os.makedirs(shared_dir, exist_ok=True)
        # errors="replace": observations can carry lone surrogates (terminal
        # output of a binary decoded with surrogateescape); strict UTF-8 would
        # raise UnicodeEncodeError and break the live tool call.
        with open(persist_path, "w", encoding="utf-8", errors="replace") as fh:
            fh.write(f"# Observation Step {idx}\n\n")
            fh.write(obs)
    except (OSError, UnicodeError) as exc:
        logger.warning("cap_large_observation: write failed: %s", exc)
        return False

    register_offload(persist_path, obs, kind="obs_step")

    preview = obs[:preview_chars]
    last_newline = preview.rfind("\n")
    if last_newline > preview_chars // 2:
        preview = preview[:last_newline]

    trajectory[obs_key] = (
        f"<persisted-output>\n"
        f"Output too large ({len(obs):,} chars). "
        f"Full output saved to: {persist_path}\n\n"
        f"Preview (first {len(preview)} chars):\n"
        f"{preview}\n"
        f"</persisted-output>"
    )

    logger.info(
        "cap_large_observation: step %d persisted %d chars -> %s "
        "(preview %d chars)",
        idx, len(obs), persist_path, len(preview),
    )
    return True


class VinvEngineReAct(ReAct):
    """DSPy ReAct with graduated observation compression and live blackboard delta injection."""

    def __init__(
        self,
        signature,
        tools: list[Callable],
        max_iters: int = 50,
        *,
        proactive_compact_after: int = _DEFAULT_COMPACT_AFTER,
        proactive_compact_keep_recent: int = _DEFAULT_KEEP_RECENT,
        scratchpad: "SharedScratchpad | None" = None,
        shared_context: "SharedContext | None" = None,
        goal: str = "",
    ) -> None:
        super().__init__(signature, tools, max_iters)
        self._proactive_compact_after = proactive_compact_after
        self._proactive_compact_keep_recent = proactive_compact_keep_recent
        self._scratchpad = scratchpad
        self._shared_context = shared_context
        self._skill_buffer: list[dict[str, Any]] = []
        self._agent_name: str | None = None
        self._bb_cursor: int = 0
        self._obs_summarizer: Optional[ObservationSummarizer] = None
        self._goal = goal

    # ------------------------------------------------------------------
    # Override: smarter truncation on ContextWindowExceededError
    # ------------------------------------------------------------------

    def truncate_trajectory(self, trajectory: dict[str, Any]) -> dict[str, Any]:
        return microcompact_trajectory_dict(
            trajectory, keep_recent=self._proactive_compact_keep_recent
        )

    # ------------------------------------------------------------------
    # Override: sync forward with hooks
    # ------------------------------------------------------------------

    def forward(self, **input_args):
        trajectory: dict[str, Any] = {}
        self._skill_buffer = []
        if self._scratchpad and self._agent_name:
            self._bb_cursor = len(self._scratchpad.messages)

        max_iters = input_args.pop("max_iters", self.max_iters)
        for idx in range(max_iters):
            try:
                pred = self._call_with_potential_trajectory_truncation(
                    self.react, trajectory, **input_args,
                )
            except ValueError as err:
                logger.warning(
                    "Ending the trajectory: Agent failed to select a valid tool: %s",
                    err,
                )
                break

            trajectory[f"thought_{idx}"] = pred.next_thought
            trajectory[f"tool_name_{idx}"] = pred.next_tool_name
            trajectory[f"tool_args_{idx}"] = pred.next_tool_args

            try:
                trajectory[f"observation_{idx}"] = self.tools[
                    pred.next_tool_name
                ](**pred.next_tool_args)
            except Exception as err:
                trajectory[f"observation_{idx}"] = (
                    f"Execution error in {pred.next_tool_name}: {err}"
                )

            self._post_observation_hooks(trajectory, idx)

            if pred.next_tool_name == "finish":
                break

        extract = self._call_with_potential_trajectory_truncation(
            self.extract, trajectory, **input_args,
        )
        return dspy.Prediction(trajectory=trajectory, **extract)

    # ------------------------------------------------------------------
    # Override: async aforward with hooks
    # ------------------------------------------------------------------

    async def aforward(self, **input_args):
        trajectory: dict[str, Any] = {}
        self._skill_buffer = []
        self._obs_summarizer = ObservationSummarizer(
            target_tokens=_OBS_BG_TARGET_TOKENS,
            start_after_step=_OBS_BG_SUMMARIZE_AFTER,
            goal=self._goal,
        )
        if self._scratchpad and self._agent_name:
            self._bb_cursor = len(self._scratchpad.messages)

        max_iters = input_args.pop("max_iters", self.max_iters)
        for idx in range(max_iters):
            try:
                pred = await self._async_call_with_potential_trajectory_truncation(
                    self.react, trajectory, **input_args,
                )
            except ValueError as err:
                logger.warning(
                    "Ending the trajectory: Agent failed to select a valid tool: %s",
                    err,
                )
                break

            trajectory[f"thought_{idx}"] = pred.next_thought
            trajectory[f"tool_name_{idx}"] = pred.next_tool_name
            trajectory[f"tool_args_{idx}"] = pred.next_tool_args

            try:
                trajectory[f"observation_{idx}"] = await self.tools[
                    pred.next_tool_name
                ].acall(**pred.next_tool_args)
            except Exception as err:
                trajectory[f"observation_{idx}"] = (
                    f"Execution error in {pred.next_tool_name}: {err}"
                )

            self._post_observation_hooks(trajectory, idx)

            if pred.next_tool_name == "finish":
                break

        await self._obs_summarizer.await_pending()

        extract = await self._async_call_with_potential_trajectory_truncation(
            self.extract, trajectory, **input_args,
        )
        return dspy.Prediction(trajectory=trajectory, **extract)

    # ------------------------------------------------------------------
    # Post-observation hooks (shared by sync + async paths)
    # ------------------------------------------------------------------

    def _post_observation_hooks(
        self, trajectory: dict[str, Any], idx: int,
    ) -> None:
        # Layer 1: immediate budget enforcement — persist large observations to disk
        cap_large_observation(trajectory, idx)

        # Layer 2: proactive microcompact — truncate older steps
        if idx >= self._proactive_compact_after:
            compacted = microcompact_trajectory_dict(
                trajectory, keep_recent=self._proactive_compact_keep_recent,
            )
            if compacted is not trajectory:
                trajectory.clear()
                trajectory.update(compacted)

        # Layer 3: async background summarization of the PREVIOUS step's observation
        # (only in aforward — _obs_summarizer is None in sync forward)
        if self._obs_summarizer is not None:
            self._obs_summarizer.schedule(trajectory, idx)

        delta = self._poll_blackboard_delta()
        if delta:
            obs_key = f"observation_{idx}"
            trajectory[obs_key] = (
                str(trajectory.get(obs_key, ""))
                + f"\n\n[COLLABORATION UPDATE]\n{delta}"
            )

        tool_name = str(trajectory.get(f"tool_name_{idx}", ""))
        tool_args = trajectory.get(f"tool_args_{idx}", {})
        thought = str(trajectory.get(f"thought_{idx}", ""))
        self._skill_buffer.append({
            "step": idx,
            "tool": tool_name,
            "args_keys": list(tool_args.keys()) if isinstance(tool_args, dict) else [],
            "thought_preview": thought[:200],
        })

    # ------------------------------------------------------------------
    # Blackboard delta polling
    # ------------------------------------------------------------------

    def _poll_blackboard_delta(self) -> str:
        """Pull ONLY new messages from blackboard + new stream chunks.

        Uses cursor-based reads so each iteration sees only what was
        added since the last check.  Never dumps the full blackboard.
        """
        parts: list[str] = []

        if self._scratchpad and self._agent_name:
            new_msgs, self._bb_cursor = self._scratchpad.read_new_messages(
                self._agent_name, self._bb_cursor,
            )
            for m in new_msgs:
                label = m.message_type.value if hasattr(m.message_type, "value") else str(m.message_type)
                body = m.insight or str(m.content)[:300]
                parts.append(f"[{label} from {m.sender}] {body}")

        if self._shared_context and self._agent_name:
            try:
                active_streams = self._shared_context.get_active_streams()
            except Exception:
                active_streams = []
            for stream_id in active_streams:
                try:
                    new_chunks = self._shared_context.read_stream(
                        stream_id, self._agent_name,
                    )
                except Exception:
                    continue
                for chunk in new_chunks:
                    data = chunk.get("data", {})
                    parts.append(
                        f"[Stream {stream_id}] "
                        + json.dumps(data, default=str)[:400]
                    )

        return "\n".join(parts) if parts else ""
