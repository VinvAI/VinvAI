/**
 * Endpoint I/O probes — closes "no input/output testing of endpoints".
 *
 * After a service is green and the insight pass has identified the observed
 * endpoints, probe specs are synthesized DETERMINISTICALLY from the traces:
 * the captured request shape (method + concrete path, with path parameters
 * filled from the handler's observed argument summaries) plus the expected
 * outcome (status class derived from whether the endpoint was observed clean,
 * the handler symbol, and no server error). Specs live in
 * .vinv/probes/<service>.json; the runner replays them against the live
 * traced service over plain HTTP and marks each endpoint pass/fail.
 *
 * Where captured values are redacted/truncated/insufficient (typically
 * POST-style bodies, which frameworks parse before the tracer sees them), the
 * probe is marked "needs-authoring" and authoring is dispatched to the
 * harness via the existing runGoalAgent('author-tests', …) path — returned
 * probes are stored in the same file and run like any other.
 *
 * Probe results feed the IssueList (via the insight runner's recompute), so a
 * failing probe becomes a dispatchable issue like any other evidence.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { getBinPath } from '../tracelens/bin';
import { getHandbookEnv, getHarnessId, isAutoEpisodesEnabled } from '../config/settings';
import { dispatchAgentPrompt, isHarnessBusy } from './harnessRunner';
import { isEpisodeRunning } from './episodeLoop';
import { runGoalAgent, type AgentSpawn } from './binaryAgents';
import { readServices, readStartCommands, serviceSlug } from '../bringup/bringup';
import { isServiceRunning, runningServiceNames } from '../bringup/serviceRunner';
import { loadCorpus, resolveSymbol, type SummaryDict, type TraceCorpus } from '../runtime/traceStore';
import { readInsightManifest, recomputeIssues } from './insightRunner';
import { applyBaselines, responseShapeHash, type ObservedResponse } from './probeBaseline';
import {
	publishProbeState,
	getProbeState,
	type EndpointInsight,
	type ProbeOutcome,
	type ProbeRunSummary,
} from './pipelineState';

// ---- probe spec model -------------------------------------------------------

/** What a probe asserts about the response. */
export interface ProbeExpectation {
	/** '2xx-3xx' when the endpoint was observed clean; 'no-5xx' otherwise. */
	statusClass: '2xx-3xx' | 'no-5xx';
	/** The handler symbol the traced request resolved to (provenance). */
	handler: string | null;
	/** Always true: the probe must not surface a server error. */
	noServerError: true;
}

/** One synthesized (or authored) I/O probe. */
export interface ProbeSpec {
	id: string;
	endpointId: string;
	method: string;
	/** Concrete request path (parameters already substituted). */
	path: string;
	/** Request body for POST-style probes (authored). */
	body?: string;
	contentType?: string;
	expected: ProbeExpectation;
	/** 'ready' runs; 'needs-authoring' waits for the authoring agent. */
	status: 'ready' | 'needs-authoring';
	/** Where the spec came from. */
	source: 'trace' | 'authored';
	/** Why authoring is needed (evidence handed to the authoring agent). */
	authoringReason?: string;
}

/** The persisted probe file for one service. */
export interface ProbeFile {
	version: 1;
	service: string;
	generatedAt: string;
	probes: ProbeSpec[];
	lastRun?: ProbeRunSummary;
}

/** .vinv/probes/<service-slug>.json */
export function probeFilePath(workspaceRoot: string, service: string): string {
	return path.join(workspaceRoot, '.vinv', 'probes', `${serviceSlug(service)}.json`);
}

/** Reads a service's probe file, or null when absent/unreadable. */
export function readProbeFile(workspaceRoot: string, service: string): ProbeFile | null {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(probeFilePath(workspaceRoot, service), 'utf8'),
		) as ProbeFile;
		return parsed && parsed.version === 1 && Array.isArray(parsed.probes) ? parsed : null;
	} catch {
		return null;
	}
}

function writeProbeFile(workspaceRoot: string, file: ProbeFile): void {
	const target = probeFilePath(workspaceRoot, file.service);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(file, null, '\t')}\n`, 'utf8');
	fs.renameSync(tmp, target);
}

function probeId(endpointId: string, method: string, p: string): string {
	return crypto
		.createHash('sha256')
		.update(`${endpointId}\u0000${method}\u0000${p}`)
		.digest('hex')
		.slice(0, 16);
}

// ---- deterministic synthesis from traces ------------------------------------

/** A usable example value extracted from an observed argument summary. */
export interface ArgExample {
	value: string;
	/** False when the capture was truncated/redacted — not trustworthy input. */
	complete: boolean;
}

/**
 * Extracts a concrete example from one captured argument summary. Scalars are
 * exact; strings are exact only when the recorded head covers the whole value
 * (len ≤ 32 — tracelens keeps the first 32 chars); everything else (objects,
 * truncated/redacted values) is incomplete evidence.
 */
export function exampleFromSummary(s: SummaryDict | undefined): ArgExample | null {
	if (!s || typeof s !== 'object') {
		return null;
	}
	if (s.truncated || s.summary_error) {
		return { value: '', complete: false };
	}
	if (typeof s.v === 'boolean') {
		return { value: s.v ? 'true' : 'false', complete: true };
	}
	if (typeof s.v === 'number') {
		return { value: String(s.v), complete: true };
	}
	if (s.head !== undefined) {
		const full = s.len === undefined || s.len <= s.head.length;
		return { value: s.head, complete: full };
	}
	return { value: '', complete: false };
}

/** Path-parameter tokens: `{id}`, `{int:id}`, `<id>`, `<int:id>`, `:id`. */
const PARAM_TOKEN = /\{([^}]+)\}|<([^>]+)>|:([A-Za-z_][A-Za-z0-9_]*)/g;

/** Parameter names referenced by a route path (converter prefixes stripped). */
export function pathParamNames(routePath: string): string[] {
	const names: string[] = [];
	for (const m of routePath.matchAll(PARAM_TOKEN)) {
		const raw = m[1] ?? m[2] ?? m[3] ?? '';
		const name = raw.includes(':') ? raw.split(':').pop() ?? raw : raw;
		if (name) {
			names.push(name);
		}
	}
	return names;
}

/** Substitutes observed example values into a route path's parameter tokens. */
export function concretizePath(
	routePath: string,
	examples: Record<string, ArgExample>,
): { path: string; complete: boolean } {
	let complete = true;
	const out = routePath.replace(PARAM_TOKEN, (whole, a, b, c) => {
		const raw: string = a ?? b ?? c ?? '';
		const name = raw.includes(':') ? (raw.split(':').pop() ?? raw) : raw;
		const example = examples[name];
		if (!example || !example.complete || example.value === '') {
			complete = false;
			return whole;
		}
		return encodeURIComponent(example.value);
	});
	return { path: out, complete };
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

/**
 * Synthesizes probe specs for the observed endpoints — PURE (unit tested):
 * the caller supplies per-handler argument examples extracted from the trace.
 *
 *  - Bodyless methods with all path parameters concretizable from observed
 *    values → 'ready'.
 *  - Missing/incomplete parameter values, or body-carrying methods (the
 *    tracer sees parsed handler arguments, never the raw payload) →
 *    'needs-authoring' with the reason recorded as authoring evidence.
 */
export function synthesizeProbeSpecs(
	endpoints: ReadonlyArray<Pick<EndpointInsight, 'id' | 'trigger' | 'handler' | 'errorCount'>>,
	argExamplesByHandler: ReadonlyMap<string, Record<string, ArgExample>>,
): ProbeSpec[] {
	const specs: ProbeSpec[] = [];
	for (const ep of endpoints) {
		const space = ep.trigger.indexOf(' ');
		if (space <= 0) {
			continue; // not an HTTP trigger
		}
		const method = ep.trigger.slice(0, space).toUpperCase();
		const routePath = ep.trigger.slice(space + 1).trim();
		if (!routePath.startsWith('/')) {
			continue;
		}
		const expected: ProbeExpectation = {
			statusClass: ep.errorCount > 0 ? 'no-5xx' : '2xx-3xx',
			handler: ep.handler,
			noServerError: true,
		};
		const examples = (ep.handler && argExamplesByHandler.get(ep.handler)) || {};
		const { path: concrete, complete } = concretizePath(routePath, examples);
		if (!BODYLESS_METHODS.has(method)) {
			specs.push({
				id: probeId(ep.id, method, routePath),
				endpointId: ep.id,
				method,
				path: complete ? concrete : routePath,
				expected,
				status: 'needs-authoring',
				source: 'trace',
				authoringReason:
					`${method} requires a request body; the trace records the handler's parsed ` +
					'arguments, not the raw payload — author a representative body' +
					(complete ? '' : ' and concrete path parameter values'),
			});
			continue;
		}
		if (!complete) {
			specs.push({
				id: probeId(ep.id, method, routePath),
				endpointId: ep.id,
				method,
				path: routePath,
				expected,
				status: 'needs-authoring',
				source: 'trace',
				authoringReason:
					`path parameters ${JSON.stringify(pathParamNames(routePath))} could not be ` +
					'filled from observed values (missing, truncated, or redacted in the capture)',
			});
			continue;
		}
		specs.push({
			id: probeId(ep.id, method, routePath),
			endpointId: ep.id,
			method,
			path: concrete,
			expected,
			status: 'ready',
			source: 'trace',
		});
	}
	return specs;
}

/** Builds the handler → argument-example map from the trace corpus. */
function argExamplesFromCorpus(
	corpus: TraceCorpus,
	handlers: Iterable<string>,
): Map<string, Record<string, ArgExample>> {
	const out = new Map<string, Record<string, ArgExample>>();
	for (const handler of handlers) {
		const resolved = resolveSymbol(corpus, handler);
		if (!resolved.match) {
			continue;
		}
		const record = corpus.bySymbol.get(resolved.match);
		if (!record || record.enters.length === 0) {
			continue;
		}
		// Prefer the newest enter from a request that did NOT fail — a probe
		// should replay the healthy contract, not the crash input.
		const okEnter =
			[...record.enters]
				.reverse()
				.find((e) => corpus.byRequest.get(e.request_id)?.failed === false) ??
			record.enters[record.enters.length - 1];
		const examples: Record<string, ArgExample> = {};
		for (const [param, summary] of Object.entries(okEnter.args_summary)) {
			const ex = exampleFromSummary(summary);
			if (ex) {
				examples[param] = ex;
			}
		}
		out.set(handler, examples);
	}
	return out;
}

// ---- probe execution --------------------------------------------------------

/** Per-probe HTTP deadline in ms (VINV_PROBE_TIMEOUT_S, default 10s). */
function probeTimeoutMs(): number {
	const raw = Number.parseFloat(process.env.VINV_PROBE_TIMEOUT_S ?? '');
	return (Number.isFinite(raw) && raw > 0 ? raw : 10) * 1000;
}

/** Response-body capture cap for shape hashing — structure, not a transcript. */
const PROBE_BODY_CAP = 64 * 1024;

/** One plain-HTTP request against the local service, hard-deadlined. Exported
 * for the stub-HTTP unit tests (the pass itself stays module-internal). */
export function httpProbe(
	port: number,
	spec: ProbeSpec,
): Promise<{
	status: number | null;
	error?: string;
	latencyMs: number;
	/** Structural hash of the (bounded) response body — the baseline join key. */
	shapeHash: string;
}> {
	return new Promise((resolve) => {
		const started = Date.now();
		let settled = false;
		let body = '';
		let contentType: string | undefined;
		const settle = (status: number | null, error?: string): void => {
			if (!settled) {
				settled = true;
				resolve({
					status,
					error,
					latencyMs: Date.now() - started,
					shapeHash: responseShapeHash(body, contentType),
				});
			}
		};
		const req = http.request(
			{
				host: '127.0.0.1',
				port,
				method: spec.method,
				path: spec.path,
				timeout: probeTimeoutMs(),
				headers: spec.body
					? {
							'content-type': spec.contentType ?? 'application/json',
							'content-length': Buffer.byteLength(spec.body),
						}
					: {},
			},
			(res) => {
				contentType = res.headers['content-type'];
				res.setEncoding('utf8');
				// Bounded capture: enough body for a structural hash, never a
				// transcript; the stream keeps draining so keep-alive releases.
				res.on('data', (chunk: string) => {
					if (body.length < PROBE_BODY_CAP) {
						body += chunk.slice(0, PROBE_BODY_CAP - body.length);
					}
				});
				res.on('end', () => settle(res.statusCode ?? null));
				res.on('error', () => settle(res.statusCode ?? null));
			},
		);
		req.on('timeout', () => {
			req.destroy();
			settle(null, `no response within ${Math.round(probeTimeoutMs() / 1000)}s`);
		});
		req.on('error', (e) => settle(null, e.message));
		if (spec.body) {
			req.write(spec.body);
		}
		req.end();
	});
}

/** Applies a probe's expectation to an observed HTTP status. Pure. */
export function judgeProbe(
	spec: Pick<ProbeSpec, 'expected'>,
	status: number | null,
	error?: string,
): { verdict: 'pass' | 'fail'; detail?: string } {
	if (status === null) {
		return { verdict: 'fail', detail: error ?? 'no response' };
	}
	if (status >= 500) {
		return { verdict: 'fail', detail: `server error HTTP ${status}` };
	}
	if (spec.expected.statusClass === '2xx-3xx' && status >= 400) {
		return {
			verdict: 'fail',
			detail: `expected a 2xx/3xx (endpoint was observed serving cleanly), got HTTP ${status}`,
		};
	}
	return { verdict: 'pass' };
}

/** The service's expected port: services.json first, then the start record. */
function servicePort(workspaceRoot: string, service: string): number | null {
	const entry = readServices(workspaceRoot).find((s) => s.name === service);
	if (typeof entry?.port === 'number' && entry.port > 0) {
		return entry.port;
	}
	try {
		const raw = fs.readFileSync(
			path.join(workspaceRoot, '.vinv', 'start_commands', `${serviceSlug(service)}.json`),
			'utf8',
		);
		const parsed = JSON.parse(raw) as { verification?: { port?: number } };
		const p = parsed.verification?.port;
		return typeof p === 'number' && p > 0 ? p : null;
	} catch {
		return null;
	}
}

/** The running service to probe: prefer a live session with a known port. */
function pickProbeTarget(workspaceRoot: string): { service: string; port: number } | null {
	const candidates = runningServiceNames().length
		? runningServiceNames()
		: readServices(workspaceRoot)
				.map((s) => s.name)
				.filter((name) => readStartCommands(workspaceRoot, name).length > 0);
	for (const service of candidates) {
		const port = servicePort(workspaceRoot, service);
		if (port !== null) {
			return { service, port };
		}
	}
	return null;
}

// ---- frozen replay for the optimization verdict engine ----------------------

/** A frozen probe request set bound to one live service target. */
export interface FrozenProbeTarget {
	service: string;
	port: number;
	specs: ProbeSpec[];
}

/** One probe's samples across the replay passes (exerciseOptimize's unit). */
export interface ProbeMeasurement {
	/** Latencies of replays that produced a response, in pass order. */
	latencies: number[];
	/** Observed HTTP status per pass (null = no response). */
	statuses: Array<number | null>;
	/** Structural response-shape hash per pass. */
	shapes: string[];
	/** Human label ("GET /path") for verdict evidence. */
	label?: string;
}

/**
 * Freezes the CURRENT ready probe request set against the running service —
 * the identical requests the optimization verdict engine replays before and
 * after a change (a re-synthesized set could differ between the two runs and
 * silently unpair the comparison). Deterministic synthesis from the newest
 * traces plus any persisted authored probes; needs-authoring specs are
 * excluded (nothing is dispatched here). Null when there is no running
 * service with a known port or no observed endpoints.
 */
export function freezeReadyProbeSpecs(workspaceRoot: string): FrozenProbeTarget | null {
	const manifest = readInsightManifest(workspaceRoot);
	const endpoints = manifest?.endpoints ?? [];
	if (endpoints.length === 0) {
		return null;
	}
	const target = pickProbeTarget(workspaceRoot);
	if (!target || !isServiceRunning(target.service)) {
		return null;
	}
	let corpus: TraceCorpus | null = null;
	try {
		corpus = loadCorpus(workspaceRoot);
	} catch {
		corpus = null;
	}
	const handlers = endpoints.map((e) => e.handler).filter((h): h is string => Boolean(h));
	const examples = corpus
		? argExamplesFromCorpus(corpus, handlers)
		: new Map<string, Record<string, ArgExample>>();
	const specs = synthesizeProbeSpecs(endpoints, examples);
	const persisted = readProbeFile(workspaceRoot, target.service);
	for (const old of persisted?.probes ?? []) {
		if (old.source === 'authored' && old.status === 'ready' && !specs.some((s) => s.id === old.id)) {
			specs.push(old);
		}
	}
	const ready = specs.filter((s) => s.status === 'ready');
	return ready.length > 0 ? { service: target.service, port: target.port, specs: ready } : null;
}

/**
 * Replays a frozen spec list `passes` times against the service and collects
 * per-probe samples. Purely mechanical (no synthesis, no authoring, no issue
 * recompute) — this is the measurement half of the paired comparison, so it
 * must do nothing but replay the frozen requests.
 */
export async function replayProbeSpecs(
	port: number,
	specs: ProbeSpec[],
	passes: number,
): Promise<Map<string, ProbeMeasurement>> {
	const out = new Map<string, ProbeMeasurement>();
	for (let pass = 0; pass < passes; pass += 1) {
		for (const spec of specs) {
			const res = await httpProbe(port, spec);
			const m = out.get(spec.id) ?? {
				latencies: [],
				statuses: [],
				shapes: [],
				label: `${spec.method} ${spec.path}`,
			};
			if (!res.error) {
				m.latencies.push(res.latencyMs);
			}
			m.statuses.push(res.status);
			m.shapes.push(res.shapeHash);
			out.set(spec.id, m);
		}
	}
	return out;
}

// ---- authoring hand-off -----------------------------------------------------

/** Validates authored probes from the agent reply (contract-checked). */
export function asAuthoredProbes(raw: Record<string, unknown> | null): Array<{
	method: string;
	path: string;
	body?: string;
	content_type?: string;
}> {
	if (!raw || !Array.isArray(raw.probes)) {
		return [];
	}
	const out: Array<{ method: string; path: string; body?: string; content_type?: string }> = [];
	for (const p of raw.probes as unknown[]) {
		if (typeof p !== 'object' || p === null) {
			continue;
		}
		const rec = p as Record<string, unknown>;
		if (typeof rec.method !== 'string' || typeof rec.path !== 'string') {
			continue;
		}
		if (!rec.path.startsWith('/')) {
			continue;
		}
		out.push({
			method: rec.method.toUpperCase(),
			path: rec.path,
			body: typeof rec.body === 'string' ? rec.body : undefined,
			content_type: typeof rec.content_type === 'string' ? rec.content_type : undefined,
		});
	}
	return out.slice(0, 8);
}

/** Max probes handed to the authoring agent per pass (dispatches are costly). */
const AUTHORING_CAP = 5;

/**
 * Dispatches authoring for needs-authoring specs through the existing
 * runGoalAgent('author-tests') path and merges any returned probes into the
 * spec list as 'authored'/'ready'. Best-effort: unavailable engine/harness or
 * an unusable reply leaves the specs as they were.
 */
async function authorMissingProbes(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	specs: ProbeSpec[],
): Promise<ProbeSpec[]> {
	const pending = specs.filter((s) => s.status === 'needs-authoring').slice(0, AUTHORING_CAP);
	if (pending.length === 0) {
		return specs;
	}
	// Busy-lock discipline: authoring rides the harness — never contend with a
	// running episode/setup, and only run unattended when auto-episodes are on.
	if (!isAutoEpisodesEnabled() || isEpisodeRunning() || isHarnessBusy()) {
		return specs;
	}
	const goalBin = getBinPath(context, 'goal');
	if (!fs.existsSync(goalBin)) {
		return specs;
	}
	const spawnInfo: AgentSpawn = {
		binPath: goalBin,
		env: getHandbookEnv(path.dirname(goalBin), workspaceRoot),
		cwd: workspaceRoot,
		dispatch: (name, prompt) => dispatchAgentPrompt(getHarnessId(), workspaceRoot, name, prompt),
	};
	const merged = [...specs];
	for (const spec of pending) {
		try {
			const raw = await runGoalAgent(spawnInfo, 'author-tests', {
				task: 'author-http-probes',
				endpoint: { method: spec.method, path: spec.path, handler: spec.expected.handler },
				reason: spec.authoringReason ?? '',
				instructions:
					'Author up to 3 concrete HTTP probes for this endpoint of the running service. ' +
					'Reply with JSON only: {"probes": [{"method": "...", "path": "/concrete/path", ' +
					'"body": "...", "content_type": "..."}]} — paths must be concrete (no {param} ' +
					'placeholders); omit body for GET-style probes.',
			});
			const authored = asAuthoredProbes(raw);
			for (const a of authored) {
				const id = probeId(spec.endpointId, a.method, a.path);
				if (merged.some((m) => m.id === id)) {
					continue;
				}
				merged.push({
					id,
					endpointId: spec.endpointId,
					method: a.method,
					path: a.path,
					body: a.body,
					contentType: a.content_type,
					expected: spec.expected,
					status: 'ready',
					source: 'authored',
				});
			}
		} catch {
			// Authoring is best-effort; the spec stays needs-authoring.
		}
	}
	return merged;
}

// ---- the pass ---------------------------------------------------------------

let probeRunning = false;

/** True while a probe pass is in flight. */
export function isProbeRunning(): boolean {
	return probeRunning;
}

/** How one probe pass settled — Auto-Pilot's stage outcome. */
export interface ProbePassResult {
	outcome: 'done' | 'failed' | 'skipped';
	total: number;
	failed: number;
	/** Ids of the failing probes (drives Auto-Pilot's failure signature). */
	failedIds: string[];
	error?: string;
}

/**
 * Runs one probe pass against the live traced service: synthesize (or reuse)
 * specs, author the gaps, replay every ready probe, persist + publish the
 * results, and feed failures into the issue list. Serialized and never
 * throws.
 */
export async function runProbePass(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	options: { endpointIds?: string[] } = {},
): Promise<ProbePassResult> {
	if (probeRunning) {
		return {
			outcome: 'skipped',
			total: 0,
			failed: 0,
			failedIds: [],
			error: 'a probe pass is already running',
		};
	}
	probeRunning = true;
	try {
		return await probePassOnce(context, workspaceRoot, options);
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		publishProbeState({
			phase: 'failed',
			label: 'probe pass failed',
			results: getProbeState().results,
		});
		return { outcome: 'failed', total: 0, failed: 0, failedIds: [], error };
	} finally {
		probeRunning = false;
	}
}

async function probePassOnce(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	options: { endpointIds?: string[] },
): Promise<ProbePassResult> {
	const skip = (why: string): ProbePassResult => {
		publishProbeState({ phase: 'skipped', label: why, results: getProbeState().results });
		return { outcome: 'skipped', total: 0, failed: 0, failedIds: [], error: why };
	};
	const manifest = readInsightManifest(workspaceRoot);
	let endpoints = manifest?.endpoints ?? [];
	if (options.endpointIds?.length) {
		const wanted = new Set(options.endpointIds);
		endpoints = endpoints.filter((e) => wanted.has(e.id));
	}
	if (endpoints.length === 0) {
		return skip('no observed endpoints to probe (insight pass has not produced any)');
	}
	const target = pickProbeTarget(workspaceRoot);
	if (!target) {
		return skip('no service with a recorded port to probe');
	}
	if (!isServiceRunning(target.service)) {
		return skip(`service '${target.service}' is not running — start it to probe`);
	}
	publishProbeState({
		phase: 'running',
		label: `synthesizing probes for ${target.service}…`,
		results: getProbeState().results,
	});

	// Deterministic synthesis from the traces, then merge with the persisted
	// file: authored probes survive regeneration (they carry human/agent work),
	// trace-sourced specs are refreshed from the newest evidence.
	let corpus: TraceCorpus | null = null;
	try {
		corpus = loadCorpus(workspaceRoot);
	} catch {
		corpus = null;
	}
	const handlers = endpoints.map((e) => e.handler).filter((h): h is string => Boolean(h));
	const examples = corpus
		? argExamplesFromCorpus(corpus, handlers)
		: new Map<string, Record<string, ArgExample>>();
	let specs = synthesizeProbeSpecs(endpoints, examples);
	const persisted = readProbeFile(workspaceRoot, target.service);
	for (const old of persisted?.probes ?? []) {
		if (old.source === 'authored' && !specs.some((s) => s.id === old.id)) {
			specs.push(old);
		}
	}

	specs = await authorMissingProbes(context, workspaceRoot, specs);

	const outcomes: ProbeOutcome[] = [];
	const observations: ObservedResponse[] = [];
	let ran = 0;
	for (const spec of specs) {
		if (spec.status !== 'ready') {
			outcomes.push({
				id: spec.id,
				endpointId: spec.endpointId,
				method: spec.method,
				path: spec.path,
				verdict: 'needs-authoring',
				detail: spec.authoringReason,
			});
			continue;
		}
		ran += 1;
		publishProbeState({
			phase: 'running',
			label: `probing ${spec.method} ${spec.path} (${ran})…`,
			results: getProbeState().results,
		});
		const res = await httpProbe(target.port, spec);
		const judged = judgeProbe(spec, res.status, res.error);
		outcomes.push({
			id: spec.id,
			endpointId: spec.endpointId,
			method: spec.method,
			path: spec.path,
			verdict: judged.verdict,
			httpStatus: res.status ?? undefined,
			latencyMs: res.latencyMs,
			detail: judged.detail,
			shapeHash: res.shapeHash,
		});
		observations.push({
			probeId: spec.id,
			endpointId: spec.endpointId,
			method: spec.method,
			path: spec.path,
			httpStatus: res.status,
			handler: spec.expected.handler,
			shapeHash: res.shapeHash,
		});
	}

	// Golden-baseline diff: record first-seen healthy responses, compare the
	// rest — after a fix/optimization episode this is the per-endpoint
	// degraded/same/improved regression verdict (see probeBaseline.ts).
	const baselineVerdicts = applyBaselines(workspaceRoot, observations);
	for (const outcome of outcomes) {
		const cmp = baselineVerdicts.get(outcome.id);
		if (cmp) {
			outcome.baseline = cmp.verdict;
			outcome.baselineDetail = cmp.detail;
		}
	}

	const summary: ProbeRunSummary = {
		service: target.service,
		ranAt: new Date().toISOString(),
		total: outcomes.length,
		passed: outcomes.filter((o) => o.verdict === 'pass').length,
		failed: outcomes.filter((o) => o.verdict === 'fail').length,
		needsAuthoring: outcomes.filter((o) => o.verdict === 'needs-authoring').length,
		degraded: outcomes.filter((o) => o.baseline === 'degraded').length,
		improved: outcomes.filter((o) => o.baseline === 'improved').length,
		probes: outcomes,
	};
	writeProbeFile(workspaceRoot, {
		version: 1,
		service: target.service,
		generatedAt: persisted?.generatedAt ?? new Date().toISOString(),
		probes: specs,
		lastRun: summary,
	});
	publishProbeState({
		phase: 'done',
		label: `${summary.passed}/${summary.total} passed` + (summary.failed ? `, ${summary.failed} failed` : ''),
		results: { ...getProbeState().results, [target.service]: summary },
	});

	// Probe failures are issues: recompute + publish (and auto-dispatch new ones).
	await recomputeIssues(context, workspaceRoot, manifest);

	return {
		outcome: 'done',
		total: summary.total,
		failed: summary.failed,
		failedIds: outcomes.filter((o) => o.verdict === 'fail').map((o) => o.id),
	};
}
