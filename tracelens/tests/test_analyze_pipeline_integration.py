"""End-to-end analyze smoke: JSONL → metrics parquet columns."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from tracelens.analysis.metrics import build_metrics


def _line(
    event: str,
    ts: str,
    component: str,
    *,
    rid: str = "r1",
    parent: str | None = None,
    depth: int = 0,
) -> dict[str, object]:
    base: dict[str, object] = {
        "ts": ts,
        "request_id": rid,
        "component": component,
        "event": event,
        "level": "info",
        "depth": depth,
        "parent_component": parent,
        "thread_id": 1,
    }
    if event == "enter":
        base["args_hash"] = "0" * 16
        base["args_schema"] = "()"
        base["args_summary"] = {}
    else:
        base["duration_ms"] = 1.0
        base["status"] = "ok"
        base["oracle_violations"] = []
        base["call_count_in_request"] = 1
        base["result_schema"] = None
        base["result_summary"] = None
    return base


def test_metrics_parquet_has_stage_d_families(tmp_path: Path) -> None:
    log = tmp_path / "t.jsonl"
    chunks: list[dict[str, object]] = []
    for i in range(15):
        rid = f"r{i}"
        t0 = f"2024-06-01T10:{i:02d}:00.000Z"
        t1 = f"2024-06-01T10:{i:02d}:00.001Z"
        t2 = f"2024-06-01T10:{i:02d}:00.002Z"
        t3 = f"2024-06-01T10:{i:02d}:00.003Z"
        chunks.append(_line("enter", t0, "svc.root", rid=rid, depth=0, parent=None))
        chunks.append(_line("enter", t1, "svc.child", rid=rid, depth=1, parent="svc.root"))
        chunks.append(_line("exit", t2, "svc.child", rid=rid, depth=1, parent="svc.root"))
        chunks.append(_line("exit", t3, "svc.root", rid=rid, depth=0, parent=None))
    log.write_text("\n".join(json.dumps(x) for x in chunks) + "\n", encoding="utf-8")
    out = tmp_path / "m.parquet"
    build_metrics(log, out, bucket="60s")
    df = pd.read_parquet(out)
    cols = set(df.columns)
    for need in (
        "error_rate",
        "latency_p50",
        "latency_p95",
        "latency_p99",
        "qps",
        "mean_call_count_per_request",
        "max_call_count_per_request",
        "oracle_violation_rate",
        "result_schema_diversity",
        "result_null_rate",
    ):
        assert need in cols, f"missing {need}"
