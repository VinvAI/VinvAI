"""Goal-creation prompt rendering.

Takes an arbitrary working context — task notes, a session summary, an issue
description, trace evidence — and renders the prompt that distills it into ONE
crisp, actionable goal string.

Harness-only: this module makes ZERO LLM calls. The CLI prints the rendered
prompt and the user's coding-agent harness executes it, replying with the JSON
object the prompt specifies.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Cap what we feed the LM: a goal is a distillation, and beyond this much
# context the marginal signal is gone while the token cost (and the chance of
# blowing the model's context window) keeps growing. The head of the context
# is kept — callers put the important framing first.
MAX_CONTEXT_CHARS = 80_000

_INSTRUCTION = """\
Distill the working context below into one crisp, actionable goal.

The goal must be a single imperative statement of the outcome to achieve —
specific enough that an engineer (or agent) reading only the goal knows what
"done" means, and short enough to serve as a standing objective. State the
outcome, not the steps; never restate or summarize the whole context.

Respond with ONLY a JSON object (no fences, no prose around it) of the form:

{
  "goal": "<ONE imperative, outcome-oriented goal statement (1-2 sentences, no preamble, no numbering, no markdown)>",
  "reasoning": "<2-3 sentences on why this is the goal the context implies>"
}
"""


def prepare_context(context: str) -> tuple[str, bool]:
    """Validate and truncate ``context``; returns ``(text, truncated)``.

    Raises ``ValueError`` on empty context — the CLI surfaces it as an error.
    """
    ctx = (context or "").strip()
    if not ctx:
        raise ValueError(
            "context is empty — pass the context text as an argument, via "
            "--context-file, or on stdin"
        )
    truncated = False
    if len(ctx) > MAX_CONTEXT_CHARS:
        logger.info(
            "goal_context_truncated chars=%s cap=%s", len(ctx), MAX_CONTEXT_CHARS
        )
        ctx = ctx[:MAX_CONTEXT_CHARS]
        truncated = True
    return ctx, truncated


def render_goal_prompt(context: str) -> str:
    """Render the goal-creation prompt over ``context`` (makes no LLM call)."""
    ctx, _ = prepare_context(context)
    return (
        _INSTRUCTION
        + "\n### Working context\n\n"
        + ctx
        + "\n"
    )
