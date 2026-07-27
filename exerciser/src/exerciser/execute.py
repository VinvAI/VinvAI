"""Execute one probe against the LIVE traced service (stdlib urllib).

Bounded concurrency 1 — traces must attribute cleanly, so probes are strictly
serial. Every request carries an ``X-Vinv-Exercise-Id`` header (so its spans can
be told apart from organic traffic) and is hard-deadlined. The response is
captured up to a cap for structural shape-hashing (the same
sorted-keys/value-types signature ``probeBaseline.ts`` uses, re-implemented here
so a Python profile and a TypeScript baseline agree on shape).
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

# Response-body capture cap for shape hashing — structure, not a transcript.
_BODY_CAP = 64 * 1024


@dataclass
class ProbeResult:
    status: int | None
    latency_ms: float
    body: Any  # parsed JSON when possible, else the raw text (capped)
    shape_hash: str
    error: str | None
    request_id: str | None
    content_type: str | None
    # Digest of the response VALUES (canonical JSON, or raw bytes). The shape
    # hash erases values by design; this keeps them, so a plausibly-shaped
    # wrong answer is detectable. Appended with a default so the positional
    # 7-arg construction sites stay valid.
    value_digest: str | None = None


def _fill_path(path: str, path_params: dict[str, Any]) -> str:
    """Substitute path params into ``{name}``/``<name>``/``:name`` tokens.

    Converter-prefixed forms (``{int:id}``, ``<int:id>``) are handled BEFORE the
    bare forms so the converter prefix cannot leak into the output.
    """
    import re as _re

    out = path
    for name, value in path_params.items():
        rep = urllib.parse.quote(str(value), safe="")
        esc = _re.escape(name)
        # Converter-prefixed first: {conv:name}, <conv:name>.
        out = _re.sub(r"\{[^{}:]+:" + esc + r"\}", rep, out)
        out = _re.sub(r"<[^<>:]+:" + esc + r">", rep, out)
        # Bare braces / angle brackets.
        out = out.replace(f"{{{name}}}", rep).replace(f"<{name}>", rep)
        # Flask ``/:name`` style — require a boundary so ``:id`` never eats
        # ``{int:id}`` (already handled above) or a longer name.
        out = _re.sub(r"(?<![\w:]):" + esc + r"(?![\w])", rep, out)
    return out


def _shape_signature(value: Any, depth: int = 0) -> str:
    """Structural signature of a JSON value (values erased) — mirrors
    probeBaseline.jsonShapeSignature so shape hashes match across engines."""
    if depth > 8:
        return "…"
    if value is None:
        return "null"
    if isinstance(value, list):
        shapes = sorted({_shape_signature(v, depth + 1) for v in value})
        return "[" + "|".join(shapes) + "]"
    if isinstance(value, dict):
        entries = [f"{k}:{_shape_signature(v, depth + 1)}" for k, v in sorted(value.items())]
        return "{" + ",".join(entries) + "}"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    return "string"


def response_value_digest(body_text: str, content_type: str | None) -> str | None:
    """Value-level digest of a response body (16 hex chars), or None when empty.

    JSON bodies digest their canonical form (sorted keys, minimal separators) so
    key order cannot alias two equal values; anything else digests raw bytes.
    Complements ``response_shape_hash``, which deliberately erases values.
    """
    if not body_text:
        return None
    looks_json = ("json" in (content_type or "")) or body_text.lstrip()[:1] in '[{"'
    if looks_json:
        try:
            canonical = json.dumps(json.loads(body_text), sort_keys=True, separators=(",", ":"))
            return "v:" + hashlib.sha256(canonical.encode()).hexdigest()[:16]
        except ValueError:
            pass
    return "raw:" + hashlib.sha256(body_text.encode()).hexdigest()[:16]


def response_shape_hash(body_text: str, content_type: str | None) -> str:
    if not body_text:
        return "empty"
    looks_json = ("json" in (content_type or "")) or body_text.lstrip()[:1] in '[{"'
    if looks_json:
        try:
            sig = _shape_signature(json.loads(body_text))
            return "json:" + hashlib.sha256(sig.encode()).hexdigest()[:16]
        except ValueError:
            pass
    klass = (content_type or "unknown").split(";")[0].strip() or "unknown"
    return "raw:" + klass


def execute_probe(
    base_url: str,
    method: str,
    path: str,
    *,
    body: Any = None,
    path_params: dict[str, Any] | None = None,
    query: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    content_type: str | None = None,
    exercise_id: str = "vinv-exercise",
    timeout_s: float = 10.0,
) -> ProbeResult:
    """Fire one probe and capture the outcome. Never raises — failures land in
    ``error`` with ``status=None``.

    ``content_type='form'`` sends the body as ``application/x-www-form-urlencoded``
    (OAuth2 password flows and other form endpoints need this); otherwise a dict
    body is sent as JSON.
    """
    filled = _fill_path(path, path_params or {})
    url = base_url.rstrip("/") + "/" + filled.lstrip("/")
    if query:
        qs = urllib.parse.urlencode({k: str(v) for k, v in query.items()})
        url = f"{url}?{qs}"

    req_headers = {"X-Vinv-Exercise-Id": exercise_id, "Accept": "application/json"}
    if headers:
        req_headers.update(headers)

    data: bytes | None = None
    if body is not None and method.upper() not in ("GET", "HEAD"):
        is_form = content_type == "form" or (content_type or "").startswith(
            "application/x-www-form-urlencoded"
        )
        if is_form and isinstance(body, dict):
            data = urllib.parse.urlencode({k: str(v) for k, v in body.items()}).encode("utf-8")
            req_headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        else:
            data = json.dumps(body).encode("utf-8")
            req_headers.setdefault("Content-Type", "application/json")

    req = urllib.request.Request(url, data=data, method=method.upper(), headers=req_headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310 (local trusted)
            raw = resp.read(_BODY_CAP)
            ctype = resp.headers.get("Content-Type")
            rid = resp.headers.get("X-Request-Id")
            text = raw.decode("utf-8", errors="replace")
            return _result(resp.status, started, text, ctype, rid, None)
    except urllib.error.HTTPError as exc:  # 4xx/5xx are outcomes, not errors
        raw = exc.read(_BODY_CAP) if hasattr(exc, "read") else b""
        text = raw.decode("utf-8", errors="replace")
        ctype = exc.headers.get("Content-Type") if exc.headers else None
        rid = exc.headers.get("X-Request-Id") if exc.headers else None
        return _result(exc.code, started, text, ctype, rid, None)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        latency = (time.monotonic() - started) * 1000.0
        return ProbeResult(None, round(latency, 3), None, "empty", str(exc), None, None)


def _result(
    status: int,
    started: float,
    text: str,
    ctype: str | None,
    rid: str | None,
    err: str | None,
) -> ProbeResult:
    latency = (time.monotonic() - started) * 1000.0
    parsed: Any = None
    try:
        parsed = json.loads(text) if text else None
    except ValueError:
        parsed = None
    return ProbeResult(
        status=status,
        latency_ms=round(latency, 3),
        body=parsed,
        shape_hash=response_shape_hash(text, ctype),
        error=err,
        request_id=rid,
        content_type=ctype,
        value_digest=response_value_digest(text, ctype),
    )
