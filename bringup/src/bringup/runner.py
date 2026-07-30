"""Vinv Stage 2 — bring-up runbook rendering over the discovery handbook.

Renders the full Stage 2 bring-up task prompts from a repository's
``<repo>/.vinv/vinv.md`` handbook: enumerate the Python services (Stage 2a)
and bring ONE selected service up under ``tracelens run`` so traces land under
``~/.tracelens/baselines/<session>/<service>/trace.jsonl`` for downstream RCA.

Harness-only: this module makes ZERO LLM calls. The CLI prints the rendered
runbook and the user's coding-agent harness executes it. The deterministic
halves — distribution/package discovery, service-inventory validation, the
replay verification gate, and operator start-hint plumbing — run in-process.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import queue
import re
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import tomllib
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Bring-up task templates ship as plaintext package data (``bringup/prompts/``)
# and are injected via str.format() at prompt-render time.
_PROMPTS_DIR = Path(__file__).with_name("prompts")


def _prompt(name: str) -> str:
    return (_PROMPTS_DIR / f"{name}.txt").read_text(encoding="utf-8")

HANDBOOK_REL = Path(".vinv") / "vinv.md"

# Stage 2a (list) writes the service inventory here; Stage 2b (start) reads it
# back so the caller can pick a service + module(s) to bring up.
SERVICES_REL = Path(".vinv") / "services.json"

# Stage 2b (start) writes the VERIFIED start command(s) for the service it
# brought up here — one file per service so repeated `start` invocations for
# different services don't clobber each other. The CLI reads this back and
# returns it as the command's final response.
START_COMMANDS_DIR_REL = Path(".vinv") / "start_commands"

# How the OPERATOR says they start a service, recorded by the host (VS Code
# extension) after a failed bring-up and reused on every later attempt. It is a
# hint about WHICH command to trace — never a verified artifact, and never a
# licence to skip tracing: the `verified:true` contract in START_COMMANDS_DIR_REL
# is unchanged. One file per service, mirroring the start_commands layout.
START_HINTS_DIR_REL = Path(".vinv") / "start_hints"


# ── Capture root (kept in sync with sessions/paths.captures_root) ──

def _captures_root() -> Path:
    override = os.environ.get("VINV_CAPTURES_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / ".tracelens" / "baselines").resolve()


# ── Local tracelens package resolution ──
#
# `tracelens` is a sibling Python package in this monorepo
# (`vinv/tracelens/`), NOT a PyPI distribution.  The
# bring-up agent has historically been told to `pip install
# tracelens`, which fails with "No matching distribution found"
# and silently disables instrumentation for the whole pipeline.
#
# We resolve a concrete on-disk path so the agent can do
# `pip install -e <PATH>` instead.  Override with
# `VINV_TRACELENS_PACKAGE_PATH` for packaged builds where the
# autodetected path doesn't exist.

def _tracelens_package_path() -> Path | None:
    """Resolve the local `tracelens` package path or return ``None``.

    Resolution order:
      1. ``VINV_TRACELENS_PACKAGE_PATH`` env override (expanduser/resolve).
      2. Autodetect: the sibling ``tracelens`` package in the monorepo
         (``<repo>/tracelens``), located relative to this file.

    Returns the resolved path only if it contains a ``pyproject.toml``
    (so we never instruct the agent to ``pip install -e`` an empty or
    non-Python directory).  Returns ``None`` otherwise — the prompt
    will then tell the agent to abort with a precise error rather
    than silently fall back to PyPI.
    """
    override = os.environ.get("VINV_TRACELENS_PACKAGE_PATH")
    if override:
        candidate = Path(override).expanduser().resolve()
        if (candidate / "pyproject.toml").is_file():
            return candidate
        return None
    # This file lives at <repo>/bringup/src/bringup/runner.py, so the sibling
    # tracelens package is at parents[3] / "tracelens".
    candidate = (Path(__file__).resolve().parents[3] / "tracelens").resolve()
    if (candidate / "pyproject.toml").is_file():
        return candidate
    return None


# OTel deps pinned to one mutually-compatible release pair.
#
# Core packages (api/sdk/semantic-conventions) follow the stable
# scheme ``1.<X>.0`` and contrib instrumentation packages follow
# ``0.<X+21>b0`` (e.g. core 1.29.0 ↔ contrib 0.50b0). Mixing
# versions across that boundary makes the contrib packages crash
# at import time with ``ImportError: cannot import name
# '_StabilityMode'`` / ``'HTTP_DURATION_BUCKETS'`` — the JSONL
# exporter never registers and tracelens emits zero spans even
# while the wrapped service runs happily.
#
# Pin every OTel package explicitly and force-reinstall so any
# pre-installed mismatched versions in the target venv get
# realigned. ``--no-deps`` keeps pip from chasing transitive
# requirements that would re-introduce the skew we just fixed.
#
# 1.44.0/0.65b0: contrib <0.64b0 crashes every request on FastAPI
# ≥0.137 (``AttributeError: '_IncludedRouter' object has no attribute
# 'path'`` — app.routes became a tree; fixed upstream in contrib PR
# #4700 via ``iter_route_contexts()``). Verified live against the
# tracelens binary: spans flow, function-level components intact.
_OTEL_CORE_VERSION = "1.44.0"
_OTEL_INSTRUMENTATION_VERSION = "0.65b0"

_OTEL_PIN_SPECS: tuple[str, ...] = (
    f"opentelemetry-api=={_OTEL_CORE_VERSION}",
    f"opentelemetry-sdk=={_OTEL_CORE_VERSION}",
    f"opentelemetry-semantic-conventions=={_OTEL_INSTRUMENTATION_VERSION}",
    f"opentelemetry-util-http=={_OTEL_INSTRUMENTATION_VERSION}",
    f"opentelemetry-instrumentation=={_OTEL_INSTRUMENTATION_VERSION}",
    f"opentelemetry-instrumentation-fastapi=={_OTEL_INSTRUMENTATION_VERSION}",
    f"opentelemetry-instrumentation-asgi=={_OTEL_INSTRUMENTATION_VERSION}",
    f"opentelemetry-instrumentation-requests=={_OTEL_INSTRUMENTATION_VERSION}",
    f"opentelemetry-instrumentation-httpx=={_OTEL_INSTRUMENTATION_VERSION}",
    f"opentelemetry-instrumentation-asyncio=={_OTEL_INSTRUMENTATION_VERSION}",
    "asgiref",
    # PyYAML is a tracelens *run-path* dependency, not an OTel package: the
    # AST-injected trace function imports ``tracelens.enrich.external_invariants``
    # (→ ``import yaml``) at module-load time inside the SERVICE venv. The binary
    # and ``--no-deps`` editable installs both skip tracelens's own deps, so
    # without this the first instrumented import dies with ``No module named
    # 'yaml'`` and zero spans land. Pin to tracelens's declared range.
    "PyYAML>=6.0.1,<7.0.0",
)
_OTEL_DEPS = " ".join(_OTEL_PIN_SPECS)


def _render_otel_pin_block() -> str:
    """Render the OTel-pin + sanity-check shell block (shared by both install paths).

    Whether tracelens is installed editable or invoked as a prebuilt binary, the
    OpenTelemetry instrumentation packages still have to be present and
    version-pinned **in the service's own venv** — that is where tracelens
    imports them to wrap the running app. Mixed OTel versions make the contrib
    instrumenters crash at import (``_StabilityMode`` / ``HTTP_DURATION_BUCKETS``)
    and the JSONL exporter silently emits zero spans.
    """
    # shlex-quote every spec: `PyYAML>=6.0.1,<7.0.0` copied unquoted into a
    # shell turns `>` / `<` into redirections — pip silently installs an
    # unconstrained PyYAML and a junk `=6.0.1,` file appears in the cwd.
    otel_pin_lines_uv = " \\\n  ".join(shlex.quote(s) for s in _OTEL_PIN_SPECS)
    otel_pin_lines_pip = otel_pin_lines_uv
    return (
        _prompt("otel_pin_block").format(otel_pin_lines_uv=otel_pin_lines_uv, otel_pin_lines_pip=otel_pin_lines_pip, _OTEL_CORE_VERSION=_OTEL_CORE_VERSION, _OTEL_INSTRUMENTATION_VERSION=_OTEL_INSTRUMENTATION_VERSION)
    )


def _render_tracelens_install_block(tl_pkg: Path | None) -> str:
    """Render the prompt section telling the agent how to obtain tracelens.

    ``tl_pkg`` is the local monorepo source, installed editable; when it cannot
    be resolved the block says to abort, since `tracelens` is not on PyPI. The
    block always carries the abort-if-nothing-works contract so the agent never
    silently skips instrumentation.
    """
    pypi_warning = (
        "**`tracelens` is a LOCAL package in this monorepo — the `tracelens` "
        "name on PyPI belongs to an UNRELATED third-party project.** "
        "NEVER `pip install tracelens`: the install SUCCEEDS but yields an "
        "agent-evaluation framework whose `tracelens run` demands "
        "`--eval-set/--adapter/--graders` and cannot wrap a service. If a "
        "venv already contains it (`pip show tracelens` mentions eval sets "
        "or version >= 0.2), `pip uninstall -y tracelens` before continuing.\n\n"
    )
    if tl_pkg is not None:
        # Render the OTel pin block as one ``pkg==ver \`` per line so
        # the prompt is human-readable; the agent runs the block as
        # one shell command.
        otel_pin_lines = " \\\n  ".join(_OTEL_PIN_SPECS)
        return (
            _prompt("tracelens_install_editable").format(pypi_warning=pypi_warning, tl_pkg=tl_pkg, otel_pin_lines=otel_pin_lines, _OTEL_CORE_VERSION=_OTEL_CORE_VERSION, _OTEL_INSTRUMENTATION_VERSION=_OTEL_INSTRUMENTATION_VERSION)
        )
    return (
        _prompt("tracelens_install_missing").format(pypi_warning=pypi_warning)
    )


# ── Auto-discovery of Python distributions / traceable packages ─────
#
# Rather than asking the LLM agent to guess which packages to pass as
# --target-package flags (which it routinely gets wrong — it picks only
# the entry-point module and misses the library packages the handlers
# actually import), we scan the project ourselves at prompt-render time.
#
# The unit of discovery is the DISTRIBUTION — a directory carrying packaging
# metadata (pyproject.toml / setup.py / setup.cfg) — because that is the only
# notion that survives every real-world layout: flat single-package repos,
# src-layouts, poetry/hatch monorepos with n-level-nested sub-distributions,
# and multi-repo workspaces. For each distribution we resolve the IMPORTABLE
# top-level package names (what `tracelens --target-package` actually needs;
# directory names like `payment` or `vinv-electron` are useless there) from
# the declared metadata first and layout conventions second.

_TRACELENS_SKIP_DIRS: frozenset[str] = frozenset({
    # Virtual environments
    ".venv", "venv", ".venv312", "venv312", ".env", "env",
    # JS / build artefacts
    "node_modules", "dist", "build", "out", ".next",
    # VCS / tooling
    ".git", ".hg", ".svn",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".eggs",
    "__pycache__", "htmlcov",
    # Clearly not application code
    "docs", "data", "static", "assets", "media",
    "test_screenshots", "fixtures",
    "benchmarks", "benchmark_results",
    # Frontend / non-Python runtimes
    "frontend", "ui", "typescript", "javascript",
    # Packaging metadata
    "packaging", "deploy",
    # Test code — never instrument (would pollute traces with test helpers)
    "tests", "test", "spec",
    # Plain scripts / one-off tools — not importable library code
    "scripts", "tools", "bin",
    # DB migration artefacts
    "migrations", "alembic",
    # Vendored third-party code — ships its own pyproject.toml (e.g. a
    # vendored litellm stub with `name = "litellm"`) that must never be
    # enumerated as one of THIS repo's services.
    "vendor", "vendored", "vendors", "third_party", "thirdparty",
    "site-packages", "extern", "externals",
})

_TRACELENS_SKIP_PREFIXES: tuple[str, ...] = (".", "_", "test_")

# Packaging manifests that mark a directory as a distribution root.
_MANIFEST_NAMES: tuple[str, ...] = ("pyproject.toml", "setup.py", "setup.cfg")

# Recursion ceiling for the distribution walk. Skip-pruning does the real
# work; this only backstops pathological trees.
_DISCOVERY_MAX_DEPTH = 12


@dataclasses.dataclass(frozen=True)
class Distribution:
    """One discovered Python distribution (or unpackaged top-level package).

    ``name`` is the distribution name (``[project].name`` → ``[tool.poetry].name``
    → directory name) — the human-facing service identity, which may contain
    dashes. ``packages`` are the importable top-level package names — always
    valid Python identifiers, the only thing ``tracelens --target-package``
    accepts. ``path`` is the directory the manifest lives in (the natural
    ``working_directory`` for the service's start command).
    """

    name: str
    path: Path
    packages: tuple[str, ...]


def _load_pyproject(dist_dir: Path) -> dict[str, Any]:
    """Parse ``<dist_dir>/pyproject.toml`` into a dict; ``{}`` on absence/bad TOML."""
    manifest = dist_dir / "pyproject.toml"
    if not manifest.is_file():
        return {}
    try:
        return tomllib.loads(manifest.read_text(encoding="utf-8", errors="replace"))
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def _normalize_pkg_token(token: Any) -> str | None:
    """Normalize a declared package token to a top-level import name.

    Handles the shapes packaging tools actually declare: path-style
    (``src/pkg`` — hatch), dotted (``pkg.sub`` — setuptools include),
    glob-suffixed (``pkg*`` / ``pkg.*`` — setuptools find), and plain names.
    Returns ``None`` for anything that doesn't reduce to a valid identifier.
    """
    if not isinstance(token, str):
        return None
    tok = token.strip().replace("\\", "/").strip("/")
    if "/" in tok:
        tok = tok.rsplit("/", 1)[-1]
    tok = tok.split(".", 1)[0].rstrip("*")
    return tok if tok.isidentifier() else None


def _declared_packages(meta: dict[str, Any]) -> list[str]:
    """Extract explicitly-declared import packages from pyproject metadata.

    Covers the declaration styles of the mainstream build backends —
    setuptools (``packages`` list, ``packages.find.include``, ``py-modules``),
    poetry (``packages = [{include = …}]``), hatch (wheel target ``packages``),
    and flit (``[tool.flit.module].name``). When the author told the build
    backend what the import packages are, believe them over any heuristic.
    """
    tool = meta.get("tool") if isinstance(meta.get("tool"), dict) else {}
    tokens: list[Any] = []

    setuptools = tool.get("setuptools") if isinstance(tool.get("setuptools"), dict) else {}
    declared = setuptools.get("packages")
    if isinstance(declared, list):
        tokens += declared
    elif isinstance(declared, dict):
        find = declared.get("find")
        if isinstance(find, dict) and isinstance(find.get("include"), list):
            tokens += find["include"]
    if isinstance(setuptools.get("py-modules"), list):
        tokens += setuptools["py-modules"]

    poetry = tool.get("poetry") if isinstance(tool.get("poetry"), dict) else {}
    if isinstance(poetry.get("packages"), list):
        for item in poetry["packages"]:
            if isinstance(item, dict):
                tokens.append(item.get("include"))

    hatch_wheel = tool.get("hatch") if isinstance(tool.get("hatch"), dict) else {}
    hatch_wheel = hatch_wheel.get("build") if isinstance(hatch_wheel.get("build"), dict) else {}
    hatch_wheel = hatch_wheel.get("targets") if isinstance(hatch_wheel.get("targets"), dict) else {}
    hatch_wheel = hatch_wheel.get("wheel") if isinstance(hatch_wheel.get("wheel"), dict) else {}
    if isinstance(hatch_wheel.get("packages"), list):
        tokens += hatch_wheel["packages"]

    flit = tool.get("flit") if isinstance(tool.get("flit"), dict) else {}
    flit_module = flit.get("module") if isinstance(flit.get("module"), dict) else {}
    tokens.append(flit_module.get("name"))

    out: list[str] = []
    for token in tokens:
        norm = _normalize_pkg_token(token)
        if norm and norm not in out:
            out.append(norm)
    return out


def _is_candidate_pkg_dir(entry: Path) -> bool:
    """True when ``entry`` looks like an application import package."""
    name = entry.name
    if name in _TRACELENS_SKIP_DIRS or not name.isidentifier():
        return False
    if any(name.startswith(p) for p in _TRACELENS_SKIP_PREFIXES):
        return False
    return entry.is_dir() and (entry / "__init__.py").is_file()


def _layout_packages(dist_dir: Path, dist_name: str) -> list[str]:
    """Resolve import packages from filesystem conventions (no declarations).

    Priority: src-layout → the manifest dir *is* the package (flat
    self-package) → flat child packages → a single ``<name>.py`` module.
    """
    src = dist_dir / "src"
    if src.is_dir():
        try:
            pkgs = [e.name for e in sorted(src.iterdir()) if _is_candidate_pkg_dir(e)]
        except OSError:
            pkgs = []
        if pkgs:
            return pkgs
    if (dist_dir / "__init__.py").is_file() and dist_dir.name.isidentifier():
        return [dist_dir.name]
    try:
        pkgs = [e.name for e in sorted(dist_dir.iterdir()) if _is_candidate_pkg_dir(e)]
    except OSError:
        pkgs = []
    if pkgs:
        return pkgs
    norm = dist_name.replace("-", "_").replace(".", "_")
    if norm.isidentifier() and (dist_dir / f"{norm}.py").is_file():
        return [norm]
    return []


def _dist_name(meta: dict[str, Any], dist_dir: Path) -> str:
    project = meta.get("project") if isinstance(meta.get("project"), dict) else {}
    tool = meta.get("tool") if isinstance(meta.get("tool"), dict) else {}
    poetry = tool.get("poetry") if isinstance(tool.get("poetry"), dict) else {}
    name = project.get("name") or poetry.get("name")
    return str(name).strip() if isinstance(name, str) and name.strip() else dist_dir.name


def _discover_distributions(
    project_root: Path, *, max_depth: int = _DISCOVERY_MAX_DEPTH
) -> list[Distribution]:
    """Recursively discover Python distributions under ``project_root``.

    Walks the tree (n-level nesting: monorepos, multi-repo workspaces) with
    three hard rules:

      * a directory holding a packaging manifest is a distribution root — its
        import packages come from declared metadata first, layout second;
      * a directory that is itself a package (``__init__.py``) is never
        descended into — subpackages are not top-level, and vendored manifests
        buried inside a package tree are not this repo's services;
      * venvs are recognized by ``pyvenv.cfg`` (they can carry ANY directory
        name), on top of the name-based skip lists.

    A bare package directory found outside any distribution (Django-style
    unpackaged project) is reported as its own pseudo-distribution. Namespace
    packages without ``__init__.py`` and without metadata are only picked up
    by the legacy flat-scan fallback in :func:`_discover_traceable_packages`.

    Symlink cycles are broken via a resolved-path visited set. Results are
    sorted by name for deterministic prompts.
    """
    results: list[Distribution] = []
    visited: set[Path] = set()

    def _walk(directory: Path, depth: int, under_dist: bool) -> None:
        try:
            resolved = directory.resolve()
        except OSError:
            return
        if resolved in visited or depth > max_depth:
            return
        visited.add(resolved)
        if (directory / "pyvenv.cfg").is_file():
            return

        has_manifest = any((directory / m).is_file() for m in _MANIFEST_NAMES)
        is_package = (directory / "__init__.py").is_file()

        if has_manifest:
            meta = _load_pyproject(directory)
            packages = _declared_packages(meta)
            name = _dist_name(meta, directory)
            if not packages:
                packages = _layout_packages(directory, name)
            results.append(
                Distribution(name=name, path=directory, packages=tuple(dict.fromkeys(packages)))
            )
            under_dist = True
        elif is_package and not under_dist and directory.name.isidentifier():
            results.append(
                Distribution(
                    name=directory.name,
                    path=directory.parent,
                    packages=(directory.name,),
                )
            )

        if is_package:
            return
        try:
            children = sorted(directory.iterdir(), key=lambda p: p.name)
        except OSError:
            return
        for child in children:
            name = child.name
            if not child.is_dir():
                continue
            if name in _TRACELENS_SKIP_DIRS:
                continue
            if any(name.startswith(p) for p in _TRACELENS_SKIP_PREFIXES):
                continue
            _walk(child, depth + 1, under_dist)

    _walk(project_root, 0, False)
    return sorted(results, key=lambda d: (d.name, str(d.path)))


def _flat_scan_fallback(project_root: Path) -> list[str]:
    """Legacy depth-1 scan for repos with no packaging metadata at all.

    Keeps the pre-distribution behavior (any immediate child directory holding
    ``.py`` files counts) for unpackaged script-soup projects, but drops names
    that aren't importable identifiers — they can never be tracelens targets.
    """
    packages: list[str] = []
    try:
        entries = sorted(project_root.iterdir(), key=lambda p: p.name)
    except OSError:
        return packages

    for entry in entries:
        name = entry.name
        if not entry.is_dir() or not name.isidentifier():
            continue
        if name in _TRACELENS_SKIP_DIRS:
            continue
        if any(name.startswith(p) for p in _TRACELENS_SKIP_PREFIXES):
            continue
        py_files = [
            f for f in entry.rglob("*.py")
            if not any(part in _TRACELENS_SKIP_DIRS for part in f.parts)
        ]
        if not py_files:
            continue
        packages.append(name)

    return sorted(packages)


def _discover_traceable_packages(project_root: Path) -> list[str]:
    """Return top-level import package names to pass as tracelens targets.

    The union of every discovered distribution's import packages; falls back
    to the legacy flat scan only when the distribution walk finds nothing
    (repos with zero manifests and zero ``__init__.py`` package roots).
    Returns names sorted alphabetically for deterministic prompts.
    """
    packages = sorted({p for dist in _discover_distributions(project_root) for p in dist.packages})
    if packages:
        return packages
    return _flat_scan_fallback(project_root)


# ── Declared-runnable mining (manifest-first service enumeration) ──
#
# Mature platforms enumerate runnables from what the repo AUTHOR declared
# before inferring anything: Heroku/Cloud Native Buildpacks read Procfile
# process types, Nx/Turborepo infer targets from package.json scripts and
# workspace manifests, compose/k8s tooling mines service definitions. The same
# manifest-first pass runs here at prompt-render time so the Stage 2a agent
# starts from every DECLARED runnable — Procfile entries, compose services,
# console scripts, package.json run scripts, Cargo [[bin]] targets — instead
# of only the Python distributions. Each candidate carries a `kind` from the
# shared taxonomy (http-service | stdio-server | worker | scheduler | cli |
# frontend-dev-server | infra) plus the evidence file, and the prompt tells
# the agent to confirm or reclassify against the entry code.

# Directories never worth scanning for manifests. Deliberately SMALLER than
# _TRACELENS_SKIP_DIRS: that list drops `frontend`/`ui`/`scripts`/`bin` because
# they are not *instrumentable Python*, but a frontend dev server or a script
# entry is exactly the kind of runnable this pass exists to surface.
_MANIFEST_SCAN_SKIP: frozenset[str] = frozenset({
    ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", ".next",
    ".venv", "venv", ".venv312", "venv312", ".env", "env",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox",
    ".eggs", "htmlcov", "site-packages",
    "vendor", "vendored", "vendors", "third_party", "thirdparty",
    # Test fixtures declare runnables too (mini-monorepo fixtures, demo
    # Procfiles) — they are not THIS repo's services.
    "tests", "test", "spec", "fixtures", "fixture", "testdata",
})

# Compose images that are stateful infrastructure we never instrument (they
# run in Docker; everything else is an app candidate that runs on the host).
_INFRA_IMAGE_TOKENS: tuple[str, ...] = (
    "postgres", "mysql", "mariadb", "redis", "valkey", "memcached", "kafka",
    "zookeeper", "rabbitmq", "nats", "mongo", "elasticsearch", "opensearch",
    "clickhouse", "cassandra", "neo4j", "minio", "jaeger", "grafana",
    "prometheus", "otel", "opentelemetry", "collector", "localstack",
)

# package.json script names that launch something (vs build/test/lint chores).
_RUNNABLE_SCRIPT_NAMES: frozenset[str] = frozenset({
    "dev", "start", "serve", "preview", "watch",
})


@dataclasses.dataclass(frozen=True)
class DeclaredRunnable:
    """One runnable the repo's own manifests declare.

    ``kind`` is the shared discovery taxonomy (``http-service | stdio-server |
    worker | scheduler | cli | frontend-dev-server | infra``) — a *prior* from
    the declared command text, for the agent to confirm against entry code.
    ``source`` is the repo-relative evidence (``Procfile``,
    ``web/package.json:scripts.dev``, …).
    """

    name: str
    kind: str
    command: str
    source: str


def _classify_run_command(command: str) -> str:
    """Classify a declared start command into the shared taxonomy.

    Deterministic keyword mapping over the command text — specific signals
    first (scheduler beats worker for ``celery … beat``), CLI as the fallback
    when nothing marks the command long-running.
    """
    c = command.lower()
    if ("celery" in c and " beat" in c) or any(
        t in c for t in ("apscheduler", "cron", "scheduler", "clockwork")
    ):
        return "scheduler"
    if any(t in c for t in ("celery", "dramatiq", "rq worker", "taskiq", "huey")) or (
        " worker" in c
    ):
        return "worker"
    if any(t in c for t in ("mcp", "stdio")):
        return "stdio-server"
    if any(
        t in c
        for t in (
            "vite", "next dev", "next start", "webpack serve",
            "react-scripts start", "astro dev", "nuxt dev", "ng serve",
        )
    ):
        return "frontend-dev-server"
    if any(
        t in c
        for t in (
            "uvicorn", "gunicorn", "hypercorn", "waitress", "daphne",
            "runserver", "flask run", "flask --app", "http.server",
            "fastapi run", "fastapi dev", "node server", "sanic",
        )
    ):
        return "http-service"
    return "cli"


_PROCFILE_LINE_RE = re.compile(r"^([A-Za-z0-9_-]+)\s*:\s*(.+)$")


def _mine_procfile(path: Path, rel: str) -> list[DeclaredRunnable]:
    """Heroku-style Procfile: each line is `<process-type>: <command>`."""
    out: list[DeclaredRunnable] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return out
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = _PROCFILE_LINE_RE.match(line)
        if not m:
            continue
        name, command = m.group(1), m.group(2).strip()
        kind = _classify_run_command(command)
        # Process-type conventions refine a `cli` fallback: `web` serves HTTP,
        # `worker`/`clock` name their own kinds, `release` is a one-shot.
        if kind == "cli":
            lowered = name.lower()
            if lowered == "web":
                kind = "http-service"
            elif "worker" in lowered:
                kind = "worker"
            elif lowered in ("clock", "scheduler", "cron", "beat"):
                kind = "scheduler"
        out.append(DeclaredRunnable(name=name, kind=kind, command=command, source=rel))
    return out


def _mine_compose(path: Path, rel: str) -> list[DeclaredRunnable]:
    """docker-compose/compose service definitions, without a YAML dependency.

    Minimal indentation scan of the top-level ``services:`` block: each
    consistently-indented child key is a service; its ``image:``/``build:``/
    ``command:``/``ports:`` lines classify it. Infra images (Postgres, Redis,
    Kafka, …) become ``infra`` (Docker); everything else is an app candidate
    (host). Anchors/extends and exotic YAML are out of scope — the agent reads
    the file itself; this only seeds the candidate list.
    """
    out: list[DeclaredRunnable] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return out
    in_services = False
    svc_indent: int | None = None
    current: str | None = None
    props: dict[str, dict[str, str | bool]] = {}
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        stripped = raw.strip()
        if indent == 0:
            in_services = stripped == "services:"
            svc_indent, current = None, None
            continue
        if not in_services:
            continue
        if stripped.endswith(":") and not stripped.startswith("-"):
            key = stripped[:-1].strip().strip("\"'")
            if svc_indent is None:
                svc_indent = indent
            if indent == svc_indent:
                current = key
                props[current] = {}
                continue
        if current is None:
            continue
        if stripped.startswith("image:"):
            props[current]["image"] = stripped.split(":", 1)[1].strip().strip("\"'")
        elif stripped.startswith("build:") or stripped == "build:":
            props[current]["build"] = True
        elif stripped.startswith("command:"):
            props[current]["command"] = stripped.split(":", 1)[1].strip().strip("\"'")
        elif stripped.startswith("ports:"):
            props[current]["ports"] = True
    for name, p in props.items():
        image = str(p.get("image", ""))
        image_leaf = image.split("/")[-1].split(":")[0].lower()
        if image and any(tok in image_leaf for tok in _INFRA_IMAGE_TOKENS):
            out.append(DeclaredRunnable(
                name=name, kind="infra", command=f"docker compose up -d {name}", source=rel,
            ))
            continue
        command = str(p.get("command", ""))
        if command:
            kind = _classify_run_command(command)
        else:
            kind = "http-service" if p.get("ports") else "worker"
        out.append(DeclaredRunnable(
            name=name, kind=kind,
            command=command or "(compose service — derive native command from its Dockerfile)",
            source=rel,
        ))
    return out


def _mine_package_json(path: Path, rel: str) -> list[DeclaredRunnable]:
    """package.json run scripts (`dev`/`start`/`serve`/`preview`/`watch`)."""
    out: list[DeclaredRunnable] = []
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return out
    if not isinstance(data, dict):
        return out
    pkg = str(data.get("name") or path.parent.name)
    scripts = data.get("scripts")
    if isinstance(scripts, dict):
        for script, command in sorted(scripts.items()):
            if script not in _RUNNABLE_SCRIPT_NAMES or not isinstance(command, str):
                continue
            out.append(DeclaredRunnable(
                name=f"{pkg}:{script}",
                kind=_classify_run_command(command),
                command=command,
                source=f"{rel}:scripts.{script}",
            ))
    return out


def _mine_pyproject_scripts(path: Path, rel: str) -> list[DeclaredRunnable]:
    """Console scripts from [project.scripts] / [tool.poetry.scripts].

    Declared as `kind=cli` — a console script is runnable by definition, but
    only its entry code says whether it is a server/worker in disguise; the
    runbook instructs the agent to verify and reclassify.
    """
    out: list[DeclaredRunnable] = []
    meta = _load_pyproject(path.parent)
    project = meta.get("project") if isinstance(meta.get("project"), dict) else {}
    tool = meta.get("tool") if isinstance(meta.get("tool"), dict) else {}
    poetry = tool.get("poetry") if isinstance(tool.get("poetry"), dict) else {}
    for table, label in ((project.get("scripts"), "project.scripts"),
                         (poetry.get("scripts"), "tool.poetry.scripts")):
        if not isinstance(table, dict):
            continue
        for script, target in sorted(table.items()):
            if not isinstance(target, str):
                continue
            out.append(DeclaredRunnable(
                name=str(script), kind="cli", command=str(script),
                source=f"{rel}:[{label}] → {target}",
            ))
    return out


def _mine_cargo_bins(path: Path, rel: str) -> list[DeclaredRunnable]:
    """Cargo.toml [[bin]] targets (and the implicit src/main.rs binary)."""
    out: list[DeclaredRunnable] = []
    try:
        meta = tomllib.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, tomllib.TOMLDecodeError):
        return out
    pkg = meta.get("package") if isinstance(meta.get("package"), dict) else {}
    bins = meta.get("bin") if isinstance(meta.get("bin"), list) else []
    for b in bins:
        if isinstance(b, dict) and isinstance(b.get("name"), str):
            out.append(DeclaredRunnable(
                name=b["name"], kind="cli",
                command=f"cargo run --bin {b['name']}", source=f"{rel}:[[bin]]",
            ))
    if not bins and isinstance(pkg.get("name"), str) and (path.parent / "src" / "main.rs").is_file():
        out.append(DeclaredRunnable(
            name=str(pkg["name"]), kind="cli",
            command="cargo run", source=f"{rel} (src/main.rs)",
        ))
    return out


_JUSTFILE_TARGET_RE = re.compile(r"^([A-Za-z0-9_-]+)\s*:(?:\s|$)")
_RUN_TARGET_TOKENS: tuple[str, ...] = ("run", "serve", "dev", "start", "worker", "web")


def _mine_make_just(path: Path, rel: str) -> list[DeclaredRunnable]:
    """Run-shaped Makefile / justfile targets (`run*`, `serve*`, `dev*`, …)."""
    out: list[DeclaredRunnable] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return out
    runner = "just" if path.name.lower() == "justfile" else "make"
    for i, line in enumerate(lines):
        if line.startswith(("\t", " ", ".", "#")):
            continue
        m = _JUSTFILE_TARGET_RE.match(line)
        if not m:
            continue
        target = m.group(1)
        lowered = target.lower()
        if not any(tok in lowered for tok in _RUN_TARGET_TOKENS):
            continue
        recipe = ""
        for nxt in lines[i + 1 : i + 6]:
            if nxt.startswith(("\t", "    ")) and nxt.strip():
                recipe = nxt.strip()
                break
        kind = _classify_run_command(recipe) if recipe else "cli"
        out.append(DeclaredRunnable(
            name=target, kind=kind, command=f"{runner} {target}", source=rel,
        ))
    return out


_COMPOSE_NAMES: tuple[str, ...] = (
    "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
)


def _discover_declared_runnables(
    project_root: Path, *, max_depth: int = _DISCOVERY_MAX_DEPTH
) -> list[DeclaredRunnable]:
    """Mine every runnable the repo's manifests DECLARE, across nesting.

    Walks the tree (bounded, venv/vendor/node_modules pruned, symlink-cycle
    safe) and mines: Procfile process types, docker-compose service
    definitions, package.json run scripts, pyproject console scripts,
    Cargo ``[[bin]]`` targets, and run-shaped Makefile/justfile targets.
    Nested workspace members (npm/pnpm/uv workspaces, nested repos) are
    covered by the walk itself — every member's own manifests are mined.
    Deterministic: results sorted by (source, name).
    """
    results: list[DeclaredRunnable] = []
    visited: set[Path] = set()

    def _walk(directory: Path, depth: int) -> None:
        try:
            resolved = directory.resolve()
        except OSError:
            return
        if resolved in visited or depth > max_depth:
            return
        visited.add(resolved)
        if (directory / "pyvenv.cfg").is_file():
            return
        try:
            rel_dir = directory.relative_to(project_root)
        except ValueError:
            rel_dir = Path(".")

        def _rel(name: str) -> str:
            return name if str(rel_dir) == "." else f"{rel_dir.as_posix()}/{name}"

        for name in ("Procfile", "Procfile.dev"):
            p = directory / name
            if p.is_file():
                results.extend(_mine_procfile(p, _rel(name)))
        for name in _COMPOSE_NAMES:
            p = directory / name
            if p.is_file():
                results.extend(_mine_compose(p, _rel(name)))
        p = directory / "package.json"
        if p.is_file():
            results.extend(_mine_package_json(p, _rel("package.json")))
        p = directory / "pyproject.toml"
        if p.is_file():
            results.extend(_mine_pyproject_scripts(p, _rel("pyproject.toml")))
        p = directory / "Cargo.toml"
        if p.is_file():
            results.extend(_mine_cargo_bins(p, _rel("Cargo.toml")))
        for name in ("Makefile", "makefile", "justfile", "Justfile"):
            p = directory / name
            if p.is_file():
                results.extend(_mine_make_just(p, _rel(name)))
                break
        try:
            children = sorted(directory.iterdir(), key=lambda c: c.name)
        except OSError:
            return
        for child in children:
            if not child.is_dir():
                continue
            if child.name in _MANIFEST_SCAN_SKIP or child.name.startswith("."):
                continue
            _walk(child, depth + 1)

    _walk(project_root, 0)
    return sorted(results, key=lambda r: (r.source, r.name))


def _declared_runnables_note(project_root: Path, *, cap: int = 60) -> str:
    """Render the declared-runnables block for the Stage 2a prompt (or '')."""
    runnables = _discover_declared_runnables(project_root)
    if not runnables:
        return ""
    shown = runnables[:cap]
    lines = [
        f"- `{r.name}` — kind guess: **{r.kind}** — declared in `{r.source}`"
        + (f" as `{r.command}`" if r.command else "")
        for r in shown
    ]
    more = (
        f"\n…and {len(runnables) - cap} more (re-run the same manifest walk yourself if needed)."
        if len(runnables) > cap else ""
    )
    return (
        "\n\nThe framework also mined every runnable the repo's manifests DECLARE "
        "(Procfile process types, docker-compose services, package.json run "
        "scripts, pyproject console scripts, Cargo [[bin]] targets, Makefile/"
        "justfile run targets — across nested workspaces):\n\n"
        + "\n".join(lines)
        + more
        + "\n\nUse these to cross-check the inventory: every DECLARED runnable "
        "must be accounted for — either as a service entry (Python web/worker/"
        "stdio/scheduler), or consciously excluded (non-Python frontend dev "
        "servers, `infra` compose services, one-shot CLIs) with the reason clear "
        "from its kind. A `cli` kind is a *prior*, not a verdict: read the "
        "script's entry code — a console script that starts uvicorn is a "
        "`python_web` service, one that runs an MCP/stdio JSON-RPC loop is "
        "`python_stdio`."
    )


def _render_target_package_flags(packages: list[str]) -> str:
    """Render the --target-package flags block for the bringup prompt."""
    if not packages:
        return "  --target-package <PACKAGE> \\\n"
    lines = [f"  --target-package {pkg} \\\n" for pkg in packages]
    return "".join(lines)


def list_instruction(project_root: Path, *, portable: bool = False) -> str:
    """Build the TerminalExecutor task for Stage 2a: enumerate the Python services.

    ``portable=True`` selects the tool-agnostic variant (``*_portable`` prompt
    file) — the same rendered content with the Vinv-specific terminal/file tool
    mechanics stripped — for printing into a foreign coding agent. The default
    keeps the native wording the Vinv terminal-tool vocabulary expects.

    This is the read-only half of bring-up. The agent reads the discovery
    handbook (and inspects the repo where the handbook is thin) and writes a
    machine-readable inventory of the **Python services** — the top-level Python
    packages/components we instrument — to ``<repo>/.vinv/services.json`` via the
    injected ``save_file`` tool. The caller then reads that file back and picks a
    service to pass to :func:`start_instruction` (Stage 2b).

    **Python services only.** Stateful Docker infrastructure (Postgres, Redis,
    etc.) and non-Python processes (Node/Vite frontends) are **excluded** from
    this inventory — they are not things we bring up under tracelens. The start
    stage will start whatever infrastructure a Python service depends on by
    reading the handbook itself.

    It must NOT install anything or start any process — it only describes.
    """
    root = str(project_root.resolve())
    vinv_md = str((project_root / HANDBOOK_REL).resolve())
    services_json = str((project_root / SERVICES_REL).resolve())
    # Distributions are the service candidates. The scan is a strong prior the
    # agent starts from — the handbook stays authoritative, so a service the
    # scan missed must be ADDED from the handbook, never silently dropped.
    _dists = _discover_distributions(project_root)
    if _dists:
        _dist_lines = []
        for d in _dists:
            mods = ", ".join(f"`{p}`" for p in d.packages) or (
                "(unresolved — derive from its own pyproject/src layout)"
            )
            _dist_lines.append(
                f"- `{d.name}` — path: `{d.path.resolve()}`, import package(s) for `modules`: {mods}"
            )
        _pkgs_note = (
            "The Vinv framework scanned the repo for Python distributions "
            "(pyproject.toml / setup.py / setup.cfg) and unpackaged top-level "
            "packages, and found these candidate services:\n\n"
            + "\n".join(_dist_lines)
            + "\n\nTreat this list as a strong prior, NOT a mandate — the handbook "
            "is the authority:\n"
            "- Default to one entry per candidate above: `name` = the candidate "
            "name shown, `modules` = the import package(s) shown. Import packages "
            "are Python identifiers — never put a directory or distribution name "
            "containing `-` (or any non-identifier) in `modules`.\n"
            "- If the handbook documents a Python service missing from this list, "
            "ADD it (derive its modules from its own pyproject/src layout) — do "
            "not drop it or rename a candidate to cover it.\n"
            "- If a candidate is clearly not part of this repo's runnable stack "
            "(a vendored copy, an example, a dev-only shim), you may omit it.\n"
            "- Never merge several candidates into one entry, and do not invent "
            "names that appear in neither this list nor the handbook."
        )
    else:
        _pkgs_note = (
            "No Python distributions or top-level packages were auto-detected; "
            "inspect the repo layout and enumerate each Python service yourself. "
            "Every `modules` entry must be an importable top-level package name "
            "(a valid Python identifier), never a directory name with `-`."
        )
    # Manifest-first enumeration: append every runnable the repo DECLARES
    # (Procfile, compose, run scripts, console scripts, …) so the inventory is
    # cross-checked against the author's own declarations, not just the
    # Python-distribution scan.
    _pkgs_note += _declared_runnables_note(project_root)
    key = "list_instruction_portable" if portable else "list_instruction"
    return _prompt(key).format(_pkgs_note=_pkgs_note, vinv_md=vinv_md, root=root, services_json=services_json).strip()


def start_instruction(
    project_root: Path,
    service: str,
    modules: list[str],
    session_id: str | None = None,
    *,
    portable: bool = False,
) -> str:
    """Build the TerminalExecutor task to bring up a SINGLE selected service.

    This is Stage 2b: the caller has already enumerated the stack (Stage 2a,
    :func:`list_instruction` → ``.vinv/services.json``) and picked one
    ``service`` plus the ``modules`` (top-level Python packages) to instrument
    for it. The agent installs that service's dependencies and starts **only
    that service**, wrapping it in ``tracelens run`` when it is a Python process.

    ``session_id`` (when provided) is woven into the tracelens output path so
    each run's traces land under
    ``<captures_root>/<session_id>/<service>/trace.jsonl`` — isolated from prior
    projects' baselines. When omitted the unscoped path is used. ``captures_root``
    comes from :func:`_captures_root` (``VINV_CAPTURES_DIR`` env override, default
    ``~/.tracelens/baselines``) so a host (electron app / VS Code extension) can
    point captures at a per-workspace directory at runtime; the value is embedded
    into the agent's ``--output`` command so writer and backend reader agree.
    """
    root = str(project_root.resolve())
    vinv_md = str((project_root / ".vinv" / "vinv.md").resolve())
    start_commands_json = str(_start_commands_path(project_root, service))
    tracelens_subdir = f"{session_id}/" if session_id else ""
    # Captures root honours ``VINV_CAPTURES_DIR`` so the host (electron app / VS
    # Code extension) can redirect traces per workspace at runtime; the backend
    # reader (``sessions/paths.captures_root``) resolves the SAME env var, keeping
    # writer and reader in sync. Embed the resolved absolute base in the prompt
    # instead of a hardcoded ``~/.tracelens/baselines`` literal so that setting the
    # env var actually moves where the agent WRITES, not just where we scan.
    #
    # Rendered with FORWARD SLASHES, deliberately. Every use of this base sits
    # inside a shell command (`--output …`, `wc -l …`) that the recorded entry
    # carries into `bash -lc`, and a Windows path written with single backslashes
    # loses them twice over:
    #   * bash eats them as escapes — `C:\Users\SERVER\.tracelens` arrives as
    #     `C:UsersSERVER.tracelens`, a relative path, so the trace lands
    #     somewhere the backend reader never scans and the baseline reads empty;
    #   * `\U` / `\S` are not valid JSON escapes, so the deliverable this prompt
    #     asks for would not even parse — while the same section demands "valid
    #     JSON only".
    # Forward slashes dodge both (no escape to eat, nothing to escape) and are
    # still a perfectly good Windows path: Win32 and Python accept `C:/…`, so
    # this needs no Git-Bash `/c/…` mangling and works if the command is ever run
    # outside Git Bash. POSIX paths are unaffected.
    _caps_base = str(_captures_root()).replace("\\", "/")
    # Same reasoning for the recorded `working_directory`: it is a JSON string
    # value, so single backslashes would break the parse. It is handed to the
    # replayer as a subprocess cwd (never through bash), and `C:/…` is valid
    # there. Prose/tool-arg uses of `{root}` keep the native form.
    _root_json = root.replace("\\", "/")
    tl_pkg = _tracelens_package_path()
    tracelens_install_block = _render_tracelens_install_block(tl_pkg)
    # The command examples below invoke tracelens and the interpreter through the
    # SERVICE venv's script directory, written as the `<venv-bin>` placeholder.
    #
    # Deliberately a placeholder and NOT a resolved path: the venv is created by
    # the agent at run time (STEP 0 detects the manager first), long after this
    # prompt is rendered, so there is nothing real to bake in. What matters is
    # that the shape the agent copies into `.vinv/start_commands/<svc>.json` is
    # venv-qualified. A bare `tracelens` / bare `python` resolves for the agent
    # only because of what ITS shell happens to have on PATH, and the recorded
    # command is replayed later from a plain non-interactive shell that inherits
    # none of that — it fails with exit 127 and no agent can repair it, because
    # the file lives outside the repo where a fix episode's diff cannot reach.
    _venv_bin = "<venv-bin>"
    _tracelens_cmd = f"{_venv_bin}/tracelens"
    _venv_python = f"{_venv_bin}/python"
    # tracelens shells out to the `opentelemetry-instrument` console script to
    # wrap the app. That script lives in the SERVICE venv's `bin/` (next to
    # `python`), not on the global PATH — and invoking tracelens by absolute
    # path (or via `uv run`, which only sets up the venv for the *inner*
    # process) does NOT add it. If it's missing tracelens aborts with
    # `tracelens run: opentelemetry-instrument not on PATH` and the service
    # never starts. The fix is to prepend the venv `bin/` to PATH inline.
    _otel_path_note = (
        "\n\n**CRITICAL — put the service venv's script dir on `PATH` when you "
        "invoke tracelens.** tracelens shells out to the "
        "`opentelemetry-instrument` console script to wrap the app; that script "
        "lives in the service venv's script dir (alongside `python`), NOT on the "
        "global `PATH`. If it isn't found tracelens aborts with `tracelens run: "
        "opentelemetry-instrument not on PATH` and the service never starts. "
        "Calling tracelens by absolute path does NOT add it, and `uv run` only "
        "fixes the *inner* process's environment — so prepend it inline on the "
        "tracelens command itself:\n"
        "```bash\n"
        f"PATH=\"{_venv_bin}:$PATH\" {_tracelens_cmd}"
        f" run … -- {_venv_python} -m <module> <args>\n"
        "```"
    )
    _tracelens_path_note = (
        f"**`{_venv_bin}` is a placeholder — substitute the real path.** It is "
        "the service venv's script directory: `bin/` on macOS/Linux, `Scripts/` "
        "on Windows. Resolve it from the venv YOU created in the install step "
        "and use it for both `tracelens` and the interpreter.\n\n"
        "**Never leave a bare `tracelens` or a bare `python` in a command you "
        "record.** Both resolve for you only because of what your shell happens "
        "to have on `PATH` or an activated venv; the recorded start command is "
        "replayed later from a plain shell that inherits neither, where a bare "
        "name fails with `exit 127 command not found`.\n\n"
        "**The recorded command is executed by `bash -lc`, on every platform.** "
        "On Windows that is Git Bash, so write the venv path in the form bash "
        "accepts — `/c/Users/…/.venv/Scripts`, not `C:\\Users\\…\\.venv\\Scripts` "
        "(a drive-letter colon would be read as a `PATH` separator) — and "
        "separate `PATH` entries with `:`, never `;`."
    ) + _otel_path_note
    # The caller selected the modules (top-level Python packages) to instrument
    # for this service. Fall back to auto-discovery only if none were passed.
    _selected_modules = [m for m in modules if m]
    if _selected_modules:
        _target_pkg_flags = _render_target_package_flags(_selected_modules)
        _target_pkg_note = (
            f"The caller selected these module(s) to instrument for `{service}`: "
            f"**{', '.join(f'`{m}`' for m in _selected_modules)}**. Use them "
            "**verbatim** in the `--target-package` flags below — do not "
            "substitute, add, or remove any package names."
        )
    else:
        _discovered_pkgs = _discover_traceable_packages(project_root)
        _target_pkg_flags = _render_target_package_flags(_discovered_pkgs)
        _target_pkg_note = (
            f"No modules were passed for `{service}`; the Vinv framework scanned "
            f"`{project_root}` and found these top-level Python packages: "
            f"**{', '.join(f'`{p}`' for p in _discovered_pkgs) or '(none detected)'}**. "
            "Use them **verbatim** in the `--target-package` flags below."
        ) if _discovered_pkgs else (
            "No modules were passed and no Python packages were auto-detected. "
            "Inspect the repo structure and choose the correct `--target-package` "
            "value manually."
        )
    key = "start_instruction_portable" if portable else "start_instruction"
    return _prompt(key).format(service=service, vinv_md=vinv_md, tracelens_install_block=tracelens_install_block, _caps_base=_caps_base, _tracelens_cmd=_tracelens_cmd, _venv_bin=_venv_bin, _venv_python=_venv_python, _target_pkg_note=_target_pkg_note, _target_pkg_flags=_target_pkg_flags, tracelens_subdir=tracelens_subdir, _tracelens_path_note=_tracelens_path_note, _g0=tracelens_subdir or '<session-id>/', root=root, _root_json=_root_json, start_commands_json=start_commands_json).strip()


# ── Prompt rendering for --print-prompt (no agent, no LLM) ────────
#
# The CLI's --print-prompt path renders the exact task prompt the agent WOULD
# receive and prints it, so a human can pipe it into another coding agent
# (Cursor / Windsurf / Claude Code / …) and have THAT agent's model do the
# bring-up. Two knobs:
#   * portable=True         → the tool-agnostic prompt variant (above).
#   * inline_handbook=True  → prepend the handbook body so the printed runbook is
#                             self-contained (no separate `cat {vinv_md}` step,
#                             and none of the path/casing mistakes that dogged
#                             weak-model runs). Only bounded, known-size content
#                             is inlined — never runtime command output.


def _handbook_inline_block(project_root: Path, *, max_chars: int = 80_000) -> str:
    """Return a fenced '### Handbook (inlined)' block, or '' when absent/unreadable.

    Bounded on purpose: the handbook is stable, known-size content (safe to
    inline), but we still cap it and leave a pointer to the full file so a
    pathological multi-hundred-KB handbook can't bloat the printed prompt. The
    body is concatenated (never ``str.format``-ed) because handbook Markdown
    routinely contains ``{`` / ``}`` that would break format substitution.
    """
    hb = _handbook_path(project_root)
    try:
        text = hb.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    trunc = ""
    if len(text) > max_chars:
        text = text[:max_chars]
        trunc = f"\n\n…[handbook truncated at {max_chars} chars — read the full file at {hb}]"
    header = (
        f"### Handbook (inlined — full file also at `{hb}`)\n\n"
        "The Stage 1 discovery handbook this runbook refers to is reproduced here "
        "so you do not need to open it separately:\n\n"
    )
    # Four-backtick fence so triple-backtick code blocks inside the handbook
    # don't prematurely close it.
    return header + "````markdown\n" + text + trunc + "\n````\n\n---\n\n"


def render_list_prompt(
    project_root: Path, *, portable: bool = False, inline_handbook: bool = True
) -> str:
    """Render the Stage 2a task prompt for printing (constructs no agent, makes no LLM call)."""
    project_root = project_root.resolve()
    prompt = list_instruction(project_root, portable=portable)
    if inline_handbook:
        block = _handbook_inline_block(project_root)
        if block:
            prompt = block + prompt
    return prompt


def render_start_prompt(
    project_root: Path,
    *,
    service: str,
    modules: list[str] | None = None,
    session_id: str | None = None,
    portable: bool = False,
    inline_handbook: bool = True,
    start_hint: str | None = None,
) -> str:
    """Render the Stage 2b task prompt for printing (constructs no agent, makes no LLM call).

    Launch-command resolution, most authoritative first: the explicit
    ``start_hint``, then the operator's answer at
    ``.vinv/start_hints/<service>.json``, then the ``command`` discovery recorded
    in ``services.json``. The last rung is what stops the agent inferring a value
    the repo already states — previously the prompt carried no command at all
    unless a human had been asked, so a bring-up failed, the extension asked the
    operator, and the operator re-typed what was already on disk.
    """
    project_root = project_root.resolve()
    modules = _default_modules(project_root, service, modules)
    prompt = start_instruction(project_root, service, modules, session_id, portable=portable)
    hint = start_hint if (start_hint and start_hint.strip()) else _read_start_hint(
        project_root, service
    )
    start_commands_json = str(_start_commands_path(project_root, service))
    if hint:
        prompt = _user_hint_instruction(prompt, service, hint, start_commands_json)
    else:
        # No operator hint — fall back to what discovery already recorded rather
        # than making the agent re-derive it. The operator still wins when they
        # have answered, because they may know discovery got it wrong.
        discovered = _discovered_command(project_root, service)
        if discovered:
            prompt = _discovered_command_instruction(
                prompt, service, discovered, start_commands_json
            )
    if inline_handbook:
        block = _handbook_inline_block(project_root)
        if block:
            prompt = block + prompt
    return prompt


# ── Handbook location / validation ───────────────────────────────

def _handbook_path(project_root: Path) -> Path:
    return (project_root / HANDBOOK_REL).resolve()


def expect_vinv_handbook(project_root: Path) -> Path:
    """Return resolved ``.vinv/vinv.md`` or raise if discovery did not produce one.

    The bring-up agent reads the handbook and decides what to execute; the
    handbook can be prose, fenced blocks, or any mix. The only contract here
    is that the file exists and is readable.
    """
    hb = _handbook_path(project_root)
    if not hb.is_file():
        msg = (
            f"Vinv handbook not found at {hb}. Run Stage 1 (Discovery / handbook) "
            "first so `.vinv/vinv.md` exists."
        )
        raise FileNotFoundError(msg)
    try:
        hb.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise FileNotFoundError(f"Could not read handbook at {hb}: {exc}") from exc
    return hb


# ── Services inventory location / parsing ────────────────────────

def _services_path(project_root: Path) -> Path:
    return (project_root / SERVICES_REL).resolve()


def _read_services(project_root: Path) -> list[dict[str, Any]]:
    """Read and parse ``<repo>/.vinv/services.json`` into a list of service dicts.

    Raises ``RuntimeError`` if the file is missing, unreadable, malformed, or
    does not contain a ``services`` array.
    """
    path = _services_path(project_root)
    if not path.is_file():
        raise RuntimeError(
            f"Service inventory missing after TerminalExecutor: {path}. The list "
            "agent did not write .vinv/services.json."
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not parse service inventory at {path}: {exc}") from exc
    services = data.get("services") if isinstance(data, dict) else None
    if not isinstance(services, list):
        raise RuntimeError(
            f"Service inventory at {path} has no 'services' array (got {type(services).__name__})."
        )
    return services


# A `python -m module:attr` command can never run: `-m` takes a module, the
# `module:attr` form is an ASGI app-factory reference (uvicorn syntax). Agents
# splice the two together routinely; catch it before the file ships.
_MODULE_COLON_RE = re.compile(r"-m\s+[A-Za-z_][\w.]*:\S+")

# Valid `kind` values for services.json entries. The original two survive
# unchanged (back-compat); `python_stdio` covers stdio JSON-RPC servers (MCP
# and the like — long-running, port-less, spoken to over stdin/stdout) and
# `python_scheduler` covers beat/cron-style processes whose only observable
# behavior is staying alive and firing jobs.
_INVENTORY_KINDS: tuple[str, ...] = (
    "python_web", "python_worker", "python_stdio", "python_scheduler",
)
# Optional additive `transport` field: how the service is spoken to.
_INVENTORY_TRANSPORTS: tuple[str, ...] = ("http", "stdio")


def _validate_services_inventory(
    services: list[Any], project_root: Path | None = None
) -> list[str]:
    """Deterministically validate the agent-written service inventory.

    Returns a list of human-readable violations (empty ⇒ valid). This is the
    harness-side gate for the contract the list prompt states: import-package
    ``modules`` (tracelens ``--target-package`` can only ever match a valid
    Python identifier), runnable ``command`` forms, real working directories,
    and a port for anything claiming to serve HTTP.

    When ``project_root`` is given, each module is additionally checked against
    the distribution discovery: a module that is not an importable package
    anywhere in the repo can never match ``--target-package``, so tracelens
    would silently record framework spans only (no function-level trace). The
    classic failure is writing the DISTRIBUTION name (``admin``) instead of the
    import package (``vinv_admin``); the violation message names the correct
    package(s) for that distribution so the agent can fix it in one round.
    """
    issues: list[str] = []
    known_packages: set[str] = set()
    dist_packages: dict[str, tuple[str, ...]] = {}
    if project_root is not None:
        for dist in _discover_distributions(project_root):
            known_packages.update(dist.packages)
            dist_packages.setdefault(dist.name, dist.packages)
        if not known_packages:
            # No packaging metadata anywhere: fall back to the flat scan,
            # exactly as _discover_traceable_packages does. Never mix the two —
            # the flat scan counts directory names, which is the very confusion
            # this grounding exists to reject.
            known_packages.update(_flat_scan_fallback(project_root))
    if not services:
        issues.append("the `services` array is empty — at least one Python service is required")
    seen_names: set[str] = set()
    for i, svc in enumerate(services):
        label = f"services[{i}]"
        if not isinstance(svc, dict):
            issues.append(f"{label}: entry is not a JSON object")
            continue
        name = svc.get("name")
        if not isinstance(name, str) or not name.strip():
            issues.append(f"{label}: `name` is missing or empty")
        else:
            label = f"services[{i}] (`{name}`)"
            if name in seen_names:
                issues.append(f"{label}: duplicate service name")
            seen_names.add(name)

        kind = svc.get("kind")
        if kind not in _INVENTORY_KINDS:
            allowed = ", ".join(f"'{k}'" for k in _INVENTORY_KINDS)
            issues.append(f"{label}: `kind` must be one of {allowed} (got {kind!r})")

        transport = svc.get("transport")
        if transport is not None and transport not in _INVENTORY_TRANSPORTS:
            allowed_t = ", ".join(f"'{t}'" for t in _INVENTORY_TRANSPORTS)
            issues.append(
                f"{label}: `transport` must be one of {allowed_t} or null (got {transport!r})"
            )
        if kind == "python_stdio" and transport not in (None, "stdio"):
            issues.append(
                f"{label}: kind=python_stdio serves over stdin/stdout — `transport` must be "
                f"'stdio' or omitted (got {transport!r})"
            )
        if kind == "python_web" and transport not in (None, "http"):
            issues.append(
                f"{label}: kind=python_web serves HTTP — `transport` must be 'http' or "
                f"omitted (got {transport!r})"
            )

        modules = svc.get("modules")
        if not isinstance(modules, list) or not modules:
            issues.append(f"{label}: `modules` must be a non-empty list of import package names")
        else:
            for m in modules:
                if not isinstance(m, str) or not m.isidentifier():
                    issues.append(
                        f"{label}: modules entry {m!r} is not an importable Python identifier — "
                        "`tracelens --target-package` can never match it. Use the import package "
                        "name (e.g. `vinv_payment`), never a directory/distribution name with `-`."
                    )
                elif known_packages and m not in known_packages:
                    hint = dist_packages.get(m)
                    correction = (
                        f" This looks like the DISTRIBUTION name; its import package(s) are "
                        f"{', '.join(f'`{p}`' for p in hint)} — use those instead."
                        if hint
                        else (
                            " Valid import packages discovered in this repo: "
                            + ", ".join(f"`{p}`" for p in sorted(known_packages)) + "."
                        )
                    )
                    issues.append(
                        f"{label}: modules entry {m!r} is not an import package anywhere in this "
                        "repo — tracelens would instrument nothing (framework spans only, no "
                        f"function trace).{correction}"
                    )

        command = svc.get("command")
        if not isinstance(command, str) or not command.strip():
            issues.append(f"{label}: `command` is missing or empty")
        else:
            if _MODULE_COLON_RE.search(command):
                issues.append(
                    f"{label}: command {command!r} uses `-m <module>:<attr>` — `-m` takes a module, "
                    "the `module:attr` form is an app-factory reference. Use the project's console "
                    "script, or `python -m uvicorn <module>:<attr> --host … --port …` for ASGI apps."
                )
            if command.lstrip().startswith(("docker", "docker-compose")):
                issues.append(
                    f"{label}: command must be the native Python start command, not docker "
                    f"(got {command!r})"
                )

        wd = svc.get("working_directory")
        if wd is not None and (not isinstance(wd, str) or not Path(wd).is_dir()):
            issues.append(f"{label}: working_directory {wd!r} is not an existing directory")

        port = svc.get("port")
        port_ok = isinstance(port, int) and not isinstance(port, bool) and 0 < port < 65536
        if kind == "python_web" and not port_ok:
            issues.append(f"{label}: kind=python_web requires an integer `port` 1-65535 (got {port!r})")
        elif kind == "python_stdio" and port is not None:
            issues.append(
                f"{label}: kind=python_stdio serves over stdin/stdout, not a socket — "
                f"`port` must be null (got {port!r})"
            )
        elif port is not None and not port_ok:
            issues.append(f"{label}: `port` must be an integer 1-65535 or null (got {port!r})")
    return issues


def _list_feedback_instruction(
    base_instruction: str, services_json: str, issues: list[str]
) -> str:
    """Extend the list instruction with the concrete validation failures.

    Mirrors the replay-gate feedback pattern of Stage 2b: the agent gets the
    same task plus exactly what the harness rejected about the file it wrote,
    so the ReAct loop can fix the inventory instead of shipping it broken.
    """
    bullet_list = "\n".join(f"- {issue}" for issue in issues)
    return (
        f"{base_instruction}\n\n"
        "### ⚠️ INVENTORY VALIDATION FAILED — fix the file you already wrote\n\n"
        f"You (or a previous attempt) already wrote `{services_json}`, but harness "
        "validation rejected it:\n\n"
        f"{bullet_list}\n\n"
        "Fix ONLY these problems (re-reading the handbook / pyproject files as needed), "
        "then save the corrected full JSON with `save_file` again. Do not drop valid "
        "entries while fixing the invalid ones."
    )


def _default_modules(project_root: Path, service: str, modules: list[str] | None) -> list[str]:
    """Resolve the instrumentation modules for ``service`` when none were passed.

    Priority: caller-passed modules → the service's own ``modules`` recorded in
    ``.vinv/services.json`` (Stage 2a is the authority on the dist-name →
    import-package mapping) → the service name itself when it is a valid import
    identifier → empty, which makes :func:`start_instruction` fall back to
    repo-wide auto-discovery.

    Every candidate is then grounded against the repo's distribution discovery:
    a name that is a DISTRIBUTION (e.g. ``admin``) is remapped to its import
    package(s) (``vinv_admin``), because ``tracelens --target-package`` matches
    module fullnames — a non-package name silently records framework spans
    only, which is exactly the "runtime view is empty" failure mode.
    """
    resolved = [m for m in (modules or []) if m]
    if not resolved:
        try:
            for svc in _read_services(project_root):
                if isinstance(svc, dict) and svc.get("name") == service:
                    resolved = [
                        m for m in svc.get("modules", [])
                        if isinstance(m, str) and m.isidentifier()
                    ]
                    break
        except RuntimeError:
            pass
    if not resolved and service.isidentifier():
        resolved = [service]

    if not resolved:
        return []

    known_packages: set[str] = set()
    dist_packages: dict[str, tuple[str, ...]] = {}
    for dist in _discover_distributions(project_root):
        known_packages.update(dist.packages)
        dist_packages.setdefault(dist.name, dist.packages)
    if not known_packages:
        # No discovery signal (e.g. bare script repos): trust the input.
        return resolved

    grounded: list[str] = []
    for m in resolved:
        if m in known_packages:
            grounded.append(m)
        elif m in dist_packages:
            # The ONE transformation worth making, because it is the only one where
            # a better answer is actually known: a DISTRIBUTION name (`admin`) is
            # replaced by the import package(s) it ships (`vinv_admin`), which is
            # what `--target-package` matches on.
            grounded.extend(dist_packages[m])
        else:
            # PASS IT THROUGH. Anything else is not ours to delete.
            #
            # This branch used to drop the target, and that deletion cost a full
            # day of debugging: `examples/` is a PEP 420 namespace directory (no
            # __init__.py), so it is not an "import package" and not a
            # distribution — and the service's entrypoint lived inside it. The
            # target was silently removed, the rendered prompt then instructed the
            # agent to use the filtered list "verbatim — do not add any package
            # names", and every bring-up dutifully recorded a command that could
            # not trace the service's own handlers. The check added to prevent
            # "framework spans only" produced exactly that.
            #
            # Deleting was never justified, because tracelens already resolves
            # these cases and is deliberately permissive about them (see
            # launcher/targets.split_targets): a regular package matches by module
            # fullname, a non-importable DIRECTORY becomes a source root and
            # instruments the files under it, and an unresolvable name is kept as
            # an import name in case the target only becomes importable after the
            # app mutates sys.path at startup. Three strategies, all downstream of
            # here — so a filter here can only ever throw away information the
            # component that knows best was about to use.
            grounded.append(m)
            if not (project_root / m).is_dir():
                logger.info(
                    "bringup: module %r for service %r is not an import package, a "
                    "distribution, or a repo directory — forwarding it to tracelens "
                    "anyway; it resolves targets itself",
                    m,
                    service,
                )
    return list(dict.fromkeys(grounded))


def _start_commands_path(project_root: Path, service: str) -> Path:
    """Resolve the per-service verified-start-commands file path.

    The service name is sanitised into a filesystem-safe slug so a service like
    ``api/v2`` can't escape the ``.vinv/start_commands`` directory.
    """
    slug = re.sub(r"[^A-Za-z0-9_.-]", "_", service) or "service"
    return (project_root / START_COMMANDS_DIR_REL / f"{slug}.json").resolve()


def _start_hints_path(project_root: Path, service: str) -> Path:
    """Resolve the per-service operator start-hint file path.

    Same sanitising as :func:`_start_commands_path` — a service like ``api/v2``
    must not escape the ``.vinv/start_hints`` directory.
    """
    slug = re.sub(r"[^A-Za-z0-9_.-]", "_", service) or "service"
    return (project_root / START_HINTS_DIR_REL / f"{slug}.json").resolve()


def _read_start_hint(project_root: Path, service: str) -> str | None:
    """Return the operator's recorded start command for ``service``, if any.

    This is the "persist and reuse" half of the hint flow: the host asks the
    operator once (after a bring-up failure), writes the answer here, and every
    later ``start`` for that service picks it up automatically without asking
    again. Best-effort by design — a missing, unreadable, malformed, or blank
    hint is simply "no hint", never an error, because a bring-up that would have
    run without a hint must still run.
    """
    path = _start_hints_path(project_root, service)
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return None
    command = data.get("command") if isinstance(data, dict) else None
    if not isinstance(command, str) or not command.strip():
        return None
    return command.strip()


def _read_start_commands(project_root: Path, service: str) -> dict[str, Any]:
    """Read and parse the verified start-commands file the start agent wrote.

    Raises ``RuntimeError`` if the file is missing, unreadable, malformed, or
    does not contain a ``commands`` array.
    """
    path = _start_commands_path(project_root, service)
    if not path.is_file():
        raise RuntimeError(
            f"Verified start commands missing after TerminalExecutor: {path}. The "
            "start agent did not record the commands it used to bring up "
            f"{service!r} (it must start AND verify the service, then write this file)."
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not parse start commands at {path}: {exc}") from exc
    commands = data.get("commands") if isinstance(data, dict) else None
    if not isinstance(commands, list):
        raise RuntimeError(
            f"Start commands at {path} has no 'commands' array (got {type(commands).__name__})."
        )
    return data


# ── Replay verification gate ─────────────────────────────────────
#
# The agent verifies the service inside ITS OWN PTY session, but the artifact it
# saves is consumed by a different program with different semantics: the VS Code
# extension replays each `command` string verbatim via `bash -lc` and treats the
# spawned process's lifetime as the service's lifetime. An agent that records
# the backgrounded form it happened to type (`… > /tmp/x.log 2>&1 & echo $!`)
# produces a file whose replay exits instantly with code 0 — the UI reports the
# service as dead while the real server runs on orphaned in the background,
# squatting the port for every later launch. Nothing in the agent's own
# verification can catch that, so the harness replays the saved file exactly
# like the extension will, and feeds a failure back into the ReAct loop.

def _replay_script(commands: list[dict[str, Any]]) -> str:
    """Build the exact `bash -lc` script the VS Code serviceRunner builds.

    Earlier entries are detached dependency starts (`docker compose up -d …`);
    the final entry is the long-running server, left in the foreground so its
    exit ends the replay process.
    """
    parts: list[str] = []
    for c in commands:
        cmd = str(c.get("command", "")).strip()
        wd = c.get("working_directory")
        parts.append(f'cd "{wd}" && {cmd}' if wd else cmd)
    return " && ".join(parts)


def _port_is_serving(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False


def _resolve_bash() -> str | None:
    """Bash used to replay recorded start commands, on any platform.

    Mirrors the extension's ``resolveBash`` (vinv-vs/src/proc.ts): on Windows
    only Git for Windows' bash will do — ``System32\\bash.exe`` is the WSL
    launcher and fails with "no installed distributions" on machines without a
    WSL distro, which is most of them. POSIX prefers the well-known locations
    before PATH.
    """
    if os.name != "nt":
        for cand in ("/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash",
                     "/opt/homebrew/bin/bash"):
            if os.path.exists(cand):
                return cand
        return shutil.which("bash")
    candidates: list[str] = []
    for root_var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        root = os.environ.get(root_var)
        if root:
            candidates.append(os.path.join(root, "Git", "bin", "bash.exe"))
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if not d:
            continue
        if os.path.basename(d.rstrip("\\/")).lower() == "system32":
            continue  # WSL's bash.exe
        candidates.append(os.path.join(d, "bash.exe"))
        if os.path.exists(os.path.join(d, "git.exe")):
            # <install>\cmd\git.exe → <install>\bin\bash.exe
            candidates.append(os.path.normpath(os.path.join(d, "..", "bin", "bash.exe")))
    for cand in candidates:
        if os.path.exists(cand):
            return cand
    return None


def _listening_pids(port: int) -> set[str]:
    """PIDs currently LISTENING on ``port``, per netstat. Empty on any failure."""
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, timeout=15
        ).stdout
    except Exception:
        logger.warning("bringup_reap_netstat_failed port=%s", port, exc_info=True)
        return set()
    pids: set[str] = set()
    for line in out.splitlines():
        parts = line.split()
        if (
            len(parts) >= 5
            and parts[0] == "TCP"
            and parts[1].endswith(f":{port}")
            and parts[3] == "LISTENING"
        ):
            pids.add(parts[4])
    return pids


def _process_start_time(pid: int) -> float | None:
    """Unix-epoch seconds at which ``pid`` started, or None if unreadable.

    Reads GetProcessTimes over ctypes rather than shelling out. The probe this
    replaces launched ``powershell -NoProfile`` per candidate PID, which costs
    seconds and, on a loaded machine, overran its 15s timeout — and the reaper
    swallowed that as "cannot tell", leaving the squatter alive to fail every
    later replay. A few syscalls cannot time out.

    Imported here, not at module scope: ``ctypes.wintypes`` raises on POSIX,
    and only the Windows teardown path reaches this.
    """
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    FILETIME_TO_UNIX_EPOCH = 11644473600.0  # seconds between 1601-01-01 and 1970-01-01
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not k32.GetProcessTimes(
            handle, ctypes.byref(created), ctypes.byref(exited),
            ctypes.byref(kernel), ctypes.byref(user),
        ):
            return None
        # FILETIME counts 100-nanosecond intervals since 1601-01-01 UTC.
        ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
        return ticks / 1e7 - FILETIME_TO_UNIX_EPOCH
    finally:
        k32.CloseHandle(handle)


def _reap_windows_port_orphan(
    port: int, replay_wall_started: float, window_s: float = 10.0
) -> None:
    """Kill a `&`-backgrounded child that survived teardown as a port squatter.

    On Windows ``taskkill /T`` walks the live tree — but the incident case is a
    bash that exited instantly, so by teardown time its backgrounded child has
    been reparented and the tree walk finds nothing. Find whoever is LISTENING
    on the replay port, and kill it only if it started after this replay began,
    so a pre-existing legitimate server is never touched.

    Watched across a window rather than sampled once, because teardown races the
    squatter: bash spawns the child and exits milliseconds later, so the child
    usually has not BOUND yet when teardown runs. A single sample sees a bare
    port and reports clean — then the orphan surfaces just afterwards and holds
    the port, answering the probe of every later replay so it passes in
    milliseconds without having started anything. Watching costs a socket
    connect per tick; netstat runs only once something is actually listening.
    """
    deadline = time.monotonic() + window_s
    while True:
        if _port_is_serving(port):
            reaped = False
            for pid in _listening_pids(port):
                started = _process_start_time(int(pid)) if pid.isdigit() else None
                if started is None:
                    logger.warning(
                        "bringup_reap_start_time_unreadable port=%s pid=%s", port, pid
                    )
                    continue
                if started >= replay_wall_started - 2.0:
                    logger.info("bringup_reap_orphan port=%s pid=%s", port, pid)
                    subprocess.run(
                        ["taskkill", "/PID", pid, "/T", "/F"],
                        capture_output=True, check=False,
                    )
                    reaped = True
            # Done as soon as the squatter is gone; only an empty port has to
            # wait out the window, since a late binder is still possible.
            if reaped and not _port_is_serving(port):
                return
        if time.monotonic() >= deadline:
            return
        time.sleep(0.25)


def _terminate_process_group(proc: subprocess.Popen[bytes]) -> None:
    """Tear down the replay's whole process tree, escalating if it lingers.

    POSIX signals the process group (TERM, then KILL). Windows has neither
    ``os.killpg`` nor ``SIGKILL`` — resolving them eagerly would crash at
    call time — so the tree is walked and force-killed via ``taskkill /T``.
    """
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True, check=False,
        )
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.2)
        return
    for name, grace in (("SIGTERM", 8.0), ("SIGKILL", 4.0)):
        try:
            os.killpg(proc.pid, getattr(signal, name))
        except (ProcessLookupError, PermissionError):
            return
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.2)


# A JSON-RPC initialize request in the MCP stdio dialect — the default probe
# request when the recorded `probe` carries none. Any JSON line back within
# the deadline counts as readiness; we are proving "this command starts a
# process that speaks line-delimited JSON-RPC on stdio", not exercising the
# server's full capability negotiation.
_DEFAULT_STDIO_INIT_REQUEST: dict[str, Any] = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "vinv-bringup-replay", "version": "0"},
    },
}


def _verify_stdio_replay(
    project_root: Path,
    service: str,
    script: str,
    probe: dict[str, Any],
    bash: str,
    deadline_s: float,
) -> dict[str, Any]:
    """Readiness probe for a stdio JSON-RPC server: an initialize round-trip.

    A stdio server has no port to poll, so the only honest oracle is the one
    its real client (an MCP host) uses: spawn the recorded command, write one
    JSON-RPC initialize line to its stdin, and require ANY parseable JSON line
    on stdout before the deadline. Non-JSON banner/log lines on stdout are
    tolerated and skipped; the process exiting before it responds is the
    definitive failure. The replay is always torn down afterwards.
    """
    request = probe.get("request")
    if not isinstance(request, dict) or not request:
        request = _DEFAULT_STDIO_INIT_REQUEST
    log = tempfile.NamedTemporaryFile(
        mode="w+b", prefix=f"vinv_replay_{service}_stdio_", suffix=".log", delete=False
    )
    popen_kwargs: dict[str, Any] = (
        {} if os.name == "nt" else {"start_new_session": True}
    )
    started = time.monotonic()
    proc = subprocess.Popen(
        [bash, "-lc", script],
        cwd=str(project_root),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=log,
        **popen_kwargs,
    )

    def _tail() -> str:
        try:
            with open(log.name, "rb") as f:
                f.seek(max(0, os.path.getsize(log.name) - 4096))
                return f.read().decode("utf-8", errors="replace")
        except OSError:
            return ""

    lines: queue.Queue[bytes] = queue.Queue()

    def _reader() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            lines.put(raw)

    threading.Thread(target=_reader, daemon=True).start()

    try:
        try:
            assert proc.stdin is not None
            proc.stdin.write((json.dumps(request) + "\n").encode("utf-8"))
            proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass  # the exit branch below reports the real failure
        while True:
            elapsed = time.monotonic() - started
            try:
                raw = lines.get(timeout=0.5)
            except queue.Empty:
                raw = None
            if raw is not None:
                try:
                    json.loads(raw.decode("utf-8", errors="replace"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue  # banner/log noise on stdout — keep reading
                return {
                    "ok": True,
                    "seconds": round(time.monotonic() - started, 1),
                    "port": None,
                    "probe": "stdio-jsonrpc",
                    "response_line": raw.decode("utf-8", errors="replace").strip()[:500],
                }
            code = proc.poll()
            if code is not None and lines.empty():
                return {
                    "ok": False,
                    "reason": (
                        f"replay process exited with code {code} after {elapsed:.1f}s "
                        "before answering the JSON-RPC initialize probe — a stdio "
                        "server must keep running in the FOREGROUND and respond to an "
                        "initialize line on stdin with a JSON line on stdout"
                    ),
                    "exit_code": code,
                    "seconds": round(elapsed, 1),
                    "output_tail": _tail(),
                }
            if elapsed >= deadline_s:
                return {
                    "ok": False,
                    "reason": (
                        f"deadline: no JSON-RPC response line on stdout within "
                        f"{deadline_s:.0f}s of writing the initialize request"
                    ),
                    "seconds": round(elapsed, 1),
                    "output_tail": _tail(),
                }
    finally:
        _terminate_process_group(proc)
        log.close()
        logger.info("bringup_replay_done service=%s probe=stdio-jsonrpc", service)


def verify_replay(
    project_root: Path,
    service: str,
    data: dict[str, Any],
) -> dict[str, Any]:
    """Replay the saved start-commands file exactly as the extension will.

    Runs the composed script via ``bash -lc`` in a fresh process group and
    decides success on *evidence*, not fixed timing:

    - the replay process **exiting** (any code) before the service serves is the
      definitive failure — a correct final entry is a foreground server that
      never returns;
    - when a port is recorded, success is the port **accepting a connection**
      while the replay process is still alive (polled, so a slow boot just takes
      longer);
    - with no recorded port, success is the process still running once the
      grace window passes (there is no cheaper oracle for a portless worker).

    The recorded ``verification.probe`` object (``{"type": …}``) selects the
    readiness oracle explicitly, so non-HTTP services verify honestly:

    - ``{"type": "port"}`` — the default when a port is recorded (behavior
      above, unchanged);
    - ``{"type": "stdio-jsonrpc"}`` — for stdio JSON-RPC servers (MCP style):
      spawn the command, write one JSON-RPC initialize line (``probe.request``
      when given, a standard initialize otherwise) to stdin, and require a JSON
      line on stdout before the deadline (see :func:`_verify_stdio_replay`);
    - ``{"type": "process"}`` — an explicitly declared long-runner with no
      cheaper oracle: alive past the grace window passes, exiting before it
      (even cleanly) fails. Without a declared probe, a portless clean exit
      keeps the legacy worker semantics (exit 0 + refreshed trace = pass).

    Every polling path is bounded by an ABSOLUTE wall-clock deadline
    (``VINV_REPLAY_DEADLINE_S``, default 180s): a process that stays alive but
    never serves returns ``{"ok": false, "reason": "deadline: …"}`` instead of
    being polled forever.

    Always tears the replay down afterwards (kills the process group) so no
    orphan is left holding the port. Returns a result dict; never raises for a
    failed replay — the caller feeds failures back into the agent loop.
    """
    commands = [c for c in data.get("commands", []) if isinstance(c, dict)]
    if not commands:
        return {"ok": False, "reason": "no commands recorded", "output_tail": ""}

    script = _replay_script(commands)
    verification = data.get("verification") or {}
    port = verification.get("port") if isinstance(verification, dict) else None
    port = int(port) if isinstance(port, (int, float)) and int(port) > 0 else None

    probe = verification.get("probe") if isinstance(verification, dict) else None
    probe = probe if isinstance(probe, dict) else None
    probe_type = probe.get("type") if probe else None
    if probe_type not in (None, "port", "stdio-jsonrpc", "process"):
        return {
            "ok": False,
            "reason": (
                f"unknown probe type {probe_type!r} in verification.probe — "
                "supported types: 'port', 'stdio-jsonrpc', 'process'"
            ),
            "output_tail": "",
        }
    if probe_type == "port" and port is None:
        p = probe.get("port") if probe else None
        port = int(p) if isinstance(p, (int, float)) and int(p) > 0 else None
        if port is None:
            return {
                "ok": False,
                "reason": "probe type 'port' but no port recorded in verification",
                "output_tail": "",
            }
    if probe_type in ("stdio-jsonrpc", "process"):
        # These oracles are port-less by definition; ignore any stray port.
        port = None
    explicit_process = probe_type == "process"

    budget_s = float(os.environ.get("VINV_BRINGUP_REPLAY_BUDGET_S", "240"))
    portless_grace_s = float(os.environ.get("VINV_BRINGUP_REPLAY_GRACE_S", "12"))
    # Absolute wall-clock cap on the whole polling loop — the guarantee that a
    # replay can NEVER hang: a process that stays alive but never serves is
    # returned as a deadline failure instead of being polled forever. This is
    # deliberately separate from (and defaults tighter than) the budget above,
    # so even a mis-set budget cannot re-open the unbounded-wait bug.
    deadline_s = float(os.environ.get("VINV_REPLAY_DEADLINE_S", "180"))

    # /bin/bash does not exist on Windows; the extension there runs the same
    # script through Git Bash, so resolve it the same way. `start_new_session`
    # is POSIX-only — on Windows teardown walks the tree via taskkill instead.
    bash = _resolve_bash()
    if bash is None:
        raise RuntimeError(
            "replay verification needs bash (`/bin/bash` or `bash` on PATH; on "
            "Windows install Git for Windows — its bundled bash is used, never "
            "WSL's System32 stub) — the extension replays start commands "
            "through it, so a machine without bash cannot run the service either."
        )

    if probe_type == "stdio-jsonrpc":
        logger.info(
            "bringup_replay_start service=%s probe=stdio-jsonrpc script=%s",
            service, script[:300],
        )
        return _verify_stdio_replay(
            project_root, service, script, probe or {}, bash, deadline_s
        )

    log = tempfile.NamedTemporaryFile(
        mode="w+b", prefix=f"vinv_replay_{service}_", suffix=".log", delete=False
    )
    logger.info(
        "bringup_replay_start service=%s port=%s probe=%s script=%s log=%s",
        service, port, probe_type or ("port" if port is not None else "process"),
        script[:300], log.name,
    )
    popen_kwargs: dict[str, Any] = (
        {} if os.name == "nt" else {"start_new_session": True}  # own group: teardown reaps children
    )
    started = time.monotonic()
    proc = subprocess.Popen(
        [bash, "-lc", script],
        cwd=str(project_root),
        stdout=log,
        stderr=subprocess.STDOUT,
        **popen_kwargs,
    )

    def _tail() -> str:
        try:
            with open(log.name, "rb") as f:
                f.seek(max(0, os.path.getsize(log.name) - 4096))
                return f.read().decode("utf-8", errors="replace")
        except OSError:
            return ""

    # A portless entry is a WORKER: running to completion is its success mode,
    # unlike a server which must stay up. A clean exit passes when the traced
    # output file was refreshed by THIS replay (proof the workload really ran
    # in the foreground rather than a `&`-backgrounded shell exiting early).
    trace_path = verification.get("trace_jsonl") if isinstance(verification, dict) else None
    replay_wall_started = time.time()

    def _trace_refreshed() -> bool:
        if not isinstance(trace_path, str) or not trace_path:
            return True  # nothing recorded to check against
        try:
            return os.path.getmtime(trace_path) >= replay_wall_started - 1.0
        except OSError:
            return False

    try:
        while True:
            elapsed = time.monotonic() - started
            code = proc.poll()
            if code is not None:
                if (
                    port is None and code == 0
                    and not explicit_process and _trace_refreshed()
                ):
                    return {
                        "ok": True,
                        "seconds": round(elapsed, 1),
                        "port": None,
                        "worker_completed": True,
                    }
                result = {
                    "ok": False,
                    "reason": (
                        f"replay process exited with code {code} after {elapsed:.1f}s — a "
                        "verified start command must keep the server in the FOREGROUND "
                        "(no trailing '&', no 'echo $!', no output redirection to files)"
                        + (
                            "; probe type 'process' declares a long-runner, so exiting "
                            "before the grace window fails even with exit code 0"
                            if explicit_process else (
                                "; a portless worker may exit 0 but must refresh its "
                                "recorded trace output when it does"
                                if port is None else ""
                            )
                        )
                    ),
                    "exit_code": code,
                    "seconds": round(elapsed, 1),
                    "output_tail": _tail(),
                }
                # A clean, quick exit WITH NO SURVIVORS is affirmative evidence
                # of a run-to-completion CLI, not a broken service. Surface it
                # as a classification so the orchestrator can SKIP it (terminal
                # "not a service") instead of burning retry + fix budgets — the
                # historical get-stuck mode for misclassified console scripts.
                # The survivor check is what separates this from the
                # backgrounded-command incident (`server & echo $!` also exits
                # 0 fast but leaves the real process running in the group).
                if code == 0 and elapsed < portless_grace_s and port is None:
                    survivors = False
                    if os.name != "nt":
                        # start_new_session=True makes the leader pid the pgid;
                        # signal-0 the GROUP directly (getpgid on the dead
                        # leader would raise even when orphans survive).
                        try:
                            os.killpg(proc.pid, 0)
                            survivors = True
                        except (ProcessLookupError, OSError):
                            survivors = False
                    # Exit 0 with error-looking output is a FAILING service that
                    # lies about its exit code (e.g. "address already in use"
                    # then sys.exit(0)) — never reclassify those: they must stay
                    # on the retry/fix path, not be silently skipped.
                    tail_text = _tail().lower()
                    looks_broken = any(
                        marker in tail_text
                        for marker in (
                            "error", "exception", "traceback", "refused",
                            "cannot", "failed", "fatal", "denied",
                        )
                    )
                    if not survivors and not looks_broken:
                        result["verdict"] = "not-a-service"
                        result["reason"] = (
                            f"ran to completion in {elapsed:.1f}s (exit 0, no surviving "
                            "processes, clean output) — this looks like a run-to-completion "
                            "CLI, not a long-running service; reclassify as kind=cli and "
                            "skip bring-up"
                        )
                return result
            if port is not None and _port_is_serving(port):
                return {"ok": True, "seconds": round(elapsed, 1), "port": port}
            if port is None and elapsed >= portless_grace_s:
                result = {"ok": True, "seconds": round(elapsed, 1), "port": None}
                if explicit_process:
                    result["probe"] = "process"
                return result
            if elapsed >= deadline_s:
                return {
                    "ok": False,
                    "reason": (
                        f"deadline: port {port if port is not None else '(none)'} "
                        f"never served within {deadline_s:.0f}s"
                    ),
                    "seconds": round(elapsed, 1),
                    "output_tail": _tail(),
                }
            if elapsed >= budget_s:
                return {
                    "ok": False,
                    "reason": (
                        f"replay process stayed alive but port {port} never accepted a "
                        f"connection within {budget_s:.0f}s"
                    ),
                    "seconds": round(elapsed, 1),
                    "output_tail": _tail(),
                }
            time.sleep(0.5)
    finally:
        _terminate_process_group(proc)
        if os.name == "nt" and port is not None:
            _reap_windows_port_orphan(port, replay_wall_started)
        log.close()
        logger.info("bringup_replay_done service=%s", service)


def _write_replay_script_file(project_root: Path, service: str, data: dict[str, Any]) -> Path:
    """Write a human-runnable `<service>.sh` next to the JSON deliverable.

    The JSON stores the command with JSON string escaping (`\\"` for every
    quote), so copy-pasting it raw into a shell injects literal backslashes and
    corrupts PATH-style assignments. The .sh file is the unescaped, directly
    runnable form: `bash .vinv/start_commands/<service>.sh`.
    """
    path = _start_commands_path(project_root, service).with_suffix(".sh")
    commands = [c for c in data.get("commands", []) if isinstance(c, dict)]
    lines = ["#!/bin/bash", f"# Verified start command(s) for {service!r} — generated by bringup.", ""]
    for c in commands:
        wd = c.get("working_directory")
        if wd:
            lines.append(f'cd "{wd}"')
        lines.append(str(c.get("command", "")).strip())
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def _user_hint_instruction(
    base_instruction: str, service: str, hint: str, start_commands_json: str
) -> str:
    """Extend the start instruction with how the OPERATOR starts the service.

    Folded into the *base* instruction (not a per-round suffix) so it survives
    every replay/unverified round — the operator's answer is standing evidence
    about this repo, not feedback about one attempt.

    The hint resolves the hardest half of bring-up (WHICH command starts this
    service, which the agent otherwise infers from the handbook) while leaving
    the other half untouched: the deliverable is still the *traced* command, and
    ``verified:true`` still requires the tracelens-wrapped form to actually
    serve. The framing below is deliberate — the hint is a starting point to
    trace, never a shortcut to record.
    """
    return (
        f"{base_instruction}\n\n"
        "### ✅ THE OPERATOR TOLD US HOW THEY START THIS SERVICE — start from this command\n\n"
        f"The human who owns this repo says they start `{service}` with:\n\n"
        f"```bash\n{hint.strip()}\n```\n\n"
        "**Treat this as the authoritative answer to \"what starts this service\".** It "
        "beats the handbook, the Dockerfile `CMD`, and any command you would have "
        "inferred — it is what actually works on this machine. It was recorded because "
        "a previous bring-up FAILED to work it out, so do not re-derive it and do not "
        "silently substitute your own. Note it may be a wrapper (`make run`, `just dev`, "
        "`npm start`, a shell script) rather than the underlying process.\n\n"
        "Use it in this order:\n\n"
        "1. **Run it as given first** (correct working directory, deps installed per the "
        "install rules above) and confirm it actually serves — port LISTENing + a real "
        "request answered. This proves the operator's command works here before you "
        "change anything about it. If it fails as given, the operator's environment "
        "assumptions are the thing to diagnose (missing `.env`, a dependency they "
        "already had running, wrong directory) — fix that rather than abandoning their "
        "command for one of your own.\n"
        "2. **Then convert it to the tracelens-wrapped form** per \"How to start a Python "
        "service under tracelens\" above — unwrap it down to the real `python -m <module> "
        "<args>` invocation (read the Makefile/justfile/script/`package.json` if it is a "
        "wrapper), drop `--reload`, and wrap THAT with the exact `--target-package` flags "
        "and the session-scoped `--output` path. Keep the operator's env vars, working "
        "directory, port, and arguments intact — those are the parts you must not "
        "invent.\n"
        "3. **Verify the WRAPPED form serves** (port + request + growing `trace.jsonl`) "
        "and record that traced command in `commands`.\n\n"
        "**The hint does NOT relax the deliverable — no trace, no `verified:true`.** "
        "Recording the operator's plain untraced command as `verified:true` is a WRONG "
        "answer even though it would start the service: an untraced service produces an "
        "empty trace and every downstream Vinv stage (baseline, identification, RCA) has "
        "nothing to work with. The `verified:true` bar is exactly what it was before this "
        "hint existed — for a Python service that means the tracelens-wrapped command "
        "serves AND `trace.jsonl` has a non-zero line count. If you genuinely cannot get "
        "the traced form working, record `verified:false` with the specific blocker in "
        f"`failure_symptom` and save `{start_commands_json}` anyway — an honest "
        "`verified:false` is worth more than a start command that traces nothing."
    )


def _discovered_command_instruction(
    base_instruction: str, service: str, command: str, start_commands_json: str
) -> str:
    """Extend the start instruction with the command DISCOVERY recorded.

    Separate from :func:`_user_hint_instruction` on purpose. That block tells the
    agent a human said this and that a previous bring-up failed to work it out —
    both true for an operator hint, neither true here. Overstating provenance is
    how an agent gets told to stop thinking about a value that was itself a guess:
    discovery also wrote the handbook, so this does not "beat" it, and a
    discovered command that does not work must be diagnosed rather than trusted.

    Passing it at all is the point. Stage 2a records a ``command`` per service in
    ``services.json``, and this prompt never forwarded it — so the agent inferred
    the launch command from handbook prose, and when that failed the extension
    asked the operator, who typed the string that was already on disk. One
    workspace produced a hint byte-identical to the recorded command.
    """
    return (
        f"{base_instruction}\n\n"
        "### 📋 DISCOVERY RECORDED A LAUNCH COMMAND FOR THIS SERVICE — start from it\n\n"
        f"Vinv's discovery stage recorded that `{service}` starts with:\n\n"
        f"```bash\n{command.strip()}\n```\n\n"
        "**This is a strong starting point, not an authority.** It was derived from this "
        "repo by an earlier stage, so it is usually right about the module, port and "
        "arguments — but it has NOT been executed and verified yet, and it may be a "
        "wrapper rather than the underlying process. Do not treat it the way you would "
        "treat a human's answer.\n\n"
        "Use it in this order:\n\n"
        "1. **Run it as given first** (correct working directory, deps installed per the "
        "install rules above) and confirm it serves — port LISTENing + a real request "
        "answered.\n"
        "2. **If it does not work, diagnose before replacing it.** A wrong port or a "
        "missing `.env` is a fix to make, not a reason to invent a different command. "
        "Only derive your own if this one is genuinely not the way this service starts, "
        "and say so in your notes.\n"
        "3. **Then convert it to the tracelens-wrapped form** per \"How to start a Python "
        "service under tracelens\" above — unwrap it to the real `python -m <module> "
        "<args>` invocation, drop `--reload`, and wrap THAT with the exact "
        "`--target-package` flags and the session-scoped `--output` path. Keep its env "
        "vars, working directory, port and arguments intact.\n"
        "4. **Verify the WRAPPED form serves** (port + request + growing `trace.jsonl`) "
        "and record that traced command in `commands`.\n\n"
        "**This does NOT relax the deliverable — no trace, no `verified:true`.** If you "
        "cannot get the traced form working, record `verified:false` with the specific "
        f"blocker in `failure_symptom` and save `{start_commands_json}` anyway."
    )


def _discovered_command(project_root: Path, service: str) -> str | None:
    """The ``command`` Stage 2a recorded for ``service``, if it is usable.

    Best-effort like :func:`_read_start_hint`: a missing or malformed inventory is
    "no command", never an error, because a bring-up that would have run without
    one must still run. ``_read_services`` raises by design, so it is contained
    here.

    A ``-m module:attr`` command is rejected rather than forwarded. That form can
    never run (``-m`` takes a module; ``module:attr`` is uvicorn's app-factory
    syntax) and agents splice the two together routinely — the inventory is
    agent-written, so it carries the same risk as any other agent output, and
    handing the mistake onward would only launder it.
    """
    try:
        services = _read_services(project_root)
    except RuntimeError:
        return None
    for svc in services:
        if not isinstance(svc, dict) or svc.get("name") != service:
            continue
        command = svc.get("command")
        if not isinstance(command, str) or not command.strip():
            return None
        if _MODULE_COLON_RE.search(command):
            logger.warning(
                "bringup: services.json command for %r is a `-m module:attr` form that "
                "cannot run (%r); not forwarding it to the start prompt",
                service,
                command.strip(),
            )
            return None
        return command.strip()
    return None


def _replay_feedback_instruction(
    base_instruction: str, service: str, replay: dict[str, Any], start_commands_json: str
) -> str:
    """Extend the start instruction with the observed replay failure.

    The agent gets the same task plus the concrete evidence of how its saved
    artifact behaved when replayed the way the extension replays it — so the
    ReAct loop can diagnose and re-save instead of the operator finding a dead
    Run button later.
    """
    return (
        f"{base_instruction}\n\n"
        "### ⚠️ REPLAY VERIFICATION FAILED — fix the recorded start command\n\n"
        f"You (or a previous attempt) already wrote `{start_commands_json}`, but when the "
        "harness replayed the recorded `commands` exactly as the Vinv extension does "
        "(`bash -lc`, foreground, fresh shell), it did NOT result in a serving service:\n\n"
        f"- failure: {replay.get('reason', 'unknown')}\n"
        f"- replay exit code: {replay.get('exit_code', 'n/a')}\n"
        f"- replay output tail:\n```\n{(replay.get('output_tail') or '')[-2000:]}\n```\n\n"
        "The recorded command must be the PLAIN FOREGROUND form of the verified start "
        "command: no trailing `&`, no `nohup`, no `echo …$!`, no `> file 2>&1` "
        "redirection, no interactive-shell toggles like `set +H`. Inline env "
        "assignments and `export X=…;` prefixes are fine. Diagnose the failure above, "
        "verify the service still starts (dependencies are already installed — do NOT "
        "reinstall), fix the `commands` array, and save the corrected file with "
        "`save_file` again. Also make sure the port is not still held by a leftover "
        "process from the failed replay (`lsof -nP -iTCP:<port> -sTCP:LISTEN`)."
    )


def _unverified_feedback_instruction(
    base_instruction: str, service: str, start_commands: dict[str, Any], start_commands_json: str
) -> str:
    """Extend the start instruction after a ``verified: false`` round.

    The previous agent gave up and recorded why. Feed its self-report back so
    the retry starts from that evidence instead of rediscovering it — but
    framed as a hypothesis, with the traps that historically produced FALSE
    "environment is broken" verdicts called out explicitly.
    """
    report = {
        key: start_commands.get(key)
        for key in ("verification", "failure_symptom", "commands")
        if start_commands.get(key) is not None
    }
    report_json = json.dumps(report, indent=2, default=str)[:3000]
    return (
        f"{base_instruction}\n\n"
        "### ⚠️ PREVIOUS ATTEMPT GAVE UP (`verified: false`) — re-diagnose, then retry\n\n"
        f"A previous attempt wrote `{start_commands_json}` with `verified: false` "
        "and this self-report:\n\n"
        f"```json\n{report_json}\n```\n\n"
        "Treat that report as a HYPOTHESIS, not a fact — previous rounds have "
        "misdiagnosed blockers. Before accepting any of it:\n"
        "- **Re-run the reportedly failing command first.** The harness may have "
        "self-healed the cause between rounds (it clears stale tracelens payload "
        "caches, for one). An error observed last round is not evidence it still "
        "happens.\n"
        "- **Read the FILE PATHS in any traceback.** Frames pointing into an "
        "extracted payload cache (e.g. `…/AppData/Local/**/tracelens/<ver>/…` or "
        "`~/.cache/tracelens/…`) instead of the repo or a venv mean a stale binary "
        "extraction was executing — rerun rather than re-diagnose.\n"
        "- **Check for a leftover listener on the service port** from an earlier "
        "attempt (`netstat -ano | grep <port>` on Windows, `lsof -nP -iTCP:<port> "
        "-sTCP:LISTEN` elsewhere) and kill it before starting again.\n"
        "- **Never `pip install tracelens`** — the PyPI name is an unrelated "
        "project; if it snuck into the venv, `pip uninstall -y tracelens` and use "
        "the binary/local source per the instructions above.\n"
        "- **Quote version specs in shell commands** (e.g. `'PyYAML>=6.0.1,<7.0.0'`) "
        "so `>`/`<` are not parsed as redirections.\n\n"
        "Then bring the service up again, verify it serves, and save the corrected "
        "file with `save_file`."
    )
