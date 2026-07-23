"""In-process pexpect terminal backend — fallback when Electron PTY IPC is unavailable.

Transport design (post terminal-deadlock RCA):

* **Exact completion, not guessed idle.** Every ``block=True`` command is wrapped
  with a unique sentinel that the shell prints only after the command returns
  (with its exit code). The call returns the instant the sentinel arrives —
  ``duration`` is purely an upper budget, never a fixed wait, so fast commands
  return in milliseconds and slow ones run until genuinely done.
* **Multiline / complex commands run in a child bash via a temp script.** The
  interactive session only ever receives a short synthetic control line, so
  ``set -euo pipefail``, SIGPIPE from ``| head``, here-docs, comments, or
  unbalanced quotes in agent-authored scripts can neither kill nor desync the
  session, and the sentinel cannot be swallowed by user content.
* **Replay-impossible reads.** All output is consumed incrementally with
  ``read_nonblocking`` straight from the OS. The old ``expect(TIMEOUT)`` +
  ``before`` pattern never trimmed pexpect's buffer, so each poll re-returned
  the entire scrollback — the root cause of the megabyte "repeated transcript"
  captures.
* **Signal-free busy detection.** ``tcgetpgrp`` on the PTY reveals whether a
  foreground job still owns the terminal. A new blocking command against a busy
  shell returns a typed ``terminal_busy`` result instead of typing keystrokes
  into a running program (which is how sessions used to wedge).
* **Escalating, verified recovery.** When a command overruns its budget we
  escalate SIGINT → SIGINT → SIGTERM → SIGKILL against the foreground process
  group, verifying after each step that the shell reclaimed the terminal. Only
  if the shell itself is wedged is the PTY replaced — and the command is
  **never silently re-run** (results report ``session_reinitialized`` instead).
* **Bounded capture.** Output is accumulated head+tail under a byte ceiling so
  a runaway producer cannot OOM the process; the elision notice points at the
  redirect-to-logfile workflow which preserves everything on disk.
"""

from __future__ import annotations

import logging
import os
import re
import signal
import sys
import tempfile
import time
import uuid
from typing import Any, Optional, cast

from core.components.tools.terminal import session_state as st
from core.components.tools.terminal import terminal_events as tev

logger = logging.getLogger(__name__)

# pexpect.spawn is POSIX-only (pty/termios/fork). On Windows we drive the same
# sentinel logic over an equivalent subprocess transport that quacks like a
# pexpect child (see win_shell_child.WinShellChild): read_nonblocking /
# sendline / sendintr / isalive / close are identical.
IS_WINDOWS = sys.platform == "win32"

_SENTINEL_PREFIX = "__VINV_DONE_"

# Raw-capture safety ceiling (characters kept in memory per command). This is
# NOT a context limit — the model-facing digest is produced later by
# terminal_tools._bounded_output — it only stops a pathological producer from
# exhausting process memory. Head and tail are both preserved.
_CAPTURE_CEILING = int(os.environ.get("VINV_ENGINE_TERMINAL_CAPTURE_MAX_BYTES", str(8 * 1024 * 1024)))

# block=False settle: return once output has been quiet this long (daemons /
# raw keystrokes have no completion signal, so activity is the only cue).
_IDLE_SETTLE_NONBLOCK = float(os.environ.get("VINV_ENGINE_TERMINAL_IDLE_SETTLE_S", "0.5"))

# Floor for a blocking command's budget. Sentinel completion means a generous
# budget costs nothing (we return at completion), while a too-small caller
# value (e.g. duration=2 for a slightly slow `ls`) would otherwise trigger a
# needless interrupt cycle.
_MIN_BLOCK_BUDGET = float(os.environ.get("VINV_ENGINE_TERMINAL_MIN_BLOCK_BUDGET_S", "10"))

# How much of the UI event payload to broadcast (display-only; full output is
# returned to the caller / artifact-logged separately).
_BROADCAST_CAP = 32768

# Single lines longer than this go through the temp-script path too: typing
# huge lines into a PTY risks the kernel input-buffer overflow that wedged
# sessions in the past.
_INLINE_COMMAND_MAX = 2000

# Multiplier on the escalating recovery grace windows (SIGINT→TERM→KILL).
# Operational knob, not a command timeout — completion is always sentinel-driven.
_RECOVERY_GRACE_SCALE = float(os.environ.get("VINV_ENGINE_TERMINAL_RECOVERY_GRACE_SCALE", "1.0"))


class _TransportDead(Exception):
    """PTY/fd died mid-command. Carries partial output for honest reporting."""

    def __init__(self, partial_output: str, cause: BaseException):
        super().__init__(str(cause))
        self.partial_output = partial_output
        self.cause = cause


def _is_timeout_exc(exc: BaseException, pexpect: Any) -> bool:
    t = getattr(pexpect, "TIMEOUT", None)
    if t is not None and isinstance(exc, t):
        return True
    return type(exc).__name__ == "TIMEOUT"


def _read_new_output(_pty: Any, pexpect: Any, wait: float) -> str:
    """Read newly-arrived PTY output exactly once.

    Blocks up to ``wait`` seconds for the first chunk, then drains whatever is
    instantly available. Data is consumed from the OS — a second call can never
    re-return it (the replay bug that produced megabyte repeated transcripts is
    structurally impossible here). EOF / dead-fd errors propagate to the caller.
    """
    chunks: list[str] = []
    timeout = max(0.0, wait)
    while True:
        try:
            data = _pty.read_nonblocking(size=65536, timeout=timeout)
        except Exception as e:
            if _is_timeout_exc(e, pexpect):
                break
            if chunks:
                # The fd died mid-drain: hand back what WAS read so no output
                # is silently lost; the dead fd re-raises on the next call.
                break
            raise
        if not data:
            break
        chunks.append(data)
        timeout = 0.0  # drain only what is already available
    return "".join(chunks)


class _Collector:
    """Accumulate output under a byte ceiling, preserving head and tail.

    ``scan_tail`` is a small rolling window used for sentinel matching so the
    match cost stays O(1) per chunk regardless of total output size.
    """

    def __init__(self, ceiling: int = _CAPTURE_CEILING):
        self._head: list[str] = []
        self._head_len = 0
        self._head_max = max(1024, ceiling * 5 // 8)
        self._tail_max = max(1024, ceiling - self._head_max)
        self._tail = ""
        self.dropped = 0
        self.scan_tail = ""

    def add(self, chunk: str) -> None:
        if not chunk:
            return
        self.scan_tail = (self.scan_tail + chunk)[-8192:]
        if self._head_len < self._head_max:
            take = min(len(chunk), self._head_max - self._head_len)
            self._head.append(chunk[:take])
            self._head_len += take
            chunk = chunk[take:]
        if chunk:
            self._tail += chunk
            if len(self._tail) > self._tail_max:
                self.dropped += len(self._tail) - self._tail_max
                self._tail = self._tail[-self._tail_max :]

    def text(self) -> str:
        head = "".join(self._head)
        if not self.dropped:
            return head + self._tail
        notice = (
            f"\n[vinv-transport: {self.dropped} characters of mid-stream output "
            "exceeded the in-memory capture ceiling and were not retained inline. "
            "Head and tail are preserved above/below. To keep EVERYTHING, re-run "
            "with output redirected to a file (cmd > /tmp/out.log 2>&1) and "
            "inspect it with grep/tail.]\n"
        )
        return head + notice + self._tail


def _shell_is_busy(_pty: Any) -> Optional[bool]:
    """Does a foreground job (not the shell) own the terminal right now?

    Signal-free check via ``tcgetpgrp`` on the PTY master: when bash sits at a
    prompt the foreground process group is bash's own; while a job runs it is
    the job's. Returns None when undeterminable (closed fd, WSL shim).

    Transports without a PTY can supply their own oracle: the Windows shim
    (``WinShellChild.shell_is_busy``) answers the same tri-state question from
    the shell's OS child-process tree, and is preferred when present.
    """
    probe = getattr(_pty, "shell_is_busy", None)
    if callable(probe):
        try:
            return probe()
        except Exception:
            return None
    fd = getattr(_pty, "child_fd", None)
    pid = getattr(_pty, "pid", None)
    if fd is None or pid is None or not hasattr(os, "tcgetpgrp"):
        return None
    try:
        fg = os.tcgetpgrp(fd)
    except OSError:
        return None
    if fg <= 0:
        return None
    return fg != pid


def _foreground_pgid(_pty: Any) -> Optional[int]:
    fd = getattr(_pty, "child_fd", None)
    pid = getattr(_pty, "pid", None)
    if fd is None or pid is None or not hasattr(os, "tcgetpgrp"):
        return None
    try:
        fg = os.tcgetpgrp(fd)
    except OSError:
        return None
    if fg <= 0 or fg == pid:
        return None
    return fg


def _wrap_for_sentinel(keystrokes: str, token: str) -> tuple[str, Optional[str]]:
    """Build the control line that yields exact completion + exit code.

    Returns ``(line_to_send, temp_script_path_or_None)``.

    Simple single lines run inline in the interactive shell so ``cd`` /
    ``export`` persist across calls. Anything that could interfere with the
    appended sentinel (newlines, comments, trailing operators, very long
    lines) is written to a temp script executed by a **child** bash: inner
    ``set -e`` / ``exit`` / SIGPIPE / syntax errors then only affect the
    child, whose exit code still reaches the sentinel.
    """
    import shlex

    done = f"printf '\\n{token}:%s\\n' \"$?\""
    s = keystrokes.strip()
    if not s:
        return done, None

    inline_safe = (
        "\n" not in keystrokes
        and "\r" not in keystrokes
        and "#" not in s
        and len(keystrokes) <= _INLINE_COMMAND_MAX
        and not s.endswith(("\\", ";", "&&", "||", "|"))
    )
    if inline_safe:
        if s.endswith("&"):
            # `cmd &; printf` is a syntax error; `cmd & printf` fires the
            # sentinel immediately after backgrounding — which is correct.
            return f"{keystrokes} {done}", None
        return f"{keystrokes}; {done}", None

    fd, path = tempfile.mkstemp(prefix="vinv_cmd_", suffix=".sh")
    with os.fdopen(fd, "w", encoding="utf-8", errors="replace") as f:
        f.write(keystrokes)
        if not keystrokes.endswith("\n"):
            f.write("\n")
    q = shlex.quote(path)
    line = f"bash {q}; __vinv_rc=$?; rm -f {q}; printf '\\n{token}:%s\\n' \"$__vinv_rc\""
    return line, path


_TOKEN_RE_TEMPLATE = r"{token}:(\d+)"


def _strip_sentinel(text: str, token: str) -> str:
    return re.sub(rf"\r?\n?{re.escape(token)}:\d+\r?\n?", "", text)


def _run_blocking(
    _pty: Any, pexpect: Any, keystrokes: str, duration: float
) -> tuple[str, Optional[int], str]:
    """Run a command to exact completion (sentinel), bounded by ``duration``.

    Returns ``(output, exit_code, state)`` where state is:
      * ``"completed"``   — sentinel seen; exit_code is the command's.
      * ``"interrupted"`` — overran the budget; foreground job was stopped and
        the shell verified back at a prompt (session healthy).
      * ``"wedged"``      — could not reclaim the shell; caller must replace
        the session.

    Raises ``_TransportDead`` (with partial output) if the fd dies mid-run.
    """
    token = f"{_SENTINEL_PREFIX}{uuid.uuid4().hex}"
    line, _script = _wrap_for_sentinel(keystrokes, token)
    token_re = re.compile(_TOKEN_RE_TEMPLATE.format(token=re.escape(token)))

    col = _Collector()
    budget = max(duration, _MIN_BLOCK_BUDGET)
    deadline = time.monotonic() + budget

    try:
        _pty.sendline(line)
    except Exception as e:
        raise _TransportDead("", e) from e

    while True:
        try:
            chunk = _read_new_output(_pty, pexpect, wait=0.25)
        except Exception as e:
            raise _TransportDead(_strip_sentinel(col.text(), token), e) from e
        col.add(chunk)
        m = token_re.search(col.scan_tail)
        if m:
            return _strip_sentinel(col.text(), token), int(m.group(1)), "completed"
        if time.monotonic() >= deadline:
            break

    # Budget exhausted: the command is still holding the shell foreground. If
    # we simply returned, the *next* command's keystrokes would queue behind it
    # and the whole session would deadlock — so reclaim the terminal now,
    # escalating only as far as the job forces us to.
    state = _recover_foreground(_pty, pexpect, col, token_re)
    if state == "completed":
        m = token_re.search(col.scan_tail)
        code = int(m.group(1)) if m else None
        return _strip_sentinel(col.text(), token), code, "interrupted"
    return _strip_sentinel(col.text(), token), None, state


def _recover_foreground(
    _pty: Any, pexpect: Any, col: _Collector, token_re: re.Pattern[str]
) -> str:
    """Escalate SIGINT → SIGINT → SIGTERM → SIGKILL until the shell owns the
    terminal again, verifying (not assuming) after each step.

    Verification is the ``tcgetpgrp`` check where available; on transports
    without it (Windows shim) a quiet-stream heuristic is the fallback. Grace
    windows escalate with the severity of the signal rather than using one
    fixed timeout. Returns ``"completed"`` (sentinel arrived after the
    interrupt), ``"interrupted"`` (shell verified back at a prompt) or
    ``"wedged"``.
    """
    steps: list[tuple[str, float]] = [("int", 1.0), ("int", 2.0), ("term", 3.0), ("kill", 4.0)]
    for kind, base_grace in steps:
        grace = base_grace * _RECOVERY_GRACE_SCALE
        try:
            if kind == "int":
                _pty.sendintr()
            else:
                pg = _foreground_pgid(_pty)
                if pg is not None:
                    os.killpg(pg, signal.SIGTERM if kind == "term" else signal.SIGKILL)
                else:
                    # No PTY process group (Windows shim): terminate the job's
                    # process tree directly when the transport can, otherwise
                    # retry SIGINT as the last resort.
                    killer = getattr(_pty, "kill_foreground", None)
                    if not (callable(killer) and killer(force=(kind == "kill"))):
                        _pty.sendintr()
        except Exception:
            break

        deadline = time.monotonic() + grace
        last_data = time.monotonic()
        while time.monotonic() < deadline:
            try:
                chunk = _read_new_output(_pty, pexpect, wait=0.15)
            except Exception:
                return "wedged"
            if chunk:
                col.add(chunk)
                last_data = time.monotonic()
            if token_re.search(col.scan_tail):
                return "completed"
            busy = _shell_is_busy(_pty)
            if busy is False:
                return "interrupted"
            if busy is None and time.monotonic() - last_data >= max(0.2, _RECOVERY_GRACE_SCALE):
                # No busy oracle: a full second of silence after the signal is
                # the best available evidence the job is gone.
                return "interrupted"
    return "wedged"


def initialize_terminal(
    session_name: Optional[str],
    working_directory: Optional[str],
    shell: str,
) -> dict[str, Any]:
    session_name = session_name or st._default_session_name
    cwd = working_directory or st._default_working_directory()
    logger.info("🖥️ Initializing terminal: session_name=%s", session_name)

    if not st.PEXPECT_AVAILABLE:
        return {
            "status": "error",
            "error": "pexpect not available. Install with: pip install pexpect",
            "session_id": None,
        }

    iid = st.get_current_terminal_instance_id()
    _pexpect_key = iid
    if st.pexpect_sessions_contains(_pexpect_key):
        existing = st.pexpect_sessions_get(_pexpect_key)
        try:
            if getattr(existing, "isalive", lambda: False)():
                st.set_terminal_session_ref(existing)
                logger.info("🖥️ Reusing pexpect PTY for instance=%s", _pexpect_key)
                return {
                    "status": "success",
                    "session_name": session_name,
                    "is_alive": True,
                    "working_directory": cwd,
                    "shell": shell,
                    "pid": getattr(existing, "pid", None),
                    "transport": "pexpect",
                }
        except Exception:
            st.pexpect_sessions_del(_pexpect_key)

    assert st.pexpect is not None, "pexpect required when PEXPECT_AVAILABLE"
    pexpect = st.pexpect
    try:
        child_env = os.environ.copy()
        if IS_WINDOWS:
            # pexpect.spawn does not exist on win32. Drive a real bash (Git for
            # Windows / WSL) through the subprocess-backed shim; the shell string
            # (default "/bin/bash") is resolved to a concrete bash.exe.
            from core.components.tools.terminal.backends.win_shell_child import (
                WinShellChild,
                resolve_windows_shell,
            )

            resolved_shell = resolve_windows_shell(shell)
            if not resolved_shell:
                return {
                    "status": "error",
                    "error": (
                        "No bash found on Windows. Install Git for Windows "
                        "(https://git-scm.com/download/win) or enable WSL so a "
                        "POSIX shell is available for the terminal backend."
                    ),
                    "session_id": None,
                }
            new_session = WinShellChild(resolved_shell, cwd=cwd, env=cast(Any, child_env))
        else:
            new_session = pexpect.spawn(
                shell,
                cwd=cwd,
                echo=False,
                encoding="utf-8",
                timeout=30,
                env=cast(Any, child_env),
            )

        # Health probe: verify the shell actually executes commands before
        # declaring the session usable (replaces a blind startup sleep). Also
        # consumes any rc-file banner so the first real command starts clean.
        if not _probe_shell_ready(new_session, pexpect, timeout=10.0):
            try:
                new_session.close(force=True)
            except Exception:
                pass
            return {
                "status": "error",
                "error": "Terminal session spawned but the shell did not respond to a probe command",
                "session_id": None,
            }

        st.pexpect_sessions_set(_pexpect_key, new_session)
        st.set_terminal_session_ref(new_session)
        logger.info("✅ Terminal initialized (pexpect): session=%s, instance=%s", session_name, _pexpect_key)
        return {
            "status": "success",
            "session_name": session_name,
            "is_alive": True,
            "working_directory": cwd,
            "shell": shell,
            "pid": new_session.pid if hasattr(new_session, "pid") else None,
            "transport": "pexpect",
        }
    except Exception as e:
        logger.error("❌ Terminal initialization failed: %s", e)
        return {"status": "error", "error": f"Failed to initialize terminal: {e}", "session_id": None}


def _probe_shell_ready(_pty: Any, pexpect: Any, timeout: float) -> bool:
    """Confirm the freshly spawned shell responds to a real command."""
    token = f"{_SENTINEL_PREFIX}{uuid.uuid4().hex}"
    try:
        _pty.sendline(f"printf '\\n{token}:%s\\n' ready")
    except Exception:
        return False
    seen = ""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            seen = (seen + _read_new_output(_pty, pexpect, wait=0.2))[-4096:]
        except Exception:
            return False
        if f"{token}:ready" in seen:
            return True
        try:
            if not _pty.isalive():
                return False
        except Exception:
            return False
    return False


def close_terminal() -> dict[str, Any]:
    logger.info("🖥️ Closing terminal session (pexpect)")
    iid = st.get_current_terminal_instance_id()

    if st.get_terminal_session() is None:
        return {"status": "success", "message": "No terminal session to close"}

    if st.get_terminal_session() == "electron_pty":
        return {"status": "success", "message": "No pexpect session (electron marker)"}

    with st.session_lock(iid):
        _session = st.pexpect_sessions_pop(iid, None) or st.get_terminal_session()
        if _session is not None and not isinstance(_session, str) and hasattr(_session, "close"):
            try:
                _session.close(force=True)
            except Exception as e:
                logger.error("❌ Error closing terminal: %s", e)
                return {"status": "error", "error": f"Error closing terminal: {e}"}
        if not st.pexpect_sessions_non_empty():
            st.set_terminal_session_ref(None)
    logger.info("✅ Terminal session closed (instance=%s)", iid)
    return {"status": "success", "message": f"Terminal session closed (instance={iid})"}


def _broadcast(keystrokes: str, output: str) -> None:
    tev.broadcast_terminal_event_sync("command", {"command": keystrokes})
    if output:
        tev.broadcast_terminal_event_sync("output", {"output": output[:_BROADCAST_CAP]})


def send_terminal_command(keystrokes: str, duration: float, block: bool) -> dict[str, Any]:
    iid = st.get_current_terminal_instance_id()
    pexpect = st.pexpect
    if pexpect is None:
        return {"status": "error", "command": keystrokes, "output": "", "error": "No pexpect session"}

    with st.session_lock(iid):
        _pty = st._resolve_pexpect_child(iid)
        if _pty is None:
            return {"status": "error", "command": keystrokes, "output": "", "error": "No pexpect session"}

        try:
            if block:
                return _send_blocking_locked(_pty, pexpect, iid, keystrokes, duration)

            # Raw keystroke mode: may be input to a running program, a daemon
            # launch, or a control char — send verbatim, settle on quiet.
            _pty.sendline(keystrokes)
            output = _collect_idle(_pty, pexpect, duration)
            _broadcast(keystrokes, output)
            return {
                "status": "success",
                "command": keystrokes,
                "output": output,
                "error": None,
                "completed": None,
                "exit_code": None,
            }
        except _TransportDead as td:
            return _handle_dead_transport(iid, _pty, keystrokes, td.partial_output, td.cause)
        except Exception as e:
            if st._pexpect_fd_is_dead(e):
                return _handle_dead_transport(iid, _pty, keystrokes, "", e)
            logger.error("❌ send_terminal_command error: %s", e)
            return {"status": "error", "command": keystrokes, "output": "", "error": str(e)}


def _send_blocking_locked(
    _pty: Any, pexpect: Any, iid: str, keystrokes: str, duration: float
) -> dict[str, Any]:
    # A foreground job from a previous command still owns the terminal: typing
    # a new command now would feed IT our keystrokes (or queue them behind it)
    # and wedge the session. Refuse honestly instead — nothing is killed.
    if _shell_is_busy(_pty) is True:
        pending = ""
        try:
            pending = _read_new_output(_pty, pexpect, wait=0.1)
        except Exception:
            pass
        return {
            "status": "error",
            "command": keystrokes,
            "output": pending,
            "error": (
                "terminal_busy: a foreground process from a previous command is still "
                "running in this session, so a new blocking command cannot start. "
                "Options: poll it with get_incremental_output; send input/Ctrl-C "
                "keystrokes with block=False; or initialize_terminal(session_name=...) "
                "to work in a parallel session."
            ),
            "completed": False,
            "exit_code": None,
        }

    output, exit_code, state = _run_blocking(_pty, pexpect, keystrokes, duration)
    _broadcast(keystrokes, output)

    if state == "completed":
        logger.info("✅ send_terminal_command completed: exit=%s output_length=%s", exit_code, len(output))
        return {
            "status": "success",
            "command": keystrokes,
            "output": output,
            "error": None,
            "completed": True,
            "exit_code": exit_code,
        }

    budget = max(duration, _MIN_BLOCK_BUDGET)
    if state == "interrupted":
        logger.warning("⏱️ send_terminal_command overran %.0fs budget; foreground job stopped", budget)
        return {
            "status": "timeout",
            "command": keystrokes,
            "output": output,
            "error": (
                f"Command exceeded its {budget:.0f}s budget and was interrupted; the "
                "session is back at a clean prompt. Partial output is included "
                f"(exit_code={exit_code}). If the command legitimately needs longer, "
                "re-run it with a larger duration, or redirect to a log file "
                "(cmd > /tmp/out.log 2>&1 &) and poll the log."
            ),
            "completed": False,
            "exit_code": exit_code,
        }

    # Wedged: the shell never reclaimed the terminal. Replace the session so
    # the NEXT command has a working shell — but never re-run this one.
    logger.error("💀 terminal wedged after escalated interrupts; replacing PTY session")
    st._drop_pexpect_session(iid, dead=_pty)
    init_result = initialize_terminal(None, st._default_working_directory(), "/bin/bash")
    reinit_ok = init_result.get("status") == "success"
    return {
        "status": "timeout",
        "command": keystrokes,
        "output": output,
        "error": (
            f"Command exceeded its {budget:.0f}s budget and could not be interrupted "
            "(SIGINT/SIGTERM/SIGKILL escalation failed to free the shell). The "
            f"terminal session was {'replaced with a fresh shell' if reinit_ok else 'closed but could NOT be reinitialized'}. "
            "The command was NOT re-run — verify its side effects before retrying, "
            "and prefer redirecting long output to a log file."
        ),
        "completed": False,
        "exit_code": None,
        "session_reinitialized": reinit_ok,
    }


def _handle_dead_transport(
    iid: str, _pty: Any, keystrokes: str, partial_output: str, cause: BaseException
) -> dict[str, Any]:
    """The PTY fd died (EOF/EIO/EBADF). Replace the session; never auto-retry."""
    logger.warning("pexpect PTY died mid-command (%s); replacing session (no auto-retry)", cause)
    st._drop_pexpect_session(iid, dead=_pty)
    init_result = initialize_terminal(None, st._default_working_directory(), "/bin/bash")
    reinit_ok = init_result.get("status") == "success"
    return {
        "status": "error",
        "command": keystrokes,
        "output": partial_output,
        "error": (
            f"Terminal PTY died while the command was running ({cause}). A fresh shell "
            f"was {'started' if reinit_ok else 'attempted but could not be started'}; "
            "the command was NOT re-run automatically. Any in-shell state (cwd, env "
            "vars, background jobs) was lost — verify side effects before re-issuing."
        ),
        "completed": False,
        "exit_code": None,
        "session_reinitialized": reinit_ok,
    }


def _collect_idle(_pty: Any, pexpect: Any, duration: float) -> str:
    """block=False capture: gather output until it goes quiet, bounded by duration."""
    deadline = time.monotonic() + max(0.0, duration)
    col = _Collector()
    last_data = time.monotonic()
    while True:
        chunk = _read_new_output(_pty, pexpect, wait=0.1)
        now = time.monotonic()
        if chunk:
            col.add(chunk)
            last_data = now
        elif now - last_data >= _IDLE_SETTLE_NONBLOCK:
            break
        if now >= deadline:
            break
    return col.text()


def get_terminal_state(_capture_entire: bool) -> dict[str, Any]:
    pexpect = st.pexpect
    if pexpect is None:
        return {"status": "error", "output": "", "is_alive": False, "error": "No pexpect session"}
    iid = st.get_current_terminal_instance_id()
    ts = st.get_terminal_session()
    if isinstance(ts, str):
        return {
            "status": "error",
            "output": "",
            "is_alive": False,
            "error": f"Terminal session is a string '{ts}', not a pexpect object",
        }
    with st.session_lock(iid):
        _pty = st._resolve_pexpect_child(iid)
        if _pty is None:
            return {"status": "error", "output": "", "is_alive": False, "error": "No pexpect session"}
        try:
            col = _Collector()
            col.add(_read_new_output(_pty, pexpect, wait=0.1))
            is_alive = _pty.isalive()
            return {"status": "success", "output": col.text(), "is_alive": is_alive, "error": None}
        except Exception as e:
            logger.error("❌ get_terminal_state error: %s", e)
            return {"status": "error", "output": "", "is_alive": False, "error": str(e)}


def get_incremental_output() -> dict[str, Any]:
    pexpect = st.pexpect
    if pexpect is None:
        return {"status": "error", "output": "", "error": "No pexpect session"}
    iid = st.get_current_terminal_instance_id()
    ts = st.get_terminal_session()
    if isinstance(ts, str):
        return {
            "status": "error",
            "output": "",
            "error": f"Terminal session is a string '{ts}', not a pexpect object",
        }
    with st.session_lock(iid):
        _pty = st._resolve_pexpect_child(iid)
        if _pty is None:
            return {"status": "error", "output": "", "error": "No pexpect session"}
        try:
            col = _Collector()
            col.add(_read_new_output(_pty, pexpect, wait=0.1))
            return {"status": "success", "output": col.text(), "error": None}
        except Exception as e:
            logger.error("❌ get_incremental_output error: %s", e)
            return {"status": "error", "output": "", "error": str(e)}
