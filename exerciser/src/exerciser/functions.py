"""The FUNCTION-level input channel — calling code, not just requesting routes.

Until now every input Vinv could generate travelled as an HTTP request to a
discovered route. That caps what it can find to what a route reaches: a library
(no routes at all) was unexercisable, and even in a service the bugs living in
pure helpers — boundary/falsy handling, parser semantics, schema introspection,
interpreter-flag behaviour — sit behind a corridor no request opens.

This module drives catalogued entry points and exported functions IN PROCESS:
import the module, call the function, record args/returns/exceptions. It turns
the ``entrypoints`` inventory (which identification has always produced and
nothing ever consumed) into a target set.

Three deliberate design points:

* **Isolation by subprocess.** Target code is arbitrary: it can ``sys.exit``,
  spin forever, install signal handlers, or corrupt the interpreter. Each module
  is driven in a worker process (``python -m exerciser.functions --worker``)
  under a wall-clock deadline, so a hang or a hard exit costs one module's
  results, never the run. The worker is also the natural place for tracelens to
  attach, so function-level calls produce spans like any other traffic.
* **Deterministic arguments, with Hypothesis as an optional widener.** Values
  come from type hints via the same seeded generator the HTTP path uses; when
  ``hypothesis`` is installed, a property-based arm draws additional instances.
* **Destructive targets are never called.** A harness that calls ``delete_all``
  or ``drop_database`` because it was exported is not a testing tool. Because
  this harness IMPORTS target modules and CALLS their exported functions in
  process, the guard is a SAFETY control, not a scoring detail, so it is layered
  (see "Refusing to call" below): an AST purity pre-check on the function's own
  source is the primary gate, a segment-matched destructive-verb vocabulary is
  the backstop, and module/name scaffolding rules exclude what should never be
  imported at all. Every refusal is recorded in ``skipped`` with its reason.

Artifacts land beside the HTTP ones: ``.vinv/exercise/functions.json`` (the
plan + summary) and ``function_results.jsonl`` (one row per call).

Refusing to call
----------------

1. **AST purity pre-check (primary).** Before a target is ever imported or
   called, its body is parsed out of the source and inspected for calls that
   mutate the world outside the process: filesystem writes/removals, process
   spawning, network clients, database ``execute``/``commit``/``drop``, and
   interpreter exit. Import ALIASES are resolved first (``import os as _os``
   binds ``_os`` to ``os``), same-module helpers it calls are inspected too
   (transitively, to ``DEFAULT_TRANSITIVE_DEPTH``), and anything the walk cannot
   RESOLVE — an indirect call target, an unknown bare name, a chain deeper than
   the depth limit — counts as impure rather than being skipped. This scales to
   a repo nobody has read, because it judges what the code DOES rather than what
   it is called.
2. **Destructive-verb vocabulary (backstop).** For the cases source cannot be
   read, or where the damage happens through a library the pre-check does not
   know, the identifier is split into word segments (on ``_``/``.`` and
   camelCase) and matched against a general vocabulary of destructive verbs —
   never a raw substring, so ``remove_prefix`` is judged on ``remove`` rather
   than on the accident of containing ``remove`` inside a longer word.
3. **Scaffolding rules.** Test modules, ``conftest``, ``setup``, migrations and
   ``__main__`` are never importable targets: importing them runs fixtures and
   migrations against real state.

A refusal is not a dead end — containment is where it goes
----------------------------------------------------------

The purity guard is right to refuse, but if refusal were the END of it the
harness's coverage ceiling would be "whatever happens to be pure" — and the
functions that touch the filesystem, the network or a subprocess are usually the
ones worth exercising. So ``run_functions`` routes on what the guard could
prove, not on a flag:

* verified pure → in process, the fast path;
* unverifiable or impure (decorated, receiver-tainted, an unresolved chain) →
  automatically through ``sandbox``'s containment, no flag required;
* destructive NAME or test scaffolding → refused outright, never promoted.

That last one is not squeamishness: containment changes what a call costs, not
whether calling ``drop_database`` was ever sensible.

Containment means a disposable copy of the repo, ``cwd``/``HOME``/``TMPDIR``/
``XDG_*`` redirected into a temp tree, POSIX ``setrlimit`` caps, the existing
wall-clock deadline — and the strongest WALL the host can actually demonstrate
(``containment.detect_containment``: an OS sandbox where one probes clean,
otherwise the generated ``sitecustomize`` shim). What each target ATTEMPTED is
recorded as an effect ledger, which is useful output in its own right: "this
function writes 3 files and opens a socket" is a behavioural fact even when the
call returns cleanly.

Making the sandbox opt-IN had this backwards. It made SAFETY the thing you had
to remember to ask for, and on one real repository the default run drove 46
targets where containment drives 147. ``sandbox=False`` still exists, as an
opt-OUT: the unverified set then stays refused, loudly, and nothing runs loose.
Isolation fails CLOSED throughout — if the tree cannot be made, the repo is too
big to copy, or the policy demanded a tier this host cannot provide, the targets
stay refused with the reason recorded.
"""

from __future__ import annotations

import argparse
import ast
import builtins
import importlib
import inspect
import json
import logging
import os
import random
import re
import subprocess
import sys
import time
import traceback
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import envconfig, store
from ._worker import worker_entrypoint
from .exception_policy import DECAY, ExceptionPolicy, family_of, provenance_of, signature
from .interpreter import resolve_cached
from .issues import FailureCluster, build_clusters
from .redact import redact_text
from .sandbox import SandboxPolicy, run_sandboxed_targets

# =========================================================================
# The destructive-name vocabulary (backstop; the AST purity check is primary)
# =========================================================================
#
# Matched against WORD SEGMENTS of the identifier, never as raw substrings: a
# substring denylist both over- and under-blocks (it blocked `remove_prefix`
# and `charge_density` while letting `nuke_everything` through).
#
# The vocabulary is a general one — the English/CS verbs for "destroy or
# discard durable state" and "change the world outside this process" — not a
# list harvested from any one codebase.

# Tier A: verbs whose only reading is "destroy / discard existing state". A
# single one of these anywhere in the identifier denies it, whatever it is
# paired with. This is why `remove_prefix` stays denied: the cost of losing a
# pure string helper is one target, and the cost of guessing wrong is a repo.
_DESTRUCTIVE_VERBS = frozenset(
    {
        "abort",
        "annihilate",
        "clobber",
        "decommission",
        "delete",
        "deprovision",
        "deregister",
        "destroy",
        "discard",
        "drop",
        "erase",
        "evict",
        "expunge",
        "halt",
        "kill",
        "nuke",
        "obliterate",
        "poweroff",
        "prune",
        "purge",
        "quit",
        "reboot",
        "remove",
        "restart",
        "revert",
        "revoke",
        "rm",
        "rmdir",
        "rmtree",
        "rollback",
        "scrub",
        "shutdown",
        "teardown",
        "terminate",
        "trash",
        "truncate",
        "undo",
        "uninstall",
        "unlink",
        "unpublish",
        "unregister",
        "wipe",
        "zap",
    }
)

# Tier B: verbs that are destructive IN CONTEXT but are also ordinary domain
# nouns/verbs in scientific and mathematical code. Denied only when the
# identifier also names something stateful (below), or when the verb IS the
# whole identifier. This is the judgement call the substring list got wrong:
# `transfer_matrix` and `charge_density` are now drivable again (coverage
# regained), while `transfer_funds`, `charge_card` and `reset_database` stay
# denied. The residual risk — a Tier-B verb over an object vocabulary does not
# know — is what the AST purity pre-check is there to absorb.
_STATEFUL_VERBS = frozenset(
    {
        "apply",
        "archive",
        "bill",
        "charge",
        "clear",
        "close",
        "commit",
        "deactivate",
        "deploy",
        "disable",
        "downgrade",
        "expire",
        "flush",
        "format",
        "install",
        "invalidate",
        "migrate",
        "notify",
        "overwrite",
        "pay",
        "provision",
        "publish",
        "push",
        "refund",
        "release",
        "reset",
        "seed",
        "send",
        "sync",
        "transfer",
        "upgrade",
        "void",
        "withdraw",
    }
)

# Nouns that denote durable state or a blast radius. A Tier-B verb next to one
# of these is a state-changing call, not a formula.
_STATEFUL_OBJECTS = frozenset(
    {
        "account",
        "accounts",
        "all",
        "backup",
        "balance",
        "branch",
        "bucket",
        "cache",
        "card",
        "cluster",
        "collection",
        "config",
        "container",
        "credential",
        "credentials",
        "customer",
        "data",
        "database",
        "databases",
        "db",
        "deployment",
        "dir",
        "directory",
        "disk",
        "email",
        "env",
        "environment",
        "everything",
        "file",
        "files",
        "filesystem",
        "fs",
        "funds",
        "git",
        "host",
        "image",
        "instance",
        "invoice",
        "key",
        "keys",
        "log",
        "logs",
        "mail",
        "machine",
        "member",
        "message",
        "migration",
        "money",
        "namespace",
        "node",
        "notification",
        "order",
        "password",
        "path",
        "pod",
        "prod",
        "production",
        "project",
        "queue",
        "record",
        "records",
        "release",
        "repo",
        "repository",
        "row",
        "rows",
        "schema",
        "secret",
        "secrets",
        "server",
        "service",
        "session",
        "sessions",
        "settings",
        "sms",
        "snapshot",
        "state",
        "storage",
        "store",
        "stream",
        "subscription",
        "table",
        "tables",
        "token",
        "tokens",
        "topic",
        "transaction",
        "tree",
        "user",
        "users",
        "volume",
        "wallet",
        "workspace",
    }
)

# Modules never worth importing (side effects at import, or not target code).
# `test`/`tests`/`testing` are here because importing a test module runs its
# collection-time fixtures, and its `test_*` functions are then called with
# junk against whatever real database/tmpdir the fixtures wired up.
_DENY_MODULE_PARTS = frozenset(
    {
        "setup",
        "conftest",
        "__main__",
        "migrations",
        "alembic",
        "test",
        "tests",
        "testing",
    }
)

# How long a module's IMPORT may take. Import cost is a property of the target's
# dependency graph, not of the code under test, and on real repos it dominates:
# `import smolagents.local_python_executor` takes ~27s cold.
DEFAULT_MODULE_TIMEOUT_S = 30.0

# How long the CALLS for one module may take, measured from the moment its import
# returned — enforced inside the worker, which is the only place that knows when
# that was.
#
# These were one number. A single deadline over import-plus-calls means a heavy
# dependency graph consumes the entire budget before the first call is made: the
# worker is killed mid-import, the parent records `ModuleTimeout` and blames "a
# call hung", and the harness reports zero calls for a module whose code was
# never reached. That is the whole crash oracle silently contributing nothing on
# exactly the codebases most worth exercising (torch, pandas, transformers — any
# repo whose import graph is seconds deep), and it is indistinguishable in the
# output from a module with no defects.
DEFAULT_CALL_BUDGET_S = 30.0


# =========================================================================
# Candidate discovery
# =========================================================================


@dataclass
class FunctionTarget:
    """One callable the harness will drive, with its import coordinates."""

    module: str
    qualname: str
    file: str
    #: "entrypoint" (a decorated handler) | "exported" (a public module-level
    #: function) | "internal" (one whose name leads with a single underscore).
    #: Reported, never filtered on: the underscore states API stability, and
    #: what may be CALLED is decided by the purity guard and the destructive-name
    #: vocabulary. It does order discovery, so the published surface claims the
    #: target budget first — see `discover_with_refusals`.
    kind: str
    is_async: bool = False
    params: list[dict[str, Any]] = field(default_factory=list)

    @property
    def id(self) -> str:
        return f"{self.module}:{self.qualname}"

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "module": self.module,
            "qualname": self.qualname,
            "file": self.file,
            "kind": self.kind,
            "is_async": self.is_async,
            "params": self.params,
        }


_SEGMENT_RE = re.compile(r"[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+")


def name_segments(name: str) -> list[str]:
    """Lowercased word segments of an identifier.

    Splits on non-alphanumerics AND on camelCase humps, so ``dropAllTables``,
    ``drop_all_tables`` and ``db.drop_all`` all yield ``drop`` as a segment
    while ``remove_prefix`` yields ``remove`` and ``prefix`` separately.
    """
    out: list[str] = []
    for chunk in re.split(r"[^A-Za-z0-9]+", name or ""):
        out.extend(m.group(0).lower() for m in _SEGMENT_RE.finditer(chunk))
    return out


def denial_reason(name: str) -> str | None:
    """Why this qualified name must never be called, or None when it may be.

    Word-boundary matching on identifier segments — see the vocabulary comments
    above for the two tiers and the tradeoff each one makes.
    """
    segments = name_segments(name)
    if not segments:
        return None
    seen = set(segments)
    hit = sorted(seen & _DESTRUCTIVE_VERBS)
    if hit:
        return f"destructive verb {hit[0]!r} in the name"
    stateful = sorted(seen & _STATEFUL_VERBS)
    if stateful:
        objects = sorted(seen & _STATEFUL_OBJECTS)
        if objects:
            return f"state-changing verb {stateful[0]!r} over {objects[0]!r}"
        if len(segments) == 1:
            return f"state-changing verb {stateful[0]!r} names the whole target"
    return None


def is_denied(name: str) -> bool:
    """Whether a qualified name must never be called by the harness."""
    return denial_reason(name) is not None


# The xunit-style fixture hooks pytest/unittest call around tests. They carry no
# ``test_`` in the name, so the prefix/suffix rule below never saw them — and a
# ``setup_module`` is exactly the function that creates the database the tests
# then use. Lower-cased spellings, so ``setUp``/``tearDownClass`` match too.
_XUNIT_HOOK_NAMES = frozenset(
    {
        "setup",
        "setup_class",
        "setup_function",
        "setup_method",
        "setup_module",
        "setupclass",
        "teardown",
        "teardown_class",
        "teardown_function",
        "teardown_method",
        "teardown_module",
        "teardownclass",
    }
)


def is_test_scaffolding(qualname: str) -> bool:
    """Whether a callable is pytest/unittest scaffolding rather than target code.

    A ``test_*`` function is collected and run by a test runner with fixtures;
    calling it out of band with guessed arguments exercises the fixtures'
    real side effects (databases, tmpdirs, network doubles), not the library.
    The xunit hooks are the same thing one level up: ``setup_module`` IS the
    fixture, and calling it out of band runs the side effects without the
    teardown that was supposed to follow.
    """
    low = (qualname or "").rpartition(".")[2].lower()
    if low in _XUNIT_HOOK_NAMES:
        return True
    return low.startswith("test_") or low.endswith("_test") or low == "test"


def _is_denied_module_part(part: str) -> bool:
    """Whether one dotted module component makes the module unimportable here."""
    low = part.lower()
    return low in _DENY_MODULE_PARTS or low.startswith("test_") or low.endswith("_test")


def module_name_for(rel_file: str, src_roots: list[str]) -> str | None:
    """Import name for a repo-relative ``.py`` path, or None when it is not one.

    ``src_roots`` are repo-relative directories that sit on ``sys.path`` at
    runtime (``src``, ``.``); the longest matching root wins so
    ``src/pkg/mod.py`` becomes ``pkg.mod`` rather than ``src.pkg.mod``.
    """
    norm = rel_file.replace("\\", "/")
    if not norm.endswith(".py"):
        return None
    stem = norm[:-3]
    best: str | None = None
    for root in sorted(src_roots, key=len, reverse=True):
        r = root.strip("/")
        if not r or r == ".":
            cand = stem
        elif stem == r or stem.startswith(r + "/"):
            cand = stem[len(r) :].strip("/")
        else:
            continue
        if best is None:
            best = cand
    if best is None:
        return None
    parts = [p for p in best.split("/") if p]
    if not parts:
        return None
    if parts[-1] == "__init__":
        parts = parts[:-1]
    if not parts or any(_is_denied_module_part(p) for p in parts):
        return None
    if not all(p.isidentifier() for p in parts):
        return None
    return ".".join(parts)


#: How deep to look for nested distributions. A monorepo nests its packages a
#: level or two down (``libs/core``, ``packages/api``, ``libs/partners/openai``);
#: past that a match is far more likely to be a fixture or a vendored copy.
_MAX_DIST_DEPTH = 4

#: Files that mark a directory as a distribution root — the thing that ends up
#: on ``sys.path`` once installed.
_DIST_MARKERS = ("pyproject.toml", "setup.py", "setup.cfg")


def detect_src_roots(repo: Path) -> list[str]:
    """Repo-relative directories that behave as import roots.

    A repo with ONE distribution has one root (``src/`` under the src-layout
    convention, else the repo itself). A monorepo has one per distribution, and
    treating it as a single root is not a smaller answer but a wrong one: with
    only ``.``, ``libs/core/langchain_core/utils.py`` resolves to the module
    ``libs.core.langchain_core.utils``, which imports a SECOND copy of the
    package alongside the installed one (implicit namespace packages make it
    succeed rather than fail). Two copies means ``isinstance`` across them is
    false and every cross-package import gets the other copy — so the harness
    reports phantom errors it caused itself.

    The extra roots come from the distributions declared in the tree, because
    that is what packaging already records; nothing is inferred from directory
    names. They are ADDITIVE — the src-layout convention still holds for a tree
    that carries no packaging metadata at all.
    """
    roots: list[str] = []
    for marker_dir in _distribution_dirs(repo):
        src = marker_dir / "src"
        root = src if src.is_dir() else marker_dir
        rel = root.relative_to(repo).as_posix()
        if rel and rel not in roots:
            roots.append(rel)
    if (repo / "src").is_dir() and "src" not in roots:
        roots.append("src")
    # The repo root stays last: `module_name_for` prefers the longest matching
    # root, so it only applies to files no distribution claims.
    roots.append(".")
    return roots


def _rel_dir(repo: Path, rel: str) -> Path | None:
    """A repo-relative directory as an absolute path, or None when it is gone."""
    try:
        resolved = (repo / rel).resolve()
    except OSError:  # pragma: no cover - a hostile path
        return None
    return resolved if resolved.is_dir() else None


def distribution_cwd(repo: Path, rel_file: str) -> Path:
    """The directory a module's own distribution is run from.

    Every worker was spawned with ``cwd=repo``, and that is not a neutral
    choice: a repo's relative paths resolve against the process working
    directory, so choosing it wrong silently changes what the code under test
    reads.

    Found on demo-fastapi, a repo that was correctly configured the whole time.
    Its settings declare ``env_file="../.env"`` — relative, because the app is
    meant to run from ``backend/`` and the file sits at the repo root. Started
    from the repo root instead, ``../.env`` resolves OUTSIDE the repo, every
    required setting was missing, and 14 of 15 modules failed to import. Run
    from ``backend/``, the same code loads a 37-line ``.env`` and imports
    cleanly. The engine reported that as fifteen defects in someone's clean
    repo, and the cause was its own choice of directory.

    This returns the FIRST candidate to try. It is not the answer — the answer
    is decided by whether the import actually succeeds, in
    ``candidate_workdirs``/the retry loop, because no amount of reading a repo's
    automation proves the code runs from where it says.
    """
    ordered = candidate_workdirs(repo, rel_file)
    return ordered[0] if ordered else repo


def candidate_workdirs(repo: Path, rel_file: str) -> list[Path]:
    """Working directories worth TRYING for ``rel_file``, most likely first.

    A list of places to read declarations from — CI files, Dockerfiles,
    Procfiles, pytest config — is a list, and a list only ever covers the build
    systems someone thought of. Bazel, Nix, Earthly, a shell script or a line in
    a README are all equally valid ways for a project to say where it runs, and
    enumerating them does not converge.

    So declarations do not DECIDE here; they only ORDER. What decides is whether
    the module imports, which the harness finds out by running it — the same
    discipline ``containment`` uses for its mechanisms ("the answer comes from a
    PROBE, never from the presence of a binary on PATH"), ``interpreter`` uses
    for candidate interpreters, and ``service_doubles.induce`` uses for schema:
    act, read the failure, try the next thing, converge.

    The list is short and always ends at the repo root, so the retry is bounded
    and its last element is the historical behaviour.
    """
    ordered: list[Path] = []

    def _push(path: Path | None) -> None:
        if path is None:
            return
        resolved = path.resolve()
        if resolved not in ordered:
            ordered.append(resolved)

    # 1. Anything the repo's own automation states, best source first. A hint,
    #    and hints are allowed to be incomplete because they are not the ruling.
    for claim in envconfig.workdir_claims_for(repo, rel_file):
        _push(_rel_dir(repo, claim.path))
    # 2. The distribution that owns the file — the unit `detect_src_roots`
    #    already uses for imports, and the right guess for a repo that automates
    #    nothing.
    _push(_owning_distribution(repo, rel_file))
    # 3. Every directory BETWEEN the repo and the module, shallowest first.
    #
    #    Without this the search space is only "somewhere that declared itself",
    #    so a package living in a plain subdirectory that nothing declares and no
    #    manifest claims has no reachable answer at all — the retry runs out of
    #    candidates while the directory that works was never a candidate. These
    #    are the directories a relative path could resolve from and still land
    #    inside the repo, which is the whole space worth searching, and it is
    #    bounded by the file's own depth.
    for ancestor in _ancestors_within(repo, rel_file):
        _push(ancestor)
    # 4. The repo root: previously the only choice, now the last resort.
    _push(repo)
    return ordered


#: Cap on the between-repo-and-module walk. Deeply nested packages exist; paying
#: a worker per level for one is not worth it, and the answer is nearly always
#: within a level or two of the distribution.
_MAX_ANCESTOR_CANDIDATES = 4


def _ancestors_within(repo: Path, rel_file: str) -> list[Path]:
    """Directories from just below the repo down to the module's own, shallowest first.

    Shallowest first because run directories are shallow in practice — a repo
    runs from ``backend/``, not from ``backend/app/core/``.
    """
    parts = Path(rel_file).parent.parts
    out: list[Path] = []
    for depth in range(1, min(len(parts), _MAX_ANCESTOR_CANDIDATES) + 1):
        candidate = repo.joinpath(*parts[:depth])
        if candidate.is_dir():
            out.append(candidate)
    return out


def _repo_relative(repo: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(repo.resolve()).as_posix() or "."
    except (OSError, ValueError):  # pragma: no cover - outside the repo
        return str(path)


def _import_blocked(stdout: str) -> bool:
    """True when a worker's rows say EVERY target failed at import.

    The signal a working-directory retry needs, read off the worker protocol
    that already exists rather than by inspecting the filesystem. Partial
    success is not blocked: a module where one target imports and another does
    not has a per-target problem, and re-running it from elsewhere would trade
    the successes away for a guess.
    """
    imports = 0
    failures = 0
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("phase") != "import":
            continue
        imports += 1
        if row.get("status") == "error":
            failures += 1
    return imports > 0 and failures == imports


def _owning_distribution(repo: Path, rel_file: str) -> Path | None:
    """Deepest directory declaring itself a distribution that contains ``rel_file``."""
    candidates = [d for d in _distribution_dirs(repo)]
    if not candidates:
        return repo
    try:
        target = (repo / rel_file).resolve()
    except OSError:  # pragma: no cover - a hostile path
        return repo
    best: Path | None = None
    for directory in candidates:
        try:
            resolved = directory.resolve()
        except OSError:  # pragma: no cover
            continue
        if resolved == target or resolved in target.parents:
            # Deepest wins: in a monorepo `libs/core` owns its files, not the
            # repo root that also carries a manifest.
            if best is None or len(resolved.parts) > len(best.parts):
                best = resolved
    return best or repo


def _distribution_dirs(repo: Path) -> list[Path]:
    """Every directory in the tree that declares itself an installable package.

    One pruned walk rather than three ``rglob``s: the pattern form cannot stop a
    descent, so each marker was matched against the whole tree — ``.venv`` and
    its ``site-packages`` included — and filtered afterwards, three times, on
    every call.
    """
    dirs, _venvs = store.walk_source_dirs(repo, max_depth=_MAX_DIST_DEPTH)
    return [d for d, names in dirs if any(m in names for m in _DIST_MARKERS)]


# =========================================================================
# Static purity pre-check — the PRIMARY destructive-call guard
# =========================================================================
#
# Verbs describe intent; this describes behaviour. Before a target is imported
# or called, its body is read out of the source and inspected for calls that
# change the world outside this process. The vocabularies below are the
# general ones — the stdlib's own mutating surface, the standard client
# libraries, and the DB-API method names — not anything harvested from a
# particular repo.

# Whole modules whose every call reaches outside the process.
_IMPURE_MODULE_ROOTS = frozenset(
    {
        "aiohttp",
        "asyncpg",
        "boto3",
        "botocore",
        "ctypes",
        "docker",
        "ftplib",
        "google",
        "http",
        "httpx",
        "kubernetes",
        "multiprocessing",
        "mysqldb",
        "paramiko",
        "psycopg",
        "psycopg2",
        "pymongo",
        "pymysql",
        "redis",
        "requests",
        "shutil",
        "signal",
        "smtplib",
        "socket",
        "sqlalchemy",
        "sqlite3",
        "stripe",
        "subprocess",
        "telnetlib",
        "urllib",
        "urllib2",
        "urllib3",
        "webbrowser",
    }
)

# Modules that are mostly harmless but have a mutating subset. Listing the
# subset keeps `os.path.join` and `sys.version_info` drivable.
_IMPURE_MODULE_ATTRS: dict[str, frozenset[str]] = {
    # Audited against the whole `os` surface: everything that mutates the
    # FILESYSTEM (contents, metadata, links, devices), the PROCESS (cwd, umask,
    # identity, descriptors, environment) or spawns/replaces one. Read-only
    # calls (`stat`, `listdir`, `getcwd`, `os.path.*`) are deliberately absent —
    # over-blocking costs coverage and buys nothing.
    "os": frozenset(
        {
            "_exit",
            "abort",
            "chdir",
            "chflags",
            "chmod",
            "chown",
            "chroot",
            "copy_file_range",
            "dup2",
            "execl",
            "execle",
            "execlp",
            "execlpe",
            "execv",
            "execve",
            "execvp",
            "execvpe",
            "fchdir",
            "fchmod",
            "fchown",
            "fork",
            "forkpty",
            "ftruncate",
            "initgroups",
            "kill",
            "killpg",
            "lchflags",
            "lchmod",
            "lchown",
            "link",
            "makedirs",
            "mkdir",
            "mkfifo",
            "mknod",
            "nice",
            "open",
            "plock",
            "popen",
            "posix_fallocate",
            "posix_spawn",
            "posix_spawnp",
            "putenv",
            "pwrite",
            "pwritev",
            "remove",
            "removedirs",
            "removexattr",
            "rename",
            "renames",
            "replace",
            "rmdir",
            "sendfile",
            "setegid",
            "seteuid",
            "setgid",
            "setgroups",
            "setpgid",
            "setpgrp",
            "setpriority",
            "setregid",
            "setresgid",
            "setresuid",
            "setreuid",
            "setsid",
            "setuid",
            "setxattr",
            "spawnl",
            "spawnle",
            "spawnlp",
            "spawnlpe",
            "spawnv",
            "spawnve",
            "spawnvp",
            "spawnvpe",
            "splice",
            "startfile",
            "symlink",
            "system",
            "truncate",
            "umask",
            "unlink",
            "unsetenv",
            "utime",
            "write",
            "writev",
        }
    ),
    "sys": frozenset({"exit"}),
    "atexit": frozenset({"register"}),
}

# Method names that mean the same thing on every receiver: a DB cursor/session
# commit, a schema drop, a path being unlinked or written.
#
# The second block was added after an audit showed the receiver-agnostic backstop
# had no entry for the most common destructive calls in real code. Each costs
# some coverage on a pure receiver, and each is taken deliberately:
#
# * ``remove``  — ``os.remove``/``Path.remove``/``set.remove`` share a name; the
#   list-mutation case is the price of catching the filesystem one.
# * ``run``     — ``subprocess.run`` under any receiver (``sp.run``, ``self.run``).
# * ``move``/``rename`` — ``shutil.move``, ``Path.rename``: a file leaves its path.
# * ``delete``/``flush`` — the ORM pair (``session.delete``, ``session.flush``);
#   ``flush`` on a file object is a write reaching the disk, so both readings
#   are impure.
# * ``truncate`` — a file or a table losing its contents.
#
# ``close`` is deliberately NOT here: it is overwhelmingly a resource release on
# a receiver that was only read, so it would refuse a large share of pure targets
# for no safety gained — a closed handle changes nothing outside the process that
# opening it did not already.
#
# This table is receiver-AGNOSTIC, which is what makes it a backstop and also what
# made it wrong on its own: `xs.remove(3)` where `xs: list[int]` is a list
# mutation, not `os.remove`, and refusing it dropped provably pure targets. The
# one exception now recognised is a receiver whose type the SIGNATURE states and
# which is a builtin container (see `_pure_container_params`). A receiver of
# UNKNOWN type still lands here and is still refused — that is the whole point of
# a backstop.
_IMPURE_METHOD_NAMES = frozenset(
    {
        "commit",
        "drop",
        "drop_all",
        "execute",
        "executemany",
        "executescript",
        "kill",
        "killpg",
        "mkdir",
        "popen",
        "rmdir",
        "rmtree",
        "sendall",
        "sendmail",
        "sendto",
        "system",
        "terminate",
        "touch",
        "unlink",
        "urlopen",
        "write_bytes",
        "write_text",
        # --- added by the aliasing/indirect-dispatch audit ---
        "delete",
        "flush",
        "move",
        "remove",
        "rename",
        "run",
        "truncate",
    }
)

# Builtins that hand control to source this guard has never read. They are their
# own IMPURITY CLASS (see `impurity_class`) because one consumer — the
# differential oracle — exists precisely to drive code evaluators through its own
# corpus, while the in-process crash harness must refuse them.
_CODE_EVAL_NAMES = frozenset({"__import__", "compile", "eval", "exec"})
CODE_EVALUATION_REASON = "evaluates source text"

# Bare names that only ever come from `from subprocess import …`-style imports,
# plus the builtins that rebind the names this guard reasoned about
# (`globals`/`locals`/`setattr`/`delattr`).
_IMPURE_BARE_CALLS = frozenset(
    {
        "Popen",
        "check_call",
        "check_output",
        "delattr",
        "exit",
        "getoutput",
        "globals",
        "locals",
        "quit",
        "removedirs",
        "rmdir",
        "rmtree",
        "setattr",
        "system",
        "unlink",
        "urlopen",
    }
)

# Builtins are the one family of bare names that resolve without an import and
# whose bodies are not this repo's to inspect. `_IMPURE_BARE_CALLS` is checked
# FIRST, so `exec` never reaches this allowlist.
_BUILTIN_NAMES = frozenset(dir(builtins))

# Decorators that REPLACE the callable and provably add no effect of their own:
# the builtins that only change how a name is bound, plus the stdlib's
# memoisation / typing / dispatch wrappers. Matched on the RESOLVED dotted name
# (`from functools import wraps` → `functools.wraps`) as well as the literal
# spelling.
#
# Everything not on this list is judged, and a wrapper whose body cannot be read
# is REFUSED. That is the whole point: `getattr(mod, qualname)` returns the
# DECORATED object, so a guard that judged the undecorated body was judging code
# that never runs. A bare `@deco` is an `ast.Name`, not an `ast.Call`, which is
# how the plainest spelling of the commonest shape walked straight past.
_INERT_DECORATORS = frozenset(
    {
        "abc.abstractmethod",
        "abc.abstractproperty",
        "classmethod",
        "contextlib.asynccontextmanager",
        "contextlib.contextmanager",
        "dataclasses.dataclass",
        "enum.member",
        "enum.nonmember",
        "enum.unique",
        "enum.verify",
        "functools.cache",
        "functools.cached_property",
        "functools.lru_cache",
        "functools.singledispatch",
        "functools.singledispatchmethod",
        "functools.total_ordering",
        "functools.wraps",
        "property",
        "staticmethod",
        "typing.final",
        "typing.no_type_check",
        "typing.overload",
        "typing.runtime_checkable",
        "typing.type_check_only",
    }
)

# How a receiver binding records what the name holds (see `receiver_bindings`).
_MODULE_TAINT = "module:"
_CLASS_TAINT = "class:"
# A receiver whose type the SIGNATURE states, and which is a builtin container.
# `_IMPURE_METHOD_NAMES` is receiver-agnostic by design — it is the backstop for
# a receiver nothing else could resolve — but that made it refuse provably pure
# targets: `xs.remove(3)` where `xs: list[int]` is a list mutation on an argument
# the caller owns, `parts.truncate` never happens on a str, `d.flush()` is not a
# dict method at all. Those refusals cost real coverage on exactly the small,
# self-contained functions this harness is best at driving. A parameter
# ANNOTATION is a fact the source states about the receiver, in the same class of
# evidence as a module-level binding, so it belongs in `_resolve_receiver` beside
# the other two.
_PARAM_TAINT = "param:"

# The conventional first parameter of a method. `self.sink.record(x)` is rooted
# at a name no receiver map can ever contain, so it needs its OWN resolution
# step (`attribute_bindings`) before the unresolvable-chain rule below fires.
_SELF_NAMES = frozenset({"self", "cls"})

# How far a same-module call chain is followed. A wrapper three hops from the
# `os.remove` is exactly as destructive as the helper; beyond this the walk
# REFUSES rather than assumes (see `impurity_reasons`).
DEFAULT_TRANSITIVE_DEPTH = 3

# Expression kinds that may sit at the root of an attribute chain and still leave
# the call verifiable: a name (resolved against the imports) or a literal
# (`"a,b".split(",")`, `[].append(x)`). Anything else — a call, a subscript, a
# lambda, an await — means the receiver is computed at runtime and the guard
# cannot know what it is.
_VERIFIABLE_ROOTS = (
    ast.Name,
    ast.Constant,
    ast.JoinedStr,
    ast.List,
    ast.Tuple,
    ast.Dict,
    ast.Set,
)

_INDIRECT_REASON = "indirect call target — cannot verify"

# `open(path, mode)` is a write when the mode says so.
_WRITE_MODE_CHARS = frozenset({"w", "a", "x", "+"})
_OPEN_NAMES = frozenset({"open"})


def _attr_chain(node: ast.expr) -> tuple[ast.expr, list[str]]:
    """Split an attribute chain into its root expression and attribute names.

    ``a.b.c`` → ``(Name('a'), ['b', 'c'])``. The root is returned as an
    EXPRESSION rather than a name so the caller can tell "rooted at a name it can
    resolve" from "rooted at something computed at runtime".
    """
    attrs: list[str] = []
    cur = node
    while isinstance(cur, ast.Attribute):
        attrs.append(cur.attr)
        cur = cur.value
    attrs.reverse()
    return cur, attrs


def module_imports(source: str) -> dict[str, str]:
    """Local binding name → the dotted module path it actually refers to.

    This is what makes the module vocabularies mean anything. The old walk
    handed the local BINDING name straight to ``_IMPURE_MODULE_ROOTS``, so
    ``import subprocess as sp`` defeated the whole check — the set has no ``sp``
    in it. Resolving the alias first is the fix::

        import os as _os          -> {"_os": "os"}
        import os.path            -> {"os": "os"}
        import a.b as c           -> {"c": "a.b"}
        from os import remove     -> {"remove": "os.remove"}
        from os.path import join  -> {"join": "os.path.join"}
        from . import helper      -> {"helper": ".helper"}   (never a stdlib root)

    Imports made INSIDE a function body count too: ``def stop(): import sys;
    sys.exit(1)`` is exactly the shape the guard exists for.
    """
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return {}
    out: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    out[alias.asname] = alias.name
                else:
                    # `import a.b` binds only `a`.
                    head = alias.name.split(".")[0]
                    out[head] = head
        elif isinstance(node, ast.ImportFrom):
            # A relative import names a module inside THIS repo, never a stdlib
            # root; the leading dots keep it from colliding with one.
            dots = "." * (node.level or 0)
            base = dots + (node.module or "")
            prefix = base if base.endswith(".") or not base else base + "."
            for alias in node.names:
                if alias.name == "*":
                    continue  # a star import binds names this guard cannot enumerate
                out[alias.asname or alias.name] = prefix + alias.name
    return out


def _dotted_reason(dotted: str) -> str | None:
    """Whether a resolved dotted call target reaches outside the process."""
    parts = dotted.split(".")
    root = parts[0].lower()
    if root in _IMPURE_MODULE_ROOTS:
        return f"calls {dotted}()"
    if parts[-1] in _IMPURE_MODULE_ATTRS.get(root, frozenset()):
        return f"calls {dotted}()"
    return None


#: Modules shipped with the interpreter. A name resolving here and NOT matching
#: `_dotted_reason` is a stdlib callable this guard already knows to be safe.
_STDLIB_ROOTS = frozenset(sys.stdlib_module_names)


def _unverified_cross_module_reason(dotted: str) -> str | None:
    """A callee that resolved to a module whose BODY this guard never read.

    `_dotted_reason` is an allowlist of *impurity*: it answers "is this a known
    dangerous module?", and returning None meant "pure". For a stdlib name that
    is sound — the impure ones are enumerated. For a FIRST-PARTY name it was a
    fail-open, and the dangerous kind:

        from mypkg.db import wipe_all
        def process():            # innocuous name, no local impurity
            wipe_all()            # judged pure → called IN-PROCESS

    Resolving an import tells you where a name came from, not what it does.
    The transitive analyser only walks defs in the SAME source string, so a
    sibling module's body is unreadable by construction — which is exactly when
    the guard must refuse rather than assume.

    Refusing is cheap here: an impurity routes the target to containment, where
    it still runs. The cost is a downgrade, not lost coverage; the alternative
    is executing arbitrary destructive code on a developer's machine.
    """
    # A relative import (`from .db import wipe_all`) is first-party by definition.
    if dotted.startswith("."):
        return f"calls {dotted}() — cross-module call, body not verified"
    root = dotted.split(".")[0]
    if not root or root in _STDLIB_ROOTS:
        return None
    return f"calls {dotted}() — cross-module call, body not verified"


def _is_write_open(call: ast.Call, *, mode_arg: int = 1) -> bool:
    """Whether an ``open(...)`` call opens the file for writing.

    An unreadable (non-literal) mode counts as a write: the guard refuses to
    assume a computed mode is ``"r"``.

    ``mode_arg`` is the positional index of the mode, because the two spellings
    disagree: the builtin is ``open(file, mode)`` but the method is
    ``Path.open(mode)``. Reading index 1 for both meant ``p.open('w')`` had no
    second argument, so the guard saw no mode and judged the write pure —
    and ``pathlib`` is the idiom most modern code actually uses.
    """
    mode: ast.expr | None = None
    if len(call.args) > mode_arg:
        mode = call.args[mode_arg]
    for kw in call.keywords:
        if kw.arg == "mode":
            mode = kw.value
    if mode is None:
        return False
    if isinstance(mode, ast.Constant) and isinstance(mode.value, str):
        return any(ch in _WRITE_MODE_CHARS for ch in mode.value)
    return True


def _nested_definitions(node: ast.AST) -> set[str]:
    """Names ``def``/``class``-bound INSIDE this body.

    Their bodies are inside ``node``, so ``ast.walk`` already judged them; a call
    to one is therefore resolved, not unverifiable.
    """
    return {
        child.name
        for child in ast.walk(node)
        if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
    }


def _decorator_ref(decorator: ast.expr) -> ast.expr:
    """The expression that NAMES a decorator, for ``@d`` and ``@d(...)`` alike."""
    return decorator.func if isinstance(decorator, ast.Call) else decorator


def _decorator_reason(decorator: ast.expr, imports: dict[str, str], known: set[str]) -> str | None:
    """Why applying this decorator makes the decorated object unsafe to call.

    ``None`` means one of exactly two things, both of them checkable: the
    decorator is on the inert list, or it is a same-module name whose body the
    transitive frontier judges next (``_local_calls`` puts it there). Anything
    else — a third-party name, an attribute of a module this guard cannot read,
    a computed expression — is refused, because the object the harness would
    actually call is the WRAPPER, not the body that was inspected.
    """
    ref = _decorator_ref(decorator)
    if isinstance(ref, ast.Name):
        name = ref.id
        dotted = imports.get(name, name)
        # The allowlist is consulted on the RESOLVED name only. Checking the bare
        # spelling too made `from mylib import staticmethod` — a third-party
        # wrapper wearing a builtin's name — read as inert and drivable, which is
        # the exact aliasing bug the rest of this file resolves imports to avoid.
        # (`_dotted_reason` below still checks both readings: for IMPURITY either
        # match is enough, so consulting both is the conservative direction; for
        # an ALLOWLIST it is the permissive one.)
        if _inert_decorator(name, imports):
            return None
        if name in known:
            return None  # a same-module def: judged through the frontier
        if name in _CODE_EVAL_NAMES:
            return f"{CODE_EVALUATION_REASON}: {name}()"
        reason = _dotted_reason(dotted)
        return f"decorated by {name} — {reason}" if reason else _undecidable_decorator(name)
    if isinstance(ref, ast.Attribute):
        root, attrs = _attr_chain(ref)
        if isinstance(root, ast.Name):
            tail = ".".join(attrs)
            if _inert_decorator(f"{root.id}.{tail}", imports):
                return None
            candidates = list(
                dict.fromkeys([f"{imports.get(root.id, root.id)}.{tail}", f"{root.id}.{tail}"])
            )
            reason = next((r for r in (_dotted_reason(c) for c in candidates) if r), None)
            rendered = f"{root.id}.{tail}"
            if reason:
                return f"decorated by {rendered} — {reason}"
            return _undecidable_decorator(rendered)
    # `@registry[name]`, `@make()()`, `@obj.handlers[0]` — computed at runtime.
    return _INDIRECT_REASON


def _inert_decorator(spelling: str, imports: dict[str, str]) -> bool:
    """Whether this decorator spelling is on the provably-inert allowlist.

    Resolution wins over spelling: a name (or an attribute chain's root) that the
    module IMPORTED is judged only as what it was imported as. A spelling the
    module never imported is a builtin or a same-module name and is matched
    literally, which is what keeps a plain ``@staticmethod`` inert.
    """
    head, _, tail = spelling.partition(".")
    resolved = imports.get(head)
    if resolved is None:
        return spelling in _INERT_DECORATORS
    return (f"{resolved}.{tail}" if tail else resolved) in _INERT_DECORATORS


def _undecidable_decorator(rendered: str) -> str:
    return f"decorated by {rendered}() — wrapper body cannot be verified"


def _decorator_names(node: ast.AST) -> set[str]:
    """Bare names used as decorators anywhere in this body (including on it)."""
    out: set[str] = set()
    for child in ast.walk(node):
        if not isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            continue
        for decorator in child.decorator_list:
            ref = _decorator_ref(decorator)
            if isinstance(ref, ast.Name):
                out.add(ref.id)
    return out


def _wrapped_parameter(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    """The name a decorator binds the function it decorates to, if it takes one.

    Calling a bare PARAMETER is normally an unverifiable indirect call, and it
    stays one everywhere else. Inside a body reached as a DECORATOR it is not:
    that parameter holds the very function the guard is judging separately, so
    ``return fn(*a, **kw)`` in a wrapper is resolved, not unknown. Without this
    every same-module decorator — including provably inert ones — would refuse
    its target for the wrapper's unavoidable call back into it.
    """
    positional = [*node.args.posonlyargs, *node.args.args]
    return {positional[0].arg} if positional else set()


# Builtin container types whose ENTIRE method surface is confined to the object
# itself. `list.remove`, `dict.pop`, `set.discard`, `str.replace`,
# `bytearray.truncate` — none of them can reach the filesystem, the network, a
# database or another process, so none of them can make a target impure in the
# sense this guard means. Deliberately CONCRETE builtins only: the typing ABCs
# (`Sequence`, `Mapping`, …) are protocols any user class may implement, so an
# `xs: Sequence[Row]` says nothing at all about what `xs.commit()` runs — those
# keep being refused.
_PURE_CONTAINER_TYPES = frozenset(
    {
        "bytearray",
        "bytes",
        "dict",
        "frozenset",
        "list",
        "set",
        "str",
        "tuple",
    }
)


def _is_pure_container_annotation(annotation: str | None) -> str | None:
    """The builtin container an annotation names, or ``None``.

    Handles the spellings that actually occur — ``list``, ``list[int]``,
    ``typing.List[int]``, ``builtins.dict``, ``dict[str, int] | None`` — and
    refuses everything else, INCLUDING a union with a non-container member
    (``list[int] | Path`` may hold a ``Path``, whose ``.unlink()`` is exactly
    what the backstop exists for).
    """
    if annotation is None:
        return None
    text = str(annotation).strip()
    if not text:
        return None
    members = _union_members(text)
    if members is not None:
        bases = {_is_pure_container_annotation(m) for m in members}
        if not bases or None in bases or len(bases) != 1:
            return None
        return bases.pop()
    head = text.partition("[")[0].split(".")[-1].strip().lower()
    return head if head in _PURE_CONTAINER_TYPES else None


def _pure_container_params(node: ast.AST) -> dict[str, str]:
    """``parameter name -> builtin container type`` for a body's own signature.

    Every ``def`` reachable from ``node`` contributes, because ``ast.walk``
    inspects nested bodies too and a name there is the nested function's
    parameter, not the outer one. A name annotated as a container in one
    signature and as something else (or nothing) in another is DROPPED: the guard
    then cannot say which binding a given call site saw, and "cannot say" means
    refuse.
    """
    good: dict[str, str] = {}
    conflicted: set[str] = set()
    for child in ast.walk(node):
        if not isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        args = child.args
        # `*args: str` / `**kw: str` annotate the ELEMENT, not the collected
        # tuple/dict, so their annotation proves nothing about the receiver —
        # they go straight into `conflicted`.
        for star in (args.vararg, args.kwarg):
            if star is not None:
                conflicted.add(star.arg)
        for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]:
            if arg.arg in _SELF_NAMES:
                continue
            base = (
                _is_pure_container_annotation(ast.unparse(arg.annotation))
                if arg.annotation is not None
                else None
            )
            if base is None:
                conflicted.add(arg.arg)
            elif good.get(arg.arg, base) != base:
                conflicted.add(arg.arg)
            else:
                good[arg.arg] = base
    return {k: v for k, v in good.items() if k not in conflicted}


def _rebound_names(node: ast.AST) -> set[str]:
    """Names a body ASSIGNS to, so a parameter's annotation no longer describes them.

    ``def f(xs: list): xs = open(p); xs.write(...)`` must not be excused by the
    annotation on ``xs``. Assignment (including ``for`` targets, ``with … as``,
    walrus and augmented assignment) means the name may hold something else by
    the time the call runs, and the guard cannot order the statements.
    """
    out: set[str] = set()

    def _bind(target: ast.AST) -> None:
        for sub in ast.walk(target):
            if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store):
                out.add(sub.id)

    for child in ast.walk(node):
        if isinstance(child, ast.Assign):
            for target in child.targets:
                _bind(target)
        elif isinstance(child, ast.AnnAssign | ast.AugAssign | ast.For | ast.AsyncFor):
            _bind(child.target)
        elif isinstance(child, ast.NamedExpr):
            _bind(child.target)
        elif isinstance(child, ast.withitem):
            if child.optional_vars is not None:
                _bind(child.optional_vars)
    return out


def _resolve_receiver(
    root_id: str,
    attrs: list[str],
    receivers: dict[str, str],
    self_attrs: dict[str, str],
    params: dict[str, str] | None = None,
) -> tuple[str | None, list[str], str]:
    """``(taint, remaining attributes, how to render the receiver)``.

    Three ways a chain's receiver becomes knowable. A module-level binding
    (``_session = requests.Session()`` → ``receivers``), — inside a method
    body — an attribute the class assigned to ``self`` (``self.session =
    requests.Session()`` → ``self_attrs``), and the target's OWN parameter
    annotations (``xs: list[int]`` → ``params``). The second is what made
    ``self.sink.record(tag)`` verifiable at all: ``self`` is in no receiver map,
    so before this the chain fell through to the receiver-agnostic NAME backstop
    and a body that wrote a file outside the repo was judged pure.

    The third runs LAST, so a name that is also a tainted module-level receiver
    keeps its taint. That ordering is deliberately the pessimistic one: it can
    only ever leave a target refused, never excuse one.
    """
    bound = receivers.get(root_id)
    if bound is not None:
        return bound, attrs, root_id
    if root_id in _SELF_NAMES and len(attrs) >= 2:
        bound = self_attrs.get(attrs[0])
        if bound is not None:
            return bound, attrs[1:], f"{root_id}.{attrs[0]}"
    container = (params or {}).get(root_id)
    if container is not None:
        return _PARAM_TAINT + container, attrs, root_id
    return None, attrs, root_id


def _resolvable_root(root_id: str, imports: dict[str, str], known: set[str]) -> bool:
    """Whether the guard can say what a chain's ROOT name refers to."""
    return root_id in imports or root_id in known or root_id in _BUILTIN_NAMES


def _direct_impurities(
    node: ast.AST,
    imports: dict[str, str] | None = None,
    known: set[str] | None = None,
    receivers: dict[str, str] | None = None,
    self_attrs: dict[str, str] | None = None,
) -> list[str]:
    """World-changing — or unverifiable — calls made directly in one body.

    ``imports`` resolves local bindings to real dotted modules; ``known`` is the
    set of same-module function (and ``Class.method``) names the caller will
    inspect separately; ``receivers`` names objects built by an impure module or
    a same-module class (see ``receiver_bindings``). A bare call to anything
    outside ``known`` ∪ builtins ∪ ``imports`` cannot be resolved to source, and
    an unresolvable call is treated as impure.

    DECORATORS are judged here too, and they are judged as calls even when they
    are written bare: ``@deco`` is an ``ast.Name``, so a walk that only looked at
    ``ast.Call`` nodes inspected the undecorated body while the harness went on
    to call the decorated object.
    """
    imports = imports or {}
    known = (known or set()) | _nested_definitions(node)
    receivers = receivers or {}
    self_attrs = self_attrs or {}
    # Parameters this body's own signature declares to be builtin containers, less
    # any name the body reassigns (after `xs = open(p)` the annotation on `xs` no
    # longer describes what `xs.write(...)` runs on).
    pure_params = {
        name: base
        for name, base in _pure_container_params(node).items()
        if name not in _rebound_names(node)
    }
    reasons: list[str] = []
    # Calls that CONSTRUCT the exception of a `raise`. Building an exception
    # object is not a side effect, and `raise MyError(...)` where `MyError` came
    # `from .errors import MyError` is one of the most common shapes in any
    # codebase — the cross-module rule below would otherwise refuse every
    # function that raises its package's own error type, which is a large and
    # entirely wrong loss of coverage.
    raised: set[int] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Raise):
            for part in (child.exc, child.cause):
                if isinstance(part, ast.Call):
                    raised.add(id(part))
    for child in ast.walk(node):
        # --- decorators: `@deco`, `@deco(...)`, `@mod.deco` ------------------
        if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            for decorator in child.decorator_list:
                reason = _decorator_reason(decorator, imports, known)
                if reason is not None:
                    reasons.append(reason)
            continue
        if not isinstance(child, ast.Call):
            continue
        if id(child) in raised:
            continue  # constructing the exception of a `raise` — see `raised`
        func = child.func

        # --- bare name: `f(...)` -------------------------------------------
        if isinstance(func, ast.Name):
            name = func.id
            if name in _OPEN_NAMES and _is_write_open(child):
                reasons.append("opens a file for writing")
            elif name in _CODE_EVAL_NAMES:
                reasons.append(f"{CODE_EVALUATION_REASON}: {name}()")
            elif name in _IMPURE_BARE_CALLS:
                reasons.append(f"calls {name}()")
            elif name in imports:
                # `from os import remove` then a bare `remove(path)`: judged on
                # the module it really came from. When that module is NOT one we
                # know, fall through to the unverified rule rather than treating
                # "not on the impure list" as proof of purity.
                reason = _dotted_reason(imports[name]) or _unverified_cross_module_reason(
                    imports[name]
                )
                if reason:
                    reasons.append(reason)
            elif name not in known and name not in _BUILTIN_NAMES:
                reasons.append(f"calls {name}() — unresolved local name, cannot verify")
            continue

        # --- attribute chain: `a.b.c(...)` ----------------------------------
        if isinstance(func, ast.Attribute):
            root, attrs = _attr_chain(func)
            if not isinstance(root, _VERIFIABLE_ROOTS):
                # `getattr(shutil, "rmtree")(root)`, `handlers[k].run()`, …
                reasons.append(_INDIRECT_REASON)
                continue
            attr = attrs[-1]
            # Set when the receiver is a parameter the signature annotates as a
            # builtin container, and the chain is exactly one attribute deep
            # (`xs.remove(3)`, not `xs.log.remove()` — a list has no `.log`, so
            # the deeper chain is unresolvable and stays refused).
            pure_container: str | None = None
            if isinstance(root, ast.Name):
                # A receiver BUILT by an impure module (`_session =
                # requests.Session()`) or by a same-module class (`_store =
                # Store()`), reached either through a module-level binding or
                # through `self.<attr>` inside a method body. Neither is an
                # import binding, so neither was ever resolved here — and a
                # client object held on `self` is the commonest shape of all.
                bound, rest, label = _resolve_receiver(
                    root.id, attrs, receivers, self_attrs, pure_params
                )
                if bound is not None and bound.startswith(_PARAM_TAINT) and len(attrs) == 1:
                    pure_container = bound[len(_PARAM_TAINT) :]
                if bound is not None and bound.startswith(_MODULE_TAINT):
                    origin = bound[len(_MODULE_TAINT) :]
                    reasons.append(f"calls .{attr}() on {label}, built by {origin}()")
                    continue
                if bound is not None and bound.startswith(_CLASS_TAINT):
                    cls = bound[len(_CLASS_TAINT) :]
                    if len(rest) == 1 and f"{cls}.{attr}" in known:
                        continue  # the method body is judged through the frontier
                    reasons.append(f"calls .{attr}() on {label} ({cls}) — no readable method body")
                    continue
                tail = ".".join(attrs)
                # Both readings, because either one being impure is enough: the
                # RESOLVED module (`sp.run` -> `subprocess.run`) and the literal
                # binding (a name that shadows a module the guard knows).
                candidates = [f"{imports.get(root.id, root.id)}.{tail}", f"{root.id}.{tail}"]
                reason = next(
                    (r for r in (_dotted_reason(c) for c in dict.fromkeys(candidates)) if r), None
                )
                if reason:
                    reasons.append(reason)
                    continue
                # Same fail-open as the bare-name branch, reached differently:
                # `import mypkg.db` then `mypkg.db.wipe_all()` resolves cleanly,
                # matches no impure module, and used to fall through as pure.
                if root.id in imports:
                    unverified = _unverified_cross_module_reason(f"{imports[root.id]}.{tail}")
                    if unverified:
                        reasons.append(unverified)
                        continue
                # An attribute chain two deep or more, rooted at a name this
                # guard cannot resolve to a module, a same-module definition, a
                # tainted receiver or a builtin. `self.sink.record(tag)`,
                # `cfg.client.send(x)`, `ctx.s3.upload_file(...)`: the object the
                # method runs on is decided at runtime, so the body that would
                # run has never been read. The file already refuses an
                # unresolvable BARE NAME (`calls f() — unresolved local name`);
                # refusing the chain is the same rule, and its absence was a
                # hole a real filesystem write walked straight through.
                if len(attrs) >= 2 and not _resolvable_root(root.id, imports, known):
                    reasons.append(_INDIRECT_REASON)
                    continue
            # `p.open('w')` — the METHOD spelling, where mode is the first
            # positional argument rather than the second.
            if attr in _OPEN_NAMES and _is_write_open(child, mode_arg=0):
                reasons.append("opens a file for writing")
                continue
            if attr in _IMPURE_METHOD_NAMES and pure_container is None:
                reasons.append(f"calls .{attr}()")
            continue

        # --- anything else in call position ---------------------------------
        # `getattr(shutil, "rmtree")(root)` (a Call as func), `table[k](x)`,
        # `(lambda: os.remove(p))()`. The old walk `continue`d here and inspected
        # NOTHING, which is how the worst bypass got in.
        reasons.append(_INDIRECT_REASON)
    return sorted(dict.fromkeys(reasons))


def _local_calls(
    node: ast.AST,
    known: set[str],
    receivers: dict[str, str] | None = None,
    self_attrs: dict[str, str] | None = None,
) -> list[str]:
    """Same-module bodies this one reaches: bare calls, DECORATORS, and methods.

    Decorators count because a decorated target IS the wrapper — the frontier
    has to reach ``_wrap`` for its body to be judged at all. Methods count when
    the receiver is a known instance of a same-module class (``_store =
    Store()`` then ``_store.wipe()``, or ``self.sink = Sink()`` then
    ``self.sink.record()``), which is how the receiver's ``os.remove`` becomes
    visible.
    """
    receivers = receivers or {}
    self_attrs = self_attrs or {}
    out: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            for decorator in child.decorator_list:
                ref = _decorator_ref(decorator)
                if isinstance(ref, ast.Name):
                    out.add(ref.id)
            continue
        if not isinstance(child, ast.Call):
            continue
        if isinstance(child.func, ast.Name):
            out.add(child.func.id)
            continue
        if isinstance(child.func, ast.Attribute):
            root, attrs = _attr_chain(child.func)
            if not isinstance(root, ast.Name):
                continue
            bound, rest, _label = _resolve_receiver(root.id, attrs, receivers, self_attrs)
            if bound and bound.startswith(_CLASS_TAINT) and len(rest) == 1:
                out.add(f"{bound[len(_CLASS_TAINT) :]}.{rest[0]}")
    return sorted(out & known)


def module_function_defs(source: str) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    """Module-level ``def``s of a Python source text, by name.

    Nested and class-level definitions are deliberately absent: the harness can
    only call module-level callables, so those are the only bodies to judge.
    """
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return {}
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    }


def module_method_defs(source: str) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    """``"Class.method"`` → its def, for module-level classes.

    The harness never DRIVES a method — it can only call module-level
    callables — but it has to be able to JUDGE one: a module-level
    ``_store = Store()`` makes ``_store.wipe()`` a call into this file, and the
    only way to know whether that wipes anything is to read ``Store.wipe``.
    """
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return {}
    out: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        for item in node.body:
            if isinstance(item, ast.FunctionDef | ast.AsyncFunctionDef):
                out[f"{node.name}.{item.name}"] = item
    return out


def _construction_origin(
    func: ast.expr,
    imports: dict[str, str],
    classes: set[str],
    factories: dict[str, str] | None = None,
) -> str | None:
    """What a call in ASSIGNMENT position builds, when that is knowable.

    ``_MODULE_TAINT`` + the dotted callable when it comes out of a module whose
    surface reaches outside the process; ``_CLASS_TAINT`` + the class name when
    it is a same-module class; whatever a same-module FACTORY was found to
    return (``def _make(): return requests.Session()``). ``None`` when the value
    is anything else — a literal, a call this guard cannot resolve.
    """
    if isinstance(func, ast.Name):
        dotted = imports.get(func.id, func.id)
        if _dotted_reason(dotted):
            return _MODULE_TAINT + dotted
        if func.id in classes:
            return _CLASS_TAINT + func.id
        if factories:
            return factories.get(func.id)
        return None
    if isinstance(func, ast.Attribute):
        root, attrs = _attr_chain(func)
        if not isinstance(root, ast.Name):
            return None
        tail = ".".join(attrs)
        for cand in dict.fromkeys([f"{imports.get(root.id, root.id)}.{tail}", f"{root.id}.{tail}"]):
            if _dotted_reason(cand):
                return _MODULE_TAINT + cand
    return None


def _own_returns(node: ast.AST) -> list[ast.Return]:
    """``return`` statements belonging to THIS body, not to a nested ``def``."""
    out: list[ast.Return] = []
    stack: list[ast.AST] = list(ast.iter_child_nodes(node))
    while stack:
        current = stack.pop()
        if isinstance(current, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda | ast.ClassDef):
            continue
        if isinstance(current, ast.Return):
            out.append(current)
        stack.extend(ast.iter_child_nodes(current))
    return out


def _factory_origins(
    tree: ast.AST, imports: dict[str, str], classes: set[str], rounds: int = 3
) -> dict[str, str]:
    """Same-module functions whose EVERY return is one known construction.

    ``def _make(): return requests.Session()`` then ``_session = _make()`` binds
    a receiver just as surely as calling ``requests.Session()`` inline did, and
    the indirection is the whole point of writing a factory. A function with no
    returns, a bare ``return``, a non-call return, or two returns that build
    DIFFERENT things is not one of these — the guard would be guessing.

    Iterated to a fixed point (bounded) so a factory calling a factory resolves.
    """
    out: dict[str, str] = {}
    for _ in range(max(1, rounds)):
        changed = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            if node.name in out:
                continue
            returns = _own_returns(node)
            if not returns:
                continue
            origins: set[str] = set()
            for statement in returns:
                value = statement.value
                if not isinstance(value, ast.Call):
                    origins.clear()
                    break
                origin = _construction_origin(value.func, imports, classes, out)
                if origin is None:
                    origins.clear()
                    break
                origins.add(origin)
            if len(origins) == 1:
                out[node.name] = origins.pop()
                changed = True
        if not changed:
            break
    return out


def _assignment_pairs(target: ast.expr, value: ast.expr):
    """``(target, value)`` pairs for one binding, over-tainting when unsure.

    ``a, b = Session(), 30`` splits elementwise. ``a, b = make_pair()`` cannot
    be split, so BOTH names are paired with the whole call — over-tainting a
    name costs coverage, and under-tainting one runs an uncontained network
    client.
    """
    if isinstance(target, ast.Tuple | ast.List):
        elements = target.elts
        if isinstance(value, ast.Tuple | ast.List) and len(value.elts) == len(elements):
            for sub_target, sub_value in zip(elements, value.elts, strict=True):
                yield from _assignment_pairs(sub_target, sub_value)
            return
        for sub_target in elements:
            yield from _assignment_pairs(sub_target, value)
        return
    if isinstance(target, ast.Starred):
        yield from _assignment_pairs(target.value, value)
        return
    yield target, value


def _iterated_values(iterable: ast.expr) -> list[ast.expr]:
    """The expressions a ``for`` target could be bound to, as far as is knowable."""
    if isinstance(iterable, ast.List | ast.Tuple | ast.Set):
        return list(iterable.elts)
    return [iterable]


def _binding_sites(tree: ast.AST):
    """Every ``(target, value)`` pair in a module, whatever syntax bound it.

    Plain assignment was the only shape the receiver map used to see, and five
    ordinary ways of binding a client object walked past it: tuple assignment,
    ``with … as``, the walrus, a ``for`` target, and a same-module factory (that
    last one is handled in ``_construction_origin``). Each of them produced an
    empty binding map and a DRIVABLE verdict on ``_s.post(url)``.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                yield from _assignment_pairs(target, node.value)
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            yield from _assignment_pairs(node.target, node.value)
        elif isinstance(node, ast.NamedExpr):
            yield from _assignment_pairs(node.target, node.value)
        elif isinstance(node, ast.With | ast.AsyncWith):
            for item in node.items:
                if item.optional_vars is not None:
                    yield from _assignment_pairs(item.optional_vars, item.context_expr)
        elif isinstance(node, ast.For | ast.AsyncFor):
            for value in _iterated_values(node.iter):
                yield from _assignment_pairs(node.target, value)


def receiver_bindings(source: str, imports: dict[str, str] | None = None) -> dict[str, str]:
    """Names bound to an object whose METHODS reach outside this file.

    ``_session = requests.Session()`` binds a receiver whose every method is a
    network call; ``_store = Store()`` binds one whose methods are right here.
    Neither name is an import binding, so the attribute-chain walk — which only
    ever resolved import bindings — fell through to the receiver-agnostic
    ``_IMPURE_METHOD_NAMES`` backstop and accepted ``_session.post(url)``,
    ``_s3.delete_bucket(...)``, ``_r.flushall()``, ``_sock.connect(...)``.

    Every binding SYNTAX counts, not just ``x = C()``: a tuple unpack, a ``with``
    target, a walrus, a ``for`` target and a same-module factory all bind the
    same dangerous object, and each of them used to yield an empty map.

    Bindings anywhere in the module count, including inside function bodies: the
    map is deliberately not scope-aware, because a name that ever holds a client
    object is not a name this guard should assume is inert somewhere else.
    """
    imports = module_imports(source) if imports is None else imports
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return {}
    classes = {node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)}
    factories = _factory_origins(tree, imports, classes)
    out: dict[str, str] = {}
    for target, value in _binding_sites(tree):
        if not isinstance(target, ast.Name) or not isinstance(value, ast.Call):
            continue
        origin = _construction_origin(value.func, imports, classes, factories)
        if origin is not None:
            out[target.id] = origin
    return out


def attribute_bindings(source: str, imports: dict[str, str] | None = None) -> dict[str, str]:
    """``"Class.attr"`` → what that instance attribute holds.

    The receiver map answers "what does the NAME ``_session`` hold"; this one
    answers "what does ``self.session`` hold", which is the shape almost all
    real client objects actually take. Without it a method body reached through
    a tainted receiver had its own chains rooted at ``self`` — a name in no
    receiver map — and fell through to the NAME backstop: ``self.sink.record()``
    was judged pure while ``Sink.record`` wrote a file outside the repo.

    Every method counts, not only ``__init__``: a ``connect()`` that assigns
    ``self.session`` is the same hazard arriving later.
    """
    imports = module_imports(source) if imports is None else imports
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return {}
    classes = {node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)}
    factories = _factory_origins(tree, imports, classes)
    out: dict[str, str] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        for target, value in _binding_sites(node):
            if not isinstance(value, ast.Call):
                continue
            if not isinstance(target, ast.Attribute) or not isinstance(target.value, ast.Name):
                continue
            if target.value.id not in _SELF_NAMES:
                continue
            origin = _construction_origin(value.func, imports, classes, factories)
            if origin is not None:
                out[f"{node.name}.{target.attr}"] = origin
    return out


def _self_attrs_for(name: str, attributes: dict[str, str]) -> dict[str, str]:
    """The ``self.<attr>`` taints in scope while judging ``"Class.method"``."""
    cls, sep, _method = name.partition(".")
    if not sep:
        return {}
    prefix = f"{cls}."
    return {k[len(prefix) :]: v for k, v in attributes.items() if k.startswith(prefix)}


def impurity_reasons(
    qualname: str,
    defs: dict[str, ast.FunctionDef | ast.AsyncFunctionDef],
    *,
    imports: dict[str, str] | None = None,
    methods: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] | None = None,
    receivers: dict[str, str] | None = None,
    attributes: dict[str, str] | None = None,
    depth: int = DEFAULT_TRANSITIVE_DEPTH,
) -> list[str]:
    """Why calling ``qualname`` would change the world, or ``[]`` when it would not.

    Transitive to ``depth`` through same-module helpers: a wrapper whose body is
    one call to ``_really_delete()`` is exactly as destructive as the helper, and
    an ``a -> b -> c`` chain hides it just as well as one hop did. The frontier
    also carries DECORATORS (the harness calls the decorated object, so the
    wrapper's body is the body that runs) and methods reached through a known
    receiver. The walk keeps a visited set, so recursion and cycles terminate; if
    the chain is still unexhausted at ``depth``, that is REPORTED as an impurity
    rather than assumed harmless — the same discipline as every other refusal
    here.

    ``imports``/``methods``/``receivers``/``attributes`` should all come from the
    same source as ``defs`` (``module_imports``, ``module_method_defs``,
    ``receiver_bindings``, ``attribute_bindings``); ``impurities_in_source``
    wires them together. Passing none is safe but weaker: an aliased ``import
    subprocess as sp`` then only matches through the literal binding, and a
    client object held on ``self`` is judged by the receiver-agnostic backstop
    alone.
    """
    node = defs.get(qualname)
    if node is None:
        return []
    attributes = attributes or {}
    bodies: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {**(methods or {}), **defs}
    known = set(bodies)
    reasons = list(_direct_impurities(node, imports, known, receivers))
    seen = {qualname}
    frontier = [qualname]
    for _ in range(max(0, depth)):
        nxt: list[str] = []
        for name in frontier:
            current = bodies.get(name)
            if current is None:
                continue
            decorators = _decorator_names(current)
            for callee in _local_calls(
                current, known, receivers, _self_attrs_for(name, attributes)
            ):
                if callee in seen:
                    continue
                seen.add(callee)
                nxt.append(callee)
                body = bodies[callee]
                scope = known | (_wrapped_parameter(body) if callee in decorators else set())
                for reason in _direct_impurities(
                    body, imports, scope, receivers, _self_attrs_for(callee, attributes)
                ):
                    reasons.append(f"{reason} via {callee}()")
        frontier = nxt
    if frontier:
        reasons.append(
            f"call chain deeper than {depth} hops ({', '.join(sorted(frontier)[:3])}) "
            "— cannot verify"
        )
    return sorted(dict.fromkeys(reasons))


def impurities_in_source(
    source: str, qualname: str, *, depth: int = DEFAULT_TRANSITIVE_DEPTH
) -> list[str]:
    """``impurity_reasons`` with every vocabulary read from the SAME source.

    The one entry point callers should use: the imports, the class bodies and
    the receiver bindings all have to come from the same text as the defs, and
    wiring three of the four by hand is how a caller ends up with a weaker guard
    than it thinks it has.
    """
    imports = module_imports(source)
    return impurity_reasons(
        qualname,
        module_function_defs(source),
        imports=imports,
        methods=module_method_defs(source),
        receivers=receiver_bindings(source, imports),
        attributes=attribute_bindings(source, imports),
        depth=depth,
    )


def impurity_class(reason: str) -> str:
    """Which control is supposed to handle this impurity.

    ``"code-evaluation"`` — the body runs source text (``exec``/``eval``/
    ``compile``/``__import__``). The differential oracle is BUILT to drive these
    (it feeds them a curated corpus in its own worker and compares against
    CPython), so it opts in; the crash harness, which would call them with a
    guessed string in a process it shares with nothing, never does.

    ``"world-mutation"`` — everything else, and nothing opts into it.
    """
    return "code-evaluation" if reason.startswith(CODE_EVALUATION_REASON) else "world-mutation"


def _ast_params(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[dict[str, Any]]:
    """Parameter records read from SOURCE (no import), same shape as the live ones."""
    args = node.args
    positional = [*args.posonlyargs, *args.args]
    first_default = len(positional) - len(args.defaults)
    out: list[dict[str, Any]] = []
    for i, arg in enumerate(positional):
        if arg.arg in ("self", "cls"):
            continue
        out.append(
            {
                "name": arg.arg,
                "annotation": ast.unparse(arg.annotation) if arg.annotation else None,
                "has_default": i >= first_default,
                "keyword_only": False,
            }
        )
    for arg, default in zip(args.kwonlyargs, args.kw_defaults, strict=False):
        out.append(
            {
                "name": arg.arg,
                "annotation": ast.unparse(arg.annotation) if arg.annotation else None,
                "has_default": default is not None,
                "keyword_only": True,
            }
        )
    return out


@lru_cache(maxsize=512)
def _facts_from_source(source: str) -> dict[str, dict[str, Any]]:
    """Per-function ``{"params", "impurities"}`` for one module's source text."""
    defs = module_function_defs(source)
    imports = module_imports(source)
    methods = module_method_defs(source)
    receivers = receiver_bindings(source, imports)
    attributes = attribute_bindings(source, imports)
    return {
        name: {
            "params": _ast_params(node),
            "impurities": impurity_reasons(
                name,
                defs,
                imports=imports,
                methods=methods,
                receivers=receivers,
                attributes=attributes,
            ),
        }
        for name, node in defs.items()
    }


def source_facts(path: Path) -> dict[str, dict[str, Any]] | None:
    """Static facts about one file's module-level functions, or None when the
    source cannot be read or parsed.

    None is NOT "nothing to worry about": a target whose source could not be
    inspected has not passed the purity pre-check, and discovery skips it rather
    than importing and calling it on trust.
    """
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    try:
        ast.parse(source)
    except (SyntaxError, ValueError):
        return None
    return _facts_from_source(source)


def _param_records(fn: Any) -> list[dict[str, Any]] | None:
    """Serializable parameter records for a callable, or None when undrivable.

    A parameter with no default and no usable annotation makes the call a guess,
    so the target is skipped rather than called with junk — the harness reports
    what it could NOT drive instead of manufacturing false failures.
    """
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    out: list[dict[str, Any]] = []
    for name, p in sig.parameters.items():
        if name in ("self", "cls"):
            continue
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue  # *args/**kwargs: callable without them
        ann = p.annotation
        # Guard the empty sentinel FIRST: inspect.Parameter.empty is a class,
        # so getattr(ann, "__name__") on it yields the truthy "_empty" and an
        # unannotated parameter would masquerade as an annotated one.
        ann_name = None
        if ann is not p.empty:
            ann_name = getattr(ann, "__name__", None) or str(ann)
        has_default = p.default is not p.empty
        if not has_default and ann_name is None:
            return None
        out.append(
            {
                "name": name,
                "annotation": ann_name,
                "has_default": has_default,
                "keyword_only": p.kind == p.KEYWORD_ONLY,
            }
        )
    return out


@dataclass
class Refusal:
    """A candidate the purity guard refused, kept drivable for the SANDBOX.

    A refusal that carries no target is a dead end; one that carries the target
    and the reasons is a recoverable decision. Only impurity refusals become
    these — a destructive NAME and test scaffolding stay terminal, because no
    amount of containment makes calling ``drop_database`` a good idea and a
    ``test_*`` function belongs to a test runner, not to us.
    """

    target: FunctionTarget
    reasons: list[str]

    @property
    def id(self) -> str:
        return self.target.id

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "target": self.target.to_json(), "reasons": list(self.reasons)}


# Prefix of the ``skipped`` reason that marks an impurity-only refusal — the one
# kind the execution sandbox can take over.
IMPURE_SKIP_PREFIX = "impure-body: "


def discover_targets(
    repo: Path,
    *,
    max_targets: int = 200,
    logger: logging.Logger | None = None,
    allow_impurities: frozenset[str] = frozenset(),
) -> tuple[list[FunctionTarget], list[dict[str, str]]]:
    """Callables to drive, plus the skipped ones with reasons.

    The stable two-value view of ``discover_with_refusals`` — every existing
    caller keeps its signature; the sandbox driver is the one consumer that
    needs the third value.
    """
    targets, skipped, _refused = discover_with_refusals(
        repo,
        max_targets=max_targets,
        logger=logger,
        allow_impurities=allow_impurities,
    )
    return targets, skipped


def discover_with_refusals(
    repo: Path,
    *,
    max_targets: int = 200,
    logger: logging.Logger | None = None,
    allow_impurities: frozenset[str] = frozenset(),
) -> tuple[list[FunctionTarget], list[dict[str, str]], list[Refusal]]:
    """Callables to drive, the skipped ones with reasons, and the RECOVERABLE ones.

    Two sources, in priority order: identification's catalogued NON-HTTP entry
    points (CLI commands, tasks, script mains — inventory that has never had a
    driver), then public module-level functions of the same files. Discovery
    imports nothing; signatures are read in the worker, so a module that
    explodes on import costs only its own results.

    ``allow_impurities`` names ``impurity_class`` values a CALLER has its own
    control for — today only the differential oracle, for ``"code-evaluation"``.
    The default tolerates nothing.

    A deliberate tradeoff lives here. The purity pre-check refuses what it cannot
    RESOLVE (an indirect call target, an unknown bare name, a chain deeper than
    the depth limit), so this function skips strictly more candidates than a
    guard that inspected only what it recognised. That is the correct direction:
    the harness imports third-party code and calls it in a process on a user's
    machine, so an unverified target is a target not worth the coverage. Every
    refusal is in ``skipped`` with its reason, so the loss is auditable rather
    than silent.

    The THIRD return value is what keeps that tradeoff from being permanent: the
    subset refused only for impurity, carried with its coordinates and reasons so
    ``sandbox.run_sandboxed_targets`` can drive it under containment. Nothing
    here decides to run it — discovery still refuses; the sandbox is a separate,
    opt-in control.
    """
    log = logger or logging.getLogger(__name__)
    apis_doc = store.read_json(store.apis_json_path(repo))
    entrypoints = (apis_doc or {}).get("entrypoints") or []
    src_roots = detect_src_roots(repo)

    targets: list[FunctionTarget] = []
    skipped: list[dict[str, str]] = []
    refused: list[Refusal] = []
    seen: set[str] = set()

    # One parse per FILE, not one per target. `_add` runs once per callable and
    # a module contributes many, so re-reading and re-`ast.parse`-ing the file
    # each time was already the bulk of discovery — and the exported-then-
    # internal ordering above walks every file twice.
    facts_by_file: dict[str, dict[str, dict[str, Any]] | None] = {}

    def _facts_for(rel: str) -> dict[str, dict[str, Any]] | None:
        if rel not in facts_by_file:
            facts_by_file[rel] = source_facts(repo / rel)
        return facts_by_file[rel]

    def _add(module: str, qualname: str, rel: str, kind: str) -> None:
        tid = f"{module}:{qualname}"
        if tid in seen or len(targets) >= max_targets:
            return
        seen.add(tid)
        # 1) Scaffolding: never call what a test runner owns.
        if is_test_scaffolding(qualname):
            skipped.append({"id": tid, "reason": "test-scaffolding"})
            return
        # 2) Backstop vocabulary, on identifier SEGMENTS.
        reason = denial_reason(qualname) or denial_reason(module)
        if reason is not None:
            skipped.append({"id": tid, "reason": f"destructive-name: {reason}"})
            return
        # 3) Primary guard: what the body actually DOES, read from source.
        facts = _facts_for(rel)
        if facts is None:
            skipped.append({"id": tid, "reason": "unverifiable-source — refusing to call unread"})
            return
        fact = facts.get(qualname)
        if fact is None:
            skipped.append(
                {"id": tid, "reason": "no module-level definition in source — nothing to verify"}
            )
            return
        blocking = [r for r in fact["impurities"] if impurity_class(r) not in allow_impurities]
        if blocking:
            skipped.append({"id": tid, "reason": IMPURE_SKIP_PREFIX + "; ".join(blocking[:4])})
            if len(refused) < max_targets:
                refused.append(
                    Refusal(
                        target=FunctionTarget(
                            module=module,
                            qualname=qualname,
                            file=rel,
                            kind=kind,
                            params=list(fact["params"]),
                        ),
                        reasons=list(blocking),
                    )
                )
            return
        targets.append(
            FunctionTarget(
                module=module,
                qualname=qualname,
                file=rel,
                kind=kind,
                params=list(fact["params"]),
            )
        )

    files_seen: set[str] = set()
    for ep in entrypoints:
        if not isinstance(ep, dict) or ep.get("kind") == "http_api":
            continue
        rel = ep.get("file")
        handler = ep.get("handler")
        if not isinstance(rel, str):
            continue
        files_seen.add(rel)
        module = module_name_for(rel, src_roots)
        if module is None:
            skipped.append({"id": rel, "reason": "not-an-importable-module"})
            continue
        if isinstance(handler, str) and handler:
            _add(module, handler, rel, "entrypoint")

    # Exported functions of the same modules widen the target set past the
    # handful of decorated entry points — for a LIBRARY that is the whole
    # surface. Names are read from source (no import) via the code index.
    index_syms = _index_functions_by_file(repo)
    # TWO passes, exported before internal. `_add` stops at `max_targets` and the
    # walk is alphabetical by file, so a single pass spent the budget in file
    # order: with private functions now eligible they are the majority of a real
    # repo's module-level definitions (851 of langchain's 1,365), and `_helper`
    # in `a.py` took the slot that the public API in `z.py` never got. Which
    # functions are driven should not depend on their filename.
    for internal_pass in (False, True):
        for rel in sorted(index_syms if not files_seen else (files_seen | set(index_syms))):
            module = module_name_for(rel, src_roots)
            if module is None:
                continue
            for name in index_syms.get(rel, []):
                # A leading underscore is a statement about API STABILITY, not
                # about whether calling the function is safe or worth doing — and
                # it is where the parsing, merging and normalising helpers live,
                # which is where input-shaped defects concentrate. Safety is
                # decided by the purity guard, the destructive-name vocabulary
                # and containment, all of which apply here unchanged. Dunders
                # stay out: they are the interpreter's protocol, driven through
                # the operation that invokes them rather than by name.
                if name.startswith("__"):
                    continue
                if name.startswith("_") is not internal_pass:
                    continue
                _add(module, name, rel, "internal" if internal_pass else "exported")

    log.info(
        "functions: %d targets, %d skipped (%d sandboxable) (roots=%s)",
        len(targets),
        len(skipped),
        len(refused),
        src_roots,
    )
    return targets, skipped, refused


def _index_functions_by_file(repo: Path) -> dict[str, list[str]]:
    """Module-level function names per repo-relative file, from the code index.

    Deliberately reads the SAME index the rest of Vinv reads; when it is absent
    the harness still runs on the catalogued entry points alone.
    """
    chunks = repo / ".vinv" / "index" / "chunks.jsonl"
    out: dict[str, list[str]] = {}
    if not chunks.is_file():
        return out
    try:
        with chunks.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict) or rec.get("kind") != "function":
                    continue
                rel, name = rec.get("file"), rec.get("name")
                if not isinstance(rel, str) or not isinstance(name, str):
                    continue
                if rec.get("parent"):
                    continue  # methods need an instance; module-level only
                out.setdefault(rel, []).append(name)
    except OSError:
        return out
    return {k: sorted(set(v)) for k, v in out.items()}


# =========================================================================
# Argument generation
# =========================================================================

# Deterministic per-class values by annotation, mirroring schema.py's classes:
# a valid instance, a boundary instance, and a hostile one.
_BY_ANNOTATION: dict[str, dict[str, Any]] = {
    "str": {"valid": "vinv", "boundary": "", "negative": None},
    "int": {"valid": 3, "boundary": 0, "negative": -(2**63)},
    "float": {"valid": 1.5, "boundary": 0.0, "negative": float("nan")},
    "bool": {"valid": True, "boundary": False, "negative": None},
    "bytes": {"valid": b"vinv", "boundary": b"", "negative": None},
    "list": {"valid": [1, 2], "boundary": [], "negative": None},
    "dict": {"valid": {"k": "v"}, "boundary": {}, "negative": None},
    "tuple": {"valid": (1, 2), "boundary": (), "negative": None},
    "set": {"valid": {1}, "boundary": set(), "negative": None},
}
INPUT_CLASSES = ("valid", "boundary", "negative")

# Typing ABCs a concrete family genuinely satisfies: a ``list`` IS a Sequence,
# so supplying ``[1, 2]`` for ``Sequence[int]`` really does conform. Anything
# NOT reducible to one of these families is unresolved — the harness must not
# claim conformance for a value it invented.
_ANNOTATION_ALIASES = {
    "collection": "list",
    "iterable": "list",
    "mutablemapping": "dict",
    "mutablesequence": "list",
    "mapping": "dict",
    "sequence": "list",
}
# Annotations that accept anything (so any value conforms) or only None.
_WILDCARD_ANNOTATIONS = frozenset({"any", "object"})
_NONE_ANNOTATIONS = frozenset({"none", "nonetype"})


def _split_top_level(text: str, separators: str) -> list[str]:
    """Split on ``separators`` that are not nested inside brackets."""
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for ch in text:
        if ch in "[(":
            depth += 1
        elif ch in "])":
            # Clamped: an unbalanced closer (a truncated or malformed annotation)
            # would otherwise drive depth negative, and every later separator
            # would look nested — the splitter goes blind for the rest of the
            # string rather than merely mis-handling the bad character.
            depth = max(0, depth - 1)
        if depth == 0 and ch in separators:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def _union_members(text: str) -> list[str] | None:
    """Members of a TOP-LEVEL ``|`` union, or ``None`` if this is not one.

    ``"|" in text`` is not the same question. In ``list[ChatMessage | dict]`` the
    bar is nested, so a top-level split returns the string unchanged — and both
    callers below recurse on their first member, which means recursing on the
    identical string forever. On real modern-typed code (``list[Step | None]``,
    ``dict[str, str | bool]``) that ``RecursionError`` propagated out of
    ``discover_targets``, where ``campaign`` caught it as "function oracles
    unavailable" and armed ZERO actions: five working oracles silently
    contributing nothing, on exactly the repos most likely to be worth running.

    Returning ``None`` here sends the caller to its bracket-head path, which
    reads the outer constructor — the correct answer for a nested union.
    """
    if "|" not in text:
        return None
    members = _split_top_level(text, "|")
    if len(members) < 2:
        return None  # nested, not a union: let the caller inspect the head
    return [m for m in members if m.strip().lower() not in _NONE_ANNOTATIONS]


def annotation_base(annotation: str | None) -> str | None:
    """Reduce an annotation to the base type name a value can be built for.

    ``Optional[str]`` → ``str``; ``dict[str, int] | None`` → ``dict``;
    ``pkg.Config`` → ``config`` (which is not a family, so it is unresolvable).
    """
    if annotation is None:
        return None
    text = str(annotation).strip()
    if not text:
        return None
    members = _union_members(text)
    if members is not None:
        return annotation_base(members[0]) if members else "none"
    head, bracket, rest = text.partition("[")
    head = head.split(".")[-1].strip().lower()
    if bracket and head in ("optional", "union"):
        inner = rest.rsplit("]", 1)[0]
        members = [m for m in _split_top_level(inner, ",") if m.lower() not in _NONE_ANNOTATIONS]
        return annotation_base(members[0]) if members else "none"
    return _ANNOTATION_ALIASES.get(head, head) or None


def annotation_resolved(annotation: str | None) -> bool:
    """Whether the harness can build a value that genuinely SATISFIES ``annotation``.

    This is the honesty gate for ``conformant``: for ``cfg: Config`` there is no
    such value, so passing the string family's ``"vinv"`` and then telling the
    policy the value conformed to the declared type turns every defensive
    ``assert isinstance(cfg, Config)`` into a reported defect.
    """
    base = annotation_base(annotation)
    if base is None:
        return False
    return base in _BY_ANNOTATION or base in _WILDCARD_ANNOTATIONS or base in _NONE_ANNOTATIONS


def resolved_value_for(annotation: str | None, cls: str) -> tuple[Any, bool]:
    """``(value, resolved)`` for an annotation and input class.

    ``resolved`` is False when the value is a GUESS: the annotation named a type
    this harness cannot instantiate, so the string family stands in. The value
    is still worth sending (a wrong-typed argument is a legitimate probe) but no
    caller may treat it as conforming to the declared type.
    """
    base = annotation_base(annotation)
    if base is not None:
        table = _BY_ANNOTATION.get(base)
        if table is not None:
            return table[cls], True
        if base in _WILDCARD_ANNOTATIONS:
            return _BY_ANNOTATION["str"][cls], True
        if base in _NONE_ANNOTATIONS:
            return None, True
    return _BY_ANNOTATION["str"][cls], False


def value_for(annotation: str | None, cls: str) -> Any:
    """Deterministic argument value for an annotation and input class.

    Unknown annotations fall back to the string family — a wrong-typed argument
    is itself a legitimate probe (the negative class exists to be rejected) —
    but callers that need to know whether it was a GUESS must use
    ``resolved_value_for``/``annotation_resolved``.
    """
    return resolved_value_for(annotation, cls)[0]


def unresolvable_required(params: list[dict[str, Any]]) -> list[str]:
    """Names of required parameters whose annotation cannot be satisfied."""
    return [
        str(p["name"])
        for p in params
        if not p.get("has_default") and not annotation_resolved(p.get("annotation"))
    ]


def arg_sets_for(params: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One argument map per input class for a target's parameters.

    Parameters with defaults are omitted from the ``valid`` set (exercising the
    documented default path) and supplied in the others. Each set records
    ``annotations_resolved``: whether EVERY argument it supplies was built from
    an annotation the harness actually understood.
    """
    out: list[dict[str, Any]] = []
    for cls in INPUT_CLASSES:
        kwargs: dict[str, Any] = {}
        resolved = True
        for p in params:
            if cls == "valid" and p.get("has_default"):
                continue
            value, ok = resolved_value_for(p.get("annotation"), cls)
            kwargs[p["name"]] = value
            resolved = resolved and ok
        out.append({"class": cls, "kwargs": kwargs, "annotations_resolved": resolved})
    return out


# =========================================================================
# Worker — runs INSIDE the subprocess, importing target code
# =========================================================================


def _summarize(value: Any, cap: int = 200) -> Any:
    """JSON-safe, bounded rendering of a return value."""
    try:
        if value is None or isinstance(value, bool | int | float):
            return value
        if isinstance(value, str):
            return value[:cap]
        if isinstance(value, list | tuple | set):
            return {"type": type(value).__name__, "len": len(value)}
        if isinstance(value, dict):
            return {"type": "dict", "len": len(value), "keys": sorted(map(str, value))[:12]}
        return {"type": type(value).__name__, "repr": repr(value)[:cap]}
    except Exception:
        return {"type": "unrenderable"}


def _worker_main(argv: list[str]) -> int:
    """Drive one module's targets in this process; emit JSONL rows on stdout."""
    ap = argparse.ArgumentParser(prog="exerciser-functions-worker")
    ap.add_argument("--plan", required=True, help="path to the per-module plan JSON")
    ap.add_argument("--repo", required=True)
    args = ap.parse_args(argv)

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    repo = Path(args.repo)
    for root in plan.get("src_roots", ["."]):
        p = str((repo / root).resolve())
        if p not in sys.path:
            sys.path.insert(0, p)

    module_name = plan["module"]
    repo_packages = plan.get("repo_packages") or []
    rows: list[dict[str, Any]] = []
    import_started = time.monotonic()
    try:
        mod = importlib.import_module(module_name)
    except BaseException as exc:  # target import can raise anything, incl. SystemExit
        rows.append(
            {
                "module": module_name,
                "target_id": module_name,
                "phase": "import",
                "status": "error",
                "error_type": type(exc).__name__,
                "error_module": getattr(type(exc), "__module__", "") or "",
                "error_mro": [c.__name__ for c in type(exc).__mro__],
                "repo_packages": plan.get("repo_packages") or [],
                "error": str(exc)[:400],
            }
        )
        _emit(rows)
        return 0

    for row in rows:  # the import-failure row, if any
        row.setdefault("repo_packages", repo_packages)

    # The call clock starts HERE, not at process start: whatever the import cost,
    # the calls get their full budget. Emitted as evidence so a slow import is
    # visible as a slow import rather than inferred from a missing row.
    import_s = time.monotonic() - import_started
    calls_started = time.monotonic()
    call_budget_s = float(plan.get("call_budget_s") or DEFAULT_CALL_BUDGET_S)
    _emit_one(
        {
            "module": module_name,
            "target_id": module_name,
            "phase": "import",
            "status": "ok",
            "duration_ms": round(import_s * 1000.0, 3),
            "repo_packages": repo_packages,
        }
    )

    for target in plan["targets"]:
        if time.monotonic() - calls_started > call_budget_s:
            # Stop cleanly and SAY SO. Being killed by the parent's outer
            # backstop instead would discard the remaining plan silently and
            # attribute the whole module to a hang.
            rows.append(
                _emit_one(
                    {
                        "module": module_name,
                        "target_id": f"{module_name}:{target['qualname']}",
                        "phase": "call",
                        "status": "skipped",
                        "error_type": "CallBudgetExhausted",
                        "error": (
                            f"module's {call_budget_s}s call budget spent before this "
                            "target; earlier targets in the same module consumed it"
                        ),
                    }
                )
            )
            continue
        qual = target["qualname"]
        try:
            fn = getattr(mod, qual, None)
        except Exception:
            fn = None
        if fn is None or not callable(fn):
            rows.append(
                _emit_one(
                    {
                        "module": module_name,
                        "target_id": f"{module_name}:{qual}",
                        "phase": "resolve",
                        "status": "skipped",
                        "error": "not a module-level callable",
                    }
                )
            )
            continue
        params = _param_records(fn)
        if params is None:
            rows.append(
                _emit_one(
                    {
                        "module": module_name,
                        "target_id": f"{module_name}:{qual}",
                        "phase": "signature",
                        "status": "skipped",
                        "error": "unannotated required parameter — refusing to guess",
                    }
                )
            )
            continue
        unresolvable = unresolvable_required(params)
        if unresolvable:
            # We could still send the string family and hope, but then the row
            # would have to claim the value conformed to a type we never built.
            rows.append(
                _emit_one(
                    {
                        "module": module_name,
                        "target_id": f"{module_name}:{qual}",
                        "phase": "signature",
                        "status": "skipped",
                        "error": (
                            f"unresolvable annotation on required parameter(s) "
                            f"{', '.join(unresolvable)} — refusing to guess"
                        ),
                    }
                )
            )
            continue
        for arg_set in arg_sets_for(params):
            row = _call_once(module_name, qual, fn, arg_set)
            row["repo_packages"] = repo_packages
            rows.append(_emit_one(row))
    return 0


def _call_once(module: str, qual: str, fn: Any, arg_set: dict[str, Any]) -> dict[str, Any]:
    """Call one target once, recording the outcome. Never raises."""
    started = time.monotonic()
    row: dict[str, Any] = {
        "module": module,
        "target_id": f"{module}:{qual}",
        "qualname": qual,
        "phase": "call",
        "input_class": arg_set["class"],
        # Whether every argument below was built from an annotation the harness
        # actually understood. Without this the row cannot honestly claim the
        # value CONFORMED to the declared type (see call_verdict).
        "annotations_resolved": bool(arg_set.get("annotations_resolved", False)),
        "kwargs": {k: _summarize(v) for k, v in arg_set["kwargs"].items()},
    }
    try:
        out = fn(**arg_set["kwargs"])
        if inspect.isawaitable(out):
            import asyncio

            out = asyncio.run(_await(out))
        row.update(status="ok", result=_summarize(out), result_type=type(out).__name__)
    except KeyboardInterrupt:
        # A USER signal, not target behaviour. Catching it here made the worker
        # ignore Ctrl-C and carry on calling targets, so the only way to stop a
        # run was to kill it — which then discarded the artifacts (see the
        # `finally` in the driver). SystemExit stays caught below: a target
        # calling `sys.exit()` IS something the target did, and is worth
        # recording rather than mistaking for the user asking us to stop.
        raise
    except BaseException as exc:  # a target may raise SystemExit
        row.update(
            status="error",
            error_type=type(exc).__name__,
            # WHERE the exception class is defined: an exception the target
            # package defines itself is a deliberate refusal signal, not a
            # crash. builtins/third-party origins are judged on type alone.
            error_module=getattr(type(exc), "__module__", "") or "",
            # The class hierarchy the target itself declared. Scoring by what
            # an exception INHERITS (Python's own taxonomy) is what lets the
            # policy transfer to a repo whose exception names are unknown.
            error_mro=[c.__name__ for c in type(exc).__mro__],
            # The kernel's own reason code, when there is one. Under an OS
            # sandbox this is how a refusal is told from a target's own failure:
            # EPERM on a write is the containment working, not a defect.
            error_errno=getattr(exc, "errno", None),
            error=str(exc)[:400],
            traceback_tail="".join(traceback.format_exception_only(type(exc), exc))[:400],
        )
    row["duration_ms"] = round((time.monotonic() - started) * 1000.0, 3)
    return row


async def _await(awaitable: Any) -> Any:
    return await awaitable


def _emit(rows: list[dict[str, Any]]) -> None:
    for r in rows:
        sys.stdout.write(json.dumps(r, default=str) + "\n")
    sys.stdout.flush()


def _emit_one(row: dict[str, Any]) -> dict[str, Any]:
    """Write ONE row immediately, and return it so callers can still collect it.

    Emission used to happen once, after the last target. A module with 50
    targets where #49 hung therefore lost all 48 completed results: the parent
    killed the worker on the deadline and only a synthetic ModuleTimeout row
    survived — the evidence was earned and then thrown away, and the same is
    true of a segfault or an OOM. stdout is already line-delimited JSON and the
    parent parses it line by line, so streaming costs nothing and every row that
    was paid for is kept.
    """
    sys.stdout.write(json.dumps(row, default=str) + "\n")
    sys.stdout.flush()
    return row


# =========================================================================
# Driver — the parent side
# =========================================================================


def _expected_for(input_class: str) -> str:
    if input_class == "negative":
        return "a typed rejection (TypeError/ValueError) or a handled result"
    return "a result, or a documented exception"


# Exception types a wrong-typed (negative-class) argument SHOULD produce: they
# are the function correctly refusing bad input, not a defect.
# The only NON-learned rule: a call the harness itself got wrong (it failed to
# supply a parameter) is a HARNESS defect, not a target one. This is about our
# own call construction, not about the target's exception vocabulary, so it is
# not something to learn per repo.
_MALFORMED_CALL_MARKERS = (
    "required positional argument",
    "required keyword-only argument",
    "unexpected keyword argument",
    "takes no arguments",
)


def is_control_flow_signal(mro: Sequence[Any]) -> bool:
    """A ``BaseException`` that is not an ``Exception`` — a process-level signal.

    Not a list of exception NAMES, which this module deliberately refuses to
    keep: it is the language's own structural distinction. ``SystemExit``,
    ``KeyboardInterrupt`` and ``GeneratorExit`` descend from ``BaseException``
    rather than ``Exception`` precisely so that ``except Exception`` does not
    catch them — they request that control leave, they do not claim something is
    wrong.

    This is the third non-learned rule, for the same reason as ``malformed-call``
    and ``contained``: the exception is not evidence about the target's
    correctness. ``smolagents.cli:parse_arguments`` is the case that forced it —
    an argparse entry point called with no argv raises ``SystemExit(2)`` because
    ``ArgumentParser.error`` is DOCUMENTED to exit 2, and the harness reported it
    as ``function-crash: SystemExit: 2``. Every CLI in every repo has such an
    entry point, so this was a false positive per CLI, on first contact, in the
    one file the extension surfaces.

    A library that calls ``sys.exit()` deep inside business logic is arguably a
    real defect, and this rule declines to report it. That is the precision
    doctrine working as intended: the two cases are indistinguishable from the
    outside, the harness supplied the arguments, and a finding that might be
    argparse behaving correctly is not one worth a developer's attention. The row
    is still recorded and still counted in the verdict tally — never dropped.
    """
    names = [str(n) for n in mro]
    return "Exception" not in names and "BaseException" in names


def call_verdict(
    row: dict[str, Any],
    policy: ExceptionPolicy | None = None,
    *,
    total_targets: int = 0,
    rng: random.Random | None = None,
) -> str:
    """Classify one call outcome, using the LEARNED exception policy.

    ``ok`` | ``rejected`` (the target refused our guessed value) |
    ``malformed-call`` (our own fault) | ``contained`` (the sandbox refused the
    effect, not the target refusing the input) | ``defect``.

    ``contained`` is the second NON-learned rule, and it exists for the same
    reason as ``malformed-call``: the exception was raised by OUR apparatus, so
    it is not evidence about the target. "This function opens a socket" is a
    behavioural fact, and it is already reported — as an effect ledger entry.
    Turning it into a crash report would manufacture one defect per contained
    target, which is exactly the false signal that makes a harness ignorable.

    There is deliberately no built-in list of exception names: which exceptions
    mean "no" is a property of the repository under test, and is learned from
    dispersion, input-class invariance and provenance (see
    ``exception_policy``). Without a policy the structural priors alone decide,
    which is still repo-agnostic.

    ``rng`` makes the verdict a THOMPSON DRAW rather than a threshold on the
    posterior mean, which is what keeps a suppressed signature reachable — see
    ``exception_policy``'s module docstring. ``run_functions`` passes one;
    calling this directly without one keeps the deterministic mean behaviour.
    """
    if row.get("status") != "error":
        return "ok"
    if row.get("contained"):
        return "contained"
    etype = str(row.get("error_type", ""))
    message = str(row.get("error", ""))
    if etype == "TypeError" and any(m in message for m in _MALFORMED_CALL_MARKERS):
        return "malformed-call"
    if is_control_flow_signal(row.get("error_mro") or [etype]):
        return "control-flow"
    policy = policy or ExceptionPolicy()
    prov = provenance_of(
        str(row.get("error_module", "")), {str(n) for n in (row.get("repo_packages") or [])}
    )
    fam = family_of(row.get("error_mro") or [etype])
    key = signature(etype, prov)
    # valid/boundary values conform to the declared annotation (0 IS an int);
    # negative values deliberately violate it. But "valid" only means conformant
    # when the annotation was RESOLVED: for `cfg: Config` the harness has no
    # Config to send, so the string it sends conforms to nothing and the target
    # is entitled to reject it. Absent flag ⇒ not known to be resolved ⇒ False.
    conformant = str(row.get("input_class", "")) in ("valid", "boundary") and bool(
        row.get("annotations_resolved", False)
    )
    return (
        "defect"
        if policy.is_defect(
            key,
            provenance=prov,
            total_targets=total_targets,
            family=fam,
            conformant=conformant,
            rng=rng,
        )
        else "rejected"
    )


def classify_row(
    row: dict[str, Any],
    policy: ExceptionPolicy | None = None,
    *,
    total_targets: int = 0,
    rng: random.Random | None = None,
) -> str | None:
    """Failure kind for one row, or None when it is not a reportable defect.

    The harness GUESSES inputs, so it cannot tell "the function is broken" from
    "the function refused my made-up value" by looking at one call. The learned
    policy makes that call from evidence across the whole run, and everything
    it declines is still COUNTED in the verdict tally — never silently dropped.
    """
    if row.get("contained"):
        # The sandbox refused an effect. Nothing about the target's own
        # correctness follows from that, at import or at call time.
        return None
    if row.get("phase") == "import" and row.get("status") == "error":
        # Import supplies NO input, so nothing the harness did can explain the
        # failure. Two structural exemptions, and everything else is the
        # module's own doing: a dependency this machine lacks (the ImportError
        # family, which ModuleNotFoundError inherits), and an exception the
        # REPO defines — a package stating its own precondition ("you must
        # provide an api_key") rather than breaking.
        mro = list(row.get("error_mro") or [str(row.get("error_type", ""))])
        prov = provenance_of(
            str(row.get("error_module", "")),
            {str(n) for n in (row.get("repo_packages") or [])},
        )
        # Membership in the MRO, not the most-specific family: ModuleNotFoundError
        # IS an ImportError, and both mean "this machine lacks a dependency".
        #
        # A control-flow signal is deliberately NOT exempt here, unlike at call
        # time (`is_control_flow_signal`). A module whose BODY calls `sys.exit()`
        # takes the importing process down with it, which is a real defect in a
        # library however ordinary it is in a script — see
        # `test_a_module_that_exits_on_import_is_reported_not_fatal`.
        if "ImportError" in mro or prov == "repo":
            return None
        return "import-error"
    if row.get("phase") != "call":
        return None
    return (
        "function-crash"
        if call_verdict(row, policy, total_targets=total_targets, rng=rng) == "defect"
        else None
    )


def learn_exception_policy(
    rows: list[dict[str, Any]], policy: ExceptionPolicy, total_targets: int
) -> ExceptionPolicy:
    """Feed a run's outcomes into the policy BEFORE any of them are judged.

    Order matters: dispersion and class-invariance are properties of the whole
    run, so every sighting must be recorded before the first verdict is taken.
    Sightings carry no defect label and move no posterior mass at all — they are
    COVARIATES, and they reach a verdict only through the structural prior.
    Labels come from adjudications and downstream feedback
    (``record_feedback``), and from the differential oracle's agreement rows.
    """
    for row in rows:
        if row.get("status") != "error":
            continue
        if row.get("contained"):
            # The sandbox's own refusal is evidence about our apparatus, not
            # about this repo's exception vocabulary. Feeding it in would let a
            # containment artefact shape every later verdict.
            continue
        prov = provenance_of(
            str(row.get("error_module", "")),
            {str(n) for n in (row.get("repo_packages") or [])},
        )
        policy.observe(
            signature(str(row.get("error_type", "")), prov),
            target=str(row.get("target_id", "")),
            input_class=str(row.get("input_class", "import")),
        )
    return policy


def _policy_report(policy: ExceptionPolicy, total_targets: int) -> dict[str, Any]:
    """Per-signature decision probabilities, for the run summary.

    Deliberately the DETERMINISTIC view (posterior mean, no draw): a summary a
    human reads must not change because a draw went the other way. Which
    signatures the draw actually surfaced is reported separately, as
    ``surfaced_by_exploration``.
    """
    out: dict[str, Any] = {}
    for key, ev in sorted(policy.evidence.items()):
        _, provenance = key.rsplit("@", 1) if "@" in key else (key, "unknown")
        probability, confident = policy.defect_probability(
            key, provenance=provenance, total_targets=total_targets, family=key.split("@")[0]
        )
        out[key] = {
            "defect_probability": round(probability, 4),
            # True only when LABELS have accumulated. Unlabelled structure —
            # however much of it there is — leaves this False, so a reader can
            # tell "we have never checked" from "we checked, it is a refusal".
            "confident": confident,
            "label_mass": round(policy.label_mass(key), 4),
            "targets": len(ev.targets),
            "occurrences": ev.occurrences,
        }
    return out


def cluster_function_failures(
    rows: list[dict[str, Any]],
    policy: ExceptionPolicy | None = None,
    *,
    total_targets: int = 0,
    rng: random.Random | None = None,
) -> list[FailureCluster]:
    """Cluster failing function calls the same way HTTP failures cluster.

    A sandboxed row travels the SAME verdict path as any other, but its exemplar
    strategy says ``function-sandboxed/…`` so a reader can tell a defect found by
    calling a pure function from one found by calling a contained impure one —
    the second was reached only because containment made it callable, and its
    behaviour under redirected ``HOME``/``TMPDIR`` and a blocked network is not
    the same evidence as the first.
    """

    def _channel(row: dict[str, Any]) -> str:
        return "function-sandboxed" if row.get("sandboxed") else "function"

    return build_clusters(
        rows,
        verdict=lambda r: classify_row(r, policy, total_targets=total_targets, rng=rng),
        describe=lambda r, _k: f"{r.get('error_type', 'error')}: {r.get('error', '')}",
        target_of=lambda r: str(r.get("target_id", "?")),
        method="CALL",
        strategy=lambda r, _k: f"{_channel(r)}/{r.get('input_class', 'import')}",
        expected=lambda r, _k: _expected_for(r.get("input_class", "")),
        exemplar_extra=lambda r: {
            "input": r.get("kwargs"),
            "effects": r.get("effects"),
            "error": r.get("error"),
        },
    )


#: Share of the modules that ATTEMPTED an import which must fail with one
#: identical exception before it is read as a shared precondition rather than as
#: a defect per module. Paired with an absolute floor, because "both of my two
#: modules raised the same thing" is not dispersion, it is a small repo.
_SHARED_PRECONDITION_SHARE = 0.5
_SHARED_PRECONDITION_MIN_MODULES = 3


def shared_import_preconditions(
    rows: list[dict[str, Any]],
    clusters: list[FailureCluster],
) -> tuple[list[FailureCluster], list[dict[str, Any]]]:
    """Split import failures that are ONE unmet precondition off from defects.

    ``classify_row`` already exempts the two import failures that say nothing
    about the code: a dependency this machine lacks (the ``ImportError`` family)
    and an exception the repo defines about itself. A third shape reaches a
    verdict and should not, and it became common the moment workers started
    running under the target's own interpreter: a service that reads REQUIRED
    configuration at import time. Every module that transitively imports the
    settings object raises the same third-party validation error — on
    demo-fastapi, ``pydantic_core.ValidationError`` from 14 of the 14 modules
    that attempted an import — and each one was reported as its own defect. That
    is fifteen fabricated findings on a repo whose only problem is an unset
    environment variable.

    Provenance cannot separate these: the exception belongs to pydantic, not to
    the repo, so the "package stating its own precondition" exemption misses it.
    DISPERSION can, and it is a fact about the run rather than a vocabulary.

    What dispersion establishes is that the group has ONE cause — not that the
    cause is benign. A broken shared ``__init__`` takes out every module that
    imports it and is a real defect, so collapsing the group to zero clusters
    would trade fifteen fabricated findings for one missed one. The group is
    therefore collapsed to a single REPRESENTATIVE cluster: the count stops being
    per-module, the finding stays on ``clusters`` — which is what reaches
    ``issues.json``, the dispatch path, and the extension — and the rest of the
    group is summarised under ``import_preconditions``.

    Returns ``(clusters_to_report, preconditions)``. Nothing is discarded.
    """
    imports = [r for r in rows if r.get("phase") == "import" and r.get("status") == "error"]
    attempted = {str(r.get("module", "")) for r in rows if r.get("phase") == "import"}
    if len(attempted) < _SHARED_PRECONDITION_MIN_MODULES:
        return clusters, []

    by_signature: dict[tuple[str, str], set[str]] = {}
    for row in imports:
        key = (str(row.get("error_type", "")), str(row.get("error_module", "")))
        by_signature.setdefault(key, set()).add(str(row.get("module", "")))

    blocked: dict[str, tuple[str, str]] = {}
    findings: list[dict[str, Any]] = []
    for (error_type, error_module), modules in sorted(by_signature.items()):
        share = len(modules) / len(attempted)
        if len(modules) < _SHARED_PRECONDITION_MIN_MODULES or share < _SHARED_PRECONDITION_SHARE:
            continue
        for module in modules:
            blocked[module] = (error_type, error_module)
        exemplar = next(
            (r for r in imports if str(r.get("module", "")) in modules),
            {},
        )
        findings.append(
            {
                "error_type": error_type,
                "error_module": error_module,
                "modules_blocked": len(modules),
                "modules_attempted": len(attempted),
                # A settings object that fails validation renders its whole
                # input dict — API keys included — into the message, and this
                # field is persisted and printed.
                "detail": redact_text(str(exemplar.get("error", "")))[:400],
                "modules": sorted(modules)[:50],
            }
        )

    if not blocked:
        return clusters, []

    kept: list[FailureCluster] = []
    withheld_by_signature: dict[tuple[str, str], int] = {}
    represented: dict[tuple[str, str], str] = {}
    for cluster in clusters:
        doc = cluster.to_json()
        endpoint = str(doc.get("endpoint_id") or "")
        signature = blocked.get(endpoint)
        if doc.get("kind") != "import-error" or signature is None:
            kept.append(cluster)
            continue
        if signature not in represented:
            # The first is the group's representative and stays reportable. The
            # rest are the same cause counted again.
            represented[signature] = endpoint
            kept.append(cluster)
            continue
        withheld_by_signature[signature] = withheld_by_signature.get(signature, 0) + 1
    for finding in findings:
        key = (finding["error_type"], finding["error_module"])
        finding["clusters_withheld"] = withheld_by_signature.get(key, 0)
        finding["reported_as"] = represented.get(key)
    return kept, findings


#: Share of attempted modules that must fail to import a repo-owned package
#: before the run is called an environment failure rather than a clean result.
_ENVIRONMENT_FAILURE_SHARE = 0.5

#: The two shapes an unimportable package takes. A package that is absent
#: entirely raises the first; one that is present but STALE — an older release
#: installed over the checkout, so a name the source expects is not there yet —
#: raises the second. Both mean the interpreter is not carrying this repo's
#: code, which is the only question this canary asks.
_UNIMPORTABLE_RES = (
    re.compile(r"No module named ['\"]([\w.]+)['\"]"),
    re.compile(r"cannot import name .+ from (?:partially initialized module )?['\"]([\w.]+)['\"]"),
)


def _unimportable_package(message: str) -> str | None:
    """The top-level package an import-phase error says could not be loaded."""
    for pattern in _UNIMPORTABLE_RES:
        found = pattern.search(message)
        if found:
            return found.group(1).partition(".")[0]
    return None


def import_canary(rows: list[dict[str, Any]], modules_attempted: int) -> dict[str, Any]:
    """Whether the interpreter driving the targets can import the target's code.

    The function channel imports the repo under test. When the chosen
    interpreter has not installed it, EVERY import raises and the run finds
    nothing — and "found nothing" is exactly what a clean repo looks like. That
    ambiguity is the failure mode this exists to remove: a run that could not
    load the code must never be reported as a run that found no defects.

    A missing module is only evidence about the ENVIRONMENT when the repo owns
    it; a target that fails to import ``qdrant_client`` is telling us about an
    optional extra, and the run is still meaningful for everything else. That
    ownership test reads ``repo_packages``, which is only correct once
    ``detect_src_roots`` has resolved each distribution to its real import name
    — the two are load-bearing for each other.
    """
    missing: dict[str, int] = {}
    failed_modules: set[str] = set()
    for row in rows:
        if row.get("phase") != "import" or row.get("status") != "error":
            continue
        top = _unimportable_package(str(row.get("error", "")))
        if top is None:
            continue
        if top not in {str(n) for n in (row.get("repo_packages") or [])}:
            continue
        missing[top] = missing.get(top, 0) + 1
        failed_modules.add(str(row.get("module", "")))
    share = len(failed_modules) / modules_attempted if modules_attempted else 0.0
    return {
        "own_packages_unimportable": sorted(missing),
        "modules_failed": len(failed_modules),
        "modules_attempted": modules_attempted,
        "blocking": share >= _ENVIRONMENT_FAILURE_SHARE and bool(missing),
    }


def run_functions(
    repo: Path,
    *,
    service: str | None = None,
    max_targets: int = 200,
    module_timeout_s: float = DEFAULT_MODULE_TIMEOUT_S,
    call_budget_s: float = DEFAULT_CALL_BUDGET_S,
    python: str | None = None,
    only_targets: list[str] | None = None,
    seed: int | None = None,
    explore: bool = True,
    sandbox: bool | None = None,
    sandbox_policy: SandboxPolicy | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Drive every discovered function target in isolated workers. Persists all
    artifacts and returns a summary.

    Each module gets one worker with a wall-clock deadline; a hang or hard exit
    costs that module's rows and is reported as a ``module-timeout`` — never a
    silent gap, and never the run.

    ``seed`` fixes the exception policy's Thompson draws, making a run
    reproducible. Left unset the draws are entropy-seeded, which is what makes
    the exploration span RUNS: a thinly-labelled signature suppressed today is
    drawn high on some later run, reported, and finally adjudicated. The draw
    can only ever ADD a finding, so a genuine crash is reported either way.

    ``explore=False`` turns the draw off entirely (verdicts revert to the
    deterministic posterior-mean threshold). The CLI and the campaign leave it
    ON — they are the paths whose findings get adjudicated, so they are the
    paths that must not censor their own feedback. Callers that need
    byte-identical output for identical inputs (regression fixtures, tests
    pinning an exact cluster set) turn it off.

    ROUTING. Coverage and safety are not in tension here, and the flag that used
    to make them so is gone. A target goes exactly one of three ways:

    * **verified pure** → in-process, the fast path, unchanged;
    * **unverifiable or impure** (decorated, receiver-tainted, an unresolved
      chain, an impure body) → automatically routed to containment, no flag
      required, because containment is simply WHERE unverifiable code runs;
    * **destructive name / test scaffolding** → refused outright, never
      sandboxed. Containment changes what a call costs, not whether calling
      ``drop_database`` was ever a sensible thing to do.

    ``sandbox`` defaults to ``None``, which means "route the unverifiable
    through containment when we can". It is now an opt-OUT (``False``: the impure
    set stays refused, and the run says so) rather than the switch that unlocks
    coverage — making SAFETY opt-in was backwards, and it cost a real repo four
    fifths of its drivable surface. ``True`` is accepted and means the same as
    the default; ``sandbox_policy`` still wins outright, so a caller that wants a
    particular tier, copy cap or ``require_tier`` passes one.

    If containment cannot be established the pass reports ``unavailable``, every
    candidate stays refused with the reason recorded on its ``skipped`` entry,
    and a diagnostic is raised. There is no path in which a refused target runs
    unsandboxed.
    """
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()
    targets, skipped, refusals = discover_with_refusals(repo, max_targets=max_targets, logger=log)
    # `sandbox is None` is the DEFAULT and means "contain them if we can", so the
    # only way to end up with no second pass is an explicit opt-out or a policy
    # that disables itself.
    #
    # The default does NOT demand an OS wall, deliberately.
    #
    # A pre-production audit read the default-on containment as a safety
    # regression: the targets this pass recovers are the ones the purity guard
    # refused, and the process shim is "structurally blind to a C extension
    # calling open(2)/connect(2)" — `sqlite3.connect()` really escapes it. That
    # much is true. But requiring `os-sandbox` here was the wrong remedy, for
    # two reasons:
    #
    #   * the shim is a REAL boundary for the common case (a disposable tree,
    #     redirected HOME/TMPDIR, and patched open/os/socket/subprocess), and
    #     where it is blind it says so — the row carries `effects_complete:
    #     False` and the run raises an `unobservable` diagnostic naming the
    #     C-extension roots. An honestly-reported partial wall is not the same
    #     failure as a silent one;
    #   * `_candidates()` yields nothing off linux/darwin, AND a stock Linux CI
    #     runner has no `bwrap` and cannot `unshare` (`/proc/self/uid_map:
    #     Operation not permitted`). So requiring the tier does not "restore
    #     safety on Windows" — it disables the recovery pass nearly everywhere,
    #     which is a much larger behaviour change than the concern warranted.
    #
    # A caller who does want the hard guarantee asks for it explicitly with
    # `SandboxPolicy(require_tier=...)`, and then a host without a real wall
    # refuses loudly rather than downgrading. That is the knob's purpose.
    sbx = sandbox_policy or (None if sandbox is False else SandboxPolicy(enabled=True))
    opted_out = sbx is None or not sbx.enabled
    if opted_out:
        sbx = None
    if only_targets is not None:
        # Per-target selection: the campaign bandit allocates budget to ONE
        # action, so it must be able to drive one function rather than sweeping
        # the repo. Filtering here (not in discovery) keeps the skip reasons
        # and the discovery cost shared across plays.
        wanted = set(only_targets)
        targets = [t for t in targets if t.id in wanted]
        refusals = [r for r in refusals if r.id in wanted]

    diagnostics: list[str] = []

    # WHICH interpreter, before any worker is spawned. `python or sys.executable`
    # meant Vinv's own venv on every repo that was not installed into it, so the
    # workers imported nothing and the run reported a clean zero. An explicit
    # `--python` still wins; without one this picks the interpreter that has the
    # code under test installed, and says so.
    choice = resolve_cached(repo, explicit=python, logger=log)
    python = choice.python
    diagnostics.extend(choice.diagnostics)

    if opted_out and refusals:
        # LOUD, not silent. The impure set is where the interesting functions
        # live; a run that leaves it undriven has to say so on the summary as
        # well as on every individual skip entry.
        held = {r.id for r in refusals}
        for entry in skipped:
            if entry["id"] in held:
                entry["sandbox"] = "containment disabled by the caller — target stays refused"
        diagnostics.append(
            f"containment disabled by the caller — {len(refusals)} unverifiable/impure "
            "target(s) stay refused and were never driven"
        )
        log.warning("functions_sandbox_opted_out %d targets stay refused", len(refusals))
        refusals = []

    if not targets and not refusals:
        diagnostics.append(
            "0 function targets discovered — nothing to drive in-process. "
            "Either the code index is missing (run `index index`) or every "
            "candidate was skipped; see `skipped` for reasons."
        )
        log.warning("functions_empty %s", diagnostics[0])

    by_module: dict[str, list[FunctionTarget]] = {}
    for t in targets:
        by_module.setdefault(t.module, []).append(t)
    # Every top-level package this repo owns — an exception defined in any of
    # them is the repo's own deliberate signal, whichever module raised it. The
    # sandbox's targets are the repo's too, so their packages count: provenance
    # must not flip just because a call happened under containment.
    repo_packages = sorted(
        {t.module.partition(".")[0] for t in targets}
        | {r.target.module.partition(".")[0] for r in refusals}
    )

    src_roots = detect_src_roots(repo)
    tmp_dir = store.exercise_dir(repo) / "functions"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    timeouts: list[str] = []
    # Modules that only imported once the working directory moved. Recorded so a
    # run says WHERE it decided to run each module from, and why.
    workdir_resolutions: list[dict[str, Any]] = []

    for module, mod_targets in sorted(by_module.items()):
        plan_file = tmp_dir / f"{module.replace('.', '_')}.plan.json"
        store.write_json(
            plan_file,
            {
                "module": module,
                "src_roots": src_roots,
                "repo_packages": repo_packages,
                "call_budget_s": call_budget_s,
                "targets": [t.to_json() for t in mod_targets],
            },
        )
        cmd = [
            python or sys.executable,
            "-m",
            "exerciser.functions",
            "--worker",
            "--plan",
            str(plan_file),
            "--repo",
            str(repo),
        ]
        # WHERE to run this module from is decided by trying, not by reading.
        # A repo's relative paths resolve against the working directory, so the
        # choice changes what the code under test reads — and no list of build
        # systems to parse ever covers them all. `candidate_workdirs` orders a
        # short list using whatever the repo happens to declare, and the loop
        # below lets the IMPORT settle it.
        workdir_candidates = candidate_workdirs(repo, mod_targets[0].file)
        env = dict(os.environ)
        # The worker imports TARGET code; keep our own package importable too.
        env["PYTHONPATH"] = os.pathsep.join(
            [p for p in (env.get("PYTHONPATH"), *(str(Path(__file__).parents[1]),)) if p]
        )
        # Force UTF-8 on the CHILD's stdio to match the parent's decoding above.
        # The locale encoding is cp1252 on Windows across the whole supported
        # range (<3.15, so PEP 686's default never applies): without this a
        # target printing an emoji or any CJK text raised UnicodeEncodeError in
        # the worker and cost that module all of its rows.
        env["PYTHONIOENCODING"] = "utf-8"

        # Try each candidate directory until the module actually imports. The
        # cost is paid ONLY on failure: a module that imports from the first
        # candidate — every module in a healthy repo — runs exactly one worker,
        # as before. A module that cannot import anywhere ends on the last
        # candidate's rows, which is the repo root, which is what it used to do.
        proc = None
        attempts: list[dict[str, Any]] = []
        try:
            for attempt, module_cwd in enumerate(workdir_candidates):
                proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
                    cmd,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    # OUTER backstop only: import allowance plus the call budget
                    # the worker enforces itself, plus slack for interpreter
                    # startup. The worker stops on its own budget and reports
                    # why; reaching this deadline means it could not even do
                    # that — wedged in import, or in a call that ignores the
                    # clock (a C-level spin, a SIGKILL-only hang). Setting it AT
                    # the call budget is what made every slow import look like a
                    # hung call.
                    timeout=module_timeout_s + call_budget_s + 5.0,
                    cwd=str(module_cwd),
                    env=env,
                )
                blocked = _import_blocked(proc.stdout or "")
                attempts.append(
                    {
                        "cwd": _repo_relative(repo, module_cwd),
                        "import_blocked": blocked,
                    }
                )
                if not blocked or attempt == len(workdir_candidates) - 1:
                    if blocked and len(workdir_candidates) > 1:
                        # Every directory was tried and none of them imported, so
                        # this is not a directory problem. Said out loud rather
                        # than left as an unexplained failure.
                        log.info(
                            "functions: %s failed to import from all %d candidate "
                            "directories — not a working-directory problem",
                            module,
                            len(workdir_candidates),
                        )
                    elif attempt > 0:
                        workdir_resolutions.append(
                            {
                                "module": module,
                                "chosen": _repo_relative(repo, module_cwd),
                                "attempts": attempts,
                            }
                        )
                        log.info(
                            "functions: %s imports from %s, not from %s",
                            module,
                            attempts[-1]["cwd"],
                            attempts[0]["cwd"],
                        )
                    break
        except subprocess.TimeoutExpired:
            timeouts.append(module)
            # PARENT side — collected, never written to stdout (stdout here is
            # the CLI's own result channel, not the worker protocol).
            rows.append(
                {
                    "module": module,
                    "target_id": module,
                    "phase": "module",
                    "status": "error",
                    "error_type": "ModuleTimeout",
                    "error": (
                        f"module exceeded {module_timeout_s}s — a call hung "
                        "(candidate deadlock/infinite loop)"
                    ),
                }
            )
            continue
        module_rows = 0
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
                module_rows += 1
            except ValueError:
                continue
        # `not rows` tested the GLOBAL accumulator, so once ANY module produced
        # a row this could never fire again — and it was log.debug regardless,
        # while proc.stderr was captured and then never read anywhere. A worker
        # that segfaulted, OOMed or died on import therefore left no trace at
        # all: its module simply contributed nothing, indistinguishable from a
        # module with no targets.
        if proc.returncode != 0 and module_rows == 0:
            tail = (proc.stderr or "").strip().splitlines()[-8:]
            log.warning(
                "functions: worker for %s exited %s with no rows%s",
                module,
                proc.returncode,
                (" — stderr: " + " | ".join(tail)) if tail else " and no stderr",
            )
            rows.append(
                {
                    "module": module,
                    "target_id": module,
                    "phase": "module",
                    "status": "error",
                    "error_type": "WorkerDied",
                    "error": (
                        f"worker exited {proc.returncode} without producing rows: "
                        + (" | ".join(tail) if tail else "no stderr captured")
                    ),
                }
            )

    # --- second pass: the refused, under containment -----------------------
    #
    # Deliberately AFTER the ordinary pass, so a sandbox that cannot be
    # established costs nothing that already worked. `run_sandboxed_targets`
    # either returns contained rows or reports `unavailable`; there is no third
    # outcome, and no branch that runs a refused target loose.
    sandbox_report: dict[str, Any] = {"enabled": False}
    if sbx is not None:
        outcome = run_sandboxed_targets(
            repo,
            refusals,
            policy=sbx,
            src_roots=src_roots,
            repo_packages=repo_packages,
            module_timeout_s=module_timeout_s,
            python=python,
            logger=log,
        )
        rows.extend(outcome["rows"])
        sandbox_report = outcome["report"]
        driven = {r.id for r in refusals}
        if outcome["status"] == "unavailable":
            reason = str(sandbox_report.get("reason") or "isolation could not be established")
            for entry in skipped:
                if entry["id"] in driven:
                    entry["sandbox"] = f"unavailable: {reason}"
            diagnostics.append(
                f"execution sandbox unavailable — {len(refusals)} impurity-refused "
                f"target(s) stay refused (never run unsandboxed): {reason}"
            )
            log.warning("functions_sandbox_unavailable %s", reason)
        else:
            tier = str(sandbox_report.get("tier") or "unknown")
            for entry in skipped:
                if entry["id"] in driven:
                    entry["sandbox"] = f"driven-under-containment ({tier})"
            blind = sandbox_report.get("unobservable") or []
            if blind:
                # Never let an empty effect ledger read as "no effect": the shim
                # patches Python entry points, and these targets do their I/O
                # from C. Said once at the top level so it is not only visible to
                # a reader who opens the per-row detail.
                classes = sorted({c for entry in blind for c in entry["classes"]})
                diagnostics.append(
                    f"sandbox effect ledger INCOMPLETE for {len(blind)} contained target(s) "
                    f"({', '.join(classes)}) — their recorded effects are a LOWER BOUND, "
                    "not a claim that nothing happened"
                )
                log.warning("functions_sandbox_unobservable %s", classes)
    total_targets = len(targets) + len(refusals)

    # ONE chokepoint, upstream of every consumer. A target's exception message is
    # quoted into `function_results.jsonl`, into a cluster's title, into its
    # exemplar, into `issues.json` and onto stdout — and a settings object that
    # fails validation renders its whole input dict, API keys included, into that
    # message. Redacting at one report field left the credential in all the other
    # copies; redacting the rows before anything reads them covers the lot, and
    # the placeholder is a constant so cluster signatures stay stable.
    for row in rows:
        message = row.get("error")
        if isinstance(message, str) and message:
            row["error"] = redact_text(message)

    # Ctrl-C must not destroy the evidence. Every row below this point was
    # already paid for — a subprocess was spawned, a target was called, an
    # effect may have been left behind — and until this write happened, the
    # only way to stop a long run also threw all of it away. `store.write_jsonl`
    # is atomic (tmp + os.replace), so a partial write cannot corrupt the file.
    try:
        store.write_jsonl(store.exercise_dir(repo) / "function_results.jsonl", rows)
    except OSError as exc:  # a failed checkpoint must not fail the run
        log.warning("functions: could not checkpoint rows: %s", exc)

    # Learn from the WHOLE run before judging any of it: dispersion and
    # class-invariance are run-level properties, so a first-pass over every
    # sighting has to happen before the first verdict.
    #
    # `decay` is applied ONLY when this is a whole-repo sweep. `ExceptionPolicy.
    # load` ages accumulated evidence toward the uninformative prior on every
    # load, which is right once per harness invocation — but the campaign calls
    # `run_functions(only_targets=[one])` once PER PLAY, so the decay clock
    # started ticking on play count instead. Measured: a seeded alpha-1 of 20
    # reaches 0.625 by play 5, 0.0196 by play 10, and 0.0 by play 20
    # (0.5**20 = 9.5e-7). Because the decayed state is then SAVED, each campaign
    # strip-mined the evidence future runs depend on — and human adjudication
    # feedback, the scarcest input this policy has, was destroyed by ~20
    # automated plays.
    policy = ExceptionPolicy.load(repo, decay=1.0 if only_targets is not None else DECAY)
    learn_exception_policy(rows, policy, total_targets)
    policy.save(repo, logger=log)

    # One rng for the whole run: the policy memoises its draw per signature, so
    # clustering and the verdict tally below cannot disagree about a row.
    rng = random.Random(seed) if explore else None
    clusters = cluster_function_failures(rows, policy, total_targets=total_targets, rng=rng)
    # One unmet precondition is one finding, not one per module it blocked.
    clusters, preconditions = shared_import_preconditions(rows, clusters)
    for precondition in preconditions:
        diagnostics.append(
            f"{precondition['modules_blocked']}/{precondition['modules_attempted']} module(s) "
            f"failed to import with the SAME {precondition['error_type']} from "
            f"{precondition['error_module']} — one cause, so it is reported once (as "
            f"{precondition['reported_as']}) and {precondition['clusters_withheld']} duplicate "
            f"cluster(s) were folded into it: {precondition['detail'][:200]}"
        )
        log.warning("functions_shared_precondition %s", diagnostics[-1])
    store.write_jsonl(store.exercise_dir(repo) / "function_results.jsonl", rows)

    called = sum(1 for r in rows if r.get("phase") == "call")
    verdicts: dict[str, int] = {}
    sandbox_verdicts: dict[str, int] = {}
    for r in rows:
        if r.get("phase") == "call":
            # The SAME verdict path for both channels — a sandboxed call is not
            # judged by a softer rule — with a separate tally so a reader can see
            # what containment bought.
            v = call_verdict(r, policy, total_targets=total_targets, rng=rng)
            verdicts[v] = verdicts.get(v, 0) + 1
            if r.get("sandboxed"):
                sandbox_verdicts[v] = sandbox_verdicts.get(v, 0) + 1
    if sandbox_report.get("enabled"):
        sandbox_report["verdicts"] = dict(sorted(sandbox_verdicts.items()))

    canary = import_canary(rows, len(by_module))
    if canary["own_packages_unimportable"]:
        names = ", ".join(canary["own_packages_unimportable"])
        # Discovery already ran, so the advice has to depend on what it found:
        # telling a human to "point --python at the repo's venv" when resolution
        # searched the tree and found no better interpreter sends them looking
        # for a venv that does not exist.
        remedy = (
            "Install the target into that interpreter, or pass --python explicitly."
            if choice.handed_off
            else (
                f"No interpreter with {names} installed was found among "
                f"{len(choice.considered)} candidate(s) — create the target's venv and "
                "install it, or pass --python explicitly."
            )
        )
        detail = (
            f"{canary['modules_failed']}/{canary['modules_attempted']} module(s) could not be "
            f"imported by {python}: the repo's own package(s) {names} are not "
            f"installed for it. {remedy}"
        )
        diagnostics.append(detail)
        log.warning("functions_import_canary %s", detail)

    result: dict[str, Any] = {
        # A run that could not import the code under test found nothing BECAUSE
        # it never ran it, which is not the same claim as a clean repo.
        "status": "environment" if canary["blocking"] else "ok",
        "import_canary": canary,
        # Which interpreter drove the workers, and the evidence for it. Without
        # this a run is unreproducible: the single most important input to the
        # result was chosen and never written down.
        "interpreter": choice.to_json(),
        # Import failures that were ONE unmet precondition across many modules.
        # Withheld from `clusters` because they are not per-module defects, and
        # stated here because they are not nothing either.
        "import_preconditions": preconditions,
        # Where each module was actually run from, for the ones the first guess
        # got wrong. Empty on a repo whose layout the first candidate matched.
        "workdir_resolutions": workdir_resolutions,
        "diagnostics": diagnostics,
        "repo": str(repo),
        "service": service,
        "targets": len(targets),
        "modules": len(by_module),
        "calls": called,
        "errors": sum(1 for r in rows if r.get("status") == "error"),
        # Honest accounting of every call outcome. `rejected`, `environment` and
        # `contained` are NOT defects — the harness guesses inputs, so a refusal
        # is usually the function working, and a `contained` outcome is the
        # sandbox working — but they are counted, never hidden.
        "verdicts": dict(sorted(verdicts.items())),
        # What the LEARNED policy currently believes — the DECISION probability
        # (structural priors blended with accumulated evidence), not the raw
        # posterior, so a run is auditable rather than an oracle handing down
        # opinions.
        "exception_policy": _policy_report(policy, total_targets),
        # Signatures whose posterior MEAN was below the reporting threshold but
        # whose Thompson draw was above it — surfaced to be adjudicated rather
        # than left suppressed forever on evidence nobody ever labelled. Stated
        # explicitly so a reader can see why a "known refusal" reappeared.
        "surfaced_by_exploration": sorted(policy.exploration_surfaced),
        "module_timeouts": timeouts,
        "skipped": skipped[:100],
        "skipped_count": len(skipped),
        # The execution sandbox: what it copied and what that cost, what the
        # contained targets ATTEMPTED (files, sockets, subprocesses), and — when
        # isolation could not be established — every target that therefore
        # stayed refused. Never a silent degradation.
        "sandbox": sandbox_report,
        "issue_clusters": len(clusters),
        "clusters": [c.to_json() for c in clusters],
        "results_file": str(store.exercise_dir(repo) / "function_results.jsonl"),
    }
    store.write_json(store.exercise_dir(repo) / "functions.json", result)
    log.info(
        "functions: %d targets (+%d sandboxed) in %d modules, %d calls, %d clusters, %d timeouts",
        len(targets),
        len(refusals),
        len(by_module),
        called,
        len(clusters),
        len(timeouts),
    )
    return result


def main(argv: list[str] | None = None) -> int:
    """``python -m exerciser.functions --worker …`` dispatch (worker only)."""
    return worker_entrypoint(
        argv, _worker_main, "exerciser.functions: use `exerciser functions <repo>`"
    )


if __name__ == "__main__":
    raise SystemExit(main())
