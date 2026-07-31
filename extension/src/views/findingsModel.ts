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
import { describeLineage } from '../harness/runtimeAnalysis';
import { serviceForEndpointFile } from '../bringup/targetPackages';
import { deadCodePath, type DeadCodeReport } from './deadCodeModel';
import { analysisPath, type DeadCodeAnalysis } from '../harness/deadCodeAnalysis';
import { readRuns, runHeadline, runsForSection } from '../harness/deadCodeRuns';
import { readEntryPoints, entryPointLabel } from '../identification/identification';
import { readUnitInventory } from './unitInventory';
import { readUnitStats } from './unitStats';

/** One row of the latency profile, before its service is attributed. */
interface UnitProfileRow {
	/** Entry-point id, used to attribute the row to a service. */
	id: string;
	endpoint: string;
	unitKind: string;
	p50Ms: number;
	p95Ms: number;
	coverage: string;
	handlerObserved: boolean;
	statuses: Record<string, number>;
}

/** The entry-point `kind` spelled the way the Findings view names units. */
function unitKindOf(kind: string): string {
	if (kind === 'http_api') {
		return 'http_endpoint';
	}
	return kind === 'function' ? 'function_call' : 'cli_invocation';
}

/**
 * The latency profile, computed from the captures.
 *
 * This used to be `scorecard.endpoints` — an exerciser's own summary of the
 * units it drove. That made the section describe a fraction of the workspace
 * (nothing else has a scorecard row), report `0/0` coverage and a "not reached"
 * badge whenever the exerciser's label-keyed join missed, and go stale the
 * moment new traffic arrived without a re-run. The captures answer the same
 * questions for every unit, in the same terms, as of this second.
 *
 * Only units the captures actually SAW are listed: a latency profile of things
 * that never ran is a list of zeros, and "never ran" is what the dead-code
 * section is for.
 */
function unitProfile(workspaceRoot: string): UnitProfileRow[] {
	const units = readUnitInventory(workspaceRoot, readEntryPoints(workspaceRoot));
	const stats = readUnitStats(workspaceRoot, units);
	const rows: UnitProfileRow[] = [];
	for (const u of units) {
		const s = stats.get(u.id);
		const ran = (s?.ok ?? 0) + (s?.error ?? 0);
		if (!s || ran === 0) {
			continue;
		}
		const statuses: Record<string, number> = {};
		if (s.ok) {
			statuses.ok = s.ok;
		}
		if (s.error) {
			statuses.error = s.error;
		}
		rows.push({
			id: u.id,
			endpoint: entryPointLabel(u),
			unitKind: unitKindOf(u.kind),
			p50Ms: Math.round(s.p50Ms ?? 0),
			p95Ms: Math.round(s.p95Ms ?? 0),
			// Blank, never "0/0": no overlay yet is not zero coverage.
			coverage: s.coverage ? `${s.coverage.executed}/${s.coverage.total}` : '',
			handlerObserved: true,
			statuses,
		});
	}
	// Busiest first, then slowest — the same order the Traces panel uses.
	return rows.sort(
		(a, b) =>
			(b.statuses.ok ?? 0) + (b.statuses.error ?? 0) -
				((a.statuses.ok ?? 0) + (a.statuses.error ?? 0)) || b.p95Ms - a.p95Ms,
	);
}

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
		/**
		 * An HTTP status for a route; the word a non-HTTP oracle recorded
		 * (`ok` | `error` | `timeout`) for a CLI invocation or a driven call.
		 * Non-numeric outcomes used to be coerced to null, which silently emptied
		 * the "Got" row for every CLI failure — the reader could see that
		 * something failed but not how it ended.
		 */
		status: number | string | null;
		detail: string;
		expected: string;
		error: string;
		/** The input that triggered it (request body, argv, or call arguments). */
		input: string;
	} | null;
	/** Functions the failing case reached — where to start reading. */
	coveredFrames: string[];
}

/**
 * One dead-code section as the Findings list needs it — identity, size, the
 * reachability verdict, and the agent's one-liner if it has read the code.
 *
 * Deliberately NOT the whole section: the member symbols and their source belong
 * to the section's own report tab, and carrying them here would make
 * findings.json grow with the dead code of the repo rather than with its
 * findings.
 */
export interface FindingsDeadSection {
	id: string;
	title: string;
	files: string[];
	layer: string;
	reason: 'orphan' | 'reachable-untested';
	lines: number;
	symbols: number;
	/** How many live symbols statically reference this section. */
	liveCallers: number;
	/** The agent's recommendation, or null when the section is unanalysed. */
	action: string | null;
	/** The agent's account of what the code does; empty when unanalysed. */
	what: string;
	/**
	 * What the last "Run this Path" attempt established, or '' when this section
	 * has never been driven. Carried here so the empirical half of the dead-code
	 * story is visible in the LIST — a section that was actually run and reached
	 * nothing is a much stronger finding than one nobody has tried.
	 */
	lastRun: string;
	/** ISO timestamp of that run; '' when there is none. */
	lastRunAt: string;
}

export interface FindingsDeadCode {
	/**
	 * False when no capture has been joined onto the graph. Everything would read
	 * as dead, so the list is empty and the panel says why — an untraced repo is
	 * an absence of evidence, not a pile of findings.
	 */
	hasTrace: boolean;
	/** Symbols a trace executed, of the symbols considered (tests/docs excluded). */
	traced: number;
	considered: number;
	/** Sections that have an agent verdict, of those listed. */
	analysed: number;
	sections: FindingsDeadSection[];
	/** The honest one-line rendering of the section selection's bounds. */
	bound: string;
}

export interface Findings {
	schemaVersion: 1;
	root: string;
	headline: {
		/**
		 * Exercised UNITS, not just HTTP routes: the exerciser drives CLI
		 * invocations and functions too, and both land in `endpoints` below
		 * spelled `METHOD path` like everything else. The field keeps its name
		 * because every reader joins on it (same call the scorecard makes), but
		 * the count is over all kinds — the same population the Traces panel
		 * lists — and `unitsByKind` is what lets the view name it honestly.
		 */
		endpointsCovered: number;
		endpointsTotal: number;
		/** `{ http_endpoint: 12, cli_invocation: 3 }` — how the total breaks down. */
		unitsByKind: Record<string, number>;
		symbolsCovered: number;
		symbolsTotal: number;
		issuesFound: number;
		episodesAccepted: number;
		episodesReverted: number;
		regressCases: number;
		regressRealDiffs: number;
		stateCreated: number;
		stateCleaned: number;
		/** Dead-code sections listed; 0 also when no trace exists to judge against. */
		deadSections: number;
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
	/**
	 * Every service owning at least one finding, sorted — drives the filter
	 * chips. Deliberately NOT `services` above: that is the bring-up inventory
	 * (everything Vinv started, including services with nothing wrong), while
	 * this is the subset the issue list can actually be narrowed to. A service
	 * that came up clean belongs in one and not the other.
	 */
	servicesWithFindings: string[];
	issues: FindingsIssue[];
	/**
	 * Code no capture ever executed, grouped into sections.
	 *
	 * Assembled from `.vinv/reports/deadcode.json` like every other source here —
	 * this model reads artifacts, it does not derive them. The Findings view
	 * refreshes that artifact before assembling, so the panel is never stale; a
	 * workspace that has never scanned simply has no dead-code section.
	 */
	deadCode: FindingsDeadCode;
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
		/**
		 * Which oracle drove this unit: `http_endpoint` | `cli_invocation` |
		 * `function_call`. Carried so the latency table can say what a row IS —
		 * "RUN acme-tool" under a column headed "Endpoint" reads as a mislabelled
		 * route rather than the CLI run it is.
		 */
		unitKind: string;
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

/**
 * How the exercised total breaks down by oracle.
 *
 * Prefers the scorecard's own `units_by_kind`, and falls back to counting the
 * rows — a scorecard written before that field existed still has `unit_kind`
 * per row, and one written before EITHER is all-HTTP by construction, which is
 * exactly what the `http_endpoint` default yields.
 */
function unitsByKind(declared: any, rows: any): Record<string, number> {
	if (declared && typeof declared === 'object' && Object.keys(declared).length > 0) {
		return Object.fromEntries(
			Object.entries(declared as Record<string, unknown>).map(([k, v]) => [k, Number(v ?? 0)]),
		);
	}
	const counts: Record<string, number> = {};
	for (const r of Array.isArray(rows) ? rows : []) {
		const kind = String(r?.unit_kind ?? 'http_endpoint');
		counts[kind] = (counts[kind] ?? 0) + 1;
	}
	return counts;
}

/**
 * The service that owns a unit, from whichever ids it is known by.
 *
 * HTTP endpoints resolve through the apis.json → services.json join that
 * buildServiceIndex performs. A CLI invocation never can: the exerciser mints
 * its id as `<service>#<index>` (invocations.py) and that id appears in no
 * apis.json, so every CLI row and every CLI issue counted as "unattributed"
 * and vanished the moment a service chip was clicked. The prefix IS the
 * service name — read, not guessed, and accepted only when it names a service
 * the workspace actually inventoried.
 *
 * Driven function calls stay unattributed on purpose: their id is a module
 * path (`pkg.mod:fn`), which maps to a file rather than to a service, and
 * picking an owner off a package-name resemblance is exactly the guess this
 * join refuses to make.
 */
function serviceForUnit(
	index: Map<string, string>,
	serviceNames: ReadonlySet<string>,
	keys: Array<string | undefined>,
): string | undefined {
	for (const key of keys) {
		if (key) {
			const known = index.get(key);
			if (known) {
				return known;
			}
		}
	}
	for (const key of keys) {
		const m = /^(.+)#\d+$/.exec(key ?? '');
		if (m && serviceNames.has(m[1])) {
			return m[1];
		}
	}
	return undefined;
}

function toFindingsIssue(
	c: any,
	services: Map<string, string>,
	serviceNames: ReadonlySet<string>,
): FindingsIssue {
	const ex = c.exemplar ?? null;
	const where = `${c.method ?? ''} ${c.path ?? ''}`.trim();
	const endpoint = where || String(c.endpoint_id ?? '');
	return {
		kind: String(c.kind ?? ''),
		title: String(c.title ?? ''),
		signature: String(c.signature ?? ''),
		endpoint,
		service: serviceForUnit(services, serviceNames, [endpoint, String(c.endpoint_id ?? '')]),
		count: Number(c.count ?? 1),
		dispatchable: isDispatchableKind(String(c.kind ?? '')),
		evidenceFile: evidenceFileForKind(String(c.kind ?? '')),
		exemplar: ex
			? {
					strategy: String(ex.strategy ?? ''),
					status:
						typeof ex.status === 'number'
							? ex.status
							: typeof ex.status === 'string' && ex.status
								? ex.status
								: null,
					detail: String(ex.detail ?? ''),
					expected: String(ex.expected ?? ''),
					error: String(ex.error ?? ''),
					input: renderInput(ex.input),
				}
			: null,
		coveredFrames: (c.covered_frames ?? []).map(String),
	};
}

/**
 * The dead-code block, joined from the scan artifact and the agent's verdicts.
 *
 * Both files are optional and independent: a scan with no analysis lists sections
 * with `action: null` (the panel offers the button), and an analysis whose
 * sections no longer exist contributes nothing, because a verdict is only ever
 * attached by section id — the id is derived from the member symbols, so code
 * that changed gets a new id and cannot inherit a verdict written about the old
 * version.
 */
function buildDeadCodeBlock(workspaceRoot: string): FindingsDeadCode {
	const scan = readJson(deadCodePath(workspaceRoot)) as DeadCodeReport | null;
	const analysis = readJson(analysisPath(workspaceRoot)) as DeadCodeAnalysis | null;
	if (!scan || !scan.sections) {
		return {
			hasTrace: false,
			traced: 0,
			considered: 0,
			analysed: 0,
			sections: [],
			bound: '0 dead-code section(s)',
		};
	}
	const verdicts = analysis?.verdicts ?? {};
	const runs = readRuns(workspaceRoot);
	const sections: FindingsDeadSection[] = (scan.sections.items ?? []).map((s) => {
		const v = verdicts[s.id];
		const lastRun = runsForSection(runs, {
			id: s.id,
			rows: (s.symbols?.items ?? []).map((x) => x.row),
		})[0];
		return {
			id: s.id,
			title: s.title,
			files: s.files,
			layer: s.layer,
			reason: s.reason,
			lines: s.lines,
			symbols: s.symbols?.items?.length ?? 0,
			liveCallers: s.liveCallers.length,
			action: v?.action ?? null,
			what: v?.what ?? '',
			lastRun: lastRun ? runHeadline(lastRun) : '',
			lastRunAt: lastRun?.at ?? '',
		};
	});
	return {
		hasTrace: Boolean(scan.hasTrace),
		traced: Number(scan.traced ?? 0),
		considered: Number(scan.considered ?? 0),
		analysed: sections.filter((s) => s.action).length,
		sections,
		bound: describeLineage(scan.sections.lineage ?? [], 'dead-code section'),
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
	const servicesDoc = readJson(path.join(workspaceRoot, '.vinv', 'services.json')) ?? {};
	// Both spellings, exactly as buildServiceIndex reads them: current engines
	// write `{services: [...]}`, older ones wrote a bare array, and accepting
	// only the first here left array-form workspaces with an empty Services
	// section while their endpoints still attributed fine.
	const serviceList: any[] = Array.isArray(servicesDoc)
		? servicesDoc
		: Array.isArray(servicesDoc.services)
			? servicesDoc.services
			: [];
	const services = serviceList.map(
		(s: any) => ({
			name: String(s.name ?? ''),
			kind: String(s.kind ?? ''),
			port: typeof s.port === 'number' ? s.port : null,
			command: String(s.command ?? ''),
		}),
	);
	const serviceNames = new Set<string>(services.map((s: { name: string }) => s.name).filter(Boolean));
	const issues = clusters.map((c) => toFindingsIssue(c, serviceIndex, serviceNames));
	// The scorecard row is label-only (`RUN some-command`); the unit id that
	// carries the owning service lives in the profile it was assembled from, so
	// the two are joined on the label they both spell the same way.
	const unitIdForLabel = new Map<string, string>();
	for (const p of Array.isArray(profile.endpoints) ? profile.endpoints : []) {
		const label = `${p?.method ?? ''} ${p?.path ?? ''}`.trim();
		if (label && p?.api_id) {
			unitIdForLabel.set(label, String(p.api_id));
		}
	}

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
	const deadCode = buildDeadCodeBlock(workspaceRoot);

	return {
		schemaVersion: 1,
		root: workspaceRoot,
		headline: {
			endpointsCovered: Number(after.endpoints_with_coverage ?? 0),
			endpointsTotal: Number(after.endpoints_total ?? 0),
			unitsByKind: unitsByKind(after.units_by_kind, scorecard.endpoints),
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
			deadSections: deadCode.sections.length,
		},
		services,
		issues,
		deadCode,
		servicesWithFindings: [
			...new Set(issues.map((i) => i.service).filter((s): s is string => !!s)),
		].sort(),
		episodes,
		opportunities: (profile.opportunities ?? []).map((o: any) => ({
			kind: String(o.kind ?? ''),
			endpoint: String(o.endpoint ?? ''),
			service: serviceForUnit(serviceIndex, serviceNames, [
				String(o.endpoint ?? ''),
				unitIdForLabel.get(String(o.endpoint ?? '')),
			]),
			detail: String(o.detail ?? ''),
			value: Number(o.value ?? 0),
		})),
		regress,
		endpoints: unitProfile(workspaceRoot).map((u) => ({
			...u,
			service: serviceForUnit(serviceIndex, serviceNames, [u.endpoint, u.id]),
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
