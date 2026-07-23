"""In-flight coalescing: concurrent identical batches share exactly one encode.

The duplicate-batch LRU only helps AFTER a batch completes; these tests pin
the concurrent case observed in live traces — client retries arriving while
the original batch is still computing.
"""

from __future__ import annotations

import threading

import pytest

from conftest import make_engine
from vinv_embedder import engine as engine_mod
from vinv_embedder.engine import EncodeAbandoned


@pytest.fixture(autouse=True)
def _fast_poll(monkeypatch):
    """Shrink the liveness poll so abandon paths run in milliseconds."""
    monkeypatch.setattr(engine_mod, "WAIT_POLL_S", 0.01)


def _gate_encode(eng, exc: Exception | None = None):
    """Make the fake model's encode block until `release` is set.

    Returns (started, release, orig): `started` fires when encode is entered,
    `orig` is the unwrapped bound method (still records calls) for restoring.
    """
    started, release = threading.Event(), threading.Event()
    orig = eng._model.encode

    def gated(texts, **kwargs):
        started.set()
        assert release.wait(timeout=10), "test gate never released"
        if exc is not None:
            raise exc
        return orig(texts, **kwargs)

    eng._model.encode = gated
    return started, release, orig


def _run_threads(fn, n):
    """Run fn in n threads; return (results, errors) lists."""
    results: list = []
    errors: list = []

    def worker():
        try:
            results.append(fn())
        except Exception as e:  # noqa: BLE001 - tests inspect the exception
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    return threads, results, errors


def test_concurrent_identical_batches_encode_once(monkeypatch, fake_model):
    # Cache disabled: proves coalescing itself, not the completed-batch LRU.
    monkeypatch.setenv("VINV_EMBED_CACHE", "0")
    eng = make_engine(monkeypatch, device="cpu")
    started, release, _ = _gate_encode(eng)
    texts = ["def a(): pass", "def b(): pass"]

    # should_abandon is only polled while a request is actually waiting, so a
    # fired event proves each follower registered on the in-flight slot.
    polled = [threading.Event() for _ in range(3)]
    results: list = []
    errors: list = []

    def run(sab=None):
        try:
            results.append(eng.embed(texts, should_abandon=sab))
        except Exception as e:  # noqa: BLE001 - tests inspect the exception
            errors.append(e)

    def make_sab(i):
        def sab():
            polled[i].set()
            return False

        return sab

    leader = threading.Thread(target=run)
    leader.start()
    assert started.wait(timeout=10)  # leader is inside encode

    followers = [threading.Thread(target=run, args=(make_sab(i),)) for i in range(3)]
    for t in followers:
        t.start()
    for ev in polled:
        assert ev.wait(timeout=10), "follower never started polling (not waiting?)"
    release.set()
    leader.join(timeout=10)
    for t in followers:
        t.join(timeout=10)

    assert errors == []
    assert len(results) == 4
    # Exactly one encode for four identical concurrent requests.
    assert len(fake_model.encode_calls) == 1
    assert fake_model.encode_calls[0]["n"] == 2


def test_followers_get_leader_result(monkeypatch, fake_model):
    monkeypatch.setenv("VINV_EMBED_CACHE", "0")
    eng = make_engine(monkeypatch, device="cpu")
    started, release, _ = _gate_encode(eng)
    texts = ["hello world"]
    polled = threading.Event()

    def sab():
        polled.set()
        return False

    threads, results, errors = _run_threads(
        lambda: eng.embed(texts, should_abandon=sab), 2
    )
    threads[0].start()
    assert started.wait(timeout=10)
    threads[1].start()
    assert polled.wait(timeout=10)
    release.set()
    for t in threads:
        t.join(timeout=10)

    assert errors == []
    assert len(results) == 2
    assert (results[0] == results[1]).all()
    assert len(fake_model.encode_calls) == 1


def test_leader_failure_propagates_and_slot_clears(monkeypatch, fake_model):
    monkeypatch.setenv("VINV_EMBED_CACHE", "0")
    eng = make_engine(monkeypatch, device="cpu")
    boom = RuntimeError("encode blew up")
    started, release, orig = _gate_encode(eng, exc=boom)
    texts = ["fail me"]
    polled = threading.Event()

    def sab():
        polled.set()
        return False

    leader, l_results, l_errors = _run_threads(lambda: eng.embed(texts), 1)
    leader[0].start()
    assert started.wait(timeout=10)
    follower, f_results, f_errors = _run_threads(
        lambda: eng.embed(texts, should_abandon=sab), 1
    )
    follower[0].start()
    assert polled.wait(timeout=10)  # follower is waiting on the slot
    release.set()
    leader[0].join(timeout=10)
    follower[0].join(timeout=10)

    # Both the leader and the coalesced waiter see the failure.
    assert len(l_errors) == 1 and l_errors[0] is boom
    assert len(f_errors) == 1 and f_errors[0] is boom
    assert l_results == [] and f_results == []

    # Slot cleared on failure: a later retry re-encodes (and succeeds).
    # (The gated encode raised before reaching the recording stub, so the
    # only recorded call is the retry's real encode.)
    eng._model.encode = orig
    out = eng.embed(texts)
    assert out.shape[0] == 1
    assert len(fake_model.encode_calls) == 1  # the retry actually re-encoded


def test_dead_follower_abandons_coalesce_wait(monkeypatch, fake_model):
    monkeypatch.setenv("VINV_EMBED_CACHE", "0")
    eng = make_engine(monkeypatch, device="cpu")
    started, release, _ = _gate_encode(eng)
    texts = ["long batch"]

    leader, _, l_errors = _run_threads(lambda: eng.embed(texts), 1)
    leader[0].start()
    assert started.wait(timeout=10)
    # Follower whose client is already gone: must stop waiting, not queue.
    with pytest.raises(EncodeAbandoned):
        eng.embed(texts, should_abandon=lambda: True)
    release.set()
    leader[0].join(timeout=10)

    assert l_errors == []  # the live leader is unaffected
    assert len(fake_model.encode_calls) == 1  # dead follower never encoded


def test_dead_waiter_abandons_encode_lock_wait(monkeypatch, fake_model):
    """Different content: the waiter queues on the encode lock, then abandons."""
    eng = make_engine(monkeypatch, device="cpu")
    started, release, _ = _gate_encode(eng)

    leader, _, l_errors = _run_threads(lambda: eng.embed(["occupies the lock"]), 1)
    leader[0].start()
    assert started.wait(timeout=10)
    with pytest.raises(EncodeAbandoned):
        eng.embed(["different content"], should_abandon=lambda: True)
    release.set()
    leader[0].join(timeout=10)

    assert l_errors == []
    assert len(fake_model.encode_calls) == 1  # only the leader encoded


def test_follower_takes_over_when_leader_abandons(monkeypatch, fake_model):
    """Leader dies while queued for the lock: a live follower re-leads, not errors."""
    monkeypatch.setenv("VINV_EMBED_CACHE", "0")
    eng = make_engine(monkeypatch, device="cpu")
    started, release, _ = _gate_encode(eng)
    texts = ["contested content"]

    # An unrelated encode occupies the lock so the leader for `texts` waits.
    blocker, _, b_errors = _run_threads(lambda: eng.embed(["blocker"]), 1)
    blocker[0].start()
    assert started.wait(timeout=10)

    follower_waiting = threading.Event()

    def dead_sab():
        # Stay "alive" until the live follower is provably waiting on the
        # slot, so the takeover path (stale EncodeAbandoned in the slot) runs.
        return follower_waiting.is_set()

    def live_sab():
        follower_waiting.set()
        return False

    dead, _, d_errors = _run_threads(
        lambda: eng.embed(texts, should_abandon=dead_sab), 1
    )
    dead[0].start()
    live, l_results, l_errors = _run_threads(
        lambda: eng.embed(texts, should_abandon=live_sab), 1
    )
    live[0].start()
    dead[0].join(timeout=10)  # abandons once the follower is waiting
    release.set()
    blocker[0].join(timeout=10)
    live[0].join(timeout=10)

    assert len(d_errors) == 1 and isinstance(d_errors[0], EncodeAbandoned)
    assert b_errors == [] and l_errors == []
    assert len(l_results) == 1 and l_results[0].shape[0] == 1
    # blocker + the follower-turned-leader encode; the dead leader never did.
    assert len(fake_model.encode_calls) == 2
