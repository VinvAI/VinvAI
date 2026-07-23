"""Choose terminal transport: primary Vinv Engine Electron (stdout IPC) → E2E Electron (WS) → pexpect."""

from __future__ import annotations

import logging
import os
import socket
import time
from typing import Literal
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

KIND_PRIMARY_ELECTRON = "primary_electron"
KIND_E2E_WS = "e2e_ws"
KIND_PEXPECT = "pexpect"

TerminalBackendKind = Literal["primary_electron", "e2e_ws", "pexpect"]

# Health-check cache so we don't probe the WS bridge on every command.
_BRIDGE_HEALTH_CACHE: dict[str, tuple[float, bool]] = {}
_BRIDGE_HEALTH_TTL_SECONDS = 30.0


def primary_electron_env_enabled() -> bool:
    return os.environ.get("VINV_ENGINE_ELECTRON_PTY", "").lower() in ("1", "true", "yes")


def e2e_terminal_bridge_url() -> str:
    """e.g. ``ws://127.0.0.1:18766`` — E2E Electron app must start the bridge (see ``e2e/app``)."""
    return os.environ.get("E2E_TERMINAL_BRIDGE_URL", "").strip()


def _is_bridge_reachable(url: str, timeout_s: float = 1.5) -> bool:
    """Cheap TCP probe: open a socket to host:port and close.

    A successful WebSocket handshake would prove more, but that costs more
    too.  This rules out the common case (no listener at all on the port,
    which produced the 12-minute attempt-1 stall in run 821d0c9b) without
    burning seconds on every call.

    Result is cached for ``_BRIDGE_HEALTH_TTL_SECONDS`` so repeated calls
    don't re-probe; the cache is keyed by URL so changing the URL forces
    a fresh probe.
    """
    if not url:
        return False
    now = time.monotonic()
    cached = _BRIDGE_HEALTH_CACHE.get(url)
    if cached is not None and (now - cached[0]) < _BRIDGE_HEALTH_TTL_SECONDS:
        return cached[1]
    parsed = urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port
    if port is None:
        # Without a port we can't probe; assume reachable and let the
        # caller's WS timeout discover the truth.  This preserves the
        # legacy behaviour for unusual URLs.
        _BRIDGE_HEALTH_CACHE[url] = (now, True)
        return True
    ok = False
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            ok = True
    except (OSError, socket.timeout, socket.gaierror) as exc:
        logger.warning(
            "E2E terminal: bridge probe failed url=%s host=%s port=%s err=%s — "
            "will fall back to pexpect for terminal operations",
            url, host, port, exc,
        )
    _BRIDGE_HEALTH_CACHE[url] = (now, ok)
    return ok


def invalidate_bridge_health_cache(url: str | None = None) -> None:
    """Drop cached probe results.

    Call this when a WS RPC fails so the next backend lookup re-probes
    instead of trusting the (now-stale) cached health bit.
    """
    if url is None:
        _BRIDGE_HEALTH_CACHE.clear()
    else:
        _BRIDGE_HEALTH_CACHE.pop(url, None)


def resolve_terminal_backend_kind() -> TerminalBackendKind:
    """Static hint for tiers 2–3. Tier 1 (primary Electron) is probed first in ``terminal_tools``.

    The WS tier is only used when ``E2E_TERMINAL_BRIDGE_URL`` is set AND
    the host:port answers a TCP probe.  When the bridge has been
    auto-defaulted (see ``llm_bootstrap.derive_e2e_terminal_bridge_url_env``)
    but the Electron app isn't actually running, we silently fall back to
    pexpect rather than letting every send_terminal_command time out for
    minutes against a dead listener.
    """
    url = e2e_terminal_bridge_url()
    if not url:
        return KIND_PEXPECT
    if _is_bridge_reachable(url):
        return KIND_E2E_WS
    logger.info(
        "E2E terminal: bridge URL %s is configured but unreachable; using pexpect backend",
        url,
    )
    return KIND_PEXPECT


def should_prewarm_remote_terminal() -> bool:
    """Prewarm when E2E WS is configured or stdout is piped (typical Electron-spawned child / CI)."""
    if e2e_terminal_bridge_url():
        return True
    try:
        import sys

        if not sys.stdout.isatty():
            return True
    except Exception:
        pass
    return primary_electron_env_enabled()
