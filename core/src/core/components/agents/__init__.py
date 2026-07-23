"""core executor agents.

Only the base agent and TerminalExecutor are vendored into ``core``; the other
executor agents (browser, desktop, web search, image, audio, documentation,
code) stay in the backend engine.
"""

import logging as _logging

_agent_init_logger = _logging.getLogger("core.agents.init")

from .base_agent import BaseSwarmAgent

# TerminalExecutor is optional (requires pexpect)
try:
    from .terminal_executor import TerminalExecutorAgent
    _TERMINAL_EXECUTOR_AVAILABLE = True
except ImportError as e:
    _agent_init_logger.warning(f"TerminalExecutorAgent import failed: {e}")
    TerminalExecutorAgent = None
    _TERMINAL_EXECUTOR_AVAILABLE = False

__all__ = ["BaseSwarmAgent"]

if _TERMINAL_EXECUTOR_AVAILABLE:
    __all__.append("TerminalExecutorAgent")
