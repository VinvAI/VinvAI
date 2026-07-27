"""Thompson bandit: the violation-first objective, the enriched action space.

The objective is ORACLE VIOLATIONS PER UNIT COST — coverage is the exploration
bonus, not the goal — and the action space is (target x technique x oracle),
not input strategies for one HTTP endpoint.
"""

from __future__ import annotations

import random

from exerciser.bandit import (
    COVERAGE_BONUS,
    STRATEGIES,
    Action,
    ActionBandit,
    BetaArm,
    EndpointBandit,
    Outcome,
    bandit_summary,
    seed_actions_from_prior,
)


def test_a_violation_scores_full_credit():
    arm = BetaArm()
    assert arm.alpha == 1.0 and arm.beta == 1.0
    arm.update(Outcome(violations=1, new_coverage=0))
    assert arm.alpha == 2.0 and arm.beta == 1.0
    assert arm.reward_sum == 1.0
    assert arm.violations == 1


def test_coverage_alone_is_only_the_exploration_bonus():
    arm = BetaArm()
    arm.update(Outcome(violations=0, new_coverage=3))
    assert arm.alpha == 1.0 + COVERAGE_BONUS
    assert arm.beta == 2.0 - COVERAGE_BONUS
    assert arm.coverage_sum == 3
    # A violation must always outrank pure coverage.
    assert Outcome(violations=1).credit() > Outcome(new_coverage=99).credit()


def test_nothing_found_is_a_failure():
    arm = BetaArm()
    arm.update(Outcome())
    assert arm.alpha == 1.0 and arm.beta == 2.0
    assert arm.plays == 1


def test_every_play_adds_exactly_one_pseudo_count():
    # Fractional credit must keep the Beta update conjugate: alpha+beta grows
    # by one per play regardless of the score.
    arm = BetaArm()
    for outcome in (Outcome(violations=1), Outcome(new_coverage=2), Outcome()):
        arm.update(outcome)
    assert arm.alpha + arm.beta == 2.0 + 3.0


def test_cost_divides_the_credit():
    cheap, dear = BetaArm(), BetaArm()
    cheap.update(Outcome(violations=1, cost=1.0))
    dear.update(Outcome(violations=1, cost=4.0))
    assert cheap.mean() > dear.mean(), "an expensive find must pay less per play"


def test_int_updates_stay_backward_compatible():
    # The legacy "newly covered symbols" signal keeps working, as a
    # coverage-only outcome.
    arm = BetaArm()
    arm.update(3)
    assert arm.alpha == 1.0 + COVERAGE_BONUS
    assert arm.coverage_sum == 3


def test_mean_moves_with_evidence():
    arm = BetaArm()
    base = arm.mean()
    for _ in range(5):
        arm.update(Outcome(violations=1))
    assert arm.mean() > base


def test_selection_is_deterministic_for_a_seed():
    b1 = EndpointBandit(strategies=STRATEGIES)
    b2 = EndpointBandit(strategies=STRATEGIES)
    r1 = random.Random("x")
    r2 = random.Random("x")
    picks1 = [b1.select(r1) for _ in range(20)]
    picks2 = [b2.select(r2) for _ in range(20)]
    assert picks1 == picks2


def test_selection_favours_the_rewarding_arm():
    b = EndpointBandit(strategies=("a", "b"))
    # Arm 'a' always pays, arm 'b' never does.
    for _ in range(30):
        b.arms["a"].update(Outcome(violations=1))
        b.arms["b"].update(Outcome())
    rng = random.Random("y")
    picks = [b.select(rng) for _ in range(200)]
    assert picks.count("a") > picks.count("b")
    assert b.preferred() == "a"


def test_only_available_strategies_are_used():
    b = EndpointBandit(strategies=("schema_valid", "observed"))
    rng = random.Random("z")
    picks = {b.select(rng) for _ in range(50)}
    assert picks <= {"schema_valid", "observed"}


def test_summary_structure_and_pooling():
    b = EndpointBandit(strategies=STRATEGIES)
    b.update("schema_valid", Outcome(violations=2, new_coverage=1))
    b.update("schema_negative", Outcome())
    summary = bandit_summary({"EP_x": b})
    assert "pooled" in summary and "per_endpoint" in summary
    assert summary["pooled"]["schema_valid"]["reward_sum"] == 1.0
    assert summary["pooled"]["schema_valid"]["violations"] == 2
    assert summary["pooled"]["schema_valid"]["plays"] == 1
    assert "thompson" in summary["selection"]
    assert "violations per unit cost" in summary["objective"]


# ---- the enriched action space ---------------------------------------------


def test_action_round_trips_through_its_key():
    a = Action(target="pkg.mod:fn", technique="hypothesis", oracle="differential")
    assert Action.parse(a.key) == a


def test_same_target_under_a_different_oracle_is_a_different_arm():
    crash = Action("pkg:fn", "deterministic", "crash")
    diff = Action("pkg:fn", "deterministic", "differential")
    bandit = ActionBandit(actions=(crash, diff))
    assert len(bandit.arms) == 2, "the oracle is part of the arm identity"


def test_action_bandit_learns_which_technique_pays():
    http = Action("GET_health", "schema_valid", "status")
    differential = Action("pkg:evaluate", "ast-corpus", "differential")
    bandit = ActionBandit(actions=(http, differential))
    for _ in range(30):
        bandit.update(differential, Outcome(violations=1))
        bandit.update(http, Outcome())

    rng = random.Random("actions")
    picks = [bandit.select(rng) for _ in range(200)]
    assert picks.count(differential) > picks.count(http)
    assert bandit.preferred() == differential

    doc = bandit.to_json()
    assert doc["action_space"] == "target x technique x oracle"
    # The loop can answer "which technique pays here", which is the question a
    # human actually asks of it.
    assert doc["by_technique"]["ast-corpus"]["violations"] == 30
    assert (
        doc["by_oracle"]["differential"]["posterior_mean"]
        > (doc["by_oracle"]["status"]["posterior_mean"])
    )


def test_actions_discovered_mid_run_are_registered_once():
    bandit = ActionBandit()
    a = Action("pkg:fn", "deterministic", "crash")
    bandit.add(a)
    bandit.add(a)
    assert len(bandit.actions) == 1


def test_action_posteriors_warm_start_decayed():
    a = Action("pkg:fn", "deterministic", "crash")
    first = ActionBandit(actions=(a,))
    for _ in range(10):
        first.update(a, Outcome(violations=1))
    prior = first.to_json()

    second = seed_actions_from_prior(ActionBandit(), prior, decay=0.5)
    arm = second.arms[a.key]
    assert 1.0 < arm.alpha < first.arms[a.key].alpha, "evidence persists but decays"


def test_empty_action_bandit_selects_nothing():
    assert ActionBandit().select(random.Random("e")) is None
    assert ActionBandit().preferred() is None
