"""Regression tests for the plaintext discovery prompt templates and the portable variant.

Reads the shipped ``src/handbook/prompts/*.txt`` templates directly. The risk
guarded is entirely in the templates: each template ``.format()``ing cleanly
with the kwargs ``generator`` passes, and the ``*_portable`` variant naming
none of the Vinv-specific agent tools.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_PROMPTS_DIR = Path(__file__).resolve().parents[1] / "src" / "handbook" / "prompts"

_TOOL_TOKENS = (
    "send_terminal_command",
    "initialize_terminal",
    "get_incremental_output",
    "get_terminal_state",
    "close_terminal",
    "save_file(",
    "block:",
    "block=",
    "session_name=",
)

_DOC_KW = {"root": "/r", "vinv_md": "/r/.vinv/vinv.md"}


def _template(key: str) -> str:
    return (_PROMPTS_DIR / f"{key}.txt").read_text(encoding="utf-8")


def test_template_files_present() -> None:
    for key in ("documentation_instruction", "documentation_instruction_portable"):
        assert (_PROMPTS_DIR / f"{key}.txt").is_file(), f"{key}.txt missing from prompts dir"


@pytest.mark.parametrize("key", ["documentation_instruction", "documentation_instruction_portable"])
def test_template_formats_cleanly(key: str) -> None:
    assert _template(key).format(**_DOC_KW).strip()


def test_portable_has_no_harness_tool_tokens() -> None:
    out = _template("documentation_instruction_portable").format(**_DOC_KW)
    leaked = [tok for tok in _TOOL_TOKENS if tok in out]
    assert not leaked, f"portable discovery prompt leaks Vinv-harness tool tokens: {leaked}"


def test_portable_keeps_required_bringup_recipe_section() -> None:
    # The downstream bring-up stage greps for this exact heading; the portable
    # variant must still mandate it.
    out = _template("documentation_instruction_portable").format(**_DOC_KW)
    assert "## Bring-up recipe (host vs container)" in out
    assert "### Run on host (instrumented by tracelens)" in out
    assert _DOC_KW["vinv_md"] in out
