"""Freeing a busy port before a replay — the eviction, and its two verdicts.

A port held by an earlier run is the most common reason a recorded start
command "fails": the command is fine, the socket is taken. Two behaviours are
pinned here with real sockets and real processes, because both were previously
absent and both are load-bearing:

1. `_free_port` kills the holder and waits for the port to go quiet, so the
   replay that follows measures the command it is verifying.
2. When the port cannot be freed, the replay refuses rather than probing —
   otherwise the squatter answers the very first poll and is credited with a
   pass the recorded command never earned.
"""

from __future__ import annotations

import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bringup.runner import (  # noqa: E402
    _free_port,
    _free_tcp_port,
    _listening_pids,
    _port_is_serving,
    verify_replay,
)

_PY = f'"{sys.executable}"'
# A server that binds and then refuses to die politely on its own. It ACCEPTS
# and closes each connection, which is not decoration: a listener that only
# binds fills its accept backlog after a handful of probes and then refuses
# connections, so the port would read as free after a few polls and the test
# would pass for the wrong reason.
_SQUATTER = (
    "import socket; s=socket.socket(); "
    "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); "
    "s.bind(('127.0.0.1',{port})); s.listen(64); s.settimeout(120)\n"
    "while True: c,a=s.accept(); c.close()"
)


def _spare_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _await_serving(port: int, timeout_s: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if _port_is_serving(port):
            return True
        time.sleep(0.1)
    return False


def test_free_port_is_a_no_op_when_nothing_holds_it() -> None:
    freed, detail = _free_port(_spare_port())
    assert freed is True
    assert "was free" in detail


def test_free_port_kills_the_holder_and_waits_for_the_socket_to_close() -> None:
    port = _spare_port()
    proc = subprocess.Popen([sys.executable, "-c", _SQUATTER.format(port=port)])
    try:
        assert _await_serving(port), "the fixture squatter never bound its port"
        assert _listening_pids(port), "the holder must be identifiable before it can be killed"
        freed, detail = _free_port(port)
        assert freed is True, detail
        assert not _port_is_serving(port)
        assert "freed port" in detail
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=10)


def test_free_tcp_port_skips_a_taken_port() -> None:
    with socket.socket() as held:
        held.bind(("127.0.0.1", 0))
        held.listen(1)
        taken = int(held.getsockname()[1])
        alternative = _free_tcp_port(taken)
        assert alternative is not None
        assert alternative > taken


def test_replay_evicts_a_squatter_instead_of_failing_to_bind() -> None:
    """The recorded command binds the port a previous run left held."""
    port = _spare_port()
    squatter = subprocess.Popen([sys.executable, "-c", _SQUATTER.format(port=port)])
    try:
        assert _await_serving(port), "the fixture squatter never bound its port"
        server = (
            "import socket,time; s=socket.socket(); "
            f"s.bind(('127.0.0.1',{port})); s.listen(5); time.sleep(60)"
        )
        result = verify_replay(
            Path.cwd(),
            "svc",
            {
                "service": "svc",
                "verified": True,
                "verification": {"port": port, "probe": {"type": "port"}},
                "commands": [{"purpose": "start", "command": f'{_PY} -c "{server}"'}],
            },
        )
        # Without the eviction this is a bind failure ("address already in
        # use") reported as a broken start command.
        assert result["ok"] is True, result.get("reason")
        assert result["port"] == port
    finally:
        if squatter.poll() is None:
            squatter.kill()
        squatter.wait(timeout=10)


def test_replay_refuses_rather_than_crediting_an_unkillable_squatter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A port we cannot free is a verdict about the machine, not the fix."""
    port = _spare_port()
    holder = subprocess.Popen([sys.executable, "-c", _SQUATTER.format(port=port)])
    try:
        assert _await_serving(port), "the fixture squatter never bound its port"
        # Stand in for the case the reaper genuinely cannot handle: another
        # user's process, a container, WSL. The kill is refused, so the port
        # stays busy — and the replay must NOT poll it.
        monkeypatch.setattr("bringup.runner._kill_pid", lambda pid: None)
        result = verify_replay(
            Path.cwd(),
            "svc",
            {
                "service": "svc",
                "verified": True,
                "verification": {"port": port, "probe": {"type": "port"}},
                "commands": [{"purpose": "start", "command": f"{_PY} -c \"print('never runs')\""}],
            },
        )
        assert result["ok"] is False
        assert "cannot verify" in result["reason"]
        # The second remedy is offered, not just the diagnosis.
        assert "free port" in result["reason"]
    finally:
        if holder.poll() is None:
            holder.kill()
        holder.wait(timeout=10)
