"""LLM configuration boundary — harness-only in the open-source build.

The open-source Vinv engines never call a cloud LLM themselves. The supported
path for LLM work is prompt rendering: each CLI renders its full task prompt
with ``--print-prompt [--portable]`` (zero LLM calls) and the user's
coding-agent harness (Claude Code, Cursor, Windsurf, ...) executes it.

:func:`ensure_dspy_lm_configured` remains as the single choke point every
in-process agent execution path funnels through; it now refuses to configure a
cloud LM so no code path can silently reintroduce network LLM calls. Library
users who embed ``core``'s agent runtime in their own product must configure
``dspy.settings.lm`` themselves before invoking any agent.
"""

from __future__ import annotations


class HarnessOnlyLLMError(RuntimeError):
    """Raised when a code path asks for in-process cloud LLM execution."""


def ensure_dspy_lm_configured() -> None:
    """Refuse to configure a cloud LM — direct LLM execution is removed.

    The open-source engines are harness-only: render the task prompt with
    ``--print-prompt [--portable]`` and execute it with your own coding-agent
    harness. Embedders that want to drive ``core``'s DSPy agents directly must
    call ``dspy.configure(lm=...)`` with their own model before agent use.
    """
    try:
        import dspy

        if getattr(dspy.settings, "lm", None) is not None:
            return  # an embedder already configured a model explicitly
    except ImportError:
        pass

    raise HarnessOnlyLLMError(
        "Direct cloud-LLM execution has been removed from the open-source Vinv "
        "engines. Render the task prompt with `--print-prompt [--portable]` and "
        "run it with your coding-agent harness instead. (Embedders may configure "
        "dspy.settings.lm themselves before invoking core's agents.)"
    )
