"""The coverage-guided bandit — Thompson sampling over generation strategies.

Per endpoint the engine chooses, each probe, WHICH generation strategy to spend a
probe on. The strategies are the plan's input sources:

    schema_valid · schema_boundary · schema_negative · observed · semantic

Each ``(endpoint, strategy)`` carries a ``Beta(α, β)`` posterior with priors
``α₀ = β₀ = 1`` (uniform). A probe's REWARD is Bernoulli: ``1`` when it covered at
least one previously-uncovered symbol, ``0`` otherwise — the update is then
``α += successes, β += failures``, exactly the Beta/Bernoulli posterior update
``docs/learning.md §2`` documents for the composition bandit.

Selection is Thompson sampling: draw ``θ_s ~ Beta(α_s, β_s)`` for every available
strategy and play ``argmax_s θ_s``. A seeded ``random.Random`` makes the whole
walk reproducible, which the tests pin.

The loop's stopping rule lives in ``runner`` (stop when a whole round covers no
new symbol, or the budget is spent); this module owns only the posteriors, the
draw, and their serialisation.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any

# The strategy arms, in a stable order.
STRATEGIES = (
    "schema_valid",
    "schema_boundary",
    "schema_negative",
    "observed",
    "semantic",
)


@dataclass
class BetaArm:
    """A Beta(α, β) posterior over 'this strategy covers new ground'."""

    alpha: float = 1.0
    beta: float = 1.0
    plays: int = 0
    reward_sum: float = 0.0  # total newly-covered symbols (raw, for reporting)

    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    def update(self, covered_new: int) -> None:
        """Bernoulli update: success iff the probe covered ≥1 new symbol."""
        self.plays += 1
        self.reward_sum += max(0, covered_new)
        if covered_new > 0:
            self.alpha += 1.0
        else:
            self.beta += 1.0

    def to_json(self) -> dict[str, Any]:
        return {
            "alpha": round(self.alpha, 4),
            "beta": round(self.beta, 4),
            "plays": self.plays,
            "reward_sum": self.reward_sum,
            "mean": round(self.mean(), 4),
        }


@dataclass
class EndpointBandit:
    """The per-endpoint posterior grid over the available strategies."""

    strategies: tuple[str, ...]
    arms: dict[str, BetaArm] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for s in self.strategies:
            self.arms.setdefault(s, BetaArm())

    def select(self, rng: random.Random) -> str:
        """Thompson draw: sample each arm's θ and return the argmax strategy.

        Ties (identical draws — possible only with a pathological RNG) break on
        the fixed STRATEGIES order, keeping selection deterministic per seed.
        """
        best: str | None = None
        best_theta = -1.0
        for s in self.strategies:
            arm = self.arms[s]
            theta = rng.betavariate(arm.alpha, arm.beta)
            if theta > best_theta:
                best_theta = theta
                best = s
        return best or self.strategies[0]

    def update(self, strategy: str, covered_new: int) -> None:
        arm = self.arms.get(strategy)
        if arm is not None:
            arm.update(covered_new)

    def preferred(self) -> str:
        """The current best arm by posterior mean (for the summary)."""
        return max(self.strategies, key=lambda s: self.arms[s].mean())

    def to_json(self) -> dict[str, Any]:
        return {s: self.arms[s].to_json() for s in self.strategies}


def bandit_summary(bandits: dict[str, EndpointBandit]) -> dict[str, Any]:
    """A compact posterior report over all endpoints (written to bandit.json)."""
    per_endpoint = {ep: b.to_json() for ep, b in sorted(bandits.items())}
    # Pooled arm means across endpoints — the headline "which strategy pays".
    pooled: dict[str, dict[str, float]] = {}
    for s in STRATEGIES:
        arms = [b.arms[s] for b in bandits.values() if s in b.arms]
        plays = sum(a.plays for a in arms)
        reward = sum(a.reward_sum for a in arms)
        alpha = sum(a.alpha for a in arms)
        beta = sum(a.beta for a in arms)
        pooled[s] = {
            "plays": plays,
            "reward_sum": reward,
            "posterior_mean": round(alpha / (alpha + beta), 4) if (alpha + beta) else 0.0,
        }
    return {
        "priors": {"alpha0": 1.0, "beta0": 1.0},
        "reward": "bernoulli: 1 iff probe covered >=1 new symbol",
        "selection": "thompson: theta_s ~ Beta(alpha_s,beta_s), play argmax_s theta_s",
        "pooled": pooled,
        "per_endpoint": per_endpoint,
    }
