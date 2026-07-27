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


def test_both_arms_of_every_conditional_are_recorded(tmp_path: Path) -> None:
    """Flipping a condition must earn coverage — the exploration gradient.

    `classify` has two conditionals; the three calls decide each of them BOTH
    ways, so four distinct (src, dst) arms exist. Returning sys.monitoring
    DISABLE from on_branch used to retire the whole conditional after its first
    arm, recording 2 of 4: an input that flipped a condition scored zero new
    coverage and the bandit lost its reason to explore.

    Before 3.14 both outcomes share one BRANCH event at one instruction, and
    DISABLE is keyed by instruction — which is exactly why 3.14 split the event.
    The sibling uniqueness test cannot catch this: it is trivially satisfied
    when only one arm per branch is ever recorded.
    """
    rows = _run_target(tmp_path, calls=[-5, 0, 7])
    hits = [h for r in rows for h in r["hits"]]
    arms = {(h["src"], h["dst"]) for h in hits}
    by_line: dict[int, set[int]] = {}
    for h in hits:
        by_line.setdefault(h["line"], set()).add(h["dst"])
    assert len(arms) == 4, f"expected 4 distinct arms across 2 conditionals, got {sorted(arms)}"
    for line in (2, 4):
        assert (
            len(by_line.get(line, set())) == 2
        ), f"line {line} must record BOTH outcomes, got {by_line.get(line)}"


def test_repeated_calls_do_not_duplicate_arms_without_disable(tmp_path: Path) -> None:
    """Dedupe still holds when DISABLE is not used to enforce it."""
    rows = _run_target(tmp_path, calls=[-5, 0, 7] * 20)
    hits = [h for r in rows for h in r["hits"]]
    arms = [(h["file"], h["src"], h["dst"]) for h in hits]
    assert len(arms) == len(set(arms)) == 4


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


def test_the_targeting_cache_is_keyed_on_the_file_not_the_object_address(tmp_path: Path) -> None:
    """COR-17: `id(code)` is reused after garbage collection.

    Nothing held a reference to the code objects, so a recycled address
    inherited the previous object's decision — instrumenting non-target code
    (inflating the reward) or skipping target code, both silently and
    nondeterministically. The decision depends only on the filename, so the
    cache must be keyed there.
    """
    mon, tool_id = _acquire_tool_id()
    recorder = _BranchRecorder(mon, tool_id, str(tmp_path / "t.jsonl"), (str(tmp_path),))
    try:
        inside = compile("x = 1", str(tmp_path / "a.py"), "exec")
        outside = compile("x = 1", "/elsewhere/b.py", "exec")
        assert recorder._wants(inside) is True
        assert recorder._wants(outside) is False
        # Keys are filenames, so the cache cannot be poisoned by address reuse.
        assert set(recorder._decided) == {str(tmp_path / "a.py"), "/elsewhere/b.py"}
        # A DIFFERENT code object from the same file reuses the same decision.
        again = compile("y = 2", str(tmp_path / "a.py"), "exec")
        assert recorder._wants(again) is True
        assert len(recorder._decided) == 2, "one entry per file, not per code object"
    finally:
        mon.free_tool_id(tool_id)


def test_line_lookup_is_keyed_on_stable_code_identity(tmp_path: Path) -> None:
    """COR-17, the worse half: stale linestarts give WRONG line numbers.

    A recycled address inheriting another function's line table produces
    branch_hits pointing at the wrong source lines — nondeterministic coverage
    that reads as a defect in the target.
    """
    mon, tool_id = _acquire_tool_id()
    recorder = _BranchRecorder(mon, tool_id, str(tmp_path / "t.jsonl"), (str(tmp_path),))
    try:
        src = "def f(n):\n    if n:\n        return 1\n    return 0\n"
        code = compile(src, str(tmp_path / "m.py"), "exec")
        fn = next(c for c in code.co_consts if hasattr(c, "co_code"))
        assert recorder._line_of(fn, 0) == fn.co_firstlineno
        key = (fn.co_filename, fn.co_firstlineno, len(fn.co_code))
        assert key in recorder._lines, "keyed on stable identity, never id()"
        assert all(isinstance(k, tuple) for k in recorder._lines)
    finally:
        mon.free_tool_id(tool_id)
