"""How this repo expects to be run — read from what it already declares.

Every oracle spawned its worker with ``cwd=repo``, and a repo's relative paths
resolve against the working directory, so that choice silently decides what the
code under test reads. It was never a decision: five call sites hardcoded it and
nothing modelled "where is this meant to run from" as a question at all.

demo-fastapi answers that question **twice**, in machine-readable form, and
neither answer was consulted:

* ``.github/workflows/test-backend.yml`` — ``working-directory: backend``
* ``backend/Dockerfile`` — ``WORKDIR /app/backend/``, with compose's
  ``context: .`` mapping the repo root onto ``/app``

Its settings then declare ``env_file="../.env"``, relative because the app runs
from ``backend/``. Started at the repo root instead, ``../.env`` resolved
outside the repo entirely, every required setting was missing, 14 of 15 modules
failed to import, and the engine reported fifteen defects in a clean repo.

**What this module does NOT do is decide.** A list of places to read a
declaration from is a list, and a list only ever covers the build systems
someone thought of — Bazel, Nix, Earthly, a shell script or a sentence in a
README are all equally valid ways for a project to say where it runs, and
enumerating them does not converge. Any design that has to recognise the
mechanism fails on the next repo.

So these are HINTS that order an empirical search, and the search is what
settles it: ``functions.candidate_workdirs`` puts these first, the distribution
that owns the file next, and the repo root last, and then the worker is RUN
from each in turn until the module actually imports. That is the discipline the
rest of the engine already uses — ``containment`` ("the answer comes from a
PROBE, never from the presence of a binary on PATH"), ``interpreter`` for
candidate interpreters, ``service_doubles.induce`` for schema: act, read the
failure, try the next thing, converge.

The consequence worth stating plainly: a repo that declares nothing this module
recognises is still handled correctly, because being unable to read a project's
automation is not the same as being unable to run its code. What the hints buy
is speed — the right directory first, so the retry is usually never paid.

The sources happen to be easy to read, and that is their only claim:

* CI ``working-directory:``, the strongest, because it is literally "how this
  project runs its own code", written by the people who know;
* ``WORKDIR`` in a Dockerfile, mapped back through the build context that says
  which host directory the image root corresponds to;
* ``Procfile`` / Makefile / justfile recipes that ``cd`` before running;
* ``[tool.pytest.ini_options] testpaths``.

Every claim carries its source, so a chosen directory is auditable from the run
summary rather than being a silent default.
"""

from __future__ import annotations

import logging
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

from . import store

log = logging.getLogger(__name__)

#: Bounded so a repo with a large `.github` tree cannot make discovery expensive.
_MAX_FILES_PER_SOURCE = 40

#: Ranked. A repo that both runs CI from `backend` and builds an image with a
#: different WORKDIR is telling us two things; CI is about running THIS
#: checkout, while a Dockerfile describes a built image whose layout may not
#: mirror the source tree at all.
_SOURCE_RANK = {
    "ci-working-directory": 0,
    "procfile": 1,
    "make-recipe": 1,
    "pytest-testpaths": 2,
    "dockerfile-workdir": 3,
}


@dataclass(frozen=True)
class WorkdirClaim:
    """One repo-relative directory the project says it runs from, and where it said so."""

    path: str
    source: str
    detail: str = ""

    @property
    def rank(self) -> int:
        return _SOURCE_RANK.get(self.source, 9)

    def to_json(self) -> dict[str, str]:
        return {"path": self.path, "source": self.source, "detail": self.detail}


def _rel(repo: Path, candidate: Path) -> str | None:
    """``candidate`` as a repo-relative directory, or None when it escapes the repo."""
    try:
        resolved = candidate.resolve()
        rel = resolved.relative_to(repo.resolve()).as_posix()
    except (OSError, ValueError):
        return None
    if not resolved.is_dir():
        return None
    return rel or "."


def _yaml_scalars(text: str, key: str) -> list[str]:
    """Values of ``key:`` in a YAML-ish document, without a YAML dependency.

    Deliberately a line scan rather than a parser: this reads two specific keys
    out of CI and compose files, a full YAML dependency for that is not worth
    it, and a file this cannot parse contributes nothing rather than raising.
    """
    out: list[str] = []
    pattern = re.compile(rf"^\s*{re.escape(key)}\s*:\s*(?P<v>[^\s#][^#\n]*?)\s*(?:#.*)?$")
    for line in text.splitlines():
        found = pattern.match(line)
        if found:
            out.append(found.group("v").strip().strip("'\""))
    return out


def _ci_workdirs(repo: Path) -> list[WorkdirClaim]:
    """``working-directory:`` from GitHub Actions / GitLab CI."""
    claims: list[WorkdirClaim] = []
    files: list[Path] = []
    for pattern in (".github/workflows/*.yml", ".github/workflows/*.yaml", ".gitlab-ci.yml"):
        files.extend(sorted(repo.glob(pattern))[:_MAX_FILES_PER_SOURCE])
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for raw in _yaml_scalars(text, "working-directory"):
            # A CI expression (`${{ ... }}`) is not a path we can resolve.
            if "$" in raw:
                continue
            rel = _rel(repo, repo / raw)
            if rel:
                claims.append(
                    WorkdirClaim(rel, "ci-working-directory", path.relative_to(repo).as_posix())
                )
    return claims


def _dockerfile_workdirs(repo: Path) -> list[WorkdirClaim]:
    """``WORKDIR`` mapped back through the compose build context.

    A Dockerfile's ``WORKDIR /app/backend`` is a path inside the IMAGE. It only
    names a host directory once the build context says which host directory the
    image was built from — compose's ``context: .`` plus ``COPY . /app`` means
    ``/app`` is the repo root, so ``/app/backend`` is ``<repo>/backend``. The
    mapping is recovered from the longest ``COPY``/``ADD`` of the context root.
    """
    claims: list[WorkdirClaim] = []
    for path in sorted(repo.rglob("Dockerfile*"))[:_MAX_FILES_PER_SOURCE]:
        try:
            parts = path.relative_to(repo).parts
        except ValueError:
            continue
        if any(p in store.SKIP_DIRS for p in parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        image_roots: list[str] = []
        for line in text.splitlines():
            copy = re.match(r"^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*\.\s+(?P<dest>\S+)", line, re.I)
            if copy:
                image_roots.append(copy.group("dest").rstrip("/") or "/")
        workdirs = [
            m.group("d").strip().strip("'\"")
            for m in (
                re.match(r"^\s*WORKDIR\s+(?P<d>\S+)", line, re.I) for line in text.splitlines()
            )
            if m
        ]
        if not workdirs:
            continue
        final = workdirs[-1].rstrip("/") or "/"
        for image_root in sorted(image_roots, key=len, reverse=True):
            if final == image_root:
                sub = ""
            elif final.startswith(image_root + "/"):
                sub = final[len(image_root) + 1 :]
            else:
                continue
            rel = _rel(repo, repo / sub if sub else repo)
            if rel:
                claims.append(
                    WorkdirClaim(rel, "dockerfile-workdir", path.relative_to(repo).as_posix())
                )
            break
    return claims


_CD_RE = re.compile(r"\bcd\s+(?P<dir>[A-Za-z0-9_./-]+)\s*(?:&&|;)")


def _cd_workdirs(repo: Path) -> list[WorkdirClaim]:
    """Directories a Procfile / Makefile / justfile recipe ``cd``s into before running."""
    claims: list[WorkdirClaim] = []
    for name, source in (
        ("Procfile", "procfile"),
        ("Makefile", "make-recipe"),
        ("makefile", "make-recipe"),
        ("justfile", "make-recipe"),
        ("Justfile", "make-recipe"),
    ):
        path = repo / name
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for found in _CD_RE.finditer(text):
            rel = _rel(repo, repo / found.group("dir"))
            if rel and rel != ".":
                claims.append(WorkdirClaim(rel, source, name))
    return claims


def _pytest_workdirs(repo: Path) -> list[WorkdirClaim]:
    """``testpaths`` names where a project's own tests are rooted."""
    claims: list[WorkdirClaim] = []
    for path in sorted(repo.rglob("pyproject.toml"))[:_MAX_FILES_PER_SOURCE]:
        try:
            parts = path.parent.relative_to(repo).parts
        except ValueError:
            continue
        if any(p in store.SKIP_DIRS for p in parts):
            continue
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            continue
        tool = data.get("tool") if isinstance(data.get("tool"), dict) else {}
        pytest_cfg = tool.get("pytest") if isinstance(tool.get("pytest"), dict) else {}
        ini = pytest_cfg.get("ini_options") if isinstance(pytest_cfg, dict) else None
        if not isinstance(ini, dict) or not ini.get("testpaths"):
            continue
        rel = _rel(repo, path.parent)
        if rel:
            claims.append(WorkdirClaim(rel, "pytest-testpaths", path.relative_to(repo).as_posix()))
    return claims


def declared_workdirs(repo: Path) -> list[WorkdirClaim]:
    """Every working directory this repo declares, best source first.

    Deduplicated on ``(path, source)`` and ordered by source rank then depth, so
    the answer is deterministic and a reader can see WHY it was chosen.
    """
    claims: list[WorkdirClaim] = []
    for gather in (_ci_workdirs, _cd_workdirs, _pytest_workdirs, _dockerfile_workdirs):
        try:
            claims.extend(gather(repo))
        except OSError:  # pragma: no cover - unreadable tree
            continue
    seen: set[tuple[str, str]] = set()
    unique: list[WorkdirClaim] = []
    for claim in claims:
        key = (claim.path, claim.source)
        if key in seen:
            continue
        seen.add(key)
        unique.append(claim)
    return sorted(unique, key=lambda c: (c.rank, -len(Path(c.path).parts), c.path))


def workdir_claims_for(
    repo: Path,
    rel_file: str,
    claims: list[WorkdirClaim] | None = None,
) -> list[WorkdirClaim]:
    """Every declared working directory containing ``rel_file``, best first.

    A LIST, not a winner. These are hints that order an empirical search — the
    sources below are the ones that happen to be easy to read, never a claim to
    have enumerated how projects state their layout. A repo built with Bazel,
    Nix or a shell script contributes nothing here and is still handled, because
    what settles the question is whether the module imports.
    """
    candidates = declared_workdirs(repo) if claims is None else claims
    target = Path(rel_file).as_posix()
    containing = [
        c for c in candidates if c.path == "." or target.startswith(c.path.rstrip("/") + "/")
    ]
    return sorted(containing, key=lambda c: (c.rank, -len(Path(c.path).parts), c.path))


def workdir_for(
    repo: Path,
    rel_file: str,
    claims: list[WorkdirClaim] | None = None,
) -> WorkdirClaim | None:
    """The best declared working directory that CONTAINS ``rel_file``, if any.

    Containment is the whole test. A repo may declare several — ``backend`` for
    the API and ``frontend`` for the UI — and the one that applies to a module
    is the one the module lives under. A claim that does not contain the file
    says nothing about it, and the deepest containing claim wins for the same
    reason the deepest distribution does.
    """
    candidates = declared_workdirs(repo) if claims is None else claims
    target = Path(rel_file).as_posix()
    best: WorkdirClaim | None = None
    for claim in candidates:
        if claim.path != "." and not target.startswith(claim.path.rstrip("/") + "/"):
            continue
        if best is None:
            best = claim
            continue
        # Rank first (CI beats a Dockerfile), then depth.
        if (claim.rank, -len(Path(claim.path).parts)) < (
            best.rank,
            -len(Path(best.path).parts),
        ):
            best = claim
    return best
