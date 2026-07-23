"""Read-only adapters for identification's supported code-index formats."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Protocol


class IdentificationStore(Protocol):
    """The small symbol/graph surface identification needs from an index."""

    kind: str
    store_dir: str

    def open(self) -> None: ...
    def close(self) -> None: ...
    def symbol_count(self) -> int: ...
    def get_all_file_paths(self) -> list[str]: ...
    def get_symbols_for_file(self, file_path: str) -> list[dict[str, Any]]: ...
    def find_symbol_by_name(self, name: str) -> list[dict[str, Any]]: ...
    def get_out_links(self, symbol_id: str) -> list[str]: ...


#: Oldest index format identification can resolve calls from. Must track
#: `STORE_VERSION` in `index/src/store.rs`.
_MIN_STORE_VERSION = 5

_KIND_MAP = {
    "function": "function_definition",
    "method": "function_definition",
    "class": "class_definition",
    "doc": "doc_section",
    "section": "doc_section",
}


class RustIndexStore:
    """In-memory read-only view of the Rust index JSON store."""

    kind = "rust"

    def __init__(self, store_dir: str | Path):
        self.store_dir = str(Path(store_dir).expanduser().resolve())
        self._chunks: list[dict[str, Any]] = []
        self._by_id: dict[str, dict[str, Any]] = {}
        self._by_file: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._out_links: dict[str, list[str]] = defaultdict(list)

    def open(self) -> None:
        directory = Path(self.store_dir)
        meta = _read_json(directory / "meta.json", "meta.json")
        if not isinstance(meta, dict):
            raise ValueError(f"Corrupt Rust index at {directory}: meta.json must be an object")

        # Resolving a call needs the receiver that v5 restored. In a v4 store
        # `binary_controller.get_binary()` was flattened to bare `get_binary`,
        # so a call could not be told apart from recursion — and `p.resolve()`
        # reads as a call to any project function named `resolve`, which binds
        # real subtrees onto unrelated symbols. Refuse the older layout: a call
        # tree built from it is quietly wrong, which is worse than absent.
        version = meta.get("version")
        if not isinstance(version, int) or isinstance(version, bool):
            raise ValueError(f"Corrupt Rust index at {directory}: invalid meta.json version")
        if version < _MIN_STORE_VERSION:
            raise ValueError(
                f"Index at {directory} is version {version}; identification needs "
                f"v{_MIN_STORE_VERSION}+, which records call receivers. Rebuild it "
                f"with `index index --force --store-dir {directory}`."
            )

        raw_chunks = _read_jsonl(directory / "chunks.jsonl")
        raw_edges = _read_jsonl(directory / "edges.jsonl")
        declared_count = meta.get("count")
        if not isinstance(declared_count, int) or declared_count < 0:
            raise ValueError(f"Corrupt Rust index at {directory}: invalid meta.json count")
        if declared_count != len(raw_chunks):
            raise ValueError(
                f"Corrupt Rust index at {directory}: meta.json count {declared_count} "
                f"does not match {len(raw_chunks)} chunks"
            )

        chunks: list[dict[str, Any]] = []
        ids: set[str] = set()
        for row, raw in enumerate(raw_chunks):
            if not isinstance(raw, dict):
                raise ValueError(
                    f"Corrupt Rust index at {directory}: chunks.jsonl line {row + 1} "
                    "must be an object"
                )
            required = ("id", "file", "lang", "kind", "name", "start_line", "end_line")
            missing = [key for key in required if key not in raw]
            if missing:
                raise ValueError(
                    f"Corrupt Rust index at {directory}: chunks.jsonl line {row + 1} "
                    f"missing {', '.join(missing)}"
                )
            symbol_id = raw["id"]
            if not isinstance(symbol_id, str) or not symbol_id or symbol_id in ids:
                raise ValueError(
                    f"Corrupt Rust index at {directory}: invalid or duplicate chunk id "
                    f"on line {row + 1}"
                )
            ids.add(symbol_id)
            raw_calls = raw.get("calls") or []
            if not isinstance(raw_calls, list):
                raise ValueError(
                    f"Corrupt Rust index at {directory}: chunks.jsonl line {row + 1} "
                    "has a non-list calls field"
                )
            symbol = {
                "symbol_id": symbol_id,
                "file_path": str(raw["file"]),
                "language": str(raw["lang"]),
                "node_type": _KIND_MAP.get(str(raw["kind"]), str(raw["kind"])),
                "name": str(raw["name"]),
                "start_line": _positive_line(raw["start_line"], directory, row),
                "end_line": _positive_line(raw["end_line"], directory, row),
                "calls": [str(call) for call in raw_calls if str(call)],
            }
            chunks.append(symbol)

        for row, edge in enumerate(raw_edges):
            if not isinstance(edge, dict):
                raise ValueError(
                    f"Corrupt Rust index at {directory}: edges.jsonl line {row + 1} "
                    "must be an object"
                )
            src, dst = edge.get("src"), edge.get("dst")
            if (
                not isinstance(src, int)
                or isinstance(src, bool)
                or not isinstance(dst, int)
                or isinstance(dst, bool)
                or not (0 <= src < len(chunks))
                or not (0 <= dst < len(chunks))
            ):
                raise ValueError(
                    f"Corrupt Rust index at {directory}: edges.jsonl line {row + 1} "
                    "references an invalid chunk row"
                )

        # Out-links are the call paths the parser recorded, verbatim — not the
        # names of `edges.jsonl` invoke targets.
        #
        # `edges.jsonl` is a lossy source for a call tree. The indexer resolves
        # each call to an exact chunk row, but a row cannot be handed back
        # through this API, so reading edges meant degrading a resolved target
        # to its bare *name* and re-resolving it here — and 23% of invoke edges
        # point at a name that is ambiguous repo-wide, so that round trip could
        # land on a different same-named symbol (payment's copy instead of
        # admin's). Worse, the indexer withholds any call it cannot decide
        # (parking it in `pending_edges.jsonl` for an adjudication layer that
        # may never run), so every ambiguous call was simply invisible here.
        #
        # The call paths keep their receiver, which is exactly what
        # `resolve_target` needs to tell `binary_controller.get_binary()` apart
        # from recursion into `get_binary()`. Resolving at read time — the
        # contract identification was written against — is both lossless and
        # better informed than anything `edges.jsonl` can express.
        out_links: dict[str, list[str]] = defaultdict(list)
        for chunk in chunks:
            if chunk["calls"]:
                out_links[chunk["symbol_id"]].extend(chunk["calls"])

        self._chunks = chunks
        self._by_id = {chunk["symbol_id"]: chunk for chunk in chunks}
        self._by_file = defaultdict(list)
        self._by_name = defaultdict(list)
        for chunk in chunks:
            self._by_file[chunk["file_path"]].append(chunk)
            self._by_name[chunk["name"]].append(chunk)
        self._out_links = out_links

    def close(self) -> None:
        return None

    def symbol_count(self) -> int:
        return len(self._chunks)

    def get_all_file_paths(self) -> list[str]:
        return sorted(self._by_file)

    def get_symbols_for_file(self, file_path: str) -> list[dict[str, Any]]:
        return list(self._by_file.get(file_path, ()))

    def find_symbol_by_name(self, name: str) -> list[dict[str, Any]]:
        return list(self._by_name.get(name, ()))

    def get_out_links(self, symbol_id: str) -> list[str]:
        return list(self._out_links.get(symbol_id, ()))


def open_identification_store(
    root: Path, override: str | None = None,
) -> IdentificationStore:
    """Open the Rust index store for a repository (``<repo>/.vinv/index``)."""
    root = root.resolve()
    candidates: list[Path] = []
    if override:
        candidates.append(Path(override).expanduser().resolve())
    else:
        candidates.append(root / ".vinv" / "index")

    for candidate in candidates:
        if (candidate / "meta.json").is_file():
            store: IdentificationStore = RustIndexStore(candidate)
            store.open()
            return store

    looked = ", ".join(str(path) for path in candidates)
    raise FileNotFoundError(
        f"No code index for {root} (looked in: {looked}). Run `index index` with "
        f"--store-dir {root / '.vinv' / 'index'}, or pass --store-dir."
    )


def _read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"Corrupt Rust index at {path.parent}: read {label}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Corrupt Rust index at {path.parent}: parse {label}: {exc}") from exc


def _read_jsonl(path: Path) -> list[Any]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ValueError(f"Corrupt Rust index at {path.parent}: read {path.name}: {exc}") from exc
    rows: list[Any] = []
    for line_no, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Corrupt Rust index at {path.parent}: parse {path.name} "
                f"line {line_no}: {exc}"
            ) from exc
    return rows


def _positive_line(value: Any, directory: Path, row: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(
            f"Corrupt Rust index at {directory}: chunks.jsonl line {row + 1} "
            "has an invalid source line"
        )
    return value
