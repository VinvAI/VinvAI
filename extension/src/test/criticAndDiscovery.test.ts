/**
 * Tests for the deterministic answer critic, the widened verdict protocol
 * (typed actions + defaulted flag), the retrial missing-cap, and store
 * discovery with provenance — the pieces the ateam verdict shipped.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { critiqueAnswer } from '../qna/critic';
import { assembleEvidence, parseSufficiency } from '../qna/answer';
import { walkParams, WALK_PRIORS, POLICY_PRIORS, type WalkParams } from '../harness/episodeTelemetry';
import { discoverStores, describeProvenance } from '../graph/storeDiscovery';
import type { GraphNode, GraphSnapshot, RuntimeOverlay } from '../graph/indexGraph';

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

function snapshotOf(
	nodes: GraphNode[],
	runtime: Record<number, RuntimeOverlay> = {},
	storeEpoch = 2,
): GraphSnapshot {
	return {
		generated_at: '',
		workspace: '/tmp/x',
		store_epoch: storeEpoch,
		node_count: nodes.length,
		edge_count: 0,
		layers: [],
		nodes,
		edges: [],
		files: [],
		file_edges: [],
		tour: [],
		runtime,
		flow_edges: [],
	};
}

function evidenceFor(
	snapshot: GraphSnapshot,
	seedRows: number[] = [],
): ReturnType<typeof assembleEvidence> {
	return assembleEvidence('/nonexistent-root', snapshot, 'q', [], { seedRows });
}

suite('Deterministic answer critic', () => {
	test('grounded citations pass; unindexed files are flagged', () => {
		const snapshot = snapshotOf([node(0, { file: 'admin/src/auth.py' }), node(1)]);
		const ev = evidenceFor(snapshot);
		const ok = critiqueAnswer(snapshot, ev, 'The gate is `admin/src/auth.py:12` and pkg/mod1.py:3.');
		assert.deepStrictEqual(ok.ungrounded, []);
		assert.strictEqual(ok.grounded, true);
		assert.strictEqual(ok.citations.length, 2);
		const bad = critiqueAnswer(snapshot, ev, 'See made/up/file.py:99 for details.');
		assert.deepStrictEqual(bad.ungrounded, ['made/up/file.py:99']);
		assert.strictEqual(bad.grounded, false);
	});

	test('suffix matching aligns on separators — auth.py never matches oauth.py', () => {
		const snapshot = snapshotOf([node(0, { file: 'lib/oauth.py' })]);
		const ev = evidenceFor(snapshot);
		const r = critiqueAnswer(snapshot, ev, 'Look at auth.py:5.');
		assert.deepStrictEqual(r.ungrounded, ['auth.py:5']);
		// The full path (or a deeper suffix) does ground.
		const r2 = critiqueAnswer(snapshot, ev, 'Look at lib/oauth.py:5.');
		assert.deepStrictEqual(r2.ungrounded, []);
	});

	test('no citations → not grounded (uninformative, never a verified bit)', () => {
		const snapshot = snapshotOf([node(0)]);
		const ev = evidenceFor(snapshot);
		const r = critiqueAnswer(snapshot, ev, 'A prose answer without any citation.');
		assert.strictEqual(r.citations.length, 0);
		assert.strictEqual(r.grounded, false);
		assert.deepStrictEqual(r.ungrounded, []);
	});

	test('tense/staleness heuristics are warnings, never retrial triggers', () => {
		const superseded: RuntimeOverlay = {
			executed: true,
			calls: 3,
			total_ms: 5,
			errors: 1,
			error_types: ['ValueError'],
			failures: [
				{
					error_type: 'ValueError',
					error_message: 'bad',
					count: 1,
					duration_ms: 1,
					request_id: 'r',
					caller_chain: [],
					args_schema: null,
					args_summary: null,
					error_stack: null,
					capture_epoch: 1,
					superseded: 'not_reproduced',
				},
			],
			arg_exemplars: [],
			current_errors: 0,
			latest_epoch: 2,
		};
		const snapshot = snapshotOf([node(0, { epoch: 2 })], { 0: superseded }, 2);
		const ev = evidenceFor(snapshot, [0]);
		const r = critiqueAnswer(snapshot, ev, 'fn0 raises ValueError at pkg/mod0.py:1.');
		assert.ok(r.warnings.some((w) => w.startsWith('tense:')), `warnings: ${r.warnings}`);
		// Warnings do not make citations ungrounded.
		assert.deepStrictEqual(r.ungrounded, []);
	});
});

suite('Runtime cost analyses in QnA evidence', () => {
	test('hotspot Pareto head renders when the overlay has measured time', () => {
		const rt = (ms: number, calls: number): RuntimeOverlay => ({
			executed: true,
			calls,
			total_ms: ms,
			errors: 0,
			error_types: [],
			failures: [],
			arg_exemplars: [],
			current_errors: 0,
			latest_epoch: 1,
		});
		const snapshot = snapshotOf([node(0), node(1), node(2)], { 0: rt(900, 3), 1: rt(90, 1) });
		const ev = evidenceFor(snapshot, [2]);
		assert.ok(
			ev.contextMarkdown.includes('Runtime cost analyses'),
			'analyses section present when overlay exists',
		);
		assert.ok(/fn0 .*900ms .*3 call/.test(ev.contextMarkdown), ev.contextMarkdown.slice(-400));
	});

	test('no overlay → no analyses section (nothing measured, nothing claimed)', () => {
		const snapshot = snapshotOf([node(0)]);
		const ev = evidenceFor(snapshot, [0]);
		assert.ok(!ev.contextMarkdown.includes('Runtime cost analyses'));
	});
});

suite('Widened sufficiency verdict (actions + defaulted)', () => {
	test('typed actions parse; malformed entries are dropped', () => {
		const v = parseSufficiency(
			'Body.\n```json\n{"sufficient": false, "missing": ["x"], "actions": [' +
				'{"kind": "search", "target": "seat cap logic"},' +
				'{"kind": "read", "target": "LicenseController"},' +
				'{"kind": "nonsense", "target": "y"},' +
				'{"kind": "walk"}' +
				']}\n```',
		);
		assert.strictEqual(v.sufficient, false);
		assert.deepStrictEqual(v.actions, [
			{ kind: 'search', target: 'seat cap logic' },
			{ kind: 'read', target: 'LicenseController' },
		]);
		assert.strictEqual(v.defaulted, false);
	});

	test('missing verdict sets defaulted so the anomaly can be ledgered', () => {
		const v = parseSufficiency('An answer that lost its verdict to truncation');
		assert.strictEqual(v.sufficient, true);
		assert.strictEqual(v.defaulted, true);
		assert.deepStrictEqual(v.actions, []);
	});

	test('well-formed verdict without actions still parses (plain channel)', () => {
		const v = parseSufficiency('ok\n```json\n{"sufficient": true, "missing": []}\n```');
		assert.strictEqual(v.defaulted, false);
		assert.deepStrictEqual(v.actions, []);
	});
});

suite('Walk-policy schema growth (retry_missing_cap)', () => {
	test('priors carry the cap; stored pre-cap policies stay valid and get the prior', () => {
		assert.ok((WALK_PRIORS.retry_missing_cap ?? 0) >= 1);
		const preCapWalk = { ...WALK_PRIORS, beta: { ...WALK_PRIORS.beta } } as WalkParams;
		delete preCapWalk.retry_missing_cap;
		const filled = walkParams({ ...POLICY_PRIORS, walk: preCapWalk });
		assert.strictEqual(filled.retry_missing_cap, WALK_PRIORS.retry_missing_cap);
	});
});

suite('Store discovery + provenance', () => {
	function mkStore(
		root: string,
		opts: { epoch?: number; updated?: number; capture?: string; rewritten?: number } = {},
	): void {
		fs.mkdirSync(path.join(root, '.vinv', 'index'), { recursive: true });
		fs.writeFileSync(
			path.join(root, '.vinv', 'index', 'meta.json'),
			JSON.stringify({ epoch: opts.epoch ?? 1, updated_unix: opts.updated ?? 100 }),
		);
		if (opts.capture !== undefined) {
			const sess = path.join(root, '.vinv', 'captures', 'svc');
			fs.mkdirSync(sess, { recursive: true });
			fs.writeFileSync(path.join(sess, 'trace.jsonl'), opts.capture);
			if (opts.rewritten !== undefined) {
				fs.writeFileSync(
					path.join(sess, 'trace.jsonl.summary.json'),
					JSON.stringify({ coverage: { modules_scanned: 10, modules_rewritten: opts.rewritten } }),
				);
			}
		}
	}

	test('finds parent and child stores; root first, rest by capture recency', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-disc-'));
		mkStore(tmp, { epoch: 2 });
		mkStore(path.join(tmp, 'child'), { epoch: 10, capture: '{"event":"exit"}\n' });
		fs.mkdirSync(path.join(tmp, 'node_modules', 'x'), { recursive: true });
		const stores = discoverStores(tmp);
		assert.strictEqual(stores.length, 2);
		assert.strictEqual(stores[0].root, tmp);
		assert.strictEqual(stores[1].root, path.join(tmp, 'child'));
		assert.strictEqual(stores[1].epoch, 10);
		assert.strictEqual(stores[1].captureCount, 1);
		assert.strictEqual(stores[0].captureCount, 0);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('empty trace files do not count as captures', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-disc-'));
		mkStore(tmp, { capture: '' });
		const stores = discoverStores(tmp);
		assert.strictEqual(stores[0].captureCount, 0);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('all-uninstrumented sessions are called out in provenance', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-disc-'));
		mkStore(tmp, { capture: '{"event":"exit"}\n', rewritten: 0 });
		const stores = discoverStores(tmp);
		assert.strictEqual(stores[0].allCapturesUninstrumented, true);
		const line = describeProvenance(stores[0], Date.now());
		assert.ok(/instrumented 0 modules/.test(line), line);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('instrumented sessions carry no warning', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-disc-'));
		mkStore(tmp, { capture: '{"event":"exit"}\n', rewritten: 7 });
		const stores = discoverStores(tmp);
		assert.strictEqual(stores[0].allCapturesUninstrumented, false);
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});
