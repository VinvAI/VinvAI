"""Operator start-hint plumbing — how the human says they start a service.

The hint answers the hardest half of bring-up (WHICH command starts this
service) without touching the other half: the deliverable is still the traced
command, and `verified: true` still means the tracelens-wrapped form served.
These tests pin both halves — that the hint reaches the agent's instruction and
survives the feedback rounds, and that it never reads as permission to record an
untraced command.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core" / "src"))

from bringup.runner import (  # noqa: E402
    _read_start_hint,
    _replay_feedback_instruction,
    _start_hints_path,
    _user_hint_instruction,
)


def _write_hint(root: Path, service: str, payload: object) -> None:
    path = _start_hints_path(root, service)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_reads_recorded_hint(tmp_path: Path) -> None:
    _write_hint(tmp_path, "api", {"service": "api", "command": "make run-api"})
    assert _read_start_hint(tmp_path, "api") == "make run-api"


def test_missing_hint_is_none_not_error(tmp_path: Path) -> None:
    """No hint must be a quiet 'no hint' — an unhinted bring-up still has to run."""
    assert _read_start_hint(tmp_path, "api") is None


def test_malformed_and_blank_hints_are_none(tmp_path: Path) -> None:
    """Hint files are hand-editable, so every unusable shape degrades to no-hint."""
    (tmp_path / ".vinv" / "start_hints").mkdir(parents=True)
    _start_hints_path(tmp_path, "broken").write_text("{not json", encoding="utf-8")
    assert _read_start_hint(tmp_path, "broken") is None

    _write_hint(tmp_path, "blank", {"command": "   "})
    assert _read_start_hint(tmp_path, "blank") is None

    _write_hint(tmp_path, "wrongtype", {"command": ["make", "run"]})
    assert _read_start_hint(tmp_path, "wrongtype") is None

    _write_hint(tmp_path, "notdict", ["make run"])
    assert _read_start_hint(tmp_path, "notdict") is None


def test_hint_is_stripped(tmp_path: Path) -> None:
    _write_hint(tmp_path, "api", {"command": "  make run-api\n"})
    assert _read_start_hint(tmp_path, "api") == "make run-api"


def test_hint_path_cannot_escape_the_hints_dir(tmp_path: Path) -> None:
    """A service name is not a path segment — mirrors _start_commands_path."""
    path = _start_hints_path(tmp_path, "api/../../etc/passwd")
    assert path.parent == (tmp_path / ".vinv" / "start_hints").resolve()
    assert path.name == "api_.._.._etc_passwd.json"


def test_hint_slug_matches_extension_writer(tmp_path: Path) -> None:
    """The extension writes this file and Python reads it; the slugs must agree.

    vinv-vs/src/bringup/startHint.ts writes via serviceSlug(), which mirrors
    this regex. A divergence would silently drop the operator's answer.
    """
    assert _start_hints_path(tmp_path, "api/v2").name == "api_v2.json"
    assert _start_hints_path(tmp_path, "web-ui.dev").name == "web-ui.dev.json"
    assert _start_hints_path(tmp_path, "").name == "service.json"


def test_instruction_carries_the_operators_command() -> None:
    out = _user_hint_instruction("BASE", "api", "make run-api", "/repo/.vinv/sc/api.json")
    assert "BASE" in out
    assert "make run-api" in out


def test_instruction_does_not_license_an_untraced_command() -> None:
    """The decisive property: no trace, no verify — the hint must not read as a
    shortcut to recording the operator's plain command."""
    out = _user_hint_instruction("BASE", "api", "make run-api", "/repo/.vinv/sc/api.json")
    assert "does NOT relax" in out
    assert "verified:false" in out
    # It must still route the operator's command through the tracelens wrap.
    assert "tracelens" in out
    assert "--target-package" in out


def test_hint_survives_a_replay_feedback_round() -> None:
    """start_service folds the hint into base_instruction precisely so later
    rounds keep it; if feedback replaced rather than extended the base, the
    agent would lose the operator's answer exactly when it needs it most."""
    base = _user_hint_instruction("BASE", "api", "make run-api", "/repo/sc.json")
    out = _replay_feedback_instruction(
        base, "api", {"reason": "exited", "exit_code": 1}, "/repo/sc.json"
    )
    assert "make run-api" in out
    assert "REPLAY VERIFICATION FAILED" in out
