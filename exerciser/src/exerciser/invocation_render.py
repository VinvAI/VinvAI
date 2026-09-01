"""Filling an invocation's command template — the Python half of the contract.

A run-to-completion unit is driven many ways: a CLI has one invocation per
subcommand, a library one per entry point. Each is recorded as a *template* plus
the parameters that fill it, so the same record can serve a human filling a form
and a headless pass taking the declared defaults.

This module is duplicated VERBATIM in ``exerciser.invocation_render`` and
mirrored in TypeScript by ``extension/src/bringup/invocations.ts``. Duplication
rather than a shared import because ``bringup`` and ``exerciser`` deliberately do
not depend on each other (the field contract is the file on disk, not the code
that wrote it) — and the drift that invites is caught by
``contracts/vectors/invocation_render.json``, which every one of the three suites
reads. A change made on one side and not the others fails there instead of
quietly producing a different command in each surface.

The invariant worth stating plainly: rendering an invocation with all of its
defaults must reproduce, byte for byte, the string bring-up actually ran. That is
what keeps ``verified: true`` meaning something after parameters exist — see
:func:`defaults_match_verified`.
"""

from __future__ import annotations

import re
from typing import Any

#: An ordinary argv token needs no quoting. Leaving these bare is what keeps the
#: defaults render byte-identical to the verified string — quoting everything
#: would be equally safe and would break the identity check on every record.
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9_@%+=:,./-]+$")

#: `C:\x` / `C:/x` → the `/c/x` spelling Git Bash reads. Keyed off the SHAPE of
#: the value rather than the host platform, so the shared vectors give the same
#: answer on every OS.
_DRIVE = re.compile(r"^([A-Za-z]):[\\/](.*)$")

#: An escape (`{{` / `}}`) or a placeholder, in one pass.
_TOKEN = re.compile(r"\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}")

#: Values a `flag` parameter treats as "on". Anything else omits the flag.
_TRUTHY = frozenset({"1", "true", "yes", "on"})


class InvocationRenderError(ValueError):
    """A template and its parameters disagree — never rendered past."""


def shell_quote(value: str) -> str:
    """Quote one value for the ``bash -lc`` the recorded command runs under."""
    if _SAFE_TOKEN.match(value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


def to_bash_path(value: str) -> str:
    """Rewrite a Windows drive-letter path into the ``/c/…`` spelling.

    Recorded commands are bash-spelled by contract: a ``C:\\…`` value arrives at
    the program with its backslashes eaten as escapes, and a ``C:/…`` value has
    its colon read as a PATH separator.
    """
    m = _DRIVE.match(value)
    if m:
        return "/" + m.group(1).lower() + "/" + m.group(2).replace("\\", "/")
    return value.replace("\\", "/")


def _substitute(param: dict[str, Any], raw: str, *, in_quotes: bool = False) -> str:
    """The text one parameter contributes, already quoted. ``""`` means omit.

    ``in_quotes`` says the placeholder already sits inside a quoted span in the
    template (``--vault "{vault}"``). Quoting again nests one set inside the
    other and the program receives a value with literal quote characters in it:
    a path under a directory with a space in its name became
    ``"'/Users/me/SEO - from Scratch/vault'"``, which no filesystem has, and
    every parameterised invocation on that repo exited 2. The template's quotes
    are already doing the job, so the value goes in bare.
    """
    ptype = param.get("type")
    value = to_bash_path(raw.strip()) if ptype == "path" else raw.strip()
    name = str(param.get("name") or "")
    render = param.get("render")

    if ptype == "flag":
        if value.lower() not in _TRUTHY:
            return ""
        return render.replace("{value}", "").strip() if isinstance(render, str) else f"--{name}"

    if value == "":
        if param.get("required"):
            raise InvocationRenderError(f"'{name}' is required but empty")
        return ""

    choices = param.get("choices")
    if ptype == "enum" and isinstance(choices, list) and choices:
        if value not in choices:
            raise InvocationRenderError(
                f"'{name}' must be one of {', '.join(str(c) for c in choices)} (got '{value}')"
            )
    if ptype == "int" and not re.fullmatch(r"-?\d+", value):
        raise InvocationRenderError(f"'{name}' must be a whole number (got '{value}')")
    if ptype == "float" and not re.fullmatch(r"-?\d+(\.\d+)?", value):
        raise InvocationRenderError(f"'{name}' must be a number (got '{value}')")

    quoted = value if in_quotes else shell_quote(value)
    return render.replace("{value}", quoted) if isinstance(render, str) else quoted


def render_invocation(invocation: dict[str, Any], args: dict[str, str] | None = None) -> str:
    """Fill ``invocation``'s template, falling back to each parameter's default.

    Raises rather than guessing: an unknown placeholder, or a declared parameter
    the template never uses, is a malformed record — rendering past it would
    produce a command nobody verified.
    """
    args = args or {}
    raw_params = invocation.get("params")
    params: dict[str, dict[str, Any]] = {}
    if isinstance(raw_params, list):
        for p in raw_params:
            if isinstance(p, dict) and isinstance(p.get("name"), str):
                params[p["name"]] = p
    command = invocation.get("command")
    if not isinstance(command, str):
        raise InvocationRenderError("invocation has no command string")
    inv_id = invocation.get("id") or "?"

    used: set[str] = set()
    out: list[str] = []
    last = 0
    for m in _TOKEN.finditer(command):
        out.append(command[last : m.start()])
        last = m.end()
        if m.group(0) in ("{{", "}}"):
            out.append(m.group(0)[0])
            continue
        name = m.group(1)
        param = params.get(name)
        if param is None:
            raise InvocationRenderError(
                f"command uses {{{name}}} but no such parameter is declared on "
                f"invocation '{inv_id}'"
            )
        used.add(name)
        supplied = args.get(name)
        if supplied is None:
            supplied = param.get("default")
        # Is this placeholder already inside a quoted span? Look at the
        # characters either side of it in the TEMPLATE, not at the value.
        before = command[m.start() - 1] if m.start() > 0 else ""
        after = command[m.end()] if m.end() < len(command) else ""
        in_quotes = before == after and before in ("'", '"')
        text = _substitute(
            param,
            str(supplied) if supplied is not None else "",
            in_quotes=in_quotes,
        )
        if text == "":
            # An omitted parameter takes its own separating space with it, so the
            # defaults render stays byte-identical to the verified string rather
            # than leaving a tell-tale double space behind.
            if out and out[-1].endswith(" "):
                out[-1] = out[-1][:-1]
            continue
        out.append(text)
    out.append(command[last:])

    for name in params:
        if name not in used:
            raise InvocationRenderError(
                f"invocation '{inv_id}' declares parameter '{name}' but its command "
                f"has no {{{name}}}"
            )
    return "".join(out)


def default_args(invocation: dict[str, Any]) -> dict[str, str]:
    """Every parameter's default — what every headless consumer runs with."""
    out: dict[str, str] = {}
    raw = invocation.get("params")
    if isinstance(raw, list):
        for p in raw:
            if isinstance(p, dict) and isinstance(p.get("name"), str):
                default = p.get("default")
                out[p["name"]] = "" if default is None else str(default)
    return out


def defaults_match_verified(invocation: dict[str, Any]) -> bool:
    """Does rendering the defaults reproduce the string bring-up verified?

    True when no ``verification.rendered_command`` was recorded: an older record
    simply makes no claim, and refusing it would break every unit brought up
    before parameters existed.
    """
    verification = invocation.get("verification")
    recorded = verification.get("rendered_command") if isinstance(verification, dict) else None
    if not isinstance(recorded, str) or not recorded:
        return True
    try:
        return render_invocation(invocation, default_args(invocation)) == recorded
    except InvocationRenderError:
        return False


def invocation_slug(value: str) -> str:
    """Filesystem- and id-safe slug, mirroring ``serviceSlug`` on both sides."""
    return re.sub(r"[^A-Za-z0-9_.-]", "_", value) or "invocation"
