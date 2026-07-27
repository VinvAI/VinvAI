"""OpenAPI parsing + apis.json reconciliation + fallback."""

from __future__ import annotations

from exerciser.openapi import (
    endpoints_from_apis,
    endpoints_from_openapi,
    path_param_names,
)

SPEC = {
    "paths": {
        "/api/v1/utils/test-email/": {
            "post": {
                "operationId": "test_email",
                "requestBody": {
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/Email"}}
                    }
                },
                "security": [{"OAuth2": []}],
            }
        },
        "/api/v1/items/{id}": {
            "get": {
                "parameters": [
                    {"name": "id", "in": "path", "required": True, "schema": {"type": "integer"}}
                ]
            },
        },
        "/api/v1/openapi.json": {"get": {}},  # skipped
    },
    "components": {
        "schemas": {"Email": {"type": "object", "properties": {"email_to": {"type": "string"}}}}
    },
}

APIS = [
    {
        "id": "POST_utils_test_email",
        "method": "POST",
        "path": "/utils/test-email/",
        "handler": "test_email",
    },
    {"id": "GET_items_id", "method": "GET", "path": "/items/{id}", "handler": "read_item"},
]


def test_openapi_resolves_real_paths_and_handlers():
    eps = endpoints_from_openapi(SPEC, APIS)
    by_id = {e.api_id: e for e in eps}
    # Reconciled to the apis.json handler, real /api/v1 path from OpenAPI.
    te = by_id["POST_utils_test_email"]
    assert te.path == "/api/v1/utils/test-email/"
    assert te.handler == "test_email"
    assert te.requires_auth is True
    assert te.body_schema and "email_to" in te.body_schema["properties"]


def test_openapi_skips_spec_endpoints():
    eps = endpoints_from_openapi(SPEC, APIS)
    assert not any("openapi.json" in e.path for e in eps)


def test_ref_resolution_inlines_component():
    eps = endpoints_from_openapi(SPEC, APIS)
    te = next(e for e in eps if e.api_id == "POST_utils_test_email")
    assert te.body_schema.get("type") == "object"


def test_apis_fallback_synthesizes_path_params():
    eps = endpoints_from_apis(APIS)
    gi = next(e for e in eps if e.api_id == "GET_items_id")
    # id → integer schema synthesized.
    assert gi.param_schemas and gi.param_schemas[0]["schema"]["type"] == "integer"
    assert gi.source == "apis"


def test_semantic_flag_on_auth_and_resource_mutations():
    eps = endpoints_from_openapi(SPEC, APIS)
    te = next(e for e in eps if e.api_id == "POST_utils_test_email")
    assert te.needs_semantics is True  # auth chain / security present


def test_path_param_names():
    assert path_param_names("/items/{id}/x/{sub}") == ["id", "sub"]
    assert path_param_names("/a/<int:pk>") == ["pk"]
    assert path_param_names("/static") == []
