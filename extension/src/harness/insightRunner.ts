/**
 * Auto-insight stage — closes "call trees and flamegraphs are not built
 * end-to-end" and "identification of issues is not automatic".
 *
 * Whenever a traced run lands new spans in .vinv/captures (the same contract
 * the Sessions view polls), a debounced pass runs the identification engine
 * end-to-end with ZERO clicks:
 *
 *   consolidate (via tracesummary + the captures' own handler spans) → per
 *   observed entry point, of any kind: tracemap (static
 *   call tree + runtime overlay) written to .vinv/reports/calltree-<id>.json,
 *   and the smoke/flamegraph HTML report built headlessly into
 *   .vinv/reports/smoke-<id>.html — nothing is opened, everything is on disk
 *   and recorded in the manifest .vinv/reports/index.json.
 *
 * After each pass the issue picture is recomputed (failing symbols from the
 * runtime overlay + per-endpoint error clusters + probe failures) and
 * published as a typed IssueList on pipelineState; with autoEpisodes on, NEW
 * issues (content-signature dedup, the same family as the failure-signature
 * dedup everywhere else) are dispatched as fix episodes through the exact
 * autoTrigger path — respecting the harness busy-lock and episode budgets.
 *
 * The pass is serialized (one at a time, a re-trigger mid-run queues exactly
 * one follow-up), crash-proof (every engine call is caught; a failed endpoint
 * degrades to nulls in the manifest), and skipped cleanly when the engines
 * are missing.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
	clearTimeout as cancelTimer,
	setTimeout as scheduleTimer,
} from 'timers';
import { isBinAvailable } from '../tracelens/bin';
import { generateSmokeReport } from '../tracelens/report';
import {
	entryPointLabel,
	getTraceMap,
	getTraceSummary,
	hasCaptures,
	readEntryPoints,
	symbolRootFor,
	type CallNode,
	type EntryPoint,
	type TraceCount,
	type TraceMapResult,
} from '../identification/identification';
import { entryPointHits } from '../identification/entryPointHits';
import {
	indexStoreDir,
	loadNodes,
	loadRuntimeOverlay,
	loadStoreEpoch,
} from '../graph/indexGraph';
import { collectRuntimeErrorClusters, type ErrorCluster } from './runtimeAnalysis';
import {
	getProbeState,
	markIssuesDispatched,
	publishInsightState,
	publishIssueList,
	type EndpointInsight,
	type InsightManifest,
	type Issue,
	type ProbeOutcome,
} from './pipelineState';
import { dispatchIssueEpisode, RUNTIME_ERROR_SIG_KEY } from './autoTrigger';
import { isAutoEpisodesEnabled } from '../config/settings';

/** The insight manifest path: <workspace>/.vinv/reports/index.json */
export function insightManifestPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'index.json');
}

/** Reads the persisted manifest, or null when absent/unreadable. */
export function readInsightManifest(workspaceRoot: string): InsightManifest | null {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(insightManifestPath(workspaceRoot), 'utf8'),
		) as InsightManifest;
		return parsed && parsed.version === 1 && Array.isArray(parsed.endpoints) ? parsed : null;
	} catch {
		return null;
	}
}

function writeInsightManifest(workspaceRoot: string, manifest: InsightManifest): void {
	const target = insightManifestPath(workspaceRoot);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, '\t')}\n`, 'utf8');
	fs.renameSync(tmp, target);
}

import { captureServiceFor } from '../bringup/bringup';

/** Filename-safe id, mirroring the smoke report's own sanitization. */
function safeId(apiId: string): string {
	return apiId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Where an endpoint's call-tree snapshot lives. */
export function callTreeReportPath(workspaceRoot: string, apiId: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', `calltree-${safeId(apiId)}.json`);
}

/**
 * Recovers the api id from a `calltree-<id>.json` path.
 *
 * Lossy in principle — `safeId` collapses characters — but every id the
 * consolidator emits is already filename-safe, so the round trip is exact for
 * anything that produced one of these files.
 */
export function apiIdFromCallTreePath(file: string): string | null {
	const m = /^calltree-(.+)\.json$/.exec(path.basename(file));
	return m ? m[1] : null;
}

/**
 * Builds ONE endpoint's call tree + runtime overlay and writes its snapshot.
 *
 * Split out of the insight pass so a missing report can be produced on demand:
 * the Flow rail lists reports from the insight manifest, and a snapshot that
 * was never written (or has since been deleted) used to answer a click with
 * "file not found" — an error about our own bookkeeping, presented to the user
 * as if they had done something wrong. Rebuilding is the same work the pass
 * would do, for one endpoint.
 */
export async function buildCallTreeReport(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	apiId: string,
	/** Capture to overlay from; see captureServiceFor. */
	service?: string,
): Promise<string> {
	const map = await getTraceMap(context, workspaceRoot, apiId, service);
	const file = callTreeReportPath(workspaceRoot, apiId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(map, null, '\t')}\n`, 'utf8');
	return file;
}

/** One unit the capture proves ran, whatever kind of starting point it is. */
export interface ObservedUnit {
	id: string;
	/** Human-facing label: "GET /health", a command name, `python path/to/f.py`. */
	trigger: string;
	handler: string | null;
	file: string;
	traceCount: number;
}

/**
 * Every unit a capture actually exercised — HTTP endpoints AND the rest.
 *
 * The pass used to be `tracesummary.endpoints` and nothing else, and
 * `tracesummary` answers only for HTTP: it counts requests whose root span is
 * `"<METHOD> <path>"` against the consolidated `apis` view. CLI commands,
 * workers, scheduled jobs, stdio servers and `__main__` scripts have no root
 * span of that shape, so no matter how often they ran they were never built a
 * call tree, never given a smoke report, and never appeared in the manifest the
 * Flow rail and Findings read — the runtime overlay existed for one fifth of
 * the inventory.
 *
 * The join for those is `entryPointHits`, which counts an entry point's own
 * handler spans directly out of the captures — the same numbers the Traces
 * panel already shows in its Hits column, so the two surfaces cannot disagree.
 * The engine's own counts WIN wherever both have an answer: for a route,
 * distinct requests is the better unit and every other HTTP surface quotes it.
 */
export function observedUnits(
	endpoints: TraceCount[],
	entries: EntryPoint[],
	hits: Map<string, number>,
): ObservedUnit[] {
	const units: ObservedUnit[] = [];
	const seen = new Set<string>();
	for (const e of endpoints) {
		if (e.trace_count > 0) {
			units.push({
				id: e.id,
				trigger: `${e.method} ${e.path}`,
				handler: e.handler,
				file: e.file,
				traceCount: e.trace_count,
			});
			seen.add(e.id);
		}
	}
	for (const entry of entries) {
		const n = hits.get(entry.id) ?? 0;
		if (n > 0 && !seen.has(entry.id)) {
			units.push({
				id: entry.id,
				trigger: entryPointLabel(entry),
				handler: entry.handler,
				file: entry.file,
				traceCount: n,
			});
			seen.add(entry.id);
		}
	}
	return units;
}

/** Content signature for issue dedup — same family as failureSignature. */
export function issueSignature(kind: string, content: string): string {
	const normalized = `${kind} ${content
		.replace(/\d+/g, '#')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
		.slice(0, 600)}`;
	return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

/** Walks a tracemap tree collecting symbol names, error counts and types. */
export function summarizeTree(root: CallNode | undefined): {
	symbols: string[];
	errorCount: number;
	errorTypes: string[];
} {
	const symbols = new Set<string>();
	const errorTypes = new Set<string>();
	let errorCount = 0;
	const walk = (node: CallNode | undefined): void => {
		if (!node) {
			return;
		}
		if (node.name) {
			symbols.add(node.name);
		}
		if (node.runtime) {
			errorCount += node.runtime.error ?? 0;
			for (const t of node.runtime.errors ?? []) {
				errorTypes.add(t);
			}
		}
		for (const child of node.children ?? []) {
			walk(child);
		}
	};
	walk(root);
	return { symbols: [...symbols], errorCount, errorTypes: [...errorTypes] };
}

/**
 * Composes the typed issue list from the three evidence sources. Pure — unit
 * tested without vscode. Dispatched flags are carried over from `previous` by
 * signature so a re-computation never "un-dispatches" an issue.
 */
export function composeIssues(
	clusters: ErrorCluster[],
	endpoints: EndpointInsight[],
	endpointErrorTypes: Map<string, string[]>,
	probeFailures: ProbeOutcome[],
	previousDispatched: ReadonlySet<string>,
): Issue[] {
	const issues: Issue[] = [];
	for (const c of clusters) {
		const id = issueSignature('runtime-error', c.line);
		issues.push({
			id,
			kind: 'runtime-error',
			title: c.line.length > 110 ? `${c.line.slice(0, 107)}…` : c.line,
			detail: `The captured runtime trace shows this function raising errors:\n- ${c.line}`,
			rows: [c.row],
			row: c.row,
			dispatched: previousDispatched.has(id),
		});
	}
	for (const e of endpoints) {
		if (e.errorCount <= 0) {
			continue;
		}
		const types = endpointErrorTypes.get(e.id) ?? [];
		const id = issueSignature('endpoint-errors', `${e.trigger}:${[...types].sort().join('|')}`);
		issues.push({
			id,
			kind: 'endpoint-errors',
			title: `${e.trigger} — ${e.errorCount} error(s) under its call tree`,
			detail:
				`Endpoint ${e.trigger} (handler ${e.handler ?? 'unknown'}) shows ${e.errorCount} ` +
				`runtime error(s) in its traced call tree` +
				(types.length ? ` (${types.join(', ')})` : '') +
				`. Smoke report: ${e.reportPath ?? '(not built)'}`,
			endpointId: e.id,
			dispatched: previousDispatched.has(id),
		});
	}
	for (const p of probeFailures) {
		if (p.verdict !== 'fail') {
			continue;
		}
		const id = issueSignature('probe-failure', `${p.method} ${p.path}:${p.detail ?? ''}`);
		issues.push({
			id,
			kind: 'probe-failure',
			title: `Probe failed: ${p.method} ${p.path}${p.httpStatus ? ` → ${p.httpStatus}` : ''}`,
			detail:
				`Replaying a captured request against the live service failed.\n` +
				`Probe: ${p.method} ${p.path}\n` +
				`Observed: ${p.httpStatus !== undefined ? `HTTP ${p.httpStatus}` : 'no response'}` +
				(p.detail ? ` — ${p.detail}` : ''),
			endpointId: p.endpointId,
			dispatched: previousDispatched.has(id),
		});
	}
	return issues;
}

// ---- serialized runner ------------------------------------------------------

let insightRunning = false;
let insightQueued = false;

/** True while an insight pass is in flight. */
export function isInsightRunning(): boolean {
	return insightRunning;
}

/** How one insight pass settled — Auto-Pilot's stage outcome. */
export interface InsightPassResult {
	outcome: 'done' | 'failed' | 'skipped';
	/** Endpoints with built artifacts. */
	endpoints: number;
	/** Issues identified after the pass. */
	issues: number;
	error?: string;
}

const DISPATCHED_ISSUES_KEY = 'vinv.dispatchedIssueSignatures';

function readDispatchedSignatures(context: vscode.ExtensionContext): Set<string> {
	return new Set(context.workspaceState.get<string[]>(DISPATCHED_ISSUES_KEY) ?? []);
}

async function recordDispatchedSignatures(
	context: vscode.ExtensionContext,
	ids: Iterable<string>,
): Promise<void> {
	const merged = readDispatchedSignatures(context);
	for (const id of ids) {
		merged.add(id);
	}
	// Bounded: keep the most recent 500 signatures (insertion order suffices).
	await context.workspaceState.update(DISPATCHED_ISSUES_KEY, [...merged].slice(-500));
}

/**
 * Runs one full insight pass. Serialized: a call while a pass is running
 * queues exactly one follow-up pass (traces stream continuously — running
 * once with the newest data is enough). Never throws.
 */
export async function runInsightPass(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<InsightPassResult> {
	if (insightRunning) {
		insightQueued = true;
		return { outcome: 'skipped', endpoints: 0, issues: 0, error: 'a pass is already running' };
	}
	insightRunning = true;
	try {
		return await insightPassOnce(context, workspaceRoot);
	} finally {
		insightRunning = false;
		if (insightQueued) {
			insightQueued = false;
			// Detached follow-up: the newest spans get their own pass.
			setTimeout(() => void runInsightPass(context, workspaceRoot), 1_000);
		}
	}
}

async function insightPassOnce(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<InsightPassResult> {
	const skip = (why: string): InsightPassResult => {
		publishInsightState({
			phase: 'skipped',
			label: why,
			manifest: readInsightManifest(workspaceRoot),
		});
		return { outcome: 'skipped', endpoints: 0, issues: 0, error: why };
	};
	try {
		if (!isBinAvailable(context, 'identification')) {
			return skip('identification engine not installed');
		}
		if (!hasCaptures(workspaceRoot)) {
			return skip('no captured traces yet');
		}
		publishInsightState({
			phase: 'running',
			label: 'summarizing traced entry points…',
			manifest: readInsightManifest(workspaceRoot),
		});

		const summary = await getTraceSummary(context, workspaceRoot);
		const entries = readEntryPoints(workspaceRoot);
		const observed = observedUnits(
			summary.endpoints ?? [],
			entries,
			entryPointHits(workspaceRoot, entries),
		);
		const reportsDir = path.join(workspaceRoot, '.vinv', 'reports');
		fs.mkdirSync(reportsDir, { recursive: true });

		const endpoints: EndpointInsight[] = [];
		const endpointErrorTypes = new Map<string, string[]>();
		let built = 0;
		for (const ep of observed) {
			built += 1;
			const trigger = ep.trigger;
			publishInsightState({
				phase: 'running',
				label: `building call tree + report for ${trigger} (${built}/${observed.length})…`,
				manifest: readInsightManifest(workspaceRoot),
			});

			// 1. Call tree with the runtime overlay (tracemap = calltree ∪ trace).
			let map: TraceMapResult | null = null;
			let calltreePath: string | null = null;
			try {
				map = await getTraceMap(
					context,
					workspaceRoot,
					ep.id,
					captureServiceFor(workspaceRoot, ep.file),
					symbolRootFor(workspaceRoot, ep.id),
				);
				calltreePath = callTreeReportPath(workspaceRoot, ep.id);
				fs.mkdirSync(path.dirname(calltreePath), { recursive: true });
				fs.writeFileSync(calltreePath, `${JSON.stringify(map, null, '\t')}\n`, 'utf8');
			} catch {
				calltreePath = null;
			}
			const tree = summarizeTree(map?.tree);
			// Runtime-only components (ran under the handler but outside the static
			// tree) still carry errors — count them so the issue picture is honest.
			for (const r of map?.runtime_only ?? []) {
				tree.errorCount += r.errors.length > 0 ? r.calls : 0;
				for (const t of r.errors) {
					if (!tree.errorTypes.includes(t)) {
						tree.errorTypes.push(t);
					}
				}
			}
			endpointErrorTypes.set(ep.id, tree.errorTypes);

			// 2. The smoke/flamegraph report, headless — generated to disk, never
			//    opened. A failure only degrades this endpoint's manifest entry.
			let reportPath: string | null = null;
			try {
				reportPath = (await generateSmokeReport(context, workspaceRoot, ep.id)).path;
			} catch {
				reportPath = null;
			}

			endpoints.push({
				id: ep.id,
				trigger,
				handler: ep.handler,
				calltreePath,
				reportPath,
				traceCount: ep.traceCount,
				errorCount: tree.errorCount,
				symbols: tree.symbols,
				lastBuilt: new Date().toISOString(),
			});
		}

		let epoch: number | null = null;
		try {
			epoch = loadStoreEpoch(indexStoreDir(workspaceRoot));
		} catch {
			epoch = null;
		}
		const manifest: InsightManifest = {
			version: 1,
			builtAt: new Date().toISOString(),
			epoch,
			endpoints,
		};
		writeInsightManifest(workspaceRoot, manifest);
		publishInsightState({
			phase: 'done',
			label: `${endpoints.length} endpoint(s) analyzed`,
			manifest,
		});

		const issues = await recomputeIssues(context, workspaceRoot, manifest, endpointErrorTypes);
		return { outcome: 'done', endpoints: endpoints.length, issues: issues.length };
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		publishInsightState({
			phase: 'failed',
			label: 'insight pass failed',
			manifest: readInsightManifest(workspaceRoot),
			error,
		});
		return { outcome: 'failed', endpoints: 0, issues: 0, error };
	}
}

/**
 * Recomputes and publishes the issue list from all current evidence, then —
 * with autoEpisodes on — feeds NEW issues into the auto-episode dispatch
 * (signature-deduped so the same failure picture never re-dispatches).
 */
export async function recomputeIssues(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	manifest: InsightManifest | null,
	endpointErrorTypes: Map<string, string[]> = new Map(),
): Promise<Issue[]> {
	let clusters: ErrorCluster[] = [];
	let clusterSignature = '';
	try {
		const nodes = loadNodes(indexStoreDir(workspaceRoot));
		({ clusters, signature: clusterSignature } = collectRuntimeErrorClusters(
			nodes,
			loadRuntimeOverlay(workspaceRoot, nodes),
		));
	} catch {
		clusters = []; // no index yet — endpoint/probe evidence still counts
	}
	const probeFailures = Object.values(getProbeState().results).flatMap((r) =>
		r.probes.filter((p) => p.verdict === 'fail'),
	);
	const dispatched = readDispatchedSignatures(context);
	const issues = composeIssues(
		clusters,
		manifest?.endpoints ?? [],
		endpointErrorTypes,
		probeFailures,
		dispatched,
	);
	// Shared-dedup with the red-ring trigger (same captures, same clusters):
	// if IT already dispatched this exact runtime-error picture, those issues
	// are not "new" here either.
	const pictureDispatched =
		clusterSignature.length > 0 &&
		context.workspaceState.get<string>(RUNTIME_ERROR_SIG_KEY) === clusterSignature;
	const effective = pictureDispatched
		? issues.map((i) => (i.kind === 'runtime-error' ? { ...i, dispatched: true } : i))
		: issues;
	publishIssueList({ updatedAt: new Date().toISOString(), issues: effective });

	// Auto-dispatch: only genuinely new signatures, one grouped episode per
	// pass (episodes are the scarce resource; the pack carries all evidence).
	const fresh = effective.filter((i) => !i.dispatched);
	if (fresh.length > 0 && isAutoEpisodesEnabled()) {
		const handedOff = await dispatchIssueEpisode(context, workspaceRoot, fresh);
		if (handedOff) {
			const ids = new Set(fresh.map((i) => i.id));
			await recordDispatchedSignatures(context, ids);
			markIssuesDispatched(ids);
			// And silence the red-ring trigger for the picture we just handled.
			if (clusterSignature && fresh.some((i) => i.kind === 'runtime-error')) {
				await context.workspaceState.update(RUNTIME_ERROR_SIG_KEY, clusterSignature);
			}
		}
	}
	return effective;
}

// ---- capture watcher --------------------------------------------------------

const INSIGHT_DEBOUNCE_MS = 15_000;

/**
 * Wires the auto-insight trigger: new spans under .vinv/captures (the same
 * watcher contract the runtime-error trigger and the Sessions view use)
 * schedule a debounced insight pass. Also runs one activation pass when
 * captures already exist, so a reloaded window has fresh artifacts without a
 * new traced run.
 */
export function registerInsightRunner(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const root = folder.uri.fsPath;
	// Surface any persisted manifest immediately so views have data on reload.
	const existing = readInsightManifest(root);
	if (existing) {
		publishInsightState({ phase: 'done', label: 'loaded from disk', manifest: existing });
	}
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(root, '.vinv/captures/**/trace.jsonl'),
	);
	let timer: ReturnType<typeof scheduleTimer> | undefined;
	const schedule = (): void => {
		if (timer) {
			cancelTimer(timer);
		}
		timer = scheduleTimer(() => void runInsightPass(context, root), INSIGHT_DEBOUNCE_MS);
	};
	watcher.onDidChange(schedule);
	watcher.onDidCreate(schedule);
	context.subscriptions.push(watcher, {
		dispose: () => {
			if (timer) {
				cancelTimer(timer);
			}
		},
	});
	if (hasCaptures(root)) {
		schedule();
	}
}
