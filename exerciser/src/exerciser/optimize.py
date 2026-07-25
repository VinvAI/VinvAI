"""The improve → verify → revert → learn → retry cycle (the maths + decision).

An OPTIMIZATION opportunity is detected from a behavioral profile (a P95 latency
outlier, a throughput ceiling, duplicate compute). An optimization episode is
then dispatched through the EXISTING autoTrigger/episode machinery (the extension
side owns dispatch, the snapshot, and the auto-revert — see
``extension/src/harness/exerciseOptimize.ts``); this module owns the two pieces
that must be exact and testable:

1. **The verification oracle's metric test** — a PAIRED comparison of before/after
   latency samples for the same input, with a bootstrap 95% CI on the relative
   improvement. An optimization is accepted only when BOTH hold:
     (a) the full learned behavior suite still passes byte/shape-identical (the
         behavioral oracle — supplied by the caller as a boolean), AND
     (b) the metric improved by at least a minimum practical effect (default 10%)
         AND the bootstrap 95% CI of the relative improvement EXCLUDES zero.
   Paired resampling (resample request indices, keep before/after aligned) is the
   right test because the same inputs are measured before and after.

2. **The revert-learn-retry decision** — on degradation or no-gain, AUTO-REVERT,
   record what-was-tried-and-why-it-failed, and feed that learning into a bounded
   retry. This module returns the decision + the learning note; the extension
   applies the snapshot revert and threads the note into the retry's context.

Pure and dependency-free (stdlib ``random`` for the seeded bootstrap) so the
maths and the revert/retry logic are unit-tested directly.
"""

from __future__ import annotations

import random
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import store

# Minimum practical relative improvement for an optimization to count (10%).
DEFAULT_MIN_EFFECT = 0.10
# Bootstrap resamples for the CI.
_BOOTSTRAP_N = 2000


@dataclass
class MetricComparison:
    """A paired before/after metric comparison with a bootstrap CI."""

    before_median: float
    after_median: float
    rel_improvement: float  # (before - after) / before, positive = faster
    ci_low: float
    ci_high: float
    improved: bool  # effect >= min AND CI excludes zero (positive)

    def to_json(self) -> dict[str, Any]:
        return {
            "before_median": round(self.before_median, 3),
            "after_median": round(self.after_median, 3),
            "rel_improvement": round(self.rel_improvement, 4),
            "ci_low": round(self.ci_low, 4),
            "ci_high": round(self.ci_high, 4),
            "improved": self.improved,
        }


def paired_bootstrap_improvement(
    before: list[float],
    after: list[float],
    *,
    min_effect: float = DEFAULT_MIN_EFFECT,
    seed: int = 1729,
    resamples: int = _BOOTSTRAP_N,
) -> MetricComparison:
    """Relative improvement of ``after`` over ``before`` with a bootstrap 95% CI.

    Paired: ``before[i]`` and ``after[i]`` are the same input measured twice, so
    resampling draws INDEX sets and keeps the pairing. The statistic is the
    relative improvement of medians ``(median(before) - median(after)) /
    median(before)``. ``improved`` is True only when the point estimate meets the
    minimum practical effect AND the 95% CI lower bound is > 0 (CI excludes zero).
    """
    n = min(len(before), len(after))
    if n == 0:
        return MetricComparison(0.0, 0.0, 0.0, 0.0, 0.0, False)
    before = before[:n]
    after = after[:n]
    b_med = statistics.median(before)
    a_med = statistics.median(after)
    point = (b_med - a_med) / b_med if b_med > 0 else 0.0

    rng = random.Random(f"opt {seed}")
    stats: list[float] = []
    for _ in range(resamples):
        idx = [rng.randrange(n) for _ in range(n)]
        bb = statistics.median([before[i] for i in idx])
        aa = statistics.median([after[i] for i in idx])
        stats.append((bb - aa) / bb if bb > 0 else 0.0)
    stats.sort()
    lo = stats[int(0.025 * len(stats))]
    hi = stats[min(len(stats) - 1, int(0.975 * len(stats)))]
    improved = point >= min_effect and lo > 0.0
    return MetricComparison(b_med, a_med, point, lo, hi, improved)


def bootstrap_median_ci(
    samples: list[float],
    *,
    seed: int = 1729,
    resamples: int = _BOOTSTRAP_N,
) -> tuple[float, float]:
    """Bootstrap 95% CI of the median of ``samples``.

    The one-sample companion to :func:`paired_bootstrap_improvement`: regress
    uses it to confirm a suspected perf regression only when the WHOLE CI of
    the re-measured median clears the threshold — one noisy replay cannot
    manufacture a verdict.
    """
    if not samples:
        return 0.0, 0.0
    rng = random.Random(f"median {seed}")
    n = len(samples)
    stats = sorted(
        statistics.median([samples[rng.randrange(n)] for _ in range(n)])
        for _ in range(resamples)
    )
    return stats[int(0.025 * len(stats))], stats[min(len(stats) - 1, int(0.975 * len(stats)))]


# ---- opportunity detection from a profile ----------------------------------

@dataclass
class Opportunity:
    kind: str  # "latency-p95" | "throughput-ceiling"
    endpoint_id: str
    endpoint: str
    detail: str
    metric: str  # the target metric name the episode must improve
    value: float

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "endpoint_id": self.endpoint_id,
            "endpoint": self.endpoint,
            "detail": self.detail,
            "metric": self.metric,
            "value": self.value,
        }


def detect_opportunities(
    profile: dict[str, Any],
    *,
    outlier_factor: float = 3.0,
) -> list[Opportunity]:
    """Detect optimization opportunities from a behavioral profile.

    An endpoint whose P95 latency is an OUTLIER relative to the service's own
    per-endpoint P95 distribution is an opportunity to speed up. The test is
    RELATIVE — no absolute ms threshold — because scale is the service's, not
    ours: a 60ms endpoint among 5ms endpoints on a local service is exactly the
    outlier a 200ms floor misses, while a uniformly-300ms service has no
    outlier at all (that is a baseline, not an opportunity).

    Leave-one-out: each endpoint's P95 is compared against the median of the
    OTHER endpoints' P95s (so an outlier cannot hide by dragging the median
    toward itself — decisive with only two endpoints). It is flagged when it
    exceeds ``outlier_factor`` × that median AND, when at least three other
    endpoints exist, the median + 3 robust deviations (MAD × 1.4826) band.
    """
    eligible: list[tuple[dict[str, Any], float]] = []
    for ep in profile.get("endpoints", []):
        p95 = float(ep.get("latency", {}).get("p95_ms", 0.0) or 0.0)
        cov = ep.get("coverage", {})
        if p95 > 0 and cov.get("handler_observed"):
            eligible.append((ep, p95))
    if len(eligible) < 2:
        return []  # a lone endpoint has no distribution to be an outlier of
    out: list[Opportunity] = []
    for i, (ep, p95) in enumerate(eligible):
        others = [p for j, (_, p) in enumerate(eligible) if j != i]
        med = statistics.median(others)
        if med <= 0:
            continue
        threshold = med * outlier_factor
        if len(others) >= 3:
            mad = statistics.median([abs(v - med) for v in others])
            threshold = max(threshold, med + 3 * 1.4826 * mad)
        if p95 >= threshold:
            out.append(Opportunity(
                kind="latency-p95",
                endpoint_id=ep["api_id"],
                endpoint=f"{ep['method']} {ep['path']}",
                detail=(
                    f"P95 latency {p95}ms is {p95 / med:.1f}× the median P95 of the "
                    f"service's other endpoints ({round(med, 1)}ms)"
                ),
                metric="p95_ms",
                value=p95,
            ))
    out.sort(key=lambda o: -o.value)
    return out


# ---- revert-learn-retry decision -------------------------------------------

@dataclass
class OptimizeAttempt:
    """One optimization attempt's record (threaded into the retry context)."""

    approach: str
    comparison: MetricComparison | None
    behavior_suite_passed: bool
    reverted: bool
    learning: str

    def to_json(self) -> dict[str, Any]:
        return {
            "approach": self.approach,
            "comparison": self.comparison.to_json() if self.comparison else None,
            "behavior_suite_passed": self.behavior_suite_passed,
            "reverted": self.reverted,
            "learning": self.learning,
        }


@dataclass
class OptimizeDecision:
    action: str  # "accept" | "revert-and-retry" | "revert-and-stop"
    reason: str
    learning: str  # what-was-tried-and-why-it-failed, for the next attempt
    attempts: list[OptimizeAttempt] = field(default_factory=list)


def decide_optimization(
    approach: str,
    comparison: MetricComparison,
    behavior_suite_passed: bool,
    *,
    prior_attempts: list[OptimizeAttempt] | None = None,
    max_attempts: int = 3,
) -> OptimizeDecision:
    """The accept / revert-and-retry / revert-and-stop decision for one attempt.

    * ACCEPT only when the behavior suite passed AND the metric improved (effect
      + CI-excludes-zero — ``comparison.improved``).
    * A behavior-suite FAILURE always reverts (a faster-but-wrong service is a
      regression), and retries while budget remains, recording WHY.
    * A no-gain / degradation reverts and retries with the learning, else stops
      when the attempt budget is spent.
    """
    prior = list(prior_attempts or [])
    attempt_no = len(prior) + 1

    if behavior_suite_passed and comparison.improved:
        note = (
            f"accepted: '{approach}' improved the metric by "
            f"{comparison.rel_improvement:.1%} (95% CI "
            f"[{comparison.ci_low:.1%}, {comparison.ci_high:.1%}] excludes zero) "
            "with the behavior suite intact"
        )
        attempt = OptimizeAttempt(approach, comparison, True, False, note)
        return OptimizeDecision("accept", note, "", prior + [attempt])

    if not behavior_suite_passed:
        learning = (
            f"attempt {attempt_no} '{approach}' REVERTED: it changed observable "
            "behavior (the learned behavior suite no longer passes byte/shape "
            "identically). A valid optimization must not alter outputs — keep the "
            "response contract fixed and optimize the internals only."
        )
    else:
        learning = (
            f"attempt {attempt_no} '{approach}' REVERTED: no significant speedup "
            f"(rel improvement {comparison.rel_improvement:.1%}, 95% CI "
            f"[{comparison.ci_low:.1%}, {comparison.ci_high:.1%}] — did not clear "
            "the min effect or the CI includes zero). Try a materially different "
            "approach, not a variation of this one."
        )
    attempt = OptimizeAttempt(approach, comparison, behavior_suite_passed, True, learning)
    attempts = prior + [attempt]
    if attempt_no >= max_attempts:
        return OptimizeDecision(
            "revert-and-stop",
            f"reverted after {attempt_no} attempts without an accepted improvement",
            learning, attempts,
        )
    return OptimizeDecision("revert-and-retry", learning, learning, attempts)


# ---- durable episode log -----------------------------------------------------

def episode_log_path(repo: Path) -> Path:
    return store.exercise_dir(repo) / "optimize.jsonl"


def record_episode(
    repo: Path,
    opportunity: Opportunity | dict[str, Any],
    decision: OptimizeDecision,
    *,
    files_changed: list[str] | None = None,
    label: str | None = None,
) -> None:
    """Append one optimization episode's full record to ``optimize.jsonl``.

    This is the durable evidence trail behind "what Vinv improved": every
    attempt with its paired-bootstrap CI, whether the behavior suite held,
    and the accept/revert outcome — consumed by the findings view (human)
    and the machine summary (agent). Callers (the extension's episode
    runner) invoke it once per finished episode.
    """
    opp = opportunity.to_json() if isinstance(opportunity, Opportunity) else dict(opportunity)
    store.append_jsonl(episode_log_path(repo), [{
        "at": time.time(),
        "label": label or opp.get("endpoint") or opp.get("endpoint_id"),
        "opportunity": opp,
        "action": decision.action,
        "reason": decision.reason,
        "attempts": [a.to_json() for a in decision.attempts],
        "files_changed": files_changed or [],
    }])


def read_episodes(repo: Path) -> list[dict[str, Any]]:
    return store.read_jsonl(episode_log_path(repo))
