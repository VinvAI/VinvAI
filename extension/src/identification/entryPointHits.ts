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
	/**
	 * The exact trace component this unit IS, when it is known outright.
	 *
	 * A function the exerciser drove is named by its target — `acme.mod.summarize`
	 * — and no declaration gives it a file to derive a module prefix from. Matching
	 * that name exactly is both simpler and stricter than the module+handler
	 * heuristic below, so when it is present it decides on its own.
	 */
	component?: string;
}

/** Bytes of the file head kept to notice a rewrite rather than an append. */
const HEAD_BYTES = 256;

/**
 * Durations kept per component, most recent wins.
 *
 * A long-lived service's trace holds unbounded spans for one component, and the
 * panel only ever needs a distribution to take percentiles from. Keeping the
 * most recent N is both bounded and the more honest window: "how slow is this
 * now" is the question being asked, not "how slow has it ever been".
 */
const MAX_SAMPLES = 10_000;

interface FileCursor {
	/** Bytes already consumed. */
	offset: number;
	/** Trailing partial line from the last read, prepended to the next. */
	remainder: string;
	/** First bytes of the file, to tell an append from a rewrite. */
	head: string;
	/** component → everything this file has said about it so far. */
	facts: Map<string, ComponentFacts>;
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
	if (entry.component) {
		return component === entry.component;
	}
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

/** What one capture says about one component, accumulated incrementally. */
export interface ComponentFacts {
	/** `enter` events — one per invocation. */
	calls: number;
	/** `exit` durations in ms, the most recent MAX_SAMPLES of them. */
	durations: number[];
	/** Exits that ended ok, and that raised. */
	ok: number;
	error: number;
	/** Exception types seen, with how many exits raised each. */
	errorTypes: Map<string, number>;
}

function emptyFacts(): ComponentFacts {
	return { calls: 0, durations: [], ok: 0, error: 0, errorTypes: new Map() };
}

/** Merges `b` into `a` (used to sum one component across several captures). */
function mergeFacts(a: ComponentFacts, b: ComponentFacts): void {
	a.calls += b.calls;
	a.ok += b.ok;
	a.error += b.error;
	for (const d of b.durations) {
		if (a.durations.length < MAX_SAMPLES) {
			a.durations.push(d);
		}
	}
	for (const [t, n] of b.errorTypes) {
		a.errorTypes.set(t, (a.errorTypes.get(t) ?? 0) + n);
	}
}

/** Adds one file's newly-appended events into its cursor. */
function advance(file: string): Map<string, ComponentFacts> {
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
		return cursors.get(file)?.facts ?? new Map();
	}
	let cursor = cursors.get(file);
	// Shrunk, or a different file under the same name (the window filter
	// rewrites its trace on every poll): start over rather than read garbage.
	if (!cursor || stat.size < cursor.offset || head !== cursor.head) {
		cursor = { offset: 0, remainder: '', head, facts: new Map() };
		cursors.set(file, cursor);
	}
	if (stat.size === cursor.offset) {
		return cursor.facts;
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
		return cursor.facts;
	}
	const lines = (cursor.remainder + chunk).split('\n');
	// The last element is either a partial line (the writer is mid-flush) or
	// empty; either way it is not ours to parse yet.
	cursor.remainder = lines.pop() ?? '';
	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}
		let ev: {
			event?: string;
			component?: string;
			duration_ms?: number;
			status?: string;
			error_type?: string | null;
		};
		try {
			ev = JSON.parse(line) as typeof ev;
		} catch {
			continue;
		}
		if (!ev.component || (ev.event !== 'enter' && ev.event !== 'exit')) {
			continue;
		}
		let f = cursor.facts.get(ev.component);
		if (!f) {
			f = emptyFacts();
			cursor.facts.set(ev.component, f);
		}
		if (ev.event === 'enter') {
			f.calls += 1;
			continue;
		}
		// An exit is where the RUN reports itself: how long it took and whether
		// it raised. Both were read off this same line and dropped, which is why
		// every latency number in the product had to come from an exerciser's
		// own bookkeeping instead of from the capture.
		if (typeof ev.duration_ms === 'number' && Number.isFinite(ev.duration_ms)) {
			if (f.durations.length < MAX_SAMPLES) {
				f.durations.push(ev.duration_ms);
			} else {
				// Full: keep the most recent window rather than the first N.
				f.durations.shift();
				f.durations.push(ev.duration_ms);
			}
		}
		if (ev.status === 'error') {
			f.error += 1;
			if (ev.error_type) {
				f.errorTypes.set(ev.error_type, (f.errorTypes.get(ev.error_type) ?? 0) + 1);
			}
		} else {
			f.ok += 1;
		}
	}
	return cursor.facts;
}

/** component → everything the given traces say about it, merged. */
export function componentFacts(traceFiles: string[]): Map<string, ComponentFacts> {
	const total = new Map<string, ComponentFacts>();
	for (const file of traceFiles) {
		for (const [component, facts] of advance(file)) {
			let into = total.get(component);
			if (!into) {
				into = emptyFacts();
				total.set(component, into);
			}
			mergeFacts(into, facts);
		}
	}
	return total;
}

/** component → invocations, summed over the given traces. */
export function countInvocations(traceFiles: string[]): Map<string, number> {
	const total = new Map<string, number>();
	for (const [component, facts] of componentFacts(traceFiles)) {
		total.set(component, facts.calls);
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

/**
 * Everything the captures say about each entry point, keyed by entry-point id.
 *
 * The same join as `entryPointHits` — the entry point's own handler spans — but
 * carrying the rest of what those spans recorded: how long each invocation took
 * and whether it raised. This is the ONLY source that can answer those
 * questions for every kind of unit, which is why both the Traces panel and the
 * Findings latency profile read it rather than an exerciser's scorecard: a
 * scorecard exists only for units an exerciser drove, is keyed by a display
 * label rather than an entry-point id, and is a snapshot taken when it was
 * written. The captures are the evidence all of it was derived from.
 */
export function entryPointFacts(
	workspaceRoot: string,
	entries: EntryPointLike[],
	traceFile?: string,
): Map<string, ComponentFacts> {
	const files = traceFile
		? [traceFile]
		: findTraceFiles(path.join(workspaceRoot, '.vinv', 'captures'));
	const components = componentFacts(files);
	const byEntry = new Map<string, ComponentFacts>();
	if (components.size === 0) {
		return byEntry;
	}
	for (const entry of entries) {
		let acc: ComponentFacts | undefined;
		for (const [component, facts] of components) {
			if (!componentMatches(component, entry)) {
				continue;
			}
			if (!acc) {
				acc = emptyFacts();
			}
			mergeFacts(acc, facts);
		}
		// Absent, not zeroed: a unit the captures never saw has no latency, and
		// rendering 0ms would state a measurement nobody made.
		if (acc && acc.calls > 0) {
			byEntry.set(entry.id, acc);
		}
	}
	return byEntry;
}
