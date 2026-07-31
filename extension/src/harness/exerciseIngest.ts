/**
 * Ingests an EXTERNAL test run into vinv's exercise artifacts.
 *
 * A "unit" here is whatever was exercised: an HTTP endpoint (`GET /users`), a
 * CLI invocation (`RUN acme-tool report`), or a driven call
 * (`CALL acme.mod.summarize`). Only the first has a route a trace can name; the
 * other two are how a repo with no service gets recorded at all.
 *
 * vinv's Journey/Findings views are fed by its own exerciser. A run driven by
 * anything else — an agent, a CI suite, k6, Postman — leaves those views empty
 * even when full tracelens captures exist, because three things live only with
 * whoever SENT the traffic:
 *
 *   - the input→output record per probe (traces cap summaries and hold no bodies)
 *   - the route each request hit
 *   - the ORACLE: whether a given response was actually wrong
 *
 * A trace can supply the second one now that inbound server spans are named
 * `METHOD /path`; the other two must be handed in. This module takes them,
 * validates them, joins them to the captures, and writes the five artifacts the
 * views read.
 *
 * Everything written is stamped with provenance. Once agents can write here, a
 * hallucinated scorecard must be distinguishable from a measured one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

import { indexStoreDir, loadNodes, type GraphNode } from '../graph/indexGraph';
import { collectRequestSpans, type TraceSpan } from './runtimeAnalysis';

/** One check an external harness performed against one endpoint. */
export interface IngestCheck {
	/** "METHOD /path", e.g. "POST /run-agent". */
	endpoint: string;
	/**
	 * Which service serves this endpoint. Optional, but REQUIRED in practice
	 * whenever a repo runs more than one service: three apps each serving
	 * `GET /` are three different endpoints, and merging them into one row
	 * would average unrelated latencies and pool unrelated status codes.
	 * Supplied here it is appended to the displayed path to keep them distinct.
	 */
	service?: string;
	/** Scenario name — the strategy label in the Journey I/O table. */
	name: string;
	/** positive | negative | corner | security | load — free-form, shown as input class. */
	category?: string;
	/** HTTP status observed, or null when the request never completed. */
	status?: number | null;
	latency_ms?: number;
	/** What was sent (bounded when rendered). */
	input?: unknown;
	/** What came back (bounded when rendered). */
	output?: unknown;
	/** THE ORACLE: did this check pass? Nothing else can supply this. */
	passed: boolean;
	/** low | medium | high — only meaningful when passed === false. */
	severity?: string;
	/** Which repetition of the suite this came from. */
	round?: number;
	/** Why it failed, in the harness's own words. */
	detail?: string;
	/**
	 * `http_endpoint` | `cli_invocation` | `function_call`. Optional — inferred
	 * from the label's verb when omitted, so an existing caller sending only
	 * `METHOD /path` keeps working unchanged.
	 */
	unit_kind?: string;
}

export interface IngestRun {
	/** Who produced this run — recorded verbatim as provenance. */
	source?: string;
	checks: IngestCheck[];
}

export interface IngestResult {
	status: 'ok' | 'error';
	message?: string;
	endpoints: number;
	checks: number;
	failed: number;
	issue_clusters: number;
	opportunities: number;
	endpoints_with_coverage: number;
	symbols_covered: number;
	symbols_total: number;
	/** Endpoints seen in checks that no capture could be joined to. */
	endpoints_without_traces: string[];
	written: string[];
}

/**
 * An inbound HTTP request label: `METHOD /path`.
 *
 * Kept strict, and deliberately NOT widened to the unit grammar below: this is
 * also what decides whether a captured root span is an inbound request tree, so
 * loosening it would start attributing startup and import spans to units.
 */
const ENDPOINT_RE = /^([A-Z]+)\s+(\/\S*)$/;

/**
 * Any unit of work: `VERB target`.
 *
 * `GET /users`, `RUN acme-tool report --since 7d`, `CALL acme.mod.summarize`.
 * A repo with no service still exercises units, and refusing to ingest them
 * left an agent that had genuinely driven a CLI with nowhere to report it —
 * the Journey and Findings views then showed nothing, which reads as "this was
 * never tested" rather than "this was tested and not recordable".
 */
const UNIT_RE = /^([A-Z]+)\s+(\S.*)$/;

/** The unit kind a label implies, when the caller did not say. */
function unitKindOf(label: string): string {
	if (ENDPOINT_RE.test(label.trim())) {
		return 'http_endpoint';
	}
	return label.trim().startsWith('CALL ') ? 'function_call' : 'cli_invocation';
}
const P95_OUTLIER_MS = 10_000;

/** "POST /run-agent" -> a filesystem- and id-safe api_id. */
export function apiIdFor(endpoint: string): string {
	const m = UNIT_RE.exec(endpoint.trim());
	const method = m ? m[1] : 'ANY';
	const p = m ? m[2] : endpoint;
	const slug = p.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
	return `${method}_${slug}`;
}

function pctile(values: number[], p: number): number {
	if (values.length === 0) {
		return 0;
	}
	const s = [...values].sort((a, b) => a - b);
	return Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] * 10) / 10;
}

/**
 * Per-endpoint symbol coverage, derived from the captures alone.
 *
 * Depends on inbound server spans being named `METHOD /path` (tracelens
 * exporter). Each request tree whose ROOT is such a span attributes every
 * instrumented symbol beneath it to that endpoint — so a request rejected at
 * the edge (400/404) correctly attributes nothing, and two endpoints of the
 * same service no longer share one undifferentiated blob of coverage.
 */
export function deriveEndpointCoverage(
	workspaceRoot: string,
	nodes: GraphNode[],
): Map<string, Set<number>> {
	const byEndpoint = new Map<string, Set<number>>();
	const walk = (span: TraceSpan, into: Set<number>): void => {
		if (span.row !== null) {
			into.add(span.row);
		}
		for (const c of span.children) {
			walk(c, into);
		}
	};
	for (const rootSpan of collectRequestSpans(workspaceRoot, nodes)) {
		const label = String(rootSpan.component ?? '').trim();
		if (!ENDPOINT_RE.test(label)) {
			continue; // not an inbound request tree (startup/import spans)
		}
		const set = byEndpoint.get(label) ?? new Set<number>();
		for (const c of rootSpan.children) {
			walk(c, set);
		}
		if (rootSpan.row !== null) {
			set.add(rootSpan.row);
		}
		byEndpoint.set(label, set);
	}
	return byEndpoint;
}

/** Validates a run, refusing anything malformed BEFORE touching the disk. */
export function validateRun(run: unknown): { ok: true; run: IngestRun } | { ok: false; error: string } {
	if (typeof run !== 'object' || run === null) {
		return { ok: false, error: 'run must be an object' };
	}
	const checks = (run as IngestRun).checks;
	if (!Array.isArray(checks) || checks.length === 0) {
		return { ok: false, error: 'run.checks must be a non-empty array' };
	}
	for (let i = 0; i < checks.length; i += 1) {
		const c = checks[i];
		if (typeof c !== 'object' || c === null) {
			return { ok: false, error: `checks[${i}] must be an object` };
		}
		if (typeof c.endpoint !== 'string' || !UNIT_RE.test(c.endpoint.trim())) {
			return {
				ok: false,
				error:
					`checks[${i}].endpoint must look like "METHOD /path", "RUN <command>" or ` +
					`"CALL module.function" (got ${JSON.stringify(c.endpoint)})`,
			};
		}
		if (typeof c.name !== 'string' || !c.name.trim()) {
			return { ok: false, error: `checks[${i}].name must be a non-empty string` };
		}
		if (typeof c.passed !== 'boolean') {
			// The oracle is the one thing this module cannot infer — refuse to guess it.
			return { ok: false, error: `checks[${i}].passed must be a boolean (the pass/fail verdict)` };
		}
	}
	return { ok: true, run: run as IngestRun };
}

/** Writes the five artifacts. Pure apart from the final write. */
export function ingestRun(
	workspaceRoot: string,
	rawRun: unknown,
	opts: { write?: boolean } = {},
): IngestResult {
	const v = validateRun(rawRun);
	if (!v.ok) {
		return {
			status: 'error',
			message: v.error,
			endpoints: 0,
			checks: 0,
			failed: 0,
			issue_clusters: 0,
			opportunities: 0,
			endpoints_with_coverage: 0,
			symbols_covered: 0,
			symbols_total: 0,
			endpoints_without_traces: [],
			written: [],
		};
	}
	const run = v.run;
	const source = typeof run.source === 'string' && run.source ? run.source : 'external_harness';

	let nodes: GraphNode[] = [];
	try {
		nodes = loadNodes(indexStoreDir(workspaceRoot));
	} catch {
		nodes = []; // no index yet: coverage degrades to 0/0, the rest still lands
	}
	const coverage = nodes.length > 0 ? deriveEndpointCoverage(workspaceRoot, nodes) : new Map();

	// Denominator: index symbols in the packages the traces actually touched.
	const pkgPrefixes = new Set<string>();
	for (const rows of coverage.values()) {
		for (const row of rows) {
			const f = String(nodes[row]?.file ?? '');
			const m = /^((?:src\/)?[^/]+)\//.exec(f);
			if (m) {
				pkgPrefixes.add(m[1] + '/');
			}
		}
	}
	const symbolsTotal =
		pkgPrefixes.size > 0
			? nodes.filter((n) => [...pkgPrefixes].some((p) => String(n.file ?? '').startsWith(p))).length
			: 0;

	// Group by endpoint, keeping services apart. Only endpoints that ACTUALLY
	// collide across services get the service suffix, so a single-service repo
	// keeps clean "POST /chat" labels.
	const ownersOf = new Map<string, Set<string>>();
	for (const c of run.checks) {
		const key = c.endpoint.trim();
		const svc = String(c.service ?? '').trim();
		if (!ownersOf.has(key)) {
			ownersOf.set(key, new Set());
		}
		if (svc) {
			ownersOf.get(key)!.add(svc);
		}
	}
	const labelFor = (c: IngestCheck): string => {
		const key = c.endpoint.trim();
		const svc = String(c.service ?? '').trim();
		return svc && (ownersOf.get(key)?.size ?? 0) > 1 ? `${key}  [${svc}]` : key;
	};

	const byEndpoint = new Map<string, IngestCheck[]>();
	/** display label -> the raw "METHOD /path" used to join captures. */
	const rawOf = new Map<string, string>();
	for (const c of run.checks) {
		const key = labelFor(c);
		rawOf.set(key, c.endpoint.trim());
		if (!byEndpoint.has(key)) {
			byEndpoint.set(key, []);
		}
		byEndpoint.get(key)!.push(c);
	}

	const planEndpoints: unknown[] = [];
	const scoreEndpoints: Record<string, unknown>[] = [];
	const resultRows: unknown[] = [];
	const failures: { severity: string; endpoint: string; detail: string }[] = [];
	const allCovered = new Set<number>();
	const missingTraces: string[] = [];
	let endpointsWithCoverage = 0;

	for (const [endpoint, rows] of byEndpoint) {
		const raw = rawOf.get(endpoint) ?? endpoint;
		// UNIT_RE, not ENDPOINT_RE: validateRun accepted `RUN …` / `CALL …` too,
		// and the old non-null assertion would have thrown on exactly those.
		const m = UNIT_RE.exec(raw)!;
		const method = m[1];
		// Display path carries the service suffix; the join uses the raw route.
		const p = endpoint === raw ? m[2] : `${m[2]}  [${endpoint.split('[')[1]?.replace(']', '').trim() ?? ''}]`;
		const apiId = apiIdFor(endpoint);
		const covered = coverage.get(raw) ?? new Set<number>();
		if (covered.size === 0 && !coverage.has(raw)) {
			missingTraces.push(endpoint);
		}
		for (const r of covered) {
			allCovered.add(r);
		}
		if (covered.size > 0) {
			endpointsWithCoverage += 1;
		}

		planEndpoints.push({
			api_id: apiId,
			unit_kind: rows[0]?.unit_kind ?? unitKindOf(raw),
			method,
			path: p,
			handler: null,
			body_schema: null,
			param_schemas: [],
			source,
			needs_semantics: false,
			requires_auth: false,
			content_type: 'application/json',
			inputs: [],
		});

		const latencies = rows.map((r) => Number(r.latency_ms ?? 0));
		const statuses: Record<string, number> = {};
		for (const r of rows) {
			const k = r.status === null || r.status === undefined ? 'none' : String(r.status);
			statuses[k] = (statuses[k] ?? 0) + 1;
		}

		scoreEndpoints.push({
			// journeyModel joins the scorecard on `${method} ${path}` — it must
			// match the plan entry exactly, service suffix included.
			endpoint: `${method} ${p}`,
			api_id: apiId,
			coverage: `${covered.size}/${symbolsTotal}`,
			pct: symbolsTotal ? Math.round((covered.size / symbolsTotal) * 1000) / 10 : 0,
			handler_observed: covered.size > 0,
			p50_ms: pctile(latencies, 50),
			p95_ms: pctile(latencies, 95),
			statuses,
			invariants: 0,
			checks: rows.length,
			failed: rows.filter((r) => !r.passed).length,
		});

		for (const r of rows) {
			resultRows.push({
				api_id: apiId,
				endpoint_id: apiId,
				strategy: r.name,
				input_class: r.category ?? '',
				status: r.status ?? null,
				latency_ms: Math.round(Number(r.latency_ms ?? 0)),
				auth: false,
				input: r.input ?? { scenario: r.name, round: r.round ?? 1 },
				body: r.output ?? '',
				error: r.passed ? null : (r.detail ?? r.name),
			});
			if (!r.passed) {
				failures.push({
					severity: r.severity ?? 'medium',
					endpoint,
					detail: r.detail ?? r.name,
				});
			}
		}
	}

	// Cluster failures by ROOT CAUSE, not per check: one "500 on invalid input"
	// defect reachable through six inputs is one issue, not six.
	const sevRank: Record<string, number> = { low: 1, medium: 2, high: 3 };
	const clusterMap = new Map<
		string,
		{ kind: string; detail: string; eps: Set<string>; n: number }
	>();
	for (const f of failures) {
		const norm = f.detail.split(' - ')[0].replace(/\d+/g, 'N').trim().toLowerCase();
		const sig = createHash('sha1').update(norm).digest('hex').slice(0, 12);
		const cur = clusterMap.get(sig) ?? {
			kind: 'low',
			detail: f.detail.split(' - ')[0].trim(),
			eps: new Set<string>(),
			n: 0,
		};
		cur.n += 1;
		cur.eps.add(f.endpoint);
		if ((sevRank[f.severity] ?? 0) > (sevRank[cur.kind] ?? 0)) {
			cur.kind = f.severity;
		}
		clusterMap.set(sig, cur);
	}
	const clusters = [...clusterMap.entries()]
		.map(([signature, c]) => ({
			signature,
			kind: c.kind,
			title: `${c.detail} — ${c.n} check${c.n === 1 ? '' : 's'} across ${c.eps.size} endpoint${
				c.eps.size === 1 ? '' : 's'
			}`,
			occurrences: c.n,
			endpoints: [...c.eps],
		}))
		.sort((a, b) => (sevRank[b.kind] ?? 0) - (sevRank[a.kind] ?? 0) || b.occurrences - a.occurrences);

	const opportunities = scoreEndpoints
		.filter((e) => Number(e.p95_ms) >= P95_OUTLIER_MS)
		.sort((a, b) => Number(b.p95_ms) - Number(a.p95_ms))
		.map((e) => ({
			kind: 'latency',
			endpoint: String(e.endpoint),
			detail: `p95 ${Math.round(Number(e.p95_ms))}ms (p50 ${Math.round(Number(e.p50_ms))}ms) over ${e.checks} checks`,
			value: Math.round(Number(e.p95_ms)),
		}));

	const stamp = { generated_at: new Date().toISOString(), source, ingested_by: 'vinv_ingest_run' };
	const plan = {
		status: 'ok',
		diagnostics: [
			`Imported from an external harness (${source}) — not produced by vinv's exerciser.`,
			'Coverage is joined from tracelens captures by inbound route; no semantic input plans exist.',
		],
		...stamp,
		service: source,
		repo: workspaceRoot,
		base_url: '',
		input_source: 'external_harness',
		seed: 0,
		endpoint_count: planEndpoints.length,
		semantic_prompt_count: 0,
		endpoints: planEndpoints,
	};
	const scorecard = {
		...stamp,
		endpoints: scoreEndpoints,
		coverage: {
			after_exercised: {
				endpoints_with_coverage: endpointsWithCoverage,
				endpoints_total: planEndpoints.length,
				symbols_covered: allCovered.size,
				symbols_total: symbolsTotal,
			},
		},
		issues: clusters.map((c) => ({ kind: c.kind, title: c.title })),
		issue_clusters: clusters.length,
		scenarios: { run: resultRows.length, completed: resultRows.length, expired: [] },
		state_pollution: { created: 0, cleaned: 0, uncleaned: 0 },
	};
	const issuesDoc = { ...stamp, cluster_count: clusters.length, clusters };
	const profile = { ...stamp, opportunities };

	const written: string[] = [];
	if (opts.write !== false) {
		const ex = path.join(workspaceRoot, '.vinv', 'exercise');
		fs.mkdirSync(ex, { recursive: true });
		const files: [string, string][] = [
			['plan.json', JSON.stringify(plan, null, 2)],
			['scorecard.json', JSON.stringify(scorecard, null, 2)],
			['issues.json', JSON.stringify(issuesDoc, null, 2)],
			['profile.json', JSON.stringify(profile, null, 2)],
			['results.jsonl', resultRows.map((r) => JSON.stringify(r)).join('\n') + '\n'],
		];
		for (const [name, body] of files) {
			// Write via a temp file + rename so a reader never sees a half-written
			// artifact (the views poll these on a watcher).
			const dest = path.join(ex, name);
			const tmp = `${dest}.tmp`;
			fs.writeFileSync(tmp, body, 'utf8');
			fs.renameSync(tmp, dest);
			written.push(path.join('.vinv', 'exercise', name));
		}
	}

	return {
		status: 'ok',
		endpoints: planEndpoints.length,
		checks: resultRows.length,
		failed: failures.length,
		issue_clusters: clusters.length,
		opportunities: opportunities.length,
		endpoints_with_coverage: endpointsWithCoverage,
		symbols_covered: allCovered.size,
		symbols_total: symbolsTotal,
		endpoints_without_traces: missingTraces,
		written,
	};
}
