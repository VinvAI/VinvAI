"""HTTP contract tests: routes, shapes, error paths. Runs on an ephemeral port."""

from __future__ import annotations

import json
import socket
import threading
import urllib.error
import urllib.request

import pytest

from vinv_embedder import server as server_mod
from vinv_embedder.server import EmbedderServer

DIM = 4


class StubEngine:
    model_name = "nomic-ai/CodeRankEmbed"
    device = "cpu"

    def __init__(self):
        self.calls: list[list[str]] = []
        self.raise_next: Exception | None = None

    def embed(self, texts, should_abandon=None):
        self.calls.append(list(texts))
        if self.raise_next is not None:
            exc, self.raise_next = self.raise_next, None
            raise exc
        return [[float(len(t))] * DIM for t in texts]


@pytest.fixture
def srv(monkeypatch):
    monkeypatch.setenv("VINV_EMBED_MAX_ITEMS", "10")
    engine = StubEngine()
    server = EmbedderServer(("127.0.0.1", 0), engine)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    yield base, engine
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def _post(base: str, path: str, payload, raw: bytes | None = None):
    data = raw if raw is not None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base + path, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _get(base: str, path: str):
    try:
        with urllib.request.urlopen(base + path, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class TestEmbeddingsContract:
    @pytest.mark.parametrize("path", ["/v1/embeddings", "/embeddings"])
    def test_openai_shape_on_both_routes(self, srv, path):
        base, engine = srv
        status, body = _post(base, path, {"model": engine.model_name, "input": ["ab", "cdef"]})
        assert status == 200
        assert body["object"] == "list"
        assert body["model"] == engine.model_name
        assert [d["index"] for d in body["data"]] == [0, 1]
        assert all(d["object"] == "embedding" for d in body["data"])
        assert body["data"][0]["embedding"] == [2.0] * DIM
        assert body["data"][1]["embedding"] == [4.0] * DIM
        assert set(body["usage"]) == {"prompt_tokens", "total_tokens"}
        assert "warning" not in body

    def test_single_string_input(self, srv):
        base, _ = srv
        status, body = _post(base, "/v1/embeddings", {"input": "hello"})
        assert status == 200
        assert len(body["data"]) == 1

    def test_model_mismatch_rejected(self, srv):
        base, _engine = srv
        status, body = _post(
            base, "/v1/embeddings", {"model": "text-embedding-3-small", "input": ["x"]}
        )
        # A stale sidecar on the wrong model must not silently serve mismatched
        # vectors into a store labeled with the requested model — it 400s so the
        # caller restarts on the new model.
        assert status == 400
        assert body["error"]["type"] == "model_mismatch"
        assert "text-embedding-3-small" in body["error"]["message"]

    def test_no_prefix_added_server_side(self, srv):
        base, engine = srv
        _post(base, "/v1/embeddings", {"input": ["raw text"]})
        assert engine.calls[-1] == ["raw text"]


class TestHealth:
    def test_health_shape(self, srv):
        base, engine = srv
        status, body = _get(base, "/health")
        assert status == 200
        assert body == {
            "status": "ok",
            "model": engine.model_name,
            "device": "cpu",
            "queue_depth": 0,
            "warming": False,
        }

    def test_health_reports_warming_engine(self, srv):
        base, engine = srv
        engine.warming = True
        assert _get(base, "/health")[1]["warming"] is True
        engine.warming = False
        assert _get(base, "/health")[1]["warming"] is False


class TestErrorPaths:
    def test_bad_json_400(self, srv):
        base, _ = srv
        status, body = _post(base, "/v1/embeddings", None, raw=b"{not json")
        assert status == 400
        assert body["error"]["type"] == "invalid_request_error"

    def test_missing_input_400(self, srv):
        base, _ = srv
        assert _post(base, "/v1/embeddings", {"model": "m"})[0] == 400

    def test_empty_input_400(self, srv):
        base, _ = srv
        assert _post(base, "/v1/embeddings", {"input": []})[0] == 400

    def test_non_string_items_400(self, srv):
        base, _ = srv
        assert _post(base, "/v1/embeddings", {"input": ["ok", 42]})[0] == 400

    def test_non_object_body_400(self, srv):
        base, _ = srv
        assert _post(base, "/v1/embeddings", ["not", "an", "object"])[0] == 400

    def test_oversized_input_413(self, srv):
        base, _ = srv
        status, body = _post(base, "/v1/embeddings", {"input": ["x"] * 11})  # max is 10
        assert status == 413
        assert body["error"]["type"] == "payload_too_large"

    def test_unknown_route_404(self, srv):
        base, _ = srv
        assert _post(base, "/v2/embeddings", {"input": ["x"]})[0] == 404

    def test_get_on_embeddings_405(self, srv):
        base, _ = srv
        assert _get(base, "/v1/embeddings")[0] == 405

    def test_engine_error_returns_500_and_server_survives(self, srv):
        base, engine = srv
        engine.raise_next = RuntimeError("model exploded")
        status, body = _post(base, "/v1/embeddings", {"input": ["x"]})
        assert status == 500
        assert body["error"]["type"] == "server_error"
        # server must never die on a bad request: next request succeeds
        status, body = _post(base, "/v1/embeddings", {"input": ["x"]})
        assert status == 200
        assert len(body["data"]) == 1


class TestLocalhostBind:
    def test_default_bind_host_is_loopback(self):
        assert server_mod.config.BIND_HOST == "127.0.0.1"


# ---------------------------------------------------------------------------
# Dead-client detection: never burn an encode for a client that already hung up.
# Exercised at the handler level with a fake connection object (the stdlib
# handler owns self.connection, so that is what production code peeks at).
# ---------------------------------------------------------------------------


class FakeConn:
    """Scripted socket: each _client_disconnected() call pops one behavior.

    A behavior is either bytes to return from recv() or an exception to raise.
    Records blocking-mode toggles and timeout restoration.
    """

    def __init__(self, behaviors, timeout=17.5):
        self.behaviors = list(behaviors)
        self.timeout = timeout
        self.blocking_calls: list[bool] = []
        self.restored_timeouts: list = []

    def gettimeout(self):
        return self.timeout

    def setblocking(self, flag):
        self.blocking_calls.append(flag)

    def settimeout(self, value):
        self.restored_timeouts.append(value)

    def recv(self, n, flags=0):
        behavior = self.behaviors.pop(0)
        if isinstance(behavior, BaseException):
            raise behavior
        return behavior


class FakeQueueServer:
    """Just enough EmbedderServer surface for _handle_embeddings."""

    def __init__(self, engine, full=False):
        self.engine = engine
        self.max_items = 10
        self.max_body = 1 << 20
        self.max_queue = 32
        self.full = full
        self.enter_calls = 0
        self.exit_calls = 0

    def _enter_queue(self):
        if self.full:
            return False
        self.enter_calls += 1
        return True

    def _exit_queue(self):
        self.exit_calls += 1


def _bare_handler(conn, engine=None, body: bytes | None = None, full=False):
    """Build a _Handler without socket plumbing; record _send_json calls."""
    import io

    h = server_mod._Handler.__new__(server_mod._Handler)
    h.connection = conn
    h.path = "/v1/embeddings"
    if body is not None:
        h.headers = {"Content-Length": str(len(body))}
        h.rfile = io.BytesIO(body)
    if engine is not None:
        h.server = FakeQueueServer(engine, full=full)
    h.sent: list[tuple[int, dict]] = []
    h.sent_headers: list = []
    # Whether each reply asked to hang up — the shed paths must NOT, so the
    # client's retry can reuse the connection it already has.
    h.sent_close: list[bool] = []

    def _record(code, payload, headers=None, close=False):
        h.sent.append((code, payload))
        h.sent_headers.append(headers)
        h.sent_close.append(close)

    h._send_json = _record
    return h


class TestClientDisconnected:
    def test_peer_closed_returns_true(self):
        conn = FakeConn([b""])
        h = _bare_handler(conn)
        assert h._client_disconnected() is True
        # Non-blocking peek, then the original timeout restored.
        assert conn.blocking_calls == [False]
        assert conn.restored_timeouts == [17.5]

    def test_blockingioerror_means_alive(self):
        h = _bare_handler(FakeConn([BlockingIOError()]))
        assert h._client_disconnected() is False

    def test_buffered_data_means_alive(self):
        h = _bare_handler(FakeConn([b"x"]))
        assert h._client_disconnected() is False

    def test_check_error_assumes_alive(self):
        h = _bare_handler(FakeConn([OSError("weird socket state")]))
        assert h._client_disconnected() is False

    def test_missing_connection_assumes_alive(self):
        h = server_mod._Handler.__new__(server_mod._Handler)
        h.connection = None
        assert h._client_disconnected() is False


class TestSkipEncodeForDeadClient:
    def _body(self):
        return json.dumps({"input": ["hello"]}).encode()

    def test_skips_encode_when_client_gone_before_engine(self, caplog):
        engine = StubEngine()
        body = self._body()
        h = _bare_handler(FakeConn([b""]), engine=engine, body=body)
        with caplog.at_level("INFO", logger="vinv_embedder"):
            h._handle_embeddings()
        assert engine.calls == []  # engine never touched
        assert h.sent == []  # nothing written to a dead client
        assert h.server.enter_calls == 0
        assert any("client disconnected — skipping encode" in r.message for r in caplog.records)

    def test_drops_response_when_client_dies_during_encode(self, caplog):
        engine = StubEngine()
        body = self._body()
        # Alive at the pre-check, gone at the post-encode check.
        h = _bare_handler(FakeConn([BlockingIOError(), b""]), engine=engine, body=body)
        with caplog.at_level("INFO", logger="vinv_embedder"):
            h._handle_embeddings()
        assert len(engine.calls) == 1  # encode ran (client died mid-encode)
        assert h.sent == []  # but the response write was skipped
        assert h.server.exit_calls == 1  # queue depth still balanced
        assert any("skipping response write" in r.message for r in caplog.records)

    def test_live_client_end_to_end_unaffected(self):
        engine = StubEngine()
        body = self._body()
        h = _bare_handler(
            FakeConn([BlockingIOError(), BlockingIOError()]), engine=engine, body=body
        )
        h._handle_embeddings()
        assert len(engine.calls) == 1
        assert len(h.sent) == 1
        code, payload = h.sent[0]
        assert code == 200
        assert payload["data"][0]["embedding"] == [5.0] * DIM  # len("hello")


# ---------------------------------------------------------------------------
# Bounded queue: beyond VINV_EMBED_MAX_QUEUE waiting requests the server sheds
# load with 503 + Retry-After instead of piling threads onto the encode lock.
# ---------------------------------------------------------------------------


class TestQueueBound:
    def _body(self):
        return json.dumps({"input": ["hello"]}).encode()

    def test_full_queue_returns_503_with_retry_after(self):
        engine = StubEngine()
        h = _bare_handler(
            FakeConn([BlockingIOError()]), engine=engine, body=self._body(), full=True
        )
        h._handle_embeddings()
        assert engine.calls == []  # engine never touched
        assert len(h.sent) == 1
        code, payload = h.sent[0]
        assert code == 503
        assert payload["error"]["type"] == "server_overloaded"
        assert h.sent_headers[0] == {"Retry-After": str(server_mod.RETRY_AFTER_S)}
        assert h.server.exit_calls == 0  # never entered, never exited

    def test_queue_bound_end_to_end_503(self, monkeypatch):
        """Real server, max_queue=1: a second concurrent request is shed."""
        monkeypatch.setenv("VINV_EMBED_MAX_QUEUE", "1")

        release = threading.Event()
        started = threading.Event()

        class BlockingEngine(StubEngine):
            def embed(self, texts, should_abandon=None):
                started.set()
                assert release.wait(timeout=10)
                return super().embed(texts, should_abandon=should_abandon)

        engine = BlockingEngine()
        server = EmbedderServer(("127.0.0.1", 0), engine)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            first: list = []
            t1 = threading.Thread(
                target=lambda: first.append(_post(base, "/v1/embeddings", {"input": ["x"]}))
            )
            t1.start()
            assert started.wait(timeout=10)  # first request occupies the queue slot
            req = urllib.request.Request(
                base + "/v1/embeddings",
                data=json.dumps({"input": ["y"]}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with pytest.raises(urllib.error.HTTPError) as ei:
                urllib.request.urlopen(req, timeout=10)
            assert ei.value.code == 503
            assert ei.value.headers.get("Retry-After") == str(server_mod.RETRY_AFTER_S)
            assert json.loads(ei.value.read())["error"]["type"] == "server_overloaded"
            release.set()
            t1.join(timeout=10)
            assert first and first[0][0] == 200  # the occupying request completed fine
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_abandoned_request_sends_nothing_and_balances_queue(self, caplog):
        """EncodeAbandoned from the engine: no response write, queue exited."""
        from vinv_embedder.engine import EncodeAbandoned

        engine = StubEngine()
        engine.raise_next = EncodeAbandoned("client went away")
        h = _bare_handler(FakeConn([BlockingIOError()]), engine=engine, body=self._body())
        with caplog.at_level("INFO", logger="vinv_embedder"):
            h._handle_embeddings()
        assert h.sent == []  # nothing written to a dead client
        assert h.server.enter_calls == 1
        assert h.server.exit_calls == 1  # queue depth still balanced
        assert any("request abandoned" in r.message for r in caplog.records)

    def test_handler_passes_liveness_hook_to_engine(self):
        """The engine receives a should_abandon hook bound to the handler."""
        seen: dict = {}

        class HookEngine(StubEngine):
            def embed(self, texts, should_abandon=None):
                seen["hook"] = should_abandon
                return super().embed(texts, should_abandon=should_abandon)

        engine = HookEngine()
        h = _bare_handler(
            FakeConn([BlockingIOError(), BlockingIOError()]), engine=engine, body=self._body()
        )
        h._handle_embeddings()
        assert callable(seen["hook"])

    def test_health_reflects_queue_counter(self, srv):
        base, _ = srv
        assert _get(base, "/health")[1]["queue_depth"] == 0


# ---------------------------------------------------------------------------
# Token estimation: exact for small batches, bounded + extrapolated for big
# ones (p99 907ms measured estimating full payloads before the cap).
# ---------------------------------------------------------------------------


class TestEstimateTokens:
    def test_exact_for_small_batches(self):
        assert server_mod._estimate_tokens(["abcd", "ab"]) == 2  # 1 + 1
        assert server_mod._estimate_tokens(["x" * 40]) == 10

    def test_extrapolates_beyond_sample(self):
        n = 5 * server_mod._TOKEN_SAMPLE_ITEMS
        texts = ["x" * 8] * n  # 2 tokens each
        assert server_mod._estimate_tokens(texts) == 2 * n

    def test_work_is_bounded_to_sample(self):
        len_calls = [0]

        class CountingStr(str):
            def __len__(self):
                len_calls[0] += 1
                return str.__len__(self)

        texts = [CountingStr("x" * 8) for _ in range(500)]
        server_mod._estimate_tokens(texts)
        assert len_calls[0] == server_mod._TOKEN_SAMPLE_ITEMS  # only the sample scanned


# ---------------------------------------------------------------------------
# Keep-alive framing on the shed paths. The server speaks HTTP/1.1, so an early
# error return that never reads the request body leaves it in the socket and the
# NEXT request on that connection gets parsed starting mid-JSON. The index
# engine retries 429/5xx and treats every other status as fatal, so the 503 it
# is supposed to ride out came back as a hard 400 on the retry — retrieval then
# failed for the entire (multi-minute, on CPU) model load rather than waiting.
# ---------------------------------------------------------------------------


class LoadingEngine(StubEngine):
    """An engine that has not finished loading — the warm-up window."""

    ready = False


def _read_response(sock) -> tuple[int, bytes]:
    """Reads exactly one HTTP response (status line + headers + framed body)."""
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    status = int(head.split(b"\r\n", 1)[0].split()[1])
    length = 0
    for line in head.split(b"\r\n")[1:]:
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-length":
            length = int(value.strip())
    while len(rest) < length:
        chunk = sock.recv(4096)
        if not chunk:
            break
        rest += chunk
    return status, rest[:length]


@pytest.fixture
def loading_srv():
    server = EmbedderServer(("127.0.0.1", 0), LoadingEngine())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


class TestKeepAliveFramingWhileLoading:
    def test_retry_on_a_reused_connection_still_gets_503(self, loading_srv):
        host, port = loading_srv
        body = json.dumps({"model": "m", "input": ["some query text"]}).encode()
        request = (
            b"POST /v1/embeddings HTTP/1.1\r\n"
            b"Host: %s\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: %d\r\n"
            b"\r\n%s" % (host.encode(), len(body), body)
        )
        with socket.create_connection((host, port), timeout=10) as sock:
            sock.sendall(request)
            first, _ = _read_response(sock)
            sock.sendall(request)  # the retry, on the SAME pooled connection
            second, payload = _read_response(sock)

        assert first == 503
        # The regression: an undrained body made this a 400 "Bad request
        # syntax", which the index engine classifies as fatal and never retries.
        assert second == 503, f"retry on a reused connection got {second}: {payload!r}"
        assert json.loads(payload)["error"]["code"] == 503

    def test_health_stays_usable_on_the_same_connection(self, loading_srv):
        host, port = loading_srv
        body = json.dumps({"model": "m", "input": ["q"]}).encode()
        with socket.create_connection((host, port), timeout=10) as sock:
            sock.sendall(
                b"POST /v1/embeddings HTTP/1.1\r\nHost: %s\r\n"
                b"Content-Type: application/json\r\nContent-Length: %d\r\n\r\n%s"
                % (host.encode(), len(body), body)
            )
            assert _read_response(sock)[0] == 503
            sock.sendall(b"GET /health HTTP/1.1\r\nHost: %s\r\n\r\n" % host.encode())
            status, payload = _read_response(sock)

        assert status == 503
        assert json.loads(payload)["status"] == "loading"
