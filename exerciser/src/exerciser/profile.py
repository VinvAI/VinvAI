"""The behavioral profile — one per endpoint.

From ``results.jsonl`` (every execution) and the freshest coverage join, build,
per endpoint:

* inputs explored, by class (valid / boundary / negative / observed / semantic);
* status/exception distribution;
* latency P50 / P95;
* symbol coverage ``n/m`` plus the uncovered symbol NAMES;
* side-effect signals mined from the trace spans;
* learned invariants (Daikon-lite, ``invariants.py``).

Writes ``profile.json`` (machine) + ``profile.md`` (the human report rendered by
``render_profile_md``) + ``invariants.json``.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from . import store
from .coverage import endpoint_coverage
from .invariants import Observation, learn_invariants
from .optimize import detect_opportunities


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = (len(ordered) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(ordered) - 1)
    frac = k - lo
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * frac, 3)


def _side_effects_for_handler(repo: Path, handler: str | None) -> list[str]:
    """Distinct side-effect tags recorded on this handler's trace spans.

    tracelens exit rows carry a ``side_effects`` list; a handler that writes a
    DB, sends email, or mutates a cache surfaces those here.
    """
    if not handler:
        return []
    caps = repo / ".vinv" / "captures"
    if not caps.is_dir():
        return []
    traces = [p for p in caps.rglob("trace.jsonl") if p.is_file() and p.stat().st_size > 0]
    if not traces:
        return []
    newest = max(traces, key=lambda p: p.stat().st_mtime)
    effects: set[str] = set()
    try:
        for line in newest.read_text(encoding="utf-8").splitlines():
            if '"side_effects"' not in line:
                continue
            ev = json.loads(line)
            comp = ev.get("component", "")
            if not comp.endswith("." + handler):
                continue
            for se in ev.get("side_effects", []) or []:
                effects.add(se if isinstance(se, str) else json.dumps(se, sort_keys=True))
    except (OSError, ValueError):
        return []
    return sorted(effects)


def _endpoint_profile(
    repo: Path,
    ep_execs: list[dict[str, Any]],
    api_id: str,
    method: str,
    path: str,
    handler: str | None,
    *,
    service: str | None,
    store_dir: str | None,
    logger: logging.Logger,
) -> dict[str, Any]:
    # Inputs explored by class.
    by_class: dict[str, int] = {}
    for ex in ep_execs:
        by_class[ex["input_class"]] = by_class.get(ex["input_class"], 0) + 1

    # Status / exception distribution.
    status_dist: dict[str, int] = {}
    for ex in ep_execs:
        key = (
            str(ex.get("status"))
            if ex.get("status") is not None
            else (ex.get("error") or "no-response")
        )
        status_dist[key] = status_dist.get(key, 0) + 1

    latencies = [float(ex["latency_ms"]) for ex in ep_execs if ex.get("latency_ms") is not None]

    # A non-HTTP unit wrote its OWN capture (the invocation oracle records the
    # path on every row). Without this the join falls back to "the service's
    # newest trace", which for a CLI unit is either absent or another unit's
    # run — coverage attributed to the wrong work is worse than none.
    unit_trace = next((ex.get("trace_jsonl") for ex in ep_execs if ex.get("trace_jsonl")), None)
    # A driven call is not a declared entry point, so there is no api_id to look
    # up — its `module:qualname` target IS the root. Passed as the fallback, so
    # a unit that does happen to be declared still resolves that way first.
    unit_symbol = api_id if ep_execs and ep_execs[0].get("unit_kind") == "function_call" else None

    cov = endpoint_coverage(
        repo,
        api_id,
        service=service,
        store_dir=store_dir,
        trace=unit_trace,
        handler=handler,
        symbol=unit_symbol,
        logger=logger,
    )

    # Invariants over the SUCCESSFUL responses.
    obs: list[Observation] = []
    idx = 0
    for ex in ep_execs:
        if ex.get("status_class") != "2xx-3xx":
            continue
        idx += 1
        obs.append(
            Observation(
                body=ex.get("body"),
                output_size=ex.get("output_size", 0),
                input_size=ex.get("input_size", 0),
                call_index=idx,
            )
        )
    invariants = learn_invariants(obs)

    return {
        "api_id": api_id,
        "method": method,
        "path": path,
        "handler": handler,
        "inputs_explored": by_class,
        "status_distribution": status_dist,
        "latency": {"p50_ms": _percentile(latencies, 0.5), "p95_ms": _percentile(latencies, 0.95)},
        "coverage": {
            "covered": cov.get("covered", 0),
            "total": cov.get("total", 0),
            "pct": cov.get("pct", 0.0),
            "uncovered": cov.get("uncovered", []),
            "handler_observed": cov.get("handler_observed", False),
        },
        "side_effects": _side_effects_for_handler(repo, handler),
        "invariants": [i.to_json() for i in invariants],
    }


#: How each oracle's rows name their unit, and the pseudo-method the unit reads
#: as. The HTTP path already writes `endpoint_id`/`method`/`path`; the other two
#: name the same three things differently because they are not endpoints.
_UNIT_SOURCES: tuple[tuple[str, str, str, str], ...] = (
    ("invocation_results.jsonl", "cli_invocation", "unit_id", "RUN"),
    ("function_results.jsonl", "function_call", "target_id", "CALL"),
)


def unit_executions(repo: Path) -> list[dict[str, Any]]:
    """Every exercised unit, normalized to the profile's shape.

    A profile keyed strictly on HTTP endpoints made a whole class of repo
    unprofilable: a toolchain or a library has no endpoints, so `build_profile`
    returned "no results.jsonl" no matter how much of it had been driven. The
    three oracles already produce the same *kind* of row — an input class, an
    outcome, a duration — they just name their unit differently, so the join is
    a rename rather than a second profiler.

    Rows keep their `unit_kind`, so a reader can tell a driven function from a
    served request rather than seeing them silently pooled.
    """
    executions: list[dict[str, Any]] = []
    for row in store.read_jsonl(store.results_path(repo)):
        row.setdefault("unit_kind", "http_endpoint")
        executions.append(row)
    for filename, kind, id_field, method in _UNIT_SOURCES:
        for row in store.read_jsonl(store.exercise_dir(repo) / filename):
            unit_id = row.get(id_field) or row.get("unit_id")
            if not unit_id:
                continue
            row.setdefault("unit_kind", kind)
            row["endpoint_id"] = str(unit_id)
            row.setdefault("method", method)
            # A CLI row's `path` is the command line; a function row has none,
            # so the target itself is the label.
            row["path"] = str(row.get("path") or unit_id)
            row.setdefault("input_class", "declared")
            executions.append(row)
    return executions


def build_profile(
    repo: Path,
    *,
    service: str | None = None,
    store_dir: str | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Build and persist the behavioral profile + report. Returns the profile dict."""
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()

    executions = unit_executions(repo)
    if not executions:
        return {
            "status": "error",
            "error": (
                "nothing has been exercised yet — run `exerciser run` (HTTP), "
                "`exerciser invocations` (CLIs) or `exerciser functions` (libraries) "
                "first"
            ),
        }

    by_ep: dict[str, list[dict[str, Any]]] = {}
    meta: dict[str, tuple[str, str, str | None]] = {}
    for ex in executions:
        eid = ex["endpoint_id"]
        by_ep.setdefault(eid, []).append(ex)
        # results.jsonl is append-only across engine versions: rows written
        # before the handler field existed carry None. Take method/path from
        # the first sighting but UPGRADE the handler from any later row that
        # knows it — otherwise one legacy row pins the join to None forever.
        known = meta.get(eid)
        if known is None or (known[2] is None and ex.get("handler")):
            meta[eid] = (ex["method"], ex["path"], ex.get("handler"))

    profiles: list[dict[str, Any]] = []
    all_invariants: list[dict[str, Any]] = []
    for api_id, ep_execs in sorted(by_ep.items()):
        method, path, handler = meta[api_id]
        prof = _endpoint_profile(
            repo,
            ep_execs,
            api_id,
            method,
            path,
            handler,
            service=service,
            store_dir=store_dir,
            logger=log,
        )
        # Which oracle produced this unit. Without it a driven function and a
        # served request are indistinguishable in the profile, and the views
        # would have to guess from the pseudo-method.
        prof["unit_kind"] = ep_execs[0].get("unit_kind", "http_endpoint")
        profiles.append(prof)
        for inv in prof["invariants"]:
            all_invariants.append({"endpoint": f"{method} {path}", **inv})

    total_cov = sum(p["coverage"]["covered"] for p in profiles)
    total_sym = sum(p["coverage"]["total"] for p in profiles)
    result: dict[str, Any] = {
        "status": "ok",
        "repo": str(repo),
        "endpoint_count": len(profiles),
        "endpoints_with_coverage": sum(1 for p in profiles if p["coverage"]["covered"] > 0),
        "total_symbols_covered": total_cov,
        "total_symbols": total_sym,
        "invariants_learned": len(all_invariants),
        "endpoints": profiles,
    }
    # Optimization opportunities (P95 outliers etc.) — the seeds the improve loop
    # dispatches as optimization episodes.
    result["opportunities"] = [o.to_json() for o in detect_opportunities(result)]
    store.write_json(store.profile_path(repo), result)
    store.write_json(
        store.invariants_path(repo),
        {
            "version": 1,
            "count": len(all_invariants),
            "invariants": all_invariants,
        },
    )
    store.profile_md_path(repo).write_text(render_profile_md(result), encoding="utf-8")
    result["output_file"] = str(store.profile_path(repo))
    result["report_file"] = str(store.profile_md_path(repo))
    return result


def render_profile_md(profile: dict[str, Any]) -> str:
    """Render the human report: a run-wide summary line, then one section per
    endpoint carrying inputs explored by class, the status distribution, symbol
    coverage with the uncovered names, P50/P95 latency, and any side effects and
    learned invariants."""
    lines: list[str] = ["# Behavioral profile", ""]
    lines.append(
        f"{profile['endpoint_count']} endpoints exercised · "
        f"{profile['total_symbols_covered']}/{profile['total_symbols']} symbols covered · "
        f"{profile['invariants_learned']} invariants learned"
    )
    lines.append("")
    for p in profile["endpoints"]:
        lines.append(f"## {p['method']} {p['path']}")
        lines.append(f"handler: `{p['handler'] or '?'}`")
        lines.append("")
        lines.append("**Inputs explored**")
        for cls, n in sorted(p["inputs_explored"].items()):
            lines.append(f"- {cls}: {n}")
        lines.append("")
        lines.append("**Outputs (status distribution)**")
        for status, n in sorted(p["status_distribution"].items()):
            lines.append(f"- {status}: {n}")
        lines.append("")
        cov = p["coverage"]
        lines.append(
            f"**Coverage** — {cov['covered']}/{cov['total']} symbols "
            f"({cov['pct']}%)"
            + (", handler observed" if cov["handler_observed"] else ", handler NOT observed")
        )
        if cov["uncovered"]:
            shown = ", ".join(cov["uncovered"][:10])
            more = "" if len(cov["uncovered"]) <= 10 else f" (+{len(cov['uncovered']) - 10} more)"
            lines.append(f"- uncovered: {shown}{more}")
        lines.append("")
        lines.append(
            f"**Execution time** — P50 {p['latency']['p50_ms']}ms · P95 {p['latency']['p95_ms']}ms"
        )
        lines.append("")
        if p["side_effects"]:
            lines.append("**Side effects**")
            for se in p["side_effects"]:
                lines.append(f"- {se}")
            lines.append("")
        if p["invariants"]:
            lines.append("**Invariants**")
            for inv in p["invariants"]:
                lines.append(
                    f"- {inv['description']} (support {inv['support']}, "
                    f"confidence {inv['confidence']})"
                )
            lines.append("")
    return "\n".join(lines) + "\n"
