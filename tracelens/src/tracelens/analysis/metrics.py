"""Stage D — metrics parquet (spec §9)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from tracelens.analysis.spans import _load_validated_lines


def _nullish_result_summary(val: object) -> bool:
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return True
    if isinstance(val, dict):
        if val.get("null_pct") is not None:
            return True
        if val.get("len") == 0:
            return True
    return False


def build_metrics(log: Path, out: Path, *, bucket: str = "60s") -> None:
    rows = _load_validated_lines(log)
    df = pd.DataFrame(rows)
    if df.empty:
        pd.DataFrame().to_parquet(out)
        return
    df["_ts"] = pd.to_datetime(df["ts"], utc=True)
    sec = max(1, int(bucket.rstrip("s")))
    df["bucket"] = df["_ts"].dt.floor(f"{sec}s")
    ex = df[df["event"] == "exit"].copy()
    if ex.empty:
        pd.DataFrame().to_parquet(out)
        return

    ex["_nullish"] = ex["result_summary"].apply(_nullish_result_summary)
    ex["_viol"] = ex["oracle_violations"].apply(lambda x: bool(x) if isinstance(x, list) else False)

    mcr = (
        ex.groupby(["bucket", "component", "request_id"], as_index=False)["call_count_in_request"]
        .max()
        .groupby(["bucket", "component"])
        .agg(
            mean_call_count_per_request=("call_count_in_request", "mean"),
            max_call_count_per_request=("call_count_in_request", "max"),
        )
        .reset_index()
    )

    g = ex.groupby(["bucket", "component"])
    agg = g.agg(
        error_count=("status", lambda s: int((s == "error").sum())),
        latency_p50=("duration_ms", "median"),
        latency_p95=("duration_ms", lambda x: float(x.quantile(0.95))),
        latency_p99=("duration_ms", lambda x: float(x.quantile(0.99))),
        raw_count=("duration_ms", "count"),
        oracle_violation_count=("_viol", "sum"),
        result_schema_diversity=("result_schema", lambda s: int(s.dropna().nunique())),
        nullish_count=("_nullish", "sum"),
    ).reset_index()
    rc = agg["raw_count"].replace(0, np.nan)
    agg["error_rate"] = agg["error_count"] / rc
    agg["oracle_violation_rate"] = agg["oracle_violation_count"] / rc
    agg["result_null_rate"] = agg["nullish_count"] / rc
    agg["qps"] = agg["raw_count"] / float(sec)
    agg = agg.merge(mcr, on=["bucket", "component"], how="left")
    agg = agg.drop(columns=["raw_count", "nullish_count", "oracle_violation_count"])
    agg.to_parquet(out)
