/**
 * Live off-policy evaluation — the automatic half of retrieval-policy
 * promotion. Mirrors Vinv/index/eval/off_policy.py byte-for-math (pooled
 * epochs, cross-fitted DM/IPS/SNIPS/DR, BCa bootstrap LCB, small-n support
 * gates, per-epoch consistency guard); the Python evaluator remains the
 * offline/manual source of truth, this module is what makes promotion
 * actually HAPPEN in real usage: nothing ever ran the evaluator before, so
 * the learning loop was logging forever and promoting never.
 *
 * Gate design (two-stage, see the Python module docstring for citations):
 * the offline gate here is a do-no-harm + plausible-win filter at small n —
 * ESS >= 25 (bootstrap-validity/CLT boundary; self-limits promotion to
 * effects >= ~0.15), >= 40 joined samples, >= 8 pulls per compared action,
 * BCa 95% LCB >= 0 on the DR delta, no epoch contradicting the pooled delta,
 * and support refused outright when the logging policy was deterministic (see
 * the degeneracy guard in estimate) — and the 5% canary with 3-loss
 * auto-rollback (already live in indexServer) is the actual test.
 *
 * Runs opportunistically after feedback accrues (every EVAL_EVERY rewarded
 * events), asynchronously, and never on the query path.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { vinvHomeDir } from '../vinvHome';
import { appendRetrievalEvent } from './retrievalTelemetry';

export interface OpeSample {
	decision_id: string;
	action: number;
	propensity: number;
	reward: number;
	epoch: string;
}

// Gate constants — kept numerically identical to off_policy.py.
export const MIN_ESS = 25;
export const MIN_SAMPLES = 40;
export const MIN_ACTION_PULLS = 8;
export const EPOCH_CONSISTENCY_MIN_N = 20;
export const EPOCH_CONSISTENCY_TOLERANCE = 0.1;
/** Evaluate after this many new rewarded feedback events. */
export const EVAL_EVERY = 25;
const BOOTSTRAP_ITERATIONS = 1000;
const JACKKNIFE_CAP = 200;

/** Joins pooled decision/feedback events from ledger lines. Explicit rewards
 * win over auxiliary for the same decision (same rule as the Python loader
 * with --reward-source any). Fallback decisions are excluded. */
export function loadPooledSamples(ledgerText: string): OpeSample[] {
	const decisions = new Map<string, { action: number; propensity: number; epoch: string; fallback: boolean }>();
	const explicit = new Map<string, number>();
	const auxiliary = new Map<string, number>();
	for (const line of ledgerText.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const id = typeof event.decision_id === 'string' ? event.decision_id : undefined;
		if (!id) {
			continue;
		}
		if (event.type === 'decision') {
			const action = (event.action as { top_k?: unknown } | undefined)?.top_k;
			const propensity = event.propensity;
			if (
				typeof action === 'number' &&
				Number.isInteger(action) &&
				typeof propensity === 'number' &&
				propensity > 0 &&
				propensity <= 1
			) {
				decisions.set(id, {
					action,
					propensity,
					epoch: typeof event.epoch === 'string' ? event.epoch : '',
					fallback: event.fallback === true,
				});
			}
		} else if (event.type === 'feedback') {
			const reward = event.reward;
			if (typeof reward === 'number' && Number.isFinite(reward)) {
				if ((event.source ?? 'explicit') === 'explicit') {
					explicit.set(id, reward);
				} else {
					auxiliary.set(id, reward);
				}
			}
		}
	}
	const samples: OpeSample[] = [];
	for (const [id, d] of decisions) {
		if (d.fallback) {
			continue;
		}
		const reward = explicit.has(id) ? explicit.get(id) : auxiliary.get(id);
		if (reward === undefined) {
			continue;
		}
		samples.push({ decision_id: id, action: d.action, propensity: d.propensity, reward, epoch: d.epoch });
	}
	return samples;
}

/** Two-fold assignment stratified by action (sha256-ordered, alternating) —
 * identical to off_policy._stratified_folds. Hashes are precomputed once. */
function stratifiedFolds(samples: OpeSample[]): Map<string, 0 | 1> {
	const byAction = new Map<number, string[]>();
	for (const s of samples) {
		const list = byAction.get(s.action) ?? [];
		list.push(s.decision_id);
		byAction.set(s.action, list);
	}
	const folds = new Map<string, 0 | 1>();
	for (const ids of byAction.values()) {
		const hashed = ids
			.map((id) => ({ id, h: crypto.createHash('sha256').update(id).digest('hex') }))
			.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
		hashed.forEach((entry, position) => folds.set(entry.id, (position & 1) as 0 | 1));
	}
	return folds;
}

interface FoldModel {
	byAction: Map<number, number>;
	global: number;
}

function rewardPredictions(samples: OpeSample[], folds: Map<string, 0 | 1>): FoldModel[] {
	const models: FoldModel[] = [];
	for (const heldOut of [0, 1] as const) {
		const training = samples.filter((s) => folds.get(s.decision_id) !== heldOut);
		const global = training.length
			? training.reduce((a, s) => a + s.reward, 0) / training.length
			: 0;
		const sums = new Map<number, { sum: number; n: number }>();
		for (const s of training) {
			const cell = sums.get(s.action) ?? { sum: 0, n: 0 };
			cell.sum += s.reward;
			cell.n += 1;
			sums.set(s.action, cell);
		}
		const byAction = new Map<number, number>();
		for (const [action, cell] of sums) {
			byAction.set(action, cell.sum / cell.n);
		}
		models.push({ byAction, global });
	}
	return samples.map((s) => models[folds.get(s.decision_id) ?? 0]);
}

export interface OpeEstimate {
	count: number;
	matchedCount: number;
	directMethod: number;
	ips: number;
	snips: number | null;
	doublyRobust: number;
	effectiveSampleSize: number;
	clippedFraction: number;
	supportOk: boolean;
	/** Why support was refused outright, or null. Set by the degeneracy guard
	 * in estimate(); reported in the ope_evaluation ledger event so a refusal
	 * is never a silently missing promotion. */
	supportRefusal: string | null;
}

/** Cross-fitted DM/IPS/SNIPS/DR — mirror of off_policy.estimate with the
 * propensity-aligned no-clip default. Throws on empty samples. */
export function estimate(samples: OpeSample[], targetTopK: number): OpeEstimate {
	if (samples.length === 0) {
		throw new Error('no joined decision/feedback samples');
	}
	const matchedInverse = samples
		.filter((s) => s.action === targetTopK)
		.map((s) => 1 / s.propensity);
	const effectiveClip = matchedInverse.length ? Math.max(...matchedInverse) : 1;
	const folds = stratifiedFolds(samples);
	const predictions = rewardPredictions(samples, folds);
	const weights: number[] = [];
	let ipsSum = 0;
	let drSum = 0;
	let clipped = 0;
	let directSum = 0;
	samples.forEach((s, i) => {
		const model = predictions[i];
		const targetProbability = s.action === targetTopK ? 1 : 0;
		const rawWeight = targetProbability / s.propensity;
		const weight = Math.min(effectiveClip, rawWeight);
		if (rawWeight > effectiveClip) {
			clipped += 1;
		}
		weights.push(weight);
		ipsSum += weight * s.reward;
		const targetPrediction = model.byAction.get(targetTopK) ?? model.global;
		const loggedPrediction = model.byAction.get(s.action) ?? model.global;
		drSum += targetPrediction + weight * (s.reward - loggedPrediction);
		directSum += targetPrediction;
	});
	const weightSum = weights.reduce((a, w) => a + w, 0);
	const ess = weightSum > 0 ? (weightSum * weightSum) / weights.reduce((a, w) => a + w * w, 0) : 0;
	// DEGENERACY GUARD — a deterministic logger yields no off-policy estimate.
	// When every matched row carries propensity 1 the action was not drawn, it
	// was simply served: a row served some other action had probability 0 of
	// receiving this one, positivity fails, and IPS/DR collapse to the mean
	// reward of whichever queries happened to be served this top_k — a
	// subgroup comparison, not an off-policy estimate. The other two gates
	// cannot catch it: under a constant propensity the ESS is exactly the
	// matched row count, so MIN_ESS silently restates MIN_ACTION_PULLS, and
	// effectiveClip is by construction the largest matched weight, so no
	// weight ever exceeds it and clippedFraction is 0 for any data at all.
	// A propensity-1 ledger is precisely what the shipped 'shadow' policy
	// mode logs (see the VINV_RETRIEVAL_POLICY_MODE default in
	// indexServer.ts), so refuse support and let promotion fail closed
	// rather than fire on an unidentified number. A point mass below 1 (a
	// canary or epsilon-greedy draw) is a real randomized draw with
	// positivity intact and stays evaluable.
	const supportRefusal =
		matchedInverse.length > 0 && matchedInverse.every((w) => w === 1)
			? 'deterministic_logging_propensity_1'
			: null;
	return {
		count: samples.length,
		matchedCount: matchedInverse.length,
		directMethod: directSum / samples.length,
		ips: ipsSum / samples.length,
		snips: weightSum > 0 ? ipsSum / weightSum : null,
		doublyRobust: drSum / samples.length,
		effectiveSampleSize: ess,
		clippedFraction: clipped / samples.length,
		supportRefusal,
		supportOk:
			supportRefusal === null &&
			ess >= MIN_ESS &&
			samples.length >= MIN_SAMPLES &&
			matchedInverse.length >= MIN_ACTION_PULLS,
	};
}

function drDelta(samples: OpeSample[], baseline: number, target: number): number {
	return estimate(samples, target).doublyRobust - estimate(samples, baseline).doublyRobust;
}

/** Deterministic LCG so evaluations are reproducible from the same ledger. */
function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

function phi(x: number): number {
	// CDF via erf approximation (Abramowitz & Stegun 7.1.26, |err| < 1.5e-7).
	const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
	const erf =
		1 -
		(((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
			t *
			Math.exp((-x * x) / 2);
	return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function phiInv(p: number): number {
	// Acklam's approximation — same constants as the Python evaluator.
	if (p <= 0 || p >= 1) {
		throw new Error('p must be in (0, 1)');
	}
	const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
	const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
	const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
	const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
	const pLow = 0.02425;
	if (p < pLow) {
		const q = Math.sqrt(-2 * Math.log(p));
		return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
	}
	if (p > 1 - pLow) {
		const q = Math.sqrt(-2 * Math.log(1 - p));
		return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
	}
	const q = p - 0.5;
	const r = q * q;
	return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** BCa bootstrap CI for the DR delta — mirror of off_policy.bootstrap_dr_delta. */
export function bcaDeltaInterval(
	samples: OpeSample[],
	baselineTopK: number,
	targetTopK: number,
	iterations = BOOTSTRAP_ITERATIONS,
	seed = 7,
): [number, number] {
	const rng = makeRng(seed);
	const point = drDelta(samples, baselineTopK, targetTopK);
	const values: number[] = [];
	for (let b = 0; b < iterations; b++) {
		const resampled = samples.map(() => samples[Math.min(samples.length - 1, Math.floor(rng() * samples.length))]);
		values.push(drDelta(resampled, baselineTopK, targetTopK));
	}
	values.sort((x, y) => x - y);
	const below = values.filter((v) => v < point).length;
	const frac = Math.min(Math.max(below / values.length, 1 / (values.length + 1)), 1 - 1 / (values.length + 1));
	const z0 = phiInv(frac);
	const n = samples.length;
	const leaveOut: number[] = [];
	if (n > JACKKNIFE_CAP) {
		const stride = n / JACKKNIFE_CAP;
		for (let i = 0; i < JACKKNIFE_CAP; i++) {
			leaveOut.push(Math.floor(i * stride));
		}
	} else {
		for (let i = 0; i < n; i++) {
			leaveOut.push(i);
		}
	}
	const jack: number[] = [];
	for (const i of leaveOut) {
		const loo = samples.slice(0, i).concat(samples.slice(i + 1));
		try {
			jack.push(drDelta(loo, baselineTopK, targetTopK));
		} catch {
			continue;
		}
	}
	let accel = 0;
	if (jack.length >= 2) {
		const mean = jack.reduce((a, v) => a + v, 0) / jack.length;
		const num = jack.reduce((a, v) => a + (mean - v) ** 3, 0);
		const den = 6 * jack.reduce((a, v) => a + (mean - v) ** 2, 0) ** 1.5;
		accel = den > 0 ? num / den : 0;
	}
	const endpoint = (alpha: number): number => {
		const z = phiInv(alpha);
		const denom = 1 - accel * (z0 + z);
		const adjusted = denom > 0 ? phi(z0 + (z0 + z) / denom) : alpha;
		const idx = Math.min(values.length - 1, Math.max(0, Math.floor(adjusted * (values.length - 1))));
		return values[idx];
	};
	return [endpoint(0.025), endpoint(0.975)];
}

export interface EpochRead {
	epoch: string;
	n: number;
	drDelta: number;
}

/** Per-epoch consistency guard for pooled evaluations. */
export function epochConsistency(
	samples: OpeSample[],
	baselineTopK: number,
	targetTopK: number,
): { epochs: EpochRead[]; ok: boolean } {
	const byEpoch = new Map<string, OpeSample[]>();
	for (const s of samples) {
		const list = byEpoch.get(s.epoch) ?? [];
		list.push(s);
		byEpoch.set(s.epoch, list);
	}
	const reads: EpochRead[] = [];
	for (const [epoch, rows] of [...byEpoch.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		if (rows.length < EPOCH_CONSISTENCY_MIN_N) {
			continue;
		}
		try {
			reads.push({ epoch, n: rows.length, drDelta: drDelta(rows, baselineTopK, targetTopK) });
		} catch {
			continue;
		}
	}
	return { epochs: reads, ok: reads.every((r) => r.drDelta >= -EPOCH_CONSISTENCY_TOLERANCE) };
}

export interface CandidateEvaluation {
	action: number;
	drDelta: number;
	lcb: number;
	ucb: number;
	supportOk: boolean;
	/** The degeneracy guard's reason, from whichever of the candidate or the
	 * baseline estimate it refused, or null. */
	supportRefusal: string | null;
	epochOk: boolean;
	promotable: boolean;
}

/**
 * Evaluates every logged candidate action against the baseline (the most
 * frequently logged action — the de facto served default) and returns the
 * per-candidate verdicts. Pure over the samples; the caller decides what to
 * do with a promotable winner.
 */
export function evaluateCandidates(samples: OpeSample[]): {
	baseline: number | null;
	candidates: CandidateEvaluation[];
} {
	if (samples.length < MIN_SAMPLES) {
		return { baseline: null, candidates: [] };
	}
	const counts = new Map<number, number>();
	for (const s of samples) {
		counts.set(s.action, (counts.get(s.action) ?? 0) + 1);
	}
	const baseline = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
	const baselineEstimate = estimate(samples, baseline);
	const candidates: CandidateEvaluation[] = [];
	for (const action of [...counts.keys()].sort((a, b) => a - b)) {
		if (action === baseline) {
			continue;
		}
		const candidateEstimate = estimate(samples, action);
		const delta = candidateEstimate.doublyRobust - baselineEstimate.doublyRobust;
		const [lcb, ucb] = bcaDeltaInterval(samples, baseline, action);
		const consistency = epochConsistency(samples, baseline, action);
		candidates.push({
			action,
			drDelta: delta,
			lcb,
			ucb,
			supportOk: candidateEstimate.supportOk && baselineEstimate.supportOk,
			supportRefusal: candidateEstimate.supportRefusal ?? baselineEstimate.supportRefusal,
			epochOk: consistency.ok,
			promotable:
				candidateEstimate.supportOk &&
				baselineEstimate.supportOk &&
				lcb >= 0 &&
				candidateEstimate.clippedFraction === 0 &&
				consistency.ok,
		});
	}
	return { baseline, candidates };
}

function retrievalLedgerPath(): string {
	return path.join(vinvHomeDir(), 'telemetry', 'retrieval.jsonl');
}

function policyFilePath(): string {
	return path.join(vinvHomeDir(), 'retrieval-policy.json');
}

let running = false;

/**
 * The automatic evaluation entry point: reads the pooled ledger, evaluates
 * every candidate, and — when exactly one best promotable candidate exists —
 * writes the epoch-agnostic canary policy and logs the evaluation. Skips
 * entirely while a rollback has the policy disabled (the canary said no; a
 * human re-enables). Never throws; never runs concurrently.
 */
export function maybeRunOpeEvaluation(policyDisabled: boolean): void {
	if (running || policyDisabled) {
		return;
	}
	running = true;
	// Off the caller's path — evaluation is O(bootstrap × n) and must never
	// add latency to a query or feedback reply.
	setImmediate(() => {
		try {
			const samples = loadPooledSamples(fs.readFileSync(retrievalLedgerPath(), 'utf8'));
			const { baseline, candidates } = evaluateCandidates(samples);
			if (baseline === null) {
				return;
			}
			const promotable = candidates
				.filter((c) => c.promotable && c.drDelta > 0)
				.sort((a, b) => b.drDelta - a.drDelta);
			appendRetrievalEvent({
				type: 'ope_evaluation',
				ts: new Date().toISOString(),
				epoch: 'any',
				pooled_samples: samples.length,
				baseline,
				// The degeneracy guard's verdict on the baseline itself, stated
				// even when there is no candidate to attach it to — a ledger
				// logged entirely under a deterministic policy has exactly one
				// action in it, so without this the refusal would show up only
				// as promotions that never happen, with no reason anywhere.
				support_refusal: estimate(samples, baseline).supportRefusal,
				candidates: candidates.map((c) => ({
					action: c.action,
					dr_delta: Math.round(c.drDelta * 1000) / 1000,
					lcb: Math.round(c.lcb * 1000) / 1000,
					support_ok: c.supportOk,
					support_refusal: c.supportRefusal,
					epoch_ok: c.epochOk,
					promotable: c.promotable,
				})),
				promoted: promotable.length > 0 ? promotable[0].action : null,
			});
			if (promotable.length === 0) {
				return;
			}
			const policy = {
				version: 1,
				epoch: 'any',
				top_k: promotable[0].action,
				canary_fraction: 0.05,
			};
			const target = policyFilePath();
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const tmp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
			fs.renameSync(tmp, target);
		} catch {
			// Evaluation is opportunistic; a failure leaves the current policy.
		} finally {
			running = false;
		}
	});
}
