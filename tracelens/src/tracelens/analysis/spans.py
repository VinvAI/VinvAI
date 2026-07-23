"""Stage A — span reconstruction (single-pass stack).

Reads via :class:`tracelens.io.EventReader` so the source can later be swapped
from a JSONL file to a SQL/columnar store without touching this module. See
``docs/pitch/IMPLEMENTATION_ROADMAP.md`` phase 0.
"""

from __future__ import annotations

import json
import logging
import warnings
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from tracelens.io import open_reader

_log = logging.getLogger(__name__)


def _load_validated_lines(path: Path) -> list[dict[str, Any]]:
    """Backwards-compat wrapper. New analyze code should use ``open_reader`` directly."""
    with open_reader(path) as r:
        return list(r)


def _ts_us(ts: str) -> int:
    s = str(ts).replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.timestamp() * 1_000_000)


def _chrome_trace(rows: list[dict[str, Any]]) -> dict[str, Any]:
    events: list[dict[str, Any]] = []
    pid = 1
    for r in sorted(rows, key=lambda x: str(x["ts"])):
        rid = str(r.get("request_id", ""))
        tid = abs(hash(rid)) % (2**31 - 1) or 1
        ts_us = _ts_us(str(r["ts"]))
        comp = str(r.get("component", ""))
        ev = str(r.get("event", ""))
        name = f"{ev}:{comp}"
        dur = 0
        if ev == "exit":
            dur = max(0, int(float(r.get("duration_ms", 0) or 0) * 1000))
        events.append(
            {
                "name": name,
                "cat": "tracelens",
                "ph": "X",
                "ts": ts_us,
                "dur": dur,
                "pid": pid,
                "tid": tid,
                "args": {"request_id": rid, "depth": r.get("depth")},
            }
        )
    return {"traceEvents": events}


def _trees_for_request(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    lines_sorted = sorted(lines, key=lambda r: r["ts"])
    roots: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    for row in lines_sorted:
        if row["event"] == "enter":
            node: dict[str, Any] = {
                "component": row["component"],
                "start": row["ts"],
                "end": None,
                "duration_ms": None,
                "depth": int(row["depth"]),
                "status": None,
                "children": [],
            }
            if stack:
                stack[-1]["children"].append(node)
            else:
                roots.append(node)
            stack.append(node)
        elif row["event"] == "exit":
            if not stack:
                warnings.warn("exit without matching enter", stacklevel=1)
                continue
            if stack[-1]["component"] != row["component"]:
                warnings.warn("exit/component mismatch; unwinding", stacklevel=1)
                while stack and stack[-1]["component"] != row["component"]:
                    stack.pop()
                if not stack:
                    continue
            cur = stack.pop()
            cur["end"] = row["ts"]
            cur["duration_ms"] = float(row["duration_ms"])
            cur["status"] = row["status"]
    return roots


def build_spans(log: Path, out: Path, chrome_out: Path | None) -> None:
    rows = _load_validated_lines(log)
    df = pd.DataFrame(rows)
    trees = []
    if not df.empty:
        for rid, g in df.groupby("request_id"):
            recs = g.to_dict("records")
            trees.append({"request_id": str(rid), "spans": _trees_for_request(recs)})
    out.write_text(json.dumps(trees, indent=2), encoding="utf-8")
    if chrome_out:
        chrome_out.write_text(json.dumps(_chrome_trace(rows)), encoding="utf-8")
