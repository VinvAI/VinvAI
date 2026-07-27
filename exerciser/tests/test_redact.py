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
