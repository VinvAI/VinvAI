"""Regression tests for the fastapi-demo silent-empty-trace defect and its papercuts.

Root cause (found live on fastapi/full-stack-fastapi-template): the launcher routed
TracerProvider setup through OTel contrib's private entry-point loader
(``opentelemetry.instrumentation.auto_instrumentation._load``). On Python 3.14 that
module imports the removed ``pkg_resources``; the ``ModuleNotFoundError`` was
swallowed, no TracerProvider was ever installed, and every span went to the no-op
``ProxyTracerProvider`` — the trace file was never created at all.

The fixture below is uvicorn-shaped: a ``python -m fake_uvicorn pkg.mod:app`` target
that resolves and imports the app module LAZILY (uvicorn's ``import_from_string``),
i.e. after the launcher's hooks are installed, with a PYTHONPATH stub that shadows
``opentelemetry.instrumentation.auto_instrumentation`` and raises the same
``ModuleNotFoundError`` the demo venv produced. No network involved.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tracelens.launcher import otel_setup
from tracelens.launcher import run as run_mod

_ENTRY = "import sys; from tracelens.launcher.run import run_main; run_main(sys.argv[1:])"


def _write_broken_contrib_stub(root: Path) -> Path:
    """A PYTHONPATH dir whose ``opentelemetry.instrumentation.auto_instrumentation``
    shadows the installed one and dies exactly like the demo venv did."""
    stub = root / "stub"
    pkg = stub / "opentelemetry" / "instrumentation" / "auto_instrumentation"
    pkg.mkdir(parents=True)
    # Parents stay namespace portions (no __init__.py) so the real
    # opentelemetry / opentelemetry.instrumentation modules still resolve.
    (pkg / "__init__.py").write_text(
        "raise ModuleNotFoundError(\"No module named 'pkg_resources'\")\n",
        encoding="utf-8",
    )
    return stub


def _write_uvicorn_shaped_project(root: Path) -> Path:
    proj = root / "proj"
    app_pkg = proj / "demopkg"
    app_pkg.mkdir(parents=True)
    (app_pkg / "__init__.py").write_text("", encoding="utf-8")
    (app_pkg / "main.py").write_text(
        "class App:\n"
        "    def handle(self, item):\n"
        "        return self.transform(item)\n"
        "\n"
        "    def transform(self, item):\n"
        "        return {'item': item}\n"
        "\n"
        "app = App()\n",
        encoding="utf-8",
    )
    server = proj / "fake_uvicorn"
    server.mkdir()
    (server / "__init__.py").write_text("", encoding="utf-8")
    # Lazy import-from-string, exactly like uvicorn.importer.import_from_string:
    # the app package must not be imported until AFTER tracelens hooks are live.
    (server / "__main__.py").write_text(
        "import importlib\n"
        "import sys\n"
        "\n"
        "spec = sys.argv[1]\n"
        "modname, _, attr = spec.partition(':')\n"
        "mod = importlib.import_module(modname)\n"
        "app = getattr(mod, attr)\n"
        "for i in range(3):\n"
        "    app.handle(i)\n",
        encoding="utf-8",
    )
    return proj


def _run_tracelens(
    args: list[str], *, cwd: Path, env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", _ENTRY, *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


@pytest.mark.skipif(os.name == "nt", reason="fork supervisor path is POSIX-only")
def test_minimal_capture_survives_broken_otel_contrib(tmp_path: Path) -> None:
    stub = _write_broken_contrib_stub(tmp_path)
    proj = _write_uvicorn_shaped_project(tmp_path)
    out = tmp_path / "trace.jsonl"
    env = {**os.environ, "PYTHONPATH": str(stub)}
    env.pop("TRACELENS_DIAG_LOG", None)

    # Fixture sanity: with the stub, the contrib bootstrap import fails exactly
    # like the demo venv (pkg_resources gone on Python 3.14).
    probe = subprocess.run(
        [sys.executable, "-c", "import opentelemetry.instrumentation.auto_instrumentation"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert probe.returncode != 0
    assert "pkg_resources" in probe.stderr

    r = _run_tracelens(
        [
            "--minimal",
            "--no-otel-autoinst",
            "-t",
            "demopkg",
            "-o",
            str(out),
            "--",
            sys.executable,
            "-m",
            "fake_uvicorn",
            "demopkg.main:app",
        ],
        cwd=proj,
        env=env,
    )
    assert r.returncode == 0, r.stderr
    assert out.is_file(), "trace file was never created (root-cause regression)"
    events = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    components = {e["component"] for e in events if "component" in e}
    assert "demopkg.main.App.handle" in components
    assert "demopkg.main.App.transform" in components


@pytest.mark.skipif(os.name == "nt", reason="fork supervisor path is POSIX-only")
def test_autoinst_with_broken_contrib_warns_but_still_captures(tmp_path: Path) -> None:
    """Without --no-otel-autoinst a broken contrib package must degrade loudly,
    not silently disable span export."""
    stub = _write_broken_contrib_stub(tmp_path)
    proj = _write_uvicorn_shaped_project(tmp_path)
    out = tmp_path / "trace.jsonl"
    env = {**os.environ, "PYTHONPATH": str(stub)}
    env.pop("TRACELENS_DIAG_LOG", None)

    r = _run_tracelens(
        [
            "--minimal",
            "-t",
            "demopkg",
            "-o",
            str(out),
            "--",
            sys.executable,
            "-m",
            "fake_uvicorn",
            "demopkg.main:app",
        ],
        cwd=proj,
        env=env,
    )
    assert r.returncode == 0, r.stderr
    assert out.is_file()
    events = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert any(e.get("component", "").startswith("demopkg.") for e in events)
    assert "auto-instrumentation unavailable" in r.stderr


def test_bootstrap_no_autoinst_skips_contrib_and_configures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TRACELENS_OUTPUT", str(tmp_path / "trace.jsonl"))
    # Poison the contrib loader import: if bootstrap touches it in minimal mode,
    # this raises and the status would say "failed:" instead of "skipped:".
    monkeypatch.setitem(
        sys.modules, "opentelemetry.instrumentation.auto_instrumentation._load", None
    )

    status = otel_setup.bootstrap_autoinstrumentation(load_instrumentors=False)

    assert status["__tracelens_configurator__"] == "configured"
    assert status["__otel_entry_points__"] == "skipped:no_autoinst"


def test_bootstrap_configures_provider_even_when_entry_loader_broken(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TRACELENS_OUTPUT", str(tmp_path / "trace.jsonl"))
    monkeypatch.setitem(
        sys.modules, "opentelemetry.instrumentation.auto_instrumentation._load", None
    )

    status = otel_setup.bootstrap_autoinstrumentation(load_instrumentors=True)

    assert status["__tracelens_configurator__"] == "configured"
    assert status["__otel_entry_points__"].startswith("failed:")


def test_core_sdk_missing_names_the_missing_distribution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert otel_setup.core_sdk_missing() is None  # dev env has api+sdk

    real_find_spec = otel_setup.importlib.util.find_spec

    def fake_find_spec(name: str, *args: object) -> object:
        if name == "opentelemetry.sdk":
            return None
        return real_find_spec(name, *args)  # type: ignore[arg-type]

    monkeypatch.setattr(otel_setup.importlib.util, "find_spec", fake_find_spec)
    assert otel_setup.core_sdk_missing() == "opentelemetry-sdk"


def test_otel_less_interpreter_gets_friendly_one_liner(tmp_path: Path) -> None:
    """Simulate a target venv without opentelemetry via ``python -S`` (site-packages
    hidden); tracelens itself is supplied on PYTHONPATH. The run must exit with a
    single actionable line, not a raw ModuleNotFoundError traceback."""
    src = str(Path(run_mod.__file__).resolve().parents[2])
    script = tmp_path / "app.py"
    script.write_text("print('hi')\n", encoding="utf-8")
    env = {**os.environ, "PYTHONPATH": src}
    r = subprocess.run(
        [
            sys.executable,
            "-S",
            "-c",
            _ENTRY,
            "-o",
            str(tmp_path / "t.jsonl"),
            "--",
            sys.executable,
            str(script),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert r.returncode != 0
    assert "pip install opentelemetry-api opentelemetry-sdk" in r.stderr
    assert "Traceback" not in r.stderr


def test_missing_target_python_gets_friendly_one_liner(tmp_path: Path) -> None:
    missing = "/definitely/not/a/venv/bin/python"
    r = subprocess.run(
        [
            sys.executable,
            "-c",
            _ENTRY,
            "-o",
            str(tmp_path / "t.jsonl"),
            "--",
            missing,
            "-m",
            "uvicorn",
            "app.main:app",
        ],
        cwd=tmp_path,
        env=dict(os.environ),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert r.returncode != 0
    assert "target command not found" in r.stderr
    assert missing in r.stderr
    assert "Traceback" not in r.stderr


def test_missing_target_python_unit(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(SystemExit, match="target command not found"):
        run_mod._maybe_handoff_to_target_python(
            ["--", "/nope/bin/python", "app.py"], ["/nope/bin/python", "app.py"]
        )


@pytest.mark.skipif(os.name != "nt", reason="PATHEXT resolution is Windows-only")
def test_extensionless_windows_interpreter_is_resolvable(tmp_path: Path) -> None:
    """`<venv>/Scripts/python` must pass the preflight, as CreateProcess appends .exe.

    A Windows venv ships only ``python.exe``, so a plain ``Path.exists()`` check
    rejected the very form bring-up records — a false negative that failed a
    command the OS would have launched fine. The recorded start command lives
    outside the repo where no fix episode can edit it, so the launcher has to
    tolerate it.
    """
    scripts = tmp_path / "Scripts"
    scripts.mkdir()
    (scripts / "python.exe").write_bytes(b"MZ")  # only the .exe, as uv/venv creates
    extensionless = str(scripts / "python")

    assert run_mod._resolvable_executable(extensionless) is True
    assert run_mod._resolve_executable_path(extensionless) == scripts / "python.exe"
    # Forward-slash form too: that is what Git Bash hands a native exe.
    assert run_mod._resolvable_executable(extensionless.replace("\\", "/")) is True
    # A genuinely absent interpreter must still be reported, not silently passed.
    assert run_mod._resolvable_executable(str(scripts / "nosuchpy")) is False
