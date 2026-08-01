/**
 * Shard-file adjudication — the batch form of graph enhancement.
 *
 * The per-reference form dispatched ONE harness CLI process per ambiguous
 * reference: 888 full agent boots on this repository, 2 MB of prompt, and an
 * identical candidate list re-sent 135 times for `JSON.parse` alone. It also
 * banked nothing until the very last reference finished, so a closed window
 * threw the whole run away.
 *
 * Here the extension writes the work to disk and hands the agent a PATH:
 *
 *   .vinv/index/enhance/manifest.json   { epoch, shards, createdAt }
 *   .vinv/index/enhance/shard-01.jsonl  one line per GROUP of callers
 *   .vinv/index/enhance/out-01.jsonl    the agent appends one line per decision
 *
 * Three consequences, in order of how much they matter:
 *
 *  1. The agent can READ THE CALLER. Rule 1 of the adjudication contract is
 *     import reachability, and the inlined prompt never sent any imports — it
 *     asked for a judgement it withheld the evidence for. An agent holding the
 *     file can open it.
 *  2. Work is durable as it happens. Every decision is a line on disk, so a
 *     killed session costs its tail rather than its whole shard, and a re-run
 *     asks only what is missing.
 *  3. The shared part of the prompt — the candidate list, with summaries — is
 *     written once per group instead of once per caller.
 *
 * Grouping is by (name + candidate set), and groups are never split across
 * shards: every caller in a group is the SAME question about the SAME
 * candidates, so one session answers them together. That is also why this is
 * not arbitrary N-chunking — 100 unrelated puzzles in one context invite the
 * anchoring that the abstain-don't-guess contract exists to prevent.
 *
 * Everything above the IO layer is pure and unit-tested (enhanceShards.test.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { indexStoreDir } from './indexGraph';
import type { PendingEdge } from './graphEnhancer';

/** Directory holding the shard/out contract for the current epoch. */
export function enhanceDir(workspaceRoot: string): string {
	return path.join(indexStoreDir(workspaceRoot), 'enhance');
}

/** One group of callers asking the same question about the same candidates. */
export interface PendingGroup {
	/** `name\0<sorted candidate ids>` — stable identity of the question. */
	key: string;
	/** The referenced name, as written at the call site. */
	name: string;
	candidates: PendingEdge['candidates'];
	/** Every caller referencing `name` against exactly these candidates. */
	callers: Array<{ src_id: string; src_file: string; src_name: string }>;
	/** Highest caller rank in the group (0 when the store has no ranks). */
	rank: number;
}

/** A decision the agent reported for one caller. */
export interface Decision {
	src_id: string;
	name: string;
	/** A candidate id, or null for an explicit abstention. */
	dst_id: string | null;
}

/** The identity of one decision — matches `readAdjudicated`'s key format. */
export function decisionKey(srcId: string, name: string): string {
	return `${srcId}\u0000${name}`;
}

/**
 * Per-chunk PageRank, or null when the store publishes none.
 *
 * Null is a distinct answer, not zero: with no ranks there is no "most
 * valuable first" ordering to bank, and a cap would then drop arbitrary
 * references rather than the least important ones. `orderGroups` picks a
 * different strategy for that case instead of silently ordering by nothing.
 */
export function readRanks(storeDir: string): Map<string, number> | null {
	let content: string;
	try {
		content = fs.readFileSync(path.join(storeDir, 'chunks.jsonl'), 'utf8');
	} catch {
		return null;
	}
	const ranks = new Map<string, number>();
	let sawRank = false;
	for (const line of content.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const c = JSON.parse(line) as { id?: string; rank?: number };
			if (typeof c.id === 'string') {
				const rank = typeof c.rank === 'number' ? c.rank : 0;
				ranks.set(c.id, rank);
				sawRank ||= rank > 0;
			}
		} catch {
			// Skip unreadable lines.
		}
	}
	return sawRank ? ranks : null;
}

/** Collapses records into groups keyed on (name + candidate set). */
export function groupPending(
	records: PendingEdge[],
	ranks: Map<string, number> | null,
): PendingGroup[] {
	const groups = new Map<string, PendingGroup>();
	for (const record of records) {
		const ids = record.candidates.map((c) => c.id).sort();
		const key = `${record.name}\u0000${ids.join(',')}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				name: record.name,
				candidates: record.candidates,
				callers: [],
				rank: 0,
			};
			groups.set(key, group);
		}
		group.callers.push({
			src_id: record.src_id,
			src_file: record.src_file,
			src_name: record.src_name,
		});
		group.rank = Math.max(group.rank, ranks?.get(record.src_id) ?? 0);
	}
	return [...groups.values()];
}

/**
 * Drain order. With ranks: most important caller first, so a session that dies
 * early still banked the edges that move PageRank most. Without them: fewest
 * candidates first — the most decidable questions, which is the best proxy for
 * "worth answering" when importance is unknown. Ties break on the key so the
 * plan is deterministic across runs (and therefore resumable).
 */
export function orderGroups(groups: PendingGroup[], hasRanks: boolean): PendingGroup[] {
	return [...groups].sort((a, b) => {
		if (hasRanks && b.rank !== a.rank) {
			return b.rank - a.rank;
		}
		if (a.candidates.length !== b.candidates.length) {
			return a.candidates.length - b.candidates.length;
		}
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
}

/**
 * Sizing knobs.
 *
 * `itemsPerShard` is HARD. An earlier version stretched it to fit the queue
 * inside a fixed shard count, which held the session budget at the cost of
 * session size — and on a large repository that means three sessions of many
 * thousands of references each, which is not a session any agent finishes.
 * Size is the thing that decides whether a session produces good answers, so
 * size wins and the count derives from it.
 */
export interface ShardOptions {
	itemsPerShard: number;
	maxShards: number;
}

export interface ShardPlan {
	shards: PendingGroup[][];
	/** Callers past the cap — reported, never silently dropped. */
	skipped: number;
}

/**
 * Splits ordered groups into shards of roughly `itemsPerShard` CALLERS each.
 *
 * Shard count is derived from the queue: twelve references make one shard
 * rather than three empty spawns, and 551 make six. `maxShards` is a ceiling
 * against a runaway monorepo, not a target — what it excludes lands in
 * `skipped` and is reported rather than quietly lost.
 *
 * Groups stay whole — splitting `JSON.parse` across sessions would have three
 * agents solve the same problem — so a group larger than the target simply
 * makes its shard bigger rather than being cut.
 */
export function planShards(groups: PendingGroup[], options: ShardOptions): ShardPlan {
	const { itemsPerShard, maxShards } = options;
	const shards: PendingGroup[][] = [];
	let current: PendingGroup[] = [];
	let count = 0;
	let skipped = 0;

	for (const group of groups) {
		if (count > 0 && count + group.callers.length > itemsPerShard) {
			shards.push(current);
			current = [];
			count = 0;
		}
		if (shards.length >= maxShards) {
			// Past the ceiling: everything ordered behind this point is less
			// valuable than what is already planned, and it is REPORTED — see
			// ShardPlan.skipped, which the enhance record persists.
			skipped += group.callers.length;
			continue;
		}
		current.push(group);
		count += group.callers.length;
	}
	if (current.length > 0 && shards.length < maxShards) {
		shards.push(current);
	}
	return { shards, skipped };
}

/** Total callers across a plan — what "items" means in progress reporting. */
export function countCallers(groups: PendingGroup[]): number {
	return groups.reduce((n, g) => n + g.callers.length, 0);
}

export interface ValidationResult {
	/** Resolutions: `dst_id` named a candidate of that caller's own group. */
	overrides: Array<{ src_id: string; dst_id: string; name: string; kind: string }>;
	/** Explicit abstentions — a DECISION, and persisted as one. */
	abstentions: Array<{ src_id: string; name: string; dst_id: null }>;
	/** Rows rejected by the contract, for the log and the retry count. */
	invalid: number;
}

/**
 * Applies the adjudication contract to what the agent wrote.
 *
 * Identical strictness to `parseAdjudication`, moved from stdout to a file: a
 * `dst_id` must name a candidate of the group that caller belongs to, so an
 * agent that drifts costs a re-queue rather than a wrong edge. Rows for callers
 * outside this shard are rejected outright — a session may only answer what it
 * was asked. First decision per caller wins; later duplicates are ignored.
 */
export function validateOut(shard: PendingGroup[], rows: unknown[]): ValidationResult {
	const candidatesByCaller = new Map<string, Set<string>>();
	const nameByCaller = new Map<string, string>();
	for (const group of shard) {
		const ids = new Set(group.candidates.map((c) => c.id));
		for (const caller of group.callers) {
			candidatesByCaller.set(decisionKey(caller.src_id, group.name), ids);
			nameByCaller.set(decisionKey(caller.src_id, group.name), group.name);
		}
	}

	const result: ValidationResult = { overrides: [], abstentions: [], invalid: 0 };
	const seen = new Set<string>();
	for (const row of rows) {
		if (typeof row !== 'object' || row === null) {
			result.invalid += 1;
			continue;
		}
		const { src_id: srcId, name, dst_id: dstId } = row as Record<string, unknown>;
		if (typeof srcId !== 'string' || typeof name !== 'string') {
			result.invalid += 1;
			continue;
		}
		const key = decisionKey(srcId, name);
		const ids = candidatesByCaller.get(key);
		if (!ids) {
			result.invalid += 1; // not a question this shard asked
			continue;
		}
		if (seen.has(key)) {
			continue; // first decision wins
		}
		if (dstId === null || dstId === undefined) {
			seen.add(key);
			result.abstentions.push({ src_id: srcId, name, dst_id: null });
			continue;
		}
		if (typeof dstId !== 'string' || !ids.has(dstId)) {
			result.invalid += 1;
			continue;
		}
		seen.add(key);
		result.overrides.push({ src_id: srcId, dst_id: dstId, name, kind: 'invoke' });
	}
	return result;
}

/**
 * The callers of `shard` that `decided` does not cover — the next pass's work.
 *
 * This is why abstentions must be written explicitly: without a row saying "I
 * looked, and the evidence is insufficient", an unanswered caller and a
 * deliberately-abstained one are indistinguishable, and every top-up pass
 * re-asks the same unanswerable references forever.
 */
export function remainder(shard: PendingGroup[], decided: Set<string>): PendingGroup[] {
	const out: PendingGroup[] = [];
	for (const group of shard) {
		const callers = group.callers.filter(
			(c) => !decided.has(decisionKey(c.src_id, group.name)),
		);
		if (callers.length > 0) {
			out.push({ ...group, callers });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// on-disk contract
// ---------------------------------------------------------------------------

export interface ShardManifest {
	epoch: number;
	shards: number;
	createdAt: string;
}

/** Zero-padded so shard files sort the way they were planned. */
export function shardName(index: number, kind: 'shard' | 'out'): string {
	return `${kind}-${String(index + 1).padStart(2, '0')}.jsonl`;
}

/** Writes the manifest and one file per shard; clears any previous attempt. */
export function writeShards(
	workspaceRoot: string,
	epoch: number,
	shards: PendingGroup[][],
): void {
	const dir = enhanceDir(workspaceRoot);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const manifest: ShardManifest = {
		epoch,
		shards: shards.length,
		createdAt: new Date().toISOString(),
	};
	fs.writeFileSync(
		path.join(dir, 'manifest.json'),
		`${JSON.stringify(manifest, null, '\t')}\n`,
		'utf8',
	);
	shards.forEach((groups, i) => {
		const lines = groups
			.map((g) =>
				JSON.stringify({
					name: g.name,
					candidates: g.candidates,
					callers: g.callers,
				}),
			)
			.join('\n');
		fs.writeFileSync(path.join(dir, shardName(i, 'shard')), `${lines}\n`, 'utf8');
	});
}

/** Reads the manifest, or null when absent/unreadable. */
export function readManifest(workspaceRoot: string): ShardManifest | null {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(enhanceDir(workspaceRoot), 'manifest.json'), 'utf8'),
		) as ShardManifest;
		return typeof parsed.epoch === 'number' ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Rows the agent appended for one shard.
 *
 * `expectedEpoch` guards against the store having moved under a long session:
 * an `index update` between planning and merging renumbers chunk ids, so
 * decisions written against the old epoch name symbols that no longer exist.
 * Discarding them costs one re-plan; merging them would write edges pointing
 * at the wrong code.
 */
export function readOutRows(workspaceRoot: string, index: number, expectedEpoch: number): unknown[] {
	const manifest = readManifest(workspaceRoot);
	if (!manifest || manifest.epoch !== expectedEpoch) {
		return [];
	}
	let content: string;
	try {
		content = fs.readFileSync(path.join(enhanceDir(workspaceRoot), shardName(index, 'out')), 'utf8');
	} catch {
		return [];
	}
	return parseJsonlRows(content);
}

/**
 * Rows from JSONL text, tolerating what an agent actually writes: fenced
 * blocks, a leading prose line, or the whole thing as one JSON array. A
 * malformed line is skipped, never fatal — the caller re-queues whatever is
 * missing, so leniency here costs a retry and strictness would cost the shard.
 */
export function parseJsonlRows(content: string): unknown[] {
	const text = content.replace(/```[a-z]*\n?/g, '').trim();
	if (!text) {
		return [];
	}
	if (text.startsWith('[')) {
		try {
			const value = JSON.parse(text);
			return Array.isArray(value) ? value : [];
		} catch {
			// Fall through to line-by-line.
		}
	}
	const rows: unknown[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim().replace(/,$/, '');
		if (!trimmed.startsWith('{')) {
			continue;
		}
		try {
			rows.push(JSON.parse(trimmed));
		} catch {
			// Skip unreadable lines.
		}
	}
	return rows;
}
