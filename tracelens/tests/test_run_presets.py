"""Preset resolution for `tracelens run` (standard by default, overridable per-axis).

All collection now flows through the AST-rewrite path, so the only preset axes are
``memory`` (per-function memory attribution) and ``determinism`` (clock/RNG capture).
The CPU/alloc/gc/rss sampler and eBPF second-trace have been removed.
"""

from __future__ import annotations

import pytest

from tracelens.launcher.run import _parse_run_flags

_USER = ["python", "-m", "myapp"]


def _resolve(pre: list[str]) -> tuple[bool, bool]:
    (_out, _t, _s, _na, _cap, _fork, memory, determinism) = _parse_run_flags(
        pre, user_command=_USER
    )
    return memory, determinism


def test_default_is_standard_and_latency_honest(monkeypatch: pytest.MonkeyPatch) -> None:
    """Standard keeps tracemalloc OFF: its allocation hook taxes the USER's own
    code inside the timed window (unlike enrichment, which wrap_call keeps
    outside the perf-counter pair), so a latency-honest default cannot carry it.
    Memory-focused capture opts in via --memory / TRACELENS_PRESET=memory."""
    for var in ("TRACELENS_PRESET", "TRACELENS_MEMORY", "TRACELENS_CAPTURE_DETERMINISM"):
        monkeypatch.delenv(var, raising=False)
    memory, determinism = _resolve(["-o", "trace.jsonl", "-t", "myapp"])
    assert memory is False
    assert determinism is False


def test_memory_preset_retains_full_tracemalloc(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRACELENS_PRESET", "memory")
    monkeypatch.delenv("TRACELENS_MEMORY", raising=False)
    monkeypatch.delenv("TRACELENS_CAPTURE_DETERMINISM", raising=False)
    memory, determinism = _resolve(["-t", "myapp"])
    assert memory is True
    assert determinism is False


def test_minimal_turns_extra_axes_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRACELENS_MEMORY", raising=False)
    monkeypatch.delenv("TRACELENS_CAPTURE_DETERMINISM", raising=False)
    memory, determinism = _resolve(["-t", "myapp", "--minimal"])
    assert memory is False
    assert determinism is False


def test_full_enables_both_axes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRACELENS_MEMORY", raising=False)
    memory, determinism = _resolve(["-t", "myapp", "--full"])
    assert memory is True
    assert determinism is True


def test_granular_flag_overrides_preset_per_axis(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRACELENS_MEMORY", raising=False)
    monkeypatch.delenv("TRACELENS_CAPTURE_DETERMINISM", raising=False)
    # standard, but re-enable memory individually (the memory-preset axes via a flag)
    memory, determinism = _resolve(["-t", "myapp", "--memory", "--no-capture-determinism"])
    assert memory is True
    assert determinism is False


def test_minimal_then_reenable_memory(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRACELENS_MEMORY", raising=False)
    monkeypatch.delenv("TRACELENS_CAPTURE_DETERMINISM", raising=False)
    memory, determinism = _resolve(["-t", "myapp", "--minimal", "--memory"])
    assert memory is True  # memory axis overridden back on
    assert determinism is False  # determinism still off from minimal


def test_env_preset_respected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRACELENS_PRESET", "minimal")
    monkeypatch.delenv("TRACELENS_MEMORY", raising=False)
    monkeypatch.delenv("TRACELENS_CAPTURE_DETERMINISM", raising=False)
    memory, determinism = _resolve(["-t", "myapp"])
    assert (memory, determinism) == (False, False)


def test_env_memory_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRACELENS_PRESET", raising=False)
    monkeypatch.delenv("TRACELENS_CAPTURE_DETERMINISM", raising=False)
    monkeypatch.setenv("TRACELENS_MEMORY", "1")
    memory, _determinism = _resolve(["-t", "myapp"])
    assert memory is True  # env override beats standard preset default
