"""Stateful scenarios: substitution, JSON pointer capture, sequential flow."""

from __future__ import annotations

from exerciser.execute import ProbeResult
from exerciser.scenario import json_pointer, run_scenario, substitute


def test_substitute_whole_string_preserves_type():
    assert substitute("${id}", {"id": 42}) == 42
    assert substitute("Bearer ${tok}", {"tok": "abc"}) == "Bearer abc"


def test_substitute_recurses():
    out = substitute({"headers": {"Authorization": "Bearer ${t}"}, "path_params": {"id": "${id}"}},
                     {"t": "xyz", "id": 7})
    assert out["headers"]["Authorization"] == "Bearer xyz"
    assert out["path_params"]["id"] == 7


def test_json_pointer_paths():
    body = {"access_token": "tok", "user": {"id": 5}, "items": [{"id": 9}]}
    assert json_pointer(body, "/access_token") == "tok"
    assert json_pointer(body, "user.id") == 5
    assert json_pointer(body, "items/0/id") == 9
    assert json_pointer(body, "missing") is None


def test_scenario_threads_captured_variables():
    calls: list[dict] = []

    def fake_probe(base, method, path, *, body=None, path_params=None, query=None,
                   headers=None, content_type=None, exercise_id="x"):
        calls.append({"method": method, "path": path, "headers": headers or {},
                      "path_params": path_params or {}})
        if path == "/login":
            return ProbeResult(200, 1.0, {"access_token": "TOK"}, "json:a", None, None, "json")
        if path == "/items":
            return ProbeResult(200, 1.0, {"id": 123}, "json:b", None, None, "json")
        return ProbeResult(200, 1.0, {"id": 123, "title": "t"}, "json:c", None, None, "json")

    steps = [
        {"method": "POST", "path": "/login", "inputs": {}, "capture": {"token": "/access_token"}},
        {"method": "POST", "path": "/items",
         "inputs": {"headers": {"Authorization": "Bearer ${token}"}, "body": {"title": "t"}},
         "capture": {"item_id": "/id"}},
        {"method": "GET", "path": "/items/${item_id}",
         "inputs": {"headers": {"Authorization": "Bearer ${token}"},
                    "path_params": {"item_id": "${item_id}"}}},
    ]
    res = run_scenario("http://x", "flow", steps, probe_fn=fake_probe)
    assert res.completed
    # The token flowed into later request headers.
    assert calls[1]["headers"]["Authorization"] == "Bearer TOK"
    assert calls[2]["path_params"]["item_id"] == 123


def test_scenario_stops_on_failed_step():
    def fake_probe(base, method, path, **kw):  # noqa: ARG001
        return ProbeResult(500, 1.0, None, "empty", None, None, None)

    steps = [
        {"method": "POST", "path": "/a", "inputs": {}, "expect": {"status": 200}},
        {"method": "POST", "path": "/b", "inputs": {}},
    ]
    res = run_scenario("http://x", "flow", steps, probe_fn=fake_probe)
    assert not res.completed
    assert len(res.steps) == 1  # stopped after the first failing step
