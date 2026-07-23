"""Propagate Python ``contextvars`` (and therefore OTel context) across thread pools.

Background
----------
Tracelens recovers the parent-component link two ways inside the
processor:

1. **Primary** — its own ``_stack_cv`` :class:`contextvars.ContextVar`
   stack pushed/popped on every ``enter`` / ``exit`` event.
2. **Fallback** — OTel's ``span.parent`` (also stored in a
   ``ContextVar``).

Python copies context vars across ``asyncio`` tasks, but **not** across
:class:`concurrent.futures.ThreadPoolExecutor` workers and therefore
**not** across ``loop.run_in_executor(None, fn, *args)``.  The result
in production is dramatic: an API handler delegates the heavy work via
``run_in_executor`` and the worker thread emits its spans

  * with no ``tracelens.parent_component`` attribute (because
    ``_stack_cv`` is empty), and
  * as a brand-new OTel root span (because ``current_span`` is empty),
    so they end up under a different ``request_id`` in
    ``trace.jsonl``.

The downstream effect is that the flame-graph for the handler looks
flat ("only 2 nodes") even though the actual call tree is several
levels deep.

What this module does
---------------------
Wrap the two entry points that hand work to a thread pool so the
caller's :class:`contextvars.Context` travels with the work:

* :meth:`asyncio.AbstractEventLoop.run_in_executor`
* :meth:`concurrent.futures.ThreadPoolExecutor.submit`

The shim simply does ``ctx = contextvars.copy_context();
executor.submit(ctx.run, fn, *args)``. This restores the primary path
(``_stack_cv``) **and** the fallback path (OTel ``current_span``) in
one shot and is fully transparent to user code.

Idempotent: the install routine sets a sentinel attribute so a second
call is a no-op, even when a sub-process re-imports tracelens.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars
import functools
import logging
from collections.abc import Callable
from typing import Any, cast

_log = logging.getLogger("tracelens.diag")

_INSTALLED_SENTINEL = "_tracelens_ctx_propagating"


def _wrap_callable_with_context(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Snapshot the *calling* thread's context and run ``fn`` inside it."""
    ctx = contextvars.copy_context()

    @functools.wraps(fn)
    def runner(*args: Any, **kwargs: Any) -> Any:
        return ctx.run(fn, *args, **kwargs)

    return runner


def _patch_thread_pool_submit() -> bool:
    """Wrap :meth:`ThreadPoolExecutor.submit` so contextvars travel with the work."""
    submit = concurrent.futures.ThreadPoolExecutor.submit
    if getattr(submit, _INSTALLED_SENTINEL, False):
        return False

    @functools.wraps(cast(Callable[..., Any], submit))
    def submit_with_context(self, fn, /, *args, **kwargs):  # type: ignore[no-untyped-def]
        return submit(self, _wrap_callable_with_context(fn), *args, **kwargs)

    setattr(submit_with_context, _INSTALLED_SENTINEL, True)
    concurrent.futures.ThreadPoolExecutor.submit = submit_with_context  # type: ignore[method-assign]
    return True


def _patch_run_in_executor() -> bool:
    """Wrap :meth:`AbstractEventLoop.run_in_executor` so contextvars travel."""
    run_in_executor = asyncio.events.AbstractEventLoop.run_in_executor
    if getattr(run_in_executor, _INSTALLED_SENTINEL, False):
        return False

    @functools.wraps(run_in_executor)
    def run_in_executor_with_context(self, executor, func, *args):  # type: ignore[no-untyped-def]
        return run_in_executor(self, executor, _wrap_callable_with_context(func), *args)

    setattr(run_in_executor_with_context, _INSTALLED_SENTINEL, True)
    asyncio.events.AbstractEventLoop.run_in_executor = run_in_executor_with_context  # type: ignore[assignment]

    # ``BaseEventLoop`` defines its own override that calls into the
    # executor directly; patch it too so subclasses without their own
    # override still pick the wrapped behaviour up.
    base_run = asyncio.base_events.BaseEventLoop.run_in_executor
    if not getattr(base_run, _INSTALLED_SENTINEL, False):

        @functools.wraps(base_run)
        def base_run_in_executor_with_context(self, executor, func, *args):  # type: ignore[no-untyped-def]
            return base_run(self, executor, _wrap_callable_with_context(func), *args)

        setattr(base_run_in_executor_with_context, _INSTALLED_SENTINEL, True)
        asyncio.base_events.BaseEventLoop.run_in_executor = base_run_in_executor_with_context  # type: ignore[assignment]

    return True


def install() -> dict[str, str]:
    """Install both shims. Safe to call repeatedly.

    Returns a per-shim status dict suitable for folding into
    ``trace.jsonl.summary.json`` so the launcher can confirm the
    patches were actually applied for a given run.
    """
    status: dict[str, str] = {}
    try:
        status["thread_pool_submit"] = "patched" if _patch_thread_pool_submit() else "already"
    except BaseException as exc:  # noqa: BLE001 — never crash the target
        status["thread_pool_submit"] = f"failed:{type(exc).__name__}"
        _log.warning("tracelens: ThreadPoolExecutor.submit patch failed: %s", exc)
    try:
        status["run_in_executor"] = "patched" if _patch_run_in_executor() else "already"
    except BaseException as exc:  # noqa: BLE001
        status["run_in_executor"] = f"failed:{type(exc).__name__}"
        _log.warning("tracelens: run_in_executor patch failed: %s", exc)
    _log.info("tracelens: executor context propagation status %s", status)
    return status
