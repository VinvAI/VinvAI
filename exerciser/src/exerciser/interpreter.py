"""Which Python actually has the target's dependencies installed.

Every oracle in this engine drives target code in a worker subprocess, and every
one of them took the interpreter as ``python or sys.executable``. The fallback
is Vinv's own venv, which contains Vinv's dependencies and nothing else — so
against any repo that was not installed into that same venv, every worker died
in ``import`` with ``ModuleNotFoundError`` and the run reported a clean zero.

Measured on a clone of langchain-ai/langchain: 185 of 288 outcomes were import
failures, ``issue_clusters: 0``, ``diagnostics: []``, ``status: "ok"``. Pointing
``--python`` at the repo's own venv turned the same command into 642 calls and 5
defect clusters. The flag existed the whole time. Nothing ever inferred it, so
the engine's default behaviour on an arbitrary repo was to find nothing and say
so in a way that read as good news.

The resolution here is EVIDENCE, not a name convention:

* **candidates** come from the explicit flag, an env override, every
  ``pyvenv.cfg`` in the tree (a venv can carry any directory name — the one that
  exposed this was ``.venv-target``), the environment-manager tools the repo's
  own manifests declare, and finally ``sys.executable``, which is always in the
  list so there is always an answer;
* **each candidate is PROBED** — a short, isolated subprocess asks
  ``importlib.metadata`` which of the distributions this repo DECLARES are
  actually installed there. Metadata only: no target code is imported and
  nothing is installed, resolved or written;
* **the winner is the one with the most of the target's dependencies present**,
  and ``sys.executable`` wins every tie. A handoff happens only when another
  interpreter is measurably better, so a repo installed into Vinv's own venv
  (the test suite's own case) keeps today's behaviour exactly.

The explicit ``--python`` is never overridden. It is still probed, because a
human who points the flag at the wrong venv deserves to be told.

TRUST BOUNDARY, stated because this module moves one. Choosing the interpreter
that has the target installed means EXECUTING a binary that lives inside the
target repo — ``<repo>/.venv/bin/python`` is the repo's file, and a probe runs
it before any sandbox exists. That is not incidental; it is what "run the code
under test in the environment it was built for" requires, and no design that
resolves an interpreter by evidence can avoid it. What is bounded is the blast
radius: the probe is ``-I``-isolated, reads ``.dist-info`` only, imports no
target code, installs nothing, and is killed on a timeout. ``_ENV_TOOLS``
likewise only runs commands that REPORT. A repo you would not run is still a
repo you should not exercise.
"""

from __future__ import annotations

import configparser
import json
import logging
import os
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import store

log = logging.getLogger(__name__)

#: Floor from this package's own ``requires-python``. A worker is OUR code, so
#: an interpreter that cannot run it is not a candidate however complete its
#: dependency set is — and saying that out loud beats handing the worker to a
#: 3.9 venv and reporting the SyntaxError as the repo's problem.
MIN_WORKER_PYTHON = (3, 12)

#: Bound on the probe fan-out. A monorepo can carry a venv per package; probing
#: every one costs a subprocess each, and the ranking is not improved by the
#: tail.
MAX_CANDIDATES = 12

#: Bound on what we ask about. The probe is O(names) inside one subprocess, and
#: a few dozen distributions already separate "this venv has the repo installed"
#: from "this venv has never seen it".
MAX_REQUIREMENTS = 150

DEFAULT_PROBE_TIMEOUT_S = 20.0

#: Read-only introspection commands, keyed by evidence that the repo actually
#: uses that tool. Every one of these PRINTS a path and creates nothing:
#: `poetry env info` reports, `pipenv --venv` reports, `pdm info` reports.
#: Deliberately absent: anything that would materialise an environment as a side
#: effect of being asked where it is — discovering an interpreter must not
#: change the machine.
#:
#: The evidence is a lock file or the tool's OWN table in pyproject, never bare
#: ``pyproject.toml``: nearly every Python repo has one, and `poetry env info`
#: reports the ACTIVATED virtualenv when there is one — which is always Vinv's
#: own while the CLI is running. Gating on the bare manifest therefore
#: re-nominated the exact interpreter this module exists to move off, wearing a
#: "poetry environment" label that looks like corroboration.
_ENV_TOOLS: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("poetry", ("poetry.lock",), ("poetry", "env", "info", "--path")),
    ("pipenv", ("Pipfile",), ("pipenv", "--venv")),
    ("pdm", ("pdm.lock",), ("pdm", "info", "--python")),
)

#: ``[tool.<name>]`` in pyproject is equally good evidence, for a repo that
#: keeps its lock file out of version control.
_ENV_TOOL_TABLES = ("poetry", "pdm")

_MANIFESTS = ("pyproject.toml", "setup.cfg")
_REQUIREMENT_GLOBS = ("requirements.txt", "requirements-*.txt", "requirements/*.txt")
_MAX_MANIFEST_DEPTH = 4


# =========================================================================
# What the repo declares
# =========================================================================


def normalize_dist(name: str) -> str:
    """PEP 503 normalisation — ``Foo.Bar_baz`` and ``foo-bar-baz`` are one name."""
    return re.sub(r"[-_.]+", "-", name).strip().lower()


def _requirement_name(spec: str) -> str | None:
    """Distribution name out of one requirement string.

    Handles the shapes a manifest actually carries: ``foo``, ``foo>=1,<2``,
    ``foo[extra]==1.0``, ``foo ; python_version < '3.12'``, ``foo @ url``.
    Anything that is not a bare name (a URL, a path, a pip flag) yields None —
    a probe cannot ask ``importlib.metadata`` about a git URL.
    """
    spec = spec.strip()
    if not spec or spec.startswith(("#", "-", ".", "/")):
        return None
    head = re.split(r"[\s\[\](<>=!~;@,]", spec, maxsplit=1)[0]
    if not head or not re.fullmatch(r"[A-Za-z0-9._-]+", head):
        return None
    if head.lower() in {"python", "python_version"}:
        return None
    return normalize_dist(head)


def _scan(repo: Path) -> tuple[list[Path], list[Path]]:
    """``(directories carrying a manifest, virtualenv roots)`` from ONE walk.

    Both answers come off the same traversal because they are the same
    traversal: a venv is pruned from the manifest scan for exactly the reason it
    is nominated as an interpreter. Discovery is by ``pyvenv.cfg`` rather than by
    directory name — the venv that exposed the bug this module fixes was called
    ``.venv-target``, and a name list would have walked straight into it.
    """
    dirs, venvs = store.walk_source_dirs(repo, max_depth=_MAX_MANIFEST_DEPTH)
    manifests = [d for d, names in dirs if any(m in names for m in _MANIFESTS)]
    return sorted(manifests, key=lambda p: (len(p.parts), str(p))), venvs


def _venv_roots(repo: Path) -> list[Path]:
    """Every virtualenv root in the tree, by ``pyvenv.cfg``."""
    return _scan(repo)[1]


def _manifest_dirs(repo: Path) -> list[Path]:
    """Directories carrying a packaging manifest, vendored trees and venvs pruned."""
    return _scan(repo)[0]


def _from_pyproject(path: Path) -> tuple[str | None, list[str]]:
    """``(this distribution's own name, the distributions it depends on)``."""
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return None, []
    names: list[str] = []
    project = data.get("project") if isinstance(data.get("project"), dict) else {}
    tool = data.get("tool") if isinstance(data.get("tool"), dict) else {}
    poetry = tool.get("poetry") if isinstance(tool.get("poetry"), dict) else {}

    own: str | None = None
    for owner in (project, poetry):
        declared = owner.get("name")
        if own is None and isinstance(declared, str) and declared.strip():
            own = normalize_dist(declared)

    for spec in project.get("dependencies") or []:
        if isinstance(spec, str):
            names.append(_requirement_name(spec) or "")
    optional = project.get("optional-dependencies")
    if isinstance(optional, dict):
        for group in optional.values():
            for spec in group if isinstance(group, list) else []:
                if isinstance(spec, str):
                    names.append(_requirement_name(spec) or "")
    # Poetry keeps dependencies as a table keyed by name.
    for table_key in ("dependencies", "dev-dependencies"):
        table = poetry.get(table_key)
        if isinstance(table, dict):
            for key in table:
                names.append(_requirement_name(str(key)) or "")
    groups = poetry.get("group")
    if isinstance(groups, dict):
        for group in groups.values():
            table = group.get("dependencies") if isinstance(group, dict) else None
            if isinstance(table, dict):
                for key in table:
                    names.append(_requirement_name(str(key)) or "")
    return own, [n for n in names if n]


def _from_setup_cfg(path: Path) -> tuple[str | None, list[str]]:
    """``(this distribution's own name, its install_requires)`` from setup.cfg.

    ``setup.cfg`` was in ``_MANIFESTS`` from the start but nothing ever parsed
    it, so a setuptools-configured repo declared no OWN distribution — and the
    ranking silently fell back to the flat third-party count that this module's
    own docstring says is too weak to trust.
    """
    parser = configparser.ConfigParser()
    try:
        parser.read_string(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, configparser.Error):
        return None, []
    declared = parser.get("metadata", "name", fallback="").strip()
    own = normalize_dist(declared) if declared else None
    requires = parser.get("options", "install_requires", fallback="")
    names = [_requirement_name(line) for line in requires.splitlines()]
    return own, [n for n in names if n]


def _from_requirements(path: Path) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return [n for n in (_requirement_name(line) for line in lines) if n]


@dataclass(frozen=True)
class Requirements:
    """What the repo declares, split by who owns it.

    The split is the whole discriminator. Measured on langchain, the two
    candidate interpreters scored 20/74 and 15/74 on the flat set — Vinv's own
    venv genuinely has pydantic, requests, PyYAML, SQLAlchemy and a dozen other
    ordinary libraries, so a flat count nearly ties and would invert on any repo
    whose dependencies are more common still.

    On the repo's OWN distributions the same two interpreters scored 4 and 0.
    "Is the code under test installed here" is a far sharper question than "does
    this interpreter have some libraries", and it is the one that actually
    predicts whether a worker can import the target.
    """

    #: Distributions the repo itself declares (``[project].name`` of every
    #: manifest in the tree) — its own packages and, in a monorepo, its siblings.
    own: tuple[str, ...] = ()
    #: Everything the repo depends on that it does not also publish.
    third_party: tuple[str, ...] = ()

    @property
    def all(self) -> list[str]:
        return [*self.own, *self.third_party]

    def __len__(self) -> int:
        return len(self.own) + len(self.third_party)


def declared_requirements(repo: Path) -> Requirements:
    """Every distribution this repo declares, normalised, split own vs third-party.

    Deliberately the DECLARED set rather than an installed set or an import
    scan: declarations are what packaging already records, they exist before
    anything is installed anywhere, and they are the same list whichever
    interpreter is asked.
    """
    own: list[str] = []
    deps: list[str] = []
    for directory in _manifest_dirs(repo):
        pyproject = directory / "pyproject.toml"
        if pyproject.is_file():
            name, requires = _from_pyproject(pyproject)
            if name:
                own.append(name)
            deps.extend(requires)
        cfg = directory / "setup.cfg"
        if cfg.is_file():
            name, requires = _from_setup_cfg(cfg)
            if name:
                own.append(name)
            deps.extend(requires)
    for pattern in _REQUIREMENT_GLOBS:
        for path in sorted(repo.glob(pattern)):
            deps.extend(_from_requirements(path))
    own_ordered = list(dict.fromkeys(own))
    owned = set(own_ordered)
    # A monorepo declares its siblings as dependencies too; they belong to the
    # repo, so they are counted once, on the side that discriminates.
    third = [n for n in dict.fromkeys(deps) if n not in owned]
    return Requirements(
        own=tuple(own_ordered[:MAX_REQUIREMENTS]),
        third_party=tuple(third[:MAX_REQUIREMENTS]),
    )


# =========================================================================
# Candidates
# =========================================================================


@dataclass(frozen=True)
class Candidate:
    """One interpreter worth asking, and where the suggestion came from."""

    python: str
    origin: str
    detail: str = ""

    def key(self) -> str:
        """Identity for deduplication — the venv PREFIX, not the binary.

        ``bin/python3`` inside a venv is a symlink to the base interpreter, so
        ``realpath`` collapses every venv built from the same Python into one
        key: the target's venv and Vinv's own venv become indistinguishable
        while having entirely different ``site-packages``. A venv's identity is
        its prefix, which is exactly what ``pyvenv.cfg`` marks. Outside a venv
        (a system or pyenv interpreter) ``realpath`` is the right answer and
        still collapses ``python`` with ``python3``.
        """
        exe = Path(self.python)
        try:
            for prefix in (exe.parent.parent, exe.parent):
                if (prefix / "pyvenv.cfg").is_file():
                    return str(prefix.resolve())
            return os.path.realpath(exe)
        except OSError:  # pragma: no cover - a hostile path
            return self.python


def _venv_python(venv_root: Path) -> str | None:
    """The interpreter inside a venv root, on either platform layout."""
    for rel in ("bin/python3", "bin/python", "Scripts/python.exe", "Scripts/python3.exe"):
        exe = venv_root / rel
        if exe.is_file() and os.access(exe, os.X_OK):
            return str(exe)
    return None


def _in_repo_venvs(repo: Path) -> list[Candidate]:
    """Every venv in the tree, recognised by ``pyvenv.cfg`` rather than by name.

    Name lists are what made this invisible: the venv that exposed the bug was
    called ``.venv-target``, and a repo is free to call one anything at all.
    ``pyvenv.cfg`` is the marker the interpreter itself writes.
    """
    found: list[Candidate] = []
    for root in _venv_roots(repo):
        parts = root.relative_to(repo).parts
        # A venv nested inside vendored or VCS metadata is not this repo's env.
        # The venv's OWN directory name is never judged — that is the point.
        if any(p in {".git", "node_modules", "__pycache__", ".vinv"} for p in parts[:-1]):
            continue
        exe = _venv_python(root)
        if exe:
            found.append(Candidate(exe, "in-repo venv", root.relative_to(repo).as_posix()))
    # Shallowest first: a top-level `.venv` is more likely the project's env
    # than one nested inside a single package. Probing settles it either way;
    # this only makes the ORDER deterministic.
    return sorted(found, key=lambda c: (len(Path(c.detail).parts), c.detail))


def _declares_tool(repo: Path, tool: str) -> bool:
    """Does the repo's own pyproject carry a ``[tool.<tool>]`` table?"""
    if tool not in _ENV_TOOL_TABLES:
        return False
    path = repo / "pyproject.toml"
    if not path.is_file():
        return False
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return False
    table = data.get("tool")
    return isinstance(table, dict) and isinstance(table.get(tool), dict)


def _tool_venvs(repo: Path, *, timeout_s: float = 10.0) -> list[Candidate]:
    """Out-of-tree environments the repo's own tooling knows about.

    Gated on a manifest marker so no tool is invoked for a repo that does not
    use it, and every command is read-only (see ``_ENV_TOOLS``). A tool that is
    absent, slow, or unhappy contributes nothing — this is a source of
    suggestions, not a requirement.
    """
    found: list[Candidate] = []
    for tool, markers, argv in _ENV_TOOLS:
        if not any((repo / m).is_file() for m in markers) and not _declares_tool(repo, tool):
            continue
        try:
            proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
                list(argv),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                cwd=str(repo),
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        out = (proc.stdout or "").strip().splitlines()
        if proc.returncode != 0 or not out:
            continue
        raw = Path(out[-1].strip())
        exe = str(raw) if raw.is_file() else _venv_python(raw)
        if exe and Path(exe).is_file():
            found.append(Candidate(exe, f"{tool} environment", str(raw)))
    return found


def discover_candidates(repo: Path, explicit: str | None = None) -> list[Candidate]:
    """Interpreters worth probing for ``repo``, best-guess first.

    Order is a tie-break only — the ranking that matters comes from the probe.
    ``sys.executable`` is always present and always last, so the list is never
    empty and the status quo is always reachable.
    """
    out: list[Candidate] = []
    if explicit:
        out.append(Candidate(explicit, "--python", "explicit"))

    override = os.environ.get("VINV_TARGET_PYTHON")
    if override:
        out.append(Candidate(override, "VINV_TARGET_PYTHON", "environment override"))

    # An ACTIVE virtualenv counts only when it belongs to this repo. Vinv's own
    # venv is active whenever the CLI runs, and treating that as a signal would
    # re-elect exactly the interpreter this module exists to stop electing.
    active = os.environ.get("VIRTUAL_ENV")
    if active:
        try:
            inside = Path(active).resolve().is_relative_to(repo.resolve())
        except (OSError, ValueError):
            inside = False
        exe = _venv_python(Path(active)) if inside else None
        if exe:
            out.append(Candidate(exe, "VIRTUAL_ENV", active))

    # `uv` puts the project environment in `<repo>/.venv` unless told otherwise;
    # the walk below finds that, and this covers the relocated case.
    uv_env = os.environ.get("UV_PROJECT_ENVIRONMENT")
    if uv_env:
        base = Path(uv_env)
        exe = _venv_python(base if base.is_absolute() else repo / base)
        if exe:
            out.append(Candidate(exe, "UV_PROJECT_ENVIRONMENT", uv_env))

    out.extend(_in_repo_venvs(repo))
    out.extend(_tool_venvs(repo))
    fallback = Candidate(sys.executable, "vinv's own interpreter", "fallback")
    out.append(fallback)

    seen: set[str] = set()
    unique: list[Candidate] = []
    for cand in out:
        k = cand.key()
        if k in seen:
            continue
        seen.add(k)
        unique.append(cand)
    if len(unique) <= MAX_CANDIDATES:
        return unique
    # The cap truncates the TAIL, and the fallback is last — so a monorepo with
    # a venv per package dropped `sys.executable` off the end of its own list.
    # `resolve_interpreter` then scored it (0, 0) without ever probing it, which
    # both fabricates the baseline the handoff diagnostic quotes and lets a
    # candidate with one third-party package beat an interpreter that may have
    # the whole repo installed. The fallback keeps a reserved slot.
    self_key = fallback.key()
    kept = [c for c in unique if c.key() != self_key][: MAX_CANDIDATES - 1]
    kept.append(next((c for c in unique if c.key() == self_key), fallback))
    return kept


# =========================================================================
# The probe
# =========================================================================

#: Runs in the CANDIDATE interpreter. Reads a JSON name list on stdin and
#: reports which distributions are installed. `importlib.metadata` reads
#: `.dist-info` off the filesystem — no target package is imported, so a
#: candidate cannot execute repo code, spend real time, or have side effects
#: just by being measured.
_PROBE_SRC = r"""
import json, sys
from importlib import metadata
names = json.loads(sys.stdin.read())
have = set()
for dist in metadata.distributions():
    try:
        name = dist.metadata["Name"]
    except Exception:
        name = None
    if name:
        have.add("".join("-" if c in "-_." else c for c in name).lower())
present = [n for n in names if n in have]
missing = [n for n in names if n not in have]
json.dump(
    {
        "executable": sys.executable,
        "version": list(sys.version_info[:3]),
        "present": present,
        "missing": missing,
    },
    sys.stdout,
)
"""


@dataclass
class Probe:
    """What one candidate interpreter answered."""

    ok: bool = False
    version: tuple[int, ...] = ()
    #: The repo's OWN distributions this interpreter has installed.
    own_present: tuple[str, ...] = ()
    #: Its third-party dependencies this interpreter has installed.
    third_present: tuple[str, ...] = ()
    missing: tuple[str, ...] = ()
    error: str = ""

    @property
    def score(self) -> tuple[int, int]:
        """Rank key: the repo's own packages first, everything else as tie-break.

        Lexicographic on purpose. An interpreter with the code under test
        installed beats one with more third-party libraries, every time — the
        second number only separates candidates that are indistinguishable on
        the first.
        """
        return (len(self.own_present), len(self.third_present))

    @property
    def present(self) -> tuple[str, ...]:
        return (*self.own_present, *self.third_present)

    @property
    def runnable(self) -> bool:
        """Can this interpreter run an exerciser worker at all?"""
        return self.ok and self.version >= MIN_WORKER_PYTHON


def probe_candidate(
    candidate: Candidate,
    requirements: Requirements,
    *,
    timeout_s: float = DEFAULT_PROBE_TIMEOUT_S,
    cwd: Path | None = None,
) -> Probe:
    """Ask one interpreter which of ``requirements`` it has installed.

    ``-I`` isolates the probe: no user site directory, no ``PYTHON*`` env
    inherited from Vinv's own process, and — the one that matters — no working
    directory on ``sys.path``, so a repo with a ``json.py`` at its root cannot
    shadow the probe's own imports.
    """
    try:
        proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
            [candidate.python, "-I", "-c", _PROBE_SRC],
            input=json.dumps(requirements.all),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
            cwd=str(cwd) if cwd else None,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return Probe(error=f"probe timed out after {timeout_s:g}s")
    except OSError as exc:
        return Probe(error=f"not executable: {exc}")
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-1:]
        return Probe(error=f"exit {proc.returncode}: {tail[0] if tail else 'no stderr'}"[:200])
    try:
        doc = json.loads(proc.stdout or "")
    except ValueError:
        return Probe(error="probe produced no parseable answer")
    present = set(doc.get("present") or ())
    return Probe(
        ok=True,
        version=tuple(int(p) for p in doc.get("version") or ()),
        own_present=tuple(n for n in requirements.own if n in present),
        third_present=tuple(n for n in requirements.third_party if n in present),
        missing=tuple(doc.get("missing") or ()),
    )


# =========================================================================
# The choice
# =========================================================================


@dataclass
class InterpreterChoice:
    """The interpreter the workers will use, and the evidence for it."""

    python: str
    origin: str
    #: How many of the repo's OWN distributions this interpreter has installed —
    #: the number that decided the choice.
    own_present: int = 0
    own_declared: int = 0
    #: The same for third-party dependencies (the tie-break).
    third_present: int = 0
    third_declared: int = 0
    #: The declared distributions it does NOT have, capped for the report.
    missing: tuple[str, ...] = ()
    version: tuple[int, ...] = ()
    #: Every candidate considered, with its score — so a wrong choice is
    #: debuggable from the run summary alone.
    considered: list[dict[str, Any]] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)
    #: True when the choice moved off `sys.executable`.
    handed_off: bool = False

    @property
    def target_installed(self) -> bool:
        """Does this interpreter have the code under test installed?"""
        return self.own_declared > 0 and self.own_present > 0

    def to_json(self) -> dict[str, Any]:
        return {
            "python": self.python,
            "origin": self.origin,
            "handed_off": self.handed_off,
            "python_version": ".".join(str(p) for p in self.version) or None,
            "target_installed": self.target_installed,
            "repo_distributions": {
                "declared": self.own_declared,
                "present": self.own_present,
            },
            "third_party": {
                "declared": self.third_declared,
                "present": self.third_present,
            },
            "missing_sample": list(self.missing[:20]),
            "considered": self.considered,
        }


def _summarise(cand: Candidate, probe: Probe, reqs: Requirements) -> dict[str, Any]:
    own, third = probe.score
    return {
        "python": cand.python,
        "origin": cand.origin,
        "detail": cand.detail,
        "ok": probe.ok,
        "python_version": ".".join(str(p) for p in probe.version) or None,
        "repo_distributions_present": f"{own}/{len(reqs.own)}",
        "third_party_present": f"{third}/{len(reqs.third_party)}",
        "error": probe.error or None,
    }


def resolve_interpreter(
    repo: Path,
    *,
    explicit: str | None = None,
    probe_timeout_s: float = DEFAULT_PROBE_TIMEOUT_S,
    logger: logging.Logger | None = None,
) -> InterpreterChoice:
    """Pick the interpreter whose installed set best matches what ``repo`` declares.

    ``explicit`` (the ``--python`` flag) is HONOURED unconditionally — a human
    who names an interpreter has said something this function cannot outrank —
    but it is still probed, so pointing the flag at the wrong venv produces a
    diagnostic instead of another silent zero.

    With no explicit flag the answer is the candidate with the most of the
    repo's OWN distributions installed (third-party count as tie-break), and
    ``sys.executable`` wins every remaining tie. Strictly-greater is the whole
    rule: a repo that IS installed into Vinv's venv, or one that declares
    nothing at all, keeps today's behaviour exactly and pays only the probe.
    """
    log_ = logger or log
    reqs = declared_requirements(repo)
    candidates = discover_candidates(repo, explicit)

    probes: list[tuple[Candidate, Probe]] = []
    for cand in candidates:
        probe = probe_candidate(cand, reqs, timeout_s=probe_timeout_s, cwd=repo)
        probes.append((cand, probe))
        if explicit and cand.origin == "--python":
            # The human's answer stands; nothing after this can change it, so
            # there is no reason to pay for the rest of the fan-out.
            break

    considered = [_summarise(c, p, reqs) for c, p in probes]
    diagnostics: list[str] = []

    def _build(cand: Candidate, probe: Probe, *, handed_off: bool) -> InterpreterChoice:
        own, third = probe.score
        return InterpreterChoice(
            python=cand.python,
            origin=cand.origin,
            own_present=own,
            own_declared=len(reqs.own),
            third_present=third,
            third_declared=len(reqs.third_party),
            missing=probe.missing,
            version=probe.version,
            considered=considered,
            handed_off=handed_off,
        )

    self_key = Candidate(sys.executable, "").key()

    if explicit:
        cand, probe = probes[0]
        choice = _build(cand, probe, handed_off=cand.key() != self_key)
        if not probe.ok:
            diagnostics.append(
                f"--python {cand.python} could not be probed ({probe.error}) — the "
                "workers will use it anyway, because an explicit flag is not "
                "second-guessed, but nothing here confirms it can import the target."
            )
        elif reqs.own and probe.score[0] == 0:
            diagnostics.append(
                f"--python {cand.python} has NONE of the {len(reqs.own)} distribution(s) "
                f"this repo publishes ({', '.join(reqs.own[:5])}) — the code under test "
                "is not installed there, and every worker will fail in import."
            )
        elif not probe.runnable and probe.ok:
            diagnostics.append(
                f"--python {cand.python} is Python "
                f"{'.'.join(str(p) for p in probe.version)}, below exerciser's "
                f"{'.'.join(str(p) for p in MIN_WORKER_PYTHON)} floor — the worker "
                "itself will not run there."
            )
        choice.diagnostics = diagnostics
        return choice

    runnable = [(c, p) for c, p in probes if p.runnable]
    unrunnable = [(c, p) for c, p in probes if p.ok and not p.runnable]

    fallback = next(
        ((c, p) for c, p in probes if c.key() == self_key),
        (Candidate(sys.executable, "vinv's own interpreter", "fallback"), Probe()),
    )
    best_cand, best_probe = fallback
    for cand, probe in runnable:
        # STRICTLY greater, lexicographically. A tie keeps `sys.executable`, so
        # the handoff only ever happens on evidence that it buys something.
        if probe.score > best_probe.score:
            best_cand, best_probe = cand, probe

    handed_off = best_cand.key() != self_key
    if handed_off:
        log_.info(
            "interpreter: %s (%s) has %d/%d of the repo's own distributions; "
            "handing the workers off from %s",
            best_cand.python,
            best_cand.origin,
            best_probe.score[0],
            len(reqs.own),
            sys.executable,
        )
        diagnostics.append(
            f"workers will run under {best_cand.python} ({best_cand.origin}): it has "
            f"{best_probe.score[0]}/{len(reqs.own)} of the distributions this repo "
            f"publishes, against {fallback[1].score[0]}/{len(reqs.own)} in Vinv's own "
            "venv. Pass --python to override."
        )
    for cand, probe in unrunnable:
        # Reported, not silently dropped: "the repo's venv is too old for our
        # worker" is a fact the human needs, and it is invisible from a run that
        # merely stayed on the fallback.
        diagnostics.append(
            f"{cand.python} ({cand.origin}) has {probe.score[0]}/{len(reqs.own)} of the "
            f"repo's own distributions but is Python "
            f"{'.'.join(str(p) for p in probe.version)}, below exerciser's "
            f"{'.'.join(str(p) for p in MIN_WORKER_PYTHON)} floor — it cannot host a "
            "worker, so it was not used."
        )

    choice = _build(best_cand, best_probe, handed_off=handed_off)
    choice.diagnostics = diagnostics
    return choice


@lru_cache(maxsize=32)
def _cached(repo_key: str, explicit: str | None, timeout: float) -> InterpreterChoice:
    return resolve_interpreter(Path(repo_key), explicit=explicit, probe_timeout_s=timeout)


#: The FIRST answer reached for a repo in this process, by resolved path. See
#: `resolve_cached` — this is what tells an answer coming back round from the
#: campaign apart from a human naming an interpreter.
_ANSWERED: dict[str, InterpreterChoice] = {}
_LOGGED: set[tuple[str, str]] = set()


def resolve_cached(
    repo: Path,
    *,
    explicit: str | None = None,
    probe_timeout_s: float = DEFAULT_PROBE_TIMEOUT_S,
    logger: logging.Logger | None = None,
) -> InterpreterChoice:
    """``resolve_interpreter`` memoised per (repo, flag).

    The campaign resolves the same answer for five oracles in one run, and a
    fan-out of probe subprocesses per oracle is pure cost — the filesystem it
    reads does not change mid-run.

    An answer HANDED BACK is not a flag. The campaign resolves once and passes
    the result to every oracle as its ``python`` argument, which each oracle then
    offers here as ``explicit`` — a different cache key, so it re-probed, and
    worse, took the explicit branch and reported ``--python <path> has NONE of
    the distributions this repo publishes`` about a flag nobody passed. When the
    request names the interpreter this repo has already resolved to, the prior
    choice IS the answer.
    """
    key = str(repo.resolve())
    prior = _ANSWERED.get(key)
    if prior is not None and explicit == prior.python:
        choice = prior
    else:
        choice = _cached(key, explicit, probe_timeout_s)
        _ANSWERED.setdefault(key, choice)
    if logger and choice.diagnostics and (key, choice.python) not in _LOGGED:
        # Once per repo per interpreter: five oracles repeating one handoff
        # notice reads as five handoffs.
        _LOGGED.add((key, choice.python))
        for diag in choice.diagnostics:
            logger.info("interpreter: %s", diag)
    return choice


def reset_cache() -> None:
    """Drop the memo — tests build a fresh tree per case."""
    _cached.cache_clear()
    _ANSWERED.clear()
    _LOGGED.clear()
