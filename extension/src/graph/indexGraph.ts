/**
 * Reads the Rust index store (<workspace>/.vinv/index) into a renderable graph
 * snapshot: symbol nodes with PageRank/epoch, typed edges, deterministic
 * architectural layers, a dependency-ordered guided tour, and a runtime overlay
 * joined from the identification tracemaps.
 *
 * Deliberately free of any `vscode` dependency so it is unit-testable and
 * importable from the QnA pipeline and the graph webview host alike. All data
 * comes from artifacts that already exist on disk — no LLM calls, no binaries.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
	cmpSessionMark,
	containmentVerdict,
	mergeContainment,
	readSessionTag,
	type SessionMark,
} from '../runtime/traceStore';

/** One symbol chunk as stored in .vinv/index/chunks.jsonl (text omitted). */
export interface GraphNode {
	/** Row index in chunks.jsonl — the id space edges.jsonl references. */
	row: number;
	id: string;
	file: string;
	lang: string;
	kind: string;
	name: string;
	start_line: number;
	end_line: number;
	summary: string;
	/** Max-normalized PageRank over invoke/inherit edges (from the index). */
	rank: number;
	/** Content epoch when this chunk's SHA last changed. */
	epoch: number;
	parent: string | null;
	/** Deterministic architectural layer (see classifyLayer). */
	layer: string;
}

export interface GraphEdge {
	src: number;
	dst: number;
	kind: 'contains' | 'invoke' | 'inherit';
}

/** File-level aggregation — the default render granularity for large graphs. */
export interface FileGroup {
	file: string;
	layer: string;
	symbols: number;
	/** Sum of member PageRanks — sizes the file bubble. */
	rank: number;
	/** True when any member symbol changed in the current store epoch. */
	changed: boolean;
	/** Rows of the member symbols (for expansion). */
	rows: number[];
}

/** Aggregated invoke/inherit traffic between two files. */
export interface FileEdge {
	src: string;
	dst: string;
	count: number;
}

/**
 * One observed failure of a symbol, carrying the full evidence identity: the
 * exception message and traceback (when the capture recorded one), the request
 * it happened in, the observed caller chain up to the request root, and the
 * arguments the failing call received. This is what lets an agent answer
 * "what IS the error" instead of only "an error of this class occurred".
 */
export interface FailureExemplar {
	error_type: string;
	error_message: string | null;
	/** Formatted traceback tail (newer captures only). */
	error_stack: string | null;
	request_id: string;
	/** Immediate caller first, request root last (observed, not static). */
	caller_chain: string[];
	/** Signature schema of the failing call, e.g. `(result:dict)`. */
	args_schema: string | null;
	/** Bounded per-argument summaries recorded at call time. */
	args_summary: Record<string, unknown> | null;
	duration_ms: number;
	/** How many observed failures share this (type, message) identity. */
	count: number;
	/** Index epoch of the newest capture containing this failure (null = untagged session). */
	capture_epoch: number | null;
	/**
	 * Lifecycle verdict, evidence-ordered by (capture epoch, capture time):
	 *  - null: CURRENT — observed in the symbol's latest captured run and the
	 *    code has not changed since; treat as live.
	 *  - 'not_reproduced': a LATER run observed this symbol without this
	 *    failure — the only evidence that truly retires an error (this is what
	 *    a verifying re-run after a fix produces).
	 *  - 'code_changed': the symbol's code changed after the failure was last
	 *    observed and no fresh run has confirmed either way — possibly fixed,
	 *    unverified. Never silently dropped: claiming "fixed" requires a run.
	 */
	superseded: null | 'code_changed' | 'not_reproduced';
	/**
	 * Did this exception ESCAPE the call stack, or did a caller absorb it?
	 *
	 *  - true  — CONTAINED: an observed ancestor of the raising frame exited
	 *    `ok`, so the exception was caught and handled. The raise is control
	 *    flow, not a failure.
	 *  - false — PROPAGATED: every observed ancestor also exited with an error,
	 *    so nothing absorbed it.
	 *  - null  — UNKNOWN: no ancestor exit was observed (no parent link, or the
	 *    chain is the request root). Callers must treat null as PROPAGATED —
	 *    when unsure, keep it on the defect list.
	 *
	 * Derived purely from the capture: `status` on the exit rows of the frames
	 * named in `caller_chain`. Nothing here is inferred from source.
	 */
	contained: boolean | null;
	/**
	 * The observed ancestor frame that absorbed this exception (the innermost
	 * one that exited `ok`), or null when it escaped / is unknown. Lets a
	 * consumer say "caught by _cmd_serve" rather than silently dropping a
	 * failure a user may have seen flagged red yesterday.
	 */
	contained_by: string | null;
}

/**
 * One observed SUCCESSFUL call's inputs, deduplicated by argument shape. The
 * failure exemplars already carry args for calls that raised; this is the same
 * evidence for calls that returned normally, so QnA can answer "what inputs did
 * this run with" (e.g. the actual page_size) without an error to hang it on.
 */
export interface ArgExemplar {
	/** Signature schema of the call, e.g. `(page:int, page_size:int)`. */
	args_schema: string | null;
	/** Bounded per-argument summaries recorded at call time. */
	args_summary: Record<string, unknown> | null;
	/** A representative request id that ran with these arguments. */
	request_id: string;
	/** Wall-clock of the SLOWEST observed call with these arguments. */
	max_duration_ms: number;
	/** How many observed calls shared this argument shape. */
	count: number;
}

/** Runtime facts joined from tracemaps, keyed by node row. */
export interface RuntimeOverlay {
	executed: boolean;
	/** Lifetime totals across every capture on disk (history included). */
	calls: number;
	total_ms: number;
	errors: number;
	error_types: string[];
	/**
	 * Distinct observed failures, deduplicated by (type, message) with
	 * occurrence counts — the highest-count exemplars first. Each carries its
	 * lifecycle verdict (`superseded`) so fixed errors retire visibly.
	 */
	failures: FailureExemplar[];
	/**
	 * Inputs of observed SUCCESSFUL calls, deduplicated by argument shape,
	 * highest-count first. Optional: only the raw-capture path populates it, and
	 * older callers construct overlays without it.
	 */
	arg_exemplars?: ArgExemplar[];
	/**
	 * Errors in this symbol's LATEST captured run only — what "is it failing
	 * NOW" means. Drives the error rings, the failure-site digest, and issue
	 * clusters, so a verified fix + re-run retires the error everywhere.
	 */
	current_errors: number;
	/** Index epoch of the latest capture observing this symbol (null = untagged/derived). */
	latest_epoch: number | null;
}

/** One stop of the dependency-ordered guided tour. */
export interface TourStop {
	row: number;
	/** Why this stop is in the tour (rank percentile). */
	reason: string;
}

/**
 * One OBSERVED call edge from a runtime trace: caller row → callee row, with
 * how often and how long. `observed_only` marks flow the static index never
 * predicted (dynamic dispatch, callbacks, framework glue) — exactly the edges
 * a static code graph is blind to.
 */
export interface FlowEdge {
	src: number;
	dst: number;
	calls: number;
	total_ms: number;
	/** Lifetime error count across every capture (history included). */
	errors: number;
	observed_only: boolean;
	/**
	 * Errors on this edge in its LATEST captured session — same lifecycle rule
	 * as RuntimeOverlay.current_errors, so a fixed call path stops rendering
	 * red. Absent on data produced before the lifecycle existed.
	 */
	current_errors?: number;
}

export interface GraphSnapshot {
	generated_at: string;
	workspace: string;
	store_epoch: number;
	node_count: number;
	edge_count: number;
	layers: string[];
	nodes: GraphNode[];
	edges: GraphEdge[];
	files: FileGroup[];
	file_edges: FileEdge[];
	tour: TourStop[];
	/** row → runtime facts (sparse; only symbols observed in a trace). */
	runtime: Record<number, RuntimeOverlay>;
	/** Observed caller→callee edges from raw trace captures. */
	flow_edges: FlowEdge[];
}

/** Legend order — foundational layers first, periphery last. */
export const LAYERS = [
	'api',
	'service',
	'data',
	'ui',
	'util',
	'config',
	'scripts',
	'tests',
	'docs',
	'other',
] as const;

const LAYER_PATTERNS: ReadonlyArray<{ layer: string; re: RegExp }> = [
	{ layer: 'tests', re: /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|[._-](test|spec)\.[a-z]+$/i },
	{ layer: 'api', re: /(^|\/)(api|apis|routes?|controllers?|handlers?|endpoints?|views|server|rpc|mcp)(\/|$)/i },
	{ layer: 'data', re: /(^|\/)(models?|store|stores?|db|database|schema|schemas|storage|repositor(y|ies)|dao|migrations?|orm)(\/|$)/i },
	{ layer: 'ui', re: /(^|\/)(components?|pages?|frontend|web|ui|widgets?|styles?)(\/|$)|\.(tsx|jsx|css|scss|html|vue|svelte)$/i },
	{ layer: 'config', re: /(^|\/)(config|configs?|settings|env)(\/|$)|(^|\/)(pyproject\.toml|package\.json|cargo\.toml|.*\.cfg|.*\.ini|.*\.ya?ml)$/i },
	{ layer: 'scripts', re: /(^|\/)(scripts?|bin|tools?|ci|\.github)(\/|$)/i },
	{ layer: 'util', re: /(^|\/)(utils?|helpers?|lib|libs?|common|shared)(\/|$)/i },
	{ layer: 'service', re: /(^|\/)(services?|core|domain|logic|engine|pipeline|runtime|analysis|agents?)(\/|$)/i },
];

/**
 * Deterministic layer classification: path/kind heuristics, no LLM. The same
 * file always lands in the same layer, so colors are stable across reloads.
 */
export function classifyLayer(file: string, lang: string, kind: string): string {
	if (lang === 'doc' || kind === 'doc' || /\.(md|rst|txt)$/i.test(file)) {
		return 'docs';
	}
	for (const { layer, re } of LAYER_PATTERNS) {
		if (re.test(file)) {
			return layer;
		}
	}
	return 'other';
}

/** Raw chunk line shape (subset we consume). */
interface RawChunk {
	id?: string;
	file?: string;
	lang?: string;
	kind?: string;
	name?: string;
	start_line?: number;
	end_line?: number;
	summary?: string;
	rank?: number;
	epoch?: number;
	parent?: string | null;
}

function readJsonl<T>(file: string): T[] {
	const out: T[] = [];
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch {
		return out;
	}
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			out.push(JSON.parse(trimmed) as T);
		} catch {
			// One malformed line never poisons the whole graph.
		}
	}
	return out;
}

/** The index store dir for a workspace. */
export function indexStoreDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'index');
}

/**
 * The stored chunk TEXT for specific rows — read lazily so the graph snapshot
 * itself stays light. This is the code as of the row's index epoch, i.e. the
 * version every rank, edge, and joined trace actually describes; reading the
 * live file by stored line numbers instead silently returns the wrong code
 * once the file drifts (functions move) — an exactness bug, not a staleness
 * nuance.
 */
export function loadChunkTexts(storeDir: string, rows: number[]): Map<number, string> {
	const out = new Map<number, string>();
	if (rows.length === 0) {
		return out;
	}
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(storeDir, 'chunks.jsonl'), 'utf8');
	} catch {
		return out;
	}
	// Row numbering MUST mirror readJsonl (used by loadNodes): blank and
	// malformed lines are skipped, not counted — indexing physical lines
	// would silently shift every row after a skipped line and show the wrong
	// symbol's code.
	const wanted = new Set(rows);
	let row = 0;
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		let chunk: { text?: string };
		try {
			chunk = JSON.parse(trimmed) as { text?: string };
		} catch {
			continue;
		}
		if (wanted.has(row) && typeof chunk.text === 'string' && chunk.text) {
			out.set(row, chunk.text);
			if (out.size === wanted.size) {
				break;
			}
		}
		row += 1;
	}
	return out;
}

/** True when the workspace has an index store the graph can render. */
export function hasIndexStore(workspaceRoot: string): boolean {
	return fs.existsSync(path.join(indexStoreDir(workspaceRoot), 'chunks.jsonl'));
}

/** Loads nodes (chunks minus text/vectors) with layers assigned. */
export function loadNodes(storeDir: string): GraphNode[] {
	const chunks = readJsonl<RawChunk>(path.join(storeDir, 'chunks.jsonl'));
	return chunks.map((c, row) => ({
		row,
		id: c.id ?? `row:${row}`,
		file: c.file ?? '',
		lang: c.lang ?? '',
		kind: c.kind ?? '',
		name: c.name ?? '',
		start_line: c.start_line ?? 1,
		end_line: c.end_line ?? 1,
		summary: c.summary ?? '',
		rank: typeof c.rank === 'number' ? c.rank : 0,
		epoch: typeof c.epoch === 'number' ? c.epoch : 0,
		parent: c.parent ?? null,
		layer: classifyLayer(c.file ?? '', c.lang ?? '', c.kind ?? ''),
	}));
}

/** Loads typed edges; rows out of range are dropped (stale sidecar safety). */
export function loadEdges(storeDir: string, nodeCount: number): GraphEdge[] {
	const rows = readJsonl<{ src?: number; dst?: number; kind?: string }>(
		path.join(storeDir, 'edges.jsonl'),
	);
	const edges: GraphEdge[] = [];
	for (const e of rows) {
		if (
			typeof e.src === 'number' &&
			typeof e.dst === 'number' &&
			e.src >= 0 &&
			e.dst >= 0 &&
			e.src < nodeCount &&
			e.dst < nodeCount &&
			(e.kind === 'contains' || e.kind === 'invoke' || e.kind === 'inherit')
		) {
			edges.push({ src: e.src, dst: e.dst, kind: e.kind });
		}
	}
	return edges;
}

/** Reads the store epoch from meta.json (0 when missing). */
export function loadStoreEpoch(storeDir: string): number {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(storeDir, 'meta.json'), 'utf8')) as {
			epoch?: number;
		};
		return typeof meta.epoch === 'number' ? meta.epoch : 0;
	} catch {
		return 0;
	}
}

/** Aggregates symbol nodes into per-file groups plus inter-file edge traffic. */
export function buildFileLevel(
	nodes: GraphNode[],
	edges: GraphEdge[],
	storeEpoch: number,
): { files: FileGroup[]; fileEdges: FileEdge[] } {
	const groups = new Map<string, FileGroup>();
	for (const n of nodes) {
		let g = groups.get(n.file);
		if (!g) {
			g = { file: n.file, layer: n.layer, symbols: 0, rank: 0, changed: false, rows: [] };
			groups.set(n.file, g);
		}
		g.symbols += 1;
		g.rank += n.rank;
		g.rows.push(n.row);
		if (storeEpoch > 0 && n.epoch === storeEpoch) {
			g.changed = true;
		}
	}
	const traffic = new Map<string, FileEdge>();
	for (const e of edges) {
		if (e.kind === 'contains') {
			continue; // structural nesting, not dependency traffic
		}
		const src = nodes[e.src]?.file;
		const dst = nodes[e.dst]?.file;
		if (!src || !dst || src === dst) {
			continue;
		}
		const key = `${src}\u0000${dst}`;
		const existing = traffic.get(key);
		if (existing) {
			existing.count += 1;
		} else {
			traffic.set(key, { src, dst, count: 1 });
		}
	}
	return { files: [...groups.values()], fileEdges: [...traffic.values()] };
}

/**
 * Dependency-ordered guided tour: Kahn's topological sort over invoke/inherit
 * edges with "callees first", so foundations are visited before the code built
 * on them (the Understand-Anything tour ordering, computed deterministically).
 * Cycles are broken by releasing the highest-PageRank blocked node. The tour
 * keeps only the top `stops` nodes by rank, in that dependency order.
 */
export function buildTour(nodes: GraphNode[], edges: GraphEdge[], stops = 15): TourStop[] {
	const n = nodes.length;
	if (n === 0) {
		return [];
	}
	// node depends on its callees/bases: edge src -> dst means src needs dst first.
	const pendingDeps = new Array<number>(n).fill(0);
	const dependents: number[][] = Array.from({ length: n }, () => []);
	for (const e of edges) {
		if (e.kind === 'contains' || e.src === e.dst) {
			continue;
		}
		pendingDeps[e.src] += 1;
		dependents[e.dst].push(e.src);
	}
	const order: number[] = [];
	const done = new Array<boolean>(n).fill(false);
	const ready: number[] = [];
	for (let i = 0; i < n; i++) {
		if (pendingDeps[i] === 0) {
			ready.push(i);
		}
	}
	// Deterministic tie-break inside the ready set: rank desc, then row asc.
	const byRank = (a: number, b: number) => nodes[b].rank - nodes[a].rank || a - b;
	while (order.length < n) {
		if (ready.length === 0) {
			// Cycle: release the highest-rank remaining node.
			let best = -1;
			for (let i = 0; i < n; i++) {
				if (!done[i] && (best === -1 || byRank(i, best) < 0)) {
					best = i;
				}
			}
			if (best === -1) {
				break;
			}
			ready.push(best);
			pendingDeps[best] = 0;
		}
		ready.sort(byRank);
		const next = ready.shift();
		if (next === undefined || done[next]) {
			continue;
		}
		done[next] = true;
		order.push(next);
		for (const dep of dependents[next]) {
			pendingDeps[dep] -= 1;
			if (pendingDeps[dep] === 0 && !done[dep]) {
				ready.push(dep);
			}
		}
	}
	// Tour stops: the highest-rank code symbols, presented in dependency order.
	const eligible = order.filter((row) => nodes[row].layer !== 'docs' && nodes[row].rank > 0);
	const top = new Set(
		[...eligible].sort((a, b) => nodes[b].rank - nodes[a].rank).slice(0, stops),
	);
	return eligible
		.filter((row) => top.has(row))
		.map((row) => ({
			row,
			reason: `pagerank ${nodes[row].rank.toFixed(3)}`,
		}));
}

/** Tracemap tree node subset used for the runtime join. */
interface TraceMapNode {
	name?: string;
	file?: string;
	runtime?: {
		executed?: boolean;
		calls?: number;
		total_ms?: number;
		error?: number;
		errors?: string[];
	};
	children?: TraceMapNode[];
}

/**
 * Joins runtime facts from every runtime artifact on disk onto graph nodes.
 * Sources (all written during normal use, no extra steps required):
 *   .vinv/captures/** /trace.jsonl        — raw tracelens captures (source of
 *     truth; produced the moment any service runs under tracing)
 *   .vinv/identification/*.tracemap.json  — identification tracemap output
 *   .vinv/reports/calltree-*.json         — call-tree view backing snapshots
 * Tracemap/calltree join on (file, name). Raw captures join on the dotted
 * qualname tracelens records (`vinv_admin.signing.ensure_signing_key`): the
 * module path must be a suffix of the node's dotted file path, so the match
 * is exact-by-construction, never fuzzy.
 */
export function loadRuntimeOverlay(
	workspaceRoot: string,
	nodes: GraphNode[],
): Record<number, RuntimeOverlay> {
	const byKey = new Map<string, number[]>();
	for (const n of nodes) {
		if (!n.name || !n.file) {
			continue;
		}
		const key = `${n.file}\u0000${n.name}`;
		const rows = byKey.get(key);
		if (rows) {
			rows.push(n.row);
		} else {
			byKey.set(key, [n.row]);
		}
	}
	const overlay: Record<number, RuntimeOverlay> = {};
	const absorb = (node: TraceMapNode): void => {
		const rt = node.runtime;
		if (rt?.executed && node.file && node.name) {
			const rows = byKey.get(`${node.file}\u0000${node.name}`);
			for (const row of rows ?? []) {
				const cur = overlay[row] ?? {
					executed: true,
					calls: 0,
					total_ms: 0,
					errors: 0,
					error_types: [],
					failures: [],
					arg_exemplars: [],
					current_errors: 0,
					latest_epoch: null,
				};
				cur.calls += rt.calls ?? 0;
				cur.total_ms += rt.total_ms ?? 0;
				cur.errors += rt.error ?? 0;
				// Derived artifacts carry no session ordering; their totals are
				// the best available currency until raw captures win the row.
				cur.current_errors = cur.errors;
				for (const t of rt.errors ?? []) {
					if (!cur.error_types.includes(t)) {
						cur.error_types.push(t);
					}
				}
				overlay[row] = cur;
			}
		}
		for (const child of node.children ?? []) {
			absorb(child);
		}
	};
	const sources: string[] = [];
	for (const dir of [
		path.join(workspaceRoot, '.vinv', 'identification'),
		path.join(workspaceRoot, '.vinv', 'reports'),
	]) {
		try {
			for (const f of fs.readdirSync(dir)) {
				if (/\.tracemap\.json$/.test(f) || /^calltree-.*\.json$/.test(f)) {
					sources.push(path.join(dir, f));
				}
			}
		} catch {
			// No captures yet — the overlay is simply empty.
		}
	}
	for (const source of sources) {
		try {
			const doc = JSON.parse(fs.readFileSync(source, 'utf8')) as { tree?: TraceMapNode };
			if (doc.tree) {
				absorb(doc.tree);
			}
		} catch {
			// Skip unreadable snapshots.
		}
	}
	// Raw captures are the SOURCE OF TRUTH; tracemap/calltree artifacts are
	// derived views of the same runs. Absorbing both used to double-count
	// every symbol present in both (×2 calls and ms). Raw facts win per row;
	// derived facts only fill rows the raw captures no longer cover (e.g. a
	// capture pruned after its report was generated).
	const raw: Record<number, RuntimeOverlay> = {};
	absorbRawCaptures(workspaceRoot, nodes, raw);
	for (const [row, fact] of Object.entries(raw)) {
		overlay[Number(row)] = fact;
	}
	return overlay;
}

/**
 * Runtime overlay + observed call-flow edges in one pass over the captures.
 * Flow edges the static index already predicted (an invoke edge between the
 * same rows, either direction) keep `observed_only: false`; the rest are the
 * dynamic-dispatch/callback/framework flow only tracing can see.
 */
export function loadRuntimeAndFlow(
	workspaceRoot: string,
	nodes: GraphNode[],
	edges: GraphEdge[],
): { runtime: Record<number, RuntimeOverlay>; flow: FlowEdge[] } {
	const runtime: Record<number, RuntimeOverlay> = {};
	// Tracemap/calltree artifacts still contribute execution facts.
	for (const [row, fact] of Object.entries(loadRuntimeOverlay(workspaceRoot, nodes))) {
		runtime[Number(row)] = fact;
	}
	const flow: FlowEdge[] = [];
	// Raw captures were already absorbed inside loadRuntimeOverlay; run the
	// flow extraction separately against an empty overlay so counts don't double.
	const scratch: Record<number, RuntimeOverlay> = {};
	absorbRawCaptures(workspaceRoot, nodes, scratch, flow);
	const staticPairs = new Set<string>();
	for (const e of edges) {
		if (e.kind !== 'contains') {
			staticPairs.add(`${e.src}\u0000${e.dst}`);
			staticPairs.add(`${e.dst}\u0000${e.src}`);
		}
	}
	for (const f of flow) {
		f.observed_only = !staticPairs.has(`${f.src}\u0000${f.dst}`);
	}
	return { runtime, flow };
}

/**
 * Joins raw tracelens captures (.vinv/captures/** /trace.jsonl) directly onto
 * graph nodes, so the Runtime view works the moment ANY service runs under
 * tracing — no call-tree view or tracemap generation step in between.
 *
 * tracelens records each function exit with a dotted qualname component
 * (`vinv_admin.signing.ensure_signing_key`, methods as `pkg.mod.Class.fn`).
 * The index records (file, name). The join: the component's module path must
 * be a suffix of the node's dotted file path and the terminal segment must be
 * the node's name — exact by construction, with the class-qualified form also
 * tried so methods land on their symbol rows.
 */
/**
 * Builds the tracelens-component → graph-row join used everywhere runtime
 * facts meet the index. tracelens records dotted qualnames
 * (`vinv_admin.signing.ensure_signing_key`, methods as `pkg.mod.Class.fn`);
 * the match requires the component's module path to be a segment-aligned
 * suffix of the node's dotted file path AND the terminal segment to equal the
 * node's name — exact by construction, never fuzzy.
 */
export function buildComponentMatcher(nodes: GraphNode[]): (component: string) => number[] {
	const nameToRows = new Map<string, number[]>();
	const dottedFile: string[] = [];
	for (const n of nodes) {
		dottedFile[n.row] = n.file.replace(/\.py$/, '').replace(/\//g, '.');
		if (!n.name) {
			continue;
		}
		const rows = nameToRows.get(n.name);
		if (rows) {
			rows.push(n.row);
		} else {
			nameToRows.set(n.name, [n.row]);
		}
	}
	return (component: string): number[] => {
		// HTTP/framework spans ("GET /docs") carry spaces; only dotted
		// qualnames can join to code symbols.
		if (component.includes(' ') || !component.includes('.')) {
			return [];
		}
		const parts = component.split('.');
		const name = parts[parts.length - 1];
		const candidates = nameToRows.get(name) ?? [];
		const modulePath = parts.slice(0, -1).join('.');
		const classlessPath = parts.length >= 3 ? parts.slice(0, -2).join('.') : '';
		// Segment-aligned suffix match ("…​.vinv_admin.db" matches "vinv_admin.db"
		// but "….mydb" never matches "db"), so joins can't cross word boundaries.
		const suffixMatch = (dotted: string, mod: string): boolean =>
			dotted === mod || dotted.endsWith('.' + mod);
		return candidates.filter((row) => {
			const dotted = dottedFile[row];
			return (
				suffixMatch(dotted, modulePath) ||
				(classlessPath !== '' && suffixMatch(dotted, classlessPath))
			);
		});
	};
}

/** Structural memory bound on stored failure exemplars per symbol row. */
const MAX_STORED_FAILURES = 16;

/** Structural memory bound on stored successful-call arg exemplars per row. */
const MAX_STORED_ARG_EXEMPLARS = 8;

/** Stable dedup key for an arg exemplar: schema + summarized values. */
function argShapeKey(
	schema: string | null,
	summary: Record<string, unknown> | null,
): string {
	return `${schema ?? ''}\u0000${summary ? JSON.stringify(summary) : ''}`;
}

/**
 * Folds one successful call's args into a row's exemplars, deduped by argument
 * shape. Repeat shapes bump the count and keep the slowest call as the
 * representative (so a slow input stands out); new shapes are stored up to the
 * memory bound.
 */
function recordArgExemplar(
	fact: RuntimeOverlay,
	args: { schema: string | null; summary: Record<string, unknown> | null },
	requestId: string,
	ms: number,
): void {
	if (!fact.arg_exemplars) {
		fact.arg_exemplars = [];
	}
	const key = argShapeKey(args.schema, args.summary);
	const match = fact.arg_exemplars.find(
		(a) => argShapeKey(a.args_schema, a.args_summary) === key,
	);
	if (match) {
		match.count += 1;
		if (ms > match.max_duration_ms) {
			match.max_duration_ms = ms;
			match.request_id = requestId;
		}
		return;
	}
	if (fact.arg_exemplars.length < MAX_STORED_ARG_EXEMPLARS) {
		fact.arg_exemplars.push({
			args_schema: args.schema,
			args_summary: args.summary,
			request_id: requestId,
			max_duration_ms: ms,
			count: 1,
		});
	}
}

function absorbRawCaptures(
	workspaceRoot: string,
	nodes: GraphNode[],
	overlay: Record<number, RuntimeOverlay>,
	flowSink?: FlowEdge[],
): void {
	const rowsFor = buildComponentMatcher(nodes);
	// Observed caller→callee aggregation, keyed src\0dst. Ambiguous name
	// matches (same symbol name in several files after the module filter) are
	// skipped rather than guessed — an invented edge is worse than a missing one.
	const flowAgg = new Map<string, FlowEdge>();
	// Latest session per flow edge and its error count there — the same
	// (epoch, time) lifecycle rule as symbol rows, applied to call paths.
	const flowLatest = new Map<string, { mark: SessionMark; errors: number }>();
	const singleRow = (component: string): number | null => {
		const rows = rowsFor(component);
		return rows.length === 1 ? rows[0] : null;
	};
	interface RawTraceRow {
		event?: string;
		request_id?: string;
		thread_id?: number;
		component?: string;
		parent_component?: string | null;
		duration_ms?: number | string;
		status?: string;
		error_type?: string | null;
		error_message?: string | null;
		error_stack?: string | null;
		args_schema?: string;
		args_summary?: Record<string, unknown>;
	}
	// Observation ordering: every capture session (one trace.jsonl) is ordered
	// by (index epoch, capture time, path) — the SHARED lifecycle order, so
	// this overlay and the MCP coverage_of tool pick the same latest session.
	// Per symbol, the LATEST session defines current truth; older is history.
	const cmpSession = cmpSessionMark;
	const sessionOf = (traceFile: string): SessionMark => readSessionTag(traceFile);
	// Per row: the latest session observing it, that session's error count,
	// and the failure keys it contained (for not_reproduced verdicts).
	const rowLatest = new Map<
		number,
		{ mark: SessionMark; errors: number; failKeys: Set<string> }
	>();
	// Per (row, failure key): when the failure was last observed.
	const failLastSeen = new Map<string, SessionMark>();
	for (const traceFile of findTraceFiles(path.join(workspaceRoot, '.vinv', 'captures'))) {
		let text: string;
		try {
			text = fs.readFileSync(traceFile, 'utf8');
		} catch {
			continue;
		}
		const mark = sessionOf(traceFile);
		// This session's per-row facts, folded into rowLatest after the file.
		const sessionRows = new Map<number, { errors: number; failKeys: Set<string> }>();
		// Per-edge error tally for THIS session (folded into flowLatest below).
		const flowSessionErrors = new Map<string, number>();
		// Per-file join state. Enter rows carry the call arguments; exit rows
		// carry outcome and the observed parent link. Keyed by
		// (request, thread, component): multi-threaded traces and repeated
		// per-request calls must never cross-contaminate — an exemplar's
		// args/chain have to come from the same thread of execution as the
		// failing exit.
		const lastArgs = new Map<string, { schema: string | null; summary: Record<string, unknown> | null }>();
		const parentOf = new Map<string, string | null>(); // req\0thread\0comp → parent comp
		// Exit outcome per frame, for containment: an error that an ancestor
		// absorbed (that ancestor exited `ok`) is handled control flow, not a
		// defect. Populated on exit rows; read in the post-pass below, because a
		// caller's exit is written AFTER the callee's as the stack unwinds.
		const exitOkOf = new Map<string, boolean>(); // req\0thread\0comp → exited ok
		/**
		 * The (request, thread, component) key shape shared by `lastArgs`,
		 * `parentOf` and `exitOkOf`. Must stay byte-identical to the inline
		 * `reqKey` those maps are written with — same NUL separator.
		 */
		const keyOf = (req: string, thread: number, comp: string): string =>
			`${req}\u0000${thread}\u0000${comp}`;
		const errorExits: Array<{
			component: string;
			request_id: string;
			thread_id: number;
			error_type: string;
			error_message: string | null;
			error_stack: string | null;
			duration_ms: number;
			// Snapshot of the enter args CURRENT AT THIS EXIT (the invocation
			// that failed), not whatever enter happens to be last in the file.
			args: { schema: string | null; summary: Record<string, unknown> | null } | null;
		}> = [];
		for (const line of text.split('\n')) {
			if (!line.includes('"enter"') && !line.includes('"exit"')) {
				continue;
			}
			let ev: RawTraceRow;
			try {
				ev = JSON.parse(line) as RawTraceRow;
			} catch {
				continue;
			}
			if (!ev.component) {
				continue;
			}
			const reqKey = `${ev.request_id ?? ''}\u0000${ev.thread_id ?? 0}\u0000${ev.component}`;
			if (ev.event === 'enter') {
				lastArgs.set(reqKey, {
					schema: ev.args_schema ?? null,
					summary:
						ev.args_summary && typeof ev.args_summary === 'object' ? ev.args_summary : null,
				});
				if (ev.parent_component !== undefined) {
					parentOf.set(reqKey, ev.parent_component ?? null);
				}
				continue;
			}
			if (ev.event !== 'exit') {
				continue;
			}
			if (ev.parent_component !== undefined) {
				parentOf.set(reqKey, ev.parent_component ?? null);
			}
			const ms = Number(ev.duration_ms ?? 0) || 0;
			const errType = ev.error_type && ev.error_type !== 'None' ? ev.error_type : null;
			// A frame that exits without an error type absorbed whatever its
			// callees raised. Recorded for every exit, not just clean ones, so a
			// re-raising parent reads as `false` rather than unknown.
			exitOkOf.set(reqKey, !errType);
			const callArgs = lastArgs.get(reqKey) ?? null;
			for (const row of rowsFor(ev.component)) {
				const cur = overlay[row] ?? {
					executed: true,
					calls: 0,
					total_ms: 0,
					errors: 0,
					error_types: [],
					failures: [],
					arg_exemplars: [],
					current_errors: 0,
					latest_epoch: null,
				};
				cur.calls += 1;
				cur.total_ms += ms;
				if (errType) {
					cur.errors += 1;
					if (!cur.error_types.includes(errType)) {
						cur.error_types.push(errType);
					}
				} else if (callArgs && (callArgs.schema || callArgs.summary)) {
					// A call that returned normally: record the inputs it ran with so
					// QnA sees them (failing-call args already ride with `failures`).
					recordArgExemplar(cur, callArgs, ev.request_id ?? '', ms);
				}
				overlay[row] = cur;
				const sr = sessionRows.get(row) ?? { errors: 0, failKeys: new Set<string>() };
				if (errType) {
					sr.errors += 1;
					sr.failKeys.add(`${errType} ${ev.error_message ?? ''}`);
				}
				sessionRows.set(row, sr);
			}
			if (errType) {
				errorExits.push({
					component: ev.component,
					request_id: ev.request_id ?? '',
					thread_id: ev.thread_id ?? 0,
					error_type: errType,
					error_message: ev.error_message ?? null,
					error_stack: ev.error_stack ?? null,
					duration_ms: ms,
					args: lastArgs.get(reqKey) ?? null,
				});
			}
			if (flowSink && ev.parent_component) {
				const src = singleRow(ev.parent_component);
				const dst = singleRow(ev.component);
				if (src !== null && dst !== null && src !== dst) {
					const key = `${src}\u0000${dst}`;
					const cur = flowAgg.get(key) ?? {
						src,
						dst,
						calls: 0,
						total_ms: 0,
						errors: 0,
						observed_only: true, // resolved against static edges below
						current_errors: 0,
					};
					cur.calls += 1;
					cur.total_ms += ms;
					// Record the edge as OBSERVED this session (0 errors by
					// default) so a later CLEAN session can supersede an earlier
					// failing one — mirroring the symbol-row sessionRows path.
					// Tracking only error exits here left a fixed call path red.
					flowSessionErrors.set(key, (flowSessionErrors.get(key) ?? 0) + (errType ? 1 : 0));
					if (errType) {
						cur.errors += 1;
					}
					flowAgg.set(key, cur);
				}
			}
		}
		// Fold this session's flow observations into each edge's latest slot.
		// A strictly-newer session replaces; a CONCURRENT one (same epoch+time)
		// merges its errors so a tie never drops a failing path to clean.
		for (const [key, errs] of flowSessionErrors) {
			const cur = flowLatest.get(key);
			if (!cur) {
				flowLatest.set(key, { mark, errors: errs });
			} else {
				const c = cmpSession(mark, cur.mark);
				if (c > 0) {
					flowLatest.set(key, { mark, errors: errs });
				} else if (c === 0) {
					cur.errors += errs;
				}
			}
		}
		// Resolve failure exemplars after the whole file is read, so caller
		// chains can follow observed parent links all the way to the request
		// root regardless of line order. Deduped by (type, message) per row.
		for (const err of errorExits) {
			const chain: string[] = [];
			let cursor: string | null | undefined = parentOf.get(
				`${err.request_id}\u0000${err.thread_id}\u0000${err.component}`,
			);
			while (cursor && chain.length < 32 && !chain.includes(cursor)) {
				chain.push(cursor);
				cursor = parentOf.get(`${err.request_id}\u0000${err.thread_id}\u0000${cursor}`);
			}
			// Containment: walk the same observed chain and ask whether any
			// ancestor exited `ok`. If one did, it caught this exception — the
			// raise never escaped, so it is control flow rather than a defect
			// (the embedder's EADDRINUSE single-instance lock is the canonical
			// case: make_server exits error, _cmd_serve exits ok, main exits ok).
			// Stays `null` when NO ancestor exit was observed at all, which
			// consumers must read as propagated: unknown is never "handled".
			const ancestorOk = chain.map((ancestor) =>
				exitOkOf.get(keyOf(err.request_id, err.thread_id, ancestor)),
			);
			const contained = containmentVerdict(ancestorOk);
			// Innermost ancestor that exited ok — the frame whose except: caught it.
			const containedBy =
				contained === true ? (chain[ancestorOk.indexOf(true)] ?? null) : null;
			const args = err.args;
			const failKey = `${err.error_type} ${err.error_message ?? ''}`;
			for (const row of rowsFor(err.component)) {
				const cur = overlay[row];
				if (!cur) {
					continue;
				}
				const seenKey = `${row}\u0000${failKey}`;
				const prevSeen = failLastSeen.get(seenKey);
				if (!prevSeen || cmpSession(mark, prevSeen) > 0) {
					failLastSeen.set(seenKey, mark);
				}
				const match = cur.failures.find(
					(f) => f.error_type === err.error_type && f.error_message === err.error_message,
				);
				if (match) {
					match.count += 1;
					// Merge containment across occurrences of the same failure
					// identity: it is only "handled" if EVERY observed occurrence
					// was absorbed. One escape makes the whole identity a defect,
					// and an unknown never upgrades a known escape.
					match.contained = mergeContainment(match.contained, contained);
					match.contained_by = match.contained === true ? (match.contained_by ?? containedBy) : null;
					// Prefer an exemplar that carries a traceback over one without.
					if (!match.error_stack && err.error_stack) {
						match.error_stack = err.error_stack;
						match.request_id = err.request_id;
						match.caller_chain = chain;
					}
				} else if (cur.failures.length < MAX_STORED_FAILURES) {
					// Memory bound, not a rendering budget (renderers apply the
					// learned failure_exemplars budget): high-cardinality
					// messages must not grow the snapshot without limit.
					cur.failures.push({
						error_type: err.error_type,
						error_message: err.error_message,
						error_stack: err.error_stack,
						request_id: err.request_id,
						caller_chain: chain,
						args_schema: args?.schema ?? null,
						args_summary: args?.summary ?? null,
						duration_ms: err.duration_ms,
						count: 1,
						capture_epoch: mark.epoch,
						superseded: null,
						contained,
						contained_by: containedBy,
					});
				}
				// current_errors means "is this FAILING now" — it drives the graph's
				// red rings, the "failing:" digest, the ⚠N row labels, the status bar
				// and the Fix-with-Coding-Agent button. An exception a caller caught is
				// not failing, so discount it from this session's tally here, where
				// containment is finally known. Lifetime `errors` deliberately keeps the
				// raw observed count: "it raised N times" stays a true fact.
				if (contained === true) {
					const sr = sessionRows.get(row);
					if (sr) {
						sr.errors = Math.max(0, sr.errors - 1);
						if (!cur.failures.some((f) => f.contained !== true && `${f.error_type} ${f.error_message ?? ''}` === failKey)) {
							sr.failKeys.delete(failKey);
						}
					}
				}
			}
		}
		// Fold this session into each observed row's latest slot. Strictly-newer
		// replaces; CONCURRENT (same epoch+time) merges errors + failure keys, so
		// a tie between a failing and a clean run never reads as fixed.
		for (const [row, sr] of sessionRows) {
			const cur = rowLatest.get(row);
			if (!cur) {
				rowLatest.set(row, { mark, errors: sr.errors, failKeys: sr.failKeys });
			} else {
				const c = cmpSession(mark, cur.mark);
				if (c > 0) {
					rowLatest.set(row, { mark, errors: sr.errors, failKeys: sr.failKeys });
				} else if (c === 0) {
					cur.errors += sr.errors;
					for (const k of sr.failKeys) {
						cur.failKeys.add(k);
					}
				}
			}
		}
	}
	// Lifecycle verdicts, evidence-ordered. For each row: current_errors come
	// from its latest session; each failure exemplar is CURRENT only when its
	// last sighting IS the latest session and the code has not changed since.
	for (const [rowKey, fact] of Object.entries(overlay)) {
		const row = Number(rowKey);
		const latest = rowLatest.get(row);
		if (!latest) {
			continue; // derived-only row: currency handled in absorb()
		}
		fact.current_errors = latest.errors;
		fact.latest_epoch = latest.mark.epoch;
		const chunkEpoch = nodes[row]?.epoch ?? 0;
		const latestEpoch = latest.mark.epoch;
		for (const f of fact.failures) {
			const seen = failLastSeen.get(`${row}\u0000${f.error_type} ${f.error_message ?? ''}`);
			if (!seen) {
				continue;
			}
			f.capture_epoch = seen.epoch;
			if (cmpSession(seen, latest.mark) < 0) {
				// A later run observed this symbol without this failure. Call it
				// verified-fixed only when that clean run exercised the CURRENT
				// code; if the code changed again afterward, the fix is unverified.
				f.superseded =
					latestEpoch !== null && chunkEpoch > latestEpoch ? 'code_changed' : 'not_reproduced';
			} else if (seen.epoch !== null && chunkEpoch > seen.epoch) {
				// The code moved on after the failure; no fresh run yet.
				f.superseded = 'code_changed';
			} else {
				f.superseded = null;
			}
		}
	}
	// Highest-frequency failures first, so renderers under a budget keep the
	// exemplars that explain the most observed behavior.
	for (const fact of Object.values(overlay)) {
		fact.failures.sort((a, b) => b.count - a.count);
		fact.arg_exemplars?.sort((a, b) => b.count - a.count);
	}
	if (flowSink) {
		for (const [key, edge] of flowAgg) {
			edge.current_errors = flowLatest.get(key)?.errors ?? 0;
		}
		flowSink.push(...flowAgg.values());
	}
}

/** Recursively finds every trace.jsonl under the captures root. */
export function findTraceFiles(root: string): string[] {
	const out: string[] = [];
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
			const p = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(p, depth + 1);
			} else if (e.isFile() && e.name === 'trace.jsonl') {
				out.push(p);
			}
		}
	};
	walk(root, 0);
	return out;
}

/**
 * Builds the full snapshot the Graph Explorer webview renders (and the QnA
 * pipeline slices). Everything is computed from on-disk artifacts.
 */
export function buildGraphSnapshot(workspaceRoot: string): GraphSnapshot {
	const storeDir = indexStoreDir(workspaceRoot);
	const nodes = loadNodes(storeDir);
	const edges = loadEdges(storeDir, nodes.length);
	const storeEpoch = loadStoreEpoch(storeDir);
	const { files, fileEdges } = buildFileLevel(nodes, edges, storeEpoch);
	const { runtime, flow } = loadRuntimeAndFlow(workspaceRoot, nodes, edges);
	return {
		generated_at: new Date().toISOString(),
		workspace: workspaceRoot,
		store_epoch: storeEpoch,
		node_count: nodes.length,
		edge_count: edges.length,
		layers: [...LAYERS],
		nodes,
		edges,
		files,
		file_edges: fileEdges,
		tour: buildTour(nodes, edges),
		runtime,
		flow_edges: flow,
	};
}

/**
 * Budgeted neighborhood expansion around seed rows — the graph slice attached
 * to QnA answers and harness context packs. Breadth-first over invoke/inherit
 * (both directions) plus `contains` parents, ranked by PageRank, capped by
 * `budget` nodes. Mirrors the Rust side's personalized-PageRank neighbor idea
 * without re-running the binary.
 */
export function graphSlice(
	nodes: GraphNode[],
	edges: GraphEdge[],
	seedRows: number[],
	depth: number,
	budget: number,
): GraphNode[] {
	const adjacency: number[][] = Array.from({ length: nodes.length }, () => []);
	for (const e of edges) {
		if (e.src === e.dst) {
			continue;
		}
		adjacency[e.src].push(e.dst);
		adjacency[e.dst].push(e.src);
	}
	const seen = new Set<number>(seedRows.filter((r) => r >= 0 && r < nodes.length));
	let frontier = [...seen];
	for (let hop = 0; hop < depth && seen.size < budget; hop++) {
		const next: number[] = [];
		// Expand highest-rank frontier nodes first so the budget favors hubs.
		frontier.sort((a, b) => nodes[b].rank - nodes[a].rank);
		for (const row of frontier) {
			for (const neighbor of adjacency[row]) {
				if (!seen.has(neighbor)) {
					seen.add(neighbor);
					next.push(neighbor);
					if (seen.size >= budget) {
						break;
					}
				}
			}
			if (seen.size >= budget) {
				break;
			}
		}
		frontier = next;
	}
	return [...seen].map((row) => nodes[row]).sort((a, b) => b.rank - a.rank);
}
