"""Resolve writable runtime and log directories outside PyInstaller ``_internal``.

Packaged apps must not use ``Path(__file__)`` or ``sys._MEIPASS`` for mutable data.
Electron passes ``VINV_ENGINE_RUNTIME_DIR`` (userData) and ``VINV_ENGINE_LOG_DIR``; this module
also supports legacy ``VINV_ENGINE_RUNTIME_DATA_DIR`` (full path to ``runtime_data``).
"""

from __future__ import annotations

import os
import platform
import sys
from pathlib import Path

APP_NAME = "Vinv Engine"


def _dev_vinv_engine_root() -> Path:
    """``vinv_engine/`` package root when running from a source checkout."""
    return Path(__file__).resolve().parent.parent.parent


def _default_user_data_root() -> Path:
    """OS-default application data directory (no env overrides)."""
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        return home / "Library" / "Application Support" / APP_NAME
    if system == "Windows":
        appdata = os.environ.get("APPDATA")
        return Path(appdata) / APP_NAME if appdata else home / "AppData" / "Roaming" / APP_NAME
    xdg = os.environ.get("XDG_DATA_HOME")
    return Path(xdg) / APP_NAME if xdg else home / ".local" / "share" / APP_NAME


def _platform_log_dir() -> Path:
    """OS-default log directory when not using repo-relative dev paths."""
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        return home / "Library" / "Logs" / APP_NAME
    if system == "Windows":
        local = os.environ.get("LOCALAPPDATA")
        return Path(local) / APP_NAME / "Logs" if local else home / "AppData" / "Local" / APP_NAME / "Logs"
    xdg = os.environ.get("XDG_STATE_HOME")
    return Path(xdg) / APP_NAME / "logs" if xdg else home / ".local" / "state" / APP_NAME / "logs"


def get_runtime_data_dir() -> Path:
    """Directory for vault, scratchpad, sessions, caches, etc.

    Resolution order:

    1. ``VINV_ENGINE_RUNTIME_DATA_DIR`` — absolute path to the ``runtime_data`` folder (legacy).
    2. ``VINV_ENGINE_RUNTIME_DIR`` / ``runtime_data`` — Electron ``userData`` + subfolder.
    3. PyInstaller bundle: ``Application Support/Vinv Engine/runtime_data`` (or equivalent).
    4. Dev checkout: ``<repo>/vinv_engine/runtime_data``.
    """
    legacy = os.environ.get("VINV_ENGINE_RUNTIME_DATA_DIR")
    if legacy:
        p = Path(legacy).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        return p

    parent = os.environ.get("VINV_ENGINE_RUNTIME_DIR")
    if parent:
        p = Path(parent).expanduser() / "runtime_data"
        p.mkdir(parents=True, exist_ok=True)
        return p

    if getattr(sys, "frozen", False):
        p = _default_user_data_root() / "runtime_data"
        p.mkdir(parents=True, exist_ok=True)
        return p

    p = _dev_vinv_engine_root() / "runtime_data"
    p.mkdir(parents=True, exist_ok=True)
    return p


def get_logs_dir() -> Path:
    """Directory for component / thinking JSONL logs.

    Resolution order:

    1. ``VINV_ENGINE_LOG_DIR`` — explicit (set by Electron in packaged builds).
    2. PyInstaller, or any runtime env that relocates data (``VINV_ENGINE_RUNTIME_DIR`` /
       ``VINV_ENGINE_RUNTIME_DATA_DIR``): platform log dir (e.g. ``~/Library/Logs/Vinv Engine``).
    3. Local dev without those env vars: ``<repo>/vinv_engine/runtime_data/logs``.
    """
    override = os.environ.get("VINV_ENGINE_LOG_DIR")
    if override:
        p = Path(override).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        return p

    use_platform = (
        getattr(sys, "frozen", False)
        or os.environ.get("VINV_ENGINE_RUNTIME_DIR")
        or os.environ.get("VINV_ENGINE_RUNTIME_DATA_DIR")
    )
    if use_platform:
        p = _platform_log_dir()
        p.mkdir(parents=True, exist_ok=True)
        return p

    p = _dev_vinv_engine_root() / "runtime_data" / "logs"
    p.mkdir(parents=True, exist_ok=True)
    return p


# Backwards-compatible aliases for older call sites
get_log_dir = get_logs_dir
