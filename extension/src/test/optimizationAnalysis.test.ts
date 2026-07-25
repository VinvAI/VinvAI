/**
 * Tests for the optimization analyzer: recoverable-time ranking (hot ≠
 * optimizable), the waste-signal selection, and the predicted→proven loop's
 * freeze / reconcile with an honest noise band.
 */
import * as assert from 'assert';
import type { GraphEdge, GraphNode } from '../graph/indexGraph';
import type { CacheCandidate, SymbolSessionTiming } from '../harness/runtimeAnalysis';
import {
	computeOptimizationCandidates,
	markDispatched,
	noiseBand,
	reconcileOutcome,
	type OptimizationCandidate,
} from '../harness/optimizationAnalysis';

function node(row: number, name: string): GraphNode {
	return {
		row,
		id: `id${row}`,
		file: `pkg/mod${row}.py`,
		lang: 'python',
		kind: 'function',
		name,
		start_line: row + 1,
		end_line: row + 10,
		summary: '',
		rank: 0.5,
		epoch: 1,
		parent: null,
		layer: 'service',
	};
}

function timing(session: string, total_ms: number, calls: number): SymbolSessionTiming {
	return { session, total_ms, calls };
}

const NODES = [
	node(0, 'handler'),
	node(1, 'get_docs'),
	node(2, 'serialize'),
	node(3, 'already_optimal'),
];

/** handler invokes serialize (makes serialize a fan-out callee). */
const EDGES: GraphEdge[] = [{ src: 0, dst: 2, kind: 'invoke' }];

function baseTimings(): Map<number, SymbolSessionTiming[]> {
	return new Map<number, SymbolSessionTiming[]>([
		[0, [timing('s1', 100, 1)]], // slow per call (cumulative)
		[1, [timing('s1', 200, 100)]], // cache waste
		[2, [timing('s1', 120, 500)]], // called 500× under one handler call → fan-out
		[3, [timing('s1', 50, 50)]], // 1ms/call, below the typical — no removable overhead
	]);
}

function cacheFor(): Map<number, CacheCandidate> {
	const c: CacheCandidate = {
		row: 1,
		name: 'get_docs',
		file: 'pkg/mod1.py',
		line: 2,
		calls: 100,
		distinct_args: 10,
		reclaimable_ms: 150,
		share: 1,
	};
	return new Map([[1, c]]);
}

suite('optimizationAnalysis: recoverable-time ranking', () => {
	function candidates(): OptimizationCandidate[] {
		return computeOptimizationCandidates({
			nodes: NODES,
			edges: EDGES,
			timings: baseTimings(),
			cacheByRow: cacheFor(),
		});
	}

	test('a hot-but-already-optimal symbol is excluded (hot ≠ optimizable)', () => {
		assert.ok(
			!candidates().some((c) => c.row === 3),
			'already_optimal has no removable overhead and must not be surfaced',
		);
	});

	test('duplicate recomputation is surfaced as a cache candidate at its reclaimable ms', () => {
		const c = candidates().find((x) => x.row === 1);
		assert.ok(c, 'get_docs should be a candidate');
		assert.strictEqual(c!.waste_kind, 'cache');
		assert.strictEqual(Math.round(c!.predicted_ms), 150);
		assert.match(c!.reason, /cacheable/);
	});

	test('a callee invoked many times per caller is flagged as a fan-out', () => {
		const c = candidates().find((x) => x.row === 2);
		assert.ok(c, 'serialize should be a candidate');
		assert.strictEqual(c!.waste_kind, 'fanout');
		assert.ok(c!.predicted_ms > 100, 'most of the 120ms is collapsible');
	});

	test('candidates rank by predicted recoverable time, highest first', () => {
		const list = candidates();
		for (let i = 1; i < list.length; i++) {
			assert.ok(
				list[i - 1].predicted_ms >= list[i].predicted_ms,
				'list must be sorted by predicted_ms desc',
			);
		}
		assert.strictEqual(list[0].row, 1, 'the 150ms cache win outranks the others');
	});
});

suite('optimizationAnalysis: noise band', () => {
	test('empty baseline has no band; a single sample gets a 10% tolerance', () => {
		assert.strictEqual(noiseBand([]), 0);
		assert.strictEqual(noiseBand([200]), 20);
	});

	test('a flat baseline has a zero band; a spread one scales the MAD', () => {
		assert.strictEqual(noiseBand([100, 100, 100]), 0);
		assert.ok(Math.abs(noiseBand([90, 100, 110]) - 14.826) < 0.001);
	});
});

suite('optimizationAnalysis: predicted → proven loop', () => {
	const candidate: OptimizationCandidate = {
		row: 1,
		name: 'get_docs',
		file: 'pkg/mod1.py',
		line: 2,
		total_ms: 200,
		calls: 100,
		waste_prior: 0.75,
		predicted_ms: 150,
		waste_kind: 'cache',
		reason: 'recomputes identical inputs',
		status: 'candidate',
	};

	test('dispatch freezes the before-cost and the noise band', () => {
		const d = markDispatched(candidate, [timing('s1', 200, 100)], 'Optimize get_docs');
		assert.strictEqual(d.status, 'dispatched');
		assert.strictEqual(d.outcome!.measured_before, 200);
		assert.strictEqual(d.outcome!.before_session, 's1');
		assert.strictEqual(d.outcome!.noise_band_ms, 20); // single-sample 10% floor
	});

	test('no fresh capture yet → the candidate keeps waiting', () => {
		const d = markDispatched(candidate, [timing('s1', 200, 100)], 't');
		const still = reconcileOutcome(d, [timing('s1', 200, 100)], true);
		assert.strictEqual(still.status, 'dispatched');
	});

	test('a drop beyond the band with clean behavior is PROVEN', () => {
		const d = markDispatched(candidate, [timing('s1', 200, 100)], 't');
		const done = reconcileOutcome(d, [timing('s1', 200, 100), timing('s2', 40, 100)], true);
		assert.strictEqual(done.status, 'proven');
		assert.strictEqual(done.outcome!.delta_ms, -160);
		assert.strictEqual(done.outcome!.measured_after, 40);
	});

	test('a drop inside the band is INCONCLUSIVE (no false proof)', () => {
		const d = markDispatched(candidate, [timing('s1', 200, 100)], 't');
		const done = reconcileOutcome(d, [timing('s1', 200, 100), timing('s2', 190, 100)], true);
		assert.strictEqual(done.status, 'inconclusive');
	});

	test('new errors on the symbol disqualify any timing claim → REGRESSED', () => {
		const d = markDispatched(candidate, [timing('s1', 200, 100)], 't');
		const done = reconcileOutcome(d, [timing('s1', 200, 100), timing('s2', 40, 100)], false);
		assert.strictEqual(done.status, 'regressed');
		assert.strictEqual(done.outcome!.behavior_ok, false);
	});
});
