/**
 * Dead code: sectioning (islands over the graph), the honest no-trace state,
 * batching + concurrency of the harness analysis, verdict parsing, the durable
 * batch queue, PPR context retrieval, and the Findings join.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { GraphEdge, GraphNode, GraphSnapshot } from '../graph/indexGraph';
import {
	buildDeadCode,
	buildSectionReport,
	deadSectionPath,
	sectionIdFromPath,
	writeDeadCodeReport,
	writeSectionReport,
	MAX_SECTIONS,
	type DeadCodeReport,
} from '../views/deadCodeModel';
import {
	analyzeDeadSections,
	batchSections,
	buildBatchPrompt,
	buildContextRetriever,
	parseVerdicts,
	pooled,
	readAnalysis,
	writeAnalysis,
	type DeadSectionVerdict,
} from '../harness/deadCodeAnalysis';
import {
	enqueueDeadCodeBatch,
	readPendingBatches,
	removeBatch,
} from '../harness/deadCodeQueue';
import { buildFindings } from '../views/findingsModel';
import {
	handleDeadSectionMessage,
	type DeadSectionActions,
} from '../views/deadCodeReportView';

function tmpRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-deadcode-'));
}

function node(row: number, name: string, file: string, opts: Partial<GraphNode> = {}): GraphNode {
	return {
		row,
		id: `${file}::${name}`,
		file,
		lang: 'python',
		kind: 'function',
		name,
		start_line: 1 + row * 10,
		end_line: 8 + row * 10,
		summary: `summary of ${name}`,
		rank: 0.1,
		epoch: 1,
		parent: null,
		layer: 'service',
		...opts,
	};
}

function snapshotOf(
	nodes: GraphNode[],
	edges: GraphEdge[],
	runtimeRows: number[],
): GraphSnapshot {
	const runtime: GraphSnapshot['runtime'] = {};
	for (const row of runtimeRows) {
		runtime[row] = {
			executed: true,
			calls: 3,
			total_ms: 5,
			errors: 0,
			error_types: [],
			failures: [],
			current_errors: 0,
			latest_epoch: 1,
		};
	}
	return {
		generated_at: 'now',
		workspace: 'w',
		store_epoch: 7,
		node_count: nodes.length,
		edge_count: edges.length,
		layers: ['service'],
		nodes,
		edges,
		files: [],
		file_edges: [],
		tour: [],
		runtime,
		flow_edges: [],
	};
}

/**
 * Fixture: live handler (0) → dead helper A (1) → dead helper B (2) in the same
 * island (cross-file invoke), a dead orphan module (3, 4 sharing a file), and a
 * live util (5). A test chunk (6) that must never be counted.
 */
function fixture(): GraphSnapshot {
	const nodes = [
		node(0, 'handler', 'app/api.py'),
		node(1, 'helper_a', 'app/legacy.py', { rank: 0.5 }),
		node(2, 'helper_b', 'app/legacy2.py'),
		node(3, 'orphan_x', 'app/orphan.py'),
		node(4, 'orphan_y', 'app/orphan.py'),
		node(5, 'util', 'app/util.py'),
		node(6, 'test_x', 'tests/test_x.py', { layer: 'tests' }),
	];
	const edges: GraphEdge[] = [
		{ src: 0, dst: 1, kind: 'invoke' }, // live → dead: liveCaller evidence
		{ src: 1, dst: 2, kind: 'invoke' }, // dead → dead: joins the island
		{ src: 0, dst: 5, kind: 'invoke' },
	];
	return snapshotOf(nodes, edges, [0, 5]);
}

suite('dead code: sectioning', () => {
	test('no trace at all means no verdict, not a codebase-sized finding', () => {
		const snap = snapshotOf([node(0, 'a', 'a.py'), node(1, 'b', 'b.py')], [], []);
		const report = buildDeadCode(tmpRepo(), snap);
		assert.strictEqual(report.hasTrace, false);
		assert.strictEqual(report.sections.items.length, 0);
		assert.strictEqual(report.considered, 2, 'the denominator is still reported');
	});

	test('islands: dead symbols joined by edges or files cluster; live callers recorded', () => {
		const report = buildDeadCode(tmpRepo(), fixture());
		assert.strictEqual(report.hasTrace, true);
		assert.strictEqual(report.sections.items.length, 2);

		const wired = report.sections.items.find((s) => s.reason === 'reachable-untested');
		const orphan = report.sections.items.find((s) => s.reason === 'orphan');
		assert.ok(wired && orphan);
		// helper_a + helper_b joined across files by the dead→dead invoke.
		assert.deepStrictEqual([...wired.files].sort(), ['app/legacy.py', 'app/legacy2.py']);
		assert.ok(wired.liveCallers[0].includes('handler'), 'the live caller names the evidence');
		// orphan_x + orphan_y joined by the shared file, referenced by nothing.
		assert.strictEqual(orphan.files[0], 'app/orphan.py');
		assert.strictEqual(orphan.liveCallers.length, 0);
		// The test-layer chunk is never counted anywhere.
		assert.strictEqual(report.considered, 6);
	});

	test('section ids are stable across row renumbering', () => {
		const a = buildDeadCode(tmpRepo(), fixture());
		// Same symbols, every row shifted (a reindex inserting a chunk above).
		const shifted = fixture();
		shifted.nodes = shifted.nodes.map((n) => ({ ...n, row: n.row + 5 }));
		shifted.edges = shifted.edges.map((e) => ({ ...e, src: e.src + 5, dst: e.dst + 5 }));
		shifted.runtime = Object.fromEntries(
			Object.entries(shifted.runtime).map(([k, v]) => [Number(k) + 5, v]),
		);
		const b = buildDeadCode(tmpRepo(), shifted);
		assert.deepStrictEqual(
			a.sections.items.map((s) => s.id).sort(),
			b.sections.items.map((s) => s.id).sort(),
			'ids derive from file:name identity, not row positions',
		);
	});

	test('tour order walks callees before callers', () => {
		const report = buildDeadCode(tmpRepo(), fixture());
		const wired = report.sections.items.find((s) => s.reason === 'reachable-untested');
		assert.ok(wired);
		const posA = wired.tourOrder.indexOf(1); // helper_a calls helper_b
		const posB = wired.tourOrder.indexOf(2);
		assert.ok(posB < posA, 'the callee (helper_b) is visited first');
	});

	test('the section list bound is a lineage, and reachable-untested sorts first', () => {
		const report = buildDeadCode(tmpRepo(), fixture());
		assert.strictEqual(report.sections.items[0].reason, 'reachable-untested');
		const stage = report.sections.lineage[0];
		assert.strictEqual(stage.stopped_by, 'exhausted');
		assert.strictEqual(stage.total, 2);
		assert.ok(report.sections.items.length <= MAX_SECTIONS);
	});
});

suite('dead code: batching and dispatch', () => {
	function sections(): DeadCodeReport['sections']['items'] {
		return buildDeadCode(tmpRepo(), fixture()).sections.items;
	}

	test('batchSections splits and preserves order', () => {
		const s = sections();
		const batches = batchSections([...s, ...s, ...s], 2);
		assert.strictEqual(batches.length, 3);
		assert.strictEqual(batches[0].length, 2);
		assert.strictEqual(batches[2].length, 2);
	});

	test('pooled bounds concurrency and preserves result order', async () => {
		let inFlight = 0;
		let peak = 0;
		const results = await pooled([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight -= 1;
			return x * 10;
		});
		assert.deepStrictEqual(results, [10, 20, 30, 40, 50, 60, 70]);
		assert.ok(peak <= 3, `at most 3 in flight (saw ${peak})`);
		assert.ok(peak >= 2, 'actually ran concurrently');
	});

	test('parseVerdicts keeps only asked ids and tolerates prose around the JSON', () => {
		const asked = new Set(['aaa', 'bbb']);
		const reply = [
			'Here is my analysis.',
			'```json',
			JSON.stringify({
				verdicts: {
					aaa: { what: 'a retry helper', why: 'flag off', action: 'integrate', integrate: 'wire flag', reimagine: '', risk: 'none', confidence: 'high' },
					zzz: { what: 'hallucinated', why: '', action: 'delete', integrate: '', reimagine: '', risk: '', confidence: 'high' },
					bbb: { what: 'old exporter', why: 'superseded', action: 'weird-action', integrate: '', reimagine: '', risk: '', confidence: 'certain' },
				},
			}),
			'```',
		].join('\n');
		const out = parseVerdicts(reply, asked);
		assert.deepStrictEqual(Object.keys(out).sort(), ['aaa', 'bbb'], 'unasked ids are dropped');
		assert.strictEqual(out.aaa.action, 'integrate');
		// Unknown enum values degrade to the honest floor, never to a guess.
		assert.strictEqual(out.bbb.action, 'unclear');
		assert.strictEqual(out.bbb.confidence, 'low');
	});

	test('a verdict without "what" is not a verdict', () => {
		const out = parseVerdicts(
			JSON.stringify({ verdicts: { aaa: { what: '', action: 'delete' } } }),
			new Set(['aaa']),
		);
		assert.deepStrictEqual(out, {});
	});

	test('analyzeDeadSections batches instead of one dispatch per section', async () => {
		const root = tmpRepo();
		const s = sections();
		const many = [...s, ...s, ...s].map((x, i) => ({ ...x, id: `id-${i}` }));
		const prompts: string[] = [];
		const outcome = await analyzeDeadSections(
			root,
			many,
			async (_name, prompt) => {
				prompts.push(prompt);
				// Answer every section this batch asked about.
				const ids = [...prompt.matchAll(/### section `([^`]+)`/g)].map((m) => m[1]);
				return JSON.stringify({
					verdicts: Object.fromEntries(
						ids.map((id) => [id, { what: `w-${id}`, why: '', action: 'keep', integrate: '', reimagine: '', risk: '', confidence: 'medium' }]),
					),
				});
			},
			{ batchSize: 4, concurrency: 2 },
		);
		assert.strictEqual(outcome.requested, 6);
		assert.strictEqual(outcome.answered, 6);
		assert.strictEqual(outcome.batches, 2, '6 sections at batch size 4 is 2 runs, not 6');
		assert.strictEqual(prompts.length, 2);
		assert.strictEqual(outcome.detail, '');
	});

	test('a failed batch loses only its own sections, and the shortfall is stated', async () => {
		const root = tmpRepo();
		const s = sections();
		const many = [...s, ...s].map((x, i) => ({ ...x, id: `id-${i}` }));
		let call = 0;
		const landed: string[][] = [];
		const outcome = await analyzeDeadSections(
			root,
			many,
			async (_name, prompt) => {
				call += 1;
				if (call === 1) {
					return null; // first batch: harness failed
				}
				const ids = [...prompt.matchAll(/### section `([^`]+)`/g)].map((m) => m[1]);
				return JSON.stringify({
					verdicts: Object.fromEntries(
						ids.map((id) => [id, { what: 'w', why: '', action: 'keep', integrate: '', reimagine: '', risk: '', confidence: 'low' }]),
					),
				});
			},
			{
				batchSize: 2,
				concurrency: 1,
				onBatch: (batch, verdicts) => void landed.push(Object.keys(verdicts).length ? batch.map((b) => b.id) : []),
			},
		);
		assert.strictEqual(outcome.answered, 2);
		assert.ok(outcome.detail.includes('2 of 4'));
		// The durability hook saw the failed batch as empty and the good one whole.
		assert.deepStrictEqual(landed, [[], ['id-2', 'id-3']]);
	});

	test('the analysis store merges and never overwrites across runs', () => {
		const root = tmpRepo();
		const v = (id: string, what: string): DeadSectionVerdict => ({
			id, what, why: '', action: 'keep', integrate: '', reimagine: '', risk: '', confidence: 'low',
		});
		writeAnalysis(root, 7, { aaa: v('aaa', 'first') });
		writeAnalysis(root, 7, { bbb: v('bbb', 'second') });
		const stored = readAnalysis(root);
		assert.ok(stored);
		assert.deepStrictEqual(Object.keys(stored.verdicts).sort(), ['aaa', 'bbb']);
		assert.strictEqual(stored.verdicts.aaa.what, 'first');
	});
});

suite('dead code: durable batch queue', () => {
	test('enqueue → read → remove round-trips; malformed files self-heal', () => {
		const root = tmpRepo();
		const file = enqueueDeadCodeBatch(root, ['aaa', 'bbb']);
		fs.writeFileSync(path.join(path.dirname(file), 'batch-broken.json'), '{torn', 'utf8');
		let pending = readPendingBatches(root);
		assert.strictEqual(pending.length, 1, 'the torn file is not a batch');
		assert.deepStrictEqual(pending[0].request.sectionIds, ['aaa', 'bbb']);
		assert.ok(!fs.existsSync(path.join(path.dirname(file), 'batch-broken.json')), 'malformed deleted');
		removeBatch(pending[0].file);
		pending = readPendingBatches(root);
		assert.strictEqual(pending.length, 0);
	});

	test('reading does not consume — a crashed run leaves the ask on disk', () => {
		const root = tmpRepo();
		enqueueDeadCodeBatch(root, ['ccc']);
		readPendingBatches(root);
		assert.strictEqual(readPendingBatches(root).length, 1);
	});
});

suite('dead code: PPR live context', () => {
	test('the retriever surfaces the multi-hop live neighbourhood, live only', () => {
		const snap = fixture();
		const report = buildDeadCode(tmpRepo(), snap);
		const wired = report.sections.items.find((s) => s.reason === 'reachable-untested');
		assert.ok(wired);
		const context = buildContextRetriever(snap)(wired);
		assert.ok(context.length > 0);
		// handler is 1 hop from helper_a; util is 2 hops (via handler). Both live.
		const names = context.map((c) => c.name);
		assert.ok(names.includes('handler'), 'direct live neighbour retrieved');
		assert.ok(names.includes('util'), 'multi-hop live neighbour retrieved');
		assert.strictEqual(names[0], 'handler', 'the nearer neighbour carries more mass');
		for (const c of context) {
			assert.ok(!['helper_a', 'helper_b'].includes(c.name), 'section members are not context');
		}
	});

	test('the batch prompt carries the neighbourhood when provided', () => {
		const snap = fixture();
		const report = buildDeadCode(tmpRepo(), snap);
		const wired = report.sections.items.find((s) => s.reason === 'reachable-untested');
		assert.ok(wired);
		const context = buildContextRetriever(snap)(wired);
		const prompt = buildBatchPrompt([wired], new Map(), new Map([[wired.id, context]]));
		assert.ok(prompt.includes('Live neighbourhood'));
		assert.ok(prompt.includes('handler (app/api.py:1)'));
	});
});

suite('dead code: reports and findings join', () => {
	test('section report path round-trips through sectionIdFromPath', () => {
		const root = tmpRepo();
		const file = deadSectionPath(root, 'ab12cd34ef56');
		assert.strictEqual(sectionIdFromPath(file), 'ab12cd34ef56');
		assert.strictEqual(sectionIdFromPath(path.join(root, 'deadcode_analysis.json')), null);
		assert.strictEqual(sectionIdFromPath(path.join(root, 'deadcode.json')), null);
	});

	test('buildSectionReport orders stops by the tour and attaches the verdict', () => {
		const root = tmpRepo();
		const report = buildDeadCode(root, fixture());
		const wired = report.sections.items.find((s) => s.reason === 'reachable-untested');
		assert.ok(wired);
		const v: DeadSectionVerdict = {
			id: wired.id, what: 'legacy retry path', why: 'flag removed', action: 'reimagine',
			integrate: '', reimagine: 'fold into client', risk: 'none', confidence: 'medium',
		};
		const section = buildSectionReport(root, wired, report.storeEpoch, v);
		assert.strictEqual(section.stops.length, 2);
		assert.strictEqual(section.stops[0].symbol.name, 'helper_b', 'callee first');
		assert.strictEqual(section.verdict?.action, 'reimagine');
		const file = writeSectionReport(root, section);
		assert.ok(fs.existsSync(file));
		assert.strictEqual(sectionIdFromPath(file), wired.id);
	});

	test('findings carries the dead-code block, joined with stored verdicts', () => {
		const root = tmpRepo();
		const scan = buildDeadCode(root, fixture());
		writeDeadCodeReport(root, scan);
		const first = scan.sections.items[0];
		writeAnalysis(root, scan.storeEpoch, {
			[first.id]: {
				id: first.id, what: 'an old exporter', why: '', action: 'integrate',
				integrate: 'call from handler', reimagine: '', risk: '', confidence: 'high',
			},
		});
		const f = buildFindings(root);
		assert.strictEqual(f.headline.deadSections, 2);
		assert.strictEqual(f.deadCode.hasTrace, true);
		assert.strictEqual(f.deadCode.analysed, 1);
		const listed = f.deadCode.sections.find((s) => s.id === first.id);
		assert.ok(listed);
		assert.strictEqual(listed.action, 'integrate');
		assert.strictEqual(listed.what, 'an old exporter');
		const other = f.deadCode.sections.find((s) => s.id !== first.id);
		assert.strictEqual(other?.action, null, 'unanalysed stays null, never a guess');
	});

	test('findings without any scan artifact degrades to the empty block', () => {
		const f = buildFindings(tmpRepo());
		assert.strictEqual(f.deadCode.hasTrace, false);
		assert.strictEqual(f.deadCode.sections.length, 0);
		assert.strictEqual(f.headline.deadSections, 0);
	});
});

suite('dead code: report view routing', () => {
	test('messages route to their actions', async () => {
		const log: string[] = [];
		const a: DeadSectionActions = {
			openSource: async (f, l) => void log.push(`open:${f}:${l}`),
			refresh: async () => void log.push('refresh'),
			analyze: async () => void log.push('analyze'),
		};
		await handleDeadSectionMessage({ type: 'openSource', file: 'x.py', line: 4 }, a);
		await handleDeadSectionMessage({ type: 'refresh' }, a);
		await handleDeadSectionMessage({ type: 'analyze' }, a);
		assert.deepStrictEqual(log, ['open:x.py:4', 'refresh', 'analyze']);
	});
});
