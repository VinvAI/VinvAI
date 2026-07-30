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
 * Is this raised exception one a CALLER absorbed, rather than a failure that
 * escaped? `contained === true` means the capture observed an ancestor frame
 * exiting `ok` while this frame exited with an error — i.e. a `try/except`
 * upstream handled it, deliberately, and the process carried on.
 *
 * This is the same false-positive class as `isExpectedRejection`, one level
 * more general. The case that motivated it: the embedder binds its port as a
 * machine-wide single-instance lock, so a second `serve` raises
 * `OSError(EADDRINUSE)` inside `make_server`, and `_cmd_serve` catches it,
 * prints "reusing it rather than loading a second copy of the model", and
 * returns 0 (embedder/src/vinv_embedder/cli.py:91). The trace records exactly
 * that shape — `make_server` exits error at depth 2, `_cmd_serve` exits ok at
 * depth 1, `main` exits ok at depth 0 — yet it was clustered as a defect,
 * dispatched as a fix episode, and the harness agent correctly disputed the
 * premise ("the intentional single-instance bind lock, not an unhandled
 * failure"). The episode aborted at reward -1.00. Handled control flow must
 * never reach the episode queue.
 *
 * `null`/`undefined` (no ancestor exit observed) is NOT treated as handled —
 * same "when unsure, keep it on the list" rule as everywhere else here.
 */
export function isHandledInternally(contained: boolean | null | undefined): boolean {
	return contained === true;
}

/**
 * Scans the runtime overlay for symbols that raised DEFECTS. The returned
 * `signature` is order-independent and content-derived (file:name:errorTypes),
 * so "the same errors as last time" is a computable fact — the auto-trigger
 * uses it to dispatch each distinct failure picture exactly once.
 *
 * Two classes of non-defect are excluded, both evidence-derived and both
 * narrow: deliberate 4xx rejections (see `isExpectedRejection`) are the
 * service saying "no" correctly, and exceptions an upstream frame caught (see
 * `isHandledInternally`) never escaped at all. Everything else stays a defect.
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
				(f) =>
					!isExpectedRejection(f.error_type, f.error_message) &&
					!isHandledInternally(f.contained),
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

/**
 * Session identity shared by every cross-session collector: `<dir>@<mtime>`.
 * A session's identity must change when a run is RE-TRACED: services commonly
 * overwrite the same capture directory in place (same dirname, new
 * trace.jsonl), so the directory alone cannot tell "the fix's after-run" from
 * "the same run already measured". Folding the trace mtime in makes every
 * genuine re-trace a new session (reconcileOutcome sees the after-run the
 * moment it lands), and every collector keying on this joins exactly.
 */
function sessionKeyOf(s: SessionTrace): string {
	return `${s.session}@${Math.round(s.mtimeMs)}`;
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
/**
 * Fraction of a request root's duration at or above which a frame's time IS the
 * request/process lifetime rather than its own work.
 *
 * Not an absolute millisecond threshold — it is a ratio against THIS app's own
 * request roots, so it holds for a 5ms service and a 5s batch alike (the same
 * rule the rest of this module follows). Measured on the embedder capture, the
 * separation is wide: `main` (depth 0), `do_GET` (depth 0) and `_cmd_serve` (the
 * pass-through under main) all sit at 100.00% of their root, while the slowest
 * frame that does REAL work — `EmbeddingEngine.load`, a sentence-transformer
 * load — is 90.29%, and a request handler's `_send_json` is 55.69%. 0.99 keeps a
 * ~9.7-point margin above the highest genuine worker.
 */
const LIFETIME_SHARE = 0.99;

/**
 * Rows whose observed duration measures PROCESS/REQUEST LIFETIME, not work —
 * mapped to a human-readable reason.
 *
 * For a process or request root, `total_ms` is wall-clock lifetime: the program
 * was running. Every duration-based heuristic misreads that, and the misreads
 * are dispatchable. Observed live on this repo before this gate existed: the
 * cache board offered `main` and `_cmd_serve` at "~25101ms is cacheable —
 * recomputes identical inputs (1 of 2 calls repeat)", i.e. memoize the CLI entry
 * point of a SERVER, and the hotspot board ranked the same two symbols #1 and #2
 * at 31.2% each — 62.4% of "traced runtime" being "the process was running" —
 * with a one-click optimize episode on both. The per-call rule read worst of all:
 * "_cmd_serve 10738.8ms per call (self) — 148428.8x the typical symbol;
 * unexpectedly slow for the work it does." A serve loop is SUPPOSED to take the
 * whole run.
 *
 * None of the three existing soundness gates fires on these: functional
 * dependence HOLDS (same argv, same exit 0, every time), no crypto/credential
 * import is on the path, and `main` returns 0 rather than None.
 *
 * A row qualifies when it was observed at depth 0 (its duration is the lifetime
 * by definition), or when its duration reaches LIFETIME_SHARE of the depth-0
 * root of the same request — a pass-through frame that spans the whole run.
 *
 * Deliberately NOT "any once-per-request child of a root": in a web service most
 * of a handler's real work is exactly that shape. On this capture that rule would
 * have wrongly excluded `_send_json`, `queue_depth`, `ready` and `warming`, all
 * legitimate optimization targets. The discriminator is the SHARE, not the
 * parent.
 *
 * Excluded from cache candidates and from duration-ranked hotspots — the two
 * surfaces that dispatch work. Coverage, the call tree and `why_did_this_run`
 * keep them, because there lifetime is the correct and useful reading. Same
 * discipline as the containment fix: stop CLASSIFYING it as waste, do not hide it.
 */
export function lifetimeFrames(
	workspaceRoot: string,
	nodes: GraphNode[],
): Map<number, string> {
	const rowsFor = buildComponentMatcher(nodes);
	const out = new Map<number, string>();
	// Per request: the depth-0 root's duration, and per component the LONGEST
	// single call plus how many times it ran.
	//
	// Longest-single-call, never the sum. A pass-through is one call that wraps
	// the run; summing cannot tell that apart from a hot function called many
	// times, because both reach 100% of the root. Under a sum, `embed_chunk`
	// called 500 times at 4ms inside a 2000ms root reads as "spans 100% of its
	// request root" and is excluded from cache candidates AND from the per-call,
	// fanout and staircase kinds — losing the N+1 detector its single best
	// target. Recursive frames are worse still: each level's duration includes
	// its children, so a 10-deep recursion sums past 1000% and every recursive
	// function in the workspace is exempted from optimization.
	const rootMs = new Map<string, number>();
	const compMs = new Map<string, Map<string, { maxMs: number; calls: number }>>();
	const depthZero = new Set<string>();
	for (const file of findTraceFiles(path.join(workspaceRoot, '.vinv', 'captures'))) {
		for (const ev of eventsOf(file)) {
			if (ev.event !== 'exit' || !ev.component) {
				continue;
			}
			const rid = `${file}\u0000${ev.request_id ?? ''}`;
			const ms = Number(ev.duration_ms ?? 0) || 0;
			// depth is a string in raw captures — compare numerically.
			if (Number(ev.depth ?? -1) === 0) {
				depthZero.add(ev.component);
				rootMs.set(rid, Math.max(rootMs.get(rid) ?? 0, ms));
			}
			const byComp = compMs.get(rid) ?? new Map<string, { maxMs: number; calls: number }>();
			const acc = byComp.get(ev.component);
			byComp.set(
				ev.component,
				acc
					? { maxMs: Math.max(acc.maxMs, ms), calls: acc.calls + 1 }
					: { maxMs: ms, calls: 1 },
			);
			compMs.set(rid, byComp);
		}
	}
	const mark = (component: string, reason: string): void => {
		const rows = rowsFor(component);
		if (rows.length === 1 && !out.has(rows[0])) {
			out.set(rows[0], reason);
		}
	};
	for (const component of depthZero) {
		mark(component, 'runs at depth 0 — its duration is the request/process lifetime, not work');
	}
	for (const [rid, byComp] of compMs) {
		const root = rootMs.get(rid);
		if (!root || root <= 0) {
			continue; // no depth-0 root observed for this request — no denominator
		}
		for (const [component, { maxMs, calls }] of byComp) {
			// ONE call, and that call spans the root. The call count is the whole
			// discriminator: a pass-through is entered once and returns when the
			// request does, while a hot function reaching the same share got there
			// by running repeatedly — which is work, and the most reclaimable kind.
			// Recursion lands here too (many calls), and correctly stays eligible.
			if (calls === 1 && maxMs / root >= LIFETIME_SHARE) {
				mark(
					component,
					`spans ${Math.round((maxMs / root) * 100)}% of its request root in a single call — a pass-through whose duration is the lifetime, not work`,
				);
			}
		}
	}
	return out;
}

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
	// FOURTH soundness gate (see lifetimeFrames). The other three — functional
	// dependence, the security guard, and the none-return rule — all PASS on a
	// process entry point, which is how `main` and `_cmd_serve` came to be
	// offered as memoization targets at "~25101ms is cacheable". Memoizing a
	// server's CLI entry point means "do not start the process the second time".
	const lifetime = lifetimeFrames(workspaceRoot, nodes);
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
			if (lifetime.has(row)) {
				continue; // duration is lifetime, not work — nothing here is reclaimable
			}
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
	/**
	 * Sum of positive mem_delta_bytes over this symbol's successful calls in
	 * the session — its gross observed allocation footprint, the attribution
	 * basis for the gc-pressure detector. Undefined when the trace carries no
	 * memory data (memory axis off), which downstream must read as "no
	 * allocation visibility", never "allocates nothing".
	 */
	alloc_bytes?: number;
	/**
	 * The SESSION's total GC pause ms / collection count (identical on every
	 * symbol observed in the session) — session-level facts threaded here so
	 * the pure analyzer (computeOptimizationCandidates) receives GC evidence
	 * through the one timings channel every caller already passes. Undefined
	 * when the session's trace has no gc_pause lines.
	 */
	gc_pause_ms?: number;
	gc_pause_count?: number;
}

/** Per-session GC pause pressure, parsed from the tracer's gc_pause lines. */
export interface GcSessionPressure {
	/** Sum of gc_pause duration_ms across the session. */
	total_pause_ms: number;
	/** Number of collections observed. */
	count: number;
}

/**
 * Total GC pause time and collection count per capture session, keyed by the
 * same `<dir>@<mtime>` session identity collectSymbolTimings uses (so the two
 * join exactly). Sessions whose trace predates gc_pause emission simply do not
 * appear — absence means "no GC visibility", never "zero pauses".
 */
export function collectGcPressure(workspaceRoot: string): Map<string, GcSessionPressure> {
	const out = new Map<string, GcSessionPressure>();
	for (const s of sessionTraces(workspaceRoot)) {
		let total = 0;
		let count = 0;
		for (const ev of eventsOf(s.file)) {
			if (ev.event !== 'gc_pause') {
				continue;
			}
			total += Number(ev.duration_ms ?? 0) || 0;
			count += 1;
		}
		if (count > 0) {
			out.set(sessionKeyOf(s), { total_pause_ms: total, count });
		}
	}
	return out;
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
	// row -> session -> {ms, calls, alloc, sawMem}
	const perRow = new Map<
		number,
		Map<string, { ms: number; calls: number; alloc: number; sawMem: boolean }>
	>();
	const sessions = sessionTraces(workspaceRoot);
	// Session identity is the shared `<dir>@<mtime>` key (sessionKeyOf): the
	// proof loop must see a RE-TRACE into the same directory as a NEW session,
	// or the before/after diff would never fire and the candidate would stick
	// on 'dispatched' forever.
	const sessionOrder = [...new Set(sessions.map(sessionKeyOf))];
	for (const s of sessions) {
		const sessionKey = sessionKeyOf(s);
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
			const bySession =
				perRow.get(rows[0]) ??
				new Map<string, { ms: number; calls: number; alloc: number; sawMem: boolean }>();
			const acc = bySession.get(sessionKey) ?? { ms: 0, calls: 0, alloc: 0, sawMem: false };
			acc.ms += Number(ev.duration_ms ?? 0) || 0;
			acc.calls += 1;
			// Gross allocation footprint for the gc-pressure detector: only the
			// POSITIVE deltas (a net-freeing call is not an allocator), and only
			// when the trace actually carries memory data — a null mem_delta_bytes
			// (memory axis off) must stay "no visibility", not a silent zero.
			if (ev.mem_delta_bytes !== null && ev.mem_delta_bytes !== undefined) {
				acc.sawMem = true;
				acc.alloc += Math.max(0, Number(ev.mem_delta_bytes) || 0);
			}
			bySession.set(sessionKey, acc);
			perRow.set(rows[0], bySession);
		}
	}
	// Session-level GC facts ride on every timing entry (same value per
	// session): the pure analyzer receives GC evidence through this one
	// channel, with no extra plumbing at any call site.
	const gcBySession = collectGcPressure(workspaceRoot);
	const out = new Map<number, SymbolSessionTiming[]>();
	for (const [row, bySession] of perRow) {
		const ordered = sessionOrder
			.filter((sess) => bySession.has(sess))
			.map((sess) => {
				const acc = bySession.get(sess) as {
					ms: number;
					calls: number;
					alloc: number;
					sawMem: boolean;
				};
				const t: SymbolSessionTiming = { session: sess, total_ms: acc.ms, calls: acc.calls };
				if (acc.sawMem) {
					t.alloc_bytes = acc.alloc;
				}
				const gc = gcBySession.get(sess);
				if (gc) {
					t.gc_pause_ms = gc.total_pause_ms;
					t.gc_pause_count = gc.count;
				}
				return t;
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
	/**
	 * Wall time this call spent OFF the CPU (tracelens `blocked_ms` = wall − cpu),
	 * clamped to [0, durationMs]. 0 when the trace predates the field.
	 *
	 * `io` is the majority-blocked BOOLEAN derived from this; the raw number is
	 * kept because ranking needs the degree, not just the verdict: a symbol that
	 * is 99% blocked on a network call has almost no on-CPU work an optimization
	 * could remove, and must not out-rank one that is genuinely compute-bound.
	 */
	blockedMs: number;
	children: TraceSpan[];
}

function parseTs(ts: string | undefined): number {
	if (typeof ts !== 'string') {
		return 0;
	}
	const t = Date.parse(ts);
	return Number.isFinite(t) ? t : 0;
}

/** Blocked wall time for an exit, clamped into [0, duration]. 0 when absent. */
function blockedMsOf(ev: ExitEvent): number {
	const blocked = Number(ev.blocked_ms);
	const wall = Number(ev.duration_ms);
	if (!Number.isFinite(blocked) || blocked <= 0) {
		return 0;
	}
	if (!Number.isFinite(wall) || wall <= 0) {
		return 0;
	}
	return Math.min(blocked, wall);
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
						blockedMs: 0,
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
				p.span.blockedMs = blockedMsOf(ev);
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
				blockedMs: 0,
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
					span.blockedMs = blockedMsOf(ev);
					stack.length = i;
					break;
				}
			}
			stacks.set(key, stack);
		}
	}
}
