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
