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
import { getBinPath, isBinAvailable } from '../tracelens/bin';
import { ensureEmbedder } from '../engines/install';
import { getIndexEnv } from '../config/settings';
import { chatViaHarness, type ChatTurn, type IndexHit } from '../qna/answer';
import { indexStoreDir } from './indexGraph';

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

/** Reads pending edges, highest-impact callers first (rank from chunks). */
export function readPendingEdges(storeDir: string): PendingEdge[] {
	let content: string;
	try {
		content = fs.readFileSync(path.join(storeDir, 'pending_edges.jsonl'), 'utf8');
	} catch {
		return [];
	}
	const rankById = new Map<string, number>();
	try {
		for (const line of fs.readFileSync(path.join(storeDir, 'chunks.jsonl'), 'utf8').split('\n')) {
			if (!line.trim()) {
				continue;
			}
			const c = JSON.parse(line) as { id?: string; rank?: number };
			if (c.id) {
				rankById.set(c.id, c.rank ?? 0);
			}
		}
	} catch {
		// No ranks — order stays as published.
	}
	const records: PendingEdge[] = [];
	for (const line of content.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const value = JSON.parse(line) as PendingEdge;
			if (value.src_id && value.name && Array.isArray(value.candidates)) {
				records.push(value);
			}
		} catch {
			// Skip unreadable lines.
		}
	}
	records.sort((a, b) => (rankById.get(b.src_id) ?? 0) - (rankById.get(a.src_id) ?? 0));
	return records;
}

/** (src_id, name) pairs already adjudicated in edge_overrides.jsonl. */
export function readAdjudicated(storeDir: string): Set<string> {
	const done = new Set<string>();
	try {
		for (
			const line of fs
				.readFileSync(path.join(storeDir, 'edge_overrides.jsonl'), 'utf8')
				.split('\n')
		) {
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
