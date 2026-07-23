"""External invariant loader and eval sandbox."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tracelens.enrich.external_invariants import (
    check_invariants,
    load_invariant_exprs,
    reset_invariants_cache,
)


@pytest.fixture(autouse=True)
def _clear_inv_cache() -> None:
    reset_invariants_cache()
    yield
    reset_invariants_cache()


def test_len_allowed_in_expression(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "inv.json"
    p.write_text(json.dumps({"demo_app.main.wrong": "len(result) >= 0"}), encoding="utf-8")
    monkeypatch.setenv("TRACELENS_INVARIANTS", str(p))
    v = check_invariants("demo_app.main.wrong", {"n": 3}, {"a": 1})
    assert v == []


def test_wrong_invariant_detects_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    inv = Path(__file__).resolve().parent / "integration" / "demo_invariants.json"
    monkeypatch.setenv("TRACELENS_INVARIANTS", str(inv))
    reset_invariants_cache()
    v = check_invariants(
        "demo_app.main.wrong",
        {"n": 3},
        {"expected": 6, "got": 4},
    )
    assert v == ["demo_app.main.wrong:postcondition_failed"]


def test_yaml_loads(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "inv.yaml"
    expr = 'result.get("got") == result.get("expected")'
    p.write_text(f"demo_app.main.wrong: '{expr}'\n", encoding="utf-8")
    monkeypatch.setenv("TRACELENS_INVARIANTS", str(p))
    reset_invariants_cache()
    m = load_invariant_exprs()
    assert "demo_app.main.wrong" in m


@pytest.mark.parametrize(
    "expr",
    [
        "__import__('os').system('echo compromised')",
        "result.__class__.__mro__[1].__subclasses__()",
        "(lambda: 1)()",
        "[x for x in result]",
    ],
)
def test_executable_python_syntax_is_rejected(
    expr: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = tmp_path / "malicious.json"
    p.write_text(json.dumps({"demo.target": expr}), encoding="utf-8")
    monkeypatch.setenv("TRACELENS_INVARIANTS", str(p))

    violations = check_invariants("demo.target", {}, {})

    assert violations == ["demo.target:invariant_eval_error:ValueError"]


def test_get_is_limited_to_mappings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class CallableGet:
        def get(self, key: object) -> bool:
            raise AssertionError("untrusted get method executed")

    p = tmp_path / "custom-get.json"
    p.write_text(json.dumps({"demo.target": "result.get('key')"}), encoding="utf-8")
    monkeypatch.setenv("TRACELENS_INVARIANTS", str(p))

    violations = check_invariants("demo.target", {}, CallableGet())

    assert violations == ["demo.target:invariant_eval_error:TypeError"]
