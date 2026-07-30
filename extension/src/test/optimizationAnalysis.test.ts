/**
 * Tests for the optimization analyzer: recoverable-time ranking (hot ≠
 * optimizable), the waste-signal selection, and the predicted→proven loop's
 * freeze / reconcile with an honest noise band.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GraphEdge, GraphNode } from '../graph/indexGraph';
import {
	chainStatus,
	collectGcPressure,
	collectSymbolTimings,
	describeLineage,
	selectionStage,
	unbounded,
	type Bounded,
	type CacheCandidate,
	type SymbolSessionTiming,
	type TraceSpan,
} from '../harness/runtimeAnalysis';
import {
	appendOptimizeAttempt,
	attemptKey,
	candidateAttemptKeys,
	composePriorAttemptSeed,
	computeOptimizationCandidates,
	loadOptimizationCalibration,
	loadPriorOptimizeAttempts,
	markDispatched,
	noiseBand,
	opportunitySignature,
	optimizationCalibrationPath,
	optimizeAttemptsPath,
	reconcileOutcome,
	recordCandidateSightings,
	traceRelativeSpread,
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

function cacheFor(): Bounded<CacheCandidate> {
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
	// `unbounded`, not a bare list: these fixtures ARE the complete candidate
	// set, and the analyzer now inherits whatever bound produced its input, so a
	// test must say which it is rather than leave it to be assumed.
	return unbounded([c], 'cache-pareto');
}

suite('optimizationAnalysis: recoverable-time ranking', () => {
	function candidates(): OptimizationCandidate[] {
		return computeOptimizationCandidates({
			nodes: NODES,
			edges: EDGES,
			timings: baseTimings(),
			cache: cacheFor(),
		}).items;
	}

	test('a lifetime frame is excluded from EVERY waste kind, not just cache', () => {
		// Regression: gating collectCacheCandidates alone left per-call/fanout/
		// staircase dispatchable, because those are derived here from `timings`.
		// Live consequence on the embedder capture: _cmd_serve posted as
		// "10738.8ms per call (self) — 148428.8× the typical symbol; unexpectedly
		// slow for the work it does" — backwards for a serve loop that is meant to
		// span the run. Row 1 has a measured cache candidate AND outlier timings,
		// so it would qualify on more than one signal if the gate missed a kind.
		const gated = computeOptimizationCandidates({
			nodes: NODES,
			edges: EDGES,
			timings: baseTimings(),
			cache: cacheFor(),
			lifetimeRows: new Set([1]),
		}).items;
		assert.ok(
			!gated.some((c) => c.row === 1),
			'a lifetime frame must not surface under any waste kind',
		);
		// The gate must be surgical: everything else still ranks as before.
		assert.deepStrictEqual(
			gated.map((c) => c.row),
			candidates()
				.map((c) => c.row)
				.filter((r) => r !== 1),
			'gating one row must not disturb the ranking of the others',
		);
	});

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

suite('selection lineage: bounds compose and the least certain wins', () => {
	const stage = (
		name: string,
		stopped_by: 'coverage' | 'cap' | 'exhausted',
		returned: number,
		total: number,
	) =>
		selectionStage(name, {
			returned,
			total,
			coverage_achieved: total > 0 ? returned / total : 0,
			stopped_by,
			droppedMagnitude: (total - returned) * 10,
			unit: 'ms' as const,
		});

	test('a cap ANYWHERE poisons the chain, even behind a later coverage stop', () => {
		// The case a flat per-call stat could not express at all. The cache Pareto
		// runs out of slots, then the waste ranking stops on measured coverage —
		// and a reader shown only the last stage would be told the result is
		// bounded by something that measured what it dropped. It is not: nothing
		// measured the 192 the first stage never looked past.
		assert.strictEqual(
			chainStatus([stage('cache-pareto', 'cap', 8, 200), stage('optimization-rank', 'coverage', 6, 11)]),
			'cap',
		);
		// Order does not matter — absorbing, not last-wins.
		assert.strictEqual(
			chainStatus([stage('cache-pareto', 'coverage', 4, 24), stage('optimization-rank', 'cap', 6, 11)]),
			'cap',
		);
		assert.strictEqual(
			chainStatus([stage('cache-pareto', 'coverage', 4, 24), stage('optimization-rank', 'exhausted', 4, 4)]),
			'coverage',
		);
		// Only when nothing anywhere dropped is the whole chain complete.
		assert.strictEqual(
			chainStatus([stage('a', 'exhausted', 4, 4), stage('b', 'exhausted', 4, 4)]),
			'exhausted',
		);
		// Same monoid as mergeExitOutcome/mergeContainment: the pessimistic value
		// wins, because overstating certainty costs more than understating it.
	});

	test('the rendering names the SOURCE population, not the last survivor count', () => {
		const line = describeLineage(
			[stage('cache-pareto', 'cap', 8, 200), stage('optimization-rank', 'coverage', 6, 11)],
			'candidate',
		);
		// "6 of 200", never "6 of 11" — 11 is already a survivor count, and
		// printing it as the population is precisely the defect.
		assert.ok(line.startsWith('6 of 200 candidate(s)'), line);
		assert.match(line, /NOT KNOWN TO BE COMPLETE/);
		assert.match(line, /cache-pareto STOPPED AT ITS ITEM CAP, dropping 192/);
		// Both stages are named, so the reader can see WHERE it narrowed.
		assert.match(line, /optimization-rank dropped 5/);
		// The residual magnitude makes the claim checkable rather than asserted.
		assert.match(line, /1920ms combined/);
	});

	test('a complete chain says so plainly, with no bound language', () => {
		const line = describeLineage([stage('cache-pareto', 'exhausted', 4, 4)], 'candidate');
		assert.strictEqual(line, '4 candidate(s)');
	});

	test('the analyzer INHERITS its input bound instead of replacing it', () => {
		// The stacked-truncation defect, as a test. The cache stage dropped 20 of
		// 24 before the analyzer saw anything; a board reporting only the ranking
		// stage would state 4 as the population.
		const capped: Bounded<CacheCandidate> = {
			items: cacheFor().items,
			lineage: [stage('cache-pareto', 'cap', 4, 24)],
		};
		const out = computeOptimizationCandidates({
			nodes: NODES,
			edges: EDGES,
			timings: baseTimings(),
			cache: capped,
		});
		assert.strictEqual(out.lineage.length, 2, 'both stages must survive');
		assert.strictEqual(out.lineage[0].stage, 'cache-pareto');
		assert.strictEqual(out.lineage[1].stage, 'optimization-rank');
		// And the upstream cap governs the whole chain even though this ranking
		// exhausted its own input.
		assert.strictEqual(chainStatus(out.lineage), 'cap');
		assert.ok(describeLineage(out.lineage, 'candidate').includes('of 24'));
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

	test('the trace-derived floor lifts a degenerate MAD band to the smallest detectable delta', () => {
		// Three sessions that happen to repeat exactly give MAD 0 — but the trace
		// as a whole jitters 10%, so no delta under median×0.1 is distinguishable.
		assert.strictEqual(noiseBand([100, 100, 100], 0.1), 10);
		// A healthy MAD above the floor stands unchanged.
		assert.ok(Math.abs(noiseBand([90, 100, 110], 0.001) - 14.826) < 0.001);
		// A single sample uses the derived factor instead of the 10% prior.
		assert.strictEqual(noiseBand([200], 0.05), 10);
		// A genuinely repeatable trace (derived factor 0) keeps the honest zero.
		assert.strictEqual(noiseBand([100, 100, 100], 0), 0);
	});

	test('traceRelativeSpread derives the factor from ALL symbols with ≥2 sessions', () => {
		const timings = new Map<number, SymbolSessionTiming[]>([
			// med 100, MAD 10 → scaled 14.826 → relative 0.14826
			[0, [timing('s1', 90, 1), timing('s2', 100, 1), timing('s3', 110, 1)]],
			// perfectly flat → relative 0
			[1, [timing('s1', 200, 1), timing('s2', 200, 1)]],
			// single session → no spread to observe, excluded
			[2, [timing('s1', 50, 1)]],
		]);
		const f = traceRelativeSpread(timings)!;
		// median of [0.14826, 0] on two entries = midpoint
		assert.ok(Math.abs(f - 0.07413) < 0.0005);
		// No symbol with two sessions → nothing to derive from.
		assert.strictEqual(
			traceRelativeSpread(new Map([[2, [timing('s1', 50, 1)]]])),
			undefined,
		);
	});

	test('markDispatched freezes the floored band', () => {
		const c: OptimizationCandidate = {
			row: 1,
			name: 'get_docs',
			file: 'pkg/mod1.py',
			line: 2,
			total_ms: 100,
			calls: 10,
			waste_prior: 0.5,
			predicted_ms: 50,
			waste_kind: 'cache',
			reason: '',
			status: 'candidate',
		};
		const sessions = [timing('s1', 100, 10), timing('s2', 100, 10), timing('s3', 100, 10)];
		const d = markDispatched(c, sessions, 't', 0.1);
		assert.strictEqual(d.outcome!.noise_band_ms, 10, 'flat baseline floored at median × derived spread');
	});
});

suite('optimizationAnalysis: Amdahl ceiling', () => {
	test('a single candidate owning the whole trace gets 1/(1 − waste_prior)', () => {
		const nodes = [node(0, 'handler'), node(1, 'get_docs')];
		const timings = new Map<number, SymbolSessionTiming[]>([[1, [timing('s1', 100, 10)]]]);
		const cache: CacheCandidate = {
			row: 1,
			name: 'get_docs',
			file: 'pkg/mod1.py',
			line: 2,
			calls: 10,
			distinct_args: 5,
			reclaimable_ms: 50,
			share: 1,
		};
		const [c] = computeOptimizationCandidates({
			nodes,
			edges: [],
			timings,
			cache: unbounded([cache], 'cache-pareto'),
		}).items;
		// share = 1, waste_prior = 0.5 → ceiling = 1/(1 − 0.5) = 2×.
		assert.ok(Math.abs(c.amdahl_ceiling! - 2) < 1e-9);
	});

	test('share is relative to the trace: every candidate carries a finite ceiling ≥ 1', () => {
		const list = computeOptimizationCandidates({
			nodes: NODES,
			edges: EDGES,
			timings: baseTimings(),
			cache: cacheFor(),
		}).items;
		assert.ok(list.length >= 2);
		const total = list.reduce((s, c) => s + c.predicted_ms_effective!, 0);
		for (const c of list) {
			const share = c.predicted_ms_effective! / total;
			// The candidates here span the whole predicted total, so share is exact.
			assert.ok(
				Math.abs(c.amdahl_ceiling! - 1 / (1 - share * c.waste_prior)) < 1e-6,
				'ceiling = 1/(1 − share·waste_prior)',
			);
			assert.ok(c.amdahl_ceiling! >= 1 && Number.isFinite(c.amdahl_ceiling!));
		}
	});
});

suite('optimizationAnalysis: calibration deflation at ranking time', () => {
	test('shrunk_ratio deflates predicted_ms for ranking while the raw value stays exposed', () => {
		// Uncalibrated: the 150ms cache win outranks the ~120ms fan-out. Full
		// coverage so the deflated candidate stays inspectable below the Pareto cut.
		const plain = computeOptimizationCandidates({
			nodes: NODES,
			edges: EDGES,
			timings: baseTimings(),
			cache: cacheFor(),
			coverage: 1,
		}).items;
		assert.strictEqual(plain[0].row, 1);
		assert.strictEqual(plain[0].predicted_ms_effective, plain[0].predicted_ms, 'no calibration → effective = raw');
		// History says cache predictions land at 10% of the claim → the fan-out
		// takes the top slot; raw and effective are BOTH on the candidate.
		const calibrated = computeOptimizationCandidates({
			nodes: NODES,
			edges: EDGES,
			timings: baseTimings(),
			cache: cacheFor(),
			coverage: 1,
			calibration: { cache: 0.1 },
		}).items;
		assert.strictEqual(calibrated[0].row, 2, 'the deflated cache claim no longer outranks the fan-out');
		const cache = calibrated.find((c) => c.row === 1)!;
		assert.strictEqual(Math.round(cache.predicted_ms), 150, 'raw survives for the proof loop');
		assert.strictEqual(Math.round(cache.predicted_ms_effective!), 15, 'ranking used the calibrated value');
	});

	test('loadOptimizationCalibration reads the artifact and rejects junk', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-calib-'));
		try {
			assert.strictEqual(loadOptimizationCalibration(root), undefined, 'absent file → undefined (ratio 1)');
			const file = optimizationCalibrationPath(root);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				JSON.stringify({
					updated_at: '2026-07-25T00:00:00Z',
					by_waste_kind: {
						cache: { n: 4, mean_ratio: 0.6, shrunk_ratio: 0.5 },
						fanout: { n: 1, mean_ratio: -3, shrunk_ratio: -3 }, // invalid → dropped
						'per-call': { n: 2, mean_ratio: 1.2, shrunk_ratio: 'NaN' }, // invalid → dropped
					},
				}),
			);
			assert.deepStrictEqual(loadOptimizationCalibration(root), { cache: 0.5 });
			fs.writeFileSync(file, 'not json');
			assert.strictEqual(loadOptimizationCalibration(root), undefined, 'malformed → undefined, never a crash');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

suite('optimizationAnalysis: attempt-history store (doom-loop guard)', () => {
	const SIG = opportunitySignature({ kind: 'latency-symbol', endpoint_id: 'get_docs' });

	function tempRoot(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-attempts-'));
	}

	function append(root: string, at: number, learning: string): void {
		appendOptimizeAttempt(root, {
			row: 5,
			signature: SIG,
			approach: `Optimize get_docs — attempt ${at}`,
			comparison: { rel_improvement: 0, improved: false },
			verdict: 'reverted-no-gain',
			learning,
			at,
		});
	}

	test('attempts persist and reload keyed by (row, signature)', () => {
		const root = tempRoot();
		try {
			append(root, 1000, 'tried memoization — CI included zero');
			append(root, 1001, 'tried batching — CI included zero');
			// Same signature, DIFFERENT row → a different key entirely.
			appendOptimizeAttempt(root, {
				row: 9,
				signature: SIG,
				approach: 'other row',
				comparison: null,
				verdict: 'accepted',
				learning: 'other row won',
				at: 1002,
			});
			const loaded = loadPriorOptimizeAttempts(root, 5, SIG);
			assert.strictEqual(loaded.length, 2, 'reload sees exactly this key');
			assert.strictEqual(loaded[0].learning, 'tried memoization — CI included zero');
			assert.strictEqual(loaded[1].learning, 'tried batching — CI included zero');
			const seed = composePriorAttemptSeed(loaded)!;
			assert.ok(seed.includes('tried memoization') && seed.includes('tried batching'));
			assert.ok(seed.includes('materially different'), 'the seed carries the instruction');
			assert.strictEqual(composePriorAttemptSeed([]), undefined, 'no history → no seed');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('a key unsighted for 3 fresh capture sessions expires (and is compacted away)', () => {
		const root = tempRoot();
		try {
			append(root, 1000, 'stale learning');
			const key = attemptKey(5, SIG);
			// Two fresh sessions without the candidate: still alive.
			recordCandidateSightings(root, '/caps/s1/svc', [], 1001);
			recordCandidateSightings(root, '/caps/s2/svc', [], 1002);
			assert.strictEqual(loadPriorOptimizeAttempts(root, 5, SIG).length, 1, 'missed 2 sessions → alive');
			// The third absent session crosses the relative-expiry threshold.
			recordCandidateSightings(root, '/caps/s3/svc', [], 1003);
			assert.strictEqual(loadPriorOptimizeAttempts(root, 5, SIG).length, 0, 'missed 3 sessions → expired');
			const rawFile = fs.readFileSync(optimizeAttemptsPath(root), 'utf8');
			assert.ok(!rawFile.includes(key), 'compaction rewrote the expired lines away');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('a sighting resets the expiry clock; re-sighted keys never expire', () => {
		const root = tempRoot();
		try {
			append(root, 1000, 'still-relevant learning');
			const key = attemptKey(5, SIG);
			recordCandidateSightings(root, '/caps/s1/svc', [], 1001); // absent
			recordCandidateSightings(root, '/caps/s2/svc', [key], 1002); // SIGHTED — clock resets
			recordCandidateSightings(root, '/caps/s3/svc', [], 1003); // absent
			recordCandidateSightings(root, '/caps/s4/svc', [], 1004); // absent (2 since sighting)
			assert.strictEqual(loadPriorOptimizeAttempts(root, 5, SIG).length, 1, 'only 2 misses since the last sighting');
			// A session whose trace merely grows must not double-count.
			recordCandidateSightings(root, '/caps/s4/svc', [], 1005);
			assert.strictEqual(loadPriorOptimizeAttempts(root, 5, SIG).length, 1, 'the same session never counts twice');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('candidateAttemptKeys mirrors the dispatch-side opportunity identities', () => {
		const list = computeOptimizationCandidates({
			nodes: NODES,
			edges: EDGES,
			timings: baseTimings(),
			cache: cacheFor(),
		}).items;
		const keys = candidateAttemptKeys(list);
		const cacheRow = list.find((c) => c.waste_kind === 'cache')!;
		assert.ok(
			keys.includes(
				attemptKey(cacheRow.row, opportunitySignature({ kind: 'latency-symbol', endpoint_id: cacheRow.name })),
			),
			'panel-row dispatch key present',
		);
		assert.ok(
			keys.includes(attemptKey(undefined, opportunitySignature({ kind: 'hotspot-sweep', endpoint_id: 'hotspots' }))),
			'hotspot-sweep key present while any candidate exists',
		);
		assert.ok(
			keys.includes(
				attemptKey(undefined, opportunitySignature({ kind: 'cache-sweep', endpoint_id: 'cache-candidates' })),
			),
			'cache-sweep key present while a cache candidate exists',
		);
		assert.deepStrictEqual(candidateAttemptKeys([]), [], 'no candidates → nothing sighted');
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

	test('a big drop with NO code change is DISMISSED, not proven (watcher integrity)', () => {
		const d = markDispatched(candidate, [timing('s1', 200, 100)], 't');
		// The same 160ms drop that reads PROVEN above — but with no file diff the
		// move is cold→warm variance, not a fix, so it must never be credited.
		const done = reconcileOutcome(d, [timing('s1', 200, 100), timing('s2', 40, 100)], true, false);
		assert.strictEqual(done.status, 'dismissed');
		assert.ok(
			done.outcome!.dismiss_note && done.outcome!.dismiss_note.includes('No code change'),
			'dismiss note explains why',
		);
		assert.strictEqual(done.outcome!.measured_after, 40);
	});

	test('the same drop WITH a code change is still PROVEN (gate open by default)', () => {
		const d = markDispatched(candidate, [timing('s1', 200, 100)], 't');
		const done = reconcileOutcome(d, [timing('s1', 200, 100), timing('s2', 40, 100)], true, true);
		assert.strictEqual(done.status, 'proven');
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

// ---------------------------------------------------------------------------
// Wave-2 detectors: unexplained wait (§1.5 queueing / §2.5 lock-wait) and GC
// pressure (§20).
// ---------------------------------------------------------------------------

/** TraceSpan fixture: non-errored, non-I/O by default. */
function span(
	row: number | null,
	component: string,
	startMs: number,
	durationMs: number,
	opts: Partial<TraceSpan> = {},
): TraceSpan {
	return {
		row,
		component,
		startMs,
		durationMs,
		errored: false,
		io: false,
		blockedMs: 0,
		children: [],
		...opts,
	};
}

/** A handler call at `start` with two 4ms db children and the given duration. */
function handlerCall(start: number, durationMs: number, opts: Partial<TraceSpan> = {}): TraceSpan {
	const h = span(0, 'pkg.mod0.handler', start, durationMs, opts);
	h.children.push(span(1, 'pkg.mod1.db', start + 1, 4));
	h.children.push(span(1, 'pkg.mod1.db', start + 5, 4));
	return h;
}

suite('optimizationAnalysis: unexplained-wait detector', () => {
	const nodes = [node(0, 'handler'), node(1, 'db')];

	function waitCandidates(spans: TraceSpan[]): OptimizationCandidate[] {
		// handler: 4 calls, 130ms total; db: 8 calls, 32ms — matches the span
		// fixture so per-call competition is realistic, not degenerate.
		const timings = new Map<number, SymbolSessionTiming[]>([
			[0, [timing('s1', 130, 4)]],
			[1, [timing('s1', 32, 8)]],
		]);
		return computeOptimizationCandidates({
			nodes,
			edges: [],
			timings,
			cache: unbounded([], 'cache-pareto'),
			spans,
		}).items;
	}

	test('a call whose duration neither callees nor typical self-work explain is flagged', () => {
		// Three requests behave (self 2ms); the fourth waits 90ms beyond typical
		// with the SAME callees — the queueing / lock-contention shape.
		const spans = [
			handlerCall(0, 10),
			handlerCall(100, 10),
			handlerCall(200, 10),
			handlerCall(300, 100),
		];
		const c = waitCandidates(spans).find((x) => x.row === 0);
		assert.ok(c, 'the waiting handler must surface');
		assert.strictEqual(c!.waste_kind, 'wait');
		// self on the slow call = 100 − 8 = 92; typical self (median) = 2 → 90.
		assert.ok(Math.abs(c!.predicted_ms - 90) < 1e-6, `predicted ${c!.predicted_ms}`);
		assert.match(c!.reason, /neither its callees nor I\/O explain/);
	});

	test('negative: when the children explain the long call, no wait is claimed', () => {
		// The slow request is slow because its CALLEES are slow (2×49ms I/O
		// reads) — the handler's own self time stays typical, so there is no
		// unexplained gap anywhere: the parent's time is explained by children,
		// the children's by their io flag (the staircase detector's clock).
		const slow = span(0, 'pkg.mod0.handler', 300, 100);
		slow.children.push(span(1, 'pkg.mod1.db', 301, 49, { io: true }));
		slow.children.push(span(1, 'pkg.mod1.db', 351, 49, { io: true }));
		const spans = [handlerCall(0, 10), handlerCall(100, 10), handlerCall(200, 10), slow];
		assert.ok(
			!waitCandidates(spans).some((c) => c.waste_kind === 'wait'),
			'children-explained time must not be reported as unexplained wait',
		);
	});

	test('negative: a wait the io flag already explains belongs to the staircase detector', () => {
		const spans = [
			handlerCall(0, 10),
			handlerCall(100, 10),
			handlerCall(200, 10),
			handlerCall(300, 100, { io: true }),
		];
		assert.ok(
			!waitCandidates(spans).some((c) => c.waste_kind === 'wait'),
			'blocked_ms-derived I/O wait must not double-report as lock/queue wait',
		);
	});
});

suite('optimizationAnalysis: gc-pressure detector', () => {
	const gcNodes = [node(0, 'ingest'), node(1, 'lookup'), node(2, 'render')];

	function gcTiming(
		total_ms: number,
		calls: number,
		alloc_bytes: number,
		gc?: { ms: number; count: number },
	): SymbolSessionTiming {
		return {
			session: 's1',
			total_ms,
			calls,
			alloc_bytes,
			...(gc ? { gc_pause_ms: gc.ms, gc_pause_count: gc.count } : {}),
		};
	}

	function gcCandidates(gc?: { ms: number; count: number }): OptimizationCandidate[] {
		// ingest allocates 90% of traced bytes; the session's GC total (60ms)
		// out-costs the trace's typical symbol (median cost 30ms).
		const timings = new Map<number, SymbolSessionTiming[]>([
			[0, [gcTiming(80, 40, 9_000_000, gc)]],
			[1, [gcTiming(30, 10, 500_000, gc)]],
			[2, [gcTiming(20, 5, 500_000, gc)]],
		]);
		return computeOptimizationCandidates({
			nodes: gcNodes,
			edges: [],
			timings,
			cache: unbounded([], 'cache-pareto'),
		}).items;
	}

	test('an outlier GC total flags the top allocator, bounded by its GC share', () => {
		const list = gcCandidates({ ms: 60, count: 12 });
		const c = list.find((x) => x.row === 0);
		assert.ok(c, 'the top allocator must surface');
		assert.strictEqual(c!.waste_kind, 'gc-pressure');
		// 60ms of GC × 90% allocation share = 54ms recoverable.
		assert.ok(Math.abs(c!.predicted_ms - 54) < 1e-6, `predicted ${c!.predicted_ms}`);
		assert.match(c!.reason, /garbage collection pauses/);
		assert.match(c!.reason, /reduce allocations/);
		// Small allocators never carry the flag, even in a flagged session.
		assert.ok(!list.some((x) => x.row !== 0 && x.waste_kind === 'gc-pressure'));
	});

	test('negative: no gc_pause events → the kind never fires', () => {
		assert.ok(!gcCandidates(undefined).some((c) => c.waste_kind === 'gc-pressure'));
	});

	test('negative: GC below the typical symbol cost is not an outlier', () => {
		// 10ms of GC against a 30ms median symbol — GC is cheap here, relative
		// to this trace's own cost distribution.
		assert.ok(!gcCandidates({ ms: 10, count: 3 }).some((c) => c.waste_kind === 'gc-pressure'));
	});
});

suite('runtimeAnalysis: gc_pause parsing and the timings channel', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-gc-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writeTrace(lines: string[]): void {
		const d = path.join(root, '.vinv', 'captures', 'r1', 'svc');
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, 'trace.jsonl'), lines.join('\n') + '\n');
	}

	test('per-session GC totals join the shared session identity and ride on timings', () => {
		writeTrace([
			JSON.stringify({ event: 'gc_pause', ts: 'T', duration_ms: 2.5, generation: 0 }),
			JSON.stringify({ event: 'gc_pause', ts: 'T', duration_ms: 1.5, generation: 2, request_id: 'r' }),
			JSON.stringify({ component: 'pkg.mod0.handler', event: 'enter' }),
			JSON.stringify({ component: 'pkg.mod0.handler', event: 'exit', duration_ms: 5, mem_delta_bytes: 4096 }),
		]);
		const gc = collectGcPressure(root);
		assert.strictEqual(gc.size, 1);
		const [key, p] = [...gc.entries()][0];
		assert.match(key, /@\d+$/, 'gc sessions must use the <dir>@<mtime> identity');
		assert.strictEqual(p.count, 2);
		assert.ok(Math.abs(p.total_pause_ms - 4.0) < 1e-9);
		const t = collectSymbolTimings(root, [node(0, 'handler')]).get(0)![0];
		assert.strictEqual(t.gc_pause_count, 2);
		assert.ok(Math.abs((t.gc_pause_ms ?? 0) - 4.0) < 1e-9);
		assert.strictEqual(t.alloc_bytes, 4096);
	});

	test('a trace without gc_pause or memory data leaves the fields undefined', () => {
		writeTrace([
			JSON.stringify({ component: 'pkg.mod0.handler', event: 'enter' }),
			JSON.stringify({ component: 'pkg.mod0.handler', event: 'exit', duration_ms: 5, mem_delta_bytes: null }),
		]);
		assert.strictEqual(collectGcPressure(root).size, 0);
		const t = collectSymbolTimings(root, [node(0, 'handler')]).get(0)![0];
		assert.strictEqual(t.gc_pause_ms, undefined, 'no gc visibility must not read as 0ms');
		assert.strictEqual(t.alloc_bytes, undefined, 'memory axis off must not read as 0 bytes');
		assert.strictEqual(t.total_ms, 5);
	});
});
