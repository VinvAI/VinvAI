"""The function-level input channel, driven for real (subprocess workers).

G1: every input used to travel as an HTTP request, so a LIBRARY — no routes —
was unexercisable, and bugs in pure helpers sat behind a corridor no request
opens. These tests build a throwaway target package, run the real driver
(isolated workers, real imports), and assert it CATCHES a planted crash while
staying quiet on correct code, refusing to guess, and surviving hostile targets.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from exerciser import store
from exerciser.functions import (
    arg_sets_for,
    classify_row,
    discover_targets,
    is_denied,
    module_name_for,
    run_functions,
    value_for,
)

_TARGET_PKG = {
    "__init__.py": "",
    "calc.py": """\
def add(a: int, b: int) -> int:
    return a + b


def halve(n: int) -> float:
    # Planted defect: the falsy-zero case divides by an empty denominator.
    counts = [] if n == 0 else [1, 2]
    return n / len(counts)


def greet(name: str, punct: str = "!") -> str:
    return f"hello {name}{punct}"


def _private(x: int) -> int:
    return x


def untyped(a, b):
    return a


def delete_everything(path: str) -> None:
    raise AssertionError("the harness must never call this")
""",
}


def _make_repo(tmp_path: Path, *, pkg: dict[str, str] | None = None) -> Path:
    import re

    src = tmp_path / "src" / "targetpkg"
    src.mkdir(parents=True)
    files = pkg or _TARGET_PKG
    for name, body in files.items():
        (src / name).write_text(body, encoding="utf-8")
    # A minimal code index derived from the actual sources: the harness reads
    # module-level function names here.
    index = tmp_path / ".vinv" / "index"
    index.mkdir(parents=True)
    chunks = []
    for name, body in files.items():
        for fn in re.findall(r"^(?:async )?def (\w+)", body, re.MULTILINE):
            chunks.append(
                {
                    "id": f"src/targetpkg/{name}:{fn}",
                    "file": f"src/targetpkg/{name}",
                    "lang": "python",
                    "kind": "function",
                    "name": fn,
                    "start_line": 1,
                    "end_line": 2,
                    "parent": None,
                }
            )
    (index / "chunks.jsonl").write_text(
        "".join(json.dumps(c) + "\n" for c in chunks), encoding="utf-8"
    )
    return tmp_path


# ---- unit: targeting rules -------------------------------------------------


def test_module_names_resolve_through_src_layout():
    roots = ["src", "."]
    assert module_name_for("src/pkg/mod.py", roots) == "pkg.mod"
    assert module_name_for("src/pkg/__init__.py", roots) == "pkg"
    assert module_name_for("tool.py", roots) == "tool"
    assert module_name_for("README.md", roots) is None
    assert module_name_for("src/pkg/conftest.py", roots) is None


def test_destructive_names_are_denied():
    assert is_denied("delete_user")
    assert is_denied("db.drop_all")
    assert is_denied("shutdown")
    assert not is_denied("add")
    assert not is_denied("compute_total")


def test_argument_sets_cover_the_input_classes():
    params = [
        {"name": "n", "annotation": "int", "has_default": False, "keyword_only": False},
        {"name": "tag", "annotation": "str", "has_default": True, "keyword_only": False},
    ]
    sets = {s["class"]: s["kwargs"] for s in arg_sets_for(params)}
    assert sets["valid"] == {"n": 3}, "defaults are left to their documented path"
    assert sets["boundary"] == {"n": 0, "tag": ""}
    assert sets["negative"]["n"] == -(2**63)
    assert value_for("Optional[str]", "valid") == "vinv", "subscripted hints resolve"
    assert value_for(None, "boundary") == ""


def test_discovery_skips_private_and_destructive(tmp_path: Path):
    repo = _make_repo(tmp_path)
    targets, skipped = discover_targets(repo)
    names = {t.qualname for t in targets}
    assert {"add", "halve", "greet", "untyped"} <= names
    assert "_private" not in names, "private by convention"
    assert "delete_everything" not in names
    assert any(s["reason"] == "destructive-name" for s in skipped)
    assert all(t.module == "targetpkg.calc" for t in targets)


# ---- classification --------------------------------------------------------


def test_typed_rejection_of_bad_input_is_not_a_failure():
    row = {
        "phase": "call",
        "status": "error",
        "input_class": "negative",
        "error_type": "TypeError",
    }
    assert classify_row(row) is None, "refusing bad input is correct behaviour"


def test_untyped_explosion_on_bad_input_is_a_failure():
    row = {
        "phase": "call",
        "status": "error",
        "input_class": "negative",
        "error_type": "RecursionError",
    }
    assert classify_row(row) == "function-crash"


def test_any_raise_on_valid_input_is_a_failure():
    row = {
        "phase": "call",
        "status": "error",
        "input_class": "valid",
        "error_type": "TypeError",
    }
    assert classify_row(row) == "function-crash"


def test_healthy_calls_classify_as_nothing():
    assert classify_row({"phase": "call", "status": "ok"}) is None


# ---- the real driver -------------------------------------------------------


def test_driver_calls_real_code_and_catches_the_planted_crash(tmp_path: Path):
    repo = _make_repo(tmp_path)

    result = run_functions(repo, module_timeout_s=60.0)

    assert result["status"] == "ok"
    assert result["calls"] > 0, "the harness must actually call target code"
    rows = store.read_jsonl(store.exercise_dir(repo) / "function_results.jsonl")
    # add() was really executed with real arguments.
    added = [r for r in rows if r.get("qualname") == "add" and r.get("status") == "ok"]
    assert added and any(r["result"] == 6 for r in added), "add(3, 3) == 6"
    # halve() has a planted ZeroDivisionError on the falsy-zero boundary — the
    # exact class HTTP probing cannot reach.
    kinds = {c["kind"] for c in result["clusters"]}
    assert "function-crash" in kinds
    crash = next(c for c in result["clusters"] if c["kind"] == "function-crash")
    assert "halve" in crash["title"]
    assert "ZeroDivisionError" in crash["title"]
    # And the destructive function was never invoked (it would have raised).
    assert not any(r.get("qualname") == "delete_everything" for r in rows)


def test_unannotated_parameters_are_skipped_not_guessed(tmp_path: Path):
    repo = _make_repo(tmp_path)
    run_functions(repo, module_timeout_s=60.0)
    rows = store.read_jsonl(store.exercise_dir(repo) / "function_results.jsonl")
    untyped = [r for r in rows if "untyped" in r.get("target_id", "")]
    assert untyped and all(r["status"] == "skipped" for r in untyped)
    assert "refusing to guess" in untyped[0]["error"]


def test_clean_library_produces_no_failures(tmp_path: Path):
    repo = _make_repo(
        tmp_path,
        pkg={
            "__init__.py": "",
            "calc.py": (
                "def add(a: int, b: int) -> int:\n    return a + b\n\n\n"
                "def label(x: str) -> str:\n    return x.strip().lower()\n"
            ),
        },
    )
    result = run_functions(repo, module_timeout_s=60.0)
    assert result["calls"] > 0
    assert result["issue_clusters"] == 0, "correct code must stay quiet"


def test_a_hanging_module_costs_one_module_not_the_run(tmp_path: Path):
    repo = _make_repo(
        tmp_path,
        pkg={
            "__init__.py": "",
            "calc.py": (
                "import time\n\n\n" "def spin(n: int) -> int:\n    time.sleep(600)\n    return n\n"
            ),
        },
    )
    result = run_functions(repo, module_timeout_s=3.0)
    assert result["status"] == "ok", "a hang must never take the run down"
    assert result["module_timeouts"] == ["targetpkg.calc"]


def test_a_module_that_exits_on_import_is_reported_not_fatal(tmp_path: Path):
    repo = _make_repo(
        tmp_path,
        pkg={
            "__init__.py": "",
            "calc.py": "import sys\n\nsys.exit(3)\n\n\ndef add(a: int) -> int:\n    return a\n",
        },
    )
    result = run_functions(repo, module_timeout_s=60.0)
    assert result["status"] == "ok"
    kinds = {c["kind"] for c in result["clusters"]}
    assert "import-error" in kinds


def test_empty_target_set_is_loudly_diagnosed(tmp_path: Path):
    (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
    result = run_functions(tmp_path, module_timeout_s=10.0)
    assert result["targets"] == 0
    assert result["diagnostics"] and "0 function targets" in result["diagnostics"][0]


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_worker_is_invocable_as_a_module(tmp_path: Path):
    import subprocess

    proc = subprocess.run(
        [sys.executable, "-m", "exerciser.functions"],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2
    assert "exerciser functions" in proc.stderr
