"""Environment-breakage robustness: no dependency/env failure may silently kill capture.

Siblings of the fastapi-demo defect (broken OTel contrib on Python 3.14 swallowed into
a status string → spans to the no-op ProxyTracerProvider → no trace file, ever). Every
scenario here must end in one of exactly two states:

* fail fast — a single actionable line on stderr, non-zero exit, no raw traceback; or
* degrade LOUDLY — capture continues, one stderr warning, and an accounting entry in
  the summary's ``capture_health`` block.

Covered: read-only / uncreatable output dir, opentelemetry api↔sdk version skew,
TracerProvider configuration failure, span-export write failures, ``python -O``,
``os.fork()`` in the target, the post-startup capture self-check, and the
``capture_health`` summary block on a healthy smoke run.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tracelens import _health
from tracelens.launcher import otel_setup
from tracelens.launcher import run as run_mod

_ENTRY = "import sys; from tracelens.launcher.run import run_main; run_main(sys.argv[1:])"


@pytest.fixture(autouse=True)
def _fresh_health() -> None:
    _health.reset_for_tests()


def _write_target_project(root: Path, *, script_body: str) -> tuple[Path, Path]:
    """A tiny instrumentable package + a script that exercises it, runpy-style."""
    proj = root / "proj"
    pkg = proj / "demopkg"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "main.py").write_text(
        "def work(item):\n" "    return {'item': item}\n",
        encoding="utf-8",
    )
    script = proj / "app.py"
    script.write_text(script_body, encoding="utf-8")
    return proj, script


def _run_tracelens(
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    interpreter_flags: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *(interpreter_flags or []), "-c", _ENTRY, *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def _minimal_args(out: Path, script: Path) -> list[str]:
    return [
        "--minimal",
        "--no-otel-autoinst",
        "-t",
        "demopkg",
        "-o",
        str(out),
        "--",
        sys.executable,
        str(script),
    ]


def _components(trace_path: Path) -> set[str]:
    events = [
        json.loads(line)
        for line in trace_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    # Non-span header lines (tracer_calibration) carry no component.
    return {e["component"] for e in events if "component" in e}


# ---------------------------------------------------------------------------
# Read-only / uncreatable output locations → one clear line, not an empty trace.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission semantics")
@pytest.mark.skipif(
    os.name == "posix" and os.geteuid() == 0,
    reason="root ignores directory permissions",
)
def test_readonly_output_dir_is_one_clear_error(tmp_path: Path) -> None:
    proj, script = _write_target_project(tmp_path, script_body="print('hi')\n")
    ro = tmp_path / "ro"
    ro.mkdir()
    ro.chmod(0o500)
    try:
        r = _run_tracelens(
            _minimal_args(ro / "trace.jsonl", script), cwd=proj, env=dict(os.environ)
        )
    finally:
        ro.chmod(0o700)
    assert r.returncode != 0
    assert "not writable" in r.stderr
    assert "Traceback" not in r.stderr
    assert not (ro / "trace.jsonl").exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission semantics")
@pytest.mark.skipif(
    os.name == "posix" and os.geteuid() == 0,
    reason="root ignores directory permissions",
)
def test_uncreatable_output_dir_is_one_clear_error(tmp_path: Path) -> None:
    proj, script = _write_target_project(tmp_path, script_body="print('hi')\n")
    ro = tmp_path / "ro"
    ro.mkdir()
    ro.chmod(0o500)
    try:
        r = _run_tracelens(
            _minimal_args(ro / "sub" / "trace.jsonl", script), cwd=proj, env=dict(os.environ)
        )
    finally:
        ro.chmod(0o700)
    assert r.returncode != 0
    assert "cannot create trace output directory" in r.stderr
    assert "Traceback" not in r.stderr


# ---------------------------------------------------------------------------
# opentelemetry-api ↔ opentelemetry-sdk version skew → translated one-liner.
# ---------------------------------------------------------------------------


def test_version_skew_translated_to_one_liner(tmp_path: Path) -> None:
    """Distributions present but the sdk import explodes (ancient/mismatched pairing,
    simulated by a PYTHONPATH shadow that raises on import — the distribution still
    resolves via find_spec, exactly like a real skewed install)."""
    stub = tmp_path / "stub"
    sdk = stub / "opentelemetry" / "sdk"
    sdk.mkdir(parents=True)
    (sdk / "__init__.py").write_text(
        "raise ImportError(\"cannot import name 'Span' from 'opentelemetry.trace' "
        '(simulated version skew)")\n',
        encoding="utf-8",
    )
    proj, script = _write_target_project(tmp_path, script_body="print('hi')\n")
    env = {**os.environ, "PYTHONPATH": str(stub)}
    r = _run_tracelens(_minimal_args(tmp_path / "trace.jsonl", script), cwd=proj, env=env)
    assert r.returncode != 0
    assert "version skew" in r.stderr
    assert "simulated version skew" in r.stderr  # the underlying cause is named
    assert "pip install -U opentelemetry-api opentelemetry-sdk" in r.stderr
    assert "Traceback" not in r.stderr


def test_core_sdk_import_error_healthy_env_is_none() -> None:
    assert otel_setup.core_sdk_import_error() is None


# ---------------------------------------------------------------------------
# TracerProvider configuration failure → abort, never an empty "successful" run.
# ---------------------------------------------------------------------------


def test_configurator_failure_yields_status_with_cause(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from tracelens.otel import configurator as conf_mod

    def _boom(self: object, **kwargs: object) -> None:
        raise RuntimeError("cannot open span pipeline")

    monkeypatch.setattr(conf_mod.TracelensConfigurator, "configure", _boom)
    status = otel_setup.configure_tracer_provider()
    assert status == "failed:RuntimeError: cannot open span pipeline"
    assert "NO spans will be recorded" in capsys.readouterr().err


def test_ensure_span_pipeline_aborts_on_failed_configurator() -> None:
    with pytest.raises(SystemExit, match="no spans would be recorded"):
        run_mod._ensure_span_pipeline(
            {"__tracelens_configurator__": "failed:PermissionError: [Errno 13] denied"}
        )


def test_ensure_span_pipeline_accepts_configured() -> None:
    run_mod._ensure_span_pipeline({"__tracelens_configurator__": "configured"})


# ---------------------------------------------------------------------------
# Span-export write failures → loud once + counted, never silently eaten.
# ---------------------------------------------------------------------------


def test_export_error_is_loud_once_and_counted(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    from opentelemetry.sdk.trace.export import SpanExportResult

    from tracelens.otel.exporter import JSONLFileSpanExporter

    exp = JSONLFileSpanExporter(str(tmp_path / "trace.jsonl"))
    bad_span = object()  # _export_one blows up on the first attribute access
    assert exp.export([bad_span]) is SpanExportResult.SUCCESS  # type: ignore[list-item]
    assert exp.export([bad_span]) is SpanExportResult.SUCCESS  # type: ignore[list-item]
    err = capsys.readouterr().err
    assert err.count("span export to") == 1, "loud exactly once, not once per span"
    snap = _health.snapshot()
    assert snap.get("export_errors") == 2, "every failure is counted for the summary"


# ---------------------------------------------------------------------------
# Capture self-check: real provider, writable file, spans actually flowing.
# ---------------------------------------------------------------------------


def test_selfcheck_flags_proxy_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from opentelemetry import trace as otel_trace

    monkeypatch.setattr(otel_trace, "get_tracer_provider", lambda: otel_trace.ProxyTracerProvider())
    out = tmp_path / "trace.jsonl"
    out.write_text("", encoding="utf-8")
    problems = run_mod._capture_selfcheck(str(out))
    assert any("ProxyTracerProvider" in p for p in problems)
    assert "ProxyTracerProvider" in capsys.readouterr().err


@pytest.mark.skipif(os.name == "nt", reason="fork supervisor path is POSIX-only")
def test_selfcheck_warns_when_instrumented_but_zero_spans_exported(tmp_path: Path) -> None:
    """--sample-rate 0.0 stands in for 'capture broke': modules were instrumented and
    imported, yet nothing reaches the exporter — the run must say so on stderr."""
    proj, script = _write_target_project(
        tmp_path,
        script_body=(
            "import time\n" "from demopkg.main import work\n" "work(1)\n" "time.sleep(1.0)\n"
        ),
    )
    out = tmp_path / "trace.jsonl"
    env = {**os.environ, "TRACELENS_SELFCHECK_DELAY_S": "0.3"}
    r = _run_tracelens(
        [*_minimal_args(out, script)[:2], "--sample-rate", "0.0", *_minimal_args(out, script)[2:]],
        cwd=proj,
        env=env,
    )
    assert r.returncode == 0, r.stderr
    assert "capture self-check" in r.stderr
    assert "0 spans exported" in r.stderr
    summary = json.loads(out.with_name(out.name + ".summary.json").read_text(encoding="utf-8"))
    assert any("0 spans exported" in p for p in summary["capture_health"]["selfcheck"])


# ---------------------------------------------------------------------------
# python -O: no load-bearing asserts anywhere in the capture path.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(os.name == "nt", reason="fork supervisor path is POSIX-only")
def test_capture_works_under_python_O(tmp_path: Path) -> None:
    proj, script = _write_target_project(
        tmp_path,
        script_body="from demopkg.main import work\nwork(1)\nwork(2)\n",
    )
    out = tmp_path / "trace.jsonl"
    r = _run_tracelens(
        _minimal_args(out, script),
        cwd=proj,
        env=dict(os.environ),
        interpreter_flags=["-O"],
    )
    assert r.returncode == 0, r.stderr
    assert out.is_file()
    assert "demopkg.main.work" in _components(out)


# ---------------------------------------------------------------------------
# os.fork() in the target: children must never corrupt the parent's trace file.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not hasattr(os, "fork"), reason="requires os.fork")
def test_fork_child_spans_are_isolated_then_merged_back(tmp_path: Path) -> None:
    proj, script = _write_target_project(
        tmp_path,
        script_body=(
            "import os\n"
            "from demopkg.main import work\n"
            "work('parent-pre')\n"
            "pid = os.fork()\n"
            "if pid == 0:\n"
            "    work('child')\n"
            "    raise SystemExit(0)\n"
            "os.waitpid(pid, 0)\n"
            "work('parent-post')\n"
        ),
    )
    out = tmp_path / "trace.jsonl"
    r = _run_tracelens(_minimal_args(out, script), cwd=proj, env=dict(os.environ))
    assert r.returncode == 0, r.stderr

    # Parent file: valid JSONL throughout (no interleaved/torn lines) with the
    # parent's spans present.
    lines = [ln for ln in out.read_text(encoding="utf-8").splitlines() if ln.strip()]
    events = [json.loads(ln) for ln in lines]  # raises if any line was torn
    assert any(e.get("component") == "demopkg.main.work" for e in events)

    # The fork child wrote to its own pid-suffixed sidecar DURING the run —
    # that isolation is what keeps the parent file free of interleaved lines.
    # The summary still records that it happened.
    summary = json.loads(out.with_name(out.name + ".summary.json").read_text(encoding="utf-8"))
    assert summary["capture_health"]["fork_sidecar_files"]

    # …and by the end those sidecars are MERGED BACK into the trace, because
    # every reader in the repo resolves a capture by globbing `trace.jsonl`
    # exactly: an unmerged sidecar is a capture that never happened.
    assert not sorted(out.parent.glob(out.name + ".fork-*")), (
        "fork sidecars must be folded into the main trace, not left on disk"
    )
    # Three work() calls happened across two processes: 'parent-pre' and
    # 'parent-post' in the parent, 'child' in the fork. Without the merge the
    # trace would carry only the parent's two.
    work_enters = [
        e
        for e in events
        if e.get("event") == "enter" and e.get("component") == "demopkg.main.work"
    ]
    assert len(work_enters) == 3, (
        "the forked child's span must appear in the merged trace; got "
        f"{len(work_enters)} work() enters"
    )
    # The child's argument was 'child' (5 chars) — distinct from both of the
    # parent's, so its presence is unambiguous.
    assert any(
        (e.get("args_summary") or {}).get("item", {}).get("len") == 5 for e in work_enters
    ), "the child's own call must be the one that was merged in"


# ---------------------------------------------------------------------------
# Healthy-path smoke: capture works AND proves it in capture_health.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(os.name == "nt", reason="fork supervisor path is POSIX-only")
def test_smoke_summary_carries_capture_health(tmp_path: Path) -> None:
    proj, script = _write_target_project(
        tmp_path,
        script_body=(
            "import time\n" "from demopkg.main import work\n" "work(1)\n" "time.sleep(0.2)\n"
        ),
    )
    out = tmp_path / "trace.jsonl"
    r = _run_tracelens(_minimal_args(out, script), cwd=proj, env=dict(os.environ))
    assert r.returncode == 0, r.stderr
    assert "demopkg.main.work" in _components(out)
    summary = json.loads(out.with_name(out.name + ".summary.json").read_text(encoding="utf-8"))
    health = summary["capture_health"]
    assert health["spans_exported"] >= 1
    assert health["configurator"] == "configured"
    assert "export_errors" not in health


# ---------------------------------------------------------------------------
# Enrichment failures must degrade the span, never break the wrapped call.
# ---------------------------------------------------------------------------


def test_result_enrichment_failure_does_not_break_wrapped_call(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from tracelens.runtime import trace_fn

    def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("pathological result object")

    monkeypatch.setattr(trace_fn, "_apply_exit_attrs", _boom)
    assert trace_fn.wrap_call("demo.fn", lambda x: x + 1, 41) == 42
    assert "result enrichment failed for demo.fn" in capsys.readouterr().err
    assert _health.snapshot().get("result_enrichment_errors") == 1
