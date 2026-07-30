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
	/**
	 * The services bring-up verified, from .vinv/services.json.
	 *
	 * Carried here because this view is the one landing surface: services were
	 * previously visible ONLY in the Journey tab, which had no entry point
	 * outside the command palette, so "what did Vinv actually bring up" was
	 * effectively unreachable.
	 */
	services: Array<{ name: string; kind: string; port: number | null; command: string }>;
	issues: Array<{ kind: string; title: string; signature: string }>;
	episodes: FindingsEpisode[];
	opportunities: Array<{ kind: string; endpoint: string; detail: string; value: number }>;
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

export function buildFindings(workspaceRoot: string): Findings {
	const ex = path.join(workspaceRoot, '.vinv', 'exercise');
	const scorecard = readJson(path.join(ex, 'scorecard.json')) ?? {};
	const issuesDoc = readJson(path.join(ex, 'issues.json')) ?? {};
	const profile = readJson(path.join(ex, 'profile.json')) ?? {};
	const episodesRaw = readJsonl(path.join(ex, 'optimize.jsonl'));
	const regressRaw = readJsonl(path.join(ex, 'regress.jsonl'));
	const ledger = readJsonl(path.join(ex, 'state_ledger.jsonl'));
	const servicesDoc = readJson(path.join(workspaceRoot, '.vinv', 'services.json')) ?? {};
	const services = (Array.isArray(servicesDoc.services) ? servicesDoc.services : []).map(
		(s: any) => ({
			name: String(s.name ?? ''),
			kind: String(s.kind ?? ''),
			port: typeof s.port === 'number' ? s.port : null,
			command: String(s.command ?? ''),
		}),
	);

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
			issuesFound: Number(scorecard.issue_clusters ?? (issuesDoc.clusters ?? []).length),
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
		services,
		issues: (issuesDoc.clusters ?? []).map((c: any) => ({
			kind: String(c.kind ?? ''),
			title: String(c.title ?? ''),
			signature: String(c.signature ?? ''),
		})),
		episodes,
		opportunities: (profile.opportunities ?? []).map((o: any) => ({
			kind: String(o.kind ?? ''),
			endpoint: String(o.endpoint ?? ''),
			detail: String(o.detail ?? ''),
			value: Number(o.value ?? 0),
		})),
		regress,
		endpoints: (scorecard.endpoints ?? []).map((e: any) => ({
			endpoint: String(e.endpoint ?? ''),
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
