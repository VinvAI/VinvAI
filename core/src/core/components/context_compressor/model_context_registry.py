"""Vinv Engine / components / context_compressor / model_context_registry — Model limit discovery.

Discovers per-model context window limits from:
1. agent_models.yaml ``model_context_windows`` (single source when set)
2. Local catalog (vinv_engine.components.model_limits.catalog)
3. litellm model metadata
4. dspy.settings.lm context_window / primary default_model window

Thread-safe singleton. All compression code should call get_limit(model_id)
instead of hardcoding context window sizes.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from typing import Dict, Optional

logger = logging.getLogger(__name__)


def _persist_path() -> str:
    """Location of the learned-limits catalog (survives process restarts)."""
    explicit = os.environ.get("VINV_ENGINE_MODEL_LIMITS_PATH")
    if explicit:
        return explicit
    return os.path.join(
        os.path.expanduser("~"), ".vinv", "learned_model_limits.json"
    )


class ModelContextRegistry:
    """Singleton registry of per-model context window limits.

    Limits are resolved from the local catalog first, then litellm/dspy metadata.

    The registry also LEARNS from live traffic, provider-agnostically:

    * ``record_overflow(model_id, estimated_tokens, reported_tokens, reported_limit)``
      is called whenever a provider rejects a request for context length. The
      error message carries two ground-truth numbers — the provider's actual
      input limit and the actual token count of the rejected request. From
      these the registry learns:

      - ``observed_input_limit``: the provider-enforced input ceiling (this
        overrides any stale catalog/fallback figure), and
      - ``token_inflation``: the ratio ``reported / estimated`` between what
        the provider counted and what our local estimator counted for the
        same request. This single multiplier absorbs tokenizer mismatch,
        prompt-template overhead, and adapter/serialization framing without
        needing any provider-specific rules.

    Planners divide their content budgets by ``token_inflation`` so the next
    request is feasible by the provider's own arithmetic, not ours.
    """

    _instance: Optional["ModelContextRegistry"] = None
    _lock = threading.Lock()

    def __new__(cls, persist_dir: Optional[str] = None) -> "ModelContextRegistry":
        with cls._lock:
            if cls._instance is None:
                inst = super().__new__(cls)
                inst._cache: Dict[str, int] = {}
                inst._observed_limits: Dict[str, int] = {}
                inst._inflation: Dict[str, float] = {}
                inst._load_persisted()
                cls._instance = inst
            return cls._instance

    # ── persistence: the learned catalog survives process restarts ────

    def _load_persisted(self) -> None:
        """Preload previously learned limits/inflation so a fresh process
        plans with the provider's real numbers BEFORE its first failure."""
        path = _persist_path()
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            limits = data.get("observed_limits", {})
            inflation = data.get("inflation", {})
            self._observed_limits.update(
                {str(k): int(v) for k, v in limits.items() if int(v) > 0}
            )
            self._inflation.update(
                {str(k): float(v) for k, v in inflation.items() if float(v) >= 1.0}
            )
            if self._observed_limits or self._inflation:
                logger.info(
                    "ModelContextRegistry: loaded learned catalog from %s "
                    "(%d limits, %d inflation ratios)",
                    path, len(self._observed_limits), len(self._inflation),
                )
        except FileNotFoundError:
            pass
        except Exception as exc:
            logger.warning(
                "ModelContextRegistry: could not load learned catalog %s: %s",
                path, exc,
            )

    def _save_persisted(self) -> None:
        """Atomically write the learned catalog (model → limit/inflation)."""
        path = _persist_path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            payload = {
                "observed_limits": self._observed_limits,
                "inflation": self._inflation,
            }
            fd, tmp = tempfile.mkstemp(
                dir=os.path.dirname(path), prefix=".model_limits_", suffix=".tmp"
            )
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, sort_keys=True)
            os.replace(tmp, path)
            logger.debug("ModelContextRegistry: persisted learned catalog to %s", path)
        except Exception as exc:
            logger.warning(
                "ModelContextRegistry: could not persist learned catalog: %s", exc,
            )

    # ── learned-from-traffic calibration ──────────────────────────────

    _GLOBAL_KEY = "__default__"

    def _key(self, model_id: Optional[str]) -> str:
        return model_id or self._active_model_id() or self._GLOBAL_KEY

    def record_overflow(
        self,
        model_id: Optional[str],
        estimated_tokens: int,
        reported_tokens: Optional[int],
        reported_limit: Optional[int],
    ) -> None:
        """Learn from a provider context-overflow rejection.

        ``estimated_tokens`` is our local estimate of the content we sent;
        ``reported_tokens``/``reported_limit`` are the provider's own numbers
        parsed from the error. Any of the provider numbers may be missing —
        we learn whatever is available.
        """
        key = self._key(model_id)
        changed = False
        if reported_limit and reported_limit > 0:
            prev = self._observed_limits.get(key)
            # The provider's stated ceiling is ground truth; keep the newest.
            self._observed_limits[key] = int(reported_limit)
            if prev != reported_limit:
                changed = True
                logger.info(
                    "ModelContextRegistry: learned input limit %s=%d (was %s)",
                    key, reported_limit, prev,
                )
        if reported_tokens and reported_tokens > 0 and estimated_tokens > 0:
            ratio = reported_tokens / estimated_tokens
            prev_ratio = self._inflation.get(key, 1.0)
            # Keep the most conservative (largest) observed inflation so the
            # planner never under-provisions after having seen worse.
            if ratio > prev_ratio:
                self._inflation[key] = ratio
                changed = True
                logger.info(
                    "ModelContextRegistry: learned token inflation %s=%.3f "
                    "(estimated=%d, provider counted=%d)",
                    key, ratio, estimated_tokens, reported_tokens,
                )
        if changed:
            # Update the on-disk catalog immediately so the NEXT process (or
            # binary) starts with the provider's real numbers before any
            # failure occurs.
            self._save_persisted()

    def observed_input_limit(self, model_id: Optional[str] = None) -> Optional[int]:
        """Provider-enforced input limit learned from live rejections, if any."""
        return self._observed_limits.get(self._key(model_id)) or self._observed_limits.get(
            self._GLOBAL_KEY
        )

    def token_inflation(self, model_id: Optional[str] = None) -> float:
        """Learned ratio between provider token counts and local estimates (≥ 1.0)."""
        key = self._key(model_id)
        return max(
            1.0,
            self._inflation.get(key, self._inflation.get(self._GLOBAL_KEY, 1.0)),
        )

    def effective_input_limit(self, model_id: Optional[str] = None) -> Optional[int]:
        """Best-known input ceiling: learned-from-traffic first, then static sources."""
        observed = self.observed_input_limit(model_id)
        if observed:
            return observed
        return self.get_limit(model_id)

    def get_limit(self, model_id: Optional[str] = None) -> Optional[int]:
        """Return the known context window limit for *model_id*, or None if unknown.

        Discovery order:
        1. Local catalog (vinv_engine.components.model_limits.catalog) — primary source
        2. litellm model metadata (if available)
        3. dspy.settings.lm context_window (if available)
        4. None
        """
        if not model_id:
            model_id = self._active_model_id()
        # Gateway-qualified ids like "gateway::model" are stripped to the
        # bare model id before lookup.
        if model_id and "::" in model_id:
            model_id = model_id.split("::")[-1]
        if not model_id:
            try:
                from core.components.common.model_context import (
                    is_initialized,
                    primary_runtime_context_window_tokens,
                )

                if is_initialized():
                    v = primary_runtime_context_window_tokens()
                    logger.debug(
                        "ModelContextRegistry.get_limit: primary default_model window=%s",
                        v,
                    )
                    return v
            except Exception:
                pass
            limit = self._query_dspy_context_window()
            logger.debug("ModelContextRegistry.get_limit: no model_id, dspy limit=%s", limit)
            return limit

        if model_id in self._cache:
            logger.debug("ModelContextRegistry.get_limit: cache hit for %s -> %d", model_id, self._cache[model_id])
            return self._cache[model_id]

        try:
            from core.components.common.model_context import configured_context_for_model_id

            _yaml_lim = configured_context_for_model_id(model_id)
            if _yaml_lim is not None:
                self._cache[model_id] = _yaml_lim
                logger.debug(
                    "ModelContextRegistry.get_limit: yaml model_context_windows %s -> %d",
                    model_id,
                    _yaml_lim,
                )
                return _yaml_lim
        except Exception:
            pass

        try:
            from core.components.model_limits.catalog import get_model_limits
            limit = get_model_limits(model_id)["max_prompt"]
            self._cache[model_id] = limit
            logger.debug("ModelContextRegistry.get_limit: catalog limit for %s -> %d", model_id, limit)
            return limit
        except (ValueError, KeyError, ImportError) as exc:
            logger.debug("ModelContextRegistry.get_limit: catalog lookup failed for %s: %s", model_id, exc)
            pass

        discovered = self._query_litellm_limit(model_id)
        if discovered is None:
            discovered = self._query_dspy_context_window()
        if discovered is not None:
            self._cache[model_id] = discovered
            logger.info("ModelContextRegistry: discovered %s = %d from metadata", model_id, discovered)
        return discovered

    @staticmethod
    def _active_model_id() -> Optional[str]:
        try:
            import dspy
            if hasattr(dspy.settings, "lm") and dspy.settings.lm:
                mid = getattr(dspy.settings.lm, "model", None)
                if mid:
                    return str(mid)
        except Exception:
            pass
        return os.environ.get("VINV_ENGINE_MODEL")

    @staticmethod
    def _query_litellm_limit(model_id: str) -> Optional[int]:
        try:
            import litellm
            info = litellm.get_model_info(model_id)
            if info and isinstance(info, dict):
                ctx = info.get("max_input_tokens") or info.get("max_tokens")
                if ctx and int(ctx) > 0:
                    return int(ctx)
        except Exception:
            pass
        return None

    @staticmethod
    def _query_dspy_context_window() -> Optional[int]:
        try:
            import dspy
            if hasattr(dspy.settings, "lm") and dspy.settings.lm:
                ctx = getattr(dspy.settings.lm, "context_window", None)
                if ctx and int(ctx) > 0:
                    return int(ctx)
        except Exception:
            pass
        return None


def get_model_context_registry() -> ModelContextRegistry:
    """Module-level accessor for the singleton registry."""
    return ModelContextRegistry()


__all__ = ["ModelContextRegistry", "get_model_context_registry"]
