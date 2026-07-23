"""Stage E — CIRCA-style residual shift (spec §10).

Primary path: sklearn ``LinearRegression`` + ``scipy.stats.ks_2samp`` on residuals per
depgraph node with parents (plan §10 fallback). PyRCA may be wired later as an optional
extra; this module documents the scipy path in JSON as ``path: linear_ks``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import networkx as nx
import numpy as np
import pandas as pd
from scipy.stats import ks_2samp  # type: ignore[import-untyped]
from sklearn.linear_model import LinearRegression  # type: ignore[import-untyped]

_MIN_NORMAL_ROWS = 30
_MIN_TRAIN_ROWS = 20
_MIN_CALIBRATION_ROWS = 10
_MIN_INCIDENT_ROWS = 10
_FDR_Q = 0.05
_MIN_KS_EFFECT = 0.20


def _parse_range(spec: str) -> tuple[pd.Timestamp, pd.Timestamp]:
    left, right = spec.split(",", 1)
    return (
        pd.to_datetime(left.strip(), utc=True),
        pd.to_datetime(right.strip(), utc=True),
    )


def _load_graph(depgraph: Path) -> nx.DiGraph:
    data: dict[str, Any] = json.loads(depgraph.read_text(encoding="utf-8"))
    return nx.node_link_graph(
        data,
        directed=bool(data.get("directed", True)),
        multigraph=bool(data.get("multigraph", False)),
    )


def _parents_map(G: nx.DiGraph) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for c in G.nodes():
        ps = [str(p) for p in G.predecessors(c)]
        if ps:
            out[str(c)] = ps
    return out


def _benjamini_hochberg(p_values: list[float]) -> list[float]:
    """Return monotone Benjamini-Hochberg adjusted p-values in input order."""
    count = len(p_values)
    if count == 0:
        return []
    ordered = sorted(enumerate(p_values), key=lambda item: item[1])
    adjusted = [1.0] * count
    running = 1.0
    for rank, (original_index, p_value) in reversed(
        list(enumerate(ordered, start=1))
    ):
        running = min(running, p_value * count / rank)
        adjusted[original_index] = min(1.0, running)
    return adjusted


def run_circa(
    metrics: Path,
    depgraph: Path,
    target: str,
    normal: str,
    incident: str,
    out: Path,
) -> None:
    """Fit on early normal data; compare held-out normal and incident residuals."""
    df = pd.read_parquet(metrics)
    if df.empty or target not in df.columns:
        out.write_text(
            json.dumps(
                {
                    "path": "linear_ks",
                    "error": f"metric column {target!r} missing or empty metrics",
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return

    G = _load_graph(depgraph)
    pmap = _parents_map(G)
    df = df.copy()
    df["_ts"] = pd.to_datetime(df["bucket"], utc=True)
    n0, n1 = _parse_range(normal)
    i0, i1 = _parse_range(incident)
    dfn = df[(df["_ts"] >= n0) & (df["_ts"] <= n1)]
    dfi = df[(df["_ts"] >= i0) & (df["_ts"] <= i1)]

    wide_n = dfn.pivot_table(index="bucket", columns="component", values=target, aggfunc="mean")
    wide_i = dfi.pivot_table(index="bucket", columns="component", values=target, aggfunc="mean")

    ranked: list[dict[str, Any]] = []
    for node, pas in sorted(pmap.items()):
        cols = [p for p in pas if p in wide_n.columns and p in wide_i.columns]
        if node not in wide_n.columns or node not in wide_i.columns or not cols:
            continue
        normal_rows = wide_n[[*cols, node]].dropna().sort_index()
        if len(normal_rows) < _MIN_NORMAL_ROWS:
            continue
        split = max(_MIN_TRAIN_ROWS, int(len(normal_rows) * 2 / 3))
        train = normal_rows.iloc[:split]
        calibration = normal_rows.iloc[split:]
        if len(train) < _MIN_TRAIN_ROWS or len(calibration) < _MIN_CALIBRATION_ROWS:
            continue
        X_train = train[cols].to_numpy(dtype=np.float64)
        y_train = train[node].to_numpy(dtype=np.float64)
        model = LinearRegression().fit(X_train, y_train)
        X_normal = calibration[cols].to_numpy(dtype=np.float64)
        y_normal = calibration[node].to_numpy(dtype=np.float64)
        res_n = y_normal - model.predict(X_normal)

        inc = wide_i[[*cols, node]].dropna().sort_index()
        if len(inc) < _MIN_INCIDENT_ROWS:
            continue
        Xi = inc[cols].to_numpy(dtype=np.float64)
        yi = inc[node].to_numpy(dtype=np.float64)
        res_i = yi - model.predict(Xi)

        stat, p = ks_2samp(res_n, res_i, alternative="two-sided", method="auto")
        ranked.append(
            {
                "component": node,
                "ks_statistic": float(stat),
                "p_value": float(p),
                "n_normal_residuals": int(len(res_n)),
                "n_incident_residuals": int(len(res_i)),
                "n_model_fit_rows": int(len(train)),
                "parents": cols,
            }
        )

    adjusted = _benjamini_hochberg([float(row["p_value"]) for row in ranked])
    for row, adjusted_p in zip(ranked, adjusted, strict=True):
        row["p_adjusted_bh"] = adjusted_p
    ranked.sort(key=lambda r: (r["p_value"], r["component"]))
    significant = [
        r
        for r in ranked
        if r["p_adjusted_bh"] <= _FDR_Q and r["ks_statistic"] >= _MIN_KS_EFFECT
    ]
    payload = {
        "path": "linear_ks",
        "target_metric": target,
        "normal_rows": int(len(dfn)),
        "incident_rows": int(len(dfi)),
        "ranked": ranked,
        "significant_fdr_q_0_05_and_ks_ge_0_20": significant,
        "sample_policy": {
            "minimum_normal": _MIN_NORMAL_ROWS,
            "minimum_model_fit": _MIN_TRAIN_ROWS,
            "minimum_held_out_normal": _MIN_CALIBRATION_ROWS,
            "minimum_incident": _MIN_INCIDENT_ROWS,
        },
        "note": "Linear model fit excludes held-out normal residuals; BH controls node-wise FDR.",
    }
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
