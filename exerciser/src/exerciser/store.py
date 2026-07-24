"""Filesystem layout + atomic IO for the exercise artifacts.

Everything the engine produces lands under ``<repo>/.vinv/exercise/`` so it sits
alongside identification's ``.vinv/identification`` and the extension's
``.vinv/probes`` without colliding. Writes are atomic (tmp + rename) to match the
discipline the extension's probe/insight writers use.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable


def exercise_dir(repo: Path) -> Path:
    return repo / ".vinv" / "exercise"


def prompts_dir(repo: Path) -> Path:
    return exercise_dir(repo) / "prompts"


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
