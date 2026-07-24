"""T2.1 — DeterminismBoundary capture (minimal v1).

Wraps ``time.time / time.monotonic / time.perf_counter`` and ``random.random / randint /
getrandbits / uuid.uuid4 / secrets.token_bytes`` so each call's return value is recorded
keyed by the OTel-current ``request_id`` baggage entry.

What's NOT captured in v1 (documented limitations):
  - ``datetime.now()`` (replaceable, but datetime is patched by some apps already; deferred)
  - DB / HTTP / LLM / cache responses (these come from the contrib instrumenters' span
    events; producer-side capture is wired in a follow-up Phase 1.4 pass)
  - Native-code clocks / RNGs (gettimeofday, arc4random) — see pitch §6.4
  - GPU non-determinism — same

Records are streamed to ``<output>.determinism.jsonl`` next to the trace JSONL. Off by
default; enabled with ``--capture-determinism``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import secrets
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any

from tracelens.context import get_request_id_from_baggage, synthetic_request_id_from_trace
from tracelens.otel.processor import record_determinism_source


def _current_request_id() -> str | None:
    """Look up an active request_id: baggage first, fall back to the OTel current
    span's trace_id (matches what TracelensSpanProcessor synthesizes when baggage is
    absent — the FastAPI request handler case)."""
    rid = get_request_id_from_baggage()
    if rid:
        return rid
    try:
        from opentelemetry import trace as _t

        sp = _t.get_current_span()
        ctx = sp.get_span_context() if sp is not None else None
        if ctx is not None and ctx.is_valid:
            return synthetic_request_id_from_trace(ctx.trace_id)
    except Exception:
        return None
    return None


_log = logging.getLogger("tracelens.diag")

_fh: IO[str] | None = None
_lock = threading.Lock()
_installed = False


def _capture_raw_values() -> bool:
    return os.environ.get("TRACELENS_RAW_DETERMINISM_VALUES", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _now_iso() -> str:
    return (
        datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.")
        + f"{datetime.now(UTC).microsecond // 1000:03d}Z"
    )


def _emit(rec: dict[str, Any]) -> None:
    try:
        with _lock:
            if _fh is not None:
                _fh.write(json.dumps(rec, separators=(",", ":")) + "\n")
                _fh.flush()
    except BaseException as exc:  # noqa: BLE001 — never break the wrapped clock/RNG call
        from tracelens import _health

        _health.record("determinism_emit_errors", note=repr(exc))
        _health.warn_once(
            "determinism_emit",
            f"determinism ledger write failed ({type(exc).__name__}: {exc}) — "
            "determinism capture is degraded (disk full?)",
        )


def _wrap_clock(name: str, orig: Any) -> Any:
    def wrapper(*a: Any, **kw: Any) -> Any:
        v = orig(*a, **kw)
        rid = _current_request_id()
        if rid is not None:
            # Same contract as the RNG wrapper: the ledger records that the
            # clock was read and a digest for run-to-run comparison; the raw
            # reading (absolute wall time correlates with user activity) is
            # only kept under the explicit raw-values opt-in.
            payload = repr(v)
            record = {
                "ts": _now_iso(),
                "kind": "determinism",
                "request_id": rid,
                "fn": name,
                "payload_sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
            }
            if _capture_raw_values():
                record["value"] = v
            _emit(record)
            try:
                record_determinism_source(rid, "clock")
            except Exception:
                pass
        return v

    wrapper.__wrapped__ = orig  # type: ignore[attr-defined]
    return wrapper


def _wrap_rng(name: str, orig: Any) -> Any:
    def wrapper(*a: Any, **kw: Any) -> Any:
        v = orig(*a, **kw)
        rid = _current_request_id()
        if rid is not None:
            if isinstance(v, uuid.UUID):
                payload = v.hex  # UUID.hex is a property (str), not a method
            elif isinstance(v, bytes | bytearray):
                payload = v.hex()
            else:
                payload = str(v)
            record = {
                "ts": _now_iso(),
                "kind": "determinism",
                "request_id": rid,
                "fn": name,
                "payload_len": len(payload),
                "payload_sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
            }
            if _capture_raw_values():
                record["payload"] = payload[:128]
            _emit(record)
            try:
                record_determinism_source(rid, "rng")
            except Exception:
                pass
        return v

    wrapper.__wrapped__ = orig  # type: ignore[attr-defined]
    return wrapper


def _open_secure_append(target: Path) -> IO[str]:
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(target, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.chmod(target, 0o600)
        return os.fdopen(descriptor, "a", encoding="utf-8")
    except BaseException:
        os.close(descriptor)
        raise


def install(output_path: str) -> None:
    global _fh, _installed
    if _installed:
        return
    target = Path(output_path).with_suffix(Path(output_path).suffix + ".determinism.jsonl")
    _fh = _open_secure_append(target)

    # clocks
    time.time = _wrap_clock("time.time", time.time)
    time.monotonic = _wrap_clock("time.monotonic", time.monotonic)
    time.perf_counter = _wrap_clock("time.perf_counter", time.perf_counter)

    # rng
    random.random = _wrap_rng("random.random", random.random)
    random.randint = _wrap_rng("random.randint", random.randint)
    random.getrandbits = _wrap_rng("random.getrandbits", random.getrandbits)
    uuid.uuid4 = _wrap_rng("uuid.uuid4", uuid.uuid4)
    secrets.token_bytes = _wrap_rng("secrets.token_bytes", secrets.token_bytes)
    secrets.token_hex = _wrap_rng("secrets.token_hex", secrets.token_hex)

    _installed = True
    _log.info("tracelens determinism capture: streaming to %s", target)
