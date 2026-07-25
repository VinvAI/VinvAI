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
	collectCacheCandidates,
	collectMemoryTrends,
	collectRuntimeErrorClusters,
	selectHotspots,
	type ErrorCluster,
	type Hotspot,
} from './runtimeAnalysis';

// The pure analyses live in runtimeAnalysis.ts (vscode-free, shared with the
// MCP server); re-exported here so existing imports and tests keep working.
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

/**
 * Self-driven performance sweep: reads the runtime overlay, extracts the
 * Pareto head of traced time, and dispatches (or offers) an optimization
 * episode. The pack carries the evidence — per-symbol time, call counts,
 * share — and asks the agent to decide per hotspot whether the win is a
 * better algorithm, caching, or making the call async/parallel; the replay
 * gate plus a fresh trace verify the app still works and got faster.
 */
export async function offerEpisodeForHotspots(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	hooks?: DispatchHooks,
): Promise<boolean> {
	let hotspots: Hotspot[] = [];
	try {
		const nodes = loadNodes(indexStoreDir(workspaceRoot));
		hotspots = selectHotspots(nodes, loadRuntimeOverlay(workspaceRoot, nodes));
	} catch {
		return false;
	}
	if (hotspots.length === 0) {
		void vscode.window.showInformationMessage(
			'Vinv: No latency hotspots — capture a trace first (run a service and exercise it).',
		);
		return false;
	}
	const lines = hotspots.map(
		(h) =>
			`- ${h.name} at ${h.file}:${h.line} — ${Math.round(h.total_ms)}ms total across ` +
			`${h.calls} call(s) (${(h.share * 100).toFixed(1)}% of all traced time)`,
	);
	const task: EpisodeTask = {
		kind: 'general',
		trigger: 'smoke-errors',
		title: `Optimize ${hotspots.length} latency hotspot(s)`,
		issue:
			'The captured runtime trace concentrates its time in these symbols ' +
			'(Pareto head of traced time):\n\n' +
			lines.join('\n') +
			'\n\nFor each: decide whether the win is a better algorithm, caching, ' +
			'batching, or making the work async/parallel — and only change what the ' +
			'evidence supports. Re-run the same flow afterwards to show the time dropped.',
		seedRows: hotspots.map((h) => h.row),
		successCriteria: [
			'The listed symbols spend measurably less total time on the same exercised flow',
			'Behavior is unchanged: the service still starts, serves, and raises no new errors',
		],
	};
	return offerOrDispatch(
		context,
		workspaceRoot,
		task,
		`the trace concentrates ${(hotspots.reduce((s, h) => s + h.share, 0) * 100).toFixed(0)}% of runtime in ${hotspots.length} symbol(s)`,
		hooks,
	);
}

/**
 * Scoped sibling of offerEpisodeForHotspots: dispatches an optimization episode
 * for ONE symbol (the row the user clicked in the Optimization panel). A
 * single-symbol pack is smaller, faster, and — the point of the predicted→proven
 * loop — cleanly attributable: the after-run's measured delta belongs to this
 * one change, not a batch. Falls back to the whole-Pareto sweep when the row
 * carries no runtime evidence (nothing to scope to).
 */
export async function offerEpisodeForHotspot(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	row: number,
	hooks?: DispatchHooks,
): Promise<boolean> {
	let node: { name: string; file: string; start_line: number } | undefined;
	let totalMs = 0;
	let calls = 0;
	try {
		const nodes = loadNodes(indexStoreDir(workspaceRoot));
		const overlay = loadRuntimeOverlay(workspaceRoot, nodes);
		node = nodes[row];
		const rt = overlay[row];
		totalMs = rt?.total_ms ?? 0;
		calls = rt?.calls ?? 0;
	} catch {
		return false;
	}
	if (!node) {
		// Row is not resolvable against the current store — do the safe thing.
		return offerEpisodeForHotspots(context, workspaceRoot, hooks);
	}
	const task: EpisodeTask = {
		kind: 'general',
		trigger: 'smoke-errors',
		title: `Optimize ${node.name}`,
		issue:
			`The captured runtime trace spends significant time in \`${node.name}\` ` +
			`at ${node.file}:${node.start_line}` +
			(totalMs > 0 ? ` — ${Math.round(totalMs)}ms across ${calls} call(s).` : '.') +
			'\n\nDecide whether the win is a better algorithm, caching, batching, or ' +
			'making the work async/parallel — and change only what the evidence ' +
			'supports. Do not alter behavior. Re-run the same flow afterwards so a ' +
			'fresh trace can show the time dropped.',
		seedRows: [row],
		successCriteria: [
			`\`${node.name}\` spends measurably less total time on the same exercised flow`,
			'Behavior is unchanged: the service still starts, serves, and raises no new errors',
		],
	};
	return offerOrDispatch(
		context,
		workspaceRoot,
		task,
		`optimize ${node.name}${totalMs > 0 ? ` (${Math.round(totalMs)}ms in the trace)` : ''}`,
		hooks,
	);
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

/**
 * Cache sweep: symbols repeatedly called with identical argument hashes
 * (and no recorded nondeterminism) waste recomputable time — the Pareto head
 * of reclaimable time is dispatched as a memoization episode.
 */
export async function offerEpisodeForCacheCandidates(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	hooks?: DispatchHooks,
): Promise<boolean> {
	let candidates: ReturnType<typeof collectCacheCandidates> = [];
	try {
		candidates = collectCacheCandidates(workspaceRoot, loadNodes(indexStoreDir(workspaceRoot)));
	} catch {
		return false;
	}
	if (candidates.length === 0) {
		void vscode.window.showInformationMessage(
			'Vinv: No cache opportunities — no deterministic symbol was re-called with identical arguments in the captured traces.',
		);
		return false;
	}
	const lines = candidates.map(
		(c) =>
			`- ${c.name} at ${c.file}:${c.line} — ${c.calls} calls but only ${c.distinct_args} ` +
			`distinct argument hash(es); ~${Math.round(c.reclaimable_ms)}ms reclaimable ` +
			`(${(c.share * 100).toFixed(1)}% of all duplicated work)`,
	);
	const task: EpisodeTask = {
		kind: 'general',
		trigger: 'smoke-errors',
		title: `Cache ${candidates.length} recomputation site(s)`,
		issue:
			'The captured traces show these symbols recomputing identical inputs ' +
			'(same args_hash, no recorded nondeterminism):\n\n' +
			lines.join('\n') +
			'\n\nDecide per symbol whether memoization is safe (watch invalidation and ' +
			'unbounded growth — prefer bounded/keyed caches) and implement only where ' +
			'the evidence supports it.',
		seedRows: candidates.map((c) => c.row),
		successCriteria: [
			'A fresh trace of the same flow shows fewer duplicate-argument recomputations or lower total time in the listed symbols',
			'Behavior is unchanged: same results, no new errors, memory stays bounded',
		],
	};
	return offerOrDispatch(
		context,
		workspaceRoot,
		task,
		`~${Math.round(candidates.reduce((s, c) => s + c.reclaimable_ms, 0))}ms of traced time is duplicate recomputation in ${candidates.length} symbol(s)`,
		hooks,
	);
}

/**
 * The verified sweeps and the panel dispatch — every optimization episode
 * flows through the exerciseOptimize verdict engine (paired-bootstrap CI on
 * the frozen probe set, episode-bound after-run, real revert, optimize.jsonl).
 * These wrappers compose the existing offer/dispatch flows with the engine;
 * they are what the commands and the chat-request sweeps invoke.
 */
export async function runVerifiedHotspotEpisode(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	row?: number,
): Promise<void> {
	let label = 'Optimize latency hotspots';
	let opportunity: OptimizeOpportunity = {
		kind: 'hotspot-sweep',
		endpoint_id: 'hotspots',
		endpoint: 'traced latency hotspots',
		detail: 'Pareto head of traced time dispatched as one optimization episode',
		metric: 'probe_latency_ms',
		value: 0,
	};
	if (row !== undefined) {
		try {
			const n = loadNodes(indexStoreDir(workspaceRoot))[row];
			if (n) {
				label = `Optimize ${n.name}`;
				opportunity = {
					kind: 'latency-symbol',
					endpoint_id: n.name,
					endpoint: `${n.name} (${n.file}:${n.start_line})`,
					detail: 'panel dispatch of a ranked optimization candidate',
					metric: 'probe_latency_ms',
					value: 0,
				};
			}
		} catch {
			// Store unreadable — keep the generic labels; the offer flow re-checks.
		}
	}
	const result = await runVerifiedOptimization(
		{ label, opportunity },
		(hooks) =>
			row !== undefined
				? offerEpisodeForHotspot(context, workspaceRoot, row, hooks)
				: offerEpisodeForHotspots(context, workspaceRoot, hooks),
		buildWorkspaceDeps(workspaceRoot, { row }),
	);
	announceVerdict(result, label);
}

/** Cache sweep through the same verdict engine (see runVerifiedHotspotEpisode). */
export async function runVerifiedCacheSweep(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<void> {
	const label = 'Cache recomputation sites';
	const result = await runVerifiedOptimization(
		{
			label,
			opportunity: {
				kind: 'cache-sweep',
				endpoint_id: 'cache-candidates',
				endpoint: 'duplicate-recomputation sites',
				detail: 'Pareto head of reclaimable duplicated work dispatched as a memoization episode',
				metric: 'probe_latency_ms',
				value: 0,
			},
		},
		(hooks) => offerEpisodeForCacheCandidates(context, workspaceRoot, hooks),
		buildWorkspaceDeps(workspaceRoot, {}),
	);
	announceVerdict(result, label);
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
