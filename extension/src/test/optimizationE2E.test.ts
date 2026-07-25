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
} from '../harness/runtimeAnalysis';
import {
	computeOptimizationCandidates,
	markDispatched,
	reconcileOutcome,
} from '../harness/optimizationAnalysis';

interface TraceEvent {
	component: string;
	event: 'enter' | 'exit';
	args_hash?: string;
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
		// get_docs: 10 calls with the SAME args_hash, 10ms each → cache waste.
		for (let i = 0; i < 10; i++) {
			lines.push(ev('get_docs', 'enter', { args_hash: 'H' }));
			lines.push(ev('get_docs', 'exit', { duration_ms: 10, error_type: null, determinism_sources: [] }));
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
		const cacheByRow = new Map(collectCacheCandidates(root, nodes).map((c) => [c.row, c]));
		return { nodes, timings, list: computeOptimizationCandidates({ nodes, edges, timings, cacheByRow }) };
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
			cacheByRow: new Map(),
			spans: collectRequestSpans(root, nodes),
		});
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
