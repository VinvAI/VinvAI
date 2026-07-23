"""Signature exports for executor agents.

The TerminalExecutor and CodeExecutor signatures are vendored into core; the
other executor signatures (browser, desktop, image, audio, web search,
presentation) stay in the backend engine.
"""

from .code_executor_signature import CodeExecutorSignature
from .terminal_executor_signature import TerminalExecutorSignature

__all__ = ["TerminalExecutorSignature", "CodeExecutorSignature"]
