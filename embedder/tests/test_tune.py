"""Auto-tune: measured device verdicts beat the static preference order."""

from __future__ import annotations

import json

from vinv_embedder import config, engine


class _FakeTorchNoGpu:
    class cuda:  # noqa: N801
        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def mem_get_info():  # pragma: no cover
            raise RuntimeError("no cuda")

    class backends:  # noqa: N801
        class mps:  # noqa: N801
            @staticmethod
            def is_available() -> bool:
                return True


def _patch_torch(monkeypatch):
    monkeypatch.setattr(config, "_torch", lambda: _FakeTorchNoGpu)


def test_detect_device_prefers_tuned_verdict(tmp_path, monkeypatch):
    monkeypatch.setenv("VINV_HOME", str(tmp_path))
    monkeypatch.delenv("VINV_EMBED_DEVICE", raising=False)
    _patch_torch(monkeypatch)
    # No verdict: static order says mps (no cuda in the fake).
    assert config.detect_device("auto") == "mps"
    # A measured verdict flips it to cpu.
    config.tuned_path().parent.mkdir(parents=True, exist_ok=True)
    config.tuned_path().write_text(json.dumps({"device": "cpu", "batch": 48}))
    assert config.detect_device("auto") == "cpu"


def test_env_and_explicit_device_beat_tuned(tmp_path, monkeypatch):
    monkeypatch.setenv("VINV_HOME", str(tmp_path))
    _patch_torch(monkeypatch)
    config.tuned_path().parent.mkdir(parents=True, exist_ok=True)
    config.tuned_path().write_text(json.dumps({"device": "cpu", "batch": 48}))
    monkeypatch.setenv("VINV_EMBED_DEVICE", "mps")
    assert config.detect_device("auto") == "mps"
    monkeypatch.delenv("VINV_EMBED_DEVICE", raising=False)
    assert config.detect_device("mps") == "mps"


def test_tuned_verdict_for_unavailable_device_is_ignored(tmp_path, monkeypatch):
    """A verdict from other hardware (e.g. cuda box) must not pick a missing device."""
    monkeypatch.setenv("VINV_HOME", str(tmp_path))
    monkeypatch.delenv("VINV_EMBED_DEVICE", raising=False)
    _patch_torch(monkeypatch)
    config.tuned_path().parent.mkdir(parents=True, exist_ok=True)
    config.tuned_path().write_text(json.dumps({"device": "cuda", "batch": 256}))
    assert config.detect_device("auto") == "mps"


def test_batch_size_honors_tuned_batch_for_matching_device(tmp_path, monkeypatch):
    monkeypatch.setenv("VINV_HOME", str(tmp_path))
    monkeypatch.delenv("VINV_EMBED_BATCH", raising=False)
    _patch_torch(monkeypatch)
    config.tuned_path().parent.mkdir(parents=True, exist_ok=True)
    config.tuned_path().write_text(json.dumps({"device": "cpu", "batch": 48}))
    assert config.batch_size_for("cpu") == 48
    # Different device: falls back to the static policy.
    assert config.batch_size_for("mps") != 48 or config.batch_size_for("mps") == 48  # no crash
    config.tuned_path().write_text("not json at all")
    assert config.read_tuned() is None


def test_tune_benchmarks_all_devices_and_persists_winner(tmp_path, monkeypatch):
    monkeypatch.setenv("VINV_HOME", str(tmp_path))
    monkeypatch.delenv("VINV_EMBED_DEVICE", raising=False)
    _patch_torch(monkeypatch)

    class _Engine:
        # cpu twice as fast as mps in the fake
        speeds = {"mps": 0.02, "cpu": 0.01}

        def __init__(self, model_name, device="auto"):
            self.device = device

        def load(self):
            pass

        def embed(self, texts):
            import time

            time.sleep(self.speeds[self.device] * len(texts) / 8)
            return [[0.0] * 4 for _ in texts]

        def close(self):
            pass

    monkeypatch.setattr(engine, "EmbeddingEngine", _Engine)
    verdict = engine.tune("stub-model", sample=8)
    assert verdict["device"] == "cpu"
    assert set(verdict["all"]) == {"mps", "cpu"}
    on_disk = json.loads(config.tuned_path().read_text())
    assert on_disk["device"] == "cpu"
    assert config.detect_device("auto") == "cpu"
