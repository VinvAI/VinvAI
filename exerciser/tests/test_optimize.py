"""Optimization cycle: paired bootstrap CI, opportunity detection, revert-retry."""

from __future__ import annotations

from exerciser.optimize import (
    MetricComparison,
    OptimizeAttempt,
    decide_optimization,
    detect_opportunities,
    paired_bootstrap_improvement,
)


def test_clear_improvement_ci_excludes_zero():
    before = [100.0] * 20 + [110.0] * 20
    after = [60.0] * 20 + [66.0] * 20
    cmp = paired_bootstrap_improvement(before, after, min_effect=0.10, seed=1)
    assert cmp.improved
    assert cmp.rel_improvement > 0.3
    assert cmp.ci_low > 0.0


def test_no_gain_not_improved():
    before = [100.0] * 40
    after = [99.0] * 40  # ~1% — below min effect
    cmp = paired_bootstrap_improvement(before, after, min_effect=0.10, seed=1)
    assert not cmp.improved


def test_noisy_no_effect_ci_includes_zero():
    # Same distribution before/after → CI should straddle zero.
    before = [float(i) for i in range(1, 41)]
    after = [float(i) for i in range(1, 41)]
    cmp = paired_bootstrap_improvement(before, after, min_effect=0.10, seed=7)
    assert not cmp.improved
    assert cmp.ci_low <= 0.0 <= cmp.ci_high


def test_detect_opportunities_from_profile():
    profile = {"endpoints": [
        {"api_id": "A", "method": "GET", "path": "/slow",
         "latency": {"p95_ms": 500.0}, "coverage": {"handler_observed": True}},
        {"api_id": "B", "method": "GET", "path": "/fast",
         "latency": {"p95_ms": 10.0}, "coverage": {"handler_observed": True}},
    ]}
    ops = detect_opportunities(profile, p95_outlier_ms=200.0)
    assert len(ops) == 1 and ops[0].endpoint_id == "A"


def test_accept_when_improved_and_suite_passes():
    cmp = MetricComparison(100, 60, 0.40, 0.30, 0.50, True)
    d = decide_optimization("cache the query", cmp, behavior_suite_passed=True)
    assert d.action == "accept"


def test_behavior_break_reverts_even_if_faster():
    cmp = MetricComparison(100, 40, 0.60, 0.50, 0.70, True)
    d = decide_optimization("skip validation", cmp, behavior_suite_passed=False)
    assert d.action == "revert-and-retry"
    assert "changed observable behavior" in d.learning


def test_no_gain_reverts_and_retries_with_learning():
    cmp = MetricComparison(100, 99, 0.01, -0.02, 0.04, False)
    d = decide_optimization("tweak", cmp, behavior_suite_passed=True)
    assert d.action == "revert-and-retry"
    assert "materially different approach" in d.learning


def test_retry_budget_exhausts_to_stop():
    cmp = MetricComparison(100, 99, 0.01, -0.02, 0.04, False)
    prior = [
        OptimizeAttempt("a", cmp, True, True, "note1"),
        OptimizeAttempt("b", cmp, True, True, "note2"),
    ]
    d = decide_optimization("c", cmp, True, prior_attempts=prior, max_attempts=3)
    assert d.action == "revert-and-stop"
    assert len(d.attempts) == 3


def test_reverting_optimization_informs_the_retry():
    # A degrading optimization auto-reverts AND the learning threads forward.
    cmp = MetricComparison(100, 130, -0.30, -0.45, -0.15, False)
    d1 = decide_optimization("attempt-1", cmp, behavior_suite_passed=True)
    assert d1.action == "revert-and-retry"
    d2 = decide_optimization("attempt-2", cmp, behavior_suite_passed=True,
                             prior_attempts=d1.attempts)
    # The second decision carries BOTH attempts' learning forward.
    assert len(d2.attempts) == 2
    assert d2.attempts[0].reverted and d2.attempts[1].reverted


def test_record_and_read_episodes(tmp_path):
    """Episodes persist with CI evidence — the findings view's data source."""
    from exerciser.optimize import (
        MetricComparison, Opportunity, OptimizeAttempt, OptimizeDecision,
        read_episodes, record_episode,
    )
    opp = Opportunity("latency-p95", "GET_items", "GET /items",
                      "P95 240ms exceeds 200ms", "p95_ms", 240.0)
    cmp_ = MetricComparison(240.0, 130.0, 0.46, 0.31, 0.58, True)
    dec = OptimizeDecision("accept", "significant", "", [
        OptimizeAttempt("add index on items.owner_id", cmp_, True, False, ""),
    ])
    record_episode(tmp_path, opp, dec,
                   files_changed=["app/crud.py"], label="items index")
    eps = read_episodes(tmp_path)
    assert len(eps) == 1
    assert eps[0]["action"] == "accept"
    assert eps[0]["attempts"][0]["comparison"]["ci_low"] == 0.31
    assert eps[0]["files_changed"] == ["app/crud.py"]
    assert eps[0]["at"] > 0
