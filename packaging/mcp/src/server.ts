/**
 * vinv-mcp — one MCP stdio server that exposes ALL of Vinv's tools.
 *
 * Vinv ships three focused MCP stdio servers (index / runtime / exercise). This
 * multiplexer spawns all three as children and presents their union as a single
 * server: `tools/list` merges every tool, and `tools/call` routes to the child
 * that owns the tool. Speaks newline-delimited JSON-RPC 2.0 — the same framing
 * the children use — with no external dependency.
 *
 * Workspace discovery: the folder Vinv analyzes is resolved, in order, from an
 * explicit VINV_WORKSPACE / argv path, then the MCP `roots` the client exposes
 * (so ONE global config follows whatever folder the editor has open — no
 * per-repo config), then the process cwd. Children are spawned only once that
 * folder is known, and the index child is told to self-build the index in the
 * background so the first query has something to serve.
 *
 * The children resolve the Vinv engines via PATH (see engines/resolve.ts), so a
 * `pip install vinv` / `uv tool install vinv` is all that is required alongside.
 *
 *   vinv-mcp [workspaceRoot]      # or set VINV_WORKSPACE, or rely on MCP roots
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = __dirname;
const EXPLICIT_WORKSPACE = process.env.VINV_WORKSPACE || process.argv[2] || '';

interface Sub {
	name: string;
	proc: ChildProcess;
	pending: Map<number, (msg: any) => void>;
	nextId: number;
}

function send(msg: unknown): void {
	process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Requests we send TO the client (roots/list) ───────────────────────────
// The MCP transport is bidirectional: to learn the workspace we ask the client
// for its roots. The reply arrives on our stdin and is matched here by id
// before the line is treated as an inbound request.
let outboundId = 0;
const clientPending = new Map<string, (msg: any) => void>();

function callClient(method: string, params: unknown, timeoutMs = 4000): Promise<any> {
	return new Promise((resolve, reject) => {
		const id = `_vinv_${++outboundId}`;
		const timer = setTimeout(() => {
			clientPending.delete(id);
			reject(new Error(`client did not answer ${method} in time`));
		}, timeoutMs);
		clientPending.set(id, (msg) => {
			clearTimeout(timer);
			if (msg.error) reject(msg.error);
			else resolve(msg.result);
		});
		send({ jsonrpc: '2.0', id, method, params });
	});
}

let initializeParams: any = {};
let clientSupportsRoots = false;

function rootUriToPath(uri: unknown): string | null {
	if (typeof uri !== 'string' || !uri) return null;
	try {
		return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
	} catch {
		return null;
	}
}

// ── Workspace resolution (memoized) ───────────────────────────────────────
let workspacePromise: Promise<string> | null = null;

function resolveWorkspace(): Promise<string> {
	if (workspacePromise) return workspacePromise;
	workspacePromise = (async () => {
		if (EXPLICIT_WORKSPACE) return EXPLICIT_WORKSPACE;
		if (clientSupportsRoots) {
			try {
				const res = await callClient('roots/list', {});
				const first = (res?.roots ?? [])
					.map((r: any) => rootUriToPath(r?.uri))
					.find((p: string | null) => !!p);
				if (first) return first as string;
			} catch {
				// client declared roots but did not answer — fall through to cwd
			}
		}
		return process.cwd();
	})();
	return workspacePromise;
}

// ── Children ──────────────────────────────────────────────────────────────
let subs: Sub[] = [];
const toolOwner = new Map<string, Sub>();

function startSub(file: string, label: string, workspace: string, extraEnv?: NodeJS.ProcessEnv): Sub {
	const proc = spawn(process.execPath, [path.join(HERE, file), workspace], {
		stdio: ['pipe', 'pipe', 'inherit'],
		env: { ...process.env, ...extraEnv },
	});
	const sub: Sub = { name: label, proc, pending: new Map(), nextId: 1 };
	readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
		const t = line.trim();
		if (!t) return;
		let msg: any;
		try {
			msg = JSON.parse(t);
		} catch {
			return;
		}
		if (typeof msg.id === 'number' && sub.pending.has(msg.id)) {
			const cb = sub.pending.get(msg.id)!;
			sub.pending.delete(msg.id);
			cb(msg);
		}
	});
	proc.on('exit', () => {
		for (const cb of sub.pending.values()) cb({ error: { code: -32603, message: `${label} server exited` } });
		sub.pending.clear();
	});
	return sub;
}

function callSub(sub: Sub, method: string, params: unknown): Promise<any> {
	return new Promise((resolve) => {
		const id = sub.nextId++;
		sub.pending.set(id, resolve);
		sub.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	});
}

function notifyAll(method: string, params: unknown): void {
	for (const s of subs) s.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

// Spawn + initialize the three children against the resolved workspace. The
// index child gets VINV_MCP_AUTOINDEX so it self-builds the index in the
// background. Memoized: the first caller (initialized notification or the first
// tools request) triggers it, everyone else awaits the same promise.
let childrenPromise: Promise<void> | null = null;

function ensureChildren(): Promise<void> {
	if (childrenPromise) return childrenPromise;
	childrenPromise = (async () => {
		const workspace = await resolveWorkspace();
		subs = [
			startSub('indexServer.js', 'index', workspace, { VINV_MCP_AUTOINDEX: '1' }),
			startSub('runtimeServer.js', 'runtime', workspace),
			startSub('exerciseServer.js', 'exercise', workspace),
		];
		await Promise.all(subs.map((s) => callSub(s, 'initialize', initializeParams)));
		notifyAll('notifications/initialized', {});
	})();
	return childrenPromise;
}

async function restartChildren(): Promise<void> {
	// The open folder changed (roots/list_changed): tear down and re-resolve so
	// the next request targets — and indexes — the new workspace.
	for (const s of subs) s.proc.kill();
	subs = [];
	toolOwner.clear();
	workspacePromise = null;
	childrenPromise = null;
	await ensureChildren();
	send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

async function refreshTools(): Promise<any[]> {
	const tools: any[] = [];
	toolOwner.clear();
	const results = await Promise.all(subs.map((s) => callSub(s, 'tools/list', {}).then((r) => ({ s, r }))));
	for (const { s, r } of results) {
		for (const t of r?.result?.tools ?? []) {
			toolOwner.set(t.name, s);
			tools.push(t);
		}
	}
	return tools;
}

async function handle(req: any): Promise<void> {
	const { id, method, params } = req;

	if (method === 'initialize') {
		initializeParams = params ?? {};
		clientSupportsRoots = !!params?.capabilities?.roots;
		send({
			jsonrpc: '2.0',
			id,
			result: {
				protocolVersion: params?.protocolVersion ?? '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'vinv', version: '0.0.6' },
			},
		});
		return;
	}

	if (method === 'notifications/initialized') {
		// Client is ready: roots/list is answerable now, so spawn children and
		// start background indexing without waiting for the first tools call.
		ensureChildren().catch(() => {});
		return;
	}

	if (method === 'notifications/roots/list_changed') {
		restartChildren().catch(() => {});
		return;
	}

	if (typeof method === 'string' && method.startsWith('notifications/')) {
		if (subs.length) notifyAll(method, params);
		return; // notifications get no response
	}

	if (method === 'tools/list') {
		await ensureChildren();
		send({ jsonrpc: '2.0', id, result: { tools: await refreshTools() } });
		return;
	}

	if (method === 'tools/call') {
		await ensureChildren();
		const name = params?.name;
		let owner = toolOwner.get(name);
		if (!owner) {
			await refreshTools();
			owner = toolOwner.get(name);
		}
		if (!owner) {
			send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } });
			return;
		}
		const r = await callSub(owner, 'tools/call', params);
		if (r.error) send({ jsonrpc: '2.0', id, error: r.error });
		else send({ jsonrpc: '2.0', id, result: r.result });
		return;
	}

	if (id !== undefined) {
		send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
	}
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
	const t = line.trim();
	if (!t) return;
	let req: any;
	try {
		req = JSON.parse(t);
	} catch {
		return;
	}
	// A response to a request WE sent the client (e.g. roots/list) — match and
	// resolve it before treating the line as an inbound request.
	if (req && req.method === undefined && req.id !== undefined && clientPending.has(req.id)) {
		const cb = clientPending.get(req.id)!;
		clientPending.delete(req.id);
		cb(req);
		return;
	}
	handle(req).catch((e) => {
		if (req?.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(e) } });
	});
});

function shutdown(): void {
	for (const s of subs) s.proc.kill();
	process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
