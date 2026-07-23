"""CIRCA: linear regression + KS on residuals."""

from __future__ import annotations

import json
from pathlib import Path

import networkx as nx
import pandas as pd
import pytest

from tracelens.analysis.circa import _benjamini_hochberg, run_circa


def test_benjamini_hochberg_adjustment_is_monotone() -> None:
    adjusted = _benjamini_hochberg([0.01, 0.04, 0.03])
    assert adjusted == pytest.approx([0.03, 0.04, 0.04])


def test_circa_ks_flags_residual_shift(tmp_path: Path) -> None:
    G = nx.DiGraph([("parent.node", "child.node")])
    dep = tmp_path / "dep.json"
    dep.write_text(json.dumps(nx.node_link_data(G)), encoding="utf-8")

    rows: list[dict[str, object]] = []
    for i in range(60):
        bucket = (pd.Timestamp("2020-01-01T00:00:00Z") + pd.Timedelta(hours=i)).isoformat()
        rows.append(
            {
                "bucket": bucket,
                "component": "parent.node",
                "latency_p95": float(10 + (i % 3)),
            }
        )
        rows.append(
            {
                "bucket": bucket,
                "component": "child.node",
                "latency_p95": float(20 + (i % 2)),
            }
        )
    for i in range(60):
        bucket = (pd.Timestamp("2020-02-01T00:00:00Z") + pd.Timedelta(hours=i)).isoformat()
        rows.append(
            {
                "bucket": bucket,
                "component": "parent.node",
                "latency_p95": float(11 + (i % 3)),
            }
        )
        rows.append(
            {
                "bucket": bucket,
                "component": "child.node",
                "latency_p95": float(80.0 + i),
            }
        )
    mp = tmp_path / "m.parquet"
    pd.DataFrame(rows).to_parquet(mp)
    out = tmp_path / "circa.json"
    run_circa(
        mp,
        dep,
        "latency_p95",
        "2020-01-01T00:00:00Z,2020-01-31T23:59:59Z",
        "2020-02-01T00:00:00Z,2020-02-29T23:59:59Z",
        out,
    )
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload.get("path") == "linear_ks"
    ranked = payload.get("ranked", [])
    assert isinstance(ranked, list) and ranked
    child = next((r for r in ranked if r.get("component") == "child.node"), None)
    assert child is not None
    assert float(child["p_value"]) < 0.05
    assert float(child["p_adjusted_bh"]) <= 0.05
    assert int(child["n_model_fit_rows"]) >= 20
    assert int(child["n_normal_residuals"]) >= 10
