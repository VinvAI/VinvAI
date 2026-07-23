"""
TerminalExecutor Agent - Terminal automation and command execution specialist.

Handles: Command execution, shell scripting, system operations, log analysis.
Tools: Shared PTY (via Electron IPC) or pexpect fallback for terminal session management.
"""

try:
    import dspy
except ImportError:
    dspy = None

from .base_agent import BaseSwarmAgent
from core.components.agents import prompts
from core.components.agents.signatures import TerminalExecutorSignature
import os
import sys

from core.components.tools.terminal.terminal_tools import (
    initialize_terminal,
    close_terminal,
    send_terminal_command,
    get_terminal_state,
    get_incremental_output
)


if dspy is not None:
    class TerminalExecutorAgent(BaseSwarmAgent):
        """TerminalExecutor: Terminal automation, command execution, file inspection, and code editing specialist.
        
        Skills: Shell command execution, file operations (read/write/search/edit),
        system administration, process management, log analysis, script execution,
        code inspection (indentation/syntax checking), chunk-based file editing,
        front-end rendering verification, visual file inspection via VLM,
        and multi-step command workflows.
        Tools: send_terminal_command, get_terminal_state, get_incremental_output,
        initialize_terminal, close_terminal.
        VLM Tools: inspect_file_visually (open+analyze any file), inspect_code_for_errors
        (indentation/syntax check), inspect_browser_state (screenshot front-end),
        visual_inspect (analyze any image).
        """

        AGENT_NAME = "TerminalExecutor"
        SIGNATURE_CLASS = TerminalExecutorSignature
        
        # Default session for persistent terminal
        DEFAULT_SESSION = "vinv_engine_default_terminal"
        
        # Original terminal tools (will be wrapped in __init__)
        _TERMINAL_TOOLS = [
            initialize_terminal,
            close_terminal,
            send_terminal_command,
            get_terminal_state,
            get_incremental_output
        ]
        
        _TERMINAL_MAX_ITERS = 30

        def __init__(self, max_iters: int = _TERMINAL_MAX_ITERS):
            """Initialize TerminalExecutor with terminal session and wrapped tools."""
            self._terminal_session_id = self.DEFAULT_SESSION
            # Defer bootstrap init when stdout is piped (typical Electron-spawned child): runtime
            # stdin reader must be running before primary IPC create.
            _defer_terminal_bootstrap = not sys.stdout.isatty()
            if not _defer_terminal_bootstrap:
                result = initialize_terminal(session_name=self._terminal_session_id)
                if result.get("status") != "success":
                    raise RuntimeError(f"Failed to initialize terminal session: {result.get('error', 'Unknown error')}")
            # Tools auto-call initialize_terminal() on first use when session is None.

            wrapped_tools = self._create_wrapped_terminal_tools()
            super().__init__(max_iters=max_iters, tools=wrapped_tools)
        
        def _create_wrapped_terminal_tools(self):
            """Create wrapper tools that automatically use the initialized terminal session."""
            import functools
            
            wrapped = []
            for tool in self._TERMINAL_TOOLS:
                # Tools already use the session set by set_terminal_session()
                # So we can just pass them through
                wrapped.append(tool)
            
            return wrapped
        
        def _prepare_for_execution(self, **kwargs):
            """Prepare terminal state for execution."""
            from core.components.tools.terminal.terminal_tools import (
                notify_terminal_instance_ready,
                set_current_terminal_instance_id,
            )

            tid = kwargs.get("_parallel_task_id") or "default"
            instance_id = "default" if tid == "default" else f"term_{tid}"
            set_current_terminal_instance_id(instance_id)
            notify_terminal_instance_ready(instance_id, "TerminalExecutor")

            # Get current terminal state
            terminal_state_result = get_terminal_state()
            terminal_state = terminal_state_result.get("output", "") if terminal_state_result.get("status") == "success" else ""
            
            return {"terminal_state": terminal_state}
        
        # Remove TOOLS class variable since we're setting it dynamically
        TOOLS = []
        
        SYSTEM_PROMPT = prompts.get("terminal_executor_system")

else:
    class TerminalExecutorAgent:
        """Placeholder when dspy is not available."""
        pass
