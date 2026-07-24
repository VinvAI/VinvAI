"""Auth-permutation sweep, environment canary, bandit prior decay, authed regress.

The gaps these close, seen live: DELETE/PATCH-by-id endpoints sat at 0 coverage
because only one scenario carried credentials; a reset database failed silently
mid-run instead of loudly up front; and every run re-explored strategies from
scratch.
"""

from __future__ import annotations

from pathlib import Path

from exerciser import state, store
from exerciser.bandit import EndpointBandit, seed_from_prior
from exerciser.execute import ProbeResult
from exerciser.regress import replay_suite
from exerciser.run import _auth_sweep, _environment_canary

import logging

LOG = logging.getLogger("test")


def _probe(status=200, body=None, latency=5.0):
    return ProbeResult(status, latency, body, "json:x", None, None, "json")


def _endpoint(api_id="DELETE_users_id", method="DELETE",
              path="/users/{user_id}", **kw):
    return {
        "api_id": api_id, "method": method, "path": path, "handler": None,
        "inputs": [{
            "strategy": "schema_valid", "provenance": "schema", "class": "valid",
            "body": None, "path_params": {"user_id": "generated-uuid"},
            "query": {},
        }],
        **kw,
    }


# ---- auth sweep -------------------------------------------------------------

def test_auth_sweep_substitutes_real_ids_and_marks_rows():
    hits = []

    def probe(base, method, path, *, body=None, path_params=None, query=None,
              headers=None, exercise_id="x", **kw):
        hits.append((path_params.get("user_id"), dict(headers or {})))
        ok = headers and path_params.get("user_id") == "real-id-123"
        return _probe(200 if ok else 404)

    rows = _auth_sweep(
        [_endpoint()], "http://x", "t", probe,
        [{"Authorization": "Bearer tok"}], ["real-id-123"], LOG,
    )
    # one plain variant + one real-id substitution, all authed and flagged
    assert len(rows) == 2
    assert all(r["strategy"] == "authed" and r["auth"] is True for r in rows)
    assert ("real-id-123", {"Authorization": "Bearer tok"}) in hits
    assert any(r["status"] == 200 for r in rows)


def test_auth_sweep_without_credentials_is_a_noop():
    assert _auth_sweep([_endpoint()], "http://x", "t",
                       lambda *a, **k: _probe(), [], ["id"], LOG) == []


# ---- environment canary -----------------------------------------------------

def _scenario_endpoint(setup_status_probe):
    return {
        **_endpoint(api_id="POST_email", method="POST", path="/email"),
        "semantic_inputs": [{
            "inputs": {},
            "setup": [{"endpoint": "POST /login", "inputs": {"body": {"u": "x"}},
                       "capture": {"tok": "/access_token"}}],
        }],
    }


def test_canary_reports_failing_setup_step_once():
    def probe(*a, **k):
        return _probe(400, {"detail": "Incorrect email or password"})

    # Two endpoints sharing the same login chain — one canary probe, deduped.
    eps = [_scenario_endpoint(400), _scenario_endpoint(400)]
    canary = _environment_canary(eps, "http://x", "t", probe, LOG)
    assert canary["failed"] == [{"step": "POST /login", "status": 400}]


def test_canary_passes_on_healthy_setup():
    canary = _environment_canary(
        [_scenario_endpoint(200)], "http://x", "t",
        lambda *a, **k: _probe(200, {"access_token": "t"}), LOG,
    )
    assert canary == {"checked": 1, "failed": []}


# ---- bandit prior decay -----------------------------------------------------

def test_seed_from_prior_halves_evidence():
    b = seed_from_prior(
        EndpointBandit(strategies=("schema_valid", "semantic")),
        {"schema_valid": {"alpha": 9.0, "beta": 3.0}},
        decay=0.5,
    )
    assert b.arms["schema_valid"].alpha == 5.0   # 1 + (9-1)*0.5
    assert b.arms["schema_valid"].beta == 2.0    # 1 + (3-1)*0.5
    assert b.arms["semantic"].alpha == 1.0       # untouched arm stays uniform


# ---- authed regress replay --------------------------------------------------

def _write_authed_results(repo: Path):
    store.write_jsonl(store.results_path(repo), [{
        "endpoint_id": "GET_users", "method": "GET", "path": "/users",
        "handler": None, "strategy": "authed", "input_class": "authed_valid",
        "input": {"body": None, "path_params": {}, "query": {}},
        "status": 200, "shape_hash": "json:users", "latency_ms": 4.0,
        "auth": True,
    }])


def _write_auth_plan(repo: Path):
    store.write_json(store.plan_path(repo), {"endpoints": [{
        "api_id": "POST_email", "method": "POST", "path": "/email",
        "semantic_inputs": [{
            "inputs": {"headers": {"Authorization": "Bearer ${tok}"}},
            "setup": [{"endpoint": "POST /login", "inputs": {},
                       "capture": {"tok": "/access_token"}}],
        }],
    }]})


def test_regress_replays_authed_cases_with_fresh_credentials(tmp_path):
    _write_authed_results(tmp_path)
    _write_auth_plan(tmp_path)

    def probe(base, method, path, *, headers=None, **kw):
        if path == "/login":
            return _probe(200, {"access_token": "fresh-tok"})
        if (headers or {}).get("Authorization") == "Bearer fresh-tok":
            return _probe(200, {"users": []}, latency=4.0)
        return _probe(401, {"detail": "nope"})

    # Shape hash must match the recorded one for a no-diff replay.
    def probe_shape(base, method, path, **kw):
        r = probe(base, method, path, **kw)
        return ProbeResult(r.status, r.latency_ms, r.body,
                           "json:users" if r.status == 200 else "json:err",
                           None, None, "json")

    summary = replay_suite(tmp_path, "http://x", probe_fn=probe_shape)
    assert summary["auth_cases_skipped"] == 0
    assert summary["behavior_diffs"] == 0


def test_regress_skips_authed_cases_when_no_setup_available(tmp_path):
    _write_authed_results(tmp_path)
    store.write_json(store.plan_path(tmp_path), {"endpoints": []})
    summary = replay_suite(
        tmp_path, "http://x", probe_fn=lambda *a, **k: _probe(401),
    )
    assert summary["auth_cases_skipped"] == 1
    assert summary["behavior_diffs"] == 0  # skipped, not misreported


def test_auth_sweep_creator_ids_flow_to_deleters_same_sweep():
    """A 2xx authed POST mints an id the DELETE later in the sweep targets."""
    creator = _endpoint(api_id="POST_users", method="POST", path="/users")
    creator["inputs"][0]["path_params"] = {}
    deleter = _endpoint()  # DELETE /users/{user_id}
    deleted = []

    def probe(base, method, path, *, body=None, path_params=None, query=None,
              headers=None, exercise_id="x", **kw):
        if method == "POST":
            return _probe(200, {"id": "minted-id-99", "email": "a@x.test"})
        if method == "DELETE":
            deleted.append(path_params.get("user_id"))
            return _probe(200 if path_params.get("user_id") == "minted-id-99" else 404)
        return _probe(404)

    rows = _auth_sweep(
        [deleter, creator], "http://x", "t", probe,  # unsorted on purpose
        [{"Authorization": "Bearer tok"}], [], LOG,
    )
    assert "minted-id-99" in deleted
    assert any(r["method"] == "DELETE" and r["status"] == 200 for r in rows)
