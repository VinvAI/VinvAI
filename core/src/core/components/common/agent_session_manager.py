"""Agent Session Manager — Electron UI session management.

Tracks which agent is currently active and broadcasts agent events
to Electron UI for automatic view switching.  Also handles
bidirectional communication for browser commands with a
request-response pattern.

This is a self-contained module with no external dependencies beyond
the Python standard library.  The WebSocket manager is injected at
initialisation time.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Browser command request / response
# ---------------------------------------------------------------------------

@dataclass
class PendingRequest:
    """A pending browser command request awaiting response.

    Uses ``threading.Event`` (not ``asyncio.Event``) because
    ``deliver_response`` is called from the WebSocket handler (async
    event-loop) while ``wait_for_response_sync`` polls from a worker
    thread.  ``threading.Event`` is fully thread-safe in both contexts.
    """

    request_id: str
    command: str
    params: Dict[str, Any]
    created_at: datetime = field(default_factory=datetime.now)
    event: threading.Event = field(default_factory=threading.Event)
    response: Optional[Dict[str, Any]] = None
    timeout_seconds: float = 30.0
    timed_out: bool = False


class BrowserCommandResponseQueue:
    """Thread-safe queue for browser command responses.

    1. Backend sends command with ``request_id``
    2. Electron executes and sends response with same ``request_id``
    3. Backend waits for and receives the response
    """

    def __init__(self) -> None:
        self._pending: Dict[str, PendingRequest] = {}
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def register_request(
        self,
        request_id: str,
        command: str,
        params: Dict[str, Any],
        timeout: float = 30.0,
    ) -> PendingRequest:
        with self._lock:
            request = PendingRequest(
                request_id=request_id,
                command=command,
                params=params,
                timeout_seconds=timeout,
            )
            self._pending[request_id] = request
            logger.debug("Registered pending request: %s (%s)", request_id, command)
            return request

    def deliver_response(self, request_id: str, response: Dict[str, Any]) -> bool:
        with self._lock:
            if request_id not in self._pending:
                logger.warning("Response for unknown request_id: %s", request_id)
                return False
            request = self._pending[request_id]
            request.response = response
            request.event.set()
            logger.debug("Delivered response for: %s", request_id)
            return True

    async def wait_for_response(
        self, request_id: str, timeout: Optional[float] = None
    ) -> Dict[str, Any]:
        with self._lock:
            if request_id not in self._pending:
                raise KeyError(f"Request not found: {request_id}")
            request = self._pending[request_id]

        wait_timeout = timeout if timeout is not None else request.timeout_seconds
        signalled = await asyncio.to_thread(request.event.wait, wait_timeout)

        if not signalled:
            with self._lock:
                if request_id in self._pending:
                    self._pending[request_id].timed_out = True
            raise TimeoutError(
                f"Browser command '{request.command}' timed out after {wait_timeout}s"
            )

        with self._lock:
            request = self._pending.pop(request_id, None)

        if request is None or request.response is None:
            raise RuntimeError(f"Response lost for request: {request_id}")
        return request.response

    def wait_for_response_sync(
        self, request_id: str, timeout: Optional[float] = None
    ) -> Dict[str, Any]:
        with self._lock:
            if request_id not in self._pending:
                raise KeyError(f"Request not found: {request_id}")
            request = self._pending[request_id]

        wait_timeout = timeout if timeout is not None else request.timeout_seconds
        signalled = request.event.wait(timeout=wait_timeout)

        if not signalled:
            with self._lock:
                if request_id in self._pending:
                    self._pending[request_id].timed_out = True
            raise TimeoutError(
                f"Browser command '{request.command}' timed out after {wait_timeout}s"
            )

        with self._lock:
            request = self._pending.pop(request_id, None)

        if request is None or request.response is None:
            raise RuntimeError(f"Response lost for request: {request_id}")
        return request.response

    def check_late_response(
        self, command: str, instance_id: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Retrieve a late response for a previously timed-out request."""
        with self._lock:
            for req_id, request in list(self._pending.items()):
                if (
                    request.timed_out
                    and request.command == command
                    and request.response is not None
                ):
                    if instance_id and request.params.get("instance_id") != instance_id:
                        continue
                    self._pending.pop(req_id, None)
                    logger.info(
                        "Retrieved late response for %s (request_id=%s)",
                        command,
                        req_id,
                    )
                    return request.response
        return None

    def cancel_request(self, request_id: str) -> None:
        with self._lock:
            self._pending.pop(request_id, None)

    def cleanup_stale_requests(self, max_age_seconds: float = 300.0) -> None:
        now = datetime.now()
        with self._lock:
            stale = [
                req_id
                for req_id, req in self._pending.items()
                if (now - req.created_at).total_seconds() > max_age_seconds
            ]
            for req_id in stale:
                self._pending.pop(req_id, None)
            if stale:
                logger.debug("Cleaned up %d stale pending requests", len(stale))

    def get_pending_count(self) -> int:
        with self._lock:
            return len(self._pending)


# ---------------------------------------------------------------------------
# Global browser response queue
# ---------------------------------------------------------------------------

_browser_response_queue: Optional[BrowserCommandResponseQueue] = None


def get_browser_response_queue() -> BrowserCommandResponseQueue:
    """Get or create the global browser response queue."""
    global _browser_response_queue
    if _browser_response_queue is None:
        _browser_response_queue = BrowserCommandResponseQueue()
        logger.info("BrowserCommandResponseQueue initialised")
    return _browser_response_queue


# ---------------------------------------------------------------------------
# Agent types & session manager
# ---------------------------------------------------------------------------

class AgentType(Enum):
    """Supported agent types."""

    BROWSER = "BrowserExecutor"
    TERMINAL = "TerminalExecutor"
    CODE_EXECUTOR = "CodeExecutor"
    WEBSEARCH = "WebSearchAgent"
    PLANNER = "PlannerAgent"


class AgentSessionManager:
    """Manages active agent views with parallel-execution support.

    When agents send events they become active/visible in the Electron
    UI.  Multiple agents can be active simultaneously.
    """

    def __init__(self, websocket_manager: Any) -> None:
        self.websocket_manager = websocket_manager
        self.active_agents: set = set()
        self.agent_states: Dict[str, Dict[str, Any]] = {}
        logger.info("AgentSessionManager initialised (multi-agent support)")

    async def activate_agent(self, agent_type: AgentType) -> None:
        if agent_type in self.active_agents:
            return
        self.active_agents.add(agent_type)
        self.agent_states[agent_type.value] = {
            "status": "active",
            "activated_at": datetime.now().isoformat(),
        }
        await self.websocket_manager.broadcast(
            {
                "type": "agent_activated",
                "agent": agent_type.value,
                "timestamp": datetime.now().isoformat(),
            }
        )
        logger.info(
            "Agent activated: %s (total active: %d)",
            agent_type.value,
            len(self.active_agents),
        )

    async def broadcast_agent_event(
        self,
        agent_type: AgentType,
        event_type: str,
        data: Dict[str, Any],
        agent_id: Optional[str] = None,
    ) -> None:
        if agent_type not in self.active_agents:
            await self.activate_agent(agent_type)
        await self.websocket_manager.broadcast(
            {
                "type": "agent_event",
                "agent": agent_type.value,
                "agent_id": agent_id,
                "event_type": event_type,
                "data": data,
                "timestamp": datetime.now().isoformat(),
            }
        )
        logger.debug("Agent event: %s.%s", agent_type.value, event_type)

    def get_active_agent(self) -> Optional[AgentType]:
        return next(iter(self.active_agents)) if self.active_agents else None

    def get_active_agents(self) -> set:
        return self.active_agents.copy()

    def get_agent_state(self, agent_type: AgentType) -> Dict[str, Any]:
        return self.agent_states.get(agent_type.value, {})

    def get_all_agent_states(self) -> Dict[str, Dict[str, Any]]:
        return self.agent_states.copy()

    async def broadcast_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        active_count = len(self.websocket_manager.active_connections)
        if active_count == 0:
            logger.warning(
                "No active WebSocket connections for broadcast: %s",
                message.get("type", "unknown"),
            )
            return {"success": False, "active_connections": 0, "error": "No active connections"}
        await self.websocket_manager.broadcast(message)
        remaining_count = len(self.websocket_manager.active_connections)
        logger.debug(
            "Broadcast message: %s | connections: %d",
            message.get("type", "unknown"),
            remaining_count,
        )
        return {"success": remaining_count > 0, "active_connections": remaining_count}


# ---------------------------------------------------------------------------
# Global session manager
# ---------------------------------------------------------------------------

_agent_session_manager: Optional[AgentSessionManager] = None


def get_agent_session_manager() -> Optional[AgentSessionManager]:
    return _agent_session_manager


def initialize_agent_session_manager(websocket_manager: Any) -> AgentSessionManager:
    global _agent_session_manager
    _agent_session_manager = AgentSessionManager(websocket_manager)
    logger.info("Global AgentSessionManager initialised")
    return _agent_session_manager


def set_agent_session_manager(manager: AgentSessionManager) -> None:
    global _agent_session_manager
    _agent_session_manager = manager
