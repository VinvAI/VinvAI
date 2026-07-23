"""Vinv Engine / components / hero — Domain models for the Architect→Executor→Auditor pipeline.

Adapted for Pydantic v2 and actor-runtime communication.  Includes collaboration, credit assignment,
confidence override, and shared context models.

DORMANT in the core closure: no caller constructs SharedScratchpad;
VinvEngineReAct is constructed without scratchpad/shared_context
(base_agent.py BaseSwarmAgent.__init__).  Kept as infrastructure for
hero-style orchestration; do not wire into single-agent runtimes
(bringup/handbook) — the sender!=self delta filter makes it a no-op there.
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from enum import Enum
from typing import Annotated, Any, Callable

import json as _json

from pydantic import BaseModel, BeforeValidator, Field, field_validator, model_validator

from core.components.bootstrap.paths import DEFAULT_VINV_ENGINE_SHARED_DIR


def _coerce_json_str(v: Any) -> str | None:
    """Coerce list/dict to JSON string, strip markdown code fences, pass through str/None.

    Used as a Pydantic ``BeforeValidator`` for fields that store JSON as a string.
    The payload_normalizer aggressively decodes JSON-looking strings into Python
    objects; this validator reverses that conversion so the field always holds a
    well-formed JSON *string*, regardless of what the normalizer did.
    """
    if v is None:
        return None
    if isinstance(v, (list, dict)):
        return _json.dumps(v, default=str)
    v = str(v).strip()
    if v.startswith("```"):
        first_nl = v.find("\n")
        if first_nl != -1:
            v = v[first_nl + 1:]
        if v.rstrip().endswith("```"):
            v = v.rstrip()[:-3].rstrip()
    return v or None


JsonStr = Annotated[str | None, BeforeValidator(_coerce_json_str)]


def safe_str(val: Any, default: str = "") -> str:
    """Safely convert any DSPy output value to a string.

    DSPy can return ``list``, ``dict``, ``bool``, or other non-string types for
    fields declared as ``str``.  Calling ``.strip()`` / ``.lower()`` on those
    crashes with ``AttributeError``.  This helper normalises every type:

    * ``None``        → *default*
    * ``list | dict`` → ``json.dumps(...)``
    * ``bool``        → ``"true"`` / ``"false"``
    * anything else   → ``str(val)``
    """
    if val is None:
        return default
    if isinstance(val, (list, dict)):
        return _json.dumps(val, default=str)
    if isinstance(val, bool):
        return "true" if val else "false"
    return str(val)


class OutputTag(str, Enum):
    USEFUL = "useful"
    FAIL = "fail"
    ENQUIRY = "enquiry"
    PARTIAL = "partial"


class ValidationRound(str, Enum):
    INITIAL = "initial"
    REFINED = "refined"


class AuditorDecision(BaseModel):
    """Structured decision from the auditor about what to do next.

    Reuses ``RerouteAction`` so the entire pipeline speaks one vocabulary
    for routing decisions.  When the auditor knows the right next step
    (e.g. SWITCH_ACTOR to ``BrowserExecutor``) the orchestrator can act
    immediately instead of burning retries then consulting reroute_dspy.

    ``suggested_actor`` should always use the **base** agent name
    (e.g. ``BrowserExecutor``, ``WebSearchAgent``) — never the runtime
    actor-id with ``_agent`` / ``_dspy`` suffix.
    """

    action: str = "retry_same"
    suggested_actor: str | None = None
    reasoning: str = ""
    enrichment_data: dict[str, Any] = Field(default_factory=dict)


class ValidationResult(BaseModel):
    """Result of an Architect or Auditor validation pass."""

    agent_name: str
    is_valid: bool
    confidence: float = 0.5
    reasoning: str = ""

    should_proceed: bool | None = None
    injected_context: str | None = None
    injected_instructions: str | None = None

    output_tag: OutputTag | None = None
    why_useful: str | None = None
    fix_instructions: str | None = None
    insight_to_share: str | None = None
    recommended_output_format: str | None = None

    contingency_approach: str | None = None

    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    execution_time: float = 0.0
    validation_round: ValidationRound = ValidationRound.INITIAL

    auditor_decision: AuditorDecision | None = None
    suggested_reroute_actor: str | None = None
    task_decomposition: JsonStr = None
    todo_suggestions: list[dict[str, Any]] = Field(default_factory=list)
    rotate_todo: bool = False


class TaggedOutput(BaseModel):
    """Actor output tagged by the Auditor."""

    name: str
    tag: OutputTag
    why_useful: str = ""
    content: Any = None


class EpisodeResult(BaseModel):
    """Full result of one Architect→Executor→Auditor episode for a single task."""

    task_id: str
    task_name: str = ""
    actor_used: str = ""
    output: Any = None
    success: bool = False
    execution_time: float = 0.0
    trajectory_summary: str = ""
    error: str | None = None

    failure_class: str | None = Field(
        default=None,
        description=(
            "Agent-sourced failure classification. Set by hero_actor on failure. "
            "One of: 'infra' (missing server/engine), 'terminal' (permanent error), "
            "'context_length' (token limit), 'decompose' (needs subtask split), "
            "'transient' (retry may help), or None on success."
        ),
    )

    architect_result: ValidationResult | None = None
    auditor_result: ValidationResult | None = None
    tagged_outputs: list[TaggedOutput] = Field(default_factory=list)

    retry_count: int = 0
    negotiation_used: bool = False
    override_metadata: dict[str, Any] | None = None
    alerts: list[str] = Field(default_factory=list)
    insights: list[str] = Field(default_factory=list)
    todo_suggestions: list[dict[str, Any]] = Field(default_factory=list)
    rotate_todo: bool = False


class HeroTaskRequest(BaseModel):
    """A single task to be executed through the hero pipeline."""

    task_id: str
    task_name: str
    task_description: str
    task_type: str = "implementation"
    output_type: str = "text"  # "text" | "file" | "action"
    assigned_actor: str = ""
    actor_capabilities: list[str] = Field(default_factory=list)
    depends_on: list[str] = Field(default_factory=list)
    dependency_types: dict[str, str] = Field(
        default_factory=dict,
        description="Maps dep_id -> 'hard'|'soft'|'streaming'. Absent entries default to 'hard'.",
    )

    goal: str = ""
    todo_state: JsonStr = None
    available_actors: str | None = None
    q_learning_advisory: str = ""
    q_td_error: float = 0.0  # Q-learning temporal difference error for memory salience

    run_id: str = ""
    run_start_ts: float = 0.0

    is_trivial_task: bool = False
    decomposition_depth: int = 0

    decomposition_context: str = ""

    collaboration_actors: list[str] = Field(
        default_factory=list,
        description="Secondary actors that should collaborate on this task",
    )

    collaboration_depth: int = Field(
        default=0,
        description="Current depth in collaboration chain (0 = root task, incremented by collaborate tool)",
    )
    collaboration_chain: list[str] = Field(
        default_factory=list,
        description="Lineage of actors in the collaboration chain (e.g. ['BrowserExecutor', 'TerminalExecutor'])",
    )

    upstream_streams: list[str] = Field(
        default_factory=list,
        description="Stream channel IDs this task should consume (wired by coordinator at dispatch).",
    )

    max_architect_retries: int = 2
    max_auditor_retries: int = 3

    @property
    def description(self) -> str:
        """Alias for ``task_description`` (DSPy / legacy call sites)."""
        return self.task_description

    @property
    def max_attempts(self) -> int:
        """Coordinator episode retry budget (aligned with auditor loop cap)."""
        return self.max_auditor_retries

    @model_validator(mode="before")
    @classmethod
    def _coerce_none_collections(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ("actor_capabilities", "depends_on", "upstream_streams"):
                if key in data and data[key] is None:
                    data[key] = []
            if "dependency_types" in data and data["dependency_types"] is None:
                data["dependency_types"] = {}
            # Coerce task_id to str if int (e.g. 0) to avoid ValidationError (A-Team RCA).
            if "task_id" in data and data["task_id"] is not None and not isinstance(data["task_id"], str):
                data = {**data, "task_id": str(data["task_id"])}
        return data

    @field_validator("available_actors", mode="before")
    @classmethod
    def _coerce_available_actors(cls, v: Any) -> str | None:
        if v is None:
            return None
        if isinstance(v, str):
            return v
        if isinstance(v, (list, dict)):
            return _json.dumps(v, default=str)
        return str(v)


class HeroBatchRequest(BaseModel):
    """Batch of tasks to run through the hero pipeline."""

    tasks: list[HeroTaskRequest] = Field(default_factory=list)
    goal: str = ""
    executable_dag: dict[str, Any] = Field(default_factory=dict)


class SpotAuditResult(BaseModel):
    """Goal-level validation after all tasks complete.

    The SpotAuditor doesn't care about how individual tasks were done —
    it only checks whether the user's original goal is actually satisfied
    by the combined outputs.
    """

    goal_satisfied: bool = False
    confidence: float = 0.5
    reasoning: str = ""
    unresolved_gaps: str = ""
    recommended_action: str = "accept"


class HeroBatchResult(BaseModel):
    """Aggregated result of a full hero batch."""

    goal: str = ""
    episodes: list[EpisodeResult] = Field(default_factory=list)
    total_tasks: int = 0
    succeeded: int = 0
    failed: int = 0
    total_time: float = 0.0
    timed_out: bool = False
    spot_audit: SpotAuditResult | None = None


# ---------------------------------------------------------------------------
# Collaboration & Shared Context
# ---------------------------------------------------------------------------


class CommunicationType(str, Enum):
    INSIGHT = "insight"
    WARNING = "warning"
    TOOL_RESULT = "tool_result"
    TASK_OUTPUT = "task_output"
    KNOWLEDGE_SHARE = "knowledge_share"
    BROADCAST = "broadcast"
    FILE_DELIVERY = "file_delivery"
    # Blackboard-architecture message types (paper: arxiv 2507.01701)
    BLACKBOARD_PUBLIC = "blackboard_public"      # public-space contributions
    BLACKBOARD_PRIVATE = "blackboard_private"    # private debate / self-reflection
    BLACKBOARD_CLEAN = "blackboard_clean"        # cleaner marks a message removed
    # Agent↔User collaboration via blackboard
    AGENT_USER_COLLAB = "agent_user_collab"      # agent requests user collaboration
    USER_COLLAB_RESPONSE = "user_collab_response"  # user responds to agent collab


class AgentMessage(BaseModel):
    """Inter-agent communication message via SharedScratchpad."""

    sender: str
    receiver: str = "*"
    message_type: CommunicationType
    content: dict[str, Any] = Field(default_factory=dict)
    timestamp: float = Field(default_factory=time.time)

    insight: str | None = None
    confidence: float | None = None

    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None
    tool_result: Any = None

    task_id: str | None = None
    task_name: str | None = None
    output_data: dict[str, Any] | None = None
    file_path: str | None = None


class SharedScratchpad:
    """Blackboard-architecture shared memory for multi-agent collaboration.

    Implements the blackboard pattern from *Exploring Advanced LLM
    Multi-Agent Systems Based on Blackboard Architecture* (Han & Zhang,
    arXiv 2507.01701):

    • **Public space** — all agents read/write; every agent receives the
      full public-space content as prompt context each round.
    • **Private spaces** — scoped to a pair / group of agents for debate
      or self-reflection; invisible to others.
    • **Message cleaning** — the cleaner can mark messages as removed so
      they stop appearing in the blackboard view without data loss.

    Fully **async and non-blocking**: uses ``asyncio.Lock`` for all
    mutations so callers never block the event loop.  Synchronous
    convenience wrappers (``add_message``, ``get_insights``, etc.) are
    retained for backward compatibility — they schedule the async
    version on the running loop when possible, or fall back to direct
    (thread-safe via a secondary ``threading.Lock``).

    Provides:
    - Full blackboard content injection for every agent prompt
    - Broadcast/targeted message passing between agents
    - Tool result caching with TTL eviction
    - Insight accumulation
    - **Real-time persistence** via optional ``persist_path`` (JSONL
      append-on-write).
    """

    # ------------------------------------------------------------------
    # Blackboard configuration
    # ------------------------------------------------------------------

    # Blackboard budget: 100k tokens × 4 chars/token = 400k chars limit.
    # Compression triggers at 60% (60k tokens = 240k chars) so there's
    # 40k tokens (160k chars) of headroom for the LLM to generate the
    # compressed output.  Critical messages (task outputs, file deliveries)
    # are NEVER compressed or trimmed.
    _BLACKBOARD_MAX_PUBLIC_CHARS = int(
        __import__("os").environ.get("VINV_ENGINE_BLACKBOARD_MAX_PUBLIC_CHARS", "400000")
    )
    _BLACKBOARD_COMPRESS_TRIGGER_CHARS = int(
        __import__("os").environ.get("VINV_ENGINE_BLACKBOARD_COMPRESS_TRIGGER_CHARS", "240000")
    )

    def __init__(
        self,
        max_cache_entries: int | None = None,
        cache_ttl_seconds: float | None = None,
        persist_path: "Path | str | None" = None,
    ) -> None:
        import asyncio as _asyncio
        import os as _os
        import threading as _threading

        if max_cache_entries is None:
            max_cache_entries = int(_os.environ.get("VINV_ENGINE_SCRATCHPAD_MAX_CACHE", "1000"))
        if cache_ttl_seconds is None:
            cache_ttl_seconds = float(_os.environ.get("VINV_ENGINE_SCRATCHPAD_TTL", "300.0"))

        # Public-space messages (visible to all agents)
        self.messages: list[AgentMessage] = []
        # Private-space messages keyed by sorted participant tuple
        self._private_spaces: dict[tuple[str, ...], list[AgentMessage]] = {}
        # IDs of messages marked as cleaned / removed by the cleaner agent
        self._cleaned_ids: set[str] = set()

        self._tool_cache: OrderedDict[str, tuple[Any, float]] = OrderedDict()
        self._max_cache = max_cache_entries
        self._ttl = cache_ttl_seconds

        # Absolute paths of task-output offload files THIS instance wrote;
        # a clear() collects exactly these (see _gc_task_output_offloads).
        self._own_offload_paths: set[str] = set()

        # Primary lock: asyncio for non-blocking async paths
        self._alock = _asyncio.Lock()
        # Secondary threading lock for sync compat callers
        self._lock = _threading.Lock()

        self._persist_path: Path | None = None
        if persist_path is not None:
            from pathlib import Path as _P
            self._persist_path = _P(persist_path)
            self._restore_from_disk()

    # ==================================================================
    # ASYNC CORE API — preferred path (non-blocking)
    # ==================================================================

    async def async_add_message(self, message: AgentMessage) -> None:
        """Append *message* to the public blackboard (async, non-blocking).

        After appending, checks if total blackboard size exceeds the
        compression trigger threshold.  If so, fires a non-blocking
        background task that compresses LOW-priority messages in-place —
        the compressed content replaces the original under the async lock
        so the next reader sees the smaller version.
        """
        async with self._alock:
            self.messages.append(message)
        await self._async_persist_append(message)
        # Check if compression should be triggered
        await self._maybe_compress_blackboard()

    _bb_compress_task: "asyncio.Task | None" = None

    async def _maybe_compress_blackboard(self) -> None:
        """Fire non-blocking background compression if blackboard exceeds trigger."""
        import asyncio as _asyncio
        if self._bb_compress_task is not None and not self._bb_compress_task.done():
            return  # Already compressing
        total = sum(len(m.content.get("message", "") if isinstance(m.content, dict) else str(m.content)) for m in self.messages)
        if total < self._BLACKBOARD_COMPRESS_TRIGGER_CHARS:
            return
        self._bb_compress_task = _asyncio.ensure_future(self._compress_blackboard_bg())

    async def _compress_blackboard_bg(self) -> None:
        """Background: compress LOW-priority blackboard messages in-place.

        Runs without blocking the event loop.  Acquires ``_alock`` only
        briefly to swap the compressed content — agents reading the
        blackboard between lock acquisitions see consistent snapshots.
        """
        import asyncio as _asyncio
        import logging as _logging
        _log = _logging.getLogger("vinv_engine.scratchpad.compress")
        try:
            from core.components.context_compressor import smart_fit
        except ImportError:
            return

        _CRITICAL_TYPES = {CommunicationType.TASK_OUTPUT, CommunicationType.FILE_DELIVERY}
        candidates = [
            (i, m) for i, m in enumerate(self.messages)
            if m.message_type not in _CRITICAL_TYPES
            and not getattr(m, "_bb_compressed", False)
            and len(str(m.content)) > 2000
        ]
        if not candidates:
            return

        _log.info("blackboard_compress_start candidates=%d", len(candidates))
        for idx, msg in candidates:
            raw = str(msg.content)
            if len(raw) < 2000:
                continue
            try:
                compressed = await smart_fit(
                    raw,
                    max_chars=len(raw) // 2,
                    purpose="blackboard_compress",
                )
                async with self._alock:
                    if idx < len(self.messages) and self.messages[idx] is msg:
                        if isinstance(msg.content, dict):
                            msg.content["message"] = compressed
                        else:
                            msg.content = compressed
                        msg._bb_compressed = True  # type: ignore[attr-defined]
                _log.info(
                    "blackboard_compress_msg idx=%d original=%d compressed=%d",
                    idx, len(raw), len(compressed),
                )
            except Exception as _e:
                _log.debug("blackboard_compress_skip idx=%d error=%s", idx, _e)
        _log.info("blackboard_compress_done")

    async def async_add_private_message(
        self, message: AgentMessage, participants: list[str],
    ) -> None:
        """Write to a private space visible only to *participants*."""
        key = tuple(sorted(participants))
        message.message_type = CommunicationType.BLACKBOARD_PRIVATE
        async with self._alock:
            self._private_spaces.setdefault(key, []).append(message)
        await self._async_persist_append(message)

    async def async_get_messages_for(self, receiver: str) -> list[AgentMessage]:
        async with self._alock:
            msgs = list(self.messages)
        return [
            m for m in msgs
            if m.receiver in ("*", receiver)
            and m.sender != receiver
            and id(m) not in self._cleaned_ids
        ]

    async def async_read_new_messages(
        self, agent_name: str, cursor: int = 0,
    ) -> tuple[list[AgentMessage], int]:
        """Return messages added since *cursor*, filtered for *agent_name*.

        Returns ``(new_messages, new_cursor)``.  The caller stores
        ``new_cursor`` and passes it on the next call to get only the
        delta.  Because ``self.messages`` is append-only, the cursor is
        simply an integer index into the list.
        """
        async with self._alock:
            new_msgs = self.messages[cursor:]
            new_cursor = len(self.messages)
        filtered = [
            m for m in new_msgs
            if m.receiver in ("*", agent_name)
            and m.sender != agent_name
            and id(m) not in self._cleaned_ids
        ]
        return filtered, new_cursor

    async def async_get_private_messages(
        self, agent_name: str,
    ) -> list[AgentMessage]:
        """Return private-space messages where *agent_name* is a participant."""
        results: list[AgentMessage] = []
        async with self._alock:
            for participants, msgs in self._private_spaces.items():
                if agent_name in participants:
                    results.extend(msgs)
        return results

    async def async_get_insights(self, receiver: str) -> list[str]:
        results: list[str] = []
        for m in await self.async_get_messages_for(receiver):
            if m.message_type == CommunicationType.INSIGHT and m.insight:
                results.append(f"[{m.sender}]: {m.insight}")
            elif m.message_type == CommunicationType.WARNING:
                results.append(f"[WARNING from {m.sender}]: {m.content}")
        return results

    # ------------------------------------------------------------------
    # Blackboard content rendering (full injection per paper §3.2)
    # ------------------------------------------------------------------

    async def async_get_blackboard_content(
        self,
        agent_name: str,
        *,
        include_private: bool = True,
        max_chars: int | None = None,
    ) -> str:
        """Render the full blackboard content for injection into an agent's prompt.

        Per the blackboard architecture (Algorithm 1, line 5):
            ``mi ← Exec(Ai, B)``
        Every selected agent receives the *entire* blackboard B as context.

        Returns a formatted string containing:
        1. PUBLIC SPACE — all non-cleaned public messages
        2. PRIVATE SPACE (if applicable) — messages from debates / self-reflection
           that this agent participated in

        The output is capped at *max_chars* (default ``_BLACKBOARD_MAX_PUBLIC_CHARS``)
        by trimming oldest messages first to stay within budget.
        """
        if max_chars is None:
            max_chars = self._BLACKBOARD_MAX_PUBLIC_CHARS

        sections: list[str] = []

        # ---- Public space ----
        async with self._alock:
            public_msgs = [
                m for m in self.messages
                if id(m) not in self._cleaned_ids
            ]

        if public_msgs:
            pub_lines = ["═══ BLACKBOARD — PUBLIC SPACE ═══"]
            for m in public_msgs:
                pub_lines.append(self._format_message(m))
            sections.append("\n".join(pub_lines))

        # ---- Private spaces this agent participates in ----
        if include_private:
            private_msgs = await self.async_get_private_messages(agent_name)
            if private_msgs:
                priv_lines = [f"═══ BLACKBOARD — PRIVATE SPACE (for {agent_name}) ═══"]
                for m in private_msgs:
                    priv_lines.append(self._format_message(m))
                sections.append("\n".join(priv_lines))

        full = "\n\n".join(sections)

        # Smart budget trim: protect messages that pending/in-flight tasks
        # may still need.  Three tiers (never trim → trim last → trim first):
        #   1. CRITICAL types (task_output, file_delivery, user_collab) — never
        #   2. Messages whose task_id is referenced by a future dependency — last
        #   3. Everything else (insights, broadcasts, knowledge_share) — first
        _CRITICAL_TYPES = {
            CommunicationType.TASK_OUTPUT,
            CommunicationType.FILE_DELIVERY,
            CommunicationType.USER_COLLAB_RESPONSE,
            CommunicationType.AGENT_USER_COLLAB,
        }
        if len(full) > max_chars and len(public_msgs) > 1:
            # Gather task_ids that still have pending consumers
            _pending_dep_task_ids = self._get_pending_dependency_task_ids()

            critical = []
            dep_protected = []
            trimmable = []
            for m in public_msgs:
                if m.message_type in _CRITICAL_TYPES:
                    critical.append(m)
                elif m.task_id and m.task_id in _pending_dep_task_ids:
                    dep_protected.append(m)
                else:
                    trimmable.append(m)

            # Trim non-critical, non-dep messages first (oldest first)
            while len(full) > max_chars and trimmable:
                trimmable.pop(0)
                remaining = sorted(
                    critical + dep_protected + trimmable,
                    key=lambda m: m.timestamp,
                )
                pub_lines = ["═══ BLACKBOARD — PUBLIC SPACE (trimmed) ═══"]
                for m in remaining:
                    pub_lines.append(self._format_message(m))
                sections[0] = "\n".join(pub_lines)
                full = "\n\n".join(sections)

            # If still over budget, trim dep-protected (oldest first)
            if len(full) > max_chars and dep_protected:
                while len(full) > max_chars and dep_protected:
                    dep_protected.pop(0)
                    remaining = sorted(
                        critical + dep_protected,
                        key=lambda m: m.timestamp,
                    )
                    pub_lines = ["═══ BLACKBOARD — PUBLIC SPACE (trimmed) ═══"]
                    for m in remaining:
                        pub_lines.append(self._format_message(m))
                    sections[0] = "\n".join(pub_lines)
                    full = "\n\n".join(sections)

        return full

    def _get_pending_dependency_task_ids(self) -> set[str]:
        """Return task_ids whose outputs are still needed by pending tasks.

        Scans the task output cache to find task_ids referenced as
        dependencies by tasks that haven't completed yet.  Messages
        from these tasks are protected from trimming because their
        content may be consumed by a future executor.
        """
        # _pending_dep_ids is populated by the coordinator via
        # set_pending_dependency_ids() before each blackboard read.
        return getattr(self, "_pending_dep_ids", set())

    def set_pending_dependency_ids(self, ids: set[str]) -> None:
        """Called by coordinator before blackboard content is read."""
        self._pending_dep_ids = ids

    @staticmethod
    def _format_message(m: AgentMessage) -> str:
        """Format a single blackboard message for prompt injection."""
        import datetime as _dt
        ts = _dt.datetime.fromtimestamp(m.timestamp).strftime("%H:%M:%S")
        header = f"[{ts}] {m.sender} → {m.receiver} ({m.message_type.value})"
        body_parts: list[str] = []
        if m.insight:
            body_parts.append(m.insight)
        if m.task_name:
            body_parts.append(f"task: {m.task_name}")
        if m.content:
            summary = m.content.get("summary", "")
            if summary:
                # Truncate very long summaries in the formatted view
                if len(summary) > 2000:
                    summary = summary[:2000] + "… (truncated)"
                body_parts.append(summary)
            elif m.content:
                content_str = _json.dumps(m.content, default=str)
                if len(content_str) > 2000:
                    content_str = content_str[:2000] + "… (truncated)"
                body_parts.append(content_str)
        if m.file_path:
            body_parts.append(f"file: {m.file_path}")
        body = "\n  ".join(body_parts) if body_parts else "(no content)"
        return f"{header}\n  {body}"

    # ------------------------------------------------------------------
    # Message cleaning (paper §3.2 — cleaner agent)
    # ------------------------------------------------------------------

    async def async_clean_message(self, message_index: int, cleaner_agent: str) -> bool:
        """Mark a public-space message as cleaned (removed from blackboard view).

        The message is not physically deleted — a BLACKBOARD_CLEAN record is
        appended for auditability.  Returns True if the index was valid.
        """
        async with self._alock:
            if 0 <= message_index < len(self.messages):
                target = self.messages[message_index]
                self._cleaned_ids.add(id(target))
            else:
                return False
        await self.async_add_message(AgentMessage(
            sender=cleaner_agent,
            receiver="*",
            message_type=CommunicationType.BLACKBOARD_CLEAN,
            content={
                "cleaned_index": message_index,
                "cleaned_sender": target.sender,
                "reason": "redundant or obsolete",
            },
        ))
        return True

    # ------------------------------------------------------------------
    # Async task output & knowledge sharing API
    # ------------------------------------------------------------------

    _TASK_OUTPUT_OFFLOAD_CHARS = int(
        __import__("os").environ.get("VINV_ENGINE_TASK_OUTPUT_OFFLOAD_CHARS", "50000")
    )

    def _register_task_output_offload(self, path: str, content: str) -> None:
        """Index an offloaded task output (non-fatal — never breaks the write).

        The path is also tracked on THIS instance so a later ``clear()`` can
        collect exactly the files this blackboard wrote — and nothing else.
        """
        import os as _os
        # Track ownership even if registry indexing fails below: the clear-time
        # collection must still find the file (collect_paths tombstones
        # unregistered paths with a synthesized entry).
        self._own_offload_paths.add(_os.path.abspath(str(path)))
        try:
            from core.components.common.offload_registry import register_offload
            register_offload(path, content, kind="task_output")
        except Exception:
            pass

    def _gc_task_output_offloads(self) -> None:
        """Collect this blackboard's OWN task-output offloads at a clear.

        A blackboard clear invalidates every ``_offloaded_path`` pointer this
        instance handed out, so its own files are collected immediately (no
        grace — we own them).  Files belonging to OTHER runs/processes sharing
        ``VINV_ENGINE_SHARED_DIR`` are never touched here: a concurrent run's
        live offloads must survive our clear.  Stale foreign files are instead
        collected by the run-start ``gc_offloads`` hooks (bringup/handbook),
        which honor the grace window.  Non-fatal: a GC failure must never
        break a clear.
        """
        try:
            from core.components.common.offload_registry import collect_paths
            own = set(self._own_offload_paths)
            if own:
                collect_paths(own)
                self._own_offload_paths.clear()
        except Exception:
            pass

    async def async_add_task_output(
        self,
        task_id: str,
        task_name: str,
        actor: str,
        output: dict[str, Any],
        file_artifacts: list[dict[str, str]] | None = None,
        result_store: Any = None,
    ) -> None:
        """Record a task output on the public blackboard (async)."""
        import asyncio as _asyncio

        # If ResultStore already persisted this output, use its compact reference
        if result_store is not None:
            try:
                _ref = result_store.get_reference(task_id)
                if _ref is not None:
                    output = {"_stored": True, "_ref": _ref}
            except Exception:
                pass

        full_json = _json.dumps(output, default=str)

        stored_output = output
        offloaded_path: str | None = None
        if len(full_json) > self._TASK_OUTPUT_OFFLOAD_CHARS:
            import os
            shared_dir = os.environ.get("VINV_ENGINE_SHARED_DIR", DEFAULT_VINV_ENGINE_SHARED_DIR)
            os.makedirs(shared_dir, exist_ok=True)
            offloaded_path = os.path.join(shared_dir, f"task_output_{task_id}.md")
            try:
                def _write():
                    # errors="replace": task_name may carry lone surrogates.
                    with open(
                        offloaded_path, "w", encoding="utf-8", errors="replace"
                    ) as fh:
                        fh.write(f"# Task Output: {task_name}\n\n")
                        fh.write(full_json)
                await _asyncio.to_thread(_write)
                self._register_task_output_offload(offloaded_path, full_json)
                stored_output = {
                    "_offloaded": True,
                    "_offloaded_path": offloaded_path,
                    "_offloaded_chars": len(full_json),
                }
                full_json = _json.dumps(stored_output, default=str)
            except OSError:
                pass

        content: dict[str, Any] = {
            "actor": actor,
            "success": True,
            "summary": full_json,
        }
        if file_artifacts:
            content["file_artifacts"] = file_artifacts
        if offloaded_path:
            content.setdefault("file_artifacts", [])
            content["file_artifacts"].append({
                "path": offloaded_path,
                "type": "task_output_offload",
            })
        await self.async_add_message(AgentMessage(
            sender=actor,
            receiver="*",
            message_type=CommunicationType.TASK_OUTPUT,
            content=content,
            task_id=task_id,
            task_name=task_name,
            output_data=stored_output,
        ))

    async def async_get_task_outputs(
        self, task_ids: list[str] | None = None,
    ) -> list[AgentMessage]:
        async with self._alock:
            msgs = list(self.messages)
        return [
            m for m in msgs
            if m.message_type == CommunicationType.TASK_OUTPUT
            and (task_ids is None or m.task_id in task_ids)
            and id(m) not in self._cleaned_ids
        ]

    async def async_get_completed_task_summary(
        self, task_ids: list[str] | None = None,
    ) -> str:
        outputs = await self.async_get_task_outputs(task_ids=task_ids)
        if not outputs:
            return ""
        header = (
            "DEPENDENCY TASK OUTPUTS:" if task_ids
            else "COMPLETED TASKS SO FAR:"
        )
        lines = [header]
        for m in outputs:
            status = "SUCCESS" if m.content.get("success") else "FAILED"
            actor = m.content.get("actor", m.sender)
            summary = m.content.get("summary", "")
            fa = m.content.get("file_artifacts", [])
            fa_str = f" | files: {[f.get('path','?') for f in fa]}" if fa else ""
            lines.append(f"  [{m.task_id}] {m.task_name} ({actor}) — {status}{fa_str}")
            if summary:
                lines.append(f"    output: {summary}")
        return "\n".join(lines)

    async def async_add_knowledge_share(
        self, sender: str, receiver: str, data: dict[str, Any],
    ) -> None:
        await self.async_add_message(AgentMessage(
            sender=sender,
            receiver=receiver,
            message_type=CommunicationType.KNOWLEDGE_SHARE,
            content=data,
        ))

    async def async_broadcast_data(
        self, sender: str, data: dict[str, Any],
    ) -> None:
        await self.async_add_message(AgentMessage(
            sender=sender,
            receiver="*",
            message_type=CommunicationType.BROADCAST,
            content=data,
        ))

    async def async_add_file_delivery(
        self, sender: str, receiver: str, file_path: str, description: str = "",
    ) -> None:
        await self.async_add_message(AgentMessage(
            sender=sender,
            receiver=receiver,
            message_type=CommunicationType.FILE_DELIVERY,
            content={"description": description},
            file_path=file_path,
        ))

    # ------------------------------------------------------------------
    # Async agent↔user collaboration via blackboard
    # ------------------------------------------------------------------

    async def async_request_user_collab(
        self,
        sender: str,
        question: str,
        context: str = "",
        task_id: str | None = None,
        options: list[str] | None = None,
        collab_type: str = "question",
    ) -> str:
        """Post an agent→user collaboration request on the blackboard.

        The UserActor polls for AGENT_USER_COLLAB messages addressed to "user"
        and relays them to the Electron UI via EventStreamChannel.  The user's
        response comes back as a USER_COLLAB_RESPONSE message on the blackboard
        that the requesting agent can poll for.

        Args:
            sender:      agent id posting the request
            question:    the question / request for the user
            context:     additional context about what the agent is doing
            task_id:     optional task_id the request relates to
            options:     optional list of suggested responses
            collab_type: "question" | "confirmation" | "feedback" | "info"

        Returns:
            request_id — callers can poll async_get_user_collab_response(request_id)
        """
        import uuid as _uuid
        request_id = f"collab_{_uuid.uuid4().hex[:12]}"
        msg = AgentMessage(
            sender=sender,
            receiver="user",
            message_type=CommunicationType.AGENT_USER_COLLAB,
            content={
                "request_id": request_id,
                "question": question,
                "context": context,
                "collab_type": collab_type,
                "options": options or [],
            },
            task_id=task_id,
            insight=f"[AGENT→USER] {sender}: {question}",
            confidence=1.0,
        )
        await self.async_add_message(msg)
        return request_id

    async def async_get_pending_user_collab_requests(self) -> list[AgentMessage]:
        """Retrieve unprocessed AGENT_USER_COLLAB messages addressed to 'user'.

        Called by UserActor's blackboard poll to discover new agent→user
        collaboration requests that need to be relayed to the Electron UI.
        """
        async with self._alock:
            return [
                m for m in self.messages
                if m.receiver == "user"
                and m.message_type == CommunicationType.AGENT_USER_COLLAB
                and not self._is_cleaned(m)
            ]

    async def async_post_user_collab_response(
        self,
        request_id: str,
        response_text: str,
        responder: str = "user",
    ) -> None:
        """Post the user's response to an agent collaboration request.

        The response is posted as a USER_COLLAB_RESPONSE message on the
        blackboard. The original requesting agent picks it up via
        async_get_user_collab_response().
        """
        await self.async_add_message(AgentMessage(
            sender=responder,
            receiver="*",
            message_type=CommunicationType.USER_COLLAB_RESPONSE,
            content={
                "request_id": request_id,
                "response": response_text,
            },
            insight=f"[USER→AGENT] response to {request_id}: {response_text[:200]}",
            confidence=1.0,
        ))

    async def async_get_user_collab_response(
        self, request_id: str,
    ) -> str | None:
        """Check if the user has responded to a specific collaboration request.

        Returns the response text if found, None if not yet responded.
        """
        async with self._alock:
            for m in reversed(self.messages):
                if (
                    m.message_type == CommunicationType.USER_COLLAB_RESPONSE
                    and isinstance(m.content, dict)
                    and m.content.get("request_id") == request_id
                ):
                    return m.content.get("response", "")
        return None

    def _is_cleaned(self, msg: "AgentMessage") -> bool:
        """Check if a message has been marked as cleaned."""
        return id(msg) in self._cleaned_ids

    # ------------------------------------------------------------------
    # Async credential sharing
    # ------------------------------------------------------------------

    async def async_add_credential_handoff(
        self,
        sender: str,
        receiver: str,
        credentials: dict[str, str],
        description: str = "",
        ttl_seconds: float = 600.0,
    ) -> None:
        await self.async_add_message(AgentMessage(
            sender=sender,
            receiver=receiver,
            message_type=CommunicationType.KNOWLEDGE_SHARE,
            content={
                "type": "credential_handoff",
                "description": description,
                "credentials": credentials,
                "expires_at": time.time() + ttl_seconds,
            },
        ))

    async def async_get_credentials_for(
        self, receiver: str,
    ) -> list[dict[str, Any]]:
        now = time.time()
        results: list[dict[str, Any]] = []
        for m in await self.async_get_messages_for(receiver):
            if (
                m.message_type == CommunicationType.KNOWLEDGE_SHARE
                and isinstance(m.content, dict)
                and m.content.get("type") == "credential_handoff"
            ):
                expires = m.content.get("expires_at", 0)
                if expires > now:
                    results.append({
                        "from": m.sender,
                        "description": m.content.get("description", ""),
                        "credentials": m.content.get("credentials", {}),
                        "expires_in_seconds": round(expires - now),
                    })
        return results

    # ------------------------------------------------------------------
    # Async tool result caching
    # ------------------------------------------------------------------

    async def async_cache_tool_result(
        self, tool_name: str, tool_args: dict, result: Any,
    ) -> None:
        async with self._alock:
            self._evict_expired()
            key = self._cache_key(tool_name, tool_args)
            self._tool_cache[key] = (result, time.time())
            if len(self._tool_cache) > self._max_cache:
                self._tool_cache.popitem(last=False)

    async def async_get_cached_result(
        self, tool_name: str, tool_args: dict,
    ) -> Any | None:
        async with self._alock:
            self._evict_expired()
            key = self._cache_key(tool_name, tool_args)
            entry = self._tool_cache.get(key)
            if entry is None:
                return None
            return entry[0]

    async def async_clear(self) -> None:
        import asyncio as _asyncio
        async with self._alock:
            self.messages.clear()
            self._private_spaces.clear()
            self._cleaned_ids.clear()
            self._tool_cache.clear()
        await self._async_persist_truncate()
        await _asyncio.to_thread(self._gc_task_output_offloads)

    @staticmethod
    def _is_run_scoped_message(m: "AgentMessage") -> bool:
        """Return True for messages that must NOT survive a goal/run boundary.

        ``user_live_instruction`` entries are injected mid-run to broadcast a
        live user request to in-flight agents.  They are run-scoped: once the
        run they belong to ends, preserving them would cause stale instructions
        to appear as current user requests in the next run.
        """
        return (
            isinstance(m.content, dict)
            and m.content.get("type") == "user_live_instruction"
        )

    async def async_clear_goal_scoped(
        self, current_goal: str = "", project_id: str = "",
    ) -> None:
        if not current_goal and not project_id:
            await self.async_clear()
            return

        async with self._alock:
            preserved: list[AgentMessage] = []
            for m in self.messages:
                if self._is_run_scoped_message(m):
                    # Never carry user_live_instruction across run boundaries
                    continue
                if m.message_type in (
                    CommunicationType.KNOWLEDGE_SHARE,
                    CommunicationType.INSIGHT,
                ):
                    preserved.append(m)
                elif (
                    project_id
                    and isinstance(m.content, dict)
                    and m.content.get("project_id") == project_id
                ):
                    preserved.append(m)
            self.messages = preserved
            self._tool_cache.clear()
            self._cleaned_ids.clear()
        await self._async_persist_truncate()
        for m in preserved:
            await self._async_persist_append(m)
        import asyncio as _asyncio
        await _asyncio.to_thread(self._gc_task_output_offloads)

    # ==================================================================
    # SYNC COMPAT WRAPPERS — delegate to async via best-effort
    # ==================================================================

    def add_message(self, message: AgentMessage) -> None:
        with self._lock:
            self.messages.append(message)
        self._persist_append(message)

    def get_messages_for(self, receiver: str) -> list[AgentMessage]:
        with self._lock:
            msgs = list(self.messages)
        return [
            m for m in msgs
            if m.receiver in ("*", receiver)
            and m.sender != receiver
            and id(m) not in self._cleaned_ids
        ]

    def read_new_messages(
        self, agent_name: str, cursor: int = 0,
    ) -> tuple[list[AgentMessage], int]:
        """Sync cursor-based delta read.  See ``async_read_new_messages``."""
        with self._lock:
            new_msgs = self.messages[cursor:]
            new_cursor = len(self.messages)
        filtered = [
            m for m in new_msgs
            if m.receiver in ("*", agent_name)
            and m.sender != agent_name
            and id(m) not in self._cleaned_ids
        ]
        return filtered, new_cursor

    def get_insights(self, receiver: str) -> list[str]:
        results: list[str] = []
        for m in self.get_messages_for(receiver):
            if m.message_type == CommunicationType.INSIGHT and m.insight:
                results.append(f"[{m.sender}]: {m.insight}")
            elif m.message_type == CommunicationType.WARNING:
                results.append(f"[WARNING from {m.sender}]: {m.content}")
        return results

    def get_blackboard_content_sync(
        self, agent_name: str, *, max_chars: int | None = None,
    ) -> str:
        """Synchronous version of ``async_get_blackboard_content``."""
        if max_chars is None:
            max_chars = self._BLACKBOARD_MAX_PUBLIC_CHARS
        sections: list[str] = []
        with self._lock:
            public_msgs = [
                m for m in self.messages if id(m) not in self._cleaned_ids
            ]
        if public_msgs:
            pub_lines = ["═══ BLACKBOARD — PUBLIC SPACE ═══"]
            for m in public_msgs:
                pub_lines.append(self._format_message(m))
            sections.append("\n".join(pub_lines))

        with self._lock:
            for participants, msgs in self._private_spaces.items():
                if agent_name in participants:
                    priv_lines = [f"═══ BLACKBOARD — PRIVATE SPACE (for {agent_name}) ═══"]
                    for m in msgs:
                        priv_lines.append(self._format_message(m))
                    sections.append("\n".join(priv_lines))
        full = "\n\n".join(sections)
        # Smart budget trim: same 3-tier logic as async version
        _CRITICAL_TYPES = {
            CommunicationType.TASK_OUTPUT,
            CommunicationType.FILE_DELIVERY,
            CommunicationType.USER_COLLAB_RESPONSE,
            CommunicationType.AGENT_USER_COLLAB,
        }
        if len(full) > max_chars and public_msgs:
            _pending_dep_task_ids = self._get_pending_dependency_task_ids()
            critical = []
            dep_protected = []
            trimmable = []
            for m in public_msgs:
                if m.message_type in _CRITICAL_TYPES:
                    critical.append(m)
                elif m.task_id and m.task_id in _pending_dep_task_ids:
                    dep_protected.append(m)
                else:
                    trimmable.append(m)
            while len(full) > max_chars and trimmable:
                trimmable.pop(0)
                remaining = sorted(critical + dep_protected + trimmable, key=lambda m: m.timestamp)
                pub_lines = ["═══ BLACKBOARD — PUBLIC SPACE (trimmed) ═══"]
                for m in remaining:
                    pub_lines.append(self._format_message(m))
                sections[0] = "\n".join(pub_lines)
                full = "\n\n".join(sections)
            if len(full) > max_chars and dep_protected:
                while len(full) > max_chars and dep_protected:
                    dep_protected.pop(0)
                    remaining = sorted(critical + dep_protected, key=lambda m: m.timestamp)
                    pub_lines = ["═══ BLACKBOARD — PUBLIC SPACE (trimmed) ═══"]
                    for m in remaining:
                        pub_lines.append(self._format_message(m))
                    sections[0] = "\n".join(pub_lines)
                    full = "\n\n".join(sections)
        return full

    def add_task_output(
        self,
        task_id: str,
        task_name: str,
        actor: str,
        output: dict[str, Any],
        file_artifacts: list[dict[str, str]] | None = None,
    ) -> None:
        """Sync compat — records task output on the public blackboard."""
        full_json = _json.dumps(output, default=str)

        stored_output = output
        offloaded_path: str | None = None
        if len(full_json) > self._TASK_OUTPUT_OFFLOAD_CHARS:
            import os
            shared_dir = os.environ.get("VINV_ENGINE_SHARED_DIR", DEFAULT_VINV_ENGINE_SHARED_DIR)
            os.makedirs(shared_dir, exist_ok=True)
            offloaded_path = os.path.join(shared_dir, f"task_output_{task_id}.md")
            try:
                # errors="replace": task_name may carry lone surrogates.
                with open(
                    offloaded_path, "w", encoding="utf-8", errors="replace"
                ) as fh:
                    fh.write(f"# Task Output: {task_name}\n\n")
                    fh.write(full_json)
                self._register_task_output_offload(offloaded_path, full_json)
                stored_output = {
                    "_offloaded": True,
                    "_offloaded_path": offloaded_path,
                    "_offloaded_chars": len(full_json),
                }
                full_json = _json.dumps(stored_output, default=str)
            except OSError:
                pass

        content: dict[str, Any] = {
            "actor": actor,
            "success": True,
            "summary": full_json,
        }
        if file_artifacts:
            content["file_artifacts"] = file_artifacts
        if offloaded_path:
            content.setdefault("file_artifacts", [])
            content["file_artifacts"].append({
                "path": offloaded_path,
                "type": "task_output_offload",
            })
        self.add_message(AgentMessage(
            sender=actor,
            receiver="*",
            message_type=CommunicationType.TASK_OUTPUT,
            content=content,
            task_id=task_id,
            task_name=task_name,
            output_data=stored_output,
        ))

    def get_task_outputs(self, task_ids: list[str] | None = None) -> list[AgentMessage]:
        with self._lock:
            msgs = list(self.messages)
        return [
            m for m in msgs
            if m.message_type == CommunicationType.TASK_OUTPUT
            and (task_ids is None or m.task_id in task_ids)
            and id(m) not in self._cleaned_ids
        ]

    def get_completed_task_summary(
        self, task_ids: list[str] | None = None,
    ) -> str:
        outputs = self.get_task_outputs(task_ids=task_ids)
        if not outputs:
            return ""
        header = (
            "DEPENDENCY TASK OUTPUTS:" if task_ids
            else "COMPLETED TASKS SO FAR:"
        )
        lines = [header]
        for m in outputs:
            status = "SUCCESS" if m.content.get("success") else "FAILED"
            actor = m.content.get("actor", m.sender)
            summary = m.content.get("summary", "")
            fa = m.content.get("file_artifacts", [])
            fa_str = f" | files: {[f.get('path','?') for f in fa]}" if fa else ""
            lines.append(f"  [{m.task_id}] {m.task_name} ({actor}) — {status}{fa_str}")
            if summary:
                lines.append(f"    output: {summary}")
        return "\n".join(lines)

    def add_knowledge_share(
        self, sender: str, receiver: str, data: dict[str, Any],
    ) -> None:
        self.add_message(AgentMessage(
            sender=sender,
            receiver=receiver,
            message_type=CommunicationType.KNOWLEDGE_SHARE,
            content=data,
        ))

    def broadcast_data(self, sender: str, data: dict[str, Any]) -> None:
        self.add_message(AgentMessage(
            sender=sender,
            receiver="*",
            message_type=CommunicationType.BROADCAST,
            content=data,
        ))

    def add_file_delivery(
        self, sender: str, receiver: str, file_path: str, description: str = "",
    ) -> None:
        self.add_message(AgentMessage(
            sender=sender,
            receiver=receiver,
            message_type=CommunicationType.FILE_DELIVERY,
            content={"description": description},
            file_path=file_path,
        ))

    def add_credential_handoff(
        self,
        sender: str,
        receiver: str,
        credentials: dict[str, str],
        description: str = "",
        ttl_seconds: float = 600.0,
    ) -> None:
        self.add_message(AgentMessage(
            sender=sender,
            receiver=receiver,
            message_type=CommunicationType.KNOWLEDGE_SHARE,
            content={
                "type": "credential_handoff",
                "description": description,
                "credentials": credentials,
                "expires_at": time.time() + ttl_seconds,
            },
        ))

    def get_credentials_for(self, receiver: str) -> list[dict[str, Any]]:
        now = time.time()
        results: list[dict[str, Any]] = []
        for m in self.get_messages_for(receiver):
            if (
                m.message_type == CommunicationType.KNOWLEDGE_SHARE
                and isinstance(m.content, dict)
                and m.content.get("type") == "credential_handoff"
            ):
                expires = m.content.get("expires_at", 0)
                if expires > now:
                    results.append({
                        "from": m.sender,
                        "description": m.content.get("description", ""),
                        "credentials": m.content.get("credentials", {}),
                        "expires_in_seconds": round(expires - now),
                    })
        return results

    def cache_tool_result(self, tool_name: str, tool_args: dict, result: Any) -> None:
        with self._lock:
            self._evict_expired()
            key = self._cache_key(tool_name, tool_args)
            self._tool_cache[key] = (result, time.time())
            if len(self._tool_cache) > self._max_cache:
                self._tool_cache.popitem(last=False)

    def get_cached_result(self, tool_name: str, tool_args: dict) -> Any | None:
        with self._lock:
            self._evict_expired()
            key = self._cache_key(tool_name, tool_args)
            entry = self._tool_cache.get(key)
            if entry is None:
                return None
            return entry[0]

    def clear(self) -> None:
        with self._lock:
            self.messages.clear()
            self._private_spaces.clear()
            self._cleaned_ids.clear()
            self._tool_cache.clear()
        self._persist_truncate()
        self._gc_task_output_offloads()

    def clear_goal_scoped(self, current_goal: str = "", project_id: str = "") -> None:
        if not current_goal and not project_id:
            self.clear()
            return

        with self._lock:
            preserved: list[AgentMessage] = []
            for m in self.messages:
                if self._is_run_scoped_message(m):
                    continue
                if m.message_type in (
                    CommunicationType.KNOWLEDGE_SHARE,
                    CommunicationType.INSIGHT,
                ):
                    preserved.append(m)
                elif (
                    project_id
                    and isinstance(m.content, dict)
                    and m.content.get("project_id") == project_id
                ):
                    preserved.append(m)
            self.messages = preserved
            self._tool_cache.clear()
            self._cleaned_ids.clear()
        self._persist_truncate()
        for m in preserved:
            self._persist_append(m)
        self._gc_task_output_offloads()

    # ------------------------------------------------------------------
    # Async disk persistence (non-blocking I/O)
    # ------------------------------------------------------------------

    async def _async_persist_append(self, message: AgentMessage) -> None:
        if self._persist_path is None:
            return
        try:
            import asyncio as _asyncio
            from core.components.common.persistence import AtomicWriter
            await _asyncio.to_thread(
                AtomicWriter.append_line,
                self._persist_path,
                message.model_dump(mode="json"),
            )
        except Exception:
            pass

    async def _async_persist_truncate(self) -> None:
        if self._persist_path is None:
            return
        try:
            import asyncio as _asyncio
            def _trunc():
                if self._persist_path.exists():
                    self._persist_path.write_text("")
            await _asyncio.to_thread(_trunc)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Sync disk persistence (compat)
    # ------------------------------------------------------------------

    def _persist_append(self, message: AgentMessage) -> None:
        if self._persist_path is None:
            return
        try:
            from core.components.common.persistence import AtomicWriter
            AtomicWriter.append_line(self._persist_path, message.model_dump(mode="json"))
        except Exception:
            pass

    def _persist_truncate(self) -> None:
        if self._persist_path is None:
            return
        try:
            if self._persist_path.exists():
                self._persist_path.write_text("")
        except Exception:
            pass

    def _restore_from_disk(self) -> None:
        """Replay JSONL file to rebuild in-memory state on startup.

        ``user_live_instruction`` messages are scoped to the run that produced
        them (they carry a live user request injected mid-execution).  They must
        never bleed into subsequent runs, so they are silently dropped here.
        """
        if self._persist_path is None or not self._persist_path.exists():
            return
        try:
            from core.components.common.persistence import AtomicWriter
            lines = AtomicWriter.read_lines(self._persist_path)
        except Exception:
            return
        for line in lines:
            try:
                raw = _json.loads(line)
                # Drop run-scoped user instructions — they must not replay into
                # a new run even if they are within the TTL window.
                content = raw.get("content") or {}
                if isinstance(content, dict) and content.get("type") == "user_live_instruction":
                    continue
                self.messages.append(AgentMessage.model_validate(raw))
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _evict_expired(self) -> None:
        now = time.time()
        expired = [k for k, (_, ts) in self._tool_cache.items() if now - ts > self._ttl]
        for k in expired:
            del self._tool_cache[k]

    @staticmethod
    def _cache_key(tool_name: str, tool_args: dict) -> str:
        raw = f"{tool_name}:{sorted(tool_args.items())}"
        return hashlib.md5(raw.encode()).hexdigest()


class StreamChannel:
    """Incremental data channel for real-time inter-actor collaboration.

    Allows a producer actor to publish data chunks incrementally,
    and consumer actors to subscribe and read chunks as they arrive.
    Used for streaming collaboration (e.g., WebSearchAgent streaming
    search results to DocumentationAgent in real time).

    Supports on_publish callbacks so that listeners (e.g. the coordinator)
    are notified immediately when new data arrives, enabling event-driven
    re-evaluation of downstream tasks instead of polling.
    """

    def __init__(self, channel_id: str, producer: str) -> None:
        self.channel_id = channel_id
        self.producer = producer
        self.chunks: list[dict[str, Any]] = []
        self.subscribers: set[str] = set()
        self.read_cursors: dict[str, int] = {}
        self.closed = False
        self.created_at = time.time()
        self._on_publish_callbacks: list[Callable[[str, dict[str, Any]], None]] = []

    def add_on_publish(self, callback: Callable[[str, dict[str, Any]], None]) -> None:
        """Register a callback invoked on each publish(). Args: (channel_id, data)."""
        self._on_publish_callbacks.append(callback)

    def publish(self, data: dict[str, Any]) -> None:
        """Producer publishes a data chunk to the channel."""
        if self.closed:
            return
        self.chunks.append({
            "data": data,
            "timestamp": time.time(),
            "index": len(self.chunks),
        })
        for cb in self._on_publish_callbacks:
            try:
                cb(self.channel_id, data)
            except Exception:
                pass

    def subscribe(self, actor_name: str) -> None:
        """Consumer subscribes to receive chunks."""
        self.subscribers.add(actor_name)
        if actor_name not in self.read_cursors:
            self.read_cursors[actor_name] = 0

    def read_new(self, actor_name: str) -> list[dict[str, Any]]:
        """Consumer reads all chunks since its last read."""
        cursor = self.read_cursors.get(actor_name, 0)
        new_chunks = self.chunks[cursor:]
        self.read_cursors[actor_name] = len(self.chunks)
        return new_chunks

    def close(self) -> None:
        """Producer signals no more data will be published."""
        self.closed = True

    @property
    def has_data(self) -> bool:
        return len(self.chunks) > 0


class SharedContext:
    """Global shared context propagated across the hero pipeline.

    Thread-safe key-value store for todo_state, agent_directory,
    metadata, deliverables, etc. Also hosts StreamChannels for
    real-time inter-actor collaboration.
    """

    def __init__(self) -> None:
        import threading as _threading
        self._data: dict[str, Any] = {}
        self._streams: dict[str, StreamChannel] = {}
        self._lock = _threading.Lock()

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = value

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(key, default)

    def delete(self, key: str) -> None:
        """Remove a key from the shared context if it exists."""
        with self._lock:
            self._data.pop(key, None)

    def get_all(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._data)

    def keys(self) -> list[str]:
        with self._lock:
            return list(self._data.keys())

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._data)

    def append_list(self, key: str, items: list[Any]) -> None:
        """Atomically extend a list stored under *key*.

        Avoids the read-modify-write race where two parallel actors both
        read ``[]``, append independently, and one set overwrites the other.
        """
        if not items:
            return
        with self._lock:
            existing = self._data.get(key)
            if not isinstance(existing, list):
                existing = []
            self._data[key] = existing + items

    # ------------------------------------------------------------------
    # StreamChannel API for real-time inter-actor collaboration
    # ------------------------------------------------------------------

    def create_stream(self, channel_id: str, producer: str) -> StreamChannel:
        """Create a new stream channel for incremental data publishing."""
        channel = StreamChannel(channel_id=channel_id, producer=producer)
        with self._lock:
            self._streams[channel_id] = channel
        return channel

    def create_stream_with_listener(
        self,
        channel_id: str,
        producer: str,
        on_publish: Callable[[str, dict[str, Any]], None],
    ) -> StreamChannel:
        """Create a stream channel and register an on_publish callback.

        Used by the coordinator to wire producer/consumer contracts at
        dispatch time so that downstream task re-evaluation is triggered
        as soon as the upstream actor publishes data.
        """
        channel = self.create_stream(channel_id, producer)
        channel.add_on_publish(on_publish)
        return channel

    def get_stream(self, channel_id: str) -> StreamChannel | None:
        """Get a stream channel by ID."""
        with self._lock:
            return self._streams.get(channel_id)

    def subscribe_to_stream(self, channel_id: str, actor_name: str) -> bool:
        """Subscribe an actor to a stream channel. Returns True if channel exists."""
        with self._lock:
            channel = self._streams.get(channel_id)
        if channel is None:
            return False
        channel.subscribe(actor_name)
        return True

    def read_stream(self, channel_id: str, actor_name: str) -> list[dict[str, Any]]:
        """Read new data from a stream channel."""
        with self._lock:
            channel = self._streams.get(channel_id)
        if channel is None:
            return []
        return channel.read_new(actor_name)

    def publish_to_stream(self, channel_id: str, data: dict[str, Any]) -> bool:
        """Publish data to a stream channel. Returns True if channel exists."""
        with self._lock:
            channel = self._streams.get(channel_id)
        if channel is None:
            return False
        channel.publish(data)
        return True

    def get_active_streams(self) -> list[str]:
        """Return IDs of all active (non-closed) streams."""
        with self._lock:
            return [cid for cid, ch in self._streams.items() if not ch.closed]

    def close_stream(self, channel_id: str) -> None:
        """Close a stream channel."""
        with self._lock:
            channel = self._streams.get(channel_id)
        if channel is not None:
            channel.close()


# ---------------------------------------------------------------------------
# Context Ledger — append-only output accumulator with async distillation
# ---------------------------------------------------------------------------


class LedgerEntry:
    """Single entry in the context ledger.  Mutable: content is refined in-place
    when the async ``OutputDistillerActor`` finishes its LLM distillation pass.
    """

    __slots__ = (
        "task_id", "task_name", "actor_used", "success",
        "raw_output", "content", "distilled", "file_artifacts", "url_artifacts",
        "appended_at", "quality_score", "compression_audit",
        "stored_result",
    )

    def __init__(
        self,
        task_id: str,
        task_name: str,
        actor_used: str,
        success: bool,
        raw_output: dict[str, Any],
        quality_score: float = 0.5,
    ) -> None:
        self.task_id = task_id
        self.task_name = task_name
        self.actor_used = actor_used
        self.success = success
        self.raw_output = raw_output
        self.content: str = _json.dumps(raw_output, default=str)
        self.distilled: bool = False
        self.file_artifacts: list[dict[str, str]] = []
        self.url_artifacts: list[dict[str, str]] = []
        self.appended_at: float = time.monotonic()
        self.quality_score: float = quality_score
        self.compression_audit: dict[str, Any] | None = None
        self.stored_result: Any = None  # StoredResult | None — set when output persisted to disk

    def refine(self, distilled_content: Any) -> None:
        """Called by the distiller — replaces content in-place."""
        if isinstance(distilled_content, (dict, list)):
            self.content = _json.dumps(distilled_content, default=str)
        else:
            self.content = str(distilled_content) if distilled_content is not None else ""
        self.distilled = True


class ContextLedger:
    """Append-only ledger of task outputs.  Single instance per run, shared
    across all batches.

    * ``append()`` — adds full raw output after each task completes.
    * ``refine()`` — distiller replaces an entry's content in-place (async).
    * ``get_context_for()`` — returns ordered entries for a task's dependencies.
    * ``get_all()`` — returns the full ledger (debugging / env context).
    """

    def __init__(self) -> None:
        import threading as _threading
        self._entries: dict[str, LedgerEntry] = {}
        self._order: list[str] = []
        self._lock = _threading.Lock()

    def append(self, entry: LedgerEntry) -> None:
        with self._lock:
            self._entries[entry.task_id] = entry
            self._order.append(entry.task_id)

    def refine(self, task_id: str, distilled_content: str) -> None:
        with self._lock:
            entry = self._entries.get(task_id)
            if entry:
                entry.refine(distilled_content)

    def get(self, task_id: str) -> LedgerEntry | None:
        with self._lock:
            return self._entries.get(task_id)

    def get_context_for(self, depends_on: list[str]) -> list[LedgerEntry]:
        """Return ledger entries for the given dependency task IDs, in order."""
        with self._lock:
            return [self._entries[tid] for tid in depends_on if tid in self._entries]

    def get_all(self) -> list[LedgerEntry]:
        with self._lock:
            return [self._entries[tid] for tid in self._order if tid in self._entries]

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


# ---------------------------------------------------------------------------
# Confidence Override
# ---------------------------------------------------------------------------


def _env_float(key: str, default: float) -> float:
    import os as _os
    raw = _os.environ.get(key)
    if raw is not None:
        try:
            return float(raw)
        except (ValueError, TypeError):
            pass
    return default


def _env_int(key: str, default: int) -> int:
    import os as _os
    raw = _os.environ.get(key)
    if raw is not None:
        try:
            return int(raw)
        except (ValueError, TypeError):
            pass
    return default


class OverrideConfig(BaseModel):
    """Configuration for confidence-based override mechanism.

    All numeric fields are overridable via VINV_ENGINE_OVERRIDE_* environment
    variables so that thresholds can be tuned without code changes.
    """

    enabled: bool = True
    threshold: float = Field(default_factory=lambda: _env_float("VINV_ENGINE_OVERRIDE_THRESHOLD", 0.30))
    moving_average_alpha: float = Field(default_factory=lambda: _env_float("VINV_ENGINE_OVERRIDE_MA_ALPHA", 0.7))
    min_actor_confidence: float = Field(default_factory=lambda: _env_float("VINV_ENGINE_OVERRIDE_MIN_ACTOR_CONF", 0.70))
    max_validator_confidence: float = Field(default_factory=lambda: _env_float("VINV_ENGINE_OVERRIDE_MAX_VALIDATOR_CONF", 0.95))
    planner_trust_prior: float = Field(default_factory=lambda: _env_float("VINV_ENGINE_OVERRIDE_PLANNER_TRUST_PRIOR", 0.72))
    planner_trust_decay: float = Field(default_factory=lambda: _env_float("VINV_ENGINE_OVERRIDE_PLANNER_TRUST_DECAY", 0.45))
    q_delta_sensitivity: float = Field(default_factory=lambda: _env_float("VINV_ENGINE_OVERRIDE_Q_DELTA_SENSITIVITY", 5.0))
    maturity_visits: int = Field(default_factory=lambda: _env_int("VINV_ENGINE_OVERRIDE_MATURITY_VISITS", 10))
    conservatism_bias: float = Field(default_factory=lambda: _env_float("VINV_ENGINE_OVERRIDE_CONSERVATISM_BIAS", 0.10))


# ---------------------------------------------------------------------------
# Credit Assignment
# ---------------------------------------------------------------------------


class AgentContribution(BaseModel):
    """Enhanced contribution tracking with reasoning analysis."""

    agent_name: str
    contribution_score: float = 0.0

    decision: str = ""
    decision_correct: bool = False
    counterfactual_impact: float = 0.0

    reasoning_quality: float = 0.0
    evidence_used: list[str] = Field(default_factory=list)
    tools_used: list[str] = Field(default_factory=list)

    decision_timing: float = 0.0
    temporal_weight: float = 1.0

    def compute_final_contribution(self) -> float:
        base = self.contribution_score
        reasoning_factor = 0.5 + 0.5 * self.reasoning_quality
        impact_factor = 0.5 + 0.5 * self.counterfactual_impact
        temporal_factor = 0.7 + 0.3 * self.decision_timing
        return base * reasoning_factor * impact_factor * temporal_factor


# ---------------------------------------------------------------------------
# Rerouting
# ---------------------------------------------------------------------------


class RerouteAction(str, Enum):
    SWITCH_ACTOR = "switch_actor"
    RETRY_SAME = "retry_same"
    RETRY_WITH_ENRICHMENT = "retry_with_enrichment"
    RETRY_WITH_STRATEGY_CHANGE = "retry_with_strategy_change"
    DECOMPOSE = "decompose"
    ACCEPT_PARTIAL = "accept_partial"
    FAIL_PERMANENT = "fail_permanent"
    ESCALATE_TO_USER = "escalate_to_user"


class RerouteDecision(BaseModel):
    """Result of a rerouting decision after actor failure."""

    action: RerouteAction
    reasoning: str = ""
    confidence: float = 0.5
    suggested_actor: str | None = None
    enrichment_data: dict[str, Any] = Field(default_factory=dict)
    sub_tasks: list[dict[str, Any]] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Attempt Tracking (for progressive enrichment + stale detection)
# ---------------------------------------------------------------------------


class AttemptOutcome(BaseModel):
    """Record of a single execution attempt for stale retry detection."""

    attempt_number: int
    actor_used: str = ""
    output_hash: str = ""
    output_summary: str = ""
    auditor_tag: OutputTag | None = None
    auditor_reasoning: str = ""
    sources_tried: list[str] = Field(default_factory=list)
    data_collected: list[str] = Field(default_factory=list)
