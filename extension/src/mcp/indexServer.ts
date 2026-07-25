/**
 * Minimal MCP stdio server exposing the bundled code index as a single tool.
 *
 * Speaks JSON-RPC 2.0 over stdio (the MCP transport) without any external
 * dependency, so it ships as a single compiled .js. Launched by Cursor (or any
 * MCP client) with the workspace root as argv[2].
 *
 *   node out/mcp/indexServer.js <workspaceRoot>
 *
 * Embeddings come from the local vinv-embedder sidecar (started on demand);
 * the index binary is pointed at its OpenAI-compatible gateway — no cloud
 * credentials are involved.
 */
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { resolveIndexBinary } from '../engines/resolve';
import { EMBEDDER_GATEWAY_URL, ensureEmbedderRunning } from '../embedder/sidecar';
import * as fs from 'fs';
import {
	appendRetrievalEvent,
	loadPolicyForEpoch,
	loadTelemetryState,
	queryFeatures,
	retrievalEpoch,
	saveTelemetryState,
	selectRetrievalAction,
	PendingDecision,
	TelemetryState,
} from './retrievalTelemetry';
import {
	loadSession,
	setEpisodeBudget,
	setGoal,
} from '../harness/session';
import {
	composeTrajectoryReport,
	readEpisodeEvents,
} from '../harness/trajectoryReport';
import {
	collectCacheCandidates,
	collectMemoryTrends,
	collectRuntimeErrorClusters,
	selectHotspots,
} from '../harness/runtimeAnalysis';
import {
	loadOpportunityBoard,
	renderOpportunityBoard,
	syncOpportunityBoard,
} from '../harness/opportunityBoard';
import {
	loadNodes,
	loadRuntimeOverlay,
	indexStoreDir,
	type GraphNode,
	type RuntimeOverlay,
} from '../graph/indexGraph';
import { discoverStores, describeProvenance } from '../graph/storeDiscovery';
import { EVAL_EVERY, maybeRunOpeEvaluation } from './opeEvaluator';
import {
	enqueueEpisodeRequest,
	type EpisodeRequestKind,
} from '../harness/requestQueue';
import { composePlaybookSlice, PLAYBOOK_KINDS } from '../harness/contextPack';

const PROTOCOL_VERSION = '2024-11-05';
const workspaceRoot = process.argv[2] ?? process.cwd();
// This file runs bundled at <extension>/out/mcp/indexServer.js, so the
// extension dir (whose parent may be the engines monorepo in a dev checkout)
// is two levels up.
const extensionDir = path.resolve(__dirname, '..', '..');
const storeDir = path.join(workspaceRoot, '.vinv', 'index');

function indexBinPath(): string | null {
	return resolveIndexBinary({ extensionDir });
}

/**
 * Environment for the index binary: queries embed through the local
 * vinv-embedder gateway — no keys, no cloud endpoints.
 */
function indexEnv(): NodeJS.ProcessEnv {
	return { ...process.env, INDEX_GATEWAY_URL: EMBEDDER_GATEWAY_URL };
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

async function runQuery(query: string, topK: number): Promise<{ output: string; latencyMs: number }> {
	const indexBin = indexBinPath();
	if (!indexBin) {
		return {
			output: JSON.stringify({
				status: 'error',
				error: 'the Vinv index engine is not installed — run "Vinv: Install Engines" in the editor',
			}),
			latencyMs: 0,
		};
	}
	// Queries embed through the local sidecar; make sure it is serving first
	// (an already-running instance — any window, any editor — is reused).
	await ensureEmbedderRunning({ extensionDir });
	return new Promise((resolve) => {
		const started = process.hrtime.bigint();
		execFile(
			indexBin,
			['query', query, '--repo-path', workspaceRoot, '--store-dir', storeDir, '--top-k', String(topK)],
			{ maxBuffer: 32 * 1024 * 1024, env: indexEnv() },
			(error, stdout, stderr) => {
				const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
				if (stdout) {
					resolve({ output: stdout, latencyMs });
					return;
				}
				resolve({
					output: JSON.stringify({
						status: 'error',
						error: error ? error.message : stderr || 'index query produced no output',
					}),
					latencyMs,
				});
			},
		);
	});
}

/**
 * Injected into the client's system prompt at initialize. Tool descriptions
 * compete inside a flat tool list; this is read as policy, so it carries the
 * "use this before grep" ordering that actually drives adoption.
 */
const INSTRUCTIONS =
	'This workspace has a prebuilt semantic code index (Vinv). To locate code by ' +
	'meaning or behavior — "where is X handled", "what implements Y" — call ' +
	'vinv_query FIRST, before grep/text search or directory exploration: one call ' +
	'returns the relevant symbols ranked, with file paths. Fall back to text ' +
	'search only for exact-string lookups or when the index returns nothing ' +
	'useful. After acting on results, report once whether they helped via ' +
	'vinv_feedback with the vinv_decision_id from the response. ' +
	'Everything Vinv knows and does is also driveable from this chat via ' +
	'vinv_session — do not search source code for this live state: ' +
	'action="trajectory" shows the trajectory — episodes, rewards, goals, ' +
	'disputes and learning; action="status" gives the short session summary; ' +
	'action="issues" lists functions observed raising errors in live traces; ' +
	'action="hotspots" lists where traced runtime concentrates; ' +
	'action="memory_trends" lists cross-session leak suspects; ' +
	'action="cache_candidates" lists duplicate-recomputation sites; ' +
	'action="opportunities" shows the live optimization opportunity board — the ' +
	'shared ledger every sweep posts to and dispatch consumes (posted entries ' +
	'are dispatchable; dispatched/resolved never re-dispatch until they expire); ' +
	'action="playbook" with kind (e.g. cache, n-plus-1, throughput-ceiling) ' +
	'returns distilled fix guidance for that kind of performance waste plus the ' +
	'file paths holding this workspace’s current evidence of it. ' +
	'To ACT: action="fix" with an issue description (and optional service) ' +
	'queues a closed-loop fix episode that the Vinv extension dispatches to the ' +
	'coding harness; action="run_sweep" with sweep one of ' +
	'runtime_errors|hotspots|memory_trends|cache_candidates queues that ' +
	'evidence-seeded episode. action="set_goal"/"set_budget" steer ' +
	'future episodes. ' +
	'When you are working on a task Vinv dispatched (a context pack in ' +
	'.vinv/episodes/), you can talk back to Vinv by printing a line starting ' +
	'with "vinv:" in your final output — e.g. "vinv: episodes 8" to extend the ' +
	'episode budget or "vinv: goal <text>" to update the standing goal; Vinv ' +
	'parses these directives after every run and adjusts the session.';

const TOOL = {
	name: 'vinv_query',
	description:
		'Semantic code search over the prebuilt index of this workspace. Use INSTEAD ' +
		'of grep/glob when looking for code by meaning or behavior rather than an ' +
		'exact string — e.g. "where are auth tokens refreshed", "what validates ' +
		'uploads". Returns the most relevant symbols (functions/classes) ranked, ' +
		'with file paths and scores, in a single call.',
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Natural-language search query.' },
			top_k: { type: 'number', description: 'Number of results (default 5).' },
		},
		required: ['query'],
	},
};
const FEEDBACK_TOOL = {
	name: 'vinv_feedback',
	description:
		'After you have acted on vinv_query results (opened the files, made the ' +
		'edit), call this once to record whether they helped, passing the ' +
		'vinv_decision_id from that response. Use reward in [-1,1], where 1 is ' +
		'fully useful and -1 is harmful. This trains retrieval for this workspace.',
	inputSchema: {
		type: 'object',
		properties: {
			decision_id: { type: 'string' },
			reward: { type: 'number', minimum: -1, maximum: 1 },
			outcome: { type: 'string', description: 'Optional short outcome label.' },
		},
		required: ['decision_id', 'reward'],
	},
};
const SESSION_TOOL = {
	name: 'vinv_session',
	description:
		'Read what Vinv has observed about this workspace at runtime, and drive its ' +
		'automated fix/optimize runs ("episodes"), from chat. READ: ' +
		'action="trajectory" (every episode so far — what was tried, whether it ' +
		'verified, the reward, the standing goal, any disputes), ' +
		'action="status" (one-paragraph session summary), ' +
		'action="issues" (functions observed raising errors in captured runtime traces), ' +
		'action="hotspots" (the few functions where most traced runtime concentrates), ' +
		'action="memory_trends" (symbols retaining more memory every capture session — ' +
		'leak suspects), ' +
		'action="cache_candidates" (functions recomputing identical inputs — ' +
		'memoization sites with measured reclaimable time), ' +
		'action="opportunities" (the live optimization opportunity board with ' +
		'per-entry lifecycle status: posted entries are dispatchable, ' +
		'dispatched/resolved never re-dispatch until they expire), ' +
		'action="playbook" with kind (distilled how-to-fix guidance for one kind of ' +
		'performance waste — fix patterns, traps, verification discipline — plus the ' +
		'file paths holding this workspace’s current evidence of that kind: board ' +
		'entries, prior optimization attempts, learned prediction calibration). ACT: ' +
		'action="fix" with issue (and optional service) queues an automated fix run ' +
		'that a coding agent executes and Vinv verifies; action="run_sweep" with sweep ' +
		'queues a run pre-seeded with the named evidence (error clusters, hotspots, ' +
		'leak trends, or cache sites); action="set_goal"/"set_budget" steer future ' +
		'runs. Queued runs are picked up by the Vinv extension in the editor.',
	inputSchema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: [
					'trajectory',
					'status',
					'issues',
					'hotspots',
					'memory_trends',
					'cache_candidates',
					'opportunities',
					'playbook',
					'fix',
					'run_sweep',
					'set_goal',
					'set_budget',
				],
				description: 'Operation to perform.',
			},
			kind: {
				type: 'string',
				enum: [...PLAYBOOK_KINDS],
				description:
					'For action="playbook": which waste kind to get guidance and live ' +
					'evidence paths for.',
			},
			goal: {
				type: 'string',
				description: 'Standing goal for set_goal; an empty string clears it.',
			},
			budget: {
				type: 'number',
				minimum: 1,
				maximum: 20,
				description: 'Episode budget for set_budget.',
			},
			issue: {
				type: 'string',
				description: 'For action="fix": what to investigate and fix.',
			},
			service: {
				type: 'string',
				description:
					'For action="fix": optional service name — the fix is then verified by replaying that service.',
			},
			sweep: {
				type: 'string',
				enum: ['runtime_errors', 'hotspots', 'memory_trends', 'cache_candidates'],
				description:
					'For action="run_sweep": which evidence seeds the queued run — ' +
					'runtime_errors (fix functions observed raising errors), hotspots ' +
					'(optimize where traced time concentrates), memory_trends ' +
					'(investigate leak suspects), cache_candidates (memoize measured ' +
					'duplicate recomputation).',
			},
		},
		required: ['action'],
	},
};

/**
 * Loads graph nodes and the runtime overlay for the read-side session actions.
 * Returns null (instead of throwing) when there is no index yet — every
 * caller degrades to a "no data yet, here is the next step" message.
 */
function loadGraphWithOverlay(
	root: string = workspaceRoot,
): { nodes: GraphNode[]; overlay: Record<number, RuntimeOverlay> } | null {
	try {
		const nodes = loadNodes(indexStoreDir(root));
		return { nodes, overlay: loadRuntimeOverlay(root, nodes) };
	} catch {
		return null;
	}
}

/**
 * Runs a read-side analysis over EVERY discovered store under the launch root,
 * labeling each store's section with its provenance. The launch root's own
 * store used to be the silent, sole subject — which made "no issues" from a
 * near-empty parent store indistinguishable from "healthy" while a child
 * repo's store held live failures. Stores are reported separately, never
 * aggregated: their epoch counters are independent.
 */
function federatedReadAction(
	emptyMessage: string,
	perStore: (graph: { nodes: GraphNode[]; overlay: Record<number, RuntimeOverlay> }, root: string) => string | null,
): string {
	const stores = discoverStores(workspaceRoot);
	if (stores.length === 0) {
		return 'No Vinv store found under this root — run "Vinv: Discover Project" in the editor first.';
	}
	const now = Date.now();
	const sections: string[] = [];
	const provenance: string[] = [];
	for (const s of stores) {
		provenance.push(`- ${describeProvenance(s, now)}`);
		if (!s.hasIndex) {
			continue;
		}
		const graph = loadGraphWithOverlay(s.root);
		if (!graph) {
			continue;
		}
		const section = perStore(graph, s.root);
		if (section) {
			sections.push(stores.length > 1 ? `[${s.root}]\n${section}` : section);
		}
	}
	const provenanceBlock = `Evidence read from:\n${provenance.join('\n')}`;
	if (sections.length === 0) {
		return `${emptyMessage}\n\n${provenanceBlock}`;
	}
	return `${sections.join('\n\n')}\n\n${provenanceBlock}`;
}

function fmtBytes(b: number): string {
	return b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)}MB` : `${Math.round(b / 1024)}KB`;
}

/** Text payloads for the read-side vinv_session actions; null = unknown action. */
function sessionReadAction(action: string): string | null {
	switch (action) {
		case 'trajectory':
		case 'campaign': // pre-rename alias, kept so older agent configs still work
			return composeTrajectoryReport(loadSession(workspaceRoot), readEpisodeEvents());
		case 'status': {
			const session = loadSession(workspaceRoot);
			const verified = session.history.filter((h) => h.verified).length;
			const lastEpisode = session.history[session.history.length - 1];
			const now = Date.now();
			const provenance = discoverStores(workspaceRoot)
				.map((s) => `- ${describeProvenance(s, now)}`)
				.join('\n');
			return [
				`Goal: ${session.goal || '(none set — use set_goal)'}`,
				`Episodes: ${session.episodes_used} used of ${session.episode_budget} budget; ` +
					`${verified} of ${session.history.length} verified.`,
				lastEpisode
					? `Last episode: "${lastEpisode.title}" — ${lastEpisode.verified ? 'VERIFIED' : lastEpisode.aborted ? 'ABORTED' : 'failed'}, reward ${lastEpisode.reward.toFixed(2)}.`
					: 'No episodes run yet.',
				provenance ? `Evidence read from:\n${provenance}` : 'No Vinv store found under this root.',
			].join('\n');
		}
		case 'issues': {
			return federatedReadAction(
				'No functions raising errors in the captured traces. Run a service and exercise it to capture more.',
				(graph) => {
					const { clusters } = collectRuntimeErrorClusters(graph.nodes, graph.overlay);
					if (clusters.length === 0) {
						return null;
					}
					return (
						`${clusters.length} function(s) raising errors in live traces:\n` +
						clusters.map((c) => `- ${c.line}`).join('\n') +
						'\n\nUse action="run_sweep" sweep="runtime_errors" to dispatch a fix episode.'
					);
				},
			);
		}
		case 'hotspots': {
			return federatedReadAction(
				'No latency hotspots — capture a trace first (run a service and exercise it).',
				(graph) => {
					const hotspots = selectHotspots(graph.nodes, graph.overlay);
					if (hotspots.length === 0) {
						return null;
					}
					return (
						'Pareto head of traced runtime:\n' +
						hotspots
							.map(
								(h) =>
									`- ${h.name} at ${h.file}:${h.line} — ${Math.round(h.total_ms)}ms across ${h.calls} call(s) (${(h.share * 100).toFixed(1)}%)`,
							)
							.join('\n') +
						'\n\nUse action="run_sweep" sweep="hotspots" to dispatch an optimization episode.'
					);
				},
			);
		}
		case 'memory_trends': {
			return federatedReadAction(
				'No memory-leak trends — needs 3+ capture sessions where a symbol keeps retaining memory.',
				(graph, root) => {
					const suspects = collectMemoryTrends(root, graph.nodes);
					if (suspects.length === 0) {
						return null;
					}
					return (
						`${suspects.length} leak suspect(s) across capture sessions:\n` +
						suspects
							.map(
								(s) =>
									`- ${s.name} at ${s.file}:${s.line} — retained ${fmtBytes(s.total_retained_bytes)} over ${s.sessions} sessions, growing ${fmtBytes(s.slope_bytes_per_session)}/session`,
							)
							.join('\n') +
						'\n\nUse action="run_sweep" sweep="memory_trends" to dispatch an investigation episode.'
					);
				},
			);
		}
		case 'opportunities': {
			// The board lives at the launch root — the same file the editor's
			// sweeps and the capture watcher maintain. Syncing here (reconcile
			// outcomes, advance expiry, post fresh candidates) keeps the board
			// live even when no sweep has run recently; when there is no index
			// store the sync degrades to reading whatever the board already holds.
			try {
				return renderOpportunityBoard(
					syncOpportunityBoard(workspaceRoot, 'mcp', readEpisodeEvents()).entries,
				);
			} catch {
				return renderOpportunityBoard(loadOpportunityBoard(workspaceRoot));
			}
		}
		case 'cache_candidates': {
			return federatedReadAction(
				'No cache opportunities — no deterministic symbol was re-called with identical arguments in the captured traces.',
				(graph, root) => {
					const candidates = collectCacheCandidates(root, graph.nodes);
					if (candidates.length === 0) {
						return null;
					}
					return (
						`${candidates.length} memoization candidate(s):\n` +
						candidates
							.map(
								(c) =>
									`- ${c.name} at ${c.file}:${c.line} — ${c.calls} calls, ${c.distinct_args} distinct arg hash(es), ~${Math.round(c.reclaimable_ms)}ms reclaimable`,
							)
							.join('\n') +
						'\n\nUse action="run_sweep" sweep="cache_candidates" to dispatch a memoization episode.'
					);
				},
			);
		}
		default:
			return null;
	}
}

const SWEEP_REQUEST_KINDS: Record<string, EpisodeRequestKind> = {
	runtime_errors: 'runtime-errors',
	hotspots: 'hotspots',
	memory_trends: 'memory-trends',
	cache_candidates: 'cache-candidates',
};
// Durable learning state: rollback and pending decisions survive restarts.
const state: TelemetryState = loadTelemetryState();

// ---- automatic off-policy evaluation ---------------------------------------
// The evaluator (opeEvaluator.ts) is what makes retrieval-policy promotion
// actually happen: it runs once at server start (covering everything logged
// while no server was watching) and again after every EVAL_EVERY rewarded
// feedback events. Rollback-disabled policies suppress it entirely.
let rewardedFeedbackSinceEval = 0;

function noteRewardedFeedback(): void {
	rewardedFeedbackSinceEval += 1;
	if (rewardedFeedbackSinceEval >= EVAL_EVERY) {
		rewardedFeedbackSinceEval = 0;
		maybeRunOpeEvaluation(state.policy_disabled);
	}
}

maybeRunOpeEvaluation(state.policy_disabled);

function persistState(): void {
	try {
		saveTelemetryState(state);
	} catch {
		// A read-only home degrades to in-memory state; never break queries.
	}
}

function findPending(decisionId: string): PendingDecision | undefined {
	return state.pending.find((entry) => entry.decision_id === decisionId);
}

function removePending(decisionId: string): void {
	const index = state.pending.findIndex((entry) => entry.decision_id === decisionId);
	if (index >= 0) {
		state.pending.splice(index, 1);
	}
}

/** Minutes before a decision without explicit feedback receives an auxiliary
 * edit-overlap reward (VINV_AUX_FEEDBACK_MINUTES). */
function auxiliaryFeedbackMinutes(): number {
	const raw = Number.parseFloat(process.env.VINV_AUX_FEEDBACK_MINUTES ?? '5');
	return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/**
 * Reward bridge: decisions that never received explicit feedback are graded by
 * whether the files they surfaced were subsequently edited (task-grounded
 * usefulness). Reward is the fraction of returned files with an mtime after
 * the decision, logged with source="auxiliary" so offline evaluation never
 * silently mixes it with explicit rewards. Missing explicit feedback is MNAR;
 * the logged-decision denominator lives in the telemetry stream itself.
 */
function settleAuxiliaryFeedback(now: number): void {
	const cutoff = now - auxiliaryFeedbackMinutes() * 60_000;
	const due = state.pending.filter((entry) => Date.parse(entry.ts) <= cutoff);
	if (due.length === 0) {
		return;
	}
	for (const entry of due) {
		removePending(entry.decision_id);
		const decidedAt = Date.parse(entry.ts);
		let edited = 0;
		let checked = 0;
		for (const file of entry.files) {
			try {
				const stat = fs.statSync(path.resolve(workspaceRoot, file));
				checked += 1;
				if (stat.mtimeMs > decidedAt) {
					edited += 1;
				}
			} catch {
				// Deleted or unreadable files are excluded from the denominator.
			}
		}
		appendRetrievalEvent({
			type: 'feedback',
			ts: new Date(now).toISOString(),
			decision_id: entry.decision_id,
			epoch: entry.epoch,
			source: 'auxiliary',
			reward: checked > 0 ? edited / checked : 0,
			files_checked: checked,
			files_edited: edited,
		});
		noteRewardedFeedback();
	}
	persistState();
}

function attachDecision(output: string, decisionId: string): {
	text: string;
	resultCount: number;
	resultHashes: string[];
	resultFiles: string[];
} {
	try {
		const payload = JSON.parse(output) as Record<string, unknown>;
		payload.vinv_decision_id = decisionId;
		const results = Array.isArray(payload.results) ? payload.results : [];
		const resultHashes = results.slice(0, 20).map((result) =>
			crypto
				.createHash('sha256')
				.update(JSON.stringify(result))
				.digest('hex')
				.slice(0, 24),
		);
		const resultFiles = [
			...new Set(
				results
					.slice(0, 20)
					.map((result) => (result as { file?: unknown }).file)
					.filter((file): file is string => typeof file === 'string' && file.length > 0),
			),
		];
		return { text: JSON.stringify(payload), resultCount: results.length, resultHashes, resultFiles };
	} catch {
		return { text: output, resultCount: 0, resultHashes: [], resultFiles: [] };
	}
}

/**
 * Executes the counterfactual (shadow) action after the user-facing reply.
 * Results are discarded; only content-safe metrics are logged, so shadow-mode
 * telemetry carries real outcome measurements into offline evaluation at zero
 * user risk.
 */
function runShadowQuery(query: string, shadowTopK: number, decisionId: string, epoch: string): void {
	void runQuery(query, shadowTopK).then(({ output, latencyMs }) => {
		const decorated = attachDecision(output, decisionId);
		appendRetrievalEvent({
			type: 'shadow',
			ts: new Date().toISOString(),
			decision_id: decisionId,
			epoch,
			action: { top_k: shadowTopK },
			latency_ms: latencyMs,
			result_count: decorated.resultCount,
			result_hashes: decorated.resultHashes,
		});
	});
}

function queryFailed(output: string): boolean {
	try {
		const payload = JSON.parse(output) as { status?: string };
		return payload.status === 'error';
	} catch {
		return true;
	}
}

async function handle(req: JsonRpcRequest): Promise<void> {
	switch (req.method) {
		case 'initialize':
			reply(req.id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: 'vinv-index', version: '0.0.1' },
				instructions: INSTRUCTIONS,
			});
			return;

		case 'notifications/initialized':
			return; // notification, no response

		case 'tools/list':
			reply(req.id, { tools: [TOOL, FEEDBACK_TOOL, SESSION_TOOL] });
			return;

		case 'tools/call': {
			const params = req.params ?? {};
			const name = params.name as string;
			if (name === 'vinv_session') {
				const args = (params.arguments ?? {}) as {
					action?: string;
					kind?: string;
					goal?: string;
					budget?: number;
					issue?: string;
					service?: string;
					sweep?: string;
					campaign?: string; // pre-rename alias for sweep
				};
				if (args.action === 'playbook') {
					// The knowledge slice: shipped guidance for one waste kind + the
					// live artifact paths behind it. Failures are LOUD tool errors
					// (unknown kind lists the valid ones; a missing playbook file
					// names the packaging gap) — never an empty slice.
					try {
						reply(req.id, {
							content: [
								{
									type: 'text',
									text: composePlaybookSlice(workspaceRoot, extensionDir, args.kind ?? ''),
								},
							],
						});
					} catch (e) {
						replyError(req.id, -32602, e instanceof Error ? e.message : String(e));
					}
					return;
				}
				const readText = args.action ? sessionReadAction(args.action) : null;
				if (readText !== null) {
					reply(req.id, { content: [{ type: 'text', text: readText }] });
					return;
				}
				if (args.action === 'fix' && typeof args.issue === 'string' && args.issue.trim()) {
					const file = enqueueEpisodeRequest(workspaceRoot, {
						source: 'chat',
						kind: 'fix',
						issue: args.issue.trim(),
						service: args.service?.trim() || undefined,
					});
					reply(req.id, {
						content: [{
							type: 'text',
							text:
								`Fix episode queued (${path.basename(file)}). The Vinv extension in the ` +
								'editor dispatches it to the coding harness, verifies the fix ' +
								(args.service ? `by replaying service '${args.service}', ` : 'against the stated criteria, ') +
								'and records the outcome — check progress with action="trajectory".',
						}],
					});
					return;
				}
				// 'run_campaign' + 'campaign' are the pre-rename aliases of
				// 'run_sweep' + 'sweep', kept so older agent configs still work.
				const sweep = args.sweep ?? args.campaign;
				if (
					(args.action === 'run_sweep' || args.action === 'run_campaign') &&
					sweep &&
					SWEEP_REQUEST_KINDS[sweep]
				) {
					const file = enqueueEpisodeRequest(workspaceRoot, {
						source: 'chat',
						kind: SWEEP_REQUEST_KINDS[sweep],
					});
					reply(req.id, {
						content: [{
							type: 'text',
							text:
								`Sweep '${sweep}' queued (${path.basename(file)}). The Vinv ` +
								'extension gathers the current evidence, seeds a context pack with the ' +
								'affected symbols, and dispatches the episode — check progress with ' +
								'action="trajectory".',
						}],
					});
					return;
				}
				if (args.action === 'set_goal' && typeof args.goal === 'string') {
					// Agent-reachable channel: never reset episodes_used, else an
					// autonomous/injected agent changing the goal each turn escapes
					// the episode budget (review Finding C — the same guard as the
					// harness-stdout goal directive).
					const session = setGoal(workspaceRoot, args.goal, false);
					reply(req.id, {
						content: [{
							type: 'text',
							text:
								`Vinv standing goal ${session.goal ? `set to: ${session.goal}` : 'cleared'}. ` +
								`Episode ${session.episodes_used} of ${session.episode_budget}.`,
						}],
					});
					return;
				}
				if (
					args.action === 'set_budget' &&
					Number.isInteger(args.budget) &&
					(args.budget as number) >= 1 &&
					(args.budget as number) <= 20
				) {
					const session = setEpisodeBudget(workspaceRoot, args.budget as number);
					reply(req.id, {
						content: [{
							type: 'text',
							text:
								`Vinv episode budget set to ${session.episode_budget}; ` +
								`${session.episodes_used} episode(s) used on the current goal.`,
						}],
					});
					return;
				}
				replyError(
					req.id,
					-32602,
					'Invalid vinv_session arguments. Read actions (trajectory, status, issues, ' +
						'hotspots, memory_trends, cache_candidates, opportunities) take no value; ' +
						`playbook needs kind in ${PLAYBOOK_KINDS.join('|')}; fix needs issue ` +
						'(service optional); run_sweep needs sweep in ' +
						'runtime_errors|hotspots|memory_trends|cache_candidates; set_goal needs ' +
						'goal; set_budget needs an integer budget from 1 to 20.',
				);
				return;
			}
			if (name === 'vinv_feedback') {
				const args = (params.arguments ?? {}) as {
					decision_id?: string;
					reward?: number;
					outcome?: string;
				};
				const pendingDecision = args.decision_id ? findPending(args.decision_id) : undefined;
				if (
					!args.decision_id ||
					typeof args.reward !== 'number' ||
					!Number.isFinite(args.reward) ||
					args.reward < -1 ||
					args.reward > 1 ||
					!pendingDecision
				) {
					replyError(req.id, -32602, 'Unknown decision_id or invalid reward.');
					return;
				}
				removePending(args.decision_id);
				if (pendingDecision.canary) {
					state.consecutive_canary_losses =
						args.reward < 0 ? state.consecutive_canary_losses + 1 : 0;
					if (state.consecutive_canary_losses >= 3) {
						state.policy_disabled = true;
						appendRetrievalEvent({
							type: 'rollback',
							ts: new Date().toISOString(),
							epoch: pendingDecision.epoch,
							reason: 'three_consecutive_negative_canary_rewards',
						});
					}
				}
				persistState();
				appendRetrievalEvent({
					type: 'feedback',
					ts: new Date().toISOString(),
					decision_id: args.decision_id,
					epoch: pendingDecision.epoch,
					source: 'explicit',
					reward: args.reward,
					outcome: args.outcome?.slice(0, 80) ?? null,
				});
				noteRewardedFeedback();
				reply(req.id, { accepted: true });
				return;
			}
			if (name !== 'vinv_query') {
				replyError(req.id, -32602, `Unknown tool: ${name}`);
				return;
			}
			const args = (params.arguments ?? {}) as { query?: string; top_k?: number };
			if (!args.query) {
				replyError(req.id, -32602, 'Missing required argument: query');
				return;
			}
			const requestedTopK = args.top_k ?? 5;
			const epoch = retrievalEpoch(storeDir);
			settleAuxiliaryFeedback(Date.now());
			const configuredPolicy = state.policy_disabled ? null : loadPolicyForEpoch(epoch);
			const selected = selectRetrievalAction(
				requestedTopK,
				configuredPolicy,
				process.env.VINV_RETRIEVAL_POLICY_MODE ?? 'shadow',
			);
			const decisionId = crypto.randomUUID();
			let run = await runQuery(args.query, selected.topK);
			let fallback = false;
			if (selected.policy === 'canary' && queryFailed(run.output)) {
				// The canary draw failed; serve the baseline instead, but log the
				// decision as its TRUE draw (canary action/propensity) flagged as a
				// fallback so offline evaluation can exclude it rather than absorb a
				// mislabeled propensity-1 baseline sample.
				state.policy_disabled = true;
				persistState();
				appendRetrievalEvent({
					type: 'rollback',
					ts: new Date().toISOString(),
					epoch,
					reason: 'canary_query_error',
				});
				run = await runQuery(args.query, requestedTopK);
				fallback = true;
			}
			const decorated = attachDecision(run.output, decisionId);
			if (state.pending.length >= 10_000) {
				state.pending.shift();
			}
			const decisionTs = new Date().toISOString();
			state.pending.push({
				decision_id: decisionId,
				epoch,
				ts: decisionTs,
				canary: !fallback && selected.policy === 'canary',
				files: decorated.resultFiles,
			});
			persistState();
			appendRetrievalEvent({
				type: 'decision',
				ts: decisionTs,
				decision_id: decisionId,
				epoch,
				features: queryFeatures(args.query),
				action: { top_k: selected.topK, policy: selected.policy },
				served_top_k: fallback ? requestedTopK : selected.topK,
				propensity: selected.propensity,
				fallback,
				shadow_action: selected.shadowTopK
					? { top_k: selected.shadowTopK }
					: null,
				latency_ms: run.latencyMs,
				result_count: decorated.resultCount,
				result_hashes: decorated.resultHashes,
			});
			if (selected.shadowTopK !== null && !fallback) {
				runShadowQuery(args.query, selected.shadowTopK, decisionId, epoch);
			}
			reply(req.id, { content: [{ type: 'text', text: decorated.text }] });
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
			void handle(req);
		} catch {
			// Ignore malformed lines.
		}
	}
});
