"""EventReader: validate good lines, count and skip invalid ones."""

from __future__ import annotations

import json
from pathlib import Path

from tracelens.io import open_reader


def _enter(ts: str, comp: str = "x") -> dict[str, object]:
    return {
        "ts": ts,
        "request_id": "r",
        "component": comp,
        "event": "enter",
        "level": "info",
        "depth": 0,
        "parent_component": None,
        "thread_id": 1,
        "args_hash": "0" * 16,
        "args_schema": "()",
        "args_summary": {},
    }


def _exit(ts: str, comp: str = "x") -> dict[str, object]:
    return {
        "ts": ts,
        "request_id": "r",
        "component": comp,
        "event": "exit",
        "level": "info",
        "depth": 0,
        "parent_component": None,
        "thread_id": 1,
        "duration_ms": 1.0,
        "status": "ok",
        "oracle_violations": [],
        "call_count_in_request": 1,
    }


def test_reader_yields_valid_rows(tmp_path: Path) -> None:
    p = tmp_path / "t.jsonl"
    rows = [
        _enter("2024-01-01T00:00:00.000Z"),
        _exit("2024-01-01T00:00:00.001Z"),
    ]
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    with open_reader(p) as r:
        out = list(r)
    assert len(out) == 2
    assert out[0]["event"] == "enter"
    assert out[1]["event"] == "exit"


def test_reader_counts_skipped_invalid(tmp_path: Path) -> None:
    p = tmp_path / "t.jsonl"
    valid = _enter("2024-01-01T00:00:00.000Z")
    invalid_missing_required = {"event": "enter"}  # fails schema (missing fields)
    bad_json = "{not json"
    p.write_text(
        json.dumps(valid) + "\n" + json.dumps(invalid_missing_required) + "\n" + bad_json + "\n",
        encoding="utf-8",
    )
    r = open_reader(p)
    out = list(r)
    assert len(out) == 1
    assert r.skipped == 2


def test_reader_handles_blank_lines(tmp_path: Path) -> None:
    p = tmp_path / "t.jsonl"
    p.write_text("\n\n" + json.dumps(_enter("2024-01-01T00:00:00.000Z")) + "\n\n", encoding="utf-8")
    with open_reader(p) as r:
        out = list(r)
    assert len(out) == 1
    assert r.skipped == 0


def test_legacy_helper_still_works(tmp_path: Path) -> None:
    """``_load_validated_lines`` is the backwards-compat wrapper used elsewhere."""
    from tracelens.analysis.spans import _load_validated_lines

    p = tmp_path / "t.jsonl"
    p.write_text(json.dumps(_enter("2024-01-01T00:00:00.000Z")) + "\n", encoding="utf-8")
    rows = _load_validated_lines(p)
    assert len(rows) == 1
