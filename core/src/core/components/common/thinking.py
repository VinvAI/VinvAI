"""Vinv Engine / components / common / thinking — Structured thinking trace logger.

Captures the internal reasoning of hero actors, DSPy modules, and Surface
agents at every pipeline stage.  Written to a dedicated JSONL file so it can be
replayed, streamed, or rendered independently of operational logs.

Each entry includes:
  - ``ts``          — unix timestamp
  - ``actor``       — source actor / agent name
  - ``phase``       — pipeline phase (architect, executor, auditor, …)
  - ``event``       — thinking event type (see ``ThinkingEvent``)
  - ``step``        — step counter within a phase (e.g. ReAct step 1, 2 …)
  - ``content``     — the actual reasoning text / action / observation
  - ``elapsed_ms``  — time since the phase started
  - extra fields    — caller-supplied kwargs

Destinations:
  1. Date-stamped JSONL file: ``{logs_dir}/thinking_{YYYYMMDD}.jsonl``
  2. Optionally stderr (controlled at configure time)

Usage::

    from core.components.common import ThinkingTracer, configure_thinking

    configure_thinking(logs_dir=Path("vinv_engine/runtime_data/logs"))

    tracer = ThinkingTracer(actor="hero_architect", phase="planning")
    tracer.thinking("Analyzing task dependencies and constraints…")
    tracer.action("web_search", args={"query": "python REST frameworks"})
    tracer.observation("Found FastAPI, Flask, Django REST…", chars=312)
    tracer.decision("Recommending FastAPI for async support", confidence=0.85)
    tracer.phase_end(success=True)
"""

from __future__ import annotations

import enum
import json
import logging
import sys
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class ThinkingEvent(str, enum.Enum):
    """Canonical event types for the thinking trace."""

    PHASE_START = "phase_start"
    THINKING = "thinking"
    ACTION = "action"
    TOOL_START = "tool_start"
    TOOL_END = "tool_end"
    OBSERVATION = "observation"
    DECISION = "decision"
    RETRY = "retry"
    REROUTE = "reroute"
    NEGOTIATION = "negotiation"
    OVERRIDE = "override"
    INSIGHT = "insight"
    ERROR = "error"
    PHASE_END = "phase_end"
    STEP = "step"


_file_handler: Any | None = None
_stderr_enabled: bool = False
_write_lock = threading.Lock()


def configure_thinking(
    logs_dir: Path | str | None = None,
    *,
    stderr: bool = False,
    run_id: str | None = None,
) -> None:
    """Set up the thinking trace file.  Call once at startup.

    Args:
        logs_dir: Directory for the ``thinking_*.jsonl`` file.
                  Defaults to ``vinv_engine/runtime_data/logs``.
        stderr:   If *True*, also mirror thinking lines to stderr.
        run_id:   Unique identifier for this run. Used as the log filename stem.
                  If not provided, one is generated from the current timestamp.
    """
    global _file_handler, _stderr_enabled

    if _file_handler is not None:
        return

    if logs_dir is None:
        from core.components.common.runtime_paths import get_logs_dir

        logs_dir = get_logs_dir()
    logs_dir = Path(logs_dir)
    logs_dir.mkdir(parents=True, exist_ok=True)

    if run_id is None:
        run_id = time.strftime("%Y%m%d_%H%M%S")
    thinking_file = logs_dir / f"thinking_{run_id}.jsonl"
    _file_handler = open(thinking_file, "w", encoding="utf-8")  # noqa: SIM115
    _stderr_enabled = stderr
    logger.info(
        "configure_thinking: logs_dir=%s run_id=%s thinking_file=%s stderr=%s",
        logs_dir, run_id, thinking_file, stderr,
    )


def _write_entry(entry: dict[str, Any]) -> None:
    """Append a single JSON line to the thinking file (and optionally stderr).

    Thread-safe: ReAct iterations run inside ``asyncio.to_thread`` and emit
    thinking events from a worker thread concurrently with the event loop.
    """
    line = json.dumps(entry, default=str)
    with _write_lock:
        if _file_handler is not None:
            _file_handler.write(line + "\n")
            _file_handler.flush()
        if _stderr_enabled:
            print(f"[💭 THINKING] {line}", file=sys.stderr)


class ThinkingTracer:
    """Per-phase tracer that emits structured thinking entries.

    Create a new instance for each logical phase (architect planning,
    executor run, auditor validation, …).  The tracer tracks elapsed
    time and step count automatically.
    """

    def __init__(
        self,
        actor: str,
        phase: str,
        *,
        task_id: str = "",
        correlation_id: str = "",
    ) -> None:
        self.actor = actor
        self.phase = phase
        self.task_id = task_id
        self.correlation_id = correlation_id
        self._start = time.monotonic()
        self._step = 0

    def _elapsed_ms(self) -> float:
        return round((time.monotonic() - self._start) * 1000, 2)

    def _base(self, event: ThinkingEvent | str, **fields: Any) -> dict[str, Any]:
        return {
            "ts": time.time(),
            "actor": self.actor,
            "phase": self.phase,
            "event": event.value if isinstance(event, ThinkingEvent) else event,
            "step": self._step,
            "task_id": self.task_id,
            "correlation_id": self.correlation_id,
            "elapsed_ms": self._elapsed_ms(),
            **fields,
        }

    def _emit(self, event: ThinkingEvent | str, **fields: Any) -> None:
        _write_entry(self._base(event, **fields))

    # ── High-level helpers ──────────────────────────────────────────

    def phase_start(self, **extra: Any) -> None:
        """Mark the beginning of a pipeline phase."""
        self._step = 0
        self._start = time.monotonic()
        self._emit(ThinkingEvent.PHASE_START, **extra)

    def thinking(self, content: str, **extra: Any) -> None:
        """Record a reasoning / thought step."""
        self._step += 1
        self._emit(ThinkingEvent.THINKING, content=content, **extra)

    def action(self, action_name: str, *, args: Any = None, **extra: Any) -> None:
        """Record an action the actor is about to take."""
        self._emit(ThinkingEvent.ACTION, action=action_name, args=args, **extra)

    def tool_start(self, tool_name: str, **extra: Any) -> None:
        """Record the start of a tool invocation."""
        self._emit(ThinkingEvent.TOOL_START, tool=tool_name, **extra)

    def tool_end(self, tool_name: str, *, result_len: int = 0, **extra: Any) -> None:
        """Record the completion of a tool invocation."""
        self._emit(ThinkingEvent.TOOL_END, tool=tool_name, result_len=result_len, **extra)

    def observation(self, content: str, *, chars: int = 0, **extra: Any) -> None:
        """Record an observation from a tool or external source."""
        self._emit(ThinkingEvent.OBSERVATION, content=content, chars=chars or len(content), **extra)

    def decision(self, content: str, *, confidence: float = 0.0, **extra: Any) -> None:
        """Record a decision point (approve, reject, proceed, etc.)."""
        self._emit(ThinkingEvent.DECISION, content=content, confidence=confidence, **extra)

    def retry(self, reason: str, *, attempt: int = 0, **extra: Any) -> None:
        """Record a retry decision."""
        self._emit(ThinkingEvent.RETRY, reason=reason, attempt=attempt, **extra)

    def reroute(self, action: str, *, target_actor: str = "", **extra: Any) -> None:
        """Record a rerouting decision."""
        self._emit(ThinkingEvent.REROUTE, action=action, target_actor=target_actor, **extra)

    def negotiation(self, outcome: str, **extra: Any) -> None:
        """Record a negotiation result."""
        self._emit(ThinkingEvent.NEGOTIATION, outcome=outcome, **extra)

    def override(self, reason: str, *, score: float = 0.0, **extra: Any) -> None:
        """Record a confidence override."""
        self._emit(ThinkingEvent.OVERRIDE, reason=reason, score=score, **extra)

    def insight(self, content: str, *, from_agent: str = "", **extra: Any) -> None:
        """Record a shared insight."""
        self._emit(ThinkingEvent.INSIGHT, content=content, from_agent=from_agent, **extra)

    def error(self, message: str, **extra: Any) -> None:
        """Record an error during thinking."""
        self._emit(ThinkingEvent.ERROR, error=message, **extra)

    def step(self, content: str, **extra: Any) -> None:
        """Record a generic intermediate step."""
        self._step += 1
        self._emit(ThinkingEvent.STEP, content=content, **extra)

    def phase_end(self, *, success: bool = True, **extra: Any) -> None:
        """Mark the end of a pipeline phase."""
        self._emit(
            ThinkingEvent.PHASE_END,
            success=success,
            total_steps=self._step,
            total_elapsed_ms=self._elapsed_ms(),
            **extra,
        )
