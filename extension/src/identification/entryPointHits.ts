/**
 * Hit counts for the entry points the engine's tracesummary cannot count.
 *
 * `identification tracesummary` ranks HTTP endpoints by how many trace requests
 * reached them. It has no answer for the other four fifths of the inventory —
 * CLI commands, workers, scheduled jobs, stdio servers, `__main__` scripts —
 * so those rows sat in the Traces panel at 0 hits permanently, no matter how
 * often they ran. The trace proves otherwise: a `tracelens run … -- python -m
 * handbook.cli generate` capture holds `handbook.cli.generate_cmd` enter/exit
 * events with durations, and the runtime overlay already joins them onto the
 * graph. Only the panel's Hits column could not see them.
 *
 * So the count is computed here, from the captures directly:
 *
 *   - the UNIT is one invocation — an `enter` event for the entry point's own
 *     handler. For a CLI that is one run, for a worker one task, for a script
 *     one execution. It answers the same question the HTTP column answers
 *     ("how many times did this starting point fire"), which is why the two
 *     can share a column without lying;
 *   - the JOIN is the entry point's file path turned into a module prefix
 *     (`handbook/src/handbook/cli.py` → `handbook.cli`) plus its handler name
 *     as the final segment. Anchoring on BOTH is what stops a common helper
 *     name from collecting every namesake's calls in the repo;
 *   - reads are INCREMENTAL. The panel polls once a second and a live server's
 *     trace grows without bound, so each file is read from where the last read
 *     stopped. A rewritten file (the time-window filter rebuilds one each poll)
 *     is detected by its changed head and re-read from zero.
 *
 * HTTP rows keep the engine's own numbers — this never overrides them. It fills
 * only the rows the engine returns nothing for.
 */

import * as fs from 'fs';
import * as path from 'path';

import { findTraceFiles } from '../graph/indexGraph';

/** The subset of an EntryPoint this join needs. */
export interface EntryPointLike {
	id: string;
	handler: string | null;
	file: string;
}

/** Bytes of the file head kept to notice a rewrite rather than an append. */
const HEAD_BYTES = 256;

interface FileCursor {
	/** Bytes already consumed. */
	offset: number;
	/** Trailing partial line from the last read, prepended to the next. */
	remainder: string;
	/** First bytes of the file, to tell an append from a rewrite. */
	head: string;
	/** component → enter events seen so far in this file. */
	counts: Map<string, number>;
}

const cursors = new Map<string, FileCursor>();

/** Drops all cached reads. Exported for tests, which reuse temp paths. */
export function resetHitCache(): void {
	cursors.clear();
}

/**
 * Module prefixes a file could be imported as, most specific first.
 *
 * Two candidates because both layouts are common and neither is discoverable
 * from the path alone: `pkg/src/pkg/mod.py` is imported as `pkg.mod` (src
 * layout), while `pkg/mod.py` is imported as `pkg.mod` directly. A path with no
 * `src` segment yields one candidate; a src layout yields the post-src form and
 * the whole path, so a mis-detected layout degrades to no match rather than to
 * a wrong one.
 */
export function moduleCandidates(file: string): string[] {
	const parts = file
		.replace(/\\/g, '/')
		.replace(/\.pyw?$/i, '')
		.split('/')
		.filter((p) => p.length > 0 && p !== '.');
	if (parts.length === 0) {
		return [];
	}
	const out: string[] = [];
	const srcAt = parts.lastIndexOf('src');
	if (srcAt >= 0 && srcAt < parts.length - 1) {
		out.push(parts.slice(srcAt + 1).join('.'));
	}
	out.push(parts.join('.'));
	// `__init__` is the package itself, not a submodule of it.
	return [...new Set(out.map((m) => m.replace(/\.__init__$/, '')))].filter(Boolean);
}

/**
 * True when a traced component IS this entry point's handler.
 *
 * The component's last segment must be the handler (so a caller of it does not
 * count), and the component must sit under one of the file's module prefixes
 * (so `other.module.main` never counts as this `main`). A class method
 * (`pkg.mod.Class.handle`) still matches its `pkg/mod.py` entry point, because
 * the prefix test is `startsWith`, not equality.
 */
export function componentMatches(component: string, entry: EntryPointLike): boolean {
	const handler = (entry.handler ?? '').trim();
	if (!handler || !component) {
		return false;
	}
	const segments = component.split('.');
	if (segments[segments.length - 1] !== handler) {
		return false;
	}
	return moduleCandidates(entry.file).some(
		(mod) => component === `${mod}.${handler}` || component.startsWith(`${mod}.`),
	);
}

/** Adds one file's newly-appended `enter` events into its cursor. */
function advance(file: string): Map<string, number> {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		cursors.delete(file);
		return new Map();
	}
	let head = '';
	try {
		const fd = fs.openSync(file, 'r');
		try {
			const buf = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
			fs.readSync(fd, buf, 0, buf.length, 0);
			head = buf.toString('utf8');
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return cursors.get(file)?.counts ?? new Map();
	}
	let cursor = cursors.get(file);
	// Shrunk, or a different file under the same name (the window filter
	// rewrites its trace on every poll): start over rather than read garbage.
	if (!cursor || stat.size < cursor.offset || head !== cursor.head) {
		cursor = { offset: 0, remainder: '', head, counts: new Map() };
		cursors.set(file, cursor);
	}
	if (stat.size === cursor.offset) {
		return cursor.counts;
	}
	let chunk = '';
	try {
		const fd = fs.openSync(file, 'r');
		try {
			const length = stat.size - cursor.offset;
			const buf = Buffer.alloc(length);
			const read = fs.readSync(fd, buf, 0, length, cursor.offset);
			chunk = buf.subarray(0, read).toString('utf8');
			cursor.offset += read;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return cursor.counts;
	}
	const lines = (cursor.remainder + chunk).split('\n');
	// The last element is either a partial line (the writer is mid-flush) or
	// empty; either way it is not ours to parse yet.
	cursor.remainder = lines.pop() ?? '';
	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}
		let ev: { event?: string; component?: string };
		try {
			ev = JSON.parse(line) as { event?: string; component?: string };
		} catch {
			continue;
		}
		if (ev.event !== 'enter' || !ev.component) {
			continue;
		}
		cursor.counts.set(ev.component, (cursor.counts.get(ev.component) ?? 0) + 1);
	}
	return cursor.counts;
}

/** component → invocations, summed over the given traces. */
export function countInvocations(traceFiles: string[]): Map<string, number> {
	const total = new Map<string, number>();
	for (const file of traceFiles) {
		for (const [component, n] of advance(file)) {
			total.set(component, (total.get(component) ?? 0) + n);
		}
	}
	return total;
}

/**
 * Invocation counts per entry point id.
 *
 * `traceFile` counts exactly that trace (the panel's time-window filter passes
 * one); omitting it counts every capture in the workspace, which is what the
 * unfiltered panel shows.
 */
export function entryPointHits(
	workspaceRoot: string,
	entries: EntryPointLike[],
	traceFile?: string,
): Map<string, number> {
	const files = traceFile
		? [traceFile]
		: findTraceFiles(path.join(workspaceRoot, '.vinv', 'captures'));
	const components = countInvocations(files);
	const hits = new Map<string, number>();
	if (components.size === 0) {
		return hits;
	}
	for (const entry of entries) {
		let n = 0;
		for (const [component, count] of components) {
			if (componentMatches(component, entry)) {
				n += count;
			}
		}
		if (n > 0) {
			hits.set(entry.id, n);
		}
	}
	return hits;
}
