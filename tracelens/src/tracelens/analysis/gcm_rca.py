"""Stage F — DoWhy GCM anomaly attribution (spec §11, optional ``tracelens[rca]``)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import networkx as nx
import numpy as np
import pandas as pd

_log = logging.getLogger("tracelens.diag")


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


def _wide_metric(df: pd.DataFrame, metric_col: str) -> pd.DataFrame:
    d = df.copy()
    d["_ts"] = pd.to_datetime(d["bucket"], utc=True)
    return d.pivot_table(index="_ts", columns="component", values=metric_col, aggfunc="mean")


def _canonical_node(G: nx.DiGraph, name: str) -> str | None:
    for n in G.nodes():
        if str(n) == name:
            return str(n)
    return None


def run_gcm(
    metrics: Path,
    depgraph: Path,
    target: str,
    normal: str,
    incident: str,
    out: Path,
    *,
    metric_col: str = "latency_p95",
) -> None:
    """``target`` = SCM target *node* (component qualname); values = *metric_col* per bucket."""
    try:
        from dowhy import gcm
    except ImportError:
        out.write_text(
            json.dumps({"error": "install tracelens[rca] for DoWhy GCM"}),
            encoding="utf-8",
        )
        return

    dfm = pd.read_parquet(metrics)
    if dfm.empty or metric_col not in dfm.columns:
        out.write_text(
            json.dumps({"error": f"metrics missing or no column {metric_col!r}"}),
            encoding="utf-8",
        )
        return

    G0 = _load_graph(depgraph)
    t_canon = _canonical_node(G0, target)
    if t_canon is None:
        out.write_text(
            json.dumps(
                {
                    "error": f"target node {target!r} not in depgraph",
                    "nodes_sample": [str(n) for n in list(G0.nodes())[:40]],
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return

    target = t_canon

    n0, n1 = _parse_range(normal)
    i0, i1 = _parse_range(incident)
    wide = _wide_metric(dfm, metric_col)
    nodeset = {str(n) for n in G0.nodes()}
    cols = [str(c) for c in wide.columns if str(c) in nodeset]
    if target not in cols:
        out.write_text(
            json.dumps({"error": f"target {target!r} has no {metric_col} rows in metrics"}),
            encoding="utf-8",
        )
        return

    sub_nodes = {target} | {str(p) for p in G0.predecessors(target)} | {str(c) for c in cols}
    G = G0.subgraph([n for n in G0.nodes() if str(n) in sub_nodes]).copy()
    if not nx.is_directed_acyclic_graph(G):
        out.write_text(
            json.dumps({"error": "subgraph for GCM target is not a DAG; refine depgraph"}),
            encoding="utf-8",
        )
        return

    use_cols = [str(n) for n in nx.topological_sort(G) if str(n) in wide.columns]
    if len(use_cols) < 2:
        out.write_text(
            json.dumps({"error": "insufficient overlapping nodes for GCM"}),
            encoding="utf-8",
        )
        return

    data_all = wide[use_cols].sort_index().dropna(how="any")
    dfn = data_all[(data_all.index >= n0) & (data_all.index <= n1)]
    dfi = data_all[(data_all.index >= i0) & (data_all.index <= i1)]
    if len(dfn) < 10 or len(dfi) < 3:
        out.write_text(
            json.dumps(
                {
                    "error": "too few rows for normal/incident after align",
                    "normal_n": int(len(dfn)),
                    "incident_n": int(len(dfi)),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return

    scm = gcm.StructuralCausalModel(G.subgraph(use_cols).copy())
    try:
        gcm.auto.assign_causal_mechanisms(scm, dfn)
        gcm.fit(scm, dfn)
    except Exception as exc:
        _log.warning("gcm fit failed: %s", exc)
        out.write_text(
            json.dumps({"error": f"gcm_fit_failed:{type(exc).__name__}:{exc!s}"}),
            encoding="utf-8",
        )
        return

    try:
        ev = gcm.evaluate_causal_model(scm, dfn, max_num_samples=min(200, len(dfn)))
        eval_report = {"summary": str(ev)[:800]}
    except Exception as exc:
        eval_report = {"skipped": str(exc)}

    try:
        dfi_sub = dfi[use_cols].dropna(how="any")
        attribs = gcm.attribute_anomalies(scm, target_node=target, anomaly_samples=dfi_sub)
    except Exception as exc:
        out.write_text(
            json.dumps(
                {
                    "error": f"attribute_anomalies_failed:{type(exc).__name__}",
                    "detail": str(exc)[:500],
                    "evaluation": eval_report,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return

    serial = {
        str(k): float(np.sum(np.abs(np.asarray(v, dtype=np.float64)))) for k, v in attribs.items()
    }
    top1 = max(serial, key=lambda k: serial[k]) if serial else None
    out.write_text(
        json.dumps(
            {
                "path": "dowhy_gcm",
                "target_node": target,
                "metric_col": metric_col,
                "shapley_attribution": serial,
                "top1": top1,
                "evaluation": eval_report,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
