/**
 * Durable dead-code batch queue — the requestQueue pattern applied to analysis.
 *
 * A batch dispatch is minutes of agent time, and holding the batch list only in
 * memory means a crash (or a closed window) between "decided to ask" and "the
 * reply landed" silently forgets the ask. So each batch is a file under
 * .vinv/requests/deadcode/ written BEFORE anything is dispatched — the same
 * crash-safety contract the chat→editor episode queue keeps: the file is the
 * intent, and losing the process loses nothing.
 *
 * Consumption is deliberately DIFFERENT from the episode queue's drain-then-
 * dispatch: an episode request is consumed on read because dispatching twice
 * would run two episodes, but re-ASKING about a dead section is idempotent — a
 * verdict merges by section id and never overwrites. So a batch file is removed
 * only when its dispatch produced at least one verdict; a batch the harness
 * failed (blocked, timeout, unusable reply) stays queued and the next analysis
 * run sweeps it up. The failure mode that avoids: a batch that died mid-run
 * reading as "the agent had nothing to say about these" forever.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface DeadCodeBatchRequest {
	id: string;
	ts: string;
	/** Section ids (deadCodeModel.sectionId) this batch should analyse. */
	sectionIds: string[];
}

export function deadCodeRequestsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'requests', 'deadcode');
}

/** Writes one batch file atomically (tmp + rename) and returns its path. */
export function enqueueDeadCodeBatch(workspaceRoot: string, sectionIds: string[]): string {
	const dir = deadCodeRequestsDir(workspaceRoot);
	fs.mkdirSync(dir, { recursive: true });
	const request: DeadCodeBatchRequest = {
		id: crypto.randomUUID(),
		ts: new Date().toISOString(),
		sectionIds: [...sectionIds],
	};
	const file = path.join(dir, `batch-${request.id}.json`);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(request, null, '\t'));
	fs.renameSync(tmp, file);
	return file;
}

/**
 * Every pending batch, oldest first, WITHOUT consuming them (see module doc).
 * Malformed files are deleted — they can never become dispatchable, so the
 * queue self-heals exactly like the episode queue does.
 */
export function readPendingBatches(
	workspaceRoot: string,
): Array<{ file: string; request: DeadCodeBatchRequest }> {
	const dir = deadCodeRequestsDir(workspaceRoot);
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter((n) => n.startsWith('batch-') && n.endsWith('.json'));
	} catch {
		return [];
	}
	const out: Array<{ file: string; request: DeadCodeBatchRequest }> = [];
	for (const name of names) {
		const file = path.join(dir, name);
		try {
			const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DeadCodeBatchRequest;
			if (parsed && Array.isArray(parsed.sectionIds)) {
				out.push({ file, request: parsed });
				continue;
			}
		} catch {
			// fall through to the delete below
		}
		try {
			fs.unlinkSync(file);
		} catch {
			// already gone — fine
		}
	}
	out.sort((a, b) => (a.request.ts < b.request.ts ? -1 : a.request.ts > b.request.ts ? 1 : 0));
	return out;
}

/** Removes one batch file. Missing is fine — a racing run already settled it. */
export function removeBatch(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		// already gone
	}
}
