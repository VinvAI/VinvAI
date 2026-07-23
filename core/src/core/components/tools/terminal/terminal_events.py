"""Broadcast terminal events to Electron UI (session bridge)."""

from __future__ import annotations

import logging
import threading
from typing import Any

from core.components.common.session_bridge import (
    AgentType,
    get_agent_session_manager,
    is_available as _session_bridge_available,
)
from core.components.tools.terminal import session_state as st

logger = logging.getLogger(__name__)

AGENT_MANAGER_AVAILABLE = _session_bridge_available()


def notify_terminal_instance_ready(instance_id: str, agent_name: str) -> None:
    """Tell Electron to add a TerminalView card for this PTY instance (collaboration / parallel)."""
    safe = st._sanitize_terminal_instance_id(instance_id)
    if safe == "default":
        return
    if not AGENT_MANAGER_AVAILABLE:
        return
    try:
        import asyncio

        manager = get_agent_session_manager()
        if not manager:
            return

        agent_type = (
            AgentType.CODE_EXECUTOR
            if agent_name == "CodeExecutor"
            else AgentType.TERMINAL
        )

        async def _do_broadcast() -> None:
            try:
                await manager.broadcast_agent_event(
                    agent_type,
                    "terminal_instance_ready",
                    {"instance_id": safe, "agent": agent_name},
                )
            except Exception as e:
                logger.debug("Failed to broadcast terminal_instance_ready: %s", e)

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(_do_broadcast(), loop)
            else:
                loop.run_until_complete(_do_broadcast())
        except RuntimeError:

            def run_in_thread() -> None:
                asyncio.run(_do_broadcast())

            threading.Thread(target=run_in_thread, daemon=True).start()
    except Exception as e:
        logger.debug("notify_terminal_instance_ready failed: %s", e)


def broadcast_terminal_event_sync(event_type: str, data: dict[str, Any]) -> None:
    """Broadcast terminal event to Electron UI via AgentSessionManager."""
    if not AGENT_MANAGER_AVAILABLE:
        return
    try:
        import asyncio

        manager = get_agent_session_manager()
        if not manager:
            return

        async def _do_broadcast() -> None:
            try:
                await manager.broadcast_agent_event(AgentType.TERMINAL, event_type, data)
            except Exception as e:
                logger.debug("Failed to broadcast terminal event: %s", e)

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(_do_broadcast(), loop)
            else:
                loop.run_until_complete(_do_broadcast())
        except RuntimeError:

            def run_in_thread() -> None:
                asyncio.run(_do_broadcast())

            threading.Thread(target=run_in_thread, daemon=True).start()
    except Exception as e:
        logger.debug("broadcast_terminal_event_sync failed: %s", e)
