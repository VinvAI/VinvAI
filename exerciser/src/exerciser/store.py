"""Filesystem layout + atomic IO for the exercise artifacts.

Everything the engine produces lands under ``<repo>/.vinv/exercise/`` so it sits
alongside identification's ``.vinv/identification`` and the extension's
``.vinv/probes`` without colliding. Writes are atomic (tmp + rename) to match the
discipline the extension's probe/insight writers use.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable
from pathlib import Path
from typing import Any

#: Directories no scan of a repo should descend into: vendored code, build
#: output and virtualenvs are not the repo's own source, and a match inside one
#: is someone else's package.
SKIP_DIRS = frozenset(
    {
        ".git",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        "site-packages",
        ".tox",
        "build",
        "dist",
    }
)

#: The marker the interpreter itself writes at the root of a virtualenv. A venv
#: is recognised by this and never by its directory NAME — the one that exposed
#: the interpreter bug was called ``.venv-target``.
VENV_MARKER = "pyvenv.cfg"

#: Pruned during the walk but NOT name-matched as venvs: descending is the only
#: way to find the marker, so ``.venv``/``venv`` are walked one level and then
#: stopped by the marker instead of by their name.
_WALK_PRUNE = (SKIP_DIRS - {".venv", "venv"}) | {".vinv"}


def walk_source_dirs(
    repo: Path, *, max_depth: int = 4
) -> tuple[list[tuple[Path, frozenset[str]]], list[Path]]:
    """One bounded, pruned walk of a repo. Returns ``(source dirs, venv roots)``.

    Every scan in this engine used to be its own ``rglob``, which cannot prune:
    the pattern is matched against the whole tree and the filter runs afterwards,
    so each one descended through ``.venv/**/site-packages`` in full — six times
    per run, on a tree where that is most of the files. ``os.walk`` lets the skip
    list stop the descent instead of the match.

    ``followlinks`` stays off, deliberately: ``Path.rglob`` follows directory
    symlinks on 3.12 (``recurse_symlinks`` only arrived in 3.13), so a repo with
    a symlink cycle hung the walk rather than being scanned.

    A venv is reported separately and never descended: it is a candidate
    INTERPRETER, and its ``site-packages`` holds every other project's manifests
    — reading those as the repo's own measured every candidate against pandas'
    dependency list.
    """
    repo = Path(repo)
    dirs: list[tuple[Path, frozenset[str]]] = []
    venvs: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(repo, followlinks=False):
        here = Path(dirpath)
        try:
            parts = here.relative_to(repo).parts
        except ValueError:  # pragma: no cover - os.walk cannot leave its root
            dirnames[:] = []
            continue
        names = frozenset(filenames)
        if VENV_MARKER in names:
            venvs.append(here)
            dirnames[:] = []
            continue
        if not any(p in SKIP_DIRS for p in parts):
            dirs.append((here, names))
        if len(parts) >= max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(d for d in dirnames if d not in _WALK_PRUNE)
    return dirs, venvs


def exercise_dir(repo: Path) -> Path:
    return repo / ".vinv" / "exercise"


def prompts_dir(repo: Path) -> Path:
    return exercise_dir(repo) / "prompts"


def prompt_path(repo: Path, api_id: str) -> Path:
    """The semantic-prompt file for an endpoint — sanitised, in ONE place.

    `plan` wrote `_safe(api_id).json` while `run`'s expiry used the raw id, so
    for an OpenAPI-synthesised id like `GET_items_{p}` the two named different
    files (`GET_items__p_.json` vs `GET_items_{p}.json`, the latter not even
    creatable on Windows). The expiry therefore never took effect: a scenario
    that had become environment-invalid was replayed on every subsequent run
    and the harness was never asked to re-author it — precisely what
    `_mark_expired_scenarios` exists to prevent. It fires for parameterised
    paths, which are also the ones most likely to need semantics.
    """
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in api_id)
    return prompts_dir(repo) / f"{safe}.json"


def baselines_dir(repo: Path) -> Path:
    return exercise_dir(repo) / "baselines"


def plan_path(repo: Path) -> Path:
    return exercise_dir(repo) / "plan.json"


def results_path(repo: Path) -> Path:
    return exercise_dir(repo) / "results.jsonl"


def bandit_path(repo: Path) -> Path:
    return exercise_dir(repo) / "bandit.json"


def profile_path(repo: Path) -> Path:
    return exercise_dir(repo) / "profile.json"


def profile_md_path(repo: Path) -> Path:
    return exercise_dir(repo) / "profile.md"


def invariants_path(repo: Path) -> Path:
    return exercise_dir(repo) / "invariants.json"


def issues_path(repo: Path) -> Path:
    return exercise_dir(repo) / "issues.json"


def read_invariants_by_endpoint(repo: Path) -> dict[str, list[dict[str, Any]]]:
    """The learned invariants from ``invariants.json``, keyed by "METHOD path".

    The map both ``run`` and ``regress`` ENFORCE against replayed responses.
    An absent or invalid document yields an empty map — enforcement has nothing
    to say until a profile has learned something.
    """
    doc = read_json(invariants_path(repo))
    out: dict[str, list[dict[str, Any]]] = {}
    if isinstance(doc, dict):
        for inv in doc.get("invariants") or []:
            if isinstance(inv, dict) and isinstance(inv.get("endpoint"), str) and _enforceable(inv):
                out.setdefault(inv["endpoint"], []).append(inv)
    return out


def _enforceable(inv: dict[str, Any]) -> bool:
    """Whether an invariant's params are the SHAPE the enforcer will index into.

    Only ``endpoint`` was validated, so a well-formed JSON document carrying
    drifted types reached the comparison and raised there: ``"5" <= 5`` is a
    bare ``TypeError``, and the enforcement call in run's round loop is
    unguarded, so one bad entry unwound the whole exercise and discarded every
    execution recorded so far (artifacts are written only after the loop).

    A subtler variant needs the same guard: ``str(v) not in values`` performs
    SUBSTRING matching when ``values`` is a string rather than a list, which
    fails silently instead of loudly.

    A malformed invariant is dropped, not fatal — enforcement simply has
    nothing to say about it.
    """
    params = inv.get("params")
    if params is None:
        return True
    if not isinstance(params, dict):
        return False
    if "values" in params and not isinstance(params["values"], list):
        return False
    for key in ("min", "max"):
        if key in params and (
            isinstance(params[key], bool) or not isinstance(params[key], int | float)
        ):
            return False
    return True


def apis_json_path(repo: Path) -> Path:
    return repo / ".vinv" / "identification" / "apis.json"


def reply_fingerprint(reply: Any) -> str | None:
    """Stable fingerprint of a harness reply (expiry is bound to one reply)."""
    if reply is None:
        return None
    import hashlib

    blob = json.dumps(reply, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def write_json(path: Path, data: Any) -> None:
    """Atomic pretty-printed JSON write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2, default=str) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    """Atomic JSONL write (whole file rewritten from ``rows``)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp-{os.getpid()}")
    with tmp.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, default=str) + "\n")
    os.replace(tmp, path)


def append_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    """Append rows to a JSONL file (creating it)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, default=str) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out
