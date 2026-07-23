"""Generate JSON Schema files from the pydantic models.

Run: ``python -m lens_contracts.tools.gen_schemas`` (or ``pytest tests/test_schemas_match.py``
which validates the on-disk files match the regenerated ones).
"""

from __future__ import annotations

import json
from importlib import resources
from pathlib import Path
from typing import Any

from lens_contracts import (
    DeterminismBoundaryRecord,
    ExternalCallEvent,
    ReplayCorpusRow,
    SampleEvent,
    SpanEvent,
)

ENTITIES: dict[str, type[Any]] = {
    "span_event": SpanEvent,
    "sample_event": SampleEvent,
    "external_call_event": ExternalCallEvent,
    "replay_corpus_row": ReplayCorpusRow,
    "determinism_boundary_record": DeterminismBoundaryRecord,
}


def render(entity_cls: type[Any]) -> dict[str, Any]:
    schema: dict[str, Any] = entity_cls.model_json_schema(mode="serialization")
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["title"] = entity_cls.__name__
    return schema


def _schema_dir() -> Path:
    """Location of the on-disk JSON schemas in the installed package tree."""
    pkg = resources.files("lens_contracts.schemas")
    # `files` returns a Traversable; for a real package on disk this is a Path.
    return Path(str(pkg))


def write_all(out_dir: Path | None = None) -> dict[str, Path]:
    target = out_dir if out_dir is not None else _schema_dir()
    target.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}
    for name, cls in ENTITIES.items():
        path = target / f"{name}.schema.json"
        path.write_text(
            json.dumps(render(cls), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        written[name] = path
    return written


def main() -> None:
    written = write_all()
    for name, path in written.items():
        print(f"wrote {name} → {path}")


if __name__ == "__main__":
    main()
