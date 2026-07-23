"""Vinv Engine / components / model_limits / catalog — Complete model token-limit catalog.

NO NETWORK DEPENDENCY — all data local.
"""

from __future__ import annotations

import logging
from typing import Dict

logger = logging.getLogger(__name__)

MODEL_LIMITS_CATALOG: Dict[str, Dict[str, int]] = {
    # -- OpenAI --
    "gpt-4": {"max_prompt": 8_192, "max_output": 4_096},
    "gpt-4o": {"max_prompt": 128_000, "max_output": 16_384},
    "gpt-4.1": {"max_prompt": 32_000, "max_output": 8_192},
    "gpt-4o-mini": {"max_prompt": 128_000, "max_output": 16_384},
    "gpt-4o-mini-2024-07-18": {"max_prompt": 128_000, "max_output": 16_384},
    "o1-mini": {"max_prompt": 128_000, "max_output": 65_536},
    "o1-preview": {"max_prompt": 128_000, "max_output": 32_768},
    "gpt-4-turbo": {"max_prompt": 128_000, "max_output": 4_096},
    "gpt-4-32k": {"max_prompt": 32_768, "max_output": 4_096},
    "gpt-3.5-turbo": {"max_prompt": 16_385, "max_output": 4_096},
    "gpt-3.5-turbo-16k": {"max_prompt": 16_385, "max_output": 4_096},
    # -- Anthropic --
    "claude-3-opus-20240229": {"max_prompt": 200_000, "max_output": 4_096},
    "claude-3-sonnet-20240229": {"max_prompt": 200_000, "max_output": 4_096},
    "claude-3-haiku-20240307": {"max_prompt": 200_000, "max_output": 4_096},
    "claude-3-5-sonnet-20240620": {"max_prompt": 200_000, "max_output": 8_192},
    "claude-3-5-sonnet-20241022": {"max_prompt": 200_000, "max_output": 8_192},
    "claude-3-5-haiku-20241022": {"max_prompt": 200_000, "max_output": 8_192},
    "claude-3-opus": {"max_prompt": 200_000, "max_output": 4_096},
    "claude-3-sonnet": {"max_prompt": 200_000, "max_output": 4_096},
    "claude-3-haiku": {"max_prompt": 200_000, "max_output": 4_096},
    "claude-3.5-sonnet": {"max_prompt": 200_000, "max_output": 8_192},
    "claude-3.5-haiku": {"max_prompt": 200_000, "max_output": 8_192},
    # -- Google --
    "gemini-1.5-pro": {"max_prompt": 2_000_000, "max_output": 8_192},
    "gemini-1.5-flash": {"max_prompt": 1_000_000, "max_output": 8_192},
    "gemini-2.0-flash": {"max_prompt": 1_048_576, "max_output": 8_192},
    "gemini-pro": {"max_prompt": 32_768, "max_output": 8_192},
    # -- Meta Llama --
    "meta-llama/llama-3-8b-instruct": {"max_prompt": 8_192, "max_output": 8_192},
    "meta-llama/llama-3-70b-instruct": {"max_prompt": 8_192, "max_output": 8_192},
    "meta-llama/llama-3.1-8b-instruct": {"max_prompt": 128_000, "max_output": 8_192},
    "meta-llama/llama-3.1-70b-instruct": {"max_prompt": 128_000, "max_output": 8_192},
    "meta-llama/llama-3.1-405b-instruct": {"max_prompt": 128_000, "max_output": 8_192},
    "meta-llama/llama-3.3-70b-instruct": {"max_prompt": 128_000, "max_output": 8_192},
    # -- Mistral --
    "mistral-large-latest": {"max_prompt": 128_000, "max_output": 128_000},
    "mistral-small-latest": {"max_prompt": 32_768, "max_output": 32_768},
    "codestral-latest": {"max_prompt": 256_000, "max_output": 4_000},
    # -- Cohere --
    "command-r": {"max_prompt": 128_000, "max_output": 4_096},
    "command-r-plus": {"max_prompt": 128_000, "max_output": 4_096},
    # -- DeepSeek --
    "deepseek-chat": {"max_prompt": 64_000, "max_output": 8_192},
    "deepseek-coder": {"max_prompt": 64_000, "max_output": 8_192},
    # -- xAI (Grok) --
    "grok-beta": {"max_prompt": 131_072, "max_output": 131_072},
    # -- Perplexity --
    "perplexity/llama-3.1-sonar-small-128k-online": {"max_prompt": 127_000, "max_output": 8_000},
    "perplexity/llama-3.1-sonar-large-128k-online": {"max_prompt": 127_000, "max_output": 8_000},
}


def get_model_limits(model_name: str) -> Dict[str, int]:
    """Return ``{max_prompt, max_output}`` for *model_name*.

    Tries exact match, case-insensitive match, partial match, and base-model
    extraction (``openai/gpt-4o`` -> ``gpt-4o``) before raising ``ValueError``.
    """
    if model_name in MODEL_LIMITS_CATALOG:
        return MODEL_LIMITS_CATALOG[model_name].copy()

    lower = model_name.lower().strip()
    for key, limits in MODEL_LIMITS_CATALOG.items():
        if key.lower() == lower:
            return limits.copy()

    for key, limits in MODEL_LIMITS_CATALOG.items():
        kl = key.lower()
        if lower in kl or kl in lower:
            return limits.copy()

    if "/" in model_name and model_name.count("/") == 1:
        return get_model_limits(model_name.split("/")[-1])

    raise ValueError(
        f"Model '{model_name}' not in catalog ({len(MODEL_LIMITS_CATALOG)} entries). "
        "System will learn actual limit from first API call."
    )


def list_supported_models() -> Dict[str, Dict[str, int]]:
    return MODEL_LIMITS_CATALOG.copy()


def get_models_by_provider(provider: str) -> Dict[str, Dict[str, int]]:
    patterns: Dict[str, list[str]] = {
        "openai": ["gpt-", "text-embedding", "ft:gpt", "o1-", "chatgpt"],
        "anthropic": ["claude-"],
        "google": ["gemini-"],
        "meta": ["llama-", "meta-llama/"],
        "mistral": ["mistral-", "codestral", "pixtral"],
        "cohere": ["command"],
        "deepseek": ["deepseek"],
        "xai": ["grok"],
        "perplexity": ["perplexity/"],
    }
    pats = patterns.get(provider.lower(), [])
    return {m: l for m, l in MODEL_LIMITS_CATALOG.items() if any(p in m.lower() for p in pats)}


def get_max_context_models(min_tokens: int = 100_000) -> Dict[str, Dict[str, int]]:
    matching = {m: l for m, l in MODEL_LIMITS_CATALOG.items() if l["max_prompt"] >= min_tokens}
    return dict(sorted(matching.items(), key=lambda x: x[1]["max_prompt"], reverse=True))
