"""Device selection and batch policy — no real torch behavior required."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from vinv_embedder import config


def _fake_torch(cuda: bool = False, mps: bool = False, free_vram: int = 0):
    return SimpleNamespace(
        cuda=SimpleNamespace(
            is_available=lambda: cuda,
            mem_get_info=lambda: (free_vram, free_vram * 2),
        ),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps)),
    )


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for var in (
        "VINV_EMBED_DEVICE",
        "VINV_EMBED_BATCH",
        "VINV_EMBED_WORKERS",
        "VINV_EMBED_MP_THRESHOLD",
        "VINV_EMBED_REVISION",
        "VINV_EMBED_TRUST_REMOTE_CODE",
    ):
        monkeypatch.delenv(var, raising=False)
    # Isolated home, never deleted: unsetting VINV_HOME would resolve to the
    # developer's real ~/.vinv, whose tune verdict flips device expectations.
    monkeypatch.setenv("VINV_HOME", str(tmp_path / "vinv-home"))


class TestDetectDevice:
    def test_cuda_wins(self, monkeypatch):
        monkeypatch.setattr(config, "_torch", lambda: _fake_torch(cuda=True, mps=True))
        assert config.detect_device("auto") == "cuda"

    def test_mps_second(self, monkeypatch):
        monkeypatch.setattr(config, "_torch", lambda: _fake_torch(mps=True))
        assert config.detect_device("auto") == "mps"

    def test_cpu_fallback(self, monkeypatch):
        monkeypatch.setattr(config, "_torch", lambda: _fake_torch())
        assert config.detect_device("auto") == "cpu"

    def test_explicit_preference_skips_detection(self, monkeypatch):
        monkeypatch.setattr(config, "_torch", lambda: 1 / 0)  # must not be called
        assert config.detect_device("cpu") == "cpu"

    def test_env_override_beats_preference(self, monkeypatch):
        monkeypatch.setenv("VINV_EMBED_DEVICE", "cpu")
        monkeypatch.setattr(config, "_torch", lambda: 1 / 0)
        assert config.detect_device("cuda") == "cpu"


class TestBatchPolicy:
    def test_cuda_vram_table(self, monkeypatch):
        cases = [
            (24 << 30, 512),
            (12 << 30, 256),
            (8 << 30, 128),
            (4 << 30, 64),
            (2 << 30, config.CUDA_FALLBACK_BATCH),
        ]
        for free, expected in cases:
            monkeypatch.setattr(
                config, "_torch", lambda f=free: _fake_torch(cuda=True, free_vram=f)
            )
            assert config.batch_size_for("cuda") == expected, hex(free)

    def test_cuda_meminfo_failure_uses_fallback(self, monkeypatch):
        def broken():
            raise RuntimeError("no cuda")

        monkeypatch.setattr(config, "_torch", broken)
        assert config.batch_size_for("cuda") == config.CUDA_FALLBACK_BATCH

    def test_mps_and_cpu_constants(self):
        assert config.batch_size_for("mps") == config.MPS_BATCH
        assert config.batch_size_for("cpu") == config.CPU_BATCH

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("VINV_EMBED_BATCH", "7")
        assert config.batch_size_for("cuda") == 7
        assert config.batch_size_for("cpu") == 7


class TestWorkersAndThresholds:
    def test_worker_count_default_is_conservative(self, monkeypatch):
        # Safe margin: ~half the cores, hard-capped at 4 — the machine also
        # runs the editor, services, and the coding agent.
        monkeypatch.setattr("os.cpu_count", lambda: 10)
        assert config.worker_count() == 4
        monkeypatch.setattr("os.cpu_count", lambda: 6)
        assert config.worker_count() == 2

    def test_worker_count_floor_one(self, monkeypatch):
        monkeypatch.setattr("os.cpu_count", lambda: 2)
        assert config.worker_count() == 1

    def test_worker_env_override(self, monkeypatch):
        monkeypatch.setenv("VINV_EMBED_WORKERS", "3")
        assert config.worker_count() == 3

    def test_mp_threshold_override(self, monkeypatch):
        assert config.mp_threshold() == config.DEFAULT_MP_THRESHOLD
        monkeypatch.setenv("VINV_EMBED_MP_THRESHOLD", "10")
        assert config.mp_threshold() == 10


class TestRevisionAndTrust:
    CODERANK = "nomic-ai/CodeRankEmbed"

    def test_default_model_unpinned_and_untrusted(self):
        # The default (granite, native ModernBERT) needs no pin and no remote code.
        assert config.revision_for(config.DEFAULT_MODEL) is None
        assert config.trust_remote_code_for(config.DEFAULT_MODEL) is False

    def test_coderank_override_pinned_and_trusted(self):
        # The optional CodeRankEmbed override ships custom modeling code.
        assert config.revision_for(self.CODERANK) is not None
        assert config.trust_remote_code_for(self.CODERANK) is True

    def test_other_model_unpinned(self):
        assert config.revision_for("some/other-model") is None

    def test_env_revision_override(self, monkeypatch):
        monkeypatch.setenv("VINV_EMBED_REVISION", "deadbeef")
        assert config.revision_for(config.DEFAULT_MODEL) == "deadbeef"

    def test_trust_remote_code_env_optin(self, monkeypatch):
        assert config.trust_remote_code_for("some/other-model") is False
        monkeypatch.setenv("VINV_EMBED_TRUST_REMOTE_CODE", "1")
        assert config.trust_remote_code_for("some/other-model") is True

    def test_vinv_home_honored(self, monkeypatch, tmp_path):
        monkeypatch.setenv("VINV_HOME", str(tmp_path / "vh"))
        assert config.models_dir() == tmp_path / "vh" / "models"
