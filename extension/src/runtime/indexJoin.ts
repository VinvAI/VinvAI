/**
 * Joins runtime trace components to index chunks — the code ↔ trace link in
 * the artifact graph.
 *
 * The Rust index stores, per chunk, a content hash (`sha`) and the content
 * epoch at which that hash last changed (`epoch`). Capture sessions are
 * stamped with the index epoch current when they were recorded. Joining the
 * two dates every runtime fact: facts observed at epoch E about a chunk whose
 * content last changed at epoch > E describe code that no longer exists.
 *
 * vscode-free (fs/path only) so the standalone MCP servers can import it.
 */
import * as fs from 'fs';
import * as path from 'path';

/** The identity-relevant slice of an index chunk. */
export interface ChunkIdentity {
	id: string;
	file: string;
	name: string;
	/** Content hash of the symbol's source snippet. */
	sha: string;
	/** Index epoch at which the content last changed. */
	epoch: number;
}

interface CachedChunks {
	/** `size:mtime` of chunks.jsonl when parsed. */
	sig: string;
	/** short symbol name → all chunks bearing it. */
	byName: Map<string, ChunkIdentity[]>;
}

const cache = new Map<string, CachedChunks>();

function chunksPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'index', 'chunks.jsonl');
}

/** Parses (and caches) the chunk identity table for a workspace's index. */
function loadChunks(workspaceRoot: string): Map<string, ChunkIdentity[]> | null {
	const file = chunksPath(workspaceRoot);
	let sig: string;
	try {
		const s = fs.statSync(file);
		sig = `${s.size}:${s.mtimeMs}`;
	} catch {
		return null;
	}
	const cached = cache.get(workspaceRoot);
	if (cached && cached.sig === sig) {
		return cached.byName;
	}

	const byName = new Map<string, ChunkIdentity[]>();
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
	for (const line of raw.split('\n')) {
		const s = line.trim();
		if (!s) {
			continue;
		}
		let row: { id?: string; file?: string; name?: string; sha?: string; epoch?: number };
		try {
			row = JSON.parse(s);
		} catch {
			continue;
		}
		if (!row.id || !row.file || !row.name) {
			continue;
		}
		const identity: ChunkIdentity = {
			id: row.id,
			file: row.file,
			name: row.name,
			sha: row.sha ?? '',
			epoch: typeof row.epoch === 'number' ? row.epoch : 0,
		};
		const list = byName.get(identity.name);
		if (list) {
			list.push(identity);
		} else {
			byName.set(identity.name, [identity]);
		}
	}
	cache.set(workspaceRoot, { sig, byName });
	return byName;
}

/**
 * Resolves a trace component (dotted qualname, e.g. `billing.payments.charge`)
 * to its index chunk. Matches by short name, then prefers the chunk whose file
 * path agrees with the qualname's module segments. Returns null when the index
 * is absent or no chunk bears the name.
 */
export function chunkForComponent(
	workspaceRoot: string,
	component: string,
): ChunkIdentity | null {
	const byName = loadChunks(workspaceRoot);
	if (!byName) {
		return null;
	}
	const short = component.includes('.')
		? component.slice(component.lastIndexOf('.') + 1)
		: component;
	const candidates = byName.get(short);
	if (!candidates || candidates.length === 0) {
		return null;
	}
	if (candidates.length === 1) {
		return candidates[0];
	}
	// Disambiguate with the module segments: score each candidate by how many
	// qualname segments appear in its file path.
	const segments = component.split('.').slice(0, -1);
	let best = candidates[0];
	let bestScore = -1;
	for (const c of candidates) {
		const normalized = c.file.replace(/\\/g, '/');
		let score = 0;
		for (const seg of segments) {
			if (normalized.includes(seg)) {
				score += 1;
			}
		}
		if (score > bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best;
}
