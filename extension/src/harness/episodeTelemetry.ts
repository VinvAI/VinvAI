/**
 * Harness-episode learning: the same contextual-bandit pattern as retrieval
 * telemetry, applied to context-pack composition.
 *
 * The action space is a FACTORED grid over composition features (graph-slice
 * depth × runtime-evidence inclusion × snippet budget), so the ledger supports
 * exact Shapley attribution per feature — "did runtime evidence actually help"
 * is a computed number, not an opinion. Selection is THOMPSON SAMPLING over
 * per-arm Beta posteriors (see selectEpisodeArm), with a small ε-floor mixture
 * that keeps every arm's logged propensity non-zero so importance weights stay
 * bounded for off-policy evaluation. Propensities are logged exactly (the floor
 * mass plus the Monte-Carlo Thompson probability).
 *
 * What is LEARNED from the ledger by episodePolicyUpdater after each episode:
 * the per-arm Beta posteriors (hence the greedy arm and Shapley attribution)
 * and the attempt budget. What is NOT auto-learned (manually-tuned priors,
 * honestly): the walk parameters (WalkParams — α, β edge weights, etc.), the
 * ε-floor schedule, and the pack-size budgets. A stale or malformed policy is
 * rejected wholesale (and the rejection is logged), mirroring loadPolicyForEpoch.
 *
 * The episode ledger (~/.vinv/telemetry/episodes.jsonl) is consumed by
 * episodePolicyUpdater; it is NOT the schema the offline retrieval OPE
 * (Vinv/index/eval/off_policy.py, which reads retrieval.jsonl) expects.
 */
import * as fs from 'fs';
import * as path from 'path';
import { vinvHomeDir } from '../vinvHome';

/** One pack-composition arm. */
export interface EpisodeArm {
	/** Graph-slice expansion depth around the seed symbols. */
	slice_depth: number;
	/** Whether runtime evidence (trace facts) is included in the pack. */
	include_runtime: boolean;
}

/** The named composition features the factored arm grid ranges over. */
/**
 * The features the bandit actually explores.
 *
 * `snippet_chars` WAS a third feature and was removed: on this path it is consumed
 * in exactly one place — `contextPack` slicing `n.summary` — and summaries are far
 * shorter than either level, so both returned the identical string. Measured on a
 * 7577-symbol snapshot: longest summary 696 chars, median 76, p99 160, and ZERO
 * symbols exceeded even the lean 800 level. Bit 2 was inert, arms 0-3 were
 * byte-identical to arms 4-7, and Thompson sampling spent half its exploration
 * distinguishing arms that could not differ — while the learner was already
 * starved (1 objective outcome across 17 completed episodes).
 *
 * The bit was not merely wasted. `qna/answer.ts` decoded it for Ask Vinv's ANCHOR
 * SOURCE budget, where the same numbers DO bite (indexed source: median 436, p95
 * 3769, 30.3% of symbols over 800). So a value was learned in a domain where it
 * provably could not affect the outcome, then applied to one where it could. That
 * is not thin evidence; it is evidence with no causal path to the claim it was
 * used to justify. Ask Vinv now carries its own explicit `qna_snippet_chars`.
 *
 * Dropping it halves the arm space to 4, doubling the per-arm sample rate.
 */
export const EPISODE_FEATURES = ['slice_depth', 'include_runtime'] as const;
export type EpisodeFeature = (typeof EPISODE_FEATURES)[number];

/** Two levels per feature: level 0 is the lean baseline, level 1 the rich one. */
export interface ArmFeatureLevels {
	slice_depth: [number, number];
	include_runtime: [boolean, boolean];
}

const DEFAULT_FEATURE_LEVELS: ArmFeatureLevels = {
	slice_depth: [1, 2],
	include_runtime: [false, true],
};

function validFeatureLevels(raw: unknown): raw is ArmFeatureLevels {
	if (typeof raw !== 'object' || raw === null) {
		return false;
	}
	const r = raw as Record<string, unknown>;
	const depth = r.slice_depth;
	const runtime = r.include_runtime;
	return (
		Array.isArray(depth) &&
		depth.length === 2 &&
		depth.every((d) => Number.isInteger(d) && d >= 0 && d <= 4) &&
		Array.isArray(runtime) &&
		runtime.length === 2 &&
		runtime.every((b) => typeof b === 'boolean')
	);
}

/**
 * The factored arm grid: cartesian product of the feature levels, in a fixed
 * bit order (arm index i has feature f at level (i >> bit(f)) & 1). The fixed
 * order keeps arm indices stable across processes so the ledger joins.
 */
export function armGrid(levels: ArmFeatureLevels): EpisodeArm[] {
	const arms: EpisodeArm[] = [];
	// 1 << EPISODE_FEATURES.length — 4 arms since snippet_chars was removed.
	for (let i = 0; i < 1 << EPISODE_FEATURES.length; i++) {
		arms.push({
			slice_depth: levels.slice_depth[i & 1],
			include_runtime: levels.include_runtime[(i >> 1) & 1],
		});
	}
	return arms;
}

/** Level assignment (0/1 per feature) for an arm index — the Shapley coalition. */
export function armLevels(index: number): Record<EpisodeFeature, 0 | 1> {
	return {
		slice_depth: (index & 1) as 0 | 1,
		include_runtime: ((index >> 1) & 1) as 0 | 1,
	};
}

/** Arm index for a level assignment (inverse of armLevels). */
export function levelsToIndex(levels: Record<EpisodeFeature, 0 | 1>): number {
	return levels.slice_depth | (levels.include_runtime << 1);
}

/**
 * The discrete arm set from the active policy's feature levels. Env-tunable
 * via VINV_EPISODE_ARM_LEVELS (JSON ArmFeatureLevels); invalid input keeps the
 * policy's levels so exploration never stops.
 */
export function episodeArmSet(policy?: EpisodePolicy): EpisodeArm[] {
	const raw = process.env.VINV_EPISODE_ARM_LEVELS;
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (validFeatureLevels(parsed)) {
				return armGrid(parsed);
			}
		} catch {
			// Malformed env: fall through to the policy levels.
		}
	}
	return armGrid(policy?.arm_levels ?? DEFAULT_FEATURE_LEVELS);
}

/**
 * Learned episode policy (see module docs). All fields are priors until the
 * updater replaces them from ledger evidence; `episodes_seen` and
 * `attribution` record what the current values were computed from.
 */
export interface EpisodePolicy {
	version: 3;
	/** Exploration ceiling — effective epsilon decays below it with data. */
	epsilon0: number;
	/** Exploration floor — never stop exploring entirely. */
	epsilon_min: number;
	/** Decay scale: effective eps = clamp(c·|A|/sqrt(N), floor, ceiling). */
	epsilon_decay: number;
	/** Max dispatch attempts before escalating to the user (learned quantile). */
	attempt_budget: number;
	/** Quantile of attempts-to-success the budget must cover. */
	attempt_quantile: number;
	/** Hard ceiling for the learned attempt budget. */
	attempt_budget_max: number;
	/** Greedy arm = argmax posterior mean (reporting/back-compat; TS drives selection). */
	preferred_arm: number;
	/**
	 * Ask Vinv's per-anchor SOURCE budget, in characters.
	 *
	 * Explicit rather than decoded from a bandit arm. It previously came from
	 * `(preferred_arm >> 2) & 1`, i.e. a bit the bandit learned against context
	 * PACKS — where it sliced summaries and could not bite — and Ask Vinv then
	 * applied it to anchor SOURCE, where it does. See EPISODE_FEATURES.
	 *
	 * 4000 follows from what a prompt can hold, NOT from a percentile of one
	 * repo. Anchors are bounded and few (explicit seeds plus extra anchor rows),
	 * so the bound that transfers is capacity: ~8 anchors x 4000 = 32KB, which a
	 * prompt absorbs, where p99 (11,920 here) x 8 = ~95KB does not. The measured
	 * distribution corroborates the choice; it did not derive it. Do NOT 'update'
	 * this from a fresh percentile — that would make it a property of whichever
	 * repo was measured last.
	 *
	 * REQUIRED, not optional, and that is load-bearing. The consumer slices with
	 * it: `text.slice(0, Math.ceil(qna_snippet_chars * k))`. If the field were
	 * optional and ever absent, that arithmetic is NaN and `.slice(0, NaN)`
	 * returns the EMPTY STRING — the model would receive an empty code fence
	 * where the anchor's source belongs, with no error and nothing in the prompt
	 * saying so. A silently empty anchor is worse than a truncated one, because
	 * truncation now announces itself and this would not. Keep it required, and
	 * keep `validPolicy` range-checking it so a malformed file resets to priors
	 * rather than propagating a non-number.
	 */
	qna_snippet_chars: number;
	/**
	 * Per-arm Beta posteriors over the verified-fix probability, re-estimated
	 * from the objective-outcome ledger each episode. Absent on a cold/legacy
	 * policy → the flat TS prior applies. This is what makes selection LEARN.
	 */
	arm_posteriors?: ArmPosterior[];
	/** Beta prior (successes) for an unseen arm — 1 = uniform on [0,1]. */
	ts_prior_alpha: number;
	/** Beta prior (failures) for an unseen arm — 1 = uniform on [0,1]. */
	ts_prior_beta: number;
	/** Feature levels the arm grid ranges over. */
	arm_levels: ArmFeatureLevels;
	/** Graph-slice node budget for pack composition. */
	slice_budget: number;
	/** Max seed symbols derived from issue text. */
	seed_cap: number;
	/** Chars of prior-failure evidence carried into the next pack. */
	failure_evidence_chars: number;
	/** Evidence similarity (Jaccard) above which two failures count as a stall. */
	stall_similarity: number;
	/** Judge cheat-likelihood at/above which a flagged pass is failed. A
	 * learnable prior like stall_similarity — the guardrail that decides
	 * pass/fail is not a bare module constant. */
	judge_cheat_threshold: number;
	/** Min episodes on a challenger arm before it can be promoted. */
	min_promotion_n: number;
	/** Confidence parameter for the Bernstein promotion bound. */
	promotion_delta: number;
	/** Shrinkage pseudo-count toward the global mean for sparse arms. */
	shrinkage_n0: number;
	/** Episodes the updater had seen when it wrote this policy. */
	episodes_seen: number;
	/** Exact Shapley value per composition feature (attribution report). */
	attribution?: Record<EpisodeFeature, number>;
	/** When the updater last wrote this file. */
	updated_at?: string;
	/**
	 * Context-walk parameters (typed-edge personalized PageRank). Optional so
	 * policies written before the walk existed stay valid; absent means the
	 * WALK_PRIORS apply. These are hand-tuned PRIORS at literature defaults —
	 * they are validated and versioned like the rest of the policy, but (unlike
	 * the arm posteriors and attempt budget) the updater does NOT yet
	 * re-estimate them from outcomes.
	 */
	walk?: WalkParams;
	/**
	 * Replay-verification parameters (adaptive oracle budget). Optional like
	 * `walk`; absent means REPLAY_PRIORS. The per-service learned component
	 * lives in .vinv/replay-stats, not here.
	 */
	replay?: ReplayParams;
}

/**
 * Parameters of the typed-edge personalized-PageRank context walk — the math
 * QnA and pack composition use to select evidence:
 *
 *   π = α·s + (1−α)·π·( Σ_t β_t·W̃_t )
 *
 * s is the anchor (reset) distribution, W̃_t the row-normalized adjacency of
 * edge type t. Values are hand-tuned priors at literature defaults (α = PageRank
 * damping, k₀ = Cormack et al. 2009 RRF); β starts FLAT so no edge type is
 * hand-privileged. NOTE: these are not currently outcome-learned (the episode
 * updater re-estimates the arm posteriors and attempt budget, not the walk).
 */
export interface WalkParams {
	/** Teleport (restart) probability α of the random walk. */
	alpha: number;
	/** Convergence tolerance; iterations = ceil(ln(tol)/ln(1−α)). */
	tol: number;
	/** RRF constant k₀ — the anchor weight of retrieval hit r is 1/(k₀+r). */
	rrf_k0: number;
	/** Edge-type mixture weights β_t. Flat hand-tuned priors (not yet outcome-learned). */
	beta: { invoke: number; inherit: number; contains: number; flow: number };
	/** Failure exemplars rendered per symbol in QnA/pack evidence. */
	failure_exemplars: number;
	/** Anchors resolved per missing item during a QnA retrial. */
	retry_anchors_per_item: number;
	/** Slice-budget growth factor applied on each QnA retrial. */
	retry_budget_growth: number;
	/** Max QnA retrials after an insufficient-evidence verdict. */
	max_retrials: number;
	/**
	 * Max missing items a retrial fans out to `index query` (each is a
	 * subprocess + embedding call). Bounds the verified unbounded-subprocess
	 * hazard: a model naming 20 missing items must not spawn 20 binaries.
	 * The cheap word-aligned name join still runs for EVERY item. Optional in
	 * stored policies (pre-cap files stay valid); absent means the prior.
	 */
	retry_missing_cap?: number;
}

export const WALK_PRIORS: WalkParams = {
	alpha: 0.15,
	tol: 1e-4,
	rrf_k0: 60,
	beta: { invoke: 1, inherit: 1, contains: 1, flow: 1 },
	failure_exemplars: 3,
	retry_anchors_per_item: 3,
	retry_budget_growth: 2,
	max_retrials: 2,
	retry_missing_cap: 3,
};

/**
 * Replay-verification parameters — the adaptive-budget half of the oracle
 * (see replayStats.ts for the design and its systemd/Kubernetes lineage).
 * Priors, like the walk block: validated, versioned, optional in stored
 * policies (schema growth never invalidates episode-policy.json), and not yet
 * re-estimated by the updater. The learned component is per-service (the
 * recorded boot durations in .vinv/replay-stats), not global, so it does not
 * belong in this file's posteriors.
 */
export interface ReplayParams {
	/** Soft-budget floor, seconds. The prior equals the old fixed budget so
	 * behavior is never worse than before learning kicks in. */
	floor_s: number;
	/** Hard ceiling, seconds — the absolute longest a replay may wait. */
	ceiling_s: number;
	/** Safety multiplier over the observed boot-time quantile. */
	multiplier: number;
	/** Quantile of recorded boot durations the soft budget must cover. */
	quantile: number;
	/** Output silence (seconds) past the soft budget that means "hung". */
	activity_window_s: number;
	/** Survival (seconds) a portless service must show for a heuristic pass. */
	portless_grace_s: number;
}

export const REPLAY_PRIORS: ReplayParams = {
	floor_s: 240,
	ceiling_s: 1800,
	multiplier: 3,
	quantile: 0.95,
	activity_window_s: 45,
	portless_grace_s: 12,
};

/** The policy's replay parameters, with priors filling a pre-replay policy. */
export function replayParams(policy: EpisodePolicy): ReplayParams {
	return { ...REPLAY_PRIORS, ...(policy.replay ?? {}) };
}

/** The policy's walk parameters, with the priors filling a pre-walk policy. */
export function walkParams(policy: EpisodePolicy): WalkParams {
	const w = policy.walk ?? { ...WALK_PRIORS, beta: { ...WALK_PRIORS.beta } };
	// Fields added after a policy file was written fall back to their priors —
	// stored policies are never invalidated by schema growth.
	return { retry_missing_cap: WALK_PRIORS.retry_missing_cap, ...w };
}

/**
 * Priors, explicitly: the values the system starts from before any ledger
 * evidence exists. Every one of them is replaced by episodePolicyUpdater as
 * episodes accrue — none is a frozen constant.
 */
export const POLICY_PRIORS: EpisodePolicy = {
	version: 3,
	epsilon0: 0.25,
	epsilon_min: 0.02,
	epsilon_decay: 0.5,
	attempt_budget: 3,
	attempt_quantile: 0.9,
	attempt_budget_max: 6,
	preferred_arm: 3, // depth 2 + runtime evidence (the richest of the 4 arms)
	qna_snippet_chars: 4000,
	ts_prior_alpha: 1, // uniform Beta(1,1) prior — no arm privileged before data
	ts_prior_beta: 1,
	arm_levels: DEFAULT_FEATURE_LEVELS,
	slice_budget: 24,
	seed_cap: 8,
	failure_evidence_chars: 3000,
	stall_similarity: 0.8,
	judge_cheat_threshold: 0.7,
	min_promotion_n: 5,
	promotion_delta: 0.1,
	shrinkage_n0: 2,
	episodes_seen: 0,
};

export function policyFilePath(): string {
	return path.join(vinvHomeDir(), 'episode-policy.json');
}

function validPolicy(raw: Partial<EpisodePolicy>): raw is EpisodePolicy {
	const numberIn = (v: unknown, lo: number, hi: number): boolean =>
		typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
	const intIn = (v: unknown, lo: number, hi: number): boolean =>
		Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
	return (
		raw.version === 3 &&
		numberIn(raw.epsilon0, 0, 0.5) &&
		numberIn(raw.epsilon_min, 0, 0.5) &&
		(raw.epsilon_min as number) <= (raw.epsilon0 as number) &&
		numberIn(raw.epsilon_decay, 0, 10) &&
		intIn(raw.attempt_budget, 1, 10) &&
		numberIn(raw.attempt_quantile, 0.5, 1) &&
		intIn(raw.attempt_budget_max, 1, 10) &&
		validFeatureLevels(raw.arm_levels) &&
		// 0..3: the arm space is 1 << EPISODE_FEATURES.length, now 4 not 8.
		intIn(raw.preferred_arm, 0, (1 << EPISODE_FEATURES.length) - 1) &&
		intIn(raw.qna_snippet_chars, 200, 40_000) &&
		intIn(raw.slice_budget, 4, 200) &&
		intIn(raw.seed_cap, 1, 50) &&
		intIn(raw.failure_evidence_chars, 200, 50_000) &&
		numberIn(raw.stall_similarity, 0.5, 1) &&
		// Optional (added after stored policies existed): absent → prior applies.
		(raw.judge_cheat_threshold === undefined ||
			numberIn(raw.judge_cheat_threshold, 0.1, 1)) &&
		intIn(raw.min_promotion_n, 1, 1000) &&
		numberIn(raw.promotion_delta, 0.001, 0.5) &&
		numberIn(raw.shrinkage_n0, 0, 100) &&
		intIn(raw.episodes_seen, 0, Number.MAX_SAFE_INTEGER) &&
		numberIn(raw.ts_prior_alpha, 0.01, 100) &&
		numberIn(raw.ts_prior_beta, 0.01, 100) &&
		(raw.arm_posteriors === undefined || validPosteriors(raw.arm_posteriors)) &&
		(raw.walk === undefined || validWalk(raw.walk)) &&
		(raw.replay === undefined || validReplay(raw.replay))
	);
}

function validReplay(raw: unknown): raw is ReplayParams {
	if (typeof raw !== 'object' || raw === null) {
		return false;
	}
	const r = raw as Partial<ReplayParams>;
	const numberIn = (v: unknown, lo: number, hi: number): boolean =>
		typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
	return (
		numberIn(r.floor_s, 5, 3600) &&
		numberIn(r.ceiling_s, 30, 21_600) &&
		(r.floor_s as number) <= (r.ceiling_s as number) &&
		numberIn(r.multiplier, 1, 20) &&
		numberIn(r.quantile, 0.5, 1) &&
		numberIn(r.activity_window_s, 5, 600) &&
		numberIn(r.portless_grace_s, 1, 600)
	);
}

function validPosteriors(raw: unknown): raw is ArmPosterior[] {
	return (
		Array.isArray(raw) &&
		raw.every(
			(p) =>
				typeof p === 'object' &&
				p !== null &&
				typeof (p as ArmPosterior).alpha === 'number' &&
				typeof (p as ArmPosterior).beta === 'number' &&
				Number.isFinite((p as ArmPosterior).alpha) &&
				Number.isFinite((p as ArmPosterior).beta) &&
				(p as ArmPosterior).alpha > 0 &&
				(p as ArmPosterior).beta > 0,
		)
	);
}

function validWalk(raw: unknown): raw is WalkParams {
	if (typeof raw !== 'object' || raw === null) {
		return false;
	}
	const w = raw as Partial<WalkParams>;
	const numberIn = (v: unknown, lo: number, hi: number): boolean =>
		typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
	const intIn = (v: unknown, lo: number, hi: number): boolean =>
		Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
	const beta = w.beta as Record<string, unknown> | undefined;
	return (
		numberIn(w.alpha, 0.01, 0.9) &&
		numberIn(w.tol, 1e-8, 0.1) &&
		numberIn(w.rrf_k0, 1, 1000) &&
		beta !== undefined &&
		['invoke', 'inherit', 'contains', 'flow'].every((t) => numberIn(beta[t], 0, 100)) &&
		// The mixture must have SOME kernel: an all-zero beta would leave the
		// walk with nothing to follow (contextWalk guards it, but a learned
		// policy proposing it is invalid by construction).
		['invoke', 'inherit', 'contains', 'flow'].reduce((acc, t) => acc + (beta[t] as number), 0) > 0 &&
		intIn(w.failure_exemplars, 1, 20) &&
		intIn(w.retry_anchors_per_item, 1, 20) &&
		numberIn(w.retry_budget_growth, 1, 10) &&
		intIn(w.max_retrials, 0, 5) &&
		// Optional (added later than the walk block): absent = prior applies.
		(w.retry_missing_cap === undefined || intIn(w.retry_missing_cap, 1, 20))
	);
}

/**
 * Loads the learned episode policy, falling back to the priors. Malformed or
 * out-of-range values are rejected wholesale (and the rejection is logged) —
 * a partially-honored policy would corrupt the logged propensities.
 */
export function loadEpisodePolicy(): EpisodePolicy {
	let raw: Partial<EpisodePolicy>;
	try {
		raw = JSON.parse(fs.readFileSync(policyFilePath(), 'utf8')) as Partial<EpisodePolicy>;
	} catch {
		return { ...POLICY_PRIORS };
	}
	if (!validPolicy(raw)) {
		// Say WHY, and say what was discarded. The ledger previously carried 38
		// bare {type, ts} invalidations against 17 completed episodes — enough to
		// make "was that one clean migration or something invalidating
		// repeatedly?" unanswerable. A reset is a state change and must announce
		// itself like any other.
		// Read through `unknown`: `raw` is typed Partial<EpisodePolicy>, so TS narrows
		// `version` to the CURRENT literal and would rule out the comparison below —
		// but the whole point is that the FILE may hold an older number.
		const rawVersion = (raw as { version?: unknown }).version;
		const storedVersion = typeof rawVersion === 'number' ? rawVersion : null;
		const discardedArms = Array.isArray(raw.arm_posteriors)
			? raw.arm_posteriors.length
			: 0;
		// A KNOWN version step is a migration, not corruption. v2 -> v3 dropped
		// `snippet_chars` from the arm grid (see EPISODE_FEATURES), which halves
		// the arm space, so a v2 file's 8 posteriors cannot be reindexed onto 4
		// arms — arm 4, the one v2 had promoted, ceases to exist. Discarding them
		// is correct AND cheap here (the ledger holds one objective observation),
		// but it must be a declared reset rather than a silent fallback.
		const migration = storedVersion === POLICY_PRIORS.version - 1;
		appendEpisodeEvent({
			type: 'policy_invalidated',
			ts: new Date().toISOString(),
			from_version: storedVersion,
			to_version: POLICY_PRIORS.version,
			reason: migration
				? 'grid change v2->v3: snippet_chars removed from the arm space (it was '
					+ 'inert on the pack path), so arm indices are not comparable and the '
					+ 'stored posteriors were discarded'
				: 'stored policy failed validation and was replaced with priors',
			declared_migration: migration,
			discarded_arm_count: discardedArms,
			arm_count: 1 << EPISODE_FEATURES.length,
		});
		return { ...POLICY_PRIORS };
	}
	return raw;
}

/** Atomically persists a policy (updater output). */
export function saveEpisodePolicy(policy: EpisodePolicy): void {
	const target = policyFilePath();
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(policy, null, '\t')}\n`, { mode: 0o600 });
	fs.renameSync(tmp, target);
}

/**
 * The residual exploration FLOOR served under Thompson sampling: a small
 * uniform-random mixture that guarantees every arm keeps non-zero propensity
 * (bounded importance weights for off-policy evaluation) even once the
 * posterior is confident. Thompson sampling supplies the ADAPTIVE exploration
 * on top of this; the floor is only the OPE support guarantee. Decays as
 * evidence accrues but never below epsilon_min.
 */
export function effectiveEpsilon(policy: EpisodePolicy, armCount: number): number {
	const n = Math.max(1, policy.episodes_seen);
	const decayed = (policy.epsilon_decay * armCount) / Math.sqrt(n);
	return Math.min(policy.epsilon0, Math.max(policy.epsilon_min, decayed));
}

/** Observations a posterior has accrued beyond the policy's flat prior. */
function armObservations(p: ArmPosterior, policy: EpisodePolicy): number {
	return Math.max(0, p.alpha + p.beta - policy.ts_prior_alpha - policy.ts_prior_beta);
}

/**
 * Fraction of composition features whose posterior evidence is still SPARSE —
 * the local-maxima/dip guard's trigger. A feature is sparse when either of its
 * two levels has fewer than K effective observations (summed over the arms at
 * that level), where K = max(1, total_observations / |arms|) — i.e. the mean
 * per-arm pull count, derived from the trace itself, never a hardcoded count.
 * While a feature level is under-observed its effect on the verified-fix rate
 * is unresolved, so exploration must not anneal away: a few early failures on
 * one level (a posterior "dip") would otherwise let Thompson sampling starve
 * exactly the arms that could disprove the dip.
 */
export function sparseFeatureFraction(
	policy: EpisodePolicy,
	posteriors: ArmPosterior[],
): number {
	const obs = posteriors.map((p) => armObservations(p, policy));
	const total = obs.reduce((a, b) => a + b, 0);
	const k = Math.max(1, total / Math.max(1, posteriors.length));
	let sparse = 0;
	for (const feature of EPISODE_FEATURES) {
		let n0 = 0;
		let n1 = 0;
		for (let a = 0; a < posteriors.length; a++) {
			if (armLevels(a)[feature] === 1) {
				n1 += obs[a];
			} else {
				n0 += obs[a];
			}
		}
		if (Math.min(n0, n1) < k) {
			sparse += 1;
		}
	}
	return sparse / EPISODE_FEATURES.length;
}

/**
 * The exploration floor actually served: the evidence-decayed ε (OPE support)
 * raised by a PRINCIPLED optimism bonus while any feature's evidence is sparse
 * (see sparseFeatureFraction). The bonus is ε₀ scaled by the sparse-feature
 * fraction — proportional to how much of the composition space is still
 * unresolved, ceiling-clamped at ε₀ — so a feature with thin evidence keeps a
 * selection probability bounded away from zero (≥ floor/|arms| via the uniform
 * mixture) no matter how confident the rest of the posterior is, and the bonus
 * vanishes entirely once every feature level has ≥K observations.
 */
export function explorationFloor(policy: EpisodePolicy, posteriors: ArmPosterior[]): number {
	const decayed = effectiveEpsilon(policy, posteriors.length);
	const optimism = policy.epsilon0 * sparseFeatureFraction(policy, posteriors);
	return Math.min(policy.epsilon0, Math.max(decayed, optimism));
}

// ---- Thompson sampling over the arm grid (Beta-Bernoulli) -----------------
// Why Thompson, not ε-greedy + a UCB/Bernstein promotion gate: episode pulls
// are EXPENSIVE (one full coding-agent dispatch each) and the reward is
// binary/low-variance, so sample efficiency dominates. Thompson sampling
// (Chapelle & Li, NeurIPS 2011) adapts from the first few pulls, self-anneals
// exploration as the posterior sharpens (no hand-tuned ε schedule), and — being
// randomized — its play distribution is a valid logging policy for OPE. The old
// empirical-Bernstein promotion required ~50-80 samples on ONE arm before it
// could ever displace the hand-coded prior, so the policy never actually moved.

/** Beta posterior over one arm's verified-fix probability. */
export interface ArmPosterior {
	alpha: number;
	beta: number;
}

/** Standard normal via Box–Muller, drawing two uniforms from `rng`. */
function sampleNormal(rng: () => number): number {
	const u1 = Math.max(rng(), 1e-12);
	const u2 = rng();
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gamma(shape, 1) via Marsaglia–Tsang; boosted for shape < 1. Deterministic in `rng`. */
export function sampleGamma(shape: number, rng: () => number): number {
	if (shape < 1) {
		// Gamma(a) = Gamma(a+1) · U^(1/a) (Ahrens–Dieter boosting).
		return sampleGamma(shape + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / shape);
	}
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	// Bounded iterations: acceptance prob is high (>0.95); the cap only guards
	// against a pathological rng and never triggers in practice.
	for (let i = 0; i < 1000; i++) {
		let x = 0;
		let v = 0;
		// Bounded inner retry too (a pathological rng that always yields a very
		// negative normal could otherwise spin); the mean fallback below is a
		// safe last resort that never triggers with a sane rng.
		for (let j = 0; j < 1000; j++) {
			x = sampleNormal(rng);
			v = 1 + c * x;
			if (v > 0) {
				break;
			}
		}
		if (v <= 0) {
			return d;
		}
		v = v * v * v;
		const u = rng();
		if (u < 1 - 0.0331 * x * x * x * x) {
			return d * v;
		}
		if (Math.log(Math.max(u, 1e-12)) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
			return d * v;
		}
	}
	return d; // fallback (mean) — unreachable with a sane rng
}

/** One draw from Beta(alpha, beta) = Ga(alpha)/(Ga(alpha)+Ga(beta)). */
export function sampleBeta(alpha: number, beta: number, rng: () => number): number {
	const ga = sampleGamma(alpha, rng);
	const gb = sampleGamma(beta, rng);
	const s = ga + gb;
	return s > 0 ? ga / s : 0.5;
}

/** Thompson draw: sample every arm's posterior, return the argmax index (ties → lowest). */
export function thompsonDraw(posteriors: ArmPosterior[], rng: () => number): number {
	let best = 0;
	let bestTheta = -1;
	for (let a = 0; a < posteriors.length; a++) {
		const theta = sampleBeta(posteriors[a].alpha, posteriors[a].beta, rng);
		if (theta > bestTheta) {
			bestTheta = theta;
			best = a;
		}
	}
	return best;
}

/** Monte-Carlo P(arm a is the Thompson argmax) for every arm — the TS propensities. */
export function thompsonPropensities(
	posteriors: ArmPosterior[],
	samples: number,
	rng: () => number,
): number[] {
	const wins = new Array<number>(posteriors.length).fill(0);
	for (let s = 0; s < samples; s++) {
		wins[thompsonDraw(posteriors, rng)] += 1;
	}
	return wins.map((w) => w / samples);
}

/** Posterior mean (expected verified-fix rate) of an arm. */
export function posteriorMean(p: ArmPosterior): number {
	return p.alpha / (p.alpha + p.beta);
}

/** The policy's per-arm posteriors, filling the flat TS prior for a cold/legacy policy. */
export function armPosteriors(policy: EpisodePolicy, armCount: number): ArmPosterior[] {
	const flat = (): ArmPosterior => ({ alpha: policy.ts_prior_alpha, beta: policy.ts_prior_beta });
	if (!policy.arm_posteriors || policy.arm_posteriors.length !== armCount) {
		return Array.from({ length: armCount }, flat);
	}
	return policy.arm_posteriors.map((p) =>
		p && Number.isFinite(p.alpha) && Number.isFinite(p.beta) && p.alpha > 0 && p.beta > 0
			? p
			: flat(),
	);
}

/** MC sample budget for the logged TS propensities (bias/variance vs cost). */
const TS_PROPENSITY_SAMPLES = 800;

export interface ArmDecision {
	armIndex: number;
	arm: EpisodeArm;
	propensity: number;
	epsilon: number;
	explored: boolean;
}

/**
 * Thompson-sampling arm selection with an ε-floor mixture for OPE support.
 * With probability `floor` an arm is drawn uniformly (guaranteeing every arm
 * non-zero propensity so importance weights stay bounded); otherwise the arm
 * is the Thompson argmax over the Beta posteriors. The logged propensity is
 * the exact mixture P(play a) = floor/|A| + (1-floor)·P_TS(a), with P_TS
 * estimated by Monte-Carlo — valid for IPS/SNIPS/DR. `explored` = the play
 * differs from the current greedy (highest posterior mean) arm.
 */
export function selectEpisodeArm(policy: EpisodePolicy, rng: () => number = Math.random): ArmDecision {
	const arms = episodeArmSet(policy);
	const posteriors = armPosteriors(policy, arms.length);
	// The floor is the decayed ε raised by the sparse-feature optimism bonus
	// (dip guard) — see explorationFloor. Uniform over ALL arms so the OPE
	// support guarantee is untouched; sparse-feature arms simply keep more of it.
	const floor = explorationFloor(policy, posteriors);
	// Greedy arm = highest posterior mean (for the explored flag / reporting).
	let greedy = 0;
	for (let a = 1; a < arms.length; a++) {
		if (posteriorMean(posteriors[a]) > posteriorMean(posteriors[greedy])) {
			greedy = a;
		}
	}
	// Exact mixture propensities: floor-uniform + (1-floor)·TS.
	const tsP = thompsonPropensities(posteriors, TS_PROPENSITY_SAMPLES, rng);
	const chosen = rng() < floor ? Math.min(Math.floor(rng() * arms.length), arms.length - 1) : thompsonDraw(posteriors, rng);
	const propensity = floor / arms.length + (1 - floor) * tsP[chosen];
	return {
		armIndex: chosen,
		arm: arms[chosen],
		propensity,
		epsilon: floor,
		explored: chosen !== greedy,
	};
}

export interface EpisodeEvent {
	// 'optimization_outcome' is appended by the exercise/optimize verdict
	// bridge when a measured optimization verdict resolves (possibly long
	// after episode_end): {"type":"optimization_outcome","at":unix-seconds,
	// "episode_id","row","waste_kind","predicted_ms","delta_ms",
	// "verdict":"proven"|"inconclusive"|"regressed"|"reverted-behavior",
	// "attempt"}. The policy updater re-labels the episode from it (a measured
	// verdict IS an objective oracle) and calibrates predicted-vs-measured
	// speedups from it. It carries `at` (unix seconds) rather than `ts`.
	type: 'episode_start' | 'attempt' | 'acceptance' | 'candidate_defect' | 'mutation_smoke' | 'stall' | 'dispute' | 'revert' | 'infra_blocked' | 'episode_end' | 'reconciliation' | 'policy_invalidated' | 'policy_updated' | 'optimization_outcome';
	ts: string;
	episode_id?: string;
	[key: string]: unknown;
}

/** The durable episode ledger path (owner-only file). */
export function episodeLedgerPath(): string {
	return path.join(vinvHomeDir(), 'telemetry', 'episodes.jsonl');
}

/** Appends one event to the durable episode ledger. */
export function appendEpisodeEvent(event: EpisodeEvent): void {
	const target = episodeLedgerPath();
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const descriptor = fs.openSync(target, 'a', 0o600);
	try {
		fs.writeSync(descriptor, `${JSON.stringify(event)}\n`);
	} finally {
		fs.closeSync(descriptor);
	}
	try {
		fs.chmodSync(target, 0o600);
	} catch {
		// chmod is not meaningful on every platform.
	}
}

/**
 * Episode reward: verified success discounted by extra attempts (a fix on the
 * first dispatch is worth more than one that needed the whole budget); a
 * user-aborted episode is a definitive loss; an unverified/escalated end
 * without an abort is neutral (0) rather than assumed bad — missing outcome
 * is MNAR, same treatment as the retrieval ledger.
 */
export function episodeReward(
	verified: boolean,
	attempts: number,
	budget: number,
	aborted: boolean,
): number {
	if (aborted) {
		return -1;
	}
	if (!verified) {
		return 0;
	}
	const denominator = Math.max(1, budget);
	return Math.max(0, 1 - (attempts - 1) / denominator);
}
