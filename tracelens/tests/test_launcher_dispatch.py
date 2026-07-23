"""Spec §20 #15: runpy vs opentelemetry-instrument (execvp) dispatch is logged."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tracelens.launcher import run as run_mod

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def oi_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    bindir = Path(sys.executable).parent
    oi = bindir / "opentelemetry-instrument"
    if not oi.is_file():
        pytest.skip("opentelemetry-instrument not found next to python interpreter")
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ.get("PATH", ""))


def test_nuitka_onefile_child_is_frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run_mod.sys, "frozen", False, raising=False)
    monkeypatch.setitem(run_mod.__dict__, "__compiled__", None)
    monkeypatch.setitem(run_mod.sys.modules, "__main__", type(run_mod.sys)("fake_main"))
    monkeypatch.setenv("NUITKA_ONEFILE_PARENT", "12345")
    monkeypatch.delenv("NUITKA_ONEFILE_DIRECTORY", raising=False)

    assert run_mod._is_frozen() is True


def test_source_launcher_is_not_frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run_mod.sys, "frozen", False, raising=False)
    monkeypatch.setitem(run_mod.__dict__, "__compiled__", None)
    monkeypatch.setitem(run_mod.sys.modules, "__main__", type(run_mod.sys)("fake_main"))
    monkeypatch.delenv("NUITKA_ONEFILE_PARENT", raising=False)
    monkeypatch.delenv("NUITKA_ONEFILE_DIRECTORY", raising=False)

    assert run_mod._is_frozen() is False


def test_dispatch_runpy_logged(tmp_path: Path) -> None:
    script = tmp_path / "emit.py"
    script.write_text(
        "from opentelemetry import trace\n"
        "tr = trace.get_tracer('probe')\n"
        "for _ in range(5):\n"
        "    with tr.start_as_current_span('root'):\n"
        "        pass\n",
        encoding="utf-8",
    )
    diag = tmp_path / "diag.log"
    out = tmp_path / "trace.jsonl"
    env = {**os.environ, "TRACELENS_DIAG_LOG": str(diag)}
    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "tracelens.cli",
            "run",
            "-o",
            str(out),
            "-t",
            "demo_app",
            "--",
            sys.executable,
            str(script),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
        check=False,
    )
    assert r.returncode == 0, r.stderr + r.stdout
    assert out.stat().st_size > 0, "expected JSONL from OTel spans"
    text = diag.read_text(encoding="utf-8")
    assert "tracelens_dispatch=runpy" in text


def test_dispatch_execvp_logged(tmp_path: Path, oi_on_path: None) -> None:
    diag = tmp_path / "diag2.log"
    out = tmp_path / "trace2.jsonl"
    env = {**os.environ, "TRACELENS_DIAG_LOG": str(diag)}
    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "tracelens.cli",
            "run",
            "-o",
            str(out),
            "-t",
            "demo_app",
            "--",
            sys.executable,
            "-c",
            "print('tracelens_execvp_probe')",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
        check=False,
    )
    assert r.returncode == 0, r.stderr + r.stdout
    text = diag.read_text(encoding="utf-8")
    assert "tracelens_dispatch=execvp" in text
    assert "external command dispatch uses degraded instrumentation" in r.stderr

    emit = tmp_path / "emit_inline.py"
    emit.write_text(
        "from opentelemetry import trace\n"
        "tr = trace.get_tracer('execvp_emit')\n"
        "for _ in range(5):\n"
        "    with tr.start_as_current_span('root'):\n"
        "        pass\n",
        encoding="utf-8",
    )
    out3 = tmp_path / "trace_execvp_otel.jsonl"
    diag3 = tmp_path / "diag3.log"
    code = (
        "import runpy\n" f"runpy.run_path({json.dumps(str(emit.resolve()))}, run_name='__main__')\n"
    )
    r3 = subprocess.run(
        [
            sys.executable,
            "-m",
            "tracelens.cli",
            "run",
            "-o",
            str(out3),
            "-t",
            "demo_app",
            "--",
            sys.executable,
            "-c",
            code,
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        env={**os.environ, "TRACELENS_DIAG_LOG": str(diag3)},
        timeout=120,
        check=False,
    )
    assert r3.returncode == 0, r3.stderr + r3.stdout
    assert "tracelens_dispatch=execvp" in diag3.read_text(encoding="utf-8")
    assert out3.stat().st_size > 0, "execvp path should still emit JSONL when child runs OTel spans"
