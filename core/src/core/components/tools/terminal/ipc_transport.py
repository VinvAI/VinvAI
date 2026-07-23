"""JSON IPC to Electron main process (node-pty). Primary Cursor-like terminal transport."""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import uuid
from typing import Any, Optional

from core.components.tools.terminal import session_state as st

logger = logging.getLogger(__name__)

# When True, stdin acks are delivered by the actor runtime reader (``feed_ipc_response``);
# do not start a competing ``_ipc_reader_thread``.
_runtime_terminal_ipc_feed_enabled = False

_pending_responses: dict[str, threading.Event] = {}
_response_data: dict[str, dict[str, Any]] = {}
_ipc_lock = threading.Lock()
_ipc_reader_thread: Optional[threading.Thread] = None

_IPC_MARKER = "_terminal_ipc"


def _send_ipc(msg: dict[str, Any]) -> None:
    """Write a JSON IPC message to stdout for Electron to intercept."""
    msg[_IPC_MARKER] = True
    line = json.dumps(msg, separators=(",", ":"))
    t0 = time.monotonic()
    logger.info(
        f"[terminal-ipc] Python sending request_id={msg.get('request_id')} "
        f"type={msg.get('type')} t_mono={t0:.6f}"
    )
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
    t1 = time.monotonic()
    logger.info(f"[terminal-ipc] Python flushed stdout (flush_sec={t1 - t0:.6f})")


def feed_ipc_response(msg: dict[str, Any]) -> bool:
    """Process a terminal IPC response (called by runtime stdin reader when running under Electron).

    Returns True if the message was a terminal IPC response and was handled, so the runtime
    should not process it as a mailbox inject. Used to avoid stdin contention: one reader
    in the runtime dispatches terminal IPC lines here instead of a separate thread.
    """
    if not msg.get(_IPC_MARKER):
        return False
    req_id = msg.get("request_id")
    if not req_id:
        return False
    t_ack = time.monotonic()
    logger.info(
        f"[terminal-ipc] Python received ack request_id={req_id} t_mono={t_ack:.6f} "
        "(fed by runtime stdin reader)"
    )
    with _ipc_lock:
        _response_data[req_id] = msg
        evt = _pending_responses.get(req_id)
        if evt:
            evt.set()
    return True


def _ipc_reader_loop() -> None:
    """Background thread that reads IPC responses from stdin (standalone/pexpect mode only)."""
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        feed_ipc_response(msg)


def _ensure_ipc_reader() -> None:
    """Start the stdin reader thread only when NOT under Electron (runtime feeds us via feed_ipc_response)."""
    global _ipc_reader_thread
    if _is_electron_ipc_available():
        return
    if _ipc_reader_thread is not None and _ipc_reader_thread.is_alive():
        return
    _ipc_reader_thread = threading.Thread(target=_ipc_reader_loop, daemon=True, name="terminal-ipc-reader")
    _ipc_reader_thread.start()


def _ipc_request(msg: dict[str, Any], timeout: float | None = 300.0) -> dict[str, Any]:
    """Send an IPC request and wait for the matching response."""
    _ensure_ipc_reader()

    req_id = msg.get("request_id") or str(uuid.uuid4())
    msg["request_id"] = req_id

    evt = threading.Event()
    with _ipc_lock:
        _pending_responses[req_id] = evt

    t0 = time.monotonic()
    _send_ipc(msg)

    if not evt.wait(timeout=timeout):
        with _ipc_lock:
            _pending_responses.pop(req_id, None)
            _response_data.pop(req_id, None)
        round_trip = time.monotonic() - t0
        logger.info(
            f"[terminal-ipc] IPC timeout request_id={req_id} type={msg.get('type')} "
            f"after {timeout}s (round_trip_sec={round_trip:.3f})"
        )
        return {"status": "error", "error": f"IPC timeout after {timeout}s"}

    t1 = time.monotonic()
    round_trip = t1 - t0
    with _ipc_lock:
        _pending_responses.pop(req_id, None)
        resp = _response_data.pop(req_id, {})

    logger.info(
        f"[terminal-ipc] round_trip_sec={round_trip:.3f} request_id={req_id} type={msg.get('type')} "
        "(Python send->ack received; if large, check stdout buffering / Electron busy / stdin contention)"
    )
    return resp


def _ipc_with_instance(msg: dict[str, Any]) -> dict[str, Any]:
    iid = st.get_current_terminal_instance_id()
    out = dict(msg)
    out["instance_id"] = iid
    return out


def legacy_vinv_engine_electron_pty_env() -> bool:
    """Opt-in legacy flag; primary Electron no longer requires this when using ``run.py`` stdin feed."""
    return os.environ.get("VINV_ENGINE_ELECTRON_PTY", "").lower() in ("1", "true", "yes")


def enable_runtime_terminal_ipc_feed(enabled: bool = True) -> None:
    """Call from ``vinv_engine.run`` after ``runtime.start()`` so primary IPC acks use ``feed_ipc_response``."""
    global _runtime_terminal_ipc_feed_enabled
    _runtime_terminal_ipc_feed_enabled = bool(enabled)
    if enabled:
        logger.info("terminal_ipc: runtime stdin feed enabled (primary Electron via feed_ipc_response)")


def terminal_stdin_acks_via_runtime() -> bool:
    return _runtime_terminal_ipc_feed_enabled


def _is_electron_ipc_available() -> bool:
    """True when stdin terminal IPC acks must not use a local ``_ipc_reader_thread`` (runtime feed or legacy env)."""
    return terminal_stdin_acks_via_runtime() or legacy_vinv_engine_electron_pty_env()


def is_terminal_host_owned() -> bool:
    """True when PTY is owned outside this process (primary Electron or E2E WS), not in-process pexpect."""
    try:
        ts = st.get_terminal_session()
        if ts in ("electron_pty", "e2e_ws_pty"):
            return True
    except Exception:
        pass
    return _is_electron_ipc_available()
