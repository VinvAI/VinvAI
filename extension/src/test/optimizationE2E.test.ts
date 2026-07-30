/**
 * End-to-end test of the optimization pipeline against REAL on-disk artifacts:
 * a synthetic index store (chunks/edges/meta) plus raw capture traces written
 * to a temp workspace, driven through the exact code path the extension uses —
 * loadNodes → collectSymbolTimings/collectCacheCandidates (which read the trace
 * JSONL and join components to rows via buildComponentMatcher) →
 * computeOptimizationCandidates → the predicted→proven reconcile.
 *
 * The unit test (optimizationAnalysis.test.ts) drives the pure ranker with a
 * hand-built timings map; this one proves the DISK pipeline: the qualname join,
 * the nested-capture discovery, the errored-call exclusion, and the before/
 * after measurement across two real capture sessions. Its anchor case is the
 * exact defect the smolagents trace exposed — a symbol whose only call RAISED
 * (472ms of a failed model.generate) must never be offered as a hotspot.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	indexStoreDir,
	loadEdges,
	loadNodes,
	type GraphEdge,
} from '../graph/indexGraph';
import {
	collectCacheCandidates,
	collectRequestSpans,
	collectSymbolTimings,
	unbounded,
} from '../harness/runtimeAnalysis';
import {
	computeOptimizationCandidates,
	markDispatched,
	reconcileOutcome,
	type OptimizationStatus,
} from '../harness/optimizationAnalysis';
import {
	appendOptimizeEpisode,
	buildWorkspaceDeps,
	pairProbeSamples,
	runVerifiedOptimization,
	type FrozenProbeSet,
	type MetricComparison,
	type OptimizeAttempt,
	type OptimizeDispatchHooks,
	type OptimizeEngineDeps,
} from '../harness/exerciseOptimize';
import {
	appendOptimizeAttempt,
	loadPriorOptimizeAttempts,
	opportunitySignature,
	type PersistedOptimizeAttempt,
} from '../harness/optimizationAnalysis';
import type { ProbeMeasurement } from '../harness/probeRunner';
import { buildFindings } from '../views/findingsModel';

interface TraceEvent {
	component: string;
	event: 'enter' | 'exit';
	args_hash?: string;
	result_hash?: string;
	duration_ms?: number;
	error_type?: string | null;
	determinism_sources?: unknown[];
}

const SYMBOLS = ['handler', 'get_docs', 'serialize', 'already_fast', 'broken_call'];

function writeStore(root: string): void {
	const store = indexStoreDir(root);
	fs.mkdirSync(store, { recursive: true });
	const chunks = SYMBOLS.map((name, i) => ({
		id: `id${i}`,
		file: 'src/app/svc.py',
		lang: 'python',
		kind: 'function',
		name,
		start_line: i * 10 + 1,
		end_line: i * 10 + 9,
		summary: '',
		rank: 0.5,
		epoch: 1,
		parent: null,
	}));
	fs.writeFileSync(path.join(store, 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
	// handler invokes get_docs, serialize, broken_call — serialize's fan-out
	// (50 calls under handler's 1) is what makes it a fan-out candidate.
	const edges: GraphEdge[] = [
		{ src: 0, dst: 1, kind: 'invoke' },
		{ src: 0, dst: 2, kind: 'invoke' },
		{ src: 0, dst: 4, kind: 'invoke' },
	];
	fs.writeFileSync(path.join(store, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n') + '\n');
	fs.writeFileSync(path.join(store, 'meta.json'), JSON.stringify({ epoch: 1 }));
}

function ev(comp: string, event: 'enter' | 'exit', extra: Partial<TraceEvent>): string {
	return JSON.stringify({ component: `app.svc.${comp}`, event, ...extra });
}

/** Writes one capture session at captures/<dir>/svc/trace.jsonl with a set mtime. */
function writeSession(root: string, dir: string, lines: string[], iso: string): void {
	const d = path.join(root, '.vinv', 'captures', dir, 'svc');
	fs.mkdirSync(d, { recursive: true });
	const f = path.join(d, 'trace.jsonl');
	fs.writeFileSync(f, lines.join('\n') + '\n');
	// The proof loop keys sessions on trace mtime, so before/after must differ.
	fs.utimesSync(f, new Date(iso), new Date(iso));
	fs.utimesSync(d, new Date(iso), new Date(iso));
}

function clean(comp: string, ms: number): [string, string] {
	return [
		ev(comp, 'enter', { args_hash: `${comp}-${Math.random()}` }),
		ev(comp, 'exit', { duration_ms: ms, error_type: null, determinism_sources: [] }),
	];
}

suite('optimization end-to-end (disk pipeline)', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-'));
		writeStore(root);
		const lines: string[] = [];
		// handler: 1 call, 2ms — at/below the typical per-call, so it is not a
		// candidate on its own (it only matters as serialize's caller).
		lines.push(...clean('handler', 2));
		// get_docs: 10 calls with the SAME args_hash AND the same result_hash —
		// observed functional dependence, so caching is sound → cache waste.
		for (let i = 0; i < 10; i++) {
			lines.push(ev('get_docs', 'enter', { args_hash: 'H' }));
			lines.push(ev('get_docs', 'exit', { duration_ms: 10, error_type: null, determinism_sources: [], result_hash: 'R' }));
		}
		// serialize: 50 distinct-arg calls, 2ms each → fan-out (50× per handler call).
		for (let i = 0; i < 50; i++) {
			lines.push(...clean('serialize', 2));
		}
		// already_fast: 20 calls at 1ms → below the typical, nothing to recover.
		for (let i = 0; i < 20; i++) {
			lines.push(...clean('already_fast', 1));
		}
		// broken_call: one 500ms call that RAISED → the biggest raw time, but it
		// measures a failure, not latency. Must be excluded.
		lines.push(ev('broken_call', 'enter', { args_hash: 'b0' }));
		lines.push(ev('broken_call', 'exit', { duration_ms: 500, error_type: 'ValueError', determinism_sources: [] }));
		writeSession(root, 'run1', lines, '2020-01-01T00:00:00Z');
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function candidates() {
		const store = indexStoreDir(root);
		const nodes = loadNodes(store);
		const edges = loadEdges(store, nodes.length);
		const timings = collectSymbolTimings(root, nodes);
		const cache = collectCacheCandidates(root, nodes);
		return { nodes, timings, list: computeOptimizationCandidates({ nodes, edges, timings, cache }).items };
	}

	test('a symbol whose only call RAISED is never a hotspot (the smolagents defect)', () => {
		const { list } = candidates();
		assert.ok(
			!list.some((c) => c.name === 'broken_call'),
			'broken_call spent 500ms failing — that is not optimizable latency',
		);
	});

	test('a hot-but-optimal symbol is excluded; cache and fan-out are surfaced with the right kind', () => {
		const { list } = candidates();
		assert.ok(!list.some((c) => c.name === 'already_fast'), 'nothing removable → not a candidate');
		const cache = list.find((c) => c.name === 'get_docs');
		const fanout = list.find((c) => c.name === 'serialize');
		assert.ok(cache && cache.waste_kind === 'cache', 'get_docs is a cache candidate');
		assert.ok(fanout && fanout.waste_kind === 'fanout', 'serialize is a fan-out candidate');
	});

	test('candidates are ranked by predicted recoverable time', () => {
		const { list } = candidates();
		for (let i = 1; i < list.length; i++) {
			assert.ok(list[i - 1].predicted_ms >= list[i].predicted_ms, 'sorted desc');
		}
	});

	test('predicted → proven: a faster after-trace resolves the dispatched candidate', () => {
		const { nodes, timings, list } = candidates();
		const getRow = nodes.findIndex((n) => n.name === 'get_docs');
		const frozen = markDispatched(list.find((c) => c.name === 'get_docs')!, timings.get(getRow), 'Optimize get_docs');
		assert.strictEqual(Math.round(frozen.outcome!.measured_before), 100, 'before = 10×10ms');

		// The fix landed: re-trace the SAME flow, get_docs now 1ms/call.
		const after: string[] = [];
		for (let i = 0; i < 10; i++) {
			after.push(ev('get_docs', 'enter', { args_hash: 'H' }));
			after.push(ev('get_docs', 'exit', { duration_ms: 1, error_type: null, determinism_sources: [] }));
		}
		writeSession(root, 'run2', after, '2020-06-01T00:00:00Z');

		const timings2 = collectSymbolTimings(root, nodes);
		const done = reconcileOutcome(frozen, timings2.get(getRow), true);
		assert.strictEqual(done.status, 'proven', 'a drop beyond the noise band with clean behavior is proven');
		assert.strictEqual(Math.round(done.outcome!.delta_ms!), -90, '100ms → 10ms measured');
	});

	test('a dispatched candidate stays waiting until a NEW capture session arrives', () => {
		const { nodes, timings, list } = candidates();
		const getRow = nodes.findIndex((n) => n.name === 'get_docs');
		const frozen = markDispatched(list.find((c) => c.name === 'get_docs')!, timings.get(getRow), 't');
		// Reconcile against the SAME session (no re-trace yet) → still dispatched.
		const still = reconcileOutcome(frozen, collectSymbolTimings(root, nodes).get(getRow), true);
		assert.strictEqual(still.status, 'dispatched', 'no after-run yet → keep waiting, do not fabricate a verdict');
	});
});

/**
 * The request-structure detectors (N+1, staircase, self-time) need a per-request
 * call tree, so this suite writes ONE request with nested enter/exit events and
 * drives collectRequestSpans → computeOptimizationCandidates end to end.
 */
suite('optimization end-to-end (request-structure detectors)', () => {
	let root: string;

	function store(root2: string): void {
		const dir = indexStoreDir(root2);
		fs.mkdirSync(dir, { recursive: true });
		const names = ['handler', 'db_get', 'fetch_a', 'fetch_b'];
		const chunks = names.map((name, i) => ({
			id: `id${i}`,
			file: 'src/app/svc.py',
			lang: 'python',
			kind: 'function',
			name,
			start_line: i + 1,
			end_line: i + 9,
			rank: 0.5,
			epoch: 1,
			parent: null,
		}));
		fs.writeFileSync(path.join(dir, 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
		fs.writeFileSync(path.join(dir, 'edges.jsonl'), '');
		fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ epoch: 1 }));
	}

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-req-'));
		store(root);
		const lines: string[] = [];
		let t = 1000;
		const enter = (c: string, extra: Record<string, unknown> = {}): void => {
			lines.push(JSON.stringify({ component: `app.svc.${c}`, event: 'enter', request_id: 'R1', thread_id: 1, ts: new Date(t).toISOString(), ...extra }));
		};
		const exit = (c: string, dur: number, extra: Record<string, unknown> = {}): void => {
			lines.push(JSON.stringify({ component: `app.svc.${c}`, event: 'exit', request_id: 'R1', thread_id: 1, ts: new Date(t + dur).toISOString(), duration_ms: dur, error_type: null, ...extra }));
			t += dur;
		};
		// handler is a pure delegator (self ≈ 0): 5 sequential db_get (N+1) + two
		// sequential I/O fetches (staircase). Total = 5×10 + 30 + 40 = 120.
		enter('handler');
		for (let i = 0; i < 5; i++) {
			enter('db_get', { args_hash: `q${i}` });
			exit('db_get', 10, { side_effects: ['db'] });
		}
		enter('fetch_a', { args_hash: 'a' });
		exit('fetch_a', 30, { side_effects: ['http'] });
		enter('fetch_b', { args_hash: 'b' });
		exit('fetch_b', 40, { side_effects: ['http'] });
		exit('handler', 120);
		const d = path.join(root, '.vinv', 'captures', 'r1', 'svc');
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, 'trace.jsonl'), lines.join('\n') + '\n');
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function list() {
		const dir = indexStoreDir(root);
		const nodes = loadNodes(dir);
		return computeOptimizationCandidates({
			nodes,
			edges: loadEdges(dir, nodes.length),
			timings: collectSymbolTimings(root, nodes),
			cache: unbounded([], 'cache-pareto'),
			spans: collectRequestSpans(root, nodes),
		}).items;
	}

	test('a callee repeated many times in one request is flagged N+1', () => {
		assert.ok(
			list().some((c) => c.name === 'db_get' && c.waste_kind === 'n-plus-1'),
			'db_get fires 5× under one handler call',
		);
	});

	test('sequential independent I/O under a parent is flagged serial-async (staircase)', () => {
		assert.ok(
			list().some((c) => c.name === 'handler' && c.waste_kind === 'serial-async'),
			'handler awaits its I/O children back-to-back — parallelizable',
		);
	});

	test('a pure delegator is NOT flagged per-call (self-time critical-path gate)', () => {
		const handler = list().find((c) => c.name === 'handler');
		assert.ok(handler, 'handler is surfaced (via staircase)');
		assert.notStrictEqual(handler!.waste_kind, 'per-call', 'its time is in callees, not itself');
		assert.strictEqual(Math.round(handler!.self_ms ?? -1), 0, 'self time ≈ 0');
	});
});

/**
 * The REAL exporter writes both of a span's lines (enter+exit) together at span
 * END, so children's pairs appear BEFORE their parent's in the file — assembled
 * by line order this degenerates into one root per span (the demo-fastapi trace
 * produced 10k roots from ~300 requests). These fixtures mirror that ordering,
 * with the depth/parent_component/ts fields every real event carries, and prove
 * the structural assembly nests them correctly — including two overlapping
 * same-component parents on one thread (asyncio), where only interval
 * containment can pick the right instance.
 */
suite('optimization end-to-end (end-ordered exporter traces)', () => {
	let root: string;

	function store2(root2: string): void {
		const dir = indexStoreDir(root2);
		fs.mkdirSync(dir, { recursive: true });
		const names = ['handler', 'db_get', 'fetch_a', 'fetch_b', 'worker', 'job'];
		const chunks = names.map((name, i) => ({
			id: `id${i}`,
			file: 'src/app/svc.py',
			lang: 'python',
			kind: 'function',
			name,
			start_line: i * 10 + 1,
			end_line: i * 10 + 9,
			rank: 0.5,
			epoch: 1,
			parent: null,
		}));
		fs.writeFileSync(path.join(dir, 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
		fs.writeFileSync(path.join(dir, 'edges.jsonl'), '');
		fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ epoch: 1 }));
	}

	/** Emits one span's enter+exit ADJACENTLY (the exporter's end-time pattern). */
	function spanLines(
		lines: string[],
		req: string,
		c: string,
		depth: number,
		parent: string,
		startMs: number,
		durMs: number,
		extra: Record<string, unknown> = {},
	): void {
		const base = {
			request_id: req,
			thread_id: 1,
			component: `app.svc.${c}`,
			depth: String(depth),
			parent_component: parent === 'None' ? 'None' : `app.svc.${parent}`,
		};
		lines.push(
			JSON.stringify({ ...base, event: 'enter', ts: new Date(startMs).toISOString(), ...extra }),
		);
		lines.push(
			JSON.stringify({
				...base,
				event: 'exit',
				ts: new Date(startMs + durMs).toISOString(),
				duration_ms: durMs,
				error_type: null,
				...extra,
			}),
		);
	}

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-endorder-'));
		store2(root);
		const lines: string[] = [];
		// Request R1 — same tree as the call-order suite, but written in EXIT
		// order: all children first, the root handler LAST.
		const T = 1_000_000;
		for (let i = 0; i < 5; i++) {
			spanLines(lines, 'R1', 'db_get', 1, 'handler', T + i * 10, 10, {
				args_hash: `q${i}`,
				side_effects: ['db'],
			});
		}
		spanLines(lines, 'R1', 'fetch_a', 1, 'handler', T + 50, 30, { side_effects: ['http'] });
		spanLines(lines, 'R1', 'fetch_b', 1, 'handler', T + 80, 40, { side_effects: ['http'] });
		spanLines(lines, 'R1', 'handler', 0, 'None', T, 120);
		// Request R2 — asyncio: two OVERLAPPING worker instances on one thread,
		// each with one job child; only interval containment separates them.
		// worker#1 [0,50] owns job@5; worker#2 [20,100] owns job@60.
		const U = 2_000_000;
		spanLines(lines, 'R2', 'job', 2, 'worker', U + 5, 10, { args_hash: 'j1' });
		spanLines(lines, 'R2', 'worker', 1, 'handler', U, 50, { args_hash: 'w1' });
		spanLines(lines, 'R2', 'job', 2, 'worker', U + 60, 10, { args_hash: 'j2' });
		spanLines(lines, 'R2', 'worker', 1, 'handler', U + 20, 80, { args_hash: 'w2' });
		spanLines(lines, 'R2', 'handler', 0, 'None', U, 110);
		const d = path.join(root, '.vinv', 'captures', 'r1', 'svc');
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, 'trace.jsonl'), lines.join('\n') + '\n');
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function forest() {
		const nodes = loadNodes(indexStoreDir(root));
		return collectRequestSpans(root, nodes);
	}

	test('children written before their parent still nest under it', () => {
		const roots = forest();
		assert.strictEqual(roots.length, 2, 'one root per request, not one per span');
		const r1 = roots.find((r) => r.children.length === 7);
		assert.ok(r1, 'R1 root has all 7 children attached');
		assert.strictEqual(r1!.component, 'app.svc.handler');
		assert.strictEqual(r1!.durationMs, 120);
	});

	test('overlapping same-component asyncio parents get their own children', () => {
		const roots = forest();
		const r2 = roots.find((r) => r.children.some((c) => c.component === 'app.svc.worker'));
		assert.ok(r2, 'R2 root found');
		const workers = r2!.children.filter((c) => c.component === 'app.svc.worker');
		assert.strictEqual(workers.length, 2, 'both worker instances under the handler');
		const w1 = workers.find((w) => w.durationMs === 50)!;
		const w2 = workers.find((w) => w.durationMs === 80)!;
		assert.strictEqual(w1.children.length, 1, 'worker#1 has exactly its own job');
		assert.strictEqual(w2.children.length, 1, 'worker#2 has exactly its own job');
		assert.ok(w1.children[0].startMs < w2.startMs + 1.5, 'job@5 attached to the earlier worker');
		assert.ok(w2.children[0].startMs > w2.startMs, 'job@60 attached to the later worker');
	});

	test('the structural detectors fire on an end-ordered trace', () => {
		const dir = indexStoreDir(root);
		const nodes = loadNodes(dir);
		const out = computeOptimizationCandidates({
			nodes,
			edges: loadEdges(dir, nodes.length),
			timings: collectSymbolTimings(root, nodes),
			cache: unbounded([], 'cache-pareto'),
			spans: forest(),
		}).items;
		assert.ok(
			out.some((c) => c.name === 'db_get' && c.waste_kind === 'n-plus-1'),
			'N+1 detected despite end-ordered lines',
		);
		assert.ok(
			out.some((c) => c.name === 'handler' && c.waste_kind === 'serial-async'),
			'staircase detected despite end-ordered lines',
		);
		const handler = out.find((c) => c.name === 'handler');
		assert.strictEqual(Math.round(handler!.self_ms ?? -1), 0, 'delegator self-time ≈ 0');
	});
});

/**
 * The optimization verdict engine (exerciseOptimize.ts) — the bridge
 * optimize.py's docstring promises. Driven through runVerifiedOptimization
 * with injected deps so every contract is observable: a declined dispatch
 * leaves no phantom state, the after-run is bound to THIS episode's frozen
 * probe set (never "any newer capture session"), a regression actually
 * reverts, and the finished episode lands in optimize.jsonl where the
 * findings model reads it.
 */
suite('optimization end-to-end (verdict engine bridge)', () => {
	/** A stable probe measurement: R identical samples at `latency` ms. */
	function m(latency: number, opts: { status?: number; shape?: string; label?: string } = {}): ProbeMeasurement {
		return {
			latencies: [latency, latency, latency],
			statuses: [opts.status ?? 200, opts.status ?? 200, opts.status ?? 200],
			shapes: [opts.shape ?? 'shapeA', opts.shape ?? 'shapeA', opts.shape ?? 'shapeA'],
			label: opts.label ?? 'GET /x',
		};
	}

	function samples(latency: number, opts: { status?: number; shape?: string } = {}): Map<string, ProbeMeasurement> {
		return new Map(
			['p1', 'p2', 'p3', 'p4'].map((id) => [id, m(latency, { ...opts, label: `GET /${id}` })]),
		);
	}

	interface Calls {
		markDispatched: number;
		revert: number;
		/** interleaved event order — proves WHEN the revert ran, not just that it did. */
		sequence: string[];
		measure: FrozenProbeSet[];
		resolutions: Array<{
			status: OptimizationStatus;
			comparison: MetricComparison | null;
			reverted: boolean;
			attempt: number;
		}>;
		records: Array<{ action: string; attempts: OptimizeAttempt[] }>;
		dispatchHooks: OptimizeDispatchHooks[];
		/** persisted attempt history (the doom-loop guard's write side). */
		persisted: Array<{ signature: string; approach: string; verdict: string }>;
		/** what loadPriorAttempts serves (the read side). */
		prior: PersistedOptimizeAttempt[];
	}

	/** Deps whose measure() replays a scripted sequence (before, after1, after2…). */
	function fakeDeps(measurements: Array<Map<string, ProbeMeasurement>>): { deps: OptimizeEngineDeps; calls: Calls } {
		const calls: Calls = {
			markDispatched: 0,
			revert: 0,
			sequence: [],
			measure: [],
			resolutions: [],
			records: [],
			dispatchHooks: [],
			persisted: [],
			prior: [],
		};
		let next = 0;
		const deps: OptimizeEngineDeps = {
			freezeProbes: async () => ({ ids: ['p1', 'p2', 'p3', 'p4'] }),
			measure: async (set) => {
				calls.measure.push(set);
				calls.sequence.push('measure');
				return measurements[Math.min(next++, measurements.length - 1)];
			},
			snapshot: async () => 'sha',
			revert: async () => {
				calls.revert += 1;
				calls.sequence.push('revert');
			},
			markDispatched: () => {
				calls.markDispatched += 1;
			},
			resolve: (r) => {
				calls.resolutions.push({
					status: r.status,
					comparison: r.comparison,
					reverted: r.reverted,
					attempt: r.attempt,
				});
			},
			loadPriorAttempts: () => calls.prior,
			persistAttempt: (signature, attempt, verdict) => {
				calls.persisted.push({ signature, approach: attempt.approach, verdict });
			},
			changedFiles: async () => ['src/app/svc.py'],
			recordEpisode: (r) => {
				calls.records.push({ action: r.action, attempts: r.attempts });
			},
			notify: () => undefined,
		};
		return { deps, calls };
	}

	const OPP = {
		kind: 'latency-symbol',
		endpoint_id: 'get_docs',
		endpoint: 'get_docs (src/app/svc.py:11)',
		detail: 'panel dispatch',
		metric: 'probe_latency_ms',
		value: 0,
	};

	/** A dispatcher that behaves like offerOrDispatch on ACCEPT: confirms first. */
	function accepting(calls: Calls): (hooks: OptimizeDispatchHooks) => Promise<boolean> {
		return async (hooks) => {
			calls.dispatchHooks.push(hooks);
			await hooks.onAccept();
			return true;
		};
	}

	test('a declined dispatch leaves no phantom state — nothing marked, resolved, reverted, or recorded', async () => {
		const { deps, calls } = fakeDeps([samples(100)]);
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP },
			async (hooks) => {
				calls.dispatchHooks.push(hooks);
				return false; // user clicked Dismiss / busy-lock / infra block
			},
			deps,
		);
		assert.strictEqual(result.mode, 'declined');
		assert.strictEqual(calls.markDispatched, 0, 'declined offer must never flip the row to dispatched');
		assert.strictEqual(calls.revert, 0);
		assert.strictEqual(calls.resolutions.length, 0);
		assert.strictEqual(calls.records.length, 0, 'nothing ran → no optimize.jsonl row');
	});

	test('the verdict is episode-bound: before/after replay the SAME frozen set and resolve from it', async () => {
		// Before 100ms → after 10ms per probe, byte/shape-identical responses.
		const { deps, calls } = fakeDeps([samples(100), samples(10)]);
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP },
			accepting(calls),
			deps,
		);
		assert.strictEqual(result.mode, 'verdict');
		assert.strictEqual(result.action, 'accept');
		assert.strictEqual(calls.markDispatched, 1, 'row marked exactly once, on confirm');
		// The after-measure replays the identical frozen request set — pairing by
		// construction, not "whatever capture session landed most recently".
		assert.strictEqual(calls.measure.length, 2, 'one before pass, one after pass');
		assert.deepStrictEqual(calls.measure[0].ids, calls.measure[1].ids, 'frozen set identical before/after');
		const res = calls.resolutions[0];
		assert.strictEqual(res.status, 'proven');
		assert.strictEqual(res.reverted, false);
		// The comparison is computed from THIS episode's paired samples.
		assert.strictEqual(Math.round(res.comparison!.before_median), 100);
		assert.strictEqual(Math.round(res.comparison!.after_median), 10);
		assert.ok(res.comparison!.improved && res.comparison!.ci_low > 0, 'CI excludes zero');
		assert.strictEqual(calls.revert, 0, 'accepted → the change is kept');
	});

	test('a regression actually reverts: behavior break → revertToSnapshot runs and the row resolves regressed', async () => {
		// Faster but WRONG: the after-run answers a different shape on every probe.
		const { deps, calls } = fakeDeps([samples(100), samples(10, { shape: 'shapeB' })]);
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP, maxAttempts: 1 },
			accepting(calls),
			deps,
		);
		assert.strictEqual(result.mode, 'verdict');
		assert.strictEqual(result.action, 'revert-and-stop');
		assert.strictEqual(calls.revert, 1, 'the revert is real, not UI copy');
		const res = calls.resolutions[0];
		assert.strictEqual(res.status, 'regressed');
		assert.strictEqual(res.reverted, true);
		assert.strictEqual(calls.records[0].action, 'revert-and-stop');
		assert.strictEqual(calls.records[0].attempts[0].behavior_suite_passed, false);
	});

	test('no-gain keeps the step alive, threads the learning, and a declined retry reverts to ORIGIN', async () => {
		// Attempt 1: no change (100 → 100) but behavior intact → the step stays
		// applied as a lineage intermediate. Attempt 2: the retry is declined →
		// the lineage ends without acceptance → origin revert.
		const { deps, calls } = fakeDeps([samples(100), samples(100)]);
		let dispatches = 0;
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP, maxAttempts: 3 },
			async (hooks) => {
				calls.dispatchHooks.push(hooks);
				dispatches += 1;
				if (dispatches === 1) {
					await hooks.onAccept();
					return true;
				}
				return false; // user declines the retry
			},
			deps,
		);
		assert.strictEqual(calls.revert, 1, 'the lineage ended unaccepted → one origin revert');
		assert.deepStrictEqual(
			calls.sequence,
			['measure', 'measure', 'revert'],
			'the kept step was NOT reverted before the retry — only when the lineage closed',
		);
		assert.strictEqual(calls.dispatchHooks[0].priorLearning, undefined, 'first attempt has no prior');
		assert.ok(
			calls.dispatchHooks[1].priorLearning?.includes('KEPT'),
			'the retry pack opens with what was tried and that it is still applied',
		);
		assert.strictEqual(result.action, 'revert-and-stop');
		assert.strictEqual(calls.resolutions[0].status, 'inconclusive', 'no honest claim either way');
		assert.strictEqual(calls.resolutions[0].reverted, true);
		assert.ok(
			calls.records[0].attempts.every((a) => a.reverted),
			'once the lineage reverts to origin every attempt reads as reverted',
		);
		assert.deepStrictEqual(
			calls.persisted.map((p) => p.verdict),
			['kept-no-gain'],
			'the attempt history landed in the doom-loop store',
		);
	});

	test('LINEAGE: a timing-neutral step1 plus a step2 that clears the CI is ACCEPTED (no revert)', async () => {
		// step1: 100 → 100 (behavior intact, kept). step2 builds on step1 and the
		// endpoint measures 10ms vs the ORIGINAL 100ms baseline → accept.
		const { deps, calls } = fakeDeps([samples(100), samples(100), samples(10)]);
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP, maxAttempts: 3 },
			accepting(calls),
			deps,
		);
		assert.strictEqual(result.mode, 'verdict');
		assert.strictEqual(result.action, 'accept');
		assert.strictEqual(calls.revert, 0, 'nothing was ever reverted — step1 stayed alive');
		assert.strictEqual(calls.measure.length, 3, 'before + one endpoint measure per step');
		const res = calls.resolutions[0];
		assert.strictEqual(res.status, 'proven');
		assert.strictEqual(res.attempt, 2, 'the verdict resolved on the second lineage step');
		assert.strictEqual(Math.round(res.comparison!.before_median), 100, 'judged vs the ORIGINAL baseline');
		assert.strictEqual(Math.round(res.comparison!.after_median), 10);
		assert.strictEqual(calls.records[0].attempts.length, 2);
		assert.strictEqual(calls.records[0].attempts[0].reverted, false, 'the kept step was never rolled back');
		assert.deepStrictEqual(
			calls.persisted.map((p) => p.verdict),
			['kept-no-gain', 'accepted'],
		);
	});

	test('LINEAGE: a lineage ending worse reverts to ORIGIN once, not to step1', async () => {
		// step1: 100 → 120 (worse, behavior intact → kept). step2: 150 (worse
		// still). Budget exhausted → ONE revert, straight to the origin snapshot.
		const { deps, calls } = fakeDeps([samples(100), samples(120), samples(150)]);
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP, maxAttempts: 2 },
			accepting(calls),
			deps,
		);
		assert.strictEqual(result.action, 'revert-and-stop');
		assert.strictEqual(calls.revert, 1, 'exactly one revert — origin, never a partial step rollback');
		assert.deepStrictEqual(
			calls.sequence,
			['measure', 'measure', 'measure', 'revert'],
			'the single revert happened only after the lineage ended',
		);
		const res = calls.resolutions[0];
		assert.strictEqual(res.status, 'regressed', 'the whole CI below zero is a regression');
		assert.strictEqual(res.reverted, true);
		assert.ok(
			calls.records[0].attempts.every((a) => a.reverted),
			'both lineage steps read as reverted after the origin revert',
		);
		assert.deepStrictEqual(
			calls.persisted.map((p) => p.verdict),
			['kept-no-gain', 'reverted-no-gain'],
		);
	});

	test('LINEAGE: a behavior break reverts to origin immediately and the next attempt starts fresh', async () => {
		// step1 answers a different shape → dead on the spot (origin revert);
		// step2 starts from origin, measures 10ms clean → accept.
		const { deps, calls } = fakeDeps([samples(100), samples(10, { shape: 'shapeB' }), samples(10)]);
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP, maxAttempts: 2 },
			accepting(calls),
			deps,
		);
		assert.strictEqual(result.action, 'accept');
		assert.deepStrictEqual(
			calls.sequence,
			['measure', 'measure', 'revert', 'measure'],
			'the behavior break was reverted BEFORE the retry dispatched',
		);
		assert.deepStrictEqual(
			calls.persisted.map((p) => p.verdict),
			['reverted-behavior', 'accepted'],
		);
	});

	test('DOOM-LOOP GUARD: persisted attempts seed the FIRST dispatch of a new episode (restart survives)', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-attempts-'));
		try {
			const signature = opportunitySignature(OPP);
			// Episode 1 (pre-"restart"): one kept-no-gain attempt, retry declined —
			// wired to the REAL store.
			const first = fakeDeps([samples(100), samples(100)]);
			first.deps.loadPriorAttempts = (sig) => loadPriorOptimizeAttempts(root, 7, sig);
			first.deps.persistAttempt = (sig, attempt, verdict) =>
				appendOptimizeAttempt(root, {
					row: 7,
					signature: sig,
					approach: attempt.approach,
					comparison: null,
					verdict,
					learning: attempt.learning,
				});
			let dispatches = 0;
			await runVerifiedOptimization(
				{ label: 'Optimize get_docs', opportunity: OPP, maxAttempts: 2 },
				async (hooks) => {
					first.calls.dispatchHooks.push(hooks);
					dispatches += 1;
					if (dispatches === 1) {
						await hooks.onAccept();
						return true;
					}
					return false;
				},
				first.deps,
			);
			const stored = loadPriorOptimizeAttempts(root, 7, signature);
			assert.strictEqual(stored.length, 1, 'the attempt record persisted to optimize_attempts.jsonl');
			assert.strictEqual(stored[0].verdict, 'kept-no-gain');

			// Episode 2 — a brand-new engine run (fresh deps = restarted process).
			const second = fakeDeps([samples(100), samples(10)]);
			second.deps.loadPriorAttempts = (sig) => loadPriorOptimizeAttempts(root, 7, sig);
			await runVerifiedOptimization(
				{ label: 'Optimize get_docs', opportunity: OPP, maxAttempts: 2 },
				accepting(second.calls),
				second.deps,
			);
			const seeded = second.calls.dispatchHooks[0].priorLearning;
			assert.ok(
				seeded?.includes('Prior optimization attempts'),
				'the FIRST dispatch of the new episode opens with the persisted history',
			);
			assert.ok(
				seeded?.includes('materially different'),
				'the seed carries the do-not-repeat instruction across the restart',
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('CONTRACT C1: a resolved verdict appends an optimization_outcome event to the episode ledger', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-outcome-root-'));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-outcome-home-'));
		const previousHome = process.env.VINV_HOME;
		try {
			process.env.VINV_HOME = home;
			// Production deps (the REAL resolve → ledger append), with the probe /
			// snapshot machinery faked out so no service or git repo is needed.
			const { deps: fake, calls } = fakeDeps([samples(100), samples(10)]);
			const deps: OptimizeEngineDeps = {
				...buildWorkspaceDeps(root, { row: 424242 }),
				freezeProbes: fake.freezeProbes,
				measure: fake.measure,
				snapshot: fake.snapshot,
				revert: fake.revert,
				changedFiles: fake.changedFiles,
				recordEpisode: fake.recordEpisode,
				notify: fake.notify,
			};
			const result = await runVerifiedOptimization(
				{ label: 'Optimize get_docs', opportunity: OPP },
				accepting(calls),
				deps,
			);
			assert.strictEqual(result.mode, 'verdict');
			const ledger = fs.readFileSync(path.join(home, 'telemetry', 'episodes.jsonl'), 'utf8');
			const events = ledger
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.filter((e) => e.type === 'optimization_outcome');
			assert.strictEqual(events.length, 1, 'exactly one outcome event per resolved verdict');
			const e = events[0];
			assert.ok(String(e.episode_id).startsWith('opt-'), 'carries the dispatched episode id');
			assert.strictEqual(e.row, 424242);
			assert.strictEqual(e.verdict, 'proven');
			assert.strictEqual(e.attempt, 1);
			assert.strictEqual(typeof e.at, 'number');
			assert.strictEqual(typeof e.waste_kind, 'string');
			assert.strictEqual(typeof e.predicted_ms, 'number');
			assert.strictEqual(Math.round(e.delta_ms as number), -90, 'delta = after − before medians');
		} finally {
			if (previousHome === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previousHome;
			}
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test('CONTRACT C1: a behavior break resolves as reverted-behavior', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-outcome2-root-'));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-outcome2-home-'));
		const previousHome = process.env.VINV_HOME;
		try {
			process.env.VINV_HOME = home;
			const { deps: fake, calls } = fakeDeps([samples(100), samples(10, { shape: 'shapeB' })]);
			const deps: OptimizeEngineDeps = {
				...buildWorkspaceDeps(root, { row: 424242 }),
				freezeProbes: fake.freezeProbes,
				measure: fake.measure,
				snapshot: fake.snapshot,
				revert: fake.revert,
				changedFiles: fake.changedFiles,
				recordEpisode: fake.recordEpisode,
				notify: fake.notify,
			};
			await runVerifiedOptimization(
				{ label: 'Optimize get_docs', opportunity: OPP, maxAttempts: 1 },
				accepting(calls),
				deps,
			);
			const ledger = fs.readFileSync(path.join(home, 'telemetry', 'episodes.jsonl'), 'utf8');
			const e = ledger
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.find((x) => x.type === 'optimization_outcome');
			assert.ok(e, 'the outcome event landed');
			assert.strictEqual(e!.verdict, 'reverted-behavior');
		} finally {
			if (previousHome === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previousHome;
			}
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	test('the finished episode lands in optimize.jsonl where the findings model reads it', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-optlog-'));
		try {
			const { deps, calls } = fakeDeps([samples(100), samples(10)]);
			deps.recordEpisode = (r) => appendOptimizeEpisode(root, r);
			await runVerifiedOptimization(
				{ label: 'Optimize get_docs', opportunity: OPP },
				accepting(calls),
				deps,
			);
			const findings = buildFindings(root);
			assert.strictEqual(findings.episodes.length, 1, 'the episode section is alive');
			assert.strictEqual(findings.headline.episodesAccepted, 1);
			const ep = findings.episodes[0];
			assert.strictEqual(ep.action, 'accept');
			assert.strictEqual(ep.opportunity.kind, 'latency-symbol');
			assert.ok(ep.attempts[0].rel !== null && ep.attempts[0].rel! > 0.8, 'CI evidence recorded');
			assert.deepStrictEqual(ep.filesChanged, ['src/app/svc.py']);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('behavior oracle: a new 5xx fails even an unstable probe; stable probes demand identity', () => {
		const before = new Map<string, ProbeMeasurement>([
			['stable', m(50)],
			['flaky', { latencies: [40, 45, 42], statuses: [200, 404, 200], shapes: ['a', 'b', 'a'], label: 'GET /f' }],
		]);
		const okAfter = new Map<string, ProbeMeasurement>([
			['stable', m(20)],
			['flaky', { latencies: [20, 21, 22], statuses: [404, 200, 200], shapes: ['b', 'a', 'a'], label: 'GET /f' }],
		]);
		assert.strictEqual(pairProbeSamples(before, okAfter).behaviorOk, true, 'flaky-before probes are not held to identity');
		const brokenAfter = new Map<string, ProbeMeasurement>([
			['stable', m(20)],
			['flaky', { latencies: [20], statuses: [500], shapes: ['x'], label: 'GET /f' }],
		]);
		assert.strictEqual(pairProbeSamples(before, brokenAfter).behaviorOk, false, 'a NEW 5xx is a behavior break');
	});

	test('an unmeasurable dispatch falls back to the watcher path — dispatched, but never auto-judged', async () => {
		const { deps, calls } = fakeDeps([new Map()]);
		deps.freezeProbes = async () => null; // service down / no probes yet
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP },
			accepting(calls),
			deps,
		);
		assert.strictEqual(result.mode, 'fallback');
		assert.strictEqual(calls.markDispatched, 1, 'the dispatch itself still happened and is tracked');
		assert.strictEqual(calls.revert, 0, 'never judge (or revert) on evidence we lack');
		assert.strictEqual(calls.resolutions.length, 0);
		assert.strictEqual(calls.records.length, 0);
	});

	// ---- trace-diff fallback: judge a flow the probe path can't measure -------

	/** Deps where probes are UNAVAILABLE (freezeProbes → null) but a trace-diff
	 * measure supplies scripted before/after per-call samples. */
	function traceDiffDeps(
		before: { samples: number[]; errorSig: string },
		after: { samples: number[]; errorSig: string },
	): { deps: OptimizeEngineDeps; calls: Calls } {
		const { deps, calls } = fakeDeps([]);
		let phaseCount = 0;
		return {
			deps: {
				...deps,
				freezeProbes: async () => null, // no probe path → the fallback branch
				measureTraceDiff: async () => (phaseCount++ === 0 ? before : after),
			},
			calls,
		};
	}

	test('trace-diff: a faster function on an unprobeable flow resolves PROVEN and records the episode', async () => {
		const slow = Array.from({ length: 30 }, () => 30);
		const fast = Array.from({ length: 30 }, () => 6);
		const { deps, calls } = traceDiffDeps(
			{ samples: slow, errorSig: 'app.run|ValueError' }, // flow raises...
			{ samples: fast, errorSig: 'app.run|ValueError' }, // ...identically after the fix
		);
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP },
			accepting(calls),
			deps,
		);
		assert.strictEqual(result.mode, 'verdict', 'trace-diff produced a verdict, not a watcher fallback');
		assert.strictEqual(result.action, 'accept');
		assert.strictEqual(calls.resolutions[0]?.status, 'proven');
		assert.strictEqual(calls.revert, 0, 'a proven win is kept');
		assert.strictEqual(calls.records.length, 1, 'the episode is recorded → the exercise/ artifact');
	});

	test('trace-diff: a behavior change (different error signature) resolves REGRESSED and reverts', async () => {
		const s = Array.from({ length: 30 }, () => 30);
		const f = Array.from({ length: 30 }, () => 6);
		const { deps, calls } = traceDiffDeps(
			{ samples: s, errorSig: 'app.run|ValueError' },
			{ samples: f, errorSig: '' }, // the flow no longer raises — behavior changed
		);
		const result = await runVerifiedOptimization(
			{ label: 'Optimize get_docs', opportunity: OPP },
			accepting(calls),
			deps,
		);
		assert.strictEqual(result.mode, 'verdict');
		assert.strictEqual(calls.resolutions[0]?.status, 'regressed');
		assert.strictEqual(calls.revert, 1, 'a behavior change is reverted');
	});
});
