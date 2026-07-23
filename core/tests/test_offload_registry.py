"""Unit surface of core.components.common.offload_registry.

Covers spec scenarios 4 (index lookup, corrupt-line skip, quarantine) and 9
(Windows-path normalization, PermissionError tombstones, read-only shared dir),
plus tombstone semantics, the grace window, compaction, and the run_id
contextvar default.  All thresholds reference the module constants / env names,
never re-hardcoded literals.
"""

from __future__ import annotations

import json
import os
import stat
import time
from pathlib import Path

import pytest

from core.components.common import offload_registry as reg


@pytest.fixture()
def shared_dir(tmp_path, monkeypatch):
    """Isolated shared workspace; run identity reset per test."""
    monkeypatch.setenv("VINV_ENGINE_SHARED_DIR", str(tmp_path))
    reg.set_run_id("test-run")
    return tmp_path


def _make_offload(shared_dir: Path, name: str, content: str = "payload") -> str:
    p = shared_dir / name
    p.write_text(content, encoding="utf-8")
    return str(p)


def test_register_and_lookup_roundtrip(shared_dir):
    p1 = _make_offload(shared_dir, "a.md", "aaa")
    p2 = _make_offload(shared_dir, "b.log", "bbb")
    before = time.time()
    reg.register_offload(p1, "aaa", kind="obs_step", run_id="runA")
    reg.register_offload(p2, "bbb", kind="log_artifact", run_id="runB")

    assert len(reg.lookup()) == 2
    assert [e["path"] for e in reg.lookup(kind="obs_step")] == [os.path.abspath(p1)]
    assert [e["run_id"] for e in reg.lookup(run_id="runB")] == ["runB"]
    assert len(reg.lookup(since_ts=before)) == 2
    assert reg.lookup(since_ts=time.time() + 60) == []

    entry = reg.lookup(kind="obs_step")[0]
    import hashlib
    assert entry["content_sha"] == hashlib.sha256(b"aaa").hexdigest()[:16]
    assert entry["status"] == "live"
    assert entry["kind"] in reg.VALID_KINDS


def test_last_entry_per_path_wins_tombstone_semantics(shared_dir):
    p = _make_offload(shared_dir, "x.md")
    reg.register_offload(p, "payload", kind="obs_step", run_id="runA")
    counts = reg.gc_offloads("runB", grace_s=0.0)
    assert counts["deleted"] == 1

    # Later tombstone line supersedes the earlier live line for the same path.
    assert reg.lookup() == []
    dead = reg.lookup(status="deleted")
    assert len(dead) == 1
    assert dead[0]["deleted_ts"] >= dead[0]["created_ts"]
    assert len(reg.lookup(status=None)) == 1


def test_corrupt_line_skipped_individually(shared_dir):
    p1 = _make_offload(shared_dir, "a.md")
    p2 = _make_offload(shared_dir, "b.md")
    reg.register_offload(p1, "one", kind="obs_step")
    with open(reg.registry_path(), "a", encoding="utf-8") as fh:
        fh.write('{"torn": tru\n')  # simulated torn concurrent append
        fh.write("not json at all\n")
    reg.register_offload(p2, "two", kind="obs_step")
    assert len(reg.lookup()) == 2


def test_wholesale_corrupt_registry_quarantined(shared_dir):
    p = _make_offload(shared_dir, "a.md")
    reg.register_offload(p, "one", kind="obs_step")
    path = reg.registry_path()
    os.chmod(path, 0o000)  # unreadable at the OS level
    try:
        assert reg.lookup() == []  # no raise
    finally:
        for f in shared_dir.iterdir():
            try:
                os.chmod(f, 0o644)
            except OSError:
                pass
    quarantined = list(shared_dir.glob(".offload_registry.jsonl.corrupt-*"))
    assert len(quarantined) == 1
    assert not path.exists()
    # Registry restarts fresh and is usable again.
    reg.register_offload(p, "one", kind="obs_step")
    assert len(reg.lookup()) == 1


def test_grace_window_protects_recent_foreign_run(shared_dir):
    p = _make_offload(shared_dir, "fresh.md")
    reg.register_offload(p, "payload", kind="obs_step", run_id="other-run")
    counts = reg.gc_offloads("active-run")  # default grace = _GC_GRACE_S
    assert counts == {"deleted": 0, "missing": 0, "failed": 0, "kept": 1}
    assert os.path.exists(p)


def test_active_run_never_collected_even_with_zero_grace(shared_dir):
    p = _make_offload(shared_dir, "mine.md")
    reg.register_offload(p, "payload", kind="obs_step", run_id="active-run")
    counts = reg.gc_offloads("active-run", grace_s=0.0)
    assert counts["kept"] == 1 and counts["deleted"] == 0
    assert os.path.exists(p)


def test_gc_missing_file_tombstones_and_is_idempotent(shared_dir):
    p = _make_offload(shared_dir, "gone.md")
    reg.register_offload(p, "payload", kind="obs_step", run_id="runA")
    os.remove(p)  # collected out-of-band before GC runs

    counts = reg.gc_offloads("runB", grace_s=0.0)
    assert counts["missing"] == 1 and counts["deleted"] == 0
    dead = reg.lookup(status="deleted")
    assert len(dead) == 1 and dead[0].get("note") == "already_missing"

    # Idempotent: tombstoned entries are skipped, nothing raises.
    counts2 = reg.gc_offloads("runB", grace_s=0.0)
    assert counts2 == {"deleted": 0, "missing": 0, "failed": 0, "kept": 0}


def test_gc_kind_scoping(shared_dir):
    p1 = _make_offload(shared_dir, "task.md")
    p2 = _make_offload(shared_dir, "obs.md")
    reg.register_offload(p1, "t", kind="task_output", run_id="runA")
    reg.register_offload(p2, "o", kind="obs_step", run_id="runA")
    counts = reg.gc_offloads("runB", grace_s=0.0, kinds=("task_output",))
    assert counts["deleted"] == 1 and counts["kept"] == 1
    assert not os.path.exists(p1)
    assert os.path.exists(p2)


def test_run_id_contextvar_default_is_process_scoped(shared_dir):
    token = reg._run_id_var.set(None)
    try:
        rid = reg.current_run_id()
        assert rid == f"{os.getpid()}-{int(reg._PROCESS_START_TS)}"
    finally:
        reg._run_id_var.reset(token)
    reg.set_run_id("explicit")
    assert reg.current_run_id() == "explicit"


def test_windows_path_normcase_dedupe(shared_dir, monkeypatch):
    # On Windows os.path.normcase lower-cases; emulate it so C:\X vs c:\x
    # collapse to one logical entry.
    monkeypatch.setattr(os.path, "normcase", lambda s: s.lower())
    p = _make_offload(shared_dir, "MiXeD.md")
    reg.register_offload(str(p), "v1", kind="obs_step")
    reg.register_offload(str(p).lower(), "v2", kind="obs_step")
    entries = reg.lookup(status=None)
    assert len(entries) == 1
    assert entries[0]["content_sha"] != ""


def test_permission_error_delete_failed_then_retry(shared_dir):
    locked = shared_dir / "locked"
    locked.mkdir()
    p = _make_offload(locked, "held.md")
    reg.register_offload(p, "payload", kind="log_artifact", run_id="runA")

    os.chmod(locked, stat.S_IRUSR | stat.S_IXUSR)  # no write → unlink fails
    try:
        counts = reg.gc_offloads("runB", grace_s=0.0)
    finally:
        os.chmod(locked, 0o755)
    assert counts["failed"] == 1
    failed = reg.lookup(status="delete_failed")
    assert len(failed) == 1
    assert os.path.exists(p)

    # Next GC retries the delete_failed entry and succeeds.
    counts2 = reg.gc_offloads("runB", grace_s=0.0)
    assert counts2["deleted"] == 1
    assert not os.path.exists(p)
    assert reg.lookup(status="delete_failed") == []
    assert len(reg.lookup(status="deleted")) == 1


def test_register_readonly_shared_dir_is_nonfatal(shared_dir):
    os.chmod(shared_dir, stat.S_IRUSR | stat.S_IXUSR)
    try:
        reg.register_offload(str(shared_dir / "x.md"), "c", kind="obs_step")  # no raise
    finally:
        os.chmod(shared_dir, 0o755)
    assert reg.lookup() == []


def test_compaction_keeps_live_and_young_tombstones(shared_dir, monkeypatch):
    live_p = _make_offload(shared_dir, "live.md")
    reg.register_offload(live_p, "keep", kind="obs_step", run_id="runA")

    # An expired tombstone (older than the TTL) and a young one.
    now = time.time()
    old_tomb = {
        "path": str(shared_dir / "old_dead.md"), "content_sha": "0" * 16,
        "created_ts": now - reg._TOMBSTONE_TTL_S - 100, "run_id": "runX",
        "kind": "obs_step", "status": "deleted",
        "deleted_ts": now - reg._TOMBSTONE_TTL_S - 50,
    }
    young_tomb = {
        "path": str(shared_dir / "young_dead.md"), "content_sha": "1" * 16,
        "created_ts": now - 10, "run_id": "runX",
        "kind": "obs_step", "status": "deleted", "deleted_ts": now - 5,
    }
    with open(reg.registry_path(), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(old_tomb) + "\n")
        fh.write(json.dumps(young_tomb) + "\n")

    reg.compact_registry()
    lines = reg.registry_path().read_text(encoding="utf-8").splitlines()
    parsed = [json.loads(line) for line in lines if line.strip()]
    statuses = {(e["path"], e["status"]) for e in parsed}
    assert (os.path.abspath(live_p), "live") in statuses
    assert (young_tomb["path"], "deleted") in statuses
    assert all(e["path"] != old_tomb["path"] for e in parsed)


def test_gc_triggers_compaction_over_max_entries(shared_dir, monkeypatch):
    monkeypatch.setattr(reg, "_REGISTRY_MAX_ENTRIES", 5)
    paths = []
    for i in range(8):
        p = _make_offload(shared_dir, f"f{i}.md", f"c{i}")
        reg.register_offload(p, f"c{i}", kind="obs_step", run_id="runA")
        paths.append(p)
    reg.gc_offloads("runB", grace_s=0.0)  # 8 deletions → 16 lines > 5 → compact
    lines = [
        line for line in
        reg.registry_path().read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    # Compacted: one current entry (tombstone) per path, not the full log.
    assert len(lines) == 8
    assert all(json.loads(line)["status"] == "deleted" for line in lines)


def test_binary_garbage_line_skipped_not_quarantined(shared_dir):
    """Non-UTF8 garbage bytes mid-registry poison only their own line.

    Regression: strict-UTF8 reads raised UnicodeDecodeError, which the
    wholesale-corruption handler treated as an unreadable registry —
    quarantining every live entry and leaking their files forever.
    """
    paths = []
    for i in range(3):
        p = _make_offload(shared_dir, f"g{i}.md", f"g{i}")
        reg.register_offload(p, f"g{i}", kind="obs_step", run_id="runA")
        paths.append(p)
    with open(reg.registry_path(), "ab") as fh:
        fh.write(b"\xff\xfe\x00garbage\x80\n")

    assert len(reg.lookup(kind="obs_step")) == 3  # no quarantine
    counts = reg.gc_offloads("runB", grace_s=0.0)  # compaction check survives too
    assert counts["deleted"] == 3
    assert all(not os.path.exists(p) for p in paths)
    assert not list(shared_dir.glob("*.corrupt-*"))


def test_collect_paths_owner_initiated(shared_dir):
    """collect_paths ignores run identity and grace: the caller owns the files."""
    own = _make_offload(shared_dir, "own.md", "mine")
    reg.register_offload(own, "mine", kind="task_output", run_id="test-run")
    ghost = str(shared_dir / "ghost.md")  # registered never / already gone
    unregistered = _make_offload(shared_dir, "unreg.md", "lost-entry")

    counts = reg.collect_paths([own, ghost, unregistered])
    assert counts == {"deleted": 2, "missing": 1, "failed": 0, "kept": 0}
    assert not os.path.exists(own) and not os.path.exists(unregistered)
    tombs = reg.lookup(kind="task_output", status="deleted")
    assert len(tombs) == 3  # ghost + unregistered got synthesized tombstones
    assert any(t.get("note") == "unregistered_at_collect" for t in tombs)
    # Idempotent: already-tombstoned entries are kept, not re-deleted.
    assert reg.collect_paths([own])["kept"] == 1
