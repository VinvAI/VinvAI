"""Long-horizon context management — rolling summary + generation compaction.

A many-endpoint / many-round run produces a large ``results.jsonl`` (append-only,
the durable record). What feeds a harness prompt, though, must stay bounded, so
this module compacts the log into a ROLLING SUMMARY that keeps only the LATEST
per-endpoint profile line (status distribution, coverage, latency, top uncovered
symbols) — never the full execution history. The index/graph and the
``.vinv/exercise/`` artifacts are the persistent memory; a harness re-hydrates the
compacted summary with ONE read per episode.

``compact_results`` is deterministic and its output is bounded by a documented
token budget: at most ``max_endpoints`` lines, each capped in length, so the
prompt context stays under a stated ceiling regardless of how long the run was.
``estimate_tokens`` is the crude 4-chars/token heuristic used to assert the bound
in tests.

GENERATION COMPACTION (``compact_artifacts``) bounds the append-only logs
themselves, at ``exerciser run`` start:

* ``results.jsonl`` — keep the NEWEST row per ``(endpoint, strategy,
  input-fingerprint)`` plus a decayed sample of superseded history. The decay
  reuses the bandit's 50%-per-run discipline (``bandit.seed_from_prior``): a
  superseded row ``k`` generations behind the newest survives with probability
  ``0.5**k``, decided by a content-stable hash — so the expected retained
  history per key is ~1 row, the sample is deterministic, and re-running the
  compaction drops nothing further (idempotent: a survivor's generation index
  can only shrink, which only loosens its survival threshold).
* ``state_ledger.jsonl`` — drop rows whose planted values were confirmed
  cleaned, and rows whose endpoint vanished from the current plan (nothing can
  ever unwind or re-match them).
* ``optimize.jsonl`` / ``regress.jsonl`` — attempt-style logs, compacted with
  the SAME decayed-history mechanism keyed per episode label (optimize) or as
  one stream of replay summaries (regress).

Every compaction leaves a loud one-line summary artifact
(``compaction_summary.txt``) of exactly what was dropped, and warns on the log.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable

from . import store
from .state import ledger_path

# Documented budget: the compacted summary is capped so a harness prompt stays
# well under a small context window. ~4 chars/token → 6000 chars ≈ 1500 tokens.
MAX_ENDPOINTS = 60
MAX_LINE_CHARS = 200
TOKEN_BUDGET = 2000


def estimate_tokens(text: str) -> int:
    """Crude 4-characters-per-token estimate (upper-bounds real tokenisers)."""
    return (len(text) + 3) // 4


def _latest_per_endpoint(executions: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The most recent execution per endpoint (append-only → last wins)."""
    latest: dict[str, dict[str, Any]] = {}
    for ex in executions:
        latest[ex.get("endpoint_id", ex.get("api_id", "?"))] = ex
    return latest


def compact_results(
    executions: list[dict[str, Any]],
    coverage_rows: list[dict[str, Any]] | None = None,
    *,
    max_endpoints: int = MAX_ENDPOINTS,
    max_line_chars: int = MAX_LINE_CHARS,
) -> str:
    """A bounded, human+agent-legible rolling summary of the run so far.

    Keeps one line per endpoint (latest status + coverage + latency), sorted by
    coverage-gap so the endpoints that most need attention lead. The result is
    hard-capped to ``max_endpoints`` lines, each ``max_line_chars`` chars.
    """
    latest = _latest_per_endpoint(executions)
    cov_by_id = {c["api_id"]: c for c in (coverage_rows or [])}

    lines: list[str] = []
    for api_id, ex in latest.items():
        cov = cov_by_id.get(api_id, {})
        covered = cov.get("covered", 0)
        total = cov.get("total", 0)
        uncovered = ", ".join(cov.get("uncovered", [])[:3])
        line = (
            f"{ex.get('method')} {ex.get('path')} | "
            f"last={ex.get('status')} | cov={covered}/{total}"
            + (f" | gaps: {uncovered}" if uncovered else "")
        )
        gap = (total - covered) if total else 0
        lines.append((gap, line[:max_line_chars]))

    lines.sort(key=lambda t: (-t[0], t[1]))
    body = "\n".join(line for _, line in lines[:max_endpoints])
    header = f"# Exercise rolling summary ({len(latest)} endpoints)\n"
    return header + body


def within_budget(summary: str, budget: int = TOKEN_BUDGET) -> bool:
    return estimate_tokens(summary) <= budget


# ---- generation compaction of the append-only logs --------------------------

# Survival fraction per superseded generation — the SAME 50%-per-run decay the
# bandit applies to its posteriors (``bandit.seed_from_prior``); one expiry
# discipline for all learned/accumulated state, not two.
HISTORY_DECAY = 0.5


def _row_unit(row: dict[str, Any]) -> float:
    """A content-stable uniform draw in [0, 1) for one row (deterministic)."""
    blob = json.dumps(row, sort_keys=True, default=str)
    return int(hashlib.sha256(blob.encode("utf-8")).hexdigest()[:8], 16) / float(0x100000000)


def input_fingerprint(value: Any) -> str:
    """Stable fingerprint of a probe input (the results-log dedup key part)."""
    blob = json.dumps(value, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def decayed_compact(
    rows: list[dict[str, Any]],
    key_fn: Callable[[dict[str, Any]], str],
    *,
    decay: float = HISTORY_DECAY,
) -> tuple[list[dict[str, Any]], int]:
    """Newest row per key always survives; superseded history decays at 50%/gen.

    A row ``k`` generations behind its key's newest survives iff its
    content-stable hash draw is below ``decay**k``. Deterministic, and
    IDEMPOTENT: after a compaction every survivor's ``k`` is ≤ its previous
    ``k`` (dropped rows only close gaps), so its threshold only loosens and a
    second pass drops nothing. Returns ``(kept_rows, dropped_count)``;
    ``kept_rows`` preserves file order.
    """
    by_key: dict[str, list[int]] = {}
    for i, row in enumerate(rows):
        by_key.setdefault(key_fn(row), []).append(i)
    keep: set[int] = set()
    for idxs in by_key.values():
        for k, i in enumerate(reversed(idxs)):  # k=0 is the newest for this key
            if k == 0 or _row_unit(rows[i]) < decay ** k:
                keep.add(i)
    kept = [rows[i] for i in sorted(keep)]
    return kept, len(rows) - len(kept)


def _results_key(row: dict[str, Any]) -> str:
    return json.dumps(
        [row.get("endpoint_id"), row.get("strategy"), input_fingerprint(row.get("input"))],
        sort_keys=True, default=str,
    )


def _optimize_key(row: dict[str, Any]) -> str:
    """Per-episode-target key: label first, else the opportunity identity."""
    label = row.get("label")
    if label:
        return str(label)
    opp = row.get("opportunity") or {}
    return json.dumps([opp.get("kind"), opp.get("endpoint_id"), opp.get("endpoint")],
                      sort_keys=True, default=str)


def compact_state_ledger(
    rows: list[dict[str, Any]], plan_api_ids: set[str],
) -> tuple[list[dict[str, Any]], int]:
    """Drop confirmed-cleaned rows and rows whose endpoint left the plan.

    A cleaned row's pollution is gone; a vanished endpoint's row can never be
    unwound (no DELETE will match) nor re-matched by regress against a plan
    that no longer exercises it. Rows without an endpoint id are kept — their
    disappearance cannot be confirmed.
    """
    kept: list[dict[str, Any]] = []
    for row in rows:
        if row.get("cleaned"):
            continue
        ep = row.get("endpoint_id")
        if ep is not None and plan_api_ids and ep not in plan_api_ids:
            continue
        kept.append(row)
    return kept, len(rows) - len(kept)


def compaction_summary_path(repo: Path) -> Path:
    return store.exercise_dir(repo) / "compaction_summary.txt"


def compact_artifacts(
    repo: Path,
    plan: dict[str, Any],
    *,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Run-start generation compaction of every unbounded exercise log.

    Idempotent (a second pass with no new appends drops nothing) and LOUD: the
    one-line record of what was dropped lands in ``compaction_summary.txt`` and
    on the log as a warning whenever anything was dropped.
    """
    log = logger or logging.getLogger(__name__)
    plan_api_ids = {str(ep.get("api_id")) for ep in plan.get("endpoints", [])}

    targets: list[tuple[Path, Callable[[list[dict[str, Any]]], tuple[list[dict[str, Any]], int]]]] = [
        (store.results_path(repo), lambda rows: decayed_compact(rows, _results_key)),
        (ledger_path(repo), lambda rows: compact_state_ledger(rows, plan_api_ids)),
        (store.exercise_dir(repo) / "optimize.jsonl",
         lambda rows: decayed_compact(rows, _optimize_key)),
        (store.exercise_dir(repo) / "regress.jsonl",
         lambda rows: decayed_compact(rows, lambda _r: "replay")),
    ]

    dropped: dict[str, dict[str, int]] = {}
    parts: list[str] = []
    for path, compactor in targets:
        rows = store.read_jsonl(path)
        if not rows:
            continue
        kept, n_dropped = compactor(rows)
        if n_dropped > 0:
            store.write_jsonl(path, kept)
        dropped[path.name] = {"before": len(rows), "after": len(kept),
                              "dropped": n_dropped}
        parts.append(f"{path.name} {len(rows)}->{len(kept)} (-{n_dropped})")

    total = sum(d["dropped"] for d in dropped.values())
    line = (f"compaction @{int(time.time())}: "
            + (", ".join(parts) if parts else "no logs present"))
    # Loud one-line artifact (atomic: tmp + rename, matching store's discipline).
    out = compaction_summary_path(repo)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + f".tmp-{os.getpid()}")
    tmp.write_text(line + "\n", encoding="utf-8")
    os.replace(tmp, out)
    if total > 0:
        log.warning("%s", line)
    else:
        log.info("%s", line)
    return {"dropped": dropped, "total_dropped": total, "line": line}
