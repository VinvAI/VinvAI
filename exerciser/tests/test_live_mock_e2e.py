"""End-to-end exercise against a MOCK service — no Docker, no Postgres.

A tiny stdlib HTTP server serves a FastAPI-shaped OpenAPI spec (OAuth2 password
flow, an open registration endpoint, protected routes) and reproduces the four
bug classes the generic oracles are meant to catch:

* B1 — a bare ``email: str`` (no declared format): a malformed email 500s.
* B2 — a protected create that answers an ANONYMOUS request with a 2xx.
* B3 — a duplicate email on create 500s.
* B4 — a protected ``GET`` with an unbounded ``skip`` 500s on ``skip=-1``.

The REAL plan + run drive it over HTTP via the real ``execute_probe``, so this
exercises the whole chain: name-based format inference (sends a bad email),
implicit-domain negatives (sends ``skip=-1``), spec-driven auth bootstrap
(registers → OAuth2 token → authed sweep), and the access-control oracle.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest

from exerciser.plan import build_plan
from exerciser.run import run_exercise

SPEC = {
    "openapi": "3.1.0",
    "paths": {
        "/login/access-token": {
            "post": {
                "security": [],
                "requestBody": {
                    "content": {
                        "application/x-www-form-urlencoded": {
                            "schema": {
                                "type": "object",
                                "required": ["username", "password"],
                                "properties": {
                                    "username": {"type": "string"},
                                    "password": {"type": "string"},
                                },
                            }
                        }
                    }
                },
            }
        },
        "/signup": {
            "post": {
                "security": [],
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["email", "password"],
                                "properties": {
                                    "email": {"type": "string"},
                                    "password": {"type": "string", "minLength": 8},
                                },
                            }
                        }
                    }
                },
            }
        },
        "/items/": {
            "get": {
                "parameters": [
                    {"name": "skip", "in": "query", "schema": {"type": "integer"}},
                    {"name": "limit", "in": "query", "schema": {"type": "integer"}},
                ]
            }
        },
        "/private/users/": {
            "post": {
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["email", "password"],
                                "properties": {
                                    "email": {"type": "string"},  # B1: bare str, no format
                                    "password": {"type": "string", "minLength": 8},
                                },
                            }
                        }
                    }
                }
            }
        },
    },
    "components": {
        "securitySchemes": {
            "OAuth2PasswordBearer": {
                "type": "oauth2",
                "flows": {"password": {"tokenUrl": "login/access-token", "scopes": {}}},
            }
        }
    },
    "security": [{"OAuth2PasswordBearer": []}],
}


class _Handler(BaseHTTPRequestHandler):
    seen_emails: set[str] = set()

    def log_message(self, *a):  # noqa: ANN002, D102 - silence the test server
        pass

    def _send(self, code: int, body: dict | list) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):  # noqa: N802
        parts = urlsplit(self.path)
        path = parts.path
        if path.rstrip("/") in ("/openapi.json",) or path == "/openapi.json":
            self._send(200, SPEC)
            return
        if path.rstrip("/") == "/items":
            if "bearer" not in (self.headers.get("Authorization") or "").lower():
                self._send(401, {"detail": "Not authenticated"})
                return
            skip = (parse_qs(parts.query).get("skip") or ["0"])[0]
            try:
                if int(skip) < 0:  # B4: negative offset crashes
                    self._send(500, {"detail": "internal error: negative skip"})
                    return
            except ValueError:
                self._send(422, {"detail": "bad int"})
                return
            self._send(200, [])
            return
        self._send(404, {"detail": "not found"})

    def do_POST(self):  # noqa: N802
        path = urlsplit(self.path).path.rstrip("/")
        raw = self._read_body()
        if path == "/login/access-token":
            self._send(200, {"access_token": "mock-token", "token_type": "bearer"})
            return
        if path == "/signup":
            self._send(200, {"id": 1})
            return
        if path == "/private/users":
            # NOTE: no auth GUARD here — B2 (the spec marks it protected, but the
            # handler serves anonymous requests too). Body bugs still fire.
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                body = {}
            email = str(body.get("email", ""))
            authed = "bearer" in (self.headers.get("Authorization") or "").lower()
            if "@" not in email:  # B1: malformed email 500s (any caller)
                self._send(500, {"detail": "internal error serializing email"})
                return
            if authed and email in self.seen_emails:  # B3: duplicate under auth 500s
                self._send(500, {"detail": "IntegrityError"})
                return
            if authed:
                self.seen_emails.add(email)
            self._send(200, {"id": 1})  # anonymous valid always 200 = B2
            return
        self._send(404, {"detail": "not found"})


@pytest.fixture()
def mock_service():
    _Handler.seen_emails = set()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def _no_coverage(*_a, **_k):
    return {"covered_ids": set()}


def test_exercise_finds_the_bug_classes_against_a_mock(mock_service, tmp_path, monkeypatch):
    monkeypatch.delenv("VINV_EXERCISE_USERNAME", raising=False)
    monkeypatch.delenv("VINV_EXERCISE_PASSWORD", raising=False)
    repo = tmp_path
    (repo / ".vinv").mkdir()

    build_plan(repo, base_url=mock_service)
    summary = run_exercise(
        repo,
        base_url=mock_service,
        budget=60,
        rounds=1,
        settle_s=0.0,
        coverage_fn=_no_coverage,
    )

    assert summary["status"] in ("ok", "completed", None) or "endpoints" in summary
    issues = json.loads((repo / ".vinv" / "exercise" / "issues.json").read_text())
    kinds = {c["kind"] for c in issues.get("clusters", issues.get("issues", []))}
    paths = {c.get("path") for c in issues.get("clusters", issues.get("issues", []))}

    print(
        f"\n[mock-e2e] auth_credential_sets={summary.get('auth_credential_sets')} "
        f"auth_sweep_probes={summary.get('auth_sweep_probes')} "
        f"kinds={sorted(kinds)} paths={sorted(p for p in paths if p)}"
    )
    # Auth was bootstrapped from the OpenAPI security scheme (no scenario, no env).
    assert summary.get("auth_credential_sets", 0) >= 1
    # B2 — anonymous 2xx on a protected create → broken-access-control.
    assert "broken-access-control" in kinds
    # B1/B3/B4 — the create and the negative-skip GET 500 → server-error.
    assert "server-error" in kinds
    assert any(p and "private/users" in p for p in paths)
