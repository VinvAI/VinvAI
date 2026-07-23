"""handbook — standalone discovery-handbook prompt renderer.

Renders the exploration prompt whose execution (by the caller's coding-agent
harness) writes a single onboarding handbook to ``<repo>/.vinv/vinv.md``.
Harness-only: no LLM calls are made in-process.
"""

from handbook.generator import (
    HANDBOOK_REL,
    handbook_already_present,
    render_documentation_prompt,
)

__all__ = [
    "HANDBOOK_REL",
    "handbook_already_present",
    "render_documentation_prompt",
]
