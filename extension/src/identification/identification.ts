import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getBinPath, isBinAvailable } from '../tracelens/bin';
import { getIndexEnv } from '../config/settings';

/** Per-workspace tracelens captures root: <workspace>/.vinv/captures */
export function getCapturesDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'captures');
}

/**
 * True when this workspace has at least one captured session on disk.
 *
 * bringup/service runs write tracelens output under <workspace>/.vinv/captures
 * (see getBringupEnv's VINV_CAPTURES_DIR). The presence of a non-empty captures
 * tree is our signal that a session exists and the Sessions view should surface
 * the project's entry points.
 */
export function hasCaptures(workspaceRoot: string): boolean {
	try {
		return fs.readdirSync(getCapturesDir(workspaceRoot)).length > 0;
	} catch {
		return false;
	}
}

/** Project-local API/entry-point inventory: <workspace>/.vinv/identification/apis.json */
export function getApisPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'identification', 'apis.json');
}

/**
 * One starting point a service exposes, as emitted by `identification
 * consolidate`. `kind` discriminates HTTP routes (`http_api`) from CLI commands,
 * background/queue workers, scheduled jobs, lifecycle hooks, and bare `__main__`
 * script entries. `trigger` is the human-facing label (e.g. "GET /health" or a
 * command name); `handler` is the enclosing symbol resolved from the code index.
 */
export interface EntryPoint {
	kind: string;
	id: string;
	trigger: string;
	handler: string | null;
	file: string;
	line: number;
	framework: string;
}

/** One HTTP route from the back-compat `apis` array (older consolidate builds). */
interface HttpApi {
	id: string;
	method: string;
	path: string;
	handler: string | null;
	file: string;
	line: number;
	framework: string;
}

/** The JSON document `identification consolidate` prints (and writes to apis.json). */
interface ConsolidateResult {
	status: string;
	error?: string;
	code_root?: string;
	/** Full entry-point set (current builds). */
	entrypoints?: EntryPoint[];
	/** HTTP-only view, always present; the only field older builds emit. */
	apis?: HttpApi[];
}

/**
 * Normalises a consolidate result to entry points. Prefers the unified
 * `entrypoints` set (current builds); falls back to mapping the HTTP-only `apis`
 * array (older builds emit only that) so a stale binary still populates the view.
 */
function entryPointsOf(result: ConsolidateResult): EntryPoint[] {
	if (Array.isArray(result.entrypoints)) {
		return result.entrypoints;
	}
	if (Array.isArray(result.apis)) {
		return result.apis.map((a) => ({
			kind: 'http_api',
			id: a.id,
			trigger: `${a.method} ${a.path}`,
			handler: a.handler,
			file: a.file,
			line: a.line,
			framework: a.framework,
		}));
	}
	return [];
}

/** Reads a previously written apis.json, returning [] when absent/unparseable. */
export function readEntryPoints(workspaceRoot: string): EntryPoint[] {
	try {
		const raw = fs.readFileSync(getApisPath(workspaceRoot), 'utf8');
		return entryPointsOf(JSON.parse(raw) as ConsolidateResult);
	} catch {
		return [];
	}
}

/** Any JSON document `identification` emits — all carry a `status` field. */
interface IdentificationResult {
	status: string;
	error?: string;
}

/**
 * Spawns the `identification` binary with the given subcommand args, captures its
 * stdout, and parses the single JSON document it prints. Rejects with the result's
 * error message (or stderr) when the command reports `status: "error"`, fails to
 * emit JSON, or exits abnormally.
 */
function runIdentification<T extends IdentificationResult>(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	args: string[],
): Promise<T> {
	const binPath = getBinPath(context, 'identification');
	try {
		fs.chmodSync(binPath, 0o755);
	} catch {
		// Non-fatal: a real failure surfaces when the command runs.
	}

	return new Promise<T>((resolve, reject) => {
		// The result JSON is printed to stdout; any logging goes to stderr.
		const child = spawn(binPath, args, {
			cwd: workspaceRoot,
			env: getIndexEnv(path.dirname(binPath)),
			windowsHide: true, // headless CLI: never flash a console window on Windows
		});
		let out = '';
		let err = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			out += chunk;
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			err += chunk;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			let parsed: T;
			try {
				parsed = JSON.parse(out) as T;
			} catch {
				reject(new Error(err.trim() || `identification exited with code ${code ?? 'null'}`));
				return;
			}
			if (parsed.status === 'error') {
				reject(new Error(parsed.error || 'identification failed'));
				return;
			}
			resolve(parsed);
		});
	});
}

/**
 * Loads the workspace's entry points for the Sessions view. Runs `identification
 * consolidate` when the engine is installed (so the list reflects the current
 * source); falls back to the last apis.json on disk when the binary isn't
 * available yet.
 *
 * consolidate is code-based: it reads the Rust index's JSON store (no vectors, no
 * LLM, no running server) and regex-extracts every route/command/worker/job/hook
 * the source defines, then writes the inventory to .vinv/identification/apis.json.
 */
export async function loadEntryPoints(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<EntryPoint[]> {
	if (isBinAvailable(context, 'identification')) {
		const result = await runIdentification<ConsolidateResult>(context, workspaceRoot, [
			'consolidate',
			workspaceRoot,
		]);
		return entryPointsOf(result);
	}
	return readEntryPoints(workspaceRoot);
}

/** One node in a call tree: the root/expanded symbols, plus call-site metadata. */
export interface CallNode {
	/** The call name as recorded in the source (absent on the root symbol). */
	call?: string;
	/** False for external/library calls that resolve to no indexed symbol (leaves). */
	resolved?: boolean;
	symbol_id?: number;
	name?: string;
	file?: string;
	line?: number;
	/** Number of same-named symbols when the call name was ambiguous. */
	ambiguous?: number;
	/** This symbol's subtree was already expanded under another caller (DAG share). */
	expanded_elsewhere?: boolean;
	/** Set (e.g. "max_depth") when recursion was capped before expanding. */
	truncated?: string;
	/** Runtime overlay from `tracemap` — present only on annotated trees. */
	runtime?: RuntimeFact;
	children?: CallNode[];
}

/** A node's runtime fact, as `tracemap` overlays onto each static-tree node. */
export interface RuntimeFact {
	/** True when this function actually ran in the captured trace. */
	executed: boolean;
	/** Invocation count under the matched handler request(s). */
	calls?: number;
	/** Total wall time across those invocations, ms. */
	total_ms?: number;
	/**
	 * Of that wall time, the part spent WAITING on I/O, ms. Without it a function
	 * that blocks on a network call is indistinguishable from one burning CPU for
	 * the same duration — and only one of those is worth optimizing in-process.
	 */
	blocked_ms?: number;
	/**
	 * Net bytes allocated across those invocations, from the engine's own
	 * overlay. Absent unless the capture ran with memory attribution on (the
	 * `standard` preset leaves it off), so it is never a misleading 0.
	 */
	mem_delta_bytes?: number;
	ok?: number;
	error?: number;
	/** Distinct error types observed (when any invocation failed). */
	errors?: string[];
	/**
	 * Net bytes attributed to this function (sum of tracemalloc `mem_delta_bytes`).
	 * Overlaid extension-side from the raw trace (see traceMemory) since the
	 * binary's runtime fact reports latency but not memory. Absent when the
	 * capture has no memory attribution.
	 */
	mem_bytes?: number;
}

/** The entry point a call tree is rooted at. */
export interface CallTreeEntrypoint {
	id: string;
	kind: string;
	method?: string | null;
	path?: string | null;
	trigger?: string | null;
	handler: string;
	file: string;
	line: number;
	framework?: string;
}

/** The JSON document `identification calltree --json` prints. */
export interface CallTreeResult extends IdentificationResult {
	entrypoint?: CallTreeEntrypoint;
	code_root?: string;
	max_depth?: number;
	stats?: {
		internal_functions: number;
		external_calls: number;
		max_depth_reached: number;
	};
	tree?: CallNode;
}

/**
 * Runs `identification calltree <workspace> --api-id <id> --json` and returns the
 * resolved call graph rooted at that entry point's handler. Deterministic: walks
 * the code index's precomputed call graph — no traces, no running server, no LLM.
 * Requires the installed engine.
 */
export function getCallTree(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	apiId: string,
): Promise<CallTreeResult> {
	return runIdentification<CallTreeResult>(context, workspaceRoot, [
		'calltree',
		workspaceRoot,
		'--api-id',
		apiId,
		'--json',
	]);
}

/** One endpoint's runtime hit count from `tracesummary`. */
export interface TraceCount {
	id: string;
	method: string;
	path: string;
	handler: string | null;
	file: string;
	line: number;
	/** Number of distinct trace requests whose server root hit this endpoint. */
	trace_count: number;
}

/** The JSON document `identification tracesummary --json` prints. */
export interface TraceSummaryResult extends IdentificationResult {
	trace_file?: string;
	api_count?: number;
	exercised_count?: number;
	trace_invocations_total?: number;
	endpoints?: TraceCount[];
	unmatched_roots?: { root: string; trace_count: number }[];
}

/**
 * Runs `identification tracesummary <workspace> --json`: ranks every consolidated
 * HTTP endpoint by how many trace requests exercised it (busiest first, never-hit
 * at 0). Needs a captured trace under .vinv/captures; the binary falls back to the
 * first capture dir, so no `--service` is required.
 *
 * Note: tracesummary only covers HTTP endpoints (the `apis` view). Non-HTTP entry
 * points (CLI/worker/hook/script) have no trace_count and aren't returned here.
 *
 * `traceFile` overrides the trace the binary counts (via --trace); the Sessions
 * view passes a time-window-filtered trace here so the hit counts reflect only a
 * selected range. Omit it to count the full default capture.
 */
export function getTraceSummary(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	traceFile?: string,
): Promise<TraceSummaryResult> {
	const args = ['tracesummary', workspaceRoot, '--json'];
	if (traceFile) {
		args.push('--trace', traceFile);
	}
	return runIdentification<TraceSummaryResult>(context, workspaceRoot, args);
}

/**
 * The JSON document `identification tracemap --json` prints: the static call tree
 * (same shape as calltree, but each node carries a `runtime` overlay) plus
 * request/coverage facts and the runtime-only gap.
 */
export interface TraceMapResult extends CallTreeResult {
	trace_file?: string;
	/** Trace request ids in which the handler actually ran. */
	requests_matched?: string[];
	/** False when the handler never ran in this capture (nothing to overlay). */
	handler_observed?: boolean;
	coverage?: {
		static_functions: number;
		executed: number;
		never_executed: number;
		pct: number;
	};
	/** Components that ran under the handler but the static tree didn't predict. */
	runtime_only?: {
		component: string;
		calls: number;
		total_ms: number;
		blocked_ms?: number;
		mem_delta_bytes?: number;
		errors: string[];
	}[];
}

/**
 * Runs `identification tracemap <workspace> --api-id <id> --json`: overlays the
 * captured runtime trace onto the entry point's static call tree, marking each
 * node executed/not, with call counts, durations and errors, plus coverage and the
 * runtime-only gap. Needs a captured trace under .vinv/captures.
 */
export function getTraceMap(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	apiId: string,
	/**
	 * Capture subdirectory to overlay from — the service that serves this
	 * endpoint. Omitting it makes the engine fall back to the freshest capture
	 * ANYWHERE under .vinv/captures, which in a multi-service repo is whichever
	 * service ran last and usually not this one.
	 */
	service?: string,
): Promise<TraceMapResult> {
	return runIdentification<TraceMapResult>(context, workspaceRoot, [
		'tracemap',
		workspaceRoot,
		'--api-id',
		apiId,
		...(service ? ['--service', service] : []),
		'--json',
	]);
}
