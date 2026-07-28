"""One seam for every remote API, including the model providers.

Under containment the network is denied, so every target that reaches a remote
API lands as ``contained`` — correctly not a defect, and correctly not
exercised. On a repo that talks to a provider that is most of the interesting
surface.

The obvious substitution is one double per provider. It does not scale and is
already wrong: langchain vendors SIXTEEN partner packages in one repository, so
that list needs sixteen entries for a single target and is still wrong for the
seventeenth. So the cut is HTTP — where all of them bottom out, and a standard
rather than a vendor, exactly as PEP 249 is the right cut for databases.

The response body looks like it needs per-API knowledge and does not: a client
reads by ACCESS PATH, so a body that satisfies any path satisfies every API
without knowing one of them.

What this cannot do is be correct, and the tests say so: a doubled provider
returns a plausibly-SHAPED answer, never a right one.
"""

from __future__ import annotations

import pytest

from exerciser.service_doubles import HTTP_MODULES, LenientBody, SubstitutedResponse


@pytest.mark.parametrize(
    ("path", "label"),
    [
        (("choices", 0, "message", "content"), "openai chat"),
        (("content", 0, "text"), "anthropic messages"),
        (("generations", 0, "text"), "cohere generate"),
        (("data", 0, "embedding"), "openai embeddings"),
        (("candidates", 0, "content", "parts", 0, "text"), "gemini"),
        (("results", 0, "outputs", 0, "data"), "an api nobody has written yet"),
    ],
)
def test_any_access_path_is_satisfied(path: tuple, label: str) -> None:
    """The whole argument for cutting at HTTP instead of per provider."""
    body: object = LenientBody()
    for key in path:
        body = body[key]  # type: ignore[index]
    assert str(body) == "vinv-substituted", label


def test_a_body_is_a_dict_because_client_code_branches_on_that() -> None:
    assert isinstance(LenientBody(), dict)


def test_a_loop_over_a_substituted_collection_runs_once() -> None:
    """Zero iterations is the "not exercised" outcome this exists to remove.

    An earlier version defined ``__bool__`` as always True — a response body
    must not read as falsy to a client guarding on it — which made the
    emptiness test never fire, so every ``for choice in r["choices"]`` ran zero
    times while appearing to work.
    """
    assert len([c for c in LenientBody()["choices"]]) == 1
    assert [str(c["message"]["content"]) for c in LenientBody()["choices"]] == ["vinv-substituted"]


def test_a_populated_body_iterates_its_real_keys() -> None:
    body = LenientBody()
    body["a"] = 1
    body["b"] = 2
    assert sorted(body) == ["a", "b"]


def test_a_guard_on_a_missing_key_is_not_told_yes() -> None:
    """`if "error" in body` must not hand the client an error path.

    Vivifying on ``in`` would send every caller down its failure branch, and
    those branches would then be reported as the repo's behaviour.
    """
    assert "error" not in LenientBody()


def test_a_body_is_truthy() -> None:
    assert bool(LenientBody()) is True


def test_the_response_looks_like_the_real_ones() -> None:
    response = SubstitutedResponse(url="https://api.example.invalid/v1/chat", method="POST")
    assert response.status_code == 200
    assert response.status == 200  # aiohttp's spelling
    assert response.ok is True
    assert response.is_success is True
    assert response.raise_for_status() is response
    assert response.text == "vinv-substituted"
    assert response.content == b"vinv-substituted"
    assert response.headers["content-type"] == "application/json"


def test_the_response_supports_the_context_manager_spellings() -> None:
    response = SubstitutedResponse()
    with response as opened:
        assert opened is response


def test_streaming_readers_do_not_hang_or_raise() -> None:
    response = SubstitutedResponse()
    assert list(response.iter_lines()) == []
    assert list(response.iter_content()) == [b"vinv-substituted"]


def test_the_clients_substituted_are_transports_not_vendors() -> None:
    """A vendor list goes stale; the transport list is the standard."""
    assert set(HTTP_MODULES) == {"httpx", "requests", "aiohttp"}


def test_the_double_records_that_it_answered(monkeypatch) -> None:
    """Participation is recorded by the double, never inferred by the parent.

    A parent reading an error message to decide whether the substitution was
    involved is guessing, and the guess misattributes real defects: a
    ``NameError`` inside a repo's own fake-embeddings class has no provider
    anywhere near it and would be blamed on the substitution by any text rule.
    Only the double knows whether the double answered.
    """
    from exerciser import service_doubles

    seen: list[tuple[str, str]] = []
    monkeypatch.setattr(
        service_doubles,
        "_record",
        lambda kind, service, detail, **extra: seen.append((kind, service)),
    )
    service_doubles._serve_http("POST", "https://api.example.invalid/v1/chat")

    assert seen == [(service_doubles.SUBSTITUTED, "http")]


def test_a_substituted_answer_is_shaped_not_correct() -> None:
    """The honest ceiling, pinned so nobody reads more into this than it gives.

    Two different questions return the same placeholder. The substitution buys
    REACHABILITY — the code path runs — and never the correctness of anything
    downstream of the model's content.
    """
    first = LenientBody()["choices"][0]["message"]["content"]
    second = LenientBody()["choices"][0]["message"]["content"]
    assert str(first) == str(second) == "vinv-substituted"
