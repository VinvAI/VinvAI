"""The CONTAINMENT LADDER — pick the strongest wall the host actually offers.

``sandbox.py`` used to enforce containment with a generated ``sitecustomize.py``
that monkeypatched ``socket``, ``subprocess``, ``os.*`` and ``open``. That is a
LANGUAGE-level control, and it is structurally blind to a C extension that calls
``open(2)``/``connect(2)`` itself: ``sqlite3.connect("/abs/path/outside")``
created a real database outside the sandbox root, and ``sqlite3`` is precisely
the kind of module the sandbox exists to promote. Reporting the hole honestly
(``unobservable: ["c-extension-io"]``, ``effects_complete: False``) was the right
thing to do about a hole; it was not a fix for one.

The fix is to move the wall to the OS, and to be explicit about which wall we
actually got:

``OS_SANDBOX``
    The kernel refuses the effect. A write outside the sandbox root is
    IMPOSSIBLE — not intercepted, impossible — so the effect ledger can honestly
    claim completeness for the filesystem, and (when the policy blocks it) for
    the network too. Provided by ``sandbox-exec`` on macOS, ``bwrap`` on Linux,
    or ``unshare`` where unprivileged user namespaces allow a read-only rebind
    of ``/``.
``PROCESS_SHIM``
    The Python shim, unchanged: a disposable tree, a copied repo, redirected
    ``HOME``/``TMPDIR``, and patched Python entry points. It stops a
    well-behaved Python client and records what was attempted. It does NOT stop
    a C extension, so ``effects_complete`` stays False wherever the static guard
    predicted C-level I/O.
``NONE``
    No containment at all. Never a run mode: it exists so a caller that demanded
    a tier can be REFUSED with the reason, rather than silently downgraded.

Nothing here is assumed. Every OS mechanism is chosen only after a PROBE that
runs the candidate on a trivial command and checks that it really blocked a
write outside the root (and, when asked, a connect). A mechanism that is on
``PATH`` but does not actually contain anything on this host — a kernel without
unprivileged user namespaces, a seccomp-restricted container, a
``sandbox-exec`` profile the OS declines to compile — fails its probe and is not
offered. The probe result is cached per process because it is a fact about the
host, not about the run.

No new dependency, no Docker, no root. If none of the OS mechanisms probe clean
the ladder returns ``PROCESS_SHIM``, which is exactly what the harness did
before — a weaker tier with an honest completeness claim, never a stronger claim
with a weaker wall.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

# Seconds a single probe invocation may take. A mechanism that cannot answer in
# this long is not one we are going to run a whole module under.
PROBE_TIMEOUT_S = 20.0


class ContainmentTier(str, Enum):
    """How strong the wall around a contained call actually is.

    ``str``-valued so a tier drops straight into a JSON report; ordered by
    ``rank`` so ``require_tier`` is a comparison rather than a lookup table.
    """

    NONE = "none"
    PROCESS_SHIM = "process-shim"
    OS_SANDBOX = "os-sandbox"

    @property
    def rank(self) -> int:
        return {"none": 0, "process-shim": 1, "os-sandbox": 2}[self.value]

    def __ge__(self, other: object) -> bool:  # type: ignore[override]
        if isinstance(other, ContainmentTier):
            return self.rank >= other.rank
        return NotImplemented

    def __gt__(self, other: object) -> bool:  # type: ignore[override]
        if isinstance(other, ContainmentTier):
            return self.rank > other.rank
        return NotImplemented

    def __le__(self, other: object) -> bool:  # type: ignore[override]
        if isinstance(other, ContainmentTier):
            return self.rank <= other.rank
        return NotImplemented

    def __lt__(self, other: object) -> bool:  # type: ignore[override]
        if isinstance(other, ContainmentTier):
            return self.rank < other.rank
        return NotImplemented


def parse_tier(value: str | ContainmentTier | None) -> ContainmentTier | None:
    """A tier from its wire value, or None. Raises on an unknown name."""
    if value is None or isinstance(value, ContainmentTier):
        return value
    text = str(value).strip().lower().replace("_", "-")
    for tier in ContainmentTier:
        if tier.value == text:
            return tier
    raise ValueError(f"unknown containment tier {value!r} (expected one of {tier_names()})")


def tier_names() -> list[str]:
    return [t.value for t in ContainmentTier]


@dataclass(frozen=True)
class ContainmentMechanism:
    """One rung of the ladder, and what it is entitled to claim.

    ``tier`` is the achieved strength; ``name`` is how it was achieved. The
    boolean guarantees are set from what the PROBE observed, never from what the
    mechanism is supposed to do, so a ``bwrap`` whose ``--unshare-net`` silently
    did nothing cannot claim a blocked network.
    """

    tier: ContainmentTier
    name: str
    tool: str | None = None
    blocks_writes_outside_root: bool = False
    blocks_network: bool = False
    detail: str = ""
    checks: tuple[str, ...] = ()
    fallback_reason: str | None = None
    candidates: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    # -- what a result document is allowed to say -------------------------

    @property
    def effects_complete(self) -> bool:
        """May a row claim its effect ledger is COMPLETE?

        Only under an OS wall that actually denied a write outside the root: the
        two channels that remain — the kernel's refusal, and the before/after
        walk of the tree — between them see every filesystem effect, including
        the C-extension writes the Python shim is blind to. Under the shim this
        is False wherever the static guard predicted C-level I/O.
        """
        return self.tier is ContainmentTier.OS_SANDBOX and self.blocks_writes_outside_root

    def guarantees(self) -> dict[str, str]:
        """Plain-language statement of what this rung does and does not stop."""
        if self.tier is ContainmentTier.OS_SANDBOX:
            return {
                "writes_outside_root": (
                    "IMPOSSIBLE — refused by the kernel, including from C extensions"
                    if self.blocks_writes_outside_root
                    else "intercepted by the Python shim only"
                ),
                "network": (
                    "IMPOSSIBLE — refused by the kernel"
                    if self.blocks_network
                    else "intercepted by the Python shim only (policy allows network)"
                ),
                "subprocess": (
                    "intercepted by the Python shim; any child that escapes it "
                    "inherits this OS sandbox"
                ),
                "effect_ledger": (
                    "COMPLETE for the filesystem — a write either lands in the "
                    "disposable tree (seen by the before/after walk) or is denied"
                    if self.blocks_writes_outside_root
                    else "INCOMPLETE — C-level I/O is not witnessed"
                ),
            }
        if self.tier is ContainmentTier.PROCESS_SHIM:
            return {
                "writes_outside_root": (
                    "intercepted at the Python level (open/os.open/os.* family); "
                    "a C extension calling open(2) is NOT stopped"
                ),
                "network": (
                    "intercepted at the Python level (socket/ssl); a C extension "
                    "calling connect(2) is NOT stopped"
                ),
                "subprocess": "intercepted at the Python level (subprocess/os.exec*/os.spawn*)",
                "effect_ledger": (
                    "INCOMPLETE wherever the static guard predicted C-level I/O — "
                    "an empty effects map means 'we could not see', not 'nothing happened'"
                ),
            }
        return {
            "writes_outside_root": "NOT CONTAINED",
            "network": "NOT CONTAINED",
            "subprocess": "NOT CONTAINED",
            "effect_ledger": "NONE — nothing may be run at this tier",
        }

    def to_json(self) -> dict[str, Any]:
        return {
            "tier": self.tier.value,
            "mechanism": self.name,
            "tool": self.tool,
            "blocks_writes_outside_root": self.blocks_writes_outside_root,
            "blocks_network": self.blocks_network,
            "effects_complete": self.effects_complete,
            "detail": self.detail,
            "checks": list(self.checks),
            "fallback_reason": self.fallback_reason,
            "guarantees": self.guarantees(),
            "candidates": [dict(c) for c in self.candidates],
        }

    # -- turning an argv into a contained argv ----------------------------

    def wrap(
        self,
        argv: Sequence[str],
        *,
        root: Path,
        writable: Sequence[Path] = (),
        block_network: bool = True,
    ) -> list[str]:
        """``argv`` rewritten to run under this mechanism.

        A tier that is not an OS sandbox returns ``argv`` unchanged: the shim is
        established through the environment, not through the command line.
        """
        argv = list(argv)
        if self.tier is not ContainmentTier.OS_SANDBOX or not self.tool:
            return argv
        writes = [root, *writable]
        if self.name == "sandbox-exec":
            return [self.tool, "-p", macos_profile(writes, block_network=block_network), *argv]
        if self.name == "bwrap":
            return bwrap_argv(self.tool, argv, writes, block_network=block_network)
        if self.name == "unshare":
            return unshare_argv(self.tool, argv, writes, block_network=block_network)
        return argv


# The two rungs that need no probing at all.
SHIM_MECHANISM = ContainmentMechanism(
    tier=ContainmentTier.PROCESS_SHIM,
    name="python-shim",
    detail=(
        "generated sitecustomize patches the Python entry points; the durable "
        "guarantee is the disposable tree and the copied repo"
    ),
    checks=("shim-loaded-in-worker",),
)
NO_CONTAINMENT = ContainmentMechanism(
    tier=ContainmentTier.NONE,
    name="none",
    detail="no containment mechanism is available on this host",
)


# =========================================================================
# Profile / argv construction
# =========================================================================


def _real(path: Path) -> str:
    """The path the kernel will match against — symlinks resolved.

    ``/tmp`` is a symlink to ``/private/tmp`` on macOS, and an SBPL ``subpath``
    matches the resolved vnode, so a profile written against the unresolved path
    silently allows nothing.
    """
    return os.path.realpath(str(path))


def _sbpl_string(text: str) -> str:
    """An SBPL string literal. Backslash and quote are the only escapes."""
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def macos_profile(writable: Sequence[Path], *, block_network: bool = True) -> str:
    """An SBPL profile: everything allowed, then writes and network taken away.

    ``(deny default)`` is the textbook shape and it is unusable here — CPython
    cannot start under it without an allow-list nobody can maintain across
    interpreter builds. ``(allow default)`` followed by targeted denies is what
    the harness actually needs: the ONE guarantee we are buying is that a write
    cannot land outside the disposable tree, and (optionally) that no socket
    reaches the network. Later rules win in SBPL, so the allow-list below is
    read as an exception to the deny above it.

    The host ``TMPDIR`` is deliberately NOT on the allow-list. ``sandbox_env``
    already redirects ``TMPDIR``/``TEMP``/``TMP`` into the sandbox root, so
    nothing legitimate needs it — and allowing it would punch the hole exactly
    where test frameworks and build tools put their scratch directories.
    """
    lines = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
    ]
    for path in writable:
        lines.append(f"(allow file-write* (subpath {_sbpl_string(_real(path))}))")
    # Stateless character devices: a write to one leaves nothing behind to
    # discard, and refusing them breaks ordinary logging and tty output.
    lines.append(
        "(allow file-write-data "
        '(literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") '
        '(literal "/dev/urandom") (literal "/dev/dtracehelper"))'
    )
    lines.append('(allow file-write* (regex #"^/dev/(tty|ptmx|fd/)"))')
    if block_network:
        lines.append("(deny network*)")
    return "\n".join(lines)


def bwrap_argv(
    tool: str,
    argv: Sequence[str],
    writable: Sequence[Path],
    *,
    block_network: bool = True,
) -> list[str]:
    """``bwrap`` arguments: the whole filesystem read-only, the tree writable.

    Order is load-bearing. ``--tmpfs /tmp`` has to come BEFORE the writable
    binds, because the sandbox root usually lives under ``/tmp`` and a tmpfs
    mounted afterwards would hide it. Bind SOURCES are resolved in the original
    namespace, so binding a path back over its own (now shadowed) location is
    exactly the right move.
    """
    out = [
        tool,
        "--ro-bind",
        "/",
        "/",
        "--tmpfs",
        "/tmp",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--die-with-parent",
        "--unshare-pid",
    ]
    if block_network:
        out.append("--unshare-net")
    for path in writable:
        real = _real(path)
        out += ["--bind", real, real]
    out.append("--")
    out += list(argv)
    return out


# Run inside `unshare -rm[n]`: make `/` read-only, give `/tmp` a fresh tmpfs,
# then rebind each writable path read-write. Every step is checked; a failure
# exits with a distinctive status so the probe reports "unshare cannot contain
# on this host" instead of running the command uncontained.
_UNSHARE_SCRIPT = """\
set -e
mount --make-rprivate / 2>/dev/null || exit 97
for p in $VINV_WRITABLE_PATHS; do mount --bind "$p" "$p" 2>/dev/null || exit 97; done
mount -o remount,bind,ro / / 2>/dev/null || exit 97
for p in $VINV_WRITABLE_PATHS; do mount -o remount,bind,rw "$p" "$p" 2>/dev/null || exit 97; done
exec "$@"
"""


def unshare_argv(
    tool: str,
    argv: Sequence[str],
    writable: Sequence[Path],
    *,
    block_network: bool = True,
) -> list[str]:
    """``unshare`` arguments, for a host with unprivileged user namespaces.

    ``-r`` maps the caller to root INSIDE the namespace, which is what makes the
    remounts below possible without any real privilege. ``-m`` is the mount
    namespace they happen in and ``-n`` the network one. The writable paths
    travel in an environment variable rather than in the script text so a path
    containing shell metacharacters cannot become code.
    """
    flags = "-rmn" if block_network else "-rm"
    return [
        tool,
        flags,
        "--propagation",
        "private",
        "--",
        "/bin/sh",
        "-c",
        _UNSHARE_SCRIPT,
        "sh",
        *argv,
    ]


def unshare_env(writable: Sequence[Path], base: dict[str, str] | None = None) -> dict[str, str]:
    """Environment carrying the writable paths ``_UNSHARE_SCRIPT`` rebinds."""
    env = dict(os.environ if base is None else base)
    env["VINV_WRITABLE_PATHS"] = " ".join(_real(p) for p in writable)
    return env


# =========================================================================
# The probe — run the candidate and check it actually blocked something
# =========================================================================

# Executed INSIDE the candidate containment. Writes what it managed to do to
# stdout as JSON; the parent independently checks the real filesystem, so a
# mechanism cannot pass by lying about itself.
_PROBE_SOURCE = """\
import json, os, socket, sys, time

res = {"wrote_allowed": False, "wrote_denied": False, "network": "not-checked"}
try:
    with open(os.environ["VINV_PROBE_ALLOWED"], "w", encoding="utf-8") as fh:
        fh.write("allowed")
    res["wrote_allowed"] = True
except Exception as exc:
    res["allowed_error"] = str(exc)[:200]
try:
    with open(os.environ["VINV_PROBE_DENIED"], "w", encoding="utf-8") as fh:
        fh.write("escaped")
    res["wrote_denied"] = True
except Exception as exc:
    res["denied_error"] = str(exc)[:200]
if os.environ.get("VINV_PROBE_NETWORK") == "1":
    # 192.0.2.0/24 is TEST-NET-1: never routed, so an UNCONTAINED connect hangs
    # until the timeout while a contained one is refused instantly. Only an
    # immediate refusal counts as evidence of containment.
    started = time.monotonic()
    try:
        sock = socket.socket()
        sock.settimeout(0.6)
        sock.connect(("192.0.2.1", 9))
        res["network"] = "open"
    except socket.timeout:
        res["network"] = "open"
        res["network_error"] = "timed out — no evidence the network is blocked"
    except OSError as exc:
        res["network"] = "blocked"
        res["network_error"] = "%s: %s" % (exc.errno, exc)
    res["network_ms"] = round((time.monotonic() - started) * 1000)
sys.stdout.write(json.dumps(res))
"""


@dataclass
class _ProbeOutcome:
    ok: bool
    reason: str
    blocks_writes: bool = False
    blocks_network: bool = False
    checks: tuple[str, ...] = ()


def _run_probe(
    build: Any,
    *,
    python: str,
    block_network: bool,
    extra_env: Any = None,
) -> _ProbeOutcome:
    """Run ``_PROBE_SOURCE`` under a candidate and judge what it achieved.

    ``build(python_argv, allowed_dir, root)`` returns the wrapped argv. The
    parent checks the real filesystem afterwards: the probe's own report is
    corroborating detail, never the decision.
    """
    with tempfile.TemporaryDirectory(prefix="vinv-containment-probe-") as raw:
        base = Path(raw)
        allowed = base / "allowed"
        denied = base / "denied"
        allowed.mkdir()
        denied.mkdir()
        allowed_file = allowed / "inside.txt"
        denied_file = denied / "outside.txt"
        env = dict(os.environ)
        env["VINV_PROBE_ALLOWED"] = str(allowed_file)
        env["VINV_PROBE_DENIED"] = str(denied_file)
        env["VINV_PROBE_NETWORK"] = "1" if block_network else "0"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env.pop("PYTHONSTARTUP", None)
        env.pop("PYTHONPATH", None)
        if extra_env:
            env.update(extra_env([allowed]))
        cmd = build([python, "-c", _PROBE_SOURCE], [allowed])
        try:
            proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=PROBE_TIMEOUT_S,
                env=env,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return _ProbeOutcome(False, f"probe could not run: {exc}")
        try:
            reported = json.loads((proc.stdout or "").strip() or "{}")
        except ValueError:
            reported = {}
        if not isinstance(reported, dict):
            reported = {}
        # The parent's own evidence, which no child can fake.
        escaped = denied_file.exists()
        landed = allowed_file.exists()
        if escaped:
            return _ProbeOutcome(
                False,
                "a write outside the allowed root still landed on disk — "
                "this mechanism does not contain writes",
            )
        if not landed:
            detail = str(reported.get("allowed_error") or (proc.stderr or "").strip())[:200]
            return _ProbeOutcome(
                False,
                f"a write INSIDE the allowed root failed, so the mechanism is "
                f"unusable rather than strict: {detail or 'no output'}",
            )
        if reported.get("wrote_denied"):
            return _ProbeOutcome(
                False, "the probe reported the escaping write succeeded (inconsistent state)"
            )
        checks = ["write-inside-root-allowed", "write-outside-root-denied"]
        blocks_network = False
        if block_network:
            if reported.get("network") == "blocked":
                blocks_network = True
                checks.append("network-denied")
            else:
                return _ProbeOutcome(
                    False,
                    "the network was not refused ("
                    + str(reported.get("network_error") or reported.get("network") or "no result")
                    + ") — refusing to claim an OS network wall we did not observe",
                )
        return _ProbeOutcome(
            True,
            "probe passed",
            blocks_writes=True,
            blocks_network=blocks_network,
            checks=tuple(checks),
        )


def _probe_sandbox_exec(python: str, block_network: bool) -> tuple[_ProbeOutcome, str | None]:
    tool = shutil.which("sandbox-exec")
    if not tool:
        return _ProbeOutcome(False, "sandbox-exec is not on PATH"), None
    # Cheapest possible check first: does the OS compile and load the profile at
    # all? A profile that fails here would otherwise fail once per module.
    probe_profile = macos_profile([Path(tempfile.gettempdir())], block_network=block_network)
    try:
        loaded = subprocess.run(  # noqa: S603 (fixed argv, no shell)
            [tool, "-p", probe_profile, "/usr/bin/true"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROBE_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return _ProbeOutcome(False, f"sandbox-exec could not be run: {exc}"), tool
    if loaded.returncode != 0:
        return (
            _ProbeOutcome(
                False, f"sandbox-exec refused the profile: {(loaded.stderr or '').strip()[:200]}"
            ),
            tool,
        )

    def build(argv: list[str], writable: list[Path]) -> list[str]:
        return [tool, "-p", macos_profile(writable, block_network=block_network), *argv]

    outcome = _run_probe(build, python=python, block_network=block_network)
    if outcome.ok:
        outcome.checks = ("profile-loads", *outcome.checks)
    return outcome, tool


def _probe_bwrap(python: str, block_network: bool) -> tuple[_ProbeOutcome, str | None]:
    tool = shutil.which("bwrap")
    if not tool:
        return _ProbeOutcome(False, "bwrap (bubblewrap) is not on PATH"), None

    def build(argv: list[str], writable: list[Path]) -> list[str]:
        return bwrap_argv(tool, argv, writable, block_network=block_network)

    return _run_probe(build, python=python, block_network=block_network), tool


def _probe_unshare(python: str, block_network: bool) -> tuple[_ProbeOutcome, str | None]:
    tool = shutil.which("unshare")
    if not tool:
        return _ProbeOutcome(False, "unshare is not on PATH"), None

    def build(argv: list[str], writable: list[Path]) -> list[str]:
        return unshare_argv(tool, argv, writable, block_network=block_network)

    return (
        _run_probe(
            build,
            python=python,
            block_network=block_network,
            extra_env=lambda writable: unshare_env(writable, base={}),
        ),
        tool,
    )


# Ordered strongest-first per platform. Every entry is a candidate only; the
# probe decides.
def _candidates() -> list[tuple[str, Any]]:
    if sys.platform == "darwin":
        return [("sandbox-exec", _probe_sandbox_exec)]
    if sys.platform.startswith("linux"):
        return [("bwrap", _probe_bwrap), ("unshare", _probe_unshare)]
    return []


_CACHE: dict[tuple[bool, str], ContainmentMechanism] = {}


def reset_containment_cache() -> None:
    """Forget the probe results. For tests, and for a host that changed."""
    _CACHE.clear()


def detect_containment(
    *,
    block_network: bool = True,
    max_tier: ContainmentTier | str | None = None,
    python: str | None = None,
    logger: logging.Logger | None = None,
) -> ContainmentMechanism:
    """The strongest rung this host actually provides, PROBED and cached.

    ``max_tier`` is a deliberate ceiling — it exists so a caller (a test, a
    developer reproducing a report) can exercise the weaker rung on a host that
    offers a stronger one. It never raises the tier. ``require_tier`` lives on
    the policy, not here: this function reports what the host has, and refusing
    is the caller's decision.
    """
    log = logger or logging.getLogger(__name__)
    ceiling = parse_tier(max_tier)
    if ceiling is not None and ceiling is ContainmentTier.NONE:
        return ContainmentMechanism(
            tier=ContainmentTier.NONE,
            name="none",
            detail="containment capped at 'none' by the caller",
            fallback_reason="max_tier=none",
        )
    interpreter = python or sys.executable
    key = (bool(block_network), interpreter)
    mechanism = _CACHE.get(key)
    if mechanism is None:
        mechanism = _detect_uncached(interpreter, bool(block_network), log)
        _CACHE[key] = mechanism
    if ceiling is not None and mechanism.tier > ceiling:
        return ContainmentMechanism(
            tier=ContainmentTier.PROCESS_SHIM,
            name=SHIM_MECHANISM.name,
            detail=SHIM_MECHANISM.detail,
            checks=SHIM_MECHANISM.checks,
            fallback_reason=(
                f"{mechanism.name} probed clean but the caller capped containment "
                f"at '{ceiling.value}'"
            ),
            candidates=mechanism.candidates,
        )
    return mechanism


def _detect_uncached(python: str, block_network: bool, log: logging.Logger) -> ContainmentMechanism:
    tried: list[dict[str, Any]] = []
    for name, probe in _candidates():
        outcome, tool = probe(python, block_network)
        tried.append(
            {
                "name": name,
                "tier": ContainmentTier.OS_SANDBOX.value,
                "available": bool(outcome.ok),
                "reason": outcome.reason,
            }
        )
        if outcome.ok:
            log.info("containment: %s probed clean (%s)", name, ", ".join(outcome.checks))
            return ContainmentMechanism(
                tier=ContainmentTier.OS_SANDBOX,
                name=name,
                tool=tool,
                blocks_writes_outside_root=outcome.blocks_writes,
                blocks_network=outcome.blocks_network,
                detail=outcome.reason,
                checks=outcome.checks,
                candidates=tuple(tried),
            )
        log.debug("containment: %s unavailable — %s", name, outcome.reason)
    reason = (
        "; ".join(f"{c['name']}: {c['reason']}" for c in tried)
        if tried
        else f"no OS containment mechanism is known for platform {sys.platform!r}"
    )
    log.info("containment: falling back to the Python shim — %s", reason)
    return ContainmentMechanism(
        tier=ContainmentTier.PROCESS_SHIM,
        name=SHIM_MECHANISM.name,
        detail=SHIM_MECHANISM.detail,
        checks=SHIM_MECHANISM.checks,
        fallback_reason=reason,
        candidates=tuple(tried),
    )


# =========================================================================
# Reading an OS denial back off a row
# =========================================================================

# What a kernel refusal looks like by the time it reaches a result row. Under
# the shim these never fire — the shim raises its own `SandboxBlocked` and is
# matched by its defining module instead.
_DENIAL_ERRNOS = frozenset(
    {
        errno.EPERM,
        errno.EACCES,
        errno.EROFS,
        errno.ENETUNREACH,
        errno.ENETDOWN,
        errno.EHOSTUNREACH,
    }
)

# Messages a KERNEL refusal produces, for the case where the errno never made it
# onto the row. Kept short and literal.
_DENIAL_MARKERS = (
    "operation not permitted",
    "permission denied",
    "read-only file system",
    "network is unreachable",
    "no route to host",
)

# A C extension that swallows the errno and re-raises its own exception type is
# the whole reason a message path exists at all: `sqlite3.OperationalError:
# unable to open database file` is not an OSError and carries no errno, but it is
# exactly what a denied `open(2)` looks like from sqlite3. These markers are
# admissible ONLY on an exception that is itself DB-driver shaped (see
# `_driver_shaped`) — a repo's own error quoting the phrase is not a kernel
# denial no matter how it is worded.
_DRIVER_DENIAL_MARKERS = (
    "unable to open database file",
    "attempt to write a readonly database",
)

_NETWORK_MARKERS = ("network is unreachable", "no route to host")

# The exception classes a kernel refusal actually arrives as. `error_mro` is the
# authoritative test; `error_type` is the fallback for a row that carries no MRO
# (older result files, and workers that could not introspect the class).
_OS_ERROR_TYPES = frozenset(
    {
        "OSError",
        "IOError",
        "EnvironmentError",
        "PermissionError",
        "BlockingIOError",
        "ConnectionError",
        "ConnectionAbortedError",
        "ConnectionRefusedError",
        "ConnectionResetError",
        "BrokenPipeError",
        "TimeoutError",
    }
)

# PEP 249 §8 names these, and a DB driver written as a C extension is the one
# family that turns a kernel refusal into a non-OSError. `Error` alone is NOT
# accepted: it is far too common a name for a repo's own base exception.
_DBAPI_DENIAL_BASES = frozenset(
    {
        "DatabaseError",
        "OperationalError",
        "InterfaceError",
        "InternalError",
    }
)

# Modules whose exceptions are, by construction, a driver reporting what the OS
# told it. Accepted as an alternative to the MRO test.
_DRIVER_MODULES = frozenset(
    {
        "sqlite3",
        "_sqlite3",
        "sqlite3.dbapi2",
        "psycopg2",
        "psycopg",
        "MySQLdb",
        "pymysql",
    }
)


def _os_error_shaped(row: dict[str, Any]) -> bool:
    """Whether this row's exception really is an OS-level error CLASS."""
    mro = [str(c) for c in (row.get("error_mro") or [])]
    if mro:
        return any(name in _OS_ERROR_TYPES for name in mro)
    return str(row.get("error_type") or "") in _OS_ERROR_TYPES


def _driver_shaped(row: dict[str, Any]) -> bool:
    """Whether this row's exception is a DB driver's own error class."""
    mro = [str(c) for c in (row.get("error_mro") or [])]
    if any(name in _DBAPI_DENIAL_BASES for name in mro):
        return True
    return str(row.get("error_module") or "") in _DRIVER_MODULES


def os_denial(row: dict[str, Any]) -> tuple[str, str] | None:
    """``(kind, detail)`` when this row's error is an OS containment refusal.

    Only meaningful for a row produced under ``OS_SANDBOX``; the caller checks
    the tier. Within that class of exception it stays GENEROUS: an ambiguous
    ``PermissionError`` under a kernel wall is attributed to the wall, because
    containment must never be able to fabricate a finding.

    What it is NO LONGER is a bare substring test on the message. `mark_contained`
    promises judgement "by defining module and by MRO, both facts about the
    class", and every other apparatus in it keeps that promise; the OS branch did
    not. A message-only rule swallowed an app's own authorization
    ``PermissionError``, a ``ValueError`` that merely QUOTED "permission denied",
    and a config-driven "Network is unreachable" — silently, as `contained`. It
    also made verdicts TIER-DEPENDENT and therefore non-portable: the identical
    row was a reported defect on a Linux box without bwrap and contained on a Mac,
    which is not a property a defect finder may have. So the message may now only
    CORROBORATE a class that is already OS-level (or a DB driver's, the one family
    that provably discards the errno).
    """
    if row.get("status") != "error":
        return None
    message = str(row.get("error") or "").lower()
    mro = [str(c) for c in (row.get("error_mro") or [])]
    number = row.get("error_errno")
    kind = "network-denied" if any(m in message for m in _NETWORK_MARKERS) else "filesystem-denied"
    if isinstance(number, int) and number in _DENIAL_ERRNOS and "OSError" in mro:
        return kind, f"errno {number}: {str(row.get('error') or '')[:200]}"
    detail = f"{row.get('error_type', 'error')}: {str(row.get('error') or '')[:200]}"
    if _os_error_shaped(row) and any(marker in message for marker in _DENIAL_MARKERS):
        return kind, detail
    if _driver_shaped(row) and any(marker in message for marker in _DRIVER_DENIAL_MARKERS):
        return kind, detail
    return None
