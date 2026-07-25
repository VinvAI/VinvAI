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
 * Robust spread of a symbol's baseline per-session cost: the median absolute
 * deviation scaled to a standard-deviation equivalent (×1.4826). This is the
 * band a measured drop must clear to be called "proven" rather than trace
 * noise. With a single baseline sample there is no spread to estimate, so we
 * fall back to a 10% tolerance of that sample — honest and deliberately
 * conservative (borderline wins report inconclusive, never a false proof).
 */
export function noiseBand(baseline: number[]): number {
	if (baseline.length <= 1) {
		return baseline.length === 1 ? Math.abs(baseline[0]) * 0.1 : 0;
	}
	const med = median(baseline);
	const mad = median(baseline.map((v) => Math.abs(v - med)));
	return mad * 1.4826;
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

	const total = raw.reduce((s, c) => s + c.predicted_ms, 0);
	if (total <= 0) {
		return [];
	}
	raw.sort((a, b) => b.predicted_ms - a.predicted_ms);
	const out: OptimizationCandidate[] = [];
	let covered = 0;
	for (const c of raw) {
		if (out.length >= cap || covered / total >= coverage) {
			break;
		}
		covered += c.predicted_ms;
		out.push(c);
	}
	return out;
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
			noise_band_ms: noiseBand(baseline),
			baseline_sessions: baseline.length,
			before_session: l?.session ?? '',
			episode_title: episodeTitle,
		},
	};
}

/**
 * Closes the loop for a dispatched candidate once a FRESH capture session has
 * arrived (a newer session key than the one recorded at dispatch). Compares
 * the new session's cost against the before baseline and issues an honest
 * verdict: `proven` only when the drop clears the noise band AND no new errors
 * appeared, `regressed` on a rise beyond the band, `inconclusive` inside it.
 * Returns the candidate unchanged while it is still waiting for the after-run.
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
