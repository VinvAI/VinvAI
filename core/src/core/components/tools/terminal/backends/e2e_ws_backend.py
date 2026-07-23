"""E2E Electron terminal — WebSocket bridge to ``e2e/app`` node-pty (tier 2 after primary Electron)."""

from __future__ import annotations

import logging
from typing import Any, Optional

from core.components.timeout_registry import get_timeout_seconds
from core.components.tools.terminal import session_state as st
from core.components.tools.terminal import terminal_events as tev
from core.components.tools.terminal.e2e_ws_client import close_connection, ws_request
from core.components.tools.terminal.ipc_transport import _ipc_with_instance

logger = logging.getLogger(__name__)


def initialize_terminal(
    session_name: Optional[str],
    working_directory: Optional[str],
    shell: str,
) -> dict[str, Any]:
    session_name = session_name or st._default_session_name
    cwd = working_directory or st._default_working_directory()
    iid = st.get_current_terminal_instance_id()
    is_reuse = iid in st.get_electron_instances()
    logger.info(
        "🖥️ E2E WS terminal init: session_name=%s instance_id=%s cwd=%s shell=%s reuse=%s",
        session_name, iid, cwd, shell, is_reuse,
    )

    # B1: even when the instance is already known, forward the `create` IPC
    # so the bridge has a chance to honor a NEW cwd. The bridge's
    # TerminalService.create now detects an existing PTY and either reuses
    # it as-is (cwd unchanged) or issues a synthetic `cd` to the new cwd.
    # Without this, the agent's `initialize_terminal(working_directory=X)`
    # silently leaves the PTY parked in whatever cwd it was first opened in.

    _create_timeout = float(get_timeout_seconds("terminal.ipc_create"))
    payload = _ipc_with_instance({"type": "create", "shell": shell, "cwd": cwd})
    logger.info(
        "🖥️ E2E WS create request instance_id=%s cwd=%s timeout_s=%s reuse_path=%s",
        payload.get("instance_id"), cwd, _create_timeout, is_reuse,
    )
    resp = ws_request(payload, timeout=_create_timeout)
    logger.info(
        "🖥️ E2E WS create response success=%s status=%r error=%r message=%r keys=%s",
        bool(resp.get("success")),
        resp.get("status"),
        resp.get("error"),
        resp.get("message"),
        sorted(resp.keys()),
    )
    if resp.get("success"):
        st.electron_instances_add(iid)
        st.set_terminal_session_ref("e2e_ws_pty")
        return {
            "status": "success",
            "session_name": session_name,
            "instance_id": iid,
            "is_alive": True,
            "working_directory": cwd,
            "shell": shell,
            "pid": resp.get("pid"),
            "transport": "e2e_ws",
        }
    return {
        "status": "error",
        "error": resp.get("error", "E2E WS PTY creation failed"),
        "session_id": None,
    }


def close_terminal() -> dict[str, Any]:
    logger.info("🖥️ Closing terminal session (E2E WS)")
    iid = st.get_current_terminal_instance_id()

    if iid in st.get_electron_instances():
        ws_request(_ipc_with_instance({"type": "destroy"}))
        st.electron_instances_discard(iid)
        if not st.get_electron_instances():
            st.set_terminal_session_ref(None)
            close_connection()
        return {"status": "success", "message": "E2E WS PTY destroyed", "instance_id": iid}

    if st.get_terminal_session() is None:
        close_connection()
        return {"status": "success", "message": "No terminal session to close"}

    if st.get_terminal_session() == "e2e_ws_pty":
        ws_request(_ipc_with_instance({"type": "destroy"}))
        st.electron_instances_clear()
        st.set_terminal_session_ref(None)
        close_connection()
        return {"status": "success", "message": "E2E WS PTY destroyed"}

    close_connection()
    return {"status": "success", "message": "No E2E WS PTY for this instance"}


def send_terminal_command(keystrokes: str, duration: float, block: bool) -> dict[str, Any]:
    iid = st.get_current_terminal_instance_id()
    effective_duration = duration
    preview = keystrokes if len(keystrokes) <= 120 else keystrokes[:120] + "…"
    logger.info(
        "📤 E2E WS send_terminal_command instance_id=%s block=%s duration=%s keystrokes=%r",
        iid, block, effective_duration, preview,
    )
    ipc_payload = _ipc_with_instance(
        {
            "type": "command",
            "command": keystrokes,
            "duration": effective_duration,
            "block": block,
        }
    )
    # Cap the WS RPC wait time to ``duration + headroom`` so a wedged bridge
    # cannot consume more than ~1 command's worth of agent budget. Without
    # this cap each timeout costs the WS client default (5 minutes) which
    # eats a 40-iteration budget in 2-3 calls.  Headroom is generous so
    # commands that legitimately produce long output still complete.
    import os as _os
    _ws_headroom = float(_os.environ.get("VINV_ENGINE_WS_RPC_HEADROOM_SECONDS", "10"))
    _ws_max = float(_os.environ.get("VINV_ENGINE_WS_RPC_MAX_SECONDS", "60"))
    _rpc_timeout = min(_ws_max, max(effective_duration + _ws_headroom, 5.0))
    resp = ws_request(ipc_payload, timeout=_rpc_timeout)
    output = resp.get("output", "")
    status = "success" if resp.get("status") != "error" else "error"
    logger.info(
        "📥 E2E WS send_terminal_command response instance_id=%s status=%s output_bytes=%d error=%r",
        iid, status, len(output) if isinstance(output, str) else 0, resp.get("error"),
    )

    if status == "error" and "timeout" in (resp.get("error") or "").lower():
        logger.warning("[e2e-ws] command timeout instance=%s", iid)
        # A timeout strongly suggests the bridge is wedged or not actually
        # serving RPCs.  Drop the cached "reachable" bit so the next
        # backend resolution re-probes; if the listener is dead, the
        # caller falls back to pexpect instead of hammering WS.
        try:
            from core.components.tools.terminal.backend_resolver import (
                e2e_terminal_bridge_url,
                invalidate_bridge_health_cache,
            )
            invalidate_bridge_health_cache(e2e_terminal_bridge_url())
        except Exception:
            pass
        return {
            "status": "timeout",
            "command": keystrokes,
            "output": output or "",
            "error": resp.get("error", "timeout"),
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
    iid = st.get_current_terminal_instance_id()
    logger.info("🔍 E2E WS get_terminal_state instance_id=%s", iid)
    resp = ws_request(_ipc_with_instance({"type": "get_state"}), timeout=10.0)
    if resp.get("status") == "error":
        logger.warning("🔍 E2E WS get_terminal_state error instance_id=%s err=%r", iid, resp.get("error"))
        return {"status": "error", "output": "", "is_alive": False, "error": resp.get("error", "Unknown")}
    output = resp.get("output", "")
    logger.info(
        "🔍 E2E WS get_terminal_state response instance_id=%s output_bytes=%d is_alive=%s",
        iid, len(output) if isinstance(output, str) else 0, resp.get("is_alive", True),
    )
    return {
        "status": "success",
        "output": output,
        "is_alive": resp.get("is_alive", True),
        "error": None,
    }


def get_incremental_output() -> dict[str, Any]:
    iid = st.get_current_terminal_instance_id()
    resp = ws_request(_ipc_with_instance({"type": "get_output"}), timeout=10.0)
    if resp.get("status") == "error":
        logger.warning("🔍 E2E WS get_incremental_output error instance_id=%s err=%r", iid, resp.get("error"))
        return {"status": "error", "output": "", "error": resp.get("error", "Unknown")}
    output = resp.get("output", "")
    logger.info(
        "🔍 E2E WS get_incremental_output instance_id=%s output_bytes=%d",
        iid, len(output) if isinstance(output, str) else 0,
    )
    return {
        "status": "success",
        "output": output,
        "error": None,
    }
