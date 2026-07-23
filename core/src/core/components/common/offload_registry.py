"""Vinv Engine / components / common / offload_registry — index + GC for disk-offloaded content.

Several live paths offload oversized content to disk instead of carrying it in
LLM context:

  * ``cap_large_observation`` (vinv_engine_react) → ``obs_step_{run_id}_{idx}.md``
  * ``log_artifact._write_artifact`` (terminal digests, giant tool results)
    → ``{artifact_dir}/{label}-{ms}.log``
  * ``SharedScratchpad.add_task_output`` (dormant hero path)
    → ``task_output_{task_id}.md``

Historically these files were written and then forgotten: no index (discovery
was path-string-in-trajectory + grep only) and no garbage collection (artifacts
persisted forever).  This module fixes both with a single append-only JSONL
registry in the shared workspace:

    {VINV_ENGINE_SHARED_DIR}/.offload_registry.jsonl

Entry schema (one JSON object per line; later lines supersede earlier ones for
the same normalized path — tombstone semantics):

    {path, content_sha, created_ts, run_id, kind, status, deleted_ts?}

  path        — absolute; compared via os.path.normcase(os.path.normpath(p))
  content_sha — sha256(content)[:16] for integrity spot checks
  created_ts  — time.time() at registration
  run_id      — attribution; a process-scoped default is always available
  kind        — "obs_step" | "task_output" | "log_artifact"
  status      — "live" | "deleted" | "delete_failed"

Honest degradation everywhere: a registry failure must never break a live tool
call (``register_offload`` never raises), a wholesale-corrupt registry is
quarantined and rebuilt, per-line JSON errors are skipped, and GC treats a
missing file as already collected (tombstoned, not fatal).

Concurrency: single-line fsync'd appends under an in-process lock; cross-process
interleaving of whole lines is safe for JSONL (each line independently
parseable; a torn line is skipped by the per-line parser).  GC races are
covered by the grace window + ``run_id != active`` check, so GC never touches
files a concurrently-running process created within the last hour.

Environment variables:
  VINV_ENGINE_OFFLOAD_GC_GRACE_S — minimum age (seconds) before a foreign run's
      offload may be collected (default: 3600).  The longest observed
      bringup/handbook stage is minutes; 1h protects a concurrently-running
      second process against one shared dir with >10x margin.
  VINV_ENGINE_OFFLOAD_REGISTRY_MAX — line count that triggers compaction
      (default: 10000 ≈ 65 runs of headroom at ≤150 entries/run; the JSONL
      stays <2 MB with sub-ms scans).
  VINV_ENGINE_OFFLOAD_TOMBSTONE_TTL_S — how long tombstones survive compaction
      (default: 30 days, matching audit expectations for run forensics; after
      30 d a tombstone has no consumer).
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from core.components.bootstrap.paths import DEFAULT_VINV_ENGINE_SHARED_DIR
from core.components.common.persistence import AtomicWriter

logger = logging.getLogger(__name__)

_REGISTRY_BASENAME = ".offload_registry.jsonl"

VALID_KINDS = ("obs_step", "task_output", "log_artifact")
VALID_STATUSES = ("live", "deleted", "delete_failed")

# Every number is a documented prior — see the module docstring.
_GC_GRACE_S = float(os.environ.get("VINV_ENGINE_OFFLOAD_GC_GRACE_S", "3600.0"))
_REGISTRY_MAX_ENTRIES = int(os.environ.get("VINV_ENGINE_OFFLOAD_REGISTRY_MAX", "10000"))
_TOMBSTONE_TTL_S = float(os.environ.get("VINV_ENGINE_OFFLOAD_TOMBSTONE_TTL_S", "2592000"))

# Process-scoped fallback run id: every entry is attributable even when a
# driver never calls set_run_id (e.g. ad-hoc scripts driving the agent).
_PROCESS_START_TS = time.time()

_run_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "vinv_engine_offload_run_id", default=None,
)

# In-process serialization of appends + GC.  Cross-process safety comes from
# whole-line appends (see module docstring).
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Run identity
# ---------------------------------------------------------------------------

def current_run_id() -> str:
    """Return the active run id, falling back to a process-scoped default."""
    rid = _run_id_var.get()
    if rid:
        return rid
    return f"{os.getpid()}-{int(_PROCESS_START_TS)}"


def set_run_id(run_id: str) -> None:
    """Bind *run_id* as the active run identity for this context."""
    _run_id_var.set(str(run_id))


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def _shared_dir() -> str:
    return os.environ.get("VINV_ENGINE_SHARED_DIR", DEFAULT_VINV_ENGINE_SHARED_DIR)


def registry_path() -> Path:
    """Absolute path of the JSONL registry file (env-sensitive, call-time)."""
    return Path(_shared_dir()) / _REGISTRY_BASENAME


def _norm_path(p: str) -> str:
    """Normalize for comparison: absolute + normpath + normcase (Windows-safe)."""
    return os.path.normcase(os.path.normpath(os.path.abspath(str(p))))


# ---------------------------------------------------------------------------
# Registration (never raises — a registry failure must not break a tool call)
# ---------------------------------------------------------------------------

def register_offload(
    path: str, content: str, kind: str, run_id: str | None = None,
) -> None:
    """Append a ``live`` entry for an offloaded file.  Log-and-continue on error."""
    try:
        entry = {
            "path": os.path.abspath(str(path)),
            "content_sha": hashlib.sha256(
                content.encode("utf-8", "replace")
            ).hexdigest()[:16],
            "created_ts": time.time(),
            "run_id": run_id or current_run_id(),
            "kind": kind,
            "status": "live",
        }
        with _lock:
            AtomicWriter.append_line(registry_path(), entry)
    except Exception as exc:
        # Non-fatal contract (mirrors file_tools._register_file): the offload
        # file itself was written; losing the index entry degrades discovery,
        # not correctness.
        logger.warning("offload_registry: register failed (non-fatal): %s", exc)


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def _load_or_quarantine() -> list[dict[str, Any]]:
    """Read all parseable entries; quarantine a wholesale-unreadable registry.

    Per-line JSON errors (torn concurrent appends, manual edits, non-UTF8
    garbage bytes) are skipped individually — the file is decoded with
    ``errors="replace"`` so a few corrupt bytes poison only their own line,
    never the whole registry.  Only an OS-level read failure quarantines the
    whole file (renamed to ``.offload_registry.corrupt-{ts}``) so the registry
    restarts fresh instead of wedging every caller.
    """
    path = registry_path()
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip()]
    except FileNotFoundError:
        return []
    except Exception as exc:
        logger.warning("offload_registry: unreadable registry (%s) — quarantining", exc)
        try:
            quarantine = path.with_name(
                f"{_REGISTRY_BASENAME}.corrupt-{int(time.time())}"
            )
            os.replace(path, quarantine)
        except OSError:
            pass
        return []

    entries: list[dict[str, Any]] = []
    for line in lines:
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue  # torn / corrupt line — skip, never fatal
        if isinstance(obj, dict) and obj.get("path"):
            entries.append(obj)
    return entries


def _latest_by_path(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Collapse the append-only log: last entry per normalized path wins."""
    latest: dict[str, dict[str, Any]] = {}
    for e in entries:
        latest[_norm_path(e["path"])] = e
    return latest


def lookup(
    kind: str | None = None,
    run_id: str | None = None,
    since_ts: float | None = None,
    status: str | None = "live",
) -> list[dict[str, Any]]:
    """Return current entries matching the filters (``status=None`` = all)."""
    results: list[dict[str, Any]] = []
    for e in _latest_by_path(_load_or_quarantine()).values():
        if kind is not None and e.get("kind") != kind:
            continue
        if run_id is not None and e.get("run_id") != run_id:
            continue
        if since_ts is not None and float(e.get("created_ts") or 0.0) < since_ts:
            continue
        if status is not None and e.get("status") != status:
            continue
        results.append(e)
    results.sort(key=lambda e: float(e.get("created_ts") or 0.0))
    return results


# ---------------------------------------------------------------------------
# Garbage collection
# ---------------------------------------------------------------------------

def gc_offloads(
    active_run_id: str,
    *,
    grace_s: float = _GC_GRACE_S,
    kinds: tuple[str, ...] | None = None,
) -> dict[str, int]:
    """Collect offloads from *other* runs older than the grace window.

    For every current ``live`` (or previously ``delete_failed`` — retried)
    entry with ``run_id != active_run_id`` and ``created_ts < now - grace_s``:
    delete the file and append a tombstone.  A missing file tombstones anyway
    (already collected out-of-band); a PermissionError/OSError (e.g. a Windows
    open handle) appends ``delete_failed`` and is retried at the next GC.
    Tombstones are appended, never rewritten in place.

    ``kinds`` optionally scopes collection (e.g. a blackboard clear collects
    only its own ``task_output`` offloads).  Returns
    ``{deleted, missing, failed, kept}`` counts for logging.
    """
    counts = {"deleted": 0, "missing": 0, "failed": 0, "kept": 0}
    now = time.time()

    with _lock:
        current = _latest_by_path(_load_or_quarantine())
        for e in current.values():
            status = e.get("status")
            if status == "deleted":
                continue  # already tombstoned
            if kinds is not None and e.get("kind") not in kinds:
                counts["kept"] += 1
                continue
            if e.get("run_id") == active_run_id:
                counts["kept"] += 1
                continue
            if float(e.get("created_ts") or 0.0) >= now - grace_s:
                counts["kept"] += 1  # inside the grace window — may be live elsewhere
                continue

            path = str(e.get("path"))
            tomb = dict(e)
            tomb.pop("note", None)  # drop any stale delete_failed note on retry
            tomb["deleted_ts"] = time.time()
            try:
                os.remove(path)
                tomb["status"] = "deleted"
                counts["deleted"] += 1
            except FileNotFoundError:
                tomb["status"] = "deleted"
                tomb["note"] = "already_missing"
                counts["missing"] += 1
            except OSError as exc:
                # e.g. Windows open handle / permission — retry next GC
                tomb["status"] = "delete_failed"
                tomb["note"] = str(exc)
                counts["failed"] += 1
            try:
                AtomicWriter.append_line(registry_path(), tomb)
            except Exception as exc:
                logger.warning(
                    "offload_registry: tombstone append failed (non-fatal): %s", exc,
                )

        _maybe_compact_locked()

    if counts["deleted"] or counts["missing"] or counts["failed"]:
        logger.info(
            "offload_registry: gc active_run=%s deleted=%d missing=%d failed=%d kept=%d",
            active_run_id, counts["deleted"], counts["missing"],
            counts["failed"], counts["kept"],
        )
    return counts


def collect_paths(paths: "list[str] | set[str] | tuple[str, ...]") -> dict[str, int]:
    """Owner-initiated collection of specific offload files (no grace, no run check).

    For a caller that KNOWS it owns *paths* (e.g. a blackboard collecting the
    task-output files it wrote itself at a clear), grace windows and run-id
    checks are meaningless — collect exactly these paths, now.  For each path:
    delete the file and append a tombstone.  A missing file tombstones anyway;
    an entry already tombstoned is skipped; a path that was never registered
    (registration is non-fatal and may have been lost) is still deleted and
    tombstoned with a synthesized entry so the audit trail records the removal.
    Returns ``{deleted, missing, failed, kept}`` counts.
    """
    counts = {"deleted": 0, "missing": 0, "failed": 0, "kept": 0}
    if not paths:
        return counts
    with _lock:
        current = _latest_by_path(_load_or_quarantine())
        for p in paths:
            norm = _norm_path(p)
            entry = current.get(norm)
            if entry is not None and entry.get("status") == "deleted":
                counts["kept"] += 1
                continue
            if entry is not None:
                tomb = dict(entry)
                tomb.pop("note", None)  # drop any stale delete_failed note
            else:
                tomb = {
                    "path": os.path.abspath(str(p)),
                    "content_sha": "",
                    "created_ts": time.time(),
                    "run_id": current_run_id(),
                    "kind": "task_output",
                    "status": "live",
                    "note": "unregistered_at_collect",
                }
            tomb["deleted_ts"] = time.time()
            try:
                os.remove(str(p))
                tomb["status"] = "deleted"
                counts["deleted"] += 1
            except FileNotFoundError:
                tomb["status"] = "deleted"
                tomb["note"] = "already_missing"
                counts["missing"] += 1
            except OSError as exc:
                tomb["status"] = "delete_failed"
                tomb["note"] = str(exc)
                counts["failed"] += 1
            try:
                AtomicWriter.append_line(registry_path(), tomb)
            except Exception as exc:
                logger.warning(
                    "offload_registry: tombstone append failed (non-fatal): %s", exc,
                )
        _maybe_compact_locked()
    if counts["deleted"] or counts["missing"] or counts["failed"]:
        logger.info(
            "offload_registry: collect_paths deleted=%d missing=%d failed=%d kept=%d",
            counts["deleted"], counts["missing"], counts["failed"], counts["kept"],
        )
    return counts


# ---------------------------------------------------------------------------
# Compaction
# ---------------------------------------------------------------------------

def _maybe_compact_locked() -> None:
    """Compact when the raw line count exceeds the cap.  Caller holds ``_lock``."""
    path = registry_path()
    try:
        if not path.exists():
            return
        # errors="replace": garbage bytes must not crash the count (they only
        # poison their own line at parse time — see _load_or_quarantine).
        with open(path, encoding="utf-8", errors="replace") as fh:
            line_count = sum(1 for line in fh if line.strip())
        if line_count > _REGISTRY_MAX_ENTRIES:
            _compact_locked()
    except OSError as exc:
        logger.warning("offload_registry: compaction check failed (non-fatal): %s", exc)


def compact_registry() -> None:
    """Rewrite the registry keeping live entries + young tombstones (atomic)."""
    with _lock:
        _compact_locked()


def _compact_locked() -> None:
    """Temp-write + rename rewrite.  Caller holds ``_lock``.

    Keeps (a) all ``live`` / ``delete_failed`` entries (the latter are pending
    retries), (b) tombstones younger than ``_TOMBSTONE_TTL_S``.
    """
    import tempfile

    path = registry_path()
    now = time.time()
    keep: list[dict[str, Any]] = []
    for e in _latest_by_path(_load_or_quarantine()).values():
        if e.get("status") in ("live", "delete_failed"):
            keep.append(e)
        elif now - float(e.get("deleted_ts") or e.get("created_ts") or 0.0) < _TOMBSTONE_TTL_S:
            keep.append(e)
    keep.sort(key=lambda e: float(e.get("created_ts") or 0.0))

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                for e in keep:
                    f.write(json.dumps(e, default=str) + "\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        logger.info("offload_registry: compacted to %d entries", len(keep))
    except OSError as exc:
        logger.warning("offload_registry: compaction failed (non-fatal): %s", exc)


__all__ = [
    "current_run_id",
    "set_run_id",
    "register_offload",
    "lookup",
    "gc_offloads",
    "collect_paths",
    "compact_registry",
    "registry_path",
    "VALID_KINDS",
    "VALID_STATUSES",
]
