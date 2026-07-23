"""
Signature implementation for CodeExecutor Agent.

CodeExecutor: Code understanding, editing, and validation specialist.
"""

try:
    import dspy
except ImportError:
    dspy = None

from core.components.agents import prompts


if dspy is not None:

    class CodeExecutorSignature(dspy.Signature):
        """CodeExecutor: code understanding, editing, and validation specialist."""

        instruction: str = dspy.InputField(
            desc="The code task to complete (understand, modify, or fix code)"
        )

        terminal_state: str = dspy.InputField(
            desc="Current terminal output and state"
        )

        conversation_history: str = dspy.InputField(
            desc="Previous conversation context", default=""
        )

        analysis: str = dspy.OutputField(
            desc="Analysis of what code needs to be understood or changed and why"
        )

        plan: str = dspy.OutputField(
            desc="Step-by-step plan: which files to read, what to edit, how to validate"
        )

        commands: str = dspy.OutputField(
            desc='JSON array of tool calls. Format: [{"action": "read_code", "args": {"file_path": "...", "start_line": 1, "end_line": 50}}, ...]'
        )

        task_complete: bool = dspy.OutputField(
            desc="True when the code task is fully completed and validated"
        )

        reasoning: str = dspy.OutputField(
            desc="Technical reasoning for the approach: why these files, why this edit strategy"
        )

        trajectory_summary: str = dspy.OutputField(
            desc="Compact self-summary: files read, edits made, tests run, final outcome. 3-5 sentences max."
        )

        collaboration_actions: str = dspy.OutputField(
            desc="""JSON array of collaboration actions. Use when you need help from other agents.
            Example: [{"action": "request_help", "target_agent": "TerminalExecutor", "type": "run_tests", "data": {"problem": "...", "context": {...}}}]
            Other actions: "share_knowledge", "broadcast".
            Default: []""",
            default="[]",
        )

    prompts.apply(CodeExecutorSignature, "code_executor")

else:

    class CodeExecutorSignature:
        """Placeholder when dspy is not available."""

        pass
