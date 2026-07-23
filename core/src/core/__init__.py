"""core — shared Vinv Engine components for standalone CLIs.

A lean, self-contained extraction of the reusable agent runtime (BaseSwarmAgent,
TerminalExecutorAgent, terminal/file tools, the DSPy ReAct wrapper) from
``vinv_engine``, with no dependency on the backend. Standalone tools such as
``handbook`` import from here instead of vendoring the agent logic themselves.

The open-source build is harness-only: no cloud LM is ever configured here.
See :mod:`core.llm` — embedders must configure ``dspy.settings.lm`` themselves
before driving any agent; the CLIs built on top of core only render prompts.
"""

from core.components.agents.base_agent import BaseSwarmAgent
from core.components.agents.terminal_executor import TerminalExecutorAgent
from core.llm import ensure_dspy_lm_configured

__all__ = [
    "BaseSwarmAgent",
    "TerminalExecutorAgent",
    "ensure_dspy_lm_configured",
]
