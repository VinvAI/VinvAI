"""Rooting a call tree at a symbol no declaration names.

`consolidate` finds entry points the repo DECLARES — a route decorator, a Click
command, a celery task. A function the exerciser drove directly is declared
nowhere: it was picked from the index because it is exported and callable, which
is precisely why driving it needed a harness. It still has a call tree, and
without one every function-level unit carried no static denominator and so
reported 0/0 coverage however much of it actually ran.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from identification.runner import build_api_call_tree


def _chunk(
    symbol_id: str,
    file: str,
    name: str,
    start: int,
    *,
    calls: list[str] | None = None,
) -> dict:
    return {
        "id": symbol_id, "file": file, "lang": "python", "kind": "function",
        "name": name, "start_line": start, "end_line": start + 4, "sha": "fixture",
        "summary": "", "text": "", "parent": None, "calls": list(calls or ()),
        "bases": [], "rank": 0.0,
    }


def _write_index(root: Path, chunks: list[dict]) -> None:
    store = root / ".vinv" / "index"
    store.mkdir(parents=True)
    (store / "meta.json").write_text(
        json.dumps({
            "version": 5, "repo_path": str(root), "embedding_model": "fixture",
            "summary_model": "fixture", "dim": 0, "count": len(chunks), "updated_unix": 0,
        }),
        encoding="utf-8",
    )
    (store / "chunks.jsonl").write_text(
        "".join(json.dumps(c) + "\n" for c in chunks), encoding="utf-8"
    )
    (store / "edges.jsonl").write_text("", encoding="utf-8")


def _library_repo(tmp_path: Path) -> Path:
    """A library with no declared entry point of any kind."""
    root = tmp_path / "repo"
    (root / "acme").mkdir(parents=True)
    (root / "acme" / "mod.py").write_text(
        "def summarize(n):\n    return helper(n)\n\n\ndef helper(n):\n    return n * 2\n",
        encoding="utf-8",
    )
    _write_index(
        root,
        [
            _chunk("s1", "acme/mod.py", "summarize", 1, calls=["helper"]),
            _chunk("s2", "acme/mod.py", "helper", 5),
        ],
    )
    return root


def test_a_symbol_gets_a_call_tree_without_being_declared(tmp_path: Path) -> None:
    root = _library_repo(tmp_path)

    result = build_api_call_tree(root, symbol="acme.mod:summarize", max_depth=5)

    assert result["status"] == "ok"
    assert result["entrypoint"]["handler"] == "summarize"
    assert result["entrypoint"]["kind"] == "function"
    assert result["tree"]["name"].endswith("summarize")
    # The callee is what makes this a TREE rather than a single node — and the
    # denominator coverage is measured against.
    assert any(c.get("name", "").endswith("helper") for c in result["tree"]["children"])


def test_the_exerciser_target_id_spelling_resolves(tmp_path: Path) -> None:
    # `module:qualname` is exactly what function_results.jsonl records.
    root = _library_repo(tmp_path)
    assert build_api_call_tree(root, symbol="acme.mod:summarize")["status"] == "ok"
    # A bare name works too — the file half is a hint, never a requirement.
    assert build_api_call_tree(root, symbol="summarize")["status"] == "ok"


def test_the_file_hint_disambiguates_a_shared_name(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    (root / "acme").mkdir(parents=True)
    (root / "acme" / "a.py").write_text("def run():\n    pass\n", encoding="utf-8")
    (root / "acme" / "b.py").write_text("def run():\n    pass\n", encoding="utf-8")
    _write_index(
        root,
        [_chunk("s1", "acme/a.py", "run", 1), _chunk("s2", "acme/b.py", "run", 1)],
    )

    chosen = build_api_call_tree(root, symbol="acme.b:run")

    assert chosen["entrypoint"]["file"] == "acme/b.py"


def test_an_unknown_symbol_says_what_to_do(tmp_path: Path) -> None:
    root = _library_repo(tmp_path)

    with pytest.raises(LookupError) as exc:
        build_api_call_tree(root, symbol="acme.mod:nonexistent")

    assert "nonexistent" in str(exc.value)
    assert "index index" in str(exc.value)


def test_neither_identifier_is_a_usage_error(tmp_path: Path) -> None:
    root = _library_repo(tmp_path)

    with pytest.raises(ValueError):
        build_api_call_tree(root)
