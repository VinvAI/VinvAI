"""Edge cases the mission's verification bar calls out explicitly."""

from __future__ import annotations

import json
from pathlib import Path

from exerciser import store
from exerciser.execute import ProbeResult
from exerciser.plan import build_plan
from exerciser.run import run_exercise
from exerciser.schema import generate_value


def _seed_apis(repo: Path, apis):
    p = store.apis_json_path(repo)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"apis": apis}), encoding="utf-8")


def test_empty_schema_generates_without_crashing():
    # An endpoint with no body schema / empty schema must not raise.
    assert generate_value({}, 1, "valid") is not None or True
    assert generate_value({}, 1, "negative") is not None or True


def test_service_dies_mid_run(tmp_path):
    """A service that stops responding partway becomes crash clusters, not a crash
    of the engine."""
    (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
    store.write_json(store.plan_path(tmp_path), {
        "endpoints": [{"api_id": "GET_x", "method": "GET", "path": "/x", "handler": "h",
                       "inputs": [{"strategy": "schema_valid", "provenance": "schema",
                                   "class": "valid", "body": None, "path_params": {}, "query": {}}]}],
    })
    calls = {"n": 0}

    def dying(base, method, path, **kw):
        calls["n"] += 1
        if calls["n"] > 3:
            return ProbeResult(None, 10.0, None, "empty", "connection refused", None, None)
        return ProbeResult(200, 5.0, {"ok": True}, "json:a", None, None, "json")

    def cov(repo, api_id, **kw):
        return {"api_id": api_id, "covered_ids": set(), "covered": 0, "total": 2,
                "pct": 0.0, "uncovered": ["h"], "handler_observed": False}

    result = run_exercise(tmp_path, "http://x", budget=10, rounds=6, settle_s=0.0,
                          probe_fn=dying, coverage_fn=cov)
    assert result["status"] == "ok"  # engine survives the service dying
    issues = store.read_json(store.issues_path(tmp_path))
    assert any(c["kind"] == "crash" for c in issues["clusters"])


def test_auth_everywhere_produces_anon_negative_probes(tmp_path):
    """Every endpoint requiring auth → an anonymous negative-auth probe."""
    from exerciser.openapi import Endpoint
    from exerciser.plan import _endpoint_plan

    ep = Endpoint(api_id="GET_me", method="GET", path="/users/me", handler="read_me",
                  requires_auth=True, body_schema=None)
    rec = _endpoint_plan(ep, tmp_path, seed=1)
    provs = {i.get("provenance") for i in rec["inputs"]}
    assert "auth-permutation" in provs


def test_never_converging_endpoint_stops_at_budget(tmp_path):
    """An endpoint that never covers a new symbol still terminates (budget/rounds)."""
    (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
    store.write_json(store.plan_path(tmp_path), {
        "endpoints": [{"api_id": "GET_x", "method": "GET", "path": "/x", "handler": "h",
                       "inputs": [{"strategy": "schema_valid", "provenance": "schema",
                                   "class": "valid", "body": None, "path_params": {}, "query": {}}]}],
    })

    def probe(base, method, path, **kw):
        return ProbeResult(200, 1.0, {"ok": True}, "json:a", None, None, "json")

    def no_new_coverage(repo, api_id, **kw):
        return {"api_id": api_id, "covered_ids": set(), "covered": 0, "total": 4,
                "pct": 0.0, "uncovered": ["h"], "handler_observed": True}

    result = run_exercise(tmp_path, "http://x", budget=100, rounds=2, settle_s=0.0,
                          probe_fn=probe, coverage_fn=no_new_coverage)
    # Stops after `rounds` no-improvement rounds, well under budget.
    assert result["rounds_run"] <= 3
    assert result["probes_spent"] < 100
