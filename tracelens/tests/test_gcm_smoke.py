"""DoWhy GCM smoke (optional ``tracelens[rca]``)."""

from __future__ import annotations

import json
from pathlib import Path

import networkx as nx
import pandas as pd
import pytest


def test_gcm_attribute_anomalies_smoke(tmp_path: Path) -> None:
    pytest.importorskip("dowhy", reason="dowhy GCM requires tracelens[rca]")
    from tracelens.analysis.gcm_rca import run_gcm

    G = nx.DiGraph([("p", "c")])
    dep = tmp_path / "d.json"
    dep.write_text(json.dumps(nx.node_link_data(G)), encoding="utf-8")
    rows = []
    for day in range(15):
        ts = f"2020-01-{day + 1:02d}T12:00:00Z"
        rows.append({"bucket": ts, "component": "p", "latency_p95": float(day % 3)})
        rows.append({"bucket": ts, "component": "c", "latency_p95": float(2 * (day % 3) + 0.1)})
    for day in range(15):
        ts = f"2020-02-{day + 1:02d}T12:00:00Z"
        rows.append({"bucket": ts, "component": "p", "latency_p95": float(day % 3)})
        rows.append({"bucket": ts, "component": "c", "latency_p95": float(50.0 + day)})
    mp = tmp_path / "m.parquet"
    pd.DataFrame(rows).to_parquet(mp)
    out = tmp_path / "g.json"
    run_gcm(
        mp,
        dep,
        "c",
        "2020-01-01T00:00:00Z,2020-01-31T23:59:59Z",
        "2020-02-01T00:00:00Z,2020-02-29T23:59:59Z",
        out,
        metric_col="latency_p95",
    )
    payload = json.loads(out.read_text(encoding="utf-8"))
    if "error" in payload:
        pytest.skip(f"dowhy gcm not runnable in this env: {payload['error']}")
    assert payload.get("path") == "dowhy_gcm"
    assert payload.get("top1")
