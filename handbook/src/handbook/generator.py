"""Discovery handbook prompt rendering.

Renders the Stage 1 discovery task prompt that instructs a coding agent to
explore a repository and write a single onboarding handbook to
``<repo>/.vinv/vinv.md``.

Harness-only: this module makes ZERO LLM calls. The CLI prints the rendered
prompt and the user's coding-agent harness executes it.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Discovery task templates ship as plaintext package data (``handbook/prompts/``)
# and are injected via str.format() at prompt-render time.
_PROMPTS_DIR = Path(__file__).with_name("prompts")

HANDBOOK_REL = Path(".vinv") / "vinv.md"


def _prompt(name: str) -> str:
    return (_PROMPTS_DIR / f"{name}.txt").read_text(encoding="utf-8")


def handbook_already_present(project_root: Path) -> bool:
    """True when ``.vinv/vinv.md`` exists and is non-empty (whitespace is ignored)."""
    path = project_root.resolve() / HANDBOOK_REL
    if not path.is_file():
        return False
    body = path.read_text(encoding="utf-8", errors="replace").strip()
    return bool(body)


def documentation_instruction(project_root: Path, *, portable: bool = False) -> str:
    """Render the Stage 1 discovery task prompt.

    ``portable=True`` selects the tool-agnostic variant (``*_portable`` prompt
    file) — the same task with the Vinv-specific terminal/file tool mechanics
    stripped — for printing into a foreign coding agent. The default keeps the
    native wording the Vinv terminal-tool vocabulary expects.
    """
    root = str(project_root.resolve())
    vinv_md = str((project_root / HANDBOOK_REL).resolve())
    key = "documentation_instruction_portable" if portable else "documentation_instruction"
    return _prompt(key).format(root=root, vinv_md=vinv_md).strip()


def render_documentation_prompt(project_root: Path, *, portable: bool = False) -> str:
    """Render the discovery task prompt for printing (makes no LLM call).

    Unlike bring-up, discovery *produces* the handbook rather than consuming one,
    so there is nothing to inline — this is a thin wrapper over
    :func:`documentation_instruction` kept for symmetry with the bringup CLI.
    """
    return documentation_instruction(project_root.resolve(), portable=portable)
