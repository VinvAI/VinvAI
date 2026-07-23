"""Replay verification gate — the harness-side proof that the SAVED start
command works for its real consumer (the extension's `bash -lc` replay).

These tests run real processes through the real gate; nothing is mocked. They
cover the exact incident that motivated the gate: an agent recording the
backgrounded form (`… > /tmp/x.log 2>&1 & echo $!`) whose replay exits
instantly with code 0 while the true server survives as a port-squatting
orphan.
"""

from __future__ import annotations

import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

# The replay runs through bash; a Windows interpreter path like C:\Users\…
# loses its backslashes unless quoted inside the bash command string.
_PY = f'"{sys.executable}"'

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core" / "src"))

from bringup.runner import (  # noqa: E402
    _replay_script,
    _resolve_bash,
    _write_replay_script_file,
    verify_replay,
)

# Resolve bash exactly the way the gate does — `shutil.which("bash")` finds
# WSL's System32 stub on Windows, which is not a usable shell.
_BASH = _resolve_bash() or "bash"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _data(command: str, port: int | None, wd: str | None = None) -> dict:
    entry: dict = {"purpose": "start", "command": command}
    if wd:
        entry["working_directory"] = wd
    return {
        "service": "svc",
        "verified": True,
        "verification": {"port": port},
        "commands": [entry],
    }


def test_backgrounded_command_fails_replay(tmp_path: Path) -> None:
    """The incident: `cmd & echo PID=$!` exits instantly — gate must fail it and
    reap the backgrounded child so it does not survive as an orphan."""
    port = _free_port()
    cmd = (
        f"{_PY} -m http.server {port} --bind 127.0.0.1 "
        f"> /dev/null 2>&1 & echo VINV_RESTART_PID=$!"
    )
    result = verify_replay(tmp_path, "svc", _data(cmd, port))
    assert result["ok"] is False
    assert result["exit_code"] == 0
    assert "FOREGROUND" in result["reason"]
    # Teardown must have reaped the orphaned background server.
    time.sleep(0.5)
    with socket.socket() as s:
        assert s.connect_ex(("127.0.0.1", port)) != 0, "orphan still holds the port"


def test_foreground_server_passes_and_is_torn_down(tmp_path: Path) -> None:
    port = _free_port()
    cmd = f"{_PY} -m http.server {port} --bind 127.0.0.1"
    result = verify_replay(tmp_path, "svc", _data(cmd, port))
    assert result["ok"] is True
    assert result["port"] == port
    # The gate must not leave the verification replay running.
    time.sleep(0.5)
    with socket.socket() as s:
        assert s.connect_ex(("127.0.0.1", port)) != 0, "replay server left running"


def test_crashing_command_fails_with_exit_code(tmp_path: Path) -> None:
    result = verify_replay(tmp_path, "svc", _data("exit 3", 1))
    assert result["ok"] is False
    assert result["exit_code"] == 3


def test_portless_long_runner_passes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VINV_BRINGUP_REPLAY_GRACE_S", "1")
    result = verify_replay(tmp_path, "svc", _data("sleep 60", None))
    assert result["ok"] is True
    assert result["port"] is None


def test_alive_but_never_serving_fails_on_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VINV_BRINGUP_REPLAY_BUDGET_S", "2")
    port = _free_port()  # nothing will listen here
    result = verify_replay(tmp_path, "svc", _data("sleep 60", port))
    assert result["ok"] is False
    assert "never accepted" in result["reason"]


def test_no_commands_fails(tmp_path: Path) -> None:
    result = verify_replay(tmp_path, "svc", {"commands": []})
    assert result["ok"] is False


def test_replay_script_mirrors_extension_composition() -> None:
    commands = [
        {"command": "docker compose up -d db", "working_directory": "/repo"},
        {"command": "python -m uvicorn app:app", "working_directory": "/repo/api"},
    ]
    script = _replay_script(commands)
    assert script == 'cd "/repo" && docker compose up -d db && cd "/repo/api" && python -m uvicorn app:app'


def test_replay_script_file_is_runnable(tmp_path: Path) -> None:
    """The .sh sidecar exists so humans replay without JSON-unescaping quotes."""
    (tmp_path / ".vinv" / "start_commands").mkdir(parents=True)
    data = _data('PATH="/x/bin:$PATH" echo ok', None, wd=str(tmp_path))
    path = _write_replay_script_file(tmp_path, "svc", data)
    assert path.name == "svc.sh"
    out = subprocess.run([_BASH, str(path)], capture_output=True, text=True, timeout=10)
    assert out.returncode == 0
    assert out.stdout.strip() == "ok"
