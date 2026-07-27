"""State ledger — what the exerciser planted in the service, and how to unwind it.

Exercising a live service MUTATES it: a 2xx POST can create a user, an item, a
token. That state outlives the run and poisons everything downstream — golden
baselines flip (a 404 "no such email" becomes a 200 once a generated signup
persisted that email), regress reports phantom behavior regressions, and in the
worst case the run invalidates its own credentials. Proven live on
full-stack-fastapi: `POST /users/signup` 200'd with the deterministic seed's
email, and the next session's regress flagged `POST /password-recovery/{email}`
404 → 200 as a behavior diff. That diff was environment drift, not a code change.

Three organs, all generic (no key names, no endpoint knowledge baked in):

1. **record_creations** — every mutating-method 2xx execution becomes a ledger
   row carrying the scalar values the exerciser injected (request) and received
   (response). Appended to ``state_ledger.jsonl`` — the durable record of what
   the engine planted, across runs.
2. **attempt_teardown** — best-effort unwind through the service's OWN api: a
   DELETE endpoint whose literal path prefix matches the creation's resource
   gets each response scalar tried in its path-param slot (2xx = cleaned).
   What cannot be unwound stays in the ledger as acknowledged pollution.
3. **planted_values / input_values** — the drift test regress uses: a diff whose
   replayed input intersects the planted set is ENVIRONMENT drift (the engine's
   own residue), not a behavior regression of the service under test.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import store
from .redact import PLACEHOLDER, redact

# Scalars shorter than this are too common to attribute (ids like "1", flags,
# enum words) — attributing them would classify every diff as drift.
_MIN_VALUE_LEN = 4

_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}

# Per-creation cap on DELETE attempts so teardown stays bounded even against a
# response body full of scalars.
_MAX_DELETE_TRIES = 3


def ledger_path(repo: Path) -> Path:
    return store.exercise_dir(repo) / "state_ledger.jsonl"


def scalar_values(obj: Any) -> set[str]:
    """Every attributable string scalar in a JSON-ish structure.

    Strings only: generated emails, uuids, tokens, names. Numbers and booleans
    are not attributable (a generated ``0`` matching a diff proves nothing).
    """
    out: set[str] = set()
    if isinstance(obj, str):
        if len(obj) >= _MIN_VALUE_LEN:
            out.add(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            out |= scalar_values(v)
    elif isinstance(obj, list | tuple):
        for v in obj:
            out |= scalar_values(v)
    return out


def record_creations(executions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ledger rows for every mutating 2xx execution of this run."""
    rows: list[dict[str, Any]] = []
    for ex in executions:
        status = ex.get("status")
        if ex.get("method") not in _MUTATING:
            continue
        if not (isinstance(status, int) and 200 <= status < 300):
            continue
        # redact() first: the ledger is persisted to state_ledger.jsonl inside the
        # user's repo, and these scalars are later spliced into teardown URLs. A
        # credential is never a resource id, so dropping it costs teardown nothing.
        planted = sorted(v for v in scalar_values(redact(ex.get("input"))) if v != PLACEHOLDER)
        response = sorted(v for v in scalar_values(redact(ex.get("body"))) if v != PLACEHOLDER)
        if not planted and not response:
            continue
        rows.append(
            {
                "endpoint_id": ex.get("endpoint_id"),
                "method": ex.get("method"),
                "path": ex.get("path"),
                "status": status,
                "planted": planted,
                "response_values": response,
                "cleaned": False,
            }
        )
    return rows


def _segments(path: str) -> list[str]:
    return [s for s in path.split("/") if s]


def _delete_targets(endpoints: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """DELETE endpoints shaped ``/literal/.../{param}`` — one trailing path param."""
    out = []
    for ep in endpoints:
        if str(ep.get("method", "")).upper() != "DELETE":
            continue
        segs = _segments(str(ep.get("path", "")))
        if not segs or not (segs[-1].startswith("{") and segs[-1].endswith("}")):
            continue
        if any(s.startswith("{") for s in segs[:-1]):
            continue  # only the trailing segment may be a param
        out.append({"path": ep["path"], "prefix": segs[:-1], "param": segs[-1][1:-1]})
    return out


def attempt_teardown(
    creations: list[dict[str, Any]],
    endpoints: list[dict[str, Any]],
    base_url: str,
    probe_fn: Callable[..., Any],
    auth_headers: list[dict[str, str]] | None = None,
    exercise_id: str = "vinv-teardown",
) -> int:
    """Unwind created resources through matching DELETE endpoints. Returns cleaned count.

    A DELETE template matches a creation when its literal prefix is a prefix of
    the creation path's segments (``POST /users/signup`` → ``DELETE /users/{id}``).
    Each response scalar is tried in the param slot; only ids WE received can be
    substituted, so a miss is a harmless 404. Tries anonymous first, then each
    captured auth header set.
    """
    targets = _delete_targets(endpoints)
    header_sets: list[dict[str, str]] = [{}] + list(auth_headers or [])
    cleaned = 0
    for row in creations:
        if row.get("cleaned"):
            continue
        segs = _segments(str(row.get("path", "")))
        candidates = list(row.get("response_values") or [])[:_MAX_DELETE_TRIES]
        if not candidates:
            continue
        # Attempt accounting: every teardown pass over this row is one attempt;
        # the outcome status is stamped after the tries below.
        row["teardown_attempts"] = int(row.get("teardown_attempts") or 0) + 1
        done = False
        for tgt in targets:
            if done or len(tgt["prefix"]) >= len(segs) + 1:
                continue
            if segs[: len(tgt["prefix"])] != tgt["prefix"]:
                continue
            for value in candidates:
                for headers in header_sets:
                    try:
                        res = probe_fn(
                            base_url,
                            "DELETE",
                            tgt["path"],
                            body=None,
                            path_params={tgt["param"]: value},
                            query={},
                            headers=headers,
                            exercise_id=exercise_id,
                        )
                    except Exception:
                        continue
                    if isinstance(res.status, int) and 200 <= res.status < 300:
                        row["cleaned"] = True
                        row["cleaned_via"] = f"DELETE {tgt['path']}"
                        cleaned += 1
                        done = True
                        break
                if done:
                    break
            if done:
                break
        row["teardown_status"] = (
            "cleaned"
            if row.get("cleaned")
            else ("failed-again" if row["teardown_attempts"] > 1 else "failed")
        )
    return cleaned


def reattempt_teardown(
    repo: Path,
    endpoints: list[dict[str, Any]],
    base_url: str,
    probe_fn: Callable[..., Any],
    *,
    auth_headers: list[dict[str, str]] | None = None,
    auth_headers_fn: Callable[[], list[dict[str, str]]] | None = None,
) -> dict[str, int]:
    """Run-start unwind of PRIOR runs' uncleaned planted values.

    Loaded from the ledger, retried through the same ``attempt_teardown``
    mechanism with the CURRENT credentials, and rewritten in place — so
    pollution stops accumulating instead of compounding run over run. Rows get
    ``teardown_status`` cleaned / failed-again and a monotone
    ``teardown_attempts`` count. ``auth_headers_fn`` is called lazily (it may
    replay login chains, which costs probes) and only when stale rows exist.
    Best-effort throughout: a failure here never blocks the run.
    """
    rows = store.read_jsonl(ledger_path(repo))
    stale = [r for r in rows if not r.get("cleaned") and (r.get("response_values"))]
    if not stale:
        return {"reattempted": 0, "cleaned": 0}
    headers = list(auth_headers or [])
    if not headers and auth_headers_fn is not None:
        try:
            headers = list(auth_headers_fn() or [])
        except Exception:
            headers = []
    cleaned = attempt_teardown(
        stale,
        endpoints,
        base_url,
        probe_fn,
        auth_headers=headers,
        exercise_id="vinv-reteardown",
    )
    # A run-start retry is by definition a re-attempt of a prior run's failure.
    for r in stale:
        if not r.get("cleaned"):
            r["teardown_status"] = "failed-again"
    store.write_jsonl(ledger_path(repo), rows)
    return {"reattempted": len(stale), "cleaned": cleaned}


def append_ledger(repo: Path, rows: list[dict[str, Any]]) -> None:
    if rows:
        store.append_jsonl(ledger_path(repo), rows)


def planted_values(repo: Path) -> set[str]:
    """Every value the engine ever planted and did NOT clean up, across runs."""
    out: set[str] = set()
    for row in store.read_jsonl(ledger_path(repo)):
        if row.get("cleaned"):
            continue
        for v in (row.get("planted") or []) + (row.get("response_values") or []):
            if isinstance(v, str):
                out.add(v)
    return out


def input_values(case_input: Any) -> set[str]:
    """The attributable scalars of one replay case's input (drift test)."""
    return scalar_values(case_input)
