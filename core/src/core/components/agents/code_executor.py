"""
CodeExecutor Agent — Code understanding, editing, and validation specialist.

Handles: Semantic code search, surgical file editing, bulk refactoring,
         and terminal-based validation (tests, linters, type checkers).

Tools: retrieve_code, grep_code, read_code, edit_code, bulk_edit_code,
       index_codebase, sync_index, send_terminal_command, get_terminal_state,
       get_incremental_output.
"""

try:
    import dspy
except ImportError:
    dspy = None

import sys

from .base_agent import BaseSwarmAgent
from core.components.agents import prompts
from core.components.agents.signatures import CodeExecutorSignature
from core.components.tools.terminal.terminal_tools import (
    initialize_terminal,
    close_terminal,
    send_terminal_command,
    get_terminal_state,
    get_incremental_output,
)
from core.components.tools.code.editor import (
    grep_code,
    read_code,
    edit_code,
    bulk_edit_code,
)
# Thin compatibility tools backed by the standalone Rust index binary.  Keeping
# subprocess invocation in ``core.index`` avoids importing a legacy indexer
# Python stack (FAISS/tree-sitter) into production agents.
from core.index import index_codebase, retrieve_code, sync_index


if dspy is not None:

    class CodeExecutorAgent(BaseSwarmAgent):
        """CodeExecutor: Code understanding, editing, and validation specialist.

        Skills: Semantic code search, regex pattern search, windowed file
        reading, surgical line-range editing, atomic bulk edits, codebase indexing,
        incremental sync, terminal-based test/lint/typecheck execution.

        Code Tools: retrieve_code, grep_code, read_code, edit_code, bulk_edit_code,
        index_codebase, sync_index.
        Terminal Tools: send_terminal_command, get_terminal_state, get_incremental_output,
        initialize_terminal, close_terminal.
        """

        AGENT_NAME = "CodeExecutor"
        SIGNATURE_CLASS = CodeExecutorSignature

        DEFAULT_SESSION = "vinv_engine_code_terminal"

        _CODE_TOOLS = [
            retrieve_code,
            grep_code,
            read_code,
            edit_code,
            bulk_edit_code,
            index_codebase,
            sync_index,
        ]

        _TERMINAL_TOOLS = [
            initialize_terminal,
            close_terminal,
            send_terminal_command,
            get_terminal_state,
            get_incremental_output,
        ]

        def __init__(self, max_iters: int = 50):
            """Initialize CodeExecutor; terminal shares the global session with TerminalExecutor.

            Defer bootstrap ``initialize_terminal`` when stdout is piped (typical Electron child)
            so the runtime stdin reader is active before primary IPC create.
            """
            self._terminal_session_id = self.DEFAULT_SESSION
            _defer_terminal_bootstrap = not sys.stdout.isatty()
            if not _defer_terminal_bootstrap:
                result = initialize_terminal(session_name=self._terminal_session_id)
                if result.get("status") != "success":
                    raise RuntimeError(
                        f"Failed to initialize terminal session: {result.get('error', 'Unknown error')}"
                    )

            all_tools = self._CODE_TOOLS + self._TERMINAL_TOOLS
            super().__init__(max_iters=max_iters, tools=all_tools)

        def _prepare_for_execution(self, **kwargs):
            """Prepare terminal state for execution context."""
            from core.components.tools.terminal.terminal_tools import (
                notify_terminal_instance_ready,
                set_current_terminal_instance_id,
            )

            tid = kwargs.get("_parallel_task_id") or "default"
            instance_id = "default" if tid == "default" else f"code_{tid}"
            set_current_terminal_instance_id(instance_id)
            notify_terminal_instance_ready(instance_id, "CodeExecutor")

            terminal_state_result = get_terminal_state()
            terminal_state = (
                terminal_state_result.get("output", "")
                if terminal_state_result.get("status") == "success"
                else ""
            )
            return {"terminal_state": terminal_state}

        TOOLS = []

        SYSTEM_PROMPT = prompts.get("code_executor_system")

else:

    class CodeExecutorAgent:
        """Placeholder when dspy is not available."""

        pass
