"""``mem_delta_bytes`` distinguishes "memory attribution OFF" from "zero delta".

The exporter used to default an absent ``tracelens.mem_delta_bytes`` attribute
to ``0``, which made a memory-disabled capture byte-identical to a capture in
which every call genuinely allocated nothing. Downstream consumers (the
extension's per-symbol memory overlay and flamegraph) key "omit the memory
axis" on the ABSENCE of memory data, so the conflation rendered all-zero
memory views instead of none. Off must now export ``null``; a recorded delta
(including a true 0) exports the integer.
"""

from __future__ import annotations

import json
from pathlib import Path

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

from tracelens.otel.exporter import JSONLFileSpanExporter


def _one_exit_row(tmp_path: Path, attributes: dict) -> dict:
    out = tmp_path / "trace.jsonl"
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(JSONLFileSpanExporter(str(out))))
    tracer = provider.get_tracer("test")
    with tracer.start_as_current_span("demo.mod.fn") as span:
        for key, value in attributes.items():
            span.set_attribute(key, value)
    provider.shutdown()
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    exits = [r for r in rows if r.get("event") == "exit"]
    assert len(exits) == 1
    return exits[0]


def test_memory_off_exports_null_not_zero(tmp_path: Path) -> None:
    row = _one_exit_row(tmp_path, {})
    assert "mem_delta_bytes" in row, "schema keeps the key for stable consumers"
    assert row["mem_delta_bytes"] is None


def test_recorded_delta_exports_the_integer(tmp_path: Path) -> None:
    row = _one_exit_row(tmp_path, {"tracelens.mem_delta_bytes": 2_097_241})
    assert row["mem_delta_bytes"] == 2_097_241


def test_true_zero_delta_survives_as_zero(tmp_path: Path) -> None:
    row = _one_exit_row(tmp_path, {"tracelens.mem_delta_bytes": 0})
    assert row["mem_delta_bytes"] == 0
