/**
 * Trace-diff verdict — measure an optimization by comparing the TARGET
 * function's per-call cost between the before-fix and after-fix traces, using
 * the same paired-bootstrap statistics the probe engine uses for HTTP latency.
 *
 * Why this exists: the probe verdict engine (exerciseOptimize) replays HTTP
 * requests and diffs response bodies — it only works when the endpoint returns
 * a healthy, replayable response against a RUNNING service. But a request that
 * FAILS (a 400, a missing token, an internal raise) still traces every function
 * that ran before the failure, with real durations and allocations. Those
 * per-call samples are a valid before/after signal, so we can optimize and
 * verify a function on a failing flow — and it is the ONLY way memory
 * (bytes-per-call) can be measured at all. Each CALL is a sample; a hot function
 * like a 176-call validator yields a strong CI from a single failing run.
 *
 * The behavior oracle here is trace-shaped, not HTTP-shaped: a memory/latency
 * fix must leave the flow FAILING THE SAME WAY (same set of errored components
 * and error types). If the change makes the flow succeed, fail differently, or
 * makes the optimized function itself start raising, that is a behavior change.
 */
import * as fs from 'fs';
import { buildComponentMatcher, type GraphNode } from '../graph/indexGraph';
import { pairedBootstrapImprovement, type MetricComparison } from './optimizeStats';

/** Which per-call quantity to sample from the trace. */
export type TraceMetric = 'duration' | 'bytes';

interface RawExit {
	event?: string;
	component?: string;
	duration_ms?: number | string;
	mem_delta_bytes?: number | string;
	error_type?: string | null;
}

function* exits(traceFile: string): Generator<RawExit> {
	let text: string;
	try {
		text = fs.readFileSync(traceFile, 'utf8');
	} catch {
		return;
	}
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const ev = JSON.parse(line) as RawExit;
			if (ev.event === 'exit' && ev.component) {
				yield ev;
			}
		} catch {
			// torn tail line — skip
		}
	}
}

function isErrored(ev: RawExit): boolean {
	return Boolean(ev.error_type && ev.error_type !== 'None');
}

/**
 * The target row's per-call sample vector from ONE trace file: `duration`
 * yields each SUCCESSFUL call's duration_ms; `bytes` yields each call's positive
 * mem_delta_bytes. Errored calls are excluded — a call that raised measures the
 * failure, not the work (the same rule the analyzer uses). Rows join through the
 * segment-aligned qualname matcher; ambiguous names never contribute.
 */
export function collectCallSamples(
	traceFile: string,
	nodes: GraphNode[],
	row: number,
	metric: TraceMetric,
): number[] {
	const rowsFor = buildComponentMatcher(nodes);
	const samples: number[] = [];
	for (const ev of exits(traceFile)) {
		if (isErrored(ev)) {
			continue;
		}
		const rows = rowsFor(ev.component as string);
		if (rows.length !== 1 || rows[0] !== row) {
			continue;
		}
		if (metric === 'bytes') {
			const b = Math.max(0, Number(ev.mem_delta_bytes ?? 0) || 0);
			if (b > 0) {
				samples.push(b);
			}
		} else {
			const d = Number(ev.duration_ms ?? 0) || 0;
			if (d >= 0) {
				samples.push(d);
			}
		}
	}
	return samples;
}

/**
 * The flow's error signature: the sorted set of `component|error_type` over all
 * errored exits in a trace. Two traces "fail the same way" when their signatures
 * match — the behavior oracle for a trace-diff verdict.
 */
export function errorSignature(traceFile: string): string {
	const sig = new Set<string>();
	for (const ev of exits(traceFile)) {
		if (isErrored(ev)) {
			sig.add(`${ev.component}|${ev.error_type}`);
		}
	}
	return [...sig].sort().join('\n');
}

/** True when the after-run failed identically to the before-run. */
export function sameErrorSignature(beforeTrace: string, afterTrace: string): boolean {
	return errorSignature(beforeTrace) === errorSignature(afterTrace);
}

/** A trace-diff verdict: the bootstrap comparison plus the resolved status. */
export interface TraceDiffVerdict {
	comparison: MetricComparison;
	status: 'proven' | 'inconclusive' | 'regressed';
	behaviorOk: boolean;
}

/**
 * Judges an optimization from before/after per-call sample vectors with the
 * SAME paired bootstrap the probe engine uses. Within-function calls are treated
 * as exchangeable (the pairing is by resample index, and order carries no
 * meaning for repeated calls of one symbol), so this is effectively a two-sample
 * median-improvement CI. `behaviorOk` (the trace error-signature check) gates the
 * verdict: a behavior change is a regression no matter what the clock/bytes did.
 */
export function traceDiffVerdict(
	before: number[],
	after: number[],
	behaviorOk: boolean,
	options: { minEffect?: number; seed?: number } = {},
): TraceDiffVerdict {
	const comparison = pairedBootstrapImprovement(before, after, options);
	let status: TraceDiffVerdict['status'];
	if (!behaviorOk) {
		status = 'regressed';
	} else if (comparison.improved) {
		status = 'proven';
	} else if (comparison.ci_high < 0) {
		// The whole CI is on the worse side of zero (after > before) — a real
		// regression, distinct from "inside the band" inconclusive.
		status = 'regressed';
	} else {
		status = 'inconclusive';
	}
	return { comparison, status, behaviorOk };
}
