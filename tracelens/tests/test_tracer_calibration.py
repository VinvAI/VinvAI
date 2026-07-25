"""Startup overhead self-calibration (audit task 1 + tracemalloc honesty, task 3).

* ``measure_overhead`` — adaptive K (relative stopping rule), bounded by call
  cap and wall budget, returns a median+MAD distribution;
* ``run_calibration`` — writes the ``tracer_calibration`` header line into the
  trace JSONL, records the active axes, is disable-able, and never raises;
* the exporter drops the synthetic calibration spans (they must not appear as
  trace rows);
* ``summarize_jsonl`` surfaces the header into summary.json without letting it
  pollute component/request statistics;
* end-to-end: a real ``tracelens run`` produces a trace whose header line and
  summary both carry the calibration, with axes matching the active preset.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tracelens.launcher import calibration
from tracelens.launcher.summary import summarize_jsonl
from tracelens.otel.exporter import CALIBRATION_SPAN_PREFIX

_ENTRY = "import sys; from tracelens.launcher.run import run_main; run_main(sys.argv[1:])"


def test_measure_overhead_shape_and_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRACELENS_CALIBRATION_MAX_CALLS", "128")
    monkeypatch.setenv("TRACELENS_CALIBRATION_BUDGET_MS", "200")
    r = calibration.measure_overhead()
    assert r["n"] >= 32  # at least one batch ran
    assert r["n"] <= 128 + 32  # the cap is respected batch-granular
    assert r["median_ns"] > 0
    assert r["mad_ns"] >= 0
    assert isinstance(r["stabilized"], bool)


def test_measure_overhead_adaptive_stop_is_relative(monkeypatch: pytest.MonkeyPatch) -> None:
    # A generous tolerance stops after the second batch on any host — the rule
    # compares successive medians relative to each other, not to a fixed ns bar.
    monkeypatch.setenv("TRACELENS_CALIBRATION_REL_TOL", "10.0")
    monkeypatch.setenv("TRACELENS_CALIBRATION_MAX_CALLS", "4096")
    monkeypatch.setenv("TRACELENS_CALIBRATION_BUDGET_MS", "5000")
    r = calibration.measure_overhead()
    assert r["stabilized"] is True
    assert r["n"] == 64  # exactly two batches


def test_run_calibration_writes_header_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("TRACELENS_NO_CALIBRATION", raising=False)
    monkeypatch.setenv("TRACELENS_CALIBRATION_MAX_CALLS", "64")
    out = tmp_path / "trace.jsonl"
    header = calibration.run_calibration(str(out), memory_enabled=False, capture_determinism=False)
    assert header is not None
    lines = [ln for ln in out.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 1
    row = json.loads(lines[0])
    assert row["event"] == "tracer_calibration"
    assert row["axes"] == {"enrichment": True, "tracemalloc": False, "determinism": False}
    dist = row["per_call_overhead_ns"]
    assert dist["median"] > 0 and dist["mad"] >= 0 and dist["n"] >= 32
    assert row["ts"].startswith("2")  # iso-ish, matches other trace lines


def test_run_calibration_disabled_by_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRACELENS_NO_CALIBRATION", "1")
    out = tmp_path / "trace.jsonl"
    assert (
        calibration.run_calibration(str(out), memory_enabled=False, capture_determinism=False)
        is None
    )
    assert not out.exists()


def test_exporter_drops_calibration_spans(tmp_path: Path) -> None:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor

    from tracelens.otel.exporter import JSONLFileSpanExporter

    out = tmp_path / "trace.jsonl"
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(JSONLFileSpanExporter(str(out))))
    tracer = provider.get_tracer("test")
    with tracer.start_as_current_span(CALIBRATION_SPAN_PREFIX + "noop"):
        pass
    with tracer.start_as_current_span("demo.mod.fn"):
        pass
    provider.shutdown()
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    comps = {r["component"] for r in rows}
    assert comps == {"demo.mod.fn"}, "calibration spans must never become trace rows"


def test_summary_surfaces_calibration_without_polluting_stats(tmp_path: Path) -> None:
    log = tmp_path / "t.jsonl"
    header = {
        "event": "tracer_calibration",
        "ts": "2026-07-25T00:00:00.000Z",
        "axes": {"enrichment": True, "tracemalloc": False, "determinism": False},
        "per_call_overhead_ns": {"median": 21000, "mad": 900, "n": 64},
        "stabilized": True,
    }
    rows = [
        header,
        {
            "ts": "2026-07-25T00:00:01.000Z",
            "request_id": "r1",
            "component": "a.b",
            "event": "enter",
            "level": "INFO",
            "depth": 0,
            "parent_component": None,
            "thread_id": 1,
            "args_hash": "0" * 16,
            "args_schema": "()",
            "args_summary": {},
        },
        {
            "ts": "2026-07-25T00:00:01.001Z",
            "request_id": "r1",
            "component": "a.b",
            "event": "exit",
            "level": "INFO",
            "depth": 0,
            "parent_component": None,
            "thread_id": 1,
            "duration_ms": 1.0,
            "status": "ok",
            "oracle_violations": [],
            "call_count_in_request": 1,
        },
    ]
    log.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    s = summarize_jsonl(log)
    assert s["tracer_calibration"]["per_call_overhead_ns"]["median"] == 21000
    assert s["enter_count"] == 1 and s["exit_count"] == 1
    comps = {c["component"] for c in s["top_components"]}
    assert comps == {"a.b"}  # the header contributed no phantom "?" component
    assert s["unique_request_ids"] == 1


# ---------------------------------------------------------------------------
# End-to-end: real `tracelens run` (the wiring in run_main is the real caller).
# ---------------------------------------------------------------------------


def _write_target(root: Path) -> tuple[Path, Path]:
    proj = root / "proj"
    pkg = proj / "demopkg"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "main.py").write_text("def work(item):\n    return {'item': item}\n", encoding="utf-8")
    script = proj / "app.py"
    script.write_text("from demopkg.main import work\nwork(1)\n", encoding="utf-8")
    return proj, script


@pytest.mark.parametrize("memory_flag,expect_tracemalloc", [(None, False), ("--memory", True)])
def test_run_writes_calibration_header_and_summary(
    tmp_path: Path, memory_flag: str | None, expect_tracemalloc: bool
) -> None:
    proj, script = _write_target(tmp_path)
    out = tmp_path / "trace.jsonl"
    env = {
        **os.environ,
        "TRACELENS_CALIBRATION_BUDGET_MS": "80",
        "TRACELENS_NO_SELFCHECK": "1",
    }
    env.pop("TRACELENS_NO_CALIBRATION", None)
    env.pop("TRACELENS_PRESET", None)
    env.pop("TRACELENS_MEMORY", None)
    args = [
        "--no-otel-autoinst",
        *([memory_flag] if memory_flag else []),
        "-t",
        "demopkg",
        "-o",
        str(out),
        "--",
        sys.executable,
        str(script),
    ]
    r = subprocess.run(
        [sys.executable, "-c", _ENTRY, *args],
        cwd=proj,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert r.returncode == 0, f"run failed: {r.stderr}"
    rows = [json.loads(ln) for ln in out.read_text(encoding="utf-8").splitlines() if ln.strip()]
    headers = [row for row in rows if row.get("event") == "tracer_calibration"]
    assert len(headers) == 1, "exactly one calibration header per run"
    assert headers[0] == rows[0], "calibration is a HEADER — first line of the trace"
    assert headers[0]["axes"]["tracemalloc"] is expect_tracemalloc
    assert headers[0]["per_call_overhead_ns"]["median"] > 0
    # No synthetic calibration span leaked into the trace rows.
    assert not any(
        str(row.get("component", "")).startswith(CALIBRATION_SPAN_PREFIX) for row in rows
    )
    # The real spans are still there, now with the additive blocked_ms field.
    exits = [row for row in rows if row.get("event") == "exit"]
    ours = [row for row in exits if row.get("component") == "demopkg.main.work"]
    assert ours and isinstance(ours[0]["blocked_ms"], int | float)
    # mem_delta follows the active axis: null on the latency-honest default.
    assert (ours[0]["mem_delta_bytes"] is not None) is expect_tracemalloc
    summary = json.loads(out.with_name(out.name + ".summary.json").read_text(encoding="utf-8"))
    assert summary["tracer_calibration"]["per_call_overhead_ns"]["median"] > 0
    assert summary["tracer_calibration"]["axes"]["tracemalloc"] is expect_tracemalloc
