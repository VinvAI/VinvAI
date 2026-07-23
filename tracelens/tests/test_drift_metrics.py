"""Stage G drift_metrics numeric output."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from tracelens.analysis.correctness import drift_metrics


def test_drift_metrics_emits_psi_kl(tmp_path: Path) -> None:
    p = tmp_path / "m.parquet"
    df = pd.DataFrame(
        {
            "bucket": pd.to_datetime(
                ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"], utc=True
            ),
            "component": ["a", "a", "a", "a"],
            "latency_p95": [1.0, 2.0, 10.0, 20.0],
            "error_rate": [0.0, 0.1, 0.0, 0.2],
            "qps": [1.0, 1.0, 1.0, 1.0],
        }
    )
    df.to_parquet(p)
    out = tmp_path / "drift.json"
    drift_metrics(
        p,
        "1970-01-01,2020-01-02",
        "2020-01-03,2099-01-01",
        out,
    )
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["path"] == "scipy_histogram"
    cols = payload["columns"]
    assert isinstance(cols, dict)
    assert "latency_p95" in cols
    assert "psi" in cols["latency_p95"]
    assert "entropy_divergence" in cols["latency_p95"]
