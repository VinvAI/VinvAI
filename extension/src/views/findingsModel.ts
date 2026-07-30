/**
 * Findings data assembly — "what Vinv found and fixed", the USP surface.
 *
 * Pure filesystem reads (no vscode import; unit-tested on fixtures). One
 * assembly feeds BOTH audiences: the findings webview renders it for humans,
 * and the same object is written verbatim to .vinv/reports/findings.json as
 * the machine-readable summary an agent can consume without scraping HTML.
 *
 * Sources under <root>/.vinv/exercise/:
 *   issues.json      — behavioral failure clusters the exerciser found
 *   optimize.jsonl   — optimization episodes: attempts, paired-bootstrap CIs,
 *                      behavior-suite verdicts, accept/revert outcomes
 *   regress.jsonl    — every regression replay's summary (diff kinds history)
 *   scorecard.json   — coverage before/after + per-endpoint latency/statuses
 *   profile.json     — detected optimization opportunities (P95 outliers)
 *   state_ledger.jsonl — what the engine planted and whether it was unwound
 */

import * as fs from 'fs';
import * as path from 'path';

import { evidenceFileForKind, isDispatchableKind } from '../harness/issueKinds';
import { serviceForEndpointFile } from '../bringup/targetPackages';

/**
 * Resolves `METHOD /path` → owning service, for every endpoint the workspace
 * knows about.
 *
 * Findings are produced per-endpoint by the exerciser, which has no concept of
 * a service — so the attribution is reconstructed here from two artifacts that
 * do: `.vinv/identification/apis.json` maps an endpoint to the FILE its handler
 * lives in, and `.vinv/services.json` maps a file back to the service whose
 * entrypoint module contains it (serviceForEndpointFile, shared with the
 * capture-directory join so both agree).
 *
 * Keyed on BOTH the trigger and the endpoint id, because issues.json spells the
 * endpoint as `METHOD /path` while the scorecard and profile sometimes carry
 * the id form (`GET_homepage`). An endpoint whose file resolves to no service —
 * or to more than one, which serviceForEndpointFile reports as null rather than
 * guessing — is simply absent, and its findings stay unattributed instead of
 * being filed under a service that may not own them.
 */
export function buildServiceIndex(workspaceRoot: string): Map<string, string> {
	const index = new Map<string, string>();
	const apis = readJson(path.join(workspaceRoot, '.vinv', 'identification', 'apis.json'));
	const services = readJson(path.join(workspaceRoot, '.vinv', 'services.json'));
	const list: Array<{ name: string; command?: string }> = Array.isArray(services)
		? services
		: (services?.services ?? []);
	if (!apis || list.length === 0) {
		return index;
	}
	for (const e of apis.entrypoints ?? []) {
		const file = typeof e?.file === 'string' ? e.file : '';
		if (!file) {
			continue;
		}
		const owner = serviceForEndpointFile(list, file);
		if (!owner) {
			continue;
		}
		for (const key of [e.trigger, e.id]) {
			if (typeof key === 'string' && key) {
				index.set(key, owner);
			}
		}
	}
	return index;
}

export interface FindingsEpisodeAttempt {
	approach: string;
	behaviorSuitePassed: boolean;
	reverted: boolean;
	/** Relative improvement point estimate and 95% CI, when measured. */
	rel: number | null;
	ciLow: number | null;
	ciHigh: number | null;
}

export interface FindingsEpisode {
	at: number;
	label: string;
	action: string; // accept | revert-and-retry | revert-and-stop
	reason: string;
	opportunity: { kind: string; endpoint: string; detail: string };
	attempts: FindingsEpisodeAttempt[];
	filesChanged: string[];
}

/**
 * One behavioral failure cluster, with the evidence that makes it actionable.
 *
 * The view used to get kind/title/signature and nothing else, so "POST /chat —
 * HTTP 500" was the whole story: no input to reproduce it, no expectation it
 * violated, no pointer to the rows behind it. issues.json has carried all of
 * that from the start — it was simply dropped on the way to the surface.
 */
export interface FindingsIssue {
	kind: string;
	title: string;
	signature: string;
	/** `METHOD /path` for an HTTP cluster; `ORACLE target` for the others. */
	endpoint: string;
	/**
	 * The service that owns this endpoint, when it can be established from
	 * apis.json + services.json (see buildServiceIndex). Absent when the
	 * endpoint maps to no service or to several — the filter treats that as
	 * "unattributed" rather than pretending to know.
	 */
	service?: string;
	/** How many failing cases collapsed into this cluster. */
	count: number;
	/** Whether a fix episode can be dispatched for it (diagnostics cannot). */
	dispatchable: boolean;
	/** `.vinv/exercise/<file>` holding the failing rows for this kind. */
	evidenceFile: string;
	/** The representative failure: what was sent, what came back, what was expected. */
	exemplar: {
		strategy: string;
		status: number | null;
		detail: string;
		expected: string;
		error: string;
		/** The request that triggered it, JSON-rendered for display. */
		input: string;
	} | null;
	/** Functions the failing case reached — where to start reading. */
	coveredFrames: string[];
}

export interface Findings {
	schemaVersion: 1;
	root: string;
	headline: {
		endpointsCovered: number;
		endpointsTotal: number;
		symbolsCovered: number;
		symbolsTotal: number;
		issuesFound: number;
		episodesAccepted: number;
		episodesReverted: number;
		regressCases: number;
		regressRealDiffs: number;
		stateCreated: number;
		stateCleaned: number;
	};
	/** Every service owning at least one finding, sorted — drives the filter. */
	services: string[];
	issues: FindingsIssue[];
	episodes: FindingsEpisode[];
	opportunities: Array<{
		kind: string;
		endpoint: string;
		service?: string;
		detail: string;
		value: number;
	}>;
	regress: {
		latest: {
			at: number;
			cases: number;
			behavior: number;
			contract: number;
			perf: number;
			environment: number;
			authSkipped: number;
			diffs: Array<{ kind: string; endpoint: string; detail: string }>;
		} | null;
		history: Array<{ at: number; behavior: number; contract: number; perf: number; environment: number }>;
	};
	endpoints: Array<{
		endpoint: string;
		service?: string;
		p50Ms: number;
		p95Ms: number;
		coverage: string;
		handlerObserved: boolean;
		statuses: Record<string, number>;
	}>;
	state: {
		created: number;
		cleaned: number;
		uncleaned: number;
		rows: Array<{ endpoint: string; cleaned: boolean; via: string | null }>;
	};
	scenarios: { run: number; completed: number; expired: Array<{ name: string; reason: string }> };
}

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
			// torn line — skip
		}
	}
	return out;
}

const MAX_EPISODES = 50;
const MAX_LEDGER_ROWS = 100;
const MAX_HISTORY = 40;

/** Renders an exemplar's request payload compactly enough to read at a glance. */
function renderInput(input: any): string {
	if (input === null || input === undefined) {
		return '';
	}
	// Drop the empty halves: an exemplar carries body/path_params/query whether or
	// not they were used, and three empty objects bury the one that mattered.
	if (typeof input === 'object' && !Array.isArray(input)) {
		const kept = Object.entries(input).filter(([, v]) => {
			if (v === null || v === undefined || v === '') {
				return false;
			}
			return typeof v !== 'object' || Object.keys(v as object).length > 0;
		});
		if (kept.length === 0) {
			// Every field empty IS the input — a bodyless POST is the whole test.
			return JSON.stringify(input);
		}
		return JSON.stringify(Object.fromEntries(kept), null, 1);
	}
	return JSON.stringify(input);
}

function toFindingsIssue(c: any, services: Map<string, string>): FindingsIssue {
	const ex = c.exemplar ?? null;
	const where = `${c.method ?? ''} ${c.path ?? ''}`.trim();
	const endpoint = where || String(c.endpoint_id ?? '');
	return {
		kind: String(c.kind ?? ''),
		title: String(c.title ?? ''),
		signature: String(c.signature ?? ''),
		endpoint,
		service: services.get(endpoint) ?? services.get(String(c.endpoint_id ?? '')),
		count: Number(c.count ?? 1),
		dispatchable: isDispatchableKind(String(c.kind ?? '')),
		evidenceFile: evidenceFileForKind(String(c.kind ?? '')),
		exemplar: ex
			? {
					strategy: String(ex.strategy ?? ''),
					status: typeof ex.status === 'number' ? ex.status : null,
					detail: String(ex.detail ?? ''),
					expected: String(ex.expected ?? ''),
					error: String(ex.error ?? ''),
					input: renderInput(ex.input),
				}
			: null,
		coveredFrames: (c.covered_frames ?? []).map(String),
	};
}

export function buildFindings(workspaceRoot: string): Findings {
	const ex = path.join(workspaceRoot, '.vinv', 'exercise');
	const scorecard = readJson(path.join(ex, 'scorecard.json')) ?? {};
	const issuesDoc = readJson(path.join(ex, 'issues.json')) ?? {};
	const profile = readJson(path.join(ex, 'profile.json')) ?? {};
	const serviceIndex = buildServiceIndex(workspaceRoot);
	const episodesRaw = readJsonl(path.join(ex, 'optimize.jsonl'));
	const regressRaw = readJsonl(path.join(ex, 'regress.jsonl'));
	const ledger = readJsonl(path.join(ex, 'state_ledger.jsonl'));
	const clusters: any[] = Array.isArray(issuesDoc.clusters) ? issuesDoc.clusters : [];
	const issues = clusters.map((c) => toFindingsIssue(c, serviceIndex));

	const episodes: FindingsEpisode[] = episodesRaw.slice(-MAX_EPISODES).map((e: any) => ({
		at: Number(e.at ?? 0),
		label: String(e.label ?? ''),
		action: String(e.action ?? ''),
		reason: String(e.reason ?? ''),
		opportunity: {
			kind: String(e.opportunity?.kind ?? ''),
			endpoint: String(e.opportunity?.endpoint ?? ''),
			detail: String(e.opportunity?.detail ?? ''),
		},
		attempts: (e.attempts ?? []).map((a: any) => ({
			approach: String(a.approach ?? ''),
			behaviorSuitePassed: Boolean(a.behavior_suite_passed),
			reverted: Boolean(a.reverted),
			rel: a.comparison?.rel_improvement ?? null,
			ciLow: a.comparison?.ci_low ?? null,
			ciHigh: a.comparison?.ci_high ?? null,
		})),
		filesChanged: (e.files_changed ?? []).map(String),
	})).reverse(); // newest first

	const latestRegress = regressRaw.length ? regressRaw[regressRaw.length - 1] : null;
	const regress = {
		latest: latestRegress
			? {
					at: Number(latestRegress.at ?? 0),
					cases: Number(latestRegress.cases ?? 0),
					behavior: Number(latestRegress.behavior_diffs ?? 0),
					contract: Number(latestRegress.contract_diffs ?? 0),
					perf: Number(latestRegress.perf_diffs ?? 0),
					environment: Number(latestRegress.environment_diffs ?? 0),
					authSkipped: Number(latestRegress.auth_cases_skipped ?? 0),
					diffs: (latestRegress.diffs ?? []).map((d: any) => ({
						kind: String(d.kind ?? ''),
						endpoint: String(d.endpoint ?? ''),
						detail: String(d.detail ?? ''),
					})),
				}
			: null,
		history: regressRaw.slice(-MAX_HISTORY).map((r: any) => ({
			at: Number(r.at ?? 0),
			behavior: Number(r.behavior_diffs ?? 0),
			contract: Number(r.contract_diffs ?? 0),
			perf: Number(r.perf_diffs ?? 0),
			environment: Number(r.environment_diffs ?? 0),
		})),
	};

	const after = scorecard.coverage?.after_exercised ?? {};
	const pollution = scorecard.state_pollution ?? {};
	const accepted = episodes.filter((e) => e.action === 'accept').length;

	return {
		schemaVersion: 1,
		root: workspaceRoot,
		headline: {
			endpointsCovered: Number(after.endpoints_with_coverage ?? 0),
			endpointsTotal: Number(after.endpoints_total ?? 0),
			symbolsCovered: Number(after.symbols_covered ?? 0),
			symbolsTotal: Number(after.symbols_total ?? 0),
			// issues.json is authoritative — it is the list rendered below, and the
			// exerciser rewrites it every pass. `scorecard.issue_clusters` is a copy
			// taken later, so a pass that dies before its `scorecard` step (or a
			// scorecard left behind by an imported run) leaves the two disagreeing:
			// the tile said 0 while the section under it listed six clusters.
			issuesFound: clusters.length,
			episodesAccepted: accepted,
			episodesReverted: episodes.length - accepted,
			regressCases: regress.latest?.cases ?? 0,
			regressRealDiffs:
				(regress.latest?.behavior ?? 0) +
				(regress.latest?.contract ?? 0) +
				(regress.latest?.perf ?? 0),
			stateCreated: Number(pollution.created ?? 0),
			stateCleaned: Number(pollution.cleaned ?? 0),
		},
		issues,
		services: [...new Set(issues.map((i) => i.service).filter((s): s is string => !!s))].sort(),
		episodes,
		opportunities: (profile.opportunities ?? []).map((o: any) => ({
			kind: String(o.kind ?? ''),
			endpoint: String(o.endpoint ?? ''),
			service: serviceIndex.get(String(o.endpoint ?? '')),
			detail: String(o.detail ?? ''),
			value: Number(o.value ?? 0),
		})),
		regress,
		endpoints: (scorecard.endpoints ?? []).map((e: any) => ({
			endpoint: String(e.endpoint ?? ''),
			service: serviceIndex.get(String(e.endpoint ?? '')),
			p50Ms: Number(e.p50_ms ?? 0),
			p95Ms: Number(e.p95_ms ?? 0),
			coverage: String(e.coverage ?? ''),
			handlerObserved: Boolean(e.handler_observed),
			statuses: e.statuses ?? {},
		})),
		state: {
			created: Number(pollution.created ?? ledger.length),
			cleaned: Number(pollution.cleaned ?? 0),
			uncleaned: Number(pollution.uncleaned ?? 0),
			rows: ledger.slice(-MAX_LEDGER_ROWS).map((r: any) => ({
				endpoint: `${r.method ?? ''} ${r.path ?? ''}`.trim(),
				cleaned: Boolean(r.cleaned),
				via: r.cleaned_via ? String(r.cleaned_via) : null,
			})),
		},
		scenarios: scorecard.scenarios ?? { run: 0, completed: 0, expired: [] },
	};
}

/** Writes the machine-readable summary and returns its path. */
export function writeFindingsSummary(workspaceRoot: string, findings: Findings): string {
	const file = path.join(workspaceRoot, '.vinv', 'reports', 'findings.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(findings, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
	return file;
}
