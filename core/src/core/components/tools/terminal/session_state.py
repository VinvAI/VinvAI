"""Shared mutable state for terminal backends (Electron IPC + pexpect fallback)."""

from __future__ import annotations

import contextvars
import errno
import logging
import os
import re
import sys
import threading
from typing import Any, Optional

from core.components.project_context import get_project_root

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler(sys.stderr)
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s"))
    logger.addHandler(handler)

_terminal_session: Any = None
_pexpect_sessions: dict[str, Any] = {}
_default_session_name = "vinv_engine_default_terminal"

_current_terminal_instance_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "terminal_instance_id", default="default"
)

# Electron: node-pty instances successfully created.
_electron_instances: set[str] = set()

try:
    import pexpect  # type: ignore[reportMissingImports]

    PEXPECT_AVAILABLE = True
except ImportError:
    PEXPECT_AVAILABLE = False
    pexpect = None  # type: ignore[assignment]


def _default_working_directory() -> str:
    """Choose a writable default working directory for terminal sessions."""
    project_root = get_project_root()
    if project_root and project_root.is_dir():
        return str(project_root)

    shared_dir = (os.environ.get("VINV_ENGINE_SHARED_DIR") or os.path.expanduser("~/vinv_engine_shared")).strip()
    if shared_dir:
        try:
            os.makedirs(shared_dir, exist_ok=True)
        except Exception:
            pass
        if os.path.isdir(shared_dir):
            return shared_dir

    return os.getcwd()


def _sanitize_terminal_instance_id(raw: Optional[str]) -> str:
    if not raw or str(raw).strip() == "default":
        return "default"
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(raw).strip())
    s = s.strip("_") or "default"
    return s[:80] if len(s) <= 80 else s[:80]


def compose_terminal_instance_for_init(
    current_iid: str,
    session_name: Optional[str],
) -> str:
    """Map ``initialize_terminal``'s ``session_name`` to a concrete ``instance_id`` (multi-tab / multi-PTY).

    - ``None``, empty, or the default session name: return the **root** instance for this task
      (strip a trailing ``__sn_<slug>`` segment so the host reuses the main tab).
    - Any other ``session_name``: return ``<root>__sn_<slug>`` so Electron / E2E can open a
      **dedicated PTY** per service (API, web, worker, …).

    ``session_name`` here is the **raw** argument before ``or vinv_engine_default_terminal`` coalescing.
    """
    if not session_name or session_name == _default_session_name:
        if "__sn_" in current_iid:
            root = current_iid.split("__sn_", 1)[0]
            return _sanitize_terminal_instance_id(root)
        return _sanitize_terminal_instance_id(current_iid)
    slug = _sanitize_terminal_instance_id(session_name)
    root = current_iid.split("__sn_", 1)[0]
    return _sanitize_terminal_instance_id(f"{root}__sn_{slug}")


def set_current_terminal_instance_id(instance_id: str) -> contextvars.Token[str]:
    """Bind PTY routing for this task (async context; copied into ReAct worker threads)."""
    return _current_terminal_instance_id.set(_sanitize_terminal_instance_id(instance_id))


def get_current_terminal_instance_id() -> str:
    return _current_terminal_instance_id.get()


def _resolve_pexpect_child(iid: str) -> Any | None:
    """Return the live pexpect child for this instance, or None."""
    s = _pexpect_sessions.get(iid)
    if s is not None and not isinstance(s, str) and getattr(s, "sendline", None):
        return s
    ts = _terminal_session
    if ts is not None and not isinstance(ts, str) and getattr(ts, "sendline", None):
        return ts
    return None


def _pexpect_fd_is_dead(exc: BaseException) -> bool:
    if isinstance(exc, EOFError):
        return True
    # pexpect.EOF does NOT subclass builtin EOFError — match it structurally so
    # a shell exit is treated as a dead session (drop + reinit, never retry).
    if type(exc).__name__ == "EOF":
        return True
    if isinstance(exc, OSError):
        if exc.errno in (errno.EBADF, errno.EIO):
            return True
    msg = str(exc).lower()
    return "bad file descriptor" in msg or "end of file (eof)" in msg


_session_locks: dict[str, threading.RLock] = {}
_session_locks_guard = threading.Lock()


def session_lock(iid: str) -> threading.RLock:
    """Per-instance lock serializing PTY access (send / state / incremental / close).

    Concurrent readers used to interleave ``read``s on the same fd, splitting
    sentinel tokens across callers and corrupting incremental capture.
    """
    with _session_locks_guard:
        return _session_locks.setdefault(iid, threading.RLock())


def _drop_pexpect_session(iid: str, dead: Any | None = None) -> None:
    """Close and forget a dead pexpect session so initialize_terminal can spawn a new PTY."""
    global _terminal_session
    removed = _pexpect_sessions.pop(iid, None)
    if removed is None and dead is not None:
        for key, val in list(_pexpect_sessions.items()):
            if val is dead:
                removed = _pexpect_sessions.pop(key, None)
                break
    if removed is None and dead is not None and _terminal_session is dead:
        removed = dead
    if _terminal_session is removed:
        _terminal_session = next(iter(_pexpect_sessions.values()), None) if _pexpect_sessions else None
    if removed is not None and not isinstance(removed, str) and hasattr(removed, "close"):
        try:
            removed.close(force=True)
        except Exception:
            pass


def get_terminal_session() -> Any:
    return _terminal_session


def set_terminal_session_ref(session: Any) -> None:
    global _terminal_session
    _terminal_session = session


def get_electron_instances() -> set[str]:
    return _electron_instances


def electron_instances_add(iid: str) -> None:
    _electron_instances.add(iid)


def electron_instances_discard(iid: str) -> None:
    _electron_instances.discard(iid)


def electron_instances_clear() -> None:
    _electron_instances.clear()


def pexpect_sessions_get(key: str) -> Any:
    return _pexpect_sessions.get(key)


def pexpect_sessions_pop(key: str, default: Any = None) -> Any:
    return _pexpect_sessions.pop(key, default)


def pexpect_sessions_set(key: str, value: Any) -> None:
    _pexpect_sessions[key] = value


def pexpect_sessions_del(key: str) -> None:
    _pexpect_sessions.pop(key, None)


def pexpect_sessions_contains(key: str) -> bool:
    return key in _pexpect_sessions


def pexpect_sessions_non_empty() -> bool:
    return bool(_pexpect_sessions)
