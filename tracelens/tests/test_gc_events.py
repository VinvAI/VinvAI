"""GC-as-latency-source capture (spec §20): gc.callbacks → gc_pause trace lines.

* forced ``gc.collect()`` under the observer produces well-formed gc_pause
  lines (duration_ms float, generation int, iso ts);
* an active request_id (Baggage) is threaded onto the lines, and omitted —
  not nulled — outside any request scope;
* install is disable-able, idempotent, and loud-but-non-blocking on failure;
* ``summarize_jsonl`` accounts gc_pause lines in their own block without
  polluting component/request statistics;
* end-to-end: a real ``tracelens run`` over a script that forces a collection
  writes gc_pause lines into the trace (the wiring in run_main is the caller).
"""

from __future__ import annotations

import gc
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from tracelens import _health
from tracelens.launcher import gc_events
from tracelens.launcher.summary import summarize_jsonl

_ENTRY = "import sys; from tracelens.launcher.run import run_main; run_main(sys.argv[1:])"


@pytest.fixture(autouse=True)
def _clean_observer() -> Any:
    """Never leak the observer (or its handle) into other test modules."""
    yield
    gc_events.uninstall()


def _rows(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(ln)
        for ln in path.read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]


def _pauses(path: Path) -> list[dict[str, Any]]:
    return [r for r in _rows(path) if r.get("event") == "gc_pause"]


def test_forced_collect_emits_gc_pause_lines(tmp_path: Path) -> None:
    out = tmp_path / "trace.jsonl"
    assert gc_events.install(str(out)) is True
    gc.collect()
    gc_events.uninstall()
    pauses = _pauses(out)
    assert pauses, "a forced gc.collect() must produce at least one gc_pause line"
    for p in pauses:
        assert isinstance(p["duration_ms"], int | float) and p["duration_ms"] >= 0
        assert isinstance(p["generation"], int)
        assert p["ts"].startswith("2")  # iso-ish, matches other trace lines
    # gc.collect() runs a full collection — generation 2 must be among them.
    assert any(p["generation"] == 2 for p in pauses)


def test_request_id_threaded_when_in_scope(tmp_path: Path) -> None:
    from opentelemetry import context as otel_context

    from tracelens.context import set_request_id_baggage

    out = tmp_path / "trace.jsonl"
    assert gc_events.install(str(out)) is True
    token = set_request_id_baggage("req-under-gc")
    try:
        gc.collect()
    finally:
        otel_context.detach(token)
    # "No request in scope" must not depend on what earlier test modules left
    # in the ambient OTel context (a leaked current span would make the
    # fallback synthesize an id) — collect under an explicitly empty context.
    clean = otel_context.attach(otel_context.Context())
    try:
        gc.collect()
    finally:
        otel_context.detach(clean)
    gc_events.uninstall()
    pauses = _pauses(out)
    assert any(p.get("request_id") == "req-under-gc" for p in pauses), (
        "collections during an active request must carry its request_id"
    )
    # Outside any request scope the field is OMITTED (the clean-context collect
    # above guarantees at least one such pause), and when present it is never
    # null or empty.
    assert any("request_id" not in p for p in pauses)
    assert all(p.get("request_id", "present") for p in pauses)


def test_install_disabled_by_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRACELENS_NO_GC_EVENTS", "1")
    before = len(gc.callbacks)
    assert gc_events.install(str(tmp_path / "trace.jsonl")) is False
    assert len(gc.callbacks) == before


def test_install_is_idempotent(tmp_path: Path) -> None:
    out = tmp_path / "trace.jsonl"
    before = len(gc.callbacks)
    assert gc_events.install(str(out)) is True
    assert gc_events.install(str(out)) is True
    assert len(gc.callbacks) == before + 1


def test_install_failure_is_loud_not_blocking(tmp_path: Path) -> None:
    # A directory where the trace file should be: open() fails, install must
    # return False (no observer) and record the failure — never raise.
    target = tmp_path / "trace.jsonl"
    target.mkdir()
    before = len(gc.callbacks)
    assert gc_events.install(str(target)) is False
    assert len(gc.callbacks) == before
    assert "gc_events_install_errors" in _health.snapshot()


def test_summary_accounts_gc_without_polluting_stats(tmp_path: Path) -> None:
    log = tmp_path / "t.jsonl"
    rows = [
        {"event": "gc_pause", "ts": "2026-07-25T00:00:00.000Z", "duration_ms": 1.5, "generation": 0},
        {"event": "gc_pause", "ts": "2026-07-25T00:00:00.500Z", "duration_ms": 2.5, "generation": 2},
        {
            "ts": "2026-07-25T00:00:01.000Z",
            "request_id": "r1",
            "component": "a.b",
            "event": "enter",
            "depth": 0,
            "parent_component": None,
            "thread_id": 1,
        },
        {
            "ts": "2026-07-25T00:00:01.001Z",
            "request_id": "r1",
            "component": "a.b",
            "event": "exit",
            "depth": 0,
            "parent_component": None,
            "thread_id": 1,
            "duration_ms": 1.0,
            "status": "ok",
        },
    ]
    log.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    s = summarize_jsonl(log)
    assert s["gc"] == {"count": 2, "total_pause_ms": 4.0}
    assert s["enter_count"] == 1 and s["exit_count"] == 1
    comps = {c["component"] for c in s["top_components"]}
    assert comps == {"a.b"}  # gc lines contributed no phantom "?" component
    assert s["unique_request_ids"] == 1


def test_summary_gc_is_none_without_gc_lines(tmp_path: Path) -> None:
    log = tmp_path / "t.jsonl"
    log.write_text("", encoding="utf-8")
    assert summarize_jsonl(log)["gc"] is None  # no visibility ≠ zero pauses


# ---------------------------------------------------------------------------
# End-to-end: real `tracelens run` (the wiring in run_main is the real caller).
# ---------------------------------------------------------------------------


def test_run_emits_gc_pause_lines(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    pkg = proj / "demopkg"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "main.py").write_text(
        "def work(item):\n    return {'item': item}\n", encoding="utf-8"
    )
    script = proj / "app.py"
    script.write_text(
        "import gc\nfrom demopkg.main import work\nwork(1)\ngc.collect()\n",
        encoding="utf-8",
    )
    out = tmp_path / "trace.jsonl"
    env = {
        **os.environ,
        "TRACELENS_CALIBRATION_BUDGET_MS": "80",
        "TRACELENS_NO_SELFCHECK": "1",
    }
    env.pop("TRACELENS_NO_GC_EVENTS", None)
    r = subprocess.run(
        [
            sys.executable,
            "-c",
            _ENTRY,
            "--no-otel-autoinst",
            "-t",
            "demopkg",
            "-o",
            str(out),
            "--",
            sys.executable,
            str(script),
        ],
        cwd=proj,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert r.returncode == 0, f"run failed: {r.stderr}"
    pauses = _pauses(out)
    assert pauses, "a traced run that forces gc.collect() must record gc_pause lines"
    assert all(isinstance(p["generation"], int) for p in pauses)
    # The span rows are untouched by the observer.
    exits = [row for row in _rows(out) if row.get("event") == "exit"]
    assert any(row.get("component") == "demopkg.main.work" for row in exits)
    summary = json.loads(out.with_name(out.name + ".summary.json").read_text(encoding="utf-8"))
    assert summary["gc"]["count"] >= len(pauses) - 1  # summary sees the same file
    assert summary["gc"]["total_pause_ms"] >= 0
