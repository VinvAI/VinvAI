"""PEP 669 hooks: branch coverage on 3.12+, tool-id reservation, AST spans.

Function-level spans still come from the AST import hook. What ``sys.monitoring``
NOW contributes is BRANCH coverage over target code: without it, coverage is
function-entry only, so any reward built on "newly covered" saturates after one
call per function — long before the input space is explored.

Design (coverage-tool shape, deliberately cheap):

* ``PY_START`` fires once per code object; target-root code objects get local
  ``BRANCH`` events enabled, everything else is DISABLEd at the call site.
* Each branch ARM ``(code, src_offset, dst_offset)`` is recorded on its FIRST
  hit — with the active request id — and then DISABLEd. Coverage is monotone,
  so first-hit-only loses nothing and keeps steady-state overhead at zero.
* Hits are appended to the trace file as their own line kind
  ``{"event": "branch_hits", "hits": [...]}`` (the ``gc_pause`` pattern: own
  handle, one flushed line per write), drained by a daemon timer so a live
  exercise loop sees branches land between rounds, and at exit.

Escape hatch: ``TRACELENS_NO_BRANCH_COVERAGE=1``. On <3.12 (or with no free
tool id) everything degrades to the plain AST hook, exactly as before.
"""

from __future__ import annotations

import dis
import json
import logging
import os
import sys
import threading
import time
from typing import Any

_log = logging.getLogger("tracelens.diag")

# Drain cadence for the writer thread — fast enough that an exercise round's
# settle window (~0.8 s) observes the branches its probes just took.
_FLUSH_INTERVAL_S = 0.5


class _BranchRecorder:
    """First-hit branch recorder writing ``branch_hits`` lines to the trace file."""

    def __init__(self, mon: Any, tool_id: int, output_path: str, roots: tuple[str, ...]):
        self._mon = mon
        self._tool_id = tool_id
        self._path = output_path
        self._roots = tuple(os.path.abspath(r) for r in roots)
        self._lock = threading.Lock()
        self._pending: list[dict[str, Any]] = []
        self._decided: dict[int, bool] = {}  # id(code) -> instrumented?
        self._lines: dict[int, list[tuple[int, int]]] = {}  # id(code) -> linestarts
        self._branch_events = 0
        self._fh: Any = None
        self._stopped = False

    # ---- targeting -------------------------------------------------------

    def _wants(self, code: Any) -> bool:
        cached = self._decided.get(id(code))
        if cached is not None:
            return cached
        filename = code.co_filename or ""
        want = False
        if filename and not filename.startswith("<"):
            norm = os.path.abspath(filename).replace("\\", "/")
            if "site-packages" not in norm or (
                os.environ.get("TRACELENS_INSTRUMENT_THIRD_PARTY") == "1"
            ):
                want = any(
                    norm == r or norm.startswith(r.rstrip("/") + "/")
                    for r in (r.replace("\\", "/") for r in self._roots)
                )
        self._decided[id(code)] = want
        return want

    def _line_of(self, code: Any, offset: int) -> int:
        starts = self._lines.get(id(code))
        if starts is None:
            starts = [(o, ln) for o, ln in dis.findlinestarts(code) if ln is not None]
            self._lines[id(code)] = starts
        line = code.co_firstlineno
        for o, ln in starts:
            if o > offset:
                break
            line = ln
        return line

    # ---- sys.monitoring callbacks ---------------------------------------

    def on_py_start(self, code: Any, _offset: int) -> Any:
        try:
            if self._wants(code):
                self._mon.set_local_events(self._tool_id, code, self._branch_events)
        except Exception:  # never let instrumentation break the target
            pass
        return self._mon.DISABLE  # decision is per code object — one visit is enough

    def on_branch(self, code: Any, src: int, dst: int) -> Any:
        try:
            hit = {
                "file": code.co_filename,
                "line": self._line_of(code, src),
                "src": src,
                "dst": dst,
                "request_id": self._request_id(),
            }
            with self._lock:
                self._pending.append(hit)
        except Exception:
            pass
        return self._mon.DISABLE  # first hit per arm; coverage is monotone

    @staticmethod
    def _request_id() -> str | None:
        try:
            from tracelens.context import (
                get_request_id_from_baggage,
                synthetic_request_id_from_trace,
            )

            rid = get_request_id_from_baggage()
            if rid:
                return rid
            from opentelemetry import trace as _t

            sp = _t.get_current_span()
            ctx = sp.get_span_context() if sp is not None else None
            if ctx is not None and ctx.is_valid:
                return synthetic_request_id_from_trace(ctx.trace_id)
        except Exception:
            return None
        return None

    # ---- writer ----------------------------------------------------------

    def flush(self) -> None:
        with self._lock:
            hits, self._pending = self._pending, []
        if not hits:
            return
        try:
            if self._fh is None:
                self._fh = open(self._path, "a", encoding="utf-8")  # noqa: SIM115
            line = json.dumps(
                {
                    "event": "branch_hits",
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
                    "hits": hits,
                },
                separators=(",", ":"),
                ensure_ascii=False,
            )
            self._fh.write(line + "\n")
            self._fh.flush()
        except OSError:
            pass  # capture must never take the target down

    def run_writer(self) -> None:
        while not self._stopped:
            time.sleep(_FLUSH_INTERVAL_S)
            self.flush()

    def stop(self) -> None:
        self._stopped = True
        self.flush()

    # ---- installation ----------------------------------------------------

    def install(self) -> None:
        mon = self._mon
        ev = mon.events
        # 3.14 splits BRANCH into BRANCH_LEFT/BRANCH_RIGHT; 3.12/3.13 have BRANCH.
        if hasattr(ev, "BRANCH_LEFT"):
            self._branch_events = ev.BRANCH_LEFT | ev.BRANCH_RIGHT
            mon.register_callback(self._tool_id, ev.BRANCH_LEFT, self.on_branch)
            mon.register_callback(self._tool_id, ev.BRANCH_RIGHT, self.on_branch)
        else:
            self._branch_events = ev.BRANCH
            mon.register_callback(self._tool_id, ev.BRANCH, self.on_branch)
        mon.register_callback(self._tool_id, ev.PY_START, self.on_py_start)
        mon.set_events(self._tool_id, ev.PY_START)
        writer = threading.Thread(
            target=self.run_writer, name="tracelens-branch-writer", daemon=True
        )
        writer.start()
        import atexit

        atexit.register(self.stop)


def _install_branch_coverage(mon: Any, tool_id: int) -> bool:
    """Enable branch coverage when configured; True when armed."""
    if os.environ.get("TRACELENS_NO_BRANCH_COVERAGE") == "1":
        return False
    output = os.environ.get("TRACELENS_OUTPUT")
    if not output:
        return False
    from tracelens.launcher.targets import roots_from_env

    roots = roots_from_env()
    if not roots:
        # Without directory roots there is no cheap file-origin test for
        # "target code" — package-name targeting has no filename to match.
        _log.info("tracelens branch coverage idle: no TRACELENS_TARGET_ROOTS")
        return False
    recorder = _BranchRecorder(mon, tool_id, output, roots)
    recorder.install()
    _log.info(
        "tracelens branch coverage armed: tool_id=%s roots=%d output=%s",
        tool_id,
        len(roots),
        output,
    )
    return True


def install() -> None:
    """Reserve a monitoring tool id when available, arm branch coverage on it,
    and always install the AST hook for target packages."""
    mon = getattr(sys, "monitoring", None)
    tool_id: int | None = None
    if mon is not None and sys.version_info >= (3, 12):
        for tid in (mon.COVERAGE_ID, mon.PROFILER_ID, mon.OPTIMIZER_ID, mon.DEBUGGER_ID):
            try:
                mon.use_tool_id(tid, "tracelens")
                tool_id = tid
                _log.info("tracelens reserved sys.monitoring tool_id=%s", tid)
                break
            except ValueError:
                continue
    if mon is not None and tool_id is not None:
        try:
            _install_branch_coverage(mon, tool_id)
        except Exception as exc:  # degraded, never fatal
            _log.warning("tracelens branch coverage failed to arm: %s", exc)
    from tracelens.launcher import import_hook

    import_hook.install()
    _log.info("tracelens_hook=ast")
