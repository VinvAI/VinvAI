"""Embedding engine: model loading, batching, and crash recovery.

Robustness policy (see tests/test_engine.py):
  - OOM (cuda/mps): halve the batch size and retry, floor 1, logged.
  - MPS op failure (non-OOM): fall back to CPU for that request; after
    MPS_FAILURE_LIMIT recurrences, switch to CPU permanently for the session.
  - CPU multi-process pool worker crash: rebuild the pool once and retry;
    if the rebuilt pool also fails, degrade to single-process permanently.
  - The engine is stateless: safe to kill and restart at any moment
    (index-side resume owns durability).
"""

from __future__ import annotations

import hashlib
import logging
import sys
import threading
import time
from collections import OrderedDict
from typing import Any, Sequence

from . import config

logger = logging.getLogger("vinv_embedder")
if not logger.handlers:
    _h = logging.StreamHandler(sys.stderr)
    _h.setFormatter(logging.Formatter("[vinv-embedder] %(levelname)s %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)


# Poll interval while waiting for the encode lock or for an identical
# in-flight batch. Between polls the caller-supplied should_abandon() hook
# runs, so a dead client stops waiting within ~this interval.
WAIT_POLL_S = 0.25


class EncodeAbandoned(Exception):
    """The waiting request's client went away (should_abandon() returned True)."""


class _InFlight:
    """Completion holder for one in-flight content hash (see EmbeddingEngine.embed)."""

    __slots__ = ("event", "result", "exc")

    def __init__(self) -> None:
        self.event = threading.Event()
        self.result: Any = None
        self.exc: BaseException | None = None


def _sentence_transformer_cls():
    """Lazy import hook — tests monkeypatch this to avoid model downloads."""
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer


def _is_oom(exc: BaseException) -> bool:
    name = type(exc).__name__
    if name == "OutOfMemoryError":
        return True
    msg = str(exc).lower()
    return "out of memory" in msg or "mps backend out of memory" in msg


def _is_mps_op_failure(exc: BaseException) -> bool:
    """A non-OOM runtime failure that names MPS (unimplemented op, backend bug)."""
    if _is_oom(exc):
        return False
    if not isinstance(exc, (RuntimeError, NotImplementedError)):
        return False
    return "mps" in str(exc).lower()


class EmbeddingEngine:
    """Owns the SentenceTransformer model and all encode policy."""

    def __init__(self, model_name: str = config.DEFAULT_MODEL, device: str = "auto") -> None:
        self.model_name = model_name
        self.device = config.detect_device(device)
        self.batch_size = config.batch_size_for(self.device)
        self.workers = config.worker_count()
        self.mp_threshold = config.mp_threshold()
        self.normalize = config.normalize_embeddings()
        self._model: Any = None
        self._encode_lock = threading.Lock()
        self._mps_failures = 0
        self._pool: Any = None
        self._pool_degraded = False
        # First-batch warmup tracking: on mps (and cuda) the first encode after
        # load() recompiles kernels and can silently take minutes. Track which
        # devices have completed a first encode so we can announce the warmup
        # (and expose it on /health) instead of looking hung.
        self._warmed_devices: set[str] = set()
        self._warming = False
        # Duplicate-batch cache: live traces showed 83% of engine compute was
        # byte-identical batches re-sent after client deaths/retries. Keyed on
        # a content hash of the exact input list; small LRU — one entry can be
        # a whole index batch, so a handful is plenty.
        self._result_cache: "OrderedDict[str, Any]" = OrderedDict()
        self._result_cache_max = config.result_cache_size()
        # In-flight coalescing: the LRU above only helps AFTER a batch
        # completes — live traces showed identical batches queueing
        # CONCURRENTLY (client retries while the original still computes),
        # each waiting for the lock and recomputing or hitting the cache
        # late. Map of content hash -> _InFlight holder; a second request
        # with the same hash waits on the first's completion instead of
        # queueing an independent encode. Guarded by its own small mutex so
        # the check-or-register step is atomic without touching _encode_lock.
        self._inflight: dict[str, _InFlight] = {}
        self._inflight_lock = threading.Lock()

    @property
    def warming(self) -> bool:
        """True while the first encode for the current device is in flight."""
        return self._warming

    # -- lifecycle -----------------------------------------------------------

    def load(self) -> None:
        if self._model is not None:
            return
        config.apply_cache_env()
        if self.device == "cpu":
            # Safe margin: never saturate every core — the machine also runs
            # the user's editor, services, and coding agent.
            try:
                config._torch().set_num_threads(config.cpu_threads())
            except Exception:  # pragma: no cover
                pass
        cls = _sentence_transformer_cls()
        revision = config.revision_for(self.model_name)
        t0 = time.monotonic()
        logger.info(
            "loading model %s (device=%s, revision=%s)",
            self.model_name,
            self.device,
            revision or "latest",
        )
        self._model = cls(
            self.model_name,
            device=self.device,
            cache_folder=str(config.models_dir()),
            trust_remote_code=config.trust_remote_code_for(self.model_name),
            revision=revision,
        )
        # Cap the sequence length: the model default (8192 for CodeRankEmbed)
        # makes one long input pad the entire batch, which is catastrophic on
        # MPS/CPU. Index embed inputs are name + signature + docstring — 1024
        # tokens is generous headroom; measured >5x throughput at no quality
        # cost for that composition.
        max_seq = config.max_seq_length()
        if max_seq > 0:
            try:
                self._model.max_seq_length = max_seq
            except Exception:  # pragma: no cover - model without the attribute
                logger.warning("model does not expose max_seq_length; cap skipped")
        logger.info(
            "model loaded in %.1fs (batch_size=%d, max_seq=%s)",
            time.monotonic() - t0,
            self.batch_size,
            max_seq if max_seq > 0 else "model-default",
        )

    def close(self) -> None:
        self._stop_pool()

    # -- public API ----------------------------------------------------------

    def embed(self, texts: Sequence[str], should_abandon: Any = None) -> Any:
        """Embed texts exactly as received (no prefixing — that is the caller's job).

        Returns a numpy array (or list of vectors) aligned with `texts`.
        Serialized behind a lock: one encode at a time; HTTP threads queue here.

        ``should_abandon`` (optional zero-arg callable) is polled every
        WAIT_POLL_S while this request is waiting — for the encode lock or for
        an identical in-flight batch. Returning True raises EncodeAbandoned so
        a dead client stops occupying the queue.

        Coalescing: if a byte-identical batch is already computing, this call
        waits for that result instead of queueing an independent encode. The
        first request ("leader") owns the slot; a leader failure propagates to
        every waiter and clears the slot, so later retries re-encode.
        """
        if self._model is None:
            self.load()
        items = list(texts)
        key = self._content_key(items)
        while True:
            with self._inflight_lock:
                slot = self._inflight.get(key)
                if slot is None:
                    slot = _InFlight()
                    self._inflight[key] = slot
                    break  # we are the leader for this content hash
            # Identical batch already in flight: wait on its completion.
            self._wait_for_slot(slot, should_abandon)
            if slot.exc is None:
                logger.info(
                    "duplicate in-flight batch (%d texts) coalesced", len(items)
                )
                return slot.result
            if isinstance(slot.exc, EncodeAbandoned):
                # The leader's client died before encoding; take over.
                continue
            raise slot.exc
        try:
            result = self._embed_serialized(items, key, should_abandon)
            slot.result = result
            return result
        except BaseException as exc:
            slot.exc = exc
            raise
        finally:
            # Clear the slot BEFORE waking waiters: a request arriving after a
            # failure must start a fresh encode, never observe a stale error.
            with self._inflight_lock:
                self._inflight.pop(key, None)
            slot.event.set()

    # -- internals -----------------------------------------------------------

    @staticmethod
    def _content_key(items: list[str]) -> str:
        """Content hash of the exact input list (cache + coalescing key)."""
        h = hashlib.sha256()
        for t in items:
            h.update(t.encode("utf-8", "replace"))
            h.update(b"\x00")
        return h.hexdigest()

    @staticmethod
    def _wait_for_slot(slot: _InFlight, should_abandon: Any) -> None:
        if should_abandon is None:
            slot.event.wait()
            return
        while not slot.event.wait(WAIT_POLL_S):
            if should_abandon():
                raise EncodeAbandoned(
                    "client disconnected while waiting for identical in-flight batch"
                )

    def _acquire_encode_lock(self, should_abandon: Any) -> None:
        if should_abandon is None:
            self._encode_lock.acquire()
            return
        while not self._encode_lock.acquire(timeout=WAIT_POLL_S):
            if should_abandon():
                raise EncodeAbandoned(
                    "client disconnected while waiting for the encode lock"
                )

    def _embed_serialized(self, items: list[str], key: str, should_abandon: Any) -> Any:
        """Leader path: queue behind the encode lock, then cache-check + encode."""
        self._acquire_encode_lock(should_abandon)
        try:
            if self._result_cache_max > 0:
                cached = self._result_cache.get(key)
                if cached is not None:
                    self._result_cache.move_to_end(key)
                    logger.info(
                        "duplicate batch (%d texts) served from cache", len(items)
                    )
                    return cached
            result = self._embed_locked(items)
            if self._result_cache_max > 0:
                self._result_cache[key] = result
                while len(self._result_cache) > self._result_cache_max:
                    self._result_cache.popitem(last=False)
            return result
        finally:
            self._encode_lock.release()

    def _embed_locked(self, texts: list[str]) -> Any:
        device = self.device
        first = device not in self._warmed_devices
        if first:
            self._warming = True
            if device != "cpu":
                logger.info(
                    "first batch on %s: kernel warmup/compile can take minutes on mps"
                    " — not hung",
                    device,
                )
        t0 = time.monotonic()
        try:
            result = self._embed_dispatch(texts)
        finally:
            self._warming = False
        if first:
            self._warmed_devices.add(device)
            logger.info("first batch on %s completed in %.1fs", device, time.monotonic() - t0)
        return result

    def _embed_dispatch(self, texts: list[str]) -> Any:
        if (
            self.device == "cpu"
            and self.workers > 1
            and len(texts) >= self.mp_threshold
        ):
            return self._encode_multiprocess(texts)
        try:
            return self._encode_with_oom_retry(texts, self.batch_size)
        except Exception as exc:
            if self.device == "mps" and _is_mps_op_failure(exc):
                return self._mps_cpu_fallback(texts, exc)
            raise

    def _encode_with_oom_retry(
        self, texts: list[str], batch: int, device: str | None = None
    ) -> Any:
        while True:
            try:
                return self._model.encode(
                    texts,
                    batch_size=batch,
                    device=device,
                    normalize_embeddings=self.normalize,
                    convert_to_numpy=True,
                    show_progress_bar=False,
                )
            except Exception as exc:
                if _is_oom(exc) and batch > 1:
                    batch = max(1, batch // 2)
                    logger.warning("OOM during encode; retrying with batch_size=%d", batch)
                    self._empty_cache()
                    continue
                raise

    def _mps_cpu_fallback(self, texts: list[str], exc: BaseException) -> Any:
        self._mps_failures += 1
        logger.warning(
            "MPS op failure (%d/%d): %s — falling back to CPU for this request",
            self._mps_failures,
            config.MPS_FAILURE_LIMIT,
            exc,
        )
        if self._mps_failures >= config.MPS_FAILURE_LIMIT:
            logger.warning("MPS failed %d times; switching to CPU for this session", self._mps_failures)
            self.device = "cpu"
            self.batch_size = config.batch_size_for("cpu")
        return self._encode_with_oom_retry(texts, config.CPU_BATCH, device="cpu")

    # -- CPU multi-process pool ----------------------------------------------

    def _ensure_pool(self) -> Any:
        if self._pool is None:
            logger.info("starting CPU encode pool (%d workers)", self.workers)
            self._pool = self._model.start_multi_process_pool(
                target_devices=["cpu"] * self.workers
            )
        return self._pool

    def _stop_pool(self) -> None:
        if self._pool is None:
            return
        try:
            self._model.stop_multi_process_pool(self._pool)
        except Exception:
            pass
        self._pool = None

    def _encode_multiprocess(self, texts: list[str]) -> Any:
        if self._pool_degraded:
            return self._encode_with_oom_retry(texts, self.batch_size)
        try:
            pool = self._ensure_pool()
            return self._model.encode_multi_process(
                texts,
                pool,
                batch_size=self.batch_size,
                normalize_embeddings=self.normalize,
            )
        except Exception as exc:
            logger.warning("encode pool failed (%s); rebuilding pool once", exc)
            self._stop_pool()
            try:
                pool = self._ensure_pool()
                return self._model.encode_multi_process(
                    texts,
                    pool,
                    batch_size=self.batch_size,
                    normalize_embeddings=self.normalize,
                )
            except Exception as exc2:
                logger.warning(
                    "rebuilt pool also failed (%s); degrading to single-process", exc2
                )
                self._stop_pool()
                self._pool_degraded = True
                return self._encode_with_oom_retry(texts, self.batch_size)

    def _empty_cache(self) -> None:
        try:
            torch = config._torch()
            if self.device == "cuda":
                torch.cuda.empty_cache()
            elif self.device == "mps" and hasattr(torch, "mps"):
                torch.mps.empty_cache()
        except Exception:
            pass


def tune(model_name: str = config.DEFAULT_MODEL, sample: int = 32) -> dict:
    """Benchmark the real model on every available device and persist the winner.

    The static device preference (cuda > mps > cpu) is a guess that can be
    badly wrong — CodeRankEmbed's custom modeling measured 3-4x FASTER on CPU
    than on Apple-Silicon MPS. This runs a short realistic encode on each
    device, records texts/s, and writes the verdict to
    ``config.tuned_path()``; ``detect_device``/``batch_size_for`` honor it on
    every later start. Idempotent and safe to re-run (e.g. after a hardware or
    model change).
    """
    import json
    import time

    texts = [
        f"function verify_replay_{i}(project_root, service, data): Replay the saved "
        "start-commands file and decide success on evidence, not fixed timing. "
        "Returns a result dict; never raises for a failed replay."
        for i in range(sample)
    ]
    results: dict[str, float] = {}
    for device in config.available_devices():
        engine = EmbeddingEngine(model_name, device=device)
        try:
            engine.load()
            engine.embed(texts[:8])  # warm the kernels/compile caches
            t0 = time.monotonic()
            engine.embed(texts)
            dt = time.monotonic() - t0
            results[device] = round(sample / dt, 2) if dt > 0 else 0.0
            logger.info("tune: %s -> %.1f texts/s", device, results[device])
        except Exception as exc:
            logger.warning("tune: %s failed (%s); skipping", device, exc)
        finally:
            engine.close()
            del engine
    if not results:
        raise RuntimeError("auto-tune could not benchmark any device")
    best = max(results, key=lambda d: results[d])
    verdict = {
        "device": best,
        "batch": config.batch_size_for(best),
        "texts_per_s": results[best],
        "all": results,
        "model": model_name,
        "tuned_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    config.tuned_path().parent.mkdir(parents=True, exist_ok=True)
    config.tuned_path().write_text(json.dumps(verdict, indent=2) + "\n", encoding="utf-8")
    logger.info("tune verdict: %s (%.1f texts/s) -> %s", best, results[best], config.tuned_path())
    return verdict
