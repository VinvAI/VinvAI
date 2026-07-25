"""State ledger, teardown, scenario expiry, and drift classification.

The failure mode these guard (seen live on full-stack-fastapi): a 2xx
`POST /users/signup` planted a generated user; the next session's regress
flagged `POST /password-recovery/{email}` 404 → 200 as a behavior regression,
and a stale harness-authored login scenario silently 401'd an entire run.
"""

from __future__ import annotations

import json
from pathlib import Path

from exerciser import state, store
from exerciser.execute import ProbeResult
from exerciser.plan import _read_semantic_reply
from exerciser.regress import _confirm_perf_diff, replay_suite
from exerciser.run import _mark_expired_scenarios, _resolved_auth_headers


def _probe(status=200, body=None, latency=5.0):
    return ProbeResult(status, latency, body, "json:x", None, None, "json")


# ---- scalar extraction ------------------------------------------------------

def test_scalar_values_strings_only_and_min_length():
    vals = state.scalar_values({
        "email": "gen-user@example.test",
        "n": 12345, "ok": True, "tag": "ab",  # number/bool/short → dropped
        "nested": {"items": ["longvalue", {"k": "deep-value"}]},
    })
    assert vals == {"gen-user@example.test", "longvalue", "deep-value"}


# ---- creation recording -----------------------------------------------------

def _exec_row(method="POST", path="/users/signup", status=200,
              input=None, body=None):
    return {
        "endpoint_id": f"{method}_{path}", "method": method, "path": path,
        "status": status,
        "input": input if input is not None else {"body": {"email": "planted@x.test"}},
        "body": body,
    }


def test_record_creations_only_mutating_2xx():
    rows = state.record_creations([
        _exec_row(status=200, body={"id": "abcd-1234"}),
        _exec_row(status=401),                       # rejected — planted nothing
        _exec_row(method="GET", status=200),         # read — planted nothing
        _exec_row(method="DELETE", path="/items/{id}", status=200,
                  input={"path_params": {"id": "gone-item-id"}}),
    ])
    assert len(rows) == 2
    assert rows[0]["planted"] == ["planted@x.test"]
    assert rows[0]["response_values"] == ["abcd-1234"]
    assert not rows[0]["cleaned"]


# ---- teardown ---------------------------------------------------------------

def test_teardown_maps_creation_to_parent_delete_and_uses_auth():
    creation = state.record_creations(
        [_exec_row(body={"id": "user-uuid-1", "email": "planted@x.test"})]
    )
    endpoints = [
        {"method": "DELETE", "path": "/users/{user_id}"},
        {"method": "DELETE", "path": "/items/{id}"},  # wrong resource — no match
    ]
    calls = []

    def probe(base, method, path, *, body=None, path_params=None, query=None,
              headers=None, exercise_id="x", **kw):
        calls.append((method, path, dict(path_params or {}), dict(headers or {})))
        # Anonymous DELETE bounces; the captured token succeeds on the real id.
        if headers and path_params.get("user_id") == "user-uuid-1":
            return _probe(200)
        return _probe(401 if not headers else 404)

    cleaned = state.attempt_teardown(
        creation, endpoints, "http://x", probe,
        auth_headers=[{"Authorization": "Bearer tok-123"}],
    )
    assert cleaned == 1
    assert creation[0]["cleaned"] is True
    assert creation[0]["cleaned_via"] == "DELETE /users/{user_id}"
    # /users/signup matched DELETE /users/{user_id} via the literal prefix.
    assert all(p == "/users/{user_id}" for _, p, _, _ in calls)


def test_teardown_without_response_ids_is_a_noop():
    creation = state.record_creations([_exec_row(body=None)])
    cleaned = state.attempt_teardown(
        creation, [{"method": "DELETE", "path": "/users/{id}"}],
        "http://x", lambda *a, **k: _probe(200),
    )
    assert cleaned == 0 and not creation[0]["cleaned"]


def test_teardown_stamps_attempt_counts_and_status():
    creation = state.record_creations([_exec_row(body={"id": "user-uuid-1"})])
    endpoints = [{"method": "DELETE", "path": "/users/{id}"}]
    state.attempt_teardown(creation, endpoints, "http://x",
                           lambda *a, **k: _probe(404))
    assert creation[0]["teardown_attempts"] == 1
    assert creation[0]["teardown_status"] == "failed"
    state.attempt_teardown(creation, endpoints, "http://x",
                           lambda *a, **k: _probe(404))
    assert creation[0]["teardown_attempts"] == 2
    assert creation[0]["teardown_status"] == "failed-again"
    state.attempt_teardown(creation, endpoints, "http://x",
                           lambda *a, **k: _probe(200))
    assert creation[0]["teardown_attempts"] == 3
    assert creation[0]["teardown_status"] == "cleaned"


# ---- run-start re-attempt of prior pollution --------------------------------

def test_reattempt_teardown_cleans_prior_runs_rows(tmp_path):
    state.append_ledger(tmp_path, [
        {"endpoint_id": "POST_users", "method": "POST", "path": "/users/signup",
         "planted": ["stale@x.test"], "response_values": ["stale-uuid-1"],
         "cleaned": False, "teardown_attempts": 1, "teardown_status": "failed"},
        {"endpoint_id": "POST_done", "method": "POST", "path": "/users/signup",
         "planted": ["done@x.test"], "response_values": ["done-uuid-9"],
         "cleaned": True},
    ])
    auth_calls = []

    def auth_fn():
        auth_calls.append(1)
        return [{"Authorization": "Bearer fresh-tok"}]

    def probe(base, method, path, *, path_params=None, headers=None, **kw):
        # Only the freshly-captured credentials can delete the stale row.
        if headers and (path_params or {}).get("user_id") == "stale-uuid-1":
            return _probe(200)
        return _probe(401 if not headers else 404)

    summary = state.reattempt_teardown(
        tmp_path, [{"method": "DELETE", "path": "/users/{user_id}"}],
        "http://x", probe, auth_headers_fn=auth_fn,
    )
    assert summary == {"reattempted": 1, "cleaned": 1}
    assert auth_calls == [1], "credentials are earned once, lazily"
    ledger = store.read_jsonl(state.ledger_path(tmp_path))
    stale = next(r for r in ledger if r["endpoint_id"] == "POST_users")
    assert stale["cleaned"] is True
    assert stale["teardown_status"] == "cleaned"
    assert stale["teardown_attempts"] == 2
    # And the planted values stop polluting the drift classifier.
    assert "stale@x.test" not in state.planted_values(tmp_path)


def test_reattempt_teardown_marks_failed_again_and_skips_when_clean(tmp_path):
    state.append_ledger(tmp_path, [
        {"endpoint_id": "POST_users", "method": "POST", "path": "/users/signup",
         "planted": ["stuck@x.test"], "response_values": ["stuck-uuid-2"],
         "cleaned": False, "teardown_attempts": 1, "teardown_status": "failed"},
    ])
    summary = state.reattempt_teardown(
        tmp_path, [{"method": "DELETE", "path": "/users/{user_id}"}],
        "http://x", lambda *a, **k: _probe(404),
    )
    assert summary == {"reattempted": 1, "cleaned": 0}
    row = store.read_jsonl(state.ledger_path(tmp_path))[0]
    assert row["teardown_status"] == "failed-again"
    assert row["teardown_attempts"] == 2

    # An all-clean ledger short-circuits: no probes, no credential capture.
    store.write_jsonl(state.ledger_path(tmp_path), [{**row, "cleaned": True}])

    def exploding_auth():
        raise AssertionError("auth must not be captured when nothing is stale")

    summary = state.reattempt_teardown(
        tmp_path, [], "http://x",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no probes")),
        auth_headers_fn=exploding_auth,
    )
    assert summary == {"reattempted": 0, "cleaned": 0}


# ---- ledger + planted values ------------------------------------------------

def test_planted_values_skips_cleaned(tmp_path):
    state.append_ledger(tmp_path, [
        {"planted": ["kept@x.test"], "response_values": ["id-kept-1"], "cleaned": False},
        {"planted": ["gone@x.test"], "response_values": [], "cleaned": True},
    ])
    vals = state.planted_values(tmp_path)
    assert vals == {"kept@x.test", "id-kept-1"}


# ---- scenario expiry --------------------------------------------------------

def _scenario(completed, steps, planned=None, api_id="POST_things"):
    return {
        "name": "POST /things", "api_id": api_id, "completed": completed,
        "planned_steps": planned if planned is not None else len(steps),
        "steps": steps,
    }


def test_mark_expired_setup_failure_and_auth_bounce():
    setup_fail = _scenario(False, [
        {"endpoint": "POST /login", "status": 400, "ok": False},
    ], planned=2)
    auth_bounce = _scenario(False, [
        {"endpoint": "POST /login", "status": 200, "ok": True},
        {"endpoint": "POST /things", "status": 403, "ok": False},
    ], planned=2)
    legit_4xx = _scenario(False, [
        {"endpoint": "POST /things", "status": 422, "ok": False},
    ], planned=1)  # endpoint step failed on its own merits — NOT expiry
    done = _scenario(True, [{"endpoint": "POST /things", "status": 200, "ok": True}])

    expired = _mark_expired_scenarios([setup_fail, auth_bounce, legit_4xx, done])
    assert [s["name"] for s in expired] == ["POST /things", "POST /things"]
    assert setup_fail["expired"] and "setup" in setup_fail["expired_reason"]
    assert auth_bounce["expired"] and "endpoint" in auth_bounce["expired_reason"]
    assert "expired" not in legit_4xx and "expired" not in done


def test_expired_reply_suppressed_until_fresh_reply(tmp_path):
    prompt_file = store.prompts_dir(tmp_path) / "POST_things.json"
    reply = {"plans": [{"endpoint": "POST /things", "inputs": {}}]}
    store.write_json(prompt_file, {
        "api_id": "POST_things", "reply": reply,
        "reply_expired": "setup step POST /login got 400",
        "reply_expired_for": store.reply_fingerprint(reply),
    })
    assert _read_semantic_reply(prompt_file) is None  # stale — awaiting re-authorship

    fresh = {"plans": [{"endpoint": "POST /things", "inputs": {"body": {"v": 2}}}]}
    doc = store.read_json(prompt_file)
    doc["reply"] = fresh  # the extension stored a new reply; flag not cleared
    store.write_json(prompt_file, doc)
    assert _read_semantic_reply(prompt_file) == fresh["plans"]  # auto-revived


# ---- auth header harvesting -------------------------------------------------

def test_resolved_auth_headers_only_captured_and_fully_resolved():
    steps = [
        {"inputs": {"headers": {"Authorization": "Bearer ${access_token}"}}},
        {"inputs": {"headers": {"X-Static": "fixed"}}},          # static — skip
        {"inputs": {"headers": {"Authorization": "Bearer ${missing}"}}},  # unresolved
    ]
    out = _resolved_auth_headers(steps, {"access_token": "tok-xyz"})
    assert out == [{"Authorization": "Bearer tok-xyz"}]


# ---- regress drift + perf confirmation --------------------------------------

def test_regress_classifies_planted_diff_as_environment(tmp_path):
    store.write_jsonl(store.results_path(tmp_path), [{
        "endpoint_id": "POST_recovery", "method": "POST",
        "path": "/password-recovery/{email}", "handler": None,
        "strategy": "schema_valid", "input_class": "valid",
        "input": {"body": None, "path_params": {"email": "planted@x.test"}, "query": {}},
        "status": 404, "shape_hash": "json:err", "latency_ms": 3.0,
    }])
    state.append_ledger(tmp_path, [
        {"planted": ["planted@x.test"], "response_values": [], "cleaned": False},
    ])
    summary = replay_suite(
        tmp_path, "http://x",
        probe_fn=lambda *a, **k: _probe(200, {"message": "sent"}),
    )
    assert summary["behavior_diffs"] == 0
    assert summary["environment_diffs"] == 1
    assert summary["diffs"][0]["kind"] == "environment"


def test_perf_diff_needs_median_confirmation():
    case = {
        "method": "GET", "path": "/items", "input": {"path_params": {}},
        "input_class": "boundary", "prev_latency_ms": 5.0,
    }
    warm = iter([40.0, 6.0, 5.5, 6.2])  # first replay still cold, rest warm

    def probe(*a, **k):
        return _probe(200, None, latency=next(warm))

    assert _confirm_perf_diff(case, "http://x", 2.0, probe, "t") is None

    def slow(*a, **k):
        return _probe(200, None, latency=30.0)

    confirmed = _confirm_perf_diff(case, "http://x", 2.0, slow, "t")
    assert confirmed and confirmed["kind"] == "perf" and "median" in confirmed["detail"]


def test_user_authored_reply_feeds_plan_for_non_semantic_endpoint(tmp_path):
    """The Journey view writes user plans for ORDINARY endpoints too — plan
    must fold them in even when the endpoint never needed semantics."""
    from exerciser.plan import build_plan

    store.write_json(store.apis_json_path(tmp_path), {"apis": [{
        "id": "GET_health", "method": "GET", "path": "/health",
        "handler": "health", "file": "app.py", "line": 1,
    }]})
    store.write_json(store.prompts_dir(tmp_path) / "GET_health.json", {
        "api_id": "GET_health",
        "reply": {"plans": [{"endpoint": "GET /health",
                             "inputs": {"query": {"verbose": True}},
                             "user_authored": True}]},
    })
    result = build_plan(tmp_path)
    ep = next(e for e in result["endpoints"] if e["api_id"] == "GET_health")
    assert ep.get("semantic_inputs"), "user-authored plan must reach the plan"
    assert ep["semantic_inputs"][0]["user_authored"] is True
