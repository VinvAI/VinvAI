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
#:
#: ``secretkey``/``accesskey`` are listed even though ``secret`` already is:
#: the suffix rule reads the LAST noun, and ``SECRET_KEY`` normalises to
#: ``secretkey``, which ends in "key" rather than "secret". Django's and
#: Flask's canonical setting name, and ``AWS_SECRET_ACCESS_KEY`` with it, were
#: therefore not recognised at all.
_SECRET_KEY_NOUNS = (
    "password",
    "passwd",
    "passphrase",
    "secret",
    "secretkey",
    "accesskey",
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


#: ``user:password@host`` in a URL's authority. Whether or not the password is
#: named anything, its POSITION says what it is.
_URL_USERINFO = re.compile(r"(?P<scheme>[a-zA-Z][\w+.-]*://)(?P<user>[^/@\s:]+):[^/@\s]*@")

#: Query-parameter names that mean "credential" in a URL and do NOT mean it as a
#: field name — so this list is scoped to `redact_url` and deliberately not added
#: to `_SECRET_KEY_NOUNS`.
#:
#: `key` is the case that forces the distinction. As a query parameter it is how
#: Google authenticates (`?key=AIza…`) and is a credential essentially always; as
#: a field name it is `sort_key`, `cache_key`, `partition_key`, `primary_key`,
#: and redacting those would corrupt the observations the invariant oracle learns
#: from — the over-redaction this module treats as an oracle bug. `sig` is Azure
#: SAS, `signature` is AWS presigned. Position is the discriminator, which is the
#: same reason `is_id_shaped` exists.
_URL_SECRET_PARAMS = frozenset({"key", "sig", "signature", "auth"})


def redact_url(url: str) -> str:
    """Redact credentials carried in a URL, keeping the URL readable.

    A recorded request line is one of the places a key most reliably ends up:
    plenty of providers authenticate by query parameter (``?key=…``,
    ``?access_token=…``) rather than by header, and a connection string carries
    its password in the authority. ``is_id_shaped`` already refuses to SPLICE a
    credential into a URL for exactly this reason — this is the same rule applied
    to a URL the target built itself and the engine is about to write down.

    Only values are touched: the scheme, host, path and parameter NAMES survive,
    because what the URL was is the whole diagnostic value of recording it.
    """
    if not url:
        return url
    out = _URL_USERINFO.sub(rf"\g<scheme>\g<user>:{PLACEHOLDER}@", url)
    head, sep, query = out.partition("?")
    if not sep:
        return out
    query, frag_sep, fragment = query.partition("#")
    pairs: list[str] = []
    for part in query.split("&"):
        name, eq, value = part.partition("=")
        secret = (
            is_secret_key(name)
            or _normalize_key(name) in _URL_SECRET_PARAMS
            or looks_like_jwt(value)
        )
        if eq and value and secret:
            pairs.append(f"{name}={PLACEHOLDER}")
        else:
            pairs.append(part)
    return f"{head}?{'&'.join(pairs)}{frag_sep}{fragment}"


#: ``key:`` / ``"key" =`` / ``KEY=`` — the LEFT half of a pair in free text. The
#: key is captured so the existing ``is_secret_key`` predicate decides; this
#: adds a place to look, never a second vocabulary of what is secret.
_TEXT_KEY = re.compile(
    r"""(?P<kq>['"]?)(?P<key>[A-Za-z_][A-Za-z0-9_.\- ]{0,60})(?P=kq)(?P<sep>\s*[:=]\s*)"""
)

#: A quoted value. Same shape whoever owns the key.
_TEXT_QUOTED = re.compile(r"""(?P<vq>['"])(?P<quoted>(?:(?!(?P=vq)).)*)(?P=vq)""")

#: An unquoted value under a NON-secret key. Deliberately short: it stops at
#: quotes, openers and ``=`` so that ``input_value={'api_key': …}`` and
#: ``Traceback: token=sk-…`` leave the inner pair intact for the scan to reach.
_TEXT_BARE_SHORT = re.compile(r"""[^\s,;:=)}\]'"{\[(]+""")

#: An unquoted value under a SECRET key, which is a different question: ``=`` is
#: part of the value, not a new pair. ``Set-Cookie: session=abc; Path=/`` broke
#: under the short form — it stopped at the ``=``, redacted the cookie's NAME
#: and left the value in the text.
_TEXT_BARE_SECRET = re.compile(r"""[^\s\r\n,;&)}\]]+""")

#: An auth SCHEME is not the credential, it introduces one. ``Authorization:
#: Bearer eyJ…`` redacted the word "Bearer" and published the token, because a
#: value that stops at whitespace stops one word early here — and only here, so
#: the rest of an ordinary message ("token=… in file") keeps its prose.
_AUTH_SCHEMES = frozenset({"bearer", "basic", "digest", "token", "jwt", "apikey", "key"})
_TEXT_NEXT_WORD = re.compile(r"""[ \t]+(?P<word>[^\s\r\n,;&)}\]]+)""")

#: A JWT with no key at all — a bearer token pasted bare into a traceback. Rule
#: 2 of this module says the shape is enough under ANY key name, and "no key"
#: is the limiting case of that.
_BARE_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*")


def redact_text(text: str) -> str:
    """Redact credential values embedded in a free-text blob.

    ``redact`` walks a STRUCTURE and decides by field name, which is the right
    rule and the wrong reach: an exception message is one string, and the
    credential inside it is spelled as text. A settings object that fails
    validation renders its whole input dict into the message —

        5 validation errors for Settings ... input_value={'openai_api_key':
        'sk-pr...54k5cA', ...}

    — and that message is persisted to ``.vinv/`` and printed to stdout. The
    engine has to be able to quote a target's error without becoming a way to
    exfiltrate the target's keys.

    Scanned rather than ``re.sub``-ed, because a substitution consumes its whole
    match and the value of one pair is routinely the KEY of the next. A single
    pattern therefore let an innocent key swallow the credential behind it:
    ``Traceback: token=sk-…`` matched as ``Traceback`` → ``token`` and the scan
    resumed past the real pair. On a non-secret key this resumes INSIDE the
    value, so every nested pair is examined on its own terms.
    """
    if not text:
        return text

    out: list[str] = []
    pos = 0
    while pos < len(text):
        match = _TEXT_KEY.search(text, pos)
        if match is None:
            break
        key = match.group("key")
        secret = is_secret_key(key)
        value_at = match.end()
        quoted = _TEXT_QUOTED.match(text, value_at)
        if quoted is not None:
            if not (secret or looks_like_jwt(quoted.group("quoted"))):
                # Keep it verbatim and resume after it: a quoted value cannot
                # itself be a key, so there is nothing inside to reach.
                out.append(text[pos : quoted.end()])
                pos = quoted.end()
                continue
            vq = quoted.group("vq")
            out.append(f"{text[pos : match.end()]}{vq}{PLACEHOLDER}{vq}")
            pos = quoted.end()
            continue
        bare = (_TEXT_BARE_SECRET if secret else _TEXT_BARE_SHORT).match(text, value_at)
        if bare is None:
            out.append(text[pos : match.end()])
            pos = match.end()
            continue
        value = bare.group(0).rstrip()
        if secret and value.casefold() in _AUTH_SCHEMES:
            after = _TEXT_NEXT_WORD.match(text, value_at + len(value))
            if after is not None:
                value = text[value_at : after.end()]
        if not (secret or looks_like_jwt(value)):
            # Resume at the VALUE, not past it — it is the next candidate key.
            out.append(text[pos:value_at])
            pos = value_at
            continue
        out.append(f"{text[pos : match.end()]}{PLACEHOLDER}")
        pos = value_at + len(value)
    out.append(text[pos:])
    return _BARE_JWT.sub(PLACEHOLDER, "".join(out))


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
