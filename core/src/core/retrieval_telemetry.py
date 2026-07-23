"""Retrieval decision/feedback telemetry for the Python agent surface.

Mirrors the VS Code extension's MCP telemetry (vinv-vs
``src/mcp/retrievalTelemetry.ts``) byte-for-byte where it matters, so both
surfaces write compatible events into the same ledger
(``~/.vinv/telemetry/retrieval.jsonl``) and the offline policy evaluator
(``index/eval/off_policy.py``) learns from Python-agent retrievals exactly as
it does from editor retrievals:

* the epoch is the identical sha256 over the store's ``meta.json`` +
  ``manifest.json`` (24 hex chars), so events from both surfaces join;
* query features are content-safe (hash + shape only — never the query text);
* epsilon-greedy exploration uses the same env knobs
  (``VINV_RETRIEVAL_POLICY_MODE``, ``VINV_RETRIEVAL_ACTIONS``,
  ``VINV_RETRIEVAL_EPSILON``) and logs exact per-action propensities.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
import time
import uuid
from pathlib import Path
from typing import Any

_CODE_IDENTIFIER = re.compile(r"[_:.()\[\]{}]")


def _vinv_home() -> Path:
    override = os.environ.get("VINV_HOME", "").strip()
    return Path(override) if override else Path.home() / ".vinv"


def _telemetry_path() -> Path:
    return _vinv_home() / "telemetry" / "retrieval.jsonl"


def retrieval_epoch(store_dir: str | os.PathLike[str]) -> str:
    """Identical to the extension's epoch: sha256(meta.json + manifest.json)."""
    digest = hashlib.sha256()
    store = Path(store_dir)
    for filename in ("meta.json", "manifest.json"):
        try:
            digest.update((store / filename).read_bytes())
        except OSError:
            digest.update(f"{filename}:missing".encode())
    return digest.hexdigest()[:24]


def query_features(query: str) -> dict[str, Any]:
    """Content-safe query shape — hash and counts, never the text."""
    words = [w for w in query.strip().split() if w]
    return {
        "query_hash": hashlib.sha256(query.encode()).hexdigest()[:24],
        "char_count": len(query),
        "token_estimate": math.ceil(len(query) / 4),
        "word_count": len(words),
        "has_code_identifier": any(_CODE_IDENTIFIER.search(w) for w in words),
    }


def retrieval_action_set(requested_top_k: int) -> list[int]:
    raw = os.environ.get("VINV_RETRIEVAL_ACTIONS", "3,5,8,10")
    parsed = []
    for part in raw.split(","):
        try:
            value = int(part.strip())
        except ValueError:
            continue
        if 1 <= value <= 20:
            parsed.append(value)
    actions = parsed or [3, 5, 8, 10]
    if requested_top_k not in actions:
        actions.append(requested_top_k)
    return sorted(set(actions))


def exploration_epsilon() -> float:
    try:
        raw = float(os.environ.get("VINV_RETRIEVAL_EPSILON", "0.1"))
    except ValueError:
        return 0.1
    return raw if 0 <= raw <= 0.5 else 0.1


def select_retrieval_action(
    requested_top_k: int, random_value: float | None = None
) -> dict[str, Any]:
    """Epsilon-greedy action selection with exact logged propensities.

    The Python surface has no canary/policy file plumbing (that lives in the
    editor); it participates in learning through the explore/off modes.
    propensity(a) = eps/|A| + (1-eps)*[a == requested].
    """
    mode = os.environ.get("VINV_RETRIEVAL_POLICY_MODE", "shadow")
    if mode != "explore":
        return {"top_k": requested_top_k, "propensity": 1.0, "policy": "baseline"}
    actions = retrieval_action_set(requested_top_k)
    epsilon = exploration_epsilon()
    draw = random.random() if random_value is None else random_value
    chosen = requested_top_k
    if epsilon > 0 and draw < epsilon:
        index = min(int((draw / epsilon) * len(actions)), len(actions) - 1)
        chosen = actions[index]
    propensity = epsilon / len(actions) + (
        1 - epsilon if chosen == requested_top_k else 0.0
    )
    return {
        "top_k": chosen,
        "propensity": propensity,
        "policy": "baseline" if chosen == requested_top_k else "explore",
    }


def append_retrieval_event(event: dict[str, Any]) -> None:
    """Append one event; telemetry must never break retrieval itself."""
    target = _telemetry_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event) + "\n")
        os.chmod(target, 0o600)
    except OSError:
        pass


def result_fingerprints(results: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    """(hashes, files) for the first 20 hits — same shape as the extension."""
    hashes = [
        hashlib.sha256(
            json.dumps(result, separators=(",", ":"), sort_keys=False).encode()
        ).hexdigest()[:24]
        for result in results[:20]
    ]
    files: list[str] = []
    for result in results[:20]:
        file = result.get("file")
        if isinstance(file, str) and file and file not in files:
            files.append(file)
    return hashes, files


def log_retrieval_decision(
    *,
    store_dir: str | os.PathLike[str],
    query: str,
    requested_top_k: int,
    selection: dict[str, Any],
    latency_ms: float,
    results: list[dict[str, Any]],
) -> str:
    """Log one decision event; returns the decision id for feedback joins."""
    decision_id = uuid.uuid4().hex
    hashes, _files = result_fingerprints(results)
    append_retrieval_event(
        {
            "type": "decision",
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            + f".{int(time.time() * 1000) % 1000:03d}Z",
            "decision_id": decision_id,
            "epoch": retrieval_epoch(store_dir),
            "surface": "python-agent",
            "features": query_features(query),
            "action": {"top_k": selection["top_k"], "policy": selection["policy"]},
            "served_top_k": selection["top_k"],
            "propensity": selection["propensity"],
            "fallback": False,
            "shadow_action": None,
            "latency_ms": round(latency_ms, 3),
            "result_count": len(results),
            "result_hashes": hashes,
        }
    )
    return decision_id


def record_retrieval_feedback(
    decision_id: str,
    reward: float,
    *,
    store_dir: str | os.PathLike[str],
    outcome: str | None = None,
) -> None:
    """Explicit reward for an earlier decision (same schema as vinv_feedback)."""
    append_retrieval_event(
        {
            "type": "feedback",
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "decision_id": decision_id,
            "epoch": retrieval_epoch(store_dir),
            "source": "explicit",
            "reward": float(reward),
            "outcome": (outcome or "")[:80] or None,
        }
    )


__all__ = [
    "append_retrieval_event",
    "exploration_epsilon",
    "log_retrieval_decision",
    "query_features",
    "record_retrieval_feedback",
    "result_fingerprints",
    "retrieval_action_set",
    "retrieval_epoch",
    "select_retrieval_action",
]
