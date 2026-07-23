"""
Vinv Engine in-tree shim for the `litellm` import name.

Implements the small surface area used by DSPy 3.x and Vinv Engine tooling via the
official OpenAI Python SDK only (no BerriAI litellm package).
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any, Callable, Optional, TypeVar
from urllib.parse import urlparse

from openai import APIStatusError, AsyncOpenAI, OpenAI
from openai.types.chat import ChatCompletionChunk

from ._logging import verbose_logger
from .exceptions import ContextWindowExceededError, RateLimitError, Timeout

T = TypeVar("T")


class _LiteLLMCompatChatResponse:
    """Wrap OpenAI ``ChatCompletion`` so DSPy can use both ``r.choices`` and ``r[\"choices\"]``."""

    __slots__ = ("_raw",)

    def __init__(self, raw: Any) -> None:
        object.__setattr__(self, "_raw", raw)

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_raw"), name)

    def __getitem__(self, key: str) -> Any:
        raw = object.__getattribute__(self, "_raw")
        if key == "choices":
            return raw.choices
        if key == "usage":
            return raw.usage
        if key == "model":
            return raw.model
        if key == "id":
            return getattr(raw, "id", None)
        raise KeyError(key)


def _wrap_chat_response(obj: Any) -> Any:
    if obj is None or isinstance(obj, dict):
        return obj
    if isinstance(obj, _LiteLLMCompatChatResponse):
        return obj
    if getattr(obj, "choices", None) is not None:
        return _LiteLLMCompatChatResponse(obj)
    return obj


# DSPy streaming / adapters use this as the chunk type (OpenAI-native stream objects).
ModelResponseStream = ChatCompletionChunk

_SUPPORTED_OPENAI_CHAT_PARAMS: tuple[str, ...] = (
    "temperature",
    "max_tokens",
    "max_completion_tokens",
    "top_p",
    "n",
    "stream",
    "stream_options",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "user",
    "tools",
    "tool_choice",
    "response_format",
    "seed",
    "reasoning_effort",
)

__all__ = [
    "ContextWindowExceededError",
    "ModelResponseStream",
    "RateLimitError",
    "Timeout",
    "acompletion",
    "aembedding",
    "aresponses",
    "atext_completion",
    "cache",
    "completion",
    "disable_cache",
    "embedding",
    "get_model_info",
    "get_supported_openai_params",
    "image_generation",
    "responses",
    "set_verbose",
    "stream_chunk_builder",
    "suppress_debug_info",
    "supports_function_calling",
    "supports_reasoning",
    "supports_response_schema",
    "telemetry",
    "text_completion",
    "verbose_logger",
]

telemetry = False
cache = None
suppress_debug_info = True
set_verbose = False


def disable_cache() -> None:
    global cache
    cache = None


_PROVIDER_PREFIXES = (
    "openai/", "anthropic/", "groq/", "together_ai/",
    "mistral/", "deepseek/", "openrouter/", "azure/",
)

_REASONING_MODEL_RE = re.compile(
    r"(?:^|[/:])(?:gpt-5|o[1345])(?![\w.-]*-chat)[\w.-]*$|codex",
    re.IGNORECASE,
)


def _normalize_model(model: str) -> str:
    """Strip LiteLLM provider routing prefixes.

    The stub routes everything through the OpenAI SDK, so provider prefixes
    like 'anthropic/' or 'groq/' must be removed before the model name is
    sent to the API (the API only understands the bare model name).
    """
    for prefix in _PROVIDER_PREFIXES:
        if model.startswith(prefix):
            return model[len(prefix):]
    return model


def _normalize_openai_compat_base_url(url: str) -> str:
    """The OpenAI SDK defaults to ``.../v1``; a bare host in env hits the wrong path.

    If ``LITELLM_BASE_URL`` is ``https://gateway`` with no path, the client would call
    ``/chat/completions`` at the site root. OpenAI-compatible gateways are almost always
    under ``/v1/chat/completions``.
    """
    s = (url or "").strip()
    if not s:
        return s
    s = s.rstrip("/")
    p = urlparse(s)
    if p.scheme not in ("http", "https") or not p.netloc:
        return s
    path = p.path or ""
    if path in ("", "/"):
        return f"{p.scheme}://{p.netloc}/v1"
    return s


def _sync_client(
    *,
    api_key: Optional[str] = None,
    api_base: Optional[str] = None,
    base_url: Optional[str] = None,
    headers: Optional[dict[str, str]] = None,
) -> OpenAI:
    key = (
        (api_key or "").strip()
        or os.environ.get("OPENAI_API_KEY", "").strip()
        or os.environ.get("LITELLM_API_KEY", "").strip()
    )
    url = (api_base or base_url or "").strip() or os.environ.get(
        "OPENAI_BASE_URL", ""
    ).strip() or os.environ.get("LITELLM_BASE_URL", "").strip()
    kwargs: dict[str, Any] = {}
    if key:
        kwargs["api_key"] = key
    if url:
        kwargs["base_url"] = _normalize_openai_compat_base_url(url)
    if headers:
        kwargs["default_headers"] = headers
    return OpenAI(**kwargs)


def _async_client(
    *,
    api_key: Optional[str] = None,
    api_base: Optional[str] = None,
    base_url: Optional[str] = None,
    headers: Optional[dict[str, str]] = None,
) -> AsyncOpenAI:
    key = (
        (api_key or "").strip()
        or os.environ.get("OPENAI_API_KEY", "").strip()
        or os.environ.get("LITELLM_API_KEY", "").strip()
    )
    url = (api_base or base_url or "").strip() or os.environ.get(
        "OPENAI_BASE_URL", ""
    ).strip() or os.environ.get("LITELLM_BASE_URL", "").strip()
    kwargs: dict[str, Any] = {}
    if key:
        kwargs["api_key"] = key
    if url:
        kwargs["base_url"] = _normalize_openai_compat_base_url(url)
    if headers:
        kwargs["default_headers"] = headers
    return AsyncOpenAI(**kwargs)


def _should_retry(exc: BaseException) -> bool:
    if isinstance(exc, Timeout):
        return True
    if isinstance(exc, RateLimitError):
        return True
    if isinstance(exc, APIStatusError) and exc.status_code in (408, 409, 429, 500, 502, 503, 504):
        return True
    return False


def _retry_sync(fn: Callable[[], T], num_retries: int) -> T:
    last: Optional[BaseException] = None
    for attempt in range(max(0, int(num_retries)) + 1):
        try:
            return fn()
        except Exception as e:
            last = e
            if attempt >= num_retries or not _should_retry(e):
                raise
            time.sleep(min(2.0, 0.25 * (2**attempt)))
    assert last is not None
    raise last


def _maybe_strip_json_object_response_format(kw: dict[str, Any]) -> None:
    """Drop legacy json_object mode when the gateway only allows json_schema.

    DSPy's JSONAdapter sets ``response_format={"type": "json_object"}``; strict
    LiteLLM proxies may reject that with invalid_request_error. Opt-in strip so
    the model still follows JSON instructions in the prompt without the param.
    """
    if os.environ.get("VINV_ENGINE_LLM_STRIP_JSON_OBJECT_RESPONSE_FORMAT", "").lower() not in (
        "1",
        "true",
        "yes",
    ):
        return
    rf = kw.get("response_format")
    if isinstance(rf, dict) and rf.get("type") == "json_object":
        kw.pop("response_format", None)


def _drop_none_values(kw: dict[str, Any]) -> None:
    """Do not serialize optional request parameters as JSON ``null``.

    DSPy includes unset LM options such as ``max_tokens=None`` in chat request
    kwargs. The OpenAI SDK accepts that Python value and serializes it, but
    OpenAI-compatible APIs may reject the resulting explicit null instead of
    treating it as omitted. An unset option must therefore be removed at this
    final transport boundary.
    """
    for key in [k for k, value in kw.items() if value is None]:
        kw.pop(key, None)


def _normalize_chat_kwargs(kw: dict[str, Any]) -> None:
    """Normalize DSPy chat kwargs for the selected OpenAI model family."""
    model = str(kw.get("model") or "")
    if model:
        model = _normalize_model(model)
        kw["model"] = model

    # OpenAI reasoning models reject the legacy max_tokens parameter even when
    # it is non-null; their Chat Completions equivalent is max_completion_tokens.
    if (
        _REASONING_MODEL_RE.search(model)
        and "max_tokens" in kw
        and kw.get("max_completion_tokens") is None
    ):
        value = kw.pop("max_tokens")
        if value is not None:
            kw["max_completion_tokens"] = value

    _drop_none_values(kw)


def _normalize_responses_kwargs(kw: dict[str, Any]) -> None:
    """Map Chat-Completions params to their Responses API equivalents in place.

    DSPy (and callers) build requests in Chat-Completions shape and route them to
    the Responses API without renaming token/temperature params. The OpenAI
    ``responses.create`` endpoint rejects unknown kwargs (e.g. ``max_tokens``), so
    translate the known ones and drop ``None`` values.
    """
    # max_tokens / max_completion_tokens → max_output_tokens
    for src in ("max_completion_tokens", "max_tokens"):
        if src in kw:
            val = kw.pop(src)
            if val is not None and kw.get("max_output_tokens") is None:
                kw["max_output_tokens"] = val
    # The Responses API also rejects optional parameters sent as null.
    _drop_none_values(kw)


async def _retry_async(fn: Callable[[], Any], num_retries: int) -> Any:
    last: Optional[BaseException] = None
    for attempt in range(max(0, int(num_retries)) + 1):
        try:
            return await fn()
        except Exception as e:
            last = e
            if attempt >= num_retries or not _should_retry(e):
                raise
            await asyncio.sleep(min(2.0, 0.25 * (2**attempt)))
    assert last is not None
    raise last


def completion(
    *,
    cache: Any = None,
    num_retries: int = 3,
    retry_strategy: Any = None,
    headers: Optional[dict[str, str]] = None,
    **kwargs: Any,
) -> Any:
    kw = dict(kwargs)
    api_key = kw.pop("api_key", None)
    api_base = kw.pop("api_base", None)
    base_url = kw.pop("base_url", None)
    kw.pop("rollout_id", None)
    stream = bool(kw.get("stream", False))
    _maybe_strip_json_object_response_format(kw)
    _normalize_chat_kwargs(kw)
    client = _sync_client(api_key=api_key, api_base=api_base, base_url=base_url, headers=headers)

    def _call() -> Any:
        return _wrap_chat_response(client.chat.completions.create(**kw))

    if stream:
        return _call()
    return _retry_sync(_call, num_retries)


async def acompletion(
    *,
    cache: Any = None,
    num_retries: int = 3,
    retry_strategy: Any = None,
    headers: Optional[dict[str, str]] = None,
    **kwargs: Any,
) -> Any:
    kw = dict(kwargs)
    api_key = kw.pop("api_key", None)
    api_base = kw.pop("api_base", None)
    base_url = kw.pop("base_url", None)
    kw.pop("rollout_id", None)
    stream = bool(kw.get("stream", False))
    _maybe_strip_json_object_response_format(kw)
    _normalize_chat_kwargs(kw)
    client = _async_client(api_key=api_key, api_base=api_base, base_url=base_url, headers=headers)

    async def _call() -> Any:
        return _wrap_chat_response(await client.chat.completions.create(**kw))

    if stream:
        return await _call()
    return await _retry_async(_call, num_retries)


def embedding(
    *,
    model: str,
    input: Any,
    caching: Any = None,
    **kwargs: Any,
) -> Any:
    raw = dict(kwargs)
    raw.pop("caching", None)
    api_key = raw.pop("api_key", None)
    api_base = raw.pop("api_base", None)
    base_url = raw.pop("base_url", None)
    headers = raw.pop("headers", None)
    _drop_none_values(raw)
    client = _sync_client(api_key=api_key, api_base=api_base or base_url, headers=headers)
    m = _normalize_model(model)
    return client.embeddings.create(model=m, input=input, **raw)


async def aembedding(
    *,
    model: str,
    input: Any,
    caching: Any = None,
    **kwargs: Any,
) -> Any:
    raw = dict(kwargs)
    raw.pop("caching", None)
    api_key = raw.pop("api_key", None)
    api_base = raw.pop("api_base", None)
    base_url = raw.pop("base_url", None)
    headers = raw.pop("headers", None)
    _drop_none_values(raw)
    client = _async_client(api_key=api_key, api_base=api_base or base_url, headers=headers)
    m = _normalize_model(model)
    return await client.embeddings.create(model=m, input=input, **raw)


def text_completion(
    *,
    cache: Any = None,
    num_retries: int = 3,
    retry_strategy: Any = None,
    headers: Optional[dict[str, str]] = None,
    **kwargs: Any,
) -> Any:
    kw = dict(kwargs)
    model = str(kw.pop("model", "") or "")
    prompt = kw.pop("prompt", "")
    if model.startswith("text-completion-openai/"):
        model = model.split("/", 1)[1]
    return completion(
        cache=cache,
        num_retries=num_retries,
        retry_strategy=retry_strategy,
        headers=headers,
        model=model,
        messages=[{"role": "user", "content": prompt}],
        **kw,
    )


async def atext_completion(
    *,
    cache: Any = None,
    num_retries: int = 3,
    retry_strategy: Any = None,
    headers: Optional[dict[str, str]] = None,
    **kwargs: Any,
) -> Any:
    kw = dict(kwargs)
    model = str(kw.pop("model", "") or "")
    prompt = kw.pop("prompt", "")
    if model.startswith("text-completion-openai/"):
        model = model.split("/", 1)[1]
    return await acompletion(
        cache=cache,
        num_retries=num_retries,
        retry_strategy=retry_strategy,
        headers=headers,
        model=model,
        messages=[{"role": "user", "content": prompt}],
        **kw,
    )


def responses(
    *,
    cache: Any = None,
    num_retries: int = 3,
    retry_strategy: Any = None,
    headers: Optional[dict[str, str]] = None,
    **kwargs: Any,
) -> Any:
    kw = dict(kwargs)
    api_key = kw.pop("api_key", None)
    api_base = kw.pop("api_base", None)
    base_url = kw.pop("base_url", None)
    if "model" in kw and kw["model"] is not None:
        kw["model"] = _normalize_model(str(kw["model"]))
    _normalize_responses_kwargs(kw)
    client = _sync_client(api_key=api_key, api_base=api_base, base_url=base_url, headers=headers)

    def _call() -> Any:
        return client.responses.create(**kw)

    return _retry_sync(_call, num_retries)


async def aresponses(
    *,
    cache: Any = None,
    num_retries: int = 3,
    retry_strategy: Any = None,
    headers: Optional[dict[str, str]] = None,
    **kwargs: Any,
) -> Any:
    kw = dict(kwargs)
    api_key = kw.pop("api_key", None)
    api_base = kw.pop("api_base", None)
    base_url = kw.pop("base_url", None)
    if "model" in kw and kw["model"] is not None:
        kw["model"] = _normalize_model(str(kw["model"]))
    _normalize_responses_kwargs(kw)
    client = _async_client(api_key=api_key, api_base=api_base, base_url=base_url, headers=headers)

    async def _call() -> Any:
        return await client.responses.create(**kw)

    return await _retry_async(_call, num_retries)


def image_generation(**kwargs: Any) -> Any:
    kw = dict(kwargs)
    api_key = kw.pop("api_key", None)
    api_base = kw.pop("api_base", None)
    model = _normalize_model(str(kw.pop("model", "") or ""))
    _drop_none_values(kw)
    client = _sync_client(api_key=api_key, api_base=api_base)
    return client.images.generate(model=model, **kw)


def stream_chunk_builder(
    chunks: Optional[list[Any]],
    messages: Any = None,
    start_time: Any = None,
    end_time: Any = None,
    logging_obj: Any = None,
) -> Any:
    if not chunks:
        return None
    from openai.lib.streaming.chat import ChatCompletionStreamState

    state = ChatCompletionStreamState()
    for ch in chunks:
        state.handle_chunk(ch)
    return _wrap_chat_response(state.get_final_completion())


def get_model_info(model: str) -> dict[str, Any]:
    try:
        client = _sync_client()
        mid = _normalize_model(model)
        info = client.models.retrieve(mid)
        if hasattr(info, "model_dump"):
            return info.model_dump()
    except Exception:
        pass
    return {}


def get_supported_openai_params(
    model: str,
    custom_llm_provider: Optional[str] = None,
) -> list[str]:
    """DSPy JSONAdapter: return standard chat-completion params for OpenAI-compatible routers."""
    _ = model
    _ = custom_llm_provider
    return list(_SUPPORTED_OPENAI_CHAT_PARAMS)


def supports_response_schema(
    model: str,
    custom_llm_provider: Optional[str] = None,
) -> bool:
    """Permissive default: OpenAI-compatible gateways used by Vinv Engine generally support JSON schema modes."""
    _ = model
    _ = custom_llm_provider
    return True


def supports_function_calling(model: str, custom_llm_provider: Optional[str] = None) -> bool:
    _ = model
    _ = custom_llm_provider
    return True


def supports_reasoning(model: str) -> bool:
    m = (model or "").lower()
    return any(k in m for k in ("gpt-5", "o1", "o3", "o4", "reasoning"))
