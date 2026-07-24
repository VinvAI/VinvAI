"""Thompson bandit: update maths, deterministic selection, summary."""

from __future__ import annotations

import random

from exerciser.bandit import STRATEGIES, BetaArm, EndpointBandit, bandit_summary


def test_beta_update_success_and_failure():
    arm = BetaArm()
    assert arm.alpha == 1.0 and arm.beta == 1.0
    arm.update(3)  # covered 3 new symbols → success
    assert arm.alpha == 2.0 and arm.beta == 1.0
    assert arm.reward_sum == 3
    arm.update(0)  # covered nothing → failure
    assert arm.alpha == 2.0 and arm.beta == 2.0
    assert arm.plays == 2


def test_mean_moves_with_evidence():
    arm = BetaArm()
    base = arm.mean()
    for _ in range(5):
        arm.update(1)
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
        b.arms["a"].update(2)
        b.arms["b"].update(0)
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
    b.update("schema_valid", 2)
    b.update("schema_negative", 0)
    summary = bandit_summary({"EP_x": b})
    assert "pooled" in summary and "per_endpoint" in summary
    assert summary["pooled"]["schema_valid"]["reward_sum"] == 2
    assert summary["pooled"]["schema_valid"]["plays"] == 1
    assert "thompson" in summary["selection"]
