/**
 * Tests for shard-file adjudication — the batch replacement for one harness
 * process per ambiguous reference.
 *
 * The invariants worth protecting are the ones whose failures are silent: a
 * cap that drops references without saying so, an ordering that banks the
 * wrong work when a session dies early, a validator that lets an agent write
 * an edge to a candidate it was never offered, and a resume loop that re-asks
 * abstentions forever because "I abstained" and "I never got there" look the
 * same on disk.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	countCallers,
	decisionKey,
	groupPending,
	orderGroups,
	parseJsonlRows,
	planShards,
	readOutRows,
	readRanks,
	remainder,
	shardName,
	validateOut,
	writeShards,
	type PendingGroup,
} from '../graph/enhanceShards';
import { adjudicateViaShards, type PendingEdge } from '../graph/graphEnhancer';

function record(
	srcId: string,
	name: string,
	candidateIds: string[],
): PendingEdge {
	return {
		src_id: srcId,
		src_file: `${srcId}.py`,
		src_name: srcId,
		name,
		candidates: candidateIds.map((id) => ({
			id,
			file: `${id}.py`,
			kind: 'function',
			summary: `def ${id}`,
		})),
	};
}

function tempStore(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-shards-'));
}

suite('Pending-edge grouping', () => {
	test('callers asking the same question about the same candidates collapse', () => {
		const records = [
			record('a', 'parse', ['x', 'y']),
			record('b', 'parse', ['x', 'y']),
			record('c', 'parse', ['x', 'y']),
		];
		const groups = groupPending(records, null);
		assert.strictEqual(groups.length, 1, 'one question, not three');
		assert.strictEqual(groups[0].callers.length, 3);
		assert.strictEqual(countCallers(groups), 3);
	});

	test('the same name against a different candidate set is a different question', () => {
		const groups = groupPending(
			[record('a', 'parse', ['x', 'y']), record('b', 'parse', ['x', 'z'])],
			null,
		);
		assert.strictEqual(groups.length, 2);
	});

	test('candidate order does not split a group', () => {
		// The engine publishes candidates in chunk order, which differs between
		// callers; keying on the unsorted list would split one question in two.
		const groups = groupPending(
			[record('a', 'parse', ['x', 'y']), record('b', 'parse', ['y', 'x'])],
			null,
		);
		assert.strictEqual(groups.length, 1);
	});

	test('a group carries its highest caller rank', () => {
		const ranks = new Map([
			['a', 0.1],
			['b', 0.9],
		]);
		const groups = groupPending(
			[record('a', 'parse', ['x', 'y']), record('b', 'parse', ['x', 'y'])],
			ranks,
		);
		assert.strictEqual(groups[0].rank, 0.9);
	});
});

suite('Shard ordering', () => {
	test('with ranks, the most important question drains first', () => {
		const ranks = new Map([
			['a', 0.2],
			['b', 0.8],
		]);
		const groups = groupPending(
			[record('a', 'low', ['x', 'y']), record('b', 'high', ['x', 'y', 'z'])],
			ranks,
		);
		const ordered = orderGroups(groups, true);
		assert.strictEqual(ordered[0].name, 'high');
	});

	test('without ranks, the most decidable question drains first', () => {
		// A store with no PageRank gives no importance signal at all. Ordering
		// by nothing would make a cap drop arbitrary references, so fall back to
		// fewest candidates — the questions most likely to get a real answer.
		const groups = groupPending(
			[record('a', 'wide', ['x', 'y', 'z', 'w']), record('b', 'narrow', ['x', 'y'])],
			null,
		);
		const ordered = orderGroups(groups, false);
		assert.strictEqual(ordered[0].name, 'narrow');
	});

	test('ordering is deterministic so a resumed plan matches the original', () => {
		const groups = groupPending(
			[record('a', 'one', ['x', 'y']), record('b', 'two', ['p', 'q'])],
			null,
		);
		const first = orderGroups(groups, false).map((g) => g.key);
		const second = orderGroups([...groups].reverse(), false).map((g) => g.key);
		assert.deepStrictEqual(first, second);
	});
});

suite('Shard planning', () => {
	function manyGroups(count: number, callersEach: number): PendingGroup[] {
		const records: PendingEdge[] = [];
		for (let g = 0; g < count; g++) {
			for (let c = 0; c < callersEach; c++) {
				records.push(record(`caller${g}_${c}`, `name${g}`, ['x', 'y']));
			}
		}
		return orderGroups(groupPending(records, null), false);
	}

	test('shard count is derived from the queue, not fixed', () => {
		const tiny = planShards(manyGroups(2, 3), { itemsPerShard: 100, maxShards: 9 });
		assert.strictEqual(tiny.shards.length, 1, 'six callers is one shard, not nine');
		assert.strictEqual(tiny.skipped, 0);

		const full = planShards(manyGroups(30, 10), { itemsPerShard: 100, maxShards: 9 });
		assert.strictEqual(full.shards.length, 3, '300 callers at 100 each');
	});

	test('groups are never split across shards', () => {
		const plan = planShards(manyGroups(6, 40), { itemsPerShard: 100, maxShards: 3 });
		const keys = plan.shards.flat().map((g) => g.key);
		assert.strictEqual(new Set(keys).size, keys.length, 'a group appears in one shard only');
	});

	test('a group larger than the shard target stays whole', () => {
		// `JSON.parse` had 135 callers against 2 candidates. Splitting it would
		// have three sessions independently solve the identical problem.
		const plan = planShards(manyGroups(1, 135), { itemsPerShard: 100, maxShards: 3 });
		assert.strictEqual(plan.shards.length, 1);
		assert.strictEqual(countCallers(plan.shards[0]), 135);
	});

	test('work past the ceiling is reported, never silently dropped', () => {
		const plan = planShards(manyGroups(20, 50), { itemsPerShard: 100, maxShards: 2 });
		assert.strictEqual(plan.shards.length, 2);
		assert.ok(plan.skipped > 0, 'the remainder must be counted');
		assert.strictEqual(
			countCallers(plan.shards.flat()) + plan.skipped,
			20 * 50,
			'every caller is either planned or explicitly skipped',
		);
	});
});

suite('Out-file validation', () => {
	const shard: PendingGroup[] = orderGroups(
		groupPending([record('a', 'parse', ['x', 'y']), record('b', 'parse', ['x', 'y'])], null),
		false,
	);

	test('a resolution to an offered candidate is accepted', () => {
		const out = validateOut(shard, [{ src_id: 'a', name: 'parse', dst_id: 'x' }]);
		assert.deepStrictEqual(out.overrides, [
			{ src_id: 'a', dst_id: 'x', name: 'parse', kind: 'invoke' },
		]);
		assert.strictEqual(out.invalid, 0);
	});

	test('a dst_id that was never a candidate is rejected', () => {
		const out = validateOut(shard, [{ src_id: 'a', name: 'parse', dst_id: 'somewhere_else' }]);
		assert.strictEqual(out.overrides.length, 0);
		assert.strictEqual(out.invalid, 1);
	});

	test('a caller outside this shard is rejected', () => {
		const out = validateOut(shard, [{ src_id: 'zzz', name: 'parse', dst_id: 'x' }]);
		assert.strictEqual(out.overrides.length, 0);
		assert.strictEqual(out.invalid, 1);
	});

	test('an explicit abstention is a decision, not a rejection', () => {
		const out = validateOut(shard, [{ src_id: 'a', name: 'parse', dst_id: null }]);
		assert.strictEqual(out.abstentions.length, 1);
		assert.strictEqual(out.invalid, 0);
	});

	test('the first decision per caller wins', () => {
		const out = validateOut(shard, [
			{ src_id: 'a', name: 'parse', dst_id: 'x' },
			{ src_id: 'a', name: 'parse', dst_id: 'y' },
		]);
		assert.strictEqual(out.overrides.length, 1);
		assert.strictEqual(out.overrides[0].dst_id, 'x');
	});

	test('malformed rows cost a retry, never the shard', () => {
		const out = validateOut(shard, [
			null,
			'not an object',
			{ src_id: 'a', name: 'parse', dst_id: 'x' },
		]);
		assert.strictEqual(out.overrides.length, 1, 'the good row still lands');
		assert.strictEqual(out.invalid, 2);
	});
});

suite('Resume and remainder', () => {
	const shard: PendingGroup[] = orderGroups(
		groupPending(
			[
				record('a', 'parse', ['x', 'y']),
				record('b', 'parse', ['x', 'y']),
				record('c', 'parse', ['x', 'y']),
			],
			null,
		),
		false,
	);

	test('only undecided callers are asked again', () => {
		const decided = new Set([decisionKey('a', 'parse')]);
		const left = remainder(shard, decided);
		assert.strictEqual(countCallers(left), 2);
	});

	test('an abstained caller is never re-asked', () => {
		// Without a persisted abstention row this is the loop that never ends:
		// the reference stays pending, so every top-up pass re-asks the one
		// question whose only correct answer is "I cannot tell".
		const out = validateOut(shard, [{ src_id: 'a', name: 'parse', dst_id: null }]);
		const decided = new Set(out.abstentions.map((r) => decisionKey(r.src_id, r.name)));
		const left = remainder(shard, decided);
		assert.ok(
			!left.some((g) => g.callers.some((c) => c.src_id === 'a')),
			'an abstention settles the caller',
		);
	});

	test('a fully decided shard drops out of the round', () => {
		const decided = new Set(['a', 'b', 'c'].map((id) => decisionKey(id, 'parse')));
		assert.deepStrictEqual(remainder(shard, decided), []);
	});
});

suite('Agent output parsing', () => {
	test('plain JSONL', () => {
		const rows = parseJsonlRows('{"src_id":"a","name":"p","dst_id":"x"}\n{"src_id":"b","name":"p","dst_id":null}\n');
		assert.strictEqual(rows.length, 2);
	});

	test('a fenced block is not a failed session', () => {
		const rows = parseJsonlRows('```jsonl\n{"src_id":"a","name":"p","dst_id":"x"}\n```');
		assert.strictEqual(rows.length, 1);
	});

	test('a JSON array is accepted', () => {
		const rows = parseJsonlRows('[{"src_id":"a","name":"p","dst_id":"x"}]');
		assert.strictEqual(rows.length, 1);
	});

	test('prose around the rows is skipped, not fatal', () => {
		const rows = parseJsonlRows(
			'Here are my decisions:\n{"src_id":"a","name":"p","dst_id":"x"}\nDone.',
		);
		assert.strictEqual(rows.length, 1);
	});

	test('a truncated final line does not discard the good ones', () => {
		const rows = parseJsonlRows('{"src_id":"a","name":"p","dst_id":"x"}\n{"src_id":"b","na');
		assert.strictEqual(rows.length, 1);
	});
});

suite('Shard files on disk', () => {
	test('out rows from a different epoch are discarded', () => {
		// A long session can outlive an `index update`, which renumbers chunk
		// ids. Merging those decisions would point edges at the wrong code.
		const root = tempStore();
		const storeDir = path.join(root, '.vinv', 'index');
		fs.mkdirSync(storeDir, { recursive: true });
		const groups = orderGroups(groupPending([record('a', 'parse', ['x', 'y'])], null), false);
		writeShards(root, 7, [groups]);
		fs.writeFileSync(
			path.join(storeDir, 'enhance', shardName(0, 'out')),
			'{"src_id":"a","name":"parse","dst_id":"x"}\n',
			'utf8',
		);
		assert.strictEqual(readOutRows(root, 0, 7).length, 1, 'same epoch merges');
		assert.strictEqual(readOutRows(root, 0, 8).length, 0, 'a moved store discards');
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('a missing out-file is empty, not an exception', () => {
		const root = tempStore();
		fs.mkdirSync(path.join(root, '.vinv', 'index'), { recursive: true });
		const groups = orderGroups(groupPending([record('a', 'parse', ['x', 'y'])], null), false);
		writeShards(root, 1, [groups]);
		assert.deepStrictEqual(readOutRows(root, 0, 1), []);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('a shard line carries its candidates once, not once per caller', () => {
		const root = tempStore();
		fs.mkdirSync(path.join(root, '.vinv', 'index'), { recursive: true });
		const groups = orderGroups(
			groupPending(
				[record('a', 'parse', ['x', 'y']), record('b', 'parse', ['x', 'y'])],
				null,
			),
			false,
		);
		writeShards(root, 1, [groups]);
		const written = fs.readFileSync(
			path.join(root, '.vinv', 'index', 'enhance', shardName(0, 'shard')),
			'utf8',
		);
		const lines = written.trim().split('\n');
		assert.strictEqual(lines.length, 1, 'two callers, one question, one line');
		const parsed = JSON.parse(lines[0]) as { candidates: unknown[]; callers: unknown[] };
		assert.strictEqual(parsed.candidates.length, 2);
		assert.strictEqual(parsed.callers.length, 2);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('session size is held and the count derives from it', () => {
		// This repository's real queue. Session SIZE decides answer quality, so
		// it is the fixed quantity; the count follows. An earlier version did
		// the reverse — three shards, stretched to fit — which on a monorepo
		// means three sessions of thousands, which no agent finishes.
		const records: PendingEdge[] = [];
		for (let i = 0; i < 551; i++) {
			records.push(record(`c${i}`, `name${i % 60}`, ['x', 'y']));
		}
		const groups = orderGroups(groupPending(records, null), false);
		const plan = planShards(groups, { itemsPerShard: 100, maxShards: 9 });
		assert.strictEqual(plan.skipped, 0, '551 callers, nothing lost');
		assert.strictEqual(countCallers(plan.shards.flat()), 551);
		assert.strictEqual(plan.shards.length, 6, '551 at 100 per session');
		for (const shard of plan.shards) {
			assert.ok(
				countCallers(shard) <= 100 + 10,
				`no session far exceeds 100, got ${countCallers(shard)}`,
			);
		}
	});

	test('a store with no ranks reports null rather than all-zero', () => {
		const root = tempStore();
		const storeDir = path.join(root, 'store');
		fs.mkdirSync(storeDir, { recursive: true });
		fs.writeFileSync(
			path.join(storeDir, 'chunks.jsonl'),
			'{"id":"a"}\n{"id":"b","rank":0}\n',
			'utf8',
		);
		assert.strictEqual(readRanks(storeDir), null);
		fs.writeFileSync(
			path.join(storeDir, 'chunks.jsonl'),
			'{"id":"a","rank":0.4}\n',
			'utf8',
		);
		assert.strictEqual(readRanks(storeDir)?.get('a'), 0.4);
		fs.rmSync(root, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// end to end, against a stub agent — no CLI process, no tokens
// ---------------------------------------------------------------------------

/** A workspace with a pending queue, ready for adjudication. */
function workspaceWith(records: PendingEdge[], epoch = 3): string {
	const root = tempStore();
	const storeDir = path.join(root, '.vinv', 'index');
	fs.mkdirSync(storeDir, { recursive: true });
	fs.writeFileSync(
		path.join(storeDir, 'pending_edges.jsonl'),
		records.map((r) => JSON.stringify(r)).join('\n') + '\n',
		'utf8',
	);
	fs.writeFileSync(path.join(storeDir, 'meta.json'), JSON.stringify({ epoch }), 'utf8');
	return root;
}

function overridesIn(root: string): Array<Record<string, unknown>> {
	const file = path.join(root, '.vinv', 'index', 'edge_overrides.jsonl');
	if (!fs.existsSync(file)) {
		return [];
	}
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * A stub agent that reads its shard file and writes decisions, exactly as the
 * prompt asks a real one to. `answer` decides what it does per caller, so a
 * test can make it resolve, abstain, cheat, or quit halfway.
 */
function stubAgent(
	root: string,
	answer: (srcId: string, name: string, candidateIds: string[]) => string | null | undefined,
) {
	return async (index: number, _prompt: string, _shard: unknown): Promise<string | null> => {
		const dir = path.join(root, '.vinv', 'index', 'enhance');
		const lines = fs
			.readFileSync(path.join(dir, shardName(index, 'shard')), 'utf8')
			.split('\n')
			.filter((l) => l.trim());
		const out: string[] = [];
		for (const line of lines) {
			const group = JSON.parse(line) as {
				name: string;
				candidates: Array<{ id: string }>;
				callers: Array<{ src_id: string }>;
			};
			const ids = group.candidates.map((c) => c.id);
			for (const caller of group.callers) {
				const decision = answer(caller.src_id, group.name, ids);
				if (decision === undefined) {
					continue; // this caller was never reached
				}
				out.push(
					JSON.stringify({ src_id: caller.src_id, name: group.name, dst_id: decision }),
				);
			}
		}
		fs.writeFileSync(path.join(dir, shardName(index, 'out')), out.join('\n') + '\n', 'utf8');
		return 'done';
	};
}

suite('Shard adjudication end to end (stub agent)', () => {
	const ctx = {} as never; // only reached via runIndexUpdate, which apply:false skips

	test('decisions land in edge_overrides and cost a handful of sessions', async () => {
		const records = Array.from({ length: 240 }, (_, i) =>
			record(`c${i}`, `name${i % 40}`, ['x', 'y']),
		);
		const root = workspaceWith(records);
		const outcome = await adjudicateViaShards(ctx, root, {
			apply: false,
			dispatch: stubAgent(root, () => 'x'),
		});
		assert.strictEqual(outcome.resolved, 240);
		assert.strictEqual(outcome.skipped, 0);
		assert.ok(outcome.sessions <= 3, `240 references in ${outcome.sessions} sessions`);
		assert.strictEqual(overridesIn(root).length, 240);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('an abstention is persisted so it is never asked again', async () => {
		const root = workspaceWith([record('a', 'parse', ['x', 'y'])]);
		const outcome = await adjudicateViaShards(ctx, root, {
			apply: false,
			dispatch: stubAgent(root, () => null),
		});
		assert.strictEqual(outcome.abstained, 1);
		const rows = overridesIn(root);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].dst_id, null, 'a null dst_id creates no edge but settles it');

		// The Rust loader skips a null dst_id; readAdjudicated keys on
		// src_id+name, so a second run has nothing left to ask.
		const again = await adjudicateViaShards(ctx, root, {
			apply: false,
			dispatch: stubAgent(root, () => 'x'),
		});
		assert.strictEqual(again.sessions, 0, 'the settled reference is not re-dispatched');
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('a session that quits halfway keeps its work and the rest is topped up', async () => {
		const records = Array.from({ length: 10 }, (_, i) => record(`c${i}`, 'parse', ['x', 'y']));
		const root = workspaceWith(records);
		let pass = 0;
		const outcome = await adjudicateViaShards(ctx, root, {
			apply: false,
			dispatch: async (index, prompt, shard) => {
				pass += 1;
				// First pass answers only half the callers, then stops.
				const half = pass === 1;
				let seen = 0;
				return stubAgent(root, () => {
					seen += 1;
					return half && seen > 5 ? undefined : 'x';
				})(index, prompt, shard);
			},
		});
		assert.strictEqual(outcome.resolved, 10, 'the tail is picked up by a top-up pass');
		assert.ok(outcome.sessions >= 2, 'it took more than one session');
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('an agent naming a candidate it was not offered writes no edge', async () => {
		const root = workspaceWith([record('a', 'parse', ['x', 'y'])]);
		const outcome = await adjudicateViaShards(ctx, root, {
			apply: false,
			dispatch: stubAgent(root, () => 'a_symbol_from_somewhere_else'),
		});
		assert.strictEqual(outcome.resolved, 0, 'the contract rejects it');
		assert.strictEqual(overridesIn(root).length, 0);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('an agent that writes nothing at all is survivable', async () => {
		const root = workspaceWith([record('a', 'parse', ['x', 'y'])]);
		const outcome = await adjudicateViaShards(ctx, root, {
			apply: false,
			dispatch: async () => null,
		});
		assert.strictEqual(outcome.resolved, 0);
		assert.strictEqual(outcome.abstained, 0);
		assert.ok(outcome.sessions > 0, 'it tried');
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('answers in the reply text are used when no out-file was written', async () => {
		// Harnesses differ in how reliably they write files; a session that
		// answered in its reply is not a failed session.
		const root = workspaceWith([record('a', 'parse', ['x', 'y'])]);
		const outcome = await adjudicateViaShards(ctx, root, {
			apply: false,
			dispatch: async () => '{"src_id":"a","name":"parse","dst_id":"y"}',
		});
		assert.strictEqual(outcome.resolved, 1);
		assert.strictEqual(overridesIn(root)[0].dst_id, 'y');
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('an empty queue dispatches nothing', async () => {
		const root = workspaceWith([]);
		const outcome = await adjudicateViaShards(ctx, root, {
			apply: false,
			dispatch: async () => {
				assert.fail('must not dispatch with nothing to ask');
			},
		});
		assert.strictEqual(outcome.sessions, 0);
		fs.rmSync(root, { recursive: true, force: true });
	});
});
