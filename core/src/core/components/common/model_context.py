"""Context window (tokens) from agent_models.yaml — one entry per model id.

All components that need a max-input budget should resolve via this module
(``context_window_tokens_for_component``, ``context_window_tokens_for_model``,
or ``primary_runtime_context_window_tokens`` for the global default_model LM).

``model_context_windows`` in YAML maps the exact model string (same as
``default_model`` / per-agent ``model:`` overrides) to token limits.
Missing models fall back to ``default_context_window``, then model_limits catalog.
"""

from __future__ import annotations

from typing import Any

_CFG: dict[str, Any] | None = None


def init_agent_model_config(cfg: dict | None) -> None:
    """Call once at bootstrap with the loaded agent_models.yaml dict."""
    global _CFG
    _CFG = dict(cfg) if cfg else {}


def is_initialized() -> bool:
    return bool(_CFG)


def _cfg() -> dict[str, Any]:
    return _CFG or {}


def configured_context_for_model_id(model_id: str | None) -> int | None:
    """Return tokens only if *model_id* is listed in ``model_context_windows``."""
    if not model_id:
        return None
    wins = _cfg().get("model_context_windows") or {}
    if model_id in wins:
        return int(wins[model_id])
    return None


def _resolve_model_key(entry: dict[str, Any] | None) -> str | None:
    if not entry:
        return None
    mv = entry.get("model", "default")
    c = _cfg()
    if mv == "default":
        return (c.get("default_model") or "").strip() or None
    if mv == "lightweight":
        return (c.get("default_lightweight_model") or "").strip() or None
    return str(mv).strip() or None


def resolve_model_id_for_component(component_name: str) -> str | None:
    """Map hero agent / internal module name → concrete model id string."""
    c = _cfg()
    if not c:
        return None
    for key in ("agents", "internal_agents"):
        sec = c.get(key) or {}
        ent = sec.get(component_name)
        if isinstance(ent, dict):
            return _resolve_model_key(ent)
    return (c.get("default_model") or "").strip() or None


def context_window_tokens_for_model(model_id: str | None) -> int:
    """Tokens for a deployment model id: YAML map → default_context_window → catalog."""
    explicit = configured_context_for_model_id(model_id)
    if explicit is not None:
        return explicit
    fallback = int(_cfg().get("default_context_window", 200_000))
    if not model_id:
        return fallback
    try:
        from core.components.model_limits.catalog import get_model_limits

        return int(get_model_limits(model_id)["max_prompt"])
    except Exception:
        return fallback


def context_window_tokens_for_component(component_name: str) -> int:
    """Tokens for the model assigned to *component_name* in agents / internal_agents."""
    mid = resolve_model_id_for_component(component_name)
    return context_window_tokens_for_model(mid)


def primary_runtime_context_window_tokens() -> int:
    """Context for ``default_model`` (global DSPy LM, compression defaults)."""
    mid = (_cfg().get("default_model") or "").strip() or None
    return context_window_tokens_for_model(mid)


def executor_payload_token_share() -> float:
    return float(_cfg().get("executor_payload_token_share", 0.2))
