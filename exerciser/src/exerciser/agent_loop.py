"""The shared agent-in-the-loop channel — asked once, cached forever, budgeted.

Several oracles hit a question that no amount of structure answers, because the
answer lives in intent rather than in syntax:

* *differential* — "is this refusal a documented limit, or a defect wearing a
  refusal message?"
* *functions* — "is this exception the library refusing my made-up argument, or
  a real break?" (the learned policy answers most of these; the borderline
  band is where evidence is thin)
* *faults* — "what IS the type contract of this boundary?" — the fault
  cataloguer needs a contract, and requiring a human to write one by hand is
  exactly the thing that stops the oracle being used on a new repo.
* *differential (reference finding)* — "what is the reference implementation
  for this function?" for symbols the shape rules cannot see.

Answering those with hand-written rules does not survive contact with an
unfamiliar codebase, and answering every one of them with a model call is not a
design either — it is a bill that grows with the repo. So they all go through
one channel with the same three cost properties:

1. **Deduplicated by SHAPE.** A question is keyed by a normalised digest of its
   subject, so sixty occurrences of one message shape are one question.
2. **Cached permanently.** An answered question is never asked again; the
   steady-state cost of a repeat run is zero model calls.
3. **Budgeted.** ``max_new`` caps how many NEW questions a run may raise, and
   the overflow is REPORTED, never silently dropped — a truncated queue that
   looks like a clean run is the failure mode this whole codebase exists to
   avoid.

The transport is the repo's established contract: questions are rendered as
prompts into a JSON file, the extension (or any agent) dispatches them and
writes back a verdict, and the next run reads the verdicts. Nothing here calls
a model directly, so the engine stays runnable — and testable — with no
network at all.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import store

# Default ceiling on NEW questions per channel per run.
DEFAULT_MAX_NEW = 25

_DIGITS = re.compile(r"\d+")
_WS = re.compile(r"\s+")


def question_key(topic: str, subject: str) -> str:
    """Stable id for one question SHAPE.

    Digits are normalised (line numbers, ids and sizes vary run to run without
    changing what is being asked) and whitespace collapsed, so an answer
    generalises to every future occurrence of the same shape.
    """
    norm = _WS.sub(" ", _DIGITS.sub("#", subject or "")).strip().lower()[:400]
    return hashlib.sha256(f"{topic}|{norm}".encode()).hexdigest()[:16]


@dataclass
class Question:
    """One thing the engine could not decide structurally."""

    key: str
    topic: str
    subject: str
    prompt: str
    reply_schema: str
    context: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "topic": self.topic,
            "subject": self.subject,
            "prompt": self.prompt,
            "reply_schema": self.reply_schema,
            "context": self.context,
            "answer": None,
        }


class AgentChannel:
    """A budgeted, self-caching queue of questions for one repo."""

    def __init__(self, repo: Path, topic: str, *, max_new: int = DEFAULT_MAX_NEW):
        self.repo = repo
        self.topic = topic
        self.max_new = max_new
        self._doc = store.read_json(self._path()) or {}
        self._entries: dict[str, dict[str, Any]] = dict(self._doc.get("questions") or {})
        self._asked_this_run: list[str] = []
        self.overflow = 0

    def _path(self) -> Path:
        return store.exercise_dir(self.repo) / f"agent_{self.topic}.json"

    # ---- answers ---------------------------------------------------------

    def answer(self, key: str) -> Any:
        """The stored answer for a question shape, or None when unanswered."""
        entry = self._entries.get(key)
        if not isinstance(entry, dict):
            return None
        return entry.get("answer")

    def answered(self, key: str) -> bool:
        return self.answer(key) is not None

    # ---- asking ----------------------------------------------------------

    def ask(self, question: Question) -> Any:
        """Return a cached answer, or enqueue the question and return None.

        Enqueuing is idempotent and budget-bounded: a question already on the
        queue is not re-added, and once ``max_new`` NEW shapes have been raised
        this run the rest are counted in ``overflow`` rather than queued.
        """
        cached = self.answer(question.key)
        if cached is not None:
            return cached
        if question.key in self._entries:
            return None  # already queued, still unanswered
        if len(self._asked_this_run) >= self.max_new:
            self.overflow += 1
            return None
        self._entries[question.key] = question.to_json()
        self._asked_this_run.append(question.key)
        return None

    # ---- persistence -----------------------------------------------------

    def pending(self) -> list[dict[str, Any]]:
        return [e for e in self._entries.values() if e.get("answer") is None]

    def save(self, logger: logging.Logger | None = None) -> dict[str, Any]:
        """Persist the queue and return a summary for the run document."""
        log = logger or logging.getLogger(__name__)
        store.exercise_dir(self.repo).mkdir(parents=True, exist_ok=True)
        store.write_json(
            self._path(),
            {
                "version": 1,
                "topic": self.topic,
                "how_to_answer": (
                    "Fill each question's `answer` field with an object matching "
                    "its `reply_schema`. Answers are cached by question shape and "
                    "never re-asked, so the cost of this channel falls to zero as "
                    "the repo's recurring questions get settled."
                ),
                "questions": self._entries,
            },
        )
        pending = self.pending()
        summary = {
            "topic": self.topic,
            "asked_this_run": len(self._asked_this_run),
            "pending": len(pending),
            "answered": sum(1 for e in self._entries.values() if e.get("answer") is not None),
            "overflow": self.overflow,
            "file": str(self._path()),
        }
        if self.overflow:
            log.warning(
                "agent channel %s: %d question(s) over the max_new=%d budget were "
                "not queued this run",
                self.topic,
                self.overflow,
                self.max_new,
            )
        log.info(
            "agent channel %s: %d new, %d pending, %d answered",
            self.topic,
            summary["asked_this_run"],
            summary["pending"],
            summary["answered"],
        )
        return summary


def channel_summary(repo: Path, topics: tuple[str, ...]) -> dict[str, Any]:
    """Cross-channel view: what the engine is still waiting on, and its cost.

    ``model_calls_saved`` is the honest measure of the caching claim — how many
    questions this repo has already settled and will never pay for again.
    """
    out: dict[str, Any] = {"channels": {}, "pending_total": 0, "answered_total": 0}
    for topic in topics:
        doc = store.read_json(store.exercise_dir(repo) / f"agent_{topic}.json") or {}
        questions = doc.get("questions") or {}
        answered = sum(
            1 for e in questions.values() if isinstance(e, dict) and e.get("answer") is not None
        )
        pending = len(questions) - answered
        out["channels"][topic] = {"answered": answered, "pending": pending}
        out["pending_total"] += pending
        out["answered_total"] += answered
    out["model_calls_saved"] = out["answered_total"]
    return out
