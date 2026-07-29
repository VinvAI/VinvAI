"""A failing replay must NOT be written off as a run-to-completion CLI."""

from __future__ import annotations

import sys
from pathlib import Path

from bringup.runner import verify_replay


def test_quick_nonzero_exit_stays_a_failure(tmp_path):
    data = {
        "commands": [{"command": f"{sys.executable} -c 'raise SystemExit(3)'"}],
        "verification": {"probe": {"type": "process"}},
    }
    r = verify_replay(Path(tmp_path), "broken", data)
    assert r["ok"] is False
    assert r.get("verdict") != "not-a-service"  # real failure -> retry/fix path


def test_exit_zero_with_error_output_stays_a_failure(tmp_path):
    """A service that prints an error but exits 0 must NOT be skipped."""
    data = {
        "commands": [
            {"command": f"{sys.executable} -c \"print('bind failed: address already in use — Error'); raise SystemExit(0)\""}
        ],
        "verification": {"probe": {"type": "process"}},
    }
    r = verify_replay(Path(tmp_path), "lying-service", data)
    assert r["ok"] is False
    assert r.get("verdict") != "not-a-service"  # stays on the retry/fix path
