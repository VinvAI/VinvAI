#!/usr/bin/env python3
"""Offline evaluation for retrieval top-k policies from MCP bandit telemetry.

Sample-size design (the gates must FIRE in real usage, not only in theory):
the top-k action's semantics are stable across index epochs — "how many
results to serve" does not change meaning when file contents drift — so
decisions POOL across epochs (``--epoch all``). IPS/DR stay unbiased
conditionally on the observed contexts (the estimand becomes the policy value
over the historical context mixture; see Waudby-Smith et al., "Anytime-valid
off-policy inference for contextual bandits", arXiv:2210.10768), and a
per-epoch consistency diagnostic guards against Simpson-style pooling
artifacts. The promotion gate is a two-stage design: this offline gate is a
do-no-harm + plausible-win filter at small n (ESS >= 25 — the
bootstrap-validity/CLT boundary, self-limiting to effects >= ~0.15; BCa
bootstrap, which is near-nominal from n~20 where percentile intervals
undercover; per-action support floors so DR cells are populated), and the 5%
canary with auto-rollback in the extension is the actual test.
"""

import argparse
import hashlib
import json
import math
import os
import random
from collections import defaultdict
from pathlib import Path

#: Epoch value that pools decisions across all epochs (stable action semantics).
POOL_ALL = "all"

#: Minimum logged pulls of a compared action for its DR cell to count as
#: supported (the ESS>=200 production heuristic of arXiv:2207.00632, scaled to
#: the small-n regime this gate serves).
MIN_ACTION_PULLS = 8

#: Minimum joined samples for a per-epoch consistency read to qualify.
EPOCH_CONSISTENCY_MIN_N = 20

#: A qualifying epoch contradicting the pooled delta by more than this fails
#: the pooling guard (0.1 ~ the smallest effect the ESS-25 gate can promote).
EPOCH_CONSISTENCY_TOLERANCE = 0.1


def load_samples(path, epoch, reward_source="explicit"):
    """Join decisions with rewards of the requested source.

    Returns ``(samples, diagnostics)``. ``epoch`` may be a concrete epoch or
    ``POOL_ALL`` ("all") to pool every epoch — each sample then carries its
    ``epoch`` for the consistency diagnostic. Feedback events carry
    ``source`` in {"explicit", "auxiliary"}; legacy events without a source
    are treated as explicit. Fallback decisions (a canary draw that failed
    and was served as baseline) are logged as their true draw but excluded
    here — their served action does not match their logged propensity.
    Missing explicit feedback is missing-not-at-random, so the diagnostics
    always report the logged-decision denominator.
    """
    decisions = {}
    feedback = defaultdict(dict)
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if epoch != POOL_ALL and event.get("epoch") != epoch:
                continue
            decision_id = event.get("decision_id")
            if not decision_id:
                continue
            if event.get("type") == "decision":
                decisions[decision_id] = event
            elif event.get("type") == "feedback":
                source = event.get("source") or "explicit"
                feedback[decision_id][source] = event
    samples = []
    fallback_count = 0
    explicit_count = 0
    for decision_id, decision in decisions.items():
        if decision.get("fallback") is True:
            fallback_count += 1
            continue
        sources = feedback.get(decision_id, {})
        if "explicit" in sources:
            explicit_count += 1
        chosen = sources.get(reward_source)
        if chosen is None and reward_source == "any":
            # Preference order mirrors signal strength: a human's explicit
            # grade > the deterministic critic's grounding verdict > the
            # behavioral edit-overlap signal > the implicit reformulation
            # signal.
            chosen = (
                sources.get("explicit")
                or sources.get("critic")
                or sources.get("auxiliary")
                or sources.get("implicit")
            )
        if chosen is None:
            continue
        reward = chosen.get("reward")
        action = (decision.get("action") or {}).get("top_k")
        propensity = decision.get("propensity")
        if (
            isinstance(reward, (int, float))
            and math.isfinite(reward)
            and isinstance(action, int)
            and isinstance(propensity, (int, float))
            and 0 < propensity <= 1
        ):
            samples.append(
                {
                    "decision_id": decision_id,
                    "action": action,
                    "propensity": float(propensity),
                    "reward": float(reward),
                    "epoch": decision.get("epoch"),
                }
            )
    diagnostics = {
        "logged_decisions": len(decisions),
        "fallback_decisions_excluded": fallback_count,
        "explicit_feedback_rate": (
            explicit_count / len(decisions) if decisions else 0.0
        ),
        "reward_source": reward_source,
    }
    return samples, diagnostics


def _stratified_folds(samples):
    """Two-fold assignment stratified by action.

    Within each logged action, samples are ordered by a decision-id hash and
    alternated between folds, so both folds see every action that has at
    least two samples. A bare hash split can starve a fold of a rare action,
    which silently degrades the cross-fitted model to the global mean.
    """
    folds = {}
    by_action = defaultdict(list)
    for row in samples:
        by_action[row["action"]].append(row["decision_id"])
    for decision_ids in by_action.values():
        decision_ids.sort(key=lambda d: hashlib.sha256(d.encode()).hexdigest())
        for position, decision_id in enumerate(decision_ids):
            folds[decision_id] = position & 1
    return folds


def _reward_predictions(samples):
    """Two-fold cross-fitted action means, folds stratified by action."""
    folds = _stratified_folds(samples)
    models = {}
    for held_out_fold in (0, 1):
        training = [
            row for row in samples if folds[row["decision_id"]] != held_out_fold
        ]
        global_mean = (
            sum(row["reward"] for row in training) / len(training)
            if training
            else 0.0
        )
        by_action = defaultdict(list)
        for row in training:
            by_action[row["action"]].append(row["reward"])
        models[held_out_fold] = {
            action: sum(rewards) / len(rewards)
            for action, rewards in by_action.items()
        } | {"__global__": global_mean}
    return [models[folds[sample["decision_id"]]] for sample in samples]


def estimate(samples, target_top_k, weight_clip=None, min_ess=25.0, min_samples=40):
    """Cross-fitted direct, IPS, SNIPS, and doubly robust estimates.

    ``weight_clip=None`` aligns the clip with the logged propensities: the
    maximum achievable weight is 1/min(propensity) over samples matching the
    target action, so no weight is ever clipped and the estimator stays
    unbiased. Pass an explicit clip only to trade bias for variance, and read
    ``clipped_fraction`` to see how much bias that introduced.

    Support is gated on the effective sample size of the target action's
    importance weights (plus a minimum joined-sample count and a per-action
    pull floor) rather than a raw overlap fraction: under epsilon-greedy
    logging a rare-but-correctly-propensitied action would fail a raw overlap
    gate even when the estimate is perfectly identified.

    Gate calibration (see module docstring): ESS >= 25 is the
    bootstrap-validity/CLT boundary — with binary rewards SE ~ 0.09 there, so
    the LCB >= 0 rule only clears deltas >= ~0.15; the gate self-limits to
    large wins at small n, and the live canary (with rollback) is the real
    test. The previous 200/100 gates could never fire at observed per-epoch
    volumes (~56 decisions/epoch), which made promotion structurally
    unreachable — a broken gate, not a conservative one.
    """
    if not samples:
        raise ValueError("no joined decision/feedback samples for epoch")
    matched_inverse = [
        1.0 / sample["propensity"]
        for sample in samples
        if sample["action"] == target_top_k
    ]
    effective_clip = (
        weight_clip if weight_clip is not None else max(matched_inverse, default=1.0)
    )
    predictions = _reward_predictions(samples)
    weights = []
    ips_terms = []
    dr_terms = []
    clipped = 0
    for sample, model in zip(samples, predictions, strict=True):
        target_probability = 1.0 if sample["action"] == target_top_k else 0.0
        raw_weight = target_probability / sample["propensity"]
        weight = min(effective_clip, raw_weight)
        if raw_weight > effective_clip:
            clipped += 1
        weights.append(weight)
        ips_terms.append(weight * sample["reward"])
        target_prediction = model.get(target_top_k, model["__global__"])
        logged_prediction = model.get(sample["action"], model["__global__"])
        dr_terms.append(
            target_prediction + weight * (sample["reward"] - logged_prediction)
        )
    weight_sum = sum(weights)
    ess = weight_sum**2 / sum(weight**2 for weight in weights) if weight_sum else 0.0
    overlap = sum(weight > 0 for weight in weights) / len(weights)
    direct = sum(
        model.get(target_top_k, model["__global__"]) for model in predictions
    ) / len(predictions)
    return {
        "count": len(samples),
        "matched_count": len(matched_inverse),
        "target_top_k": target_top_k,
        "direct_method": direct,
        "ips": sum(ips_terms) / len(samples),
        "snips": (
            sum(ips_terms) / weight_sum if weight_sum else None
        ),
        "doubly_robust": sum(dr_terms) / len(samples),
        "overlap": overlap,
        "effective_sample_size": ess,
        "max_importance_weight": max(weights),
        "weight_clip_used": effective_clip,
        "clipped_fraction": clipped / len(samples),
        "support_ok": (
            ess >= min_ess
            and len(samples) >= min_samples
            and len(matched_inverse) >= MIN_ACTION_PULLS
        ),
    }


def bootstrap_dr_interval(samples, target_top_k, iterations=2000, seed=0):
    rng = random.Random(seed)
    values = []
    for _ in range(iterations):
        resampled = [samples[rng.randrange(len(samples))] for _ in samples]
        values.append(estimate(resampled, target_top_k)["doubly_robust"])
    values.sort()
    return [
        values[int(0.025 * (len(values) - 1))],
        values[int(0.975 * (len(values) - 1))],
    ]


def _phi(x):
    """Standard normal CDF via erf (stdlib only)."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _phi_inv(p):
    """Acklam's rational approximation to the standard normal quantile —
    |relative error| < 1.15e-9, no scipy dependency."""
    if not 0.0 < p < 1.0:
        raise ValueError("p must be in (0, 1)")
    a = (-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
         1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00)
    b = (-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
         6.680131188771972e01, -1.328068155288572e01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
         -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
         3.754408661907416e00)
    p_low = 0.02425
    if p < p_low:
        q = math.sqrt(-2.0 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
        )
    if p > 1.0 - p_low:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
        )
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (
        ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0
    )


#: Jackknife cap for the BCa acceleration: beyond this, leave-one-out points
#: are subsampled deterministically (grouped-jackknife approximation) so the
#: interval stays computable on large ledgers without quadratic cost.
JACKKNIFE_CAP = 200


def _dr_delta(samples, baseline_top_k, target_top_k):
    return (
        estimate(samples, target_top_k)["doubly_robust"]
        - estimate(samples, baseline_top_k)["doubly_robust"]
    )


def bootstrap_dr_delta(
    samples, baseline_top_k, target_top_k, iterations=2000, seed=0
):
    """BCa (bias-corrected and accelerated) bootstrap CI for the DR delta.

    BCa rather than percentile because this gate must work at tens of
    samples: percentile intervals undercover below n~30 while BCa is
    near-nominal from n~20 (Efron 1987; small-n coverage simulations). The
    bias correction z0 comes from the bootstrap distribution's position
    relative to the point estimate; the acceleration a from the jackknife of
    the delta (capped/subsampled at JACKKNIFE_CAP for large ledgers).
    """
    rng = random.Random(seed)
    point = _dr_delta(samples, baseline_top_k, target_top_k)
    values = []
    for _ in range(iterations):
        resampled = [samples[rng.randrange(len(samples))] for _ in samples]
        values.append(_dr_delta(resampled, baseline_top_k, target_top_k))
    values.sort()
    below = sum(1 for v in values if v < point)
    # Clamp so a degenerate bootstrap (all mass one side) stays finite.
    frac = min(max(below / len(values), 1.0 / (len(values) + 1)),
               1.0 - 1.0 / (len(values) + 1))
    z0 = _phi_inv(frac)
    n = len(samples)
    if n > JACKKNIFE_CAP:
        stride = n / JACKKNIFE_CAP
        leave_out = [int(i * stride) for i in range(JACKKNIFE_CAP)]
    else:
        leave_out = list(range(n))
    jack = []
    for i in leave_out:
        loo = samples[:i] + samples[i + 1:]
        try:
            jack.append(_dr_delta(loo, baseline_top_k, target_top_k))
        except ValueError:
            continue
    accel = 0.0
    if len(jack) >= 2:
        mean = sum(jack) / len(jack)
        num = sum((mean - v) ** 3 for v in jack)
        den = 6.0 * (sum((mean - v) ** 2 for v in jack) ** 1.5)
        accel = num / den if den > 0 else 0.0

    def endpoint(alpha):
        z = _phi_inv(alpha)
        denom = 1.0 - accel * (z0 + z)
        adjusted = _phi(z0 + (z0 + z) / denom) if denom > 0 else alpha
        idx = min(len(values) - 1, max(0, int(adjusted * (len(values) - 1))))
        return values[idx]

    return [endpoint(0.025), endpoint(0.975)]


def epoch_consistency(samples, baseline_top_k, target_top_k):
    """Per-epoch DR deltas for pooled evaluations (Simpson-artifact guard).

    Pooling across epochs is sound when the reward mapping is stable; the
    observable symptom of it NOT being stable is an epoch that contradicts
    the pooled delta. Epochs with >= EPOCH_CONSISTENCY_MIN_N joined samples
    get a point-estimate read; ``ok`` fails when any qualifying epoch's delta
    is below -EPOCH_CONSISTENCY_TOLERANCE.
    """
    by_epoch = defaultdict(list)
    for row in samples:
        by_epoch[row.get("epoch")].append(row)
    reads = []
    for epoch_id, rows in sorted(by_epoch.items(), key=lambda kv: str(kv[0])):
        if len(rows) < EPOCH_CONSISTENCY_MIN_N:
            continue
        try:
            delta = _dr_delta(rows, baseline_top_k, target_top_k)
        except ValueError:
            continue
        reads.append({"epoch": epoch_id, "n": len(rows), "dr_delta": delta})
    ok = all(read["dr_delta"] >= -EPOCH_CONSISTENCY_TOLERANCE for read in reads)
    return {"epochs": reads, "ok": ok}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--telemetry", required=True)
    parser.add_argument("--epoch", required=True)
    parser.add_argument("--target-top-k", type=int, required=True)
    parser.add_argument("--baseline-top-k", type=int, default=5)
    parser.add_argument(
        "--weight-clip",
        type=float,
        default=None,
        help="importance-weight clip; default aligns with logged propensities "
        "(1/min propensity of the target action) so nothing is clipped",
    )
    parser.add_argument(
        "--reward-source",
        choices=("explicit", "critic", "auxiliary", "implicit", "any"),
        default="explicit",
        help="which feedback stream grades decisions; explicit vinv_feedback "
        "by default, auxiliary uses edit-overlap rewards, any prefers explicit",
    )
    parser.add_argument("--min-ess", type=float, default=25.0)
    parser.add_argument("--min-samples", type=int, default=40)
    parser.add_argument("--bootstrap", type=int, default=2000)
    parser.add_argument("--json-output", required=True)
    parser.add_argument(
        "--policy-output",
        help="write an epoch-bound 5%% canary policy only when promotion gates pass",
    )
    args = parser.parse_args()
    if (
        args.target_top_k < 1
        or args.baseline_top_k < 1
        or (args.weight_clip is not None and args.weight_clip <= 0)
        or args.bootstrap < 100
        or args.min_ess <= 0
        or args.min_samples < 1
    ):
        parser.error("target-top-k, weight-clip, and bootstrap must be positive")
    samples, diagnostics = load_samples(
        args.telemetry, args.epoch, args.reward_source
    )
    candidate = estimate(
        samples, args.target_top_k, args.weight_clip, args.min_ess, args.min_samples
    )
    baseline = estimate(
        samples, args.baseline_top_k, args.weight_clip, args.min_ess, args.min_samples
    )
    delta = candidate["doubly_robust"] - baseline["doubly_robust"]
    delta_interval = bootstrap_dr_delta(
        samples,
        args.baseline_top_k,
        args.target_top_k,
        args.bootstrap,
    )
    # Pooled evaluations must also pass the per-epoch consistency guard.
    consistency = (
        epoch_consistency(samples, args.baseline_top_k, args.target_top_k)
        if args.epoch == POOL_ALL
        else {"epochs": [], "ok": True}
    )
    result = {
        "epoch": args.epoch,
        "telemetry_diagnostics": diagnostics,
        "baseline": baseline,
        "candidate": candidate,
        "dr_delta": delta,
        "dr_delta_ci95": delta_interval,
        "epoch_consistency": consistency,
        "promotable": bool(
            baseline["support_ok"]
            and candidate["support_ok"]
            and delta_interval[0] >= 0
            and candidate["clipped_fraction"] == 0
            and consistency["ok"]
        ),
    }
    Path(args.json_output).write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    if args.policy_output and result["promotable"]:
        policy = {
            "version": 1,
            # A pooled evaluation promotes an epoch-agnostic policy ("any"):
            # the previous exact-epoch binding meant a promoted policy died on
            # the next index update — promotion was structurally unreachable.
            "epoch": "any" if args.epoch == POOL_ALL else args.epoch,
            "top_k": args.target_top_k,
            "canary_fraction": 0.05,
        }
        target = Path(args.policy_output)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        temporary.write_text(
            json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        os.chmod(temporary, 0o600)
        temporary.replace(target)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
