/**
 * The opportunity board — a shared blackboard of optimization opportunities
 * (.vinv/reports/opportunities.jsonl) that replaces point-to-point dispatch
 * bookkeeping. Producers (the hotspot/cache sweeps, the panel dispatch, the
 * capture watcher, the MCP surface) POST candidates here; dispatch CONSUMES
 * the board: only an entry in status 'posted' is dispatchable, and an id that
 * is 'dispatched' or 'resolved' is never re-dispatched until it expires. The
 * file is the cross-restart, cross-process dedup memory the in-memory
 * signature keys could never be.
 *
 * Mechanics, in doctrine terms:
 *   • ONE detection mechanism — every candidate on the board comes from
 *     computeOptimizationCandidates (the waste-prior ranker); the board never
 *     invents its own ranking.
 *   • Content-signature identity — id = hash(kind, file, name, evidence-CLASS)
 *     where the evidence class strips volatile numbers, so "the same waste,
 *     re-measured" maps to the same entry while a genuinely different waste
 *     signal opens a new one. Row indices and millisecond figures never enter
 *     the id: they drift between traces and reindexes.
 *   • Append-only with newest-status-wins — every state change appends a full
 *     line; load() keeps the newest line per id, so a torn tail or a lost
 *     append degrades to a slightly stale status, never a corrupt board.
 *   • Explicit relative expiry — an entry whose signature has been ABSENT
 *     from fresh evidence for EXPIRY_MISSING_SESSIONS consecutive new capture
 *     sessions expires. That is the same "3 points make a trend" statistical
 *     floor collectMemoryTrends uses, defined against the app's own capture
 *     cadence — no wall-clock TTL.
 *   • Bounded growth — when the file holds more than COMPACTION_FACTOR lines
 *     per retained entry, it is rewritten to one line per id, dropping
 *     terminal entries (expired/evicted/exhausted) whose lifecycle ended
 *     EXPIRY_MISSING_SESSIONS fresh capture sessions ago; the live 'posted'
 *     surface itself is bounded at LIVE_POSTED_CAP (the analyzer's own cap ×
 *     LIVE_POSTED_FACTOR) by evicting the lowest-predicted entries.
 *   • Complete lifecycle — dispatches that hang (no ledger activity) or
 *     resolve regressed re-open under one shared retry budget
 *     (board.max_retries), then park loudly as 'exhausted'.
 *
 * The module is vscode-free so the MCP server (a separate bundled process)
 * walks the very same board the editor sweeps use.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
	findTraceFiles,
	hasIndexStore,
	indexStoreDir,
	loadEdges,
	loadNodes,
	type GraphNode,
} from '../graph/indexGraph';
import {
	collectCacheCandidates,
	collectRequestSpans,
	collectSymbolTimings,
} from './runtimeAnalysis';
import {
	computeOptimizationCandidates,
	loadOptimizationCalibration,
	type OptimizationCandidate,
} from './optimizationAnalysis';

/**
 * The complete lifecycle:
 *
 *   posted ──dispatch──▶ dispatched ──outcome──▶ resolved (verdict kept)
 *     │                     │  │
 *     │                     │  └─ episode went quiet (hang) ─▶ posted (retry)
 *     │                     └─ regressed/reverted verdict ────▶ posted (retry)
 *     │                          …until the retry budget, then ▶ exhausted
 *     ├─ outranked when the live surface overflows ──────────▶ evicted
 *     └─ absent from fresh evidence for N sessions ──────────▶ expired
 *        (resolved follows the same evidence expiry — a fix that removed the
 *         waste sees its signature vanish, and the entry closes as expired)
 *
 * 'expired', 'evicted', and 'exhausted' are TERMINAL: they hold their id
 * against silent re-posting while they live, then compaction drops them after
 * EXPIRY_MISSING_SESSIONS further fresh capture sessions — bounded memory
 * measured in the app's own sessions, never a wall clock.
 */
export type OpportunityStatus =
	| 'posted'
	| 'dispatched'
	| 'resolved'
	| 'expired'
	| 'evicted'
	| 'exhausted';

/** Terminal statuses: never re-dispatched; aged by session and eventually dropped. */
const TERMINAL_STATUSES: ReadonlySet<OpportunityStatus> = new Set([
	'expired',
	'evicted',
	'exhausted',
]);

/**
 * One board line (contract shape). misses/last_session are the ONE
 * session-relative sighting mechanism, whose "sighting" depends on status:
 * for 'posted'/'resolved' a sighting is the signature appearing in fresh
 * evidence (absence expiry); for 'dispatched' a sighting is ledger activity
 * from its episode (hang detection); for terminal entries the counter just
 * ages once per new session (compaction drop).
 */
export interface OpportunityEntry {
	/** Content signature (see opportunitySignature) — the dedup identity. */
	id: string;
	/** The waste signal that produced the candidate (waste_kind, or 'latency-symbol'). */
	kind: string;
	/** Graph row at post time — advisory (rows drift across reindexes; id does not). */
	row: number;
	name: string;
	file: string;
	line: number;
	predicted_ms: number;
	/** Human-readable evidence behind the prediction. */
	evidence: string;
	/** Which surface posted it: hotspot-sweep | cache-sweep | panel | capture-watch | mcp. */
	source: string;
	status: OpportunityStatus;
	/** Unix seconds. */
	posted_at: number;
	/** Unix seconds of the newest status change. */
	updated_at: number;
	/** Verdict text once resolved/expired. */
	resolution?: string;
	/** Session-relative sighting counter (see the interface doc for its
	 * per-status meaning). */
	misses?: number;
	/** The capture-session key the miss counter last advanced on. */
	last_session?: string;
	/** Automatic re-opens consumed (hang retries + regressed retries share it). */
	retry_count?: number;
	/** Unix seconds of the newest dispatch — stable while hang bookkeeping
	 * advances updated_at, so outcome/activity postdating stays correct. */
	dispatched_at?: number;
	/** The verdict engine's episode id recorded at dispatch — hang detection
	 * counts only THIS episode's ledger activity, not the whole workspace's. */
	episode_id?: string;
	/** Plain-language lifecycle note (why re-opened, why parked, why evicted). */
	note?: string;
}

/** What a producer posts (identity + status are derived here). */
export interface OpportunityInput {
	kind: string;
	row: number;
	name: string;
	file: string;
	line: number;
	predicted_ms: number;
	evidence: string;
	source: string;
}

/**
 * One episode-ledger line, untyped: the resolution pass only consumes
 * `optimization_outcome` events (contract shape: at/episode_id/row/waste_kind/
 * predicted_ms/delta_ms/verdict/attempt) and parses their fields defensively —
 * ledger lines are cross-process JSON, never trusted shapes.
 */
export type LedgerEvent = { type?: string } & Record<string, unknown>;

/**
 * Consecutive NEW capture sessions a signature must be absent from before its
 * entry expires. 3 is the statistical floor for calling an absence a trend
 * rather than one noisy run (the same floor collectMemoryTrends uses for the
 * opposite claim) — it is a count of the app's own capture sessions, never a
 * wall-clock TTL.
 */
export const EXPIRY_MISSING_SESSIONS = 3;

/**
 * Compaction trigger, relative to the board's own live population: more than
 * this many file lines per live (non-expired) entry means the append log is
 * mostly churn, and it is rewritten to one line per id.
 */
export const COMPACTION_FACTOR = 4;

/**
 * The dispatch-attempt budget per opportunity — the policy default for the
 * `board.max_retries` key in .vinv/exercise/policy.json (the same flat-key
 * policy file the verdict engine's learned min-effect lives in). Despite the
 * key's name it counts TOTAL dispatch attempts, first try included: the
 * default 2 means the original attempt plus ONE automatic re-open (after a
 * hung dispatch or a regressed/reverted verdict), after which the entry parks
 * as terminal 'exhausted' — loud in the render, never silently re-dispatched.
 */
export const DEFAULT_BOARD_MAX_RETRIES = 2;

/** The effective attempt budget: policy `board.max_retries`, else the default. */
export function boardMaxRetries(workspaceRoot: string): number {
	try {
		const raw = fs.readFileSync(
			path.join(workspaceRoot, '.vinv', 'exercise', 'policy.json'),
			'utf8',
		);
		const policy = JSON.parse(raw) as Record<string, unknown>;
		const value = policy['board.max_retries'];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
			return Math.floor(value);
		}
	} catch {
		// No policy yet — the documented default applies.
	}
	return DEFAULT_BOARD_MAX_RETRIES;
}

/**
 * The list-length budget the board's analyzer feed requests from
 * computeOptimizationCandidates (the same budget the panel path runs with).
 * Passing it explicitly makes it THE cap by construction — the eviction bound
 * below derives from it instead of a second free-floating count.
 */
export const OPPORTUNITY_ANALYZER_CAP = 12;

/**
 * Live-'posted' bound = the analyzer's own cap × this factor: room for one
 * full turnover of the ranked head (the previous evidence's survivors plus the
 * current head) before the board sheds its tail. Overflow evicts the
 * lowest-predicted entries first — 'evicted' is terminal and distinct from
 * 'expired' (outranked, not vanished-from-evidence).
 */
export const LIVE_POSTED_FACTOR = 2;

/** The derived cap on live 'posted' entries (see LIVE_POSTED_FACTOR). */
export const LIVE_POSTED_CAP = OPPORTUNITY_ANALYZER_CAP * LIVE_POSTED_FACTOR;

export function opportunityBoardPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'opportunities.jsonl');
}

/**
 * The content signature: kind + file + name + the evidence CLASS (evidence
 * with every number normalized away). Volatile measurements — call counts,
 * milliseconds, shares — must not change identity, or every re-trace would
 * mint a "new" opportunity and the dedup would be a no-op.
 */
export function opportunitySignature(
	kind: string,
	file: string,
	name: string,
	evidence: string,
): string {
	const evidenceClass = evidence.replace(/\d+(?:\.\d+)?/g, '#');
	return crypto
		.createHash('sha256')
		.update(`${kind}\u0000${file}\u0000${name}\u0000${evidenceClass}`)
		.digest('hex')
		.slice(0, 16);
}

interface BoardFile {
	/** Newest-status-wins view, keyed by id. */
	entries: Map<string, OpportunityEntry>;
	/** Raw line count, for the compaction trigger. */
	lineCount: number;
}

function readBoardFile(workspaceRoot: string): BoardFile {
	const entries = new Map<string, OpportunityEntry>();
	let lineCount = 0;
	let raw: string;
	try {
		raw = fs.readFileSync(opportunityBoardPath(workspaceRoot), 'utf8');
	} catch {
		return { entries, lineCount };
	}
	for (const line of raw.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		lineCount += 1;
		let parsed: OpportunityEntry;
		try {
			parsed = JSON.parse(line) as OpportunityEntry;
		} catch {
			continue; // torn tail line — the previous status for this id still holds
		}
		if (!parsed || typeof parsed.id !== 'string' || !parsed.status) {
			continue;
		}
		const prev = entries.get(parsed.id);
		// Later lines are newer appends; updated_at breaks ties across writers.
		if (!prev || (parsed.updated_at ?? 0) >= (prev.updated_at ?? 0)) {
			entries.set(parsed.id, parsed);
		}
	}
	return { entries, lineCount };
}

function appendEntries(workspaceRoot: string, entries: OpportunityEntry[]): void {
	if (entries.length === 0) {
		return;
	}
	const file = opportunityBoardPath(workspaceRoot);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
}

/**
 * A terminal entry is DROPPED once its explicit lifecycle end is
 * EXPIRY_MISSING_SESSIONS fresh capture sessions old — the reconcile pass ages
 * every terminal entry's miss counter once per new session, so this is
 * session-relative, never a wall clock. 'expired' entries always enter their
 * terminal state with misses exactly at the expiry threshold (the counter
 * advances one per session and the transition fires at the floor), so their
 * baseline is that threshold; evicted/exhausted enter with misses reset to 0.
 */
function terminalDropReady(entry: OpportunityEntry): boolean {
	if (!TERMINAL_STATUSES.has(entry.status)) {
		return false;
	}
	const baseline = entry.status === 'expired' ? EXPIRY_MISSING_SESSIONS : 0;
	return (entry.misses ?? 0) - baseline >= EXPIRY_MISSING_SESSIONS;
}

/**
 * Rewrites the board to one line per id — dropping terminal entries whose
 * lifecycle end is EXPIRY_MISSING_SESSIONS fresh sessions old, exactly what
 * licenses forgetting them — when the append log exceeds COMPACTION_FACTOR
 * lines per retained entry. tmp+rename keeps readers from ever seeing a torn
 * file.
 */
function maybeCompact(workspaceRoot: string, board: BoardFile): void {
	const retained = [...board.entries.values()].filter((e) => !terminalDropReady(e));
	if (board.lineCount <= COMPACTION_FACTOR * Math.max(1, retained.length)) {
		return;
	}
	if (board.lineCount <= board.entries.size) {
		return; // nothing to squeeze — every line is already a distinct id
	}
	const file = opportunityBoardPath(workspaceRoot);
	const tmp = `${file}.tmp-${process.pid}`;
	const ordered = retained.sort((a, b) => a.posted_at - b.posted_at);
	fs.writeFileSync(tmp, ordered.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
	fs.renameSync(tmp, file);
	board.entries = new Map(ordered.map((e) => [e.id, e]));
	board.lineCount = ordered.length;
}

/** The full board, newest-status-wins, ordered by posted_at. */
export function loadOpportunityBoard(workspaceRoot: string): OpportunityEntry[] {
	return [...readBoardFile(workspaceRoot).entries.values()].sort(
		(a, b) => a.posted_at - b.posted_at,
	);
}

/**
 * Posts candidates: an id already on the board in ANY status but 'expired' is
 * left untouched — dispatched/resolved never silently re-open, and evicted/
 * exhausted stay parked until compaction forgets them — while an unknown or
 * expired id gets a fresh 'posted' line. When the live 'posted' surface then
 * exceeds LIVE_POSTED_CAP (the analyzer's own cap × LIVE_POSTED_FACTOR), the
 * lowest-predicted posted entries are EVICTED — terminal, so the same
 * outranked signature does not churn back next sync. Returns the board's
 * current entry for every input id, so the caller can partition its candidates
 * into dispatchable vs held.
 */
export function postOpportunities(
	workspaceRoot: string,
	inputs: OpportunityInput[],
): Map<string, OpportunityEntry> {
	const board = readBoardFile(workspaceRoot);
	const now = Math.floor(Date.now() / 1000);
	const changed: OpportunityEntry[] = [];
	const out = new Map<string, OpportunityEntry>();
	for (const input of inputs) {
		const id = opportunitySignature(input.kind, input.file, input.name, input.evidence);
		if (out.has(id)) {
			continue; // duplicate signature within one post batch
		}
		const existing = board.entries.get(id);
		if (existing && existing.status !== 'expired') {
			out.set(id, existing);
			continue;
		}
		const entry: OpportunityEntry = {
			id,
			kind: input.kind,
			row: input.row,
			name: input.name,
			file: input.file,
			line: input.line,
			predicted_ms: input.predicted_ms,
			evidence: input.evidence,
			source: input.source,
			status: 'posted',
			posted_at: now,
			updated_at: now,
			misses: 0,
		};
		changed.push(entry);
		board.entries.set(id, entry);
		out.set(id, entry);
	}
	// EVICTION: bound the live 'posted' surface relative to the evidence feed.
	const posted = [...board.entries.values()].filter((e) => e.status === 'posted');
	if (posted.length > LIVE_POSTED_CAP) {
		// Rank each entry WITHIN its own unit (ms vs bytes) before evicting: a
		// memory opportunity's predicted_ms holds bytes, so a raw compare would
		// evict every latency opportunity and keep the byte counts. Evict the
		// least-important within each unit first (highest within-unit rank).
		const unitOfKind = (kind: string): 'ms' | 'bytes' =>
			kind === 'alloc-churn' || kind === 'mem-leak' ? 'bytes' : 'ms';
		const byUnit = new Map<string, OpportunityEntry[]>();
		for (const e of posted) {
			const u = unitOfKind(e.kind);
			(byUnit.get(u) ?? byUnit.set(u, []).get(u)!).push(e);
		}
		const rankWithinUnit = new Map<OpportunityEntry, number>();
		for (const arr of byUnit.values()) {
			arr.sort((a, b) => b.predicted_ms - a.predicted_ms);
			arr.forEach((e, i) => rankWithinUnit.set(e, i));
		}
		const overflow = posted
			.sort((a, b) => (rankWithinUnit.get(b) ?? 0) - (rankWithinUnit.get(a) ?? 0))
			.slice(0, posted.length - LIVE_POSTED_CAP);
		for (const victim of overflow) {
			const evicted = transition(board, victim, {
				status: 'evicted',
				misses: 0,
				note:
					`outranked — the board already holds ${LIVE_POSTED_CAP} open opportunities ` +
					'with more predicted recoverable time',
			});
			changed.push(evicted);
			if (out.has(evicted.id)) {
				out.set(evicted.id, evicted);
			}
		}
	}
	appendEntries(workspaceRoot, changed);
	board.lineCount += changed.length;
	maybeCompact(workspaceRoot, board);
	return out;
}

function transition(
	board: BoardFile,
	entry: OpportunityEntry,
	patch: Partial<OpportunityEntry>,
): OpportunityEntry {
	const next: OpportunityEntry = {
		...entry,
		...patch,
		updated_at: Math.floor(Date.now() / 1000),
	};
	board.entries.set(next.id, next);
	return next;
}

/**
 * Marks 'posted' entries dispatched. Idempotent: any other status is skipped.
 * Records dispatched_at (the hang detector's and the outcome postdate check's
 * anchor — updated_at keeps moving as bookkeeping advances) and resets the
 * sighting counter so hang detection starts fresh for this attempt.
 */
export function markOpportunitiesDispatched(
	workspaceRoot: string,
	ids: string[],
	episodeId?: string,
): void {
	const board = readBoardFile(workspaceRoot);
	const changed: OpportunityEntry[] = [];
	const now = Math.floor(Date.now() / 1000);
	for (const id of ids) {
		const entry = board.entries.get(id);
		if (entry && entry.status === 'posted') {
			changed.push(
				transition(board, entry, {
					status: 'dispatched',
					dispatched_at: now,
					misses: 0,
					...(episodeId ? { episode_id: episodeId } : {}),
				}),
			);
		}
	}
	appendEntries(workspaceRoot, changed);
	board.lineCount += changed.length;
	maybeCompact(workspaceRoot, board);
}

/** Everything a reconcile pass consumed and did, for loud logging by callers. */
export interface BoardReconcileResult {
	resolved: number;
	expired: number;
	/** Entries automatically re-opened for another attempt (hang or regression). */
	reopened: number;
	/** Entries parked terminal after exhausting the attempt budget. */
	exhausted: number;
}

/** Unix seconds of a ledger event: `at` (contract) or parsed `ts` (ISO). */
function eventUnixTime(ev: LedgerEvent): number | undefined {
	if (typeof ev.at === 'number' && Number.isFinite(ev.at)) {
		return ev.at;
	}
	if (typeof ev.ts === 'string') {
		const parsed = Date.parse(ev.ts);
		if (Number.isFinite(parsed)) {
			return parsed / 1000;
		}
	}
	return undefined;
}

/**
 * Whether the episode ledger shows ANY activity postdating a dispatch —
 * an episode_end or optimization_outcome at/after dispatched_at (1s slop for
 * same-second clocks). A timestamp-less line counts as activity: an unknown
 * clock must never convict a dispatch of hanging.
 */
function ledgerActiveSince(
	events: ReadonlyArray<LedgerEvent>,
	since: number,
	episodeId?: string,
): boolean {
	return events.some((ev) => {
		if (ev.type !== 'episode_end' && ev.type !== 'optimization_outcome') {
			return false;
		}
		// When the dispatch recorded its episode id, only THAT episode's events
		// count — otherwise any concurrent episode in the workspace resets the
		// hang counter forever and a genuinely dead dispatch never re-opens.
		if (episodeId) {
			const eid = typeof ev.episode_id === 'string' ? ev.episode_id : undefined;
			const bid = typeof ev.bridge_episode_id === 'string' ? ev.bridge_episode_id : undefined;
			if (eid !== episodeId && bid !== episodeId) {
				return false;
			}
		}
		const at = eventUnixTime(ev);
		return at === undefined || at + 1 >= since;
	});
}

/**
 * The board's evidence reconcile — called wherever fresh evidence already
 * flows (the capture watcher, the sweeps, the MCP surface). Two passes:
 *
 * 1. RESOLUTION: an `optimization_outcome` event from the episode ledger
 *    (contract C1) whose row matches a 'dispatched' entry — and which
 *    postdates that dispatch — resolves it, with the verdict as resolution.
 *    When several dispatched entries share a row, the event's waste_kind picks
 *    the one it judged. A 'regressed'/'reverted-behavior' verdict does NOT
 *    park the entry as resolved: the failed optimization automatically
 *    re-opens for ONE materially different attempt (the attempt store seeds
 *    the learning) — sharing the same attempt budget as hang retrial — and
 *    only exhausts once that budget is spent.
 * 2. SESSION BOOKKEEPING, once per NEW `sessionKey` (the newest capture
 *    session), through the ONE sighting mechanism (misses/last_session):
 *    • 'posted'/'resolved' — evidence expiry: absent from `freshIds` (the
 *      signatures the ranker currently derives) advances the counter;
 *      EXPIRY_MISSING_SESSIONS consecutive misses expire the entry; presence
 *      resets it. Pass `freshIds: null` when the evidence could not be
 *      computed (store unreadable) — unknown is not absent, nothing advances.
 *    • 'dispatched' — HANG DETECTION: a dispatch whose episode produced no
 *      ledger activity at all (no episode_end, no optimization_outcome since
 *      dispatched_at) advances the counter instead; after
 *      EXPIRY_MISSING_SESSIONS quiet sessions the dispatch is presumed hung
 *      (harness died, run lost) and re-opens for retry — or parks 'exhausted'
 *      when the attempt budget (boardMaxRetries) is spent.
 *    • terminal ('expired'/'evicted'/'exhausted') — the counter just ages, so
 *      compaction can drop the entry EXPIRY_MISSING_SESSIONS sessions after
 *      its lifecycle ended.
 */
export function reconcileOpportunityBoard(
	workspaceRoot: string,
	events: ReadonlyArray<LedgerEvent>,
	freshIds: ReadonlySet<string> | null,
	sessionKey: string,
): BoardReconcileResult {
	const board = readBoardFile(workspaceRoot);
	const changed: OpportunityEntry[] = [];
	const maxAttempts = boardMaxRetries(workspaceRoot);
	let resolved = 0;
	let expired = 0;
	let reopened = 0;
	let exhausted = 0;

	/**
	 * The ONE retry mechanism (hang and regression share it): re-open for
	 * another attempt while the budget allows, else park terminal 'exhausted'.
	 */
	const reopenOrExhaust = (
		entry: OpportunityEntry,
		why: string,
		resolution?: string,
	): void => {
		const attempts = (entry.retry_count ?? 0) + 1; // dispatches consumed so far
		const sessionPatch = sessionKey ? { last_session: sessionKey } : {};
		if (attempts < maxAttempts) {
			changed.push(
				transition(board, entry, {
					status: 'posted',
					retry_count: attempts,
					misses: 0,
					note: `${why} — queued for attempt ${attempts + 1} of ${maxAttempts}`,
					...(resolution ? { resolution } : {}),
					...sessionPatch,
				}),
			);
			reopened += 1;
		} else {
			changed.push(
				transition(board, entry, {
					status: 'exhausted',
					misses: 0,
					note: `${why} — tried ${attempts === 2 ? 'twice' : `${attempts} time(s)`}, no verified win — parked`,
					...(resolution ? { resolution } : {}),
					...sessionPatch,
				}),
			);
			exhausted += 1;
		}
	};

	// Pass 1 — resolution from episode outcomes.
	for (const ev of events) {
		if (ev.type !== 'optimization_outcome' || typeof ev.row !== 'number') {
			continue;
		}
		const row = ev.row;
		const at = typeof ev.at === 'number' ? ev.at : Number.MAX_SAFE_INTEGER;
		const wasteKind = typeof ev.waste_kind === 'string' ? ev.waste_kind : undefined;
		const verdict = typeof ev.verdict === 'string' ? ev.verdict : 'resolved';
		const deltaMs = typeof ev.delta_ms === 'number' ? ev.delta_ms : undefined;
		const predictedMs = typeof ev.predicted_ms === 'number' ? ev.predicted_ms : undefined;
		const dispatched = [...board.entries.values()].filter(
			(e) =>
				e.status === 'dispatched' &&
				e.row === row &&
				// The outcome must postdate the dispatch (1s slop for same-second
				// clocks): an old ledger line must not insta-resolve a fresh dispatch.
				at + 1 >= (e.dispatched_at ?? e.updated_at),
		);
		if (dispatched.length === 0) {
			continue;
		}
		const target = dispatched.find((e) => e.kind === wasteKind) ?? dispatched[0];
		const delta =
			deltaMs !== undefined
				? ` (measured ${Math.round(deltaMs)}ms vs predicted ${Math.round(predictedMs ?? target.predicted_ms)}ms)`
				: '';
		if (verdict === 'regressed' || verdict === 'reverted-behavior') {
			// TERMINATION with retrial: the failed optimization gets one more
			// materially different attempt before parking (attempt-store seeded).
			reopenOrExhaust(
				target,
				`the optimization attempt was reverted (${verdict})`,
				`${verdict}${delta}`,
			);
		} else {
			changed.push(
				transition(board, target, {
					status: 'resolved',
					resolution: `${verdict}${delta}`,
					// The sighting counter switches meaning here (hang → evidence
					// expiry): quiet-session counts must not bleed into absence counts.
					misses: 0,
				}),
			);
			resolved += 1;
		}
	}

	// Pass 2 — session-relative bookkeeping (one advance per NEW session key).
	if (sessionKey) {
		for (const entry of [...board.entries.values()]) {
			if (entry.status === 'dispatched') {
				if (entry.last_session === sessionKey) {
					continue; // this session's quiet was already counted
				}
				if (ledgerActiveSince(events, entry.dispatched_at ?? entry.updated_at, entry.episode_id)) {
					if ((entry.misses ?? 0) > 0) {
						changed.push(transition(board, entry, { misses: 0, last_session: sessionKey }));
					}
					continue; // the episode is (or was) alive — resolution judges it
				}
				const misses = (entry.misses ?? 0) + 1;
				if (misses >= EXPIRY_MISSING_SESSIONS) {
					reopenOrExhaust(
						entry,
						`the dispatched episode went quiet — no ledger activity across ${misses} capture sessions (the run likely died)`,
					);
				} else {
					changed.push(transition(board, entry, { misses, last_session: sessionKey }));
				}
				continue;
			}
			if (TERMINAL_STATUSES.has(entry.status)) {
				// Terminal aging: count fresh sessions since the lifecycle ended, so
				// compaction knows when forgetting is licensed.
				if (entry.last_session !== sessionKey) {
					changed.push(
						transition(board, entry, {
							misses: (entry.misses ?? 0) + 1,
							last_session: sessionKey,
						}),
					);
				}
				continue;
			}
			// 'posted' / 'resolved' — evidence-relative expiry.
			if (freshIds === null) {
				continue; // unknown evidence is not absent evidence
			}
			if (freshIds.has(entry.id)) {
				if ((entry.misses ?? 0) > 0) {
					changed.push(transition(board, entry, { misses: 0, last_session: sessionKey }));
				}
				continue;
			}
			if (entry.last_session === sessionKey) {
				continue; // this session's absence was already counted
			}
			const misses = (entry.misses ?? 0) + 1;
			if (misses >= EXPIRY_MISSING_SESSIONS) {
				changed.push(
					transition(board, entry, {
						status: 'expired',
						misses,
						last_session: sessionKey,
						resolution: `signature absent from fresh evidence for ${misses} capture sessions`,
					}),
				);
				expired += 1;
			} else {
				changed.push(transition(board, entry, { misses, last_session: sessionKey }));
			}
		}
	}

	appendEntries(workspaceRoot, changed);
	board.lineCount += changed.length;
	maybeCompact(workspaceRoot, board);
	return { resolved, expired, reopened, exhausted };
}

// ---- the analyzer feed ------------------------------------------------------

/**
 * The ONE candidate source every board producer derives from: the waste-prior
 * ranker over the full evidence set (per-session timings, cache duplication,
 * request-span structure). Throws when there is no index store — callers must
 * treat that as "evidence unknown", never as "no opportunities".
 *
 * (optimizationSource.ts assembles the same inputs for the panel; that class
 * is vscode-bound, so the vscode-free surfaces share this assembly instead.)
 */
export function rankedOpportunityCandidates(workspaceRoot: string): OptimizationCandidate[] {
	if (!hasIndexStore(workspaceRoot)) {
		// loadNodes degrades to [] on a missing store, which would masquerade as
		// "the evidence shows nothing" — and expiry would count absences against
		// entries that are merely unreadable. Unknown must stay unknown.
		throw new Error(`no Vinv index store under ${workspaceRoot}`);
	}
	const storeDir = indexStoreDir(workspaceRoot);
	const nodes: GraphNode[] = loadNodes(storeDir);
	const edges = loadEdges(storeDir, nodes.length);
	const timings = collectSymbolTimings(workspaceRoot, nodes);
	const cacheByRow = new Map(collectCacheCandidates(workspaceRoot, nodes).map((c) => [c.row, c]));
	const spans = collectRequestSpans(workspaceRoot, nodes);
	// Same ranking-time calibration deflation as the panel path — the board and
	// the panel must never rank the same evidence differently.
	const calibration = loadOptimizationCalibration(workspaceRoot);
	return computeOptimizationCandidates({
		nodes,
		edges,
		timings,
		cacheByRow,
		spans,
		calibration,
		// The board's own list budget — the eviction bound (LIVE_POSTED_CAP)
		// derives from this cap, so it is passed explicitly rather than trusting
		// the analyzer's default to stay in sync.
		cap: OPPORTUNITY_ANALYZER_CAP,
	});
}

/** Board input for one ranked candidate. */
export function candidateToOpportunity(
	c: OptimizationCandidate,
	source: string,
): OpportunityInput {
	return {
		kind: c.waste_kind,
		row: c.row,
		name: c.name,
		file: c.file,
		line: c.line,
		predicted_ms: c.predicted_ms,
		evidence: c.reason,
		source,
	};
}

/** The candidate's board id (same signature post() derives). */
export function candidateSignature(c: OptimizationCandidate): string {
	return opportunitySignature(c.waste_kind, c.file, c.name, c.reason);
}

/**
 * Newest capture-session key under .vinv/captures, matching the
 * `<dir>@<mtime>` identity collectSymbolTimings keys sessions by — a re-trace
 * into the same directory is a NEW session. Empty string when no captures.
 */
export function newestCaptureSession(workspaceRoot: string): string {
	let best = '';
	let bestMtime = -1;
	for (const file of findTraceFiles(path.join(workspaceRoot, '.vinv', 'captures'))) {
		try {
			const st = fs.statSync(file);
			if (st.size > 0 && st.mtimeMs > bestMtime) {
				bestMtime = st.mtimeMs;
				best = `${path.dirname(file)}@${Math.round(st.mtimeMs)}`;
			}
		} catch {
			// Vanished between listing and stat — skip.
		}
	}
	return best;
}

/** What one full board sync computed and left on disk. */
export interface BoardSyncResult {
	/** The board after reconcile + post, newest-status-wins. */
	entries: OpportunityEntry[];
	/** The ranked candidates the evidence currently supports (empty when the
	 * store was unreadable — see evidenceKnown). */
	candidates: OptimizationCandidate[];
	/** False when the analyzer could not run (no index): expiry was skipped and
	 * nothing was posted, because unknown evidence is not absent evidence. */
	evidenceKnown: boolean;
	reconcile: BoardReconcileResult;
}

/**
 * The one produce-and-reconcile cycle every surface runs: derive the ranked
 * candidates, resolve dispatched entries from episode outcomes, advance
 * expiry against the fresh evidence, and post whatever the evidence newly
 * supports. Callers pass the episode-ledger events (readEpisodeEvents()) so
 * tests can inject them.
 */
export function syncOpportunityBoard(
	workspaceRoot: string,
	source: string,
	events: ReadonlyArray<LedgerEvent>,
): BoardSyncResult {
	let candidates: OptimizationCandidate[] = [];
	let evidenceKnown = true;
	try {
		candidates = rankedOpportunityCandidates(workspaceRoot);
	} catch {
		evidenceKnown = false;
	}
	const freshIds = evidenceKnown ? new Set(candidates.map(candidateSignature)) : null;
	const reconcile = reconcileOpportunityBoard(
		workspaceRoot,
		events,
		freshIds,
		newestCaptureSession(workspaceRoot),
	);
	if (evidenceKnown) {
		postOpportunities(
			workspaceRoot,
			candidates.map((c) => candidateToOpportunity(c, source)),
		);
	}
	return { entries: loadOpportunityBoard(workspaceRoot), candidates, evidenceKnown, reconcile };
}

// ---- rendering (shared by the MCP surface) ----------------------------------

const STATUS_ORDER: Record<OpportunityStatus, number> = {
	posted: 0,
	dispatched: 1,
	resolved: 2,
	exhausted: 3,
	evicted: 4,
	expired: 5,
};

/**
 * The status in plain language for the human block (the machine JSON below it
 * keeps the raw fields — agents parse those, people read these).
 */
export function plainStatus(e: OpportunityEntry): string {
	switch (e.status) {
		case 'posted':
			return (e.retry_count ?? 0) > 0
				? `waiting to retry (attempt ${(e.retry_count ?? 0) + 1})`
				: 'waiting to try';
		case 'dispatched':
			return 'being worked on';
		case 'resolved':
			if (e.resolution?.startsWith('proven')) {
				return 'improved — verified';
			}
			if (e.resolution?.startsWith('inconclusive')) {
				return 'tried — no measurable difference';
			}
			return 'finished';
		case 'exhausted': {
			const tries = (e.retry_count ?? 0) + 1;
			return `tried ${tries === 2 ? 'twice' : `${tries} time(s)`}, no verified win — parked`;
		}
		case 'evicted':
			return 'outranked by higher-predicted work — evicted';
		case 'expired':
			return 'no longer in the evidence — expired';
	}
}

/**
 * The board as a human-readable block plus machine JSON lines — what the MCP
 * `opportunities` action returns so harness agents walk the same board the
 * sweeps consume. Statuses read as plain language; the machine block keeps
 * the raw contract fields unchanged.
 */
export function renderOpportunityBoard(entries: OpportunityEntry[]): string {
	if (entries.length === 0) {
		return (
			'The opportunity board is empty — no optimization opportunities have been ' +
			'posted yet. Capture a trace (run a service and exercise it); the analyzer ' +
			'posts candidates as evidence arrives.'
		);
	}
	const ordered = [...entries].sort(
		(a, b) =>
			STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.predicted_ms - a.predicted_ms,
	);
	const counts: Record<OpportunityStatus, number> = {
		posted: 0,
		dispatched: 0,
		resolved: 0,
		exhausted: 0,
		evicted: 0,
		expired: 0,
	};
	for (const e of entries) {
		counts[e.status] += 1;
	}
	const fmtMag = (kind: string, n: number): string => {
		// Memory kinds carry BYTES in predicted_ms; render them as bytes.
		if (kind === 'alloc-churn' || kind === 'mem-leak') {
			const b = Math.abs(n);
			if (b >= 1 << 20) {
				return `${(b / (1 << 20)).toFixed(1)}MB`;
			}
			if (b >= 1 << 10) {
				return `${(b / (1 << 10)).toFixed(1)}KB`;
			}
			return `${Math.round(b)}B`;
		}
		return `${Math.round(n)}ms`;
	};
	const lines = ordered.map(
		(e) =>
			`- [${plainStatus(e)}] ${e.name} at ${e.file}:${e.line} — ${e.kind}, ` +
			`~${fmtMag(e.kind, e.predicted_ms)} predicted: ${e.evidence}` +
			(e.resolution ? ` → ${e.resolution}` : '') +
			(e.note ? ` (${e.note})` : '') +
			` (id ${e.id}, source ${e.source})`,
	);
	// Exhausted entries are LOUD: they represent evidence the loop tried and
	// could not convert — silence here would bury exactly the failures a human
	// should look at.
	const exhaustedWarning =
		counts.exhausted > 0
			? `\nATTENTION: ${counts.exhausted} opportunity(ies) exhausted their retry budget ` +
				'and are parked — they will NOT be retried automatically. Investigate them ' +
				'manually or dispatch with a materially different approach.\n'
			: '';
	return (
		`Opportunity board: ${counts.posted} waiting to try, ${counts.dispatched} being ` +
		`worked on, ${counts.resolved} resolved, ${counts.exhausted} parked (retry budget ` +
		`spent), ${counts.evicted} evicted (outranked), ${counts.expired} expired.\n` +
		exhaustedWarning +
		`${lines.join('\n')}\n\n` +
		'Only "waiting to try" entries are dispatchable; entries being worked on or ' +
		'already resolved re-open only after expiry (absent from fresh evidence for ' +
		`${EXPIRY_MISSING_SESSIONS}+ capture sessions), and parked/evicted entries never ` +
		're-dispatch automatically. ' +
		'Use action="run_sweep" sweep="hotspots" or sweep="cache_candidates" to dispatch.\n\n' +
		'Machine JSON (one entry per line):\n' +
		ordered.map((e) => JSON.stringify(e)).join('\n')
	);
}
