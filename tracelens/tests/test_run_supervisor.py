"""Dogfooding fix: the `tracelens run` wrapper must supervise its child.

Observed live: the wrapper process lingered (idle, holding the trace file)
after the traced service was SIGKILLed. The wrapper now forks the instrumented
target into its own process group, reaps it promptly, forwards signals, and
exits with the child's status (128+N for signal deaths) while leaving a
complete, parseable JSONL trace behind.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX supervisor (fork) only")


def _spawn_run(tmp_path: Path, target_args: list[str]) -> tuple[subprocess.Popen, Path]:
    """Start `tracelens run -o <trace> -- <target_args>`; return (wrapper, trace)."""
    out = tmp_path / "trace.jsonl"
    env = {**os.environ}
    # The execvp dispatch path needs opentelemetry-instrument next to python.
    bindir = str(Path(sys.executable).parent)
    env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
    proc = subprocess.Popen(
        [sys.executable, "-m", "tracelens.cli", "run", "-o", str(out), "--", *target_args],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    return proc, out


def _wait_for_pidfile(pidfile: Path, proc: subprocess.Popen, timeout: float = 90.0) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pidfile.is_file():
            text = pidfile.read_text(encoding="utf-8").strip()
            if text:
                return int(text)
        if proc.poll() is not None:
            outs, errs = proc.communicate()
            raise AssertionError(
                f"tracelens run exited early (rc={proc.returncode}):\n{outs}\n{errs}"
            )
        time.sleep(0.05)
    proc.kill()
    raise AssertionError("target never wrote its pidfile")


def _sleeper_code(pidfile: Path) -> str:
    return (
        "import os, time, pathlib; "
        f"pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid())); "
        "time.sleep(60)"
    )


def _assert_parseable_jsonl(path: Path) -> None:
    assert path.exists(), "trace file was never created"
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            json.loads(line)


def _assert_gone(pid: int, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    raise AssertionError(f"process {pid} still alive")


def test_wrapper_exits_when_child_is_sigkilled_runpy(tmp_path: Path) -> None:
    """Primary live scenario: script/module target (runpy dispatch), child SIGKILLed."""
    pidfile = tmp_path / "pid.txt"
    script = tmp_path / "sleeper.py"
    script.write_text(_sleeper_code(pidfile), encoding="utf-8")
    proc, out = _spawn_run(tmp_path, [sys.executable, str(script)])
    try:
        child_pid = _wait_for_pidfile(pidfile, proc)
        assert child_pid != proc.pid, "expected a real wrapper/child process split"
        os.kill(child_pid, signal.SIGKILL)
        rc = proc.wait(timeout=5)
        assert rc == 128 + signal.SIGKILL, f"expected 137 (128+SIGKILL), got {rc}"
        _assert_parseable_jsonl(out)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)


def test_wrapper_exits_when_child_is_sigkilled_execvp(tmp_path: Path) -> None:
    """`python -c` target (execvp/opentelemetry-instrument dispatch), child SIGKILLed."""
    if not (Path(sys.executable).parent / "opentelemetry-instrument").is_file():
        pytest.skip("opentelemetry-instrument not found next to python interpreter")
    pidfile = tmp_path / "pid.txt"
    proc, out = _spawn_run(tmp_path, [sys.executable, "-c", _sleeper_code(pidfile)])
    try:
        child_pid = _wait_for_pidfile(pidfile, proc)
        assert child_pid != proc.pid
        os.kill(child_pid, signal.SIGKILL)
        rc = proc.wait(timeout=5)
        assert rc == 128 + signal.SIGKILL, f"expected 137 (128+SIGKILL), got {rc}"
        _assert_parseable_jsonl(out)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)


def test_wrapper_forwards_sigterm_to_child_group(tmp_path: Path) -> None:
    """SIGTERM to the wrapper reaches the child's process group; both exit."""
    pidfile = tmp_path / "pid.txt"
    script = tmp_path / "sleeper.py"
    script.write_text(_sleeper_code(pidfile), encoding="utf-8")
    proc, _out = _spawn_run(tmp_path, [sys.executable, str(script)])
    try:
        child_pid = _wait_for_pidfile(pidfile, proc)
        proc.send_signal(signal.SIGTERM)
        rc = proc.wait(timeout=10)
        # The child's in-process signal handler exits with 128+SIGTERM (143),
        # which the wrapper mirrors as a plain exit code.
        assert rc == 128 + signal.SIGTERM, f"expected 143 (128+SIGTERM), got {rc}"
        _assert_gone(child_pid)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)


def test_wrapper_mirrors_child_exit_code(tmp_path: Path) -> None:
    script = tmp_path / "exit7.py"
    script.write_text("import sys; sys.exit(7)\n", encoding="utf-8")
    proc, _out = _spawn_run(tmp_path, [sys.executable, str(script)])
    rc = proc.wait(timeout=120)
    proc.communicate()
    assert rc == 7


def test_finalize_truncates_partial_trailing_line(tmp_path: Path) -> None:
    from tracelens.launcher.run import _finalize_trace_output

    trace = tmp_path / "trace.jsonl"
    good = json.dumps({"event": "enter"}) + "\n" + json.dumps({"event": "exit"}) + "\n"
    trace.write_text(good + '{"event": "ent', encoding="utf-8")  # SIGKILL mid-write
    _finalize_trace_output(str(trace))
    assert trace.read_text(encoding="utf-8") == good
    _assert_parseable_jsonl(trace)

    # Idempotent on an already-complete file.
    _finalize_trace_output(str(trace))
    assert trace.read_text(encoding="utf-8") == good
