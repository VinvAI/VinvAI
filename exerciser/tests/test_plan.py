"""Plan builder: three provenance layers, semantic prompts, offline fallback."""

from __future__ import annotations

import json
from pathlib import Path

from exerciser import store
from exerciser.plan import build_plan, render_semantic_prompt
from exerciser.openapi import Endpoint


def _seed_apis(repo: Path, apis: list[dict]):
    p = store.apis_json_path(repo)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"apis": apis}), encoding="utf-8")


def test_plan_offline_from_apis(tmp_path):
    _seed_apis(tmp_path, [
        {"id": "GET_health", "method": "GET", "path": "/health", "handler": "health"},
        {"id": "DELETE_items_id", "method": "DELETE", "path": "/items/{id}", "handler": "delete_item"},
    ])
    result = build_plan(tmp_path, base_url=None)
    assert result["status"] == "ok"
    assert result["input_source"] == "apis.json"
    assert result["endpoint_count"] == 2
    # DELETE on a {id} resource is flagged semantic → a prompt is rendered.
    assert result["semantic_prompt_count"] >= 1
    assert store.plan_path(tmp_path).exists()


def test_plan_has_all_three_schema_classes(tmp_path):
    _seed_apis(tmp_path, [{"id": "GET_x", "method": "GET", "path": "/x", "handler": "h"}])
    result = build_plan(tmp_path)
    inputs = result["endpoints"][0]["inputs"]
    classes = {i["class"] for i in inputs}
    assert {"valid", "boundary", "negative"} <= classes


def test_semantic_prompt_ends_with_reply_schema_and_tools():
    ep = Endpoint(api_id="POST_login", method="POST", path="/login/access-token",
                  handler="login", requires_auth=False, needs_semantics=True,
                  body_schema={"type": "object", "properties": {"username": {"type": "string"}}})
    prompt = render_semantic_prompt(ep, {"username": "a@b.c"}, coverage_gaps=["verify_pw", "get_user"])
    assert '"plans"' in prompt  # exact reply schema present
    assert ".vinv/exercise/" in prompt  # tells the agent its artifacts
    assert "verify_pw" in prompt  # coverage gaps threaded in


def test_semantic_prompt_written_to_disk(tmp_path):
    _seed_apis(tmp_path, [
        {"id": "POST_login_access_token", "method": "POST",
         "path": "/login/access-token", "handler": "login"},
    ])
    build_plan(tmp_path)
    prompts = list(store.prompts_dir(tmp_path).glob("*.json"))
    assert prompts
    doc = json.loads(prompts[0].read_text())
    assert "prompt" in doc and "reply_schema" in doc and doc["reply"] is None
