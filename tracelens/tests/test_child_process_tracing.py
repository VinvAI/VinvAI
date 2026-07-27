"""Child-process tracing: the sitecustomize bootstrap and the sidecar merge.

Gap G5 of the 2026-07-27 exploration audit: the hook was installed only in the
launcher's own interpreter, so subprocess executors — where sandboxed code
actually runs — produced no spans at all. Fork sidecars were written but never
merged, and every reader in the repo resolves a capture by globbing
``trace.jsonl`` exactly, so those were captures that never happened.

The end-to-end test runs the REAL CLI against a target that spawns a real
child, then asserts the child's functions appear in the single merged trace.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tracelens.launcher.child_bootstrap import (
    install_child_bootstrap,
    merge_sidecars,
    sidecar_paths,
)

# The driver script is run via runpy (never rewritten), so the instrumented
# code must live in an IMPORTED package — the established target-project shape.
# The child script likewise imports the package, so `child_only_function` can
# only reach the trace if the CHILD process installed the hook itself.
_PKG_MAIN = """\
def parent_function(n):
    return n * 2


def child_only_function(n):
    return n + 1
"""

_DRIVER = """\
import subprocess
import sys
from pathlib import Path

from demopkg.main import parent_function

parent_function(21)
subprocess.run([sys.executable, str(Path(__file__).with_name("child.py"))], check=True)
"""

_CHILD_SCRIPT = """\
from demopkg.main import child_only_function

child_only_function(41)
"""


def _write_target(tmp_path: Path) -> tuple[Path, Path]:
    """A package the driver imports, plus a driver that spawns a child."""
    proj = tmp_path / "proj"
    pkg = proj / "demopkg"
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "main.py").write_text(_PKG_MAIN, encoding="utf-8")
    (proj / "app.py").write_text(_DRIVER, encoding="utf-8")
    (proj / "child.py").write_text(_CHILD_SCRIPT, encoding="utf-8")
    return proj, proj / "app.py"


def _components(trace: Path) -> set[str]:
    out: set[str] = set()
    if not trace.is_file():
        return out
    for line in trace.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        comp = row.get("component") if isinstance(row, dict) else None
        if isinstance(comp, str):
            out.add(comp.rsplit(".", 1)[-1])
    return out


# ---- unit: the merge -------------------------------------------------------


def test_merge_folds_sidecars_in_timestamp_order(tmp_path: Path) -> None:
    main = tmp_path / "trace.jsonl"
    main.write_text(json.dumps({"ts": "2026-07-27T00:00:00.000Z", "component": "a"}) + "\n")
    (tmp_path / "trace.jsonl.child-99").write_text(
        json.dumps({"ts": "2026-07-27T00:00:03.000Z", "component": "c"})
        + "\n"
        + json.dumps({"ts": "2026-07-27T00:00:01.000Z", "component": "b"})
        + "\n"
    )
    (tmp_path / "trace.jsonl.fork-77").write_text(
        json.dumps({"ts": "2026-07-27T00:00:02.000Z", "component": "f"}) + "\n"
    )

    merged = merge_sidecars(str(main))

    assert merged == {"files": 2, "lines": 3}
    rows = [json.loads(ln) for ln in main.read_text().splitlines() if ln.strip()]
    assert [r["component"] for r in rows] == ["a", "b", "f", "c"], "appended in ts order"
    assert sidecar_paths(str(main)) == [], "merged sidecars are removed"


def test_merge_is_a_noop_without_sidecars(tmp_path: Path) -> None:
    main = tmp_path / "trace.jsonl"
    main.write_text('{"ts":"x"}\n')
    assert merge_sidecars(str(main)) == {"files": 0, "lines": 0}
    assert main.read_text() == '{"ts":"x"}\n'


def test_merge_survives_a_corrupt_sidecar(tmp_path: Path) -> None:
    main = tmp_path / "trace.jsonl"
    main.write_text("")
    (tmp_path / "trace.jsonl.child-1").write_text("not json\n" + '{"ts":"2026"}\n')
    merged = merge_sidecars(str(main))
    assert merged["files"] == 1
    # The unparseable line is kept (sorted first, ts "") rather than dropped —
    # capture evidence is never silently discarded.
    assert "not json" in main.read_text()


def test_bootstrap_can_be_disabled(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("TRACELENS_NO_CHILD_TRACING", "1")
    assert install_child_bootstrap(str(tmp_path / "trace.jsonl")) is None


def test_bootstrap_prepends_and_preserves_existing_pythonpath(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("TRACELENS_NO_CHILD_TRACING", raising=False)
    monkeypatch.setenv("PYTHONPATH", "/pre/existing")
    boot = install_child_bootstrap(str(tmp_path / "trace.jsonl"))
    assert boot is not None
    assert Path(boot, "sitecustomize.py").is_file()
    parts = os.environ["PYTHONPATH"].split(os.pathsep)
    assert parts[0] == boot, "ours must win"
    assert "/pre/existing" in parts, "the host's own path is preserved"


# ---- end to end: a real child process --------------------------------------


@pytest.mark.skipif(os.name == "nt", reason="POSIX process semantics")
def test_child_process_functions_land_in_the_merged_trace(tmp_path: Path) -> None:
    proj, driver = _write_target(tmp_path)
    out = tmp_path / "trace.jsonl"
    env = dict(os.environ)
    env["PYTHONPATH"] = str(proj)
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "tracelens.cli",
            "run",
            "--target-package",
            "demopkg",
            "--output",
            str(out),
            "--sample-rate",
            "1.0",
            "--",
            sys.executable,
            str(driver),
        ],
        capture_output=True,
        text=True,
        timeout=180,
        cwd=str(proj),
        env=env,
    )
    assert out.is_file(), f"no trace written.\nstdout={proc.stdout}\nstderr={proc.stderr}"
    names = _components(out)
    assert "parent_function" in names, f"parent must be traced; got {sorted(names)}"
    assert "child_only_function" in names, (
        "the CHILD process's functions must appear in the merged trace — " f"got {sorted(names)}"
    )
    assert sidecar_paths(str(out)) == [], "sidecars are merged away, not left behind"


def test_the_parent_output_handed_to_children_is_absolute(tmp_path: Path, monkeypatch) -> None:
    """COR-20: a child resolves this against ITS OWN cwd.

    With a relative `TRACELENS_OUTPUT` and a child that chdir's — routine in
    CLIs and servers — the sidecar was written somewhere the parent never
    looked. `sidecar_paths` globs only the parent-relative directory, so the
    file was never found, merged or deleted, and `merge_sidecars` returned
    `{"files": 0}`: indistinguishable from "no children ran". Every
    default-configured test passed because `_default_output` is already
    absolute.
    """
    # `install_child_bootstrap` mutates os.environ DIRECTLY, and monkeypatch only
    # restores what it set itself — so both vars must be registered here or the
    # bootstrap's sitecustomize leaks onto PYTHONPATH for every later test in
    # this process and silently traces their subprocesses.
    monkeypatch.delenv("TRACELENS_NO_CHILD_TRACING", raising=False)
    monkeypatch.setenv("PYTHONPATH", os.environ.get("PYTHONPATH", ""))
    monkeypatch.setenv("TRACELENS_PARENT_OUTPUT", "")
    monkeypatch.chdir(tmp_path)
    boot = install_child_bootstrap("trace.jsonl")  # deliberately relative
    assert boot is not None
    handed = os.environ["TRACELENS_PARENT_OUTPUT"]
    assert os.path.isabs(handed), f"children would resolve {handed!r} against their own cwd"
    assert Path(handed).parent == tmp_path


def test_an_absolute_parent_output_is_passed_through_unchanged(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("TRACELENS_NO_CHILD_TRACING", raising=False)
    monkeypatch.setenv("PYTHONPATH", os.environ.get("PYTHONPATH", ""))
    monkeypatch.setenv("TRACELENS_PARENT_OUTPUT", "")
    target = tmp_path / "trace.jsonl"
    assert install_child_bootstrap(str(target)) is not None
    assert Path(os.environ["TRACELENS_PARENT_OUTPUT"]) == target
