"""Replay-gate probe types — verifying non-HTTP services honestly.

`verification.probe` selects the readiness oracle: `stdio-jsonrpc` (an MCP
initialize round-trip over stdin/stdout), `process` (alive past grace), with
`port` staying the default. Real processes through the real gate — no mocks.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_PY = f'"{sys.executable}"'

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bringup.runner import verify_replay  # noqa: E402


def _data(
    command: str,
    probe: dict,
    port: int | None = None,
    trace_jsonl: str | None = None,
) -> dict:
    verification: dict = {"port": port, "probe": probe}
    if trace_jsonl is not None:
        verification["trace_jsonl"] = trace_jsonl
    return {
        "service": "svc",
        "verified": True,
        "verification": verification,
        "commands": [{"purpose": "start", "command": command}],
    }


# A minimal stdio JSON-RPC server: reads one line, answers with a JSON-RPC
# response line, then stays alive (like a real MCP server awaiting requests).
_STDIO_SERVER = (
    "import sys,json,time; line=sys.stdin.readline(); "
    "req=json.loads(line); "
    "sys.stdout.write(json.dumps({'jsonrpc':'2.0','id':req.get('id'),'result':{}})+chr(10)); "
    "sys.stdout.flush(); time.sleep(60)"
)


def test_stdio_jsonrpc_probe_passes_on_initialize_roundtrip() -> None:
    cmd = f"{_PY} -c \"{_STDIO_SERVER}\""
    result = verify_replay(Path.cwd(), "svc", _data(cmd, {"type": "stdio-jsonrpc"}))
    assert result["ok"] is True
    assert result["probe"] == "stdio-jsonrpc"
    assert "jsonrpc" in result["response_line"]


def test_stdio_jsonrpc_probe_skips_banner_noise_before_json() -> None:
    noisy = (
        "import sys,json,time; sys.stdout.write('booting mcp server...'+chr(10)); "
        "sys.stdout.flush(); line=sys.stdin.readline(); "
        "sys.stdout.write(json.dumps({'jsonrpc':'2.0','id':1,'result':{}})+chr(10)); "
        "sys.stdout.flush(); time.sleep(60)"
    )
    cmd = f"{_PY} -c \"{noisy}\""
    result = verify_replay(Path.cwd(), "svc", _data(cmd, {"type": "stdio-jsonrpc"}))
    assert result["ok"] is True


def test_stdio_jsonrpc_probe_uses_recorded_request() -> None:
    # The server echoes the request id back; a custom probe.request id proves
    # the recorded request (not the default) was written to stdin.
    cmd = f"{_PY} -c \"{_STDIO_SERVER}\""
    probe = {"type": "stdio-jsonrpc", "request": {"jsonrpc": "2.0", "id": 42, "method": "initialize", "params": {}}}
    result = verify_replay(Path.cwd(), "svc", _data(cmd, probe))
    assert result["ok"] is True
    assert '"id": 42' in result["response_line"] or '42' in result["response_line"]


def test_stdio_jsonrpc_probe_fails_when_process_exits_silently() -> None:
    result = verify_replay(Path.cwd(), "svc", _data("exit 3", {"type": "stdio-jsonrpc"}))
    assert result["ok"] is False
    assert result["exit_code"] == 3
    assert "initialize" in result["reason"]


def test_stdio_jsonrpc_probe_fails_on_deadline_when_never_responding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VINV_REPLAY_DEADLINE_S", "2")
    result = verify_replay(Path.cwd(), "svc", _data("sleep 60", {"type": "stdio-jsonrpc"}))
    assert result["ok"] is False
    assert "deadline" in result["reason"]


def test_process_probe_passes_when_alive_past_grace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VINV_BRINGUP_REPLAY_GRACE_S", "1")
    result = verify_replay(Path.cwd(), "svc", _data("sleep 60", {"type": "process"}))
    assert result["ok"] is True
    assert result["probe"] == "process"


def test_process_probe_fails_on_clean_immediate_exit() -> None:
    # An explicitly declared long-runner exiting 0 immediately is the
    # backgrounded-command incident — must fail even though the code is 0.
    result = verify_replay(Path.cwd(), "svc", _data("true", {"type": "process"}))
    assert result["ok"] is False
    assert result["exit_code"] == 0
    assert "process" in result["reason"]


# ── The `exit` oracle: run-to-completion units ────────────────────


def test_exit_probe_passes_when_command_completes_with_nonempty_trace(
    tmp_path: Path,
) -> None:
    trace = tmp_path / "trace.jsonl"
    cmd = f"{_PY} -c \"open(r'{trace}','w').write('{{}}'+chr(10))\""
    result = verify_replay(Path.cwd(), "svc", _data(cmd, {"type": "exit"}, trace_jsonl=str(trace)))
    assert result["ok"] is True
    assert result["probe"] == "exit"
    assert result["ran_to_completion"] is True
    assert result["exit_code"] == 0


def test_exit_probe_fails_on_empty_trace(tmp_path: Path) -> None:
    # The signature failure of a run-to-completion unit: the command worked and
    # tracelens instrumented nothing (a --target-package matching no package).
    trace = tmp_path / "trace.jsonl"
    cmd = f"{_PY} -c \"open(r'{trace}','w').close()\""
    result = verify_replay(Path.cwd(), "svc", _data(cmd, {"type": "exit"}, trace_jsonl=str(trace)))
    assert result["ok"] is False
    assert "EMPTY" in result["reason"]
    assert "target-package" in result["reason"]


def test_exit_probe_fails_on_unexpected_exit_code() -> None:
    result = verify_replay(Path.cwd(), "svc", _data("exit 2", {"type": "exit"}))
    assert result["ok"] is False
    assert result["exit_code"] == 2
    assert "expected 0" in result["reason"]


def test_exit_probe_honors_documented_nonzero_exit() -> None:
    # A linter that exits 1 on findings is behaving correctly; the recorded
    # expect_exit is what separates that from a broken invocation.
    result = verify_replay(Path.cwd(), "svc", _data("exit 1", {"type": "exit", "expect_exit": 1}))
    assert result["ok"] is True
    assert result["exit_code"] == 1


def test_exit_probe_fails_when_unit_never_returns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The inverse of the `process` probe: staying alive is the failure, because
    # a CLI that never returns is hung or waiting on stdin.
    monkeypatch.setenv("VINV_REPLAY_DEADLINE_S", "2")
    monkeypatch.setenv("VINV_BRINGUP_REPLAY_GRACE_S", "1")
    result = verify_replay(Path.cwd(), "svc", _data("sleep 60", {"type": "exit"}))
    assert result["ok"] is False
    assert "deadline" in result["reason"]
    assert "runs to completion" in result["reason"]


def test_exit_probe_ignores_stray_port() -> None:
    result = verify_replay(Path.cwd(), "svc", _data("true", {"type": "exit"}, port=8776))
    assert result["ok"] is True
    assert result["port"] is None


def test_unknown_probe_type_is_rejected() -> None:
    result = verify_replay(Path.cwd(), "svc", _data("sleep 60", {"type": "telepathy"}))
    assert result["ok"] is False
    assert "telepathy" in result["reason"]


def test_port_probe_type_without_port_is_rejected() -> None:
    result = verify_replay(Path.cwd(), "svc", _data("sleep 60", {"type": "port"}))
    assert result["ok"] is False
    assert "no port" in result["reason"]
