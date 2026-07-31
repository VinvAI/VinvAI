/**
 * Resolves which entry points are relevant to a clicked graph node, so the graph's
 * "Trace & Flamegraph" action can open the right call tree — or a picker of just
 * the relevant endpoints — instead of asking the user to choose from every
 * endpoint in the workspace.
 *
 * Relevance is computed at the FILE level, deliberately. A symbol-level reverse
 * walk sounds more precise, but the static index resolves only a fraction of
 * cross-file calls (dynamic dispatch, decorators, framework wiring), so most
 * route→handler→controller chains have missing row edges — a row-level walk finds
 * almost nothing. Aggregating to files only needs ONE resolved edge between two
 * files to connect them, and it keys endpoints on their reliable `file` field
 * rather than the often-module-level `handler` name. In practice this turns "all
 * 116 endpoints" into the handful whose call tree actually passes through the
 * clicked file.
 *
 * Deterministic: reads only the snapshot and the consolidate inventory — no
 * traces, no running server, no LLM.
 */
import { entryPointLabel, type EntryPoint } from './identification';
import type { GraphSnapshot } from '../graph/indexGraph';

/** An entry point relevant to the target, with how far above it its file sits. */
export interface ReachingEndpoint {
	entry: EntryPoint;
	/** 0 = endpoint is defined in the clicked file; N = its file is N file-hops above it. */
	depth: number;
}

/** Normalises a path for suffix comparison (forward slashes, no leading `./`). */
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * True when two paths denote the same file. Entry-point paths come from
 * `consolidate` (relative to the detected code root) while node paths come from
 * the index store (relative to the workspace), so they can differ by a leading
 * directory — a suffix match bridges that without a full path resolve.
 */
function sameFile(a: string, b: string): boolean {
	const na = normalizePath(a);
	const nb = normalizePath(b);
	return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

/**
 * Ranks the entry points whose call tree passes through any of `targetRows`'
 * files, closest first. An endpoint is relevant when its handler file is the
 * target file or a (transitive) caller of it in the file-level invoke graph —
 * i.e. running that endpoint executes code in the clicked file. Empty when
 * nothing resolves; callers then fall back to the full entry-point picker.
 */
export function endpointsForRows(
	entries: EntryPoint[],
	snapshot: GraphSnapshot,
	targetRows: number[],
): ReachingEndpoint[] {
	if (entries.length === 0 || targetRows.length === 0) {
		return [];
	}

	const fileOfRow = new Map<number, string>();
	for (const n of snapshot.nodes) {
		fileOfRow.set(n.row, n.file);
	}

	// File-level reverse invoke adjacency: callee file → files that call into it.
	// Cross-file edges only — internal calls don't connect distinct files.
	const fileCallers = new Map<string, Set<string>>();
	for (const e of snapshot.edges) {
		if (e.kind !== 'invoke') {
			continue;
		}
		const src = fileOfRow.get(e.src);
		const dst = fileOfRow.get(e.dst);
		if (!src || !dst || src === dst) {
			continue;
		}
		let callers = fileCallers.get(dst);
		if (!callers) {
			callers = new Set();
			fileCallers.set(dst, callers);
		}
		callers.add(src);
	}

	// BFS upward from the target files; record the shallowest hop each caller file
	// is reached at (its distance from the closest target file).
	const depthOf = new Map<string, number>();
	let frontier: string[] = [];
	for (const row of targetRows) {
		const file = fileOfRow.get(row);
		if (file && !depthOf.has(file)) {
			depthOf.set(file, 0);
			frontier.push(file);
		}
	}
	let depth = 0;
	while (frontier.length > 0) {
		depth += 1;
		const next: string[] = [];
		for (const file of frontier) {
			for (const caller of fileCallers.get(file) ?? []) {
				if (!depthOf.has(caller)) {
					depthOf.set(caller, depth);
					next.push(caller);
				}
			}
		}
		frontier = next;
	}

	// An endpoint is relevant when its file is in the reachable set (suffix-matched
	// to bridge code-root vs workspace-relative paths). Keep its shallowest depth.
	const reaching: ReachingEndpoint[] = [];
	for (const entry of entries) {
		let best: number | null = null;
		for (const [file, d] of depthOf) {
			if (sameFile(file, entry.file) && (best === null || d < best)) {
				best = d;
			}
		}
		if (best !== null) {
			reaching.push({ entry, depth: best });
		}
	}

	if (reaching.length === 0) {
		return [];
	}

	// Keep only the closest ring: the shallowest hop-distance that actually holds
	// endpoints. Direct callers of the file are the endpoints that meaningfully
	// exercise it; deeper matches only reach it transitively through shared
	// middleware (e.g. an auth bearer check) or app startup (`__main__`), which
	// would reintroduce the noise this resolver exists to remove. Taking the
	// nearest band still works for layered stacks (route → service → controller),
	// where the routes are simply the shallowest endpoints found.
	const minDepth = Math.min(...reaching.map((r) => r.depth));
	const closest = reaching.filter((r) => r.depth === minDepth);

	// Stable trigger order so the picker is deterministic across rebuilds.
	closest.sort((a, b) => entryPointLabel(a.entry).localeCompare(entryPointLabel(b.entry)));
	return closest;
}
