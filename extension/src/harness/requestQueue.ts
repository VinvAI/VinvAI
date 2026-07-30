/**
 * The chat→editor action bridge. The MCP server runs as a standalone node
 * process (no `vscode` module), so it cannot start an episode itself — episodes
 * need the harness runner, the escalation UI, and the workspace snapshot, all
 * of which live in the extension host. Instead, chat-side requests are durable
 * files under .vinv/requests/; the extension watches that directory and
 * dispatches each request as a real episode, then deletes the file. Crashing
 * between write and dispatch loses nothing: the file is still there on the
 * next activation sweep.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** What the chat side may ask the editor side to do. */
export type EpisodeRequestKind =
	| 'fix' // free-form issue text → general/service-fix episode
	| 'runtime-errors' // sweep: fix observed runtime error clusters
	| 'hotspots' // sweep: optimize the Pareto head of traced time
	| 'memory-trends' // sweep: investigate cross-session leak suspects
	| 'cache-candidates'; // sweep: memoize duplicate recomputation

export interface EpisodeRequest {
	id: string;
	ts: string;
	/** Where the request came from (e.g. 'chat' for the MCP session tool). */
	source: string;
	kind: EpisodeRequestKind;
	/** Free-form issue statement — required for kind 'fix'. */
	issue?: string;
	/** Optional service name to scope a 'fix' as a service-fix episode. */
	service?: string;
}

/**
 * Why a drained request produced what it produced.
 *
 * The queue is atomic and unconditional: `readAndClearRequests` removes the file
 * before anything is attempted. That is correct for crash-safety, but it means a
 * request that dispatches nothing leaves NO trace — and until this ledger, the
 * only channel for the reason was `vscode.window.showInformationMessage`, a
 * transient toast. So an MCP caller that queued a sweep observed: file created,
 * file drained, silence forever, with no way even in principle to learn the
 * outcome. Worse than silence, because the request was consumed, so a retry is
 * not idempotent — it is a second consumption with the same silent result.
 *
 * Observed live: `run_sweep hotspots` reported `Sweep 'hotspots' queued
 * (episode-363c2c62-….json)`; `.vinv/requests/` was left empty (drained) and
 * `.vinv/episodes.jsonl` never gained a line. `noPlanMessage` had computed one of
 * three perfectly actionable reasons — all opportunities held on the board / no
 * cache opportunities / no recoverable time, capture a trace first — and routed
 * every one of them to a popup.
 *
 * The general rule this encodes: this codebase guards VERDICTS everywhere
 * (verified, objective, contained, superseded) and had no persistence at all for
 * NON-verdicts. "Nothing happened, and here is why" is evidence too.
 */
export type RequestOutcomeKind =
	| 'dispatched' // an episode actually ran for this request
	| 'no_plan' // nothing to work on; `reason` says why (never a guess)
	| 'harness_busy' // deferred, restored to the queue — NOT consumed
	| 'invalid'; // malformed request (e.g. kind 'fix' with no issue text)

export interface RequestOutcome {
	request_id: string;
	kind: EpisodeRequestKind;
	outcome: RequestOutcomeKind;
	/** Human-readable cause. For 'no_plan' this is the text the toast carried. */
	reason: string;
	ts: string;
}

/** Append-only outcome ledger, beside the other durable reports. */
export function requestOutcomesPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'request-outcomes.jsonl');
}

/**
 * Records what became of one drained request. Best-effort by design: a failure
 * to write the ledger must never take down a dispatch that is otherwise fine.
 */
export function recordRequestOutcome(
	workspaceRoot: string,
	outcome: Omit<RequestOutcome, 'ts'> & { ts?: string },
): void {
	try {
		const file = requestOutcomesPath(workspaceRoot);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const row: RequestOutcome = { ...outcome, ts: outcome.ts ?? new Date().toISOString() };
		fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
	} catch {
		// A missing ledger line is a reporting loss, not a dispatch failure.
	}
}

/** Reads the outcome ledger, newest last. `[]` when absent or unreadable. */
export function readRequestOutcomes(workspaceRoot: string): RequestOutcome[] {
	let text: string;
	try {
		text = fs.readFileSync(requestOutcomesPath(workspaceRoot), 'utf8');
	} catch {
		return [];
	}
	const out: RequestOutcome[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const row = JSON.parse(line) as RequestOutcome;
			if (row && typeof row.request_id === 'string' && typeof row.outcome === 'string') {
				out.push(row);
			}
		} catch {
			continue; // a torn line must not hide the rest of the ledger
		}
	}
	return out;
}

export function requestsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'requests');
}

/** Writes one request file atomically (tmp + rename) and returns its path. */
export function enqueueEpisodeRequest(
	workspaceRoot: string,
	request: Omit<EpisodeRequest, 'id' | 'ts'> | EpisodeRequest,
): string {
	const dir = requestsDir(workspaceRoot);
	fs.mkdirSync(dir, { recursive: true });
	const full: EpisodeRequest = {
		id: crypto.randomUUID(),
		ts: new Date().toISOString(),
		...request,
	};
	const file = path.join(dir, `episode-${full.id}.json`);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(full, null, '\t'));
	fs.renameSync(tmp, file);
	return file;
}

/**
 * Restores requests previously returned by readAndClearRequests without
 * changing their ids or timestamps. This is the busy-harness rollback for the
 * queue's drain-then-dispatch transaction: every unconsumed item goes back.
 */
export function restoreEpisodeRequests(
	workspaceRoot: string,
	requests: EpisodeRequest[],
): void {
	for (const request of requests) {
		enqueueEpisodeRequest(workspaceRoot, request);
	}
}

/**
 * Reads every pending request (oldest first) and deletes the files — the
 * caller owns dispatch from here. Malformed files are deleted too (they can
 * never become dispatchable), so the queue self-heals.
 */
export function readAndClearRequests(workspaceRoot: string): EpisodeRequest[] {
	const dir = requestsDir(workspaceRoot);
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter((n) => n.startsWith('episode-') && n.endsWith('.json'));
	} catch {
		return [];
	}
	const out: EpisodeRequest[] = [];
	for (const name of names) {
		const file = path.join(dir, name);
		try {
			const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EpisodeRequest;
			if (parsed && typeof parsed.kind === 'string') {
				out.push(parsed);
			}
		} catch {
			// Unreadable/malformed: fall through to the delete below.
		}
		try {
			fs.unlinkSync(file);
		} catch {
			// Already gone (racing sweep) — the dedupe-by-delete still holds.
		}
	}
	out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	return out;
}
