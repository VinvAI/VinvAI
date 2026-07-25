/**
 * The extension side of the optimization improve → verify → revert → learn →
 * retry cycle — the bridge `exerciser/optimize.py`'s docstring promises. The
 * exerciser module owns the maths + decision DOCTRINE (paired bootstrap CI,
 * accept / revert-and-retry / revert-and-stop); this file is the production
 * caller: it owns dispatch, the pre-episode snapshot, the frozen probe request
 * set, the episode-bound after-measurement, the ACTUAL revert, and the durable
 * episode record in `.vinv/exercise/optimize.jsonl`.
 *
 * This is the ONE verdict engine for optimization episodes. Panel dispatches
 * (optimizeHotspot) and the hotspot/cache sweeps all flow through
 * `runVerifiedOptimization`; the MAD noise band in `reconcileOutcome` and the
 * regress `>2.0x` latency factor remain SCREENS (cheap detectors), never the
 * authority on whether an optimization is kept.
 *
 * The verification protocol, per `optimize.py`:
 *   1. FREEZE the probe request set at dispatch — before and after replay the
 *      IDENTICAL requests, so the comparison is paired by construction.
 *   2. Measure BEFORE (N passes over the frozen set) while the code is
 *      untouched, and snapshot the whole working state.
 *   3. Dispatch the episode. The panel row is marked dispatched only AFTER the
 *      dispatch is confirmed (accepted or auto-dispatched) — a declined offer
 *      leaves no phantom "Agent optimizing…" state.
 *   4. Measure AFTER as soon as THIS episode's dispatch completes — the
 *      after-run is bound to the episode, never to "any newer capture session".
 *   5. Verdict = paired-bootstrap CI on the per-probe median latencies AND the
 *      behavioral oracle (byte/shape-identical responses on the frozen set).
 *   6. accept → keep. Attempts form a bounded LINEAGE: a behavior break
 *      reverts to ORIGIN at once; a behavior-preserving step without a proven
 *      speedup stays applied (the next attempt builds on it, judged endpoint
 *      vs the original baseline); a lineage that ends without acceptance
 *      reverts to ORIGIN — revertToSnapshot ACTUALLY runs — and every retry
 *      re-dispatches with the learning (plus the persisted attempt history in
 *      optimize_attempts.jsonl) threaded into the pack.
 *
 * The maths (paired bootstrap, decision) is a faithful TypeScript port of
 * `exerciser/src/exerciser/optimize.py` — same statistic, same thresholds,
 * same JSON shapes — so `optimize.jsonl` rows are identical no matter which
 * side wrote them, and `findingsModel.ts` reads both.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { captureWorkspaceSnapshot, revertToSnapshot, snapshotRef } from './workspaceSnapshot';
import {
	freezeReadyProbeSpecs,
	replayProbeSpecs,
	type FrozenProbeTarget,
	type ProbeMeasurement,
} from './probeRunner';
import { optimizationSourceInstance } from '../views/optimizationSource';
import {
	appendOptimizeAttempt,
	composePriorAttemptSeed,
	loadPriorOptimizeAttempts,
	opportunitySignature,
	type OptimizationStatus,
	type PersistedOptimizeAttempt,
} from './optimizationAnalysis';
import { appendEpisodeEvent, type EpisodeEvent } from './episodeTelemetry';
import { readEpisodeEvents } from './trajectoryReport';
import { maybeUpdateEpisodePolicy } from './episodePolicyUpdater';

/**
 * The policy updater joins optimization_outcome events to episodes by the
 * EPISODE LOOP's id (the one episode_start/episode_end carry) — the bridge's
 * own `opt-*` id never matches, which would leave the bandit blind to real
 * optimization runs. This finds the newest episode_end at or after the
 * dispatch started; the bridge id is the honest fallback when no loop episode
 * completed (headless drivers, declined offers).
 */
function ledgerEpisodeIdSince(sinceUnix: number, fallback: string): string {
	try {
		const events = readEpisodeEvents();
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const e = events[i] as { type?: string; episode_id?: string; at?: number; ts?: string };
			// episode_end lines carry ts (ISO), not at — parse whichever exists.
			const when =
				typeof e.at === 'number' ? e.at : e.ts ? Math.floor(Date.parse(e.ts) / 1000) : 0;
			if (e.type === 'episode_end' && typeof e.episode_id === 'string' && when >= sinceUnix) {
				return e.episode_id;
			}
		}
	} catch {
		// Unreadable ledger → fallback id; the event still records the verdict.
	}
	return fallback;
}

// ---- the maths: paired bootstrap CI (port of optimize.py) -------------------

/** Minimum practical relative improvement for an optimization to count (10%). */
export const DEFAULT_MIN_EFFECT = 0.1;
/** Bootstrap resamples for the CI. */
const BOOTSTRAP_N = 2000;

/** A paired before/after metric comparison with a bootstrap CI. */
export interface MetricComparison {
	before_median: number;
	after_median: number;
	/** (before - after) / before, positive = faster. */
	rel_improvement: number;
	ci_low: number;
	ci_high: number;
	/** effect >= min AND CI excludes zero (positive). */
	improved: boolean;
}

/** JSON shape identical to optimize.py's MetricComparison.to_json(). */
export function comparisonToJson(c: MetricComparison): Record<string, number | boolean> {
	const r = (v: number, d: number): number => {
		const f = 10 ** d;
		return Math.round(v * f) / f;
	};
	return {
		before_median: r(c.before_median, 3),
		after_median: r(c.after_median, 3),
		rel_improvement: r(c.rel_improvement, 4),
		ci_low: r(c.ci_low, 4),
		ci_high: r(c.ci_high, 4),
		improved: c.improved,
	};
}

function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Deterministic PRNG (xmur3 string seed → mulberry32) for the bootstrap. */
function seededRng(seed: string): () => number {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i += 1) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	let a = (h ^= h >>> 16) >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Relative improvement of `after` over `before` with a bootstrap 95% CI.
 * Paired: before[i] and after[i] are the SAME request measured twice, so
 * resampling draws index sets and keeps the pairing. `improved` is true only
 * when the point estimate meets the minimum practical effect AND the CI lower
 * bound is > 0.
 */
export function pairedBootstrapImprovement(
	before: number[],
	after: number[],
	options: { minEffect?: number; seed?: number; resamples?: number } = {},
): MetricComparison {
	const minEffect = options.minEffect ?? DEFAULT_MIN_EFFECT;
	const resamples = options.resamples ?? BOOTSTRAP_N;
	const n = Math.min(before.length, after.length);
	if (n === 0) {
		return {
			before_median: 0,
			after_median: 0,
			rel_improvement: 0,
			ci_low: 0,
			ci_high: 0,
			improved: false,
		};
	}
	const b = before.slice(0, n);
	const a = after.slice(0, n);
	const bMed = median(b);
	const aMed = median(a);
	const point = bMed > 0 ? (bMed - aMed) / bMed : 0;

	const rng = seededRng(`opt ${options.seed ?? 1729}`);
	const stats: number[] = [];
	for (let r = 0; r < resamples; r += 1) {
		const bb: number[] = [];
		const aa: number[] = [];
		for (let i = 0; i < n; i += 1) {
			const idx = Math.floor(rng() * n);
			bb.push(b[idx]);
			aa.push(a[idx]);
		}
		const bm = median(bb);
		stats.push(bm > 0 ? (bm - median(aa)) / bm : 0);
	}
	stats.sort((x, y) => x - y);
	const lo = stats[Math.floor(0.025 * stats.length)];
	const hi = stats[Math.min(stats.length - 1, Math.floor(0.975 * stats.length))];
	return {
		before_median: bMed,
		after_median: aMed,
		rel_improvement: point,
		ci_low: lo,
		ci_high: hi,
		improved: point >= minEffect && lo > 0,
	};
}

// ---- the decision: revert-learn-retry (port of optimize.py) -----------------

/** One optimization attempt's record (threaded into the retry context). */
export interface OptimizeAttempt {
	approach: string;
	comparison: MetricComparison | null;
	behavior_suite_passed: boolean;
	reverted: boolean;
	learning: string;
}

export type OptimizeAction = 'accept' | 'revert-and-retry' | 'revert-and-stop';

export interface OptimizeDecision {
	action: OptimizeAction;
	reason: string;
	/** what-was-tried-and-why-it-failed, for the next attempt. */
	learning: string;
	attempts: OptimizeAttempt[];
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * The accept / revert-and-retry / revert-and-stop decision for one attempt —
 * identical doctrine and wording to optimize.py's decide_optimization, so the
 * findings view reads one vocabulary regardless of which side judged.
 */
export function decideOptimization(
	approach: string,
	comparison: MetricComparison,
	behaviorSuitePassed: boolean,
	options: { priorAttempts?: OptimizeAttempt[]; maxAttempts?: number } = {},
): OptimizeDecision {
	const prior = [...(options.priorAttempts ?? [])];
	const maxAttempts = options.maxAttempts ?? 3;
	const attemptNo = prior.length + 1;

	if (behaviorSuitePassed && comparison.improved) {
		const note =
			`accepted: '${approach}' improved the metric by ${pct(comparison.rel_improvement)} ` +
			`(95% CI [${pct(comparison.ci_low)}, ${pct(comparison.ci_high)}] excludes zero) ` +
			'with the behavior suite intact';
		const attempt: OptimizeAttempt = {
			approach,
			comparison,
			behavior_suite_passed: true,
			reverted: false,
			learning: note,
		};
		return { action: 'accept', reason: note, learning: '', attempts: [...prior, attempt] };
	}

	let learning: string;
	if (!behaviorSuitePassed) {
		learning =
			`attempt ${attemptNo} '${approach}' REVERTED: it changed observable behavior ` +
			'(the learned behavior suite no longer passes byte/shape identically). A valid ' +
			'optimization must not alter outputs — keep the response contract fixed and ' +
			'optimize the internals only.';
	} else {
		learning =
			`attempt ${attemptNo} '${approach}' REVERTED: no significant speedup ` +
			`(rel improvement ${pct(comparison.rel_improvement)}, 95% CI ` +
			`[${pct(comparison.ci_low)}, ${pct(comparison.ci_high)}] — did not clear the min ` +
			'effect or the CI includes zero). Try a materially different approach, not a ' +
			'variation of this one.';
	}
	const attempt: OptimizeAttempt = {
		approach,
		comparison,
		behavior_suite_passed: behaviorSuitePassed,
		reverted: true,
		learning,
	};
	const attempts = [...prior, attempt];
	if (attemptNo >= maxAttempts) {
		return {
			action: 'revert-and-stop',
			reason: `reverted after ${attemptNo} attempts without an accepted improvement`,
			learning,
			attempts,
		};
	}
	return { action: 'revert-and-retry', reason: learning, learning, attempts };
}

// ---- the behavioral oracle over the frozen probe set ------------------------

/** Paired vectors + behavior verdict derived from two replays of the SAME set. */
export interface PairedProbeSamples {
	/** per-probe median latency, index-aligned before/after. */
	before: number[];
	after: number[];
	/** probes contributing a latency pair. */
	pairs: number;
	/** true when every stable probe answered byte/shape-identically after. */
	behaviorOk: boolean;
	/** first few violations, for the episode record / learning note. */
	behaviorDetail: string;
}

/**
 * Pairs two measurements of the frozen probe set and applies the behavioral
 * oracle: a probe whose BEFORE replays were stable (one status, one response
 * shape) must answer with that exact status + shape after the change; any new
 * server error fails regardless of stability. Latency pairs use the per-probe
 * median so one cold hit cannot swing the verdict.
 */
export function pairProbeSamples(
	before: Map<string, ProbeMeasurement>,
	after: Map<string, ProbeMeasurement>,
): PairedProbeSamples {
	const b: number[] = [];
	const a: number[] = [];
	const violations: string[] = [];
	for (const [id, bm] of before) {
		const am = after.get(id);
		if (!am) {
			continue;
		}
		if (bm.latencies.length > 0 && am.latencies.length > 0) {
			b.push(median(bm.latencies));
			a.push(median(am.latencies));
		}
		const bStatuses = new Set(bm.statuses.map(String));
		const bShapes = new Set(bm.shapes);
		const stable = bStatuses.size === 1 && bShapes.size === 1;
		if (stable) {
			const wantStatus = bm.statuses[0];
			const wantShape = bm.shapes[0];
			for (let i = 0; i < am.statuses.length; i += 1) {
				if (am.statuses[i] !== wantStatus || am.shapes[i] !== wantShape) {
					violations.push(
						`${bm.label ?? id}: HTTP ${wantStatus}/${wantShape.slice(0, 8)} → ` +
							`HTTP ${am.statuses[i]}/${(am.shapes[i] ?? '').slice(0, 8)}`,
					);
					break;
				}
			}
		}
		// A server error that was not there before is a behavior break even on
		// an unstable probe.
		const hadServerError = bm.statuses.some((s) => s !== null && s >= 500);
		if (!hadServerError && am.statuses.some((s) => s !== null && s >= 500)) {
			if (!violations.some((v) => v.startsWith(bm.label ?? id))) {
				violations.push(`${bm.label ?? id}: new 5xx after the change`);
			}
		}
	}
	return {
		before: b,
		after: a,
		pairs: b.length,
		behaviorOk: violations.length === 0,
		behaviorDetail: violations.slice(0, 5).join('; '),
	};
}

// ---- durable episode log (.vinv/exercise/optimize.jsonl) --------------------

/** The opportunity block of an episode record (optimize.py Opportunity shape). */
export interface OptimizeOpportunity {
	kind: string;
	endpoint_id: string;
	endpoint: string;
	detail: string;
	metric: string;
	value: number;
}

export function optimizeLogPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'exercise', 'optimize.jsonl');
}

/**
 * Appends one finished episode to optimize.jsonl — the exact row shape
 * optimize.py's record_episode writes, so findingsModel.ts (and the machine
 * summary) consume both sides identically.
 */
export function appendOptimizeEpisode(
	workspaceRoot: string,
	record: {
		label: string;
		opportunity: OptimizeOpportunity;
		action: OptimizeAction;
		reason: string;
		attempts: OptimizeAttempt[];
		files_changed: string[];
		at?: number;
	},
): void {
	const file = optimizeLogPath(workspaceRoot);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const row = {
		at: record.at ?? Date.now() / 1000,
		label: record.label,
		opportunity: record.opportunity,
		action: record.action,
		reason: record.reason,
		attempts: record.attempts.map((a) => ({
			approach: a.approach,
			comparison: a.comparison ? comparisonToJson(a.comparison) : null,
			behavior_suite_passed: a.behavior_suite_passed,
			reverted: a.reverted,
			learning: a.learning,
		})),
		files_changed: record.files_changed,
	};
	fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

// ---- the orchestrator -------------------------------------------------------

/** The frozen request set, opaque to the core (the deps carry the real specs). */
export interface FrozenProbeSet {
	ids: string[];
}

/** Hooks the dispatcher must honor. */
export interface OptimizeDispatchHooks {
	/**
	 * Called the moment the dispatch is CONFIRMED (user accepted the offer or
	 * auto-dispatch decided to run) but before the episode starts — this is
	 * where the panel row flips to 'dispatched'. Never called on decline.
	 */
	onAccept: () => void | Promise<void>;
	/** Prior attempts' learning, threaded into the retry's pack. */
	priorLearning?: string;
}

/**
 * Runs (or offers) ONE episode. Resolves true only when an episode actually
 * ran to completion — false on decline, busy-lock, or infra block.
 */
export type OptimizeDispatch = (hooks: OptimizeDispatchHooks) => Promise<boolean>;

/** Everything the orchestrator touches, injectable for tests. */
export interface OptimizeEngineDeps {
	/** Freeze the probe request set. Null → nothing replayable (fallback mode). */
	freezeProbes: () => Promise<FrozenProbeSet | null>;
	/** Replay the FROZEN set (never a re-synthesized one) and sample it. */
	measure: (set: FrozenProbeSet) => Promise<Map<string, ProbeMeasurement>>;
	/** Snapshot the working state; null when not a git repo (no revert offer). */
	snapshot: () => Promise<string | null>;
	/** Restore the snapshot — the ACTUAL revert. */
	revert: () => Promise<void>;
	/** Mark the panel row dispatched (no-op for sweeps). */
	markDispatched: () => void;
	/**
	 * Resolve the panel row from the engine verdict. The production deps also
	 * emit the contract `optimization_outcome` event to the episode ledger here
	 * — this is THE point where a verdict resolves.
	 */
	resolve: (resolution: {
		status: OptimizationStatus;
		comparison: MetricComparison | null;
		behaviorOk: boolean;
		reverted: boolean;
		/** attempts consumed when the verdict resolved. */
		attempt: number;
		/** the dispatched opportunity's kind (waste_kind fallback for sweeps). */
		opportunity_kind: string;
	}) => void;
	/**
	 * Prior persisted attempts for this opportunity signature (doom-loop
	 * guard) — read from .vinv/exercise/optimize_attempts.jsonl in production.
	 */
	loadPriorAttempts: (signature: string) => PersistedOptimizeAttempt[];
	/** Durably record one attempt for this opportunity signature. */
	persistAttempt: (
		signature: string,
		attempt: OptimizeAttempt,
		verdict: PersistedOptimizeAttempt['verdict'],
	) => void;
	/** Workspace files changed since the snapshot. */
	changedFiles: () => Promise<string[]>;
	/** Append the finished episode to optimize.jsonl. */
	recordEpisode: (record: {
		label: string;
		opportunity: OptimizeOpportunity;
		action: OptimizeAction;
		reason: string;
		attempts: OptimizeAttempt[];
		files_changed: string[];
	}) => void;
	notify: (message: string) => void;
	/** The verdict engine's own episode id (opt-*) — board dispatch records it
	 * so hang detection can scope ledger activity to THIS episode. */
	episodeId?: string;
	/**
	 * Fallback hand-off: called when the engine dispatched WITHOUT a measurable
	 * frozen set, so the session-timing watcher must own the row again — the
	 * bridge tag would otherwise orphan it (dispatched forever, judged by
	 * neither loop). Optional: test deps and sweeps without a panel row omit it.
	 */
	releaseToWatcher?: () => void;
	/**
	 * Learned minimum-detectable-effect: receives the null-split noise floor
	 * measured from the BEFORE samples (half-width of the CI of a no-change
	 * comparison; null when too few samples), persists it as the repo's learned
	 * `optimize.min_effect` policy, and returns the effective min effect the
	 * verdict should use. Optional: absent → the documented default applies.
	 */
	persistLearnedMinEffect?: (noiseFloorRel: number | null) => number | undefined;
}

/**
 * A no-change comparison from the BEFORE samples alone: odd vs even passes of
 * each probe. Its CI half-width is the measured noise floor — the smallest
 * relative effect this probe set can honestly resolve (doc §3.4: derive the
 * minimum detectable effect from measurement noise, not a constant).
 */
export function nullSplitComparison(
	before: Map<string, ProbeMeasurement>,
): MetricComparison | null {
	const evens: number[] = [];
	const odds: number[] = [];
	for (const m of before.values()) {
		if (m.latencies.length >= 4) {
			evens.push(median(m.latencies.filter((_, i) => i % 2 === 0)));
			odds.push(median(m.latencies.filter((_, i) => i % 2 === 1)));
		}
	}
	if (evens.length < 3) {
		return null;
	}
	return pairedBootstrapImprovement(evens, odds, { minEffect: 0 });
}

export interface OptimizeRunOptions {
	label: string;
	opportunity: OptimizeOpportunity;
	/** Attempt budget for the revert-learn-retry loop (optimize.py default 3). */
	maxAttempts?: number;
	/** Paired probes required for a statistical verdict (below → fallback). */
	minPairedProbes?: number;
}

export interface OptimizeRunResult {
	/** 'verdict' when the engine judged; 'fallback' when it dispatched without
	 * measurement (watcher reconcile takes over); 'declined' when nothing ran. */
	mode: 'verdict' | 'fallback' | 'declined';
	action?: OptimizeAction;
	comparison?: MetricComparison | null;
	behaviorOk?: boolean;
	attempts?: OptimizeAttempt[];
}

/** Panel status derived from the engine verdict. */
function statusFrom(
	decision: OptimizeDecision,
	comparison: MetricComparison,
	behaviorOk: boolean,
): OptimizationStatus {
	if (!behaviorOk) {
		return 'regressed';
	}
	if (decision.action === 'accept') {
		return 'proven';
	}
	// A significant slowdown (the whole CI below zero) is a regression; a
	// no-gain inside the CI is honestly inconclusive — both were reverted.
	return comparison.ci_high < 0 ? 'regressed' : 'inconclusive';
}

/** The KEPT-step learning note for a behavior-preserving, timing-unproven attempt. */
function keptLearning(attemptNo: number, approach: string, c: MetricComparison): string {
	return (
		`attempt ${attemptNo} '${approach}' KEPT as an intermediate lineage step: no significant ` +
		`speedup vs the ORIGINAL baseline yet (rel improvement ${pct(c.rel_improvement)}, 95% CI ` +
		`[${pct(c.ci_low)}, ${pct(c.ci_high)}]), but behavior is intact so the change remains ` +
		'applied. Build on it or take a materially different route — the timing verdict is always ' +
		'judged against the original pre-episode baseline, and everything reverts to origin if the ' +
		'lineage ends without a proven win.'
	);
}

/**
 * The one verdict engine. Freezes the probe set, measures before, dispatches,
 * measures after AS PART OF the same episode, applies the paired-bootstrap +
 * behavioral-oracle verdict, resolves the panel row, and records the whole
 * episode to optimize.jsonl.
 *
 * Attempts form a LINEAGE (the escape from the one-step revert trap): every
 * attempt must pass the BEHAVIOR gate (byte/shape-identical replay of the
 * frozen set) to stay alive, but the TIMING verdict is always the lineage
 * endpoint vs the ORIGINAL frozen baseline. A step that preserves behavior
 * without a proven speedup stays applied and the next attempt builds on it
 * (budget permitting); a behavior break reverts to ORIGIN immediately; and
 * when the lineage ends without acceptance the workspace reverts to ORIGIN —
 * never to an intermediate step. `maxAttempts` remains the whole budget.
 *
 * The doom-loop guard: prior attempts persisted under this opportunity's
 * signature (optimize_attempts.jsonl) seed the FIRST dispatch's prompt, so
 * "try a materially different approach" survives restarts; and every attempt
 * of this episode is persisted back as it happens.
 *
 * When the frozen set is empty or too small to judge (service down, no probes
 * yet), it still dispatches ONE episode — the phantom-dispatch fix and the
 * snapshot still apply — but leaves the verdict to the legacy session-timing
 * reconcile rather than fabricating a CI from nothing.
 */
export async function runVerifiedOptimization(
	opts: OptimizeRunOptions,
	dispatch: OptimizeDispatch,
	deps: OptimizeEngineDeps,
): Promise<OptimizeRunResult> {
	const minPaired = opts.minPairedProbes ?? 3;
	const maxAttempts = opts.maxAttempts ?? 3;
	const signature = opportunitySignature(opts.opportunity);

	const frozen = await deps.freezeProbes();
	const before = frozen ? await deps.measure(frozen) : null;
	// Measurable = enough paired latency samples to make the CI meaningful.
	const beforePairs = before
		? [...before.values()].filter((m) => m.latencies.length > 0).length
		: 0;
	const measurable = Boolean(frozen && before && beforePairs >= minPaired);

	await deps.snapshot();

	// Doom-loop guard: what earlier episodes (possibly before a restart)
	// already tried on this exact opportunity, threaded into every dispatch.
	let persistedSeed: string | undefined;
	try {
		persistedSeed = composePriorAttemptSeed(deps.loadPriorAttempts(signature));
	} catch {
		persistedSeed = undefined; // an unreadable store must not block dispatch
	}

	let attempts: OptimizeAttempt[] = [];
	let decision: OptimizeDecision | null = null;
	let lastComparison: MetricComparison | null = null;
	let lastBehaviorOk = true;
	let files: string[] = [];
	const budget = measurable ? maxAttempts : 1;
	// Behavior-preserving intermediate changes currently applied on top of the
	// origin snapshot (the live lineage).
	let liveLineageSteps = 0;

	const persist = (attempt: OptimizeAttempt, verdict: PersistedOptimizeAttempt['verdict']): void => {
		try {
			deps.persistAttempt(signature, attempt, verdict);
		} catch {
			// The attempt already happened; a failed history write must not mask it.
		}
	};
	const markAllReverted = (list: OptimizeAttempt[]): void => {
		for (const a of list) {
			a.reverted = true;
		}
	};
	const seed = (): string | undefined => {
		const parts = [persistedSeed, decision?.learning].filter(
			(p): p is string => Boolean(p),
		);
		return parts.length > 0 ? parts.join('\n\n') : undefined;
	};

	for (let attempt = 1; attempt <= budget; attempt += 1) {
		const dispatched = await dispatch({
			onAccept: () => deps.markDispatched(),
			priorLearning: seed(),
		});
		if (!dispatched) {
			if (attempts.length === 0) {
				// Declined outright: nothing ran, nothing was marked — no phantom.
				return { mode: 'declined' };
			}
			// A retry was declined after real attempts: the lineage ends without
			// acceptance, so any live intermediate steps go back to ORIGIN.
			if (liveLineageSteps > 0) {
				await deps.revert();
				markAllReverted(attempts);
			}
			decision = {
				action: 'revert-and-stop',
				reason: `retry declined after ${attempts.length} unaccepted attempt(s)`,
				learning: decision?.learning ?? '',
				attempts,
			};
			break;
		}
		if (!measurable) {
			// Dispatched without a measurable frozen set: the session-timing
			// reconcile (noise-band screen) picks the row up when a fresh capture
			// lands. No CI, no auto-revert — we never judge on evidence we lack.
			// Release the row back to the watcher so it is not orphaned under the
			// bridge tag with a verdict that will never come.
			deps.releaseToWatcher?.();
			return { mode: 'fallback' };
		}
		// Lineage endpoint vs the ORIGINAL frozen baseline — `before` never moves.
		const after = await deps.measure(frozen as FrozenProbeSet);
		const paired = pairProbeSamples(before as Map<string, ProbeMeasurement>, after);
		// Minimum detectable effect from the measured noise floor when the deps
		// can persist it; the documented default otherwise.
		const nullCmp = nullSplitComparison(before as Map<string, ProbeMeasurement>);
		const noiseFloor = nullCmp ? Math.abs(nullCmp.ci_high - nullCmp.ci_low) / 2 : null;
		const learnedMinEffect = deps.persistLearnedMinEffect?.(noiseFloor);
		lastComparison = pairedBootstrapImprovement(
			paired.before,
			paired.after,
			learnedMinEffect !== undefined ? { minEffect: learnedMinEffect } : {},
		);
		lastBehaviorOk = paired.behaviorOk;
		files = await deps.changedFiles();
		decision = decideOptimization(
			`${opts.label} — attempt ${attempt}`,
			lastComparison,
			paired.behaviorOk,
			{ priorAttempts: attempts, maxAttempts: budget },
		);
		const newest = decision.attempts[decision.attempts.length - 1];
		if (!paired.behaviorOk && paired.behaviorDetail) {
			newest.learning += ` (${paired.behaviorDetail})`;
		}
		attempts = decision.attempts;

		if (decision.action === 'accept') {
			persist(newest, 'accepted');
			break;
		}
		if (!paired.behaviorOk) {
			// A behavior break never stays alive: the WHOLE lineage returns to
			// origin (earlier kept steps included), and (budget permitting) the
			// next attempt starts fresh.
			await deps.revert();
			liveLineageSteps = 0;
			markAllReverted(attempts);
			persist(newest, 'reverted-behavior');
			deps.notify(`Vinv: optimization attempt ${attempt} reverted — behavior changed.`);
			if (decision.action === 'revert-and-stop') {
				break;
			}
			continue;
		}
		if (decision.action === 'revert-and-stop') {
			// Budget exhausted without acceptance: the lineage ends → ORIGIN (one
			// real revert of everything, never a partial rollback to a step).
			await deps.revert();
			markAllReverted(attempts);
			persist(newest, 'reverted-no-gain');
			deps.notify(
				`Vinv: optimization lineage reverted to origin after ${attempt} attempt(s) — no verified speedup.`,
			);
			break;
		}
		// No proven speedup but behavior intact: the step stays ALIVE as an
		// intermediate lineage change instead of reverting immediately.
		liveLineageSteps += 1;
		newest.reverted = false;
		newest.learning = keptLearning(attempt, `${opts.label} — attempt ${attempt}`, lastComparison);
		decision.learning = newest.learning;
		persist(newest, 'kept-no-gain');
		deps.notify(
			`Vinv: optimization attempt ${attempt} kept (behavior intact, no verified speedup yet) — the lineage continues.`,
		);
	}

	if (!decision || !lastComparison) {
		return { mode: 'declined' };
	}
	deps.resolve({
		status: statusFrom(decision, lastComparison, lastBehaviorOk),
		comparison: lastComparison,
		behaviorOk: lastBehaviorOk,
		reverted: decision.action !== 'accept',
		attempt: attempts.length,
		opportunity_kind: opts.opportunity.kind,
	});
	deps.recordEpisode({
		label: opts.label,
		opportunity: opts.opportunity,
		action: decision.action,
		reason: decision.reason,
		attempts,
		files_changed: decision.action === 'accept' ? files : [],
	});
	return {
		mode: 'verdict',
		action: decision.action,
		comparison: lastComparison,
		behaviorOk: lastBehaviorOk,
		attempts,
	};
}

// ---- workspace wiring -------------------------------------------------------

function git(root: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
			if (err) {
				reject(err);
			} else {
				resolve(stdout);
			}
		});
	});
}

/** How many replay passes sample each frozen probe (VINV_OPTIMIZE_PROBE_PASSES). */
function probePasses(): number {
	const raw = Number.parseInt(process.env.VINV_OPTIMIZE_PROBE_PASSES ?? '', 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/**
 * The production deps: frozen probes via probeRunner, snapshot/revert via
 * workspaceSnapshot under a bridge-owned episode id, panel bookkeeping via the
 * live OptimizationSource, changed files via git against the snapshot ref.
 */
export function buildWorkspaceDeps(
	workspaceRoot: string,
	target: { row?: number },
): OptimizeEngineDeps {
	const episodeId = `opt-${crypto.randomUUID()}`;
	const startedAtUnix = Math.floor(Date.now() / 1000);
	let frozenTarget: FrozenProbeTarget | null = null;
	return {
		episodeId,
		freezeProbes: async () => {
			frozenTarget = freezeReadyProbeSpecs(workspaceRoot);
			if (!frozenTarget || frozenTarget.specs.length === 0) {
				return null;
			}
			return { ids: frozenTarget.specs.map((s) => s.id) };
		},
		measure: async () => {
			if (!frozenTarget) {
				return new Map();
			}
			return replayProbeSpecs(frozenTarget.port, frozenTarget.specs, probePasses());
		},
		snapshot: () => captureWorkspaceSnapshot(workspaceRoot, episodeId).catch(() => null),
		revert: async () => {
			const result = await revertToSnapshot(workspaceRoot, episodeId);
			// Environment drift is a silent revert-killer: surface what the file
			// restore fixed and what it cannot (already-installed packages).
			if (result.lockfilesRestored.length > 0) {
				void vscode.window.showWarningMessage(
					`Vinv: revert restored ${result.lockfilesRestored.join(', ')} — the episode changed ` +
						'dependency lockfiles. Installed packages may still differ; re-run your install step.',
				);
			}
		},
		markDispatched: () => {
			if (target.row !== undefined) {
				optimizationSourceInstance()?.markRowDispatched(workspaceRoot, target.row, {
					engine: 'bridge',
				});
			}
		},
		releaseToWatcher: () => {
			if (target.row !== undefined) {
				// Re-tag as watcher-owned: the fallback dispatch has no episode-bound
				// verdict coming, so the session-timing reconcile must judge the row.
				optimizationSourceInstance()?.markRowDispatched(workspaceRoot, target.row, {
					engine: 'watch',
				});
			}
		},
		persistLearnedMinEffect: (noiseFloorRel) => {
			// Learned MDE: at least the measured noise floor, never below a 3%
			// practical floor nor above 25% (a floor that high means the probe set
			// is too noisy to verify anything — flag via the policy value itself).
			// No fresh noise floor (too few samples) → fall back to the value a
			// previous measured run persisted, so the learned prior is READ back,
			// not merely written.
			let persisted: number | undefined;
			try {
				const prev = JSON.parse(
					fs.readFileSync(path.join(workspaceRoot, '.vinv', 'exercise', 'policy.json'), 'utf8'),
				) as Record<string, unknown>;
				if (typeof prev['optimize.min_effect'] === 'number') {
					persisted = prev['optimize.min_effect'] as number;
				}
			} catch {
				persisted = undefined;
			}
			const learned = Math.min(0.25, Math.max(0.03, noiseFloorRel ?? persisted ?? 0.03));
			try {
				const file = path.join(workspaceRoot, '.vinv', 'exercise', 'policy.json');
				fs.mkdirSync(path.dirname(file), { recursive: true });
				let policy: Record<string, unknown> = {};
				try {
					policy = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
				} catch {
					policy = {};
				}
				policy['optimize.min_effect'] = Number(learned.toFixed(4));
				fs.writeFileSync(file, JSON.stringify(policy, null, 1), 'utf8');
			} catch {
				// The learned value still applies to THIS verdict even unpersisted.
			}
			return learned;
		},
		resolve: (resolution) => {
			let candidate;
			if (target.row !== undefined) {
				candidate = optimizationSourceInstance()?.resolveRowFromVerdict(
					workspaceRoot,
					target.row,
					resolution,
				);
			}
			// Contract: one optimization_outcome event per resolved verdict, into
			// the SAME episode ledger episodeTelemetry/trajectoryReport read. The
			// calibration updater joins delta_ms against the RAW predicted_ms that
			// was frozen at dispatch.
			const ci = resolution.comparison;
			try {
				appendEpisodeEvent({
					type: 'optimization_outcome',
					ts: new Date().toISOString(),
					at: Math.floor(Date.now() / 1000),
					// Join key for the policy updater: the LOOP's episode id (the one
					// episode_start/episode_end carry), found in the ledger for the
					// episode this dispatch ran. The bridge's own id is the fallback
					// when no loop episode completed (headless/test dispatches).
					episode_id: ledgerEpisodeIdSince(startedAtUnix, episodeId),
					// The bridge's own id, for board hang-detection scoping.
					bridge_episode_id: episodeId,
					row: target.row ?? -1,
					waste_kind: candidate?.waste_kind ?? resolution.opportunity_kind,
					predicted_ms: candidate?.outcome?.predicted_ms ?? 0,
					delta_ms: ci ? ci.after_median - ci.before_median : 0,
					verdict: resolution.behaviorOk ? resolution.status : 'reverted-behavior',
					attempt: resolution.attempt,
				} as unknown as EpisodeEvent);
			} catch {
				// The verdict already resolved; a failed ledger append must not mask it.
			}
			// A resolved verdict is fresh objective evidence — update the learned
			// policy (posteriors + calibration artifact) now rather than waiting
			// for the next episode_end-driven update.
			try {
				void maybeUpdateEpisodePolicy(workspaceRoot);
			} catch {
				// Policy refresh is best-effort; the verdict itself already landed.
			}
		},
		changedFiles: async () => {
			try {
				const diff = await git(workspaceRoot, [
					'diff',
					'--name-only',
					snapshotRef(episodeId),
				]);
				const untracked = await git(workspaceRoot, [
					'ls-files',
					'--others',
					'--exclude-standard',
				]);
				return [...new Set([...diff.split('\n'), ...untracked.split('\n')])].filter(Boolean);
			} catch {
				return [];
			}
		},
		loadPriorAttempts: (signature) =>
			loadPriorOptimizeAttempts(workspaceRoot, target.row, signature),
		persistAttempt: (signature, attempt, verdict) => {
			appendOptimizeAttempt(workspaceRoot, {
				row: target.row,
				signature,
				approach: attempt.approach,
				comparison: attempt.comparison ? comparisonToJson(attempt.comparison) : null,
				verdict,
				learning: attempt.learning,
			});
		},
		recordEpisode: (record) => {
			try {
				appendOptimizeEpisode(workspaceRoot, record);
			} catch {
				// The episode already resolved; a failed log write must not mask it.
			}
		},
		notify: (message) => void vscode.window.showInformationMessage(message),
	};
}
