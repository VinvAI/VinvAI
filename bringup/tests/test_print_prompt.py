"""Regression tests for the plaintext bring-up prompt templates and their portable variants.

These read the shipped ``src/bringup/prompts/*.txt`` templates directly, so the
risk they guard is entirely in the templates themselves:

  * every template ``.format()``s cleanly with the kwargs ``runner`` passes
    (no stray single brace, no missing/extra placeholder);
  * the ``*_portable`` variants name none of the Vinv-specific agent tools, so a
    foreign coding agent isn't handed instructions for tools it doesn't have;
  * the portable start variant still carries the real deliverable contract
    (target-package flags, tracelens output path, the ``verified`` JSON).
"""

from __future__ import annotations

from pathlib import Path

import pytest

_PROMPTS_DIR = Path(__file__).resolve().parents[1] / "src" / "bringup" / "prompts"

# The Vinv-harness tool vocabulary that must NOT leak into a portable prompt.
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

# Representative kwargs mirroring what runner.py passes at render time.
_LIST_KW = {
    "_pkgs_note": "PKGS",
    "vinv_md": "/r/.vinv/vinv.md",
    "root": "/r",
    "services_json": "/r/.vinv/services.json",
}
_START_KW = {
    "service": "svc",
    "vinv_md": "/r/.vinv/vinv.md",
    "tracelens_install_block": "INSTALL",
    "_caps_base": "/caps",
    "_tracelens_cmd": "tracelens",
    "_target_pkg_note": "NOTE",
    "_target_pkg_flags": "  --target-package svc \\\n",
    "tracelens_subdir": "sess/",
    "_tracelens_path_note": "PATHNOTE",
    "_g0": "sess/",
    "root": "/r",
    "start_commands_json": "/r/.vinv/start_commands/svc.json",
}


def _template(key: str) -> str:
    return (_PROMPTS_DIR / f"{key}.txt").read_text(encoding="utf-8")


def test_all_template_files_present() -> None:
    for key in ("list_instruction", "list_instruction_portable",
                "start_instruction", "start_instruction_portable",
                "otel_pin_block", "tracelens_install_editable",
                "tracelens_install_missing"):
        assert (_PROMPTS_DIR / f"{key}.txt").is_file(), f"{key}.txt missing from prompts dir"


@pytest.mark.parametrize(
    ("key", "kw"),
    [
        ("list_instruction", _LIST_KW),
        ("list_instruction_portable", _LIST_KW),
        ("start_instruction", _START_KW),
        ("start_instruction_portable", _START_KW),
    ],
)
def test_template_formats_cleanly(key: str, kw: dict[str, str]) -> None:
    # Raises KeyError (missing placeholder) / ValueError (stray single brace) if broken.
    out = _template(key).format(**kw)
    assert out.strip()


@pytest.mark.parametrize("key", ["list_instruction_portable", "start_instruction_portable"])
def test_portable_has_no_harness_tool_tokens(key: str) -> None:
    kw = _LIST_KW if key.startswith("list") else _START_KW
    out = _template(key).format(**kw)
    leaked = [tok for tok in _TOOL_TOKENS if tok in out]
    assert not leaked, f"{key} leaks Vinv-harness tool tokens: {leaked}"


def test_portable_start_keeps_deliverable_contract() -> None:
    out = _template("start_instruction_portable").format(**_START_KW)
    assert "--target-package svc" in out            # instrumentation targets
    assert "trace.jsonl" in out                      # tracelens output path
    assert _START_KW["start_commands_json"] in out   # where to write the deliverable
    assert '"verified"' in out                       # the verified-command JSON schema
