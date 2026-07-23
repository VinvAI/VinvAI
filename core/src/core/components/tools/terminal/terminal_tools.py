"""
Terminal interaction tools for Vinv Engine Swarm Agents.

**Transport order (functional, not env-gated for tier 1):**

1. **Primary Vinv Engine Electron** — stdout ``_terminal_ipc``; stdin acks via ``run.py`` runtime reader
   (``enable_runtime_terminal_ipc_feed``) or legacy ``VINV_ENGINE_ELECTRON_PTY``. Short probe when neither
   applies (e.g. e2e FastAPI) so tier 2 is reachable without a long IPC wait.
2. **E2E Electron shell** — ``E2E_TERMINAL_BRIDGE_URL`` (or derived port in e2e backend).
3. **Python pexpect** — in-process fallback.

Backends: ``electron_backend``, ``e2e_ws_backend``, ``python_pexpect_backend``.
"""

from __future__ import annotations

import logging
import os
import sys
import hashlib
from typing import Any, Optional

from core.components.tools.terminal import backend_resolver as _br
from core.components.tools.terminal import session_state as st
from core.components.tools.terminal import terminal_events as tev
from core.components.tools.terminal.backends import e2e_ws_backend, electron_backend, python_pexpect_backend
from core.components.tools.terminal.ipc_transport import (
    _is_electron_ipc_available,
    feed_ipc_response,
    is_terminal_host_owned,
    legacy_vinv_engine_electron_pty_env,
    terminal_stdin_acks_via_runtime,
)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logger.propagate = True
# No StreamHandler here: rely on uvicorn/root so cascade + transport lines share one pipeline.

# Backward compatibility: same dict object as session_state._pexpect_sessions
_pexpect_sessions = st._pexpect_sessions
_pexpect_fd_is_dead = st._pexpect_fd_is_dead
_current_terminal_instance_id = st._current_terminal_instance_id


def _e2e_bridge_url_log_fragment(url: str) -> str:
    """Log host/port only (no credentials in path/query if ever added)."""
    if not url:
        return "unset"
    try:
        from urllib.parse import urlparse

        p = urlparse(url)
        host = p.hostname or ""
        port = p.port
        if port is None and p.scheme == "ws":
            port = 80
        elif port is None and p.scheme == "wss":
            port = 443
        return f"{p.scheme}://{host}:{port}"
    except Exception:
        return "set (unparseable)"


def _primary_create_probe_timeout() -> float | None:
    """None = full ``terminal.ipc_create`` timeout. Short probe avoids blocking e2e-backend on tier 1."""
    if terminal_stdin_acks_via_runtime() or legacy_vinv_engine_electron_pty_env():
        return None
    return float(os.environ.get("VINV_ENGINE_TERMINAL_PRIMARY_PROBE_S", "0.45"))


def _using_e2e_ws_session() -> bool:
    return st.get_terminal_session() == "e2e_ws_pty"


def _active_transport_kind() -> str:
    """Which backend will handle commands for the current instance (post-init)."""
    iid = st.get_current_terminal_instance_id()
    if iid in st.get_electron_instances():
        return "e2e_ws" if _using_e2e_ws_session() else "primary_electron_ipc"
    ts = st.get_terminal_session()
    if ts is not None and not isinstance(ts, str):
        return "pexpect"
    return "none"


def _log_terminal_transport(where: str) -> None:
    """Always INFO: visible next to send/get lines even when ``initialize_terminal`` ran earlier."""
    logger.info(
        "terminal_transport [%s]: kind=%s instance_id=%s host_registry=%s e2e_bridge_env=%s runtime_feed=%s",
        where,
        _active_transport_kind(),
        st.get_current_terminal_instance_id(),
        st.get_current_terminal_instance_id() in st.get_electron_instances(),
        _e2e_bridge_url_log_fragment(_br.e2e_terminal_bridge_url()),
        terminal_stdin_acks_via_runtime(),
    )


def _bounded_output(result: dict[str, Any], label: str) -> dict[str, Any]:
    """Keep terminal observations bounded: log everything, ingest almost nothing.

    Every capture above the inline threshold is written IN FULL to an on-disk
    log artifact, and the model-facing ``output`` is replaced with a digest:
    head + tail + diagnostic (error/warning) lines + the artifact path + grep
    instructions. The agent then investigates failures with targeted
    ``grep``/``sed``/``tail`` commands against the log file instead of
    carrying megabytes of scrollback in its context.

    Small outputs pass through unchanged — nothing to gain from indirection.
    """
    output = result.get("output")
    if not isinstance(output, str) or not output:
        return result
    try:
        from core.components.context_compressor.token_utils import count_tokens
        threshold = int(os.environ.get(
            "VINV_ENGINE_TERMINAL_INLINE_OUTPUT_TOKENS", "4000"
        ))
        tokens = count_tokens(output)
        if tokens <= threshold:
            return result
        from core.components.context_compressor.log_artifact import (
            digest_with_artifact,
        )
        digest, path = digest_with_artifact(output, label, threshold)
        result = dict(result)
        result["output"] = digest
        result["output_log"] = path
        result["output_tokens_full"] = tokens
        logger.info(
            "terminal output bounded: %d tokens → digest (full log: %s)",
            tokens, path,
        )
    except Exception as exc:  # never break the tool over observability
        logger.warning("terminal output bounding failed: %s", exc)
    return result


def _auto_init_terminal_if_needed() -> dict[str, Any] | None:
    """Initialize via primary → E2E → pexpect when no host instance and no pexpect session."""
    iid = st.get_current_terminal_instance_id()
    if iid in st.get_electron_instances():
        return None
    ts = st.get_terminal_session()
    if ts is not None and not isinstance(ts, str):
        return None
    r = initialize_terminal()
    if r.get("status") != "success":
        return r
    return None


def _remote_send_command(keystrokes: str, duration: float, block: bool) -> dict[str, Any]:
    if _using_e2e_ws_session():
        return e2e_ws_backend.send_terminal_command(keystrokes, duration, block)
    return electron_backend.send_terminal_command(keystrokes, duration, block)


def _remote_get_terminal_state(capture_entire: bool) -> dict[str, Any]:
    if _using_e2e_ws_session():
        return e2e_ws_backend.get_terminal_state(capture_entire)
    return electron_backend.get_terminal_state(capture_entire)


def _remote_get_incremental_output() -> dict[str, Any]:
    if _using_e2e_ws_session():
        return e2e_ws_backend.get_incremental_output()
    return electron_backend.get_incremental_output()


def notify_terminal_instance_ready(instance_id: str, agent_name: str) -> None:
    """Tell Electron to add a TerminalView card for this PTY instance (collaboration / parallel)."""
    tev.notify_terminal_instance_ready(instance_id, agent_name)


def set_current_terminal_instance_id(instance_id: str):
    """Bind PTY routing for this task (async context; copied into ReAct worker threads)."""
    return st.set_current_terminal_instance_id(instance_id)


def get_current_terminal_instance_id() -> str:
    return st.get_current_terminal_instance_id()


def initialize_terminal(
    session_name: Optional[str] = None,
    working_directory: Optional[str] = None,
    shell: str = "/bin/bash",
) -> dict[str, Any]:
    """
    Initialize a terminal session: primary Electron (IPC) → E2E WS bridge → pexpect.

    When ``E2E_TERMINAL_BRIDGE_URL`` is set but there is **no** primary Electron stdin feed
    (e.g. e2e FastAPI), **E2E WS is tier-1** so we do not write ``_terminal_ipc`` JSON to stdout
    (which never reaches an Electron parent and would not open tabs in the E2E shell).

    **Multiple host tabs (E2E / Electron):** pass a **distinct** ``session_name`` for each
    long-running application (e.g. ``e2e_api``, ``e2e_web``). That routes to a dedicated
    ``instance_id`` so the shell opens a new PTY per service. Omit or use the default session
    name to work in the root tab for that pipeline task.
    """
    resolved_session = session_name or st._default_session_name
    iid_now = st.get_current_terminal_instance_id()
    target_iid = st.compose_terminal_instance_for_init(iid_now, session_name)
    if target_iid != iid_now:
        st.set_current_terminal_instance_id(target_iid)
        logger.info(
            "initialize_terminal: routed instance_id %s -> %s (raw_session_name=%r resolved=%r)",
            iid_now,
            target_iid,
            session_name,
            resolved_session,
        )

    probe = _primary_create_probe_timeout()
    e2e_url = _br.e2e_terminal_bridge_url()
    stdin_feed = terminal_stdin_acks_via_runtime()
    legacy_pty_env = legacy_vinv_engine_electron_pty_env()
    # E2E-first when a bridge URL is configured and we are not the run.py child with stdin IPC.
    # Do not treat legacy VINV_ENGINE_ELECTRON_PTY alone as "primary capable": conda shells often set it
    # while FastAPI has no Electron parent — that would emit _terminal_ipc JSON to stdout forever.
    can_primary_ipc = stdin_feed or legacy_pty_env
    logger.info(
        "initialize_terminal: cascade start primary_probe_timeout_s=%s runtime_terminal_feed=%s "
        "legacy_VINV_ENGINE_ELECTRON_PTY=%s e2e_bridge=%s can_primary_ipc=%s e2e_first=%s",
        probe,
        stdin_feed,
        legacy_pty_env,
        _e2e_bridge_url_log_fragment(e2e_url),
        can_primary_ipc,
        bool(e2e_url and not stdin_feed),
    )

    # FastAPI / e2e-backend + bridge URL: WS is the only host PTY — skip doomed stdout IPC.
    if e2e_url and not stdin_feed:
        logger.info(
            "initialize_terminal: tier1=E2E WS (skip primary stdout IPC — no runtime stdin feed)",
        )
        r_ws = e2e_ws_backend.initialize_terminal(resolved_session, working_directory, shell)
        if r_ws.get("status") == "success":
            logger.info(
                "initialize_terminal: backend=e2e_ws status=success instance_id=%s transport=%s",
                r_ws.get("instance_id", ""),
                r_ws.get("transport"),
            )
            return r_ws
        logger.warning(
            "initialize_terminal: tier1 E2E WS failed; falling back to pexpect error=%r",
            r_ws.get("error"),
        )
        r_px = python_pexpect_backend.initialize_terminal(resolved_session, working_directory, shell)
        logger.info("initialize_terminal: backend=pexpect status=%s", r_px.get("status"))
        return r_px

    # Only attempt the primary Electron stdout/stdin IPC when there is actually a host
    # capable of answering it (runtime stdin feed or legacy Electron PTY env). Standalone
    # runs (e.g. the bringup CLI with no Electron parent) have can_primary_ipc=False, where
    # the create request can never be acked and just burns the probe timeout before falling
    # through to pexpect — and logs a misleading IPC-timeout ERROR every run.
    if can_primary_ipc:
        r = electron_backend.initialize_terminal(
            resolved_session, working_directory, shell, ipc_create_timeout=probe
        )
        if r.get("status") == "success":
            logger.info(
                "initialize_terminal: backend=primary_electron status=%s instance_id=%s",
                r.get("status"),
                r.get("instance_id", ""),
            )
            return r
        logger.info(
            "initialize_terminal: tier1 primary_electron not used error=%r",
            r.get("error"),
        )
        if probe is not None:
            logger.info(
                "initialize_terminal: tier1 used short probe (%.2fs); continuing to tier2/tier3",
                probe,
            )
    else:
        logger.info(
            "initialize_terminal: tier1 primary_electron skipped — no primary IPC channel "
            "(no runtime stdin feed / Electron parent); going straight to tier2/tier3",
        )
    if e2e_url:
        logger.info("initialize_terminal: tier2 attempting E2E WS (create over bridge)")
        r2 = e2e_ws_backend.initialize_terminal(resolved_session, working_directory, shell)
        if r2.get("status") == "success":
            logger.info(
                "initialize_terminal: backend=e2e_ws status=success instance_id=%s transport=%s",
                r2.get("instance_id", ""),
                r2.get("transport"),
            )
            return r2
        logger.warning(
            "initialize_terminal: tier2 E2E WS failed; falling back to pexpect error=%r",
            r2.get("error"),
        )
    else:
        logger.info(
            "initialize_terminal: tier2 skipped — E2E_TERMINAL_BRIDGE_URL unset after "
            "dotenv/port derive (set E2E_TERMINAL_BRIDGE_URL or E2E_TERMINAL_BRIDGE_PORT in "
            "e2e/backend/.env and restart backend; e2e app needs E2E_TERMINAL_BRIDGE_PORT + npm start)",
        )
    r3 = python_pexpect_backend.initialize_terminal(resolved_session, working_directory, shell)
    logger.info(
        "initialize_terminal: backend=pexpect status=%s",
        r3.get("status"),
    )
    return r3


def close_terminal(session_name: Optional[str] = None) -> dict[str, Any]:
    """Close or destroy the terminal session.

    Pass ``session_name`` to close a specific tab; omit to close the
    currently routed one. Note: bring-up tasks are instructed never to
    close terminals, but this stays available for general use.
    """
    with _route_for_session(session_name):
        if _using_e2e_ws_session():
            return e2e_ws_backend.close_terminal()
        if st.get_terminal_session() == "electron_pty":
            return electron_backend.close_terminal()
        if st.get_current_terminal_instance_id() in st.get_electron_instances():
            return electron_backend.close_terminal()
        return python_pexpect_backend.close_terminal()


def should_prewarm_remote_terminal() -> bool:
    """True when a host PTY (primary or E2E WS) should be prewarmed instead of pexpect-only."""
    return _br.should_prewarm_remote_terminal()


def set_terminal_session(session: Any) -> None:
    """
    Set the terminal session to use for tool operations.

    In Electron mode this is a no-op for real PTY handles (the PTY lives in the main process).
    """
    if isinstance(session, str):
        if session in ("electron_pty", "e2e_ws_pty"):
            st.set_terminal_session_ref(session)
        else:
            logger.warning("⚠️ Ignoring set_terminal_session with string: %s", session)
        return
    if hasattr(session, "isalive") or session is None:
        st.set_terminal_session_ref(session)
        logger.info("🖥️ Terminal session set manually: %s", type(session).__name__)
    else:
        logger.warning("⚠️ Ignoring set_terminal_session with invalid type: %s", type(session).__name__)


def _route_for_session(session_name: Optional[str]):
    """Context manager that temporarily routes terminal tool calls to a
    specific ``session_name``'s instance, restoring the prior routing on exit.

    Used by ``send_terminal_command`` / ``get_terminal_state`` /
    ``get_incremental_output`` / ``close_terminal`` so the agent can target a
    specific tab on a per-call basis without losing the contextvar's prior
    value (which other in-flight calls / tasks rely on).
    """
    import contextlib

    @contextlib.contextmanager
    def _ctx():
        if not session_name or session_name == st._default_session_name:
            yield
            return
        prev_iid = st.get_current_terminal_instance_id()
        target_iid = st.compose_terminal_instance_for_init(prev_iid, session_name)
        if target_iid == prev_iid:
            yield
            return
        token = st.set_current_terminal_instance_id(target_iid)
        logger.info(
            "🛠️ session_name=%r routes call to instance_id %s (prev=%s)",
            session_name, target_iid, prev_iid,
        )
        try:
            yield
        finally:
            try:
                st._current_terminal_instance_id.reset(token)
            except Exception:
                # contextvar tokens can only be reset in the same context; if that
                # fails (e.g. the call hopped threads), restore by writing back.
                st.set_current_terminal_instance_id(prev_iid)

    return _ctx()


def _dangerous_terminal_enabled() -> bool:
    return os.environ.get("VINV_ENGINE_ALLOW_DANGEROUS_TERMINAL", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _terminal_policy_error(keystrokes: str) -> str | None:
    """Reject high-impact shell actions unless the host operator opts in."""
    if _dangerous_terminal_enabled():
        return None
    import re

    rules = (
        (r"(^|[;&|]\s*)sudo(?:\s|$)", "privilege escalation"),
        (r"\brm\s+-[^\n ]*(?:rf|fr)[^\n ]*\s+(?:/|~|\$HOME)(?:\s|$)", "recursive root/home deletion"),
        (r"\bgit\s+reset\s+--hard\b", "destructive Git reset"),
        (r"\bgit\s+clean\s+-[a-zA-Z]*(?:f[a-zA-Z]*d|d[a-zA-Z]*f|x)", "destructive Git clean"),
        (r"\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f)(?:\s|$)", "force push"),
        (r"\b(?:curl|wget)\b[^\n|;]*\|\s*(?:ba|z)?sh\b", "remote script execution"),
        (r"\b(?:mkfs(?:\.\w+)?|fdisk|shutdown|reboot|halt|poweroff)\b", "host-destructive command"),
        (r"\bdd\b[^\n]*\bof=/dev/", "raw device write"),
        (
            r"\b(?:cat|less|more|cp|scp)\s+[^\n;&|]*(?:/etc/shadow|(?:~|\$HOME)/\.(?:ssh|aws|gnupg))",
            "credential or system-secret access",
        ),
    )
    for pattern, reason in rules:
        if re.search(pattern, keystrokes, flags=re.IGNORECASE):
            return (
                f"Terminal policy blocked {reason}. A host operator must set "
                "VINV_ENGINE_ALLOW_DANGEROUS_TERMINAL=1 for this process after explicit review."
            )
    return None


def send_terminal_command(
    keystrokes: str,
    duration: float = 2.0,
    block: bool = False,
    session_name: Optional[str] = None,
) -> dict[str, Any]:
    """Send keystrokes to the terminal session (parameter is ``keystrokes``, not ``command``).

    The PTY-bound parameter is named ``keystrokes`` because the value is sent
    raw to the terminal device — newlines, tabs, control characters and shell
    metacharacters are all forwarded unmodified, which is more general than a
    "command". A trailing newline is appended automatically by the backend.

    Required:
        keystrokes: The exact text to type into the terminal — typically a
            shell command like ``ls -la`` or ``cat README.md``. Do **not**
            pass it as ``command=`` — that argument does not exist.

    Optional:
        duration: Upper budget in seconds — NOT a wait. ``block=True`` returns
            the instant the command actually completes (exact sentinel
            detection), so a generous budget costs nothing; give long
            operations (installs, builds) 300–900s rather than undershooting.
        block: ``True`` waits for exact completion and returns
            ``exit_code``/``completed`` alongside the output. If the budget is
            exceeded the foreground job is safely interrupted and ``status``
            is ``"timeout"`` with partial output — the session stays usable.
            If a previous command's foreground process still owns the shell,
            a blocking send returns a ``terminal_busy`` error instead of
            typing into it. The DEFAULT is ``False`` (raw keystrokes, settle
            on quiet): use it for daemons, interactive input, or Ctrl-C, and
            prefer redirecting long/noisy commands to a log file, e.g.
            ``pip install -r reqs.txt > /tmp/pip.log 2>&1`` then
            ``grep -in 'error\\|fail' /tmp/pip.log | head -20``.
        session_name: Target a specific tab opened by a prior
            ``initialize_terminal(session_name=...)`` call. Omit to route to
            the most-recently-initialized session.

    Multi-line scripts are executed via a temp script in a child shell:
    ``set -e``/pipefail/syntax errors inside them cannot break the session,
    but ``cd``/``export`` in multi-line blocks do NOT persist — put those on
    their own single-line calls.

    Result contract:
        status "success" — command finished; ``exit_code`` is its real exit
            status (0 = ok). Check it instead of parsing output for errors.
        status "timeout" — the command exceeded ``duration`` and was
            interrupted; partial output included. Re-run with a larger
            duration, or redirect to a log and poll. If
            ``session_reinitialized`` is true the shell was replaced (cwd/env
            lost) and the command was NOT re-run automatically.
        status "error" + ``terminal_busy`` — a foreground process from a
            previous command still owns this session: poll with
            get_incremental_output, stop it by sending ``"\\x03"`` with
            ``block=False``, or use a separate ``session_name``. A daemon
            started with ``block=False`` (without ``&``) keeps the session
            busy — launch servers as ``cmd > /tmp/x.log 2>&1 &`` when you
            need the same session afterwards.

    Output handling: large captures are NOT returned inline. They are written
    in full to a log artifact and you receive a digest (head/tail/diagnostic
    lines + the log path). Investigate failures by grepping that log file for
    errors — never request or re-print entire logs into your context.

    Example:
        send_terminal_command(keystrokes="ls -la", duration=5, block=True)
        send_terminal_command(keystrokes="npm test > /tmp/test.log 2>&1")
        send_terminal_command(keystrokes="grep -in 'fail\\|error' /tmp/test.log | head -20",
                              duration=5, block=True)
    """
    import re as _re

    policy_error = _terminal_policy_error(keystrokes)
    if policy_error is not None:
        return {"status": "error", "error": policy_error, "output": ""}

    _HEREDOC_RE = _re.compile(r'<<\s*[\'"]?(\w+)[\'"]?')
    if _HEREDOC_RE.search(keystrokes) and len(keystrokes) > 4096:
        return {
            "status": "error",
            "error": (
                "Heredoc command too large ({}B). Large heredocs cause PTY buffer "
                "overflow and terminal lockups. To CREATE a file, use "
                "save_file(content, file_path). To RUN a multi-line script, "
                "save_file() it to a path (e.g. /tmp/_run.py) then execute it with a "
                "single short command (e.g. 'python3 /tmp/_run.py'). Do not inline "
                "the script via heredoc."
            ).format(len(keystrokes)),
            "output": "",
        }

    with _route_for_session(session_name):
        logger.info(
            "🛠️ send_terminal_command: session_name=%r command_len=%d command_sha256=%s duration=%s",
            session_name,
            len(keystrokes),
            hashlib.sha256(keystrokes.encode("utf-8", errors="replace")).hexdigest()[:16],
            duration,
        )

        iid = st.get_current_terminal_instance_id()
        init_err = _auto_init_terminal_if_needed()
        if init_err is not None:
            return {
                "status": "error",
                "error": f"Failed to auto-initialize terminal: {init_err.get('error', 'Unknown')}",
                "output": "",
            }

        _log_terminal_transport("send_terminal_command")

        if iid in st.get_electron_instances():
            return _bounded_output(
                _remote_send_command(keystrokes, duration, block), "terminal-cmd",
            )

        ts = st.get_terminal_session()
        if isinstance(ts, str) and ts in ("electron_pty", "e2e_ws_pty"):
            return {
                "status": "error",
                "command": keystrokes,
                "output": "",
                "error": "Host PTY session expected but instance not registered",
            }

        return _bounded_output(
            python_pexpect_backend.send_terminal_command(keystrokes, duration, block),
            "terminal-cmd",
        )


def get_terminal_state(
    capture_entire: bool = False,
    session_name: Optional[str] = None,
) -> dict[str, Any]:
    """Get the current state of the terminal session.

    Pass ``session_name`` to read a specific tab; omit for the default routing.
    """
    with _route_for_session(session_name):
        logger.info(
            "🛠️ get_terminal_state called: capture_entire=%s session_name=%r",
            capture_entire, session_name,
        )

        iid = st.get_current_terminal_instance_id()
        init_err = _auto_init_terminal_if_needed()
        if init_err is not None:
            return {"status": "error", "error": init_err.get("error", "Unknown"), "output": ""}

        _log_terminal_transport("get_terminal_state")

        if iid in st.get_electron_instances():
            return _bounded_output(
                _remote_get_terminal_state(capture_entire), "terminal-state",
            )

        ts = st.get_terminal_session()
        if isinstance(ts, str) and ts in ("electron_pty", "e2e_ws_pty"):
            return {
                "status": "error",
                "output": "",
                "is_alive": False,
                "error": f"Terminal session is a string '{ts}', not a pexpect object",
            }

        return _bounded_output(
            python_pexpect_backend.get_terminal_state(capture_entire),
            "terminal-state",
        )


def get_incremental_output(session_name: Optional[str] = None) -> dict[str, Any]:
    """Get incremental output from the terminal (new output since last check).

    Pass ``session_name`` to read a specific tab; omit for the default routing.
    """
    with _route_for_session(session_name):
        logger.info("🛠️ get_incremental_output called: session_name=%r", session_name)

        iid = st.get_current_terminal_instance_id()
        init_err = _auto_init_terminal_if_needed()
        if init_err is not None:
            return {"status": "error", "error": init_err.get("error", "Unknown"), "output": ""}

        _log_terminal_transport("get_incremental_output")

        if iid in st.get_electron_instances():
            return _bounded_output(
                _remote_get_incremental_output(), "terminal-incremental",
            )

        ts = st.get_terminal_session()
        if isinstance(ts, str) and ts in ("electron_pty", "e2e_ws_pty"):
            return {
                "status": "error",
                "output": "",
                "error": f"Terminal session is a string '{ts}', not a pexpect object",
            }

        return _bounded_output(
            python_pexpect_backend.get_incremental_output(),
            "terminal-incremental",
        )


__all__ = [
    "close_terminal",
    "feed_ipc_response",
    "get_current_terminal_instance_id",
    "get_incremental_output",
    "get_terminal_state",
    "initialize_terminal",
    "is_terminal_host_owned",
    "notify_terminal_instance_ready",
    "send_terminal_command",
    "set_current_terminal_instance_id",
    "set_terminal_session",
    "should_prewarm_remote_terminal",
    "_is_electron_ipc_available",
    "_pexpect_fd_is_dead",
    "_pexpect_sessions",
    "_current_terminal_instance_id",
]
