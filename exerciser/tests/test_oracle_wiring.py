"""The wrong-value oracle, end to end: learn → enforce → cluster → baseline.

Covers the gap that made a plausibly-shaped WRONG answer invisible: the
``invariant_violation`` flag ``issues.py`` reads had no writer anywhere, golden
baselines erased values, and nothing judged a 2xx whose body silently changed.
"""

from __future__ import annotations

from exerciser import store
from exerciser.baseline import apply_baselines, compare_observation
from exerciser.execute import ProbeResult, response_value_digest
from exerciser.invariants import (
    Observation,
    check_monotonic_sequence,
    check_observation,
    learn_invariants,
)
from exerciser.issues import clusters_from_baseline
from exerciser.run import run_exercise
from test_run_profile_regress import _fake_coverage_factory, _write_plan


def _learned(bodies: list[dict]) -> list[dict]:
    obs = [Observation(b, len(b), 2, i) for i, b in enumerate(bodies)]
    return [inv.to_json() for inv in learn_invariants(obs)]


# ---- enforcement -----------------------------------------------------------


def test_learned_invariants_carry_enforceable_params():
    # 20 observations: enough for `stable_enum`/`numeric_bound` to clear the
    # statistical-justification gate (see invariants.MAX_CHANCE_PROBABILITY).
    # At the old n=6 the chance of coincidence is 33%, which is why a range
    # learned that thinly used to mint false failures on boundary probes.
    invs = _learned([{"status": "ok" if i % 2 else "done", "score": i} for i in range(20)])
    by_kind = {i["kind"]: i for i in invs}
    assert by_kind["stable_enum"]["params"]["values"] == ["done", "ok"]
    assert by_kind["numeric_bound"]["params"] == {"min": 0, "max": 19}


def test_check_observation_flags_null_enum_and_bound_violations():
    # 20 observations: enough for `stable_enum`/`numeric_bound` to clear the
    # statistical-justification gate (see invariants.MAX_CHANCE_PROBABILITY).
    # At the old n=6 the chance of coincidence is 33%, which is why a range
    # learned that thinly used to mint false failures on boundary probes.
    invs = _learned([{"status": "ok" if i % 2 else "done", "score": i} for i in range(20)])
    violations = check_observation(invs, {"status": "EXPLODED", "score": 99})
    kinds = {v.split(" ")[0] for v in violations}
    assert kinds == {"stable_enum", "numeric_bound"}
    # A missing/never-null field is a violation; details never leak the value.
    nulls = check_observation(invs, {"score": 3})
    assert any(v.startswith("never_null violated: 'status'") for v in nulls)
    assert all("EXPLODED" not in v for v in violations)


def test_conforming_response_raises_nothing():
    # 20 observations: enough for `stable_enum`/`numeric_bound` to clear the
    # statistical-justification gate (see invariants.MAX_CHANCE_PROBABILITY).
    # At the old n=6 the chance of coincidence is 33%, which is why a range
    # learned that thinly used to mint false failures on boundary probes.
    invs = _learned([{"status": "ok" if i % 2 else "done", "score": i} for i in range(20)])
    assert check_observation(invs, {"status": "ok", "score": 3}) == []


def test_low_confidence_and_id_bounds_are_not_enforced():
    # Confidence floor: a barely-witnessed invariant must not judge.
    weak = [{"kind": "never_null", "field": "x", "confidence": 0.5}]
    assert check_observation(weak, {"y": 1}) == []
    # Ids legitimately outgrow their observed range — numeric_bound exempts them.
    id_inv = [
        {
            "kind": "numeric_bound",
            "field": "user_id",
            "confidence": 0.9,
            "params": {"min": 1, "max": 5},
        }
    ]
    assert check_observation(id_inv, {"user_id": 999}) == []


def test_monotonic_sequence_flags_the_breaking_call():
    invs = [{"kind": "id_monotonic", "field": "id", "confidence": 0.9}]
    hits = check_monotonic_sequence(invs, [{"id": 1}, {"id": 2}, {"id": 2}, {"id": 5}])
    assert len(hits) == 1
    idx, violation = hits[0]
    assert idx == 2
    assert violation.startswith("id_monotonic violated")


def test_empty_collection_is_absence_of_evidence_not_violation():
    invs = _learned([{"status": "ok" if i % 2 else "done"} for i in range(6)])
    assert check_observation(invs, []) == []


# ---- value digests ---------------------------------------------------------


def test_value_digest_sees_what_shape_hash_erases():
    a = '{"answer": 42}'
    b = '{"answer": 43}'
    assert response_value_digest(a, "application/json") != response_value_digest(
        b, "application/json"
    )
    # Canonical: key order cannot alias two equal values.
    assert response_value_digest('{"a": 1, "b": 2}', "application/json") == response_value_digest(
        '{"b": 2, "a": 1}', "application/json"
    )
    assert response_value_digest("", "application/json") is None


# ---- baselines -------------------------------------------------------------


def _obs(probe_id: str, digest: str | None, *, stable: bool = True) -> dict:
    return {
        "probeId": probe_id,
        "endpointId": "GET_answer",
        "method": "GET",
        "path": "/answer",
        "httpStatus": 200,
        "handler": "answer",
        "shapeHash": "json:same",
        "valueDigest": digest,
        "valueStable": stable,
    }


def test_value_drift_on_stable_probe_degrades(tmp_path):
    # Run 1 proves stability and seeds the digest.
    v1 = apply_baselines(tmp_path, [_obs("p1", "v:aaaa")])
    assert v1["p1"]["verdict"] == "recorded"
    # Run 2: same status, same shape, different value → degraded.
    v2 = apply_baselines(tmp_path, [_obs("p1", "v:bbbb")])
    assert v2["p1"]["verdict"] == "degraded"
    assert "value changed" in v2["p1"]["detail"]
    # And the degradation becomes a first-class assert-shaped issue cluster.
    clusters = clusters_from_baseline(v2, [_obs("p1", "v:bbbb")])
    assert len(clusters) == 1
    assert clusters[0].kind == "baseline-degraded"
    assert clusters[0].method == "GET"


def test_unstable_probes_never_seed_or_compare_digests(tmp_path):
    # An unstable (dynamic-output) probe seeds no digest…
    apply_baselines(tmp_path, [_obs("p2", None, stable=False)])
    # …so later value drift expresses no opinion: verdict stays "same".
    v2 = apply_baselines(tmp_path, [_obs("p2", "v:cccc", stable=False)])
    assert v2["p2"]["verdict"] == "same"


def test_digest_backfills_only_from_proven_stability(tmp_path):
    # Entry seeded before digests existed (or from an unstable run)…
    apply_baselines(tmp_path, [_obs("p3", None, stable=False)])
    # …a later regress-style observation (digest but NO stability proof) must
    # not backfill…
    apply_baselines(tmp_path, [_obs("p3", "v:dddd", stable=False)])
    v = apply_baselines(tmp_path, [_obs("p3", "v:eeee", stable=False)])
    assert v["p3"]["verdict"] == "same", "no stability proof → no opinion"
    # …but a run that proves stability does, and drift then degrades.
    apply_baselines(tmp_path, [_obs("p3", "v:ffff", stable=True)])
    v2 = apply_baselines(tmp_path, [_obs("p3", "v:0000", stable=False)])
    assert v2["p3"]["verdict"] == "degraded"


def test_compare_treats_missing_digests_as_no_opinion():
    entry = {"statusClass": "2xx-3xx", "httpStatus": 200, "shapeHash": "json:x"}
    observed = {"httpStatus": 200, "shapeHash": "json:x", "valueDigest": "v:1"}
    assert compare_observation(entry, observed)["verdict"] == "same"


# ---- the run loop writes the flag ------------------------------------------


class WrongValueService:
    """/health answers 200 with a plausible shape but a value outside the
    learned enum — the exact class that used to be invisible."""

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
            return ProbeResult(
                200, 5.0, {"id": 1, "status": "EXPLODED"}, "json:health", None, None, "json"
            )
        return ProbeResult(200, 3.0, {"ok": True}, "json:ok", None, None, "json")


def test_run_enforces_learned_invariants_as_issue_clusters(tmp_path):
    repo = tmp_path
    (repo / ".vinv" / "exercise").mkdir(parents=True)
    _write_plan(repo)
    # A prior profile learned that /health's status is a stable enum.
    store.write_json(
        store.invariants_path(repo),
        {
            "version": 1,
            "count": 1,
            "invariants": [
                {
                    "endpoint": "GET /health",
                    "kind": "stable_enum",
                    "field": "status",
                    "description": "'status' only ever took values {done, ok}",
                    # 20 observations of 2 values: a 10% chance of coincidence,
                    # which is what the justification gate requires before a
                    # learned enum may fail a run.
                    "support": 20,
                    "confidence": 0.955,
                    "params": {"values": ["done", "ok"]},
                }
            ],
        },
    )

    result = run_exercise(
        repo,
        "http://fake",
        budget=10,
        rounds=1,
        settle_s=0.0,
        probe_fn=WrongValueService(),
        coverage_fn=_fake_coverage_factory(),
    )

    assert result["status"] == "ok"
    issues = store.read_json(store.issues_path(repo))
    kinds = {c["kind"] for c in issues["clusters"]}
    assert "invariant-violation" in kinds, "a 2xx with a wrong value must cluster like a failure"
    cluster = next(c for c in issues["clusters"] if c["kind"] == "invariant-violation")
    assert "stable_enum" in cluster["title"]
    rows = store.read_jsonl(store.results_path(repo))
    assert any(r.get("invariant_violation") for r in rows)
