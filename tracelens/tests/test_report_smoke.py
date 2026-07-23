"""tracelens report orchestrates analyze stages."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tracelens.analysis.report import write_report


def _exit_line(ts: str, comp: str, rid: str, parent: str | None, depth: int) -> dict[str, object]:
    return {
        "ts": ts,
        "request_id": rid,
        "component": comp,
        "event": "exit",
        "level": "info",
        "depth": depth,
        "parent_component": parent,
        "thread_id": 1,
        "duration_ms": 2.0,
        "status": "ok",
        "oracle_violations": [],
        "call_count_in_request": 1,
        "result_schema": None,
        "result_summary": None,
    }


def _enter_line(ts: str, comp: str, rid: str, parent: str | None, depth: int) -> dict[str, object]:
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
        "args_summary": {},
    }


def _write_trace(log: Path, n_requests: int = 12) -> None:
    lines: list[dict[str, object]] = []
    for i in range(n_requests):
        rid = f"r{i}"
        ts0 = f"2024-07-01T10:{i:02d}:00.000Z"
        lines.append(_enter_line(ts0, "svc.root", rid, None, 0))
        lines.append(_enter_line(f"2024-07-01T10:{i:02d}:00.001Z", "svc.child", rid, "svc.root", 1))
        lines.append(_exit_line(f"2024-07-01T10:{i:02d}:00.002Z", "svc.child", rid, "svc.root", 1))
        lines.append(_exit_line(f"2024-07-01T10:{i:02d}:00.003Z", "svc.root", rid, None, 0))
    log.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")


def test_report_ignores_foreign_tracemaps(tmp_path: Path) -> None:
    """Dogfooding fix: a sibling identification dir holding tracemaps from a
    DIFFERENT service/run (request ids disjoint from this trace) used to filter
    every row out and render an all-zero report. The overview must aggregate the
    whole trace, and disjoint tracemaps must be skipped (with a note), never
    rendered against zero rows."""
    log = tmp_path / "trace.jsonl"
    _write_trace(log, n_requests=12)

    ident = tmp_path / "identification"
    ident.mkdir()
    foreign = {
        "entrypoint": {
            "id": "POST_checkout",
            "method": "POST",
            "path": "/checkout",
            "handler": "planted_app.checkout",
        },
        "trace_file": str(log),  # claims this trace, but its request ids never ran here
        "requests_matched": ["zz-1", "zz-2"],
        "coverage": {"pct": 50.0},
    }
    (ident / "POST_checkout.tracemap.json").write_text(json.dumps(foreign), encoding="utf-8")

    html_out = tmp_path / "rep.html"
    write_report(log, html_out, identification=ident)
    text = html_out.read_text(encoding="utf-8")

    # Overview counts come from the real trace, not the foreign tracemap.
    assert ">12<" in text.replace(",", "")  # Requests KPI
    assert ">24<" in text.replace(",", "")  # Spans KPI (2 exits per request)
    # The foreign endpoint is noted as not exercised, not rendered as a view.
    assert "not exercised in this trace" in text
    assert "POST /checkout" in text
    assert "id='epsel'" not in text  # no per-endpoint dropdown for a stale-only map

    # Explicitly scoping to the foreign endpoint is an error, not a zero report.
    with pytest.raises(ValueError, match="matches no request in this trace"):
        write_report(log, tmp_path / "rep2.html", identification=ident, api_id="POST_checkout")


def test_report_keeps_overview_full_with_partial_tracemaps(tmp_path: Path) -> None:
    """A valid tracemap covering a subset of requests must not shrink the
    'All endpoints' overview to just its matched ids."""
    log = tmp_path / "trace.jsonl"
    _write_trace(log, n_requests=12)

    ident = tmp_path / "identification"
    ident.mkdir()
    good = {
        "entrypoint": {"id": "GET_thing", "method": "GET", "path": "/thing", "handler": "svc.root"},
        "trace_file": str(log),
        "requests_matched": ["r0", "r1", "r2"],
    }
    (ident / "GET_thing.tracemap.json").write_text(json.dumps(good), encoding="utf-8")

    html_out = tmp_path / "rep.html"
    write_report(log, html_out, identification=ident)
    text = html_out.read_text(encoding="utf-8")
    assert "All endpoints · 12 req" in text  # overview spans the whole trace
    assert "GET /thing · 3 req" in text  # endpoint view intersected with the trace
    assert "1 endpoint(s) exercised" in text


def test_report_html_embeds_circa_drift(tmp_path: Path) -> None:
    log = tmp_path / "l.jsonl"
    lines: list[dict[str, object]] = []
    for i in range(12):
        rid = f"r{i}"
        ts0 = f"2024-07-01T10:{i:02d}:00.000Z"
        lines.append(_enter_line(ts0, "svc.root", rid, None, 0))
        lines.append(_enter_line(f"2024-07-01T10:{i:02d}:00.001Z", "svc.child", rid, "svc.root", 1))
        lines.append(_exit_line(f"2024-07-01T10:{i:02d}:00.002Z", "svc.child", rid, "svc.root", 1))
        lines.append(_exit_line(f"2024-07-01T10:{i:02d}:00.003Z", "svc.root", rid, None, 0))
    log.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    html_out = tmp_path / "rep.html"
    write_report(log, html_out)
    text = html_out.read_text(encoding="utf-8")
    assert "CIRCA:" in text
    assert "Drift:" in text
    assert "linear_ks" in text or "scipy_histogram" in text
