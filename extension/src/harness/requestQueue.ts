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
