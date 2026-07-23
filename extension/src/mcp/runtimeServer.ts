/**
 * Minimal MCP stdio server exposing tracelens' *runtime* observations as tools.
 *
 * Companion to indexServer.ts (which serves static code search). Where the index
 * answers "where is this code", this server answers "what did this code do when
 * it ran" — value profiles, suspect ranking, slices, blast radius, coverage and
 * call structure — all read straight from the captured trace(s) under
 * .vinv/captures. It is strictly observe-only: it never runs, verifies, or edits
 * anything.
 *
 * Speaks JSON-RPC 2.0 over stdio with no external dependency (single compiled
 * .js), launched by Cursor/any MCP client with the workspace root as argv[2]:
 *
 *   node out/mcp/runtimeServer.js <workspaceRoot>
 */
import {
	toolBlastRadius,
	toolCallersOf,
	toolCoverageOf,
	toolRankSuspects,
	toolSlice,
	toolValuesOf,
	toolWhyDidThisRun,
} from '../runtime/analysis';
import { discoverStores, describeProvenance } from '../graph/storeDiscovery';

const PROTOCOL_VERSION = '2024-11-05';
const launchRoot = process.argv[2] ?? process.cwd();

/**
 * The root whose captures the tools read. The launch root used to be assumed
 * blindly — when the user opens a parent folder of repos that each own a
 * .vinv, that assumption serves the (often empty) parent store while the real
 * captures sit one level down. Discovery keeps the launch root whenever it
 * has any usable capture; otherwise it falls back to the store with the most
 * recent captures, and every reply states which store answered (provenance),
 * so "no data" is never silently ambiguous.
 */
function effectiveRoot(): { root: string; provenance: string } {
	const stores = discoverStores(launchRoot);
	const now = Date.now();
	const own = stores.find((s) => s.root === launchRoot);
	const chosen =
		own && own.captureCount > 0 && !own.allCapturesUninstrumented
			? own
			: (stores.find((s) => s.captureCount > 0 && !s.allCapturesUninstrumented) ?? own);
	if (!chosen) {
		return { root: launchRoot, provenance: `store ${launchRoot}, no .vinv found` };
	}
	return { root: chosen.root, provenance: describeProvenance(chosen, now) };
}

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: number | string | null;
	method: string;
	params?: Record<string, unknown>;
}

function send(message: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id: number | string | null | undefined, result: unknown): void {
	send({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string | null | undefined, code: number, message: string): void {
	send({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Injected into the client's system prompt at initialize. States the workflow
 * ordering (suspects → slice/values, before source reading) that individual
 * tool descriptions can't establish on their own.
 */
const INSTRUCTIONS =
	'This workspace has captured runtime traces (Vinv): real argument/return ' +
	'values, call graphs, and per-request pass/fail outcomes from actual runs. ' +
	'When debugging a failure, call rank_suspects FIRST — before reading source ' +
	'files — then slice and values_of on the top suspects; these report what ' +
	'actually happened at runtime, not static guesses. Use coverage_of to see ' +
	'what ran, and callers_of / blast_radius / why_did_this_run for observed ' +
	'call structure. All tools are read-only over the traces.';

const symbolArg = {
	symbol: {
		type: 'string',
		description: 'Symbol to inspect: a dotted qualname or a unique short name.',
	},
};

const TOOLS = [
	{
		name: 'values_of',
		description:
			'Value profile for a symbol across the captured run(s): per-argument and ' +
			'return type mix, null-rate, numeric/length ranges, and most-common values. ' +
			'Answers "what does this function actually receive and return at runtime" — ' +
			'use this for ground truth instead of inferring inputs/outputs from source.',
		inputSchema: { type: 'object', properties: symbolArg, required: ['symbol'] },
	},
	{
		name: 'rank_suspects',
		description:
			'Call FIRST when investigating a bug, error, or failing request/test: ranks ' +
			'symbols by fault suspiciousness (Ochiai SBFL) over the pass/fail spectra ' +
			'of all captured requests. Answers "which functions should I look at first ' +
			'for this failure" — cheaper and more targeted than reading source files.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Max suspects to return (default 20).' },
			},
		},
	},
	{
		name: 'slice',
		description:
			'Backward dynamic slice to a symbol: the caller chain from the request root ' +
			'down to it, annotated with the argument/return values observed at each ' +
			'frame. Answers "what flowed in to reach this call" — use when tracing how ' +
			'a bad value or state reached a function.',
		inputSchema: { type: 'object', properties: symbolArg, required: ['symbol'] },
	},
	{
		name: 'blast_radius',
		description:
			'Transitive callers (upstream) and callees (downstream) of a symbol in the ' +
			'observed call graph. Answers "if this is wrong, what could be implicated or ' +
			'affected".',
		inputSchema: {
			type: 'object',
			properties: {
				...symbolArg,
				direction: {
					type: 'string',
					enum: ['up', 'down', 'both'],
					description: 'up = callers only, down = callees only, both (default).',
				},
			},
			required: ['symbol'],
		},
	},
	{
		name: 'why_did_this_run',
		description:
			'The entry-point triggers and call paths that led to a symbol running. ' +
			'Answers "why was this function invoked".',
		inputSchema: { type: 'object', properties: symbolArg, required: ['symbol'] },
	},
	{
		name: 'coverage_of',
		description:
			'Execution coverage: with a symbol, its call count / ok-error / timing; ' +
			'without one, every executed symbol ranked by call volume. Answers "what ran ' +
			'and how much".',
		inputSchema: {
			type: 'object',
			properties: {
				symbol: {
					type: 'string',
					description: 'Optional symbol; omit for a whole-run overview.',
				},
			},
		},
	},
	{
		name: 'callers_of',
		description:
			'The observed direct callers of a symbol, with call counts. Answers "who ' +
			'calls this at runtime".',
		inputSchema: { type: 'object', properties: symbolArg, required: ['symbol'] },
	},
];

function dispatch(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const symbol = typeof args.symbol === 'string' ? args.symbol : '';
	const { root, provenance } = effectiveRoot();
	const withProvenance = (out: Record<string, unknown>): Record<string, unknown> => ({
		...out,
		vinv_evidence_source: provenance,
	});
	switch (name) {
		case 'values_of':
			return withProvenance(toolValuesOf(root, symbol));
		case 'rank_suspects':
			return withProvenance(
				toolRankSuspects(root, typeof args.limit === 'number' ? args.limit : 20),
			);
		case 'slice':
			return withProvenance(toolSlice(root, symbol));
		case 'blast_radius':
			return withProvenance(
				toolBlastRadius(
					root,
					symbol,
					args.direction === 'up' || args.direction === 'down' ? args.direction : 'both',
				),
			);
		case 'why_did_this_run':
			return withProvenance(toolWhyDidThisRun(root, symbol));
		case 'coverage_of':
			return withProvenance(
				toolCoverageOf(
					root,
					typeof args.symbol === 'string' && args.symbol ? args.symbol : undefined,
				),
			);
		case 'callers_of':
			return withProvenance(toolCallersOf(root, symbol));
		default:
			return { status: 'error', message: `Unknown tool: ${name}` };
	}
}

const REQUIRES_SYMBOL = new Set([
	'values_of',
	'slice',
	'blast_radius',
	'why_did_this_run',
	'callers_of',
]);

function handle(req: JsonRpcRequest): void {
	switch (req.method) {
		case 'initialize':
			reply(req.id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: 'vinv-runtime', version: '0.0.1' },
				instructions: INSTRUCTIONS,
			});
			return;

		case 'notifications/initialized':
			return; // notification, no response

		case 'tools/list':
			reply(req.id, { tools: TOOLS });
			return;

		case 'tools/call': {
			const params = req.params ?? {};
			const name = params.name as string;
			if (!TOOLS.some((t) => t.name === name)) {
				replyError(req.id, -32602, `Unknown tool: ${name}`);
				return;
			}
			const args = (params.arguments ?? {}) as Record<string, unknown>;
			if (REQUIRES_SYMBOL.has(name) && typeof args.symbol !== 'string') {
				replyError(req.id, -32602, 'Missing required argument: symbol');
				return;
			}
			let out: Record<string, unknown>;
			try {
				out = dispatch(name, args);
			} catch (e) {
				out = { status: 'error', message: e instanceof Error ? e.message : String(e) };
			}
			reply(req.id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
			return;
		}

		default:
			if (req.id !== undefined && req.id !== null) {
				replyError(req.id, -32601, `Method not found: ${req.method}`);
			}
	}
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	buffer += chunk;
	let newline: number;
	while ((newline = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) {
			continue;
		}
		try {
			const req = JSON.parse(line) as JsonRpcRequest;
			handle(req);
		} catch {
			// Ignore malformed lines.
		}
	}
});
