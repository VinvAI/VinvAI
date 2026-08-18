"""GC-as-latency-source capture.

Registers a ``gc.callbacks`` observer at the launcher's bootstrap point — the
same wiring style as the calibration bootstrap (``launcher.calibration``) —
and emits one line into the trace JSONL per completed collection:

    {"event": "gc_pause", "ts": iso, "duration_ms": float, "generation": int}

When a request is in scope (Baggage ``request_id``, or the OTel current span's
trace id — the same resolution the determinism ledger uses) the line also
carries ``request_id``; otherwise the field is omitted entirely, so consumers
can distinguish "no request was active" from an empty id.

Failure policy mirrors calibration: LOUD (``_health``) and never blocking. A
handle that cannot be opened or written degrades GC visibility for the run —
it never degrades the target. Writes are one complete flushed line per event,
the same append discipline the calibration header and span exporter use, so
interleaving with the exporter's handle can never tear a line.
"""

from __future__ import annotations

import atexit
import gc
import json
import os
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any

from tracelens import _health

# Env kill switch, same shape as TRACELENS_NO_CALIBRATION.
_DISABLE_ENV = "TRACELENS_NO_GC_EVENTS"

_lock = threading.Lock()
_fh: IO[str] | None = None
_path: str | None = None
_installed = False
_atexit_registered = False
# PID that installed the observer: a forked child inherits gc.callbacks AND the
# parent's file handle, and writing through the inherited handle could tear the
# parent's JSONL — the child's observer goes quiet (loudly, once) instead.
_pid: int | None = None
_start_ns: int | None = None


def _iso_now() -> str:
    dt = datetime.now(tz=UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{dt.microsecond // 1000:03d}Z"


def _current_request_id() -> str | None:
    """Active request id, if any — reuses the determinism ledger's resolver
    (Baggage first, then the OTel current span's trace id)."""
    try:
        from tracelens.launcher.determinism_capture import (
            _current_request_id as resolve,
        )

        return resolve()
    except Exception:
        return None


def _emit(rec: dict[str, Any]) -> None:
    line = json.dumps(rec, separators=(",", ":"), ensure_ascii=False) + "\n"
    with _lock:
        if _path == "-":
            sys.stdout.write(line)
            sys.stdout.flush()
        elif _fh is not None:
            _fh.write(line)
            _fh.flush()


def _on_gc(phase: str, info: dict[str, Any]) -> None:
    """The ``gc.callbacks`` observer: time start→stop, emit one gc_pause line.

    CPython invokes callbacks synchronously around a collection while the
    ``collecting`` flag is set, so the start/stop pair cannot nest and this
    module-level start timestamp is race-free. Never raises — an observer that
    breaks the target's GC would be worse than no observer.
    """
    global _start_ns
    try:
        if _pid is not None and os.getpid() != _pid:
            _health.warn_once(
                "gc_events_fork",
                f"gc_pause capture is disabled in forked child pid={os.getpid()} — "
                "the trace handle belongs to the parent process",
            )
            return
        if phase == "start":
            _start_ns = time.perf_counter_ns()
            return
        if phase != "stop" or _start_ns is None:
            return
        duration_ms = (time.perf_counter_ns() - _start_ns) / 1_000_000.0
        _start_ns = None
        rec: dict[str, Any] = {
            "event": "gc_pause",
            "ts": _iso_now(),
            "duration_ms": round(duration_ms, 4),
            "generation": int(info.get("generation", -1)),
        }
        rid = _current_request_id()
        if rid:
            rec["request_id"] = rid
        _emit(rec)
    except BaseException as exc:  # noqa: BLE001 — a GC observer must never break the target
        _health.record("gc_event_errors", note=repr(exc))
        _health.warn_once(
            "gc_event_failed",
            f"gc_pause capture failed ({type(exc).__name__}: {exc}) — "
            "GC pauses are missing from this trace",
        )


def install(output: str) -> bool:
    """Register the gc.callbacks observer writing gc_pause lines into ``output``.

    Same bootstrap contract as ``run_calibration``: must be called after the
    span pipeline is up (the lines land in the same trace JSONL) and never
    raises — a failure records a loud ``_health`` entry and the run proceeds
    without GC visibility. Idempotent. Returns True when the observer is live.
    """
    global _fh, _path, _installed, _pid, _atexit_registered
    if os.environ.get(_DISABLE_ENV) == "1":
        return False
    if _installed:
        return True
    try:
        if output != "-":
            p = Path(output)
            p.parent.mkdir(parents=True, exist_ok=True)
            _fh = open(output, "a", encoding="utf-8")  # noqa: SIM115 — held for the run
        _path = output
        _pid = os.getpid()
        gc.callbacks.append(_on_gc)
        _installed = True
        if not _atexit_registered:
            # Deterministic teardown at interpreter exit: remove the observer
            # and close (flush) the handle before the file is finalized.
            atexit.register(uninstall)
            _atexit_registered = True
        return True
    except BaseException as exc:  # noqa: BLE001 — GC capture must never block the run
        _fh = None
        _path = None
        _health.record("gc_events_install_errors", note=repr(exc))
        _health.warn_once(
            "gc_events_install_failed",
            f"gc_pause capture could not start ({type(exc).__name__}: {exc}) — "
            "the trace carries no gc_pause lines; GC time for this run is unmeasured",
        )
        return False


def uninstall() -> None:
    """Remove the observer and close the handle (atexit hook; also test hygiene)."""
    global _fh, _path, _installed, _start_ns, _pid
    try:
        gc.callbacks.remove(_on_gc)
    except ValueError:
        pass  # never installed, or already removed
    _installed = False
    _start_ns = None
    _pid = None
    with _lock:
        fh = _fh
        _fh = None
        _path = None
    try:
        if fh is not None:
            fh.close()
    except OSError:
        pass  # every line was already flushed at write time
