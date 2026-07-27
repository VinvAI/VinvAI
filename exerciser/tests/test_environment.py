"""Environment oracles: signature drift and the dependency-resolution matrix.

P2 of the 2026-07-27 exploration audit. Runtime evidence cannot see these:
an upstream package changes a signature, or the solver picks a version the code
was never run against, and it breaks in someone else's environment. Both are
structurally undetectable no matter how much trace data accumulates.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from exerciser import store
from exerciser.environment import (
    check_signature_drift,
    cluster_environment_findings,
    diff_signature,
    resolve_matrix,
    run_environment,
    signature_of,
)


def _sig(params: list[tuple[str, bool]], *, kind: str = "POSITIONAL_OR_KEYWORD") -> dict:
    return {
        "ok": True,
        "text": "(...)",
        "version": "1.0",
        "params": [{"name": n, "kind": kind, "required": r} for n, r in params],
    }


# ---- the drift differ ------------------------------------------------------


def test_removed_parameter_is_breaking():
    before = _sig([("a", True), ("b", False)])
    after = _sig([("a", True)])
    assert diff_signature(before, after) == ["parameter 'b' was removed"]


def test_parameter_becoming_required_is_breaking():
    drift = diff_signature(_sig([("a", False)]), _sig([("a", True)]))
    assert drift == ["parameter 'a' became required"]


def test_new_required_parameter_is_breaking():
    drift = diff_signature(_sig([("a", True)]), _sig([("a", True), ("b", True)]))
    assert "new REQUIRED parameter 'b' was added" in drift


def test_added_optional_parameter_stays_silent():
    # Backward-compatible. An oracle that fires on every upstream release
    # gets switched off, so this direction must not report.
    assert diff_signature(_sig([("a", True)]), _sig([("a", True), ("b", False)])) == []


def test_reordering_is_breaking():
    drift = diff_signature(_sig([("a", True), ("b", True)]), _sig([("b", True), ("a", True)]))
    assert any("positional order changed" in d for d in drift)


def test_vanished_symbol_is_reported():
    drift = diff_signature(_sig([("a", True)]), {"ok": False, "reason": "gone"})
    assert drift == ["symbol became unusable: gone"]


def test_no_baseline_reports_nothing():
    assert diff_signature({"ok": False, "reason": "x"}, _sig([("a", True)])) == []


# ---- reading real signatures -----------------------------------------------


def test_signature_of_reads_a_real_stdlib_symbol():
    sig = signature_of("json:dumps")
    assert sig["ok"] is True
    names = [p["name"] for p in sig["params"]]
    assert "obj" in names


def test_missing_symbol_and_module_are_data_not_errors():
    assert signature_of("json:no_such_function")["ok"] is False
    assert "no longer exists" in signature_of("json:no_such_function")["reason"]
    assert signature_of("no_such_module_xyz:f")["ok"] is False


# ---- the drift check lifecycle ---------------------------------------------


def test_first_run_records_and_reports_nothing(tmp_path: Path):
    store.exercise_dir(tmp_path).mkdir(parents=True)

    result = check_signature_drift(tmp_path, ["json:dumps"])

    assert result["recorded"] == 1
    assert result["drifted"] == 0, "there is nothing to drift from yet"
    doc = store.read_json(store.exercise_dir(tmp_path) / "signatures.json")
    assert "json:dumps" in doc["signatures"]


def test_drift_against_a_tampered_baseline_is_caught(tmp_path: Path):
    store.exercise_dir(tmp_path).mkdir(parents=True)
    check_signature_drift(tmp_path, ["json:dumps"])
    # Simulate the upstream release: the baseline had a parameter that the
    # installed version no longer has.
    path = store.exercise_dir(tmp_path) / "signatures.json"
    doc = store.read_json(path)
    doc["signatures"]["json:dumps"]["params"].append(
        {"name": "removed_in_new_version", "kind": "KEYWORD_ONLY", "required": False}
    )
    store.write_json(path, doc)

    result = check_signature_drift(tmp_path, ["json:dumps"])

    assert result["drifted"] == 1
    (finding,) = result["findings"]
    assert "parameter 'removed_in_new_version' was removed" in finding["drift"]


def test_baselines_of_unchecked_targets_survive(tmp_path: Path):
    store.exercise_dir(tmp_path).mkdir(parents=True)
    check_signature_drift(tmp_path, ["json:dumps", "json:loads"])
    check_signature_drift(tmp_path, ["json:dumps"])  # narrower run
    doc = store.read_json(store.exercise_dir(tmp_path) / "signatures.json")
    assert "json:loads" in doc["signatures"], "a narrower run must not drop baselines"


# ---- the resolution matrix -------------------------------------------------


def test_matrix_skips_cleanly_without_a_pyproject(tmp_path: Path):
    out = resolve_matrix(tmp_path)
    assert out["status"] == "skipped"
    assert "pyproject" in out["reason"]


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv not on PATH")
def test_matrix_resolves_both_modes_for_a_real_project(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text(
        "[project]\n"
        'name = "matrix-probe"\n'
        'version = "0.1.0"\n'
        'requires-python = ">=3.11"\n'
        'dependencies = ["packaging>=23"]\n',
        encoding="utf-8",
    )

    out = resolve_matrix(tmp_path, timeout_s=240.0)

    assert out["status"] == "ok"
    assert set(out["modes"]) == {"lowest-direct", "highest"}
    assert all(m["ok"] for m in out["modes"].values()), out["modes"]
    # A >=23 floor against the newest release must differ across modes; that
    # difference IS the untested surface the matrix exists to expose.
    versions = {m: d["packages"].get("packaging") for m, d in out["modes"].items()}
    assert versions["lowest-direct"] != versions["highest"], versions
    assert any(d["package"] == "packaging" for d in out["disagreements"])
    # The repo's own lock file was never created — resolution runs on a copy.
    assert not (tmp_path / "uv.lock").exists()


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv not on PATH")
def test_unresolvable_floor_is_a_loud_finding(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text(
        "[project]\n"
        'name = "broken-floor"\n'
        'version = "0.1.0"\n'
        'requires-python = ">=3.11"\n'
        'dependencies = ["packaging>=99999"]\n',
        encoding="utf-8",
    )

    out = resolve_matrix(tmp_path, timeout_s=240.0)
    assert not all(m["ok"] for m in out["modes"].values())
    clusters = cluster_environment_findings({"findings": []}, out)
    assert any(c.kind == "resolution-failure" for c in clusters)


# ---- the runner ------------------------------------------------------------


def test_empty_watch_list_is_loudly_diagnosed(tmp_path: Path):
    result = run_environment(tmp_path, targets=[], skip_matrix=True)
    assert result["issue_clusters"] == 0
    assert any("0 upstream symbols" in d for d in result["diagnostics"])


def test_runner_persists_and_self_sustains(tmp_path: Path):
    first = run_environment(tmp_path, targets=["json:dumps"], skip_matrix=True)
    assert first["signature_drift"]["recorded"] == 1
    assert store.read_json(store.exercise_dir(tmp_path) / "environment.json")["status"] == "ok"
    # A later run with no explicit targets reuses the recorded watch list.
    second = run_environment(tmp_path, skip_matrix=True)
    assert second["signature_drift"]["checked"] == 1
    assert second["diagnostics"] == []
