"""Regression: tracelens propagates ``contextvars`` across thread pools.

Before this fix, work submitted via ``loop.run_in_executor`` /
``ThreadPoolExecutor.submit`` ran in a worker thread that couldn't
see the caller's :class:`contextvars.ContextVar` snapshot. That broke
both of the parent-component recovery paths inside the tracelens span
processor:

* the primary ``_stack_cv`` stack — empty in the worker, so no
  ``tracelens.parent_component`` attribute on emitted spans;
* the OTel fallback — ``current_span`` is also stored in a
  ``ContextVar`` and was therefore empty too, making worker spans
  brand-new OTel roots under fresh request_ids.

The downstream symptom in the vinv UI was the flame-graph showing
"only the API handler + 1 span" instead of the multi-level call tree
underneath it.

These tests exercise the patch installed by
:func:`tracelens.launcher.executor_context.install` against a
synthetic context var, asserting that the worker thread observes the
caller's value (and not the worker thread's default).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars

import pytest

from tracelens.launcher import executor_context


@pytest.fixture(scope="module", autouse=True)
def _install_executor_patch() -> None:
    executor_context.install()


def test_thread_pool_submit_propagates_contextvars() -> None:
    cv: contextvars.ContextVar[str] = contextvars.ContextVar("tracelens_test_cv", default="default")
    cv.set("from_caller")

    def reader() -> str:
        return cv.get()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        fut = pool.submit(reader)
        assert fut.result(timeout=5.0) == "from_caller"


def test_thread_pool_submit_isolates_worker_writes() -> None:
    """The worker can mutate the var without leaking back to the caller."""
    cv: contextvars.ContextVar[str] = contextvars.ContextVar(
        "tracelens_test_cv2", default="default"
    )
    cv.set("from_caller")

    def writer() -> str:
        cv.set("from_worker")
        return cv.get()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        observed = pool.submit(writer).result(timeout=5.0)

    assert observed == "from_worker"
    assert cv.get() == "from_caller"


def test_run_in_executor_propagates_contextvars() -> None:
    """``loop.run_in_executor`` is the primary failure path in production."""
    cv: contextvars.ContextVar[str] = contextvars.ContextVar(
        "tracelens_test_cv3", default="default"
    )

    def reader() -> str:
        return cv.get()

    async def driver() -> str:
        cv.set("from_async_caller")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, reader)

    assert asyncio.run(driver()) == "from_async_caller"


def test_run_in_executor_with_args_propagates_contextvars() -> None:
    """The patch must preserve ``run_in_executor(loop, executor, fn, *args)`` semantics."""
    cv: contextvars.ContextVar[int] = contextvars.ContextVar("tracelens_test_cv4", default=-1)

    def reader(multiplier: int) -> int:
        return cv.get() * multiplier

    async def driver() -> int:
        cv.set(7)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, reader, 3)

    assert asyncio.run(driver()) == 21


def test_install_is_idempotent() -> None:
    first = executor_context.install()
    second = executor_context.install()
    # First call may report ``patched`` (test-module scope already
    # installed it via fixture, so realistically this is ``already``)
    # but the second must always be a pure no-op.
    assert all(v in {"patched", "already"} for v in first.values()), first
    assert all(v == "already" for v in second.values()), second
