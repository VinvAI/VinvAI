"""Central adaptive timeout registry: YAML defaults + persisted learning."""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

import yaml

from core.components.common.runtime_paths import get_runtime_data_dir

logger = logging.getLogger(__name__)

_VINV_ENGINE_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_YAML = _VINV_ENGINE_ROOT / "config" / "adaptive_timeouts.yaml"
_STATE_PATH = get_runtime_data_dir() / "adaptive_timeout_state.json"
_LOCK = threading.RLock()
_CACHE: dict[str, Any] | None = None
_STATE: dict[str, Any] = {}


def _load_yaml() -> dict[str, Any]:
    path = Path(os.environ.get("VINV_ENGINE_ADAPTIVE_TIMEOUTS_YAML", str(_DEFAULT_YAML)))
    if not path.is_file():
        logger.warning("Adaptive timeouts YAML missing at %s — using builtins", path)
        return {
            "version": 1,
            "learning": {
                "ema_alpha": 0.15,
                "success_margin": 1.35,
                "timeout_bump_multiplier": 1.12,
                "max_bump_steps_before_cap": 25,
            },
            "keys": {},
        }
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _ensure_state_loaded() -> None:
    global _STATE
    if _STATE_PATH.is_file():
        try:
            with _STATE_PATH.open("r", encoding="utf-8") as f:
                _STATE = json.load(f)
        except Exception as exc:
            logger.warning("Failed to load timeout state: %s", exc)
            _STATE = {}
    else:
        _STATE = {}


def _persist_state() -> None:
    try:
        _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = _STATE_PATH.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(_STATE, f, indent=2)
        tmp.replace(_STATE_PATH)
    except Exception as exc:
        logger.warning("Failed to persist timeout state: %s", exc)


def _config() -> dict[str, Any]:
    global _CACHE
    with _LOCK:
        if _CACHE is None:
            _CACHE = _load_yaml()
            _ensure_state_loaded()
        return _CACHE


def get_timeout_seconds(key: str) -> float:
    """Resolved timeout for a logical key (env overrides YAML + learned current)."""
    cfg = _config()
    keys = cfg.get("keys") or {}
    kcfg = keys.get(key)
    if not kcfg:
        logger.debug("Unknown timeout key %r — falling back to 300s", key)
        return 300.0
    env_name = kcfg.get("env")
    if env_name:
        raw = os.environ.get(env_name)
        if raw not in (None, ""):
            try:
                return float(raw)
            except ValueError:
                pass
    initial = float(kcfg.get("initial", 300))
    lo = float(kcfg.get("min", 1))
    hi = float(kcfg.get("max", 864000))
    with _LOCK:
        entry = _STATE.get(key) or {}
        current = float(entry.get("current", initial))
    current = max(lo, min(current, hi))
    return current


def record_timeout_outcome(key: str, duration_seconds: float, *, timed_out: bool) -> None:
    """Update learned timeout from one observation (thread-safe, persisted)."""
    cfg = _config()
    keys = cfg.get("keys") or {}
    kcfg = keys.get(key)
    if not kcfg:
        return
    learn = cfg.get("learning") or {}
    alpha = float(learn.get("ema_alpha", 0.15))
    success_margin = float(learn.get("success_margin", 1.35))
    bump = float(learn.get("timeout_bump_multiplier", 1.12))
    max_bumps = int(learn.get("max_bump_steps_before_cap", 25))

    initial = float(kcfg.get("initial", 300))
    lo = float(kcfg.get("min", 1))
    hi = float(kcfg.get("max", 864000))

    with _LOCK:
        _ensure_state_loaded()
        entry = _STATE.setdefault(key, {"current": initial, "bumps": 0})
        cur = float(entry.get("current", initial))
        if timed_out:
            bumps = int(entry.get("bumps", 0)) + 1
            entry["bumps"] = bumps
            if bumps <= max_bumps:
                cur = min(cur * bump, hi)
            else:
                cur = hi
        else:
            entry["bumps"] = 0
            desired = max(duration_seconds, 0.1) * success_margin
            cur = (1.0 - alpha) * cur + alpha * desired
        cur = max(lo, min(cur, hi))
        entry["current"] = cur
        entry["last_duration_s"] = duration_seconds
        entry["last_timed_out"] = timed_out
        _persist_state()
    logger.debug(
        "adaptive_timeout_observation key=%s duration_s=%.3f timed_out=%s new_current=%.3f",
        key,
        duration_seconds,
        timed_out,
        cur,
    )


def correlation_learning_key(message_type: str, recipient: str) -> str | None:
    """Map outbound request to a registry key for correlation-duration learning.

    Called when a correlation is created; the returned key is used to
    auto-record duration via record_timeout_outcome when the correlation
    resolves (success or timeout) in runtime.py / scheduler.py.
    """
    mt = (message_type or "").strip().upper()
    rid = (recipient or "").lower()

    # Q-learning
    if mt == "GET_ADVISORY" and ("qlearn" in rid or "q_learn" in rid):
        return "coordinator.advisory"
    if mt == "GET_LEARNED_CONTEXT" and ("qlearn" in rid or "q_learn" in rid):
        return "qlearning.learned_context"

    # Predictive MARL
    if mt == "PREDICT" and "marl" in rid:
        return "coordinator.marl_predict"

    # Auditor / inspector (spot-audit, full audit, test-generate)
    if mt in ("AUDITOR_VALIDATE", "SPOT_AUDIT", "TEST_GENERATE_AND_VALIDATE"):
        if "auditor" in rid or "inspector" in rid:
            return "coordinator.audit"

    # Persist / distill — output registration and context distillation
    if mt in ("REGISTER_OUTPUT", "DISTILL_OUTPUT"):
        return "coordinator.persist"

    # Context update (cortex / preempt)
    if mt == "CONTEXT_UPDATE":
        return "coordinator.ctx_collect"

    # Clarification
    if mt == "CLARIFICATION_REQUEST" and "clarif" in rid:
        return "clarification.actor"

    return None


def reload_for_tests() -> None:
    """Reset in-memory cache (tests only)."""
    global _CACHE
    with _LOCK:
        _CACHE = None
        _STATE.clear()
        _ensure_state_loaded()
