"""Secret redaction for anything the exerciser writes to disk.

Exercising a service means driving its REAL auth endpoints, so 2xx bodies
routinely contain credentials: ``POST /login/access-token`` answers with a
bearer JWT, signup echoes a password hash, a profile read carries an email.
Every execution row is persisted verbatim to ``.vinv/exercise/results.jsonl``
and the scalars are harvested into ``state_ledger.jsonl`` — both of which live
INSIDE the user's repository and are one ``git add .`` from a public push.

Two rules, deliberately narrow:

1. **By key name** — a value under ``access_token``/``password``/``api_key``/…
   is a secret regardless of what it looks like.
2. **By value shape, JWT only** — ``eyJ<base64>.<base64>.<sig>`` is
   unmistakable and travels under arbitrary key names (``detail``, ``message``,
   an array element).

Deliberately NOT done: fuzzy "this looks like a long random string" detection.
Redacting a legitimate id, hash, or content field would corrupt the very
observations the invariant oracle learns from — a false redaction is a silent
oracle bug, which is worse than a conservative miss. Key names plus JWT shape
cover the credentials that actually appear in HTTP bodies.

Redaction preserves TYPE and SHAPE: a redacted string stays a string, so
``never_null``/``stable_enum``/shape hashing keep working. It replaces the value
with a CONSTANT, which is strictly better for the oracle than a rotating token
that would make every ``stable_enum`` and value digest churn between runs.

``value_digest`` is computed upstream in ``execute.py`` over the raw body and is
a SHA-256 — not reversible, so change-detection survives redaction intact.
"""

from __future__ import annotations

import re
from typing import Any

#: What a redacted value is replaced with. A constant (not a per-value hash) so
#: repeated runs agree and value-stability oracles see a stable field.
PLACEHOLDER = "[redacted]"

#: Credential nouns, matched against the NORMALIZED key (see ``_normalize_key``)
#: by equality or SUFFIX — never bare substring.
#:
#: Suffix, because qualifiers lead: ``access_token``, ``refresh_token``,
#: ``client_secret``, ``X-Api-Key`` all END in the noun. Substring matching was
#: tried first and was wrong in both directions: it scrubbed ``token_type``
#: (whose value is the literal "bearer" — metadata an enum invariant legitimately
#: learns) while still missing ``X-Api-Key`` (dash, not underscore). Over-
#: redaction is an oracle bug, so the rule has to be tighter than "contains".
_SECRET_KEY_NOUNS = (
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "authorization",
    "credential",
    "privatekey",
    "sessionid",
    "cookie",
    "otp",
)

#: A JSON Web Token: three base64url segments, the first of which decodes to a
#: JSON header and therefore always starts ``eyJ``. Anchored and length-bounded
#: so an ordinary dotted string cannot match.
_JWT = re.compile(r"^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$")

#: Upper bound on a plausible path-param id (uuid=36, ObjectId=24, ints, slugs).
#: A credential is far longer, so length alone excludes it.
_MAX_ID_LEN = 64


def _normalize_key(key: str) -> str:
    """Fold spelling variants together: ``X-Api-Key`` → ``apikey``.

    Drops non-alphanumerics (so ``-``/``_``/spaces stop mattering) and one
    trailing plural ``s`` (so ``credentials`` matches ``credential``).
    """
    k = "".join(c for c in key.casefold() if c.isalnum())
    return k[:-1] if len(k) > 1 and k.endswith("s") else k


def is_secret_key(key: str) -> bool:
    """True when a field NAME marks its value as a credential."""
    k = _normalize_key(key)
    return any(k == noun or k.endswith(noun) for noun in _SECRET_KEY_NOUNS)


def looks_like_jwt(value: str) -> bool:
    """True for a JSON Web Token under any key name."""
    return bool(_JWT.match(value))


def is_id_shaped(value: str) -> bool:
    """True when a harvested scalar is plausible as a path-param id.

    Guards the auth sweep's id substitution: without it, a harvested bearer
    token is spliced into a URL (``DELETE /users/eyJhbGciOi…``), leaking the
    credential into the request line, the service's access log, and every proxy
    in between. Ids are short and opaque; credentials are long and structured.
    """
    if not value or len(value) > _MAX_ID_LEN:
        return False
    if looks_like_jwt(value):
        return False
    # A path param occupies ONE URL segment: no separators, no whitespace.
    return not any(c in value for c in " \t\r\n/?#&=")


def redact(obj: Any, *, _key: str | None = None) -> Any:
    """Return ``obj`` with credential values replaced, shape and types intact.

    Containers are rebuilt (never mutated in place) so the caller's live object
    — still needed for invariant checks in this same run — is untouched; only
    what gets PERSISTED is redacted.
    """
    if isinstance(obj, dict):
        return {k: redact(v, _key=str(k)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v, _key=_key) for v in obj]
    if isinstance(obj, tuple):
        return tuple(redact(v, _key=_key) for v in obj)
    if isinstance(obj, str):
        if (_key is not None and is_secret_key(_key)) or looks_like_jwt(obj):
            return PLACEHOLDER
        return obj
    # Non-str scalars under a secret key (a numeric pin, a bool flag) still leak.
    if _key is not None and is_secret_key(_key) and obj is not None:
        return PLACEHOLDER
    return obj
