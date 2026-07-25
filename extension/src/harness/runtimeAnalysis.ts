/**
 * Cross-session runtime analyses over raw tracelens captures: memory-leak
 * trends and cache (memoization) opportunities. Both feed the same episode
 * mechanism as the latency-hotspot trigger — evidence in, episode out.
 *
 * Design constraints, same as everywhere else in the cockpit:
 * - NO absolute thresholds. "Leaking" and "cacheable" are defined relative to
 *   this app's own traces (robust trend statistics, Pareto-relative
 *   selection), so the same rules work for a 10MB toy and a 10GB service.
 * - Joins are exact: components map to graph rows through the shared
 *   segment-aligned qualname matcher; ambiguous names are skipped, never
 *   guessed.
 *
 * Memory trend: tracelens records `mem_delta_bytes` on every function exit
 * (net RSS-attributed delta across the call). Per capture session we sum a
 * symbol's net delta; a symbol is a LEAK SUSPECT when it retains memory in
 * every observed session (≥3 sessions) and the per-session retention trend
 * is positive under the Theil–Sen estimator — the median of all pairwise
 * slopes, robust to a single noisy session (breakdown point 29%), which a
 * least-squares fit is not.
 *
 * Cache candidates: tracelens records `args_hash` on enter and duration on
 * exit. For a symbol called n times with only d distinct argument hashes,
 * (n−d) calls recomputed something already computed; their share of the
 * symbol's total time is the reclaimable-by-memoization estimate. Symbols
 * whose exits report error or non-empty determinism sources (time, random,
 * I/O reads) are excluded — caching those changes behavior.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
	buildComponentMatcher,
	findTraceFiles,
	type GraphNode,
	type RuntimeOverlay,
} from '../graph/indexGraph';

/** One symbol observed raising errors in the trace, with its evidence line. */
export interface ErrorCluster {
	row: number;
	line: string;
}

/**
 * Is this raised exception the service REJECTING a request on purpose,
 * rather than failing? `raise HTTPException(404, ...)` is FastAPI/Starlette's
 * normal control flow for a 4xx response — a handler that raises it is
 * working exactly as designed. Counting these as defects is the false
 * positive that produced "Fix 17 runtime error clusters" on a healthy
 * template (135 of 185 traced errors were deliberate 4xx raises), handed the
 * agent an unfixable goal, and stalled the episode: you cannot converge on
 * fixing code that is not broken.
 *
 * The rule is deliberately narrow: the exception class must end with
 * `HTTPException` AND its message must carry a parseable status below 500
 * (tracelens records the exception's str(), which for HTTPException starts
 * "404: Not Found"). A 5xx HTTPException, an unparseable message, or any
 * other exception type stays a defect — when unsure, keep it on the list.
 */
export function isExpectedRejection(
	errorType: string | null | undefined,
	errorMessage: string | null | undefined,
): boolean {
	if (!errorType || !/(^|\.)HTTPException$/.test(errorType)) {
		return false;
	}
	const m = /^\s*(\d{3})\b/.exec(errorMessage ?? '');
	if (!m) {
		return false;
	}
	const status = Number(m[1]);
	return status >= 400 && status < 500;
}

/**
 * Scans the runtime overlay for symbols that raised DEFECTS. The returned
 * `signature` is order-independent and content-derived (file:name:errorTypes),
 * so "the same errors as last time" is a computable fact — the auto-trigger
 * uses it to dispatch each distinct failure picture exactly once.
 *
 * Deliberate 4xx rejections (see `isExpectedRejection`) are excluded: they
 * are the service saying "no" correctly, not the service breaking.
 */
export function collectRuntimeErrorClusters(
	nodes: GraphNode[],
	overlay: Record<number, RuntimeOverlay>,
): { clusters: ErrorCluster[]; signature: string } {
	// CURRENT errors only (latest captured run per symbol): a fixed error whose
	// re-run came back clean is retired here — it leaves the issue list AND the
	// signature, so it can neither re-dispatch nor linger as a live problem.
	const clusters = Object.entries(overlay)
		.filter(([, rt]) => rt.current_errors > 0)
		.map(([row, rt]) => {
			const current = rt.failures.filter((f) => f.superseded === null);
			const defects = current.filter(
				(f) => !isExpectedRejection(f.error_type, f.error_message),
			);
			// Older captures carry counts but no failure records — nothing to
			// classify, so keep them defects (when unsure, keep on the list).
			const unclassifiable = current.length === 0;
			const defectCount = unclassifiable
				? rt.current_errors
				: defects.reduce((sum, f) => sum + (f.count ?? 1), 0);
			return { row, rt, defects, defectCount, unclassifiable };
		})
		.filter(({ defects, unclassifiable }) => unclassifiable || defects.length > 0)
		.sort((a, b) => b.defectCount - a.defectCount)
		.map(({ row, rt, defects, defectCount, unclassifiable }) => {
			const n = nodes[Number(row)];
			const types = unclassifiable
				? rt.error_types
				: [...new Set(defects.map((f) => f.error_type))];
			return {
				row: Number(row),
				line: `${n.name} at ${n.file}:${n.start_line} — ${defectCount} error(s): ${types.join(', ')}`,
				sig: `${n.file}:${n.name}:${[...types].sort().join('|')}`,
			};
		});
	return {
		clusters: clusters.map(({ row, line }) => ({ row, line })),
		signature: clusters
			.map((c) => c.sig)
			.sort()
			.join('\n'),
	};
}

/** One latency hotspot from the captured trace, with its share of total time. */
export interface Hotspot {
	row: number;
	name: string;
	file: string;
	line: number;
	calls: number;
	total_ms: number;
	/** Fraction of ALL traced time this symbol consumed (0..1). */
	share: number;
}

/**
 * The Pareto head of runtime cost: symbols in descending total time whose
 * cumulative share covers `coverage` of everything the trace measured. No
 * fixed milliseconds threshold — "expensive" is defined relative to THIS
 * app's own trace, so the same rule works for a 5ms service and a 5s batch
 * job. `cap` bounds the list (packs are budgeted).
 */
export function selectHotspots(
	nodes: GraphNode[],
	overlay: Record<number, RuntimeOverlay>,
	coverage = 0.8,
	cap = 8,
): Hotspot[] {
	const entries = Object.entries(overlay)
		.map(([row, rt]) => ({ row: Number(row), rt }))
		.filter(({ rt }) => rt.total_ms > 0);
	const totalMs = entries.reduce((sum, e) => sum + e.rt.total_ms, 0);
	if (totalMs <= 0) {
		return [];
	}
	entries.sort((a, b) => b.rt.total_ms - a.rt.total_ms);
	const out: Hotspot[] = [];
	let covered = 0;
	for (const { row, rt } of entries) {
		if (out.length >= cap || covered / totalMs >= coverage) {
			break;
		}
		covered += rt.total_ms;
		const n = nodes[row];
		if (!n) {
			continue;
		}
		out.push({
			row,
			name: n.name,
			file: n.file,
			line: n.start_line,
			calls: rt.calls,
			total_ms: rt.total_ms,
			share: rt.total_ms / totalMs,
		});
	}
	return out;
}

/** One symbol retaining memory across sessions, with its trend. */
export interface MemoryLeakSuspect {
	row: number;
	name: string;
	file: string;
	line: number;
	/** Number of capture sessions the symbol appeared in. */
	sessions: number;
	/** Net bytes retained summed over all sessions. */
	total_retained_bytes: number;
	/** Theil–Sen slope: bytes of additional retention per session. */
	slope_bytes_per_session: number;
}

/** One memoization opportunity, with the evidence behind it. */
export interface CacheCandidate {
	row: number;
	name: string;
	file: string;
	line: number;
	calls: number;
	distinct_args: number;
	/** Estimated ms reclaimable by caching: total_ms × (calls−distinct)/calls. */
	reclaimable_ms: number;
	/** Fraction of ALL reclaimable time this symbol accounts for (0..1). */
	share: number;
}

/** Theil–Sen slope: median of pairwise slopes over (index, value) points. */
export function theilSenSlope(values: number[]): number {
	const slopes: number[] = [];
	for (let i = 0; i < values.length; i++) {
		for (let j = i + 1; j < values.length; j++) {
			slopes.push((values[j] - values[i]) / (j - i));
		}
	}
	if (slopes.length === 0) {
		return 0;
	}
	slopes.sort((a, b) => a - b);
	const mid = Math.floor(slopes.length / 2);
	return slopes.length % 2 === 1 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
}

interface SessionTrace {
	/** Session key: the capture directory that groups one run. */
	session: string;
	mtimeMs: number;
	file: string;
}

/** Groups trace files into sessions ordered oldest → newest by mtime. */
function sessionTraces(workspaceRoot: string): SessionTrace[] {
	const out: SessionTrace[] = [];
	for (const file of findTraceFiles(path.join(workspaceRoot, '.vinv', 'captures'))) {
		try {
			const st = fs.statSync(file);
			if (st.size === 0) {
				continue;
			}
			// Session = the trace's own directory (captures/<session>/<service>).
			out.push({ session: path.dirname(file), mtimeMs: st.mtimeMs, file });
		} catch {
			// Vanished between listing and stat — skip.
		}
	}
	return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

interface ExitEvent {
	event?: string;
	component?: string;
	mem_delta_bytes?: number | string;
	duration_ms?: number | string;
	error_type?: string | null;
	determinism_sources?: unknown[];
	args_hash?: string;
	/** Request-tree fields (present on every raw-capture event). */
	request_id?: string;
	thread_id?: number | string;
	ts?: string;
	side_effects?: unknown[];
}

function* eventsOf(file: string): Generator<ExitEvent> {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return;
	}
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			yield JSON.parse(line) as ExitEvent;
		} catch {
			// Torn tail line — skip.
		}
	}
}

/**
 * Per-symbol memory retention per session → leak suspects. `minSessions` is
 * the statistical floor for a trend (3 points = 3 pairwise slopes), not a
 * tunable business rule.
 */
export function collectMemoryTrends(
	workspaceRoot: string,
	nodes: GraphNode[],
	minSessions = 3,
): MemoryLeakSuspect[] {
	const rowsFor = buildComponentMatcher(nodes);
	// row -> session -> net bytes
	const perRow = new Map<number, Map<string, number>>();
	const sessions = sessionTraces(workspaceRoot);
	for (const s of sessions) {
		for (const ev of eventsOf(s.file)) {
			if (ev.event !== 'exit' || !ev.component) {
				continue;
			}
			const bytes = Number(ev.mem_delta_bytes ?? 0) || 0;
			if (bytes === 0) {
				continue;
			}
			const rows = rowsFor(ev.component);
			if (rows.length !== 1) {
				continue; // ambiguous joins never contribute evidence
			}
			const bySession = perRow.get(rows[0]) ?? new Map<string, number>();
			bySession.set(s.session, (bySession.get(s.session) ?? 0) + bytes);
			perRow.set(rows[0], bySession);
		}
	}
	const sessionOrder = [...new Set(sessions.map((s) => s.session))];
	const suspects: MemoryLeakSuspect[] = [];
	for (const [row, bySession] of perRow) {
		const series = sessionOrder
			.filter((s) => bySession.has(s))
			.map((s) => bySession.get(s) as number);
		if (series.length < minSessions) {
			continue;
		}
		// Retention in EVERY observed session + positive robust trend: memory
		// that comes back and grows. A symbol that frees in any session is a
		// working allocator, not a leak.
		if (series.some((v) => v <= 0)) {
			continue;
		}
		const slope = theilSenSlope(series);
		if (slope <= 0) {
			continue;
		}
		const n = nodes[row];
		suspects.push({
			row,
			name: n.name,
			file: n.file,
			line: n.start_line,
			sessions: series.length,
			total_retained_bytes: series.reduce((a, b) => a + b, 0),
			slope_bytes_per_session: slope,
		});
	}
	return suspects.sort((a, b) => b.total_retained_bytes - a.total_retained_bytes);
}

/**
 * Memoization opportunities from argument-hash duplication. Selection is the
 * Pareto head of reclaimable time (relative to this trace), capped for pack
 * budgets — the exact policy the latency-hotspot trigger uses.
 */
export function collectCacheCandidates(
	workspaceRoot: string,
	nodes: GraphNode[],
	coverage = 0.8,
	cap = 8,
): CacheCandidate[] {
	const rowsFor = buildComponentMatcher(nodes);
	interface Acc {
		calls: number;
		args: Set<string>;
		totalMs: number;
		impure: boolean;
	}
	const perRow = new Map<number, Acc>();
	for (const s of sessionTraces(workspaceRoot)) {
		for (const ev of eventsOf(s.file)) {
			if (!ev.component) {
				continue;
			}
			const rows = rowsFor(ev.component);
			if (rows.length !== 1) {
				continue;
			}
			const acc = perRow.get(rows[0]) ?? {
				calls: 0,
				args: new Set<string>(),
				totalMs: 0,
				impure: false,
			};
			if (ev.event === 'enter' && typeof ev.args_hash === 'string') {
				acc.calls += 1;
				acc.args.add(ev.args_hash);
			} else if (ev.event === 'exit') {
				acc.totalMs += Number(ev.duration_ms ?? 0) || 0;
				const errored = ev.error_type && ev.error_type !== 'None';
				const nondeterministic =
					Array.isArray(ev.determinism_sources) && ev.determinism_sources.length > 0;
				if (errored || nondeterministic) {
					acc.impure = true; // caching would change behavior — never suggest it
				}
			}
			perRow.set(rows[0], acc);
		}
	}
	const raw: CacheCandidate[] = [];
	for (const [row, acc] of perRow) {
		const dup = acc.calls - acc.args.size;
		if (acc.impure || acc.calls === 0 || dup <= 0 || acc.totalMs <= 0) {
			continue;
		}
		const n = nodes[row];
		raw.push({
			row,
			name: n.name,
			file: n.file,
			line: n.start_line,
			calls: acc.calls,
			distinct_args: acc.args.size,
			reclaimable_ms: (acc.totalMs * dup) / acc.calls,
			share: 0,
		});
	}
	const total = raw.reduce((s, c) => s + c.reclaimable_ms, 0);
	if (total <= 0) {
		return [];
	}
	raw.sort((a, b) => b.reclaimable_ms - a.reclaimable_ms);
	const out: CacheCandidate[] = [];
	let covered = 0;
	for (const c of raw) {
		if (out.length >= cap || covered / total >= coverage) {
			break;
		}
		covered += c.reclaimable_ms;
		out.push({ ...c, share: c.reclaimable_ms / total });
	}
	return out;
}

/** One symbol's cost in ONE capture session — the unit the proof loop diffs. */
export interface SymbolSessionTiming {
	/** Capture directory grouping this run. */
	session: string;
	/** Wall time this symbol accumulated in this session (sum of exit durations). */
	total_ms: number;
	/** Completed calls (exits) observed for this symbol in this session. */
	calls: number;
}

/**
 * Per-symbol wall time and call count of SUCCESSFUL calls, split BY SESSION and
 * ordered oldest → newest. Calls that raised are excluded — their time measures
 * a failure, not optimizable latency. The runtime overlay (loadRuntimeOverlay)
 * reports LIFETIME totals that only ever grow, so it cannot answer "did this
 * symbol get faster after the fix"; the predicted→proven loop needs per-session
 * cost to diff a before-run against an after-run. Rows join through the same
 * segment-aligned qualname matcher as every other cross-session analysis;
 * ambiguous names never contribute (a mis-joined timing would corrupt the
 * measured delta).
 */
export function collectSymbolTimings(
	workspaceRoot: string,
	nodes: GraphNode[],
): Map<number, SymbolSessionTiming[]> {
	const rowsFor = buildComponentMatcher(nodes);
	// row -> session -> {ms, calls}
	const perRow = new Map<number, Map<string, { ms: number; calls: number }>>();
	const sessions = sessionTraces(workspaceRoot);
	// Session identity for the proof loop must change when a run is RE-TRACED.
	// A service commonly overwrites the same capture directory in place (same
	// dirname, new trace.jsonl), so the directory alone cannot tell "the fix's
	// after-run" from "the same run I already measured" — the before/after diff
	// would never fire and the candidate would stick on 'dispatched' forever.
	// Folding the trace mtime into the key makes every genuine re-trace a new
	// session, so reconcileOutcome sees the after-run the moment it lands.
	const keyOf = (s: SessionTrace): string => `${s.session}@${Math.round(s.mtimeMs)}`;
	const sessionOrder = [...new Set(sessions.map(keyOf))];
	for (const s of sessions) {
		const sessionKey = keyOf(s);
		for (const ev of eventsOf(s.file)) {
			// Exit carries the duration AND marks one completed call — counting
			// exits (not enters) keeps ms and calls on the same event so a torn
			// enter/exit pair never inflates one without the other.
			if (ev.event !== 'exit' || !ev.component) {
				continue;
			}
			// Skip calls that RAISED. A function's time on a failing call measures
			// the failure/timeout (a missing token, an unreachable host), not
			// optimizable work — treating it as latency flags an error path as a
			// hotspot and hands the agent an un-optimizable target. Errors are the
			// runtime-error trigger's job; the optimizer only ranks SUCCESSFUL time.
			const errored = ev.error_type && ev.error_type !== 'None';
			if (errored) {
				continue;
			}
			const rows = rowsFor(ev.component);
			if (rows.length !== 1) {
				continue; // ambiguous joins never contribute evidence
			}
			const bySession = perRow.get(rows[0]) ?? new Map<string, { ms: number; calls: number }>();
			const acc = bySession.get(sessionKey) ?? { ms: 0, calls: 0 };
			acc.ms += Number(ev.duration_ms ?? 0) || 0;
			acc.calls += 1;
			bySession.set(sessionKey, acc);
			perRow.set(rows[0], bySession);
		}
	}
	const out = new Map<number, SymbolSessionTiming[]>();
	for (const [row, bySession] of perRow) {
		const ordered = sessionOrder
			.filter((sess) => bySession.has(sess))
			.map((sess) => {
				const acc = bySession.get(sess) as { ms: number; calls: number };
				return { session: sess, total_ms: acc.ms, calls: acc.calls };
			});
		if (ordered.length > 0) {
			out.set(row, ordered);
		}
	}
	return out;
}

/**
 * One call in the reconstructed per-request call tree. Unlike the aggregated
 * timings, spans preserve STRUCTURE (who called whom, in what order, for how
 * long), which is what the request-shaped detectors need: N+1 (a callee
 * repeated under one parent), staircase (independent I/O children run
 * sequentially), and self-time / critical path (time spent IN a symbol vs its
 * callees).
 */
export interface TraceSpan {
	/** Resolved graph row, or null when the component didn't join a symbol. */
	row: number | null;
	component: string;
	/** Wall-clock start (ms since epoch) from the enter event. */
	startMs: number;
	/** Duration from the exit event. */
	durationMs: number;
	/** This call raised. */
	errored: boolean;
	/** The exit recorded I/O side effects or I/O determinism sources. */
	io: boolean;
	children: TraceSpan[];
}

function parseTs(ts: string | undefined): number {
	if (typeof ts !== 'string') {
		return 0;
	}
	const t = Date.parse(ts);
	return Number.isFinite(t) ? t : 0;
}

function isIoExit(ev: ExitEvent): boolean {
	if (Array.isArray(ev.side_effects) && ev.side_effects.length > 0) {
		return true;
	}
	return (
		Array.isArray(ev.determinism_sources) &&
		ev.determinism_sources.some((d) => /io|net|read|socket|http|file|db|query/i.test(String(d)))
	);
}

/**
 * Reconstructs the per-request call forest from the raw captures. Events are
 * paired enter→exit on a stack keyed by (request_id, thread_id); a missing exit
 * truncates cleanly rather than corrupting the tree. Returns every ROOT span
 * across all sessions (children hang off their parents). Rows are joined with
 * the same segment-aligned matcher as everywhere else; an unjoined component
 * keeps `row: null` so its time still counts toward a parent's structure.
 */
export function collectRequestSpans(workspaceRoot: string, nodes: GraphNode[]): TraceSpan[] {
	const rowsFor = buildComponentMatcher(nodes);
	const resolve = (component: string): number | null => {
		const rows = rowsFor(component);
		return rows.length === 1 ? rows[0] : null;
	};
	const roots: TraceSpan[] = [];
	for (const s of sessionTraces(workspaceRoot)) {
		const stacks = new Map<string, TraceSpan[]>();
		for (const ev of eventsOf(s.file)) {
			if (!ev.component) {
				continue;
			}
			const key = `${ev.request_id ?? ''} ${ev.thread_id ?? ''}`;
			const stack = stacks.get(key) ?? [];
			if (ev.event === 'enter') {
				const span: TraceSpan = {
					row: resolve(ev.component),
					component: ev.component,
					startMs: parseTs(ev.ts),
					durationMs: 0,
					errored: false,
					io: false,
					children: [],
				};
				const parent = stack[stack.length - 1];
				if (parent) {
					parent.children.push(span);
				} else {
					roots.push(span);
				}
				stack.push(span);
				stacks.set(key, stack);
			} else if (ev.event === 'exit') {
				// Match the nearest open span of the same component from the top;
				// truncate above it so a dropped exit can't wedge the stack.
				for (let i = stack.length - 1; i >= 0; i -= 1) {
					if (stack[i].component === ev.component) {
						const span = stack[i];
						span.durationMs = Number(ev.duration_ms ?? 0) || 0;
						span.errored = Boolean(ev.error_type && ev.error_type !== 'None');
						span.io = isIoExit(ev);
						stack.length = i;
						break;
					}
				}
				stacks.set(key, stack);
			}
		}
	}
	return roots;
}
