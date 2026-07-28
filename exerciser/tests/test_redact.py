"""Secrets must never reach disk or a URL (audit SEC-1, SEC-2).

These tests encode the two leaks found in the pre-production audit:

  SEC-1  ``POST /login/access-token`` answers 200 with a bearer JWT, and the
         execution row was persisted verbatim into .vinv/exercise/results.jsonl
         inside the user's repo.
  SEC-2  the state ledger harvested that token as a "response scalar", and the
         auth sweep spliced harvested scalars into path params — issuing
         DELETE /users/<jwt> and writing the credential to the access log.

The redaction must be narrow: over-redacting corrupts the observations the
invariant oracle learns from, so the "leaves ordinary data alone" tests below
are as load-bearing as the "removes the secret" ones.
"""

from __future__ import annotations

import pytest

from exerciser.redact import (
    PLACEHOLDER,
    is_id_shaped,
    is_secret_key,
    looks_like_jwt,
    redact,
)
from exerciser.state import record_creations

# A structurally real JWT (header.payload.signature), the shape a login returns.
JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ"
    ".dQw4w9WgXcQ7Lk3nF2mZpQrStUvWxYz0123456789ab"
)


class TestSecretDetection:
    def test_credential_key_names_are_recognized(self) -> None:
        for key in (
            "password",
            "access_token",
            "refresh_token",
            "API_KEY",
            "Authorization",
            "clientSecret",
            "X-Api-Key",
            "session_id",
        ):
            assert is_secret_key(key), key

    def test_ordinary_field_names_are_not(self) -> None:
        # Over-redaction is an oracle bug: these must survive untouched.
        for key in ("id", "email", "title", "count", "status", "created_at", "name"):
            assert not is_secret_key(key), key

    def test_jwt_shape_is_recognized_under_any_key(self) -> None:
        assert looks_like_jwt(JWT)

    def test_ordinary_dotted_strings_are_not_jwts(self) -> None:
        for value in ("v1.2.3", "example.com", "a.b.c", "2020-01-15T12:00:00Z"):
            assert not looks_like_jwt(value), value


class TestRedact:
    def test_the_login_response_that_leaked_is_scrubbed(self) -> None:
        """SEC-1, the exact body: POST /login/access-token → 200."""
        body = {"access_token": JWT, "token_type": "bearer"}
        assert redact(body) == {"access_token": PLACEHOLDER, "token_type": "bearer"}

    def test_a_jwt_under_an_innocent_key_is_still_scrubbed(self) -> None:
        assert redact({"detail": JWT}) == {"detail": PLACEHOLDER}

    def test_nested_and_listed_secrets_are_scrubbed(self) -> None:
        body = {"user": {"email": "a@b.com", "password": "hunter2"}, "tokens": [JWT]}
        assert redact(body) == {
            "user": {"email": "a@b.com", "password": PLACEHOLDER},
            "tokens": [PLACEHOLDER],
        }

    def test_shape_and_types_survive_so_the_invariant_oracle_still_works(self) -> None:
        """The oracle reads this field; redaction must not change its shape."""
        body = {"access_token": JWT, "expires_in": 3600, "scopes": ["a", "b"]}
        out = redact(body)
        assert sorted(out) == sorted(body)
        assert isinstance(out["access_token"], str)
        assert out["expires_in"] == 3600
        assert out["scopes"] == ["a", "b"]

    def test_ordinary_payloads_pass_through_untouched(self) -> None:
        body = {"id": 7, "title": "Buy milk", "done": False, "tags": ["home"]}
        assert redact(body) == body

    def test_the_callers_object_is_not_mutated(self) -> None:
        """run.py still checks invariants against the live body after redacting."""
        body = {"access_token": JWT}
        redact(body)
        assert body["access_token"] == JWT


class TestIdShaped:
    def test_real_ids_are_usable_as_path_params(self) -> None:
        for value in ("42", "8f14e45f-ea6a-4c1f-9b1a-000000000000", "507f1f77bcf86cd7", "my-slug"):
            assert is_id_shaped(value), value

    def test_a_bearer_token_is_never_usable_as_a_path_param(self) -> None:
        """SEC-2: this is what produced DELETE /users/<jwt>."""
        assert not is_id_shaped(JWT)

    def test_values_that_would_break_out_of_a_url_segment_are_rejected(self) -> None:
        for value in ("a/b", "a?b", "a#b", "a b", "x" * 80):
            assert not is_id_shaped(value), value


class TestRedactCornerCases:
    """The shapes that break naive redactors."""

    @pytest.mark.parametrize(
        "key",
        ["token_type", "token_endpoint", "tokens_used", "password_policy", "secret_santa_list"],
    )
    def test_names_that_merely_contain_a_secret_noun_are_kept(self, key: str) -> None:
        """Substring matching scrubbed `token_type` (value: "bearer") — an enum
        invariant legitimately learns that field. Over-redaction is an oracle bug."""
        assert not is_secret_key(key)
        assert redact({key: "bearer"}) == {key: "bearer"}

    @pytest.mark.parametrize(
        "key", ["access_token", "accessToken", "ACCESS-TOKEN", "x_api_key", "X-Api-Key", "apiKey"]
    )
    def test_separator_and_case_variants_all_match(self, key: str) -> None:
        assert is_secret_key(key)

    def test_plural_credential_names_match(self) -> None:
        assert is_secret_key("credentials") and is_secret_key("tokens")

    def test_non_string_secrets_are_scrubbed_too(self) -> None:
        """A numeric PIN or bool flag under a secret key still leaks."""
        out = redact({"otp": 123456, "password": True})
        assert out == {"otp": PLACEHOLDER, "password": PLACEHOLDER}

    def test_none_under_a_secret_key_stays_none(self) -> None:
        """Preserve null-ness so `never_null` still judges correctly."""
        assert redact({"token": None}) == {"token": None}

    def test_deeply_nested_and_list_of_dicts(self) -> None:
        body = {"a": [{"b": {"c": [{"password": "p", "id": 1}]}}]}
        assert redact(body) == {"a": [{"b": {"c": [{"password": PLACEHOLDER, "id": 1}]}}]}

    def test_empty_containers_and_scalars_pass_through(self) -> None:
        for value in ({}, [], "", 0, False, None, 3.14):
            assert redact(value) == value

    def test_tuples_keep_their_type(self) -> None:
        assert redact(("a", "b")) == ("a", "b")

    def test_redaction_is_idempotent(self) -> None:
        body = {"access_token": JWT, "n": 1}
        assert redact(redact(body)) == redact(body)

    def test_top_level_list_body_is_handled(self) -> None:
        assert redact([{"password": "x"}, {"id": 2}]) == [{"password": PLACEHOLDER}, {"id": 2}]

    @pytest.mark.parametrize(
        "value",
        [
            "eyJhbGciOiJIUzI1NiJ9",  # one segment
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0",  # two segments
            "notbase64!.abc.def",  # illegal chars
            "abc.def.ghi",  # right shape, wrong prefix
        ],
    )
    def test_near_miss_jwts_are_not_redacted(self, value: str) -> None:
        assert not looks_like_jwt(value)
        assert redact({"detail": value}) == {"detail": value}

    def test_a_jwt_with_an_empty_signature_is_still_a_jwt(self) -> None:
        assert looks_like_jwt("eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.")

    def test_unicode_keys_and_values_survive(self) -> None:
        assert redact({"名前": "太郎"}) == {"名前": "太郎"}


class TestIdShapedCornerCases:
    @pytest.mark.parametrize("value", ["", " ", "\n", "a\tb", "a/b", "a?b", "a#b", "a=b", "a&b"])
    def test_separators_and_blanks_are_rejected(self, value: str) -> None:
        assert not is_id_shaped(value)

    def test_length_boundary(self) -> None:
        assert is_id_shaped("x" * 64)
        assert not is_id_shaped("x" * 65)

    def test_a_dotted_version_string_is_id_shaped(self) -> None:
        """Dots alone are legal in a URL segment — only JWTs are excluded."""
        assert is_id_shaped("v1.2.3")

    def test_unicode_ids_are_allowed(self) -> None:
        assert is_id_shaped("café-7")


class TestLedgerHarvest:
    def test_the_ledger_never_records_a_bearer_token(self) -> None:
        """SEC-2 layer 2: state_ledger.jsonl is persisted in the user's repo."""
        rows = record_creations(
            [
                {
                    "endpoint_id": "POST_login_access-token",
                    "method": "POST",
                    "path": "/login/access-token",
                    "status": 200,
                    "input": {"body": {"username": "user@example.com", "password": "hunter2"}},
                    "body": {"access_token": JWT, "token_type": "bearer"},
                }
            ]
        )
        assert len(rows) == 1
        harvested = rows[0]["planted"] + rows[0]["response_values"]
        assert JWT not in harvested
        assert "hunter2" not in harvested
        assert PLACEHOLDER not in harvested
        # The non-secret scalars are still harvested — teardown depends on them.
        assert "user@example.com" in harvested
        assert "bearer" in harvested


# =========================================================================
# SEC-3: a credential rendered INSIDE an exception message
# =========================================================================


class TestSecretsInsideFreeText:
    """``redact`` decides by field name, which cannot reach inside one string.

    Found in a real run against demo-fastapi once the workers started using the
    target's own interpreter: every module failed to import because required
    settings were unset, and pydantic renders the whole input dict into the
    validation message — API key included. That message was persisted to
    ``.vinv/exercise/functions.json`` and printed to stdout.
    """

    def test_a_credential_in_a_rendered_dict_is_removed(self) -> None:
        from exerciser.redact import redact_text

        # Wholly fabricated. A fixture for a redaction test is the LAST place a
        # real credential should be pasted from a run's output, however dead the
        # key is believed to be — the test file is the artifact that gets pushed.
        message = (
            "5 validation errors for Settings\nPROJECT_NAME\n  Field required "
            "[type=missing, input_value={'openai_api_key': 'sk-proj-EXAMPLE-NOT-A-REAL-KEY', "
            "'project': 'demo'}, input_type=dict]"
        )
        cleaned = redact_text(message)
        assert "sk-proj-EXAMPLE-NOT-A-REAL-KEY" not in cleaned
        # The surrounding diagnostic is what makes the message useful.
        assert "PROJECT_NAME" in cleaned
        assert "'project': 'demo'" in cleaned

    def test_a_non_secret_key_does_not_swallow_the_secret_after_it(self) -> None:
        """The bug the first version of the pattern had.

        ``input_value={'openai_api_key': …}`` matched as the pair
        ``input_value`` → ``{'openai_api_key':`` — an innocent key whose "value"
        consumed the real credential, so it was never examined.
        """
        from exerciser.redact import redact_text

        cleaned = redact_text("input_value={'api_key': 'AKIAsecretsecret'}")
        assert "AKIAsecretsecret" not in cleaned

    @pytest.mark.parametrize(
        "text",
        [
            "POSTGRES_PASSWORD=s3cr3tvalue",
            '{"Authorization": "Bearer abc.def"}',
            "client_secret: 'shhh'",
            "X-Api-Key = 'abcdef123456'",
        ],
    )
    def test_the_credential_spellings_a_message_actually_carries(self, text: str) -> None:
        from exerciser.redact import redact_text

        cleaned = redact_text(text)
        assert PLACEHOLDER in cleaned

    @pytest.mark.parametrize(
        "text",
        [
            "token_type: bearer",
            "count: 5",
            "PROJECT_NAME=demo",
            "no credentials in this sentence",
            "",
        ],
    )
    def test_ordinary_text_is_left_alone(self, text: str) -> None:
        """Over-redaction is an oracle bug, exactly as it is for ``redact``."""
        from exerciser.redact import redact_text

        assert redact_text(text) == text

    def test_the_separator_and_quoting_survive(self) -> None:
        from exerciser.redact import redact_text

        assert redact_text("PASSWORD=x") == f"PASSWORD={PLACEHOLDER}"
        assert redact_text("'password': 'x'") == f"'password': '{PLACEHOLDER}'"


# =========================================================================
# SEC-4: a credential carried in a URL the engine writes down
# =========================================================================


class TestSecretsInsideUrls:
    """`is_id_shaped` already refuses to SPLICE a credential into a URL.

    The same credential arrives the other way round once the HTTP double records
    the request line it answered: plenty of providers authenticate by query
    parameter rather than by header (`?key=` is Gemini's spelling), and the
    target builds that URL from the real key `declared_env` loaded out of the
    repo's own `.env`. The ledger is a file inside the user's repository.
    """

    def test_a_key_in_a_query_parameter_is_removed(self) -> None:
        from exerciser.redact import redact_url

        cleaned = redact_url(
            "https://generativelanguage.googleapis.com/v1beta/models/x:go?key=AIzaSyREAL&alt=sse"
        )
        assert "AIzaSyREAL" not in cleaned
        # What the request WAS is the whole point of recording it.
        assert "generativelanguage.googleapis.com" in cleaned
        assert "alt=sse" in cleaned
        assert "key=" in cleaned

    def test_a_password_in_the_authority_is_removed(self) -> None:
        from exerciser.redact import redact_url

        cleaned = redact_url("postgresql://admin:hunter2@db.internal:5432/app")
        assert "hunter2" not in cleaned
        assert "admin" in cleaned and "db.internal:5432/app" in cleaned

    def test_a_jwt_under_any_parameter_name_is_removed(self) -> None:
        from exerciser.redact import redact_url

        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"
        assert jwt not in redact_url(f"https://api.example.com/v1/x?t={jwt}")

    @pytest.mark.parametrize(
        "url",
        [
            "https://api.openai.com/v1/chat/completions",
            "https://example.com/items?page=2&sort=name",
            "https://example.com/a/b#frag",
            "",
        ],
    )
    def test_an_ordinary_url_is_untouched(self, url: str) -> None:
        from exerciser.redact import redact_url

        assert redact_url(url) == url

    def test_the_fragment_survives(self) -> None:
        from exerciser.redact import redact_url

        cleaned = redact_url("https://h/p?api_key=SECRET#section")
        assert "SECRET" not in cleaned
        assert cleaned.endswith("#section")
