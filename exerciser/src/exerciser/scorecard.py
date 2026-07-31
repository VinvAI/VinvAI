"""Per-service SCORECARD — exploration-grade presentation with the WHY.

Assembles the run's artifacts into ``.vinv/exercise/scorecard.{json,md}``:
endpoints n/m, coverage before→after (traffic-only baseline vs after exercising),
invariants learned, issues found (with signatures for episode links), latency
profile, and — when an optimization cycle ran — per-metric before→after with CI
and what-changed-and-why. Includes mermaid diagrams for a stateful scenario and
the improve→verify→revert→retry loop.

Pure assembly over already-persisted artifacts (deterministic); no live calls.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import compaction, state, store


def _traffic_only_baseline(repo: Path) -> dict[str, Any]:
    """The BEFORE picture: identification's tracesummary (traffic-only coverage).

    This is exactly the pre-exerciser state — endpoints exercised only by the
    traffic the trace happened to see (e.g. POST /utils/test-email at 0/4).
    """
    data = store.read_json(repo / ".vinv" / "identification" / "tracesummary.json")
    if not isinstance(data, dict):
        return {"exercised": 0, "total": 0}
    return {
        "exercised": data.get("exercised_count", 0),
        "total": data.get("api_count", 0),
    }


#: What each unit kind is called in prose, singular/plural.
_UNIT_NOUNS: dict[str, tuple[str, str]] = {
    "http_endpoint": ("endpoint", "endpoints"),
    "cli_invocation": ("CLI invocation", "CLI invocations"),
    "function_call": ("driven call", "driven calls"),
}


def _units_by_kind(units: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for u in units:
        kind = str(u.get("unit_kind", "http_endpoint"))
        counts[kind] = counts.get(kind, 0) + 1
    return dict(sorted(counts.items()))


def _unit_noun(units: list[dict[str, Any]]) -> str:
    """The plural noun for a set of units — "endpoints" only when they are.

    A mixed set gets the neutral "units", which is what the word was always
    standing in for.
    """
    kinds = set(_units_by_kind(units))
    if len(kinds) == 1:
        return _UNIT_NOUNS.get(kinds.pop(), ("unit", "units"))[1]
    return "units"


def build_scorecard(
    repo: Path,
    *,
    service: str | None = None,
) -> dict[str, Any]:
    """Assemble and persist the scorecard from on-disk artifacts."""
    repo = repo.resolve()
    plan = store.read_json(store.plan_path(repo)) or {}
    profile = store.read_json(store.profile_path(repo)) or {}
    invariants = store.read_json(store.invariants_path(repo)) or {}
    issues = store.read_json(store.issues_path(repo)) or {}
    bandit = store.read_json(store.bandit_path(repo)) or {}

    before = _traffic_only_baseline(repo)
    endpoints = profile.get("endpoints", [])
    with_cov = sum(1 for e in endpoints if e.get("coverage", {}).get("covered", 0) > 0)

    per_endpoint = []
    for e in endpoints:
        cov = e.get("coverage", {})
        per_endpoint.append(
            {
                "endpoint": f"{e['method']} {e['path']}",
                # Which oracle produced this unit. The row is still keyed
                # `endpoint` — every reader joins on that and the profile has
                # always spelled a non-HTTP unit as `METHOD path` too — but a
                # consumer that wants to say "3 CLI invocations, 12 calls"
                # rather than "15 endpoints" needs the distinction stated.
                "unit_kind": e.get("unit_kind", "http_endpoint"),
                "coverage": f"{cov.get('covered', 0)}/{cov.get('total', 0)}",
                "pct": cov.get("pct", 0.0),
                "handler_observed": cov.get("handler_observed", False),
                "p50_ms": e.get("latency", {}).get("p50_ms", 0.0),
                "p95_ms": e.get("latency", {}).get("p95_ms", 0.0),
                "invariants": len(e.get("invariants", [])),
                "statuses": e.get("status_distribution", {}),
            }
        )

    scorecard: dict[str, Any] = {
        "version": 1,
        "service": service or plan.get("service"),
        "repo": str(repo),
        "coverage": {
            "before_traffic_only": before,
            "after_exercised": {
                "endpoints_with_coverage": with_cov,
                "endpoints_total": len(endpoints),
                "symbols_covered": profile.get("total_symbols_covered", 0),
                "symbols_total": profile.get("total_symbols", 0),
                # How the total breaks down by oracle. A repo reporting
                # "14 endpoints" when it has none — because every unit is a CLI
                # invocation or a driven call — is not wrong about the number,
                # only about the noun.
                "units_by_kind": _units_by_kind(endpoints),
            },
        },
        "invariants_learned": invariants.get("count", 0),
        "issue_clusters": issues.get("cluster_count", 0),
        "issues": [
            {"signature": c.get("signature"), "kind": c.get("kind"), "title": c.get("title")}
            for c in issues.get("clusters", [])
        ],
        "bandit_pooled": bandit.get("pooled", {}),
        "endpoints": per_endpoint,
        "input_source": plan.get("input_source"),
        "scenarios": _scenario_health(repo),
        "state_pollution": _state_pollution(repo),
    }
    store.write_json(store.exercise_dir(repo) / "scorecard.json", scorecard)
    (store.exercise_dir(repo) / "scorecard.md").write_text(
        render_scorecard_md(scorecard), encoding="utf-8"
    )
    scorecard["output_file"] = str(store.exercise_dir(repo) / "scorecard.json")
    return scorecard


def _scenario_health(repo: Path) -> dict[str, Any]:
    """Authored-scenario health — expiry is a loud signal, not a silent 401 run."""
    doc = store.read_json(store.exercise_dir(repo) / "scenarios.json") or {}
    scenarios = doc.get("scenarios", [])
    return {
        "run": len(scenarios),
        "completed": sum(1 for s in scenarios if s.get("completed")),
        "expired": [
            {"name": s.get("name"), "reason": s.get("expired_reason")}
            for s in scenarios
            if s.get("expired")
        ],
    }


def _state_pollution(repo: Path) -> dict[str, Any]:
    """What the engine planted in the service and could not unwind."""
    rows = store.read_jsonl(state.ledger_path(repo))
    uncleaned = [r for r in rows if not r.get("cleaned")]
    # Compaction prunes cleaned rows from the ledger (they are no longer work to
    # do), so counting the live file alone made these totals shrink over time
    # and report the teardown machinery doing nothing while it worked. The
    # rolled-up totals carry what compaction removed.
    doc = store.read_json(compaction.state_totals_path(repo))
    totals = doc if isinstance(doc, dict) else {}
    prior_created = int(totals.get("created_total") or 0)
    prior_cleaned = int(totals.get("cleaned_total") or 0)
    return {
        "created": prior_created + len(rows),
        "cleaned": prior_cleaned + sum(1 for r in rows if r.get("cleaned")),
        "uncleaned": len(uncleaned),
        "uncleaned_endpoints": sorted({f"{r.get('method')} {r.get('path')}" for r in uncleaned}),
    }


_IMPROVE_LOOP_MERMAID = """```mermaid
flowchart LR
  P[Profile: P95 / throughput outliers] --> D[Detect opportunity]
  D --> E[Optimization episode]
  E --> V{Behavior suite byte/shape-identical?}
  V -- no --> R[Auto-revert + record why]
  V -- yes --> M{Metric improved? paired bootstrap 95% CI excludes 0}
  M -- no --> R
  M -- yes --> A[Accept]
  R --> L[Learning note into retry context]
  L --> E
```"""


def _scenario_mermaid() -> str:
    return """```mermaid
sequenceDiagram
  participant X as Exerciser
  participant S as Service
  X->>S: POST /users/signup {email,password}
  S-->>X: 200 {id}
  X->>S: POST /login/access-token (form)
  S-->>X: 200 {access_token}
  X->>S: POST /items/ (Bearer ${access_token}) {title}
  S-->>X: 200 {id: ${item_id}}
  X->>S: GET /items/${item_id} (Bearer ${access_token})
  S-->>X: 200 {id,title}
  X->>S: DELETE /items/${item_id} (Bearer ${access_token})
  S-->>X: 200
```"""


def render_scorecard_md(sc: dict[str, Any]) -> str:
    before = sc["coverage"]["before_traffic_only"]
    after = sc["coverage"]["after_exercised"]
    units = sc.get("endpoints", [])
    # "14 endpoints" on a repo that has none — because every unit is a CLI
    # invocation or a driven call — is not wrong about the number, only about
    # the noun. A mixed set gets "units", which is what it always meant.
    noun = _unit_noun(units)
    by_kind = after.get("units_by_kind") or {}
    breakdown = (
        [
            "- Breakdown: "
            + " · ".join(
                f"**{count}** {_UNIT_NOUNS.get(kind, ('unit', 'units'))[1 if count != 1 else 0]}"
                for kind, count in sorted(by_kind.items())
            )
        ]
        if len(by_kind) > 1
        else []
    )
    lines: list[str] = [
        f"# Behavior scorecard — {sc.get('service') or 'service'}",
        "",
        f"Input source: **{sc.get('input_source')}**",
        "",
        "## Coverage: before → after",
        "",
        f"- Traffic-only baseline (identification tracesummary): "
        f"**{before.get('exercised', 0)}/{before.get('total', 0)}** endpoints exercised",
        f"- After exercising: **{after['endpoints_with_coverage']}/{after['endpoints_total']}** "
        f"{noun} with coverage · "
        f"**{after['symbols_covered']}/{after['symbols_total']}** symbols",
        f"- Invariants learned: **{sc['invariants_learned']}** · "
        f"Issue clusters: **{sc['issue_clusters']}**",
        *breakdown,
        "",
        "## Per-unit",
        "",
        "| unit | kind | coverage | P50 | P95 | invariants | statuses |",
        "|---|---|---|---|---|---|---|",
    ]
    for e in sc["endpoints"]:
        statuses = ", ".join(f"{k}:{v}" for k, v in sorted(e["statuses"].items()))
        kind = _UNIT_NOUNS.get(str(e.get("unit_kind", "http_endpoint")), ("unit", "units"))[0]
        lines.append(
            f"| {e['endpoint']} | {kind} | {e['coverage']} ({e['pct']}%) | "
            f"{e['p50_ms']}ms | {e['p95_ms']}ms | {e['invariants']} | {statuses} |"
        )
    lines += ["", "## Issue clusters", ""]
    if sc["issues"]:
        for i in sc["issues"]:
            lines.append(f"- `{i['signature']}` [{i['kind']}] {i['title']}")
    else:
        lines.append("- none")
    lines += [
        "",
        "## Stateful scenario (variable capture/substitution)",
        "",
        _scenario_mermaid(),
        "",
        "## The improve → verify → revert → learn → retry loop",
        "",
        _IMPROVE_LOOP_MERMAID,
        "",
    ]
    return "\n".join(lines) + "\n"
