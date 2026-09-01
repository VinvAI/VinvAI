"""Concurrency oracles: deterministic schedules and timeout injection.

The last of the P2 gaps. Probes were strictly serial ("Bounded concurrency 1"),
so a lock ordering that only deadlocks under interleaving never interleaved, and
a call that never returned stalled the whole run instead of being reported.
"""

from __future__ import annotations

from pathlib import Path

from exerciser import store
from exerciser.concurrency import classify, cluster_concurrency_findings, run_concurrency


def _make_repo(tmp_path: Path, source: str) -> Path:
    pkg = tmp_path / "conc"
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "target.py").write_text(source, encoding="utf-8")
    store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)
    return tmp_path


# ---- the classifier --------------------------------------------------------


def test_matching_shapes_are_silent():
    rows = [
        {"target": "t", "phase": "serial", "results": [{"ok": True, "value": "1"}]},
        {"target": "t", "phase": "concurrent", "results": [{"ok": True, "value": "1"}]},
    ]
    assert classify(rows) == []


def test_order_alone_is_not_a_finding():
    # Concurrency legitimately reorders; only the SHAPE must agree.
    rows = [
        {
            "target": "t",
            "phase": "serial",
            "results": [{"ok": True, "value": "a"}, {"ok": True, "value": "b"}],
        },
        {
            "target": "t",
            "phase": "concurrent",
            "results": [{"ok": True, "value": "b"}, {"ok": True, "value": "a"}],
        },
    ]
    assert classify(rows) == []


def test_a_stateful_target_returning_new_values_is_not_a_finding():
    # A counter legitimately returns 3,4 on the second batch. Comparing raw
    # values would flag every stateful target in existence.
    rows = [
        {
            "target": "t",
            "phase": "serial",
            "results": [{"ok": True, "value": "1"}, {"ok": True, "value": "2"}],
        },
        {
            "target": "t",
            "phase": "concurrent",
            "results": [{"ok": True, "value": "3"}, {"ok": True, "value": "4"}],
        },
    ]
    assert classify(rows) == []


def test_lost_updates_are_reported():
    # Two concurrent calls collapsing onto one value is the lost-update
    # signature, whatever the values are.
    rows = [
        {
            "target": "t",
            "phase": "serial",
            "results": [{"ok": True, "value": "1"}, {"ok": True, "value": "2"}],
        },
        {
            "target": "t",
            "phase": "concurrent",
            "results": [{"ok": True, "value": "3"}, {"ok": True, "value": "3"}],
        },
    ]
    (finding,) = classify(rows)
    assert finding["kind"] == "concurrency-divergence"
    assert "LOST" in finding["detail"]


def test_a_moving_serial_spread_is_not_a_lost_update():
    # The two serial batches disagree on the COUNT, so the spread is a property
    # of timing rather than of the target: a lower concurrent count proves
    # nothing and no verdict may rest on it.
    rows = [
        {
            "target": "t",
            "phase": "serial",
            "results": [{"ok": True, "value": v} for v in ("1", "2", "3")],
        },
        {
            "target": "t",
            "phase": "serial-control",
            "results": [{"ok": True, "value": v} for v in ("4", "4", "5")],
        },
        {
            "target": "t",
            "phase": "concurrent",
            "results": [{"ok": True, "value": "9"} for _ in range(3)],
        },
    ]
    assert classify(rows) == []


def test_all_distinct_serial_batches_cannot_prove_shared_state():
    # The failure the control exists for, and the one a count comparison misses:
    # a clock-derived return is all-unique inside EVERY serial batch, so the two
    # batches agree on 3 distinct while sharing no value at all. Counting alone
    # passed the control and asserted "unguarded shared state" about a target
    # that has none.
    rows = [
        {
            "target": "t",
            "phase": "serial",
            "results": [{"ok": True, "value": v} for v in ("1", "2", "3")],
        },
        {
            "target": "t",
            "phase": "serial-control",
            "results": [{"ok": True, "value": v} for v in ("4", "5", "6")],
        },
        {
            "target": "t",
            "phase": "concurrent",
            "results": [{"ok": True, "value": "7"} for _ in range(3)],
        },
    ]
    (finding,) = classify(rows)
    assert finding["kind"] == "concurrency-divergence", "the collapse is still reported"
    assert "unguarded shared state" not in finding["detail"], finding["detail"]
    assert "clock" in finding["detail"], "the other explanation must be named"


def test_a_repeated_serial_value_set_still_proves_a_lost_update():
    # Both serial batches hand back the SAME values (a pooled allocator), so the
    # count IS a property of the target and a concurrent batch that issues one
    # of them twice keeps the strong verdict.
    rows = [
        {
            "target": "t",
            "phase": "serial",
            "results": [{"ok": True, "value": v} for v in ("a", "b", "c")],
        },
        {
            "target": "t",
            "phase": "serial-control",
            "results": [{"ok": True, "value": v} for v in ("c", "a", "b")],
        },
        {
            "target": "t",
            "phase": "concurrent",
            "results": [{"ok": True, "value": v} for v in ("a", "b", "b")],
        },
    ]
    (finding,) = classify(rows)
    assert "updates were LOST" in finding["detail"], finding["detail"]


def test_exceptions_only_under_concurrency_are_reported():
    rows = [
        {"target": "t", "phase": "serial", "results": [{"ok": True, "value": "1"}]},
        {"target": "t", "phase": "concurrent", "results": [{"ok": False, "exception": "KeyError"}]},
    ]
    findings = classify(rows)
    assert any("not thread-safe" in f["detail"] for f in findings)


def test_a_timeout_outranks_a_divergence():
    rows = [
        {"target": "t", "phase": "serial", "results": [{"ok": True, "value": "1"}]},
        {
            "target": "t",
            "phase": "concurrent",
            "workers": 4,
            "timed_out": 2,
            "results": [{"ok": False, "exception": "Timeout"}],
        },
    ]
    (finding,) = classify(rows)
    assert finding["kind"] == "concurrency-hang"
    assert "did not return" in finding["detail"]


def test_repeated_divergence_is_one_bug():
    rows = [
        {
            "target": "t",
            "phase": "serial",
            "results": [{"ok": True, "value": "1"}, {"ok": True, "value": "2"}],
        },
        *[
            {
                "target": "t",
                "phase": "concurrent",
                "results": [{"ok": True, "value": "9"}, {"ok": True, "value": "9"}],
            }
            for _ in range(3)
        ],
    ]
    assert len(classify(rows)) == 1, "reproduced three times is still one finding"


def test_import_error_short_circuits():
    rows = [{"target": "t", "phase": "import", "status": "error", "error_type": "ImportError"}]
    (finding,) = classify(rows)
    assert finding["kind"] == "import-error"


def test_findings_cluster_with_evidence():
    (cluster,) = cluster_concurrency_findings(
        [{"kind": "concurrency-hang", "target": "pkg:fn", "detail": "blocked"}]
    )
    assert cluster.kind == "concurrency-hang"
    assert cluster.method == "CONC"
    assert "serial baseline" in cluster.exemplar["expected"]


# ---- end to end ------------------------------------------------------------

# Unguarded read-modify-write: correct serially, corrupt when interleaved.
_RACY = """\
import time

_state = {"n": 0}


def bump():
    n = _state["n"]
    time.sleep(0.01)          # the interleaving window
    _state["n"] = n + 1
    return _state["n"]
"""

# The same shape, guarded — must stay silent.
_GUARDED = """\
import threading
import time

_lock = threading.Lock()
_state = {"n": 0}


def bump():
    with _lock:
        n = _state["n"]
        time.sleep(0.01)
        _state["n"] = n + 1
        return _state["n"]
"""

# Serially fast, blocks forever under contention: the hang class.
_DEADLOCKY = """\
import threading

_lock = threading.Lock()


def grab():
    with _lock:
        # Re-entering a non-reentrant lock from another thread blocks; the
        # first caller holds it while every other caller waits on it.
        acquired = _lock.acquire(timeout=30)
        if acquired:
            _lock.release()
    return "ok"
"""


def test_unguarded_shared_state_diverges(tmp_path: Path):
    repo = _make_repo(tmp_path, _RACY)

    result = run_concurrency(
        repo, target="conc.target:bump", workers=4, repeats=3, call_timeout_s=5.0
    )

    kinds = {c["kind"] for c in result["clusters"]}
    assert (
        "concurrency-divergence" in kinds
    ), "an unguarded read-modify-write must diverge from the serial baseline"


def test_guarded_target_stays_silent(tmp_path: Path):
    repo = _make_repo(tmp_path, _GUARDED)

    result = run_concurrency(
        repo, target="conc.target:bump", workers=4, repeats=3, call_timeout_s=5.0
    )

    assert result["issue_clusters"] == 0, "correct locking must not be reported"


def test_blocking_under_contention_is_a_hang_not_a_stall(tmp_path: Path):
    repo = _make_repo(tmp_path, _DEADLOCKY)

    result = run_concurrency(
        repo,
        target="conc.target:grab",
        workers=4,
        repeats=1,
        call_timeout_s=1.0,
        worker_timeout_s=45.0,
    )

    kinds = {c["kind"] for c in result["clusters"]}
    assert "concurrency-hang" in kinds, f"got {result['clusters']}"


def test_unimportable_target_is_reported(tmp_path: Path):
    repo = _make_repo(tmp_path, _GUARDED)
    result = run_concurrency(repo, target="conc.nope:bump", workers=2, repeats=1)
    assert any(c["kind"] == "import-error" for c in result["clusters"])
