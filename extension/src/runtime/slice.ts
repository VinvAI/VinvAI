/**
 * D4 — light dynamic backward slice, and D5 — light blast radius.
 *
 * These both walk the *dynamic* call graph the trace already records
 * (parent_component / depth per request), so they describe what actually
 * happened in the run without any re-execution or data-dependence analysis.
 *
 * Backward slice (D4): for a criterion symbol, the chain of callers from the
 * request root down to it, annotated with the argument and return values
 * observed at each frame — i.e. "what flowed in to reach this call". This is the
 * trimmed, observe-only version of a slice: the call path + the values along it,
 * not a full data/control-dependence PDG.
 *
 * Blast radius (D5): the transitive set of symbols upstream (callers) and
 * downstream (callees) of a symbol in the observed graph — "if this is wrong,
 * what could be implicated / affected". Pure reachability over observed edges.
 */
import { ExitRow, EnterRow, TraceCorpus } from './traceStore';

/** One frame on a backward-slice path, with the values observed at that frame. */
export interface SliceFrame {
	component: string;
	depth: number;
	status: 'ok' | 'error';
	duration_ms: number;
	error_type?: string | null;
	/** The captured exception message — the failure's identity, not just its class. */
	error_message?: string | null;
	/** Formatted traceback tail (newer captures only). */
	error_stack?: string | null;
	/** Per-parameter summaries from this frame's enter row (if found). */
	args?: Record<string, unknown>;
	/** Return summary from this frame's exit row. */
	result?: unknown;
}

export interface SlicePath {
	request_id: string;
	/** Root → criterion, so reading top-to-bottom follows the call into the bug. */
	frames: SliceFrame[];
}

export interface SliceResult {
	component: string;
	/** One path per request the criterion ran in (capped). */
	paths: SlicePath[];
	/** True when some requests were omitted by the cap. */
	truncated: boolean;
}

const MAX_PATHS = 12;

/** Index a request's rows for stack reconstruction: (component,depth) → rows. */
function indexRequest(
	corpus: TraceCorpus,
	requestId: string,
): { enters: Map<string, EnterRow[]>; exits: Map<string, ExitRow[]> } {
	const enters = new Map<string, EnterRow[]>();
	const exits = new Map<string, ExitRow[]>();
	const key = (c: string, d: number): string => `${c}@${d}`;
	for (const e of corpus.enters) {
		if (e.request_id !== requestId) {
			continue;
		}
		const k = key(e.component, e.depth);
		(enters.get(k) ?? enters.set(k, []).get(k)!).push(e);
	}
	for (const x of corpus.exits) {
		if (x.request_id !== requestId) {
			continue;
		}
		const k = key(x.component, x.depth);
		(exits.get(k) ?? exits.set(k, []).get(k)!).push(x);
	}
	return { enters, exits };
}

/**
 * Backward slice for `component`: the root→criterion caller chain per request,
 * annotated with the values observed at each frame. Reconstructs the chain by
 * following parent_component/depth links upward (a light, best-effort stack walk
 * rather than a full re-derivation).
 */
export function backwardSlice(corpus: TraceCorpus, component: string): SliceResult {
	const rec = corpus.bySymbol.get(component);
	if (!rec) {
		return { component, paths: [], truncated: false };
	}

	const requests = [...rec.requests];
	const paths: SlicePath[] = [];

	for (const requestId of requests.slice(0, MAX_PATHS)) {
		const { enters, exits } = indexRequest(corpus, requestId);
		const keyOf = (c: string, d: number): string => `${c}@${d}`;

		// Anchor on the criterion's deepest exit in this request (prefer an error).
		const critExits = rec.exits.filter((x) => x.request_id === requestId);
		if (critExits.length === 0) {
			continue;
		}
		const anchor =
			critExits.find((x) => x.status === 'error') ??
			critExits.reduce((a, b) => (b.depth > a.depth ? b : a));

		const frames: SliceFrame[] = [];
		let cur: ExitRow | undefined = anchor;
		const seen = new Set<string>();
		while (cur) {
			const k = keyOf(cur.component, cur.depth);
			if (seen.has(k)) {
				break; // guard against cycles in the reconstructed walk
			}
			seen.add(k);
			const enter = enters.get(k)?.[0];
			frames.push({
				component: cur.component,
				depth: cur.depth,
				status: cur.status,
				duration_ms: cur.duration_ms,
				error_type: cur.error_type ?? undefined,
				error_message: cur.error_message ?? undefined,
				error_stack: cur.error_stack ?? undefined,
				args: enter ? enter.args_summary : undefined,
				result: cur.result_summary ?? undefined,
			});
			if (cur.depth <= 0 || !cur.parent_component) {
				break;
			}
			const parentKey = keyOf(cur.parent_component, cur.depth - 1);
			cur = exits.get(parentKey)?.[0];
		}

		frames.reverse(); // root first
		paths.push({ request_id: requestId, frames });
	}

	return { component, paths, truncated: requests.length > MAX_PATHS };
}

export interface BlastRadius {
	component: string;
	/** Transitive callers (things that could have caused a bad call here). */
	upstream: string[];
	/** Transitive callees (things a bug here could have affected). */
	downstream: string[];
	/** Immediate callers with observed call counts. */
	directCallers: { component: string; calls: number }[];
	/** Immediate callees with observed call counts. */
	directCallees: { component: string; calls: number }[];
}

function reachable(
	edges: Map<string, Map<string, number>>,
	start: string,
	maxDepth: number,
): string[] {
	const out = new Set<string>();
	let frontier = [start];
	for (let d = 0; d < maxDepth && frontier.length; d += 1) {
		const next: string[] = [];
		for (const node of frontier) {
			const neighbors = edges.get(node);
			if (!neighbors) {
				continue;
			}
			for (const n of neighbors.keys()) {
				if (n !== start && !out.has(n)) {
					out.add(n);
					next.push(n);
				}
			}
		}
		frontier = next;
	}
	return [...out];
}

function directEdges(
	edges: Map<string, Map<string, number>>,
	node: string,
): { component: string; calls: number }[] {
	const inner = edges.get(node);
	if (!inner) {
		return [];
	}
	return [...inner.entries()]
		.map(([component, calls]) => ({ component, calls }))
		.sort((a, b) => b.calls - a.calls);
}

/**
 * Blast radius for `component` over the observed dynamic graph: transitive
 * callers (upstream) and callees (downstream), plus the immediate edges with
 * their observed call counts.
 */
export function blastRadius(corpus: TraceCorpus, component: string, maxDepth = 6): BlastRadius {
	return {
		component,
		upstream: reachable(corpus.callers, component, maxDepth),
		downstream: reachable(corpus.callees, component, maxDepth),
		directCallers: directEdges(corpus.callers, component),
		directCallees: directEdges(corpus.callees, component),
	};
}
