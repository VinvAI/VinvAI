"""EventReader — single source of validated event dicts for offline analyze stages.

Today: only ``JSONLEventReader`` ships, reading the JSONL file produced by
``JSONLFileSpanExporter``. A SQLite-backed reader can be added behind the same
interface; analyze stages will not need to change.

Schema validation lives here so every consumer gets the same skip-count semantics.
The schema is generated from ``lens_contracts.SpanEvent``; Tracelens
does not keep a second handwritten copy. For v0.1 the reader returns SpanEvent rows only.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from importlib import resources
from pathlib import Path
from typing import Any, Protocol, cast

import jsonschema

_log = logging.getLogger(__name__)


class EventReader(Protocol):
    """Source-agnostic stream of validated event dicts.

    Implementations must report the count of skipped (invalid) lines/rows so callers
    can surface the number to the user. The expected usage is::

        with open_reader(path) as r:
            for row in r:
                ...
            if r.skipped:
                _log.warning("skipped %d invalid rows", r.skipped)
    """

    skipped: int

    def __iter__(self) -> Iterator[dict[str, Any]]: ...

    def __enter__(self) -> EventReader: ...

    def __exit__(self, *exc: object) -> None: ...


def _load_schema() -> dict[str, Any]:
    schema_path = resources.files("lens_contracts.schemas").joinpath("span_event.schema.json")
    raw = schema_path.read_text(encoding="utf-8")
    return cast(dict[str, Any], json.loads(raw))


_SCHEMA: dict[str, Any] | None = None
_VALIDATOR: jsonschema.protocols.Validator | None = None


def _schema() -> dict[str, Any]:
    global _SCHEMA
    if _SCHEMA is None:
        _SCHEMA = _load_schema()
    return _SCHEMA


def _validator() -> jsonschema.protocols.Validator:
    """Build the schema validator once and reuse it.

    ``jsonschema.validate(obj, schema)`` rebuilds the validator and re-resolves
    ``$ref``s on every call — ~1000x slower than compiling once and calling
    ``is_valid`` per row.
    """
    global _VALIDATOR
    if _VALIDATOR is None:
        schema = _schema()
        cls = jsonschema.validators.validator_for(schema)
        cls.check_schema(schema)
        _VALIDATOR = cls(schema)
    return _VALIDATOR


# Process-level cache of validated rows keyed on (resolved path, mtime_ns, size).
# ``report`` opens a fresh reader for every stage (spans, depgraph, outcomes, ...),
# so the same file was being re-parsed and re-validated 7x. Keying on mtime+size
# means a changed file is transparently reloaded.
_ROW_CACHE: dict[tuple[str, int, int], tuple[list[dict[str, Any]], int]] = {}


class JSONLEventReader:
    """Reads ``trace.jsonl`` line by line, validates against the SpanEvent schema."""

    def __init__(self, path: Path):
        self._path = Path(path)
        self.skipped = 0
        self._rows: list[dict[str, Any]] | None = None

    def _cache_key(self) -> tuple[str, int, int] | None:
        try:
            st = self._path.stat()
            return (str(self._path.resolve()), st.st_mtime_ns, st.st_size)
        except OSError:
            return None

    def _load(self) -> list[dict[str, Any]]:
        if self._rows is not None:
            return self._rows
        key = self._cache_key()
        if key is not None and key in _ROW_CACHE:
            cached_rows, cached_skipped = _ROW_CACHE[key]
            self.skipped = cached_skipped
            self._rows = cached_rows
            return cached_rows
        rows: list[dict[str, Any]] = []
        skipped = 0
        validator = _validator()
        with self._path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    skipped += 1
                    continue
                # Cheap pre-filter: the reader only surfaces SpanEvent rows, so skip
                # non-span lines (cpu/gc/rss sample events streamed into the same file)
                # before the more expensive schema check.
                if not (isinstance(obj, dict) and obj.get("event") in ("enter", "exit")):
                    skipped += 1
                    continue
                if validator.is_valid(obj):
                    rows.append(obj)
                else:
                    skipped += 1
        if skipped:
            _log.warning("skipped %d invalid JSONL lines from %s", skipped, self._path)
        self.skipped = skipped
        self._rows = rows
        if key is not None:
            _ROW_CACHE[key] = (rows, skipped)
        return rows

    def __iter__(self) -> Iterator[dict[str, Any]]:
        yield from self._load()

    def __enter__(self) -> JSONLEventReader:
        return self

    def __exit__(self, *exc: object) -> None:
        # Drop the per-instance reference; the shared row cache (keyed on
        # path+mtime+size) still serves future readers of the same file.
        self._rows = None


def open_reader(source: str | Path) -> EventReader:
    """Open a reader for the given source.

    Today this only routes to ``JSONLEventReader``; future scheme prefixes
    (``sqlite://``, ``ch://``, ``file://``) will route to alternative implementations.
    """
    p = Path(source)
    return JSONLEventReader(p)
