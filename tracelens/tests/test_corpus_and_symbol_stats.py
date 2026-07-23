"""T2.2 / T2.4 / T2.5 — corpus, symbol-stats, dynamic/static diff."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from tracelens.analysis.corpus import build_corpus
from tracelens.analysis.dynamic_static_diff import build_diff
from tracelens.analysis.symbol_stats import build_symbol_stats


def _enter(ts: str, comp: str, rid: str = "r1", depth: int = 0, parent: str | None = None) -> dict:
    return {
        "ts": ts,
        "request_id": rid,
        "component": comp,
        "event": "enter",
        "level": "info",
        "depth": depth,
        "parent_component": parent,
        "thread_id": 1,
        "args_hash": "0" * 16,
        "args_schema": "()",
        "args_summary": {"k": 1},
    }


def _exit(
    ts: str,
    comp: str,
    rid: str = "r1",
    duration_ms: float = 1.0,
    status: str = "ok",
    depth: int = 0,
    parent: str | None = None,
) -> dict:
    return {
        "ts": ts,
        "request_id": rid,
        "component": comp,
        "event": "exit",
        "level": "info",
        "depth": depth,
        "parent_component": parent,
        "thread_id": 1,
        "duration_ms": duration_ms,
        "status": status,
        "error_type": None,
        "error_message": None,
        "result_hash": "f" * 16,
        "result_schema": "dict",
        "result_summary": {"len": 1},
        "oracle_violations": [],
        "call_count_in_request": 1,
    }


def _write_log(tmp_path: Path) -> Path:
    rows = [
        _enter("2024-01-01T00:00:00.000Z", "svc.handler", rid="r1"),
        _enter(
            "2024-01-01T00:00:00.001Z", "svc.repo.fetch", rid="r1", depth=1, parent="svc.handler"
        ),
        _exit(
            "2024-01-01T00:00:00.002Z",
            "svc.repo.fetch",
            rid="r1",
            duration_ms=1.0,
            depth=1,
            parent="svc.handler",
        ),
        _exit("2024-01-01T00:00:00.003Z", "svc.handler", rid="r1", duration_ms=3.0),
        _enter("2024-01-01T00:01:00.000Z", "svc.handler", rid="r2"),
        _exit("2024-01-01T00:01:00.005Z", "svc.handler", rid="r2", duration_ms=5.0, status="error"),
    ]
    p = tmp_path / "t.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    return p


def test_corpus_one_row_per_request(tmp_path: Path) -> None:
    log = _write_log(tmp_path)
    out = tmp_path / "corpus.parquet"
    build_corpus(log, out)
    df = pd.read_parquet(out)
    assert set(df["request_id"]) == {"r1", "r2"}
    r1 = df[df["request_id"] == "r1"].iloc[0]
    assert r1["entry_component"] == "svc.handler"
    assert r1["output_status"] == "ok"
    assert r1["duration_ms"] == 3.0


def test_symbol_stats_aggregates_by_qualname(tmp_path: Path) -> None:
    log = _write_log(tmp_path)
    out = tmp_path / "syms.parquet"
    build_symbol_stats(log, out)
    df = pd.read_parquet(out)
    handler = df[df["qualname"] == "svc.handler"].iloc[0]
    assert handler["call_count"] == 2
    assert handler["error_count"] == 1
    assert handler["error_rate"] == 0.5


def test_dynamic_static_diff_classifies_edges(tmp_path: Path) -> None:
    log = _write_log(tmp_path)
    static = tmp_path / "static.json"
    # static says: handler -> repo.fetch  AND  handler -> repo.write (never observed)
    static.write_text(
        json.dumps(
            {
                "edges": [
                    ["svc.handler", "svc.repo.fetch"],
                    ["svc.handler", "svc.repo.write"],
                ]
            }
        ),
        encoding="utf-8",
    )
    out = tmp_path / "diff.json"
    build_diff(log, static, out)
    payload = json.loads(out.read_text(encoding="utf-8"))
    in_both = {(e["src"], e["dst"]) for e in payload["edges_in_both"]}
    only_static = {(e["src"], e["dst"]) for e in payload["edges_only_in_static"]}
    assert ("svc.handler", "svc.repo.fetch") in in_both
    assert ("svc.handler", "svc.repo.write") in only_static
