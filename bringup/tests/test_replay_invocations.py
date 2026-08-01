"""The replay gate over a MULTI-INVOCATION unit.

A server has one way to start; a CLI has one per subcommand and a library one
per entry point. Recording five ways to drive a unit and proving one is not a
verification of the file — it is a verification of whichever entry happened to
be first, while the other four ship as `verified: true` having never run.

These run real processes through the real gate; nothing is mocked.
"""

from __future__ import annotations

import sys
from pathlib import Path

# The replay runs through bash; a Windows interpreter path like C:\\Users\\… loses
# its backslashes unless quoted inside the bash command string.
_PY = f'"{sys.executable}"'

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bringup.runner import verify_replay  # noqa: E402


def _record(invocations: list[dict], *, dependency: str | None = None) -> dict:
    commands = [{"purpose": "start", "command": invocations[0]["command"]}]
    if dependency:
        commands.insert(0, {"purpose": "dependency", "command": dependency})
    return {
        "service": "acme-tool",
        "verified": True,
        "verification": {"port": None},
        "commands": commands,
        "invocations": invocations,
    }


def test_every_recorded_invocation_is_replayed(tmp_path: Path) -> None:
    data = _record([
        {"id": "report", "command": f"{_PY} -c \"print('report')\"", "default": True},
        {"id": "check", "command": f"{_PY} -c \"print('check')\""},
    ])

    result = verify_replay(tmp_path, "acme-tool", data)

    assert result["ok"] is True
    assert result["verified_invocations"] == ["report", "check"]


def test_one_failing_invocation_fails_the_whole_file(tmp_path: Path) -> None:
    # The second entry exits 2 where 0 was expected. Passing the file because
    # the FIRST entry worked is exactly the hole this closes.
    data = _record([
        {"id": "report", "command": f"{_PY} -c \"print('report')\""},
        {"id": "broken", "command": f"{_PY} -c \"raise SystemExit(2)\""},
    ])

    result = verify_replay(tmp_path, "acme-tool", data)

    assert result["ok"] is False
    assert result["invocation"] == "broken"
    assert "broken" in result["reason"]
    # And it says which ones DID pass, so the agent re-runs only what is broken.
    assert result["verified_invocations"] == ["report"]


def test_each_invocation_is_judged_by_its_own_expected_exit(tmp_path: Path) -> None:
    """A `check` that exits 1 on findings is working.

    There is no single file-level exit code that can describe both it and a
    `report` that exits 0 — reading one for both would dispatch a fix episode
    against a linter doing exactly what it documents.
    """
    data = _record([
        {"id": "report", "command": f"{_PY} -c \"print('ok')\"", "expect_exit": 0},
        {"id": "check", "command": f"{_PY} -c \"raise SystemExit(1)\"", "expect_exit": 1},
    ])

    result = verify_replay(tmp_path, "acme-tool", data)

    assert result["ok"] is True, result.get("reason")
    assert result["verified_invocations"] == ["report", "check"]


def test_parameters_are_filled_from_their_defaults(tmp_path: Path) -> None:
    # Headless replay uses the declared defaults — the same argv the Run
    # button's one-click path uses, which is what makes this gate mean anything.
    data = _record([
        {
            "id": "report",
            "command": f"{_PY} -c \"import sys; sys.exit(0 if sys.argv[1]=='7d' else 9)\" {{since}}",
            "params": [{"name": "since", "default": "7d"}],
        }
    ])

    assert verify_replay(tmp_path, "acme-tool", data)["ok"] is True


def test_defaults_that_cannot_render_are_refused_before_anything_runs(tmp_path: Path) -> None:
    data = _record([
        {
            "id": "report",
            "command": f"{_PY} -c \"print(1)\" {{since}}",
            "params": [{"name": "other", "default": "x"}],
        }
    ])

    result = verify_replay(tmp_path, "acme-tool", data)

    assert result["ok"] is False
    assert "could not be rendered" in result["reason"]


def test_a_dependency_entry_is_kept_for_every_invocation(tmp_path: Path) -> None:
    """`commands` is a SEQUENCE, `invocations` are ALTERNATIVES for its last entry.

    So the database still comes up before each one; only the unit is swapped.
    """
    marker = tmp_path / "dependency-ran.txt"
    dependency = f"{_PY} -c \"open(r'{marker}','a').write('x')\""
    data = _record(
        [
            {"id": "report", "command": f"{_PY} -c \"print('report')\""},
            {"id": "check", "command": f"{_PY} -c \"print('check')\""},
        ],
        dependency=dependency,
    )

    assert verify_replay(tmp_path, "acme-tool", data)["ok"] is True
    assert marker.read_text(encoding="utf-8") == "xx", "the dependency was dropped"


def test_a_record_with_no_invocations_replays_exactly_as_before(tmp_path: Path) -> None:
    # Every file recorded before invocations existed must keep verifying.
    legacy = {
        "service": "acme-tool",
        "verified": True,
        "verification": {"port": None},
        "commands": [{"purpose": "start", "command": f"{_PY} -c \"print('ok')\""}],
    }

    assert verify_replay(tmp_path, "acme-tool", legacy)["ok"] is True
