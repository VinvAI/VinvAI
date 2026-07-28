/**
 * Behavioral-exercise stage — closes "vinv only profiles the traffic it happens
 * to see". After probes, the exerciser engine PLANS, EXECUTES, PROFILES and
 * LEARNS INVARIANTS for EVERY discovered endpoint against the live traced
 * service:
 *
 *   exerciser plan <repo> --base-url … → exerciser run … → exerciser profile …
 *   → exerciser scorecard …
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

/**
 * Assert-shaped cluster kinds: the service ANSWERED (usually 2xx) but its
 * output broke a learned invariant or regressed against the golden baseline —
 * "output changed but nothing raised". These dispatch with value-shaped
 * success criteria; "no longer produces these errors" would be vacuous.
 */
export function isAssertShapedKind(kind: string): boolean {
	return ASSERT_SHAPED_KINDS.has(kind);
}

/**
 * Kinds where the code ANSWERED and the answer was wrong — no exception, no 5xx.
 *
 * The HTTP oracle contributes two. The five newer oracles contribute three more,
 * and getting them into this set is not cosmetic: an error-shaped dispatch tells
 * the fixing agent "these calls no longer raise", which is VACUOUS against a
 * silent wrong value — the target never raised in the first place, so the
 * criterion is satisfied by changing nothing.
 */
const ASSERT_SHAPED_KINDS: ReadonlySet<string> = new Set([
	'invariant-violation', // learned invariant broken on a 2xx
	'baseline-degraded', // value changed against a value-stable golden
	'differential-mismatch', // computed a different value than the reference
	'fault-divergence', // aggregate differs by chunk-split point
	'concurrency-divergence', // concurrent results collapse vs the serial baseline
]);

/**
 * Kinds that are DIAGNOSTICS about the environment, never defects in this repo —
 * so they must never become a fix episode.
 *
 * `signature-drift` is an upstream dependency changing its own API. There is no
 * edit to this repo that "fixes" it, and dispatching an agent at it burns a fix
 * budget on something it cannot resolve. It still belongs in issues.json as
 * evidence; it just must not be actioned.
 */
const NON_DISPATCHABLE_KINDS: ReadonlySet<string> = new Set(['signature-drift']);

/** Whether a cluster kind should become a fix episode at all. */
export function isDispatchableKind(kind: string): boolean {
	return !NON_DISPATCHABLE_KINDS.has(kind);
}

/**
 * Where the evidence for a cluster kind actually lives.
 *
 * The dispatch text used to hardcode "results.jsonl" for everything, which is
 * the HTTP oracle's artifact. Pointing a fixing agent at an empty file is worse
 * than pointing it nowhere — it reads the miss as "no evidence exists".
 */
export function evidenceFileForKind(kind: string): string {
	switch (kind) {
		case 'function-crash':
		case 'function-sandboxed':
			return 'function_results.jsonl';
		case 'differential-mismatch':
			return 'differential_results.jsonl';
		case 'fault-crash':
		case 'fault-divergence':
			return 'fault_results.jsonl';
		case 'concurrency-divergence':
		case 'concurrency-hang':
			return 'concurrency_results.jsonl';
		case 'signature-drift':
			return 'signatures.json';
		default:
			return 'results.jsonl';
	}
}

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

/** The service to exercise: prefer a live session with a known port. */
function pickTarget(workspaceRoot: string): { service: string; port: number } | null {
	const candidates = runningServiceNames().length
		? runningServiceNames()
		: readServices(workspaceRoot)
				.map((s) => s.name)
				.filter((name) => readStartCommands(workspaceRoot, name).length > 0);
	for (const service of candidates) {
		const entry = readServices(workspaceRoot).find((s) => s.name === service);
		if (typeof entry?.port === 'number' && entry.port > 0) {
			return { service, port: entry.port };
		}
	}
	return null;
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

/** Per-engine-step timeout (VINV_EXERCISE_TIMEOUT_S, default 180s). */
function stepTimeoutMs(): number {
	const raw = Number.parseFloat(process.env.VINV_EXERCISE_TIMEOUT_S ?? '');
	return (Number.isFinite(raw) && raw > 0 ? raw : 180) * 1000;
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
		return await exercisePassOnce(context, workspaceRoot);
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
 * The exercise pass for a repo with nothing serving: `campaign` alone, without
 * `--base-url`, so the HTTP oracle stays unarmed and the four service-free
 * oracles do the work. `plan`/`run`/`profile`/`scorecard` are all HTTP-shaped
 * and are correctly absent here — findings land in issues.json exactly as they
 * do on the served path, which is the file the dispatch path reads.
 */
async function runServiceFreePass(
	workspaceRoot: string,
	bin: string,
	env: NodeJS.ProcessEnv,
	why: string,
): Promise<ExercisePassResult> {
	publishExerciseState(
		exerciseStateFromArtifacts(null, null, 'running', `${why} — exercising functions and contracts…`),
	);
	const campaign = await runEngine(
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
	const found = issues?.clusters?.length ?? 0;
	publishExerciseState(
		exerciseStateFromArtifacts(null, issues, 'done', `${why} — drove the service-free oracles`),
	);
	return { outcome: 'done', endpointsCovered: 0, total: 0, invariants: 0, issues: found };
}

async function exercisePassOnce(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<ExercisePassResult> {
	const skip = (why: string): ExercisePassResult => {
		publishExerciseState(exerciseStateFromArtifacts(
			readExerciseJson<ExerciseProfile>(workspaceRoot, 'profile.json'),
			readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json'),
			'skipped', why,
		));
		return { outcome: 'skipped', endpointsCovered: 0, total: 0, invariants: 0, issues: 0, error: why };
	};

	if (!isBinAvailable(context, 'exerciser')) {
		return skip('exerciser engine not installed');
	}
	const bin = getBinPath(context, 'exerciser');
	const env = getHandbookEnv(path.dirname(bin), workspaceRoot);

	// No live service is a reason to skip the HTTP oracle, not a reason to skip
	// the pass. `campaign` still arms crash, differential, fault and concurrency
	// — they drive code in workers off the source and the index, with no port
	// and no traffic. Returning 'skipped' here is what made Vinv a no-op on
	// every library repo: nothing was ever exercised because nothing was ever
	// served.
	const target = pickTarget(workspaceRoot);
	if (!target || !isServiceRunning(target.service)) {
		const why = target
			? `service '${target.service}' is not running`
			: 'no service with a recorded port';
		return runServiceFreePass(workspaceRoot, bin, env, why);
	}

	const baseUrl = `http://127.0.0.1:${target.port}`;
	const slug = serviceSlug(target.service);

	publishExerciseState(exerciseStateFromArtifacts(null, null, 'running', `planning inputs for ${target.service}…`));
	let step = await runEngine(bin, ['plan', workspaceRoot, '--service', slug, '--base-url', baseUrl], workspaceRoot, env);
	if (!step.ok) {
		publishExerciseState(exerciseStateFromArtifacts(null, null, 'failed', 'plan failed'));
		return { outcome: 'failed', endpointsCovered: 0, total: 0, invariants: 0, issues: 0, error: step.error };
	}

	publishExerciseState(exerciseStateFromArtifacts(null, null, 'running', `exercising ${target.service}…`));
	step = await runEngine(bin, ['run', workspaceRoot, '--base-url', baseUrl, '--service', slug], workspaceRoot, env);
	if (!step.ok) {
		publishExerciseState(exerciseStateFromArtifacts(null, null, 'failed', 'run failed'));
		return { outcome: 'failed', endpointsCovered: 0, total: 0, invariants: 0, issues: 0, error: step.error };
	}

	// The non-HTTP oracles: crash (function harness), differential, fault,
	// concurrency, environment. Until this step existed they were complete,
	// tested, and unreachable — five oracles whose output no code in this
	// extension read, because only `plan/run/profile/scorecard` were ever
	// invoked. `campaign` allocates one budget across them by Thompson sampling
	// and publishes what they find into issues.json, which is the single file
	// the dispatch path below consumes.
	//
	// It runs AFTER `run` deliberately: `run` rewrites issues.json wholesale, so
	// merging first would be overwritten. Its own budget bounds it, because
	// `campaign` has no wall-clock deadline of its own and the step timer would
	// otherwise be the only thing stopping it.
	//
	// A campaign failure is NOT fatal to the pass — the HTTP findings from `run`
	// are already earned and worth publishing. It degrades to a diagnostic.
	publishExerciseState(
		exerciseStateFromArtifacts(null, null, 'running', 'exercising functions, faults and contracts…'),
	);
	const campaign = await runEngine(
		bin,
		['campaign', workspaceRoot, '--base-url', baseUrl, '--budget', String(campaignBudget())],
		workspaceRoot,
		env,
	);
	if (!campaign.ok) {
		console.warn(`Vinv: campaign step failed (HTTP findings still published): ${campaign.error}`);
	}

	publishExerciseState(exerciseStateFromArtifacts(null, null, 'running', 'profiling behavior…'));
	// These two MUST be checked like plan/run above. Unchecked, a crashed profile
	// is indistinguishable from a clean run: the reads below silently fall back to
	// the PREVIOUS pass's artifacts and the pass reports 'done' with stale numbers.
	step = await runEngine(bin, ['profile', workspaceRoot, '--service', slug], workspaceRoot, env);
	if (!step.ok) {
		publishExerciseState(exerciseStateFromArtifacts(null, null, 'failed', 'profile failed'));
		return { outcome: 'failed', endpointsCovered: 0, total: 0, invariants: 0, issues: 0, error: step.error };
	}

	step = await runEngine(bin, ['scorecard', workspaceRoot, '--service', slug], workspaceRoot, env);
	if (!step.ok) {
		publishExerciseState(exerciseStateFromArtifacts(null, null, 'failed', 'scorecard failed'));
		return { outcome: 'failed', endpointsCovered: 0, total: 0, invariants: 0, issues: 0, error: step.error };
	}

	const profile = readExerciseJson<ExerciseProfile>(workspaceRoot, 'profile.json');
	const issues = readExerciseJson<ExerciseIssuesDoc>(workspaceRoot, 'issues.json');
	const state = exerciseStateFromArtifacts(
		profile, issues, 'done',
		`${profile?.endpoints_with_coverage ?? 0}/${profile?.endpoint_count ?? 0} endpoints · ` +
			`${profile?.invariants_learned ?? 0} invariants`,
	);
	publishExerciseState(state);

	// Dispatch NEW behavioral failure clusters as fix episodes (signature-deduped).
	// Error-shaped and assert-shaped clusters dispatch separately: a silent
	// wrong-value violation needs value-shaped success criteria and its own
	// trigger, not "no longer produces these errors". One episode runs at a
	// time — whichever batch dispatches first wins this pass, the other stays
	// eligible (dispatchIssueEpisode returns false while busy).
	if (issues && issues.clusters.length > 0 && isAutoEpisodesEnabled()) {
		const dispatched = readDispatched(context);
		const fresh = issues.clusters.filter((c) => !dispatched.has(c.signature));
		const errorShaped = fresh.filter((c) => !isAssertShapedKind(c.kind));
		const assertShaped = fresh.filter((c) => isAssertShapedKind(c.kind));
		if (errorShaped.length > 0) {
			const handedOff = await dispatchIssueEpisode(
				context, workspaceRoot, issueEpisodesFromClusters(errorShaped),
			);
			if (handedOff) {
				await recordDispatched(context, errorShaped.map((c) => c.signature));
			}
		}
		if (assertShaped.length > 0) {
			const handedOff = await dispatchIssueEpisode(
				context, workspaceRoot, issueEpisodesFromClusters(assertShaped),
				{ trigger: 'invariant-violation', successCriteria: [...ASSERT_SUCCESS_CRITERIA] },
			);
			if (handedOff) {
				await recordDispatched(context, assertShaped.map((c) => c.signature));
			}
		}
	}

	return {
		outcome: 'done',
		endpointsCovered: state.endpointsCovered,
		total: state.total,
		invariants: state.invariants,
		issues: state.issues,
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
