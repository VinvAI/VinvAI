/// <reference types="node" />

/**
 * Auto-trigger hooks that turn observed failures into harness episodes:
 *
 *   • a service run exiting with an error (or instant-exiting, the
 *     backgrounding smell) offers "Fix with Harness" — one click starts a
 *     closed-loop episode seeded with the exit evidence; with the
 *     autoEpisodes toggle on, the episode dispatches without asking, and only
 *     surfaces when verification is in doubt.
 *   • smoke-report/tracemap error clusters raise the same offer with the
 *     failing spans as the issue statement.
 */
import {
	clearTimeout as cancelTimer,
	setTimeout as scheduleTimer,
} from 'timers';
import * as vscode from 'vscode';
import { getHarnessId, isAutoEpisodesEnabled } from '../config/settings';
import { onServiceExit, type ServiceExitEvent } from '../bringup/serviceRunner';
import { readBringupOutcome } from '../bringup/bringup';
import { runEpisode, isEpisodeRunning, type EpisodeTask } from './episodeLoop';
import { classifyIntent, criteriaFor } from './taskIntent';
import {
	getHarness,
	getHarnessBlock,
	isHarnessAutonomous,
	isHarnessBusy,
	preflightHarnessAuth,
	quickScanHarnesses,
} from './harnessRunner';
import { pickHarness } from './harnessPicker';
import { loadRuntimeOverlay, loadNodes, indexStoreDir } from '../graph/indexGraph';
import {
	buildWorkspaceDeps,
	runVerifiedOptimization,
	type OptimizeOpportunity,
	type OptimizeRunResult,
} from './exerciseOptimize';
import { readAndClearRequests, restoreEpisodeRequests } from './requestQueue';
import {
	collectMemoryTrends,
	collectRuntimeErrorClusters,
	securityGuardReasons,
	selectHotspots,
	type ErrorCluster,
	type Hotspot,
} from './runtimeAnalysis';
import {
	candidateSignature,
	candidateToOpportunity,
	markOpportunitiesDispatched,
	postOpportunities,
	syncOpportunityBoard,
	type LedgerEvent,
	type OpportunityInput,
} from './opportunityBoard';
import { readEpisodeEvents } from './trajectoryReport';
import type { OptimizationCandidate } from './optimizationAnalysis';

// The pure analyses live in runtimeAnalysis.ts (vscode-free, shared with the
// MCP server); re-exported here so existing imports and tests keep working.
// NOTE: selectHotspots is a DISPLAY ranking only (QnA answers, the MCP
// `hotspots` read action) — dispatch derives exclusively from
// computeOptimizationCandidates through the opportunity board below.
export { collectRuntimeErrorClusters, selectHotspots, type ErrorCluster, type Hotspot };

function serviceFixTask(event: ServiceExitEvent): EpisodeTask {
	const symptom = event.instantExit
		? 'the recorded start command exited instantly with code 0 (it likely backgrounds itself)'
		: `the service exited with code ${event.exitCode ?? 'null'}`;
	return {
		kind: 'service-fix',
		trigger: 'service-exit',
		service: event.service,
		title: `Fix service '${event.service}'`,
		issue:
			`Running the verified start command for service '${event.service}' failed: ${symptom}.\n\n` +
			`Output tail:\n\`\`\`\n${event.outputTail || '(no output captured)'}\n\`\`\``,
		successCriteria: [
			`The recorded start command in .vinv/start_commands/${event.service}.json starts the service in the foreground and it keeps running`,
			'The service accepts connections on its recorded port (when one is recorded)',
			'No new errors appear in the startup output',
		],
	};
}

/** Hooks a caller can attach to the offer/dispatch flow. */
export interface DispatchHooks {
	/**
	 * Invoked the moment the dispatch is CONFIRMED (auto-dispatch decided to
	 * run, or the user clicked the offer and picked a harness) but before the
	 * episode starts. This is the only safe place to record "dispatched" state
	 * — a declined offer never reaches it, so no phantom bookkeeping.
	 */
	onAccept?: () => void | Promise<void>;
	/** Prior attempts' learning, seeded into the pack (revert-learn-retry). */
	priorLearning?: string;
}

/**
 * Returns true only when an episode actually ran (accepted or auto-dispatched
 * AND not infra-blocked) — the caller's signal that "dispatched" state may be
 * recorded and an after-measurement is meaningful.
 */
async function offerOrDispatch(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	task: EpisodeTask,
	summary: string,
	hooks?: DispatchHooks,
): Promise<boolean> {
	if (isEpisodeRunning()) {
		return false; // one loop at a time; the running episode already owns the harness
	}
	if (hooks?.priorLearning) {
		task = { ...task, priorFailureSeed: hooks.priorLearning };
	}
	// Auto-dispatch only when the configured harness is actually present AND
	// runs without a human (Cursor's chat and Cascade need someone to press
	// Enter — an unattended dispatch to them just parks a prompt nobody sends).
	// Otherwise fall through to the offer, whose click proves a human is there.
	const harnessId = getHarnessId();
	const harnessReady =
		quickScanHarnesses()[harnessId] === true && isHarnessAutonomous(getHarness(harnessId));
	if (isAutoEpisodesEnabled() && harnessReady) {
		// Infra preflight: an unauthenticated CLI must not consume the dispatch
		// (markHarnessBlocked already surfaced the remediation once) — the issue
		// stays blocked-on-you and re-dispatches fresh after login.
		if ((await preflightHarnessAuth(harnessId)) !== 'ok') {
			return false;
		}
		void vscode.window.showInformationMessage(`Vinv: ${summary} — dispatching a fix episode…`);
		await hooks?.onAccept?.();
		await runEpisode(context, workspaceRoot, task);
		return !getHarnessBlock(harnessId);
	}
	const choice = await vscode.window.showWarningMessage(
		`Vinv: ${summary}`,
		'Fix with Harness',
		'Dismiss',
	);
	if (choice === 'Fix with Harness') {
		// A click means a human is present — ask which agent gets the episode.
		const picked = await pickHarness();
		if (!picked) {
			return false;
		}
		await hooks?.onAccept?.();
		await runEpisode(context, workspaceRoot, task, picked);
		return !getHarnessBlock(picked);
	}
	return false;
}

/**
 * The insight/probe pipeline's hand-off into the SAME dispatch path the
 * service-exit trigger uses: one grouped fix episode carrying every new
 * issue's evidence, seeded with the failing symbols' graph rows. Returns true
 * when the episode was dispatched (auto) or accepted (click) — the caller
 * then records the signatures as dispatched. Returns false when the harness
 * is busy or the user dismissed, so the issues stay eligible next pass.
 */
export async function dispatchIssueEpisode(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	issues: ReadonlyArray<{ title: string; detail: string; rows?: number[] }>,
): Promise<boolean> {
	if (issues.length === 0 || isEpisodeRunning() || isHarnessBusy()) {
		return false; // busy-lock discipline: the issues stay eligible next pass
	}
	const rows = [...new Set(issues.flatMap((i) => i.rows ?? []))];
	const task: EpisodeTask = {
		kind: 'general',
		trigger: 'smoke-errors',
		title:
			issues.length === 1
				? issues[0].title
				: `Fix ${issues.length} issue(s) found by the insight pipeline`,
		issue:
			'Automatic analysis of the live traced service identified these issues:\n\n' +
			issues.map((i) => `## ${i.title}\n${i.detail}`).join('\n\n'),
		seedRows: rows.length ? rows : undefined,
		successCriteria: [
			'The listed functions/endpoints no longer produce these errors when the same requests are replayed',
			'No new errors are introduced elsewhere in the trace',
		],
	};
	const harnessId = getHarnessId();
	const harnessReady =
		quickScanHarnesses()[harnessId] === true && isHarnessAutonomous(getHarness(harnessId));
	if (isAutoEpisodesEnabled() && harnessReady) {
		// Infra preflight: a blocked CLI (needs login / quota / network) must
		// not consume the dispatch. Returning false keeps every issue eligible,
		// so the same signatures re-dispatch fresh once the human has logged in
		// — blocked is never recorded as dispatched.
		if ((await preflightHarnessAuth(harnessId)) !== 'ok') {
			return false;
		}
		void vscode.window.showInformationMessage(
			`Vinv: ${issues.length} issue(s) identified from the live trace — dispatching a fix episode…`,
		);
		// Fire-and-observe: runEpisode owns the busy-lock (it refuses to start
		// while a harness run or episode is in flight, which we checked above).
		await runEpisode(context, workspaceRoot, task);
		// The dispatch itself may have discovered the precondition failure —
		// then nothing was actually attempted-to-completion: report "not handed
		// off" so the caller leaves the signatures eligible for re-dispatch.
		if (getHarnessBlock(harnessId)) {
			return false;
		}
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		`Vinv: ${issues.length} issue(s) identified from the live trace`,
		'Fix with Harness',
		'Dismiss',
	);
	if (choice !== 'Fix with Harness') {
		return false;
	}
	const picked = await pickHarness();
	if (!picked) {
		return false;
	}
	await runEpisode(context, workspaceRoot, task, picked);
	// Same rule as the auto path: a dispatch that ended infra-blocked was not
	// handed off — the issues stay eligible for a fresh dispatch after login.
	return !getHarnessBlock(picked);
}

/**
 * Wires the service-exit hook. A clean long-run exit (code 0 after a real
 * lifetime) is not a failure and raises nothing.
 */
export function registerAutoTriggers(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		onServiceExit((event) => {
			const failed = (event.exitCode !== null && event.exitCode !== 0) || event.instantExit;
			if (!failed) {
				return;
			}
			const summary = event.instantExit
				? `service '${event.service}' exited instantly (backgrounding start command)`
				: `service '${event.service}' exited with code ${event.exitCode}`;
			void offerOrDispatch(context, event.workspaceRoot, serviceFixTask(event), summary);
		}),
	);
	// Errors observed in live traces dispatch themselves (signature-deduped).
	registerRuntimeErrorTrigger(context);
	// Chat-side requests (vinv_session dispatch actions) become real episodes.
	registerEpisodeRequestTrigger(context);
}

/**
 * The other half of the chat→editor bridge: the MCP session tool enqueues
 * request files under .vinv/requests (it has no `vscode` and cannot run an
 * episode); this watcher sweeps them into real episodes. Sweeps happen on
 * activation (requests written while the editor was closed) and on every
 * create in the directory. Because the user explicitly asked for the action
 * in chat, a 'fix' request dispatches straight to runEpisode rather than
 * re-asking through the offer flow.
 */
export function registerEpisodeRequestTrigger(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const root = folder.uri.fsPath;
	const sweep = async (): Promise<void> => {
		const requests = readAndClearRequests(root);
		for (let index = 0; index < requests.length; index += 1) {
			const request = requests[index];
			if (isEpisodeRunning()) {
				// readAndClearRequests drains atomically. Restore this request AND
				// every request after it; restoring only the current item silently
				// discarded the tail whenever the harness was already occupied.
				restoreEpisodeRequests(root, requests.slice(index));
				return;
			}
			switch (request.kind) {
				case 'fix': {
					if (!request.issue) {
						break;
					}
					const service = request.service;
					void vscode.window.showInformationMessage(
						`Vinv: dispatching chat-requested episode — ${request.issue.slice(0, 96)}`,
					);
					// Chat-requested text is free-form — it may be a question rather
					// than a defect report, and must be classified before it gets
					// criteria that assert something is broken.
					const intent = service ? 'defect' : classifyIntent(request.issue);
					await runEpisode(context, root, {
						kind: service ? 'service-fix' : 'general',
						trigger: 'chat',
						service,
						intent,
						title: request.issue.length > 72 ? `${request.issue.slice(0, 69)}…` : request.issue,
						issue: request.issue,
						// Only CONCRETE, checkable criteria may enter the adherence gate
						// (ateam finding: generic goal-restatements let a soft LLM read
						// veto a hard-verified pass). Minimality/no-collateral are
						// already covered by the scope-drift signal and the regression
						// tests — the right layers. criteriaFor honors that: concrete
						// criteria for a service, satisfiable ones for a question, and
						// none for a free-text defect.
						successCriteria: criteriaFor(intent, service),
					});
					break;
				}
				case 'runtime-errors':
					await offerEpisodeForRuntimeErrors(context, root);
					break;
				case 'hotspots':
					// Chat-requested sweeps ride the same verdict engine as the
					// panel: frozen probes, episode-bound verdict, real revert.
					await runVerifiedHotspotEpisode(context, root);
					break;
				case 'memory-trends':
					await offerEpisodeForMemoryTrends(context, root);
					break;
				case 'cache-candidates':
					await runVerifiedCacheSweep(context, root);
					break;
			}
		}
	};
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(root, '.vinv/requests/episode-*.json'),
	);
	let timer: ReturnType<typeof scheduleTimer> | undefined;
	const schedule = (): void => {
		if (timer) {
			cancelTimer(timer);
		}
		// Small debounce: enqueue is atomic per file, but a chat turn can
		// enqueue several requests back-to-back.
		timer = scheduleTimer(() => void sweep(), 1_000);
	};
	watcher.onDidCreate(schedule);
	context.subscriptions.push(watcher, {
		dispose: () => {
			if (timer) {
				cancelTimer(timer);
			}
		},
	});
	// Activation sweep: requests written while the editor was closed.
	void sweep();
}

/**
 * Bring-up failure hook: when a service's bring-up ends in state 'failed'
 * (the agent tried, recorded a failure symptom, and could not verify a start
 * command), the symptom IS evidence of a code/config problem — so it becomes
 * a fix episode instead of a dead "bring-up failed" label the user has to
 * decode alone. Verification replays bring-up's own contract: the recorded
 * command must start the service in the foreground and keep it up.
 */
export async function offerEpisodeForBringupFailure(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	service: string,
): Promise<void> {
	const outcome = readBringupOutcome(workspaceRoot, service);
	if (outcome.state !== 'failed') {
		return; // verified, library, or never attempted — nothing to fix
	}
	const task: EpisodeTask = {
		kind: 'service-fix',
		trigger: 'service-exit',
		service,
		title: `Fix bring-up of '${service}'`,
		issue:
			`Bring-up of service '${service}' failed. The bring-up agent's recorded failure symptom:\n\n` +
			`\`\`\`\n${outcome.symptom ?? '(no symptom recorded — read .vinv/start_commands/' + service + '.json and the bring-up log)'}\n\`\`\`\n\n` +
			'Diagnose whether this is a code bug, a missing dependency, or a wrong start command, ' +
			'fix the root cause, and record a working foreground start command.',
		successCriteria: [
			`.vinv/start_commands/${service}.json records verified: true with a foreground start command`,
			'That command starts the service and it keeps running (no instant exit, no startup errors)',
		],
	};
	await offerOrDispatch(
		context,
		workspaceRoot,
		task,
		`bring-up of '${service}' failed — ${(outcome.symptom ?? 'no symptom recorded').slice(0, 120)}`,
	);
}

function runtimeErrorTask(clusters: ErrorCluster[]): EpisodeTask {
	return {
		kind: 'general',
		trigger: 'smoke-errors',
		title: `Fix ${clusters.length} runtime error cluster(s)`,
		issue:
			'The captured runtime trace shows these functions raising errors:\n\n' +
			clusters.map((c) => `- ${c.line}`).join('\n'),
		// Seed rows put the FAILING SYMBOLS at the center of the pack's graph
		// slice — the context graph around the errors is what gets handed over.
		seedRows: clusters.map((c) => c.row),
		successCriteria: [
			'The listed functions no longer raise these errors when the same endpoints are exercised',
			'No new errors are introduced elsewhere in the trace',
		],
	};
}

/**
 * Smoke-report companion trigger: after a report is generated, scan the
 * runtime overlay for error clusters and offer an episode targeting them.
 * Called by the smoke-report flow with the workspace root; quiet when the
 * trace is clean.
 */
export async function offerEpisodeForRuntimeErrors(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<void> {
	let clusters: ErrorCluster[] = [];
	try {
		const nodes = loadNodes(indexStoreDir(workspaceRoot));
		clusters = collectRuntimeErrorClusters(
			nodes,
			loadRuntimeOverlay(workspaceRoot, nodes),
		).clusters;
	} catch {
		return;
	}
	if (clusters.length === 0) {
		return;
	}
	await offerOrDispatch(
		context,
		workspaceRoot,
		runtimeErrorTask(clusters),
		`the smoke report found ${clusters.length} function(s) raising runtime errors`,
	);
}

/**
 * Workspace-state key holding the last DISPATCHED runtime-error picture
 * (content signature). Shared with the insight runner so the red-ring trigger
 * and the insight pass — which watch the same captures — never dispatch the
 * same failure picture twice.
 */
export const RUNTIME_ERROR_SIG_KEY = 'vinv.dispatchedRuntimeErrorSignature';

/**
 * The red-ring loop closer: whenever new trace data lands in
 * .vinv/captures, the overlay is re-scanned for error clusters. A failure
 * picture that has not been dispatched before (content signature, not a
 * timer) becomes a fix episode whose pack is seeded with the failing symbols
 * — the context graph around the errors goes straight to the harness. This
 * is what makes a red ring in the Graph Explorer an ACTION, not a color:
 * by the time the user sees it, the episode is already offered/dispatched.
 *
 * Debounce is generous (traces stream while a service runs); dedupe is by
 * signature so the same errors never re-dispatch, while a NEW error type or
 * a new failing symbol immediately re-arms the trigger.
 */
export function registerRuntimeErrorTrigger(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const root = folder.uri.fsPath;
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(root, '.vinv/captures/**/trace.jsonl'),
	);
	let timer: ReturnType<typeof scheduleTimer> | undefined;
	const evaluate = async (): Promise<void> => {
		// Fresh trace data is ALSO what advances the opportunity board: resolve
		// dispatched entries against episode outcomes (contract: the
		// optimization_outcome ledger events), advance expiry against the new
		// session, and post whatever the ranker newly supports. Best-effort —
		// board bookkeeping must never block the error trigger.
		try {
			syncOpportunityBoard(root, 'capture-watch', readEpisodeEvents());
		} catch {
			// No index yet, or an unwritable board — the next capture retries.
		}
		let clusters: ErrorCluster[] = [];
		let signature = '';
		try {
			const nodes = loadNodes(indexStoreDir(root));
			({ clusters, signature } = collectRuntimeErrorClusters(
				nodes,
				loadRuntimeOverlay(root, nodes),
			));
		} catch {
			return; // no index yet — nothing to seed a pack with
		}
		if (clusters.length === 0) {
			return;
		}
		if (context.workspaceState.get<string>(RUNTIME_ERROR_SIG_KEY) === signature) {
			return; // this exact failure picture was already dispatched/offered
		}
		await context.workspaceState.update(RUNTIME_ERROR_SIG_KEY, signature);
		await offerOrDispatch(
			context,
			root,
			runtimeErrorTask(clusters),
			`the live trace shows ${clusters.length} function(s) raising errors`,
		);
		// Blocked ≠ dispatched: if the dispatch ran into a harness precondition
		// failure (needs login / quota / network), un-record the signature so
		// the SAME failure picture re-arms and dispatches fresh after login —
		// otherwise the dedup would bury it forever.
		if (getHarnessBlock(getHarnessId())) {
			await context.workspaceState.update(RUNTIME_ERROR_SIG_KEY, undefined);
		}
	};
	const schedule = (): void => {
		if (timer) {
			cancelTimer(timer);
		}
		timer = scheduleTimer(() => void evaluate(), 10_000);
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
}

/** A fully-prepared optimization dispatch: the task, its board claim, labels. */
export interface OptimizationPlan {
	task: EpisodeTask;
	/** Board ids the accepted dispatch marks 'dispatched' (the consume step). */
	boardIds: string[];
	summary: string;
	label: string;
	opportunity: OptimizeOpportunity;
}

/** What preparing a sweep found — a plan, or the reason there is none. */
export interface OptimizationPrep {
	plan: OptimizationPlan | null;
	/** Candidates the evidence currently supports for this sweep's kind. */
	candidateCount: number;
	/** Candidates held on the board (dispatched/resolved — not re-dispatchable). */
	heldCount: number;
}

const NO_PLAN: OptimizationPrep = { plan: null, candidateCount: 0, heldCount: 0 };

/** The security constraint appended when a plan touches guarded symbols. */
function guardText(guardedNames: string[], reason: string): string {
	return (
		`\n\nSECURITY CONSTRAINT: ${guardedNames.map((n) => `\`${n}\``).join(', ')} ` +
		`${guardedNames.length === 1 ? 'is' : 'are'} security-sensitive (${reason}). ` +
		'The cost may be DELIBERATE — password hashing and crypto are slow by design. ' +
		'Do not cache credentials or their results, reduce hash rounds/iterations, or ' +
		'weaken any security parameter. If the time is intentional crypto cost, say so ' +
		'and stop instead of optimizing.'
	);
}

const GUARD_CRITERION =
	'No security behavior weakened: hashing/crypto parameters and credential checks are untouched';

/**
 * Prepares one optimization sweep — the ONE detection path every dispatch
 * surface rides:
 *
 *   computeOptimizationCandidates (waste-prior ranker)
 *     → post to the opportunity board (content-signature dedup)
 *     → dispatch only entries in status 'posted'
 *
 * An id already 'dispatched' or 'resolved' on the board is HELD: it never
 * re-dispatches — across restarts, editors, and processes — until it expires
 * (absent from fresh evidence for 3+ capture sessions). The 'cache_candidates'
 * sweep takes the candidates whose dominant waste signal is cache; 'hotspots'
 * takes the rest — each symbol is claimed by the signal that predicts the
 * largest recoverable time, so the two sweeps never fight over a row.
 *
 * Exported (with an injectable event list) so tests drive it against a disk
 * fixture without a vscode workspace.
 */
export function prepareOptimizationSweep(
	workspaceRoot: string,
	sweep: 'hotspots' | 'cache_candidates',
	events: ReadonlyArray<LedgerEvent> = readEpisodeEvents(),
): OptimizationPrep {
	const source = sweep === 'cache_candidates' ? 'cache-sweep' : 'hotspot-sweep';
	const sync = syncOpportunityBoard(workspaceRoot, source, events);
	if (!sync.evidenceKnown) {
		return NO_PLAN; // no index store — unknown evidence is not "no candidates"
	}
	const wantCache = sweep === 'cache_candidates';
	const subset = sync.candidates.filter((c) => (c.waste_kind === 'cache') === wantCache);
	const statusOf = new Map(sync.entries.map((e) => [e.id, e.status]));
	const dispatchable: { candidate: OptimizationCandidate; id: string }[] = [];
	let held = 0;
	for (const candidate of subset) {
		const id = candidateSignature(candidate);
		const status = statusOf.get(id);
		if (status === 'posted' || status === undefined) {
			dispatchable.push({ candidate, id });
		} else {
			// dispatched/resolved are held until expiry; evicted was outranked and
			// exhausted spent its retry budget — neither ever re-dispatches
			// silently, so all non-posted statuses count as held.
			held += 1;
		}
	}
	if (dispatchable.length === 0) {
		return { plan: null, candidateCount: subset.length, heldCount: held };
	}
	const lines = dispatchable.map(
		({ candidate: c }) =>
			`- ${c.name} at ${c.file}:${c.line} — ~${Math.round(c.predicted_ms)}ms recoverable ` +
			`of ${Math.round(c.total_ms)}ms (${c.waste_kind}): ${c.reason}`,
	);
	// Security-sensitive symbols stay real candidates (bcrypt DOMINATES an
	// auth-heavy trace) but the constraint rides the prompt: the agent must not
	// weaken what makes them slow.
	let guardBlock = '';
	let guarded = false;
	try {
		const reasons = securityGuardReasons(workspaceRoot, loadNodes(indexStoreDir(workspaceRoot)));
		const hit = dispatchable.filter(({ candidate }) => reasons.has(candidate.row));
		if (hit.length > 0) {
			guarded = true;
			guardBlock = guardText(
				hit.map(({ candidate }) => candidate.name),
				reasons.get(hit[0].candidate.row) as string,
			);
		}
	} catch {
		// Guard scan is best-effort; the candidates stand on their own.
	}
	const totalPredicted = Math.round(
		dispatchable.reduce((s, d) => s + d.candidate.predicted_ms, 0),
	);
	const task: EpisodeTask = wantCache
		? {
				kind: 'general',
				trigger: 'smoke-errors',
				title: `Cache ${dispatchable.length} recomputation site(s)`,
				issue:
					'The optimization analyzer found these symbols recomputing identical ' +
					'inputs (same args_hash AND the same observed result — functional ' +
					'dependence, no recorded nondeterminism):\n\n' +
					lines.join('\n') +
					'\n\nDecide per symbol whether memoization is safe (watch invalidation ' +
					'and unbounded growth — prefer bounded/keyed caches) and implement only ' +
					'where the evidence supports it.' +
					guardBlock,
				seedRows: dispatchable.map((d) => d.candidate.row),
				successCriteria: [
					'A fresh trace of the same flow shows fewer duplicate-argument recomputations or lower total time in the listed symbols',
					'Behavior is unchanged: same results, no new errors, memory stays bounded',
					...(guarded ? [GUARD_CRITERION] : []),
				],
			}
		: {
				kind: 'general',
				trigger: 'smoke-errors',
				title: `Optimize ${dispatchable.length} recoverable-time candidate(s)`,
				issue:
					'The optimization analyzer ranked these symbols by predicted RECOVERABLE ' +
					'time (measured cost × waste prior, relative to this trace — hot but ' +
					'already-optimal symbols are excluded):\n\n' +
					lines.join('\n') +
					'\n\nFor each: the waste kind names the likely fix (fanout/n-plus-1 → ' +
					'batch or hoist at the caller; per-call → a better algorithm; ' +
					'serial-async → await the independent I/O concurrently). Change only ' +
					'what the evidence supports. Re-run the same flow afterwards to show ' +
					'the time dropped.' +
					guardBlock,
				seedRows: dispatchable.map((d) => d.candidate.row),
				successCriteria: [
					'The listed symbols spend measurably less total time on the same exercised flow',
					'Behavior is unchanged: the service still starts, serves, and raises no new errors',
					...(guarded ? [GUARD_CRITERION] : []),
				],
			};
	return {
		plan: {
			task,
			boardIds: dispatchable.map((d) => d.id),
			summary: wantCache
				? `~${totalPredicted}ms of traced time is duplicate recomputation in ${dispatchable.length} symbol(s)`
				: `~${totalPredicted}ms of traced time is predicted recoverable in ${dispatchable.length} symbol(s)`,
			label: wantCache ? 'Cache recomputation sites' : 'Optimize recoverable-time candidates',
			opportunity: wantCache
				? {
						kind: 'cache-sweep',
						endpoint_id: 'cache-candidates',
						endpoint: 'duplicate-recomputation sites',
						detail:
							'board-deduped head of reclaimable duplicated work dispatched as a memoization episode',
						metric: 'probe_latency_ms',
						value: totalPredicted,
					}
				: {
						kind: 'hotspot-sweep',
						endpoint_id: 'hotspots',
						endpoint: 'ranked optimization candidates',
						detail:
							'board-deduped head of predicted recoverable time dispatched as one optimization episode',
						metric: 'probe_latency_ms',
						value: totalPredicted,
					},
		},
		candidateCount: subset.length,
		heldCount: held,
	};
}

/**
 * Prepares the single-row (panel click) dispatch. The row's candidate is
 * posted to the board like any sweep candidate — a panel click is not a
 * side-channel around the dedup: if the board already holds the id as
 * dispatched/resolved, the plan is null and nothing re-dispatches until
 * expiry. Falls back to the whole sweep when the row cannot be resolved
 * against the store.
 */
export function prepareRowOptimization(
	workspaceRoot: string,
	row: number,
	events: ReadonlyArray<LedgerEvent> = readEpisodeEvents(),
): OptimizationPrep {
	let node: { name: string; file: string; start_line: number } | undefined;
	let totalMs = 0;
	let calls = 0;
	let guardReason: string | undefined;
	try {
		const nodes = loadNodes(indexStoreDir(workspaceRoot));
		const overlay = loadRuntimeOverlay(workspaceRoot, nodes);
		node = nodes[row];
		const rt = overlay[row];
		totalMs = rt?.total_ms ?? 0;
		calls = rt?.calls ?? 0;
		guardReason = securityGuardReasons(workspaceRoot, nodes).get(row);
	} catch {
		return NO_PLAN;
	}
	if (!node) {
		// Row is not resolvable against the current store — do the safe thing.
		return prepareOptimizationSweep(workspaceRoot, 'hotspots', events);
	}
	const sync = syncOpportunityBoard(workspaceRoot, 'panel', events);
	const candidate = sync.candidates.find((c) => c.row === row);
	const input: OpportunityInput = candidate
		? candidateToOpportunity(candidate, 'panel')
		: {
				kind: 'latency-symbol',
				row,
				name: node.name,
				file: node.file,
				line: node.start_line,
				predicted_ms: 0,
				evidence: `panel dispatch of ${node.name}`,
				source: 'panel',
			};
	const entry = [...postOpportunities(workspaceRoot, [input]).values()][0];
	if (entry.status !== 'posted') {
		// dispatched/resolved held until expiry; evicted/exhausted are terminal
		// and never re-dispatch silently — a panel click is not a side-channel.
		return { plan: null, candidateCount: 1, heldCount: 1 };
	}
	const guardBlock = guardReason ? guardText([node.name], guardReason) : '';
	const task: EpisodeTask = {
		kind: 'general',
		trigger: 'smoke-errors',
		title: `Optimize ${node.name}`,
		issue:
			`The captured runtime trace spends significant time in \`${node.name}\` ` +
			`at ${node.file}:${node.start_line}` +
			(totalMs > 0 ? ` — ${Math.round(totalMs)}ms across ${calls} call(s).` : '.') +
			(candidate
				? `\n\nThe optimization analyzer predicts ~${Math.round(candidate.predicted_ms)}ms ` +
					`recoverable (${candidate.waste_kind}): ${candidate.reason}`
				: '') +
			'\n\nDecide whether the win is a better algorithm, caching, batching, or ' +
			'making the work async/parallel — and change only what the evidence ' +
			'supports. Do not alter behavior. Re-run the same flow afterwards so a ' +
			'fresh trace can show the time dropped.' +
			guardBlock,
		seedRows: [row],
		successCriteria: [
			`\`${node.name}\` spends measurably less total time on the same exercised flow`,
			'Behavior is unchanged: the service still starts, serves, and raises no new errors',
			...(guardReason ? [GUARD_CRITERION] : []),
		],
	};
	return {
		plan: {
			task,
			boardIds: [entry.id],
			summary: `optimize ${node.name}${totalMs > 0 ? ` (${Math.round(totalMs)}ms in the trace)` : ''}`,
			label: `Optimize ${node.name}`,
			opportunity: {
				kind: candidate ? candidate.waste_kind : 'latency-symbol',
				endpoint_id: node.name,
				endpoint: `${node.name} (${node.file}:${node.start_line})`,
				detail: 'panel dispatch of a ranked optimization candidate',
				metric: 'probe_latency_ms',
				value: candidate ? Math.round(candidate.predicted_ms) : 0,
			},
		},
		candidateCount: 1,
		heldCount: 0,
	};
}

/**
 * Offers/dispatches a prepared plan. The board claim happens in onAccept —
 * the only moment a dispatch is real — so a declined offer leaves every entry
 * 'posted' and eligible. Marking is idempotent, which is what lets the
 * verdict engine's revert-learn-retry loop re-offer the SAME plan without the
 * board blocking its own episode's retries.
 */
async function offerPreparedOptimization(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	plan: OptimizationPlan,
	hooks?: DispatchHooks,
): Promise<boolean> {
	return offerOrDispatch(context, workspaceRoot, plan.task, plan.summary, {
		priorLearning: hooks?.priorLearning,
		onAccept: async () => {
			try {
				markOpportunitiesDispatched(workspaceRoot, plan.boardIds);
			} catch {
				// The board is bookkeeping; a failed write must not lose the episode.
			}
			await hooks?.onAccept?.();
		},
	});
}

/**
 * Memory sweep: symbols that retain memory in EVERY capture session with
 * a positive Theil–Sen trend become a leak-fix episode, seeded with the
 * suspects so the pack's graph slice surrounds the retention sites.
 */
export async function offerEpisodeForMemoryTrends(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<void> {
	let suspects: ReturnType<typeof collectMemoryTrends> = [];
	try {
		suspects = collectMemoryTrends(workspaceRoot, loadNodes(indexStoreDir(workspaceRoot)));
	} catch {
		return;
	}
	if (suspects.length === 0) {
		void vscode.window.showInformationMessage(
			'Vinv: No memory-leak trends — needs 3+ capture sessions where a symbol keeps retaining memory. Run services across several sessions to build the series.',
		);
		return;
	}
	const fmt = (b: number): string =>
		b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)}MB` : `${Math.round(b / 1024)}KB`;
	const lines = suspects.map(
		(s) =>
			`- ${s.name} at ${s.file}:${s.line} — retained ${fmt(s.total_retained_bytes)} across ` +
			`${s.sessions} sessions, growing ${fmt(s.slope_bytes_per_session)}/session (Theil–Sen)`,
	);
	const task: EpisodeTask = {
		kind: 'general',
		trigger: 'smoke-errors',
		title: `Investigate ${suspects.length} memory-leak trend(s)`,
		issue:
			'Across capture sessions, these symbols retain memory EVERY session with a ' +
			'positive robust trend (net mem_delta_bytes per session, Theil–Sen slope):\n\n' +
			lines.join('\n') +
			'\n\nFind what each retains (growing module-level state, unbounded caches, ' +
			'listeners never removed, connections never closed) and fix the retention, ' +
			'not the symptom. Only change what the evidence supports.',
		seedRows: suspects.map((s) => s.row),
		successCriteria: [
			'A fresh capture session shows the listed symbols no longer retaining memory every call',
			'Behavior is unchanged: services start, serve, and raise no new errors',
		],
	};
	await offerOrDispatch(
		context,
		workspaceRoot,
		task,
		`${suspects.length} symbol(s) show growing memory retention across sessions`,
	);
}

/** The user-facing "nothing to dispatch" message for a plan-less prep. */
function noPlanMessage(prep: OptimizationPrep, sweep: 'hotspots' | 'cache_candidates'): string {
	if (prep.heldCount > 0) {
		return (
			`Vinv: All ${prep.heldCount} current ${sweep === 'cache_candidates' ? 'cache ' : ''}` +
			'opportunity(ies) are held on the opportunity board (being worked on, already ' +
			'resolved, or parked after their retry budget) — nothing re-dispatches ' +
			'automatically. Inspect the board with vinv_session action="opportunities".'
		);
	}
	return sweep === 'cache_candidates'
		? 'Vinv: No cache opportunities — no deterministic symbol was observed recomputing identical inputs in the captured traces.'
		: 'Vinv: No optimization opportunities — the analyzer found no recoverable time. Capture a trace first (run a service and exercise it).';
}

/**
 * The verified sweeps and the panel dispatch — every optimization episode
 * flows through the exerciseOptimize verdict engine (paired-bootstrap CI on
 * the frozen probe set, episode-bound after-run, real revert, optimize.jsonl).
 * The plan is prepared ONCE (board consulted, candidates frozen) and the
 * engine's retry loop re-offers that same plan; the board is claimed on the
 * first accepted dispatch. These wrappers are what the commands and the
 * chat-request sweeps invoke.
 */
export async function runVerifiedHotspotEpisode(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	row?: number,
): Promise<void> {
	let prep: OptimizationPrep;
	try {
		prep =
			row !== undefined
				? prepareRowOptimization(workspaceRoot, row)
				: prepareOptimizationSweep(workspaceRoot, 'hotspots');
	} catch {
		prep = NO_PLAN;
	}
	const plan = prep.plan;
	if (!plan) {
		void vscode.window.showInformationMessage(noPlanMessage(prep, 'hotspots'));
		return;
	}
	const result = await runVerifiedOptimization(
		{ label: plan.label, opportunity: plan.opportunity },
		(hooks) => offerPreparedOptimization(context, workspaceRoot, plan, hooks),
		buildWorkspaceDeps(workspaceRoot, { row }),
	);
	announceVerdict(result, plan.label);
}

/** Cache sweep through the same verdict engine (see runVerifiedHotspotEpisode). */
export async function runVerifiedCacheSweep(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<void> {
	let prep: OptimizationPrep;
	try {
		prep = prepareOptimizationSweep(workspaceRoot, 'cache_candidates');
	} catch {
		prep = NO_PLAN;
	}
	const plan = prep.plan;
	if (!plan) {
		void vscode.window.showInformationMessage(noPlanMessage(prep, 'cache_candidates'));
		return;
	}
	const result = await runVerifiedOptimization(
		{ label: plan.label, opportunity: plan.opportunity },
		(hooks) => offerPreparedOptimization(context, workspaceRoot, plan, hooks),
		buildWorkspaceDeps(workspaceRoot, {}),
	);
	announceVerdict(result, plan.label);
}

/** One closing notification per engine-judged episode. */
function announceVerdict(result: OptimizeRunResult, label: string): void {
	if (result.mode !== 'verdict' || !result.comparison) {
		return; // declined (nothing ran) or fallback (watcher reconcile will report)
	}
	const c = result.comparison;
	if (result.action === 'accept') {
		void vscode.window.showInformationMessage(
			`Vinv: "${label}" verified and kept — ${(c.rel_improvement * 100).toFixed(1)}% faster ` +
				`(95% CI [${(c.ci_low * 100).toFixed(1)}%, ${(c.ci_high * 100).toFixed(1)}%], ` +
				'behavior suite intact).',
		);
	} else {
		void vscode.window.showWarningMessage(
			`Vinv: "${label}" did not verify — the change was reverted ` +
				`(${result.behaviorOk ? 'no significant speedup' : 'behavior changed'}; ` +
				'the full evidence is in the Findings view).',
		);
	}
}
