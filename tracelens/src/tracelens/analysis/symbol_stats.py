"""T2.4 — per-symbol perf parquet (consumed by the code index to rank symbols by cost).

Produces a parquet keyed by ``qualname`` with columns:
    qualname, total_ms, call_count, p50_ms, p95_ms, p99_ms, error_rate,
    last_seen_at, projected_dollar_per_month

Cost projection: ``total_ms / 1000.0 × dollars_per_vcpu_second``. Rate defaults from env
``TRACELENS_DOLLARS_PER_VCPU_SECOND`` (AWS t3.medium ≈ 5.2e-6 USD/vCPU-s as of 2024).
"""

from __future__ import annotations

import os
import statistics
from pathlib import Path
from typing import cast

import pandas as pd

from tracelens.analysis.spans import _load_validated_lines


def _percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    idx = max(0, min(len(sorted_values) - 1, int(p * (len(sorted_values) - 1))))
    return sorted_values[idx]


def build_symbol_stats(log: Path, out: Path) -> None:
    rows = _load_validated_lines(log)
    rate = float(os.environ.get("TRACELENS_DOLLARS_PER_VCPU_SECOND", "0.0000052"))
    by_q: dict[str, dict[str, object]] = {}
    by_q_durs: dict[str, list[float]] = {}
    for r in rows:
        if r.get("event") != "exit":
            continue
        q = str(r.get("component", ""))
        d = by_q.setdefault(
            q,
            {
                "qualname": q,
                "total_ms": 0.0,
                "call_count": 0,
                "error_count": 0,
                "last_seen_at": None,
            },
        )
        durs = by_q_durs.setdefault(q, [])
        ms = float(r.get("duration_ms") or 0.0)
        d["total_ms"] = cast(float, d["total_ms"]) + ms
        d["call_count"] = cast(int, d["call_count"]) + 1
        if r.get("status") == "error":
            d["error_count"] = cast(int, d["error_count"]) + 1
        ts = r.get("ts")
        if ts and (d["last_seen_at"] is None or str(ts) > str(d["last_seen_at"])):
            d["last_seen_at"] = ts
        durs.append(ms)

    out_rows: list[dict[str, object]] = []
    # Approximate "monthly" projection: scale observed total_ms to a 30-day extrapolation.
    # If the trace covers only N seconds, total_ms*30d_seconds/N_seconds is the right scale,
    # but without an authoritative window we use observed total directly and document the
    # caveat in the column name.
    for q, d in by_q.items():
        durs = sorted(by_q_durs[q])
        d["p50_ms"] = statistics.median(durs) if durs else 0.0
        d["p95_ms"] = _percentile(durs, 0.95)
        d["p99_ms"] = _percentile(durs, 0.99)
        cc = cast(int, d["call_count"]) or 1
        d["error_rate"] = cast(int, d["error_count"]) / cc
        d["projected_dollar_per_observed_window"] = (cast(float, d["total_ms"]) / 1000.0) * rate
        out_rows.append(d)

    df = pd.DataFrame(out_rows)
    df.to_parquet(out)
