/**
 * Behavioral-exercise stage — closes "vinv only profiles the traffic it happens
 * to see". After probes, the exerciser engine PLANS, EXECUTES, PROFILES and
 * LEARNS INVARIANTS for EVERY discovered endpoint of EVERY running service:
 *
 *   for each service:  plan --base-url … → run … → campaign … → regress …
 *                      → profile --service …
 *   once, merged:      scorecard …
 *
 * The engine is single-service by construction — `run` rewrites issues.json
 * wholesale and `profile` joins coverage against one capture directory — so the
 * loop is not just iteration: each service's artifacts are read back before the
 * next service overwrites them and folded together by `mergeIssueDocuments` /
 * `mergeProfiles`. Without that, a workspace of N services would publish a
 * confident scorecard describing only the one that ran last.
 *
 * It supersedes the INPUT side of the trace-derived probes (probeRunner): where
 * probeRunner replays only what the trace already saw, the exerciser generates
 * valid/boundary/negative/observed/semantic inputs, drives them coverage-guided,
 * and feeds the SAME golden-baseline mechanism (a sibling
 * .vinv/exercise/baselines/* store with identical degraded/same/improved
 * semantics) plus the SAME issue→episode dispatch (behavioral failure clusters
 * become fix episodes via autoTrigger's dispatchIssueEpisode).
 *
 * Serialized and crash-proof like insightRunner; skipped cleanly when the engine
 * or a running service is absent. Pure parsing helpers are exported for the
 * pipeline-wiring unit tests (which never spawn a process).
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getBinPath, isBinAvailable } from '../tracelens/bin';
import { hiddenBackgroundOptions, killProcessTree } from '../proc';
import { getHandbookEnv } from '../config/settings';
import { readServices, readStartCommands, serviceSlug } from '../bringup/bringup';
import { isServiceRunning, runningServiceNames } from '../bringup/serviceRunner';
import {
	getExerciseState,
	publishExerciseState,
	type ExerciseState,
} from './pipelineState';
import { dispatchIssueEpisode } from './autoTrigger';
import { evidenceFileForKind, isAssertShapedKind, isDispatchableKind } from './issueKinds';
import { drainAgentChannels, type DrainReport } from './agentChannel';
import { runHarnessPrompt } from './harnessRunner';
import { getHarnessId } from '../config/settings';
import { openConfigRequestPanel, writeAnswers } from '../views/configRequestPanel';
import { isAutoEpisodesEnabled } from '../config/settings';

/** .vinv/exercise/<file> */
function exerciseFile(workspaceRoot: string, name: string): string {
	return path.join(workspaceRoot, '.vinv', 'exercise', name);
}

/** Reads a JSON artifact under .vinv/exercise, or null. */
export function readExerciseJson<T>(workspaceRoot: string, name: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(exerciseFile(workspaceRoot, name), 'utf8')) as T;
	} catch {
		return null;
	}
}

/**
 * Writes a JSON artifact under .vinv/exercise, atomically.
 *
 * The pass only ever writes an artifact it has just MERGED across services, and
 * a torn merge is worse than no merge: the next step reads it back and would
 * report whatever survived as the whole truth. tmp + rename, like every other
 * artifact writer here.
 */
function writeExerciseJson(workspaceRoot: string, name: string, doc: unknown): void {
	const file = exerciseFile(workspaceRoot, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
}

/**
 * The on-disk scorecard reduced to what the compass and the Flow rail need.
 *
 * `ingestedBy` is the load-bearing field. `vinv_ingest_run` (exerciseIngest)
 * writes the SAME artifact from an EXTERNAL harness run — it fills the Journey
 * and Findings views, but it is not a vinv exercise pass and it stamps itself
 * as such precisely so the two stay distinguishable.
 */
export interface ScorecardSummary {
	/** The service the run covered, or the external harness that produced it. */
	source: string;
	/** Set only when the artifact came from vinv_ingest_run, not the exerciser. */
	ingestedBy?: string;
	endpointsCovered: number;
	total: number;
	invariants: number;
	issues: number;
}

/** Reads .vinv/exercise/scorecard.json into the shape both surfaces render. */
export function readScorecardSummary(workspaceRoot: string): ScorecardSummary | null {
	const sc = readExerciseJson<Record<string, any>>(workspaceRoot, 'scorecard.json');
	if (!sc) {
		return null;
	}
	const after = (sc.coverage?.after_exercised ?? {}) as Record<string, number>;
	const endpoints: Array<Record<string, unknown>> = Array.isArray(sc.endpoints) ? sc.endpoints : [];
	return {
		source: String(sc.service ?? sc.source ?? 'unknown'),
		ingestedBy: sc.ingested_by ? String(sc.ingested_by) : undefined,
		endpointsCovered: Number(after.endpoints_with_coverage ?? 0),
		total: Number(after.endpoints_total ?? endpoints.length),
		// The exerciser totals invariants itself; an imported run has only the
		// per-endpoint counts, so sum them rather than reporting zero.
		invariants: Number(
			sc.invariants_learned ?? endpoints.reduce((n, e) => n + Number(e.invariants ?? 0), 0),
		),
		issues: Number(sc.issue_clusters ?? (Array.isArray(sc.issues) ? sc.issues.length : 0)),
	};
}

/**
 * True when vinv's OWN exerciser has completed a pass over this workspace.
 *
 * Deliberately NOT `fs.existsSync(scorecard.json)`: that treats an imported
 * external run as the stage being done, which silently dropped "Exercise the
 * services" out of the compass ladder in any workspace where the coding harness
 * had ingested a run first.
 */
export function hasExercisePass(workspaceRoot: string): boolean {
	const sc = readScorecardSummary(workspaceRoot);
	return !!sc && !sc.ingestedBy;
}

/** The exercise profile shape the runner + views read (subset). */
export interface ExerciseProfile {
	endpoint_count: number;
	endpoints_with_coverage: number;
	total_symbols_covered: number;
	total_symbols: number;
	invariants_learned: number;
	endpoints: Array<{
		api_id: string;
		method: string;
		path: string;
		coverage: { covered: number; total: number; pct: number; handler_observed: boolean };
	}>;
}

/** The issues.json cluster shape. */
export interface ExerciseIssuesDoc {
	cluster_count: number;
	clusters: Array<{
		signature: string;
		kind: string;
		title: string;
		endpoint_id: string;
		method: string;
		path: string;
	}>;
}

// =========================================================================
// Merging one workspace's artifacts across services
//
// The engine is single-service by construction: `run` rewrites issues.json
// WHOLESALE from the executions of the run that produced it, and `profile`
// joins coverage against ONE service's capture directory. Both are correct for
// one service and lossy for N — so the pass reads each service's document back
// before the next one overwrites it, and these fold the results into the single
// set of artifacts every downstream surface reads.
//
// Pure, and exported for that reason: a merge that silently drops a service's
// findings looks exactly like a clean pass, which is the failure this whole
// change exists to prevent.
// =========================================================================

/**
 * A finding cluster exactly as it lives on disk.
 *
 * The merge must carry the WHOLE object rather than `ExerciseIssuesDoc`'s typed
 * subset: the Findings view renders `exemplar`, `count` and `covered_frames`,
 * and rebuilding clusters from the declared fields would quietly strip the
 * evidence that makes a finding actionable.
 */
export type RawCluster = Record<string, unknown>;

/** Mirrors campaign._cluster_signature, including its fallback. */
function clusterSignature(c: RawCluster): string {
	const sig = c.signature;
	if (typeof sig === 'string' && sig) {
		return sig;
	}
	// A cluster the engine could not sign still has an identity; two of them
	// must not collapse into one just because both are missing a signature.
	return ['kind', 'endpoint_id', 'title'].map((k) => String(c[k] ?? '')).join('|');
}

/**
 * Folds every service's issues.json into one document.
 *
 * First-wins by signature and ordered by (kind, path) — the same rule and the
 * same ordering `campaign._merge_into_issues` applies when it publishes the
 * non-HTTP oracles into this file. Matching it matters: campaign runs after
 * this write and merges on top, so if the two disagreed about what a duplicate
 * is, a cluster would appear twice or the file's shape would flip between
 * passes.
 */
export function mergeIssueDocuments(
	docs: ReadonlyArray<{ clusters?: unknown } | null>,
): { version: 1; cluster_count: number; clusters: RawCluster[] } {
	const bySignature = new Map<string, RawCluster>();
	for (const doc of docs) {
		const clusters = doc?.clusters;
		if (!Array.isArray(clusters)) {
			continue;
		}
		for (const c of clusters) {
			if (!c || typeof c !== 'object') {
				continue;
			}
			const cluster = c as RawCluster;
			const sig = clusterSignature(cluster);
			if (!bySignature.has(sig)) {
				bySignature.set(sig, cluster);
			}
		}
	}
	const ordered = [...bySignature.values()].sort((a, b) =>
		`${String(a.kind ?? '')} ${String(a.path ?? '')}`.localeCompare(
			`${String(b.kind ?? '')} ${String(b.path ?? '')}`,
		),
	);
	return { version: 1, cluster_count: ordered.length, clusters: ordered };
}

/** A profile document as it lives on disk. */
export type RawProfile = Record<string, unknown>;

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function endpointCoverage(e: RawProfile): number {
	const cov = e.coverage;
	return cov && typeof cov === 'object' ? num((cov as RawProfile).covered) : 0;
}

/**
 * Folds every service's profile.json into one document.
 *
 * Only `coverage` differs between the per-service runs: `build_profile` reads
 * the SAME accumulated results.jsonl every time, so an endpoint's latency,
 * status distribution and learned invariants are identical whichever service
 * label the run carried — but its coverage is joined against that service's
 * capture directory, and an endpoint joined against a capture that never saw it
 * scores zero. So per endpoint the entry with the MOST covered symbols wins:
 * coverage can only ever come from a real trace join, so taking the best is
 * "the strongest evidence any capture gave us" and can never invent any.
 *
 * The totals are then RECOMPUTED from the merged endpoints rather than summed
 * across documents — summing would count the shared endpoints once per service.
 *
 * A single document is returned untouched. That is not an optimization: it
 * keeps a one-service workspace reading the exact bytes the engine wrote.
 */
export function mergeProfiles(profiles: ReadonlyArray<RawProfile | null>): RawProfile | null {
	const docs = profiles.filter((p): p is RawProfile => !!p && typeof p === 'object');
	if (docs.length === 0) {
		return null;
	}
	if (docs.length === 1) {
		return docs[0];
	}
	const best = new Map<string, RawProfile>();
	for (const doc of docs) {
		const endpoints = Array.isArray(doc.endpoints) ? (doc.endpoints as RawProfile[]) : [];
		for (const e of endpoints) {
			if (!e || typeof e !== 'object') {
				continue;
			}
			const id = String(e.api_id ?? `${String(e.method ?? '')} ${String(e.path ?? '')}`);
			const incumbent = best.get(id);
			if (!incumbent || endpointCoverage(e) > endpointCoverage(incumbent)) {
				best.set(id, e);
			}
		}
	}
	const endpoints = [...best.values()];
	// Opportunities are derived from latency, which is service-independent, so
	// every document proposes the same ones — union-dedupe rather than
	// concatenate, or a two-service pass would show each one twice.
	const opportunities: RawProfile[] = [];
	const seenOpportunity = new Set<string>();
	for (const doc of docs) {
		for (const o of Array.isArray(doc.opportunities) ? (doc.opportunities as RawProfile[]) : []) {
			if (!o || typeof o !== 'object') {
				continue;
			}
			const key = `${String(o.kind ?? '')} ${String(o.endpoint ?? '')}`;
			if (!seenOpportunity.has(key)) {
				seenOpportunity.add(key);
				opportunities.push(o);
			}
		}
	}
	return {
		...docs[0],
		endpoint_count: endpoints.length,
		endpoints_with_coverage: endpoints.filter((e) => endpointCoverage(e) > 0).length,
		total_symbols_covered: endpoints.reduce((n, e) => n + endpointCoverage(e), 0),
		total_symbols: endpoints.reduce(
			(n, e) =>
				n + (e.coverage && typeof e.coverage === 'object' ? num((e.coverage as RawProfile).total) : 0),
			0,
		),
		invariants_learned: endpoints.reduce(
			(n, e) => n + (Array.isArray(e.invariants) ? e.invariants.length : 0),
			0,
		),
		endpoints,
		opportunities,
	};
}

/**
 * Derives the published ExerciseState from the on-disk artifacts. Pure — unit
 * tested without spawning the engine.
 */
export function exerciseStateFromArtifacts(
	profile: ExerciseProfile | null,
	issues: ExerciseIssuesDoc | null,
	phase: ExerciseState['phase'],
	label: string,
): ExerciseState {
	return {
		phase,
		label,
		endpointsCovered: profile?.endpoints_with_coverage ?? 0,
		total: profile?.endpoint_count ?? 0,
		invariants: profile?.invariants_learned ?? 0,
		issues: issues?.cluster_count ?? 0,
	};
}

// Cluster-kind semantics moved to a pure module so the Findings surface — which
// must stay vscode-free — can classify a cluster the same way the dispatch path
// does. Re-exported here because this is where callers and tests already look.
export { isAssertShapedKind, isDispatchableKind, evidenceFileForKind } from './issueKinds';

/** Success criteria for an assert-shaped (silent wrong-value) dispatch. */
export const ASSERT_SUCCESS_CRITERIA: readonly string[] = [
	'Replaying the failing input yields output that satisfies the learned invariants ' +
		'and matches the golden baseline (status class, shape, and stable values)',
	'The fix changes the wrong VALUE/behavior — it does not delete or weaken the ' +
		'invariant/baseline that caught it',
	'No new errors or invariant violations are introduced elsewhere',
];

/**
 * Maps behavioral failure clusters into the shape dispatchIssueEpisode consumes
 * (title + detail + seed rows). Pure. Only NEW clusters (not previously
 * dispatched) should be passed by the caller.
 */
export function issueEpisodesFromClusters(
	clusters: ExerciseIssuesDoc['clusters'],
): Array<{ title: string; detail: string; rows?: number[] }> {
	return clusters.filter((c) => isDispatchableKind(c.kind)).map((c) => {
		// `method` is the ORACLE for a non-HTTP cluster (CALL/DIFF/FAULT/CONC/ENV)
		// and `path` is its target, so "drove CALL pkg.mod:fn" reads correctly for
		// both families without a second template.
		const where = `${c.method} ${c.path}`;
		const evidence = evidenceFileForKind(c.kind);
		return {
			title: `Behavior: ${c.title}`,
			detail: isAssertShapedKind(c.kind)
				? `The behavioral exerciser drove ${where}: the code answered ` +
					`without raising, but its output violated a learned assertion (${c.kind}).\n` +
					`Failure signature: ${c.signature}\n` +
					`See .vinv/exercise/issues.json (cluster ${c.signature}), ${evidence} for the ` +
					`failing case, invariants.json for the learned assertion, and baselines/ for ` +
					`the golden entry it regressed against.`
				: `The behavioral exerciser drove ${where} and hit a ${c.kind}.\n` +
					`Failure signature: ${c.signature}\n` +
					`See .vinv/exercise/issues.json (cluster ${c.signature}) and ${evidence} for the ` +
					`failing input, expected-vs-got, and covered frames.`,
		};
	});
}

/** A service the pass can drive: a name and the port it answers on. */
export interface ExerciseTarget {
	service: string;
	port: number;
}

/**
 * EVERY service to exercise: live sessions with a known port, in preference
 * order.
 *
 * Deliberately not "the first one". Vinv exercises a WORKSPACE, and this
 * returned a single target, so a repo running an API, a worker and an admin
 * backend had two of the three silently unexercised — the scorecard reported a
 * confident, clean pass over whichever one happened to sort first. The order is
 * unchanged (running services first, otherwise anything with a verified start
 * command), so a single-service workspace still picks exactly what it picked
 * before.
 */
function pickTargets(workspaceRoot: string): ExerciseTarget[] {
	// Read the inventory ONCE. This used to re-read and re-parse services.json on
	// every iteration of the loop below, so a workspace with N services cost N+1
	// reads of the same file to answer one question.
	const services = readServices(workspaceRoot);
	const running = runningServiceNames();
	const candidates = running.length
		? running
		: services
				.map((s) => s.name)
				.filter((name) => readStartCommands(workspaceRoot, name).length > 0);
	const targets: ExerciseTarget[] = [];
	const seen = new Set<string>();
	for (const service of candidates) {
		if (seen.has(service)) {
			continue;
		}
		const entry = services.find((s) => s.name === service);
		if (typeof entry?.port === 'number' && entry.port > 0) {
			seen.add(service);
			targets.push({ service, port: entry.port });
		}
	}
	return targets;
}

/** How one exercise pass settled — Auto-Pilot's stage outcome. */
export interface ExercisePassResult {
	outcome: 'done' | 'failed' | 'skipped';
	endpointsCovered: number;
	total: number;
	invariants: number;
	issues: number;
	error?: string;
}

let exerciseRunning = false;

/** True while an exercise pass is in flight. */
export function isExerciseRunning(): boolean {
	return exerciseRunning;
}

/**
 * Plays the campaign may spend per pass (VINV_CAMPAIGN_BUDGET, default 12).
 *
 * Kept well under the engine's own default of 20 because each play can fork a
 * worker that imports and calls target code: the step timeout has to cover the
 * whole campaign, and an unbounded one would simply be SIGKILLed halfway with
 * its posteriors half-updated.
 */
function campaignBudget(): number {
	const raw = Number.parseInt(process.env.VINV_CAMPAIGN_BUDGET ?? '', 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 12;
}

/**
 * Per-engine-step timeout (VINV_EXERCISE_TIMEOUT_S, default 10 hours).
 *
 * Was 180s, which killed real passes rather than hung ones. The exerciser
 * drives every discovered endpoint, learns invariants, and runs the function /
 * differential / fault / concurrency oracles — on a repo with a few dozen
 * endpoints and a model in the loop that is minutes of legitimate work per
 * step, and the pass died mid-flight with "exerciser timed out after 180s"
 * and no partial results. A timeout is a deadlock backstop here, not a budget:
 * it exists so a wedged child cannot hold the pipeline forever, and the honest
 * value for that is hours, not minutes.
 */
function stepTimeoutMs(): number {
	const raw = Number.parseFloat(process.env.VINV_EXERCISE_TIMEOUT_S ?? '');
	return (Number.isFinite(raw) && raw > 0 ? raw : 36_000) * 1000;
}

/**
 * The engine child of the in-flight step, so `deactivate()` can tear down a pass
 * that outlives the window. Only one step runs at a time (runExercisePass is
 * serialized), so a single handle is enough.
 */
let liveEngineChild: cp.ChildProcess | null = null;

/**
 * Kills any in-flight engine step and its subtree. Called from `deactivate()`:
 * without it, closing the window leaves the engine driving the user's service
 * with no parent and no UI — Task Manager becomes the only way to stop it.
 */
export function abortExerciseEngine(): void {
	if (liveEngineChild) {
		killProcessTree(liveEngineChild, 'SIGKILL');
		liveEngineChild = null;
	}
}

/** Exported for the stdout-drain regression test, which spawns a real child. */
export function runEngine(
	bin: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (ok: boolean, error?: string): void => {
			if (!settled) {
				settled = true;
				liveEngineChild = null;
				resolve({ ok, error });
			}
		};
		let child: cp.ChildProcess;
		try {
			// hiddenBackgroundOptions: windowsHide stops a console flashing per step
			// (four steps per Auto-Pilot cycle), and detached on POSIX gives the child
			// its own process group so killProcessTree can signal the whole subtree.
			child = cp.spawn(bin, args, hiddenBackgroundOptions({ cwd, env }));
		} catch (e) {
			done(false, e instanceof Error ? e.message : String(e));
			return;
		}
		liveEngineChild = child;
		let err = '';
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (c: string) => (err = (err + c).slice(-8000)));
		// stdout MUST be drained. The CLI writes its whole result document there
		// (cli.py `_emit`), and `plan` alone exceeds the 64 KB pipe buffer on any
		// real service once $refs are inlined. An unread pipe blocks the engine in
		// write(), it never exits, and the step below kills it as a timeout — a
		// failure that only ever reproduces on repos big enough to matter.
		let outTail = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (c: string) => (outTail = (outTail + c).slice(-8000)));
		const timer = setTimeout(() => {
			// Not child.kill: the bundled `exerciser` is a uv trampoline that execs a
			// separate python.exe, and each engine step spawns its own workers. Killing
			// only the trampoline orphans everything it started, still driving the service.
			killProcessTree(child, 'SIGKILL');
			done(false, `exerciser timed out after ${Math.round(stepTimeoutMs() / 1000)}s`);
		}, stepTimeoutMs());
		child.on('error', (e) => {
			clearTimeout(timer);
			done(false, e.message);
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			// The CLI reports structured failures as {"status":"error"} on stdout, so
			// prefer stderr but fall back to the stdout tail before a bare exit code.
			done(code === 0, code === 0 ? undefined : err || outTail || `exit ${code}`);
		});
	});
}

/**
 * Everything the pass does that reaches outside this module.
 *
 * A seam, not an abstraction: the pass ORCHESTRATES — which engine commands run,
 * in what order, which failures are fatal, and whether findings are handed on —
 * and none of that was reachable from a test, because every step went straight
 * to a process spawn, the binary registry, or the episode dispatcher. So the
 * orchestration was verified by reading it, which is exactly how the
 * service-free pass shipped returning before the dispatch block it documented
 * itself as reaching.
 *
 * Production wiring lives in `productionPorts`; a test supplies its own and gets
 * to assert the SEQUENCE.
 */
export interface ExercisePassPorts {
	binAvailable(name: string): boolean;
	binPath(name: string): string;
	handbookEnv(binDir: string, workspaceRoot: string): NodeJS.ProcessEnv;
	runEngine(
		bin: string,
		args: string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
	): Promise<{ ok: boolean; error?: string }>;
	pickTargets(workspaceRoot: string): ExerciseTarget[];
	serviceRunning(name: string): boolean;
	autoEpisodesEnabled(): boolean;
	dispatch(
		context: vscode.ExtensionContext,
		workspaceRoot: string,
		issues: ReadonlyArray<{ title: string; detail: string; rows?: number[] }>,
		opts?: { trigger?: string; successCriteria?: string[] },
	): Promise<boolean>;
	drainChannels(workspaceRoot: string): Promise<DrainReport>;
}

/** The real effects. Every field is the function the pass used to call directly. */
export function productionPorts(context: vscode.ExtensionContext): ExercisePassPorts {
	return {
		binAvailable: (name) => isBinAvailable(context, name),
		binPath: (name) => getBinPath(context, name),
		handbookEnv: (binDir, workspaceRoot) => getHandbookEnv(binDir, workspaceRoot),
		runEngine,
		pickTargets,
		serviceRunning: isServiceRunning,
		autoEpisodesEnabled: isAutoEpisodesEnabled,
		dispatch: dispatchIssueEpisode,
		drainChannels: drainChannelsAfterExercise,
	};
}

/**
 * Runs one full behavioral-exercise pass: plan → run → profile → scorecard,
 * publishes the state, and dispatches NEW behavioral failure clusters as fix
 * episodes (signature-deduped, the same path probe failures use). Serialized;
 * never throws.
 */
export async function runExercisePass(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<ExercisePassResult> {
	if (exerciseRunning) {
		return { outcome: 'skipped', endpointsCovered: 0, total: 0, invariants: 0, issues: 0, error: 'a pass is already running' };
	}
	exerciseRunning = true;
	try {
		return await exercisePassOnce(context, workspaceRoot, productionPorts(context));
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		publishExerciseState(exerciseStateFromArtifacts(null, null, 'failed', 'exercise pass failed'));
		return { outcome: 'failed', endpointsCovered: 0, total: 0, invariants: 0, issues: 0, error };
	} finally {
		exerciseRunning = false;
	}
}

const DISPATCHED_EXERCISE_KEY = 'vinv.dispatchedExerciseSignatures';

function readDispatched(context: vscode.ExtensionContext): Set<string> {
	return new Set(context.workspaceState.get<string[]>(DISPATCHED_EXERCISE_KEY) ?? []);
}

async function recordDispatched(context: vscode.ExtensionContext, ids: Iterable<string>): Promise<void> {
	const merged = readDispatched(context);
	for (const id of ids) {
		merged.add(id);
	}
	await context.workspaceState.update(DISPATCHED_EXERCISE_KEY, [...merged].slice(-500));
}

/**
 * Hand NEW behavioral failure clusters to the coding agent as fix episodes
 * (signature-deduped). Error-shaped and assert-shaped clusters dispatch
 * separately: a silent wrong-value violation needs value-shaped success
 * criteria and its own trigger, not "no longer produces these errors". One
 * episode runs at a time — whichever batch dispatches first wins this pass, the
 * other stays eligible (dispatchIssueEpisode returns false while busy).
 *
 * Shared by both passes, and that is the point: this lived INLINE at the end of
 * the served path, so the service-free pass returned before reaching it and a
 * library repo published findings that were never handed to anyone. Publishing
 * a cluster and acting on it are different things, and only the first was wired.
 */
export async function dispatchFreshClusters(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	issues: ExerciseIssuesDoc | null,
	ports: ExercisePassPorts,
): Promise<void> {
	if (!issues || issues.clusters.length === 0 || !ports.autoEpisodesEnabled()) {
		return;
	}
	const dispatched = readDispatched(context);
	const fresh = issues.clusters.filter((c) => !dispatched.has(c.signature));
	const errorShaped = fresh.filter((c) => !isAssertShapedKind(c.kind));
	const assertShaped = fresh.filter((c) => isAssertShapedKind(c.kind));
	if (errorShaped.length > 0) {
		const handedOff = await ports.dispatch(
			context, workspaceRoot, issueEpisodesFromClusters(errorShaped),
		);
		if (handedOff) {
			await recordDispatched(context, errorShaped.map((c) => c.signature));
		}
	}
	if (assertShaped.length > 0) {
		const handedOff = await ports.dispatch(
			context, workspaceRoot, issueEpisodesFromClusters(assertShaped),
			{ trigger: 'invariant-violation', successCriteria: [...ASSERT_SUCCESS_CRITERIA] },
		);
		if (handedOff) {
			await recordDispatched(context, assertShaped.map((c) => c.signature));
		}
	}
}

/** How a user-initiated dispatch from the Findings view settled. */
export type ClusterDispatch =
	| { outcome: 'dispatched' }
	| { outcome: 'unknown-cluster' | 'not-actionable' | 'busy' };

/**
 * Dispatch ONE cluster the user picked in the Findings view.
 *
 * Deliberately not `dispatchFreshClusters`: that is the automatic path, and it
 * is signature-deduped so a cluster it has already handed off is skipped
 * forever. A human clicking "Fix this" on a cluster that a previous episode
 * failed to fix means "try again" — honouring the dedup there would make the
 * button silently do nothing. It still RECORDS the dispatch, so the automatic
 * path does not re-dispatch what the user just asked for.
 */
export async function dispatchClusterFix(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	signature: string,
): Promise<ClusterDispatch> {
	const issues = readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json');
	const cluster = issues?.clusters.find((c) => c.signature === signature);
	if (!cluster) {
		return { outcome: 'unknown-cluster' };
	}
	if (!isDispatchableKind(cluster.kind)) {
		return { outcome: 'not-actionable' };
	}
	const handedOff = await dispatchIssueEpisode(
		context,
		workspaceRoot,
		issueEpisodesFromClusters([cluster]),
		isAssertShapedKind(cluster.kind)
			? { trigger: 'invariant-violation', successCriteria: [...ASSERT_SUCCESS_CRITERIA] }
			: undefined,
	);
	if (!handedOff) {
		return { outcome: 'busy' };
	}
	await recordDispatched(context, [cluster.signature]);
	return { outcome: 'dispatched' };
}

/**
 * The exercise pass for a repo with nothing serving: `campaign` alone, without
 * `--base-url`, so the HTTP oracle stays unarmed and the four service-free
 * oracles do the work. `plan`/`run`/`profile`/`scorecard` are all HTTP-shaped
 * and are correctly absent here — findings land in issues.json exactly as they
 * do on the served path, and go to the SAME dispatch path from there.
 */
async function runServiceFreePass(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	bin: string,
	env: NodeJS.ProcessEnv,
	why: string,
	ports: ExercisePassPorts,
): Promise<ExercisePassResult> {
	publishExerciseState(
		exerciseStateFromArtifacts(null, null, 'running', `${why} — exercising functions and contracts…`),
	);
	const campaign = await ports.runEngine(
		bin,
		['campaign', workspaceRoot, '--budget', String(campaignBudget())],
		workspaceRoot,
		env,
	);
	const issues = readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json');
	if (!campaign.ok) {
		publishExerciseState(exerciseStateFromArtifacts(null, issues, 'failed', 'campaign failed'));
		return {
			outcome: 'failed', endpointsCovered: 0, total: 0, invariants: 0, issues: 0,
			error: campaign.error,
		};
	}
	// The oracles have now raised whatever they could not answer structurally —
	// a boundary's type contract, a fixture row, an environment variable. Those
	// questions are only worth raising if something answers them, so drain the
	// channels and, if the harness answered anything, run once more with what it
	// said. ONE extra pass: the answers are cached permanently, so a second
	// re-run would re-drive the same evidence for nothing.
	const drained = await ports.drainChannels(workspaceRoot);
	if (drained.answered > 0) {
		publishExerciseState(
			exerciseStateFromArtifacts(
				null,
				issues,
				'running',
				`${why} — ${drained.detail}, re-running with the answers`,
			),
		);
		const second = await ports.runEngine(
			bin,
			['campaign', workspaceRoot, '--budget', String(campaignBudget())],
			workspaceRoot,
			env,
		);
		if (second.ok) {
			const reissued = readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json');
			publishExerciseState(
				exerciseStateFromArtifacts(null, reissued, 'done', `${why} — ${drained.detail}`),
			);
			return {
				outcome: 'done', endpointsCovered: 0, total: 0, invariants: 0,
				issues: reissued?.clusters?.length ?? 0,
			};
		}
		// The re-run failed. The FIRST pass's findings are still real and still
		// earned, so they stand rather than being discarded for a retry that
		// went wrong.
	}

	// Anything the harness could not answer either is a question only a person
	// can close. Opening the panel is the LAST step of the ladder, not a
	// fallback for a failure — the engine derived what it could, induced what it
	// could, asked the agent, and this is the remainder.
	askUserForRemainingConfig(workspaceRoot, bin, env, ports);

	const found = issues?.clusters?.length ?? 0;
	publishExerciseState(
		exerciseStateFromArtifacts(null, issues, 'done', `${why} — ${engineVerdict(workspaceRoot, found)}`),
	);
	await dispatchFreshClusters(context, workspaceRoot, issues, ports);
	return { outcome: 'done', endpointsCovered: 0, total: 0, invariants: 0, issues: found };
}

/**
 * Show the user whatever configuration is still unresolved, and re-run on submit.
 *
 * Opens nothing when nothing is being asked, which is the common case: the
 * panel is the tail of the ladder, so a repo Vinv configured on its own never
 * sees it. Deliberately not awaited — the exercise pass is finished and its
 * findings are already published; a person filling in a form must not hold the
 * pipeline open while they do it.
 */
function askUserForRemainingConfig(
	workspaceRoot: string,
	bin: string,
	env: NodeJS.ProcessEnv,
	ports: ExercisePassPorts,
): void {
	try {
		openConfigRequestPanel(workspaceRoot, {
			save: (answers) => writeAnswers(workspaceRoot, answers),
			rerun: async () => {
				publishExerciseState(
					exerciseStateFromArtifacts(null, null, 'running', 'configuration supplied — re-running…'),
				);
				await ports.runEngine(
					bin,
					['campaign', workspaceRoot, '--budget', String(campaignBudget())],
					workspaceRoot,
					env,
				);
				const issues = readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json');
				publishExerciseState(
					exerciseStateFromArtifacts(
						null, issues, 'done', engineVerdict(workspaceRoot, issues?.clusters?.length ?? 0),
					),
				);
			},
			showError: (message) => void vscode.window.showErrorMessage(message),
			notify: (message) => void vscode.window.showInformationMessage(`Vinv: ${message}`),
		});
	} catch {
		// A panel that cannot open must never fail the exercise pass. The requests
		// stay on disk and the next run offers them again.
	}
}

/** The status/diagnostics shape both engine summaries share. */
interface EngineVerdictDoc {
	status?: string;
	diagnostics?: string[];
}

/**
 * What the run actually concluded, not just how many clusters it produced.
 *
 * The engine already refuses to call a run clean when it could not import the
 * code — `status: "environment"` plus a diagnostic naming the interpreter, the
 * unmet precondition or the escalated variables. The CLI prints those loudly.
 * The EXTENSION read neither, so in the product a run that never executed the
 * target still rendered as "drove the service-free oracles" with zero issues —
 * which is the exact silent zero the engine-side work exists to remove,
 * reproduced one layer up.
 *
 * A producer and a consumer are two ends, and a test on the writing end passes
 * whether or not the reading end exists. This is the reading end.
 */
export function engineVerdict(workspaceRoot: string, clusters: number): string {
	// `campaign_result.json` FIRST, because it describes the run. `functions.json`
	// is rewritten by every crash play with `only_targets=[one]`, so its `status`
	// is computed over a single module — one arm's verdict, shown as the run's,
	// and stale from a previous run entirely when no crash play was drawn. It
	// stays as the fallback: `exerciser functions` run directly writes only that.
	const doc =
		readExerciseJson<EngineVerdictDoc>(workspaceRoot, 'campaign_result.json') ??
		readExerciseJson<EngineVerdictDoc>(workspaceRoot, 'functions.json');
	const diagnostics = doc?.diagnostics ?? [];
	if (doc?.status === 'environment') {
		// The strongest thing the engine can say: it could not load the code, so
		// "no issues" means nothing was tested rather than nothing was wrong.
		return diagnostics[0] ?? 'the code under test could not be imported — nothing was exercised';
	}
	if (diagnostics.length > 0) {
		return `drove the service-free oracles — ${diagnostics[0]}`;
	}
	return `drove the service-free oracles${clusters === 0 ? ' — no issues found' : ''}`;
}

/**
 * Ask the harness whatever the engine could not decide, and report what landed.
 *
 * Never throws and never fails the exercise pass: an unanswered question leaves
 * the oracle exactly where it already was, which is where every run before this
 * existed left it.
 */
async function drainChannelsAfterExercise(workspaceRoot: string): Promise<DrainReport> {
	try {
		const harnessId = getHarnessId();
		return await drainAgentChannels(workspaceRoot, async (name, prompt) => {
			const run = await runHarnessPrompt(harnessId, workspaceRoot, name, prompt);
			return { ok: run.ok, stdout: run.stdout, detail: run.detail };
		});
	} catch (err) {
		return {
			pending: 0, answered: 0, topics: [],
			detail: `channel dispatch skipped: ${err instanceof Error ? err.message : String(err)}`,
			ok: false,
		};
	}
}

export async function exercisePassOnce(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	ports: ExercisePassPorts,
): Promise<ExercisePassResult> {
	const skip = (why: string): ExercisePassResult => {
		publishExerciseState(exerciseStateFromArtifacts(
			readExerciseJson<ExerciseProfile>(workspaceRoot, 'profile.json'),
			readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json'),
			'skipped', why,
		));
		return { outcome: 'skipped', endpointsCovered: 0, total: 0, invariants: 0, issues: 0, error: why };
	};

	if (!ports.binAvailable('exerciser')) {
		return skip('exerciser engine not installed');
	}
	const bin = ports.binPath('exerciser');
	const env = ports.handbookEnv(path.dirname(bin), workspaceRoot);

	// No live service is a reason to skip the HTTP oracle, not a reason to skip
	// the pass. `campaign` still arms crash, differential, fault and concurrency
	// — they drive code in workers off the source and the index, with no port
	// and no traffic. Returning 'skipped' here is what made Vinv a no-op on
	// every library repo: nothing was ever exercised because nothing was ever
	// served.
	const targets = ports.pickTargets(workspaceRoot);
	const live = targets.filter((t) => ports.serviceRunning(t.service));
	if (live.length === 0) {
		const why =
			targets.length === 0
				? 'no service with a recorded port'
				: targets.length === 1
					? `service '${targets[0].service}' is not running`
					: `none of the ${targets.length} discovered services are running`;
		return runServiceFreePass(context, workspaceRoot, bin, env, why, ports);
	}

	const baseUrlOf = (t: ExerciseTarget): string => `http://127.0.0.1:${t.port}`;
	// "api" alone reads better than "api (1/1)"; with several, the user needs to
	// know how far through the workspace the pass is.
	const label = (t: ExerciseTarget, i: number): string =>
		live.length > 1 ? `${t.service} (${i + 1}/${live.length})` : t.service;

	// A service that fails to plan or run does NOT abort the pass. Its siblings'
	// findings are real and already earned, and discarding them because a third
	// service was wedged is the same loss this loop exists to prevent — so the
	// failures are collected, the pass carries on, and the RESULT reports
	// 'failed' with every service that could not be driven named.
	const failures: string[] = [];
	const driven: ExerciseTarget[] = [];
	const issueDocs: Array<ExerciseIssuesDoc | null> = [];

	for (const [i, target] of live.entries()) {
		const baseUrl = baseUrlOf(target);
		const slug = serviceSlug(target.service);

		publishExerciseState(
			exerciseStateFromArtifacts(null, null, 'running', `planning inputs for ${label(target, i)}…`),
		);
		let step = await ports.runEngine(
			bin, ['plan', workspaceRoot, '--service', slug, '--base-url', baseUrl], workspaceRoot, env,
		);
		if (!step.ok) {
			failures.push(`${target.service}: plan failed — ${step.error ?? 'no detail'}`);
			continue;
		}

		publishExerciseState(
			exerciseStateFromArtifacts(null, null, 'running', `exercising ${label(target, i)}…`),
		);
		step = await ports.runEngine(
			bin, ['run', workspaceRoot, '--base-url', baseUrl, '--service', slug], workspaceRoot, env,
		);
		if (!step.ok) {
			failures.push(`${target.service}: run failed — ${step.error ?? 'no detail'}`);
			continue;
		}
		driven.push(target);

		// THE reason a naive `for (const target of targets)` around this whole
		// pass would be worse than not looping at all: `run` rewrites issues.json
		// wholesale, so the next service's run destroys this one's findings. Read
		// the document back before that happens, and write the union straight
		// back — so a crash mid-loop leaves everything earned so far on disk
		// rather than only whichever service happened to run last.
		issueDocs.push(readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json'));
		if (issueDocs.length > 1) {
			writeExerciseJson(workspaceRoot, 'issues.json', mergeIssueDocuments(issueDocs));
		}
	}

	if (driven.length === 0) {
		publishExerciseState(exerciseStateFromArtifacts(null, null, 'failed', failures[0] ?? 'exercise failed'));
		return {
			outcome: 'failed', endpointsCovered: 0, total: 0, invariants: 0, issues: 0,
			error: failures.join('; '),
		};
	}

	// The non-HTTP oracles: crash (function harness), differential, fault,
	// concurrency, environment. Until this step existed they were complete,
	// tested, and unreachable — five oracles whose output no code in this
	// extension read, because only `plan/run/profile/scorecard` were ever
	// invoked. `campaign` allocates one budget across them by Thompson sampling
	// and publishes what they find into issues.json, which is the single file
	// the dispatch path below consumes.
	//
	// It runs AFTER every `run` deliberately: `run` rewrites issues.json
	// wholesale, so merging first would be overwritten. `campaign` itself merges
	// (setdefault by signature), so it composes with the cross-service union
	// just written rather than replacing it.
	//
	// One workspace budget SPLIT across the services, not one budget each. The
	// oracles it arms are workspace-scoped — only the HTTP one is per-service —
	// so N full budgets would re-drive the same targets N times for the same
	// findings. A single-service workspace therefore spends exactly what it did
	// before; the bandit's posteriors persist in campaign.json, so what a later
	// service learns still warms the next pass.
	//
	// A campaign failure is NOT fatal to the pass — the HTTP findings from `run`
	// are already earned and worth publishing. It degrades to a diagnostic.
	const perServiceBudget = Math.max(1, Math.floor(campaignBudget() / driven.length));
	for (const [i, target] of driven.entries()) {
		publishExerciseState(
			exerciseStateFromArtifacts(
				null, null, 'running',
				driven.length > 1
					? `exercising functions, faults and contracts — ${label(target, i)}…`
					: 'exercising functions, faults and contracts…',
			),
		);
		const campaign = await ports.runEngine(
			bin,
			['campaign', workspaceRoot, '--base-url', baseUrlOf(target), '--budget', String(perServiceBudget)],
			workspaceRoot,
			env,
		);
		if (!campaign.ok) {
			console.warn(
				`Vinv: campaign step failed for ${target.service} (HTTP findings still published): ${campaign.error}`,
			);
		}
	}

	// Regression replay. The engine has always had this command and nothing ever
	// invoked it, so `regress.jsonl` was never written and the Findings view's
	// "Regression checks" tile read 0 in every workspace, forever — a permanently
	// empty panel that looked like "no regressions" rather than "never ran".
	//
	// It runs AFTER `run`, which is what records the request/response pairs the
	// suite is built from, and BEFORE `profile` so the profile reflects a
	// settled service. Once per service: the suite is built from that service's
	// recorded pairs and replayed against that service's port. Like `campaign`,
	// a failure is a diagnostic and not fatal: the findings already earned are
	// worth publishing either way, and the first pass in a fresh workspace is
	// establishing the baseline rather than detecting drift against one.
	for (const [i, target] of driven.entries()) {
		publishExerciseState(
			exerciseStateFromArtifacts(
				null, null, 'running',
				driven.length > 1
					? `replaying the recorded suite — ${label(target, i)}…`
					: 'replaying the recorded suite…',
			),
		);
		const regress = await ports.runEngine(
			bin,
			['regress', workspaceRoot, '--base-url', baseUrlOf(target), '--service', serviceSlug(target.service)],
			workspaceRoot,
			env,
		);
		if (!regress.ok) {
			console.warn(`Vinv: regress step failed for ${target.service} (findings still published): ${regress.error}`);
		}
	}

	// `profile` MUST run once per service, even though it rebuilds the whole
	// document from the shared results.jsonl every time: its coverage numbers
	// come from joining each endpoint against the capture directory of the
	// service it was given, and an endpoint joined against a capture that never
	// saw it scores zero. Running it once would report honest coverage for one
	// service and a flat zero for every other — a silent under-report that reads
	// as "we exercised it and nothing was covered".
	//
	// Checked like plan/run above. Unchecked, a crashed profile is
	// indistinguishable from a clean run: the reads below silently fall back to
	// the PREVIOUS pass's artifacts and the pass reports 'done' with stale
	// numbers.
	publishExerciseState(exerciseStateFromArtifacts(null, null, 'running', 'profiling behavior…'));
	const profiles: Array<RawProfile | null> = [];
	for (const target of driven) {
		const step = await ports.runEngine(
			bin, ['profile', workspaceRoot, '--service', serviceSlug(target.service)], workspaceRoot, env,
		);
		if (!step.ok) {
			failures.push(`${target.service}: profile failed — ${step.error ?? 'no detail'}`);
			continue;
		}
		profiles.push(readExerciseJson<RawProfile>(workspaceRoot, 'profile.json'));
	}
	if (profiles.length === 0) {
		publishExerciseState(exerciseStateFromArtifacts(null, null, 'failed', 'profile failed'));
		return {
			outcome: 'failed', endpointsCovered: 0, total: 0, invariants: 0, issues: 0,
			error: failures.join('; '),
		};
	}
	if (profiles.length > 1) {
		const merged = mergeProfiles(profiles);
		if (merged) {
			writeExerciseJson(workspaceRoot, 'profile.json', merged);
		}
	}

	// `scorecard` is pure assembly over the artifacts now merged above, so it
	// runs ONCE and describes the whole workspace. `--service` is only a label to
	// it — one slug when there is one service, all of them when there are more,
	// because claiming the pass covered whichever service sorted last would be a
	// lie the Flow rail then renders.
	const step = await ports.runEngine(
		bin,
		['scorecard', workspaceRoot, '--service', driven.map((t) => serviceSlug(t.service)).join(', ')],
		workspaceRoot,
		env,
	);
	if (!step.ok) {
		publishExerciseState(exerciseStateFromArtifacts(null, null, 'failed', 'scorecard failed'));
		return {
			outcome: 'failed', endpointsCovered: 0, total: 0, invariants: 0, issues: 0,
			error: [...failures, `scorecard failed — ${step.error ?? 'no detail'}`].join('; '),
		};
	}

	const profile = readExerciseJson<ExerciseProfile>(workspaceRoot, 'profile.json');
	const issues = readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json');
	const state = exerciseStateFromArtifacts(
		profile, issues, failures.length ? 'failed' : 'done',
		`${profile?.endpoints_with_coverage ?? 0}/${profile?.endpoint_count ?? 0} endpoints · ` +
			`${profile?.invariants_learned ?? 0} invariants` +
			(driven.length > 1 ? ` · ${driven.length} services` : '') +
			(failures.length ? ` · ${failures.length} service(s) failed` : ''),
	);
	publishExerciseState(state);

	// Dispatch from the MERGED document, so a defect in the service that ran
	// first is handed to the coding agent alongside the one that ran last.
	await dispatchFreshClusters(context, workspaceRoot, issues, ports);

	return {
		// Partial coverage of a workspace is not a clean pass. The findings are
		// published either way — mirroring how a campaign failure degrades to a
		// diagnostic — but a service that could not be driven is a real failure
		// and Auto-Pilot's retry accounting has to see it.
		outcome: failures.length ? 'failed' : 'done',
		endpointsCovered: state.endpointsCovered,
		total: state.total,
		invariants: state.invariants,
		issues: state.issues,
		error: failures.length ? failures.join('; ') : undefined,
	};
}

/** Surfaces any persisted exercise artifacts immediately on activation. */
export function primeExerciseState(workspaceRoot: string): void {
	const profile = readExerciseJson<ExerciseProfile>(workspaceRoot, 'profile.json');
	const issues = readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json');
	if (profile || issues) {
		publishExerciseState(exerciseStateFromArtifacts(profile, issues, 'done', 'loaded from disk'));
	}
}

// Re-export the state getter so consumers importing from this module get it.
export { getExerciseState };
