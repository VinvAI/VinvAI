"""Configuration, device detection, and batch policy for the embedder sidecar.

All thresholds are constants with environment overrides:

    VINV_EMBED_DEVICE        force device: cuda | mps | cpu (default: auto-detect)
    VINV_EMBED_BATCH         force encode batch size (default: per-device policy)
    VINV_EMBED_WORKERS       CPU multi-process pool size (default: cpu_count - 2)
    VINV_EMBED_MP_THRESHOLD  input size at which the CPU pool kicks in (default: 256)
    VINV_EMBED_MAX_SEQ       token cap per input; 0 = model default (default: 1024)
    VINV_EMBED_MAX_ITEMS     max texts per request, else 413 (default: 2048)
    VINV_EMBED_MAX_QUEUE     max requests queued for the encode lock, else 503 (default: 32)
    VINV_EMBED_MAX_BODY      max request body bytes, else 413 (default: 64 MiB)
    VINV_EMBED_REVISION      override the pinned HF revision
    VINV_EMBED_NORMALIZE     "0" to disable L2-normalized embeddings (default on)
    VINV_EMBED_TRUST_REMOTE_CODE  "1" to allow remote code for non-default models
    VINV_HOME                base dir for Vinv state (default ~/.vinv)
"""

from __future__ import annotations

import os
from pathlib import Path

# Must be set before torch is imported anywhere in this process: lets MPS fall
# back to CPU per-op instead of raising for unimplemented operators.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

DEFAULT_MODEL = "nomic-ai/CodeRankEmbed"

# Pinned HF revision of DEFAULT_MODEL (refs/heads/main as of 2026-07-23).
# CodeRankEmbed ships custom modeling code (configuration_hf_nomic_bert.py,
# modeling_hf_nomic_bert.py) and therefore requires trust_remote_code=True;
# pinning the revision means we only ever execute code from this exact commit.
DEFAULT_REVISION = "3c4b60807d71f79b43f3c4363786d9493691f8b1"

DEFAULT_PORT = 8776
BIND_HOST = "127.0.0.1"  # localhost-only bind; no auth by design

# --- capacity / parallelism defaults ---------------------------------------
MPS_BATCH = 64
CPU_BATCH = 32
CUDA_FALLBACK_BATCH = 32
# (min free VRAM bytes, batch size) — conservative, first match wins.
CUDA_BATCH_TABLE: list[tuple[int, int]] = [
    (20 << 30, 512),
    (10 << 30, 256),
    (6 << 30, 128),
    (3 << 30, 64),
]
DEFAULT_MP_THRESHOLD = 256
DEFAULT_MAX_ITEMS = 2048
DEFAULT_MAX_QUEUE = 32
DEFAULT_MAX_BODY_BYTES = 64 << 20
MPS_FAILURE_LIMIT = 3  # MPS op failures before switching to CPU for the session


def vinv_home() -> Path:
    return Path(os.environ.get("VINV_HOME", "~/.vinv")).expanduser()


def models_dir() -> Path:
    return vinv_home() / "models"


def apply_cache_env() -> None:
    """Point the HF cache at ~/.vinv/models unless the user already set HF_HOME.

    trust_remote_code modules are cached under HF_HOME too, so setting it (not
    just cache_folder) keeps everything inside VINV_HOME.
    """
    os.environ.setdefault("HF_HOME", str(models_dir()))


def _torch():  # lazy: torch import is heavy and tests stub this out
    import torch

    return torch


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


def tuned_path() -> Path:
    """Where the measured device/batch verdict is persisted (see engine.tune)."""
    return vinv_home() / "embedder_tuned.json"


def read_tuned() -> dict | None:
    """The persisted auto-tune verdict, or None. Shape: {device, batch, texts_per_s, model, tuned_at}."""
    try:
        import json

        data = json.loads(tuned_path().read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("device") in ("cuda", "mps", "cpu"):
            return data
    except Exception:
        pass
    return None


def available_devices() -> list[str]:
    """Devices present on this machine, preferred order first."""
    torch = _torch()
    out: list[str] = []
    if torch.cuda.is_available():
        out.append("cuda")
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        out.append("mps")
    out.append("cpu")
    return out


def detect_device(prefer: str = "auto") -> str:
    """Resolve the device: env override > explicit preference > MEASURED tune
    verdict > cuda > mps > cpu.

    The static preference order is only a guess — e.g. CodeRankEmbed's custom
    modeling runs 3-4x FASTER on CPU than on Apple-Silicon MPS (measured).
    `vinv-embedder tune` (run automatically at warmup / first serve) benchmarks
    the real model on every available device and persists the winner; that
    measurement, when present, beats the guess.
    """
    env = os.environ.get("VINV_EMBED_DEVICE", "").strip().lower()
    if env:
        prefer = env
    if prefer and prefer != "auto":
        return prefer
    tuned = read_tuned()
    if tuned and tuned["device"] in available_devices():
        return str(tuned["device"])
    return available_devices()[0]


def batch_size_for(device: str) -> int:
    """Pick an encode batch size: env > measured tune verdict > device capacity."""
    env = os.environ.get("VINV_EMBED_BATCH")
    if env:
        return _env_int("VINV_EMBED_BATCH", CPU_BATCH)
    tuned = read_tuned()
    if tuned and tuned.get("device") == device and isinstance(tuned.get("batch"), int):
        return max(1, int(tuned["batch"]))
    if device == "cuda":
        try:
            free, _total = _torch().cuda.mem_get_info()
        except Exception:
            return CUDA_FALLBACK_BATCH
        for min_free, batch in CUDA_BATCH_TABLE:
            if free >= min_free:
                return batch
        return CUDA_FALLBACK_BATCH
    if device == "mps":
        return MPS_BATCH
    return CPU_BATCH


def worker_count() -> int:
    """CPU pool workers — deliberately conservative (≤4, ~half the cores).

    The sidecar shares the machine with the user's editor, services, and
    coding agent; saturating every core makes the whole system hang. Raise
    VINV_EMBED_WORKERS explicitly on a dedicated box.
    """
    cores = os.cpu_count() or 2
    return _env_int("VINV_EMBED_WORKERS", max(1, min(4, cores // 2 - 1)))


def cpu_threads() -> int:
    """Intra-op torch threads on CPU — half the cores by default (safe margin).

    Torch defaults to every performance core, which starves the UI and other
    processes. VINV_EMBED_CPU_THREADS overrides.
    """
    cores = os.cpu_count() or 2
    return _env_int("VINV_EMBED_CPU_THREADS", max(1, cores // 2))


def mp_threshold() -> int:
    return _env_int("VINV_EMBED_MP_THRESHOLD", DEFAULT_MP_THRESHOLD)


def result_cache_size() -> int:
    """Duplicate-batch result cache entries (VINV_EMBED_CACHE, 0 disables).

    Live traces showed identical batches re-sent after client deaths costing
    83% of engine compute; a tiny content-hash LRU absorbs those retries.
    """
    raw = os.environ.get("VINV_EMBED_CACHE")
    if raw is not None and raw.strip() == "0":
        return 0
    return _env_int("VINV_EMBED_CACHE", 8)


def max_seq_length() -> int:
    """Token cap per input (VINV_EMBED_MAX_SEQ, default 1024; 0 = model default).

    Sentence-transformers pads each batch to its longest sequence, so one long
    input drags the whole batch to the model's 8k ceiling — the dominant cost
    on MPS/CPU. Index embed inputs (name + signature + docstring) fit well
    under 1024 tokens.
    """
    return _env_int("VINV_EMBED_MAX_SEQ", 1024)


def max_items() -> int:
    return _env_int("VINV_EMBED_MAX_ITEMS", DEFAULT_MAX_ITEMS)


def max_queue() -> int:
    """Max requests waiting for the encode engine before shedding with 503.

    Live traces showed lock waits of >30 minutes when retry storms piled
    threads onto the encode lock; beyond this bound the server answers 503 +
    Retry-After instead of queueing (VINV_EMBED_MAX_QUEUE, default 32).
    """
    return _env_int("VINV_EMBED_MAX_QUEUE", DEFAULT_MAX_QUEUE)


def max_body_bytes() -> int:
    return _env_int("VINV_EMBED_MAX_BODY", DEFAULT_MAX_BODY_BYTES)


def normalize_embeddings() -> bool:
    return os.environ.get("VINV_EMBED_NORMALIZE", "1") != "0"


def revision_for(model_name: str) -> str | None:
    """Pinned revision for the default model; env override; None otherwise."""
    env = os.environ.get("VINV_EMBED_REVISION", "").strip()
    if env:
        return env
    if model_name == DEFAULT_MODEL:
        return DEFAULT_REVISION
    return None


def trust_remote_code_for(model_name: str) -> bool:
    """Only trust remote code for the pinned default model, unless opted in."""
    if model_name == DEFAULT_MODEL:
        return True
    return os.environ.get("VINV_EMBED_TRUST_REMOTE_CODE", "0") == "1"
