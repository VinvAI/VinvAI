"""Branch coverage via sys.monitoring (monitoring_hook._BranchRecorder).

Gap G3 of the 2026-07-27 exploration audit: coverage was function-entry only,
so a "newly covered" reward saturates after one call per function. These tests
drive the real PEP 669 machinery (3.12+) against a throwaway target module and
assert the two properties the reward loop needs: branch ARMS are recorded with
file/line/offsets, and recording is FIRST-HIT-ONLY (monotone, then silent).
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

from tracelens.launcher.monitoring_hook import _BranchRecorder

pytestmark = pytest.mark.skipif(
    sys.version_info < (3, 12) or not hasattr(sys, "monitoring"),
    reason="sys.monitoring requires Python 3.12+",
)

_TARGET_SRC = """\
def classify(n):
    if n < 0:
        return "negative"
    if n == 0:
        return "zero"
    return "positive"
"""


def _acquire_tool_id():
    mon = sys.monitoring
    for tid in (mon.COVERAGE_ID, mon.PROFILER_ID, mon.OPTIMIZER_ID, mon.DEBUGGER_ID):
        try:
            mon.use_tool_id(tid, "tracelens-test")
            return mon, tid
        except ValueError:
            continue
    pytest.skip("no free sys.monitoring tool id")


def _run_target(tmp_path: Path, calls: list[int]) -> list[dict]:
    """Install a recorder over a fresh target module, call it, return the lines."""
    target = tmp_path / "target_mod.py"
    target.write_text(_TARGET_SRC, encoding="utf-8")
    out = tmp_path / "trace.jsonl"
    mon, tool_id = _acquire_tool_id()
    recorder = _BranchRecorder(mon, tool_id, str(out), (str(tmp_path),))
    recorder.install()
    try:
        code = compile(target.read_text(encoding="utf-8"), str(target), "exec")
        mod = types.ModuleType("target_mod")
        exec(code, mod.__dict__)
        for n in calls:
            mod.classify(n)
        recorder.stop()
    finally:
        mon.set_events(tool_id, 0)
        mon.free_tool_id(tool_id)
    if not out.exists():
        return []
    return [json.loads(ln) for ln in out.read_text(encoding="utf-8").splitlines() if ln]


def test_branch_arms_are_recorded_with_location(tmp_path: Path) -> None:
    rows = _run_target(tmp_path, calls=[-5, 0, 7])
    assert rows, "branch_hits lines must be written"
    assert all(r["event"] == "branch_hits" for r in rows)
    hits = [h for r in rows for h in r["hits"]]
    assert hits
    target_file = str(tmp_path / "target_mod.py")
    assert all(h["file"] == target_file for h in hits)
    # Both conditionals were decided both ways across the three calls: the
    # recorder must have seen arms on at least the two `if` lines.
    lines = {h["line"] for h in hits}
    assert {2, 4} <= lines
    for h in hits:
        assert isinstance(h["src"], int) and isinstance(h["dst"], int)


def test_first_hit_only_arms_never_repeat(tmp_path: Path) -> None:
    rows = _run_target(tmp_path, calls=[1, 1, 1, 1, 1, 1])
    hits = [h for r in rows for h in r["hits"]]
    arms = [(h["file"], h["src"], h["dst"]) for h in hits]
    assert len(arms) == len(set(arms)), "an arm is recorded once, then DISABLEd"


def test_non_target_code_is_untouched(tmp_path: Path) -> None:
    other_dir = tmp_path / "roots"
    other_dir.mkdir()
    target = tmp_path / "outside_mod.py"
    target.write_text(_TARGET_SRC, encoding="utf-8")
    out = tmp_path / "trace.jsonl"
    mon, tool_id = _acquire_tool_id()
    recorder = _BranchRecorder(mon, tool_id, str(out), (str(other_dir),))
    recorder.install()
    try:
        code = compile(target.read_text(encoding="utf-8"), str(target), "exec")
        mod = types.ModuleType("outside_mod")
        exec(code, mod.__dict__)
        mod.classify(3)
        recorder.stop()
    finally:
        mon.set_events(tool_id, 0)
        mon.free_tool_id(tool_id)
    text = out.read_text(encoding="utf-8") if out.exists() else ""
    assert str(target) not in text, "code outside the target roots must not record"
