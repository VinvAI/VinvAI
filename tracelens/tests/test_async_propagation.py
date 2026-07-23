"""T3.1 — async / coroutine context propagation.

Asserts that spans emitted from an asyncio task spawned inside a parent function carry
the parent's request_id (via OTel Baggage) so they show up under the same request in the
JSONL.

We use ``asyncio.run`` directly so the test does not require pytest-asyncio.
"""

from __future__ import annotations

import asyncio
import importlib.util

import pytest

from tracelens.context import (
    get_request_id_from_baggage,
    new_request_id,
    set_request_id_baggage,
)


def test_request_id_propagates_through_create_task() -> None:
    rid = new_request_id()
    set_request_id_baggage(rid)

    async def main() -> str | None:
        async def child() -> str | None:
            return get_request_id_from_baggage()

        return await asyncio.create_task(child())

    result = asyncio.run(main())
    assert result == rid


@pytest.mark.skipif(
    importlib.util.find_spec("opentelemetry.instrumentation.asyncio") is None,
    reason="opentelemetry-instrumentation-asyncio not installed",
)
def test_otel_asyncio_instrumentation_imports() -> None:
    from opentelemetry.instrumentation.asyncio import AsyncioInstrumentor

    AsyncioInstrumentor().instrument()
    AsyncioInstrumentor().uninstrument()
