"""T1.4 / T2.3 — write ``<output>.summary.json`` next to the JSONL on shutdown.

A standalone module so ``tracelens summarize <log>`` can also produce one post-hoc.
"""

from __future__ import annotations

import json
import logging
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

_log = logging.getLogger("tracelens.diag")


def _percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    idx = max(0, min(len(sorted_values) - 1, int(p * (len(sorted_values) - 1))))
    return sorted_values[idx]


def summarize_jsonl(log_path: Path) -> dict[str, Any]:
    """Stream the JSONL once; report counts, errors, latency percentiles, components."""
    line_count = 0
    enter_count = 0
    exit_count = 0
    error_count = 0
    errors_by_type: Counter[str] = Counter()
    components: Counter[str] = Counter()
    request_ids: set[str] = set()
    durations: list[float] = []
    parent_null = 0
    oracle_violations_nonempty = 0
    invalid_json = 0
    if not log_path.is_file():
        return {"error": f"log not found: {log_path}"}
    with log_path.open(encoding="utf-8") as fh:
        for line in fh:
            line_s = line.strip()
            if not line_s:
                continue
            line_count += 1
            try:
                obj = json.loads(line_s)
            except json.JSONDecodeError:
                invalid_json += 1
                continue
            ev = obj.get("event")
            comp = obj.get("component", "?")
            components[comp] += 1
            request_ids.add(str(obj.get("request_id", "")))
            if obj.get("parent_component") is None:
                parent_null += 1
            if ev == "enter":
                enter_count += 1
            elif ev == "exit":
                exit_count += 1
                if obj.get("status") == "error":
                    error_count += 1
                    et = obj.get("error_type")
                    if et:
                        errors_by_type[str(et)] += 1
                d = obj.get("duration_ms")
                if isinstance(d, int | float):
                    durations.append(float(d))
                ov = obj.get("oracle_violations")
                if isinstance(ov, list) and ov:
                    oracle_violations_nonempty += 1
    durations.sort()
    return {
        "log_path": str(log_path),
        "line_count": line_count,
        "invalid_json_count": invalid_json,
        "enter_count": enter_count,
        "exit_count": exit_count,
        "balanced_pairs": enter_count == exit_count,
        "unique_request_ids": len(request_ids),
        "error_count": error_count,
        "errors_by_type": dict(errors_by_type),
        "oracle_violations_nonempty": oracle_violations_nonempty,
        "parent_null_count": parent_null,
        "duration_ms": (
            None
            if not durations
            else {
                "n": len(durations),
                "min": durations[0],
                "p50": statistics.median(durations),
                "p95": _percentile(durations, 0.95),
                "p99": _percentile(durations, 0.99),
                "max": durations[-1],
            }
        ),
        "top_components": [{"component": c, "count": n} for c, n in components.most_common(20)],
        "unique_components": len(components),
    }


def coverage_section(
    *,
    coverage_scan: dict[str, Any],
    rewrite_status: dict[str, str],
    components_seen: set[str],
) -> dict[str, Any]:
    """Cross-reference: what we COULD have instrumented (scan) vs. what we DID (rewrite_status)
    vs. what showed up at runtime (components_seen).

    Modules that were rewritten but produced zero spans are flagged — these are uncovered
    hot symbols (T2.3).
    """
    # collapse `components_seen` to module names by stripping the function tail
    seen_modules: set[str] = set()
    for c in components_seen:
        parts = c.rsplit(".", 1)
        if len(parts) == 2:
            seen_modules.add(parts[0])
    rewritten_ok = {m for m, s in rewrite_status.items() if s.startswith("ok:")}
    rewritten_failed = {m: s for m, s in rewrite_status.items() if s.startswith("failed:")}
    uncovered = sorted(rewritten_ok - seen_modules)
    return {
        "scan_totals": coverage_scan.get("totals", {}),
        "modules_scanned": len(coverage_scan.get("modules", {})),
        "modules_rewritten": len(rewritten_ok),
        "modules_rewrite_failed": rewritten_failed,
        "modules_with_zero_spans": uncovered[:50],
        "modules_with_zero_spans_count": len(uncovered),
    }


def write_summary(
    log_path: Path,
    *,
    out_path: Path | None = None,
    coverage_scan: dict[str, Any] | None = None,
    rewrite_status: dict[str, str] | None = None,
    instrumenters_loaded: dict[str, str] | None = None,
    dispatch_token: str | None = None,
    dropped_events: int = 0,
    extra: dict[str, Any] | None = None,
) -> Path:
    """Compute the summary and write it to ``<log>.summary.json`` (or ``out_path``)."""
    s = summarize_jsonl(log_path)
    components_seen = {item["component"] for item in s.get("top_components", [])}
    # widen by re-streaming if a deeper component set is needed; cheap fix: union with all
    # components from the scan.
    if rewrite_status is not None and coverage_scan is not None:
        s["coverage"] = coverage_section(
            coverage_scan=coverage_scan,
            rewrite_status=rewrite_status,
            components_seen=components_seen,
        )
    if instrumenters_loaded is not None:
        s["otel_instrumenters"] = instrumenters_loaded
    if dispatch_token:
        s["dispatch"] = dispatch_token
    s["dropped_events"] = dropped_events
    if extra:
        s.update(extra)
    target = out_path or log_path.with_suffix(log_path.suffix + ".summary.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(s, indent=2, default=str), encoding="utf-8")
    return target
