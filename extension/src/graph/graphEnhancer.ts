/**
 * Graph-enhancement agents — the loop that makes the context graph BETTER
 * over time instead of merely rebuilt.
 *
 * Two agents, both writing store-side override files the Rust index consumes
 * on its next index/update (the Rust side owns the graph; agents only submit
 * evidence-backed corrections):
 *
 * 1. Edge adjudication: the deterministic resolver refuses to guess when a
 *    referenced name has several definitions, publishing each case to
 *    `pending_edges.jsonl`. The agent resolves them one reference at a time
 *    under a STRICT contract — the answer must be one of the listed candidate
 *    ids or an explicit abstention; a violating reply is fed back verbatim
 *    with the rejection reason and retried; exhaustion abstains, never
 *    guesses. Resolutions land in `edge_overrides.jsonl` and improve PageRank,
 *    graph slices, and blast-radius views on the next update.
 *
 * 2. Tag enrichment: a thumbs-up on an Ask Vinv answer is evidence that the
 *    cited symbols answer questions phrased in the user's vocabulary. The
 *    agent distills that vocabulary into a few alias tags per symbol (again
 *    contract-validated), appending to `tag_overrides.jsonl`; the Rust BM25
 *    build merges them so the same words match lexically next time.
 *
 * The prompts teach HOW to think (evidence hierarchy, when to abstain), not
 * rules to pattern-match — the same agent works on any repository.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { cachedParse } from '../support/parseCache';
import { getBinPath, isBinAvailable } from '../tracelens/bin';
import { ensureEmbedder } from '../engines/install';
import { getIndexEnv, getHarnessId } from '../config/settings';
import { dispatchAgentPrompt } from '../harness/harnessRunner';
import { chatViaHarness, type ChatTurn, type IndexHit } from '../qna/answer';
import { indexStoreDir, loadStoreEpoch } from './indexGraph';
import {
	countCallers,
	decisionKey,
	enhanceDir,
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
} from './enhanceShards';

/** One record from pending_edges.jsonl. */
export interface PendingEdge {
	src_id: string;
	src_file: string;
	src_name: string;
	name: string;
	candidates: Array<{ id: string; file: string; kind: string; summary: string }>;
}

/** Contract-violation retries per reference before abstaining by exhaustion. */
function contractRetries(): number {
	const raw = Number.parseInt(process.env.VINV_ENHANCER_RETRIES ?? '3', 10);
	return Number.isInteger(raw) && raw >= 1 && raw <= 10 ? raw : 3;
}

const ADJUDICATION_SYSTEM = [
	'You resolve ambiguous cross-file code references: a caller uses a name that',
	'several definitions share, and the deterministic resolver refused to guess.',
	'Reason it through before answering, in this order of evidence strength:',
	'1. Import reachability — would the caller plausibly import from the',
	'   candidate file given the ecosystem\u2019s conventions (relative paths,',
	'   package roots, aliasing)? A candidate the caller cannot reach is out.',
	'2. Path proximity and cohesion — code overwhelmingly calls within its own',
	'   module, package, or service before crossing boundaries. A same-directory',
	'   or same-service candidate usually beats a distant twin.',
	'3. Kind agreement — a call expression targets a function/method; extending',
	'   targets a class. A kind mismatch is disqualifying.',
	'4. Summary fit — does the candidate\u2019s described behavior match what the',
	'   caller\u2019s context needs?',
	'Weigh all four; when two candidates remain genuinely indistinguishable',
	'(e.g. copy-pasted twins in parallel frontends), ABSTAIN — a wrong edge',
	'poisons PageRank and blast-radius analysis, while a missing edge merely',
	'stays pending. Reply with JSON only, exactly one of:',
	'{"dst_id": "<one of the candidate ids>"} or',
	'{"dst_id": null, "reason": "<why the evidence is insufficient>"}.',
].join('\n');

/** Parses/validates an adjudication reply. Throws with the rejection reason. */
export function parseAdjudication(
	reply: string,
	candidateIds: Set<string>,
): { dstId: string | null; reason: string } {
	let text = reply.trim();
	if (text.startsWith('```')) {
		text = text.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('reply was not valid JSON');
	}
	if (typeof value !== 'object' || value === null || !('dst_id' in value)) {
		throw new Error('reply must be a JSON object with a "dst_id" key');
	}
	const dst = (value as { dst_id: unknown; reason?: unknown }).dst_id;
	if (dst === null) {
		return { dstId: null, reason: String((value as { reason?: unknown }).reason ?? '') };
	}
	if (typeof dst !== 'string' || !candidateIds.has(dst)) {
		throw new Error(`"dst_id" must be null or one of the candidate ids, got ${JSON.stringify(dst)}`);
	}
	return { dstId: dst, reason: '' };
}

/**
 * Adjudicates one pending reference with the contract-violation retry loop:
 * a rejected reply goes back verbatim with the reason so the retry corrects
 * rather than repeats. Returns null (abstain) on exhaustion.
 */
export async function adjudicateOne(
	record: PendingEdge,
	chat: (messages: ChatTurn[]) => Promise<string>,
): Promise<string | null> {
	const candidateIds = new Set(record.candidates.map((c) => c.id));
	const lines = [
		`Caller: ${record.src_name} in ${record.src_file}`,
		`Referenced name: ${record.name}`,
		'Candidates:',
		...record.candidates.map(
			(c) => `- id=${c.id} file=${c.file} kind=${c.kind} summary=${c.summary}`,
		),
	];
	const messages: ChatTurn[] = [
		{ role: 'system', content: ADJUDICATION_SYSTEM },
		{ role: 'user', content: lines.join('\n') },
	];
	for (let attempt = 0; attempt < contractRetries(); attempt++) {
		let reply: string;
		try {
			reply = await chat(messages);
		} catch {
			// Transport failure: same request again (bounded by the retry budget).
			continue;
		}
		try {
			return parseAdjudication(reply, candidateIds).dstId;
		} catch (e) {
			messages.push({ role: 'assistant', content: reply });
			messages.push({
				role: 'user',
				content:
					`That reply was rejected: ${e instanceof Error ? e.message : String(e)}. ` +
					'Reply again with JSON only, exactly one of {"dst_id": "<candidate id>"} ' +
					'or {"dst_id": null, "reason": "..."}.',
			});
		}
	}
	return null;
}

/** Symbol id → PageRank, for ordering pending edges by caller impact. */
function ranksById(storeDir: string): Map<string, number> {
	return cachedParse(path.join(storeDir, 'chunks.jsonl'), (file) => {
		const ranks = new Map<string, number>();
		try {
			for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
				if (!line.trim()) {
					continue;
				}
				const c = JSON.parse(line) as { id?: string; rank?: number };
				if (c.id) {
					ranks.set(c.id, c.rank ?? 0);
				}
			}
		} catch {
			// No ranks — order stays as published.
		}
		return ranks;
	});
}

/**
 * Reads pending edges, highest-impact callers first (rank from chunks).
 *
 * Both reads are memoized per (file, size, mtime). This is called from the Flow
 * rail's fact collection AND from the compass ladder inside the same recompute,
 * and the rank map alone meant parsing the whole multi-MB chunk store twice per
 * pass. The returned array is freshly built, so callers may reorder or filter it.
 */
export function readPendingEdges(storeDir: string): PendingEdge[] {
	const parsed = cachedParse(path.join(storeDir, 'pending_edges.jsonl'), (file) => {
		let content: string;
		try {
			content = fs.readFileSync(file, 'utf8');
		} catch {
			return [] as PendingEdge[];
		}
		const rows: PendingEdge[] = [];
		for (const line of content.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				const value = JSON.parse(line) as PendingEdge;
				if (value.src_id && value.name && Array.isArray(value.candidates)) {
					rows.push(value);
				}
			} catch {
				// Skip unreadable lines.
			}
		}
		return rows;
	});
	const ranks = ranksById(storeDir);
	// Copy before sorting: the cached array is shared with every other caller.
	return [...parsed].sort((a, b) => (ranks.get(b.src_id) ?? 0) - (ranks.get(a.src_id) ?? 0));
}

/**
 * The key shape readAdjudicated stores and callers probe with. The NUL
 * separator is load-bearing: it cannot occur in an id or a symbol name, so no
 * (src_id, name) pair can collide with another.
 */
export function adjudicatedKey(srcId: string, name: string): string {
	return `${srcId}\u0000${name}`;
}

/**
 * How many pending edges are still unadjudicated — the one definition the Flow
 * rail and the compass ladder share. Both derived it inline before, so a single
 * Flow recompute ran the whole (pending × overrides × chunk-rank) read twice.
 */
export function openPendingEdgeCount(storeDir: string): number {
	const done = readAdjudicated(storeDir);
	return readPendingEdges(storeDir).filter((r) => !done.has(adjudicatedKey(r.src_id, r.name)))
		.length;
}

/** (src_id, name) pairs already adjudicated in edge_overrides.jsonl. */
export function readAdjudicated(storeDir: string): Set<string> {
	return cachedParse(path.join(storeDir, 'edge_overrides.jsonl'), parseAdjudicated);
}

function parseAdjudicated(file: string): Set<string> {
	const done = new Set<string>();
	try {
		for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				const row = JSON.parse(line) as { src_id?: string; name?: string };
				if (row.src_id) {
					done.add(`${row.src_id}\u0000${row.name ?? ''}`);
				}
			} catch {
				// Skip unreadable lines.
			}
		}
	} catch {
		// No overrides yet.
	}
	return done;
}

function appendJsonl(target: string, rows: unknown[]): void {
	if (rows.length === 0) {
		return;
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.appendFileSync(target, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

export interface AdjudicationOutcome {
	pending: number;
	resolved: number;
	abstained: number;
	applied: boolean;
}

/**
 * Adjudicates every not-yet-adjudicated pending edge (highest-rank callers
 * first, so cancellation still banks the most valuable resolutions), appends
 * the resolutions to edge_overrides.jsonl, and applies them with
 * `index update`. Progress-reporting and cancellable.
 */
export async function adjudicatePendingEdges(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	options?: {
		token?: vscode.CancellationToken;
		onProgress?: (done: number, total: number) => void;
		chat?: (messages: ChatTurn[]) => Promise<string>;
		concurrency?: number;
	},
): Promise<AdjudicationOutcome> {
	const storeDir = indexStoreDir(workspaceRoot);
	const done = readAdjudicated(storeDir);
	const queue = readPendingEdges(storeDir).filter(
		(r) => !done.has(`${r.src_id}\u0000${r.name}`),
	);
	const chat = options?.chat ?? chatViaHarness(workspaceRoot);
	let resolved = 0;
	let abstained = 0;
	let completed = 0;
	const overrides: Array<{ src_id: string; dst_id: string; name: string; kind: string }> = [];
	// Bounded worker pool: references are independent, so N in-flight chats cut
	// wall time N-fold; rank ordering still drains high-value callers first.
	const envWorkers = Number.parseInt(process.env.VINV_ENHANCER_CONCURRENCY ?? '', 10);
	const workers = Math.max(
		1,
		Math.min(
			queue.length,
			Number.isInteger(envWorkers) && envWorkers >= 1 && envWorkers <= 16 ? envWorkers : 4,
		),
	);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			if (options?.token?.isCancellationRequested) {
				return;
			}
			const index = cursor++;
			if (index >= queue.length) {
				return;
			}
			const record = queue[index];
			const dstId = await adjudicateOne(record, chat);
			if (dstId) {
				resolved += 1;
				overrides.push({
					src_id: record.src_id,
					dst_id: dstId,
					name: record.name,
					kind: 'invoke',
				});
			} else {
				abstained += 1;
			}
			completed += 1;
			options?.onProgress?.(completed, queue.length);
		}
	};
	await Promise.all(Array.from({ length: workers }, worker));
	appendJsonl(path.join(storeDir, 'edge_overrides.jsonl'), overrides);
	let applied = false;
	if (overrides.length > 0) {
		applied = await runIndexUpdate(context, workspaceRoot);
	}
	return { pending: queue.length, resolved, abstained, applied };
}

// ---------------------------------------------------------------------------
// shard-file adjudication (the default path — see graph/enhanceShards.ts)
// ---------------------------------------------------------------------------

/** Callers per shard. `VINV_ENHANCER_SHARD_ITEMS`, default 100. */
function shardItems(): number {
	const raw = Number.parseInt(process.env.VINV_ENHANCER_SHARD_ITEMS ?? '', 10);
	return Number.isInteger(raw) && raw >= 1 && raw <= 1000 ? raw : 100;
}

/**
 * Ceiling on shards per pass. `VINV_ENHANCER_SHARDS`, default 9.
 *
 * Not a target: the count comes from the queue at `shardItems()` callers each
 * (551 references make six), and this only stops a monorepo planning hundreds.
 * What it excludes is reported as `skipped`, never silently dropped.
 */
function maxShards(): number {
	const raw = Number.parseInt(process.env.VINV_ENHANCER_SHARDS ?? '', 10);
	return Number.isInteger(raw) && raw >= 1 && raw <= 64 ? raw : 9;
}

/**
 * Shard sessions in flight at once. `VINV_ENHANCER_CONCURRENCY`, default 3.
 *
 * Separate from the shard COUNT on purpose: holding sessions at 100 references
 * means more of them, and firing nine agent CLIs simultaneously would put the
 * machine under load the old per-reference path never reached (it capped at 4
 * lightweight one-shot chats). Queueing costs wall-clock, not sessions.
 */
function shardConcurrency(): number {
	const raw = Number.parseInt(process.env.VINV_ENHANCER_CONCURRENCY ?? '', 10);
	return Number.isInteger(raw) && raw >= 1 && raw <= 16 ? raw : 3;
}

/** Runs `task` over `items` with at most `limit` in flight, preserving order. */
async function boundedPool<T, R>(
	items: T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) {
				return;
			}
			results[index] = await task(items[index], index);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return results;
}

/**
 * Extra passes over whatever a session left unanswered.
 * `VINV_ENHANCER_TOPUPS`, default 2 — bounded so a shard that keeps dying
 * cannot spin. What survives all passes stays pending, which the per-epoch
 * record already treats as the terminal "done, N unresolvable" state.
 */
function topUpRounds(): number {
	const raw = Number.parseInt(process.env.VINV_ENHANCER_TOPUPS ?? '', 10);
	return Number.isInteger(raw) && raw >= 0 && raw <= 10 ? raw : 2;
}

/**
 * Wall-clock budget for one shard session. `VINV_ENHANCER_SHARD_TIMEOUT_S`,
 * default 40 minutes — a hundred references, several of which want the caller
 * file opened. The shared 5-minute agent budget would SIGKILL every shard about
 * a fifth of the way through; incremental appends make that survivable rather
 * than fatal, but paying it on every run would burn the top-up budget instead.
 */
function shardTimeoutMs(): number {
	const raw = Number.parseFloat(process.env.VINV_ENHANCER_SHARD_TIMEOUT_S ?? '');
	return (Number.isFinite(raw) && raw > 0 ? raw : 2400) * 1000;
}

/**
 * The shard prompt. Deliberately short: the work is in the file, not here.
 *
 * It asks the agent to OPEN THE CALLER, which the inlined per-reference prompt
 * could never do — rule 1 is import reachability and that prompt shipped no
 * imports, so it demanded a judgement while withholding the evidence for it.
 */
export function buildShardPrompt(shardRel: string, outRel: string, callers: number): string {
	return [
		'You are resolving ambiguous code references in this repository.',
		'',
		`Read \`${shardRel}\`. Each line is one question: a referenced \`name\`, the`,
		'candidate definitions that share it, and the `callers` that reference it.',
		`There are ${callers} callers to decide in total.`,
		'',
		'For each caller, decide which candidate it actually calls. Weigh, in this',
		'order of evidence strength:',
		'1. Import reachability — OPEN THE CALLER FILE and read its imports. Can it',
		'   reach the candidate at all? A candidate it cannot reach is out.',
		'2. Path proximity and cohesion — code calls within its own module,',
		'   package or service before crossing boundaries.',
		'3. Kind agreement — a call targets a function/method; extending targets a',
		'   class. A kind mismatch is disqualifying.',
		'4. Summary fit — does the candidate’s behavior match what the caller needs?',
		'',
		'When two candidates remain genuinely indistinguishable (copy-pasted twins',
		'in parallel services), ABSTAIN. A wrong edge poisons PageRank and',
		'blast-radius analysis; a missing one merely stays pending.',
		'',
		`Append one JSON object per line to \`${outRel}\`, in this exact shape:`,
		'  {"src_id": "<caller src_id>", "name": "<name>", "dst_id": "<candidate id>"}',
		'  {"src_id": "<caller src_id>", "name": "<name>", "dst_id": null}',
		'',
		'Append AFTER EACH DECISION — do not accumulate them and write at the end.',
		'If you stop early, everything already written is kept and only the rest is',
		'asked again. Answer only for callers listed in the shard file, and use only',
		'the candidate ids given for that caller’s line.',
	].join('\n');
}

/** Outcome of a full shard-based adjudication run. */
export interface ShardOutcome extends AdjudicationOutcome {
	/** Shard sessions dispatched (including top-up passes). */
	sessions: number;
	/** Callers past the shard budget — never silently dropped. */
	skipped: number;
}

/**
 * Runs one shard: writes are already on disk, so this dispatches the session
 * and reads back whatever it managed to record. Falls back to parsing the
 * final reply when the out-file is missing or empty — harnesses differ in how
 * reliably they write files, and a session that answered in its reply is not a
 * failed session.
 */
async function runShard(
	workspaceRoot: string,
	index: number,
	shard: PendingGroup[],
	epoch: number,
	dispatch: ShardDispatch,
): Promise<unknown[]> {
	const shardRel = `.vinv/index/enhance/${shardName(index, 'shard')}`;
	const outRel = `.vinv/index/enhance/${shardName(index, 'out')}`;
	const prompt = buildShardPrompt(shardRel, outRel, countCallers(shard));
	const reply = await dispatch(index, prompt, shard);
	const rows = readOutRows(workspaceRoot, index, epoch);
	if (rows.length > 0) {
		return rows;
	}
	return reply ? parseJsonlRows(reply) : [];
}

/**
 * How a shard reaches an agent. Injected so the whole plan → dispatch → merge
 * → resume loop can be exercised against a stub that writes out-files, with no
 * CLI process and no tokens spent — the parts worth testing are the sharding
 * and the merge, not the agent.
 */
export type ShardDispatch = (
	index: number,
	prompt: string,
	shard: PendingGroup[],
) => Promise<string | null>;

/** The real one: a headless, MCP-bypassed session per shard. */
export function harnessShardDispatch(
	workspaceRoot: string,
	onUpdate?: (line: string) => void,
): ShardDispatch {
	return (index, prompt) =>
		dispatchAgentPrompt(
			getHarnessId(),
			workspaceRoot,
			`enhance-shard-${index + 1}`,
			prompt,
			undefined,
			onUpdate,
			shardTimeoutMs(),
		);
}

/**
 * Adjudicates the pending queue through shard files instead of one CLI process
 * per reference. Returns the same shape as `adjudicatePendingEdges` plus how
 * many sessions it actually cost and what the budget left behind.
 */
export async function adjudicateViaShards(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	options?: {
		token?: vscode.CancellationToken;
		onProgress?: (done: number, total: number) => void;
		/** Stub the agent (tests); defaults to a real harness session. */
		dispatch?: ShardDispatch;
		/** Skip the `index update` (tests) — nothing to apply without an index. */
		apply?: boolean;
	},
): Promise<ShardOutcome> {
	const storeDir = indexStoreDir(workspaceRoot);
	const done = readAdjudicated(storeDir);
	const records = readPendingEdges(storeDir).filter(
		(r) => !done.has(`${r.src_id}\u0000${r.name}`),
	);
	const empty: ShardOutcome = {
		pending: 0,
		resolved: 0,
		abstained: 0,
		applied: false,
		sessions: 0,
		skipped: 0,
	};
	if (records.length === 0) {
		return empty;
	}

	let epoch: number;
	try {
		epoch = loadStoreEpoch(storeDir);
	} catch {
		return empty;
	}

	const ranks = readRanks(storeDir);
	const ordered = orderGroups(groupPending(records, ranks), ranks !== null);
	const dispatch = options?.dispatch ?? harnessShardDispatch(workspaceRoot);
	const plan = planShards(ordered, {
		itemsPerShard: shardItems(),
		maxShards: maxShards(),
	});
	const total = countCallers(plan.shards.flat());

	const overrides: Array<{ src_id: string; dst_id: string; name: string; kind: string }> = [];
	const abstentions: Array<{ src_id: string; name: string; dst_id: null }> = [];
	const decided = new Set<string>();
	let sessions = 0;

	let round = plan.shards;
	for (let pass = 0; pass <= topUpRounds(); pass++) {
		if (round.length === 0 || options?.token?.isCancellationRequested) {
			break;
		}
		// Each pass republishes the work: writeShards clears the directory, so a
		// previous pass's out-file can never be re-read as this pass's answers.
		writeShards(workspaceRoot, epoch, round);
		const results = await boundedPool(round, shardConcurrency(), (shard, i) => {
			sessions += 1;
			return runShard(workspaceRoot, i, shard, epoch, dispatch);
		});

		round.forEach((shard, i) => {
			const outcome = validateOut(shard, results[i]);
			for (const row of outcome.overrides) {
				if (!decided.has(decisionKey(row.src_id, row.name))) {
					decided.add(decisionKey(row.src_id, row.name));
					overrides.push(row);
				}
			}
			for (const row of outcome.abstentions) {
				if (!decided.has(decisionKey(row.src_id, row.name))) {
					decided.add(decisionKey(row.src_id, row.name));
					abstentions.push(row);
				}
			}
		});
		options?.onProgress?.(decided.size, total);
		round = round
			.map((shard) => remainder(shard, decided))
			.filter((shard) => shard.length > 0);
	}

	// Abstentions are persisted alongside resolutions. The Rust loader skips a
	// null `dst_id` (no edge), while `readAdjudicated` keys on src_id+name and
	// so stops re-asking it — "I looked, and the evidence is insufficient" is a
	// decision, and without recording it every later pass re-asks it forever.
	appendJsonl(path.join(storeDir, 'edge_overrides.jsonl'), [...overrides, ...abstentions]);
	let applied = false;
	if (overrides.length > 0 && options?.apply !== false) {
		applied = await runIndexUpdate(context, workspaceRoot);
	}
	// The work is banked; the scratch directory is not worth keeping.
	try {
		fs.rmSync(enhanceDir(workspaceRoot), { recursive: true, force: true });
	} catch {
		// Best-effort: a leftover directory is rewritten by the next run.
	}
	return {
		pending: total,
		resolved: overrides.length,
		abstained: abstentions.length,
		applied,
		sessions,
		skipped: plan.skipped,
	};
}

const TAG_SYSTEM = [
	'You distill retrieval-feedback vocabulary into searchable aliases. A user',
	'asked a question, the listed code symbols answered it well (the user',
	'confirmed), and lexical search should find these symbols next time the same',
	'vocabulary is used. For each symbol, propose the few words or short phrases',
	'from the QUESTION\u2019s vocabulary that (a) a developer would plausibly search',
	'for again, (b) genuinely describe what the symbol does, and (c) do not',
	'already appear in the symbol\u2019s name or summary — aliases bridge vocabulary',
	'gaps; repeating existing words only inflates term counts. Skip symbols that',
	'were merely nearby context rather than the actual answer. Reply with JSON',
	'only: {"tags": {"<symbol id>": ["alias", ...], ...}} — ids must come from',
	'the provided list; an empty object is a valid "nothing to add".',
].join('\n');

/** Parses/validates a tag-enrichment reply against the offered symbol ids. */
export function parseTagReply(
	reply: string,
	validIds: Set<string>,
): Map<string, string[]> {
	let text = reply.trim();
	if (text.startsWith('```')) {
		text = text.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('reply was not valid JSON');
	}
	const tags = (value as { tags?: unknown }).tags;
	if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
		throw new Error('reply must be {"tags": {"<id>": ["alias", ...]}}');
	}
	const out = new Map<string, string[]>();
	for (const [id, list] of Object.entries(tags as Record<string, unknown>)) {
		if (!validIds.has(id)) {
			throw new Error(`unknown symbol id ${JSON.stringify(id)} — ids must come from the list`);
		}
		if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) {
			throw new Error(`tags for ${id} must be an array of strings`);
		}
		const cleaned = list.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1);
		if (cleaned.length > 0) {
			out.set(id, [...new Set(cleaned)]);
		}
	}
	return out;
}

/**
 * Distills a confirmed-good QnA exchange into alias tags for the cited
 * symbols and appends them to tag_overrides.jsonl (merged with any existing
 * tags for the same id — enrichment accumulates, never clobbers). The store
 * picks them up on the next index/update.
 */
export async function enrichTagsFromFeedback(
	workspaceRoot: string,
	question: string,
	hits: IndexHit[],
	chat?: (messages: ChatTurn[]) => Promise<string>,
): Promise<number> {
	if (hits.length === 0) {
		return 0;
	}
	const doChat = chat ?? chatViaHarness(workspaceRoot);
	const storeDir = indexStoreDir(workspaceRoot);
	const idFor = (h: IndexHit): string => `${h.file}:${h.lines[0]}-${h.lines[1]}:${h.name}`;
	const validIds = new Set(hits.map(idFor));
	const lines = [
		`Question the user asked (and confirmed the answer was good): ${question}`,
		'Symbols that produced the answer:',
		...hits.map((h) => `- id=${idFor(h)} kind=${h.kind} summary=${h.summary}`),
	];
	const messages: ChatTurn[] = [
		{ role: 'system', content: TAG_SYSTEM },
		{ role: 'user', content: lines.join('\n') },
	];
	let parsed: Map<string, string[]> | null = null;
	for (let attempt = 0; attempt < contractRetries(); attempt++) {
		let reply: string;
		try {
			reply = await doChat(messages);
		} catch {
			continue;
		}
		try {
			parsed = parseTagReply(reply, validIds);
			break;
		} catch (e) {
			messages.push({ role: 'assistant', content: reply });
			messages.push({
				role: 'user',
				content:
					`That reply was rejected: ${e instanceof Error ? e.message : String(e)}. ` +
					'Reply again with JSON only: {"tags": {"<symbol id>": ["alias", ...]}}.',
			});
		}
	}
	if (!parsed || parsed.size === 0) {
		return 0;
	}
	// Merge with existing tags per id (append-friendly file: last line wins on
	// the Rust side, so we write the merged set).
	const target = path.join(storeDir, 'tag_overrides.jsonl');
	const existing = new Map<string, string[]>();
	try {
		for (const line of fs.readFileSync(target, 'utf8').split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				const row = JSON.parse(line) as { id?: string; tags?: string[] };
				if (row.id && Array.isArray(row.tags)) {
					existing.set(row.id, row.tags);
				}
			} catch {
				// Skip unreadable lines.
			}
		}
	} catch {
		// No overrides yet.
	}
	const rows: Array<{ id: string; tags: string[] }> = [];
	for (const [id, tags] of parsed) {
		const merged = [...new Set([...(existing.get(id) ?? []), ...tags])];
		rows.push({ id, tags: merged });
	}
	appendJsonl(target, rows);
	return rows.length;
}

/** Applies store-side overrides by running `index update` (incremental). */
export async function runIndexUpdate(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<boolean> {
	if (!isBinAvailable(context, 'index')) {
		return false;
	}
	const binPath = getBinPath(context, 'index');
	const storeDir = indexStoreDir(workspaceRoot);
	// Updates re-embed changed chunks through the local sidecar.
	await ensureEmbedder(context);
	return new Promise((resolve) => {
		execFile(
			binPath,
			['update', workspaceRoot, '--store-dir', storeDir],
			{ maxBuffer: 32 * 1024 * 1024, env: getIndexEnv(path.dirname(binPath)) },
			(error) => resolve(!error),
		);
	});
}

// The old offerAdjudication nag ("N references are ambiguous — Resolve
// Now?") is gone: enhancement now runs automatically, once per index epoch,
// through src/index/enhanceRunner.ts, which records {epoch, resolved,
// remaining} in .vinv/index/enhance_state.json and never re-offers a handled
// epoch.
