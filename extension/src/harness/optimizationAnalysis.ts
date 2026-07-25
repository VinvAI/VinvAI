/**
 * The optimization analyzer: turns the code graph + runtime evidence into a
 * ranked list of OPTIMIZABLE symbols, and closes the predicted→proven loop by
 * measuring what a dispatched fix actually recovered.
 *
 * The core correction over a plain latency hotspot list (selectHotspots) is
 * that "hot" ≠ "optimizable". A symbol that dominates runtime may already be
 * optimal — optimizing it saves nothing. What we want is recoverable time:
 *
 *     score = total_ms × waste_prior
 *
 * `total_ms` is the CEILING on savings (you can never save more time than a
 * symbol spends); `waste_prior` is the fraction of that ceiling plausibly
 * REMOVABLE, estimated from three evidence signals, all defined RELATIVE to
 * this trace (no absolute thresholds, same as the rest of the cockpit):
 *
 *   • cache    — from argument-hash duplication (collectCacheCandidates): the
 *                share of time spent recomputing inputs already seen. The only
 *                DIRECTLY measured removable fraction, so it is trusted at full
 *                weight and its reclaimable_ms is used verbatim.
 *   • fanout   — a callee invoked many times per caller invocation (calls ≫ the
 *                busiest caller's calls) is a loop / N+1 shape: the fix usually
 *                lives at the caller (hoist, batch), and the amplification bounds
 *                how much is collapsible.
 *   • per-call — a symbol whose per-call cost is an outlier above the typical
 *                symbol is unexpectedly slow for the work it does.
 *
 * predicted_ms is the LARGEST single-signal recoverable estimate (with the
 * reason that produced it), not a sum — the signals overlap, and over-claiming
 * would make the proof step look like a miss. The measured delta from the
 * after-run is the truth; predicted_ms only sets the expectation and the rank.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GraphEdge, GraphNode } from '../graph/indexGraph';
import type { CacheCandidate, SymbolSessionTiming, TraceSpan } from './runtimeAnalysis';

/** Which evidence signal drove a candidate's predicted recoverable time. */
export type WasteKind = 'cache' | 'fanout' | 'per-call' | 'n-plus-1' | 'serial-async';

/** Lifecycle of one optimization opportunity through the proof loop. */
export type OptimizationStatus =
	| 'candidate' // found, not yet dispatched
	| 'dispatched' // an episode is running / awaiting a fresh after-run
	| 'proven' // after-run measured a drop beyond the noise band
	| 'inconclusive' // after-run landed inside the noise band — no honest claim
	| 'regressed'; // after-run measured a rise beyond the noise band

/** The measured result of a dispatched optimization, filled by the after-run. */
export interface OptimizationOutcome {
	/** predicted recoverable ms at dispatch (expectation, not a promise). */
	predicted_ms: number;
	/** the symbol's per-session cost captured at dispatch. */
	measured_before: number;
	/** the newest session's cost, once a fresh capture appears. */
	measured_after?: number;
	/** measured_after − measured_before (negative = faster). */
	delta_ms?: number;
	/** robust spread of the baseline sessions — the band a claim must clear. */
	noise_band_ms: number;
	/** baseline sessions the noise band was computed from. */
	baseline_sessions: number;
	/** capture session key recorded at dispatch (detects "a new run arrived"). */
	before_session: string;
	/** false when the after-run showed new errors on this symbol. */
	behavior_ok?: boolean;
	/** the dispatched episode's title, for the evidence trail. */
	episode_title?: string;
	/**
	 * Which loop owns this dispatch's verdict. 'bridge' = the exerciseOptimize
	 * verdict engine (paired-bootstrap CI over the frozen probe set, bound to
	 * the episode) — the session-timing reconcile must NOT touch these rows.
	 * Absent/'watch' = the legacy fallback that waits for a fresh capture.
	 */
	engine?: 'bridge' | 'watch';
	/** The paired-bootstrap comparison, when the bridge judged this row. */
	ci?: {
		before_median: number;
		after_median: number;
		rel_improvement: number;
		ci_low: number;
		ci_high: number;
		improved: boolean;
	};
	/** True when the change was actually rolled back (revertToSnapshot ran). */
	reverted?: boolean;
}

/** One ranked optimization opportunity. */
export interface OptimizationCandidate {
	row: number;
	name: string;
	file: string;
	line: number;
	/** newest-session wall time — the ceiling on what optimizing can recover. */
	total_ms: number;
	/** newest-session completed calls. */
	calls: number;
	/** 0..1 fraction of total_ms estimated removable. */
	waste_prior: number;
	/** largest single-signal recoverable estimate, in ms. */
	predicted_ms: number;
	/** the signal that produced predicted_ms. */
	waste_kind: WasteKind;
	/** human-readable evidence for the waste_kind. */
	reason: string;
	/**
	 * Exclusive ("self") time — time spent IN this symbol, not its callees
	 * (from the request span tree). A symbol with high total_ms but ~0 self_ms
	 * is a delegator: its cost is in what it calls, so it is not itself an
	 * optimization target. Undefined when no span data was available.
	 */
	self_ms?: number;
	/**
	 * predicted_ms deflated by the outcome-calibration artifact
	 * (.vinv/reports/optimization_calibration.json): predicted × the learned
	 * shrunk |measured|/predicted ratio for this waste_kind. Equals predicted_ms
	 * when no calibration exists (ratio defaults to 1). RANKING (sort, Pareto
	 * coverage, Amdahl share) uses this value; `predicted_ms` stays the raw
	 * signal estimate so the calibration never feeds back into itself.
	 */
	predicted_ms_effective?: number;
	/**
	 * End-to-end Amdahl ceiling: the whole-trace speedup factor if this
	 * candidate's waste were fully removed — 1/(1 − share·waste_prior), where
	 * share = this candidate's (calibrated) predicted_ms over the trace's total
	 * predicted time. share already prices the symbol's weight in the trace and
	 * waste_prior discounts it again by how much of that weight is removable,
	 * so the ceiling is deliberately conservative: a candidate can look huge in
	 * isolation (predicted_ms) yet move the end-to-end clock barely at all.
	 */
	amdahl_ceiling?: number;
	status: OptimizationStatus;
	outcome?: OptimizationOutcome;
}

/** Median of a numeric list (0 for empty). Does not mutate the input. */
function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The typical relative session-to-session variation of THIS trace: for every
 * symbol observed in ≥2 capture sessions, compute (scaled MAD ÷ median) of its
 * per-session totals, then take the median across symbols. This is the
 * derivation behind noiseBand's smallest-detectable floor — the factor is
 * observed from the trace itself, never a constant: a workspace whose re-runs
 * genuinely repeat to the millisecond yields ~0 (tight bands are then honest),
 * while a jittery one yields a large factor (borderline wins stay
 * inconclusive). Undefined when no symbol has two sessions yet — there is no
 * observed spread to derive from.
 */
export function traceRelativeSpread(
	timings: Map<number, SymbolSessionTiming[]>,
): number | undefined {
	const spreads: number[] = [];
	for (const sessions of timings.values()) {
		const totals = sessions.map((s) => s.total_ms).filter((v) => v > 0);
		if (totals.length < 2) {
			continue;
		}
		const med = median(totals);
		if (med <= 0) {
			continue;
		}
		const mad = median(totals.map((v) => Math.abs(v - med)));
		spreads.push((mad * 1.4826) / med);
	}
	return spreads.length > 0 ? median(spreads) : undefined;
}

/**
 * Robust spread of a symbol's baseline per-session cost: the median absolute
 * deviation scaled to a standard-deviation equivalent (×1.4826). This is the
 * band a measured drop must clear to be called "proven" rather than trace
 * noise.
 *
 * `relativeSpread` (from traceRelativeSpread) supplies a smallest-detectable
 * FLOOR: max(MAD band, median per-session total × relativeSpread). A symbol's
 * own MAD can be degenerate — three sessions that happen to repeat exactly
 * give a zero band, which would let a 1ms wiggle claim "proven" — but no
 * measured delta smaller than (this symbol's typical cost × the trace's
 * typical relative jitter) is distinguishable from re-run noise. The floor is
 * relative to the trace by construction; when the caller has no derived
 * spread (undefined), the MAD band stands alone, and a single baseline sample
 * falls back to a 10% tolerance of that sample — honest and deliberately
 * conservative (borderline wins report inconclusive, never a false proof).
 */
export function noiseBand(baseline: number[], relativeSpread?: number): number {
	if (baseline.length === 0) {
		return 0;
	}
	if (baseline.length === 1) {
		return Math.abs(baseline[0]) * (relativeSpread ?? 0.1);
	}
	const med = median(baseline);
	const mad = median(baseline.map((v) => Math.abs(v - med)));
	const band = mad * 1.4826;
	if (relativeSpread === undefined) {
		return band;
	}
	return Math.max(band, Math.abs(med) * relativeSpread);
}

/** The newest session's timing for a row (undefined when never observed). */
function latest(timings: SymbolSessionTiming[] | undefined): SymbolSessionTiming | undefined {
	return timings && timings.length > 0 ? timings[timings.length - 1] : undefined;
}

interface ComputeInputs {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** row → per-session timings, oldest→newest (collectSymbolTimings). */
	timings: Map<number, SymbolSessionTiming[]>;
	/** cache opportunities keyed by row (collectCacheCandidates). */
	cacheByRow: Map<number, CacheCandidate>;
	/** per-request call forest (collectRequestSpans) — enables the structural
	 * signals: N+1, staircase, and self-time. Optional; without it the analyzer
	 * falls back to the aggregate signals only. */
	spans?: TraceSpan[];
	/** Pareto coverage of predicted time the returned list must span. */
	coverage?: number;
	/** hard cap on the list length (packs and panels are budgeted). */
	cap?: number;
	/**
	 * waste_kind → learned shrunk |measured|/predicted ratio from the outcome
	 * calibration artifact (loadOptimizationCalibration). Absent kind → 1.
	 */
	calibration?: Record<string, number>;
}

/** Last dotted segment of a component qualname, for readable reasons. */
function shortName(component: string): string {
	const parts = component.split('.');
	return parts[parts.length - 1] || component;
}

/** Structural signals derived from the request span tree, per graph row. */
interface SpanSignal {
	/** collapsible time from a callee repeated ≥N times under one parent. */
	nPlusOneMs: number;
	nCount: number;
	nParent: string;
	/** time recoverable by running this symbol's sequential I/O children concurrently. */
	serialMs: number;
	serialCount: number;
	/** exclusive time — duration spent IN this symbol, not its callees. */
	selfMs: number;
}

/** A callee is "repeated" (N+1) when it fires at least this many times under one parent in one request. */
const N_PLUS_ONE_MIN = 4;

/**
 * Walks the request span forest and derives the structural signals. All three
 * are RELATIVE to the observed requests (no absolute ms thresholds): N+1 is a
 * repetition count, staircase is a sequencing fact, self-time is a subtraction.
 */
function computeSpanSignals(roots: TraceSpan[]): Map<number, SpanSignal> {
	const sig = new Map<number, SpanSignal>();
	const get = (row: number): SpanSignal => {
		let s = sig.get(row);
		if (!s) {
			s = { nPlusOneMs: 0, nCount: 0, nParent: '', serialMs: 0, serialCount: 0, selfMs: 0 };
			sig.set(row, s);
		}
		return s;
	};
	const visit = (span: TraceSpan): void => {
		const childSum = span.children.reduce((a, c) => a + c.durationMs, 0);
		// Self time: what this symbol spent in its own body, not its callees.
		if (span.row !== null && !span.errored) {
			get(span.row).selfMs += Math.max(0, span.durationMs - childSum);
		}
		// N+1: a child component repeated many times under this one parent call.
		const byRow = new Map<number, { count: number; ms: number }>();
		for (const c of span.children) {
			if (c.row === null || c.errored) {
				continue;
			}
			const g = byRow.get(c.row) ?? { count: 0, ms: 0 };
			g.count += 1;
			g.ms += c.durationMs;
			byRow.set(c.row, g);
		}
		for (const [crow, g] of byRow) {
			if (g.count >= N_PLUS_ONE_MIN && g.ms > 0) {
				const s = get(crow);
				s.nPlusOneMs += (g.ms * (g.count - 1)) / g.count;
				if (g.count > s.nCount) {
					s.nCount = g.count;
					s.nParent = shortName(span.component);
				}
			}
		}
		// Staircase: independent I/O children that run BACK-TO-BACK (sequential,
		// non-overlapping) could be awaited concurrently; the recoverable time is
		// everything past the slowest one. Attributed to the PARENT (where the
		// gather/parallelize fix lives).
		if (span.row !== null) {
			const io = span.children
				.filter((c) => c.io && !c.errored && c.durationMs > 0 && c.startMs > 0)
				.sort((a, b) => a.startMs - b.startMs);
			if (io.length >= 2) {
				let sequential = true;
				for (let i = 1; i < io.length; i += 1) {
					// A later child that STARTS before the previous one ENDED is already
					// overlapping — not a staircase.
					if (io[i].startMs < io[i - 1].startMs + io[i - 1].durationMs - 1) {
						sequential = false;
						break;
					}
				}
				if (sequential) {
					const sum = io.reduce((a, c) => a + c.durationMs, 0);
					const slowest = Math.max(...io.map((c) => c.durationMs));
					const savings = sum - slowest;
					if (savings > 0) {
						const s = get(span.row);
						s.serialMs += savings;
						if (io.length > s.serialCount) {
							s.serialCount = io.length;
						}
					}
				}
			}
		}
		for (const c of span.children) {
			visit(c);
		}
	};
	for (const r of roots) {
		visit(r);
	}
	return sig;
}

/**
 * Computes the ranked optimization candidates. Pure and vscode-free so it is
 * unit-testable and shareable with the MCP surface. Selection is the Pareto
 * head of predicted recoverable time — relative to THIS trace — so the rule is
 * scale-free (a 5ms service and a 5s batch job get the same treatment).
 */
export function computeOptimizationCandidates(inputs: ComputeInputs): OptimizationCandidate[] {
	const { nodes, edges, timings, cacheByRow } = inputs;
	const coverage = inputs.coverage ?? 0.9;
	const cap = inputs.cap ?? 12;
	const spanSig = inputs.spans ? computeSpanSignals(inputs.spans) : new Map<number, SpanSignal>();

	// Per-symbol cost basis: EXCLUSIVE (self) time when the span tree gives it,
	// else inclusive total. Using self-time is the critical-path correction — a
	// parent that only awaits callees has ~0 self time and must not be judged
	// "slow per call" for time it spent in those callees.
	const costOf = (row: number, l: SymbolSessionTiming): number => {
		const self = spanSig.get(row)?.selfMs;
		return self !== undefined ? self : l.total_ms;
	};

	// Typical per-call cost across every executed symbol, for the outlier test.
	const perCallCosts: number[] = [];
	for (const [row, sess] of timings) {
		const l = latest([...sess]);
		if (l && l.calls > 0) {
			const cost = costOf(row, l);
			if (cost > 0) {
				perCallCosts.push(cost / l.calls);
			}
		}
	}
	const medianPerCall = median(perCallCosts);

	// Busiest caller's newest-session call count, per callee row (fanout).
	const maxCallerCalls = new Map<number, number>();
	for (const e of edges) {
		if (e.kind !== 'invoke') {
			continue;
		}
		const callerCalls = latest(timings.get(e.src))?.calls ?? 0;
		const prev = maxCallerCalls.get(e.dst) ?? 0;
		if (callerCalls > prev) {
			maxCallerCalls.set(e.dst, callerCalls);
		}
	}

	const raw: OptimizationCandidate[] = [];
	for (const [row, sess] of timings) {
		const l = latest(sess);
		const node = nodes[row];
		if (!l || !node || l.total_ms <= 0 || l.calls <= 0) {
			continue;
		}

		// Each signal proposes a removable-ms estimate and a reason; the winner
		// is the largest, so we never sum overlapping evidence into a fantasy.
		let bestMs = 0;
		let bestKind: WasteKind = 'per-call';
		let bestReason = '';

		const cache = cacheByRow.get(row);
		if (cache && cache.reclaimable_ms > 0) {
			// Directly measured removable time — trusted verbatim.
			const dup = cache.calls - cache.distinct_args;
			if (cache.reclaimable_ms > bestMs) {
				bestMs = cache.reclaimable_ms;
				bestKind = 'cache';
				bestReason = `recomputes identical inputs (${dup} of ${cache.calls} calls repeat); ~${Math.round(
					cache.reclaimable_ms,
				)}ms is cacheable`;
			}
		}

		const callerCalls = maxCallerCalls.get(row) ?? 0;
		if (callerCalls > 0) {
			const amplification = l.calls / callerCalls;
			if (amplification > 1) {
				// Fraction collapsible if the per-caller fan-out were removed.
				const signal = 1 - 1 / amplification;
				const ms = l.total_ms * signal;
				if (ms > bestMs) {
					bestMs = ms;
					bestKind = 'fanout';
					bestReason = `called ${l.calls}× (~${amplification.toFixed(
						1,
					)}× per caller invocation) — a loop or N+1 shape; batching collapses most of it`;
				}
			}
		}

		const ss = spanSig.get(row);
		const selfMs = ss?.selfMs;
		// Per-call outlier on the self-time basis (inclusive when no spans). A
		// delegator's self cost is ~0, so this never fires for it — the callees it
		// waits on are flagged on their own instead.
		const cost = costOf(row, l);
		if (medianPerCall > 0 && cost > 0) {
			const perCall = cost / l.calls;
			if (perCall > medianPerCall) {
				const signal = 1 - medianPerCall / perCall;
				const ms = cost * signal;
				if (ms > bestMs) {
					bestMs = ms;
					bestKind = 'per-call';
					bestReason = `${perCall.toFixed(1)}ms per call${
						selfMs !== undefined ? ' (self)' : ''
					} — ${(perCall / medianPerCall).toFixed(
						1,
					)}× the typical symbol; unexpectedly slow for the work it does`;
				}
			}
		}

		// Structural signals from the request span tree (most precise when present).
		if (ss) {
			if (ss.nPlusOneMs > bestMs) {
				bestMs = ss.nPlusOneMs;
				bestKind = 'n-plus-1';
				bestReason = `called ${ss.nCount}× inside a single request${
					ss.nParent ? ` from ${ss.nParent}` : ''
				} — an N+1 loop; batch or hoist the call to collapse it`;
			}
			if (ss.serialMs > bestMs) {
				bestMs = ss.serialMs;
				bestKind = 'serial-async';
				bestReason = `${ss.serialCount} independent I/O calls run back-to-back — awaiting them concurrently (gather) overlaps the waits`;
			}
		}

		if (bestMs <= 0) {
			continue; // hot but no removable overhead we can point at — skip
		}
		raw.push({
			row,
			name: node.name,
			file: node.file,
			line: node.start_line,
			total_ms: l.total_ms,
			calls: l.calls,
			waste_prior: Math.min(1, bestMs / l.total_ms),
			predicted_ms: bestMs,
			waste_kind: bestKind,
			reason: bestReason,
			self_ms: selfMs,
			status: 'candidate',
		});
	}

	// Calibration deflation at RANKING time: the learned |measured|/predicted
	// ratio per waste_kind (contract with the calibration artifact) scales the
	// raw estimate into the expectation history supports. Raw stays on the
	// candidate — the C1 outcome events report against raw so the calibration
	// never compounds on its own output.
	const calibration = inputs.calibration ?? {};
	for (const c of raw) {
		const ratio = calibration[c.waste_kind];
		c.predicted_ms_effective =
			c.predicted_ms * (typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
	}
	const effective = (c: OptimizationCandidate): number => c.predicted_ms_effective ?? c.predicted_ms;
	const total = raw.reduce((s, c) => s + effective(c), 0);
	if (total <= 0) {
		return [];
	}
	// End-to-end Amdahl ceiling per candidate (see the field doc): share of the
	// trace's total predicted time, discounted by the waste prior. The
	// denominator cannot hit zero unless one candidate IS the whole trace at
	// waste_prior 1; the epsilon floor keeps the ceiling finite even then.
	for (const c of raw) {
		const share = effective(c) / total;
		c.amdahl_ceiling = 1 / Math.max(1e-6, 1 - share * c.waste_prior);
	}
	raw.sort((a, b) => effective(b) - effective(a));
	const out: OptimizationCandidate[] = [];
	let covered = 0;
	for (const c of raw) {
		if (out.length >= cap || covered / total >= coverage) {
			break;
		}
		covered += effective(c);
		out.push(c);
	}
	return out;
}

// ---- outcome calibration artifact (read side) -------------------------------

/** Where the policy updater's outcome-calibration artifact lives. */
export function optimizationCalibrationPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'optimization_calibration.json');
}

/**
 * Loads the calibration artifact written by the episode policy updater —
 * {"updated_at":iso,"by_waste_kind":{kind:{"n","mean_ratio","shrunk_ratio"}}} —
 * as a waste_kind → shrunk_ratio map for computeOptimizationCandidates.
 * Returns undefined (ratio 1 everywhere) when the file is absent or malformed:
 * an unreadable calibration must never zero out the ranking.
 */
export function loadOptimizationCalibration(
	workspaceRoot: string,
): Record<string, number> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(optimizationCalibrationPath(workspaceRoot), 'utf8'));
	} catch {
		return undefined;
	}
	const by = (parsed as { by_waste_kind?: unknown })?.by_waste_kind;
	if (typeof by !== 'object' || by === null) {
		return undefined;
	}
	const out: Record<string, number> = {};
	for (const [kind, entry] of Object.entries(by as Record<string, unknown>)) {
		const ratio = (entry as { shrunk_ratio?: unknown })?.shrunk_ratio;
		if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0) {
			out[kind] = ratio;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Freezes a candidate at dispatch: records the prediction and the symbol's
 * current per-session cost as the BEFORE baseline, plus the robust noise band
 * the after-run will have to clear. Returns a new candidate (no mutation).
 */
export function markDispatched(
	candidate: OptimizationCandidate,
	timings: SymbolSessionTiming[] | undefined,
	episodeTitle: string,
	relativeSpread?: number,
): OptimizationCandidate {
	const l = latest(timings);
	const before = l?.total_ms ?? candidate.total_ms;
	const baseline = (timings ?? []).map((s) => s.total_ms);
	return {
		...candidate,
		status: 'dispatched',
		outcome: {
			predicted_ms: candidate.predicted_ms,
			measured_before: before,
			noise_band_ms: noiseBand(baseline, relativeSpread),
			baseline_sessions: baseline.length,
			before_session: l?.session ?? '',
			episode_title: episodeTitle,
		},
	};
}

/**
 * FALLBACK reconcile for a dispatched candidate once a fresh capture session
 * has arrived (a newer session key than the one recorded at dispatch).
 * Compares the new session's cost against the before baseline and issues a
 * verdict: `proven` only when the drop clears the noise band AND no new errors
 * appeared, `regressed` on a rise beyond the band, `inconclusive` inside it.
 * Returns the candidate unchanged while it is still waiting for the after-run.
 *
 * The MAD noise band here is a SCREEN, not the authority: rows dispatched
 * through the exerciseOptimize verdict engine (outcome.engine === 'bridge')
 * are judged by the paired-bootstrap CI on the frozen probe set, bound to the
 * episode — the caller must not route those rows here. This path remains only
 * for dispatches the engine could not measure (no running service / no
 * replayable probes), where a fresh session's timing is the best evidence left.
 */
export function reconcileOutcome(
	candidate: OptimizationCandidate,
	timings: SymbolSessionTiming[] | undefined,
	behaviorOk: boolean,
): OptimizationCandidate {
	if (candidate.status !== 'dispatched' || !candidate.outcome) {
		return candidate;
	}
	const l = latest(timings);
	// No newer session than the one we froze at dispatch → still waiting.
	if (!l || l.session === candidate.outcome.before_session) {
		return candidate;
	}
	const after = l.total_ms;
	const delta = after - candidate.outcome.measured_before;
	const band = candidate.outcome.noise_band_ms;
	let status: OptimizationStatus;
	if (!behaviorOk) {
		// A behavior change disqualifies any timing claim — the fix broke
		// something; surface it as a regression regardless of the clock.
		status = 'regressed';
	} else if (delta < -band) {
		status = 'proven';
	} else if (delta > band) {
		status = 'regressed';
	} else {
		status = 'inconclusive';
	}
	return {
		...candidate,
		status,
		total_ms: after,
		outcome: {
			...candidate.outcome,
			measured_after: after,
			delta_ms: delta,
			behavior_ok: behaviorOk,
		},
	};
}

// ---- attempt-history store (doom-loop guard) --------------------------------
//
// Every optimization attempt's record is persisted to
// .vinv/exercise/optimize_attempts.jsonl keyed by (row, opportunity
// signature), so "try a materially different approach" survives extension
// restarts: a NEW dispatch for the same key seeds the episode prompt with what
// was already tried and why it failed. The file is append-only with EXPLICIT
// expiry: a key whose underlying candidate signature has not been sighted in
// ATTEMPT_EXPIRY_SESSIONS fresh capture sessions (a session count relative to
// the trace stream, never a wall-clock age) is dropped — the code it described
// evidently changed or the waste disappeared, so its learnings are stale.
//
// Line shapes (one JSON object per line, torn tails skipped):
//   {"type":"attempt","key","row","signature","at","approach","comparison",
//    "verdict","learning"}
//   {"type":"session","session","at","keys":[...]}   ← sighting: which stored
//     keys were still present among the ranked candidates when this fresh
//     capture session was analyzed.

/** Fresh capture sessions a key may go unsighted before its attempts expire. */
export const ATTEMPT_EXPIRY_SESSIONS = 3;

/** Attempt learnings threaded into a new dispatch's prompt seed. */
const ATTEMPT_SEED_MAX = 3;

export function optimizeAttemptsPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'exercise', 'optimize_attempts.jsonl');
}

/** Content signature of an optimization opportunity (kind + endpoint id). */
export function opportunitySignature(opp: { kind: string; endpoint_id: string }): string {
	return crypto
		.createHash('sha1')
		.update(`${opp.kind}|${opp.endpoint_id}`)
		.digest('hex')
		.slice(0, 16);
}

/** The store key: row (−1 for row-less sweeps) + opportunity signature. */
export function attemptKey(row: number | undefined, signature: string): string {
	return `${row ?? -1}:${signature}`;
}

/**
 * The sighting keys a freshly ranked candidate list "proves alive": one per
 * candidate row plus the sweep keys. Kinds and endpoint ids mirror how the
 * dispatch layer (autoTrigger) constructs OptimizeOpportunity for a panel row
 * ('latency-symbol'/name), the hotspot sweep ('hotspot-sweep'/'hotspots'),
 * and the cache sweep ('cache-sweep'/'cache-candidates') — the signature must
 * hash identically on the write (dispatch) and sighting (recompute) sides.
 */
export function candidateAttemptKeys(candidates: OptimizationCandidate[]): string[] {
	const keys = candidates.map((c) =>
		attemptKey(c.row, opportunitySignature({ kind: 'latency-symbol', endpoint_id: c.name })),
	);
	if (candidates.length > 0) {
		keys.push(attemptKey(undefined, opportunitySignature({ kind: 'hotspot-sweep', endpoint_id: 'hotspots' })));
	}
	if (candidates.some((c) => c.waste_kind === 'cache')) {
		keys.push(
			attemptKey(undefined, opportunitySignature({ kind: 'cache-sweep', endpoint_id: 'cache-candidates' })),
		);
	}
	return keys;
}

/** One persisted attempt record (the doom-loop guard's unit of memory). */
export interface PersistedOptimizeAttempt {
	key: string;
	row: number;
	signature: string;
	/** unix seconds — ordering only, never used as a wall-clock expiry. */
	at: number;
	approach: string;
	comparison: Record<string, number | boolean> | null;
	verdict: 'accepted' | 'kept-no-gain' | 'reverted-no-gain' | 'reverted-behavior';
	learning: string;
}

interface SessionSighting {
	session: string;
	at: number;
	keys: Set<string>;
}

interface AttemptStore {
	attempts: PersistedOptimizeAttempt[];
	/** Deduped by session id (keys unioned), in first-appearance order. */
	sessions: SessionSighting[];
}

function parseAttemptStore(workspaceRoot: string): AttemptStore {
	const store: AttemptStore = { attempts: [], sessions: [] };
	let raw: string;
	try {
		raw = fs.readFileSync(optimizeAttemptsPath(workspaceRoot), 'utf8');
	} catch {
		return store;
	}
	const bySession = new Map<string, SessionSighting>();
	for (const line of raw.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // torn tail (crash mid-append) — never fatal
		}
		if (obj.type === 'attempt' && typeof obj.key === 'string') {
			store.attempts.push(obj as unknown as PersistedOptimizeAttempt);
		} else if (obj.type === 'session' && typeof obj.session === 'string') {
			const keys = Array.isArray(obj.keys)
				? obj.keys.filter((k): k is string => typeof k === 'string')
				: [];
			const existing = bySession.get(obj.session);
			if (existing) {
				for (const k of keys) {
					existing.keys.add(k);
				}
				existing.at = Math.max(existing.at, Number(obj.at) || 0);
			} else {
				const s: SessionSighting = {
					session: obj.session,
					at: Number(obj.at) || 0,
					keys: new Set(keys),
				};
				bySession.set(obj.session, s);
				store.sessions.push(s);
			}
		}
	}
	return store;
}

/**
 * Keys whose candidate signature disappeared for ATTEMPT_EXPIRY_SESSIONS or
 * more fresh capture sessions: count the sighted sessions recorded AFTER the
 * key's last activity (its newest attempt or newest sighting) that do NOT
 * include it. Session COUNT, not elapsed time — a workspace idle for a month
 * expires nothing.
 */
function expiredAttemptKeys(store: AttemptStore): Set<string> {
	const lastActivity = new Map<string, number>();
	for (const a of store.attempts) {
		lastActivity.set(a.key, Math.max(lastActivity.get(a.key) ?? 0, a.at || 0));
	}
	for (const s of store.sessions) {
		for (const k of s.keys) {
			if (lastActivity.has(k)) {
				lastActivity.set(k, Math.max(lastActivity.get(k) ?? 0, s.at));
			}
		}
	}
	const expired = new Set<string>();
	for (const [key, activityAt] of lastActivity) {
		const missed = store.sessions.filter((s) => s.at > activityAt && !s.keys.has(key)).length;
		if (missed >= ATTEMPT_EXPIRY_SESSIONS) {
			expired.add(key);
		}
	}
	return expired;
}

/** Appends one attempt record for (row, signature). */
export function appendOptimizeAttempt(
	workspaceRoot: string,
	record: {
		row?: number;
		signature: string;
		approach: string;
		comparison: Record<string, number | boolean> | null;
		verdict: PersistedOptimizeAttempt['verdict'];
		learning: string;
		at?: number;
	},
): void {
	const file = optimizeAttemptsPath(workspaceRoot);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const line: PersistedOptimizeAttempt & { type: 'attempt' } = {
		type: 'attempt',
		key: attemptKey(record.row, record.signature),
		row: record.row ?? -1,
		signature: record.signature,
		at: record.at ?? Math.floor(Date.now() / 1000),
		approach: record.approach,
		comparison: record.comparison,
		verdict: record.verdict,
		learning: record.learning,
	};
	fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
}

/**
 * Records which stored keys the current candidate ranking still contains, for
 * one capture session — the expiry clock. Also the compaction point: once a
 * key has expired, its lines are rewritten away here (append-only evidence
 * with explicit expiry, not an ever-growing file). No-ops when the store has
 * no attempts, and appends at most one line per (session, key-set) so a
 * session whose trace merely grows does not spam sightings.
 */
export function recordCandidateSightings(
	workspaceRoot: string,
	session: string,
	presentKeys: string[],
	at?: number,
): void {
	const store = parseAttemptStore(workspaceRoot);
	if (store.attempts.length === 0) {
		return;
	}
	const storedKeys = new Set(store.attempts.map((a) => a.key));
	const present = [...new Set(presentKeys)].filter((k) => storedKeys.has(k));
	const existing = store.sessions.find((s) => s.session === session);
	const file = optimizeAttemptsPath(workspaceRoot);
	if (!existing || present.some((k) => !existing.keys.has(k))) {
		const line = {
			type: 'session',
			session,
			at: at ?? Math.floor(Date.now() / 1000),
			keys: present,
		};
		fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
		// Fold the new sighting into the in-memory store for the expiry pass.
		if (existing) {
			for (const k of present) {
				existing.keys.add(k);
			}
			existing.at = Math.max(existing.at, line.at);
		} else {
			store.sessions.push({ session, at: line.at, keys: new Set(present) });
		}
	}
	const expired = expiredAttemptKeys(store);
	if (expired.size === 0) {
		return;
	}
	// Compaction: drop the expired keys' attempts; keep a bounded tail of
	// session lines (older ones can no longer change any surviving key's count).
	const survivors = store.attempts.filter((a) => !expired.has(a.key));
	const lines: string[] = survivors.map((a) => JSON.stringify({ type: 'attempt', ...a }));
	for (const s of store.sessions.slice(-20)) {
		lines.push(
			JSON.stringify({
				type: 'session',
				session: s.session,
				at: s.at,
				keys: [...s.keys].filter((k) => !expired.has(k)),
			}),
		);
	}
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
	fs.renameSync(tmp, file);
}

/**
 * Prior attempts for (row, signature), oldest → newest, excluding expired
 * keys. This is what a NEW dispatch threads into its prompt seed.
 */
export function loadPriorOptimizeAttempts(
	workspaceRoot: string,
	row: number | undefined,
	signature: string,
): PersistedOptimizeAttempt[] {
	const store = parseAttemptStore(workspaceRoot);
	const key = attemptKey(row, signature);
	if (expiredAttemptKeys(store).has(key)) {
		return [];
	}
	return store.attempts.filter((a) => a.key === key);
}

/**
 * The prompt-seed text composed from persisted prior attempts (newest last,
 * capped) — what makes "try a materially different approach" survive a
 * restart. Undefined when there is no history to seed.
 */
export function composePriorAttemptSeed(
	attempts: PersistedOptimizeAttempt[],
): string | undefined {
	if (attempts.length === 0) {
		return undefined;
	}
	const shown = attempts.slice(-ATTEMPT_SEED_MAX);
	const omitted = attempts.length - shown.length;
	return (
		'Prior optimization attempts on this exact target (persisted across sessions):\n' +
		(omitted > 0 ? `(${omitted} earlier attempt(s) omitted)\n` : '') +
		shown.map((a) => `- [${a.verdict}] ${a.learning}`).join('\n') +
		'\nDo not repeat these approaches — try a materially different one.'
	);
}
