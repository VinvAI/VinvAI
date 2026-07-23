"""
Signature implementation for TerminalExecutor Agent.

TerminalExecutor: Terminal automation and command execution specialist.
"""

try:
    import dspy
except ImportError:
    dspy = None

from core.components.agents import prompts


if dspy is not None:
    class TerminalExecutorSignature(dspy.Signature):
        """TerminalExecutor: terminal automation and command execution specialist."""

        instruction: str = dspy.InputField(
            desc="The terminal automation task to complete"
        )

        terminal_state: str = dspy.InputField(
            desc="Current terminal output and state"
        )

        conversation_history: str = dspy.InputField(
            desc="Previous conversation context",
            default=""
        )

        available_actors: str = dspy.InputField(
            desc='JSON list of available actors with capabilities for collaboration. '
            'Use these names in collaboration_actions target_agent. '
            'Format: [{"name": "...", "capabilities": [...], "description": "..."}]',
            default="[]"
        )

        analysis: str = dspy.OutputField(
            desc="Analysis of the terminal task and requirements"
        )

        plan: str = dspy.OutputField(
            desc="Step-by-step plan for command execution sequence"
        )

        commands: str = dspy.OutputField(
            desc="JSON array of terminal commands to execute. Format: [{\"action\": \"send_terminal_command\", \"args\": {\"keystrokes\": \"...\", \"duration\": ...}}, ...]"
        )

        task_complete: bool = dspy.OutputField(
            desc="True when terminal automation task is fully completed"
        )

        reasoning: str = dspy.OutputField(
            desc="Technical reasoning for the command execution approach"
        )

        trajectory_summary: str = dspy.OutputField(
            desc="Compact self-summary of what you did: commands executed, key outputs, errors hit, and final outcome. 3-5 sentences max."
        )

        collaboration_actions: str = dspy.OutputField(
            desc="""JSON array of collaboration actions. MANDATORY when you cannot complete a task alone.
            If real data cannot be obtained via terminal/API, you MUST request help:
            [{"action": "request_help", "target_agent": "<actor_with_required_capability>", "type": "data_fetch", "data": {"problem": "...", "context": {...}}}]
            Other actions: "share_knowledge", "broadcast".
            Format: [{"action": "...", "target_agent": "...", "type": "...", "data": {...}}]
            Default: []""",
            default="[]"
        )

    prompts.apply(TerminalExecutorSignature, "terminal_executor")

else:
    class TerminalExecutorSignature:
        """Placeholder when dspy is not available."""
        pass
