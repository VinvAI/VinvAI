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


def test_exploration_shrinks_as_the_posteriors_sharpen():
    # What "thompson" actually buys, asserted as behaviour rather than as the
    # word appearing in the summary. The exploration rate is a CONSEQUENCE of
    # posterior width: at unchanged win rates, more evidence means the losing
    # arm is sampled less and less. An epsilon-greedy rule — which the prose
    # assertion would not have noticed — holds that rate flat at epsilon.
    def losing_share(evidence: int, draws: int = 4000) -> float:
        b = EndpointBandit(strategies=("a", "b"))
        for _ in range(evidence):
            b.arms["a"].update(Outcome(violations=1))
            b.arms["b"].update(Outcome())
        rng = random.Random("thompson")
        return [b.select(rng) for _ in range(draws)].count("b") / draws

    none, some, plenty = losing_share(0), losing_share(1), losing_share(4)
    assert none > 0.4, "with no evidence at all the two arms are interchangeable"
    assert some < none / 2, "one observation already concentrates the draw"
    assert plenty < some / 10, "and the exploration keeps shrinking with evidence"
    assert plenty > 0.0, "but never becomes a hard argmax"


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
    # The pooled numbers must be the POSTERIORS, not decoration: the arm that
    # broke an oracle outranks the one that found nothing, and an untouched arm
    # sits at the uninformative prior. (Asserting the prose in
    # summary["selection"]/["objective"] pinned nothing — the strings survive
    # any change of algorithm or objective.)
    assert (
        summary["pooled"]["schema_valid"]["posterior_mean"]
        > summary["pooled"]["schema_negative"]["posterior_mean"]
    )
    assert summary["pooled"]["observed"] == {
        "plays": 0,
        "reward_sum": 0.0,
        "violations": 0,
        "coverage_sum": 0,
        "posterior_mean": 0.5,
    }
    assert summary["per_endpoint"]["EP_x"]["schema_valid"]["alpha"] == 2.0


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
    # The action space is the TRIPLE — assert the arms are actually keyed by it,
    # not that a description string says so.
    assert set(doc["arms"]) == {
        "GET_health|schema_valid|status",
        "pkg:evaluate|ast-corpus|differential",
    }
    assert doc["preferred"] == differential.to_json()
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


# ---- the update rule, stated honestly ---------------------------------------


def test_the_fractional_rule_removes_the_credits_own_variance():
    # The audited claim was "Beta/Bernoulli conjugate update". It is not: the
    # fractional `alpha += credit` is the bounded-reward RELAXATION, and posting
    # the mean instead of a draw removes the credit's own variance.
    #
    # That difference is a property of the SAMPLING DISTRIBUTION across
    # experiments, not of any single run: at equal alpha+beta the Beta variance
    # depends only on how close alpha is to beta, so one Bernoulli realisation
    # can land either side of the fractional one. Asserting per-realisation (as
    # this test first did) is a coin flip — it failed on an ordinary seed.
    outcome = Outcome(new_coverage=1)  # credit == COVERAGE_BONUS

    def posterior_mean(seed: str | None) -> float:
        arm = BetaArm()
        rng = random.Random(seed) if seed is not None else None
        for _ in range(200):
            arm.update(outcome, rng=rng) if rng else arm.update(outcome)
        return arm.mean()

    fractional = [posterior_mean(None) for _ in range(12)]
    bernoulli = [posterior_mean(f"seed-{i}") for i in range(12)]

    # The relaxation is DETERMINISTIC: same evidence, same posterior, always.
    assert len(set(fractional)) == 1, "the fractional rule must not vary at all"
    # The honest conjugate update does vary, which is the exploration the
    # relaxation gives up.
    assert len(set(bernoulli)) > 1, "Bernoulli draws must carry their variance"
    # And it is centred on the same place.
    assert abs(sum(bernoulli) / len(bernoulli) - fractional[0]) < 0.05


def test_bernoulli_updates_post_whole_counts():
    # The genuine conjugate update: the posterior only ever moves by whole
    # observations, which is what Thompson's regret guarantee is proved for.
    arm = BetaArm()
    rng = random.Random("bits")
    for _ in range(50):
        arm.update(Outcome(new_coverage=1), rng=rng)
    assert arm.alpha == int(arm.alpha), "alpha moved in whole counts"
    assert arm.alpha + arm.beta == 2.0 + 50.0, "still one pseudo-count per play"


def test_the_campaign_bandit_bernoulli_ises_by_default():
    # Asserting "bernoulli" appears in the doc's `update` prose would pass with
    # the flag ignored. The consequence is arithmetic: with an rng the posterior
    # moves in WHOLE observations, and only some of the plays score.
    a = Action("t", "tech", "oracle")
    bandit = ActionBandit(actions=(a,))
    rng = random.Random("bits")
    plays = 30  # deliberately not a multiple of 1/COVERAGE_BONUS: the fractional
    # rule would land on 1 + 7.5, so integrality alone would not tell them apart.
    for _ in range(plays):
        bandit.update(a, Outcome(new_coverage=1), rng=rng)
    arm = bandit.arms[a.key]
    assert arm.alpha == int(arm.alpha), "the credit is a bit, not a fraction"
    assert arm.alpha != 1.0 + plays * COVERAGE_BONUS, "not the fractional relaxation"
    assert 0.0 < arm.alpha - 1.0 < plays, "and only a share of the plays paid"

    # Opting out keeps the fractional relaxation even when an rng is supplied.
    opted_out = ActionBandit(actions=(a,), bernoulli=False)
    opted_out.update(a, Outcome(new_coverage=1), rng=random.Random("bits"))
    assert opted_out.arms[a.key].alpha == 1.0 + COVERAGE_BONUS
    # …as does the legacy per-endpoint path, which passes no rng at all.
    plain = ActionBandit(actions=(a,))
    plain.update(a, Outcome(new_coverage=1))
    assert plain.arms[a.key].alpha == 1.0 + COVERAGE_BONUS


# ---- the coverage bonus is a learnable prior, not a magic constant -----------


def test_the_coverage_bonus_is_an_adjustable_persisted_prior():
    a = Action("pkg:fn", "deterministic", "crash")
    bandit = ActionBandit(actions=(a,), coverage_bonus=0.5)
    bandit.update(a, Outcome(new_coverage=1))
    assert bandit.arms[a.key].alpha == 1.5, "the bandit's own prior is used, not the constant"

    doc = bandit.to_json()
    assert doc["priors"]["coverage_bonus"] == 0.5
    # And it travels with the posteriors to the next run.
    restored = seed_actions_from_prior(ActionBandit(), doc, decay=0.5)
    assert restored.coverage_bonus == 0.5


def test_the_default_coverage_bonus_is_the_documented_exchange_rate():
    # 0.25 is an EXCHANGE RATE, not a dial: it is the point at which an arm
    # that only ever reaches new ground ties an arm that finds a violation on
    # one play in four. Asserting the consequence pins the number — the
    # previous version reduced to COVERAGE_BONUS == COVERAGE_BONUS and would
    # have passed at any value.
    always_covers = BetaArm()
    violates_1_in_4 = BetaArm()
    for i in range(400):
        always_covers.update(Outcome(new_coverage=1))
        violates_1_in_4.update(Outcome(violations=1) if i % 4 == 0 else Outcome())
    assert abs(always_covers.mean() - violates_1_in_4.mean()) < 0.02, (
        f"at COVERAGE_BONUS={COVERAGE_BONUS} the two must be near-indifferent; "
        f"got {always_covers.mean():.3f} vs {violates_1_in_4.mean():.3f}"
    )
    # And a violation must always outrank pure coverage on a single play.
    assert Outcome(violations=1).credit() > Outcome(new_coverage=99).credit()
