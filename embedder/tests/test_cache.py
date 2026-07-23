"""Duplicate-batch result cache: identical inputs never re-encode."""

from __future__ import annotations

from conftest import make_engine


def test_identical_batch_served_from_cache(monkeypatch, fake_model):
    eng = make_engine(monkeypatch, device="cpu")
    texts = ["def a(): pass", "def b(): pass"]
    first = eng.embed(texts)
    calls_after_first = len(fake_model.encode_calls)
    second = eng.embed(texts)
    assert len(fake_model.encode_calls) == calls_after_first  # no new encode
    assert (first == second).all()
    # A different batch DOES encode.
    eng.embed(["def c(): pass"])
    assert len(fake_model.encode_calls) == calls_after_first + 1


def test_cache_evicts_lru_and_can_be_disabled(monkeypatch, fake_model):
    monkeypatch.setenv("VINV_EMBED_CACHE", "1")
    eng = make_engine(monkeypatch, device="cpu")
    eng.embed(["one"])
    eng.embed(["two"])  # evicts "one" (cache size 1)
    n = len(fake_model.encode_calls)
    eng.embed(["one"])
    assert len(fake_model.encode_calls) == n + 1  # re-encoded after eviction

    monkeypatch.setenv("VINV_EMBED_CACHE", "0")
    eng2 = make_engine(monkeypatch, device="cpu")
    eng2.embed(["x"])
    m = len(fake_model.encode_calls)
    eng2.embed(["x"])
    assert len(fake_model.encode_calls) == m + 1  # disabled: always encodes
