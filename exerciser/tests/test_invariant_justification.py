"""Statistical justification and non-finite handling (audit FP-1, FP-2).

Two defects, one theme: the invariant oracle enforced learned properties as HARD
failures — each one dispatches a fix episode against possibly-correct code — on
evidence that did not support them.

  FP-1  A single NaN poisoned `numeric_bound` three ways: `min()` became
        order-dependent (so the learned bound stopped being deterministic),
        `nan <= v <= nan` is False for EVERY v (so every later healthy response
        was flagged forever), and `json.dumps` wrote a bare `NaN` token that is
        not RFC-8259, making invariants.json unreadable to `JSON.parse`.
  FP-2  `ENFORCE_MIN_CONFIDENCE` could not reject anything: every learned
        invariant scores >= 6/7 = 0.857 because MIN_SUPPORT=5 already pins the
        floor above the 0.8 gate. The advertised safety valve was inert.

These tests are deliberately weighted toward the NEGATIVE direction — proving
what must *not* be flagged — because that is the direction the original suite
never asserted, and the direction in which this oracle damages trust.
"""

from __future__ import annotations

import json
import math

import pytest

from exerciser.invariants import (
    MAX_CHANCE_PROBABILITY,
    MIN_SUPPORT,
    Observation,
    _chance_probability,
    check_observation,
    learn_invariants,
)


def _learn(bodies: list[dict]) -> list[dict]:
    obs = [Observation(b, len(b), 2, i) for i, b in enumerate(bodies)]
    return [inv.to_json() for inv in learn_invariants(obs)]


def _kinds(invs: list[dict]) -> set[str]:
    return {i["kind"] for i in invs}


# ---------------------------------------------------------------------------
# FP-1 — non-finite values
# ---------------------------------------------------------------------------


class TestNonFiniteLearning:
    def test_a_nan_field_never_produces_a_numeric_bound(self) -> None:
        bodies = [{"ratio": float("nan")} for _ in range(10)]
        assert "numeric_bound" not in _kinds(_learn(bodies))

    def test_one_nan_among_many_finite_values_disqualifies_the_bound(self) -> None:
        """The realistic shape: an average that divided by zero exactly once."""
        bodies = [{"ratio": float(i)} for i in range(20)]
        bodies[7] = {"ratio": float("nan")}
        assert "numeric_bound" not in _kinds(_learn(bodies))

    @pytest.mark.parametrize("bad", [float("inf"), float("-inf")])
    def test_infinities_are_excluded_too(self, bad: float) -> None:
        bodies = [{"n": float(i)} for i in range(20)]
        bodies[3] = {"n": bad}
        assert "numeric_bound" not in _kinds(_learn(bodies))

    def test_learning_is_order_independent_with_a_nan_present(self) -> None:
        """`min([1.0,nan])==1.0` but `min([nan,1.0])==nan` — the determinism bug."""
        vals: list[float] = [float("nan"), 1.0, 2.0, 3.0, 4.0, 5.0]
        forward = _learn([{"n": v} for v in vals])
        backward = _learn([{"n": v} for v in reversed(vals)])
        assert _kinds(forward) == _kinds(backward)
        assert [i.get("params") for i in forward] == [i.get("params") for i in backward]

    def test_a_learned_document_is_always_strict_json(self) -> None:
        """A bare NaN token breaks JSON.parse on the TypeScript side."""
        bodies = [{"ratio": float("nan"), "n": float(i)} for i in range(20)]
        blob = json.dumps(_learn(bodies))
        assert "NaN" not in blob and "Infinity" not in blob
        json.loads(blob)  # strict round-trip

    def test_finite_values_still_learn_a_bound(self) -> None:
        """Guard against 'fixed' by disabling the feature."""
        invs = _learn([{"n": float(i)} for i in range(20)])
        bound = next(i for i in invs if i["kind"] == "numeric_bound")
        assert bound["params"] == {"min": 0.0, "max": 19.0}

    def test_a_nan_response_is_not_flagged_against_a_finite_bound(self) -> None:
        """Enforcement side: NaN fails every comparison, so it must not report."""
        invs = [
            {
                "kind": "numeric_bound",
                "field": "n",
                "confidence": 0.99,
                "support": 50,
                "params": {"min": 0, "max": 10},
            }
        ]
        got = check_observation(invs, {"n": float("nan")})
        assert got == [] or all("numeric_bound" not in g for g in got)


# ---------------------------------------------------------------------------
# FP-2 — statistical justification
# ---------------------------------------------------------------------------


class TestChanceProbability:
    def test_a_bound_from_min_support_is_a_coin_flip(self) -> None:
        """2/(5+1) = 33% — the number that made this a false-positive engine."""
        assert _chance_probability("numeric_bound", MIN_SUPPORT, {}) == pytest.approx(1 / 3)

    def test_bound_justification_improves_with_evidence(self) -> None:
        seq = [_chance_probability("numeric_bound", n, {}) for n in (5, 10, 20, 100)]
        assert seq == sorted(seq, reverse=True)
        assert seq[-1] < MAX_CHANCE_PROBABILITY

    def test_enum_justification_scales_with_cardinality(self) -> None:
        """More distinct values seen ⇒ more reason to expect an unseen one."""
        few = _chance_probability("stable_enum", 20, {"values": ["a", "b"]})
        many = _chance_probability("stable_enum", 20, {"values": list("abcdefgh")})
        assert few < many

    def test_cheap_binary_properties_are_justified_at_low_support(self) -> None:
        for kind in ("never_null", "size_relation"):
            assert _chance_probability(kind, MIN_SUPPORT, {}) < MAX_CHANCE_PROBABILITY

    @pytest.mark.parametrize("support", [0, -1, -999])
    def test_non_positive_support_is_never_justified(self, support: int) -> None:
        assert _chance_probability("numeric_bound", support, {}) == 1.0

    def test_an_enum_with_no_recorded_values_is_never_justified(self) -> None:
        assert _chance_probability("stable_enum", 100, {}) == 1.0
        assert _chance_probability("stable_enum", 100, {"values": []}) == 1.0

    def test_an_unknown_kind_fails_open_so_new_templates_still_enforce(self) -> None:
        """Adding a template must not silently disable it."""
        assert _chance_probability("some_future_kind", 5, {}) == 0.0

    def test_probability_is_always_a_valid_probability(self) -> None:
        for kind in ("numeric_bound", "stable_enum", "never_null", "size_relation", "zzz"):
            for n in (0, 1, 5, 1000):
                p = _chance_probability(kind, n, {"values": ["a"]})
                assert 0.0 <= p <= 1.0 and math.isfinite(p)


class TestJustificationGate:
    _WEAK_ENUM = {
        "kind": "stable_enum",
        "field": "status",
        "confidence": 0.99,
        "support": MIN_SUPPORT,
        "params": {"values": ["ok", "done"]},
    }
    _STRONG_ENUM = {**_WEAK_ENUM, "support": 100}
    _WEAK_BOUND = {
        "kind": "numeric_bound",
        "field": "score",
        "confidence": 0.99,
        "support": MIN_SUPPORT,
        "params": {"min": 0, "max": 5},
    }
    _STRONG_BOUND = {**_WEAK_BOUND, "support": 100}

    def test_a_thinly_witnessed_enum_does_not_fail_a_run(self) -> None:
        """The FP-2 headline: a 4th legitimate status is not a defect."""
        assert check_observation([self._WEAK_ENUM], {"status": "PENDING"}) == []

    def test_a_thinly_witnessed_bound_does_not_fail_a_run(self) -> None:
        """A legitimately larger count/total is not a defect."""
        assert check_observation([self._WEAK_BOUND], {"score": 9999}) == []

    def test_well_witnessed_invariants_still_catch_a_wrong_value(self) -> None:
        """Guard against 'fixed' by disabling the oracle."""
        assert check_observation([self._STRONG_ENUM], {"status": "EXPLODED"})
        assert check_observation([self._STRONG_BOUND], {"score": 9999})

    def test_conforming_values_never_report_at_any_support(self) -> None:
        for inv in (self._WEAK_ENUM, self._STRONG_ENUM):
            assert check_observation([inv], {"status": "ok"}) == []
        for inv in (self._WEAK_BOUND, self._STRONG_BOUND):
            assert check_observation([inv], {"score": 3}) == []

    def test_a_missing_support_key_is_treated_as_no_evidence(self) -> None:
        """Legacy documents predate `support`; they must not fail a build."""
        legacy = {k: v for k, v in self._STRONG_ENUM.items() if k != "support"}
        assert check_observation([legacy], {"status": "EXPLODED"}) == []

    def test_the_caller_can_widen_or_tighten_the_gate(self) -> None:
        assert check_observation([self._WEAK_ENUM], {"status": "X"}, max_chance=1.0)
        assert check_observation([self._STRONG_ENUM], {"status": "X"}, max_chance=0.0) == []

    def test_never_null_still_fires_on_modest_evidence(self) -> None:
        """The high-precision invariant must not be collateral damage."""
        inv = {
            "kind": "never_null",
            "field": "id",
            "confidence": 0.9,
            "support": MIN_SUPPORT,
        }
        assert check_observation([inv], {"other": 1})

    def test_a_learned_then_enforced_round_trip_is_silent_on_healthy_traffic(self) -> None:
        """End to end: learn from 20 healthy responses, replay a 21st."""
        bodies = [{"status": "ok" if i % 2 else "done", "score": i} for i in range(20)]
        invs = _learn(bodies)
        assert check_observation(invs, {"status": "ok", "score": 7}) == []
        assert check_observation(invs, {"status": "EXPLODED", "score": 3})
