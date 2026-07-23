"""PEP 669: reserve a ``sys.monitoring`` tool id when possible.

``register_callback`` for ``PY_START`` / ``PY_RETURN`` / ``RAISE`` is **not** wired yet;
function-level spans still come from the AST import hook (see plan §5.4 M4 note). This
module exists so the launcher can coexist with coverage/profiler slots on Python 3.12+.
"""

from __future__ import annotations

import logging
import sys

_log = logging.getLogger("tracelens.diag")


def install() -> None:
    """Reserve a monitoring tool id when available; always install AST hook for target packages."""
    mon = getattr(sys, "monitoring", None)
    if mon is not None and sys.version_info >= (3, 12):
        for tid in (mon.COVERAGE_ID, mon.PROFILER_ID, mon.OPTIMIZER_ID, mon.DEBUGGER_ID):
            try:
                mon.use_tool_id(tid, "tracelens")
                _log.info("tracelens reserved sys.monitoring tool_id=%s", tid)
                break
            except ValueError:
                continue
    from tracelens.launcher import import_hook

    import_hook.install()
    _log.info("tracelens_hook=ast")
