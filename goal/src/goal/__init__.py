"""goal — standalone goal-authoring prompt renderer.

Renders the prompt that distills an arbitrary working context (task notes, a
session summary, an issue description, trace evidence, …) into ONE crisp,
actionable goal string:

* ``render_goal_prompt`` — take the context text, return the rendered prompt
  for the caller's coding-agent harness to execute.

Harness-only: no LLM calls are made in-process.
"""

from goal.runner import render_goal_prompt

__all__ = [
    "render_goal_prompt",
]
