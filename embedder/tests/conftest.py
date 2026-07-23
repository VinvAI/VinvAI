"""Shared fixtures: a fake SentenceTransformer so tests never touch the network."""

from __future__ import annotations

import numpy as np
import pytest

from vinv_embedder import engine as engine_mod
from vinv_embedder.engine import EmbeddingEngine

DIM = 8


@pytest.fixture(autouse=True)
def _isolated_vinv_home(monkeypatch, tmp_path):
    """Every test gets a private VINV_HOME — never the developer's real one.

    Without this, a real tune verdict at ~/.vinv/embedder_tuned.json leaks
    into device-selection tests and flips their expectations.
    """
    monkeypatch.setenv("VINV_HOME", str(tmp_path / "vinv-home"))


def fake_vectors(texts: list[str]) -> np.ndarray:
    """Deterministic per-text vectors: [len(t), len(t)+1, ...]."""
    return np.array(
        [[float(len(t) + j) for j in range(DIM)] for t in texts], dtype=np.float32
    )


class FakeModel:
    """Stub SentenceTransformer. Records every encode call's kwargs."""

    def __init__(self, *args, **kwargs):
        self.init_args = args
        self.init_kwargs = kwargs
        self.encode_calls: list[dict] = []
        self.raise_plan: list[Exception] = []  # popped once per encode call
        self.pool_gen = 0
        self.bad_pool_gens: set[int] = set()
        self.mp_calls: list[dict] = []
        self.stopped_pools: list[dict] = []

    def encode(self, texts, **kwargs):
        self.encode_calls.append({"n": len(texts), **kwargs})
        if self.raise_plan:
            raise self.raise_plan.pop(0)
        return fake_vectors(list(texts))

    def start_multi_process_pool(self, target_devices=None):
        self.pool_gen += 1
        return {"gen": self.pool_gen, "devices": target_devices}

    def stop_multi_process_pool(self, pool):
        self.stopped_pools.append(pool)

    def encode_multi_process(self, texts, pool, **kwargs):
        self.mp_calls.append({"n": len(texts), "pool": pool, **kwargs})
        if pool["gen"] in self.bad_pool_gens:
            raise RuntimeError("worker process died unexpectedly")
        return fake_vectors(list(texts))


@pytest.fixture
def fake_model(monkeypatch) -> FakeModel:
    """Patch the lazy import so EmbeddingEngine.load() builds a FakeModel."""
    holder: dict = {}

    class _Cls:
        def __new__(cls, *args, **kwargs):
            m = FakeModel(*args, **kwargs)
            holder["model"] = m
            return m

    monkeypatch.setattr(engine_mod, "_sentence_transformer_cls", lambda: _Cls)
    # Return a proxy that resolves to the constructed model after load().
    proxy = FakeModel()
    holder["model"] = proxy

    class _Handle:
        def __getattr__(self, name):
            return getattr(holder["model"], name)

    return _Handle()  # type: ignore[return-value]


def make_engine(monkeypatch, device: str = "cpu", **kwargs) -> EmbeddingEngine:
    """Build an engine on the fake model without touching real torch."""
    monkeypatch.setenv("VINV_EMBED_DEVICE", device)
    eng = EmbeddingEngine(**kwargs)
    eng.load()
    return eng
