"""Capture-health accounting: loud-once warnings + counters for the trace summary.

Robustness contract (fastapi-demo silent-empty-trace postmortem): a failure that
degrades or loses span capture must NEVER be a silently-eaten exception. It either
fails fast with one actionable line, or it degrades with (a) exactly one LOUD
warning on stderr and (b) a counter that lands in ``<output>.summary.json`` under
``capture_health``. This module is the single place both halves live so every
capture-path ``except`` can afford to use it.

stderr is deliberate: the ``tracelens.diag`` logger only reaches the console via
logging's last-resort handler, and a traced app that configures ``logging`` can
unknowingly route or filter those records away.
"""

from __future__ import annotations

import logging
import sys
import threading

_log = logging.getLogger("tracelens.diag")

_lock = threading.Lock()
_counters: dict[str, int] = {}
_notes: dict[str, str] = {}
_warned: set[str] = set()


def warn_once(key: str, message: str) -> None:
    """Emit one LOUD stderr warning per ``key`` per process (plus a log record).

    Once, because these fire from hot paths (span export, wrap_call) where a
    per-event print would flood the target's console; the counter recorded via
    :func:`record` carries the repeat count into the summary.
    """
    with _lock:
        if key in _warned:
            return
        _warned.add(key)
    _log.warning("tracelens: %s", message)
    try:
        print(f"\033[33m[tracelens] {message}\033[0m", file=sys.stderr)
    except Exception:  # stderr itself may be gone at interpreter shutdown
        pass


def record(key: str, *, note: str | None = None) -> None:
    """Bump a capture-health counter (optionally keeping the latest detail note)."""
    with _lock:
        _counters[key] = _counters.get(key, 0) + 1
        if note is not None:
            _notes[key] = note[:500]


def snapshot() -> dict[str, object]:
    """Counters + latest detail notes, for the summary's ``capture_health`` block."""
    with _lock:
        out: dict[str, object] = dict(_counters)
        for k, v in _notes.items():
            out[f"{k}_detail"] = v
        return out


def reset_for_tests() -> None:
    with _lock:
        _counters.clear()
        _notes.clear()
        _warned.clear()
