/**
 * Episode policy updater — closes the RL loop locally after every episode.
 *
 * The composition bandit is Thompson sampling over the 2^|F| arm grid with a
 * Beta-Bernoulli posterior per arm (selection lives in episodeTelemetry.ts).
 * This updater turns the ledger into those posteriors:
 *
 * - Posteriors: for each arm, alpha = ts_prior_alpha + #verified, beta =
 *   ts_prior_beta + #unverified, counting ONLY objective episodes (see
 *   CompletedEpisode.objective). A user abort or a human "approve as done" is
 *   not evidence about arm quality; pooling it would bias every arm by the
 *   task-mix, so it is excluded (SOTA OPE: log ⊥, never impute). The reward
 *   used is the binary verified bit — fix SPEED feeds the attempt budget, not
 *   the arm value, keeping the posterior a clean Bernoulli success model.
 * - Why Thompson, not the previous empirical-Bernstein promotion gate: episode
 *   pulls are expensive (one coding-agent dispatch each) and reward is
 *   low-variance/binary, so sample efficiency dominates (Chapelle & Li,
 *   NeurIPS 2011). The old gate needed ~50–80 samples on ONE arm before its
 *   LCB could ever clear the incumbent, so the hand-set prior arm never moved
 *   in realistic use; Thompson adapts from the first pulls and self-anneals.
 * - The flat Beta(1,1) prior IS the regularizer: a sparse arm on a lucky
 *   streak is shrunk toward 0.5, so it cannot dominate a well-sampled arm —
 *   the same protection the old shrinkage gave, without a separate pseudo-count.
 * - Attribution: exact Shapley of each composition feature over the 2^|F| grid
 *   of posterior MEANS — no sampling. Features are the "players"; a coalition
 *   is the arm with those features at their rich level.
 * - Attempt budget: the smallest budget covering the learned `attempt_quantile`
 *   of attempts-to-success across OBJECTIVE verified episodes, plus one margin.
 * - Off-policy evaluation of whole candidate policies (IPS/SNIPS/DR) is a
 *   SEPARATE, offline concern for the RETRIEVAL ledger (retrieval.jsonl); the
 *   episode ledger is not consumed by Vinv/index/eval/off_policy.py (different
 *   schema — no epoch/action.top_k).
 */
import * as fs from 'fs';
import {
	appendEpisodeEvent,
	armLevels,
	episodeLedgerPath,
	EPISODE_FEATURES,
	levelsToIndex,
	loadEpisodePolicy,
	posteriorMean,
	saveEpisodePolicy,
	type ArmFeatureLevels,
	type ArmPosterior,
	type EpisodeArm,
	type EpisodeFeature,
	type EpisodePolicy,
} from './episodeTelemetry';

/**
 * Maps a logged arm's FEATURE VALUES onto the current grid's coalition index.
 * Joining on values instead of the logged index keeps the ledger valid across
 * arm-set evolution (including the legacy 3-arm set, whose values are all
 * coalitions of the current grid). An arm whose values match no current level
 * is unmappable → its episode is excluded rather than misattributed.
 */
export function armIndexForValues(
	arm: Partial<EpisodeArm>,
	levels: ArmFeatureLevels,
): number | null {
	const coalition = {} as Record<EpisodeFeature, 0 | 1>;
	for (const feature of EPISODE_FEATURES) {
		const value = arm[feature];
		const pair = levels[feature] as [unknown, unknown];
		if (value === pair[0]) {
			coalition[feature] = 0;
		} else if (value === pair[1]) {
			coalition[feature] = 1;
		} else {
			return null;
		}
	}
	return levelsToIndex(coalition);
}

/** One completed episode joined from start + end ledger events. */
export interface CompletedEpisode {
	armIndex: number;
	propensity: number;
	reward: number;
	attempts: number;
	verified: boolean;
	/**
	 * True when the outcome came from an OBJECTIVE oracle (service replay or a
	 * generated test) rather than a human escalation or a user abort. Only
	 * objective episodes train the composition bandit — a user's abort or an
	 * "approve as done" click is not evidence about arm quality, and pooling
	 * them biases every arm by the task-mix (SOTA OPE: log ⊥, never impute).
	 */
	objective: boolean;
}

/**
 * Joins episode_start and episode_end events into completed episodes. When
 * `levels` is given, the logged arm VALUES are re-mapped onto that grid (see
 * armIndexForValues) so old ledger entries stay usable after the arm set
 * evolves; entries that fit no current coalition are excluded.
 */
export function readCompletedEpisodes(
	ledgerPath: string = episodeLedgerPath(),
	levels?: ArmFeatureLevels,
): CompletedEpisode[] {
	let content: string;
	try {
		content = fs.readFileSync(ledgerPath, 'utf8');
	} catch {
		return [];
	}
	const starts = new Map<string, { armIndex: number; propensity: number }>();
	// One completed record per episode id — a duplicate/forged second
	// episode_end must not double-count an arm's evidence (first end wins).
	const byId = new Map<string, CompletedEpisode>();
	// Reconciliation retractions: a human counterexample that REPRODUCED on
	// "verified" code retracts the verified bit. The retracted episode is
	// re-labeled verified=false with objective=true — a reproducible failing
	// test is objective evidence about the arm, unlike a bare thumbs-down.
	const retracted = new Set<string>();
	for (const line of content.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const id = typeof event.episode_id === 'string' ? event.episode_id : undefined;
		if (!id) {
			continue;
		}
		if (
			event.type === 'episode_start' &&
			typeof event.arm_index === 'number' &&
			typeof event.propensity === 'number'
		) {
			let armIndex: number | null = event.arm_index;
			if (levels && typeof event.arm === 'object' && event.arm !== null) {
				armIndex = armIndexForValues(event.arm as Partial<EpisodeArm>, levels);
			}
			if (armIndex !== null) {
				starts.set(id, { armIndex, propensity: event.propensity });
			}
		} else if (event.type === 'episode_end') {
			const start = starts.get(id);
			if (
				start &&
				!byId.has(id) &&
				typeof event.reward === 'number' &&
				typeof event.attempts === 'number' &&
				typeof event.verified === 'boolean'
			) {
				// Back-compat: ledgers written before the objective flag existed
				// treat any non-aborted episode as objective (the prior behavior).
				const aborted = event.aborted === true;
				const objective =
					typeof event.objective === 'boolean' ? event.objective : !aborted;
				byId.set(id, {
					armIndex: start.armIndex,
					propensity: start.propensity,
					reward: event.reward,
					attempts: Math.max(1, event.attempts),
					verified: event.verified,
					objective,
				});
			}
		} else if (event.type === 'reconciliation' && event.retracted === true) {
			retracted.add(id);
		}
	}
	for (const id of retracted) {
		const episode = byId.get(id);
		if (episode) {
			episode.verified = false;
			episode.objective = true;
			episode.reward = -1;
		}
	}
	return [...byId.values()];
}

interface ArmStats {
	n: number;
	mean: number;
	variance: number;
}

/** Per-arm sample count, mean and (population) variance of observed rewards. */
export function perArmStats(episodes: CompletedEpisode[], armCount: number): ArmStats[] {
	const sums = new Array<number>(armCount).fill(0);
	const counts = new Array<number>(armCount).fill(0);
	for (const e of episodes) {
		if (e.armIndex >= 0 && e.armIndex < armCount) {
			sums[e.armIndex] += e.reward;
			counts[e.armIndex] += 1;
		}
	}
	const means = sums.map((s, a) => (counts[a] > 0 ? s / counts[a] : 0));
	const sq = new Array<number>(armCount).fill(0);
	for (const e of episodes) {
		if (e.armIndex >= 0 && e.armIndex < armCount) {
			sq[e.armIndex] += (e.reward - means[e.armIndex]) ** 2;
		}
	}
	return means.map((mean, a) => ({
		n: counts[a],
		mean,
		variance: counts[a] > 0 ? sq[a] / counts[a] : 0,
	}));
}

/** Shrinks a sparse arm's mean toward the global mean with pseudo-count n0. */
export function shrunkMean(stats: ArmStats, globalMean: number, n0: number): number {
	if (stats.n === 0) {
		return globalMean;
	}
	return (stats.n * stats.mean + n0 * globalMean) / (stats.n + n0);
}

/**
 * Empirical Bernstein lower confidence bound (Maurer & Pontil 2009), for
 * rewards in [-1, 1] (range 2). Returns -Infinity with no samples.
 */
export function bernsteinLcb(stats: ArmStats, delta: number): number {
	if (stats.n === 0) {
		return Number.NEGATIVE_INFINITY;
	}
	const range = 2;
	const logTerm = Math.log(3 / delta);
	const sampleVar = stats.n > 1 ? (stats.variance * stats.n) / (stats.n - 1) : stats.variance;
	return (
		stats.mean -
		Math.sqrt((2 * sampleVar * logTerm) / stats.n) -
		(3 * range * logTerm) / stats.n
	);
}

/**
 * Exact Shapley value per composition feature over the 2^|F| factorial arm
 * grid: coalition S = "these features at their rich level, the rest lean",
 * v(S) = that arm's shrunk mean. Exact because every coalition IS an arm.
 */
export function shapleyAttribution(
	values: number[],
): Record<EpisodeFeature, number> {
	const features = EPISODE_FEATURES;
	const factorial = (k: number): number => (k <= 1 ? 1 : k * factorial(k - 1));
	const total = factorial(features.length);
	const result = {} as Record<EpisodeFeature, number>;
	for (const feature of features) {
		let phi = 0;
		const others = features.filter((f) => f !== feature);
		// Every subset of the other features.
		for (let mask = 0; mask < 1 << others.length; mask++) {
			const levels = { slice_depth: 0, include_runtime: 0, snippet_chars: 0 } as Record<
				EpisodeFeature,
				0 | 1
			>;
			let size = 0;
			for (let b = 0; b < others.length; b++) {
				if (mask & (1 << b)) {
					levels[others[b]] = 1;
					size += 1;
				}
			}
			const without = values[levelsToIndex(levels)];
			levels[feature] = 1;
			const withF = values[levelsToIndex(levels)];
			const weight = (factorial(size) * factorial(features.length - size - 1)) / total;
			phi += weight * (withF - without);
		}
		result[feature] = phi;
	}
	return result;
}

/** Quantile of a sorted-or-not numeric sample (nearest-rank). */
export function nearestRankQuantile(sample: number[], q: number): number {
	if (sample.length === 0) {
		return 0;
	}
	const sorted = [...sample].sort((a, b) => a - b);
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[rank];
}

/**
 * Recomputes the policy from ledger evidence. Pure given the episodes — the
 * caller persists. Returns the same policy object when nothing changes.
 */
export function computeUpdatedPolicy(
	current: EpisodePolicy,
	episodes: CompletedEpisode[],
): EpisodePolicy {
	const armCount = 1 << EPISODE_FEATURES.length;
	const next: EpisodePolicy = { ...current, episodes_seen: episodes.length };
	if (episodes.length === 0) {
		return next;
	}
	// Train the bandit ONLY on objective outcomes: a user abort or a human
	// "approve as done" is not evidence about which context composition works.
	const objective = episodes.filter((e) => e.objective);

	// Per-arm Beta posteriors over the verified-fix probability. Reward is the
	// binary verified bit (fix speed feeds attempt_budget below, not the arm
	// value): alpha = prior + #verified, beta = prior + #unverified, per arm.
	const posteriors: ArmPosterior[] = Array.from({ length: armCount }, () => ({
		alpha: current.ts_prior_alpha,
		beta: current.ts_prior_beta,
	}));
	for (const e of objective) {
		if (e.armIndex >= 0 && e.armIndex < armCount) {
			if (e.verified) {
				posteriors[e.armIndex].alpha += 1;
			} else {
				posteriors[e.armIndex].beta += 1;
			}
		}
	}
	next.arm_posteriors = posteriors;

	// Greedy arm + Shapley attribution over posterior MEANS (the learned
	// verified-fix rate per arm). Exact over the 2^|F| grid.
	const means = posteriors.map(posteriorMean);
	next.attribution = shapleyAttribution(means);
	let best = 0;
	for (let a = 1; a < armCount; a++) {
		if (means[a] > means[best]) {
			best = a;
		}
	}
	next.preferred_arm = best;

	// Attempt budget: smallest budget covering the learned quantile of
	// attempts-to-success (objective successes only), PLUS one attempt of
	// optimism margin so the budget can recover (see prior note). No objective
	// successes yet → keep the current budget.
	const successAttempts = objective.filter((e) => e.verified).map((e) => e.attempts);
	if (successAttempts.length > 0) {
		const needed = nearestRankQuantile(successAttempts, current.attempt_quantile);
		next.attempt_budget = Math.min(
			current.attempt_budget_max,
			Math.max(1, Math.round(needed)) + 1,
		);
	}
	next.updated_at = new Date().toISOString();
	return next;
}

/**
 * Reads the ledger, recomputes the policy, persists it, and logs the update.
 * Called after every episode_end; cheap (the ledger is line-scanned once).
 */
export function maybeUpdateEpisodePolicy(): EpisodePolicy {
	const current = loadEpisodePolicy();
	const episodes = readCompletedEpisodes(episodeLedgerPath(), current.arm_levels);
	const next = computeUpdatedPolicy(current, episodes);
	saveEpisodePolicy(next);
	appendEpisodeEvent({
		type: 'policy_updated',
		ts: new Date().toISOString(),
		episodes_seen: next.episodes_seen,
		preferred_arm: next.preferred_arm,
		attempt_budget: next.attempt_budget,
		attribution: next.attribution ?? null,
	});
	return next;
}
