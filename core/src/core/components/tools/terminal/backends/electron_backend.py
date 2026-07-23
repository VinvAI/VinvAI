"""Electron (node-pty) terminal backend — primary, host-owned PTY."""

from __future__ import annotations

import logging
from typing import Any, Optional

from core.components.timeout_registry import get_timeout_seconds
from core.components.tools.terminal import session_state as st
from core.components.tools.terminal import terminal_events as tev
from core.components.tools.terminal.ipc_transport import _ipc_request, _ipc_with_instance

logger = logging.getLogger(__name__)


def initialize_terminal(
    session_name: Optional[str],
    working_directory: Optional[str],
    shell: str,
    *,
    ipc_create_timeout: float | None = None,
) -> dict[str, Any]:
    session_name = session_name or st._default_session_name
    cwd = working_directory or st._default_working_directory()
    logger.info("🖥️ Initializing terminal: session_name=%s", session_name)

    iid = st.get_current_terminal_instance_id()
    if iid in st.get_electron_instances():
        logger.info(
            "🖥️ Reusing existing Electron PTY (instance=%s session_name=%s)",
            iid,
            session_name,
        )
        return {
            "status": "success",
            "session_name": session_name,
            "instance_id": iid,
            "is_alive": True,
            "working_directory": cwd,
            "shell": shell,
            "pid": None,
            "transport": "electron_ipc",
        }

    _create_timeout = (
        float(ipc_create_timeout)
        if ipc_create_timeout is not None
        else float(get_timeout_seconds("terminal.ipc_create"))
    )
    resp = _ipc_request(
        _ipc_with_instance({"type": "create", "shell": shell, "cwd": cwd}),
        timeout=_create_timeout,
    )
    if resp.get("success"):
        st.electron_instances_add(iid)
        st.set_terminal_session_ref("electron_pty")
        return {
            "status": "success",
            "session_name": session_name,
            "instance_id": iid,
            "is_alive": True,
            "working_directory": cwd,
            "shell": shell,
            "pid": resp.get("pid"),
            "transport": "electron_ipc",
        }
    err = resp.get("error", "Electron PTY creation failed")
    logger.info(
        "🖥️ primary_electron create failed: error=%r response_keys=%s",
        err,
        sorted(resp.keys()),
    )
    return {
        "status": "error",
        "error": err,
        "session_id": None,
    }


def close_terminal() -> dict[str, Any]:
    logger.info("🖥️ Closing terminal session (Electron)")
    iid = st.get_current_terminal_instance_id()

    if iid in st.get_electron_instances():
        _ipc_request(_ipc_with_instance({"type": "destroy"}))
        st.electron_instances_discard(iid)
        if not st.get_electron_instances():
            st.set_terminal_session_ref(None)
        return {"status": "success", "message": "Electron PTY destroyed", "instance_id": iid}

    if st.get_terminal_session() is None:
        return {"status": "success", "message": "No terminal session to close"}

    if st.get_terminal_session() == "electron_pty":
        _ipc_request(_ipc_with_instance({"type": "destroy"}))
        st.electron_instances_clear()
        st.set_terminal_session_ref(None)
        return {"status": "success", "message": "Electron PTY destroyed"}

    return {"status": "success", "message": "No Electron PTY for this instance"}


def send_terminal_command(keystrokes: str, duration: float, block: bool) -> dict[str, Any]:
    iid = st.get_current_terminal_instance_id()
    effective_duration = duration
    ipc_payload = _ipc_with_instance(
        {
            "type": "command",
            "command": keystrokes,
            "duration": effective_duration,
            "block": block,
        }
    )
    timeout = None
    resp = _ipc_request(ipc_payload, timeout=timeout)
    output = resp.get("output", "")
    status = "success" if resp.get("status") != "error" else "error"

    if status == "error" and "IPC timeout" in (resp.get("error") or ""):
        logger.warning(
            "[terminal-ipc] IPC timeout on command (instance=%s). "
            "PTY likely busy with a running process — NOT destroying. "
            "Use get_incremental_output() to check progress.",
            iid,
        )
        return {
            "status": "timeout",
            "command": keystrokes,
            "output": output or "",
            "error": (
                "Command did not complete within IPC wait. "
                "The terminal is likely still running a previous command. "
                "Use get_incremental_output() to check what the terminal "
                "is doing, then decide whether to wait or interrupt."
            ),
        }

    tev.broadcast_terminal_event_sync("command", {"command": keystrokes})
    if output:
        tev.broadcast_terminal_event_sync("output", {"output": output})

    return {
        "status": status,
        "command": keystrokes,
        "output": output,
        "error": resp.get("error"),
    }


def get_terminal_state(_capture_entire: bool) -> dict[str, Any]:
    resp = _ipc_request(_ipc_with_instance({"type": "get_state"}), timeout=10.0)
    if resp.get("status") == "error":
        return {"status": "error", "output": "", "is_alive": False, "error": resp.get("error", "Unknown")}
    return {
        "status": "success",
        "output": resp.get("output", ""),
        "is_alive": resp.get("is_alive", True),
        "error": None,
    }


def get_incremental_output() -> dict[str, Any]:
    resp = _ipc_request(_ipc_with_instance({"type": "get_output"}), timeout=10.0)
    if resp.get("status") == "error":
        return {"status": "error", "output": "", "error": resp.get("error", "Unknown")}
    return {
        "status": "success",
        "output": resp.get("output", ""),
        "error": None,
    }
