"""Deterministic, spec-driven authentication bootstrap for the authed sweep.

The authenticated sweep is where the highest-value bugs live — a crash reachable
only once you hold a token (the ``skip=-1`` under auth, the duplicate-email 500).
It needs a bearer, and until now the only source was a harness-authored login
scenario: a FIRST pass, before any LLM dispatch, had no token and skipped auth
entirely.

This module earns a token GENERICALLY, hardcoding no ``/login`` path:

* the token endpoint is the OpenAPI OAuth2 **password** flow
  (``components.securitySchemes`` → ``flows.password.tokenUrl``, RFC 6749 §4.3),
  resolved against the real mounted paths so a prefix-less ``tokenUrl`` still
  hits ``/api/v1/login/access-token``;
* credentials come from an explicit override
  (``VINV_EXERCISE_USERNAME`` / ``VINV_EXERCISE_PASSWORD``) or, failing that,
  from registering a throwaway user at an OPEN registration endpoint discovered
  in the same spec — the email/password are schema-generated deterministically,
  so re-runs reuse the same account.

When nothing yields a token the caller keeps what it had (harness scenarios, or
anonymous-only probing). Every step is best-effort and never raises.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

from .execute import ProbeResult, execute_probe
from .openapi import _body_schema_and_type, discover_token_endpoint
from .schema import generate_value

_log = logging.getLogger(__name__)

ProbeFn = Callable[..., ProbeResult]

# Env override — the fully generic, zero-discovery contract (mirrors how
# Schemathesis/RESTler take auth from the operator).
_ENV_USERNAME = "VINV_EXERCISE_USERNAME"
_ENV_PASSWORD = "VINV_EXERCISE_PASSWORD"

# Response keys a token can live under, most standard first. Checked
# case-insensitively and one level into nested objects (``{"data": {...}}``).
_TOKEN_KEYS = ("access_token", "accesstoken", "token", "access-token", "id_token", "jwt")

# Field-name families for spotting an open registration endpoint's body.
_EMAILISH = ("email", "e_mail", "username", "user_name", "login")
_PASSWORDISH = ("password", "passwd", "pwd", "pass")


def extract_bearer(body: Any) -> str | None:
    """Pull a bearer token out of a token response, or None.

    Case-insensitive over the standard key names, and one level into a nested
    envelope (``{"data": {"access_token": …}}``) — no single key is assumed.
    """
    if not isinstance(body, dict):
        return None
    lower = {str(k).lower(): v for k, v in body.items()}
    for key in _TOKEN_KEYS:
        val = lower.get(key)
        if isinstance(val, str) and val:
            return val
    for val in body.values():
        if isinstance(val, dict):
            nested = extract_bearer(val)
            if nested:
                return nested
    return None


def token_request_form(username: str, password: str) -> dict[str, str]:
    """The RFC 6749 §4.3 resource-owner password-credentials grant body."""
    return {"grant_type": "password", "username": username, "password": password}


def resolve_token_path(token_url: str, spec: dict[str, Any] | None) -> str:
    """The real request path for a declared ``tokenUrl``.

    FastAPI (and others) frequently declare a MOUNT-RELATIVE ``tokenUrl``
    (``login/access-token``) that omits the ``API_V1_STR`` prefix the route is
    actually served under. Rather than trust the string, match it against the
    spec's real ``paths`` by suffix so ``login/access-token`` resolves to
    ``/api/v1/login/access-token``. Absolute URLs keep their path; a
    genuinely-rooted path is used as-is.
    """
    if token_url.startswith(("http://", "https://")):
        split = urlsplit(token_url)
        return split.path + (f"?{split.query}" if split.query else "")
    paths = list((spec or {}).get("paths", {}) or {})
    norm = token_url.strip("/")
    exact = [p for p in paths if p.strip("/") == norm or p.strip("/").endswith("/" + norm)]
    if exact:
        return min(exact, key=len)
    tail = norm.rsplit("/", 1)[-1]
    suffix = [p for p in paths if p.strip("/").rsplit("/", 1)[-1] == tail]
    if suffix:
        return min(suffix, key=len)
    return token_url if token_url.startswith("/") else "/" + token_url


def discover_registration_endpoint(spec: dict[str, Any] | None) -> dict[str, Any] | None:
    """An OPEN (unauthenticated) POST that creates a credentialable user, or None.

    Generic: a POST whose request body declares BOTH an email/username-like and
    a password-like property, and which is not itself protected (we cannot
    register if registration needs a token). Returns ``{"path", "body_schema"}``.
    """
    paths = (spec or {}).get("paths")
    if not isinstance(paths, dict):
        return None
    root_secured = isinstance((spec or {}).get("security"), list) and len(
        (spec or {}).get("security")
    )
    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        op = item.get("post")
        if not isinstance(op, dict):
            continue
        sec = op.get("security")
        secured = (len(sec) > 0) if isinstance(sec, list) else bool(root_secured)
        if secured:
            continue
        body, media = _body_schema_and_type(op, spec or {})
        # The OAuth2 token endpoint also carries username+password, but it is
        # form-encoded; a registration endpoint takes JSON. Skipping form bodies
        # cleanly excludes the login endpoint without naming any path.
        if media == "application/x-www-form-urlencoded":
            continue
        props = body.get("properties") if isinstance(body, dict) else None
        if not isinstance(props, dict):
            continue
        names = [str(p).lower() for p in props]
        has_email = any(any(e in n for e in _EMAILISH) for n in names)
        has_password = any(any(pw in n for pw in _PASSWORDISH) for n in names)
        if has_email and has_password:
            return {"path": str(path), "body_schema": body}
    return None


def _field_of(body: dict[str, Any], families: tuple[str, ...]) -> str | None:
    """The generated value of the first field whose name matches ``families``."""
    for key, val in body.items():
        low = str(key).lower()
        if any(f in low for f in families) and isinstance(val, str):
            return val
    return None


def _register_user(
    reg: dict[str, Any],
    base_url: str,
    probe_fn: ProbeFn,
    exercise_id: str,
    seed: int,
) -> tuple[str, str] | None:
    """Create a throwaway user and return its (username, password), or None.

    The body is schema-generated deterministically, so the same email/password
    recur across runs — a 2xx creates the account and a 4xx (it already exists
    from a prior run) is equally fine, because the credentials are identical
    either way and the token call is what ultimately validates them.
    """
    body = generate_value(reg["body_schema"], seed, "valid")
    if not isinstance(body, dict):
        return None
    email = _field_of(body, _EMAILISH)
    password = _field_of(body, _PASSWORDISH)
    if not email or not password:
        return None
    res = probe_fn(base_url, "POST", reg["path"], body=body, exercise_id=exercise_id)
    if res.status is None:
        return None
    # 2xx = created; 400/409 = already exists (deterministic body → same user).
    if 200 <= res.status < 300 or res.status in (400, 409, 422):
        return (email, password)
    return None


def _credentials(
    spec: dict[str, Any],
    base_url: str,
    probe_fn: ProbeFn,
    exercise_id: str,
    seed: int,
) -> tuple[str, str] | None:
    """Credentials to log in with: explicit override first, then registration."""
    user = os.environ.get(_ENV_USERNAME)
    pwd = os.environ.get(_ENV_PASSWORD)
    if user and pwd:
        return (user, pwd)
    reg = discover_registration_endpoint(spec)
    if reg:
        return _register_user(reg, base_url, probe_fn, exercise_id, seed)
    return None


def bootstrap_auth_headers(
    base_url: str,
    spec: dict[str, Any] | None,
    *,
    probe_fn: ProbeFn = execute_probe,
    exercise_id: str = "vinv-exercise",
    seed: int = 1729,
    logger: logging.Logger | None = None,
) -> list[dict[str, str]]:
    """A bearer ``Authorization`` header obtained purely from the spec, or ``[]``.

    Best-effort and side-effect-light: no token endpoint declared, no obtainable
    credentials, or a non-2xx token response all yield ``[]`` so the caller
    falls back cleanly. Never raises.
    """
    log = logger or _log
    if not isinstance(spec, dict):
        return []
    token = discover_token_endpoint(spec)
    if not token:
        return []
    creds = _credentials(spec, base_url, probe_fn, exercise_id, seed)
    if not creds:
        log.info("auth bootstrap: token endpoint found but no obtainable credentials")
        return []
    username, password = creds
    token_path = resolve_token_path(token["token_url"], spec)
    try:
        res = probe_fn(
            base_url,
            "POST",
            token_path,
            body=token_request_form(username, password),
            content_type="form",
            exercise_id=exercise_id,
        )
    except Exception as exc:  # noqa: BLE001 - bootstrap must never break the run
        log.debug("auth bootstrap: token request raised: %s", exc)
        return []
    if res.status and 200 <= res.status < 300:
        bearer = extract_bearer(res.body)
        if bearer:
            log.info("auth bootstrap: acquired a bearer via %s", token_path)
            return [{"Authorization": f"Bearer {bearer}"}]
    log.info("auth bootstrap: token request did not yield a bearer (status=%s)", res.status)
    return []
