"""Long-horizon context management — append-only log + compacted rolling summary.

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
"""

from __future__ import annotations

from typing import Any

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
