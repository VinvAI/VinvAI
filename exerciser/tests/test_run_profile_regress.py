"""End-to-end loop with fakes: plan → run (coverage-guided) → profile → regress.

Uses a fake service (in-process) and a fake coverage function so the whole
pipeline — bandit selection, reward attribution, results/profile schemas,
regression diffing, invariant learning — is exercised without a live server.
"""

from __future__ import annotations

from pathlib import Path

from exerciser import store
from exerciser.execute import ProbeResult
from exerciser.profile import build_profile
from exerciser.regress import replay_suite
from exerciser.run import run_exercise


def _write_plan(repo: Path):
    plan = {
        "status": "ok",
        "endpoint_count": 2,
        "input_source": "apis.json",
        "endpoints": [
            {
                "api_id": "GET_health",
                "method": "GET",
                "path": "/health",
                "handler": "health",
                "inputs": [
                    {
                        "strategy": "schema_valid",
                        "provenance": "schema",
                        "class": "valid",
                        "body": None,
                        "path_params": {},
                        "query": {},
                    },
                    {
                        "strategy": "schema_negative",
                        "provenance": "schema",
                        "class": "negative",
                        "body": None,
                        "path_params": {},
                        "query": {},
                    },
                ],
            },
            {
                "api_id": "POST_items",
                "method": "POST",
                "path": "/items",
                "handler": "create_item",
                "inputs": [
                    {
                        "strategy": "schema_valid",
                        "provenance": "schema",
                        "class": "valid",
                        "body": {"title": "x"},
                        "path_params": {},
                        "query": {},
                    },
                ],
            },
        ],
    }
    store.write_json(store.plan_path(repo), plan)


class FakeService:
    """A trivial in-memory service: /health returns a monotone id, /items 500s."""

    def __init__(self):
        self.counter = 0

    def __call__(
        self,
        base,
        method,
        path,
        *,
        body=None,
        path_params=None,
        query=None,
        headers=None,
        content_type=None,
        exercise_id="x",
        **_kw,
    ):
        if path == "/health":
            self.counter += 1
            return ProbeResult(
                200, 5.0, {"id": self.counter, "status": "ok"}, "json:health", None, None, "json"
            )
        # /items always crashes (a DB-free endpoint 500ing — the demo's shape).
        return ProbeResult(500, 3.0, {"detail": "no database"}, "json:err", None, None, "json")


def _fake_coverage_factory():
    """Coverage grows by one symbol per health probe, capped at 4."""
    seen = {"GET_health": 0, "POST_items": 0}

    def cov(repo, api_id, **kw):
        if api_id == "GET_health":
            seen[api_id] = min(4, seen[api_id] + 1)
            covered = {f"h{i}" for i in range(seen[api_id])}
            return {
                "api_id": api_id,
                "covered_ids": covered,
                "covered": len(covered),
                "total": 4,
                "pct": 25.0 * len(covered),
                "uncovered": [],
                "handler_observed": True,
            }
        return {
            "api_id": api_id,
            "covered_ids": set(),
            "covered": 0,
            "total": 4,
            "pct": 0.0,
            "uncovered": ["a", "b"],
            "handler_observed": False,
        }

    return cov


def test_full_loop(tmp_path):
    repo = tmp_path
    (repo / ".vinv" / "exercise").mkdir(parents=True)
    _write_plan(repo)

    result = run_exercise(
        repo,
        "http://fake",
        budget=40,
        rounds=2,
        settle_s=0.0,
        probe_fn=FakeService(),
        coverage_fn=_fake_coverage_factory(),
    )
    assert result["status"] == "ok"
    assert result["probes_spent"] > 0
    # /items 500s were clustered into an issue.
    assert result["issue_clusters"] >= 1
    issues = store.read_json(store.issues_path(repo))
    assert any(c["kind"] == "server-error" for c in issues["clusters"])
    # results.jsonl exists and every row has the required fields.
    rows = store.read_jsonl(store.results_path(repo))
    assert rows
    for r in rows:
        assert {"endpoint_id", "strategy", "status", "latency_ms", "shape_hash"} <= set(r)

    # Profile builds from results.jsonl (coverage re-joins from disk, which has
    # no real capture in this test — so assert on the schema, not live coverage).
    prof = build_profile(repo)
    assert prof["status"] == "ok"
    assert prof["endpoint_count"] == 2


def test_run_without_plan_errors(tmp_path):
    (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
    result = run_exercise(
        tmp_path, "http://fake", probe_fn=FakeService(), coverage_fn=_fake_coverage_factory()
    )
    assert result["status"] == "error"


def test_profile_and_regress_over_recorded_results(tmp_path):
    repo = tmp_path
    (repo / ".vinv" / "exercise").mkdir(parents=True)
    # Hand-write results with a healthy endpoint observed many times → invariants.
    rows = []
    for i in range(1, 8):
        rows.append(
            {
                "round": 1,
                "endpoint_id": "GET_health",
                "api_id": "GET_health",
                "method": "GET",
                "path": "/health",
                "handler": "health",
                "strategy": "schema_valid",
                "provenance": "schema",
                "input_class": "valid",
                "input": {"body": None, "path_params": {}, "query": {}},
                "expected": "2xx",
                "status": 200,
                "status_class": "2xx-3xx",
                "latency_ms": 5.0,
                "shape_hash": "json:health",
                "error": None,
                "request_id": None,
                "output_size": 2,
                "input_size": 1,
                "body": {"id": i, "status": "ok"},
            }
        )
    store.write_jsonl(store.results_path(repo), rows)

    prof = build_profile(repo)
    assert prof["status"] == "ok"
    health = next(e for e in prof["endpoints"] if e["api_id"] == "GET_health")
    inv_kinds = {i["kind"] for i in health["invariants"]}
    # never_null on 'status'/'id', id_monotonic on 'id', stable_enum on 'status'.
    assert "never_null" in inv_kinds
    assert "id_monotonic" in inv_kinds
    assert (store.exercise_dir(repo) / "profile.md").exists()

    # Regress replays the recorded suite; a fake service that keeps the contract
    # → no degrade.
    def keeper(base, method, path, **kw):
        return ProbeResult(200, 5.0, {"id": 1, "status": "ok"}, "json:health", None, None, "json")

    reg = replay_suite(repo, "http://fake", probe_fn=keeper)
    assert reg["status"] == "ok"
    assert reg["degraded"] == 0

    # A service that now 500s the same input → degraded.
    def breaker(base, method, path, **kw):
        return ProbeResult(500, 5.0, None, "empty", None, None, None)

    reg2 = replay_suite(repo, "http://fake", probe_fn=breaker)
    assert reg2["degraded"] >= 1
    assert reg2["behavior_diffs"] >= 1


def test_regress_without_results_errors(tmp_path):
    (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
    assert replay_suite(tmp_path, "http://x")["status"] == "error"
