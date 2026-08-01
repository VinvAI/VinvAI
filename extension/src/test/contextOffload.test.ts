/**
 * Context offload/reload + knowledge slices:
 *
 *   • optimization episode packs REFERENCE heavy evidence instead of inlining
 *     it — writeContextPack offloads the span proof + attempt history to
 *     .vinv/context/opt-<signature>.md and the pack body carries a one-line
 *     summary plus the path (reload = the agent reads the file for depth);
 *   • the offloaded file expires with the attempt store's session-relative
 *     rule — recordCandidateSightings removes it when the signature's key
 *     expires (one expiry mechanism, two artifacts);
 *   • the production wiring: prepareOptimizationSweep / prepareRowOptimization
 *     attach the offload block the pack composer consumes;
 *   • the shipped playbooks load per kind and composePlaybookSlice joins them
 *     with the live artifact paths (board, attempts, calibration).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GraphEdge, GraphNode, GraphSnapshot } from '../graph/indexGraph';
import { indexStoreDir } from '../graph/indexGraph';
import { WALK_PRIORS } from '../harness/episodeTelemetry';
import {
	composePackContent,
	composePlaybookSlice,
	loadPlaybook,
	PLAYBOOK_KINDS,
	writeContextPack,
	type PackBudgets,
	type PackTask,
} from '../harness/contextPack';
import {
	optimizationEvidencePath,
	optimizationEvidenceRelPath,
	removeExpiredOptimizationEvidence,
	writeOptimizationEvidence,
} from '../harness/optimizationEvidence';
import {
	appendOptimizeAttempt,
	ATTEMPT_EXPIRY_SESSIONS,
	loadPriorOptimizeAttempts,
	opportunitySignature,
	optimizationCalibrationPath,
	recordCandidateSightings,
} from '../harness/optimizationAnalysis';
import { prepareOptimizationSweep, prepareRowOptimization } from '../harness/autoTrigger';
import { postOpportunities } from '../harness/opportunityBoard';

// The installed layout: this file runs from out/test/, so the extension root
// (where resources/playbooks ships) is two levels up — the same resolution
// out/mcp/indexServer.js uses.
const extensionDir = path.resolve(__dirname, '..', '..');

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

function snapshot(): GraphSnapshot {
	const nodes = [node(0), node(1)];
	const edges: GraphEdge[] = [{ src: 0, dst: 1, kind: 'invoke' }];
	return {
		generated_at: 't',
		workspace: '/w',
		store_epoch: 1,
		node_count: nodes.length,
		edge_count: edges.length,
		layers: ['service'],
		nodes,
		edges,
		files: [],
		file_edges: [],
		tour: [],
		runtime: {},
		flow_edges: [],
		changed_files: [],
		change_source: 'none',
	};
}

const budgets: PackBudgets = {
	slice_budget: 24,
	seed_cap: 8,
	failure_evidence_chars: 3000,
	walk: WALK_PRIORS,
};
const arm = { slice_depth: 2, include_runtime: true, snippet_chars: 1600 };

const SPAN_PROOF =
	'- fn0 at pkg/mod0.py:1 — ~90ms recoverable of 100ms (cache): recomputes identical inputs (9 of 10 calls repeat)';
const HISTORY = "attempt 1 'x' REVERTED: no significant speedup — try a materially different approach";

function offloadTask(): PackTask {
	return {
		title: 'Optimize fn0',
		issue: 'The trace spends significant time in `fn0`.',
		successCriteria: ['fn0 is faster on the same flow'],
		seedRows: [0],
		optimization: {
			signature: 'cafe01beef',
			summary: 'optimize fn0 (~90ms predicted recoverable)',
			span_proof: SPAN_PROOF,
			attempt_history: HISTORY,
		},
	};
}

suite('optimization context offload (offload → link → reload)', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-offload-'));
	});
	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('the pack links the evidence file with a one-line summary and does NOT inline it', () => {
		const { content } = composePackContent(snapshot(), offloadTask(), arm, budgets, 1);
		assert.ok(
			content.includes(optimizationEvidenceRelPath('cafe01beef')),
			'pack body carries the workspace-relative path',
		);
		assert.ok(
			content.includes('optimize fn0 (~90ms predicted recoverable)'),
			'the one-line summary rides the link',
		);
		assert.ok(
			!content.includes('9 of 10 calls repeat'),
			'span proof is referenced, never inlined',
		);
		assert.ok(
			!content.includes('materially different approach'),
			'attempt history is referenced, never inlined',
		);
	});

	test('writeContextPack writes the evidence file before the pack, so the link never dangles', () => {
		const pack = writeContextPack(root, snapshot(), offloadTask(), arm, budgets, 1);
		assert.ok(fs.existsSync(pack.path), 'pack landed');
		const evidenceFile = optimizationEvidencePath(root, 'cafe01beef');
		assert.ok(fs.existsSync(evidenceFile), 'offloaded evidence exists');
		const body = fs.readFileSync(evidenceFile, 'utf8');
		assert.ok(body.includes('9 of 10 calls repeat'), 'span proof reloaded from the file');
		assert.ok(body.includes('materially different approach'), 'attempt history reloaded');
		assert.ok(body.includes('cafe01beef'), 'file names its own signature');
	});

	test('re-dispatch refreshes the ONE file per signature instead of accreting copies', () => {
		writeContextPack(root, snapshot(), offloadTask(), arm, budgets, 1);
		const task = offloadTask();
		task.optimization!.attempt_history = 'attempt 2 kept as a lineage step';
		writeContextPack(root, snapshot(), task, arm, budgets, 2);
		const dir = path.join(root, '.vinv', 'context');
		const evidenceFiles = fs.readdirSync(dir).filter((f) => f.startsWith('opt-'));
		assert.deepStrictEqual(evidenceFiles, ['opt-cafe01beef.md'], 'one file per signature');
		const body = fs.readFileSync(path.join(dir, 'opt-cafe01beef.md'), 'utf8');
		assert.ok(body.includes('attempt 2 kept'), 'refreshed in place');
		assert.ok(!body.includes('materially different approach'), 'stale history replaced, not accreted');
	});

	test('a task without an optimization block writes no evidence file (non-optimization episodes unchanged)', () => {
		const task = offloadTask();
		delete task.optimization;
		const { content } = composePackContent(snapshot(), task, arm, budgets, 1);
		writeContextPack(root, snapshot(), task, arm, budgets, 1);
		assert.ok(!content.includes('Offloaded evidence'));
		assert.ok(!fs.existsSync(path.join(root, '.vinv', 'context', 'opt-cafe01beef.md')));
	});
});

suite('offloaded evidence expiry (rides the attempt store rule)', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-offload-exp-'));
	});
	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('removeExpiredOptimizationEvidence deletes only the named signatures', () => {
		writeOptimizationEvidence(root, { signature: 'aaa', title: 'a' });
		writeOptimizationEvidence(root, { signature: 'bbb', title: 'b' });
		const removed = removeExpiredOptimizationEvidence(root, ['aaa', 'never-written']);
		assert.strictEqual(removed.length, 1);
		assert.ok(!fs.existsSync(optimizationEvidencePath(root, 'aaa')));
		assert.ok(fs.existsSync(optimizationEvidencePath(root, 'bbb')));
	});

	test('when the attempt key expires, the evidence file goes with it — the surviving key keeps its file', () => {
		const t0 = 1_000_000;
		// Two keys with history + offloaded evidence; only 'stale' will vanish
		// from the ranked candidates.
		appendOptimizeAttempt(root, {
			row: 3,
			signature: 'stale',
			approach: 'x',
			comparison: null,
			verdict: 'reverted-no-gain',
			learning: 'no gain',
			at: t0,
		});
		appendOptimizeAttempt(root, {
			row: 4,
			signature: 'alive',
			approach: 'y',
			comparison: null,
			verdict: 'kept-no-gain',
			learning: 'kept',
			at: t0,
		});
		writeOptimizationEvidence(root, { signature: 'stale', title: 's', span_proof: 'p' });
		writeOptimizationEvidence(root, { signature: 'alive', title: 'a', span_proof: 'p' });

		// The attempt store's own expiry clock: ATTEMPT_EXPIRY_SESSIONS fresh
		// capture sessions in which only 'alive' is still among the candidates.
		for (let s = 1; s <= ATTEMPT_EXPIRY_SESSIONS; s += 1) {
			recordCandidateSightings(root, `session-${s}`, ['4:alive'], t0 + s);
		}

		assert.ok(
			!fs.existsSync(optimizationEvidencePath(root, 'stale')),
			'expired signature: evidence file removed at the existing expiry point',
		);
		assert.ok(
			fs.existsSync(optimizationEvidencePath(root, 'alive')),
			'sighted signature: evidence file survives',
		);
		// And the store agrees: the expired key's attempts no longer seed packs.
		assert.deepStrictEqual(loadPriorOptimizeAttempts(root, 3, 'stale'), []);
		assert.strictEqual(loadPriorOptimizeAttempts(root, 4, 'alive').length, 1);
	});
});

// ---- production wiring: the sweep/panel dispatch attaches the offload -------

const SYMBOLS = ['handler', 'get_docs', 'serialize'];

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
	fs.writeFileSync(
		path.join(store, 'chunks.jsonl'),
		chunks.map((c) => JSON.stringify(c)).join('\n') + '\n',
	);
	const edges: GraphEdge[] = [
		{ src: 0, dst: 1, kind: 'invoke' },
		{ src: 0, dst: 2, kind: 'invoke' },
	];
	fs.writeFileSync(
		path.join(store, 'edges.jsonl'),
		edges.map((e) => JSON.stringify(e)).join('\n') + '\n',
	);
	fs.writeFileSync(path.join(store, 'meta.json'), JSON.stringify({ epoch: 1 }));
}

function ev(comp: string, event: 'enter' | 'exit', extra: Record<string, unknown>): string {
	return JSON.stringify({ component: `app.svc.${comp}`, event, ...extra });
}

function writeFixtureTrace(root: string): void {
	const lines: string[] = [];
	lines.push(ev('handler', 'enter', { args_hash: 'h0' }));
	lines.push(ev('handler', 'exit', { duration_ms: 2, error_type: null, determinism_sources: [] }));
	// get_docs: identical-input calls with one constant result → cache waste.
	for (let i = 0; i < 10; i += 1) {
		lines.push(ev('get_docs', 'enter', { args_hash: 'H' }));
		lines.push(
			ev('get_docs', 'exit', {
				duration_ms: 10,
				error_type: null,
				determinism_sources: [],
				result_hash: 'R',
			}),
		);
	}
	// serialize: 50 distinct-arg calls under handler's 1 → fanout waste.
	for (let i = 0; i < 50; i += 1) {
		lines.push(ev('serialize', 'enter', { args_hash: `s${i}` }));
		lines.push(ev('serialize', 'exit', { duration_ms: 2, error_type: null, determinism_sources: [] }));
	}
	const d = path.join(root, '.vinv', 'captures', 'run1', 'svc');
	fs.mkdirSync(d, { recursive: true });
	const f = path.join(d, 'trace.jsonl');
	fs.writeFileSync(f, lines.join('\n') + '\n');
	fs.utimesSync(f, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
}

suite('offload wiring (prepare* attaches the block the composer consumes)', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-offload-wire-'));
		writeStore(root);
		writeFixtureTrace(root);
	});
	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('the hotspot sweep offloads the span proof and keeps the issue compact', () => {
		const prep = prepareOptimizationSweep(root, 'hotspots', []);
		assert.ok(prep.plan, 'evidence supports a plan');
		const opt = prep.plan!.task.optimization;
		assert.ok(opt, 'the dispatch carries the offload block');
		assert.strictEqual(
			opt!.signature,
			opportunitySignature(prep.plan!.opportunity),
			'offload signature IS the attempt-store signature — one expiry key',
		);
		assert.ok(opt!.span_proof?.includes('per caller invocation'), 'full reason in the span proof');
		assert.ok(
			!prep.plan!.task.issue.includes('per caller invocation'),
			'the issue keeps only the compact list — evidence referenced, not inlined',
		);
		assert.ok(prep.plan!.task.issue.includes('serialize'), 'targets still named in the issue');
	});

	test('the cache sweep and the panel row dispatch carry the block too', () => {
		const cache = prepareOptimizationSweep(root, 'cache_candidates', []);
		assert.ok(cache.plan?.task.optimization?.span_proof?.includes('cacheable'));

		const row = SYMBOLS.indexOf('serialize');
		const panel = prepareRowOptimization(root, row, []);
		assert.ok(panel.plan, 'panel plan prepared');
		const opt = panel.plan!.task.optimization;
		assert.ok(opt, 'panel dispatch offloads as well');
		assert.strictEqual(opt!.signature, opportunitySignature(panel.plan!.opportunity));
	});

	test('an end-to-end pack for the sweep links the file and the file holds the proof', () => {
		const prep = prepareOptimizationSweep(root, 'hotspots', []);
		assert.ok(prep.plan);
		const pack = writeContextPack(root, snapshot(), prep.plan!.task, arm, budgets, 1);
		const signature = prep.plan!.task.optimization!.signature;
		assert.ok(pack.content.includes(optimizationEvidenceRelPath(signature)));
		const body = fs.readFileSync(optimizationEvidencePath(root, signature), 'utf8');
		assert.ok(body.includes('per caller invocation'), 'reload surface holds the span proof');
	});
});

// ---- knowledge slices: the shipped playbooks --------------------------------

suite('playbooks (shipped data + the MCP slice)', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-playbook-'));
	});
	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('every declared kind ships a playbook with the practitioner sections', () => {
		for (const kind of PLAYBOOK_KINDS) {
			const text = loadPlaybook(extensionDir, kind);
			assert.ok(text.startsWith(`# Playbook: ${kind}`), `${kind} opens with its own header`);
			assert.ok(text.includes('## Fix patterns'), `${kind} has fix patterns`);
			assert.ok(text.includes('## Traps'), `${kind} has traps`);
			assert.ok(text.includes('## Verification discipline'), `${kind} has verification`);
		}
	});

	test('an unknown kind fails loudly, listing the valid kinds', () => {
		assert.throws(
			() => loadPlaybook(extensionDir, 'quantum'),
			/unknown playbook kind 'quantum'.*cache.*throughput-ceiling/s,
		);
	});

	test('the slice joins the playbook with the live board, attempts, and calibration', () => {
		// A live cache opportunity + a persisted attempt behind its dispatch
		// signature + a calibration ratio for the kind.
		const posted = [
			...postOpportunities(root, [
				{
					kind: 'cache',
					row: 1,
					name: 'get_docs',
					file: 'src/app/svc.py',
					line: 11,
					predicted_ms: 90,
					evidence: 'recomputes identical inputs (9 of 10 calls repeat)',
					source: 'test',
				},
			]).values(),
		][0];
		appendOptimizeAttempt(root, {
			row: 1,
			signature: opportunitySignature({ kind: 'cache', endpoint_id: 'get_docs' }),
			approach: 'memoize get_docs',
			comparison: null,
			verdict: 'reverted-no-gain',
			learning: 'no measurable gain',
		});
		fs.mkdirSync(path.dirname(optimizationCalibrationPath(root)), { recursive: true });
		fs.writeFileSync(
			optimizationCalibrationPath(root),
			JSON.stringify({
				updated_at: 'now',
				by_waste_kind: { cache: { n: 4, mean_ratio: 0.5, shrunk_ratio: 0.42 } },
			}),
		);

		const slice = composePlaybookSlice(root, extensionDir, 'cache');
		assert.ok(slice.includes('# Playbook: cache'), 'guidance included');
		assert.ok(slice.includes(`[${posted.status}] get_docs`), 'live board entry with lifecycle status');
		assert.ok(slice.includes('opportunities.jsonl'), 'board artifact path named');
		assert.ok(slice.includes('1 prior attempt(s) — reverted-no-gain'), 'attempt history joined');
		assert.ok(slice.includes('optimize_attempts.jsonl'), 'attempts artifact path named');
		assert.ok(slice.includes('0.420'), 'learned calibration ratio surfaced');
	});

	test('an empty workspace yields an honest slice; throughput-ceiling names its sweep artifact', () => {
		const slice = composePlaybookSlice(root, extensionDir, 'throughput-ceiling');
		assert.ok(slice.includes("no board entries of kind 'throughput-ceiling'"));
		assert.ok(slice.includes("no persisted attempts for kind 'throughput-ceiling'"));
		assert.ok(slice.includes('no learned ratio'));
		assert.ok(slice.includes('throughput_sweep.json'), 'kind-specific artifact named');
	});
});
