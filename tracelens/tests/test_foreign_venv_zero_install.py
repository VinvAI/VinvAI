"""Foreign-venv zero-install capture (launcher handoff).

Tracing a service that lives in ITS OWN venv must require ZERO installs into that
venv — not tracelens, not opentelemetry, not PyYAML. The launcher achieves this by
handing off into the target interpreter and, alongside the tracelens *source root*
on ``PYTHONPATH``, telling the child where tracelens's own capture dependencies
live (``TRACELENS_CAPTURE_DEP_ROOTS``); the child appends those dirs to
``sys.path`` as a last-resort fallback (``_install_capture_dep_fallback``).

These tests exercise both the unit seam (the roots-computation + the fallback
installer) and, end to end, a subprocess that stands in for a *clean* target venv:
``python -S`` hides site-packages so opentelemetry/PyYAML are unimportable through
the normal path, exactly like a target venv that never installed them. Without the
fallback the run must fail with the friendly missing-OTel line (the historical
behaviour, still covered in ``test_run_bootstrap_resilience``); WITH the fallback
roots injected the same clean interpreter captures a non-empty trace of the app's
own components.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from tracelens.launcher import run as run_mod

_ENTRY = "import sys; from tracelens.launcher.run import run_main; run_main(sys.argv[1:])"


def _src_root() -> str:
    return str(Path(run_mod.__file__).resolve().parents[2])


def _write_app(tmp_path: Path) -> Path:
    """A component module (imported → AST-rewritten) plus a bounded entry that
    imports and drives it, then exits cleanly (no signal needed)."""
    (tmp_path / "svc.py").write_text(
        "def compute(n):\n"
        "    return sum(i * i for i in range(n))\n\n\n"
        "def summarize(counter):\n"
        "    return {'counter': counter, 'sq': compute(counter % 7 + 1)}\n\n\n"
        "def tick(counter):\n"
        "    return summarize(counter)\n",
        encoding="utf-8",
    )
    main = tmp_path / "main.py"
    main.write_text(
        "import svc\n\n" "for c in range(5):\n" "    svc.tick(c)\n",
        encoding="utf-8",
    )
    return main


# --------------------------------------------------------------------------- unit


def test_capture_dependency_roots_covers_otel_and_yaml() -> None:
    """The computed roots must contain the dirs where the dev env resolves the
    capture path's hard deps (opentelemetry + PyYAML), so a foreign child can find
    them."""
    roots = {os.path.realpath(r) for r in run_mod._capture_dependency_roots()}
    assert roots, "expected at least one capture-dependency root in a healthy env"
    import importlib.util

    for mod in ("opentelemetry", "yaml"):
        spec = importlib.util.find_spec(mod)
        assert spec is not None
        locs = list(spec.submodule_search_locations or [])
        parent = os.path.realpath(str(Path(locs[0]).parent))
        assert parent in roots, f"{mod} dir {parent} not among capture roots {roots}"


def test_install_capture_dep_fallback_appends_and_is_idempotent(
    tmp_path: Path, monkeypatch: object
) -> None:
    """The fallback APPENDS the roots (target-wins precedence) and never double-adds."""
    import importlib

    dep = tmp_path / "dep_root"
    dep.mkdir()
    (dep / "zz_fake_capture_dep.py").write_text("VALUE = 42\n", encoding="utf-8")
    monkeypatch.setenv(run_mod._CAPTURE_DEP_ROOTS_ENV, str(dep))  # type: ignore[attr-defined]

    before = list(sys.path)
    try:
        added = run_mod._install_capture_dep_fallback()
        assert added == [str(dep)]
        # Appended to the END so the target's own copies (earlier on sys.path) win.
        assert sys.path[-1] == str(dep)
        assert str(dep) not in before
        importlib.invalidate_caches()
        mod = importlib.import_module("zz_fake_capture_dep")
        assert mod.VALUE == 42
        # Idempotent: a second call adds nothing.
        assert run_mod._install_capture_dep_fallback() == []
        assert sys.path.count(str(dep)) == 1
    finally:
        sys.modules.pop("zz_fake_capture_dep", None)
        while str(dep) in sys.path:
            sys.path.remove(str(dep))


def test_install_capture_dep_fallback_noop_without_env(monkeypatch: object) -> None:
    monkeypatch.delenv(run_mod._CAPTURE_DEP_ROOTS_ENV, raising=False)  # type: ignore[attr-defined]
    before = list(sys.path)
    assert run_mod._install_capture_dep_fallback() == []
    assert sys.path == before


# --------------------------------------------------------------------- end to end


def _run_clean_target(
    tmp_path: Path, *, inject_dep_roots: bool
) -> subprocess.CompletedProcess[str]:
    """Run a trace where the interpreter hosting instrumentation has site-packages
    hidden (``-S``) — a stand-in for a target venv with no otel/yaml installed."""
    main = _write_app(tmp_path)
    out = tmp_path / "trace.jsonl"
    dep_env = run_mod._CAPTURE_DEP_ROOTS_ENV  # type: ignore[attr-defined]
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", dep_env)}
    env["PYTHONPATH"] = _src_root()
    env["TRACELENS_NO_SELFCHECK"] = "1"
    if inject_dep_roots:
        env[dep_env] = os.pathsep.join(run_mod._capture_dependency_roots())
    return subprocess.run(
        [
            sys.executable,
            "-S",
            "-c",
            _ENTRY,
            "--minimal",
            "--no-otel-autoinst",
            "-t",
            "svc",
            "-o",
            str(out),
            "--",
            sys.executable,
            str(main),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )


def test_clean_target_without_fallback_fails_friendly(tmp_path: Path) -> None:
    """Sanity anchor: with site hidden and NO injected roots, the run fails with the
    actionable missing-OTel line (never a raw traceback)."""
    r = _run_clean_target(tmp_path, inject_dep_roots=False)
    assert r.returncode != 0
    assert "opentelemetry" in r.stderr
    assert "Traceback" not in r.stderr


def test_clean_target_with_injected_roots_captures_nonempty_trace(tmp_path: Path) -> None:
    """The whole point: the SAME clean interpreter, given tracelens's capture-dep
    roots, records a non-empty parseable trace of the app's own components without
    those deps ever being installed into it."""
    r = _run_clean_target(tmp_path, inject_dep_roots=True)
    assert r.returncode == 0, f"run failed: {r.stderr}"
    out = tmp_path / "trace.jsonl"
    assert out.is_file() and out.stat().st_size > 0, "expected a non-empty trace"
    components: set[str] = set()
    n = 0
    for line in out.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)  # parseable JSONL or this raises
        if "component" not in event:
            continue  # non-span header lines (tracer_calibration)
        components.add(event["component"])
        n += 1
    assert n > 0
    # The app's own instrumented functions appear as components.
    assert {"svc.compute", "svc.summarize", "svc.tick"} <= components
