/**
 * Runtime trace reader — the shared, observe-only foundation the runtime MCP
 * tools build on.
 *
 * tracelens writes two JSONL rows per call (see the Python exporter): an `enter`
 * row carrying the per-parameter `args_summary`, and an `exit` row carrying
 * `duration_ms`, `status`, `result_summary`, `error_type`, `mem_delta_bytes`,
 * `oracle_violations`, etc. Every row also carries `component` (the dotted
 * qualname of the symbol), `parent_component`, `depth` and `request_id`.
 *
 * That means the trace already contains a *dynamic* call graph — parent→child
 * edges within each request — plus the observed values at every call. This
 * module parses the trace(s) once (cached by size+mtime, mirroring
 * traceMemory/traceFilter) and derives the indexes the value-profile, SBFL,
 * slice and blast-radius layers need. It is deliberately vscode-free (only
 * fs/path) so both the extension and the standalone MCP server can import it.
 *
 * This is strictly read-only: it observes and describes a completed run. It
 * never reproduces, verifies, or edits anything.
 */
import * as fs from 'fs';
import * as path from 'path';

/** A bounded per-value summary, as produced by tracelens' `summarize()`. */
export interface SummaryDict {
	/** Scalar value (bool/int/float). */
	v?: number | boolean;
	/** Present as "NoneType" for None, or a class name for opaque objects. */
	type?: string;
	/** String/list/dict/bytes length. */
	len?: number;
	/** First 32 chars of a string. */
	head?: string;
	/** Element type name of the first list/tuple item. */
	elem_type?: string;
	/** First 5 sorted keys of a dict. */
	keys_head?: string[];
	/** numpy ndarray / pandas DataFrame shape. */
	shape?: number[];
	/** numpy dtype. */
	dtype?: string;
	/** pandas first 5 column names. */
	cols_head?: string[];
	/** The value exceeded the byte cap and was dropped. */
	truncated?: boolean;
	/** summarize() itself raised. */
	summary_error?: string;
}

/** A parsed `enter` row. */
export interface EnterRow {
	kind: 'enter';
	ts: string;
	request_id: string;
	component: string;
	depth: number;
	parent_component: string | null;
	thread_id: number;
	args_hash?: string;
	args_schema?: string;
	/** Per-parameter summaries, keyed by parameter name. */
	args_summary: Record<string, SummaryDict>;
}

/** A parsed `exit` row. */
export interface ExitRow {
	kind: 'exit';
	ts: string;
	request_id: string;
	component: string;
	depth: number;
	parent_component: string | null;
	thread_id: number;
	duration_ms: number;
	mem_delta_bytes?: number;
	status: 'ok' | 'error';
	error_type?: string | null;
	error_message?: string | null;
	/** Formatted traceback tail (newer captures; absent in older traces). */
	error_stack?: string | null;
	/** Capture-session ordering: index epoch of the source session (null = untagged). */
	source_epoch?: number | null;
	/** Capture-session ordering: capture time (captured_unix·1000, else mtime). */
	source_t?: number;
	/** Capture-session ordering: source trace file path (final tie-break). */
	source_path?: string;
	result_summary?: SummaryDict | null;
	oracle_violations: string[];
	call_count_in_request?: number;
}

/** Per-symbol slice of the trace: every enter/exit row observed for a component. */
export interface SymbolRecord {
	component: string;
	enters: EnterRow[];
	exits: ExitRow[];
	/** Distinct request_ids in which this symbol ran. */
	requests: Set<string>;
	/**
	 * Latest index epoch among the epoch-tagged sessions that observed this
	 * symbol; null when it only appears in untagged (pre-epoch) sessions.
	 * Joined against the symbol's chunk epoch to date runtime facts.
	 */
	lastObservedEpoch: number | null;
	/** True when at least one observation came from an untagged session. */
	observedUntagged: boolean;
}

/**
 * Fold the observed exit outcomes of a failing frame's ANCESTORS into one
 * containment verdict — did the exception escape, or did a caller absorb it?
 *
 * `ancestorExitedOk` is ordered innermost-caller-first, one entry per frame of
 * the observed caller chain: `true` = that frame exited `ok`, `false` = it also
 * exited with an error, `undefined`/`null` = no usable evidence for that frame —
 * either its exit was not in the capture, or it ran several times in the request
 * with conflicting outcomes (see `mergeExitOutcome`).
 *
 *  - `true`  — some ancestor exited `ok` while the callee raised, so a
 *    `try/except` upstream handled it. The raise is control flow.
 *  - `false` — every ancestor whose exit WAS observed also errored, so nothing
 *    absorbed it: the exception escaped.
 *  - `null`  — no ancestor exit was observed at all. Unknown, and consumers
 *    must read unknown as escaped; treating it as handled would hide real
 *    failures.
 *
 * Shared by the graph overlay (`indexGraph.absorbRawCaptures`) and the
 * `coverage_of` MCP tool (`analysis.toolCoverageOf`) so both answer this
 * question identically — the same reason their session ordering is shared.
 */
export function containmentVerdict(
	ancestorExitedOk: Array<boolean | null | undefined>,
): boolean | null {
	let verdict: boolean | null = null;
	for (const ok of ancestorExitedOk) {
		if (ok === undefined || ok === null) {
			continue; // no usable evidence from this frame
		}
		if (ok) {
			return true; // absorbed here — no need to look further out
		}
		verdict = false; // observed, and it errored too: still escaping
	}
	return verdict;
}

/**
 * Fold repeated observations of ONE frame's exit outcome within a single
 * (request, thread) into one answer to "did this frame exit ok?".
 *
 * `ExitRow` carries no span or call id — only `call_count_in_request`, which
 * does not identify WHICH call a given row belongs to. So when a component runs
 * more than once inside one request its exit rows cannot be told apart, and
 * asking "did my ancestor exit ok" has no single answer:
 *
 *   dashboard()                      exits ok      <- catches, per widget
 *     build_panel(w1) -> render(w1)  exits ok
 *     build_panel(w2) -> render(w2)  exits ERROR   <- propagated through
 *     build_panel(w3) -> render(w3)  exits ok
 *
 * `build_panel` is observed exiting both ok and error. Picking either one is a
 * guess: last-write-wins says ok, first-match says error, and those are the two
 * answers the two producers used to give for the same capture.
 *
 *  - first observation      -> that outcome
 *  - all observations agree -> that outcome
 *  - observations conflict  -> `null`, AMBIGUOUS
 *
 * `null` is deliberately the same "no usable evidence" value `containmentVerdict`
 * already skips, so an ambiguous frame neither claims to have caught the
 * exception nor blocks a genuine catch further out. On the trace above,
 * `build_panel` folds to null and `dashboard` — unambiguously ok — is correctly
 * credited, which is both the right verdict AND the right `contained_by`.
 *
 * Erring toward ambiguity is the safe direction: the cost of a wrong `true` is a
 * real defect deleted from `current_errors` and filtered out of
 * `collectRuntimeErrorClusters`, while the cost of a wrong `null` is a handled
 * exception staying on the list. Unknown must read as escaped.
 */
export function mergeExitOutcome(
	prev: boolean | null | undefined,
	ok: boolean,
): boolean | null {
	if (prev === undefined) {
		return ok; // first observation of this frame in this request
	}
	if (prev === null) {
		return null; // already ambiguous — nothing makes it unambiguous again
	}
	return prev === ok ? ok : null;
}

/**
 * Merge containment across repeat occurrences of the SAME failure identity.
 * Only "handled" when EVERY observed occurrence was absorbed: one escape makes
 * the identity a real defect, and an unknown never upgrades a known escape.
 */
export function mergeContainment(
	a: boolean | null,
	b: boolean | null,
): boolean | null {
	if (a === false || b === false) {
		return false;
	}
	if (a === null || b === null) {
		return null;
	}
	return true;
}

/** One request's outcome, derived from its exit rows. */
export interface RequestOutcome {
	request_id: string;
	/** True when any exit in the request was `status: "error"`. */
	failed: boolean;
	/** Distinct components that ran in this request. */
	components: Set<string>;
	/** Root component(s) of the request (depth 0). */
	roots: string[];
}

/** The fully-parsed, indexed trace corpus (possibly spanning several sessions). */
export interface TraceCorpus {
	/** Absolute paths of every trace.jsonl that fed this corpus. */
	sources: string[];
	/**
	 * Index epoch each source was captured at (from the session's epoch.json,
	 * stamped by the extension when the trace appeared). Sources without a tag
	 * are absent from the map — their age relative to the code is unknown.
	 */
	epochBySource: Map<string, number>;
	enters: EnterRow[];
	exits: ExitRow[];
	/** component → its rows. */
	bySymbol: Map<string, SymbolRecord>;
	/** request_id → outcome. */
	byRequest: Map<string, RequestOutcome>;
	/** caller component → (callee component → observed call count). */
	callees: Map<string, Map<string, number>>;
	/** callee component → (caller component → observed call count). */
	callers: Map<string, Map<string, number>>;
	/** True when at least one row was parsed. */
	empty: boolean;
}

interface RawRow {
	event?: string;
	ts?: string;
	request_id?: string;
	component?: string;
	depth?: number;
	parent_component?: string | null;
	thread_id?: number;
	args_hash?: string;
	args_schema?: string;
	args_summary?: Record<string, SummaryDict>;
	duration_ms?: number;
	mem_delta_bytes?: number;
	status?: string;
	error_type?: string | null;
	error_message?: string | null;
	error_stack?: string | null;
	result_summary?: SummaryDict | null;
	oracle_violations?: string[];
	call_count_in_request?: number;
}

interface CachedCorpus {
	/** Signature of the source set: joined `path:size:mtime` for each file. */
	sig: string;
	corpus: TraceCorpus;
}

// Keyed by workspace root. Reused across tool calls while every source trace is
// unchanged, so repeated MCP calls don't re-parse potentially large traces.
const cache = new Map<string, CachedCorpus>();

/**
 * Captures root for a workspace: `<root>/.vinv/captures`. Honours
 * VINV_CAPTURES_DIR (the same override bring-up uses to redirect tracelens
 * output) so the reader and writer always agree on location.
 */
function capturesDir(workspaceRoot: string): string {
	const override = process.env.VINV_CAPTURES_DIR;
	if (override && override.trim()) {
		return override;
	}
	return path.join(workspaceRoot, '.vinv', 'captures');
}

/**
 * Every `trace.jsonl` under the captures tree, newest first. Recurses the whole
 * captures dir so multiple services and sessions are all included — SBFL and
 * value profiles get more signal the more runs they see.
 */
export function findTraceFiles(workspaceRoot: string): string[] {
	const root = capturesDir(workspaceRoot);
	const found: { file: string; mtimeMs: number }[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 6) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(full, depth + 1);
			} else if (e.isFile() && e.name === 'trace.jsonl') {
				try {
					found.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
				} catch {
					// ignore unreadable file
				}
			}
		}
	};
	walk(root, 0);
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return found.map((f) => f.file);
}

function sourceSignature(files: string[]): string {
	return files
		.map((f) => {
			try {
				const s = fs.statSync(f);
				return `${f}:${s.size}:${s.mtimeMs}`;
			} catch {
				return `${f}:missing`;
			}
		})
		.join('|');
}

function toEnter(r: RawRow): EnterRow | null {
	if (!r.component) {
		return null;
	}
	return {
		kind: 'enter',
		ts: r.ts ?? '',
		request_id: r.request_id ?? '',
		component: r.component,
		depth: typeof r.depth === 'number' ? r.depth : 0,
		parent_component: r.parent_component ?? null,
		thread_id: typeof r.thread_id === 'number' ? r.thread_id : 0,
		args_hash: r.args_hash,
		args_schema: r.args_schema,
		args_summary:
			r.args_summary && typeof r.args_summary === 'object' ? r.args_summary : {},
	};
}

function toExit(r: RawRow): ExitRow | null {
	if (!r.component) {
		return null;
	}
	return {
		kind: 'exit',
		ts: r.ts ?? '',
		request_id: r.request_id ?? '',
		component: r.component,
		depth: typeof r.depth === 'number' ? r.depth : 0,
		parent_component: r.parent_component ?? null,
		thread_id: typeof r.thread_id === 'number' ? r.thread_id : 0,
		duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : 0,
		mem_delta_bytes: r.mem_delta_bytes,
		status: r.status === 'error' ? 'error' : 'ok',
		error_type: r.error_type ?? null,
		error_message: r.error_message ?? null,
		error_stack: r.error_stack ?? null,
		result_summary: r.result_summary ?? null,
		oracle_violations: Array.isArray(r.oracle_violations) ? r.oracle_violations : [],
		call_count_in_request: r.call_count_in_request,
	};
}

function symbolRecord(map: Map<string, SymbolRecord>, component: string): SymbolRecord {
	let rec = map.get(component);
	if (!rec) {
		rec = {
			component,
			enters: [],
			exits: [],
			requests: new Set(),
			lastObservedEpoch: null,
			observedUntagged: false,
		};
		map.set(component, rec);
	}
	return rec;
}

/** Records which index epoch a symbol observation came from. */
function observeEpoch(rec: SymbolRecord, epoch: number | null): void {
	if (epoch === null) {
		rec.observedUntagged = true;
	} else if (rec.lastObservedEpoch === null || epoch > rec.lastObservedEpoch) {
		rec.lastObservedEpoch = epoch;
	}
}

/** The session's capture-time index epoch (epoch.json beside the trace), if any. */
function readSourceEpoch(traceFile: string): number | null {
	return readSessionTag(traceFile).epoch;
}

/**
 * The capture session's ordering identity. Kept byte-identical to indexGraph's
 * `sessionOf` so the graph/QnA lifecycle and the MCP `coverage_of` lifecycle
 * pick the SAME latest session for any trace: epoch from epoch.json, capture
 * time preferring the stamped `captured_unix` (mtime only as fallback), and the
 * source path as a deterministic final tie-break.
 */
export function readSessionTag(traceFile: string): {
	epoch: number | null;
	t: number;
	path: string;
} {
	let epoch: number | null = null;
	let capturedUnix: number | null = null;
	try {
		const raw = fs.readFileSync(path.join(path.dirname(traceFile), 'epoch.json'), 'utf8');
		const tag = JSON.parse(raw) as { epoch?: number; captured_unix?: number };
		epoch = typeof tag.epoch === 'number' ? tag.epoch : null;
		capturedUnix = typeof tag.captured_unix === 'number' ? tag.captured_unix : null;
	} catch {
		// No tag: epoch unknown, fall back to mtime for time.
	}
	let t = capturedUnix !== null ? capturedUnix * 1000 : 0;
	if (capturedUnix === null) {
		try {
			t = fs.statSync(traceFile).mtimeMs;
		} catch {
			t = 0;
		}
	}
	return { epoch, t, path: traceFile };
}

/** A capture session's ordering identity in the shared lifecycle order. */
export interface SessionMark {
	epoch: number | null;
	t: number;
	path: string;
}

/**
 * Compares two sessions by RECENCY only: (epoch, capture time). Path is
 * deliberately NOT a tie-break — two sessions with the same epoch and the same
 * capture time are genuinely concurrent (recency-indistinguishable), so the
 * lifecycle treats them as ONE logical session and MERGES their error state
 * (see the folds in indexGraph / analysis). Merging is order-independent, which
 * makes current_errors deterministic without a path tie-break AND preserves the
 * "a tie never falsely claims fixed" safety invariant: if either concurrent run
 * errored, the merged session still counts the error as current.
 */
export function cmpSessionMark(a: SessionMark, b: SessionMark): number {
	return (a.epoch ?? -1) - (b.epoch ?? -1) || a.t - b.t;
}

function bumpEdge(map: Map<string, Map<string, number>>, from: string, to: string): void {
	let inner = map.get(from);
	if (!inner) {
		inner = new Map();
		map.set(from, inner);
	}
	inner.set(to, (inner.get(to) ?? 0) + 1);
}

function build(files: string[]): TraceCorpus {
	const enters: EnterRow[] = [];
	const exits: ExitRow[] = [];
	const bySymbol = new Map<string, SymbolRecord>();
	const byRequest = new Map<string, RequestOutcome>();
	const callees = new Map<string, Map<string, number>>();
	const callers = new Map<string, Map<string, number>>();
	const epochBySource = new Map<string, number>();

	const outcome = (rid: string): RequestOutcome => {
		let o = byRequest.get(rid);
		if (!o) {
			o = { request_id: rid, failed: false, components: new Set(), roots: [] };
			byRequest.set(rid, o);
		}
		return o;
	};

	for (const file of files) {
		let raw: string;
		try {
			raw = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const tag = readSessionTag(file);
		const sourceEpoch = tag.epoch;
		if (sourceEpoch !== null) {
			epochBySource.set(file, sourceEpoch);
		}
		const sourceT = tag.t;
		for (const line of raw.split('\n')) {
			const s = line.trim();
			if (!s) {
				continue;
			}
			let row: RawRow;
			try {
				row = JSON.parse(s) as RawRow;
			} catch {
				continue; // tolerate a partially-written final line
			}
			if (row.event === 'enter') {
				const e = toEnter(row);
				if (!e) {
					continue;
				}
				enters.push(e);
				const rec = symbolRecord(bySymbol, e.component);
				rec.enters.push(e);
				rec.requests.add(e.request_id);
				observeEpoch(rec, sourceEpoch);
				const o = outcome(e.request_id);
				o.components.add(e.component);
				if (e.depth === 0 && !o.roots.includes(e.component)) {
					o.roots.push(e.component);
				}
				// Dynamic call edge from the observed parent.
				if (e.parent_component) {
					bumpEdge(callees, e.parent_component, e.component);
					bumpEdge(callers, e.component, e.parent_component);
				}
			} else if (row.event === 'exit') {
				const x = toExit(row);
				if (!x) {
					continue;
				}
				x.source_epoch = sourceEpoch;
				x.source_t = sourceT;
				x.source_path = file;
				exits.push(x);
				const rec = symbolRecord(bySymbol, x.component);
				rec.exits.push(x);
				rec.requests.add(x.request_id);
				observeEpoch(rec, sourceEpoch);
				const o = outcome(x.request_id);
				o.components.add(x.component);
				if (x.status === 'error') {
					o.failed = true;
				}
			}
		}
	}

	return {
		sources: files,
		epochBySource,
		enters,
		exits,
		bySymbol,
		byRequest,
		callees,
		callers,
		empty: enters.length === 0 && exits.length === 0,
	};
}

/**
 * Loads (and caches) the workspace's trace corpus across all captured sessions.
 * Returns an empty corpus (never throws) when nothing has been captured yet.
 */
export function loadCorpus(workspaceRoot: string): TraceCorpus {
	const files = findTraceFiles(workspaceRoot);
	const sig = sourceSignature(files);
	const cached = cache.get(workspaceRoot);
	if (cached && cached.sig === sig) {
		return cached.corpus;
	}
	const corpus = build(files);
	cache.set(workspaceRoot, { sig, corpus });
	return corpus;
}

/**
 * Resolves a caller-supplied symbol name to an exact component key. Accepts an
 * exact dotted qualname, else falls back to a unique suffix/short-name match
 * (e.g. "charge" → "billing.payments.charge") so callers don't need the full
 * module path. Returns every candidate when the match is ambiguous.
 */
export function resolveSymbol(
	corpus: TraceCorpus,
	name: string,
): { match: string | null; candidates: string[] } {
	if (corpus.bySymbol.has(name)) {
		return { match: name, candidates: [name] };
	}
	const short = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
	const candidates: string[] = [];
	for (const key of corpus.bySymbol.keys()) {
		const keyShort = key.slice(key.lastIndexOf('.') + 1);
		if (key === name || key.endsWith('.' + name) || keyShort === short) {
			candidates.push(key);
		}
	}
	if (candidates.length === 1) {
		return { match: candidates[0], candidates };
	}
	return { match: null, candidates };
}
