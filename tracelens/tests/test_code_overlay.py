"""T1.5 — code-overlay loader."""

from __future__ import annotations

import json
from pathlib import Path

from tracelens.analysis.code_overlay import load_overlay, lookup


def test_load_json_dict_form(tmp_path: Path) -> None:
    p = tmp_path / "symbols.json"
    p.write_text(
        json.dumps(
            {
                "demo.x": {
                    "file": "demo/x.py",
                    "line": 10,
                    "signature": "def x(): ...",
                    "summary": "demo function",
                },
            }
        ),
        encoding="utf-8",
    )
    overlay = load_overlay(p)
    assert "demo.x" in overlay
    assert overlay["demo.x"]["file"] == "demo/x.py"
    assert overlay["demo.x"]["summary"] == "demo function"


def test_load_jsonl(tmp_path: Path) -> None:
    p = tmp_path / "symbols.jsonl"
    p.write_text(
        json.dumps(
            {
                "qualname": "demo.y",
                "file": "demo/y.py",
                "line": 5,
                "signature": "def y(): ...",
                "summary": "another",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    overlay = load_overlay(p)
    assert overlay["demo.y"]["line"] == 5


def test_lookup_falls_back_to_parent(tmp_path: Path) -> None:
    p = tmp_path / "symbols.json"
    p.write_text(json.dumps({"demo.Foo": {"file": "demo/foo.py", "line": 1}}), encoding="utf-8")
    overlay = load_overlay(p)
    # Direct hit
    assert lookup(overlay, "demo.Foo")["file"] == "demo/foo.py"
    # Method falls back to class
    assert lookup(overlay, "demo.Foo.bar")["file"] == "demo/foo.py"
    # Unknown
    assert lookup(overlay, "demo.Bar") is None


def test_missing_file_returns_empty(tmp_path: Path) -> None:
    overlay = load_overlay(tmp_path / "nope.json")
    assert overlay == {}
