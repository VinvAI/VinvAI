/**
 * Per-unit runtime facts, joined from the artifacts that already hold them.
 *
 * The Traces panel showed one number — hits — and nothing else, so a list of
 * everything the captures saw could not answer the first question anyone asks
 * of it: did it work, how fast was it, how much of it ran. Every one of those
 * facts was already on disk, in two different files, keyed two different ways:
 *
 *   - `.vinv/exercise/scorecard.json` — per unit DRIVEN by an exerciser (vinv's
 *     own or an external harness ingested through exerciseIngest): coverage,
 *     p50/p95 latency, the status-code distribution, checks and failures.
 *   - `.vinv/reports/index.json` (the insight manifest) — per unit the CAPTURES
 *     saw at all: runtime-overlay coverage, error count, and whether a call-tree
 *     snapshot exists to open.
 *
 * The two overlap but neither contains the other: a unit can be exercised
 * without a manifest entry (the pass has not run yet) and traced without ever
 * being exercised (production traffic, a bring-up smoke run). So both are read
 * and merged per unit, and the source of the coverage number is recorded —
 * "12/40 of the tree ran under this capture" and "the suite covered 12/40" are
 * different claims and the view must not present them as one.
 *
 * The join is deliberately forgiving about keys. The ingest path stamps
 * `api_id` on every scorecard row, so that is used when present; vinv's own
 * exerciser writes only the unit label (`GET /health`, `RUN acme-tool report`),
 * which is matched against the entry point's trigger. A row that matches
 * neither is dropped rather than guessed at.
 */

import * as fs from 'fs';
import * as path from 'path';

import { entryPointLabel } from '../identification/identification';
import type { EndpointInsight } from '../harness/pipelineState';

/** Coverage of a unit's call tree, and which pass measured it. */
export interface UnitCoverage {
	executed: number;
	total: number;
	pct: number;
	/**
	 * `exercised` — the exerciser drove this unit and measured what its inputs
	 * reached. `traced` — the runtime overlay measured what the captures
	 * happened to run. Never averaged together.
	 */
	source: 'exercised' | 'traced';
}

/** Everything the panel can say about one unit beyond its name and hit count. */
export interface UnitStats {
	coverage?: UnitCoverage;
	/** Median latency in ms, over the checks the exerciser ran. */
	p50Ms?: number;
	p95Ms?: number;
	/** Status code → count, e.g. `{ "200": 12, "500": 1 }`. `none` = never completed. */
	statuses?: Record<string, number>;
	/** Checks run against this unit, and how many of them failed. */
	checks?: number;
	failed?: number;
	/** Runtime errors seen anywhere under this unit's call tree. */
	errorCount?: number;
	/** True when a call-tree snapshot has been built and can be opened. */
	hasCallTree?: boolean;
	/** ISO timestamp of the insight build this row's overlay facts came from. */
	lastBuilt?: string;
}

/** The subset of a scorecard row this join reads. */
export interface ScorecardRow {
	endpoint?: string;
	api_id?: string;
	/** "covered/total" as the scorecard spells it. */
	coverage?: string;
	pct?: number;
	p50_ms?: number;
	p95_ms?: number;
	statuses?: Record<string, number>;
	checks?: number;
	failed?: number;
}

/** The subset of an entry point this join needs to key on. */
export interface UnitKey {
	id: string;
	trigger?: string | null;
	file?: string | null;
}

/** Parses the scorecard's "12/40" coverage spelling; undefined when unusable. */
function parseCoverage(text: string | undefined, pct: number | undefined): UnitCoverage | undefined {
	const m = /^(\d+)\s*\/\s*(\d+)$/.exec((text ?? '').trim());
	if (!m) {
		return undefined;
	}
	const executed = Number(m[1]);
	const total = Number(m[2]);
	if (total <= 0) {
		// 0/0 is not 0% coverage, it is no denominator — a unit whose static tree
		// could not be built. Rendering it as 0% reads as "nothing ran".
		return undefined;
	}
	return {
		executed,
		total,
		pct: typeof pct === 'number' ? pct : Math.round((executed / total) * 1000) / 10,
		source: 'exercised',
	};
}

/**
 * Merges scorecard rows and manifest entries into per-unit stats, keyed by
 * entry-point id.
 *
 * Pure: the caller supplies the parsed artifacts. The exerciser's numbers win
 * for coverage where both exist — it drove the unit deliberately and measured
 * the result, where the overlay only reports what a capture happened to catch.
 */
export function joinUnitStats(
	rows: ScorecardRow[],
	insights: EndpointInsight[],
	units: UnitKey[],
): Map<string, UnitStats> {
	const byId = new Map<string, UnitStats>();
	const stats = (id: string): UnitStats => {
		let s = byId.get(id);
		if (!s) {
			s = {};
			byId.set(id, s);
		}
		return s;
	};

	// The manifest first, so the exerciser's coverage can overwrite the overlay's.
	const known = new Set(units.map((u) => u.id));
	for (const insight of insights) {
		if (!known.has(insight.id) && units.length > 0) {
			continue; // a unit the current inventory no longer lists
		}
		const s = stats(insight.id);
		s.errorCount = insight.errorCount;
		s.hasCallTree = Boolean(insight.calltreePath);
		s.lastBuilt = insight.lastBuilt;
		if (insight.coverage && insight.coverage.total > 0) {
			s.coverage = { ...insight.coverage, source: 'traced' };
		}
	}

	// A label→id index for the scorecards that carry no api_id.
	const idByLabel = new Map<string, string>();
	for (const u of units) {
		for (const label of [u.trigger ?? '', entryPointLabel(u)]) {
			if (label && !idByLabel.has(label)) {
				idByLabel.set(label, u.id);
			}
		}
	}

	for (const row of rows) {
		const id =
			row.api_id && known.has(row.api_id)
				? row.api_id
				: (idByLabel.get((row.endpoint ?? '').trim()) ?? (row.api_id || ''));
		if (!id) {
			continue;
		}
		const s = stats(id);
		const covered = parseCoverage(row.coverage, row.pct);
		if (covered) {
			s.coverage = covered;
		}
		if (typeof row.p50_ms === 'number') {
			s.p50Ms = row.p50_ms;
		}
		if (typeof row.p95_ms === 'number') {
			s.p95Ms = row.p95_ms;
		}
		if (row.statuses && Object.keys(row.statuses).length > 0) {
			s.statuses = row.statuses;
		}
		if (typeof row.checks === 'number') {
			s.checks = row.checks;
		}
		if (typeof row.failed === 'number') {
			s.failed = row.failed;
		}
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
 * Reads both artifacts off disk and joins them. Returns an empty map when
 * neither exists — a workspace that has only just been traced is the normal
 * case, not an error.
 */
export function readUnitStats(workspaceRoot: string, units: UnitKey[]): Map<string, UnitStats> {
	const scorecard = readJson(
		path.join(workspaceRoot, '.vinv', 'exercise', 'scorecard.json'),
	) as { endpoints?: ScorecardRow[] } | null;
	const manifest = readJson(path.join(workspaceRoot, '.vinv', 'reports', 'index.json')) as {
		endpoints?: EndpointInsight[];
	} | null;
	return joinUnitStats(
		Array.isArray(scorecard?.endpoints) ? scorecard.endpoints : [],
		Array.isArray(manifest?.endpoints) ? manifest.endpoints : [],
		units,
	);
}
