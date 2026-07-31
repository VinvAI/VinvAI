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
	buildDriverPrompt,
	parseDriverReply,
	parseVerdicts,
	pooled,
	readAnalysis,
	revivedSymbols,
	writeAnalysis,
	type DeadSectionVerdict,
} from '../harness/deadCodeAnalysis';
import {
	enqueueDeadCodeBatch,
	readPendingBatches,
	removeBatch,
} from '../harness/deadCodeQueue';
import {
	readRuns,
	recordRun,
	runHeadline,
	runsForSection,
	summarizeTrace,
	summarizeTraces,
	type DeadCodeRunRecord,
} from '../harness/deadCodeRuns';
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
			tryRun: async () => void log.push('tryRun'),
			openArtifact: async (f) => void log.push(`artifact:${f}`),
		};
		await handleDeadSectionMessage({ type: 'openSource', file: 'x.py', line: 4 }, a);
		await handleDeadSectionMessage({ type: 'refresh' }, a);
		await handleDeadSectionMessage({ type: 'analyze' }, a);
		await handleDeadSectionMessage({ type: 'tryRun' }, a);
		await handleDeadSectionMessage({ type: 'openArtifact', file: 't/trace.jsonl' }, a);
		assert.deepStrictEqual(log, [
			'open:x.py:4',
			'refresh',
			'analyze',
			'tryRun',
			'artifact:t/trace.jsonl',
		]);
	});
});

suite('dead code: try-run driver', () => {
	function wiredSection() {
		const report = buildDeadCode(tmpRepo(), fixture());
		const section = report.sections.items.find((s) => s.reason === 'reachable-untested');
		assert.ok(section);
		return section;
	}

	test('the driver prompt carries the run environment, the section and the honesty rules', () => {
		const prompt = buildDriverPrompt(
			wiredSection(),
			new Map(),
			{ python: '/venv/bin/python', targetPackages: ['app'], cwd: '/repo' },
		);
		assert.ok(prompt.includes('/venv/bin/python'));
		assert.ok(prompt.includes('Instrumented packages: app'));
		assert.ok(prompt.includes('### section `'));
		// A raising driver still traces — the prompt must forbid green-washing.
		// Anchored on the RULE, not the sentence carrying it. The prompt is built
		// from a wrapped string array, so any rewording that re-flows the lines
		// breaks a longer match while the rule itself is untouched — which is
		// exactly how this assertion went stale once already.
		assert.ok(prompt.includes('try/except to make the run look green'));
		assert.ok(prompt.includes('{"driver": null, "reason"'), 'declining is an allowed reply');
	});

	test('the driver prompt asks for VARIED cases, each run on its own', () => {
		// The surface exists to show what the code does, and one call cannot show
		// that. The prompt must ask for several deliberately different inputs and
		// name the argv contract that makes each one separately traceable.
		const prompt = buildDriverPrompt(wiredSection(), new Map(), {
			python: '/venv/bin/python',
			targetPackages: ['app'],
			cwd: '/repo',
		});
		assert.ok(prompt.includes('PROBE SUITE'));
		assert.ok(prompt.includes('sys.argv[1]'), 'the case-selection contract is stated');
		assert.ok(prompt.includes('<case-name>'), 'the invocation shows one case per process');
		assert.ok(prompt.includes('VARY the inputs'));
		assert.ok(prompt.includes('"cases"'), 'the reply shape carries the declared cases');
		// A case that raises is evidence, not a failed run.
		assert.ok(prompt.includes('a RESULT, not a failure'));
	});

	test('an orphan is told to build its own inputs; only a wired section is sent hunting', () => {
		// For an orphan there is BY CONSTRUCTION no caller to find, and telling an
		// agent to look for one invites it to conclude the section is undrivable —
		// when the absence of callers is the premise of the whole task.
		const env = { python: '/venv/bin/python', targetPackages: ['app'], cwd: '/repo' };
		const report = buildDeadCode(tmpRepo(), fixture());
		const orphan = report.sections.items.find((s) => s.reason === 'orphan');
		assert.ok(orphan, 'the fixture has an orphan section');
		const orphanPrompt = buildDriverPrompt(orphan, new Map(), env);
		assert.ok(orphanPrompt.includes('NOTHING calls this code today'));
		assert.ok(orphanPrompt.includes('reason to decline'), 'the premise is named as a premise');
		assert.ok(
			!orphanPrompt.includes('LOOK FOR AN EXISTING WAY IN'),
			'there is no existing caller to look for',
		);
		const wiredPrompt = buildDriverPrompt(wiredSection(), new Map(), env);
		assert.ok(wiredPrompt.includes('LOOK FOR AN EXISTING WAY IN'));
	});

	test('parseDriverReply keeps the driver, the decline and the unusable apart', () => {
		const good = parseDriverReply(
			'sure!\n```json\n' +
				JSON.stringify({
					driver: {
						code: 'import app\napp.helper_a()',
						notes: 'direct call',
						cases: [
							{ name: 'empty', why: 'the boundary' },
							{ name: 'typical', why: 'the ordinary input' },
							{ name: '  ', why: 'unnamed — cannot be selected by argv' },
							{ name: 'empty', why: 'a duplicate would produce two captures alike' },
						],
					},
				}) +
				'\n```',
		);
		assert.strictEqual(good.kind, 'driver');
		if (good.kind === 'driver') {
			assert.ok(good.code.includes('helper_a'));
			assert.strictEqual(good.notes, 'direct call');
			// Names become argv values, so blank and duplicate names are dropped
			// rather than run: two cases sharing a name produce two captures that
			// cannot be told apart, which is what the per-case split prevents.
			assert.deepStrictEqual(good.cases.map((c) => c.name), ['empty', 'typical']);
			assert.strictEqual(good.cases[0].why, 'the boundary');
		}
		// A driver with no declared cases still runs — once, with no argv.
		const bare = parseDriverReply(JSON.stringify({ driver: { code: 'import app' } }));
		assert.deepStrictEqual(bare.kind === 'driver' && bare.cases, []);
		assert.strictEqual(parseDriverReply(JSON.stringify({ driver: { code: '   ' } })).kind, 'unusable');
		assert.strictEqual(parseDriverReply('no json at all').kind, 'unusable');
	});

	test('a decline carries its reason, and a bare refusal carries none', () => {
		// {"driver": null} is the documented decline — a verdict, not a transport
		// failure, and the two must not collapse into one outcome. The REASON is
		// what makes it checkable: a decline leaves no driver and no trace, so
		// without it the record holds nothing anyone could disagree with.
		const reasoned = parseDriverReply(
			JSON.stringify({ driver: null, reason: 'it is a setuptools entry point, not callable code' }),
		);
		assert.strictEqual(reasoned.kind, 'declined');
		assert.strictEqual(
			reasoned.kind === 'declined' && reasoned.reason,
			'it is a setuptools entry point, not callable code',
		);
		const bare = parseDriverReply(JSON.stringify({ driver: null }));
		assert.strictEqual(bare.kind, 'declined');
		assert.strictEqual(bare.kind === 'declined' && bare.reason, '');
	});

	test('revivedSymbols counts from the overlay, not from the run outcome', () => {
		const section = wiredSection();
		// helper_a (row 1) traced, helper_b (row 2) still dead.
		assert.deepStrictEqual(revivedSymbols(section, { 1: { executed: true } }), ['helper_a']);
		assert.deepStrictEqual(revivedSymbols(section, {}), []);
	});

	test('the driver prompt forbids binding a fixed port', () => {
		// A driver that binds the service's own port dies with "address already
		// in use" and says nothing about whether the section can execute.
		const prompt = buildDriverPrompt(wiredSection(), new Map(), {
			python: '/venv/bin/python',
			targetPackages: ['app'],
			cwd: '/repo',
		});
		assert.ok(prompt.includes('Do NOT bind a fixed port'));
		assert.ok(prompt.includes('bind port 0'), 'the alternative is named, not just the ban');
	});
});

suite('dead code: try-runs are kept and summarised', () => {
	function traceFile(root: string, events: object[]): string {
		const file = path.join(root, 'trace.jsonl');
		fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
		return file;
	}

	function record(over: Partial<DeadCodeRunRecord> = {}): DeadCodeRunRecord {
		return {
			sectionId: 'sec-a',
			title: 'app/legacy.py — helper_a',
			at: '2026-07-31T10:00:00.000Z',
			outcome: 'not-reached',
			detail: 'the driver ran and traced, but nothing in the section executed',
			revived: [],
			rows: [1, 2],
			driverFile: null,
			traceFile: null,
			exitCode: 0,
			timedOut: false,
			notes: '',
			outputTail: '',
			trace: null,
			...over,
		};
	}

	test('summarizeTrace counts calls, time and raises per function', () => {
		const root = tmpRepo();
		const file = traceFile(root, [
			{ event: 'enter', component: 'app.legacy.helper_a' },
			{ event: 'exit', component: 'app.legacy.helper_a', duration_ms: 2.5 },
			{ event: 'exit', component: 'app.legacy.helper_a', duration_ms: 1.5 },
			{ event: 'exit', component: 'app.legacy2.helper_b', duration_ms: 4, error_type: 'ValueError' },
			'not json' as unknown as object,
		]);
		const summary = summarizeTrace(file);
		assert.ok(summary);
		assert.strictEqual(summary!.functions, 2);
		assert.strictEqual(summary!.calls, 3);
		assert.strictEqual(summary!.totalMs, 8);
		assert.strictEqual(summary!.errors, 1);
		assert.deepStrictEqual(summary!.errorTypes, ['ValueError']);
		// Busiest first, and a raising call still counts as a call: it ran.
		assert.strictEqual(summary!.top[0].component, 'app.legacy.helper_a');
		assert.strictEqual(summary!.top[0].calls, 2);
		assert.strictEqual(summary!.top[1].errors, 1);
	});

	test('the summary pairs each call’s arguments with what that call returned', () => {
		// The point of the surface: "helper_a ran" is a fact about the tracer,
		// "helper_a(n=3) → 'ok'" is a fact about the code. Arguments arrive on the
		// enter row and results on the exit row, so nothing can show behaviour
		// unless the two are paired back up.
		const root = tmpRepo();
		const file = traceFile(root, [
			{ event: 'enter', component: 'app.legacy.helper_a', request_id: 'r1', thread_id: 1, depth: 0,
				args_summary: { n: { v: 3 } } },
			{ event: 'enter', component: 'app.legacy2.helper_b', request_id: 'r1', thread_id: 1, depth: 1,
				parent_component: 'app.legacy.helper_a', args_summary: { items: { elem_type: 'int', len: 0 } } },
			{ event: 'exit', component: 'app.legacy2.helper_b', request_id: 'r1', thread_id: 1, depth: 1,
				parent_component: 'app.legacy.helper_a', duration_ms: 1, result_summary: { v: 0 } },
			{ event: 'exit', component: 'app.legacy.helper_a', request_id: 'r1', thread_id: 1, depth: 0,
				duration_ms: 3, result_summary: { head: 'ok' } },
		]);
		const summary = summarizeTrace(file);
		assert.ok(summary);
		// Callees before callers — a reader follows what a value did, not what ran most.
		assert.strictEqual(summary!.top[0].component, 'app.legacy2.helper_b');
		assert.deepStrictEqual(summary!.top[0].samples, [
			{ args: [{ name: 'items', render: '[int × 0]' }], result: '0', error: null, ms: 1 },
		]);
		assert.strictEqual(summary!.top[0].parent, 'app.legacy.helper_a');
		const a = summary!.top.find((f) => f.component === 'app.legacy.helper_a');
		assert.deepStrictEqual(a!.samples, [
			{ args: [{ name: 'n', render: '3' }], result: '"ok"', error: null, ms: 3 },
		]);
	});

	test('repeated calls collapse, differing ones do not, and a raise is a result', () => {
		// A probe case that loops does not get four hundred identical rows: the
		// samples exist to show a RANGE, and the second identical observation adds
		// nothing. A raise is kept as what the call answered, not dropped.
		const root = tmpRepo();
		const call = (n: number, result: object, error?: string) => [
			{ event: 'enter', component: 'app.legacy.helper_a', request_id: 'r1', thread_id: 1,
				args_summary: { n: { v: n } } },
			{ event: 'exit', component: 'app.legacy.helper_a', request_id: 'r1', thread_id: 1,
				duration_ms: 1, result_summary: result, error_type: error ?? null },
		];
		const summary = summarizeTrace(
			traceFile(root, [
				...call(1, { v: 1 }),
				...call(1, { v: 1 }),
				...call(2, { v: 2 }),
				...call(-1, { type: 'NoneType' }, 'ValueError'),
			]),
		);
		assert.strictEqual(summary!.top[0].calls, 4, 'every call is still counted');
		assert.deepStrictEqual(
			summary!.top[0].samples!.map((s) => `${s.args[0].render}→${s.error ?? s.result}`),
			['1→1', '2→2', '-1→ValueError'],
		);
		const raised = summary!.top[0].samples!.find((s) => s.error);
		assert.strictEqual(raised!.result, '', 'a call that raised returned nothing');
	});

	test('summarizeTraces merges the cases without crossing their values', () => {
		const root = tmpRepo();
		const one = path.join(root, 'case-a.jsonl');
		const two = path.join(root, 'case-b.jsonl');
		for (const [file, n] of [[one, 1], [two, 2]] as const) {
			fs.writeFileSync(
				file,
				[
					{ event: 'enter', component: 'app.legacy.helper_a', request_id: `r${n}`, thread_id: 1,
						args_summary: { n: { v: n } } },
					{ event: 'exit', component: 'app.legacy.helper_a', request_id: `r${n}`, thread_id: 1,
						duration_ms: n, result_summary: { v: n * 10 } },
				]
					.map((e) => JSON.stringify(e))
					.join('\n') + '\n',
				'utf8',
			);
		}
		const merged = summarizeTraces([one, two]);
		assert.strictEqual(merged!.calls, 2);
		assert.deepStrictEqual(
			merged!.top[0].samples!.map((s) => `${s.args[0].render}→${s.result}`),
			['1→10', '2→20'],
		);
		// A capture that does not exist is skipped, not fatal: a case can fail to
		// produce a trace while its siblings ran fine.
		assert.strictEqual(summarizeTraces([one, path.join(root, 'nope.jsonl')])!.calls, 1);
	});

	test('an unexplained refusal does not read as a settled verdict', () => {
		// A decline leaves no driver and no trace, so the reason is the entire
		// evidence. Without one there is nothing to weigh — and saying "not
		// drivable" anyway is how one lazy null becomes permanent.
		assert.strictEqual(
			runHeadline(record({ outcome: 'declined', notes: 'it is a setuptools entry point' })),
			'the agent judged this not drivable from a script',
		);
		assert.strictEqual(
			runHeadline(record({ outcome: 'declined', notes: '' })),
			'the agent refused without saying why — not a settled verdict',
		);
	});

	test('a missing or span-less trace summarises to null, never to zeros', () => {
		const root = tmpRepo();
		assert.strictEqual(summarizeTrace(path.join(root, 'nope.jsonl')), null);
		// Enter events only: tracelens instrumented nothing that returned.
		assert.strictEqual(
			summarizeTrace(traceFile(root, [{ event: 'enter', component: 'x' }])),
			null,
			'"no measurement" must be distinguishable from "measured zero"',
		);
	});

	test('runs persist newest-first and survive a reread', () => {
		const root = tmpRepo();
		recordRun(root, record({ at: '2026-07-31T10:00:00.000Z' }));
		recordRun(root, record({ at: '2026-07-31T11:00:00.000Z', outcome: 'revived', revived: ['helper_a'] }));
		const runs = readRuns(root);
		assert.strictEqual(runs.length, 2);
		assert.strictEqual(runs[0].outcome, 'revived');
		assert.strictEqual(runs[1].outcome, 'not-reached');
	});

	test('a run stays attached to the section it reshaped, id change and all', () => {
		const runs = [record({ sectionId: 'old-id', rows: [1, 2] })];
		// The section the revival re-formed into: new id, overlapping symbols.
		assert.strictEqual(runsForSection(runs, { id: 'new-id', rows: [2, 3] }).length, 1);
		// Same id, no overlap (a re-scan that kept the id) still matches.
		assert.strictEqual(runsForSection(runs, { id: 'old-id', rows: [9] }).length, 1);
		// An unrelated section gets no history at all.
		assert.strictEqual(runsForSection(runs, { id: 'other', rows: [7, 8] }).length, 0);
	});

	test('the section report and the findings list both carry the run', () => {
		const root = tmpRepo();
		const scan = buildDeadCode(root, fixture());
		const section = scan.sections.items.find((s) => s.reason === 'reachable-untested');
		assert.ok(section);
		recordRun(
			root,
			record({
				sectionId: section.id,
				rows: section.symbols.items.map((s) => s.row),
				outcome: 'revived',
				revived: ['helper_a'],
				traceFile: '/caps/deadcode-x/trace.jsonl',
			}),
		);
		const report = buildSectionReport(root, section, scan.storeEpoch, null);
		assert.strictEqual(report.runs.length, 1, 'the report tab can render the evidence');
		assert.strictEqual(report.runs[0].traceFile, '/caps/deadcode-x/trace.jsonl');

		writeDeadCodeReport(root, scan);
		const listed = buildFindings(root).deadCode.sections.find((s) => s.id === section.id);
		assert.strictEqual(listed?.lastRun, 'ran under trace — 1 symbol(s) executed');
		assert.strictEqual(listed?.lastRunAt, '2026-07-31T10:00:00.000Z');
	});

	test('a section nobody has driven reports no run rather than an empty one', () => {
		const root = tmpRepo();
		const scan = buildDeadCode(root, fixture());
		writeDeadCodeReport(root, scan);
		for (const s of buildFindings(root).deadCode.sections) {
			assert.strictEqual(s.lastRun, '');
			assert.strictEqual(s.lastRunAt, '');
		}
	});
});
