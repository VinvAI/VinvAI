"""Regression tests for the pexpect terminal transport (post terminal-deadlock RCA).

Two layers:

* **FakePty unit tests** — deterministic simulation of every failure mode from
  the incident: exact sentinel completion, multiline temp-script routing,
  budget overrun + escalating recovery, wedged shell replacement (no blind
  retry), fd death mid-command, output floods vs the capture ceiling, and
  replay-impossible incremental reads.
* **Live bash e2e** (POSIX only) — a real ``/bin/bash`` PTY driven through the
  public backend API, including the exact ``set -euo pipefail`` + ``| head``
  SIGPIPE scenario that killed the bringup session, timeout recovery, busy
  detection, and cwd persistence.
"""

from __future__ import annotations

import errno
import os
import re
import sys
import time

import pytest

from core.components.tools.terminal import session_state as st
from core.components.tools.terminal.backends import python_pexpect_backend as pb


class TIMEOUT(Exception):
    """Name-compatible with pexpect.TIMEOUT for _is_timeout_exc."""


_TOKEN_RE = re.compile(r"__VINV_DONE_[0-9a-f]{32}")


class FakePty:
    """Deterministic pexpect-child stand-in with time-scheduled output."""

    def __init__(self) -> None:
        self.pid = 4242
        self.sent: list[str] = []
        self.intr_count = 0
        self.busy: bool | None = None  # consumed by patched _shell_is_busy
        self.die_when_drained: BaseException | None = None
        self._events: list[tuple[float, str]] = []
        self.on_sendline = None
        self.on_sendintr = None
        self._closed = False

    def schedule(self, delay: float, text: str) -> None:
        self._events.append((time.monotonic() + delay, text))

    def sendline(self, line: str = "") -> None:
        self.sent.append(line)
        if self.on_sendline:
            self.on_sendline(line)

    def sendintr(self) -> None:
        self.intr_count += 1
        if self.on_sendintr:
            self.on_sendintr()

    def read_nonblocking(self, size: int = 65536, timeout: float = 0.0) -> str:
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            now = time.monotonic()
            ready = sorted((e for e in self._events if e[0] <= now), key=lambda e: e[0])
            if ready:
                ev = ready[0]
                self._events.remove(ev)
                text = ev[1]
                if len(text) > size:
                    self._events.insert(0, (ev[0], text[size:]))
                    return text[:size]
                return text
            if not self._events and self.die_when_drained is not None:
                raise self.die_when_drained
            if now >= deadline:
                raise TIMEOUT("no data")
            time.sleep(0.005)

    def isalive(self) -> bool:
        return not self._closed

    def close(self, force: bool = True) -> None:
        self._closed = True


@pytest.fixture()
def fake_session(monkeypatch):
    """Install a FakePty as the current instance's pexpect session."""
    iid = st.get_current_terminal_instance_id()
    fake = FakePty()
    st.pexpect_sessions_set(iid, fake)
    st.set_terminal_session_ref(fake)
    monkeypatch.setattr(pb, "_MIN_BLOCK_BUDGET", 0.4)
    monkeypatch.setattr(pb, "_RECOVERY_GRACE_SCALE", 0.05)
    monkeypatch.setattr(pb, "_shell_is_busy", lambda p: getattr(p, "busy", None))
    yield fake
    st.pexpect_sessions_del(iid)
    st.set_terminal_session_ref(None)


def _auto_complete(fake: FakePty, body: str, exit_code: int = 0, delay: float = 0.02) -> None:
    """Make the fake shell 'run' the next command: emit body then the sentinel."""

    def handler(line: str) -> None:
        m = _TOKEN_RE.search(line)
        if m:
            fake.schedule(delay, f"{body}\n{m.group(0)}:{exit_code}\n")
        else:
            fake.schedule(delay, body)

    fake.on_sendline = handler


# ---------------------------------------------------------------------------
# Sentinel wrapping
# ---------------------------------------------------------------------------


class TestSentinelWrapping:
    def test_simple_line_wrapped_inline(self):
        line, script = pb._wrap_for_sentinel("echo hi", "TOK")
        assert script is None
        assert line.startswith("echo hi; ")
        assert "TOK:%s" in line

    def test_background_suffix_joined_without_semicolon(self):
        line, script = pb._wrap_for_sentinel("npm run dev &", "TOK")
        assert script is None
        assert "&;" not in line
        assert line.startswith("npm run dev & ")

    def test_multiline_routed_to_temp_script(self):
        ks = "set -euo pipefail\nseq 1 10 | head -2\necho done"
        line, script = pb._wrap_for_sentinel(ks, "TOK")
        assert script is not None
        try:
            with open(script, encoding="utf-8") as f:
                assert f.read().rstrip("\n") == ks
            assert f"bash '{script}'" in line or f"bash {script}" in line
            assert "rm -f" in line
            assert "TOK:%s" in line
        finally:
            os.unlink(script)

    def test_comment_routed_to_temp_script(self):
        # `cmd # comment; printf sentinel` would swallow the sentinel.
        line, script = pb._wrap_for_sentinel("echo hi  # a comment", "TOK")
        assert script is not None
        os.unlink(script)

    def test_trailing_operator_routed_to_temp_script(self):
        for ks in ("echo hi;", "echo hi &&", "echo hi |", "echo hi \\"):
            _line, script = pb._wrap_for_sentinel(ks, "TOK")
            assert script is not None, ks
            os.unlink(script)

    def test_huge_single_line_routed_to_temp_script(self):
        _line, script = pb._wrap_for_sentinel("echo " + "x" * 5000, "TOK")
        assert script is not None
        os.unlink(script)

    def test_empty_keystrokes_still_complete(self):
        line, script = pb._wrap_for_sentinel("   ", "TOK")
        assert script is None
        assert line.startswith("printf")

    def test_strip_sentinel_removes_token_line(self):
        out = pb._strip_sentinel("hello\n__VINV_DONE_ab:0\n", "__VINV_DONE_ab")
        assert out == "hello"


# ---------------------------------------------------------------------------
# Capture ceiling
# ---------------------------------------------------------------------------


class TestCollector:
    def test_under_ceiling_verbatim(self):
        col = pb._Collector(ceiling=1000)
        col.add("a" * 100)
        col.add("b" * 100)
        assert col.text() == "a" * 100 + "b" * 100

    def test_flood_preserves_head_and_tail_with_notice(self):
        col = pb._Collector(ceiling=10_000)
        col.add("HEAD_MARK " + "x" * 20_000)
        col.add("y" * 20_000 + " TAIL_MARK")
        text = col.text()
        assert text.startswith("HEAD_MARK")
        assert text.endswith("TAIL_MARK")
        assert "capture ceiling" in text
        assert col.dropped > 0
        # bounded: ceiling + notice slack
        assert len(text) < 11_000

    def test_scan_tail_bounded(self):
        col = pb._Collector(ceiling=1000)
        for _ in range(100):
            col.add("z" * 1000)
        assert len(col.scan_tail) <= 8192


# ---------------------------------------------------------------------------
# Blocking send: exact completion
# ---------------------------------------------------------------------------


class TestBlockingCompletion:
    def test_completes_at_sentinel_with_exit_code(self, fake_session):
        _auto_complete(fake_session, "hello world", exit_code=0)
        t0 = time.monotonic()
        r = pb.send_terminal_command("echo hello world", duration=30, block=True)
        elapsed = time.monotonic() - t0
        assert r["status"] == "success"
        assert r["completed"] is True
        assert r["exit_code"] == 0
        assert "hello world" in r["output"]
        assert "__VINV_DONE_" not in r["output"]
        assert elapsed < 5, "must return at completion, not at the duration cap"

    def test_nonzero_exit_code_surfaces(self, fake_session):
        _auto_complete(fake_session, "boom", exit_code=3)
        r = pb.send_terminal_command("false", duration=10, block=True)
        assert r["status"] == "success"
        assert r["exit_code"] == 3

    def test_budget_floor_protects_slightly_slow_commands(self, fake_session):
        # Completes after 0.25s while caller asked duration=0.05: the floor
        # (patched to 0.4s) must let it finish instead of interrupting.
        _auto_complete(fake_session, "slowish", delay=0.25)
        r = pb.send_terminal_command("ls", duration=0.05, block=True)
        assert r["status"] == "success"
        assert r["completed"] is True
        assert fake_session.intr_count == 0

    def test_empty_output_command_is_success_not_timeout(self, fake_session):
        _auto_complete(fake_session, "", exit_code=0)
        r = pb.send_terminal_command("true", duration=10, block=True)
        assert r["status"] == "success"
        assert r["completed"] is True
        assert r["exit_code"] == 0


# ---------------------------------------------------------------------------
# Overrun recovery
# ---------------------------------------------------------------------------


class TestOverrunRecovery:
    def test_interrupt_recovers_session(self, fake_session):
        def on_line(line: str) -> None:
            fake_session.busy = True  # job takes the terminal foreground
            fake_session.schedule(0.01, "partial output\n")

        def on_intr():
            fake_session.schedule(0.01, "^C\n")
            fake_session.busy = False

        fake_session.on_sendline = on_line
        fake_session.on_sendintr = on_intr

        r = pb.send_terminal_command("sleep 999", duration=0.1, block=True)
        assert r["status"] == "timeout"
        assert r["completed"] is False
        assert "interrupted" in r["error"]
        assert "partial output" in r["output"]
        assert fake_session.intr_count >= 1
        assert len(fake_session.sent) == 1, "command must never be re-sent"

    def test_sentinel_after_interrupt_reports_exit_code(self, fake_session):
        sent_token: list[str] = []

        def on_line(line: str) -> None:
            fake_session.busy = True
            m = _TOKEN_RE.search(line)
            if m:
                sent_token.append(m.group(0))
            fake_session.schedule(0.01, "working...\n")

        def on_intr() -> None:
            fake_session.busy = False
            if sent_token:
                fake_session.schedule(0.01, f"\n{sent_token[0]}:130\n")

        fake_session.on_sendline = on_line
        fake_session.on_sendintr = on_intr

        r = pb.send_terminal_command("sleep 999", duration=0.1, block=True)
        assert r["status"] == "timeout"
        assert r["exit_code"] == 130

    def test_wedged_shell_replaced_without_retry(self, fake_session, monkeypatch):
        fake_session.on_sendline = lambda line: setattr(fake_session, "busy", True)  # never releases
        init_calls: list[tuple] = []
        monkeypatch.setattr(
            pb,
            "initialize_terminal",
            lambda *a, **k: init_calls.append(a) or {"status": "success"},
        )

        r = pb.send_terminal_command("stuck_forever", duration=0.1, block=True)
        assert r["status"] == "timeout"
        assert r["session_reinitialized"] is True
        assert "NOT re-run" in r["error"]
        assert len(init_calls) == 1
        assert len(fake_session.sent) == 1, "no blind retry of the same command"
        iid = st.get_current_terminal_instance_id()
        assert st.pexpect_sessions_get(iid) is None, "wedged session must be dropped"


# ---------------------------------------------------------------------------
# Dead transport
# ---------------------------------------------------------------------------


class TestDeadTransport:
    def test_fd_death_reports_partial_output_and_no_retry(self, fake_session, monkeypatch):
        init_calls: list[tuple] = []
        monkeypatch.setattr(
            pb,
            "initialize_terminal",
            lambda *a, **k: init_calls.append(a) or {"status": "success"},
        )
        fake_session.schedule(0.0, "partial before death\n")
        fake_session.die_when_drained = OSError(errno.EIO, "Input/output error")

        r = pb.send_terminal_command("make world", duration=5, block=True)
        assert r["status"] == "error"
        assert "partial before death" in r["output"]
        assert r["session_reinitialized"] is True
        assert "NOT re-run" in r["error"]
        assert len(init_calls) == 1
        assert len(fake_session.sent) == 1

    def test_pexpect_eof_class_detected_as_dead(self):
        class EOF(Exception):
            pass

        assert st._pexpect_fd_is_dead(EOF("End Of File (EOF). Empty string style platform."))
        assert st._pexpect_fd_is_dead(OSError(errno.EIO, "eio"))
        assert st._pexpect_fd_is_dead(OSError(errno.EBADF, "ebadf"))
        assert not st._pexpect_fd_is_dead(ValueError("nope"))


# ---------------------------------------------------------------------------
# Busy detection
# ---------------------------------------------------------------------------


class TestBusyDetection:
    def test_blocking_send_on_busy_shell_refused_without_typing(self, fake_session):
        fake_session.busy = True
        r = pb.send_terminal_command("echo hi", duration=5, block=True)
        assert r["status"] == "error"
        assert "terminal_busy" in r["error"]
        assert fake_session.sent == [], "must not type into a busy shell"
        assert fake_session.intr_count == 0, "must not kill the user's foreground job"

    def test_nonblocking_send_allowed_on_busy_shell(self, fake_session):
        fake_session.busy = True
        fake_session.schedule(0.01, "answered\n")
        r = pb.send_terminal_command("y", duration=0.3, block=False)
        assert r["status"] == "success"
        assert fake_session.sent == ["y"], "raw keystrokes go through verbatim"


# ---------------------------------------------------------------------------
# Replay-impossible incremental reads
# ---------------------------------------------------------------------------


class TestIncrementalReads:
    def test_no_scrollback_replay(self, fake_session):
        fake_session.schedule(0.0, "FIRST\n")
        r1 = pb.get_incremental_output()
        assert r1["status"] == "success"
        assert "FIRST" in r1["output"]

        fake_session.schedule(0.0, "SECOND\n")
        r2 = pb.get_incremental_output()
        assert "SECOND" in r2["output"]
        assert "FIRST" not in r2["output"], "old output must never be re-returned"

        r3 = pb.get_incremental_output()
        assert r3["output"] == ""

    def test_get_terminal_state_is_also_incremental(self, fake_session):
        fake_session.schedule(0.0, "ALPHA\n")
        r1 = pb.get_terminal_state(False)
        assert "ALPHA" in r1["output"]
        r2 = pb.get_terminal_state(False)
        assert "ALPHA" not in r2["output"]


# ---------------------------------------------------------------------------
# block=False raw mode
# ---------------------------------------------------------------------------


class TestNonBlocking:
    def test_raw_keystrokes_no_sentinel_and_idle_settle(self, fake_session, monkeypatch):
        monkeypatch.setattr(pb, "_IDLE_SETTLE_NONBLOCK", 0.15)
        fake_session.schedule(0.02, "server listening on :3000\n")
        t0 = time.monotonic()
        r = pb.send_terminal_command("npm run dev", duration=30, block=False)
        elapsed = time.monotonic() - t0
        assert r["status"] == "success"
        assert fake_session.sent == ["npm run dev"], "no sentinel wrapping in raw mode"
        assert "listening" in r["output"]
        assert elapsed < 5, "must settle on quiet, not sleep the full duration"


# ---------------------------------------------------------------------------
# Live bash end-to-end (POSIX)
# ---------------------------------------------------------------------------

_LIVE = pytest.mark.skipif(
    sys.platform == "win32" or not st.PEXPECT_AVAILABLE,
    reason="live PTY tests require POSIX + pexpect",
)


@_LIVE
class TestLiveBash:
    @pytest.fixture(autouse=True)
    def live_session(self, tmp_path):
        iid = st.get_current_terminal_instance_id()
        st.pexpect_sessions_del(iid)
        r = pb.initialize_terminal(None, str(tmp_path), "/bin/bash")
        assert r["status"] == "success", r
        yield
        pb.close_terminal()
        st.pexpect_sessions_del(iid)
        st.set_terminal_session_ref(None)

    def test_simple_command_exact_completion(self):
        t0 = time.monotonic()
        r = pb.send_terminal_command("echo live_hello", duration=60, block=True)
        assert r["status"] == "success", r
        assert r["exit_code"] == 0
        assert "live_hello" in r["output"]
        assert time.monotonic() - t0 < 10

    def test_exit_code_propagates(self):
        r = pb.send_terminal_command("bash -c 'exit 7'", duration=30, block=True)
        assert r["status"] == "success"
        assert r["exit_code"] == 7

    def test_cwd_persists_across_inline_commands(self):
        r1 = pb.send_terminal_command("cd /tmp", duration=30, block=True)
        assert r1["exit_code"] == 0
        r2 = pb.send_terminal_command("pwd", duration=30, block=True)
        assert "tmp" in r2["output"]

    def test_rca_killer_multiline_pipefail_head_survives(self):
        # The exact incident scenario: strict-mode script whose pipeline gets
        # SIGPIPE from `head`. Must complete with an exit code (in the child
        # bash) and leave the interactive session fully usable.
        script = "set -euo pipefail\nseq 1 200000 | head -2\necho after_head"
        r = pb.send_terminal_command(script, duration=60, block=True)
        assert r["status"] == "success", r
        assert r["completed"] is True
        assert r["exit_code"] is not None
        assert "1\n2" in r["output"].replace("\r\n", "\n")

        r2 = pb.send_terminal_command("echo session_alive", duration=30, block=True)
        assert r2["status"] == "success"
        assert "session_alive" in r2["output"]

    def test_overrun_interrupt_then_session_usable(self, monkeypatch):
        monkeypatch.setattr(pb, "_MIN_BLOCK_BUDGET", 1.0)
        t0 = time.monotonic()
        r = pb.send_terminal_command("sleep 120", duration=1, block=True)
        elapsed = time.monotonic() - t0
        assert r["status"] == "timeout", r
        assert r["completed"] is False
        assert elapsed < 20
        assert r.get("session_reinitialized") is not True, "SIGINT should recover in place"

        r2 = pb.send_terminal_command("echo recovered_ok", duration=30, block=True)
        assert r2["status"] == "success", r2
        assert "recovered_ok" in r2["output"]

    def test_busy_shell_refuses_blocking_command(self, monkeypatch):
        monkeypatch.setattr(pb, "_IDLE_SETTLE_NONBLOCK", 0.2)
        r1 = pb.send_terminal_command("sleep 2", duration=1, block=False)
        assert r1["status"] == "success"

        r2 = pb.send_terminal_command("echo should_not_run", duration=5, block=True)
        assert r2["status"] == "error", r2
        assert "terminal_busy" in r2["error"]

        time.sleep(2.2)  # let the sleep finish
        r3 = pb.send_terminal_command("echo now_free", duration=30, block=True)
        assert r3["status"] == "success", r3
        assert "now_free" in r3["output"]

    def test_syntax_error_command_still_completes_via_script_path(self):
        # Unbalanced quote on a multiline block: the child bash exits with a
        # syntax error code, the sentinel still fires, session stays clean.
        r = pb.send_terminal_command('echo "unterminated\necho next', duration=30, block=True)
        assert r["status"] in ("success", "timeout")
        r2 = pb.send_terminal_command("echo still_fine", duration=30, block=True)
        assert r2["status"] == "success"
        assert "still_fine" in r2["output"]
