/**
 * Context-graph tests: the walk math (typed-edge personalized PageRank), the
 * failure-exemplar evidence chain from raw captures to the overlay, the QnA
 * sufficiency-verdict protocol, and the harness handover pack.
 *
 * The math assertions here are the ones the multi-agent review re-checks:
 *  - π is a probability distribution (Σπ = 1)
 *  - mass decays monotonically with graph distance from the anchor on a path
 *  - budget and anchor-admission invariants hold
 *  - runtime flow edges are walkable (the old BFS ignored them)
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { contextWalk, nameSpecificity, rrfAnchorWeight } from '../graph/contextWalk';
import {
	buildGraphSnapshot,
	loadRuntimeAndFlow,
	type FlowEdge,
	type GraphEdge,
	type GraphNode,
	type GraphSnapshot,
} from '../graph/indexGraph';
import { assembleEvidence, parseSufficiency } from '../qna/answer';
import { composePackContent, type PackBudgets } from '../harness/contextPack';
import { collectRuntimeErrorClusters } from '../harness/runtimeAnalysis';
import { toolCoverageOf } from '../runtime/analysis';
import { WALK_PRIORS } from '../harness/episodeTelemetry';

function node(row: number, overrides: Partial<GraphNode> = {}): GraphNode {
	return {
		row,
		id: `id${row}`,
		file: `pkg/mod${row}.py`,
		lang: 'python',
		kind: 'function',
		name: `fn${row}`,
		start_line: 1,
		end_line: 10,
		summary: `summary of fn${row}`,
		rank: 0.5,
		epoch: 1,
		parent: null,
		layer: 'service',
		...overrides,
	};
}

const walkPriors = WALK_PRIORS;

suite('Context walk (typed-edge personalized PageRank)', () => {
	test('stationary mass is a probability distribution over the graph', () => {
		const nodes = [0, 1, 2, 3, 4].map((r) => node(r));
		const edges: GraphEdge[] = [
			{ src: 0, dst: 1, kind: 'invoke' },
			{ src: 1, dst: 2, kind: 'invoke' },
			{ src: 2, dst: 3, kind: 'inherit' },
		];
		const { rows, mass } = contextWalk(nodes, edges, [], [{ row: 0, weight: 1 }], walkPriors, 99);
		// All reachable nodes admitted; node 4 is disconnected and gets only
		// teleport-independent mass — with reset concentrated on the anchor it
		// must receive zero.
		assert.ok(rows.includes(0) && rows.includes(1) && rows.includes(2) && rows.includes(3));
		assert.ok(!mass.has(4) || mass.get(4) === 0, 'disconnected node holds no walk mass');
		let sum = 0;
		for (const [, m] of mass) {
			sum += m;
		}
		// The admitted set here IS the reachable set, so Σπ over it must equal 1
		// to floating-point precision — a loose tolerance would let a slow mass
		// leak (broken dangling handling) slip through.
		assert.ok(Math.abs(sum - 1) < 1e-9, `mass sums to 1 (got ${sum})`);
	});

	test('mass decays monotonically with distance from the anchor on a path', () => {
		const nodes = [0, 1, 2, 3].map((r) => node(r));
		const edges: GraphEdge[] = [
			{ src: 0, dst: 1, kind: 'invoke' },
			{ src: 1, dst: 2, kind: 'invoke' },
			{ src: 2, dst: 3, kind: 'invoke' },
		];
		const { mass } = contextWalk(nodes, edges, [], [{ row: 0, weight: 1 }], walkPriors, 99);
		const m = (r: number): number => mass.get(r) ?? 0;
		assert.ok(m(0) > m(1), 'anchor holds the most mass');
		assert.ok(m(1) > m(2) && m(2) > m(3), `geometric decay along the path: ${[m(0), m(1), m(2), m(3)]}`);
	});

	test('observed flow edges are walkable even with zero static edges', () => {
		const nodes = [0, 1].map((r) => node(r));
		const flow: FlowEdge[] = [
			{ src: 0, dst: 1, calls: 5, total_ms: 10, errors: 0, observed_only: true },
		];
		const { rows } = contextWalk(nodes, [], flow, [{ row: 0, weight: 1 }], walkPriors, 99);
		assert.ok(rows.includes(1), 'runtime-only flow carries relevance to its endpoint');
	});

	test('budget bounds admissions; anchors are always admitted', () => {
		const nodes = Array.from({ length: 30 }, (_, r) => node(r));
		const edges: GraphEdge[] = [];
		for (let i = 1; i < 30; i++) {
			edges.push({ src: 0, dst: i, kind: 'invoke' });
		}
		const { rows } = contextWalk(nodes, edges, [], [{ row: 0, weight: 1 }], walkPriors, 5);
		assert.strictEqual(rows.length, 5);
		assert.ok(rows.includes(0), 'anchor admitted');
	});

	test('walk is deterministic', () => {
		const nodes = [0, 1, 2, 3, 4, 5].map((r) => node(r));
		const edges: GraphEdge[] = [
			{ src: 0, dst: 1, kind: 'invoke' },
			{ src: 0, dst: 2, kind: 'contains' },
			{ src: 2, dst: 3, kind: 'invoke' },
			{ src: 4, dst: 5, kind: 'inherit' },
		];
		const a = contextWalk(nodes, edges, [], [{ row: 0, weight: 1 }], walkPriors, 99);
		const b = contextWalk(nodes, edges, [], [{ row: 0, weight: 1 }], walkPriors, 99);
		assert.deepStrictEqual(a.rows, b.rows);
		assert.deepStrictEqual([...a.mass.entries()], [...b.mass.entries()]);
	});

	test('beta mixing: zeroing an edge type silences it; all-zero beta degrades to reset', () => {
		const nodes = [0, 1, 2].map((r) => node(r));
		const flow: FlowEdge[] = [
			{ src: 0, dst: 1, calls: 4, total_ms: 2, errors: 0, observed_only: true },
		];
		const edges: GraphEdge[] = [{ src: 0, dst: 2, kind: 'invoke' }];
		const noFlow = { ...walkPriors, beta: { invoke: 1, inherit: 1, contains: 1, flow: 0 } };
		const walked = contextWalk(nodes, edges, flow, [{ row: 0, weight: 1 }], noFlow, 99);
		assert.ok(!walked.rows.includes(1), 'β_flow = 0 silences observed flow');
		assert.ok(walked.rows.includes(2), 'static invoke still walks');
		// Σβ = 0: the no-kernel limit — stationary distribution IS the reset.
		const zero = { ...walkPriors, beta: { invoke: 0, inherit: 0, contains: 0, flow: 0 } };
		const onlyReset = contextWalk(nodes, edges, flow, [{ row: 0, weight: 1 }], zero, 99);
		assert.deepStrictEqual(onlyReset.rows, [0]);
		assert.strictEqual(onlyReset.mass.get(0), 1, 'all mass on the anchor, no NaN');
	});

	test('maxHops bounds admission without changing the ranking math', () => {
		const nodes = [0, 1, 2, 3].map((r) => node(r));
		const edges: GraphEdge[] = [
			{ src: 0, dst: 1, kind: 'invoke' },
			{ src: 1, dst: 2, kind: 'invoke' },
			{ src: 2, dst: 3, kind: 'invoke' },
		];
		const walked = contextWalk(nodes, edges, [], [{ row: 0, weight: 1 }], walkPriors, 99, 1);
		assert.deepStrictEqual(walked.rows.sort(), [0, 1], 'only the anchor and its 1-hop neighbor');
		const zeroHops = contextWalk(nodes, edges, [], [{ row: 0, weight: 1 }], walkPriors, 99, 0);
		assert.deepStrictEqual(zeroHops.rows, [0], 'depth 0 keeps seeds only');
	});

	test('anchors are admitted even when they exceed the budget', () => {
		const nodes = [0, 1, 2].map((r) => node(r));
		const anchors = [0, 1, 2].map((row) => ({ row, weight: 1 }));
		const walked = contextWalk(nodes, [], [], anchors, walkPriors, 1);
		assert.strictEqual(walked.rows.length, 3, 'documented behavior: anchors always admitted');
	});

	test('name specificity is 1/df and downweights ubiquitous names', () => {
		const nodes = [
			node(0, { name: 'setup' }),
			node(1, { name: 'setup' }),
			node(2, { name: 'unique_thing' }),
		];
		const spec = nameSpecificity(nodes);
		assert.strictEqual(spec.get(0), 0.5);
		assert.strictEqual(spec.get(2), 1);
		assert.ok(rrfAnchorWeight(0, 60) > rrfAnchorWeight(4, 60), 'RRF weight decays with rank');
	});
});

suite('Failure exemplars (trace.jsonl → overlay evidence chain)', () => {
	test('error message, stack, caller chain and args survive into the overlay', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-ctx-'));
		const capDir = path.join(tmp, '.vinv', 'captures', 's1', 'svc');
		fs.mkdirSync(capDir, { recursive: true });
		const rows = [
			{
				ts: 't0',
				request_id: 'req1',
				component: 'pkg.mod0.fn0',
				event: 'enter',
				depth: 1,
				parent_component: 'pkg.mod1.fn1',
				thread_id: 1,
				args_schema: '(result:dict)',
				args_summary: { result: { len: 14 } },
			},
			{
				ts: 't1',
				request_id: 'req1',
				component: 'pkg.mod1.fn1',
				event: 'exit',
				depth: 0,
				parent_component: null,
				thread_id: 1,
				duration_ms: 45118.4,
				status: 'error',
				error_type: 'OSError',
				error_message: '[Errno 5] Input/output error',
			},
			{
				ts: 't2',
				request_id: 'req1',
				component: 'pkg.mod0.fn0',
				event: 'exit',
				depth: 1,
				parent_component: 'pkg.mod1.fn1',
				thread_id: 1,
				duration_ms: 20865.3,
				status: 'error',
				error_type: 'OSError',
				error_message: '[Errno 5] Input/output error',
				error_stack: 'Traceback (most recent call last):\n  File "cli.py", line 24, in fn0\nOSError: [Errno 5] Input/output error',
			},
		];
		fs.writeFileSync(
			path.join(capDir, 'trace.jsonl'),
			rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
		);
		const nodes = [node(0), node(1)];
		const { runtime, flow } = loadRuntimeAndFlow(tmp, nodes, []);
		fs.rmSync(tmp, { recursive: true, force: true });

		const rt0 = runtime[0];
		assert.ok(rt0, 'fn0 joined from the capture');
		assert.strictEqual(rt0.errors, 1);
		assert.strictEqual(rt0.failures.length, 1);
		const f = rt0.failures[0];
		assert.strictEqual(f.error_type, 'OSError');
		assert.strictEqual(f.error_message, '[Errno 5] Input/output error');
		assert.ok(f.error_stack?.includes('line 24'), 'traceback tail preserved');
		assert.deepStrictEqual(f.caller_chain, ['pkg.mod1.fn1'], 'observed caller chain resolved');
		assert.strictEqual(f.args_schema, '(result:dict)');
		assert.deepStrictEqual(f.args_summary, { result: { len: 14 } });
		assert.strictEqual(f.request_id, 'req1');
		// The observed parent→child call also became a flow edge.
		assert.ok(
			flow.some((e) => e.src === 1 && e.dst === 0 && e.errors === 1),
			'observed flow edge extracted',
		);
	});

	test('successful-call args land in arg_exemplars, deduped by shape with the slowest kept', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-ctx-'));
		const capDir = path.join(tmp, '.vinv', 'captures', 's1', 'svc');
		fs.mkdirSync(capDir, { recursive: true });
		// Three successful calls of fn0: two share an arg shape (page_size 20),
		// one differs (page_size 50). No error anywhere — the old code dropped
		// all of these args on the floor.
		const call = (req: string, pageSize: number, ms: number) => [
			{
				request_id: req,
				component: 'pkg.mod0.fn0',
				event: 'enter',
				thread_id: 1,
				args_schema: '(page:int, page_size:int)',
				args_summary: { page: 1, page_size: pageSize },
			},
			{
				request_id: req,
				component: 'pkg.mod0.fn0',
				event: 'exit',
				thread_id: 1,
				duration_ms: ms,
				status: 'ok',
			},
		];
		const rows = [
			...call('r1', 20, 100),
			...call('r2', 20, 250), // same shape, slower → becomes representative
			...call('r3', 50, 30),
		];
		fs.writeFileSync(
			path.join(capDir, 'trace.jsonl'),
			rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
		);
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0)], []);
		fs.rmSync(tmp, { recursive: true, force: true });

		const rt0 = runtime[0];
		assert.ok(rt0, 'fn0 joined from the capture');
		assert.strictEqual(rt0.errors, 0, 'no failures recorded');
		assert.strictEqual(rt0.calls, 3);
		const args = rt0.arg_exemplars ?? [];
		assert.strictEqual(args.length, 2, 'two distinct arg shapes');
		// Highest count first: page_size 20 seen twice.
		assert.strictEqual(args[0].count, 2);
		assert.deepStrictEqual(args[0].args_summary, { page: 1, page_size: 20 });
		assert.strictEqual(args[0].max_duration_ms, 250, 'slowest call kept as representative');
		assert.strictEqual(args[0].request_id, 'r2');
		assert.strictEqual(args[1].count, 1);
		assert.deepStrictEqual(args[1].args_summary, { page: 1, page_size: 50 });
	});

	test('raw captures win over derived tracemaps — no double counting', () => {
		// The same run recorded twice on disk: once as the raw trace.jsonl and
		// once as a derived tracemap report. Counts must NOT sum across the two.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-ctx-'));
		const capDir = path.join(tmp, '.vinv', 'captures', 's1', 'svc');
		const idDir = path.join(tmp, '.vinv', 'identification');
		fs.mkdirSync(capDir, { recursive: true });
		fs.mkdirSync(idDir, { recursive: true });
		fs.writeFileSync(
			path.join(capDir, 'trace.jsonl'),
			JSON.stringify({
				ts: 't',
				request_id: 'r1',
				component: 'pkg.mod0.fn0',
				event: 'exit',
				depth: 0,
				parent_component: null,
				thread_id: 1,
				duration_ms: 10,
				status: 'ok',
			}) + '\n',
		);
		fs.writeFileSync(
			path.join(idDir, 'x.tracemap.json'),
			JSON.stringify({
				tree: {
					file: 'pkg/mod0.py',
					name: 'fn0',
					runtime: { executed: true, calls: 1, total_ms: 10, error: 0, errors: [] },
					children: [],
				},
			}),
		);
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0)], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].calls, 1, 'one observed call, not two');
		assert.strictEqual(Math.round(runtime[0].total_ms), 10, '10ms, not 20');
	});

	test('repeat failures dedupe by (type, message) with counts', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-ctx-'));
		const capDir = path.join(tmp, '.vinv', 'captures', 's1', 'svc');
		fs.mkdirSync(capDir, { recursive: true });
		const exit = (req: string): string =>
			JSON.stringify({
				ts: 't',
				request_id: req,
				component: 'pkg.mod0.fn0',
				event: 'exit',
				depth: 0,
				parent_component: null,
				thread_id: 1,
				duration_ms: 5,
				status: 'error',
				error_type: 'KeyError',
				error_message: "'cart'",
			});
		fs.writeFileSync(path.join(capDir, 'trace.jsonl'), [exit('r1'), exit('r2'), exit('r3')].join('\n'));
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0)], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].failures.length, 1, 'one exemplar');
		assert.strictEqual(runtime[0].failures[0].count, 3, 'with the occurrence count');
	});
});

suite('Evidence lifecycle (fix detection, retirement, no stale-error confusion)', () => {
	/** Writes one capture session (dir with trace.jsonl + optional epoch.json). */
	function writeSession(
		root: string,
		name: string,
		epoch: number | null,
		t: number,
		rows: Array<Record<string, unknown>>,
	): void {
		const dir = path.join(root, '.vinv', 'captures', name, 'svc');
		fs.mkdirSync(dir, { recursive: true });
		const trace = path.join(dir, 'trace.jsonl');
		fs.writeFileSync(trace, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
		fs.utimesSync(trace, new Date(t), new Date(t));
		if (epoch !== null) {
			fs.writeFileSync(
				path.join(dir, 'epoch.json'),
				JSON.stringify({ epoch, captured_unix: Math.floor(t / 1000) }),
			);
		}
	}
	const errExit = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
		ts: 't',
		request_id: 'r1',
		component: 'pkg.mod0.fn0',
		event: 'exit',
		depth: 0,
		parent_component: null,
		thread_id: 1,
		duration_ms: 5,
		status: 'error',
		error_type: 'OSError',
		error_message: '[Errno 5] Input/output error',
		...over,
	});
	const okExit = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
		ts: 't',
		request_id: 'r2',
		component: 'pkg.mod0.fn0',
		event: 'exit',
		depth: 0,
		parent_component: null,
		thread_id: 1,
		duration_ms: 3,
		status: 'ok',
		...over,
	});

	test('fixed and verified by a later clean run → not_reproduced, current_errors 0, issue retired', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lc-'));
		writeSession(tmp, 'old-run', 5, 1_000_000, [errExit()]);
		writeSession(tmp, 'new-run', 6, 2_000_000, [okExit()]);
		const n = node(0, { epoch: 6 }); // code changed (the fix) and reindexed
		const { runtime } = loadRuntimeAndFlow(tmp, [n], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		const rt = runtime[0];
		assert.strictEqual(rt.errors, 1, 'lifetime history keeps the error');
		assert.strictEqual(rt.current_errors, 0, 'latest run is clean');
		assert.strictEqual(rt.latest_epoch, 6);
		assert.strictEqual(rt.failures[0].superseded, 'not_reproduced');
		// Issue retirement: the cluster list (what vinv_session issues and the
		// auto-trigger signature are built from) no longer contains the row.
		const { clusters, signature } = collectRuntimeErrorClusters([n], runtime);
		assert.strictEqual(clusters.length, 0, 'retired from issues');
		assert.strictEqual(signature, '', 'signature changes so dedupe state stays consistent');
	});

	test('code changed but NO fresh run → code_changed (unverified), issue stays open', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lc-'));
		writeSession(tmp, 'only-run', 5, 1_000_000, [errExit()]);
		const n = node(0, { epoch: 7 }); // code moved on, nobody re-ran
		const { runtime } = loadRuntimeAndFlow(tmp, [n], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].failures[0].superseded, 'code_changed');
		assert.strictEqual(runtime[0].current_errors, 1, 'latest observed run DID fail');
		const { clusters } = collectRuntimeErrorClusters([n], runtime);
		assert.strictEqual(clusters.length, 1, 'an unverified fix must NOT retire the issue');
	});

	test('env-fixed without a code change (same epoch, later clean run) → not_reproduced', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lc-'));
		writeSession(tmp, 'run-a', 5, 1_000_000, [errExit()]);
		writeSession(tmp, 'run-b', 5, 2_000_000, [okExit()]);
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0, { epoch: 5 })], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].failures[0].superseded, 'not_reproduced');
		assert.strictEqual(runtime[0].current_errors, 0);
	});

	test('flaky within one run (error + ok interleaved) stays CURRENT', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lc-'));
		writeSession(tmp, 'run', 5, 1_000_000, [errExit(), okExit()]);
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0, { epoch: 5 })], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].failures[0].superseded, null, 'no later run cleared it');
		assert.strictEqual(runtime[0].current_errors, 1);
	});

	test('still failing across runs → current with accumulated count', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lc-'));
		writeSession(tmp, 'old', 5, 1_000_000, [errExit()]);
		writeSession(tmp, 'new', 6, 2_000_000, [errExit({ request_id: 'r9' })]);
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0, { epoch: 6 })], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].failures[0].superseded, null, 'reproduced in latest run');
		assert.strictEqual(runtime[0].failures[0].count, 2);
		assert.strictEqual(runtime[0].current_errors, 1);
	});

	test('untagged legacy sessions order by mtime and never claim code_changed', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lc-'));
		writeSession(tmp, 'legacy-err', null, 1_000_000, [errExit()]);
		writeSession(tmp, 'legacy-ok', null, 2_000_000, [okExit()]);
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0, { epoch: 9 })], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].failures[0].superseded, 'not_reproduced', 'mtime ordering still retires');
		assert.strictEqual(runtime[0].current_errors, 0);
	});

	test('per-symbol latest: an unrelated service run never retires another symbol', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lc-'));
		writeSession(tmp, 'svc-a', 5, 1_000_000, [errExit()]);
		// Later session observing a DIFFERENT symbol only.
		writeSession(tmp, 'svc-b', 6, 2_000_000, [okExit({ component: 'pkg.mod1.fn1' })]);
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0, { epoch: 5 }), node(1)], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].failures[0].superseded, null, 'fn0 was not observed again — still current');
		assert.strictEqual(runtime[0].current_errors, 1);
	});
});

suite('Lifecycle ordering edge cases (adversarial review follow-ups)', () => {
	const writeSession = (
		root: string,
		name: string,
		epoch: number | null,
		t: number,
		rows: Array<Record<string, unknown>>,
	): void => {
		const dir = path.join(root, '.vinv', 'captures', name, 'svc');
		fs.mkdirSync(dir, { recursive: true });
		const trace = path.join(dir, 'trace.jsonl');
		fs.writeFileSync(trace, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
		fs.utimesSync(trace, new Date(t), new Date(t));
		if (epoch !== null) {
			fs.writeFileSync(
				path.join(dir, 'epoch.json'),
				JSON.stringify({ epoch, captured_unix: Math.floor(t / 1000) }),
			);
		}
	};
	const flowRows = (status: 'ok' | 'error'): Array<Record<string, unknown>> => [
		{ ts: 't', request_id: 'r', component: 'pkg.mod1.fn1', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 9, status: 'ok' },
		{ ts: 't', request_id: 'r', component: 'pkg.mod0.fn0', event: 'exit', depth: 1, parent_component: 'pkg.mod1.fn1', thread_id: 1, duration_ms: 3, status, ...(status === 'error' ? { error_type: 'OSError', error_message: 'boom' } : {}) },
	];

	test('P0: a flow edge that errored then ran clean later retires (current_errors 0)', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-fl-'));
		writeSession(tmp, 'old', 5, 1_000_000, flowRows('error'));
		writeSession(tmp, 'new', 6, 2_000_000, flowRows('ok'));
		const { flow } = loadRuntimeAndFlow(tmp, [node(0), node(1)], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		const edge = flow.find((e) => e.src === 1 && e.dst === 0)!;
		assert.strictEqual(edge.errors, 1, 'lifetime keeps the error');
		assert.strictEqual(edge.current_errors, 0, 'latest run clean — path retires');
	});

	test('P0: a flow edge still erroring in the latest run stays current', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-fl-'));
		writeSession(tmp, 'old', 5, 1_000_000, flowRows('error'));
		writeSession(tmp, 'new', 6, 2_000_000, flowRows('error'));
		const { flow } = loadRuntimeAndFlow(tmp, [node(0), node(1)], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		const edge = flow.find((e) => e.src === 1 && e.dst === 0)!;
		assert.strictEqual(edge.current_errors, 1, 'still failing in latest run');
	});

	test('P1: captured_unix (not mtime) drives time ordering when they disagree', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-cu-'));
		const errE = { ts: 't', request_id: 'r1', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 5, status: 'error', error_type: 'OSError', error_message: 'x' };
		const okE = { ts: 't', request_id: 'r2', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 3, status: 'ok' };
		fs.mkdirSync(path.join(tmp, '.vinv/captures/old/svc'), { recursive: true });
		fs.writeFileSync(path.join(tmp, '.vinv/captures/old/svc/trace.jsonl'), JSON.stringify(errE) + '\n');
		fs.writeFileSync(path.join(tmp, '.vinv/captures/old/svc/epoch.json'), JSON.stringify({ epoch: 5, captured_unix: 1000 }));
		fs.utimesSync(path.join(tmp, '.vinv/captures/old/svc/trace.jsonl'), new Date(9_000_000), new Date(9_000_000));
		fs.mkdirSync(path.join(tmp, '.vinv/captures/new/svc'), { recursive: true });
		fs.writeFileSync(path.join(tmp, '.vinv/captures/new/svc/trace.jsonl'), JSON.stringify(okE) + '\n');
		fs.writeFileSync(path.join(tmp, '.vinv/captures/new/svc/epoch.json'), JSON.stringify({ epoch: 5, captured_unix: 5000 }));
		fs.utimesSync(path.join(tmp, '.vinv/captures/new/svc/trace.jsonl'), new Date(1_000_000), new Date(1_000_000));
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0, { epoch: 5 })], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].current_errors, 0, 'captured_unix ordering makes the clean run latest');
		assert.strictEqual(runtime[0].failures[0].superseded, 'not_reproduced');
	});

	test('P2: concurrent (same epoch+time) err+clean runs merge — deterministic AND never falsely fixed', () => {
		const mk = (): { current: number; superseded: string | null } => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-tie-'));
			writeSession(tmp, 'aaa', 5, 1_000_000, [{ ts: 't', request_id: 'r', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 5, status: 'error', error_type: 'OSError', error_message: 'x' }]);
			writeSession(tmp, 'bbb', 5, 1_000_000, [{ ts: 't', request_id: 'r2', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 3, status: 'ok' }]);
			const rt = loadRuntimeAndFlow(tmp, [node(0, { epoch: 5 })], []).runtime[0];
			fs.rmSync(tmp, { recursive: true, force: true });
			return { current: rt.current_errors, superseded: rt.failures[0].superseded };
		};
		const r1 = mk();
		const r2 = mk();
		assert.deepStrictEqual(r1, r2, 'concurrent-session merge is deterministic across builds');
		assert.strictEqual(r1.current, 1, 'a tie between failing and clean keeps the error current (safe)');
		assert.strictEqual(r1.superseded, null, 'never falsely marks a concurrent error as resolved');
	});

	test('P3: clean run then ANOTHER code change -> code_changed (unverified), not RESOLVED', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-p3-'));
		writeSession(tmp, 'err', 5, 1_000_000, [{ ts: 't', request_id: 'r1', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 5, status: 'error', error_type: 'OSError', error_message: 'x' }]);
		writeSession(tmp, 'clean', 6, 2_000_000, [{ ts: 't', request_id: 'r2', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 3, status: 'ok' }]);
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0, { epoch: 7 })], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(runtime[0].failures[0].superseded, 'code_changed', 'clean run did not exercise the current code');
		assert.strictEqual(runtime[0].current_errors, 0, 'latest observed run was clean');
	});

	test('Q7: coverage_of and the graph overlay agree on the code_changed verdict too', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-cc-'));
		writeSession(tmp, 'only', 5, 1_000_000, [{ ts: 't', request_id: 'r1', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 5, status: 'error', error_type: 'OSError', error_message: 'x' }]);
		// Build a minimal index so coverage_of's chunkForComponent can date it.
		const idx = path.join(tmp, '.vinv', 'index');
		fs.mkdirSync(idx, { recursive: true });
		fs.writeFileSync(path.join(idx, 'chunks.jsonl'), JSON.stringify({ id: 'c0', file: 'pkg/mod0.py', lang: 'python', kind: 'function', name: 'fn0', start_line: 1, end_line: 3, summary: 's', rank: 0.5, epoch: 8 }) + '\n');
		fs.writeFileSync(path.join(idx, 'edges.jsonl'), '');
		fs.writeFileSync(path.join(idx, 'meta.json'), JSON.stringify({ epoch: 8 }));
		const graph = loadRuntimeAndFlow(tmp, [node(0, { file: 'pkg/mod0.py', name: 'fn0', epoch: 8 })], []).runtime[0];
		const cov = toolCoverageOf(tmp, 'pkg.mod0.fn0') as { current_errors: number; failures: Array<{ superseded: string | null }> };
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(graph.failures[0].superseded, 'code_changed', 'code advanced past the failure, no rerun');
		assert.strictEqual(cov.failures[0].superseded, graph.failures[0].superseded, 'both engines agree on code_changed');
		assert.strictEqual(cov.current_errors, graph.current_errors);
	});

	test('Q6: assembleEvidence names a cap-overflowed current error in the failure-site digest', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-q6r-'));
		const many = Array.from({ length: 20 }, (_, i) => ({ ts: 't', request_id: 'r' + i, component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 1, status: 'error', error_type: 'OSError', error_message: 'm' + i }));
		writeSession(tmp, 'old', 5, 1_000_000, many);
		writeSession(tmp, 'new', 6, 2_000_000, [{ ts: 't', request_id: 'rN', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 1, status: 'error', error_type: 'ValueError', error_message: 'brand new' }]);
		const idx = path.join(tmp, '.vinv', 'index');
		fs.mkdirSync(idx, { recursive: true });
		fs.writeFileSync(path.join(idx, 'chunks.jsonl'), JSON.stringify({ id: 'c0', file: 'pkg/mod0.py', lang: 'python', kind: 'function', name: 'fn0', start_line: 1, end_line: 3, summary: 's', rank: 0.5, epoch: 6 }) + '\n');
		fs.writeFileSync(path.join(idx, 'edges.jsonl'), '');
		fs.writeFileSync(path.join(idx, 'meta.json'), JSON.stringify({ epoch: 6 }));
		const snapshot = buildGraphSnapshot(tmp);
		const n = snapshot.nodes.find((x) => x.name === 'fn0')!;
		const evidence = assembleEvidence(tmp, snapshot, 'why does fn0 fail', [], { seedRows: [n.row] });
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.ok(/Observed failure sites/.test(evidence.contextMarkdown), 'digest present');
		assert.ok(/latest run/.test(evidence.contextMarkdown) && /ValueError|error\(s\) in the latest run/.test(evidence.contextMarkdown), 'the current error is named even though its exemplar was capped');
	});

	test('P1/Q7: coverage_of and the graph overlay agree on the same trace', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-agree-'));
		writeSession(tmp, 'old', 5, 1_000_000, [{ ts: 't', request_id: 'r1', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 5, status: 'error', error_type: 'OSError', error_message: 'x' }]);
		writeSession(tmp, 'new', 6, 2_000_000, [{ ts: 't', request_id: 'r2', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 3, status: 'ok' }]);
		const graph = loadRuntimeAndFlow(tmp, [node(0, { epoch: 5 })], []).runtime[0];
		const cov = toolCoverageOf(tmp, 'pkg.mod0.fn0') as {
			current_errors: number;
			failures: Array<{ superseded: string | null }>;
		};
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.strictEqual(cov.current_errors, graph.current_errors, 'current_errors agree');
		assert.strictEqual(
			cov.failures[0].superseded,
			graph.failures[0].superseded,
			'superseded verdict agrees across the two engines',
		);
	});

	test('Q6: cap-overflowed current error still counts (current_errors is source of truth)', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-cap-'));
		const many = Array.from({ length: 20 }, (_, i) => ({ ts: 't', request_id: 'r' + i, component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 1, status: 'error', error_type: 'OSError', error_message: 'msg' + i }));
		writeSession(tmp, 'old', 5, 1_000_000, many);
		writeSession(tmp, 'new', 6, 2_000_000, [{ ts: 't', request_id: 'rNew', component: 'pkg.mod0.fn0', event: 'exit', depth: 0, parent_component: null, thread_id: 1, duration_ms: 1, status: 'error', error_type: 'ValueError', error_message: 'brand new' }]);
		const { runtime } = loadRuntimeAndFlow(tmp, [node(0, { epoch: 6 })], []);
		fs.rmSync(tmp, { recursive: true, force: true });
		assert.ok(runtime[0].current_errors >= 1, 'latest run error counted despite the cap');
		assert.ok(runtime[0].error_types.includes('ValueError'), 'the new error type is still recorded');
	});
});


suite('QnA sufficiency verdict (failure-driven retrial protocol)', () => {
	test('parses an insufficient verdict and strips it from the body', () => {
		const answer =
			'The failure is an OSError but the message is absent.\n\n' +
			'```json\n{"sufficient": false, "missing": ["OSError message for _emit", "consolidate_cmd trace"]}\n```';
		const v = parseSufficiency(answer);
		assert.strictEqual(v.sufficient, false);
		assert.deepStrictEqual(v.missing, ['OSError message for _emit', 'consolidate_cmd trace']);
		assert.ok(!v.body.includes('sufficient'), 'verdict stripped from displayed body');
	});

	test('a dropped closing fence still parses (observed live-model behavior)', () => {
		const answer =
			'Analysis here.\n\n```json\n{"sufficient":false,"missing":["traceback for OSError"]}';
		const v = parseSufficiency(answer);
		assert.strictEqual(v.sufficient, false);
		assert.deepStrictEqual(v.missing, ['traceback for OSError']);
		assert.strictEqual(v.body, 'Analysis here.');
	});

	test('a bare unfenced verdict object parses too', () => {
		const v = parseSufficiency('Body.\n{"sufficient": false, "missing": ["x"]}');
		assert.strictEqual(v.sufficient, false);
		assert.strictEqual(v.body, 'Body.');
	});

	test('missing or malformed verdicts degrade to sufficient (no retry loop)', () => {
		assert.strictEqual(parseSufficiency('plain answer with no fence').sufficient, true);
		assert.strictEqual(
			parseSufficiency('answer\n```json\n{not json}\n```').sufficient,
			true,
		);
		const explicit = parseSufficiency('ok\n```json\n{"sufficient": true, "missing": []}\n```');
		assert.strictEqual(explicit.sufficient, true);
		assert.strictEqual(explicit.body, 'ok');
	});
});

suite('Harness handover pack (graph + evidence transfer)', () => {
	function snapshotWith(runtimeFailures: boolean): GraphSnapshot {
		const nodes = [node(0), node(1), node(2)];
		const edges: GraphEdge[] = [
			{ src: 0, dst: 1, kind: 'invoke' },
			{ src: 1, dst: 2, kind: 'invoke' },
		];
		const flow: FlowEdge[] = [
			{ src: 1, dst: 0, calls: 2, total_ms: 9, errors: 1, observed_only: true },
		];
		return {
			generated_at: 't',
			workspace: '/w',
			store_epoch: 3,
			node_count: nodes.length,
			edge_count: edges.length,
			layers: ['service'],
			nodes,
			edges,
			files: [],
			file_edges: [],
			tour: [],
			runtime: runtimeFailures
				? {
						0: {
							executed: true,
							calls: 1,
							total_ms: 20865,
							errors: 1,
							error_types: ['OSError'],
							failures: [
								{
									error_type: 'OSError',
									error_message: '[Errno 5] Input/output error',
									error_stack: 'Traceback ... OSError: [Errno 5] Input/output error',
									request_id: 'req1',
									caller_chain: ['pkg.mod1.fn1'],
									args_schema: '(result:dict)',
									args_summary: { result: { len: 14 } },
									duration_ms: 20865,
									count: 1,
									capture_epoch: 3,
									superseded: null,
								},
							],
							current_errors: 1,
							latest_epoch: 3,
						},
					}
				: {},
			flow_edges: flow,
		};
	}
	const budgets: PackBudgets = {
		slice_budget: 24,
		seed_cap: 8,
		failure_evidence_chars: 3000,
		walk: walkPriors,
	};
	const arm = { slice_depth: 2, include_runtime: true, snippet_chars: 1600 };

	test('pack carries the failure identity, typed edges, and rehydration pointers', () => {
		const { content, sliceRows } = composePackContent(
			snapshotWith(true),
			{
				title: 'Fix _emit OSError',
				issue: 'fn0 raised OSError during consolidate',
				successCriteria: ['fn0 no longer raises'],
				seedRows: [0],
			},
			arm,
			budgets,
			1,
		);
		assert.ok(content.includes('[Errno 5] Input/output error'), 'the MESSAGE, not just the class');
		assert.ok(content.includes('Traceback'), 'traceback travels to the harness');
		assert.ok(content.includes('call path: pkg.mod1.fn1'), 'observed caller chain');
		assert.ok(content.includes('(result:dict)'), 'failing-call args schema');
		assert.ok(content.includes('walk mass'), 'relevance math visible');
		assert.ok(content.includes('—invoke→'), 'typed static adjacency included');
		assert.ok(content.includes('—observed ×2'), 'observed flow adjacency included');
		assert.ok(content.includes('vinv-runtime'), 'MCP rehydration pointer present');
		assert.ok(sliceRows.includes(0) && sliceRows.includes(1), 'walk expanded along edges');
	});

	test('flow-linked symbols enter the slice even without static edges', () => {
		const snapshot = snapshotWith(false);
		snapshot.edges = [];
		const { sliceRows } = composePackContent(
			snapshot,
			{ title: 't', issue: 'fn0 broken', successCriteria: ['fixed'], seedRows: [0] },
			arm,
			budgets,
			1,
		);
		assert.ok(sliceRows.includes(1), 'runtime-only flow edge reached fn1');
	});
});
