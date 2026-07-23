"""SharedScratchpad blackboard behavior + dormancy pin (spec scenarios 5–7).

Covers cursor-delta reads through the real ``VinvEngineReAct`` polling hook,
the pinned dormancy contract (a ``BaseSwarmAgent``-constructed engine has no
scratchpad and an always-empty delta), the 240k background-compression
trigger with a stubbed ``smart_fit``, three-tier render eviction, and the
clear/clear_goal_scoped → task_output GC hook.  Thresholds come from the
class constants (``_BLACKBOARD_COMPRESS_TRIGGER_CHARS``,
``_TASK_OUTPUT_OFFLOAD_CHARS``) — never re-hardcoded.
"""

from __future__ import annotations

import asyncio
import os

import dspy
import pytest

from core.components.agents.base_agent import BaseSwarmAgent
from core.components.agents.vinv_engine_react import VinvEngineReAct
from core.components.common import offload_registry as reg
from core.components.hero.models import (
    AgentMessage,
    CommunicationType,
    SharedScratchpad,
)


@pytest.fixture()
def shared_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("VINV_ENGINE_SHARED_DIR", str(tmp_path))
    reg.set_run_id("bb-run")
    return tmp_path


def _noop_tool() -> str:
    """Stub tool."""
    return "ok"


def _insight(sender: str, text: str, receiver: str = "*") -> AgentMessage:
    return AgentMessage(
        sender=sender, receiver=receiver,
        message_type=CommunicationType.INSIGHT, insight=text,
    )


# ---------------------------------------------------------------------------
# Scenario 5 — cursor-delta correctness + dormancy pin
# ---------------------------------------------------------------------------

def test_cursor_delta_only_new_messages_and_self_filtered(shared_dir):
    sp = SharedScratchpad()
    engine = VinvEngineReAct(
        dspy.Signature("instruction -> answer"),
        tools=[_noop_tool], max_iters=1, scratchpad=sp,
    )
    engine._agent_name = "B"

    sp.add_message(_insight("A", "first finding"))
    delta1 = engine._poll_blackboard_delta()
    assert "first finding" in delta1 and "from A" in delta1

    # Second poll with no new messages: cursor advanced, delta empty.
    assert engine._poll_blackboard_delta() == ""

    # Self-sent and foreign-receiver messages are filtered out of the delta.
    sp.add_message(_insight("B", "my own note"))
    sp.add_message(_insight("A", "not for B", receiver="C"))
    assert engine._poll_blackboard_delta() == ""

    # New foreign message arrives → exactly that one message.
    sp.add_message(_insight("A", "second finding"))
    delta2 = engine._poll_blackboard_delta()
    assert "second finding" in delta2 and "first finding" not in delta2

    # Cursor is monotone non-decreasing across polls.
    assert engine._bb_cursor == len(sp.messages)


def test_async_read_new_messages_cursor(shared_dir):
    async def run():
        sp = SharedScratchpad()
        await sp.async_add_message(_insight("A", "one"))
        msgs, cur = await sp.async_read_new_messages("B", 0)
        assert [m.insight for m in msgs] == ["one"]
        await sp.async_add_message(_insight("A", "two"))
        msgs2, cur2 = await sp.async_read_new_messages("B", cur)
        assert [m.insight for m in msgs2] == ["two"]
        assert cur2 > cur
        msgs3, _ = await sp.async_read_new_messages("B", cur2)
        assert msgs3 == []
    asyncio.run(run())


class _PinSignature(dspy.Signature):
    """Minimal signature for the dormancy pin agent."""

    instruction: str = dspy.InputField()
    answer: str = dspy.OutputField()


class _PinAgent(BaseSwarmAgent):
    AGENT_NAME = "DormancyPinAgent"
    SIGNATURE_CLASS = _PinSignature
    TOOLS = [_noop_tool]


def test_dormancy_pin_base_agent_engine_has_no_scratchpad(shared_dir):
    """Pin: BaseSwarmAgent constructs its engine WITHOUT scratchpad wiring.

    This is the adjudicated dormancy contract — if someone wires a scratchpad
    (or an agent name) into the single-agent runtime, this test fails and the
    change must be re-adjudicated.
    """
    agent = _PinAgent(max_iters=1)
    assert agent.generate._scratchpad is None
    assert agent.generate._shared_context is None
    assert agent.generate._agent_name is None
    # Both delta gates fail → provably always the empty string.
    assert agent.generate._poll_blackboard_delta() == ""


# ---------------------------------------------------------------------------
# Scenario 6 — 240k compression trigger with synthetic payload
# ---------------------------------------------------------------------------

def _big_dict_msg(sender: str, mtype: CommunicationType, chars: int) -> AgentMessage:
    return AgentMessage(
        sender=sender, receiver="*", message_type=mtype,
        content={"message": "y" * chars},
    )


def test_compression_trigger_fires_only_over_threshold(shared_dir, monkeypatch):
    import core.components.context_compressor as cc

    calls = []

    async def _fake_smart_fit(raw, max_chars=None, purpose="", **kwargs):
        calls.append((len(raw), max_chars, purpose))
        return raw[:max_chars]

    monkeypatch.setattr(cc, "smart_fit", _fake_smart_fit)

    async def run():
        sp = SharedScratchpad()
        sp._bb_compress_task = None
        trigger = sp._BLACKBOARD_COMPRESS_TRIGGER_CHARS
        chunk = trigger // 3

        # Stay just UNDER the trigger → no background task.
        await sp.async_add_message(
            _big_dict_msg("A", CommunicationType.INSIGHT, chunk)
        )
        await sp.async_add_message(
            _big_dict_msg("A", CommunicationType.KNOWLEDGE_SHARE, chunk)
        )
        assert sp._bb_compress_task is None

        # Critical payloads count toward the total but must never be compressed.
        await sp.async_add_message(
            _big_dict_msg("A", CommunicationType.TASK_OUTPUT, chunk)
        )
        await sp.async_add_message(
            _big_dict_msg("A", CommunicationType.FILE_DELIVERY, chunk)
        )
        # Push OVER the trigger → task fires.
        await sp.async_add_message(
            _big_dict_msg("A", CommunicationType.BROADCAST, chunk)
        )
        assert sp._bb_compress_task is not None
        await sp._bb_compress_task

        by_type = {}
        for m in sp.messages:
            by_type.setdefault(m.message_type, []).append(m)

        # Non-critical messages were compressed in place and flagged.
        for mtype in (
            CommunicationType.INSIGHT,
            CommunicationType.KNOWLEDGE_SHARE,
            CommunicationType.BROADCAST,
        ):
            (m,) = by_type[mtype]
            assert getattr(m, "_bb_compressed", False) is True
            assert len(m.content["message"]) < chunk

        # TASK_OUTPUT / FILE_DELIVERY never compressed.
        for mtype in (
            CommunicationType.TASK_OUTPUT,
            CommunicationType.FILE_DELIVERY,
        ):
            (m,) = by_type[mtype]
            assert not getattr(m, "_bb_compressed", False)
            assert len(m.content["message"]) == chunk

        assert calls, "stubbed smart_fit was never invoked"

        # Re-trigger while a task is in flight does NOT double-fire.
        in_flight = asyncio.ensure_future(asyncio.sleep(5))
        sp._bb_compress_task = in_flight
        await sp._maybe_compress_blackboard()
        assert sp._bb_compress_task is in_flight
        in_flight.cancel()
        try:
            await in_flight
        except asyncio.CancelledError:
            pass

    asyncio.run(run())


# ---------------------------------------------------------------------------
# Scenario 7 — three-tier render eviction
# ---------------------------------------------------------------------------

def _summary_msg(
    sender: str, mtype: CommunicationType, tag: str,
    chars: int = 1500, task_id: str | None = None,
) -> AgentMessage:
    return AgentMessage(
        sender=sender, receiver="*", message_type=mtype,
        content={"summary": f"[{tag}]" + "s" * chars},
        task_id=task_id,
    )


def test_eviction_tiers_trimmable_then_dep_protected_never_critical(shared_dir):
    sp = SharedScratchpad()
    for i in range(6):
        sp.add_message(_summary_msg("A", CommunicationType.INSIGHT, f"trim{i}"))
    for i in range(3):
        sp.add_message(_summary_msg(
            "A", CommunicationType.TOOL_RESULT, f"dep{i}", task_id="dep-task",
        ))
    sp.add_message(_summary_msg(
        "A", CommunicationType.TASK_OUTPUT, "critical0", task_id="crit-task",
    ))
    sp.set_pending_dependency_ids({"dep-task"})

    # Loose budget: only trimmable messages go; dep-protected + critical stay.
    mid = sp.get_blackboard_content_sync("X", max_chars=8000)
    assert "[critical0]" in mid
    assert "[dep0]" in mid
    assert "[trim0]" not in mid

    # Tight budget: dep-protected go too; critical NEVER trimmed even though
    # the result stays over budget (only critical remain).
    tight = sp.get_blackboard_content_sync("X", max_chars=1000)
    assert "[critical0]" in tight
    assert "[dep0]" not in tight and "[trim5]" not in tight

    # Budget respected whenever anything non-critical remains.
    assert len(mid) <= 8000 or "[dep0]" not in mid


# ---------------------------------------------------------------------------
# clear / clear_goal_scoped → run-boundary GC of task_output offloads
# ---------------------------------------------------------------------------

def _offload_via_task_output(sp: SharedScratchpad, task_id: str) -> str:
    big = {"data": "q" * (sp._TASK_OUTPUT_OFFLOAD_CHARS + 1000)}
    sp.add_task_output(task_id, f"task {task_id}", "actor", big)
    (msg,) = [m for m in sp.messages if m.task_id == task_id]
    path = msg.output_data["_offloaded_path"]
    assert os.path.exists(path)
    return path


def test_clear_collects_prior_run_task_output_offloads(shared_dir):
    sp = SharedScratchpad()
    reg.set_run_id("old-run")
    path = _offload_via_task_output(sp, "t-old")
    assert len(reg.lookup(kind="task_output")) == 1

    # Blackboard clear at the next run boundary: grace waived for task_output.
    reg.set_run_id("new-run")
    sp.clear()
    assert sp.messages == []
    assert not os.path.exists(path)
    assert reg.lookup(kind="task_output") == []
    assert len(reg.lookup(kind="task_output", status="deleted")) == 1


def test_clear_goal_scoped_also_collects(shared_dir):
    sp = SharedScratchpad()
    reg.set_run_id("old-run")
    path = _offload_via_task_output(sp, "t-goal")
    reg.set_run_id("new-run")
    sp.clear_goal_scoped(current_goal="next goal")
    assert not os.path.exists(path)
    assert len(reg.lookup(kind="task_output", status="deleted")) == 1


def test_async_clear_collects(shared_dir):
    async def run():
        sp = SharedScratchpad()
        reg.set_run_id("old-run")
        big = {"data": "q" * (sp._TASK_OUTPUT_OFFLOAD_CHARS + 1000)}
        await sp.async_add_task_output("t-async", "task", "actor", big)
        (msg,) = sp.messages
        path = msg.output_data["_offloaded_path"]
        assert os.path.exists(path)
        reg.set_run_id("new-run")
        await sp.async_clear()
        assert not os.path.exists(path)
        assert len(reg.lookup(kind="task_output", status="deleted")) == 1
    asyncio.run(run())


def test_clear_gc_spares_non_task_output_kinds(shared_dir):
    """A blackboard clear must not touch obs_step/log_artifact offloads."""
    sp = SharedScratchpad()
    reg.set_run_id("old-run")
    obs = shared_dir / "obs_step_old_0.md"
    obs.write_text("observation", encoding="utf-8")
    reg.register_offload(str(obs), "observation", kind="obs_step")
    reg.set_run_id("new-run")
    sp.clear()
    assert obs.exists()
    assert len(reg.lookup(kind="obs_step")) == 1


def test_midrun_clear_collects_own_offloads_without_rebind(shared_dir):
    """clear() collects this instance's files even when run_id never changed.

    Regression: the old run-id-based GC kept own-run entries, so a mid-run
    clear() (same run identity) collected nothing and leaked every offload.
    """
    sp = SharedScratchpad()
    path = _offload_via_task_output(sp, "t-midrun")
    sp.clear()
    assert not os.path.exists(path)
    assert len(reg.lookup(kind="task_output", status="deleted")) == 1


def test_clear_spares_concurrent_foreign_runs_offloads(shared_dir):
    """clear() must never touch a concurrently-live foreign run's files.

    Regression: the old zero-grace foreign-run GC deleted another live
    process's task_output offloads out from under its pointers.
    """
    foreign = shared_dir / "task_output_foreign.md"
    foreign.write_text("# Task Output: foreign\n\nF", encoding="utf-8")
    reg.register_offload(str(foreign), "F", kind="task_output", run_id="other-live-run")

    sp = SharedScratchpad()
    own = _offload_via_task_output(sp, "t-own")
    sp.clear()
    assert not os.path.exists(own)          # own file collected
    assert foreign.exists()                 # concurrent run untouched
    assert len(reg.lookup(kind="task_output")) == 1  # foreign entry still live


def test_task_output_offload_with_lone_surrogates(shared_dir):
    """Surrogate-bearing task names/content must not break the offload write."""
    sp = SharedScratchpad()
    junk = b"binary \xff\xfe name".decode("utf-8", "surrogateescape")
    big = {"data": junk + "q" * (sp._TASK_OUTPUT_OFFLOAD_CHARS + 1000)}
    sp.add_task_output("t-sur", f"task {junk}", "actor", big)
    (msg,) = [m for m in sp.messages if m.task_id == "t-sur"]
    assert msg.output_data.get("_offloaded") is True
    assert os.path.exists(msg.output_data["_offloaded_path"])
