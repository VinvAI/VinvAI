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
	/** BLAKE2b of the return value, on exit events. */
	result_hash?: string;
	/** Shape of the return value, on exit events ('NoneType' for None). */
	result_schema?: string;
	/** wall − cpu time for this call (tracelens ≥ calibration era) — ground
	 * truth for "this call WAITED" vs the regex/side-effect heuristics. */
	blocked_ms?: number | string;
	/** Request-tree fields (present on every raw-capture event). */
	request_id?: string;
	thread_id?: number | string;
	ts?: string;
	side_effects?: unknown[];
	/** Call depth within the request (string in raw captures). */
	depth?: number | string;
	/** The caller's component ('None' at the root). */
	parent_component?: string;
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
 * Import roots that mark a file as security-sensitive. This is a structural
 * signal (what the file imports), not a symbol name list: crypto, password
 * hashing, token signing, and secret generation are DESIGNED to be slow or
 * nondeterministic, so "optimizing" them (caching credentials, cutting rounds)
 * weakens security rather than saving waste.
 */
// NOTE: hashlib is deliberately absent — it is overwhelmingly used for
// CONTENT hashing (checksums, cache keys, ids), and including it guarded half
// of real codebases. Password hashing in practice arrives via the dedicated
// libraries below.
const SECURITY_IMPORT_ROOTS = new Set([
	'hmac',
	'secrets',
	'bcrypt',
	'passlib',
	'pwdlib',
	'argon2',
	'scrypt',
	'jwt',
	'jose',
	'cryptography',
	'nacl',
	'Crypto',
	'Cryptodome',
	'oauthlib',
	'authlib',
	'itsdangerous',
]);

/** Parses the module paths a Python source imports (import X / from X import). */
function importedModules(source: string): string[] {
	const out: string[] = [];
	for (const line of source.split('\n')) {
		const m = /^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/.exec(line);
		if (m) {
			out.push(m[1]);
		}
	}
	return out;
}

/**
 * Rows whose FILE is security-sensitive, mapped to a human-readable reason.
 * Direct: the file imports a crypto/credential module (SECURITY_IMPORT_ROOTS).
 * Transitive: the file imports another repo module that is itself guarded —
 * propagated to a fixpoint, so `crud.authenticate` inherits the guard from
 * `core.security` without any function-name list. Consumers use this to keep
 * such symbols out of cache advice and to thread the reason into any episode
 * prompt that still touches them (a bcrypt hotspot is real — the fix just must
 * not weaken it).
 */
export function securityGuardReasons(
	workspaceRoot: string,
	nodes: GraphNode[],
): Map<number, string> {
	const files = new Map<string, number[]>();
	for (let row = 0; row < nodes.length; row += 1) {
		const f = nodes[row]?.file;
		if (f) {
			const list = files.get(f) ?? [];
			list.push(row);
			files.set(f, list);
		}
	}
	const importsOf = new Map<string, string[]>();
	for (const f of files.keys()) {
		try {
			importsOf.set(f, importedModules(fs.readFileSync(path.join(workspaceRoot, f), 'utf8')));
		} catch {
			importsOf.set(f, []);
		}
	}
	const dotted = (f: string): string => f.replace(/\.py$/, '').split('/').join('.');
	const reasons = new Map<string, string>();
	for (const [f, mods] of importsOf) {
		const hits = [...new Set(mods.map((m) => m.split('.')[0]).filter((r) => SECURITY_IMPORT_ROOTS.has(r)))];
		if (hits.length > 0) {
			reasons.set(f, `imports ${hits.join(', ')} — crypto/credential code is intentionally slow`);
		}
	}
	// Propagate ONE hop through intra-repo imports: a file importing a
	// DIRECTLY-guarded module (crud.py importing core.security) inherits the
	// guard, but the chain stops there — a fixpoint walk guarded half of a real
	// codebase via shared plumbing modules, which silently suppresses honest
	// candidates. One hop plus the functional-dependence gate is the balance.
	const direct = new Map(reasons);
	for (const [f, mods] of importsOf) {
		if (reasons.has(f)) {
			continue;
		}
		for (const m of mods) {
			let found: string | undefined;
			for (const g of direct.keys()) {
				const d = dotted(g);
				if (d === m || d.endsWith(`.${m}`) || m.endsWith(`.${d}`)) {
					found = `imports ${m}, which is security-sensitive (${direct.get(g)})`;
					break;
				}
			}
			if (found) {
				reasons.set(f, found);
				break;
			}
		}
	}
	const out = new Map<number, string>();
	for (const [f, reason] of reasons) {
		for (const row of files.get(f) ?? []) {
			out.set(row, reason);
		}
	}
	return out;
}

/**
 * Memoization opportunities from argument-hash duplication. Selection is the
 * Pareto head of reclaimable time (relative to this trace), capped for pack
 * budgets — the exact policy the latency-hotspot trigger uses.
 *
 * Two soundness gates, both learned from real traces rather than assumed:
 *   • Functional dependence — a symbol is cacheable only when, for EVERY
 *     argument hash observed more than once, the result hash is CONSTANT
 *     (same input → same output, observed, never inferred). This kills the
 *     false candidates arg-hash collapsing creates (all non-primitive args of
 *     one type hash identically, so 62 distinct requests can masquerade as one
 *     repeated input) and salted/impure functions whose output varies.
 *   • Security guard — symbols in files importing crypto/credential modules
 *     (directly or one intra-repo hop away) are never offered as cache
 *     candidates: their cost is intentional (bcrypt), and caching credentials
 *     is a vulnerability, not an optimization.
 *   • None-return gate — a duplicated call whose every observed return is None
 *     contributes nothing reclaimable: the work's real output is a side effect
 *     the tracer didn't see, and there is no value a cache could serve.
 * reclaimable_ms is measured per duplicated argument group (its observed time
 * minus one representative call) and capped at the NEWEST session's total for
 * the symbol — you cannot reclaim more than the symbol currently costs.
 */
export function collectCacheCandidates(
	workspaceRoot: string,
	nodes: GraphNode[],
	coverage = 0.8,
	cap = 8,
): CacheCandidate[] {
	const rowsFor = buildComponentMatcher(nodes);
	const guarded = securityGuardReasons(workspaceRoot, nodes);
	interface ArgGroup {
		count: number;
		ms: number;
		results: Set<string>;
		unknownResult: boolean;
		/** Every observed return was None — the work's real output is a side
		 * effect the tracer didn't record (the embedder's do_POST writes to a
		 * socket and returns None), so there is no value to memoize. */
		noneOnly: boolean;
	}
	interface Acc {
		calls: number;
		args: Map<string, ArgGroup>;
		impure: boolean;
		newestSessionMs: number;
	}
	const perRow = new Map<number, Acc>();
	for (const s of sessionTraces(workspaceRoot)) {
		const sessionMs = new Map<number, number>();
		// Pair enter→exit per (request, thread, component, depth) so each exit's
		// duration and result_hash join the args_hash of ITS OWN call.
		const open = new Map<string, string[]>();
		for (const ev of eventsOf(s.file)) {
			if (!ev.component) {
				continue;
			}
			const rows = rowsFor(ev.component);
			if (rows.length !== 1) {
				continue;
			}
			const row = rows[0];
			const pairKey = `${ev.request_id ?? ''}\u0000${ev.thread_id ?? ''}\u0000${ev.component}\u0000${ev.depth ?? ''}`;
			if (ev.event === 'enter') {
				const st = open.get(pairKey) ?? [];
				st.push(typeof ev.args_hash === 'string' ? ev.args_hash : '');
				open.set(pairKey, st);
			} else if (ev.event === 'exit') {
				const acc = perRow.get(row) ?? {
					calls: 0,
					args: new Map<string, ArgGroup>(),
					impure: false,
					newestSessionMs: 0,
				};
				const ah = open.get(pairKey)?.pop() ?? '';
				const ms = Number(ev.duration_ms ?? 0) || 0;
				sessionMs.set(row, (sessionMs.get(row) ?? 0) + ms);
				const errored = ev.error_type && ev.error_type !== 'None';
				const nondeterministic =
					Array.isArray(ev.determinism_sources) && ev.determinism_sources.length > 0;
				if (errored || nondeterministic) {
					acc.impure = true; // caching would change behavior — never suggest it
				}
				if (ah) {
					acc.calls += 1;
					const g = acc.args.get(ah) ?? {
						count: 0,
						ms: 0,
						results: new Set<string>(),
						unknownResult: false,
						noneOnly: true,
					};
					g.count += 1;
					g.ms += ms;
					if (typeof ev.result_hash === 'string' && ev.result_hash !== '') {
						g.results.add(ev.result_hash);
					} else {
						g.unknownResult = true;
					}
					if (ev.result_schema !== 'NoneType') {
						g.noneOnly = false;
					}
					acc.args.set(ah, g);
				}
				perRow.set(row, acc);
			}
		}
		// The last session in oldest→newest order that observed the row wins.
		for (const [row, ms] of sessionMs) {
			const acc = perRow.get(row);
			if (acc && ms > 0) {
				acc.newestSessionMs = ms;
			}
		}
	}
	const raw: CacheCandidate[] = [];
	for (const [row, acc] of perRow) {
		if (acc.impure || acc.calls === 0 || guarded.has(row)) {
			continue;
		}
		let dup = 0;
		let dupMs = 0;
		let functional = true;
		for (const g of acc.args.values()) {
			if (g.count <= 1) {
				continue;
			}
			// A repeated input whose output varied (or was never recorded) is not
			// a caching opportunity — same input did NOT produce the same output.
			if (g.unknownResult || g.results.size !== 1) {
				functional = false;
				break;
			}
			// A None-returning group has no value to reuse: its work is effects.
			if (g.noneOnly) {
				continue;
			}
			dup += g.count - 1;
			dupMs += (g.ms * (g.count - 1)) / g.count;
		}
		if (!functional || dup <= 0 || dupMs <= 0) {
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
			reclaimable_ms: Math.min(dupMs, acc.newestSessionMs > 0 ? acc.newestSessionMs : dupMs),
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
	// Ground truth first: a call that spent the MAJORITY of its wall time off
	// the CPU (blocked_ms = wall − cpu, exported by calibrated tracelens) was
	// waiting — no allowlist can beat the clock. Heuristics remain the
	// fallback for traces predating the field.
	const blocked = Number(ev.blocked_ms);
	const wall = Number(ev.duration_ms);
	if (Number.isFinite(blocked) && Number.isFinite(wall) && wall > 0) {
		return blocked / wall > 0.5;
	}
	if (Array.isArray(ev.side_effects) && ev.side_effects.length > 0) {
		return true;
	}
	return (
		Array.isArray(ev.determinism_sources) &&
		ev.determinism_sources.some((d) => /io|net|read|socket|http|file|db|query/i.test(String(d)))
	);
}

/** One paired enter/exit with the tree fields needed for structural attachment. */
interface PairedSpan {
	span: TraceSpan;
	depth: number;
	parent: string;
	/** Pairing order, as a stable tiebreak when timestamps collide. */
	seq: number;
}

/** Clock-granularity slack for interval-containment checks (raw ts is ms). */
const SPAN_ATTACH_EPS_MS = 1.5;

/**
 * Reconstructs the per-request call forest from the raw captures. The exporter
 * writes a span's enter+exit lines together at span END, so children's pairs
 * precede their parent's and LINE ORDER CANNOT DRIVE NESTING — a real trace
 * assembled by line order degenerates into thousands of one-node roots. Instead
 * events are paired enter→exit per (request, thread, component, depth), then
 * attached structurally from the tree fields present on every event: a span's
 * parent is the latest depth−1 span with component === parent_component whose
 * [start, end] interval contains the child's start (± clock granularity). This
 * survives end-time ordering and asyncio interleaving; a span whose parent pair
 * was dropped surfaces as a root rather than corrupting a sibling. Traces
 * predating the depth/parent_component fields fall back to line-order pairing.
 * Rows are joined with the same segment-aligned matcher as everywhere else; an
 * unjoined component keeps `row: null` so its time still counts toward a
 * parent's structure.
 */
export function collectRequestSpans(workspaceRoot: string, nodes: GraphNode[]): TraceSpan[] {
	const rowsFor = buildComponentMatcher(nodes);
	const resolve = (component: string): number | null => {
		const rows = rowsFor(component);
		return rows.length === 1 ? rows[0] : null;
	};
	const roots: TraceSpan[] = [];
	for (const s of sessionTraces(workspaceRoot)) {
		const events: ExitEvent[] = [];
		for (const ev of eventsOf(s.file)) {
			if (ev.component && (ev.event === 'enter' || ev.event === 'exit')) {
				events.push(ev);
			}
		}
		const hasTreeFields = events.some(
			(ev) => ev.event === 'enter' && Number.isFinite(Number(ev.depth)),
		);
		if (!hasTreeFields) {
			assembleByLineOrder(events, resolve, roots);
			continue;
		}

		// Pair enter→exit per (request, thread, component, depth). Both lines of
		// one span carry identical values for all four, and nested same-component
		// recursion still pairs correctly because the stack is LIFO per key.
		const open = new Map<string, PairedSpan[]>();
		const perRequest = new Map<string, PairedSpan[]>();
		let seq = 0;
		for (const ev of events) {
			const depth = Number(ev.depth);
			const req = String(ev.request_id ?? '');
			const pairKey = `${req}\u0000${ev.thread_id ?? ''}\u0000${ev.component}\u0000${depth}`;
			if (ev.event === 'enter') {
				const pending: PairedSpan = {
					span: {
						row: resolve(ev.component ?? ''),
						component: ev.component ?? '',
						startMs: parseTs(ev.ts),
						durationMs: 0,
						errored: false,
						io: false,
						children: [],
					},
					depth: Number.isFinite(depth) ? depth : 0,
					parent: String(ev.parent_component ?? ''),
					seq: 0,
				};
				const st = open.get(pairKey) ?? [];
				st.push(pending);
				open.set(pairKey, st);
			} else {
				const st = open.get(pairKey);
				const p = st?.pop();
				if (!p) {
					continue; // exit without a matching enter — drop, don't guess
				}
				p.span.durationMs = Number(ev.duration_ms ?? 0) || 0;
				p.span.errored = Boolean(ev.error_type && ev.error_type !== 'None');
				p.span.io = isIoExit(ev);
				p.seq = seq++;
				const list = perRequest.get(req) ?? [];
				list.push(p);
				perRequest.set(req, list);
			}
		}
		// Unmatched enters (no exit ever arrived) carry no duration; dropping
		// them mirrors the truncation the line-order path applied.

		// Attach children to parents in start order: a parent starts no later
		// than its child, so by the time a child is placed its parent is already
		// in the by-depth index. Scanning candidates newest-first picks the
		// innermost concurrent instance when several same-component parents
		// overlap (asyncio gather of the same coroutine).
		for (const list of perRequest.values()) {
			list.sort(
				(a, b) => a.span.startMs - b.span.startMs || a.depth - b.depth || a.seq - b.seq,
			);
			const byDepth = new Map<number, PairedSpan[]>();
			for (const item of list) {
				let attached = false;
				if (item.depth > 0) {
					const cands = byDepth.get(item.depth - 1);
					if (cands) {
						for (let i = cands.length - 1; i >= 0; i -= 1) {
							const c = cands[i];
							if (c.span.component !== item.parent) {
								continue;
							}
							const startsBefore = c.span.startMs <= item.span.startMs + SPAN_ATTACH_EPS_MS;
							const coversStart =
								c.span.startMs + c.span.durationMs + SPAN_ATTACH_EPS_MS >= item.span.startMs;
							if (startsBefore && coversStart) {
								c.span.children.push(item.span);
								attached = true;
								break;
							}
						}
					}
				}
				if (!attached) {
					roots.push(item.span);
				}
				const d = byDepth.get(item.depth) ?? [];
				d.push(item);
				byDepth.set(item.depth, d);
			}
		}
	}
	return roots;
}

/**
 * Legacy assembly for traces that predate the depth/parent_component fields:
 * enter→exit paired on a LIFO stack keyed by (request_id, thread_id). Only
 * valid when the exporter wrote events in call order.
 */
function assembleByLineOrder(
	events: ExitEvent[],
	resolve: (component: string) => number | null,
	roots: TraceSpan[],
): void {
	const stacks = new Map<string, TraceSpan[]>();
	for (const ev of events) {
		const key = `${ev.request_id ?? ''}\u0000${ev.thread_id ?? ''}`;
		const stack = stacks.get(key) ?? [];
		if (ev.event === 'enter') {
			const span: TraceSpan = {
				row: resolve(ev.component ?? ''),
				component: ev.component ?? '',
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
