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
import * as path from 'path';
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
	// Measured optimization verdicts (appended by the exercise/optimize bridge,
	// possibly long after episode_end): per episode, per optimized row, the
	// LATEST verdict wins — a retry's verdict supersedes its predecessor for
	// the same row, exactly like the newest-status-wins rule everywhere else.
	const optVerdicts = new Map<string, Map<number, string>>();
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
		} else if (event.type === 'optimization_outcome' && typeof event.verdict === 'string') {
			const row = typeof event.row === 'number' ? event.row : -1;
			const rows = optVerdicts.get(id) ?? new Map<number, string>();
			rows.set(row, event.verdict);
			optVerdicts.set(id, rows);
		}
	}
	// Optimization episodes (kind 'general') end without an oracle verdict —
	// objective:false — because the measured verdict resolves asynchronously.
	// When it does, the bridge's optimization_outcome IS the objective oracle,
	// so the episode is re-labeled here: 'proven' → objective SUCCESS for the
	// episode's arm, 'regressed'/'reverted-behavior' → objective FAILURE,
	// 'inconclusive' → excluded (no re-label; the episode stays non-objective
	// and never trains the bandit). Across multiple optimized rows a failure
	// dominates (shipping one regression outweighs proving another row), while
	// within a row the latest verdict wins (retries supersede).
	for (const [id, rows] of optVerdicts) {
		const episode = byId.get(id);
		if (!episode) {
			continue;
		}
		const verdicts = [...rows.values()];
		const failed = verdicts.some((v) => v === 'regressed' || v === 'reverted-behavior');
		const proven = verdicts.some((v) => v === 'proven');
		if (!failed && !proven) {
			continue; // only inconclusive verdicts — not evidence either way
		}
		episode.verified = !failed;
		episode.objective = true;
		// Binary outcome reward, matching the posterior's Bernoulli model: the
		// measured verdict arrives without the episode's attempt budget, so no
		// attempt discount applies; a regression is a definitive loss (−1, the
		// same label a retraction earns), not a neutral non-verify.
		episode.reward = failed ? -1 : 1;
	}
	// Retractions apply LAST: a human counterexample that reproduced outranks
	// every automated verdict, including a measured optimization 'proven'.
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

/**
 * COMA-style COUNTERFACTUAL credit assignment per composition feature
 * (Foerster et al., "Counterfactual Multi-Agent Policy Gradients", AAAI 2018 —
 * adapted from actor-critic to this Beta-Bernoulli feature-subset bandit).
 *
 * COMA scores agent i by an advantage against a counterfactual baseline that
 * marginalizes ONLY agent i's action, holding the others fixed:
 *   A_i(s, u) = Q(s, u) − Σ_{u'_i} π(u'_i|s) Q(s, (u^{-i}, u'_i)).
 * Here the "agents" are the composition features and an arm A ⊆ F is the joint
 * action (the subset of features at their rich level). Each feature is binary,
 * so the counterfactual baseline for feature i at arm A ∋ i is simply the
 * posterior mean of the IDENTICAL arm with i toggled off:
 *
 *   advantage_i = Σ_{A ∋ i} w_A · (μ(A) − μ(A \ {i})),
 *   w_A ∝ n(A) + n(A \ {i})            (combined evidence of the pair),
 *
 * with μ(·) the Beta-posterior mean and n(·) the arm's OBSERVED objective
 * episode count. Pairs where EITHER side is unpulled carry no counterfactual evidence about i's
 * effect (both means are pure prior, their difference is exactly 0 by
 * construction) and are skipped so they cannot dilute the weights. Unlike
 * Shapley-over-means — which weights every coalition by combinatorics alone
 * and lets never-pulled arms' prior means vote — this weights each toggled
 * pair by how much evidence actually backs it.
 *
 * The result is shrunk toward 0 by the total paired evidence,
 *   shrunk_i = raw_i · N_i / (N_i + n0),  N_i = Σ non-skipped (n(A)+n(A\{i})),
 * with n0 the policy's shrinkage pseudo-count — a feature attested by two
 * episodes claims proportionally less credit than one attested by fifty.
 * Returns all-zero when no pair has evidence.
 */
export function counterfactualAttribution(
	posteriors: ArmPosterior[],
	counts: number[],
	n0: number,
): Record<EpisodeFeature, number> {
	const result = {} as Record<EpisodeFeature, number>;
	for (const feature of EPISODE_FEATURES) {
		let weighted = 0; // Σ w_A · (μ(A) − μ(A\{i})), w_A unnormalized
		let totalPaired = 0; // N_i = Σ (n(A) + n(A\{i})) over non-skipped pairs
		for (let a = 0; a < posteriors.length; a++) {
			const levels = armLevels(a);
			if (levels[feature] !== 1) {
				continue; // only arms CONTAINING i are scored against A\{i}
			}
			const counterfactual = { ...levels };
			counterfactual[feature] = 0;
			const base = levelsToIndex(counterfactual);
			const pairN = counts[a] + counts[base];
			// A pair carries counterfactual information only when BOTH sides were
			// actually pulled: comparing an observed mean against the untouched
			// Beta(1,1) prior (0.5) credits distance-from-prior, not the feature —
			// under Thompson concentration that half-empty case is the common one,
			// and it silently dominated sparse features' attribution.
			if (counts[a] <= 0 || counts[base] <= 0) {
				continue;
			}
			weighted += pairN * (posteriorMean(posteriors[a]) - posteriorMean(posteriors[base]));
			totalPaired += pairN;
		}
		result[feature] =
			totalPaired > 0 ? (weighted / totalPaired) * (totalPaired / (totalPaired + n0)) : 0;
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
	const armCounts = new Array<number>(armCount).fill(0);
	for (const e of objective) {
		if (e.armIndex >= 0 && e.armIndex < armCount) {
			armCounts[e.armIndex] += 1;
			if (e.verified) {
				posteriors[e.armIndex].alpha += 1;
			} else {
				posteriors[e.armIndex].beta += 1;
			}
		}
	}
	next.arm_posteriors = posteriors;

	// Greedy arm + COMA counterfactual attribution (evidence-weighted toggled
	// pairs over the posterior means; see counterfactualAttribution). Same
	// Record<feature, number> report shape the Shapley attribution produced.
	const means = posteriors.map(posteriorMean);
	next.attribution = counterfactualAttribution(posteriors, armCounts, current.shrinkage_n0);
	let best = 0;
	for (let a = 1; a < armCount; a++) {
		if (means[a] > means[best]) {
			best = a;
		}
	}
	// PROMOTION GATES. `min_promotion_n` and `promotion_delta` were declared,
	// defaulted and range-VALIDATED in episodeTelemetry.ts but never read here,
	// so this was a bare argmax over posterior means. With a 1/1 prior a single
	// verified episode moves one arm's mean to 0.667 while every other arm sits
	// at 0.5, so ONE objective success promoted an arm — observed live on this
	// machine: episodes_seen 17, exactly 1 objective observation in the
	// posteriors, preferred_arm 4.
	//
	// That matters because `preferred_arm` is not merely reported: qna/answer.ts
	// decodes bit 2 of it to pick Ask-Vinv's per-symbol snippet budget. (Episode
	// arm SELECTION is Thompson sampling + decaying epsilon, which handles n=1
	// correctly on its own — this gate is for the greedy readers.)
	//
	// Rule: keep the incumbent unless the challenger has at least
	// `min_promotion_n` objective observations AND beats the incumbent's
	// posterior mean by at least `promotion_delta`.
	const incumbent =
		current.preferred_arm >= 0 && current.preferred_arm < armCount ? current.preferred_arm : 0;
	const challengerN = armCounts[best] ?? 0;
	const beatsIncumbent = means[best] - means[incumbent] >= current.promotion_delta;
	next.preferred_arm =
		best === incumbent || (challengerN >= current.min_promotion_n && beatsIncumbent)
			? best
			: incumbent;

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

// ---- optimization calibration (predicted vs measured speedups) -------------

/** One resolved-or-not optimization verdict read back from the ledger. */
export interface OptimizationOutcome {
	episodeId: string;
	row: number;
	wasteKind: string;
	predictedMs: number;
	deltaMs: number;
	verdict: string;
	attempt: number;
}

/**
 * Reads every optimization_outcome event from the episode ledger (the same
 * event log episode_start/episode_end live in — appended by the
 * exercise/optimize verdict bridge when a measured verdict resolves).
 */
export function readOptimizationOutcomes(
	ledgerPath: string = episodeLedgerPath(),
): OptimizationOutcome[] {
	let content: string;
	try {
		content = fs.readFileSync(ledgerPath, 'utf8');
	} catch {
		return [];
	}
	const out: OptimizationOutcome[] = [];
	for (const line of content.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // torn tail line — skipped, never fatal
		}
		if (
			event.type === 'optimization_outcome' &&
			typeof event.episode_id === 'string' &&
			typeof event.waste_kind === 'string' &&
			typeof event.verdict === 'string' &&
			typeof event.predicted_ms === 'number' &&
			typeof event.delta_ms === 'number'
		) {
			out.push({
				episodeId: event.episode_id,
				row: typeof event.row === 'number' ? event.row : -1,
				wasteKind: event.waste_kind,
				predictedMs: event.predicted_ms,
				deltaMs: event.delta_ms,
				verdict: event.verdict,
				attempt: typeof event.attempt === 'number' ? event.attempt : 1,
			});
		}
	}
	return out;
}

/** Per-waste-kind calibration of predicted vs measured optimization impact. */
export interface OptimizationCalibration {
	updated_at: string;
	by_waste_kind: Record<string, { n: number; mean_ratio: number; shrunk_ratio: number }>;
}

/**
 * Prior strength of the calibration shrinkage — the contract-fixed pseudo-count
 * (C2: n0 = 3) pulling a sparse kind's ratio toward the global mean. A kind
 * with 1 sample sits near the global mean; one with many sits near its own.
 */
export const CALIBRATION_PRIOR_N0 = 3;

/**
 * Turns measured verdicts into the per-kind calibration table: for each
 * RESOLVED outcome ('proven'/'regressed' — the two verdicts with a clean
 * measured delta; 'inconclusive' has no measurement and 'reverted-behavior'
 * measured a behavior break, not a speedup), ratio = |measured delta_ms| /
 * predicted_ms. Per kind the mean ratio is shrunk toward the GLOBAL mean with
 * prior strength n0 (empirical-Bayes partial pooling):
 *   shrunk = (n·mean_kind + n0·mean_global) / (n + n0).
 * Outcomes with a non-positive prediction are skipped (no defined ratio).
 * Returns null when no resolved outcome exists — the artifact is only ever
 * written from evidence, never as an empty husk.
 */
export function computeOptimizationCalibration(
	outcomes: OptimizationOutcome[],
	n0: number = CALIBRATION_PRIOR_N0,
): OptimizationCalibration | null {
	const resolved = outcomes.filter(
		(o) =>
			(o.verdict === 'proven' || o.verdict === 'regressed') &&
			Number.isFinite(o.deltaMs) &&
			Number.isFinite(o.predictedMs) &&
			o.predictedMs > 0,
	);
	if (resolved.length === 0) {
		return null;
	}
	const ratios = resolved.map((o) => Math.abs(o.deltaMs) / o.predictedMs);
	const globalMean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
	const byKind = new Map<string, number[]>();
	for (let i = 0; i < resolved.length; i++) {
		const list = byKind.get(resolved[i].wasteKind) ?? [];
		list.push(ratios[i]);
		byKind.set(resolved[i].wasteKind, list);
	}
	const table: OptimizationCalibration['by_waste_kind'] = {};
	for (const [kind, rs] of byKind) {
		const n = rs.length;
		const mean = rs.reduce((a, b) => a + b, 0) / n;
		table[kind] = {
			n,
			mean_ratio: mean,
			shrunk_ratio: (n * mean + n0 * globalMean) / (n + n0),
		};
	}
	return { updated_at: new Date().toISOString(), by_waste_kind: table };
}

/** The calibration artifact's workspace path (.vinv/reports/optimization_calibration.json). */
export function calibrationFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'optimization_calibration.json');
}

/** Atomically persists the calibration artifact. */
export function writeOptimizationCalibration(
	workspaceRoot: string,
	calibration: OptimizationCalibration,
): void {
	const target = calibrationFilePath(workspaceRoot);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(calibration, null, '\t')}\n`);
	fs.renameSync(tmp, target);
}

/**
 * Reads the ledger, recomputes the policy, persists it, and logs the update.
 * Called after every episode_end; cheap (the ledger is line-scanned once).
 * When `workspaceRoot` is given, the optimization calibration artifact is
 * refreshed from the same ledger scan's verdicts (predicted-vs-measured
 * ratios per waste kind) — the policy update is the ONE place ledger evidence
 * becomes derived state, so the calibration rides the same trigger.
 */
export function maybeUpdateEpisodePolicy(workspaceRoot?: string): EpisodePolicy {
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
	if (workspaceRoot) {
		const calibration = computeOptimizationCalibration(readOptimizationOutcomes());
		if (calibration) {
			writeOptimizationCalibration(workspaceRoot, calibration);
		}
	}
	return next;
}
