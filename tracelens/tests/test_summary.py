"""T1.4 — summary.json writer."""

from __future__ import annotations

import json
from pathlib import Path

from tracelens.launcher.summary import summarize_jsonl, write_summary


def _enter(ts: str, comp: str, rid: str = "r1", depth: int = 0) -> dict:
    return {
        "ts": ts,
        "request_id": rid,
        "component": comp,
        "event": "enter",
        "level": "info",
        "depth": depth,
        "parent_component": None,
        "thread_id": 1,
        "args_hash": "0" * 16,
        "args_schema": "()",
        "args_summary": {},
    }


def _exit(
    ts: str,
    comp: str,
    rid: str = "r1",
    status: str = "ok",
    duration_ms: float = 1.0,
    error_type: str | None = None,
    oracle_violations: list | None = None,
    depth: int = 0,
) -> dict:
    return {
        "ts": ts,
        "request_id": rid,
        "component": comp,
        "event": "exit",
        "level": "INFO" if status == "ok" else "ERROR",
        "depth": depth,
        "parent_component": None,
        "thread_id": 1,
        "duration_ms": duration_ms,
        "status": status,
        "error_type": error_type,
        "error_message": None,
        "result_hash": None,
        "result_schema": None,
        "result_summary": None,
        "oracle_violations": oracle_violations or [],
        "call_count_in_request": 1,
    }


def test_summarize_basic_counts(tmp_path: Path) -> None:
    log = tmp_path / "t.jsonl"
    rows = [
        _enter("2024-01-01T00:00:00.000Z", "x", rid="r1"),
        _exit("2024-01-01T00:00:00.001Z", "x", rid="r1", duration_ms=1.0),
        _enter("2024-01-01T00:00:00.002Z", "y", rid="r2"),
        _exit(
            "2024-01-01T00:00:00.005Z",
            "y",
            rid="r2",
            status="error",
            error_type="ValueError",
            duration_ms=3.0,
        ),
    ]
    log.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    s = summarize_jsonl(log)
    assert s["line_count"] == 4
    assert s["enter_count"] == 2
    assert s["exit_count"] == 2
    assert s["balanced_pairs"] is True
    assert s["error_count"] == 1
    assert s["errors_by_type"] == {"ValueError": 1}
    assert s["unique_request_ids"] == 2
    assert s["duration_ms"]["n"] == 2


def test_write_summary_creates_artifact(tmp_path: Path) -> None:
    log = tmp_path / "t.jsonl"
    log.write_text(
        "\n".join(
            json.dumps(r)
            for r in [
                _enter("2024-01-01T00:00:00.000Z", "x"),
                _exit("2024-01-01T00:00:00.001Z", "x"),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    out = write_summary(log, dispatch_token="runpy", dropped_events=0)
    assert out.exists()
    payload = json.loads(out.read_text())
    assert payload["dispatch"] == "runpy"
    assert payload["dropped_events"] == 0
    assert payload["line_count"] == 2


def test_invalid_json_counted_separately(tmp_path: Path) -> None:
    log = tmp_path / "t.jsonl"
    valid = json.dumps(_enter("2024-01-01T00:00:00.000Z", "x"))
    log.write_text(valid + "\n{not json\n" + valid + "\n", encoding="utf-8")
    s = summarize_jsonl(log)
    assert s["invalid_json_count"] == 1
    assert s["line_count"] == 3  # all 3 non-blank lines, including the invalid one
    assert s["enter_count"] == 2
