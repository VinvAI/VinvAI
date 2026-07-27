"""Endpoints that were permanently unreachable (audit COR-1, COR-2).

Both defects produced the same silent outcome — an endpoint that can never
succeed, at 0% coverage, with no diagnostic, because it 422s or 401s rather
than 5xx-ing and so never forms an issue cluster.

  COR-1  `_body_schema_of` selected a schema from the form media type and threw
         the media type away at the point of selection; `Endpoint` had no field
         to carry it. FastAPI's OAuth2 password flow declares ONLY
         `application/x-www-form-urlencoded`, so `POST /login/access-token` was
         JSON-encoded and 422'd on every probe — and with no token, the entire
         authenticated pass was skipped.
  COR-2  `_op_requires_auth` read only the per-operation `security`. OpenAPI 3.x
         defines a ROOT `security` array as the default every operation inherits,
         which is the standard way to protect a whole API. Such documents looked
         entirely public: no anonymous permutation, no semantic prompt (so no
         login chain was ever authored), no auth sweep.
"""

from __future__ import annotations

import pytest

from exerciser.openapi import (
    Endpoint,
    _body_schema_and_type,
    _op_requires_auth,
    content_kind,
)

_FORM = "application/x-www-form-urlencoded"
_SCHEMA = {"type": "object", "properties": {"username": {"type": "string"}}}


def _op(media: str) -> dict:
    return {"requestBody": {"content": {media: {"schema": _SCHEMA}}}}


class TestBodyMediaTypeSurvives:
    def test_a_form_only_operation_reports_form(self) -> None:
        """The OAuth2 password flow, the case that broke every auth run."""
        schema, media = _body_schema_and_type(_op(_FORM), {})
        assert schema == _SCHEMA
        assert content_kind(media) == "form"

    def test_a_json_operation_reports_json_encoding(self) -> None:
        schema, media = _body_schema_and_type(_op("application/json"), {})
        assert schema == _SCHEMA
        assert content_kind(media) is None

    def test_json_is_preferred_when_both_are_offered(self) -> None:
        op = {
            "requestBody": {
                "content": {_FORM: {"schema": _SCHEMA}, "application/json": {"schema": _SCHEMA}}
            }
        }
        assert content_kind(_body_schema_and_type(op, {})[1]) is None

    def test_an_exotic_media_type_falls_back_to_json_encoding(self) -> None:
        assert content_kind(_body_schema_and_type(_op("application/vnd.api+json"), {})[1]) is None

    @pytest.mark.parametrize(
        "op", [{}, {"requestBody": {}}, {"requestBody": {"content": {}}}, {"requestBody": None}]
    )
    def test_an_operation_without_a_body_reports_neither(self, op: dict) -> None:
        assert _body_schema_and_type(op, {}) == (None, None)

    def test_content_kind_tolerates_none(self) -> None:
        assert content_kind(None) is None

    def test_the_endpoint_carries_it_into_the_plan(self) -> None:
        """plan.py spreads `to_json()`, so the field must be serialized."""
        ep = Endpoint(api_id="e", method="POST", path="/login", handler=None, content_type="form")
        assert ep.to_json()["content_type"] == "form"

    def test_the_default_is_json(self) -> None:
        ep = Endpoint(api_id="e", method="GET", path="/x", handler=None)
        assert ep.to_json()["content_type"] is None


class TestRootLevelSecurityIsInherited:
    _SECURED = {"security": [{"bearerAuth": []}]}

    def test_an_operation_inherits_the_document_default(self) -> None:
        assert _op_requires_auth({}, self._SECURED)

    def test_an_explicit_empty_security_opts_out(self) -> None:
        """`security: []` on the operation is a deliberate public override."""
        assert not _op_requires_auth({"security": []}, self._SECURED)

    def test_an_operation_level_requirement_still_wins(self) -> None:
        assert _op_requires_auth({"security": [{"oauth": []}]}, {})

    def test_a_document_with_no_security_leaves_operations_public(self) -> None:
        assert not _op_requires_auth({}, {})
        assert not _op_requires_auth({}, {"security": []})

    def test_a_missing_spec_argument_is_tolerated(self) -> None:
        """Back-compat: the old one-argument call must still work."""
        assert not _op_requires_auth({})
        assert _op_requires_auth({"security": [{"k": []}]})

    @pytest.mark.parametrize("root", ["bearer", {"bearerAuth": []}, None, 0])
    def test_a_malformed_root_security_is_ignored(self, root: object) -> None:
        assert not _op_requires_auth({}, {"security": root})
