"""Windows shell child — a pexpect-``spawn``-compatible transport for win32.

``pexpect.spawn`` is POSIX-only: it drives the child through a ``pty`` (termios,
os.fork), none of which exist on Windows. The rest of the pexpect terminal
backend (``python_pexpect_backend``) only ever uses a small slice of the spawn
API — ``sendline`` / ``expect`` / ``before`` / ``buffer`` / ``isalive`` /
``sendintr`` / ``close`` / ``pid`` — and matches completion with a ``$?`` shell
sentinel rather than a real TTY prompt. That slice is reproducible on Windows
with an ordinary ``subprocess.Popen`` plus a background reader thread, so this
class implements exactly that slice and nothing more.

The shell we drive is **bash** (Git-for-Windows or WSL), not ``cmd.exe``: the
bring-up / handbook agent prompts emit POSIX commands (``source .venv/bin/
activate``, ``uv venv``, ``$?``), so the sentinel/idle logic in the backend —
and the commands themselves — stay valid unchanged. bash reading from a pipe
runs each line as a script (no TTY echo, no prompt written to stdout), which is
precisely what the ``echo=False`` spawn assumed on POSIX.

Only the exception *types* are borrowed from pexpect (``TIMEOUT`` / ``EOF``);
``import pexpect`` succeeds on Windows (it just doesn't expose ``spawn``), so the
backend's ``except pexpect.TIMEOUT`` clauses catch what ``expect`` raises here.
"""

from __future__ import annotations

import codecs
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

# pexpect imports cleanly on Windows — only spawn/run are gated behind posix — so
# its sentinel exception classes are available to raise from expect().
try:
    from pexpect import EOF as _PEXPECT_EOF  # type: ignore[reportMissingImports]
    from pexpect import TIMEOUT as _PEXPECT_TIMEOUT  # type: ignore[reportMissingImports]
except Exception:  # pragma: no cover - pexpect always present in the build venv
    class _PEXPECT_TIMEOUT(Exception):  # type: ignore[no-redef]
        pass

    class _PEXPECT_EOF(Exception):  # type: ignore[no-redef]
        pass


# Common Git-for-Windows install locations, tried after PATH lookup. The
# ``usr\bin`` images come first: ``<git>\bin\bash.exe`` is only a launcher shim
# that re-execs the real bash as a *child* (see _prefer_real_bash). WSL's
# System32\bash.exe is deliberately *last*: it launches a Linux VM whose
# filesystem/PATH differ from the Windows project checkout, so it is a poor
# match for driving a repo living on C:\ and is only a final fallback.
_BASH_CANDIDATES = (
    r"C:\Program Files\Git\usr\bin\bash.exe",
    r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
)


def _prefer_real_bash(path: str) -> str:
    """Map Git-for-Windows' ``<git>\\bin\\bash.exe`` launcher to the real bash.

    ``<git>\\bin\\bash.exe`` is a ~46KB shim that spawns ``<git>\\usr\\bin\\
    bash.exe`` as a child and proxies stdio to it. Driving the shim breaks the
    two places we rely on the shell being the process we spawned:

    * ``shell_is_busy`` reads the job object and asks whether any member is not
      ``self.pid``. Under the shim the real bash is always a second member, so
      the oracle answers "busy" forever — every blocking command is refused
      with ``terminal_busy`` even against a shell idling at its read loop.
    * ``kill_foreground`` terminates every job member except ``self.pid``,
      which under the shim would kill the real bash — the session itself.

    Both stay correct when we spawn the real image directly, so normalise to the
    ``usr\\bin`` sibling whenever it exists. Any other path is returned as-is.
    """
    head, tail = os.path.split(path)
    if tail.lower() != "bash.exe" or os.path.basename(head).lower() != "bin":
        return path
    real = os.path.join(os.path.dirname(head), "usr", "bin", tail)
    return real if os.path.isfile(real) else path


def _msys_bin_dirs(shell_path: str) -> list:
    """The MSYS runtime dirs a ``<git>\\usr\\bin\\bash.exe`` needs on PATH.

    Empty for anything that is not a Git-for-Windows ``usr\\bin`` bash.
    """
    head, tail = os.path.split(shell_path)
    if tail.lower() != "bash.exe" or os.path.basename(head).lower() != "bin":
        return []
    usr = os.path.dirname(head)  # <git>\usr
    if os.path.basename(usr).lower() != "usr":
        return []
    git_root = os.path.dirname(usr)
    # <git>\usr\bin holds coreutils (cat/head/sleep/grep); Git Bash also exports
    # the mingw toolchain bin, so mirror both.
    dirs = [head, os.path.join(git_root, "mingw64", "bin"), os.path.join(git_root, "mingw32", "bin")]
    return [d for d in dirs if os.path.isdir(d)]


def apply_msys_env(shell_path: str, env: Optional[dict] = None) -> Optional[dict]:
    """Give a directly-spawned Git bash the PATH the ``bin`` launcher would set.

    The launcher we bypass in ``_prefer_real_bash`` does more than re-exec: it
    installs the MSYS environment. Spawning ``usr\\bin\\bash.exe`` straight from
    a native-Windows parent inherits only the Windows PATH, so bash starts with
    *no coreutils* — ``cat``/``head``/``grep``/``sleep`` all fail "command not
    found" — and every agent command that isn't a shell builtin dies. Prepending
    the MSYS bin dirs restores them without reintroducing the launcher process.

    Returns ``env`` untouched for non-MSYS shells (WSL, an explicit bash).
    """
    dirs = _msys_bin_dirs(shell_path)
    if not dirs:
        return env
    resolved = dict(env) if env is not None else os.environ.copy()
    current = resolved.get("PATH", "")
    have = {p.lower() for p in current.split(os.pathsep) if p}
    missing = [d for d in dirs if d.lower() not in have]
    if missing:
        resolved["PATH"] = os.pathsep.join(missing + ([current] if current else []))
    return resolved


def resolve_windows_shell(shell: Optional[str]) -> Optional[str]:
    """Map a POSIX-ish ``shell`` request to a concrete bash.exe on Windows.

    ``initialize_terminal`` defaults ``shell`` to ``/bin/bash``; that path does
    not exist on Windows, so translate it (and a bare ``bash``) to the first
    real bash we can find. An absolute Windows path that already exists is
    honoured as-is. Returns ``None`` when no bash is available, letting the
    caller surface a clear "install Git for Windows" error instead of failing
    deep inside Popen.
    """
    if shell:
        s = shell.strip()
        # An explicit, existing Windows path (e.g. a caller-provided bash).
        if os.path.isabs(s) and s.lower().endswith(".exe") and os.path.isfile(s):
            return _prefer_real_bash(s)
        # Anything that isn't a bash request: only bash gives us POSIX + $?.
        base = os.path.basename(s).lower()
        if base not in ("bash", "bash.exe", "sh", "sh.exe", ""):
            # Non-bash shell explicitly requested; try to honour if on PATH.
            found = shutil.which(s)
            if found:
                return found
    # PATH lookup for bash, then the well-known install dirs.
    for name in ("bash", "bash.exe"):
        found = shutil.which(name)
        if found and "system32" not in found.lower():
            return _prefer_real_bash(found)
    for cand in _BASH_CANDIDATES:
        if os.path.isfile(cand):
            return _prefer_real_bash(cand)
    # Last resort: WSL bash if present (works, but crosses into the Linux VM).
    wsl = shutil.which("bash")
    return wsl


class WinShellChild:
    """Minimal ``pexpect.spawn`` stand-in backed by ``subprocess`` on Windows.

    Implements only the surface the pexpect terminal backend touches. A daemon
    thread reads the child's merged stdout/stderr into a queue; ``expect``
    drains that queue into ``self.buffer`` and matches against it, mirroring
    pexpect's ``before`` / ``buffer`` semantics so the existing sentinel and
    idle-settle logic works without modification.
    """

    # pexpect exposes these as class attributes; a couple of call sites reference
    # ``child.TIMEOUT`` style, and exposing them keeps parity.
    TIMEOUT = _PEXPECT_TIMEOUT
    EOF = _PEXPECT_EOF

    def __init__(
        self,
        shell_path: str,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
    ) -> None:
        self.before: str = ""
        self.after: Any = ""
        self.buffer: str = ""
        self._q: "queue.Queue[bytes]" = queue.Queue()
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._alive = True

        # A new process group lets us deliver CTRL_BREAK for sendintr() without
        # signalling our own process. bash reads commands from the stdin pipe as
        # a non-interactive script: no prompt, no input echo — matching the
        # POSIX spawn(echo=False) contract the backend relies on.
        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]

        self.proc = subprocess.Popen(
            [shell_path],
            cwd=cwd or None,
            env=apply_msys_env(shell_path, env),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
            creationflags=creationflags,
        )
        self.pid = self.proc.pid
        # Busy oracle: assign the shell to a Win32 Job Object at spawn. MSYS
        # bash "forks" through short-lived intermediates, so Toolhelp parent
        # chains break (children reparent to dead pids) — but job membership is
        # inherited unconditionally, so QueryInformationJobObject always sees
        # the full descendant set. WSL's System32 bash proxies into a Linux VM
        # whose processes never appear in the job — no oracle there.
        self._job = None
        if "system32" not in shell_path.lower():
            self._job = self._make_job()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _make_job(self):
        """Create a job object holding the shell (and thus its descendants)."""
        if sys.platform != "win32":
            return None
        try:
            import ctypes

            k32 = ctypes.windll.kernel32
            job = k32.CreateJobObjectW(None, None)
            if not job:
                return None
            if not k32.AssignProcessToJobObject(job, int(self.proc._handle)):  # type: ignore[attr-defined]
                k32.CloseHandle(job)
                return None
            return job
        except Exception:
            return None

    # -- reader thread ------------------------------------------------------
    def _read_loop(self) -> None:
        stdout = self.proc.stdout
        assert stdout is not None
        try:
            while True:
                chunk = stdout.read(4096)
                if not chunk:
                    break  # EOF: shell exited
                self._q.put(chunk)
        except Exception:  # pragma: no cover - pipe torn down on close
            pass
        finally:
            self._alive = False

    def _drain(self) -> None:
        """Move any bytes the reader captured into the decoded text buffer."""
        got = False
        while True:
            try:
                chunk = self._q.get_nowait()
            except queue.Empty:
                break
            self.buffer += self._decoder.decode(chunk)
            got = True
        if not got and not self._alive:
            # Flush any trailing partial multibyte sequence on shutdown.
            self.buffer += self._decoder.decode(b"", final=True)

    # -- pexpect-compatible surface ----------------------------------------
    def expect(self, pattern: Any, timeout: float = 30.0) -> int:
        """Match ``pattern`` against streamed output, pexpect-style.

        ``pattern is TIMEOUT`` means "collect output for ``timeout`` seconds,
        never raise" (used by the idle-poller). A regex string is searched for
        until found (``before`` = text before the match, the match is consumed
        from ``buffer``) or ``timeout`` elapses, which raises ``pexpect.TIMEOUT``
        exactly like the real spawn. EOF while waiting raises ``pexpect.EOF``.
        """
        deadline = time.monotonic() + max(0.0, timeout)
        want_timeout = pattern is _PEXPECT_TIMEOUT or pattern is self.TIMEOUT
        regex = None if want_timeout else re.compile(pattern)
        while True:
            self._drain()
            if regex is not None:
                m = regex.search(self.buffer)
                if m:
                    self.before = self.buffer[: m.start()]
                    self.after = self.buffer[m.start() : m.end()]
                    self.buffer = self.buffer[m.end() :]
                    return 0
            now = time.monotonic()
            if now >= deadline:
                if want_timeout:
                    # The awaited outcome: hand back everything accumulated.
                    self.before = self.buffer
                    return 0
                raise _PEXPECT_TIMEOUT("timeout waiting for pattern")
            if not self._alive and self._q.empty():
                self._drain()
                if want_timeout:
                    self.before = self.buffer
                    return 0
                raise _PEXPECT_EOF("shell exited before pattern matched")
            time.sleep(0.02)

    def read_nonblocking(self, size: int = 65536, timeout: float = 0.0) -> str:
        """pexpect-parity incremental read: newly-arrived output, consumed once.

        Blocks up to ``timeout`` seconds for the first data, raises
        ``pexpect.TIMEOUT`` when nothing arrives and ``pexpect.EOF`` once the
        shell has exited and the stream is drained. Any text a legacy
        ``expect()`` call left in ``self.buffer`` is served first so the two
        APIs never lose data between them.
        """
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            self._drain()
            if self.buffer:
                out, self.buffer = self.buffer[:size], self.buffer[size:]
                return out
            if not self._alive and self._q.empty():
                raise _PEXPECT_EOF("shell exited (End Of File (EOF))")
            if time.monotonic() >= deadline:
                raise _PEXPECT_TIMEOUT("no new output")
            time.sleep(0.02)

    def sendline(self, s: str = "") -> None:
        self.send(s + "\n")

    def send(self, s: str) -> None:
        stdin = self.proc.stdin
        if stdin is None:
            raise OSError("stdin closed")
        try:
            stdin.write(s.encode("utf-8", errors="replace"))
            stdin.flush()
        except (OSError, ValueError) as e:
            # Broken pipe: shell is gone. Surface as EOF so the backend's
            # dead-fd detection drops and reinitialises the session.
            raise OSError(f"bad file descriptor: {e}") from e

    def sendintr(self) -> None:
        """Interrupt the running foreground command — without killing bash.

        POSIX SIGINT-to-foreground has no safe analogue on this transport:
        CTRL_BREAK_EVENT targets the whole process group INCLUDING the
        non-interactive bash itself, which (per POSIX) does not ignore SIGINT
        and dies — taking the session with it. And a ^C byte written to the
        stdin pipe is literal input, not a signal. Terminating the foreground
        job's processes via the job object gives the same observable outcome
        as Ctrl-C: the job dies (STATUS_CONTROL_C_EXIT), bash survives at its
        read loop and continues the wrapped command line, so the completion
        sentinel still fires with the job's failure code.
        """
        try:
            self.kill_foreground(force=False)
        except Exception:
            pass

    # -- busy oracle / foreground control ------------------------------------
    # POSIX pexpect answers "is a foreground job running?" via tcgetpgrp on the
    # PTY. There is no PTY here, but the job object provides equivalent ground
    # truth: every process the shell spawns (including MSYS fork intermediates
    # and their re-parented orphans, which break Toolhelp ancestry chains)
    # inherits membership in ``self._job``, so "job holds any pid besides the
    # shell" == "a foreground job is running".

    def _job_pids(self) -> Optional[list]:
        """All live pids in the shell's job object, or None if unqueryable."""
        if sys.platform != "win32" or self._job is None:
            return None
        try:
            import ctypes
            import ctypes.wintypes as wt

            JobObjectBasicProcessIdList = 3

            def make_struct(capacity: int):
                class _IDLIST(ctypes.Structure):
                    _fields_ = [
                        ("NumberOfAssignedProcesses", wt.DWORD),
                        ("NumberOfProcessIdsInList", wt.DWORD),
                        ("ProcessIdList", ctypes.c_size_t * capacity),
                    ]

                return _IDLIST()

            k32 = ctypes.windll.kernel32
            cap = 64
            for _ in range(4):
                info = make_struct(cap)
                if k32.QueryInformationJobObject(
                    self._job, JobObjectBasicProcessIdList,
                    ctypes.byref(info), ctypes.sizeof(info), None,
                ):
                    return [int(p) for p in info.ProcessIdList[: info.NumberOfProcessIdsInList]]
                cap *= 4  # ERROR_MORE_DATA: grow and retry
            return None
        except Exception:
            return None

    def shell_is_busy(self) -> Optional[bool]:
        """Tri-state busy oracle mirroring the POSIX tcgetpgrp contract.

        True — a foreground job (process beyond the shell) is running.
        False — the shell is idle at its read loop.
        None — undeterminable (WSL bash, no job object, shell dead).
        """
        if not self.isalive():
            return None
        pids = self._job_pids()
        if pids is None:
            return None
        return any(p != self.pid for p in pids)

    def kill_foreground(self, force: bool = False) -> bool:
        """Terminate the foreground job's processes, sparing the shell.

        The POSIX escalation path signals the job's process group (killpg);
        here we terminate every job-object member except the shell itself.
        Returns True if anything was signalled.
        """
        pids = self._job_pids()
        if not pids:
            return False
        try:
            import ctypes

            k32 = ctypes.windll.kernel32
            PROCESS_TERMINATE = 0x0001
            # STATUS_CONTROL_C_EXIT: MSYS translates this to death-by-SIGINT,
            # so bash reports the familiar Ctrl-C exit status for the job.
            STATUS_CONTROL_C_EXIT = 0xC000013A
            hit = False
            for pid in pids:
                if pid == self.pid:
                    continue
                h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
                if h:
                    try:
                        if k32.TerminateProcess(h, STATUS_CONTROL_C_EXIT):
                            hit = True
                    finally:
                        k32.CloseHandle(h)
            return hit
        except Exception:
            return False

    def isalive(self) -> bool:
        return self.proc.poll() is None

    def close(self, force: bool = True) -> None:
        try:
            if self.proc.stdin is not None:
                try:
                    self.proc.stdin.close()
                except Exception:
                    pass
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3)
                except Exception:
                    if force:
                        self.proc.kill()
        finally:
            self._alive = False
            if getattr(self, "_job", None):
                try:
                    import ctypes

                    ctypes.windll.kernel32.CloseHandle(self._job)
                except Exception:
                    pass
                self._job = None
