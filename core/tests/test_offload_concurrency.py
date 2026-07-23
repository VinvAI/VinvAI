"""Concurrency: parallel async writers + thread-pool registry storm (scenario 8).

50 concurrent ``async_add_task_output`` calls (each above the offload
threshold) racing a thread pool hammering ``register_offload``, then GC under
a concurrent writer.  Asserts: no lost messages, no lost files, zero torn
JSONL lines, no deadlock, and GC only collects aged foreign-run entries.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from core.components.common import offload_registry as reg
from core.components.hero.models import SharedScratchpad

_N_TASKS = 50
_N_THREAD_REGS = 40


@pytest.fixture()
def shared_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("VINV_ENGINE_SHARED_DIR", str(tmp_path))
    reg.set_run_id("conc-run")
    return tmp_path


def test_parallel_writers_no_torn_lines_no_lost_messages(shared_dir):
    sp = SharedScratchpad()
    payload_chars = sp._TASK_OUTPUT_OFFLOAD_CHARS + 1000

    thread_paths = [str(shared_dir / f"threaded_{i}.log") for i in range(_N_THREAD_REGS)]

    def _thread_register(i: int) -> None:
        # Real artifact-style registration racing the async writers.
        with open(thread_paths[i], "w", encoding="utf-8") as fh:
            fh.write(f"artifact {i}")
        reg.register_offload(thread_paths[i], f"artifact {i}", kind="log_artifact")

    async def run():
        loop = asyncio.get_running_loop()
        with ThreadPoolExecutor(max_workers=8) as pool:
            thread_futs = [
                loop.run_in_executor(pool, _thread_register, i)
                for i in range(_N_THREAD_REGS)
            ]
            await asyncio.gather(
                *[
                    sp.async_add_task_output(
                        f"task-{i}", f"task {i}", "actor",
                        {"data": f"{i}:" + "z" * payload_chars},
                    )
                    for i in range(_N_TASKS)
                ],
                *thread_futs,
            )

    asyncio.run(run())

    # No lost messages, every output offloaded to its own file.
    assert len(sp.messages) == _N_TASKS
    offload_paths = {m.output_data["_offloaded_path"] for m in sp.messages}
    assert len(offload_paths) == _N_TASKS
    assert all(os.path.exists(p) for p in offload_paths)

    # Zero torn JSONL lines: every raw line parses.
    raw_lines = [
        line for line in
        reg.registry_path().read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    parsed = [json.loads(line) for line in raw_lines]
    assert len(parsed) == _N_TASKS + _N_THREAD_REGS

    assert len(reg.lookup(kind="task_output")) == _N_TASKS
    assert len(reg.lookup(kind="log_artifact")) == _N_THREAD_REGS


def test_gc_under_concurrent_writer_deletes_only_aged_entries(shared_dir):
    # Aged foreign-run entries (files on disk).
    old_paths = []
    for i in range(10):
        p = shared_dir / f"old_{i}.md"
        p.write_text("old", encoding="utf-8")
        reg.register_offload(str(p), "old", kind="obs_step", run_id="finished-run")
        old_paths.append(p)

    stop = threading.Event()
    written: list[str] = []

    def _writer():
        i = 0
        while not stop.is_set():
            p = shared_dir / f"live_{i}.md"
            p.write_text("live", encoding="utf-8")
            reg.register_offload(str(p), "live", kind="obs_step", run_id="conc-run")
            written.append(str(p))
            i += 1

    t = threading.Thread(target=_writer)
    t.start()
    try:
        counts = reg.gc_offloads("conc-run", grace_s=0.0)
    finally:
        stop.set()
        t.join(timeout=10)
    assert not t.is_alive(), "GC deadlocked against a concurrent writer"

    # Exactly the aged foreign entries were collected...
    assert counts["deleted"] == 10
    assert all(not p.exists() for p in old_paths)
    # ...and none of the active run's files were touched, even with grace 0.
    assert all(os.path.exists(p) for p in written)
    live = reg.lookup(kind="obs_step")
    assert {e["run_id"] for e in live} == {"conc-run"}
    assert len(live) == len(written)

    # Registry still fully parseable after the race.
    for line in reg.registry_path().read_text(encoding="utf-8").splitlines():
        if line.strip():
            json.loads(line)
