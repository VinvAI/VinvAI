"""The absolute replay deadline — the fix for "replay gets stuck".

A replayed start command that stays alive but never serves used to be polled
for the whole (mis-settable) budget; the deadline is the separate, absolute
wall-clock cap that guarantees the loop ALWAYS returns. These tests run a real
stub process that lives forever while its port never opens, under a short env
deadline.
"""

from __future__ import annotations

import socket
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core" / "src"))

from bringup.runner import verify_replay  # noqa: E402


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _data(command: str, port: int | None) -> dict:
    return {
        "service": "svc",
        "verified": True,
        "verification": {"port": port},
        "commands": [{"purpose": "start", "command": command}],
    }


def test_alive_but_never_serving_hits_deadline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A live-forever process whose port never opens must fail on the DEADLINE
    even when the (older) budget is set far higher — the budget being large is
    exactly the misconfiguration the absolute cap exists to survive."""
    monkeypatch.setenv("VINV_REPLAY_DEADLINE_S", "1")
    monkeypatch.setenv("VINV_BRINGUP_REPLAY_BUDGET_S", "600")
    port = _free_port()  # nothing will ever listen here
    started = time.monotonic()
    result = verify_replay(tmp_path, "svc", _data("sleep 300", port))
    elapsed = time.monotonic() - started
    assert result["ok"] is False
    assert result["reason"].startswith("deadline: port")
    assert "never served within 1s" in result["reason"]
    # The loop returned promptly (deadline + teardown), not on the 600s budget.
    assert elapsed < 30


def test_deadline_reports_portless_targets_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no recorded port and a grace window bigger than the deadline, the
    deadline still bounds the wait (nothing else would)."""
    monkeypatch.setenv("VINV_REPLAY_DEADLINE_S", "1")
    monkeypatch.setenv("VINV_BRINGUP_REPLAY_BUDGET_S", "600")
    monkeypatch.setenv("VINV_BRINGUP_REPLAY_GRACE_S", "600")
    result = verify_replay(tmp_path, "svc", _data("sleep 300", None))
    assert result["ok"] is False
    assert result["reason"].startswith("deadline: port (none)")


def test_deadline_does_not_shadow_real_verdicts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A serving replay still passes under a generous deadline."""
    monkeypatch.setenv("VINV_REPLAY_DEADLINE_S", "60")
    port = _free_port()
    py = f'"{sys.executable}"'
    result = verify_replay(
        tmp_path, "svc", _data(f"{py} -m http.server {port} --bind 127.0.0.1", port)
    )
    assert result["ok"] is True
    assert result["port"] == port
