"""The exploration bandit — Thompson sampling over (target × technique × oracle).

**What is chosen.** An ACTION is a triple: which target to push on, by which
input-generation technique, judged by which oracle. Restricting arms to input
strategies for one HTTP endpoint made the action space far smaller than the real
one — "call this function directly with a Hypothesis strategy and check it
against CPython" was not expressible at all, so the loop could never learn that
it is the highest-yield thing to do on a library. ``Action`` names the full
triple; the legacy per-endpoint strategy arms are the special case
``(http endpoint × schema_* technique × status oracle)``.

**What is rewarded.** Coverage is a PROXY. What the loop actually wants is
oracle violations found per unit cost, so that is the objective:

* a play that produced an oracle violation scores ``1.0``;
* a play that produced no violation but reached new ground scores
  ``COVERAGE_BONUS`` — coverage survives as an EXPLORATION BONUS, which is what
  it always should have been, rather than the goal;
* anything else scores ``0.0``;
* the score is then divided by the play's cost in probe-equivalents, so an
  expensive technique must find proportionally more to keep its posterior.

The credit lands in a ``Beta(α, β)`` posterior as a fractional pseudo-count
(``α += credit``, ``β += 1 − credit``), so α+β still grows by exactly one per
play and the conjugate update is unchanged — ``docs/learning.md §2``'s
Beta/Bernoulli scheme generalised from a bit to a bounded score.

Selection is Thompson sampling: draw ``θ_a ~ Beta(α_a, β_a)`` for every
available action and play ``argmax_a θ_a``. A seeded ``random.Random`` makes the
whole walk reproducible, which the tests pin.

The loop's stopping rule lives in ``runner``; this module owns only the
posteriors, the draw, and their serialisation.
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

# Score for a play that broke no oracle but reached new ground. Coverage is the
# exploration bonus, not the objective — high enough that exploring still pays
# when nothing is breaking, low enough that a violation always outranks it.
COVERAGE_BONUS = 0.25


@dataclass
class Outcome:
    """What one play produced — the inputs to the objective.

    ``violations`` counts ORACLE violations (a 5xx/crash, an invariant broken, a
    baseline degraded, a differential mismatch, a fault-injection crash), not
    merely a non-2xx: an endpoint correctly rejecting a negative input is
    working, and rewarding it would teach the loop to spam malformed inputs.
    ``cost`` is in probe-equivalents, so techniques of different price compete
    on yield rather than on convenience.
    """

    violations: int = 0
    new_coverage: int = 0
    cost: float = 1.0

    def credit(self) -> float:
        """Bounded score in [0, 1]: violations first, coverage as the bonus."""
        if self.violations > 0:
            value = 1.0
        elif self.new_coverage > 0:
            value = COVERAGE_BONUS
        else:
            value = 0.0
        return value / max(1.0, self.cost)


@dataclass(frozen=True, order=True)
class Action:
    """One arm of the enriched action space.

    ``target`` is what is pushed on (an endpoint id, a ``module:function``, a
    boundary), ``technique`` is how inputs are generated, and ``oracle`` is what
    judges the result. The same target under a different oracle is a DIFFERENT
    arm, because the yield of "call it and see if it raises" and "call it and
    compare against CPython" are not the same quantity.
    """

    target: str
    technique: str
    oracle: str

    @property
    def key(self) -> str:
        return f"{self.target}|{self.technique}|{self.oracle}"

    @classmethod
    def parse(cls, key: str) -> Action:
        target, _, rest = key.partition("|")
        technique, _, oracle = rest.partition("|")
        return cls(target=target, technique=technique, oracle=oracle)

    def to_json(self) -> dict[str, str]:
        return {"target": self.target, "technique": self.technique, "oracle": self.oracle}


@dataclass
class BetaArm:
    """A Beta(α, β) posterior over 'this action finds a violation per unit cost'."""

    alpha: float = 1.0
    beta: float = 1.0
    plays: int = 0
    reward_sum: float = 0.0  # total credit earned (raw, for reporting)
    violations: int = 0  # oracle violations this arm has produced
    coverage_sum: int = 0  # newly covered symbols/branch arms (exploration)
    cost_sum: float = 0.0

    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    def update(self, outcome: Outcome | int) -> None:
        """Fractional Beta update from a play's outcome.

        An ``int`` is accepted as the legacy "newly covered symbols" signal and
        is treated as a coverage-only outcome, so callers that have not moved to
        the violation-first objective keep working with identical semantics.
        """
        if isinstance(outcome, int):
            outcome = Outcome(new_coverage=max(0, outcome))
        credit = outcome.credit()
        self.plays += 1
        self.reward_sum += credit
        self.violations += outcome.violations
        self.coverage_sum += outcome.new_coverage
        self.cost_sum += outcome.cost
        self.alpha += credit
        self.beta += 1.0 - credit

    def to_json(self) -> dict[str, Any]:
        return {
            "alpha": round(self.alpha, 4),
            "beta": round(self.beta, 4),
            "plays": self.plays,
            "reward_sum": round(self.reward_sum, 4),
            "violations": self.violations,
            "coverage_sum": self.coverage_sum,
            "cost_sum": round(self.cost_sum, 4),
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

    def update(self, strategy: str, outcome: Outcome | int) -> None:
        arm = self.arms.get(strategy)
        if arm is not None:
            arm.update(outcome)

    def preferred(self) -> str:
        """The current best arm by posterior mean (for the summary)."""
        return max(self.strategies, key=lambda s: self.arms[s].mean())

    def to_json(self) -> dict[str, Any]:
        return {s: self.arms[s].to_json() for s in self.strategies}


@dataclass
class ActionBandit:
    """Thompson sampling over the full ``(target × technique × oracle)`` space.

    Unlike ``EndpointBandit`` (one endpoint, strategies only), this holds arms
    across techniques and oracles at once, so the loop can learn that — on this
    repo — driving functions in-process against a differential oracle pays
    better than another round of HTTP probes, and shift its budget accordingly.
    """

    actions: tuple[Action, ...] = ()
    arms: dict[str, BetaArm] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for a in self.actions:
            self.arms.setdefault(a.key, BetaArm())

    def add(self, action: Action) -> None:
        """Register an action discovered mid-run (a new target, say)."""
        if action.key not in self.arms:
            self.actions = (*self.actions, action)
            self.arms[action.key] = BetaArm()

    def select(self, rng: random.Random) -> Action | None:
        """Thompson draw over every registered action."""
        best: Action | None = None
        best_theta = -1.0
        for a in sorted(self.actions):
            arm = self.arms[a.key]
            theta = rng.betavariate(arm.alpha, arm.beta)
            if theta > best_theta:
                best_theta = theta
                best = a
        return best

    def update(self, action: Action, outcome: Outcome | int) -> None:
        arm = self.arms.get(action.key)
        if arm is not None:
            arm.update(outcome)

    def preferred(self) -> Action | None:
        if not self.actions:
            return None
        return max(sorted(self.actions), key=lambda a: self.arms[a.key].mean())

    def by_dimension(self, dim: str) -> dict[str, dict[str, Any]]:
        """Pooled posteriors marginalised over one dimension of the triple.

        Answers "which TECHNIQUE pays here" / "which ORACLE pays here" — the
        questions a human actually asks of the loop.
        """
        pooled: dict[str, list[BetaArm]] = {}
        for a in self.actions:
            pooled.setdefault(getattr(a, dim), []).append(self.arms[a.key])
        out: dict[str, dict[str, Any]] = {}
        for name, arms in sorted(pooled.items()):
            alpha = sum(x.alpha for x in arms)
            beta = sum(x.beta for x in arms)
            out[name] = {
                "plays": sum(x.plays for x in arms),
                "violations": sum(x.violations for x in arms),
                "coverage_sum": sum(x.coverage_sum for x in arms),
                "cost_sum": round(sum(x.cost_sum for x in arms), 4),
                "posterior_mean": round(alpha / (alpha + beta), 4) if (alpha + beta) else 0.0,
            }
        return out

    def to_json(self) -> dict[str, Any]:
        preferred = self.preferred()
        return {
            "objective": (
                "oracle violations per unit cost; coverage is the exploration "
                f"bonus (weight {COVERAGE_BONUS})"
            ),
            "selection": "thompson: theta_a ~ Beta(alpha_a,beta_a), play argmax_a theta_a",
            "action_space": "target x technique x oracle",
            "actions": len(self.actions),
            "preferred": preferred.to_json() if preferred else None,
            "by_technique": self.by_dimension("technique"),
            "by_oracle": self.by_dimension("oracle"),
            "arms": {
                a.key: {**a.to_json(), **self.arms[a.key].to_json()} for a in sorted(self.actions)
            },
        }


def seed_actions_from_prior(
    bandit: ActionBandit,
    prior: dict[str, Any] | None,
    decay: float = 0.5,
) -> ActionBandit:
    """Warm-start action arms from a previous run's ``arms`` block, decayed."""
    for key, arm_json in ((prior or {}).get("arms") or {}).items():
        if not isinstance(arm_json, dict):
            continue
        action = Action.parse(key)
        bandit.add(action)
        arm = bandit.arms[action.key]
        arm.alpha = 1.0 + (float(arm_json.get("alpha", 1.0)) - 1.0) * decay
        arm.beta = 1.0 + (float(arm_json.get("beta", 1.0)) - 1.0) * decay
    return bandit


def seed_from_prior(
    bandit: EndpointBandit,
    prior: dict[str, Any] | None,
    decay: float = 0.5,
) -> EndpointBandit:
    """Warm-start arms from a previous run's posteriors, decayed toward Beta(1,1).

    ``decay`` is the survival fraction of accumulated evidence per run: 0.5
    halves it every run it goes unrefreshed. This is the expiry mechanism for
    learned strategy state — persistent enough to skip re-exploring what
    worked yesterday, mortal enough that a lesson learned against a
    since-changed environment cannot dominate forever.
    """
    for strat, arm_json in (prior or {}).items():
        arm = bandit.arms.get(strat)
        if arm is None or not isinstance(arm_json, dict):
            continue
        arm.alpha = 1.0 + (float(arm_json.get("alpha", 1.0)) - 1.0) * decay
        arm.beta = 1.0 + (float(arm_json.get("beta", 1.0)) - 1.0) * decay
    return bandit


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
            "reward_sum": round(reward, 4),
            "violations": sum(a.violations for a in arms),
            "coverage_sum": sum(a.coverage_sum for a in arms),
            "posterior_mean": round(alpha / (alpha + beta), 4) if (alpha + beta) else 0.0,
        }
    return {
        "priors": {"alpha0": 1.0, "beta0": 1.0},
        "objective": (
            "oracle violations per unit cost; coverage is the exploration bonus "
            f"(weight {COVERAGE_BONUS})"
        ),
        "reward": (
            "fractional Beta credit in [0,1]: 1.0 on an oracle violation, "
            f"{COVERAGE_BONUS} on new symbol/branch coverage alone, 0.0 otherwise, "
            "divided by the play's cost in probe-equivalents"
        ),
        "selection": "thompson: theta_s ~ Beta(alpha_s,beta_s), play argmax_s theta_s",
        "pooled": pooled,
        "per_endpoint": per_endpoint,
    }
