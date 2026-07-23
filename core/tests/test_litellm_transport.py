from __future__ import annotations

import asyncio

import litellm


class _SyncCompletions:
    def __init__(self) -> None:
        self.kwargs: dict | None = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        return {"choices": []}


class _AsyncCompletions:
    def __init__(self) -> None:
        self.kwargs: dict | None = None

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return {"choices": []}


class _SyncEndpoint:
    def __init__(self) -> None:
        self.kwargs: dict | None = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        return {}

    def generate(self, **kwargs):
        return self.create(**kwargs)


class _AsyncEndpoint:
    def __init__(self) -> None:
        self.kwargs: dict | None = None

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return {}


def _client(completions=None, *, responses=None, embeddings=None, images=None):
    attrs = {}
    if completions is not None:
        attrs["chat"] = type("Chat", (), {"completions": completions})()
    if responses is not None:
        attrs["responses"] = responses
    if embeddings is not None:
        attrs["embeddings"] = embeddings
    if images is not None:
        attrs["images"] = images
    return type("Client", (), attrs)()


def test_chat_completion_omits_unset_optional_parameters(monkeypatch) -> None:
    completions = _SyncCompletions()
    monkeypatch.setattr(litellm, "_sync_client", lambda **_kwargs: _client(completions))

    litellm.completion(
        model="gpt-test",
        messages=[{"role": "user", "content": "hello"}],
        max_tokens=None,
        temperature=None,
    )

    assert completions.kwargs is not None
    assert "max_tokens" not in completions.kwargs
    assert "temperature" not in completions.kwargs
    assert completions.kwargs["model"] == "gpt-test"


def test_reasoning_chat_uses_max_completion_tokens(monkeypatch) -> None:
    completions = _SyncCompletions()
    monkeypatch.setattr(litellm, "_sync_client", lambda **_kwargs: _client(completions))

    litellm.completion(
        model="openai/gpt-5.4-nano",
        messages=[{"role": "user", "content": "hello"}],
        max_tokens=123,
    )

    assert completions.kwargs is not None
    assert completions.kwargs["model"] == "gpt-5.4-nano"
    assert completions.kwargs["max_completion_tokens"] == 123
    assert "max_tokens" not in completions.kwargs


def test_text_completion_inherits_chat_null_filter(monkeypatch) -> None:
    completions = _SyncCompletions()
    monkeypatch.setattr(litellm, "_sync_client", lambda **_kwargs: _client(completions))

    litellm.text_completion(
        model="text-completion-openai/gpt-test",
        prompt="hello",
        max_tokens=None,
    )

    assert completions.kwargs is not None
    assert "max_tokens" not in completions.kwargs


def test_responses_omits_null_and_maps_non_null_token_limit(monkeypatch) -> None:
    endpoint = _SyncEndpoint()
    monkeypatch.setattr(
        litellm,
        "_sync_client",
        lambda **_kwargs: _client(responses=endpoint),
    )

    litellm.responses(
        model="gpt-5.4-nano",
        input="hello",
        max_tokens=123,
        temperature=None,
    )

    assert endpoint.kwargs is not None
    assert endpoint.kwargs["max_output_tokens"] == 123
    assert "max_tokens" not in endpoint.kwargs
    assert "temperature" not in endpoint.kwargs


def test_async_responses_omits_null_and_maps_token_limit(monkeypatch) -> None:
    endpoint = _AsyncEndpoint()
    monkeypatch.setattr(
        litellm,
        "_async_client",
        lambda **_kwargs: _client(responses=endpoint),
    )

    asyncio.run(
        litellm.aresponses(
            model="gpt-5.4-nano",
            input="hello",
            max_completion_tokens=123,
            temperature=None,
        )
    )

    assert endpoint.kwargs is not None
    assert endpoint.kwargs["max_output_tokens"] == 123
    assert "max_completion_tokens" not in endpoint.kwargs
    assert "temperature" not in endpoint.kwargs


def test_embedding_omits_null_optional_parameters(monkeypatch) -> None:
    endpoint = _SyncEndpoint()
    monkeypatch.setattr(
        litellm,
        "_sync_client",
        lambda **_kwargs: _client(embeddings=endpoint),
    )

    litellm.embedding(model="text-embedding-test", input=["hello"], dimensions=None)

    assert endpoint.kwargs is not None
    assert "dimensions" not in endpoint.kwargs


def test_async_embedding_omits_null_optional_parameters(monkeypatch) -> None:
    endpoint = _AsyncEndpoint()
    monkeypatch.setattr(
        litellm,
        "_async_client",
        lambda **_kwargs: _client(embeddings=endpoint),
    )

    asyncio.run(
        litellm.aembedding(model="text-embedding-test", input=["hello"], dimensions=None)
    )

    assert endpoint.kwargs is not None
    assert "dimensions" not in endpoint.kwargs


def test_image_generation_omits_null_optional_parameters(monkeypatch) -> None:
    endpoint = _SyncEndpoint()
    monkeypatch.setattr(
        litellm,
        "_sync_client",
        lambda **_kwargs: _client(images=endpoint),
    )

    litellm.image_generation(model="image-test", prompt="hello", size=None)

    assert endpoint.kwargs is not None
    assert "size" not in endpoint.kwargs


def test_async_chat_completion_omits_unset_optional_parameters(monkeypatch) -> None:
    completions = _AsyncCompletions()
    monkeypatch.setattr(litellm, "_async_client", lambda **_kwargs: _client(completions))

    asyncio.run(
        litellm.acompletion(
            model="gpt-test",
            messages=[{"role": "user", "content": "hello"}],
            max_tokens=None,
            temperature=None,
        )
    )

    assert completions.kwargs is not None
    assert "max_tokens" not in completions.kwargs
    assert "temperature" not in completions.kwargs
