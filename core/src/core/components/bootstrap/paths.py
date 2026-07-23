"""Path defaults for Vinv Engine (shared workspace)."""

from __future__ import annotations

from pathlib import Path


def default_vinv_engine_shared_dir() -> str:
    """Absolute path to shared workspace when VINV_ENGINE_SHARED_DIR is unset (~vinv_engine_shared)."""
    return str(Path.home() / "vinv_engine_shared")


DEFAULT_VINV_ENGINE_SHARED_DIR = default_vinv_engine_shared_dir()
