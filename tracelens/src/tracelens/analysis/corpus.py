"""T2.2 — Replay corpus assembly.

Produces a parquet keyed by ``request_id`` with one row per request:
    request_id, entry_component, entry_args_hash, entry_args_schema,
    output_result_hash, output_result_schema, output_status,
    n_external_calls (best-effort; computed from any non-target spans seen),
    duration_ms

This is the artifact ``lens-contracts.ReplayCorpusRow`` describes. We don't yet have
``ExternalCallEvent`` rows in the JSONL, so the column
``n_external_calls`` is currently always 0; the column is in place so downstream code can
evolve without a schema change.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from tracelens.analysis.spans import _load_validated_lines


def build_corpus(log: Path, out: Path) -> None:
    rows = _load_validated_lines(log)
    if not rows:
        pd.DataFrame().to_parquet(out)
        return

    # group by request_id
    by_rid: dict[str, dict[str, object]] = {}
    for r in rows:
        rid = str(r.get("request_id", ""))
        ev = r.get("event")
        comp = r.get("component", "")
        d = by_rid.setdefault(
            rid,
            {
                "request_id": rid,
                "entry_component": None,
                "entry_args_hash": None,
                "entry_args_schema": None,
                "entry_args_summary": None,
                "output_result_hash": None,
                "output_result_schema": None,
                "output_status": None,
                "duration_ms": 0.0,
                "n_external_calls": 0,
                "first_ts": r.get("ts"),
                "last_ts": r.get("ts"),
            },
        )
        if r.get("ts") and (d["first_ts"] is None or str(r["ts"]) < str(d["first_ts"])):
            d["first_ts"] = r["ts"]
        if r.get("ts") and (d["last_ts"] is None or str(r["ts"]) > str(d["last_ts"])):
            d["last_ts"] = r["ts"]
        # depth==0 enter is the entry; depth==0 exit is the output
        depth = int(r.get("depth", 0) or 0)
        if ev == "enter" and depth == 0 and d["entry_component"] is None:
            d["entry_component"] = comp
            d["entry_args_hash"] = r.get("args_hash")
            d["entry_args_schema"] = r.get("args_schema")
            d["entry_args_summary"] = json.dumps(r.get("args_summary"))
        if ev == "exit" and depth == 0:
            d["output_result_hash"] = r.get("result_hash")
            d["output_result_schema"] = r.get("result_schema")
            d["output_status"] = r.get("status")
            d["duration_ms"] = float(r.get("duration_ms") or 0.0)
    df = pd.DataFrame(list(by_rid.values()))
    df.to_parquet(out)
