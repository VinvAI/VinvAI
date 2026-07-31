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

from identification.runner import build_api_call_tree, map_trace_to_tree


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


def _write_trace(root: Path, spans: list[tuple[str, int]]) -> Path:
    """A capture where each ``(component, depth)`` ran once, outermost first."""
    trace = root / ".vinv" / "captures" / "vinv-exerciser" / "repo" / "functions"
    trace.mkdir(parents=True, exist_ok=True)
    path = trace / "trace.jsonl"
    enters = [
        json.dumps({"event": "enter", "component": c, "depth": d,
                    "request_id": "r1", "thread_id": 1})
        for c, d in spans
    ]
    # tracelens writes exits in completion order — innermost first.
    exits = [
        json.dumps({"event": "exit", "component": c, "depth": d, "duration_ms": 1.0,
                    "status": "ok", "request_id": "r1", "thread_id": 1})
        for c, d in reversed(spans)
    ]
    path.write_text("\n".join(enters + exits) + "\n", encoding="utf-8")
    return path


def test_a_symbol_unit_gets_a_runtime_overlay_too(tmp_path: Path) -> None:
    # The gap this closes: a function unit could get a static tree (`--symbol`)
    # but not an overlay — tracemap took only `--api-id`, so every function and
    # CLI unit rendered as "nothing ran" however much of it had.
    root = _library_repo(tmp_path)
    _write_trace(root, [("acme.mod.summarize", 0), ("acme.mod.helper", 1)])

    result = map_trace_to_tree(root, symbol="acme.mod:summarize", max_depth=5)

    assert result["status"] == "ok"
    assert result["handler_observed"] is True
    assert result["tree"]["runtime"]["executed"] is True
    helper = next(c for c in result["tree"]["children"] if c.get("name") == "helper")
    assert helper["runtime"]["executed"] is True
    assert result["coverage"]["executed"] == 2


def test_the_overlay_reports_the_units_own_latency_distribution(tmp_path: Path) -> None:
    # The per-symbol facts are sums (calls + total_ms), which give a mean and
    # hide the tail. Percentiles are computed once, here, at the only level
    # where "one invocation of this unit" is defined — and they exist for a
    # driven function exactly as they do for a route.
    root = _library_repo(tmp_path)
    trace = root / ".vinv" / "captures" / "vinv-exerciser" / "repo" / "functions"
    trace.mkdir(parents=True, exist_ok=True)
    lines = []
    for i, ms in enumerate([5.0, 10.0, 100.0]):
        rid = f"r{i}"
        lines.append(json.dumps({
            "event": "enter", "component": "acme.mod.summarize", "depth": 0,
            "request_id": rid, "thread_id": 1,
        }))
        lines.append(json.dumps({
            "event": "exit", "component": "acme.mod.summarize", "depth": 0,
            "duration_ms": ms, "status": "error" if ms == 100.0 else "ok",
            "error_type": "ValueError" if ms == 100.0 else None,
            "request_id": rid, "thread_id": 1,
        }))
    (trace / "trace.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")

    lat = map_trace_to_tree(root, symbol="acme.mod:summarize")["latency"]

    assert lat["calls"] == 3
    assert lat["p50_ms"] == 10.0
    assert lat["p95_ms"] == 100.0, "the tail is the number a latency column is read for"
    assert lat["max_ms"] == 100.0
    assert (lat["ok"], lat["error"]) == (2, 1)
    assert lat["error_types"] == ["ValueError"]


def test_a_unit_that_never_ran_reports_no_latency_rather_than_zeros(tmp_path: Path) -> None:
    root = _library_repo(tmp_path)
    _write_trace(root, [("acme.other.thing", 0)])

    result = map_trace_to_tree(root, symbol="acme.mod:summarize")

    assert result["handler_observed"] is False
    assert result["latency"]["calls"] == 0


def test_the_symbol_overlay_artifact_survives_a_colon_in_the_id(tmp_path: Path) -> None:
    # `module:qualname` is not a legal filename on Windows: unsanitized, the
    # write raised and the artifact the caller was promised never appeared.
    root = _library_repo(tmp_path)
    _write_trace(root, [("acme.mod.summarize", 0)])

    result = map_trace_to_tree(root, symbol="acme.mod:summarize")

    assert Path(result["output_file"]).is_file()
