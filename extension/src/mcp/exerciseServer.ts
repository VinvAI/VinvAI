/**
 * MCP stdio server for the WRITE half of the loop.
 *
 * indexServer answers "where is this code" and runtimeServer "what did it do
 * when it ran" — both strictly read-only. Neither lets an agent hand anything
 * BACK, which is why a test run driven by an agent leaves the Journey and
 * Findings views empty however many traces it captured: the endpoint half of
 * vinv is fed by its own exerciser and nothing else could reach it.
 *
 * This server closes that. It is deliberately a separate server rather than
 * three more tools on an existing one, so write access can be granted (or
 * withheld) independently of read access.
 *
 *   node out/mcp/exerciseServer.js <workspaceRoot>
 */
import * as fs from 'fs';
import * as path from 'path';

import { ingestRun } from '../harness/exerciseIngest';
import { loadPlaybook } from '../harness/contextPack';

const PROTOCOL_VERSION = '2024-11-05';
const launchRoot = process.argv[2] ?? process.cwd();
/** The installed extension dir — resources/playbooks lives beside out/. */
const extensionDir = path.resolve(__dirname, '..', '..');

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

const INSTRUCTIONS =
	'This workspace uses Vinv. After you exercise a service’s endpoints — under ' +
	'`tracelens run` so the calls are captured — report what you did with ' +
	'vinv_ingest_run. That is what populates the Journey and Findings views; ' +
	'without it the traces are recorded but no endpoint, coverage or issue is ' +
	'shown. You must supply the pass/fail verdict for each check: a trace records ' +
	'that an endpoint returned 200 after four minutes, but only you can judge that ' +
	'this is a defect. Then read vinv_list_candidates for ranked optimization ' +
	'opportunities, each with a playbook describing how to fix that class of waste.';

const TOOLS = [
	{
		name: 'vinv_ingest_run',
		description:
			'Report a test run you performed, so it appears in the Journey and Findings ' +
			'views. Supply one entry per check with the unit you exercised, a scenario ' +
			'name, and the pass/fail verdict — the verdict is the one thing traces cannot ' +
			'supply. A unit is usually an HTTP endpoint ("METHOD /path"), but a repo with ' +
			'no service has units too: a CLI invocation ("RUN <command>") or a driven ' +
			'function ("CALL module.function"). Per-unit code coverage is joined ' +
			'automatically from the captures. Run this AFTER the work has been captured ' +
			'by tracelens.',
		inputSchema: {
			type: 'object',
			properties: {
				source: {
					type: 'string',
					description: 'Who produced this run, recorded as provenance (e.g. "claude-code e2e suite").',
				},
				checks: {
					type: 'array',
					description: 'One entry per check performed.',
					items: {
						type: 'object',
						properties: {
							endpoint: {
								type: 'string',
								description:
									'The unit exercised: "METHOD /path" for HTTP (e.g. "POST /run-agent"), ' +
									'"RUN <command>" for a CLI invocation, or "CALL module.function" for a ' +
									'driven call. Keep the verb prefix — it is what distinguishes the three ' +
									'in every view.',
							},
							unit_kind: {
								type: 'string',
								description:
									'http_endpoint | cli_invocation | function_call. Optional; inferred from ' +
									'the verb prefix when omitted.',
							},
							service: {
								type: 'string',
								description:
									'Which service or CLI this belongs to. Supply this whenever the repo runs ' +
									'more than one — three apps each serving "GET /" are three different ' +
									'units, and without this they merge into one row with pooled latencies.',
							},
							name: { type: 'string', description: 'Scenario name, e.g. "malformed JSON body".' },
							category: {
								type: 'string',
								description: 'positive | negative | corner | security | load.',
							},
							status: {
								type: 'number',
								description:
									'HTTP status observed — or the process exit code for a CLI invocation.',
							},
							latency_ms: { type: 'number' },
							input: { description: 'What was sent.' },
							output: { description: 'What came back.' },
							passed: { type: 'boolean', description: 'THE VERDICT — did this check pass?' },
							severity: { type: 'string', description: 'low | medium | high, when failed.' },
							detail: { type: 'string', description: 'Why it failed, in your words.' },
							round: { type: 'number', description: 'Which repetition of the suite.' },
						},
						required: ['endpoint', 'name', 'passed'],
					},
				},
			},
			required: ['checks'],
		},
	},
	{
		name: 'vinv_list_candidates',
		description:
			'Ranked optimization candidates from the captured traces, each with the ' +
			'evidence behind it and a playbook for that class of waste (cache, fanout, ' +
			'n-plus-1, per-call, serial-async, wait, gc-pressure, alloc-churn, mem-leak). ' +
			'Read this before attempting any performance work — it reports what the ' +
			'traces actually measured, not a static guess.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Max candidates to return (default 10).' },
				include_playbook: {
					type: 'boolean',
					description: 'Include the full playbook text for each candidate (default true).',
				},
			},
		},
	},
	{
		name: 'vinv_run_status',
		description:
			'What vinv currently holds for this workspace: capture sessions, whether an ' +
			'external run has been ingested, endpoint/coverage/issue counts, and the ' +
			'number of ranked candidates. Call this to check whether an ingest landed.',
		inputSchema: { type: 'object', properties: {} },
	},
];

function readJson(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function toolIngest(args: Record<string, unknown>): Record<string, unknown> {
	const res = ingestRun(launchRoot, args, { write: true });
	if (res.status === 'error') {
		return { status: 'error', message: res.message };
	}
	const notes: string[] = [];
	if (res.symbols_total === 0) {
		notes.push(
			'No index found, so code coverage is 0/0. Run the Vinv index over this repo to populate it.',
		);
	}
	if (res.endpoints_without_traces.length > 0) {
		notes.push(
			`No captured request matched these endpoints, so their coverage is 0: ${res.endpoints_without_traces.join(', ')}. ` +
				'Either the traffic was not captured under `tracelens run`, or the app’s web ' +
				'framework has no OpenTelemetry instrumenter installed (tracelens logs a warning when so).',
		);
	}
	return { ...res, notes };
}

function toolListCandidates(args: Record<string, unknown>): Record<string, unknown> {
	const limit = typeof args.limit === 'number' ? args.limit : 10;
	const withPlaybook = args.include_playbook !== false;
	const mirror = readJson(path.join(launchRoot, '.vinv', 'reports', 'optimization.json'));
	const raw = Array.isArray(mirror?.candidates) ? (mirror!.candidates as Record<string, unknown>[]) : [];
	if (raw.length === 0) {
		return {
			status: 'ok',
			candidates: [],
			message:
				'No ranked candidates yet. They are computed from tracelens captures under ' +
				'.vinv/captures — capture a run first.',
		};
	}
	const candidates = raw.slice(0, limit).map((c) => {
		const kind = String(c.waste_kind ?? 'per-call');
		const out: Record<string, unknown> = {
			symbol: c.name,
			location: `${c.file}:${c.line}`,
			dimension: c.dimension ?? 'latency',
			unit: c.unit ?? 'ms',
			predicted_recoverable: c.predicted_ms,
			observed_total: c.total_ms,
			calls: c.calls,
			waste_kind: kind,
			evidence: c.reason,
			status: c.status ?? 'candidate',
		};
		if (withPlaybook) {
			// loadPlaybook throws on an unknown kind or a missing file. A candidate
			// whose waste kind has no shipped playbook must still be returned — the
			// evidence is the valuable part; the guidance is a bonus.
			try {
				out.playbook = loadPlaybook(extensionDir, kind);
			} catch (e) {
				out.playbook_unavailable = e instanceof Error ? e.message : String(e);
			}
		}
		return out;
	});
	return { status: 'ok', count: candidates.length, total_available: raw.length, candidates };
}

function toolRunStatus(): Record<string, unknown> {
	const vinv = path.join(launchRoot, '.vinv');
	const captures = path.join(vinv, 'captures');
	const sessions: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 4) {
			return;
		}
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(full, depth + 1);
			} else if (e.name === 'trace.jsonl') {
				sessions.push(path.relative(captures, full));
			}
		}
	};
	walk(captures, 0);

	const scorecard = readJson(path.join(vinv, 'exercise', 'scorecard.json'));
	const issues = readJson(path.join(vinv, 'exercise', 'issues.json'));
	const opt = readJson(path.join(vinv, 'reports', 'optimization.json'));
	const after = ((scorecard?.coverage as Record<string, unknown>)?.after_exercised ??
		{}) as Record<string, unknown>;

	return {
		status: 'ok',
		workspace: launchRoot,
		capture_sessions: sessions.length,
		captures: sessions.slice(0, 20),
		ingested_run: scorecard
			? {
					source: scorecard.source ?? scorecard.ingested_by ?? 'unknown',
					generated_at: scorecard.generated_at ?? null,
					endpoints: Array.isArray(scorecard.endpoints) ? scorecard.endpoints.length : 0,
					endpoints_with_coverage: after.endpoints_with_coverage ?? 0,
					symbols_covered: after.symbols_covered ?? 0,
					symbols_total: after.symbols_total ?? 0,
					issue_clusters: issues?.cluster_count ?? 0,
				}
			: null,
		ranked_candidates: Array.isArray(opt?.candidates) ? (opt!.candidates as unknown[]).length : 0,
		hint: scorecard
			? undefined
			: 'No external run ingested yet — call vinv_ingest_run after exercising the endpoints.',
	};
}

function dispatch(name: string, args: Record<string, unknown>): Record<string, unknown> {
	switch (name) {
		case 'vinv_ingest_run':
			return toolIngest(args);
		case 'vinv_list_candidates':
			return toolListCandidates(args);
		case 'vinv_run_status':
			return toolRunStatus();
		default:
			return { status: 'error', message: `Unknown tool: ${name}` };
	}
}

function handle(req: JsonRpcRequest): void {
	switch (req.method) {
		case 'initialize':
			reply(req.id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: 'vinv-exercise', version: '0.0.1' },
				instructions: INSTRUCTIONS,
			});
			return;
		case 'notifications/initialized':
			return;
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
			handle(JSON.parse(line) as JsonRpcRequest);
		} catch {
			// malformed line — ignore, keep the stream alive
		}
	}
});
