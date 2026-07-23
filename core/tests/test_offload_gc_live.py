"""Live offload round-trips + run-boundary GC (spec scenarios 1–3).

Drives the REAL runtime paths — a real ``VinvEngineReAct`` step loop with a
stub LM head and an oversized tool observation, and the real terminal
``_bounded_output`` → ``digest_with_artifact`` pipeline — against a tmp
``VINV_ENGINE_SHARED_DIR``.  No thresholds are re-hardcoded: every limit comes
from the module constants (``_OBS_PERSIST_THRESHOLD``,
``VINV_ENGINE_TERMINAL_INLINE_OUTPUT_TOKENS``).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import dspy
import pytest

from core.components.agents.vinv_engine_react import (
    _OBS_PERSIST_THRESHOLD,
    VinvEngineReAct,
    cap_large_observation,
)
from core.components.common import offload_registry as reg
from core.components.tools.terminal import terminal_tools


@pytest.fixture()
def shared_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("VINV_ENGINE_SHARED_DIR", str(tmp_path))
    monkeypatch.delenv("VINV_ENGINE_ARTIFACT_DIR", raising=False)
    reg.set_run_id("live-run")
    return tmp_path


class _StubHead:
    """Stands in for the ReAct predict/extract heads (no LLM needed)."""

    def __init__(self, predictions):
        self._preds = list(predictions)

    def __call__(self, **kwargs):
        return self._preds.pop(0)


_BIG_OBS = "OBS-PAYLOAD-" + ("z" * (_OBS_PERSIST_THRESHOLD + 4321))


def _big_tool() -> str:
    """Stub tool returning an oversized observation."""
    return _BIG_OBS


def test_offload_roundtrip_through_real_react_step(shared_dir):
    """Scenario 1: engine step → obs persisted, preview injected, indexed."""
    engine = VinvEngineReAct(
        dspy.Signature("instruction -> answer"), tools=[_big_tool], max_iters=3,
    )
    engine.react = _StubHead([
        dspy.Prediction(
            next_thought="call the big tool",
            next_tool_name="_big_tool",
            next_tool_args={},
        ),
        dspy.Prediction(
            next_thought="done", next_tool_name="finish", next_tool_args={},
        ),
    ])
    engine.extract = _StubHead([dspy.Prediction(answer="ok")])

    result = engine.forward(instruction="fetch the payload")

    obs = result.trajectory["observation_0"]
    assert "<persisted-output>" in obs
    m = re.search(r"Full output saved to: (\S+)", obs)
    assert m, f"no persisted path in observation: {obs[:300]}"
    persist_path = m.group(1)

    # Filename is run-id-keyed: kills the cross-run obs_step_{idx} overwrite bug.
    assert os.path.basename(persist_path).startswith("obs_step_live-run_0")
    assert Path(persist_path).parent == shared_dir

    # Byte-identical round-trip of the pre-preview observation.
    on_disk = Path(persist_path).read_text(encoding="utf-8")
    header, _, body = on_disk.partition("\n\n")
    assert header == "# Observation Step 0"
    assert body == _BIG_OBS

    # Registry has a live entry with a matching content hash.
    entries = reg.lookup(kind="obs_step")
    assert len(entries) == 1
    import hashlib
    assert entries[0]["content_sha"] == hashlib.sha256(
        _BIG_OBS.encode("utf-8", "replace")
    ).hexdigest()[:16]
    assert entries[0]["run_id"] == "live-run"


def test_small_observation_not_persisted(shared_dir):
    traj = {"observation_0": "tiny"}
    assert cap_large_observation(traj, 0) is False
    assert traj["observation_0"] == "tiny"
    assert reg.lookup(kind="obs_step") == []


def test_terminal_artifact_roundtrip(shared_dir):
    """Scenario 2: real _bounded_output digest path + artifact + registry."""
    threshold = int(os.environ.get(
        "VINV_ENGINE_TERMINAL_INLINE_OUTPUT_TOKENS", "4000"
    ))
    # Enough numbered lines to overshoot the inline token threshold by far
    # (mirrors `seq 1 200000`-style scrollback floods).
    full_output = "\n".join(f"line {i}: some terminal output" for i in range(threshold * 3))

    result = terminal_tools._bounded_output(
        {"status": "success", "output": full_output}, "terminal-cmd",
    )

    assert result["output"] != full_output
    assert "[LARGE OUTPUT — STORED AS ARTIFACT]" in result["output"]
    log_path = result["output_log"]
    assert log_path and os.path.exists(log_path)
    # cwd-scatter fix: the fallback artifact dir lives under the shared dir.
    assert Path(log_path).is_relative_to(shared_dir)
    # Full content preserved byte-identical.
    assert Path(log_path).read_text(encoding="utf-8") == full_output
    assert result["output_tokens_full"] > threshold

    entries = reg.lookup(kind="log_artifact")
    assert len(entries) == 1
    assert os.path.samefile(entries[0]["path"], log_path)


def test_gc_across_run_boundary(shared_dir):
    """Scenario 3: run B collects run A's aged offloads; B's stay; idempotent."""
    # Run A writes an offload through the real cap path.
    reg.set_run_id("runA")
    traj_a = {"observation_0": "A" * (_OBS_PERSIST_THRESHOLD + 100)}
    assert cap_large_observation(traj_a, 0) is True
    a_path = re.search(r"Full output saved to: (\S+)", traj_a["observation_0"]).group(1)
    assert os.path.exists(a_path)

    # Run B starts: bind identity, write its own offload, then GC (grace
    # simulated as elapsed by grace_s=0 — equivalent to rewriting created_ts).
    reg.set_run_id("runB")
    traj_b = {"observation_0": "B" * (_OBS_PERSIST_THRESHOLD + 100)}
    assert cap_large_observation(traj_b, 0) is True
    b_path = re.search(r"Full output saved to: (\S+)", traj_b["observation_0"]).group(1)

    counts = reg.gc_offloads(reg.current_run_id(), grace_s=0.0)
    assert counts["deleted"] == 1
    assert not os.path.exists(a_path)
    assert os.path.exists(b_path)

    dead = reg.lookup(status="deleted")
    assert len(dead) == 1
    assert dead[0]["deleted_ts"] > 0
    assert os.path.abspath(a_path) == dead[0]["path"]

    # Idempotent re-run: nothing left to do, no exception.
    counts2 = reg.gc_offloads(reg.current_run_id(), grace_s=0.0)
    assert counts2["deleted"] == 0 and counts2["missing"] == 0

    live = reg.lookup(kind="obs_step")
    assert [e["run_id"] for e in live] == ["runB"]


def test_distinct_runs_no_longer_overwrite_same_step_index(shared_dir):
    """The cross-run obs_step_{idx}.md overwrite bug is dead."""
    reg.set_run_id("first")
    t1 = {"observation_3": "X" * (_OBS_PERSIST_THRESHOLD + 1)}
    cap_large_observation(t1, 3)
    reg.set_run_id("second")
    t2 = {"observation_3": "Y" * (_OBS_PERSIST_THRESHOLD + 1)}
    cap_large_observation(t2, 3)

    p1 = re.search(r"Full output saved to: (\S+)", t1["observation_3"]).group(1)
    p2 = re.search(r"Full output saved to: (\S+)", t2["observation_3"]).group(1)
    assert p1 != p2
    assert Path(p1).read_text(encoding="utf-8").endswith("X" * 100)
    assert Path(p2).read_text(encoding="utf-8").endswith("Y" * 100)


def test_cap_large_observation_lone_surrogates_no_crash(shared_dir):
    """Surrogateescape-decoded terminal output must persist, not raise.

    Regression: strict-UTF8 write raised UnicodeEncodeError (not OSError),
    escaping the guard and breaking the live tool call.
    """
    raw = b"binary \xff\xfe output " * 4000
    obs = raw.decode("utf-8", "surrogateescape")
    trajectory = {"observation_0": obs}
    assert cap_large_observation(trajectory, 0, threshold=1000, preview_chars=200)
    assert "<persisted-output>" in trajectory["observation_0"]
    m = re.search(r"saved to: (\S+)", trajectory["observation_0"])
    assert m and os.path.exists(m.group(1))
    assert len(reg.lookup(kind="obs_step")) == 1
