/**
 * Journey data assembly — the single start-to-end walkthrough of everything
 * Vinv verified: every discovered service, then every endpoint in order with
 * its call tree, runtime coverage, latency profile, and the exact inputs and
 * outputs the exerciser drove through it.
 *
 * Pure filesystem reads (no vscode import) so the whole assembly is unit-
 * testable against a fixture directory. Sources, all under <root>/.vinv/:
 *
 *   services.json                     — the services bringup verified
 *   exercise/scorecard.json           — per-endpoint coverage/latency/issues
 *   exercise/profile.json             — behavioral profile (fallback ordering)
 *   exercise/results.jsonl            — every probe's input → output record
 *   exercise/plan.json                — api_id ↔ METHOD/path map + semantics
 *   reports/calltree-<api_id>.json    — static tree + runtime overlay snapshot
 *
 * User-authored inputs land in exercise/prompts/<api_id>.json as reply plans —
 * the SAME channel harness-authored scenarios use, so the engine replays them
 * on the next run with zero special-casing (and a fresh reply fingerprint
 * automatically revives an expired scenario).
 */

import * as fs from 'fs';
import * as path from 'path';

/** One executed probe, trimmed for display: what went in, what came back. */
export interface JourneyIoRow {
	strategy: string;
	inputClass: string;
	status: number | null;
	latencyMs: number | null;
	auth: boolean;
	/** JSON-stringified request input (body/path_params/query), bounded. */
	input: string;
	/** JSON-stringified response body, bounded; empty when none captured. */
	output: string;
	error: string | null;
}

/** One endpoint step of the walkthrough. */
export interface JourneyStep {
	apiId: string;
	method: string;
	path: string;
	handler: string | null;
	coverage: { covered: number; total: number; pct: number };
	handlerObserved: boolean;
	p50Ms: number;
	p95Ms: number;
	statuses: Record<string, number>;
	invariants: number;
	/** Call-tree snapshot (static + runtime overlay) if a report exists. */
	tree: unknown | null;
	treeError: string | null;
	io: JourneyIoRow[];
	/** True when this endpoint accepts harness/user-authored semantic plans. */
	acceptsUserInputs: boolean;
	userPlanCount: number;
}

export interface Journey {
	root: string;
	services: Array<{ name: string; kind: string; port: number | null; command: string }>;
	scenarios: { run: number; completed: number; expired: Array<{ name: string; reason: string }> };
	statePollution: { created: number; cleaned: number; uncleaned: number };
	coverage: {
		endpointsCovered: number;
		endpointsTotal: number;
		symbolsCovered: number;
		symbolsTotal: number;
	};
	issues: Array<{ kind: string; title: string }>;
	steps: JourneyStep[];
}

const MAX_IO_ROWS = 15;
const MAX_JSON_CHARS = 400;

function readJson(file: string): any | null {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function readJsonl(file: string): any[] {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	const out: any[] = [];
	for (const line of text.split('\n')) {
		const t = line.trim();
		if (!t) {
			continue;
		}
		try {
			out.push(JSON.parse(t));
		} catch {
			// tolerate torn writes — the record is simply skipped
		}
	}
	return out;
}

function boundedJson(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	let s: string;
	try {
		s = JSON.stringify(value);
	} catch {
		s = String(value);
	}
	return s.length > MAX_JSON_CHARS ? `${s.slice(0, MAX_JSON_CHARS)}…` : s;
}

/** Latest bounded IO rows for one endpoint, newest first. */
function ioRowsFor(results: any[], apiId: string): JourneyIoRow[] {
	const rows: JourneyIoRow[] = [];
	for (let i = results.length - 1; i >= 0 && rows.length < MAX_IO_ROWS; i--) {
		const r = results[i];
		if (r?.api_id !== apiId && r?.endpoint_id !== apiId) {
			continue;
		}
		rows.push({
			strategy: String(r.strategy ?? ''),
			inputClass: String(r.input_class ?? ''),
			status: typeof r.status === 'number' ? r.status : null,
			latencyMs: typeof r.latency_ms === 'number' ? r.latency_ms : null,
			auth: Boolean(r.auth),
			input: boundedJson(r.input),
			output: boundedJson(r.body),
			error: r.error ? String(r.error) : null,
		});
	}
	return rows;
}

/**
 * Assembles the full journey for a workspace. Missing artifacts degrade to
 * empty sections (a repo that never ran the exerciser still gets services +
 * call trees); they never throw.
 */
export function buildJourney(workspaceRoot: string): Journey {
	const vinv = path.join(workspaceRoot, '.vinv');
	const servicesDoc = readJson(path.join(vinv, 'services.json')) ?? {};
	const scorecard = readJson(path.join(vinv, 'exercise', 'scorecard.json')) ?? {};
	const plan = readJson(path.join(vinv, 'exercise', 'plan.json')) ?? {};
	const results = readJsonl(path.join(vinv, 'exercise', 'results.jsonl'));

	const services = (Array.isArray(servicesDoc.services) ? servicesDoc.services : []).map(
		(s: any) => ({
			name: String(s.name ?? ''),
			kind: String(s.kind ?? ''),
			port: typeof s.port === 'number' ? s.port : null,
			command: String(s.command ?? ''),
		}),
	);

	// Canonical endpoint list + api_id mapping from the plan; the scorecard's
	// per-endpoint rows join on "METHOD path".
	const scoreByEndpoint = new Map<string, any>();
	for (const e of scorecard.endpoints ?? []) {
		scoreByEndpoint.set(String(e.endpoint ?? ''), e);
	}

	const steps: JourneyStep[] = [];
	for (const ep of plan.endpoints ?? []) {
		const apiId = String(ep.api_id ?? '');
		if (!apiId) {
			continue;
		}
		const endpointLabel = `${ep.method} ${ep.path}`;
		const score = scoreByEndpoint.get(endpointLabel) ?? {};
		const covText = String(score.coverage ?? '0/0');
		const [covered, total] = covText.split('/').map((n: string) => parseInt(n, 10) || 0);

		const report = readJson(path.join(vinv, 'reports', `calltree-${apiId}.json`));
		const promptDoc = readJson(path.join(vinv, 'exercise', 'prompts', `${apiId}.json`));
		const planCount = Array.isArray(promptDoc?.reply?.plans) ? promptDoc.reply.plans.length : 0;

		steps.push({
			apiId,
			method: String(ep.method ?? ''),
			path: String(ep.path ?? ''),
			handler: ep.handler ? String(ep.handler) : null,
			coverage: { covered, total, pct: Number(score.pct ?? 0) },
			handlerObserved: Boolean(score.handler_observed),
			p50Ms: Number(score.p50_ms ?? 0),
			p95Ms: Number(score.p95_ms ?? 0),
			statuses: score.statuses ?? {},
			invariants: Number(score.invariants ?? 0),
			tree: report?.tree ?? null,
			treeError: report && !report.tree ? String(report.error ?? 'no tree in snapshot') : null,
			io: ioRowsFor(results, apiId),
			acceptsUserInputs: true,
			userPlanCount: planCount,
		});
	}
	// Stable walk order: method-grouped, then path — reads like an API index.
	steps.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

	const after = scorecard.coverage?.after_exercised ?? {};
	return {
		root: workspaceRoot,
		services,
		scenarios: scorecard.scenarios ?? { run: 0, completed: 0, expired: [] },
		statePollution: scorecard.state_pollution ?? { created: 0, cleaned: 0, uncleaned: 0 },
		coverage: {
			endpointsCovered: Number(after.endpoints_with_coverage ?? 0),
			endpointsTotal: Number(after.endpoints_total ?? steps.length),
			symbolsCovered: Number(after.symbols_covered ?? 0),
			symbolsTotal: Number(after.symbols_total ?? 0),
		},
		issues: (scorecard.issues ?? []).map((i: any) => ({
			kind: String(i.kind ?? ''),
			title: String(i.title ?? ''),
		})),
		steps,
	};
}

/** Minimal validated shape of a user-authored input plan. */
export interface UserPlan {
	inputs: {
		body?: unknown;
		path_params?: Record<string, unknown>;
		query?: Record<string, unknown>;
		headers?: Record<string, string>;
	};
	expect?: { status?: number | string; notes?: string };
}

/**
 * Appends one user-authored input plan to the endpoint's semantic reply —
 * the same file the harness's authored scenarios live in, so the exerciser
 * replays it on the next `run` with no special-casing. Creating a fresh
 * reply (or changing an existing one) shifts the reply fingerprint, which
 * automatically revives a scenario that had expired.
 *
 * Returns the new total plan count. Throws with an actionable message on a
 * malformed plan — the caller surfaces it verbatim.
 */
export function appendUserPlan(
	workspaceRoot: string,
	apiId: string,
	endpoint: string,
	plan: UserPlan,
): number {
	if (!apiId || !/^[A-Za-z0-9._-]+$/.test(apiId)) {
		throw new Error(`Invalid endpoint id: ${JSON.stringify(apiId)}`);
	}
	if (!plan || typeof plan !== 'object' || typeof plan.inputs !== 'object' || plan.inputs === null) {
		throw new Error('A plan needs an "inputs" object (body / path_params / query / headers).');
	}
	const file = path.join(workspaceRoot, '.vinv', 'exercise', 'prompts', `${apiId}.json`);
	const doc = readJson(file) ?? { api_id: apiId, endpoint, reply: null };
	const reply =
		doc.reply && Array.isArray(doc.reply.plans) ? doc.reply : { plans: [] };
	reply.plans.push({
		endpoint,
		inputs: plan.inputs,
		setup: [],
		expect: plan.expect ?? { status: '2xx', notes: 'user-authored input' },
		user_authored: true,
	});
	doc.reply = reply;
	// A user just re-armed this endpoint — any expiry verdict is spent.
	delete doc.reply_expired;
	delete doc.reply_expired_for;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
	return reply.plans.length;
}
