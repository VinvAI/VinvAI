"""Optional bridge to the Electron UI session manager.

All session-management code lives inside vinv_engine.  This thin facade
re-exports the public API so consumer modules have a single stable
import path.
"""

from __future__ import annotations

import logging

from core.components.common.agent_session_manager import (
    AgentType,
    get_agent_session_manager,
    get_browser_response_queue,
    initialize_agent_session_manager,
    set_agent_session_manager,
)

logger = logging.getLogger(__name__)

_BRIDGE_AVAILABLE = True


def is_available() -> bool:
    logger.debug("session_bridge.is_available: %s", _BRIDGE_AVAILABLE)
    return _BRIDGE_AVAILABLE


__all__ = [
    "AgentType",
    "get_agent_session_manager",
    "get_browser_response_queue",
    "initialize_agent_session_manager",
    "set_agent_session_manager",
    "is_available",
]
