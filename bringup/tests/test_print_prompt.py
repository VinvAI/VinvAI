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

import json
import re
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
    "_tracelens_cmd": "<venv-bin>/tracelens",
    "_venv_bin": "<venv-bin>",
    "_venv_python": "<venv-bin>/python",
    "_target_pkg_note": "NOTE",
    "_target_pkg_flags": "  --target-package svc \\\n",
    "tracelens_subdir": "sess/",
    "_tracelens_path_note": "PATHNOTE",
    "_g0": "sess/",
    "root": "/r",
    "_root_json": "/r",
    "start_commands_json": "/r/.vinv/start_commands/svc.json",
}


def _template(key: str) -> str:
    return (_PROMPTS_DIR / f"{key}.txt").read_text(encoding="utf-8")


def test_all_template_files_present() -> None:
    for key in (
        "list_instruction",
        "list_instruction_portable",
        "start_instruction",
        "start_instruction_portable",
        "otel_pin_block",
        "tracelens_install_editable",
        "tracelens_install_missing",
    ):
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
    assert "--target-package svc" in out  # instrumentation targets
    assert "trace.jsonl" in out  # tracelens output path
    assert _START_KW["start_commands_json"] in out  # where to write the deliverable
    assert '"verified"' in out  # the verified-command JSON schema


@pytest.mark.parametrize("key", ["start_instruction", "start_instruction_portable"])
def test_recorded_command_template_is_venv_qualified(key: str) -> None:
    """The JSON the agent copies must never show a bare `tracelens` / `python`.

    Agents fill the ``<pkg>``/``<module>``/``<args>`` slots of the deliverable
    template and leave the rest verbatim, so whatever shape that template has is
    the shape that lands in ``.vinv/start_commands/<svc>.json``. A bare
    ``tracelens run … -- python -m …`` resolves in the agent's own shell but
    fails ``exit 127`` when the extension replays it through ``bash -lc``.
    """
    out = _template(key).format(**_START_KW)
    recorded = [ln for ln in out.splitlines() if '"command":' in ln]
    assert recorded, f"{key} has no deliverable command template"
    for line in recorded:
        if "docker compose" in line:
            continue  # a detached dependency entry, not the tracelens start
        assert '"PATH=' in line, f"{key}: recorded command lacks an inline PATH: {line}"
        assert _START_KW["_tracelens_cmd"] in line, f"{key}: bare tracelens in {line}"
        assert " -- python " not in line, f"{key}: bare interpreter in {line}"
        assert _START_KW["_venv_python"] in line, f"{key}: no venv interpreter in {line}"


@pytest.mark.parametrize("key", ["start_instruction", "start_instruction_portable"])
def test_deliverable_json_example_actually_parses(key: str) -> None:
    """The JSON block the agent copies must BE valid JSON once rendered.

    It previously wasn't on Windows: ``root``/``_caps_base`` were interpolated as
    native paths, so the example read ``"working_directory": "C:\\work\\proj"``
    with single backslashes — ``\\w`` is not a valid JSON escape, in a section that
    simultaneously demands "valid JSON only". The same backslashes inside the
    ``command`` string are eaten by ``bash -lc`` (``C:\\Users\\y`` →
    ``C:Usersy``), pointing ``--output`` at a relative path so the baseline reads
    empty. Renders with Windows-shaped paths and parses the result.
    """
    kw = {
        **_START_KW,
        "root": "C:\\work\\project\\demo",
        "_root_json": "C:/work/project/demo",
        "_caps_base": "C:/Users/you/.tracelens/baselines",
        "start_commands_json": "C:\\work\\project\\demo\\.vinv\\start_commands\\svc.json",
    }
    out = _template(key).format(**kw)
    blocks = re.findall(r"```json\n(.*?)```", out, re.DOTALL)
    assert blocks, f"{key} has no ```json deliverable example"
    for block in blocks:
        # Strip the intentional <port-or-null> / <int-or-null> slots the agent fills.
        concrete = re.sub(r"<[^\"\n>]*>", "0", block)
        parsed = json.loads(concrete)  # the real assertion: it must parse
        for entry in parsed.get("commands", []):
            cmd = entry.get("command", "")
            assert "\\U" not in cmd and "\\A" not in cmd, f"{key}: bash-eaten backslash in {cmd}"
            wd = entry.get("working_directory", "")
            assert "\\" not in wd, f"{key}: single backslash survives in working_directory {wd!r}"


@pytest.mark.parametrize("key", ["start_instruction", "start_instruction_portable"])
def test_start_templates_carry_replay_contracts(key: str) -> None:
    """Both variants must state that the recorded string outlives the agent's shell.

    The portable variant is the ONLY one the VS Code extension renders
    (``--print-prompt --portable``), so a contract present in the full runbook
    alone protects nobody in practice.
    """
    out = _template(key).format(**_START_KW)
    assert "SELF-CONTAINED" in out  # recorded ≠ what your shell can resolve
    assert "exit 127" in out  # the concrete failure it prevents
    assert "REPLAY CONTRACT" in out  # foreground-only, no `&` / nohup / redirect
    assert "bash -lc" in out  # how the replayer actually runs it
