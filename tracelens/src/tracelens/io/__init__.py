"""Event readers — abstracts the source of validated event rows.

The analyze stages are forbidden from calling `json.loads` on a JSONL file directly. They
must go through ``EventReader`` so that the future swap to a SQL/columnar store
([Phase 0 of IMPLEMENTATION_ROADMAP.md](../../../../docs/pitch/IMPLEMENTATION_ROADMAP.md))
is a single-file change.
"""

from tracelens.io.event_reader import (
    EventReader,
    JSONLEventReader,
    open_reader,
)

__all__ = ["EventReader", "JSONLEventReader", "open_reader"]
