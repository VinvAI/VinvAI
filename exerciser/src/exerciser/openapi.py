"""Live-service OpenAPI discovery + apis.json fallback → a unified endpoint model.

The plan needs, per endpoint: the REAL runtime path (with the mount prefix the
static ``apis.json`` cannot always resolve — e.g. FastAPI's ``settings.API_V1_STR``
is not a literal), the HTTP method, the request-body JSON schema, path/query
parameter schemas, and the handler symbol (for coverage joining). Two sources,
best-first:

1. **Live OpenAPI** (``GET <base_url>/openapi.json`` and common variants). FastAPI
   serves a full JSON-schema spec with real paths, ``$ref``-resolved bodies, and
   parameter definitions. This is authoritative for shapes and the mount prefix.
2. **apis.json** (identification's deterministic catalog) — always available; used
   to fill handlers, to enumerate endpoints when the service is not up at plan
   time, and to reconcile OpenAPI operations back to handler symbols.

The two are joined on ``(method, path-suffix)`` so an OpenAPI operation keeps the
handler symbol identification attributed to it — coverage joining is by handler.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

_log = logging.getLogger(__name__)

# Endpoints that are never worth exercising as behavioural probes (they are the
# spec/doc surface itself, not application behaviour).
_SKIP_PATH_SUFFIXES = ("/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect")


@dataclass
class Endpoint:
    """One exercisable endpoint, reconciled across OpenAPI + apis.json."""

    api_id: str
    method: str
    path: str  # the REAL runtime path (mount prefix included when known)
    handler: str | None
    body_schema: dict[str, Any] | None = None
    param_schemas: list[dict[str, Any]] = field(default_factory=list)
    source: str = "apis"  # "openapi" | "apis"
    needs_semantics: bool = False
    requires_auth: bool = False
    # How the body must be encoded on the wire: "form" for
    # application/x-www-form-urlencoded, None for JSON (the default). Without
    # this field the media type discovered by `_body_schema_and_type` had
    # nowhere to live, so form-only endpoints were JSON-encoded and 422'd
    # forever at zero coverage.
    content_type: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "api_id": self.api_id,
            "method": self.method,
            "path": self.path,
            "handler": self.handler,
            "body_schema": self.body_schema,
            "param_schemas": self.param_schemas,
            "source": self.source,
            "needs_semantics": self.needs_semantics,
            "requires_auth": self.requires_auth,
            "content_type": self.content_type,
        }


def fetch_openapi(base_url: str, timeout: float = 5.0) -> dict[str, Any] | None:
    """Fetch and parse an OpenAPI document from a live service, or None.

    Tries the FastAPI-style versioned spec paths first (``/api/v1/openapi.json``)
    then the root ``/openapi.json``; a non-2xx / unreachable / non-JSON response
    yields None so the caller falls back to apis.json.
    """
    base = base_url.rstrip("/")
    candidates = [
        f"{base}/openapi.json",
        f"{base}/api/v1/openapi.json",
        f"{base}/api/openapi.json",
        f"{base}/v1/openapi.json",
    ]
    for url in candidates:
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (local trusted URL)
                if resp.status != 200:
                    continue
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
            if isinstance(data, dict) and isinstance(data.get("paths"), dict):
                return data
        except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
            continue
    return None


def _resolve_ref(node: Any, spec: dict[str, Any], seen: frozenset[str] = frozenset()) -> Any:
    """Inline ``$ref`` pointers (``#/components/schemas/X``) into a schema.

    Bounded by a visited-set so a recursive model (a tree of the same schema)
    resolves once and then stops rather than looping forever.
    """
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            if ref in seen:
                return {}  # cycle guard
            target: Any = spec
            for part in ref.lstrip("#/").split("/"):
                if isinstance(target, dict):
                    target = target.get(part)
                else:
                    target = None
                    break
            return _resolve_ref(target or {}, spec, seen | {ref})
        return {k: _resolve_ref(v, spec, seen) for k, v in node.items()}
    if isinstance(node, list):
        return [_resolve_ref(v, spec, seen) for v in node]
    return node


#: Wire encoding `execute_probe` should use for a chosen media type. Anything
#: absent here is sent as JSON, which is the correct default for OpenAPI.
_FORM_MEDIA = "application/x-www-form-urlencoded"


def _body_schema_and_type(
    operation: dict[str, Any], spec: dict[str, Any]
) -> tuple[dict[str, Any] | None, str | None]:
    """The request body schema AND the media type it was selected from.

    Returning the schema alone discarded the media type at the exact point it
    was known, and `Endpoint` had nowhere to carry it — so a form-only operation
    was JSON-encoded forever. FastAPI's OAuth2 password flow declares only
    ``application/x-www-form-urlencoded``, so ``POST /login/access-token``
    422'd on every probe. It never 5xx'd, so it produced no issue cluster: it
    simply sat at 0% coverage, and with no token the whole authenticated pass
    was skipped.
    """
    body = operation.get("requestBody")
    if not isinstance(body, dict):
        return None, None
    content = body.get("content")
    if not isinstance(content, dict):
        return None, None
    for ctype in ("application/json", _FORM_MEDIA, "*/*"):
        media = content.get(ctype)
        if isinstance(media, dict) and isinstance(media.get("schema"), dict):
            return _resolve_ref(media["schema"], spec), ctype
    # Any first media type with a schema.
    for ctype, media in content.items():
        if isinstance(media, dict) and isinstance(media.get("schema"), dict):
            return _resolve_ref(media["schema"], spec), str(ctype)
    return None, None


def _body_schema_of(operation: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any] | None:
    return _body_schema_and_type(operation, spec)[0]


def content_kind(media_type: str | None) -> str | None:
    """``execute_probe``'s ``content_type`` argument for a media type, or None."""
    return "form" if media_type == _FORM_MEDIA else None


def _params_of(operation: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    params = operation.get("parameters")
    if not isinstance(params, list):
        return out
    for p in params:
        if not isinstance(p, dict):
            continue
        resolved = _resolve_ref(p, spec)
        if isinstance(resolved, dict) and resolved.get("name"):
            out.append(resolved)
    return out


def _op_requires_auth(operation: dict[str, Any], spec: dict[str, Any] | None = None) -> bool:
    """Whether this operation is protected, honouring the document-level default.

    OpenAPI 3.x defines a root ``security`` array as the default INHERITED by
    every operation that does not override it — and that is the standard way to
    protect a whole API. Modelling only the per-operation override made every
    endpoint of such a document look public, which cascaded into three losses:
    no anonymous-vs-authed permutation, no semantic prompt (so no login chain
    was ever authored), and the auth sweep skipped entirely. The result was 100%
    of endpoints 401ing at zero coverage, with no diagnostic.

    An explicit empty ``security: []`` on the operation is a deliberate opt-out
    and must win over the inherited default.
    """
    sec = operation.get("security")
    if isinstance(sec, list):
        return len(sec) > 0
    root = (spec or {}).get("security")
    return isinstance(root, list) and len(root) > 0


def _path_suffix(path: str) -> str:
    """A prefix-insensitive join key: the last two path segments, param-normalised.

    ``/api/v1/utils/test-email/`` and ``/utils/test-email/`` both key on
    ``utils/{p}`` so an OpenAPI op reconciles with its apis.json handler despite
    the unresolved mount prefix.
    """
    norm = re.sub(r"\{[^}]+\}", "{p}", path.strip("/"))
    segs = [s for s in norm.split("/") if s]
    return "/".join(segs[-2:]) if segs else ""


_HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete", "head", "options"})


def _disambiguate(
    api_id: str,
    method: str,
    path: str,
    claimed: dict[str, tuple[str, str]],
) -> str:
    """Give a colliding endpoint its own id, keeping the first claimant's intact.

    Two distinct routes reducing to one id is not a naming nit: the run loop
    groups candidates by ``api_id`` and resolves an endpoint with
    ``next(... if e["api_id"] == api_id)``, so the second route's inputs are
    fired at the first route's path and the second is never exercised at all —
    silently, because the exercised count is taken from the deduped map.

    The suffix is derived from the full path, so it is stable across runs (an
    ordinal counter would renumber whenever an unrelated route was added).
    """
    prior = claimed.get(api_id)
    if prior is None:
        claimed[api_id] = (method, path)
        return api_id
    if prior == (method, path):
        return api_id
    digest = hashlib.sha256(f"{method} {path}".encode()).hexdigest()[:8]
    unique = f"{api_id}__{digest}"
    claimed[unique] = (method, path)
    _log.warning(
        "endpoint id collision: %s %s and %s %s both key on %r; the second is "
        "now %s (without this it would never be exercised)",
        prior[0],
        prior[1],
        method,
        path,
        api_id,
        unique,
    )
    return unique


def endpoints_from_openapi(
    spec: dict[str, Any],
    apis: list[dict[str, Any]],
) -> list[Endpoint]:
    """Build the endpoint list from a live spec, reconciling handlers from apis.json."""
    # Handler lookup by (method, path-suffix).
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for a in apis:
        by_key[(a["method"].upper(), _path_suffix(a["path"]))] = a

    endpoints: list[Endpoint] = []
    # api_id -> the (method, path) that claimed it first, so a second claimant
    # can be detected and given its own id instead of silently shadowing.
    claimed: dict[str, tuple[str, str]] = {}
    for path, item in spec.get("paths", {}).items():
        if not isinstance(item, dict):
            continue
        if any(str(path).rstrip("/").endswith(s.rstrip("/")) for s in _SKIP_PATH_SUFFIXES):
            continue
        for method, operation in item.items():
            if method.lower() not in _HTTP_METHODS or not isinstance(operation, dict):
                continue
            m = method.upper()
            match = by_key.get((m, _path_suffix(str(path))))
            handler = match.get("handler") if match else operation.get("operationId")
            api_id = (
                match.get("id")
                if match
                else f"{m}_{_path_suffix(str(path)).replace('/', '_') or 'root'}"
            )
            # `_path_suffix` keeps only the last two segments so an op reconciles
            # with its handler despite an unresolved mount prefix — but that same
            # truncation makes the key non-unique. `/users/{id}/items/{item_id}`
            # and `/teams/{id}/items/{item_id}` both reduce to `items/{p}`.
            # Downstream, `next(e for e in endpoints if e["api_id"] == api_id)`
            # resolves to the FIRST match, so one path was exercised twice and
            # the other never — absent from coverage and from profile.json, with
            # no diagnostic, and `endpoints_exercised` counts the deduped map so
            # the number looked self-consistent. Disambiguate with the full path.
            api_id = _disambiguate(str(api_id), m, str(path), claimed)
            body, media_type = _body_schema_and_type(operation, spec)
            params = _params_of(operation, spec)
            requires_auth = _op_requires_auth(operation, spec)
            endpoints.append(
                Endpoint(
                    api_id=str(api_id),
                    method=m,
                    path=str(path),
                    handler=handler,
                    body_schema=body,
                    param_schemas=params,
                    source="openapi",
                    needs_semantics=_looks_semantic(m, str(path), body, requires_auth),
                    requires_auth=requires_auth,
                    content_type=content_kind(media_type),
                )
            )
    endpoints.sort(key=lambda e: (e.path, e.method))
    return endpoints


def endpoints_from_apis(apis: list[dict[str, Any]]) -> list[Endpoint]:
    """Fallback endpoint list from identification's catalog (no live shapes)."""
    endpoints: list[Endpoint] = []
    for a in apis:
        method = a["method"].upper()
        path = a["path"]
        if method == "WEBSOCKET":
            # Catalogued (WebSocketRoute) but not drivable by the HTTP prober.
            continue
        if any(path.rstrip("/").endswith(s.rstrip("/")) for s in _SKIP_PATH_SUFFIXES):
            continue
        endpoints.append(
            Endpoint(
                api_id=a["id"],
                method=method,
                path=path,
                handler=a.get("handler"),
                body_schema=None,
                param_schemas=_synth_params_from_path(path),
                source="apis",
                needs_semantics=_looks_semantic(method, path, None, False),
            )
        )
    endpoints.sort(key=lambda e: (e.path, e.method))
    return endpoints


# Path-parameter tokens: {id}, {int:id}, <id>, <int:id>, :id.
_PARAM_TOKEN = re.compile(r"\{([^}]+)\}|<([^>]+)>|:([A-Za-z_][A-Za-z0-9_]*)")


def path_param_names(path: str) -> list[str]:
    names: list[str] = []
    for m in _PARAM_TOKEN.finditer(path):
        raw = m.group(1) or m.group(2) or m.group(3) or ""
        name = raw.split(":")[-1] if ":" in raw else raw
        if name:
            names.append(name)
    return names


def _synth_params_from_path(path: str) -> list[dict[str, Any]]:
    """Manufacture path-parameter schemas from an apis.json route (no OpenAPI).

    A parameter named ``*id``/``*_id`` is typed integer, ``*email`` gets the email
    format, everything else is a plain string — enough for the schema generator.
    """
    params: list[dict[str, Any]] = []
    for name in path_param_names(path):
        lname = name.lower()
        if lname == "id" or lname.endswith("_id") or lname.endswith("id"):
            schema = {"type": "integer", "minimum": 1}
        elif "email" in lname:
            schema = {"type": "string", "format": "email"}
        elif "uuid" in lname:
            schema = {"type": "string", "format": "uuid"}
        else:
            schema = {"type": "string", "minLength": 1}
        params.append({"name": name, "in": "path", "required": True, "schema": schema})
    return params


# Heuristics for endpoints that benefit from a semantic (LLM/harness) input plan.
_SEMANTIC_PATH_HINTS = ("login", "token", "auth", "signup", "reset", "recovery", "password")


def _looks_semantic(
    method: str, path: str, body: dict[str, Any] | None, requires_auth: bool
) -> bool:
    """Whether an endpoint should be flagged ``needs-semantics``.

    Auth chains, resource-dependent CRUD (a mutation on a ``{id}`` resource that
    must exist first), and multi-step flows are exactly where deterministic
    schema inputs alone under-cover — a semantic plan (setup + dependent inputs)
    is dispatched to the harness for these.
    """
    lp = path.lower()
    if any(h in lp for h in _SEMANTIC_PATH_HINTS):
        return True
    # An authenticated endpoint is part of an auth chain — a valid call needs a
    # token obtained from a login step, which only a semantic scenario can author.
    if requires_auth:
        return True
    # A write to a specific resource id usually needs that resource created first.
    if method in ("PUT", "PATCH", "DELETE") and path_param_names(path):
        return True
    return False


def load_apis_json(apis_json_path: str) -> list[dict[str, Any]]:
    """Read identification's apis.json → its ``apis`` list (empty on any error)."""
    try:
        with open(apis_json_path, encoding="utf-8") as fh:
            data = json.load(fh)
        apis = data.get("apis")
        return apis if isinstance(apis, list) else []
    except (OSError, ValueError):
        return []
