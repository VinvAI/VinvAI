"""HTTP layer: stdlib ThreadingHTTPServer serving OpenAI-shaped embeddings.

Routes:
    POST /v1/embeddings   {"model": str, "input": str | [str, ...]}
    POST /embeddings      (same handler)
    GET  /health          {"status": "ok", "model", "device", "queue_depth", "warming"}

No auth: the server binds 127.0.0.1 only. The handler must never take the
process down — every request path returns proper JSON 4xx/5xx on failure.
"""

from __future__ import annotations

import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import config
from .engine import EncodeAbandoned, logger

EMBED_PATHS = ("/v1/embeddings", "/embeddings")

# Cap on how many input items _estimate_tokens actually inspects.
_TOKEN_SAMPLE_ITEMS = 100

# Suggested client backoff when shedding load (seconds, Retry-After header).
RETRY_AFTER_S = 5


def _estimate_tokens(texts: list[str]) -> int:
    """Cheap ~4-chars-per-token heuristic; usage numbers are informational only.

    Bounded work: estimating the full payload showed up at p99 ~900ms on large
    batches, so beyond _TOKEN_SAMPLE_ITEMS items the total is extrapolated
    from the first sample — usage numbers may be approximate for big requests.
    """
    n = len(texts)
    if n <= _TOKEN_SAMPLE_ITEMS:
        return sum(max(1, len(t) // 4) for t in texts)
    sampled = sum(max(1, len(t) // 4) for t in texts[:_TOKEN_SAMPLE_ITEMS])
    return max(n, (sampled * n) // _TOKEN_SAMPLE_ITEMS)


class EmbedderServer(ThreadingHTTPServer):
    daemon_threads = True
    # The bind is the machine-wide single-instance lock: one embedder serves
    # every VS Code window, every service and every agent, because a second
    # `serve` loses the port instead of loading its own copy of the model.
    # SO_REUSEADDR means opposite things per platform — on POSIX it only skips
    # TIME_WAIT after a restart (wanted), but on Windows it lets a second
    # process bind a port that is actively in use, which would silently split
    # traffic between two half-loaded servers and defeat the lock entirely.
    allow_reuse_address = os.name != "nt"

    def __init__(self, addr: tuple[str, int], engine: Any) -> None:
        self.engine = engine
        self.max_items = config.max_items()
        self.max_body = config.max_body_bytes()
        self.max_queue = config.max_queue()
        self._queue_depth = 0
        self._qlock = threading.Lock()
        super().__init__(addr, _Handler)

    @property
    def queue_depth(self) -> int:
        with self._qlock:
            return self._queue_depth

    def _enter_queue(self) -> bool:
        """Reserve a queue slot; False when the bound is reached (reply 503)."""
        with self._qlock:
            if self._queue_depth >= self.max_queue:
                return False
            self._queue_depth += 1
            return True

    def _exit_queue(self) -> None:
        with self._qlock:
            self._queue_depth -= 1


class _Handler(BaseHTTPRequestHandler):
    server: EmbedderServer  # type: ignore[assignment]
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet default access log
        pass

    # -- helpers -------------------------------------------------------------

    def _send_json(
        self, code: int, payload: dict, headers: dict | None = None, close: bool = False
    ) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if close:
            # Framing is unrecoverable (an unread body we will not drain): tell
            # the client so, and make the stdlib handler actually hang up.
            self.send_header("Connection", "close")
            self.close_connection = True
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(
        self,
        code: int,
        message: str,
        err_type: str,
        headers: dict | None = None,
        close: bool = False,
    ) -> None:
        self._send_json(
            code,
            {"error": {"message": message, "type": err_type, "code": code}},
            headers=headers,
            close=close,
        )

    def _drain_body(self) -> None:
        """Consume the request body so a kept-alive connection stays framed.

        An early error return that never reads ``rfile`` leaves the body sitting
        in the socket. With ``protocol_version = "HTTP/1.1"`` the connection is
        reused, so the next request on it starts parsing mid-JSON and the server
        answers ``400 Bad request syntax ('{"input":[...')``.

        That turns a *retryable* shed into a *fatal* one. The index engine
        retries 429/5xx and treats every other status as a hard error, so a
        client correctly riding out the multi-minute model load would get one
        503, reuse the pooled connection, receive the bogus 400, and give up —
        making retrieval fail for the whole warm-up window instead of waiting
        the ``Retry-After`` out.
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return
        remaining = min(length, self.server.max_body)
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 64 * 1024))
            if not chunk:
                return  # peer stopped writing; the connection is done either way
            remaining -= len(chunk)

    def _client_disconnected(self) -> bool:
        """Best-effort peek: has the peer already hung up?

        A non-blocking ``recv(1, MSG_PEEK)`` returning ``b''`` means the client
        closed the connection; raising ``BlockingIOError`` is the normal
        still-connected case (nothing buffered). The stdlib handler owns
        ``self.connection`` for the lifetime of this request, so toggling its
        blocking mode here is safe. Conservative by design: any error while
        checking counts as "still connected" — this must never turn a live
        request into a dropped one.
        """
        conn = getattr(self, "connection", None)
        if conn is None:
            return False
        try:
            prev_timeout = conn.gettimeout()
        except (OSError, AttributeError):
            return False
        try:
            conn.setblocking(False)
            try:
                chunk = conn.recv(1, socket.MSG_PEEK)
            finally:
                conn.settimeout(prev_timeout)
        except BlockingIOError:
            return False  # alive: connected with nothing buffered
        except (OSError, ValueError, AttributeError):
            return False  # can't tell — assume alive
        return chunk == b""

    # -- routes --------------------------------------------------------------

    def do_GET(self) -> None:
        try:
            if self.path in ("/health", "/healthz"):
                eng = self.server.engine
                # 503 until the model is in memory. The socket exists from the
                # moment `serve` starts so that startup is observable, but a
                # 2xx here is a promise that embeddings will actually work —
                # clients gate on the status code, so it must not lie during
                # the (multi-minute, on CPU) load.
                ready = bool(getattr(eng, "ready", True))
                self._send_json(
                    200 if ready else 503,
                    {
                        "status": "ok" if ready else "loading",
                        "model": eng.model_name,
                        "device": eng.device,
                        "queue_depth": self.server.queue_depth,
                        "warming": bool(getattr(eng, "warming", False)),
                    },
                    headers=None if ready else {"Retry-After": str(RETRY_AFTER_S)},
                )
            elif self.path in EMBED_PATHS:
                self._send_error_json(405, "use POST for embeddings", "method_not_allowed")
            else:
                self._send_error_json(404, f"no such route: {self.path}", "not_found")
        except Exception as exc:  # never die on a bad request
            self._safe_500(exc)

    def do_POST(self) -> None:
        try:
            if self.path not in EMBED_PATHS:
                self._drain_body()
                self._send_error_json(404, f"no such route: {self.path}", "not_found")
                return
            self._handle_embeddings()
        except (BrokenPipeError, ConnectionResetError):
            pass  # client went away; nothing to send
        except Exception as exc:
            self._safe_500(exc)

    def _handle_embeddings(self) -> None:
        # Reachable before the model is loaded now that the bind comes first —
        # shed with the same Retry-After clients already honour for overload
        # rather than blocking a request behind a multi-minute load.
        if not getattr(self.server.engine, "ready", True):
            # Drain FIRST: this is the shed a client is meant to retry, and an
            # unread body would poison the very connection it retries on.
            self._drain_body()
            self._send_error_json(
                503,
                "model is still loading; retry shortly",
                "service_unavailable",
                headers={"Retry-After": str(RETRY_AFTER_S)},
            )
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            # No trustworthy length ⇒ no way to know where this body ends.
            self._send_error_json(
                400, "invalid Content-Length", "invalid_request_error", close=True
            )
            return
        if length <= 0:
            self._send_error_json(400, "empty request body", "invalid_request_error")
            return
        if length > self.server.max_body:
            # Deliberately NOT drained — reading an oversized body to keep the
            # connection alive is exactly the cost the cap exists to refuse.
            self._send_error_json(
                413,
                f"request body exceeds {self.server.max_body} bytes",
                "payload_too_large",
                close=True,
            )
            return

        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_error_json(400, "request body is not valid JSON", "invalid_request_error")
            return
        if not isinstance(body, dict):
            self._send_error_json(
                400, "request body must be a JSON object", "invalid_request_error"
            )
            return

        texts = body.get("input")
        if isinstance(texts, str):
            texts = [texts]
        if not isinstance(texts, list) or not texts:
            self._send_error_json(
                400,
                "'input' must be a non-empty string or array of strings",
                "invalid_request_error",
            )
            return
        if not all(isinstance(t, str) for t in texts):
            self._send_error_json(400, "'input' items must all be strings", "invalid_request_error")
            return
        if len(texts) > self.server.max_items:
            self._send_error_json(
                413,
                f"'input' has {len(texts)} items; max is {self.server.max_items}",
                "payload_too_large",
            )
            return

        engine = self.server.engine
        # A dead client must not cost minutes of encode: killing the HTTP client
        # mid-request used to run the full batch anyway, failing only at response
        # write with BrokenPipeError. Check liveness before touching the engine.
        if self._client_disconnected():
            logger.info("client disconnected — skipping encode")
            return
        # Bounded queue: beyond max_queue waiting requests, shed load with 503
        # instead of piling more threads onto the encode lock (observed lock
        # waits >30 min under retry storms when every retry queued).
        if not self.server._enter_queue():
            logger.warning(
                "queue full (%d waiting) — shedding request with 503",
                self.server.max_queue,
            )
            self._send_error_json(
                503,
                f"embedder queue is full ({self.server.max_queue} requests waiting); retry later",
                "server_overloaded",
                headers={"Retry-After": str(RETRY_AFTER_S)},
            )
            return
        try:
            # should_abandon: the engine re-checks liveness every poll while
            # this request waits (for the lock or a coalesced duplicate), so a
            # dead client stops waiting instead of holding a queue slot.
            vectors = engine.embed(texts, should_abandon=self._client_disconnected)
        except EncodeAbandoned:
            logger.info("client disconnected while queued — request abandoned")
            return
        except Exception as exc:
            logger.error("embedding failed: %s", exc)
            self._send_error_json(500, f"embedding failed: {exc}", "server_error")
            return
        finally:
            self.server._exit_queue()

        # Re-check between the engine call and the write: the client may have
        # hung up during a long encode; serializing + writing is wasted then.
        if self._client_disconnected():
            logger.info("client disconnected after encode — skipping response write")
            return

        if hasattr(vectors, "tolist"):
            vectors = vectors.tolist()

        tokens = _estimate_tokens(texts)  # computed once; approximate on big batches
        response: dict[str, Any] = {
            "object": "list",
            "data": [
                {"object": "embedding", "embedding": vec, "index": i}
                for i, vec in enumerate(vectors)
            ],
            "model": engine.model_name,
            "usage": {
                "prompt_tokens": tokens,
                "total_tokens": tokens,
            },
        }
        requested = body.get("model")
        if requested and requested != engine.model_name:
            # Reject rather than serve. A model change (e.g. the granite
            # migration) leaves a stale sidecar loaded with the previous model;
            # serving its wrong-dimension vectors here would poison a store that
            # the index labels with the *requested* model. Fail loudly so the
            # caller restarts vinv-embedder on the new model instead.
            self._send_error_json(
                400,
                f"requested model '{requested}' is not loaded; this sidecar serves "
                f"'{engine.model_name}'. Restart vinv-embedder to switch models.",
                "model_mismatch",
            )
            return
        self._send_json(200, response)

    def _safe_500(self, exc: Exception) -> None:
        logger.error("unhandled error in request handler: %s", exc)
        try:
            self._send_error_json(500, "internal server error", "server_error")
        except Exception:
            pass


def make_server(port: int, engine: Any, host: str = config.BIND_HOST) -> EmbedderServer:
    return EmbedderServer((host, port), engine)
