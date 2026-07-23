"""Stage G — provenance + drift."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats  # type: ignore[import-untyped]
from scipy.special import rel_entr  # type: ignore[import-untyped]

from tracelens.analysis.spans import _load_validated_lines

_NUMERIC_DRIFT_COLUMNS = (
    "error_count",
    "latency_p50",
    "latency_p95",
    "latency_p99",
    "error_rate",
    "qps",
    "mean_call_count_per_request",
    "max_call_count_per_request",
    "oracle_violation_rate",
    "result_schema_diversity",
    "result_null_rate",
)


def _entropy_divergence(ref: np.ndarray, cur: np.ndarray, n_bins: int = 10) -> float:
    ref = ref[np.isfinite(ref)].astype(np.float64)
    cur = cur[np.isfinite(cur)].astype(np.float64)
    if ref.size < 2 or cur.size < 2:
        return float("nan")
    nb = int(min(max(2, n_bins), max(2, ref.size // 2)))
    _, edges = np.histogram(ref, bins=nb)
    r_counts, _ = np.histogram(ref, bins=edges)
    c_counts, _ = np.histogram(cur, bins=edges)
    r_pct = r_counts.astype(np.float64) / max(1.0, float(r_counts.sum()))
    c_pct = c_counts.astype(np.float64) / max(1.0, float(c_counts.sum()))
    eps = 1e-12
    return float(stats.entropy(r_pct + eps, c_pct + eps))


def _wasserstein_1d(ref: np.ndarray, cur: np.ndarray) -> float:
    ref = ref[np.isfinite(ref)].astype(np.float64)
    cur = cur[np.isfinite(cur)].astype(np.float64)
    if ref.size < 2 or cur.size < 2:
        return float("nan")
    return float(stats.wasserstein_distance(ref, cur))


def _json_ready(obj: object) -> object:
    if isinstance(obj, dict):
        return {k: _json_ready(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_ready(x) for x in obj]
    if isinstance(obj, float | np.floating):
        x = float(obj)
        return x if math.isfinite(x) else None
    return obj


def provenance_diff(golden: Path, current: Path, out: Path) -> None:
    def _ordered_exits(path: Path) -> dict[str, list[dict[str, object]]]:
        rows = [r for r in _load_validated_lines(path) if r["event"] == "exit"]
        by_rid: dict[str, list[dict[str, object]]] = {}
        for r in sorted(rows, key=lambda x: (str(x["request_id"]), str(x["ts"]))):
            rid = str(r["request_id"])
            by_rid.setdefault(rid, []).append(r)
        return by_rid

    a = _ordered_exits(golden)
    b = _ordered_exits(current)
    diff: dict[str, str] = {}
    for rid in set(a) & set(b):
        seq_a = a[rid]
        seq_b = b[rid]
        n = min(len(seq_a), len(seq_b))
        diverge: str | None = None
        for i in range(n):
            if seq_a[i].get("result_hash") != seq_b[i].get("result_hash"):
                diverge = str(seq_a[i].get("component", ""))
                break
        if diverge is not None:
            diff[rid] = diverge
    out.write_text(json.dumps(diff, indent=2), encoding="utf-8")


def _parse_time_range(spec: str) -> tuple[pd.Timestamp, pd.Timestamp]:
    left, right = spec.split(",", 1)
    return (
        pd.to_datetime(left.strip(), utc=True),
        pd.to_datetime(right.strip(), utc=True),
    )


def _psi(ref: np.ndarray, cur: np.ndarray, n_bins: int = 10) -> float:
    ref = ref[np.isfinite(ref)].astype(np.float64)
    cur = cur[np.isfinite(cur)].astype(np.float64)
    if ref.size < 2 or cur.size < 2:
        return float("nan")
    nb = int(min(max(2, n_bins), max(2, ref.size // 2)))
    _, edges = np.histogram(ref, bins=nb)
    r_counts, _ = np.histogram(ref, bins=edges)
    c_counts, _ = np.histogram(cur, bins=edges)
    r_pct = r_counts.astype(np.float64) / max(1.0, float(r_counts.sum()))
    c_pct = c_counts.astype(np.float64) / max(1.0, float(c_counts.sum()))
    eps = 1e-12
    return float(np.sum((c_pct - r_pct) * np.log((c_pct + eps) / (r_pct + eps))))


def _kl_discrete(p: np.ndarray, q: np.ndarray) -> float:
    p = np.asarray(p, dtype=np.float64)
    q = np.asarray(q, dtype=np.float64)
    p = np.clip(p, 1e-15, None)
    q = np.clip(q, 1e-15, None)
    p /= p.sum()
    q /= q.sum()
    return float(np.sum(rel_entr(p, q)))


def _binned_kl(ref: np.ndarray, cur: np.ndarray, n_bins: int = 12) -> float:
    ref = ref[np.isfinite(ref)].astype(np.float64)
    cur = cur[np.isfinite(cur)].astype(np.float64)
    if ref.size < 2 or cur.size < 2:
        return float("nan")
    lo = float(min(ref.min(), cur.min()))
    hi = float(max(ref.max(), cur.max()))
    if lo == hi:
        return 0.0
    nb = int(min(max(3, n_bins), max(3, int(np.sqrt(ref.size)) + 2)))
    bins = np.linspace(lo, hi, num=nb)
    p, _ = np.histogram(ref, bins=bins, density=True)
    q, _ = np.histogram(cur, bins=bins, density=True)
    p = p.astype(np.float64) + 1e-12
    q = q.astype(np.float64) + 1e-12
    p /= p.sum()
    q /= q.sum()
    return _kl_discrete(p, q)


def drift_metrics(metrics: Path, baseline: str, window: str, out: Path) -> None:
    df = pd.read_parquet(metrics)
    payload: dict[str, object] = {
        "baseline": baseline,
        "window": window,
        "metrics_rows": int(len(df)),
        "path": "scipy_histogram",
    }
    if df.empty or "bucket" not in df.columns:
        payload["note"] = "empty or missing bucket column"
        out.write_text(json.dumps(_json_ready(payload), indent=2), encoding="utf-8")
        return

    df = df.copy()
    df["bucket"] = pd.to_datetime(df["bucket"], utc=True)
    b0, b1 = _parse_time_range(baseline)
    w0, w1 = _parse_time_range(window)
    dfb = df[(df["bucket"] >= b0) & (df["bucket"] <= b1)]
    dfw = df[(df["bucket"] >= w0) & (df["bucket"] <= w1)]
    payload["baseline_rows"] = int(len(dfb))
    payload["window_rows"] = int(len(dfw))

    per_col: dict[str, dict[str, float | int | None]] = {}
    for col in _NUMERIC_DRIFT_COLUMNS:
        if col not in df.columns:
            continue
        r = dfb[col].dropna().to_numpy(dtype=np.float64)
        c = dfw[col].dropna().to_numpy(dtype=np.float64)
        if r.size == 0 and c.size == 0:
            continue
        per_col[col] = {
            "psi": _psi(r, c) if r.size >= 2 and c.size >= 2 else float("nan"),
            "kl_histogram": _binned_kl(r, c) if r.size >= 2 and c.size >= 2 else float("nan"),
            "entropy_divergence": _entropy_divergence(r, c)
            if r.size >= 2 and c.size >= 2
            else float("nan"),
            "wasserstein_1d": (
                _wasserstein_1d(r, c) if r.size >= 2 and c.size >= 2 else float("nan")
            ),
            "n_baseline": int(r.size),
            "n_window": int(c.size),
        }
    payload["columns"] = per_col
    payload["evidently_note"] = (
        "install tracelens[drift] for Evidently dashboards; numeric PSI/KL above use scipy"
    )

    out.write_text(json.dumps(_json_ready(payload), indent=2), encoding="utf-8")
