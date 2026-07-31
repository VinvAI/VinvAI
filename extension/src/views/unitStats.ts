/**
 * Per-unit runtime facts, computed from the captures.
 *
 * Every number here comes from the tracelens JSONL in `.vinv/captures` — the
 * evidence itself — and never from an exerciser's scorecard. That is a
 * deliberate reversal. The scorecard is a REPORT: a snapshot an exerciser wrote
 * about the units it drove, keyed by the label it displayed them under. Reading
 * it made three things structurally impossible:
 *
 *   - a unit no exerciser drove had no numbers at all, however much traffic the
 *     captures had recorded for it — which is most of a real repo, and all of
 *     production traffic;
 *   - CLI commands, workers, scheduled jobs and driven functions could not be
 *     described in the same terms as an HTTP route, because the scorecard's
 *     latency and status fields were written by the HTTP oracle;
 *   - the join had to go through a display label (`GET /items/{id}` with a
 *     service suffix when two services collide) rather than the entry-point id
 *     every view keys on, so rows silently dropped whenever the two spellings
 *     disagreed.
 *
 * The capture answers all three uniformly: an entry point's own handler spans
 * carry a duration and an outcome whatever kind of starting point it is, and
 * they are matched to the entry point by module + handler name — the same join
 * the hit count already used.
 *
 * What the captures CANNOT supply is an HTTP status code: tracelens records a
 * span's outcome (`status: ok | error` plus `error_type`), not the response
 * code the framework returned. So the outcome column is ok/raised, which is a
 * fact about every kind of unit, rather than a 200/500 histogram that would
 * only ever be populated for routes.
 *
 * The authority is `identification tracemap`, read from the insight manifest:
 * the engine owns the trace→unit join and computes coverage AND the latency
 * distribution there, so every Vinv surface quotes the same numbers instead of
 * each deriving its own. Reading the captures directly here is the fallback for
 * units the insight pass has not built yet — without it the panel goes blank
 * between a run finishing and the pass completing, which is exactly when
 * someone is looking at it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { entryPointFacts, type ComponentFacts, type EntryPointLike } from '../identification/entryPointHits';
import type { EndpointInsight } from '../harness/pipelineState';

/** Coverage of a unit's call tree, as the runtime overlay measured it. */
export interface UnitCoverage {
	executed: number;
	total: number;
	pct: number;
}

/** Everything the captures can say about one unit beyond its hit count. */
export interface UnitStats {
	coverage?: UnitCoverage;
	/** Median duration of this unit's own invocations, ms. */
	p50Ms?: number;
	p95Ms?: number;
	maxMs?: number;
	/** Of the total wall time, the part spent waiting rather than computing. */
	blockedMs?: number;
	/**
	 * Which pass produced the latency: the engine's runtime overlay (the
	 * authority every other Vinv surface quotes) or a direct read of the
	 * captures, used until the insight pass has built this unit.
	 */
	measuredBy?: 'overlay' | 'captures';
	/** Invocations that returned, and that raised. */
	ok?: number;
	error?: number;
	/** Exception types raised by the unit itself, worst first. */
	errorTypes?: string[];
	/** Runtime errors seen anywhere under this unit's call tree (overlay-wide). */
	errorCount?: number;
	/** True when a call-tree snapshot has been built and can be opened. */
	hasCallTree?: boolean;
	/** ISO timestamp of the insight build this row's coverage came from. */
	lastBuilt?: string;
}

/**
 * The p-th percentile of `values`, or undefined when there is nothing to take
 * one of. Nearest-rank on a sorted copy — the same method the exerciser used,
 * so a number that appears in both places reads the same.
 */
export function percentile(values: number[], p: number): number | undefined {
	if (values.length === 0) {
		return undefined;
	}
	const s = [...values].sort((a, b) => a - b);
	const at = Math.min(s.length - 1, Math.floor((s.length * p) / 100));
	return Math.round(s[at] * 10) / 10;
}

/** Turns one unit's captured spans into the numbers a view renders. */
export function statsFromFacts(facts: ComponentFacts): UnitStats {
	return {
		p50Ms: percentile(facts.durations, 50),
		p95Ms: percentile(facts.durations, 95),
		ok: facts.ok,
		error: facts.error,
		errorTypes: [...facts.errorTypes.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([type]) => type),
	};
}

/**
 * Merges what the engine measured with what the raw captures say.
 *
 * The manifest WINS. Its numbers come from `identification tracemap`, which
 * owns the trace→unit join and computes the distribution at the only level
 * where "one invocation of this unit" is defined; every other consumer of that
 * join (the exerciser's coverage, smoke reports, the runtime MCP tools) reads
 * the same engine, so a p95 quoted here matches a p95 quoted there.
 *
 * The capture-derived facts are the FALLBACK, for units the insight pass has
 * not built yet. Without them the panel would go blank between a run finishing
 * and the pass completing — which is exactly when someone is watching it.
 *
 * Coverage is taken only when it has a denominator: 0/0 means the static tree
 * could not be built, which is not the claim "none of it ran" and must not
 * render as 0%.
 */
export function joinUnitStats(
	facts: Map<string, ComponentFacts>,
	insights: EndpointInsight[],
): Map<string, UnitStats> {
	const byId = new Map<string, UnitStats>();
	for (const [id, f] of facts) {
		byId.set(id, { ...statsFromFacts(f), measuredBy: 'captures' });
	}
	for (const insight of insights) {
		const s = byId.get(insight.id) ?? {};
		s.errorCount = insight.errorCount;
		s.hasCallTree = Boolean(insight.calltreePath);
		s.lastBuilt = insight.lastBuilt;
		if (insight.coverage && insight.coverage.total > 0) {
			s.coverage = {
				executed: insight.coverage.executed,
				total: insight.coverage.total,
				pct: insight.coverage.pct,
			};
		}
		if (insight.latency && insight.latency.calls > 0) {
			s.p50Ms = insight.latency.p50Ms;
			s.p95Ms = insight.latency.p95Ms;
			s.maxMs = insight.latency.maxMs;
			s.blockedMs = insight.latency.blockedMs;
			s.ok = insight.latency.ok;
			s.error = insight.latency.error;
			s.errorTypes = insight.latency.errorTypes;
			s.measuredBy = 'overlay';
		}
		byId.set(insight.id, s);
	}
	return byId;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Reads the captures (and the insight manifest for coverage) and returns the
 * per-unit stats, keyed by entry-point id.
 *
 * `traceFile` restricts the read to one capture — the Traces panel's time
 * window filter passes the trimmed trace it built, so the percentiles describe
 * the selected range and not all history.
 */
export function readUnitStats(
	workspaceRoot: string,
	units: EntryPointLike[],
	traceFile?: string,
): Map<string, UnitStats> {
	const manifest = readJson(path.join(workspaceRoot, '.vinv', 'reports', 'index.json')) as {
		endpoints?: EndpointInsight[];
	} | null;
	return joinUnitStats(
		entryPointFacts(workspaceRoot, units, traceFile),
		Array.isArray(manifest?.endpoints) ? manifest.endpoints : [],
	);
}
