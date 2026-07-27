from __future__ import annotations

import json
from pathlib import Path

import pytest

from identification.runner import build_api_call_tree, list_service_apis
from identification.store import open_identification_store


def _chunk(
    symbol_id: str,
    file: str,
    name: str,
    start: int,
    end: int,
    *,
    kind: str = "function",
    lang: str = "python",
    calls: list[str] | None = None,
) -> dict:
    return {
        "id": symbol_id,
        "file": file,
        "lang": lang,
        "kind": kind,
        "name": name,
        "start_line": start,
        "end_line": end,
        "sha": "fixture",
        "summary": "",
        "text": "",
        "parent": None,
        "calls": list(calls or ()),
        "bases": [],
        "rank": 0.0,
    }


def _write_index(root: Path, chunks: list[dict], edges: list[dict]) -> Path:
    store = root / ".vinv" / "index"
    store.mkdir(parents=True)
    (store / "meta.json").write_text(
        json.dumps(
            {
                "version": 5,
                "repo_path": str(root),
                "embedding_model": "fixture",
                "summary_model": "fixture",
                "dim": 0,
                "count": len(chunks),
                "updated_unix": 0,
            }
        ),
        encoding="utf-8",
    )
    (store / "chunks.jsonl").write_text(
        "".join(json.dumps(chunk) + "\n" for chunk in chunks),
        encoding="utf-8",
    )
    (store / "edges.jsonl").write_text(
        "".join(json.dumps(edge) + "\n" for edge in edges),
        encoding="utf-8",
    )
    return store


def test_route_discovery_reads_local_rust_index(tmp_path: Path) -> None:
    source = '@app.get("/health")\ndef health():\n    return {"ok": True}\n'
    (tmp_path / "api.py").write_text(source, encoding="utf-8")
    rust = _write_index(
        tmp_path,
        [_chunk("api.py:2-3:health", "api.py", "health", 2, 3)],
        [],
    )

    result = list_service_apis(tmp_path)

    assert result["store_kind"] == "rust"
    assert result["index_store"] == str(rust.resolve())
    assert result["apis"] == [
        {
            "id": "GET_health",
            "method": "GET",
            "path": "/health",
            "handler": "health",
            "file": "api.py",
            "line": 1,
            "framework": "fastapi/flask",
            "is_test": False,
        }
    ]


def test_call_tree_walks_recorded_calls_and_reports_ambiguity(tmp_path: Path) -> None:
    # The tree walks each chunk's recorded `calls`, not `edges.jsonl`: the
    # indexer withholds any call it cannot resolve, so edges cannot describe a
    # call it declined to decide.
    (tmp_path / "api.py").write_text(
        '@app.post("/run")\ndef run():\n    common()\n\ndef common():\n    leaf()\n',
        encoding="utf-8",
    )
    (tmp_path / "other.py").write_text("def common():\n    pass\n", encoding="utf-8")
    chunks = [
        _chunk("api.py:2-3:run", "api.py", "run", 2, 3, calls=["common"]),
        _chunk("api.py:5-6:common", "api.py", "common", 5, 6, calls=["leaf"]),
        _chunk("other.py:1-2:common", "other.py", "common", 1, 2),
        _chunk("api.py:8-9:leaf", "api.py", "leaf", 8, 9),
    ]
    _write_index(tmp_path, chunks, [])

    result = build_api_call_tree(tmp_path, api_id="POST_run")

    common = result["tree"]["children"][0]
    assert common["name"] == "common"
    assert common["file"] == "api.py"
    assert common["ambiguous"] == 2
    assert common["children"][0]["name"] == "leaf"
    assert result["stats"]["internal_functions"] == 3


def test_delegation_to_a_same_named_function_is_not_mistaken_for_recursion(
    tmp_path: Path,
) -> None:
    # The FastAPI shape: the route handler and the controller function it
    # delegates to share a name, and only the receiver tells them apart.
    (tmp_path / "routes.py").write_text(
        '@app.get("/b/{i}")\ndef get_binary(i):\n' "    return binary_controller.get_binary(i)\n",
        encoding="utf-8",
    )
    (tmp_path / "binary_controller.py").write_text(
        "def get_binary(i):\n    return load(i)\n", encoding="utf-8"
    )
    _write_index(
        tmp_path,
        [
            _chunk(
                "routes.py:2-3:get_binary",
                "routes.py",
                "get_binary",
                2,
                3,
                calls=["binary_controller.get_binary"],
            ),
            _chunk(
                "binary_controller.py:1-2:get_binary",
                "binary_controller.py",
                "get_binary",
                1,
                2,
                calls=["load"],
            ),
            _chunk("binary_controller.py:4-5:load", "binary_controller.py", "load", 4, 5),
        ],
        [],
    )

    result = build_api_call_tree(tmp_path, api_id="GET_b_i")

    delegated = result["tree"]["children"][0]
    assert delegated["call"] == "binary_controller.get_binary"
    assert delegated["file"] == "binary_controller.py", "must not resolve back to the caller"
    assert delegated["children"][0]["name"] == "load", "the callee's subtree must be walked"


def test_a_call_through_an_untyped_receiver_stays_external(tmp_path: Path) -> None:
    # `p.resolve()` is pathlib's, not the project's same-named function; binding
    # it would graft a subtree the endpoint never touches.
    (tmp_path / "api.py").write_text(
        '@app.get("/p")\ndef where():\n    return Path(__file__).resolve()\n',
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [
            _chunk("api.py:2-3:where", "api.py", "where", 2, 3, calls=["Path(__file__).resolve"]),
            _chunk("util/a.py:1-2:resolve", "util/a.py", "resolve", 1, 2),
            _chunk("util/b.py:1-2:resolve", "util/b.py", "resolve", 1, 2),
        ],
        [],
    )

    result = build_api_call_tree(tmp_path, api_id="GET_p")

    call = result["tree"]["children"][0]
    assert call["resolved"] is False
    assert result["stats"]["internal_functions"] == 1


def test_a_ubiquitous_method_call_is_shown_but_never_bound_by_uniqueness(
    tmp_path: Path,
) -> None:
    # `session.get(...)` is a real call and must appear in the tree — but as an
    # external leaf, even when the repo happens to define exactly one function
    # named `get` (`by_uniqueness` would otherwise graft that subtree onto every
    # ORM access in the codebase).
    (tmp_path / "routes.py").write_text(
        '@app.get("/b")\ndef show(session):\n    return session.get(Binary, 1)\n',
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [
            _chunk("routes.py:2-3:show", "routes.py", "show", 2, 3, calls=["session.get"]),
            _chunk("vault.py:1-2:get", "vault.py", "get", 1, 2),
        ],
        [],
    )

    result = build_api_call_tree(tmp_path, api_id="GET_b")

    (call,) = result["tree"]["children"]
    assert call["call"] == "session.get", "the DB access must be visible"
    assert call["resolved"] is False, "and must not bind to the project's one get()"


def test_a_pre_receiver_index_is_refused(tmp_path: Path) -> None:
    (tmp_path / "api.py").write_text("def health():\n    pass\n", encoding="utf-8")
    store = _write_index(tmp_path, [_chunk("api.py:1-2:health", "api.py", "health", 1, 2)], [])
    meta = json.loads((store / "meta.json").read_text(encoding="utf-8"))
    meta["version"] = 4
    (store / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    with pytest.raises(ValueError, match="records call receivers"):
        open_identification_store(tmp_path)


def test_missing_and_corrupt_rust_stores_are_clear(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="No code index"):
        open_identification_store(tmp_path)

    store = tmp_path / ".vinv" / "index"
    store.mkdir(parents=True)
    (store / "meta.json").write_text("{broken", encoding="utf-8")
    with pytest.raises(ValueError, match=r"parse meta\.json"):
        open_identification_store(tmp_path)


def test_corrupt_edges_are_rejected(tmp_path: Path) -> None:
    (tmp_path / "api.py").write_text("def health():\n    pass\n", encoding="utf-8")
    _write_index(
        tmp_path,
        [_chunk("api.py:1-2:health", "api.py", "health", 1, 2)],
        [{"src": 0, "dst": 9, "kind": "invoke"}],
    )

    with pytest.raises(ValueError, match="invalid chunk row"):
        open_identification_store(tmp_path)


@pytest.mark.parametrize("malicious_path", ["../outside.py", "/tmp/outside.py"])
def test_index_source_paths_cannot_escape_project(tmp_path: Path, malicious_path: str) -> None:
    _write_index(
        tmp_path,
        [_chunk("malicious:1-2:steal", malicious_path, "steal", 1, 2)],
        [],
    )

    with pytest.raises(ValueError, match="absolute source path|escapes project root"):
        list_service_apis(tmp_path)


def test_store_dir_override_is_honoured(tmp_path: Path) -> None:
    (tmp_path / "api.py").write_text(
        '@app.get("/custom")\ndef custom():\n    pass\n',
        encoding="utf-8",
    )
    custom = tmp_path / "elsewhere" / "index"
    custom.mkdir(parents=True)
    (custom / "meta.json").write_text(json.dumps({"version": 5, "count": 1}), encoding="utf-8")
    (custom / "chunks.jsonl").write_text(
        json.dumps(_chunk("api.py:2-3:custom", "api.py", "custom", 2, 3)) + "\n",
        encoding="utf-8",
    )
    (custom / "edges.jsonl").write_text("", encoding="utf-8")

    result = list_service_apis(tmp_path, store_dir=str(custom))

    assert result["store_kind"] == "rust"
    assert result["index_store"] == str(custom.resolve())
    assert result["apis"][0]["handler"] == "custom"
