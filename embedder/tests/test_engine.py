"""Engine robustness: OOM retry, MPS fallback, pool crash recovery.

Uses the FakeModel from conftest — no downloads, no network, no real model.
"""

from __future__ import annotations

import numpy as np
import pytest

from vinv_embedder import config
from vinv_embedder.engine import _is_mps_op_failure, _is_oom

from conftest import fake_vectors, make_engine


class TestBasicEncode:
    def test_embeds_exactly_what_it_receives(self, monkeypatch, fake_model):
        eng = make_engine(monkeypatch, device="cpu")
        out = eng.embed(["abc", "defgh"])
        assert np.allclose(out, fake_vectors(["abc", "defgh"]))
        # no prefix logic server-side: the stub saw the raw strings
        assert fake_model.encode_calls[0]["n"] == 2

    def test_load_passes_pinned_revision_and_trust(self, monkeypatch, fake_model):
        eng = make_engine(monkeypatch, device="cpu")
        kw = fake_model.init_kwargs
        assert kw["trust_remote_code"] is True
        assert kw["revision"] == config.DEFAULT_REVISION
        assert kw["cache_folder"] == str(config.models_dir())
        assert eng.model_name == config.DEFAULT_MODEL


class TestOOMRetry:
    def test_halves_batch_once_and_succeeds(self, monkeypatch, fake_model):
        eng = make_engine(monkeypatch, device="cpu")
        fake_model.raise_plan.append(RuntimeError("CUDA out of memory. Tried to allocate"))
        out = eng.embed(["a", "b", "c"])
        assert out.shape[0] == 3
        batches = [c["batch_size"] for c in fake_model.encode_calls]
        assert batches == [eng.batch_size, max(1, eng.batch_size // 2)]

    def test_floor_is_one(self, monkeypatch, fake_model):
        monkeypatch.setenv("VINV_EMBED_BATCH", "4")
        eng = make_engine(monkeypatch, device="cpu")
        fake_model.raise_plan.extend(RuntimeError("MPS backend out of memory") for _ in range(2))
        out = eng.embed(["x"])
        assert out.shape[0] == 1
        assert [c["batch_size"] for c in fake_model.encode_calls] == [4, 2, 1]

    def test_oom_at_batch_one_propagates(self, monkeypatch, fake_model):
        monkeypatch.setenv("VINV_EMBED_BATCH", "1")
        eng = make_engine(monkeypatch, device="cpu")
        fake_model.raise_plan.append(RuntimeError("CUDA out of memory"))
        with pytest.raises(RuntimeError, match="out of memory"):
            eng.embed(["x"])

    def test_non_oom_error_propagates(self, monkeypatch, fake_model):
        eng = make_engine(monkeypatch, device="cpu")
        fake_model.raise_plan.append(ValueError("boom"))
        with pytest.raises(ValueError, match="boom"):
            eng.embed(["x"])


class TestMPSFallback:
    def _mps_engine(self, monkeypatch, fake_model):
        return make_engine(monkeypatch, device="mps")

    def test_op_failure_falls_back_to_cpu_for_request(self, monkeypatch, fake_model):
        eng = self._mps_engine(monkeypatch, fake_model)
        fake_model.raise_plan.append(
            RuntimeError("The operator 'aten::foo' is not currently implemented for the MPS device")
        )
        out = eng.embed(["hello"])
        assert out.shape[0] == 1
        # second call was the CPU fallback
        assert fake_model.encode_calls[-1]["device"] == "cpu"
        assert eng.device == "mps"  # not permanent yet

    def test_three_failures_switch_to_cpu_permanently(self, monkeypatch, fake_model):
        eng = self._mps_engine(monkeypatch, fake_model)
        for i in range(config.MPS_FAILURE_LIMIT):
            fake_model.raise_plan.append(RuntimeError("MPS: op not implemented"))
            # Distinct batches: identical retries are (correctly) served from
            # the duplicate-batch cache and never reach the device.
            eng.embed([f"hello {i}"])
        assert eng.device == "cpu"
        assert eng.batch_size == config.CPU_BATCH

    def test_mps_oom_is_retried_not_fallback(self, monkeypatch, fake_model):
        eng = self._mps_engine(monkeypatch, fake_model)
        fake_model.raise_plan.append(RuntimeError("MPS backend out of memory"))
        eng.embed(["hello"])
        assert eng.device == "mps"
        assert eng._mps_failures == 0  # handled by OOM retry, not fallback


class TestPoolRecovery:
    def _pooled_engine(self, monkeypatch, fake_model):
        monkeypatch.setenv("VINV_EMBED_WORKERS", "2")
        monkeypatch.setenv("VINV_EMBED_MP_THRESHOLD", "4")
        return make_engine(monkeypatch, device="cpu")

    def test_large_cpu_request_uses_pool(self, monkeypatch, fake_model):
        eng = self._pooled_engine(monkeypatch, fake_model)
        texts = ["t"] * 5
        out = eng.embed(texts)
        assert out.shape[0] == 5
        assert len(fake_model.mp_calls) == 1
        assert fake_model.mp_calls[0]["pool"]["devices"] == ["cpu", "cpu"]
        assert not fake_model.encode_calls  # did not go single-process

    def test_small_request_stays_single_process(self, monkeypatch, fake_model):
        eng = self._pooled_engine(monkeypatch, fake_model)
        eng.embed(["a", "b"])
        assert not fake_model.mp_calls
        assert len(fake_model.encode_calls) == 1

    def test_pool_crash_rebuilds_once(self, monkeypatch, fake_model):
        eng = self._pooled_engine(monkeypatch, fake_model)
        fake_model.bad_pool_gens.add(1)  # first pool always crashes
        out = eng.embed(["t"] * 6)
        assert out.shape[0] == 6
        pools_used = [c["pool"]["gen"] for c in fake_model.mp_calls]
        assert pools_used == [1, 2]
        assert fake_model.stopped_pools[0]["gen"] == 1
        assert not eng._pool_degraded

    def test_double_pool_failure_degrades_to_single_process(self, monkeypatch, fake_model):
        eng = self._pooled_engine(monkeypatch, fake_model)
        fake_model.bad_pool_gens.update({1, 2})
        out = eng.embed(["t"] * 6)
        assert out.shape[0] == 6
        assert eng._pool_degraded
        assert len(fake_model.encode_calls) == 1  # served single-process
        # subsequent large requests skip the pool entirely
        eng.embed(["t"] * 8)
        assert len(fake_model.mp_calls) == 2  # no new pool attempts
        assert len(fake_model.encode_calls) == 2

    def test_close_stops_pool(self, monkeypatch, fake_model):
        eng = self._pooled_engine(monkeypatch, fake_model)
        eng.embed(["t"] * 5)
        eng.close()
        assert fake_model.stopped_pools


class TestFirstBatchWarmup:
    """Silent multi-minute first-batch stall on MPS: the engine must announce
    the warmup, expose a `warming` flag while it runs, and log the elapsed time."""

    def _spy_warming(self, monkeypatch, eng):
        flags: list[bool] = []
        model = eng._model
        real_encode = model.encode

        def spying_encode(texts, **kwargs):
            flags.append(eng.warming)
            return real_encode(texts, **kwargs)

        monkeypatch.setattr(model, "encode", spying_encode)
        return flags

    def test_warming_flag_lifecycle_on_mps(self, monkeypatch, fake_model, caplog):
        import logging

        eng = make_engine(monkeypatch, device="mps")
        flags = self._spy_warming(monkeypatch, eng)
        assert eng.warming is False
        with caplog.at_level(logging.INFO, logger="vinv_embedder"):
            eng.embed(["a"])
        assert flags == [True]  # warming was True while the first encode ran
        assert eng.warming is False  # and cleared afterwards
        msgs = [r.getMessage() for r in caplog.records]
        assert any("first batch on mps" in m and "not hung" in m for m in msgs)
        assert any("first batch on mps completed in" in m for m in msgs)

        caplog.clear()
        with caplog.at_level(logging.INFO, logger="vinv_embedder"):
            eng.embed(["b"])
        assert flags == [True, False]  # second encode is not a warmup
        assert not any("first batch" in r.getMessage() for r in caplog.records)

    def test_cpu_first_encode_has_no_warmup_banner(self, monkeypatch, fake_model, caplog):
        import logging

        eng = make_engine(monkeypatch, device="cpu")
        flags = self._spy_warming(monkeypatch, eng)
        with caplog.at_level(logging.INFO, logger="vinv_embedder"):
            eng.embed(["a"])
        assert flags == [True]
        msgs = [r.getMessage() for r in caplog.records]
        assert not any("not hung" in m for m in msgs)  # banner is for non-cpu devices
        assert any("first batch on cpu completed in" in m for m in msgs)

    def test_failed_first_encode_clears_flag_and_stays_unwarmed(
        self, monkeypatch, fake_model
    ):
        eng = make_engine(monkeypatch, device="cpu")
        fake_model.raise_plan.append(ValueError("boom"))
        with pytest.raises(ValueError):
            eng.embed(["a"])
        assert eng.warming is False
        assert "cpu" not in eng._warmed_devices  # next encode is still "first"
        eng.embed(["b"])
        assert "cpu" in eng._warmed_devices

    def test_device_switch_warms_again(self, monkeypatch, fake_model):
        """After the MPS→CPU permanent fallback, the CPU first batch is tracked
        per-device (fresh kernels), not inherited from the MPS warmup."""
        eng = make_engine(monkeypatch, device="mps")
        eng.embed(["a"])
        assert eng._warmed_devices == {"mps"}
        eng.device = "cpu"  # what _mps_cpu_fallback does at the failure limit
        eng.embed(["b"])
        assert eng._warmed_devices == {"mps", "cpu"}


class TestErrorClassifiers:
    def test_is_oom(self):
        assert _is_oom(RuntimeError("CUDA out of memory"))
        assert _is_oom(RuntimeError("MPS backend out of memory"))
        assert not _is_oom(RuntimeError("something else"))

    def test_is_mps_op_failure(self):
        assert _is_mps_op_failure(RuntimeError("not implemented for the MPS device"))
        assert _is_mps_op_failure(NotImplementedError("MPS: aten::foo"))
        assert not _is_mps_op_failure(RuntimeError("MPS backend out of memory"))  # OOM
        assert not _is_mps_op_failure(ValueError("mps whatever"))
