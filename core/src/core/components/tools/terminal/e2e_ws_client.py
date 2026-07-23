"""Synchronous WebSocket RPC to the E2E Electron terminal bridge (mirrors stdout ``_terminal_ipc`` JSON)."""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)

_lock = threading.RLock()
_ws: Any = None
_url: Optional[str] = None

_IPC_MARKER = "_terminal_ipc"


def _websocket_frame_to_text(raw: bytes | str) -> str:
    """Normalize ``websocket-client`` ``recv()`` output (bytes or str) to text."""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")
    return str(raw)


def _connection_url() -> str:
    from core.components.tools.terminal.backend_resolver import e2e_terminal_bridge_url

    return e2e_terminal_bridge_url()


def _ensure_ws() -> Any:
    global _ws, _url
    import websocket  # websocket-client

    target = _connection_url()
    if not target:
        raise RuntimeError("E2E_TERMINAL_BRIDGE_URL is not set")

    with _lock:
        if _ws is not None and _url == target:
            try:
                if _ws.connected:
                    return _ws
            except Exception:
                pass
            try:
                _ws.close()
            except Exception:
                pass
            _ws = None

        t0 = time.monotonic()
        _ws = websocket.create_connection(target, timeout=10, enable_multithread=True)
        _url = target
        logger.info(
            "🖥️ E2E terminal WS connected url=%s connect_sec=%.3f",
            target,
            time.monotonic() - t0,
        )
        return _ws


def close_connection() -> None:
    global _ws, _url
    with _lock:
        if _ws is not None:
            try:
                _ws.close()
            except Exception:
                pass
            _ws = None
        _url = None


def ws_request(msg: dict[str, Any], timeout: float | None = 300.0) -> dict[str, Any]:
    """Send one JSON-line RPC and wait for the response with the same ``request_id``."""
    req_id = msg.get("request_id") or str(uuid.uuid4())
    out = dict(msg)
    out["request_id"] = req_id
    out[_IPC_MARKER] = True
    line = json.dumps(out, separators=(",", ":"))
    msg_type = out.get("type", "?")
    logger.info(
        "e2e_ws_client ws_request start type=%s request_id=%s timeout_s=%s url_configured=%s",
        msg_type,
        req_id,
        timeout,
        bool(_connection_url()),
    )

    with _lock:
        try:
            ws = _ensure_ws()
        except Exception as e:
            logger.info("e2e_ws_client ws_request connect_or_reuse failed: %s", e)
            close_connection()
            return {"status": "error", "error": f"E2E WS connect failed: {e}"}
        try:
            ws.send(line)
        except Exception as e:
            logger.info("e2e_ws_client ws_request send failed type=%s: %s", msg_type, e)
            close_connection()
            return {"status": "error", "error": f"E2E WS send failed: {e}"}
        deadline = time.monotonic() + float(timeout or 300.0)
        while time.monotonic() < deadline:
            try:
                raw = ws.recv()
            except Exception as e:
                logger.info("e2e_ws_client ws_request recv failed type=%s: %s", msg_type, e)
                close_connection()
                return {"status": "error", "error": f"E2E WS recv failed: {e}"}
            if not raw:
                continue
            for piece in _websocket_frame_to_text(raw).split("\n"):
                s = piece.strip()
                if not s:
                    continue
                try:
                    resp = json.loads(s)
                except (json.JSONDecodeError, ValueError):
                    continue
                if not resp.get(_IPC_MARKER):
                    continue
                if resp.get("request_id") != req_id:
                    logger.info(
                        "e2e_ws_client ws_request discarding unrelated _terminal_ipc line "
                        "expected_request_id=%s got_request_id=%s",
                        req_id,
                        resp.get("request_id"),
                    )
                    continue
                logger.info(
                    "e2e_ws_client ws_request done type=%s request_id=%s success=%s",
                    msg_type,
                    req_id,
                    resp.get("success"),
                )
                return resp
        logger.info(
            "e2e_ws_client ws_request timeout type=%s request_id=%s waited_s=%s",
            msg_type,
            req_id,
            timeout,
        )
        return {"status": "error", "error": f"E2E WS IPC timeout after {timeout}s"}
