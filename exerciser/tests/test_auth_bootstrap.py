"""Spec-driven auth bootstrap: token discovery, path resolution, registration."""

from __future__ import annotations

from exerciser.auth import (
    bootstrap_auth_headers,
    discover_registration_endpoint,
    extract_bearer,
    resolve_token_path,
    token_request_form,
)
from exerciser.execute import ProbeResult
from exerciser.openapi import discover_token_endpoint

# A minimal FastAPI-shaped spec: OAuth2 password flow with a MOUNT-RELATIVE
# tokenUrl, an open registration POST, and a protected POST.
SPEC = {
    "paths": {
        "/api/v1/login/access-token": {
            "post": {
                "security": [],
                "requestBody": {
                    "content": {
                        "application/x-www-form-urlencoded": {
                            "schema": {
                                "type": "object",
                                "properties": {"username": {}, "password": {}},
                            }
                        }
                    }
                },
            }
        },
        "/api/v1/users/signup": {
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
        "/api/v1/private/users/": {"post": {}},  # protected (inherits root security)
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


def test_discover_token_endpoint_reads_password_flow():
    td = discover_token_endpoint(SPEC)
    assert td and td["token_url"] == "login/access-token"


def test_discover_token_endpoint_none_without_oauth2():
    assert (
        discover_token_endpoint({"components": {"securitySchemes": {"X": {"type": "http"}}}})
        is None
    )
    assert discover_token_endpoint({}) is None


def test_resolve_token_path_recovers_mount_prefix():
    # A prefix-less tokenUrl resolves to the real mounted path by suffix match.
    assert resolve_token_path("login/access-token", SPEC) == "/api/v1/login/access-token"
    # An absolute URL keeps only its path.
    assert (
        resolve_token_path("http://h/api/v1/login/access-token", SPEC)
        == "/api/v1/login/access-token"
    )
    # An already-rooted path with no spec match is used as-is.
    assert resolve_token_path("/auth/token", {"paths": {}}) == "/auth/token"


def test_extract_bearer_variants():
    assert extract_bearer({"access_token": "abc"}) == "abc"
    assert extract_bearer({"token": "xyz"}) == "xyz"
    assert extract_bearer({"data": {"access_token": "nested"}}) == "nested"
    assert extract_bearer({"nope": 1}) is None
    assert extract_bearer("not-a-dict") is None


def test_token_request_form_is_rfc6749_password_grant():
    assert token_request_form("u", "p") == {
        "grant_type": "password",
        "username": "u",
        "password": "p",
    }


def test_discover_registration_endpoint_finds_open_user_create():
    reg = discover_registration_endpoint(SPEC)
    assert reg and reg["path"] == "/api/v1/users/signup"
    # A spec with no open email+password POST has none.
    assert (
        discover_registration_endpoint({"paths": {"/x": {"post": {"security": [{"a": []}]}}}})
        is None
    )


def _probe_factory():
    """A fake probe_fn: registration 200, token 200 with a bearer, else 404."""
    calls: list[tuple[str, str]] = []

    def probe(base_url, method, path, **kw):  # noqa: ANN001, ANN003
        calls.append((method, path))
        if path.endswith("/users/signup"):
            return ProbeResult(200, 1.0, {"id": 1}, "h", None, None, "application/json")
        if path.endswith("/login/access-token"):
            assert kw.get("content_type") == "form"  # OAuth2 password is form-encoded
            body = kw.get("body") or {}
            assert body.get("grant_type") == "password"
            return ProbeResult(
                200,
                1.0,
                {"access_token": "tok-123", "token_type": "bearer"},
                "h",
                None,
                None,
                "application/json",
            )
        return ProbeResult(404, 1.0, {}, "h", None, None, "application/json")

    return probe, calls


def test_bootstrap_registers_then_logs_in(monkeypatch):
    monkeypatch.delenv("VINV_EXERCISE_USERNAME", raising=False)
    monkeypatch.delenv("VINV_EXERCISE_PASSWORD", raising=False)
    probe, calls = _probe_factory()
    headers = bootstrap_auth_headers("http://h", SPEC, probe_fn=probe)
    assert headers == [{"Authorization": "Bearer tok-123"}]
    # It registered before requesting the token, and hit the mounted token path.
    assert ("POST", "/api/v1/users/signup") in calls
    assert ("POST", "/api/v1/login/access-token") in calls


def test_bootstrap_uses_env_credentials_without_registering(monkeypatch):
    monkeypatch.setenv("VINV_EXERCISE_USERNAME", "admin@x.com")
    monkeypatch.setenv("VINV_EXERCISE_PASSWORD", "secret123")
    probe, calls = _probe_factory()
    headers = bootstrap_auth_headers("http://h", SPEC, probe_fn=probe)
    assert headers == [{"Authorization": "Bearer tok-123"}]
    # Env creds → no registration call.
    assert ("POST", "/api/v1/users/signup") not in calls


def test_bootstrap_returns_empty_without_token_endpoint():
    assert bootstrap_auth_headers("http://h", {"paths": {}}, probe_fn=_probe_factory()[0]) == []
    assert bootstrap_auth_headers("http://h", None) == []


def test_anonymous_2xx_on_protected_clusters_as_broken_access_control():
    from exerciser.issues import cluster_failures

    rows = [
        # A protected endpoint that served an anonymous request — the violation.
        {
            "status": 200,
            "api_id": "post_private_users",
            "method": "POST",
            "path": "/api/v1/private/users/",
            "access_control_violation": True,
        },
        # A protected endpoint that correctly rejected anonymous — not returned by
        # the sweep, but even if present (no flag) it must never cluster.
        {"status": 401, "api_id": "get_me", "method": "GET", "path": "/api/v1/users/me"},
    ]
    clusters = cluster_failures(rows)
    assert len(clusters) == 1
    assert clusters[0].kind == "broken-access-control"
    assert clusters[0].path == "/api/v1/private/users/"
