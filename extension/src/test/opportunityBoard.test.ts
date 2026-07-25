/**
 * Opportunity-board tests: the blackboard lifecycle (post → content-signature
 * dedup → dispatch → resolve → expire → compaction), the ONE-detection-path
 * guarantee (sweeps derive their candidates from computeOptimizationCandidates,
 * never a raw hotspot list), and the cross-restart no-re-dispatch rule the
 * audit demanded (dispatched/resolved ids never re-dispatch until expired).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { indexStoreDir, type GraphEdge } from '../graph/indexGraph';
import {
	EXPIRY_MISSING_SESSIONS,
	loadOpportunityBoard,
	markOpportunitiesDispatched,
	opportunityBoardPath,
	opportunitySignature,
	postOpportunities,
	reconcileOpportunityBoard,
	renderOpportunityBoard,
	rankedOpportunityCandidates,
	syncOpportunityBoard,
	type OpportunityInput,
} from '../harness/opportunityBoard';
import {
	prepareOptimizationSweep,
	prepareRowOptimization,
} from '../harness/autoTrigger';

function boardLines(root: string): number {
	try {
		return fs
			.readFileSync(opportunityBoardPath(root), 'utf8')
			.split('\n')
			.filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

function input(overrides: Partial<OpportunityInput> = {}): OpportunityInput {
	return {
		kind: 'cache',
		row: 3,
		name: 'get_docs',
		file: 'src/app/svc.py',
		line: 11,
		predicted_ms: 90,
		evidence: 'recomputes identical inputs (9 of 10 calls repeat); ~90ms is cacheable',
		source: 'test',
		...overrides,
	};
}

suite('opportunity board (lifecycle)', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-board-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('content-signature dedup ignores volatile numbers, not the evidence class', () => {
		const a = opportunitySignature('cache', 'a.py', 'f', '9 of 10 calls repeat; ~90ms cacheable');
		const b = opportunitySignature('cache', 'a.py', 'f', '42 of 51 calls repeat; ~1234.5ms cacheable');
		assert.strictEqual(a, b, 'measurements drift between traces — identity must not');
		const c = opportunitySignature('fanout', 'a.py', 'f', '9 of 10 calls repeat; ~90ms cacheable');
		assert.notStrictEqual(a, c, 'a different waste kind is a different opportunity');
	});

	test('post → dedup: re-posting the same signature appends nothing', () => {
		postOpportunities(root, [input()]);
		assert.strictEqual(boardLines(root), 1);
		// Same waste, re-measured: different numbers, same class.
		postOpportunities(root, [
			input({ predicted_ms: 120, evidence: 'recomputes identical inputs (14 of 16 calls repeat); ~120ms is cacheable' }),
		]);
		assert.strictEqual(boardLines(root), 1, 'no new line for a live id');
		const board = loadOpportunityBoard(root);
		assert.strictEqual(board.length, 1);
		assert.strictEqual(board[0].status, 'posted');
	});

	test('dispatched/resolved never re-dispatch; an outcome event resolves with the verdict', () => {
		const entry = [...postOpportunities(root, [input()]).values()][0];
		markOpportunitiesDispatched(root, [entry.id]);
		assert.strictEqual(loadOpportunityBoard(root)[0].status, 'dispatched');

		// Re-posting while dispatched returns the held entry — never a fresh one.
		const again = [...postOpportunities(root, [input()]).values()][0];
		assert.strictEqual(again.status, 'dispatched');

		// The C1 outcome event (episode ledger) referencing the dispatched row
		// resolves it, verdict as resolution.
		const now = Math.floor(Date.now() / 1000);
		const result = reconcileOpportunityBoard(
			root,
			[{ type: 'optimization_outcome', at: now + 5, episode_id: 'e1', row: 3, waste_kind: 'cache', predicted_ms: 90, delta_ms: -80, verdict: 'proven', attempt: 1 }],
			null,
			'',
		);
		assert.strictEqual(result.resolved, 1);
		const resolved = loadOpportunityBoard(root)[0];
		assert.strictEqual(resolved.status, 'resolved');
		assert.ok(resolved.resolution?.startsWith('proven'), resolved.resolution);

		// Resolved is still held: posting the same signature changes nothing.
		const held = [...postOpportunities(root, [input()]).values()][0];
		assert.strictEqual(held.status, 'resolved');
	});

	test('an outcome that PREDATES the dispatch never resolves it', () => {
		const entry = [...postOpportunities(root, [input()]).values()][0];
		markOpportunitiesDispatched(root, [entry.id]);
		const stale = Math.floor(Date.now() / 1000) - 3600;
		const result = reconcileOpportunityBoard(
			root,
			[{ type: 'optimization_outcome', at: stale, row: 3, waste_kind: 'cache', verdict: 'proven' }],
			null,
			'',
		);
		assert.strictEqual(result.resolved, 0);
		assert.strictEqual(loadOpportunityBoard(root)[0].status, 'dispatched');
	});

	test('relative expiry: absent for 3 NEW sessions expires; presence resets; same session never double-counts', () => {
		const entry = [...postOpportunities(root, [input()]).values()][0];
		const absent = new Set<string>();
		const present = new Set([entry.id]);

		reconcileOpportunityBoard(root, [], absent, 'session-1');
		reconcileOpportunityBoard(root, [], absent, 'session-1');
		assert.strictEqual(loadOpportunityBoard(root)[0].misses, 1, 'one session counts once');

		// Evidence returns: the miss counter resets.
		reconcileOpportunityBoard(root, [], present, 'session-2');
		assert.strictEqual(loadOpportunityBoard(root)[0].misses, 0);

		// Three consecutive new sessions without the signature → expired.
		reconcileOpportunityBoard(root, [], absent, 'session-3');
		reconcileOpportunityBoard(root, [], absent, 'session-4');
		let result = reconcileOpportunityBoard(root, [], absent, 'session-5');
		assert.strictEqual(result.expired, 1);
		const expired = loadOpportunityBoard(root)[0];
		assert.strictEqual(expired.status, 'expired');
		assert.strictEqual(expired.misses, EXPIRY_MISSING_SESSIONS);

		// Expiry re-opens the id: the next post is a fresh 'posted' entry.
		const reposted = [...postOpportunities(root, [input()]).values()][0];
		assert.strictEqual(reposted.status, 'posted');

		// Unknown evidence (freshIds null) must not advance the counter.
		result = reconcileOpportunityBoard(root, [], null, 'session-6');
		assert.strictEqual(result.expired, 0);
		assert.strictEqual(loadOpportunityBoard(root)[0].misses ?? 0, 0);
	});

	test('compaction bounds the append log relative to its live population', () => {
		// Two live entries plus one that will churn through many status lines.
		postOpportunities(root, [input(), input({ name: 'other', kind: 'fanout' })]);
		const absent = new Set<string>();
		// Drive miss-count churn well past 4× the live-entry count. Each cycle
		// appends miss lines; a fresh post re-opens expired ids so churn repeats.
		for (let cycle = 0; cycle < 6; cycle += 1) {
			for (let s = 0; s < EXPIRY_MISSING_SESSIONS; s += 1) {
				reconcileOpportunityBoard(root, [], absent, `c${cycle}-s${s}`);
			}
			postOpportunities(root, [input(), input({ name: 'other', kind: 'fanout' })]);
		}
		const board = loadOpportunityBoard(root);
		const live = board.filter((e) => e.status !== 'expired');
		assert.ok(
			boardLines(root) <= 4 * Math.max(1, live.length),
			`file stays within 4× its live entries (${boardLines(root)} lines, ${live.length} live)`,
		);
		// Newest-status-wins survived every rewrite.
		assert.ok(live.every((e) => e.status === 'posted'));
	});
});

// ---- the disk pipeline: sweeps route through the analyzer -------------------

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
	const edges: GraphEdge[] = [
		{ src: 0, dst: 1, kind: 'invoke' },
		{ src: 0, dst: 2, kind: 'invoke' },
		{ src: 0, dst: 4, kind: 'invoke' },
	];
	fs.writeFileSync(path.join(store, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n') + '\n');
	fs.writeFileSync(path.join(store, 'meta.json'), JSON.stringify({ epoch: 1 }));
}

function ev(comp: string, event: 'enter' | 'exit', extra: Record<string, unknown>): string {
	return JSON.stringify({ component: `app.svc.${comp}`, event, ...extra });
}

function clean(comp: string, ms: number): [string, string] {
	return [
		ev(comp, 'enter', { args_hash: `${comp}-${Math.random()}` }),
		ev(comp, 'exit', { duration_ms: ms, error_type: null, determinism_sources: [] }),
	];
}

function writeSession(root: string, dir: string, lines: string[], iso: string): void {
	const d = path.join(root, '.vinv', 'captures', dir, 'svc');
	fs.mkdirSync(d, { recursive: true });
	const f = path.join(d, 'trace.jsonl');
	fs.writeFileSync(f, lines.join('\n') + '\n');
	fs.utimesSync(f, new Date(iso), new Date(iso));
}

suite('opportunity board (sweeps route through the analyzer)', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-board-sweep-'));
		writeStore(root);
		const lines: string[] = [];
		// handler: 1 call at the typical per-call cost — only serialize's caller.
		lines.push(...clean('handler', 2));
		// get_docs: 10 identical-input calls with one constant result → cache waste.
		for (let i = 0; i < 10; i++) {
			lines.push(ev('get_docs', 'enter', { args_hash: 'H' }));
			lines.push(ev('get_docs', 'exit', { duration_ms: 10, error_type: null, determinism_sources: [], result_hash: 'R' }));
		}
		// serialize: 50 distinct-arg calls under handler's 1 → fan-out waste.
		for (let i = 0; i < 50; i++) {
			lines.push(...clean('serialize', 2));
		}
		// already_fast: DOMINATES raw traced time (300ms) at 1ms/call — a raw
		// hotspot list would rank it first, but nothing is removable.
		for (let i = 0; i < 300; i++) {
			lines.push(...clean('already_fast', 1));
		}
		// broken_call: the single biggest raw duration, but it RAISED.
		lines.push(ev('broken_call', 'enter', { args_hash: 'b0' }));
		lines.push(ev('broken_call', 'exit', { duration_ms: 500, error_type: 'ValueError', determinism_sources: [] }));
		writeSession(root, 'run1', lines, '2020-01-01T00:00:00Z');
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('the hotspot sweep dispatches the analyzer ranking, not the raw time Pareto head', () => {
		const prep = prepareOptimizationSweep(root, 'hotspots', []);
		assert.ok(prep.plan, 'evidence supports a plan');
		const analyzer = rankedOpportunityCandidates(root);
		const expected = analyzer.filter((c) => c.waste_kind !== 'cache').map((c) => c.row);
		assert.deepStrictEqual(
			[...(prep.plan!.task.seedRows ?? [])].sort(),
			expected.sort(),
			'seed rows are exactly the non-cache analyzer candidates',
		);
		const already = SYMBOLS.indexOf('already_fast');
		const broken = SYMBOLS.indexOf('broken_call');
		assert.ok(!prep.plan!.task.seedRows?.includes(already), 'hot-but-optimal never dispatches');
		assert.ok(!prep.plan!.task.seedRows?.includes(broken), 'failing time never dispatches');
	});

	test('the cache sweep takes exactly the cache-kind candidates', () => {
		const prep = prepareOptimizationSweep(root, 'cache_candidates', []);
		assert.ok(prep.plan);
		const getDocs = SYMBOLS.indexOf('get_docs');
		assert.deepStrictEqual(prep.plan!.task.seedRows, [getDocs]);
		assert.ok(prep.plan!.task.title.startsWith('Cache'));
	});

	test('sweeps post their candidates to the board before dispatch', () => {
		prepareOptimizationSweep(root, 'hotspots', []);
		const board = loadOpportunityBoard(root);
		assert.ok(board.length >= 2, 'both waste kinds posted');
		assert.ok(board.every((e) => e.status === 'posted'));
		assert.ok(board.some((e) => e.kind === 'cache' && e.name === 'get_docs'));
		assert.ok(board.some((e) => e.kind === 'fanout' && e.name === 'serialize'));
	});

	test('no re-dispatch of dispatched: the board holds ids across preparations, until expiry re-opens them', () => {
		const prep1 = prepareOptimizationSweep(root, 'hotspots', []);
		assert.ok(prep1.plan);
		markOpportunitiesDispatched(root, prep1.plan!.boardIds);

		// The same sweep — as after an editor restart — finds nothing to dispatch.
		const prep2 = prepareOptimizationSweep(root, 'hotspots', []);
		assert.strictEqual(prep2.plan, null);
		assert.ok(prep2.heldCount >= 1, 'held on the board, not vanished');

		// The C1 outcome resolves the dispatched entry; it is STILL held.
		const serialize = SYMBOLS.indexOf('serialize');
		const now = Math.floor(Date.now() / 1000);
		const prep3 = prepareOptimizationSweep(root, 'hotspots', [
			{ type: 'optimization_outcome', at: now + 5, episode_id: 'e9', row: serialize, waste_kind: 'fanout', predicted_ms: 98, delta_ms: -60, verdict: 'proven', attempt: 1 },
		]);
		assert.strictEqual(prep3.plan, null);
		const resolvedEntry = loadOpportunityBoard(root).find((e) => e.name === 'serialize');
		assert.strictEqual(resolvedEntry?.status, 'resolved');
		assert.ok(resolvedEntry?.resolution?.startsWith('proven'));

		// Force expiry (signature absent from 3 fresh-evidence sessions), then the
		// sweep re-opens and re-dispatches — the full lifecycle closes.
		for (let s = 0; s < EXPIRY_MISSING_SESSIONS; s += 1) {
			reconcileOpportunityBoard(root, [], new Set<string>(), `forced-${s}`);
		}
		const prep4 = prepareOptimizationSweep(root, 'hotspots', []);
		assert.ok(prep4.plan, 'expired ids re-open as posted and dispatch again');
	});

	test('a panel (single-row) dispatch shares the same board claim as the sweep', () => {
		const serialize = SYMBOLS.indexOf('serialize');
		const prep = prepareRowOptimization(root, serialize, []);
		assert.ok(prep.plan);
		assert.deepStrictEqual(prep.plan!.task.seedRows, [serialize]);
		markOpportunitiesDispatched(root, prep.plan!.boardIds);

		// The panel click claimed the id — neither the panel NOR the sweep can
		// re-dispatch it (cross-surface, cross-restart dedup).
		const again = prepareRowOptimization(root, serialize, []);
		assert.strictEqual(again.plan, null);
		assert.strictEqual(again.heldCount, 1);
		const sweep = prepareOptimizationSweep(root, 'hotspots', []);
		assert.strictEqual(sweep.plan, null, 'the sweep respects the panel claim');
	});

	test('syncOpportunityBoard without an index reconciles but never posts or expires', () => {
		const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-board-bare-'));
		try {
			const sync = syncOpportunityBoard(bare, 'test', []);
			assert.strictEqual(sync.evidenceKnown, false);
			assert.deepStrictEqual(sync.entries, []);
			assert.strictEqual(fs.existsSync(opportunityBoardPath(bare)), false, 'no board invented');
		} finally {
			fs.rmSync(bare, { recursive: true, force: true });
		}
	});

	test('renderOpportunityBoard: human lines plus machine JSON', () => {
		assert.ok(renderOpportunityBoard([]).includes('empty'));
		prepareOptimizationSweep(root, 'hotspots', []);
		const text = renderOpportunityBoard(loadOpportunityBoard(root));
		assert.ok(text.includes('[posted]'));
		assert.ok(text.includes('serialize'));
		const jsonLines = text.split('Machine JSON (one entry per line):\n')[1];
		assert.ok(jsonLines, 'machine block present');
		for (const line of jsonLines.split('\n').filter((l) => l.trim())) {
			const parsed = JSON.parse(line) as { id?: string; status?: string };
			assert.ok(parsed.id && parsed.status, 'each machine line is a full entry');
		}
	});
});
