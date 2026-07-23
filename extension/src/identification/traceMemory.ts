import * as fs from 'fs';
import { probeTraceFile } from './traceFilter';

/** Per-function memory aggregated from a trace, keyed by component name. */
export interface MemoryFact {
	/** Number of trace spans/events seen for this component. */
	calls: number;
	/**
	 * Net bytes attributed to this component — the sum of `mem_delta_bytes`
	 * (tracemalloc byte deltas around each call). Can be negative when a function
	 * nets frees; callers clamp for magnitude-based visuals.
	 */
	memBytes: number;
}

/**
 * A trace's memory attribution: the raw per-component facts, plus a short-name
 * index (function name without its module) so callers can match static call-tree
 * nodes (which carry a bare `name`) back to their trace component.
 */
export interface TraceMemory {
	byComponent: Map<string, MemoryFact>;
	/** Short function name → the qualified components that end in that name. */
	byName: Map<string, string[]>;
}

interface CachedMemory {
	size: number;
	mtimeMs: number;
	memory: TraceMemory;
}

// Keyed by trace-file path; reused between polls while the file is unchanged so
// we don't re-parse a large trace every second (mirrors traceFilter's cache).
const cache = new Map<string, CachedMemory>();

// Pull the two fields we need without a full JSON.parse of every line. Memory
// lives in `mem_delta_bytes` (present on exit events / spans when tracelens ran
// with per-function memory attribution enabled); component is the qualified name.
const COMPONENT_RE = /"component"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const MEM_RE = /"mem_delta_bytes"\s*:\s*(-?\d+(?:\.\d+)?)/;

function shortName(component: string): string {
	const dot = component.lastIndexOf('.');
	return dot === -1 ? component : component.slice(dot + 1);
}

/**
 * Aggregates per-function memory from the workspace's tracelens capture.
 *
 * Reads the same trace.jsonl the `tracesummary`/`tracemap` binary probes and
 * sums each component's `mem_delta_bytes`. This is done extension-side because
 * the identification binary's runtime overlay reports latency but not memory —
 * so we attribute memory here and overlay it onto the call tree ourselves.
 *
 * Returns undefined when there's no capture, or when the trace carries no memory
 * attribution at all (tracelens run without `--memory`) — callers then simply
 * omit memory from the view rather than showing zeros.
 */
export function getTraceMemory(workspaceRoot: string): TraceMemory | undefined {
	const traceFile = probeTraceFile(workspaceRoot);
	if (!traceFile) {
		return undefined;
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(traceFile);
	} catch {
		return undefined;
	}
	const cached = cache.get(traceFile);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
		return cached.memory;
	}

	let raw: string;
	try {
		raw = fs.readFileSync(traceFile, 'utf8');
	} catch {
		return undefined;
	}

	const byComponent = new Map<string, MemoryFact>();
	let sawMemField = false;
	for (const line of raw.split('\n')) {
		const s = line.trim();
		if (!s) {
			continue;
		}
		const mm = MEM_RE.exec(s);
		if (!mm) {
			continue; // No memory on this line (e.g. an enter event) — skip.
		}
		sawMemField = true;
		const cm = COMPONENT_RE.exec(s);
		if (!cm) {
			continue;
		}
		const component = cm[1];
		const delta = parseFloat(mm[1]);
		let fact = byComponent.get(component);
		if (!fact) {
			fact = { calls: 0, memBytes: 0 };
			byComponent.set(component, fact);
		}
		fact.calls += 1;
		fact.memBytes += delta;
	}

	// A trace with no mem_delta_bytes at all means memory attribution was off —
	// signal "no memory" so the view hides the axis rather than showing zeros.
	if (!sawMemField) {
		cache.set(traceFile, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			memory: { byComponent: new Map(), byName: new Map() },
		});
		return undefined;
	}

	const byName = new Map<string, string[]>();
	for (const component of byComponent.keys()) {
		const name = shortName(component);
		const list = byName.get(name);
		if (list) {
			list.push(component);
		} else {
			byName.set(name, [component]);
		}
	}

	const memory: TraceMemory = { byComponent, byName };
	cache.set(traceFile, { size: stat.size, mtimeMs: stat.mtimeMs, memory });
	return memory;
}

/**
 * Resolves the memory attributed to one call-tree node. Matches by function name
 * first; when several components share that name (same method on different
 * classes/modules), disambiguates by the node's file-derived module tail. Falls
 * back to summing all same-named components when the module can't be told apart,
 * so a node still shows a sensible total rather than nothing.
 */
export function memoryForNode(
	memory: TraceMemory,
	name: string | undefined,
	file: string | undefined,
): MemoryFact | undefined {
	if (!name) {
		return undefined;
	}
	const components = memory.byName.get(name);
	if (!components || components.length === 0) {
		return undefined;
	}
	if (components.length === 1) {
		return memory.byComponent.get(components[0]);
	}

	// Disambiguate by module: turn "src/pkg/mod.py" into a "pkg.mod"-ish tail and
	// prefer the component whose qualified name contains the file stem.
	if (file) {
		const stem = file
			.replace(/\.[^./]+$/, '') // drop extension
			.replace(/^\.?\/?(src\/)?/, '') // drop leading ./, /, src/
			.replace(/\//g, '.');
		const fileTail = stem.split('.').pop() ?? '';
		const match = components.find((c) => c.includes(stem) || (fileTail && c.includes(fileTail + '.')));
		if (match) {
			return memory.byComponent.get(match);
		}
	}

	// Ambiguous: aggregate across the same-named components.
	let calls = 0;
	let memBytes = 0;
	for (const c of components) {
		const f = memory.byComponent.get(c);
		if (f) {
			calls += f.calls;
			memBytes += f.memBytes;
		}
	}
	return { calls, memBytes };
}
