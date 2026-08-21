/**
 * vinv-mcp — one MCP stdio server that exposes ALL of Vinv's tools.
 *
 * Vinv ships three focused MCP stdio servers (index / runtime / exercise). This
 * multiplexer spawns all three as children and presents their union as a single
 * server: `tools/list` merges every tool, and `tools/call` routes to the child
 * that owns the tool. Speaks newline-delimited JSON-RPC 2.0 — the same framing
 * the children use — with no external dependency.
 *
 * The children resolve the Vinv engines via PATH (see engines/resolve.ts), so a
 * `pip install vinv` / `uv tool install vinv` is all that is required alongside.
 *
 *   vinv-mcp [workspaceRoot]      # or set VINV_WORKSPACE
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';

const WORKSPACE = process.env.VINV_WORKSPACE || process.argv[2] || process.cwd();
const HERE = __dirname;

interface Sub {
	name: string;
	proc: ChildProcess;
	pending: Map<number, (msg: any) => void>;
	nextId: number;
}

function send(msg: unknown): void {
	process.stdout.write(JSON.stringify(msg) + '\n');
}

function startSub(file: string, label: string): Sub {
	const proc = spawn(process.execPath, [path.join(HERE, file), WORKSPACE], {
		stdio: ['pipe', 'pipe', 'inherit'],
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

const subs: Sub[] = [
	startSub('indexServer.js', 'index'),
	startSub('runtimeServer.js', 'runtime'),
	startSub('exerciseServer.js', 'exercise'),
];

const toolOwner = new Map<string, Sub>();

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
		await Promise.all(subs.map((s) => callSub(s, 'initialize', params)));
		send({
			jsonrpc: '2.0',
			id,
			result: {
				protocolVersion: params?.protocolVersion ?? '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'vinv', version: '0.0.1' },
			},
		});
		return;
	}

	if (typeof method === 'string' && method.startsWith('notifications/')) {
		notifyAll(method, params);
		return; // notifications get no response
	}

	if (method === 'tools/list') {
		send({ jsonrpc: '2.0', id, result: { tools: await refreshTools() } });
		return;
	}

	if (method === 'tools/call') {
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
