"""The EXECUTION SANDBOX — testflow Phase 5, and the answer to a permanent refusal.

``functions.discover_targets`` refuses to call anything whose body touches the
filesystem, the network, a subprocess or a database, and records why. That guard
is correct — the harness imports third-party code and calls it in a process on a
developer's machine — but taken alone it caps the coverage ceiling at "whatever
happens to be pure", and the impure functions are usually the interesting ones.

This module makes the refusal RECOVERABLE rather than terminal: a target refused
only for impurity can be driven again inside containment, where its effects land
somewhere disposable and are RECORDED rather than merely prevented. The worker
keeps the same ``python -m ... --worker`` discipline as ``functions.py``, so a
hang or a hard exit still costs one module's rows and never the run.

What containment actually is
----------------------------

* **Filesystem** — the target runs against a COPY of the repo inside a fresh
  temp tree, with ``cwd`` on the copy and ``TMPDIR``/``TEMP``/``TMP``, ``HOME``
  and the ``XDG_*`` directories redirected into that tree. A write to a
  repo-relative path hits the copy; a write to ``$HOME`` or ``$TMPDIR`` hits the
  tree; the whole tree is discarded afterwards. A write to an ABSOLUTE path
  outside the tree is refused outright (see the shim below). The copy is
  measured, and a repo too large to copy under the configured cap makes the
  sandbox UNAVAILABLE — the target stays refused rather than being run loose.
* **Network** — a generated ``sitecustomize.py`` on the child's ``PYTHONPATH``
  replaces ``socket.socket``/``create_connection``/``getaddrinfo`` (and
  ``ssl.wrap_socket`` where it still exists) with functions that record the
  attempt and raise.
* **Processes** — the same shim replaces ``subprocess.Popen``, ``os.system``,
  ``os.popen``, the ``os.exec*``/``os.spawn*`` family and ``os.fork`` so a target
  that shells out is REPORTED as "attempted subprocess" instead of spawning one.
* **Resources** — the existing wall-clock module deadline, plus
  ``resource.setrlimit`` for ``RLIMIT_AS``/``RLIMIT_NOFILE``/``RLIMIT_NPROC``
  applied in a POSIX ``preexec_fn``. Every cap is guarded and only ever LOWERS a
  limit, so a platform that lacks one simply skips it.

The capability ladder
---------------------

The guards above are Python-level monkeypatches, and a monkeypatch is
structurally blind to a C extension calling ``open(2)``/``connect(2)`` itself.
That was not a theoretical gap: ``sqlite3.connect("/abs/path/outside")`` created
a real database outside the sandbox root, and ``sqlite3`` is exactly the kind of
module this sandbox exists to promote.

So the wall is chosen by ``containment.detect_containment``, which PROBES the
host and returns the strongest rung it can actually demonstrate:

* ``OS_SANDBOX`` — ``sandbox-exec`` (macOS), ``bwrap`` or ``unshare`` (Linux).
  A write outside the root is refused by the KERNEL, so it is impossible rather
  than intercepted, and the effect ledger may honestly claim completeness.
* ``PROCESS_SHIM`` — everything described above, unchanged. Accidents, not
  adversaries; ``effects_complete`` stays False wherever the static guard
  predicted C-level I/O.
* ``NONE`` — nothing runs.

The shim runs at every tier: under an OS sandbox it is no longer the wall, but
it is still the LEDGER, and "this function opened a socket" is worth reporting
even when the kernel would have refused it anyway. ``SandboxPolicy.require_tier``
lets a caller demand ``OS_SANDBOX`` and be REFUSED rather than quietly given the
weaker rung. Every report states the tier it achieved and what that tier
guarantees.

Failure is CLOSED. If the temp tree cannot be made, the shim cannot be written,
or the repo exceeds the copy cap, ``prepare_sandbox`` raises and every candidate
stays refused with a recorded reason. The worker itself re-checks that the shim
loaded and refuses to import a single target if it did not — "run anyway" is
never a branch in this module.

Docker/podman are deliberately NOT required. If one is present a future caller
may use it opportunistically, but the default path is stdlib only, so the
sandbox works on a laptop with nothing installed.
"""

from __future__ import annotations

import argparse
import fnmatch
import importlib
import json
import logging
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ._worker import worker_entrypoint
from .containment import (
    SHIM_MECHANISM,
    ContainmentMechanism,
    ContainmentTier,
    detect_containment,
    os_denial,
    parse_tier,
    unshare_env,
)

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids an import cycle
    from .functions import Refusal

# Directory/file names never worth copying into the sandbox tree: version
# control, virtualenvs, dependency trees, caches and build metadata. Keeping the
# copy cheap is what makes "copy the repo" a viable default rather than a
# minutes-long tax. Deliberately conservative — `build`/`dist`/`target` are NOT
# here, because excluding a directory that turns out to hold real source would
# turn a drivable target into a false import-error.
DEFAULT_EXCLUDES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".bzr",
        ".vinv",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".nox",
        ".idea",
        ".vscode",
        ".terraform",
        "*.egg-info",
        "*.pyc",
        "*.pyo",
    }
)

# Effect kinds the ledger records. `filesystem-escape` is a write that pointed
# outside the sandbox root and was therefore refused BY THE SHIM; `os-denied` is
# one the kernel refused, which is the only kind a C extension can produce.
EFFECT_KINDS = (
    "filesystem",
    "filesystem-escape",
    "network",
    "subprocess",
    "os-denied",
    "substitution-gap",
)

# =========================================================================
# What the shim CANNOT see — and must therefore not report as "no effect"
# =========================================================================
#
# The shim patches Python-level entry points (`builtins.open`, `os.open`, the
# `os` path family, `socket`, `subprocess`). A module that reaches the syscall
# from C — `sqlite3.connect` opening a database, `ctypes` calling `open(2)`,
# a libpq-backed driver writing a socket — goes straight past all of them, and
# `filesystem_delta` only walks INSIDE the sandbox root, so an absolute path
# outside it leaves no trace there either.
#
# The containment limit is documented and accepted (see the module docstring).
# The REPORTING limit is not: a row that came back `status: "ok"`, `effects: {}`
# and an empty ledger was affirmatively claiming the call had no effect. When
# the static guard already flagged an impurity in one of these modules, the row
# says the ledger is INCOMPLETE instead.
C_EXTENSION_IO = "c-extension-io"

# Module roots whose I/O is done in C and is therefore invisible to the shim.
# Every one of these is also in `functions._IMPURE_MODULE_ROOTS`, so they are
# precisely the targets the sandbox exists to promote.
#: The PEP 249 exception hierarchy. A driver MUST define these in its own
#: module, so the service substitute's copies are indistinguishable from a
#: fidelity gap by module name alone — but they mean the opposite: the database
#: answered, and the repo's data-layer bug is real. Never contained.
#: `SubstitutionGap` is deliberately absent: that one IS the substitute giving up.
_DBAPI_EXCEPTIONS: frozenset[str] = frozenset(
    {
        "Error",
        "DatabaseError",
        "OperationalError",
        "IntegrityError",
        "ProgrammingError",
        "DataError",
        "InternalError",
        "NotSupportedError",
        "InterfaceError",
    }
)

_UNOBSERVABLE_ROOTS: dict[str, str] = {
    "asyncpg": C_EXTENSION_IO,
    "ctypes": C_EXTENSION_IO,
    "mysqldb": C_EXTENSION_IO,
    "psycopg": C_EXTENSION_IO,
    "psycopg2": C_EXTENSION_IO,
    "sqlite3": C_EXTENSION_IO,
}

# Impurity reasons render the resolved call as `…name()`; this pulls the dotted
# name back out so the root can be matched against the table above.
_DOTTED_IN_REASON = re.compile(r"([A-Za-z_][A-Za-z0-9_.]*)\(\)")


def unobservable_effect_classes(reasons: Iterable[str]) -> list[str]:
    """Effect classes these impurities predict that the shim cannot WITNESS.

    Fed the static reasons the purity guard recorded for a target. A non-empty
    result means the effect ledger for that target is incomplete — an empty
    ``effects`` map on its rows is "we could not see", never "nothing happened".
    """
    out: set[str] = set()
    for reason in reasons or ():
        for dotted in _DOTTED_IN_REASON.findall(str(reason)):
            klass = _UNOBSERVABLE_ROOTS.get(dotted.split(".")[0].lower())
            if klass:
                out.add(klass)
    return sorted(out)


# How many recorded attempts one row may carry, and how many rows the report
# keeps. A pathological target can attempt thousands of writes; the ledger is
# evidence, not a transcript.
MAX_EFFECTS_PER_ROW = 20
MAX_EFFECT_ROWS = 200
MAX_TREE_ENTRIES = 200
# Names the copy report lists when `.gitignore` rules pruned entries. Bounded for
# the same reason as the ledger: enough to diagnose a missing module, not a
# transcript of a 5000-entry ignore file (the untruncated count is reported too).
MAX_REPORTED_PRUNES = 50

DEFAULT_MAX_COPY_MB = 256.0


class IsolationUnavailable(RuntimeError):
    """Containment could not be established, so nothing may be run.

    Raised — never swallowed into a "run anyway" path — when the temp tree
    cannot be created, the shim cannot be written, the repo is too large to copy
    under the configured cap, or the policy demanded a containment TIER this
    host cannot provide.
    """


@dataclass(frozen=True)
class SandboxPolicy:
    """How much containment to establish, and what to refuse when it cannot be.

    Defaults are the ones that hold on an unprivileged developer laptop with
    nothing installed. ``address_space_mb`` is applied on Linux only: on macOS
    CPython reserves a very large virtual address space at startup, so an
    ``RLIMIT_AS`` low enough to be meaningful kills the interpreter before it
    runs a line of target code. ``max_processes`` is off by default because
    ``RLIMIT_NPROC`` is per-USER on Linux, not per-process, so lowering it can
    starve unrelated processes the developer owns; process spawning is already
    blocked at the Python level.
    """

    enabled: bool = False
    max_copy_mb: float = DEFAULT_MAX_COPY_MB
    address_space_mb: int | None = 2048
    max_open_files: int | None = 512
    max_processes: int | None = None
    block_network: bool = True
    block_subprocess: bool = True
    block_escaping_writes: bool = True
    # OFF by default. A `.gitignore` entry means "not worth version-controlling",
    # which is NOT the same claim as "not needed to run" — for generated code the
    # two are exact opposites. A repo that ignores `_version.py`, `*_pb2.py`,
    # `config.py`, `local_settings.py` or `data/` had those files pruned out of
    # the sandbox copy, and the damage was SILENT: the resulting ImportError is
    # exempted at import phase by `functions.py`, so every target in the module
    # was dropped with a diagnostic indistinguishable from "this machine lacks a
    # dependency". A pruned file that does not break the import instead surfaces
    # later as a FileNotFoundError, which IS eligible to be reported as a repo
    # defect — a fabricated finding. Cheaper copies are not worth either.
    honour_gitignore: bool = False
    keep_root: bool = False
    # Substitute the services the repo expects to already be running (Postgres,
    # Redis, S3) INSIDE the jail. Default on, because the alternative to a
    # stand-in is not "the real service" — the network is blocked either way —
    # it is the target never running at all.
    synthesize_services: bool = True
    # Rows seeded into a table whose schema had to be induced, so a read path
    # has something to read. Zero leaves induced tables empty.
    seed_rows: int = 1
    # Where the disposable tree is created. ``None`` means the system temp
    # directory. A caller that also sets ``keep_root`` should set this, because
    # "keep the tree for inspection" without saying WHERE leaves one orphaned
    # tree per run in ``$TMPDIR`` forever.
    root_parent: Path | None = None
    exclude_patterns: frozenset[str] = DEFAULT_EXCLUDES
    # The weakest rung this caller will accept. ``OS_SANDBOX`` turns "the host
    # only offers the Python shim" from a silent downgrade into a REFUSAL, which
    # is the only way a caller can insist on a guarantee rather than hope for
    # one. ``None`` accepts whatever the ladder found (never ``NONE``).
    require_tier: ContainmentTier | None = None
    # A deliberate CEILING, for exercising the weaker rung on a host that offers
    # a stronger one — a test reproducing shim behaviour, an operator narrowing
    # down a difference. It can only ever weaken, and the report says so.
    max_tier: ContainmentTier | None = None

    @property
    def max_copy_bytes(self) -> int:
        return int(max(0.0, self.max_copy_mb) * 1024 * 1024)

    def to_json(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "max_copy_mb": self.max_copy_mb,
            "address_space_mb": self.address_space_mb,
            "max_open_files": self.max_open_files,
            "max_processes": self.max_processes,
            "block_network": self.block_network,
            "block_subprocess": self.block_subprocess,
            "block_escaping_writes": self.block_escaping_writes,
            "honour_gitignore": self.honour_gitignore,
            "synthesize_services": self.synthesize_services,
            "seed_rows": self.seed_rows,
            "require_tier": self.require_tier.value if self.require_tier else None,
            "max_tier": self.max_tier.value if self.max_tier else None,
        }


@dataclass
class CopyReport:
    """What copying the repo into the sandbox actually cost."""

    files: int
    bytes: int
    ms: float
    cap_bytes: int
    skipped_dirs: int = 0
    # WHAT was pruned, and by which rule. A count alone cannot answer the only
    # question that matters when a module vanishes from the run — "did the
    # sandbox delete something the import needed?" — so a dropped module used to
    # be undiagnosable from the report. Names are relative to the repo root and
    # bounded, because a large `.gitignore` can prune thousands of entries.
    gitignore_pruned: tuple[str, ...] = ()
    gitignore_pruned_total: int = 0

    def to_json(self) -> dict[str, Any]:
        return {
            "files": self.files,
            "bytes": self.bytes,
            "mb": round(self.bytes / (1024 * 1024), 3),
            "ms": round(self.ms, 1),
            "cap_bytes": self.cap_bytes,
            "cap_mb": round(self.cap_bytes / (1024 * 1024), 3),
            "excluded_dirs": self.skipped_dirs,
            "gitignore_pruned": list(self.gitignore_pruned),
            "gitignore_pruned_total": self.gitignore_pruned_total,
        }


@dataclass
class Sandbox:
    """A prepared, disposable containment tree."""

    root: Path
    repo_copy: Path
    tmp: Path
    home: Path
    shim: Path
    plans: Path
    ledger: Path
    copy: CopyReport
    services: Path | None = None
    service_plan: Path | None = None
    service_ledger: Path | None = None
    policy: SandboxPolicy = field(default_factory=SandboxPolicy)
    mechanism: ContainmentMechanism = SHIM_MECHANISM

    @property
    def tier(self) -> ContainmentTier:
        return self.mechanism.tier

    def dispose(self) -> bool:
        """Discard the whole tree — every effect the target had lands here.

        Returns whether the root is actually gone, because the caller records
        that in the run report and used to assert it unconditionally.

        `ignore_errors=True` alone was silently insufficient: `copy_repo` uses
        `shutil.copy2`, which PRESERVES the read-only attribute, so any
        read-only file in the source repo produced a read-only copy that
        `os.unlink` refuses to remove on Windows. The error was swallowed and
        the entire tree — including everything the target wrote — was left in
        `%TEMP%`, run after run, while the report claimed `root_removed: true`.
        Clear the attribute and retry before giving up.
        """
        if self.policy.keep_root:
            return False

        def _force_writable(func: Any, path: str, _exc: Any) -> None:
            try:
                os.chmod(path, stat.S_IWRITE)
                func(path)
            except OSError:
                pass  # genuinely stuck (a lock, a long path) — reported below

        try:
            shutil.rmtree(self.root, onexc=_force_writable)
        except TypeError:  # onexc is 3.12+; onerror is the older spelling
            shutil.rmtree(self.root, onerror=lambda f, p, e: _force_writable(f, p, e))
        except OSError:
            pass
        return not self.root.exists()


# =========================================================================
# The repo copy — the containment guarantee that does not depend on patching
# =========================================================================


def gitignore_patterns(repo: Path) -> frozenset[str]:
    """NAME patterns from the repo's own ``.gitignore``.

    Deliberately "gitignore-ish", not gitignore: only unanchored name patterns
    are honoured (a rule containing ``/`` is path-anchored and matching it by
    name would exclude the wrong thing), and negations are ignored. The point is
    to keep the copy cheap by skipping what the repo itself calls disposable,
    not to reimplement git's matcher.
    """
    try:
        text = (repo / ".gitignore").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return frozenset()
    out: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("!"):
            continue
        line = line.rstrip("/")
        if "/" in line or not line:
            continue
        out.add(line)
    return frozenset(out)


def _excluded(name: str, patterns: frozenset[str]) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in patterns)


def copy_repo(repo: Path, dest: Path, policy: SandboxPolicy) -> CopyReport:
    """Copy ``repo`` into ``dest``, measuring the cost and honouring the cap.

    Symlinks are never followed: a link out of the tree is exactly the escape
    the copy exists to prevent. Exceeding ``policy.max_copy_bytes`` raises
    ``IsolationUnavailable`` mid-copy — the caller must then leave every
    candidate refused rather than fall back to running unsandboxed.

    When ``policy.honour_gitignore`` is on (it is off by default — see
    ``SandboxPolicy``), everything the ``.gitignore`` rules pruned is RECORDED on
    the report. Pruning a file the repo needs at runtime is otherwise invisible:
    the module simply fails to import inside the copy and its targets are dropped
    with a message that reads exactly like a missing third-party dependency.
    """
    started = time.monotonic()
    patterns = set(policy.exclude_patterns)
    ignored = frozenset(gitignore_patterns(repo)) if policy.honour_gitignore else frozenset()
    patterns |= set(ignored)
    frozen = frozenset(patterns)
    cap = policy.max_copy_bytes

    files = 0
    total = 0
    pruned = 0
    ignore_pruned: list[str] = []
    ignore_pruned_total = 0
    dest.mkdir(parents=True, exist_ok=True)
    stack: list[tuple[Path, Path]] = [(repo, dest)]
    while stack:
        src_dir, dst_dir = stack.pop()
        try:
            entries = sorted(os.scandir(src_dir), key=lambda e: e.name)
        except OSError:
            continue
        for entry in entries:
            if _excluded(entry.name, frozen):
                pruned += 1
                # Attribute the prune. Only the gitignore-derived rules are
                # reported: `DEFAULT_EXCLUDES` (`.git`, `node_modules`, …) are
                # this harness's own fixed policy and can never surprise anyone,
                # whereas a rule that came out of the repo's own `.gitignore` is
                # exactly what a reader needs to see when a module goes missing.
                if ignored and _excluded(entry.name, ignored):
                    ignore_pruned_total += 1
                    if len(ignore_pruned) < MAX_REPORTED_PRUNES:
                        try:
                            rel = str(Path(entry.path).relative_to(repo))
                        except ValueError:  # pragma: no cover - defensive
                            rel = entry.name
                        ignore_pruned.append(rel)
                continue
            if entry.is_symlink():
                continue
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                child = dst_dir / entry.name
                try:
                    child.mkdir(exist_ok=True)
                except OSError:
                    continue
                stack.append((Path(entry.path), child))
                continue
            try:
                size = entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
            total += size
            files += 1
            if cap and total > cap:
                raise IsolationUnavailable(
                    f"repo copy exceeds the {policy.max_copy_mb:g} MB cap "
                    f"({total / (1024 * 1024):.1f} MB after {files} files) — "
                    "raise --sandbox-max-copy-mb or leave the target refused"
                )
            try:
                shutil.copy2(entry.path, dst_dir / entry.name)
            except OSError:
                files -= 1
                total -= size
    return CopyReport(
        files=files,
        bytes=total,
        ms=(time.monotonic() - started) * 1000.0,
        cap_bytes=cap,
        skipped_dirs=pruned,
        gitignore_pruned=tuple(ignore_pruned),
        gitignore_pruned_total=ignore_pruned_total,
    )


# =========================================================================
# The shim — generated sitecustomize, imported before any target code
# =========================================================================

# Written into the sandbox tree and put FIRST on the child's PYTHONPATH, so
# `site` imports it at interpreter start, before the worker and long before any
# target module. It is deliberately stdlib-only and defensive: a shim that
# raised on import would take the worker with it, and the worker's own
# fail-closed check would then be the thing that reports it.
_SITECUSTOMIZE_SOURCE = '''\
"""Vinv execution-sandbox containment shim (generated — do not edit).

Imported by ``site`` at interpreter start because this directory is first on
PYTHONPATH. It records, and where configured refuses, the effects a target
reaches for: sockets, process spawning, and writes that would leave the sandbox
root. Attempts land on ``sys.__vinv_sandbox_ledger__`` so the parent can report
what the target TRIED to do, which is a behavioural fact worth having even when
the call succeeds.

This stops a well-behaved Python client, and (through ``os.open``) the common
low-level write too. It does not stop ``ctypes``, a C extension calling
``open(2)`` directly, or a target that re-execs a fresh interpreter. Containment
here is about accidents, not adversaries; the durable guarantee is the
disposable tree this process runs in.
"""

import atexit
import builtins
import io
import json
import os
import sys

# NOT `os.path.realpath(... or "")`: realpath("") returns the CURRENT WORKING
# DIRECTORY, never "". So the trailing `or ""` was unreachable, `_ROOT` was
# always truthy, and the `if not _ROOT: return False` fail-closed guard below
# was dead code — with the env var unset, cwd silently became the sandbox root
# and every write under it was permitted. That is precisely the fail-OPEN the
# guard exists to prevent, and it bites exactly when the shim is on PYTHONPATH
# outside a sandboxed run.
_ROOT_RAW = os.environ.get("VINV_SANDBOX_ROOT") or ""
_ROOT = os.path.realpath(_ROOT_RAW) if _ROOT_RAW else ""
_LEDGER_PATH = os.environ.get("VINV_SANDBOX_LEDGER") or ""
_BLOCK_NET = os.environ.get("VINV_SANDBOX_BLOCK_NETWORK", "1") == "1"
_BLOCK_PROC = os.environ.get("VINV_SANDBOX_BLOCK_SUBPROCESS", "1") == "1"
_BLOCK_ESCAPE = os.environ.get("VINV_SANDBOX_BLOCK_ESCAPING_WRITES", "1") == "1"

_MAX_ATTEMPTS = 4000
_WRITE_MODE_CHARS = ("w", "a", "x", "+")
# Character devices a contained process may legitimately write to: they hold no
# state, so a write to one leaves nothing behind to discard.
_ALLOWED_DEVICES = frozenset(
    {"/dev/null", "/dev/zero", "/dev/stdout", "/dev/stderr", "/dev/tty", "nul", "NUL"}
)

_real_open = builtins.open


class SandboxBlocked(RuntimeError):
    """An effect the Vinv execution sandbox refused."""


class _Ledger:
    """In-memory record of every effect attempted in this process."""

    def __init__(self):
        self.attempts = []

    def record(self, kind, detail, blocked):
        if len(self.attempts) >= _MAX_ATTEMPTS:
            return
        try:
            rendered = str(detail)[:300]
        except Exception:
            rendered = "<unrenderable>"
        self.attempts.append({"kind": kind, "detail": rendered, "blocked": bool(blocked)})


_ledger = _Ledger()
sys.__vinv_sandbox_ledger__ = _ledger


def _flush():
    """Persist the ledger so a worker that dies still reports what it tried."""
    if not _LEDGER_PATH:
        return
    try:
        with _real_open(_LEDGER_PATH, "w", encoding="utf-8") as fh:
            json.dump(_ledger.attempts, fh, default=str)
    except Exception:
        pass


atexit.register(_flush)


def _inside_root(path):
    if not _ROOT:
        return False
    try:
        real = os.path.realpath(path)
    except (TypeError, ValueError, OSError):
        return False
    return real == _ROOT or real.startswith(_ROOT + os.sep)


def _permitted(path):
    try:
        text = os.fspath(path)
    except TypeError:
        return True  # an already-open descriptor or file object
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    if text in _ALLOWED_DEVICES:
        return True
    return _inside_root(text)


def _guard_write(op, path):
    detail = "%s(%s)" % (op, path)
    if _permitted(path) or not _BLOCK_ESCAPE:
        _ledger.record("filesystem", detail, False)
        return
    _ledger.record("filesystem-escape", detail, True)
    raise SandboxBlocked(detail + " would write outside the Vinv sandbox root")


def _sandbox_open(file, mode="r", *args, **kwargs):
    text_mode = mode if isinstance(mode, str) else "r"
    if any(ch in text_mode for ch in _WRITE_MODE_CHARS):
        _guard_write("open", file)
    return _real_open(file, mode, *args, **kwargs)


builtins.open = _sandbox_open
io.open = _sandbox_open

# The low-level descriptor open, which `builtins.open` does NOT go through (it
# reaches the syscall from C). `tempfile` and `shutil` do use it, and both stay
# inside the redirected tree, so guarding it costs nothing and closes the most
# plausible accidental bypass. `importlib` writes bytecode through the `posix`
# module object rather than through `os`, so imports are unaffected either way.
_real_os_open = os.open
_WRITE_FLAGS = 0
for _flag in ("O_WRONLY", "O_RDWR", "O_CREAT", "O_APPEND", "O_TRUNC"):
    _WRITE_FLAGS |= getattr(os, _flag, 0)


def _sandbox_os_open(path, flags, *args, **kwargs):
    try:
        writing = bool(int(flags) & _WRITE_FLAGS)
    except (TypeError, ValueError):
        writing = True  # an unreadable flag word is not assumed read-only
    if writing:
        _guard_write("os.open", path)
    return _real_os_open(path, flags, *args, **kwargs)


os.open = _sandbox_os_open


def _wrap_one_path(name):
    real = getattr(os, name, None)
    if real is None:
        return

    def patched(path, *args, **kwargs):
        _guard_write("os." + name, path)
        return real(path, *args, **kwargs)

    patched.__name__ = name
    setattr(os, name, patched)


def _wrap_two_paths(name):
    real = getattr(os, name, None)
    if real is None:
        return

    def patched(src, dst, *args, **kwargs):
        _guard_write("os." + name, src)
        _guard_write("os." + name, dst)
        return real(src, dst, *args, **kwargs)

    patched.__name__ = name
    setattr(os, name, patched)


# `makedirs`/`removedirs` are deliberately absent: they call the wrapped
# `os.mkdir`/`os.rmdir` through the module globals, so wrapping them too would
# double-record the same effect.
for _name in ("remove", "unlink", "rmdir", "mkdir", "truncate", "chmod", "chown"):
    _wrap_one_path(_name)
for _name in ("rename", "replace", "link", "symlink"):
    _wrap_two_paths(_name)


def _blocker(kind, what, message):
    def patched(*args, **kwargs):
        detail = what
        if args:
            try:
                detail = "%s %s" % (what, repr(args[0])[:160])
            except Exception:
                pass
        _ledger.record(kind, detail, True)
        raise SandboxBlocked(message)

    patched.__name__ = what.replace(".", "_")
    return patched


def _blocker_class(kind, what, message, original):
    """A class-shaped blocker, for replacing a name that WAS a class.

    Replacing a class with a function breaks every subclasser: ``class X(Popen)``
    resolves its metaclass as ``type(Popen)``, which for a function is
    ``function`` — so Python calls ``function('X', bases, namespace)`` and raises
    ``TypeError: function() argument 'code' must be code, not str`` from the
    ``class`` statement itself. On Windows ``asyncio.windows_utils`` does exactly
    ``class Popen(subprocess.Popen)`` at module scope, and ``asyncio`` is imported
    by most of the ecosystem (any ``tqdm.auto``, any HTTP client), so every module
    that transitively touched it failed to import under the shim — and the harness
    attributed each failure to the REPO as an ``import-error`` defect. Eighteen
    fabricated findings on a clean third-party codebase, all of them ours, and
    invisible to CI because there is no Windows job.

    Pre-importing the known subclasser (as this shim already does for ``ssl``,
    which subclasses ``socket.socket``) only covers subclassers you thought of,
    and never the lazily-imported ones. Staying class-shaped covers all of them.

    Inherits from the original so ``issubclass``/``isinstance`` still hold and a
    subclass body referring to inherited attributes still builds. Blocking in
    ``__new__`` means subclasses are blocked too, which is the point.
    """
    def _blocked_new(cls, *args, **kwargs):
        detail = what
        if args:
            try:
                detail = "%s %s" % (what, repr(args[0])[:160])
            except Exception:
                pass
        _ledger.record(kind, detail, True)
        raise SandboxBlocked(message)

    name = getattr(original, "__name__", what.replace(".", "_"))
    try:
        blocked = type(name, (original,), {"__new__": _blocked_new})
    except Exception:
        # A type that refuses subclassing (final, or a C type with an
        # incompatible layout). Still a CLASS — the `class X(...)` statement is
        # what must keep working — just without the inheritance relationship.
        blocked = type(name, (object,), {"__new__": _blocked_new})
    blocked.__qualname__ = name
    return blocked


def _install_blocker(module, name, kind, what, message):
    """Replace ``module.name``, preserving whether it was a class or a function."""
    original = getattr(module, name, None)
    if original is None:
        return
    if isinstance(original, type):
        setattr(module, name, _blocker_class(kind, what, message, original))
    else:
        setattr(module, name, _blocker(kind, what, message))


if _BLOCK_NET:
    # `ssl` subclasses `socket.socket`, so it must be imported BEFORE the class
    # is replaced or its module body raises at class-creation time.
    try:
        import ssl as _ssl
    except Exception:
        _ssl = None
    try:
        import socket as _socket
    except Exception:
        _socket = None
    if _socket is not None:
        for _name in (
            "socket",
            "create_connection",
            "create_server",
            "socketpair",
            "getaddrinfo",
            "gethostbyname",
        ):
            # `socket.socket` is a CLASS and `create_connection` etc. are
            # functions; `_install_blocker` keeps each one's shape.
            _install_blocker(
                _socket,
                _name,
                "network",
                "socket." + _name + "()",
                "network access is blocked by the Vinv execution sandbox",
            )
    if _ssl is not None and hasattr(_ssl, "wrap_socket"):
        _ssl.wrap_socket = _blocker(
            "network",
            "ssl.wrap_socket()",
            "network access is blocked by the Vinv execution sandbox",
        )

if _BLOCK_PROC:
    _PROC_MSG = "process spawning is blocked by the Vinv execution sandbox"
    try:
        import subprocess as _subprocess
    except Exception:
        _subprocess = None
    if _subprocess is not None:
        # `run`/`call`/`check_call`/`check_output` all construct a Popen through
        # the module global, so replacing that one name covers the family.
        # Class-shaped: `asyncio.windows_utils` subclasses this at import time.
        _install_blocker(_subprocess, "Popen", "subprocess", "subprocess.Popen", _PROC_MSG)
    for _name in (
        "system",
        "popen",
        "fork",
        "forkpty",
        "posix_spawn",
        "posix_spawnp",
        "execv",
        "execve",
        "execl",
        "execle",
        "execlp",
        "execlpe",
        "execvp",
        "execvpe",
        "spawnl",
        "spawnle",
        "spawnlp",
        "spawnlpe",
        "spawnv",
        "spawnve",
        "spawnvp",
        "spawnvpe",
    ):
        if hasattr(os, _name):
            setattr(os, _name, _blocker("subprocess", "os." + _name, _PROC_MSG))

# --------------------------------------------------------------------------
# Service doubles — the stand-ins that make blocked network survivable
# --------------------------------------------------------------------------
# Blocking the network is only half an answer: a target that needs Postgres now
# fails to connect instead of running. The doubles substitute the service INSIDE
# the jail, so the guarantee is untouched and the code path still executes. They
# install here, before any repo module is imported, because a client library
# imported first would already hold a reference to the real connect().
_SERVICE_PLAN = os.environ.get("VINV_SERVICE_PLAN") or ""
if _SERVICE_PLAN:
    _service_error = ""
    try:
        with open(_SERVICE_PLAN, "r") as _fh:
            _spec = json.load(_fh)
    except Exception as _exc:
        _spec = {}
        _service_error = "unreadable service plan: %s" % (_exc,)
    if _spec.get("enabled") and _spec.get("requirements"):
        try:
            import _vinv_service_doubles as _doubles

            _doubles.install(
                directory=os.environ.get("VINV_SERVICE_DIR") or os.path.join(_ROOT, "services"),
                ledger=os.environ.get("VINV_SERVICE_LEDGER") or "",
                seed_rows=int(_spec.get("seed_rows", 1) or 0),
                schema_sources=_spec.get("schema_sources") or [],
                fixtures=_spec.get("fixtures") or [],
            )
            sys.__vinv_service_doubles__ = _doubles
        except Exception as _exc:
            _service_error = "service doubles failed to install: %s" % (_exc,)
    if _service_error:
        # Never swallowed: a run whose doubles did not install would otherwise
        # look like a repo that cannot connect, which is the parent's bug
        # wearing the repo's face.
        try:
            with open(os.environ.get("VINV_SERVICE_LEDGER") or os.devnull, "a") as _fh:
                _fh.write(json.dumps({"kind": "install-error", "detail": _service_error}) + chr(10))
        except Exception:
            pass
'''


def write_shim(directory: Path) -> Path:
    """Write the generated ``sitecustomize.py`` and return its path.

    The service doubles ship alongside it as ``_vinv_service_doubles`` — a COPY
    of :mod:`exerciser.service_doubles`, not an import of it, because the worker
    has only the standard library and the repo on its path. The module is
    dependency-free precisely so this copy is a copy and nothing more.
    """
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "sitecustomize.py"
    path.write_text(_SITECUSTOMIZE_SOURCE, encoding="utf-8")
    doubles = Path(__file__).with_name("service_doubles.py")
    if doubles.is_file():
        shutil.copy2(doubles, directory / "_vinv_service_doubles.py")
    return path


# =========================================================================
# Preparing / configuring the containment
# =========================================================================


def resolve_mechanism(
    policy: SandboxPolicy,
    *,
    python: str | None = None,
    logger: logging.Logger | None = None,
) -> ContainmentMechanism:
    """The rung this policy gets, or ``IsolationUnavailable`` if it demanded more.

    The refusal is the entire point of ``require_tier``: a caller that asked for
    an OS wall and was handed the Python shim would otherwise have no way to
    tell, and would go on reporting completeness it never had.
    """
    mechanism = detect_containment(
        block_network=policy.block_network,
        max_tier=policy.max_tier,
        python=python,
        logger=logger,
    )
    required = parse_tier(policy.require_tier)
    if required is not None and mechanism.tier < required:
        raise IsolationUnavailable(
            f"policy requires containment tier '{required.value}' but this host "
            f"only offers '{mechanism.tier.value}' "
            f"({mechanism.fallback_reason or mechanism.detail or 'no reason recorded'})"
        )
    return mechanism


def prepare_sandbox(
    repo: Path,
    policy: SandboxPolicy,
    *,
    parent_dir: Path | None = None,
    mechanism: ContainmentMechanism | None = None,
) -> Sandbox:
    """Build a disposable containment tree for ``repo``, or refuse.

    Raises ``IsolationUnavailable`` when the tree cannot be made, the shim
    cannot be written, the repo exceeds the copy cap, or the policy demanded a
    tier the host cannot provide. There is no partial success: a caller that
    catches this must leave every candidate refused.
    """
    mechanism = mechanism or resolve_mechanism(policy)
    repo = repo.resolve()
    parent = parent_dir or policy.root_parent
    try:
        root = Path(tempfile.mkdtemp(prefix="vinv-sandbox-", dir=str(parent) if parent else None))
    except OSError as exc:
        raise IsolationUnavailable(f"cannot create a sandbox temp tree: {exc}") from exc
    try:
        tmp = root / "tmp"
        home = root / "home"
        shim = root / "shim"
        plans = root / "plans"
        for path in (
            tmp,
            home,
            home / ".cache",
            home / ".config",
            home / ".local" / "share",
            home / ".local" / "state",
            plans,
        ):
            path.mkdir(parents=True, exist_ok=True)
        write_shim(shim)
        services = root / "services"
        services.mkdir(parents=True, exist_ok=True)
        dest = root / "repo" / (repo.name or "repo")
        report = copy_repo(repo, dest, policy)
        service_plan: Path | None = None
        service_ledger: Path | None = None
        if policy.synthesize_services:
            from .services import answered_fixtures, plan_services

            plan_doc = plan_services(repo, seed_rows=policy.seed_rows).to_json()
            # Fixtures the agent channel has already answered ride along, so a
            # table induced last run is populated with representative data
            # this run instead of placeholders.
            plan_doc["fixtures"] = answered_fixtures(repo)
            service_plan = root / "service_plan.json"
            service_plan.write_text(json.dumps(plan_doc, indent=2), encoding="utf-8")
            service_ledger = root / "service_ledger.json"
    except IsolationUnavailable:
        shutil.rmtree(root, ignore_errors=True)
        raise
    except OSError as exc:
        shutil.rmtree(root, ignore_errors=True)
        raise IsolationUnavailable(f"cannot establish isolation: {exc}") from exc
    except BaseException:
        # Anything else still orphans a FULLY POPULATED tree (the repo copy
        # happens above). Only IsolationUnavailable/OSError were caught, but
        # `plan_services`/`answered_fixtures` run after the copy and read
        # user-editable JSON: a hand-edited `agent_fixture.json` whose
        # `questions` is a list raises AttributeError, which escaped both
        # handlers and leaked the whole tree. Clean up, then re-raise unchanged.
        shutil.rmtree(root, ignore_errors=True)
        raise
    return Sandbox(
        root=root,
        repo_copy=dest,
        tmp=tmp,
        home=home,
        shim=shim,
        plans=plans,
        ledger=root / "ledger.json",
        copy=report,
        services=services,
        service_plan=service_plan,
        service_ledger=service_ledger,
        policy=policy,
        mechanism=mechanism,
    )


def sandbox_env(
    sandbox: Sandbox,
    *,
    base_env: dict[str, str] | None = None,
    extra_pythonpath: Sequence[str] = (),
) -> dict[str, str]:
    """Environment for a sandbox worker: every disposable path redirected inside.

    ``HOME``/``TMPDIR``/``XDG_*`` all point into the tree, so a target that
    writes "to the user's home" writes to a directory that is about to be
    deleted. ``PYTHONDONTWRITEBYTECODE`` is set because bytecode written beside
    an importable module OUTSIDE the tree would otherwise be a (blocked) escape
    on every single import.
    """
    env = dict(os.environ if base_env is None else base_env)
    policy = sandbox.policy
    for var in ("TMPDIR", "TEMP", "TMP"):
        env[var] = str(sandbox.tmp)
    env["HOME"] = str(sandbox.home)
    env["USERPROFILE"] = str(sandbox.home)
    # Match the parent's UTF-8 decoding of this worker's pipes. The locale
    # encoding is cp1252 on Windows for every supported interpreter, so without
    # this a target printing non-cp1252 text dies with UnicodeEncodeError and
    # takes the whole module's rows with it.
    env["PYTHONIOENCODING"] = "utf-8"
    # `%APPDATA%`/`%LOCALAPPDATA%` are the Windows-native equivalents of the
    # XDG vars below; leaving them alone let `platformdirs`, the pip cache, and
    # HF/matplotlib caches write to the developer's REAL AppData from inside
    # what is supposed to be a disposable tree.
    env["APPDATA"] = str(sandbox.home / "AppData" / "Roaming")
    env["LOCALAPPDATA"] = str(sandbox.home / "AppData" / "Local")
    env["HOMEDRIVE"] = ""
    env["HOMEPATH"] = str(sandbox.home)
    env["XDG_CACHE_HOME"] = str(sandbox.home / ".cache")
    env["XDG_CONFIG_HOME"] = str(sandbox.home / ".config")
    env["XDG_DATA_HOME"] = str(sandbox.home / ".local" / "share")
    env["XDG_STATE_HOME"] = str(sandbox.home / ".local" / "state")
    env["XDG_RUNTIME_DIR"] = str(sandbox.tmp)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("PYTHONSTARTUP", None)
    env["VINV_SANDBOX"] = "1"
    env["VINV_SANDBOX_ROOT"] = str(sandbox.root)
    env["VINV_SANDBOX_LEDGER"] = str(sandbox.ledger)
    env["VINV_SANDBOX_BLOCK_NETWORK"] = "1" if policy.block_network else "0"
    env["VINV_SANDBOX_BLOCK_SUBPROCESS"] = "1" if policy.block_subprocess else "0"
    env["VINV_SANDBOX_BLOCK_ESCAPING_WRITES"] = "1" if policy.block_escaping_writes else "0"
    # The worker's completeness claim follows the TIER, so the tier has to reach
    # the worker. A missing/unknown value reads as the weakest rung, which is the
    # fail-closed direction: it can only ever make the report more cautious.
    env["VINV_CONTAINMENT_TIER"] = sandbox.mechanism.tier.value
    if sandbox.service_plan is not None:
        env["VINV_SERVICE_PLAN"] = str(sandbox.service_plan)
        env["VINV_SERVICE_DIR"] = str(sandbox.services or (sandbox.root / "services"))
        env["VINV_SERVICE_LEDGER"] = str(
            sandbox.service_ledger or (sandbox.root / "service_ledger.json")
        )
    env["VINV_CONTAINMENT_MECHANISM"] = sandbox.mechanism.name
    if sandbox.mechanism.name == "unshare":
        env.update(unshare_env([sandbox.root], base=env))
    parts = [str(sandbox.shim), *(str(p) for p in extra_pythonpath)]
    inherited = env.get("PYTHONPATH")
    if inherited:
        parts.append(inherited)
    env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(parts))
    return env


def planned_rlimits(policy: SandboxPolicy) -> list[tuple[str, int]]:
    """The ``(RLIMIT_*, value)`` caps this policy asks for on this platform.

    Separated from application so it can be inspected (and tested) without
    mutating the current process's limits.
    """
    caps: list[tuple[str, int]] = []
    if policy.max_open_files:
        caps.append(("RLIMIT_NOFILE", int(policy.max_open_files)))
    if policy.address_space_mb and sys.platform.startswith("linux"):
        # macOS/BSD CPython reserves a very large virtual address space at
        # startup, so a meaningful RLIMIT_AS kills the interpreter before it
        # reaches target code. Skipped there rather than set uselessly high.
        caps.append(("RLIMIT_AS", int(policy.address_space_mb) * 1024 * 1024))
    if policy.max_processes:
        caps.append(("RLIMIT_NPROC", int(policy.max_processes)))
    return caps


def rlimit_preexec(policy: SandboxPolicy) -> Callable[[], None] | None:
    """A ``preexec_fn`` applying this policy's caps, or None where unavailable.

    Never RAISES a limit and never fails the spawn: a platform missing a
    particular ``RLIMIT_*``, or a hard limit below what we asked for, simply
    yields a smaller set of caps. The wall-clock deadline in the driver is the
    containment that holds everywhere.
    """
    if os.name != "posix":
        return None
    try:
        import resource  # noqa: F401  (probe: the module may not exist)
    except ImportError:
        return None
    caps = planned_rlimits(policy)
    if not caps:
        return None

    def _apply() -> None:  # pragma: no cover - runs in the forked child
        import resource as _resource

        for name, value in caps:
            which = getattr(_resource, name, None)
            if which is None:
                continue
            try:
                soft, hard = _resource.getrlimit(which)
            except (ValueError, OSError):
                continue
            target = value
            if hard != _resource.RLIM_INFINITY:
                target = min(target, hard)
            if soft != _resource.RLIM_INFINITY and soft <= target:
                continue  # already at least this strict — never loosen
            try:
                _resource.setrlimit(which, (target, hard))
            except (ValueError, OSError):
                continue

    return _apply


# =========================================================================
# Effect accounting
# =========================================================================


def group_attempts(attempts: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    """Ledger entries grouped by kind, bounded, for one row."""
    out: dict[str, list[str]] = {}
    for attempt in attempts:
        if not isinstance(attempt, dict):
            continue
        kind = str(attempt.get("kind") or "unknown")
        detail = str(attempt.get("detail") or "")
        bucket = out.setdefault(kind, [])
        if len(bucket) < MAX_EFFECTS_PER_ROW and detail not in bucket:
            bucket.append(detail)
    return out


def mark_contained(row: dict[str, Any], tier: ContainmentTier | None = None) -> dict[str, Any]:
    """Tag a row whose exception came from the containment, not from the target.

    An exception our APPARATUS raised is the apparatus working, not the target
    failing: "this function opens a socket" is already reported, honestly, as an
    effect-ledger entry. Without this tag the verdict path would manufacture one
    ``function-crash`` per contained target — a defect per blocked socket — which
    is precisely the false signal that makes a harness ignorable.

    Two apparatus, two tests. For the SHIM, the exception's defining module
    (``sitecustomize``) — a fact about the class rather than a guess from its
    message, so a target that catches ``SandboxBlocked`` and raises its own error
    is still judged on its own error. For an OS SANDBOX, the shape of a kernel
    refusal (a denial errno, or the message a C extension turns one into), which
    is the only trace ``sqlite3`` leaves when the kernel refuses its ``open(2)``.
    The OS test is deliberately generous WITHIN that class — under a kernel wall
    an ambiguous ``PermissionError`` is attributed to the wall — because
    containment must never be able to fabricate a finding.

    It is not, however, generous ACROSS classes: ``os_denial`` requires the
    exception to be OS-level (or a DB driver's, the one family that discards the
    errno) before a message may corroborate it. The message-only rule it replaced
    contained an app's own authorization ``PermissionError`` and a ``ValueError``
    quoting the phrase, and — because only this branch is tier-gated — made the
    same row a defect on a host without an OS sandbox and contained on one with.
    """
    if (
        row.get("status") == "error"
        and row.get("error_type") == "SandboxBlocked"
        and row.get("error_module") == "sitecustomize"
    ):
        row["contained"] = True
        row["contained_by"] = "process-shim"
        return row
    # Third apparatus: the SERVICE SUBSTITUTE. A ``SubstitutionGap`` (or any
    # exception defined by the doubles module) is the stand-in saying "I cannot
    # honour this" — the harness's own fidelity limit, which the doubles module
    # promises is NEVER a defect in the repo. Judged by defining module and by
    # MRO, both facts about the class, so a repo exception that merely quotes
    # the message is still judged on its own.
    # ...but NOT the DB-API exception hierarchy. PEP 249 §8 REQUIRES a driver to
    # define its own `IntegrityError`/`OperationalError`/… in the driver module,
    # so the substitute's do live here — and `service_doubles` raises them
    # deliberately, as THE DATABASE ANSWERING. Keying containment on the
    # defining module therefore made "the substitute cannot honour this" and
    # "the repo violated a UNIQUE constraint" indistinguishable, and every
    # unique / NOT NULL / check-constraint violation — the canonical data-layer
    # bug class this oracle exists to surface — was silently suppressed.
    #
    # This is why round 2's check passed while the bug was live: on the
    # SQLAlchemy path the class is `sqlalchemy.exc.IntegrityError`, a different
    # module, so the one path where the bug is absent was the one verified.
    if (
        row.get("status") == "error"
        and row.get("error_type") not in _DBAPI_EXCEPTIONS
        and (
            row.get("error_module") in ("_vinv_service_doubles", "exerciser.service_doubles")
            or "SubstitutionGap" in (row.get("error_mro") or ())
        )
    ):
        row["contained"] = True
        row["contained_by"] = "service-substitute"
        effects = row.setdefault("effects", {})
        if isinstance(effects, dict):
            bucket = effects.setdefault("substitution-gap", [])
            detail = f"{row.get('error_type')}: {str(row.get('error'))[:160]}"
            if isinstance(bucket, list) and detail not in bucket:
                bucket.append(detail)
        return row
    if tier is ContainmentTier.OS_SANDBOX:
        denial = os_denial(row)
        if denial is not None:
            kind, detail = denial
            row["contained"] = True
            row["contained_by"] = "os-sandbox"
            row["os_denial"] = {"kind": kind, "detail": detail}
            effects = row.setdefault("effects", {})
            if isinstance(effects, dict):
                bucket = effects.setdefault("os-denied", [])
                if isinstance(bucket, list) and detail not in bucket:
                    bucket.append(detail)
    return row


def snapshot_tree(root: Path, *, skip: Iterable[Path] = ()) -> dict[str, tuple[int, int]]:
    """``relative path -> (size, mtime_ns)`` for every file under ``root``.

    The before/after pair is the GROUND TRUTH of what a worker left behind:
    unlike the patched builtins it cannot be bypassed by a C extension writing
    through a raw descriptor.
    """
    # Resolve the skip set ONCE and compare against already-normalised strings.
    # This used to call `path.resolve()` on EVERY entry — a realpath syscall per
    # file (an open+query+close on Windows), before the is_dir check so
    # directories paid it too, and the whole walk runs twice per module. On a
    # 20k-file repo across 40 modules that is 1.6M syscalls of pure overhead,
    # invisible in the report because its `ms` field only covers the copy.
    # Both the literal and the resolved spelling, so a symlinked root still
    # matches without paying realpath per entry.
    skips: set[str] = set()
    for p in skip:
        skips.add(os.path.normcase(os.path.abspath(p)))
        skips.add(os.path.normcase(os.path.realpath(p)))
    out: dict[str, tuple[int, int]] = {}
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            path = Path(entry.path)
            if skips and os.path.normcase(entry.path) in skips:
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(path)
                    continue
                stat = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            try:
                rel = str(path.relative_to(root))
            except ValueError:
                continue
            out[rel] = (stat.st_size, stat.st_mtime_ns)
    return out


def tree_delta(
    before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]]
) -> dict[str, list[str]]:
    """Files created / modified / removed between two snapshots."""
    created = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    modified = sorted(k for k in set(before) & set(after) if before[k] != after[k])
    return {
        "created": created[:MAX_TREE_ENTRIES],
        "modified": modified[:MAX_TREE_ENTRIES],
        "removed": removed[:MAX_TREE_ENTRIES],
    }


def _empty_report(policy: SandboxPolicy, candidates: int) -> dict[str, Any]:
    return {
        "enabled": True,
        "status": "ok",
        "reason": None,
        "policy": policy.to_json(),
        # The rung of the capability ladder this run actually achieved, and what
        # that rung guarantees. Stated on EVERY report, including the ones that
        # refused, so no reader ever has to infer the strength of the wall.
        "tier": ContainmentTier.NONE.value,
        "containment": None,
        "effects_complete": False,
        "candidates": candidates,
        "targets": 0,
        "modules": 0,
        "calls": 0,
        "verdicts": {},
        "copy": None,
        "root": None,
        "root_removed": False,
        "effects": [],
        "effect_totals": dict.fromkeys(EFFECT_KINDS, 0),
        # Targets whose effect ledger is INCOMPLETE, and the count of rows
        # affected per class. An empty `effects` map on one of these rows means
        # the shim could not see, not that the call did nothing.
        "unobservable": [],
        "unobservable_totals": {},
        "filesystem_delta": [],
        "module_timeouts": [],
        "refused": [],
    }


# =========================================================================
# Driver — the parent side
# =========================================================================


def run_sandboxed_targets(
    repo: Path,
    refusals: Sequence[Refusal],
    *,
    policy: SandboxPolicy,
    src_roots: Sequence[str],
    repo_packages: Sequence[str],
    module_timeout_s: float,
    python: str | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Drive impurity-refused targets inside containment.

    Returns ``{"status", "rows", "report"}``. ``status`` is ``"unavailable"``
    when isolation could not be established, in which case ``rows`` is empty and
    every candidate is listed in ``report["refused"]`` with the reason — the
    caller must keep them refused. There is no third outcome.
    """
    log = logger or logging.getLogger(__name__)
    report = _empty_report(policy, len(refusals))
    if not refusals:
        # The ladder is still reported: "nothing to contain" and "we could not
        # have contained it" are very different facts about a run.
        #
        # `require_tier` is deliberately NOT enforced here. It exists to stop a
        # refused target being DRIVEN behind an insufficient wall — with nothing
        # to drive there is nothing to protect, and refusing would report "we
        # could not contain it" about a run that had nothing to contain,
        # collapsing exactly the two facts this branch exists to keep apart.
        idle_policy = replace(policy, require_tier=None) if policy.require_tier else policy
        try:
            idle = resolve_mechanism(idle_policy, python=python, logger=log)
        except IsolationUnavailable as exc:
            report["reason"] = str(exc)
            return {"status": "ok", "rows": [], "report": report}
        report["tier"] = idle.tier.value
        report["containment"] = idle.to_json()
        report["effects_complete"] = idle.effects_complete
        report["reason"] = "no impurity-only refusals to drive"
        return {"status": "ok", "rows": [], "report": report}

    try:
        mechanism = resolve_mechanism(policy, python=python, logger=log)
        report["tier"] = mechanism.tier.value
        report["containment"] = mechanism.to_json()
        report["effects_complete"] = mechanism.effects_complete
        sandbox = prepare_sandbox(repo, policy, mechanism=mechanism)
    except IsolationUnavailable as exc:
        report["status"] = "unavailable"
        report["reason"] = str(exc)
        if policy.synthesize_services:
            # Legible even when nothing ran: "no services were synthesised
            # because the sandbox never came up" is a different fact from
            # "this repo needs none".
            report["services"] = {"enabled": True, "status": "sandbox-unavailable"}
        report["refused"] = [
            {"id": r.target.id, "reason": f"sandbox-unavailable: {exc}"} for r in refusals
        ]
        log.warning("sandbox unavailable — %d targets stay refused: %s", len(refusals), exc)
        return {"status": "unavailable", "rows": [], "report": report}

    report["copy"] = sandbox.copy.to_json()
    report["root"] = str(sandbox.root)
    log.info(
        "sandbox: tier=%s (%s), copied %d files (%.1f MB) in %.0f ms into %s",
        sandbox.mechanism.tier.value,
        sandbox.mechanism.name,
        sandbox.copy.files,
        sandbox.copy.bytes / (1024 * 1024),
        sandbox.copy.ms,
        sandbox.root,
    )
    if sandbox.copy.gitignore_pruned_total:
        # Loud, because this is the one exclusion rule that can remove a file the
        # repo needs at RUNTIME (generated `_version.py`, `*_pb2.py`, a checked-out
        # `config.py`). The resulting import failure is exempted downstream and
        # reads exactly like a missing dependency, so without this line a whole
        # module's targets vanish with nothing pointing at the cause.
        log.warning(
            "sandbox: .gitignore rules pruned %d entr%s from the copy (%s) — a "
            "module that fails to import inside the sandbox may have lost a file "
            "it needs at runtime; set honour_gitignore=False to copy everything",
            sandbox.copy.gitignore_pruned_total,
            "y" if sandbox.copy.gitignore_pruned_total == 1 else "ies",
            ", ".join(sandbox.copy.gitignore_pruned[:10]),
        )

    by_module: dict[str, list[Refusal]] = {}
    for refusal in refusals:
        by_module.setdefault(refusal.target.module, []).append(refusal)
    report["targets"] = len(refusals)
    report["modules"] = len(by_module)
    service_summary: dict[str, Any] | None = None

    rows: list[dict[str, Any]] = []
    timeouts: list[str] = []
    effects: list[dict[str, Any]] = []
    deltas: list[dict[str, Any]] = []
    totals = dict.fromkeys(EFFECT_KINDS, 0)
    unobservable_totals: dict[str, int] = {}
    unobservable_targets: dict[str, list[str]] = {}

    env = sandbox_env(sandbox, extra_pythonpath=[str(Path(__file__).resolve().parents[1])])
    preexec = rlimit_preexec(policy)
    ignore = (sandbox.plans, sandbox.shim, sandbox.ledger)

    try:
        for module, module_refusals in sorted(by_module.items()):
            plan_file = sandbox.plans / f"{module.replace('.', '_')}.plan.json"
            plan_file.write_text(
                json.dumps(
                    {
                        "module": module,
                        "src_roots": list(src_roots),
                        "repo_packages": list(repo_packages),
                        "targets": [r.target.to_json() for r in module_refusals],
                        "impurities": {r.target.id: list(r.reasons) for r in module_refusals},
                    },
                    default=str,
                ),
                encoding="utf-8",
            )
            cmd = sandbox.mechanism.wrap(
                [
                    python or sys.executable,
                    "-m",
                    "exerciser.sandbox",
                    "--worker",
                    "--plan",
                    str(plan_file),
                    "--repo",
                    str(sandbox.repo_copy),
                ],
                root=sandbox.root,
                block_network=policy.block_network,
            )
            before = snapshot_tree(sandbox.root, skip=ignore)
            try:
                proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
                    cmd,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=module_timeout_s,
                    cwd=str(sandbox.repo_copy),
                    env=env,
                    preexec_fn=preexec,  # noqa: PLW1509 (POSIX rlimits, guarded)
                )
                stdout = proc.stdout or ""
            except subprocess.TimeoutExpired as exc:
                timeouts.append(module)
                stdout = exc.stdout if isinstance(exc.stdout, str) else ""
                rows.append(
                    {
                        "module": module,
                        "target_id": module,
                        "phase": "module",
                        "status": "error",
                        "sandboxed": True,
                        "error_type": "ModuleTimeout",
                        "error": (
                            f"sandboxed module exceeded {module_timeout_s}s — a call hung "
                            "(candidate deadlock/infinite loop)"
                        ),
                    }
                )
            except OSError as exc:
                # A spawn that never happened is an isolation failure for this
                # module: report it, never retry without containment.
                rows.append(
                    {
                        "module": module,
                        "target_id": module,
                        "phase": "sandbox",
                        "status": "skipped",
                        "sandboxed": True,
                        "error": f"sandbox worker could not be spawned: {exc}",
                    }
                )
                stdout = ""
            after = snapshot_tree(sandbox.root, skip=ignore)
            delta = tree_delta(before, after)
            if any(delta.values()):
                deltas.append({"module": module, **delta})

            module_rows: list[dict[str, Any]] = []
            for line in stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except ValueError:
                    continue
                if isinstance(parsed, dict):
                    module_rows.append(parsed)
            if not module_rows and module in timeouts:
                # The worker died before emitting; the shim's atexit flush is
                # the only surviving evidence of what it attempted.
                for kind, details in group_attempts(_read_ledger(sandbox.ledger)).items():
                    if details:
                        effects.append(
                            {
                                "target_id": module,
                                "input_class": None,
                                "phase": "module",
                                "kind": kind,
                                "attempts": details,
                            }
                        )
                        totals[kind] = totals.get(kind, 0) + len(details)
            for row in module_rows:
                row["sandboxed"] = True
                row.setdefault("repo_packages", list(repo_packages))
                classes = [str(c) for c in (row.get("unobservable") or [])]
                if classes:
                    unobservable_targets[str(row.get("target_id"))] = classes
                    for klass in classes:
                        unobservable_totals[klass] = unobservable_totals.get(klass, 0) + 1
                for kind, details in (row.get("effects") or {}).items():
                    totals[kind] = totals.get(kind, 0) + len(details)
                    if len(effects) < MAX_EFFECT_ROWS:
                        effects.append(
                            {
                                "target_id": row.get("target_id"),
                                "input_class": row.get("input_class"),
                                "phase": row.get("phase"),
                                "kind": kind,
                                "attempts": details,
                            }
                        )
                rows.append(row)
        service_summary = _read_service_ledger(sandbox.service_ledger)
        service_plan_doc = None
        if sandbox.service_plan is not None and sandbox.service_plan.exists():
            try:
                service_plan_doc = json.loads(sandbox.service_plan.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                service_plan_doc = None
    finally:
        # Derived from the FILESYSTEM, not from policy intent. Asserting
        # `not policy.keep_root` made the report claim a cleanup that had
        # silently failed — the one field a user would check to find the leak.
        report["root_removed"] = sandbox.dispose()
        if not report["root_removed"] and not policy.keep_root:
            report.setdefault("diagnostics", []).append(
                f"sandbox root could not be removed and is still on disk: {sandbox.root}"
            )

    if policy.synthesize_services:
        from .services import fixture_questions, summarise

        # The plan the worker actually saw — read back rather than re-derived,
        # so the report describes THIS run and the repo is not scanned twice.
        report["services"] = summarise(service_plan_doc or {}, service_summary)
        induced = [
            e
            for e in (service_summary or {}).get("events", [])
            if isinstance(e, dict) and e.get("kind") == "induced-schema"
        ]
        if induced:
            # Induction got the code running; representative DATA is a question
            # about intent, so each induced table becomes one cached question on
            # the agent channel. Answers land as fixtures on the next run.
            channel, _answered = fixture_questions(repo, induced)
            report["services"]["fixture_channel"] = channel.save(log)

    report["calls"] = sum(1 for r in rows if r.get("phase") == "call")
    report["effects"] = effects
    report["effect_totals"] = totals
    report["unobservable"] = [
        {"target_id": tid, "classes": classes}
        for tid, classes in sorted(unobservable_targets.items())
    ]
    report["unobservable_totals"] = dict(sorted(unobservable_totals.items()))
    report["filesystem_delta"] = deltas
    report["module_timeouts"] = timeouts
    log.info(
        "sandbox: %d targets in %d modules, %d calls, effects=%s",
        len(refusals),
        len(by_module),
        report["calls"],
        totals,
    )
    return {"status": "ok", "rows": rows, "report": report}


def _read_service_ledger(path: Path | None) -> dict[str, Any] | None:
    """Fold the in-jail doubles' ledger into the shape the report wants.

    Read INSIDE the ``try`` that disposes the tree, because the ledger lives in
    the tree — a summary computed after disposal would silently be empty, which
    would read as "the doubles did nothing" rather than "nobody looked".

    The ledger is JSONL, appended by every module worker in the run: a
    whole-document format was reproduced letting the last worker erase every
    earlier worker's recorded gaps.
    """
    if path is None or not path.exists():
        return None
    events: list[dict[str, Any]] = []
    error = ""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("kind") == "install-error":
                error = str(event.get("detail") or "install failed")
                continue
            events.append(event)
    except OSError:
        return None
    by_kind: dict[str, int] = {}
    for event in events:
        by_kind[str(event.get("kind"))] = by_kind.get(str(event.get("kind")), 0) + 1
    out = {
        "substituted": by_kind.get("substituted", 0),
        "induced_schema": by_kind.get("induced-schema", 0),
        "seeded_rows": by_kind.get("seeded-row", 0),
        "fixture_rows": by_kind.get("fixture-row", 0),
        "declared_schema": by_kind.get("declared-schema", 0),
        "substitution_gaps": by_kind.get("substitution-gap", 0),
        "events": events[:200],
    }
    if error:
        out["error"] = error
    return out


def _read_ledger(path: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


# =========================================================================
# Worker — runs INSIDE the contained subprocess, importing target code
# =========================================================================


def _service_event_count() -> int:
    doubles = getattr(sys, "__vinv_service_doubles__", None)
    try:
        return len(doubles.events()) if doubles is not None else 0
    except Exception:  # pragma: no cover
        return 0


def _service_events_since(mark: int) -> list[dict[str, Any]]:
    doubles = getattr(sys, "__vinv_service_doubles__", None)
    if doubles is None:
        return []
    try:
        return [
            {k: e[k] for k in ("kind", "service", "detail", "table") if k in e}
            for e in doubles.events()[mark:]
        ]
    except Exception:  # pragma: no cover
        return []


def _worker_main(argv: list[str]) -> int:
    """Drive one module's refused targets under containment. Emits JSONL rows.

    The FIRST thing it does is verify the shim loaded. If it did not, the
    process has no containment and the worker refuses to import a single
    target — the fail-closed rule, enforced on the inside as well as the out.
    """
    ap = argparse.ArgumentParser(prog="exerciser-sandbox-worker")
    ap.add_argument("--plan", required=True, help="path to the per-module plan JSON")
    ap.add_argument("--repo", required=True, help="path to the COPIED repo inside the sandbox")
    args = ap.parse_args(argv)

    from . import functions as fn

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    module_name = str(plan["module"])
    repo_packages = plan.get("repo_packages") or []
    # An unset or unrecognised value reads as the WEAKEST rung: a worker that
    # cannot tell what wall it is behind must not claim the strong one.
    try:
        tier = parse_tier(os.environ.get("VINV_CONTAINMENT_TIER")) or ContainmentTier.PROCESS_SHIM
    except ValueError:
        tier = ContainmentTier.PROCESS_SHIM

    ledger = getattr(sys, "__vinv_sandbox_ledger__", None)
    if ledger is None or not hasattr(ledger, "attempts"):
        fn._emit(
            [
                {
                    "module": module_name,
                    "target_id": module_name,
                    "phase": "sandbox",
                    "status": "skipped",
                    "sandboxed": True,
                    "repo_packages": repo_packages,
                    "error": (
                        "containment shim did not load — refusing to import or call "
                        "anything (fail closed)"
                    ),
                }
            ]
        )
        return 0

    repo = Path(args.repo)
    for root in plan.get("src_roots", ["."]):
        candidate = str((repo / root).resolve())
        if candidate not in sys.path:
            sys.path.insert(0, candidate)

    def drain(mark: int) -> dict[str, list[str]]:
        return group_attempts(ledger.attempts[mark:])

    rows: list[dict[str, Any]] = []
    impurities = plan.get("impurities") or {}
    mark = len(ledger.attempts)
    try:
        mod = importlib.import_module(module_name)
    except BaseException as exc:  # target import can raise anything, incl. SystemExit
        fn._emit(
            [
                mark_contained(
                    {
                        "module": module_name,
                        "target_id": module_name,
                        "phase": "import",
                        "status": "error",
                        "sandboxed": True,
                        "error_type": type(exc).__name__,
                        "error_module": getattr(type(exc), "__module__", "") or "",
                        "error_mro": [c.__name__ for c in type(exc).__mro__],
                        "error_errno": getattr(exc, "errno", None),
                        "containment_tier": tier.value,
                        "repo_packages": repo_packages,
                        "effects": drain(mark),
                        "error": str(exc)[:400],
                    },
                    tier,
                )
            ]
        )
        return 0
    import_effects = drain(mark)
    if import_effects:
        rows.append(
            {
                "module": module_name,
                "target_id": module_name,
                "phase": "import",
                "status": "ok",
                "sandboxed": True,
                "repo_packages": repo_packages,
                "effects": import_effects,
            }
        )

    for target in plan["targets"]:
        qual = str(target["qualname"])
        target_id = f"{module_name}:{qual}"
        reasons = list(impurities.get(target_id) or [])
        base: dict[str, Any] = {
            "module": module_name,
            "target_id": target_id,
            "sandboxed": True,
            "containment_tier": tier.value,
            "repo_packages": repo_packages,
            "refused_for": reasons[:4],
        }
        # Completeness FOLLOWS THE TIER. Under an OS sandbox a write outside the
        # root is impossible and one inside it is caught by the before/after walk
        # of the tree, so there is no third place for an effect to hide and the
        # ledger may claim completeness. Under the shim it may not: the static
        # guard flagged an impurity class this process cannot observe (C-extension
        # I/O), and an empty `effects` map there means "blind here", not "no
        # effect".
        unobservable = unobservable_effect_classes(reasons)
        if tier is ContainmentTier.OS_SANDBOX:
            base["unobservable"] = []
            base["effects_complete"] = True
        elif unobservable:
            base["unobservable"] = unobservable
            base["effects_complete"] = False
        try:
            candidate = getattr(mod, qual, None)
        except Exception:
            candidate = None
        if candidate is None or not callable(candidate):
            rows.append(
                {**base, "phase": "resolve", "status": "skipped", "error": "not a callable"}
            )
            continue
        params = fn._param_records(candidate)
        if params is None:
            rows.append(
                {
                    **base,
                    "phase": "signature",
                    "status": "skipped",
                    "error": "unannotated required parameter — refusing to guess",
                }
            )
            continue
        unresolvable = fn.unresolvable_required(params)
        if unresolvable:
            rows.append(
                {
                    **base,
                    "phase": "signature",
                    "status": "skipped",
                    "error": (
                        f"unresolvable annotation on required parameter(s) "
                        f"{', '.join(unresolvable)} — refusing to guess"
                    ),
                }
            )
            continue
        for arg_set in fn.arg_sets_for(params):
            mark = len(ledger.attempts)
            service_mark = _service_event_count()
            row = fn._call_once(module_name, qual, candidate, arg_set)
            row.update(base)
            row["effects"] = drain(mark)
            service_events = _service_events_since(service_mark)
            if service_events:
                # The substitutions, inductions and seedings THIS call caused —
                # drained per call exactly like the effect ledger. A verdict
                # that stood on invented rows carries the evidence it stood on,
                # so downstream consumers can down-weight it.
                row["service_events"] = service_events[:12]
                if any(
                    e.get("kind") in ("seeded-row", "induced-schema", "fixture-row")
                    for e in service_events
                ):
                    row["seed_dependent"] = True
            rows.append(mark_contained(row, tier))
    fn._emit(rows)
    return 0


def main(argv: list[str] | None = None) -> int:
    """``python -m exerciser.sandbox --worker …`` dispatch (worker only)."""
    return worker_entrypoint(
        argv, _worker_main, "exerciser.sandbox: use `exerciser functions <repo> --sandbox`"
    )


if __name__ == "__main__":
    raise SystemExit(main())
