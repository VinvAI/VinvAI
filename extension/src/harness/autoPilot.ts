/**
 * Auto-Pilot — one command that drives a workspace all the way to green:
 * discover (if needed) → set up every listed service (sequential harness
 * bring-ups) → start each under tracing and verify it actually serves → on
 * any failure, dispatch a fix episode to the coding harness, wait for its
 * verdict, and retry the failed step — until every service is green, budgets
 * are exhausted, or the user cancels.
 *
 * All decisions come from the PURE machine in autoPilotMachine.ts (unit
 * tested without vscode); this module only observes workspace facts, performs
 * the chosen action with the EXISTING primitives (runDiscovery,
 * runBringupStartViaHarness, verifyServiceReplay, startService, runEpisode),
 * and feeds outcomes back in. It never reimplements them.
 *
 * Concurrency: the harness is single-flight (one setup OR one episode at a
 * time) — every harness-touching step first waits for isHarnessBusy() and
 * isEpisodeRunning() to clear, so Auto-Pilot interleaves cleanly with manual
 * dispatches instead of racing them.
 */
import * as vscode from 'vscode';
import {
	applySetupOutcome,
	applyStageOutcome,
	decideOnFailure,
	decideOnStageFailure,
	DEFAULT_BUDGETS,
	failureSignature,
	initialPipelineLedger,
	initialServiceState,
	markBlockedOnHarness,
	markGaveUp,
	grantMoreBudget,
	markGreen,
	markNotAService,
	noteSetupAttempt,
	planPipelineAction,
	summarize,
	type AutoPilotBudgets,
	type PilotStep,
	type PipelineLedger,
	type ServiceState,
} from './autoPilotMachine';
import { runProbePass } from './probeRunner';
import { runExercisePass } from './exerciseRunner';
import { maybeAutoEnhance } from '../index/enhanceRunner';
import { publishPipelinePhase } from './pipelineState';
import { enginesReady } from '../engines/install';
import {
	isDiscovering,
	isProjectDiscovered,
	onDiscoveryStateChange,
	runDiscovery,
} from '../index/discovery';
import {
	isServicesListed,
	readBringupOutcome,
	readServices,
	serviceSlug,
} from '../bringup/bringup';
import { isServiceRunning, startService } from '../bringup/serviceRunner';
import {
	getHarness,
	getHarnessBlock,
	isHarnessAutonomous,
	isHarnessBusy,
	preflightHarnessAuth,
	quickScanHarnesses,
	runBringupStartViaHarness,
	type HarnessBlock,
} from './harnessRunner';
import {
	isEpisodeRunning,
	runEpisode,
	verifyServiceReplay,
	type EpisodeTask,
} from './episodeLoop';
import {
	extendAutoPilotBudgets,
	getAutoPilotBudgets,
	getHarnessId,
	isAutoPilotEnabled,
} from '../config/settings';

// ---- run state (single-flight per window) ----------------------------------

let pilotRunning = false;
let pilotLabel = '';
let pilotCts: vscode.CancellationTokenSource | undefined;

const stateEmitter = new vscode.EventEmitter<void>();
/** Fires whenever Auto-Pilot starts, changes step, or finishes — for views. */
export const onAutoPilotStateChange = stateEmitter.event;

/** Live status for the compass / status views. */
export function getAutoPilotStatus(): { running: boolean; label: string } {
	return { running: pilotRunning, label: pilotLabel };
}

/** True while an Auto-Pilot run is in flight for this window. */
export function isAutoPilotRunning(): boolean {
	return pilotRunning;
}

/** Cancels the in-flight run (takes effect at the next step boundary). */
export function cancelAutoPilot(): void {
	pilotCts?.cancel();
}

let channel: vscode.OutputChannel | undefined;
function log(line: string): void {
	channel ??= vscode.window.createOutputChannel('Vinv Auto-Pilot');
	channel.appendLine(`[${new Date().toISOString()}] ${line}`);
}

/** Reveals the Auto-Pilot output channel (the "watch" surface). */
export function showAutoPilotLog(): void {
	channel ??= vscode.window.createOutputChannel('Vinv Auto-Pilot');
	channel.show(true);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One-line "why blocked" for the ledger/summary when the harness cannot run. */
function blockedDetail(block: HarnessBlock | undefined): string {
	const label = getHarness(getHarnessId()).label;
	if (!block) {
		return `${label} cannot run (precondition failure) — fix the agent CLI, then re-run Auto-Pilot`;
	}
	return `${label} ${block.kind === 'auth' ? 'needs login' : block.kind === 'quota' ? 'is out of quota/credits' : 'cannot reach its service'} — ${block.remediation}`;
}

/**
 * Blocks until no harness run or episode is in flight (the one-harness-at-a-
 * time rule covers BOTH). Returns false when cancelled while waiting.
 */
async function waitForHarnessIdle(token: vscode.CancellationToken): Promise<boolean> {
	while (isHarnessBusy() || isEpisodeRunning()) {
		if (token.isCancellationRequested) {
			return false;
		}
		await delay(2000);
	}
	return !token.isCancellationRequested;
}

/**
 * True when the configured harness can run unattended right now — installed
 * AND autonomous (Cursor's chat / Cascade need a human Enter per task, so an
 * unattended Auto-Pilot fix would park a prompt nobody sends).
 */
function harnessCanRunUnattended(): boolean {
	const id = getHarnessId();
	return quickScanHarnesses()[id] === true && isHarnessAutonomous(getHarness(id));
}

/** Builds the per-service ledger from what is on disk right now. */
function buildServiceStates(workspaceRoot: string): ServiceState[] {
	return readServices(workspaceRoot).map((s) =>
		initialServiceState(
			s.name,
			readBringupOutcome(workspaceRoot, s.name).state,
			isServiceRunning(s.name),
		),
	);
}

/** The fix-episode task for a failed step — same shape the auto-triggers use. */
function fixTask(service: string, step: PilotStep, detail: string): EpisodeTask {
	const slug = serviceSlug(service);
	return {
		kind: 'service-fix',
		trigger: 'auto-pilot',
		service,
		title: step === 'setup' ? `Fix bring-up of '${service}'` : `Fix service '${service}'`,
		issue:
			(step === 'setup'
				? `Auto-Pilot could not set up service '${service}': bring-up failed.\n\n`
				: `Auto-Pilot could not run service '${service}': replaying its verified start command failed.\n\n`) +
			`Evidence:\n\`\`\`\n${detail || '(no output captured)'}\n\`\`\`\n\n` +
			'Diagnose whether this is a code bug, a missing dependency, or a wrong start command, ' +
			'fix the root cause, and make the recorded foreground start command work.',
		successCriteria: [
			`.vinv/start_commands/${slug}.json records verified: true with a foreground start command`,
			'That command starts the service, it keeps running, and it accepts connections on its recorded port (when one is recorded)',
			'No new errors appear in the startup output',
			// Load-bearing, not a nicety: without it the cheapest way to make a
			// broken `tracelens run …` command start is to delete the wrapper,
			// which satisfies every criterion above while silently ending tracing.
			// Guidance can be ignored; a criterion is checked.
			'If the command was tracelens-wrapped it still is, and replaying it grows the recorded ' +
				'trace.jsonl beyond zero lines — a green service with no traces does NOT pass',
		],
	};
}

/** Options for a run (auto-started vs. command-invoked). */
export interface AutoPilotRunOptions {
	/** True when discovery just finished and started this run on its own. */
	auto?: boolean;
}

/**
 * Asks whether an exhausted service deserves more effort, returning the number
 * of extra fix episodes to grant (0 = stop). Presented only when a budget
 * actually runs out, so it is never noise: by this point Vinv has already
 * spent every attempt it was allowed and the alternative is silently giving
 * up on the service.
 */
async function offerBudgetTopUp(service: string, reason: string): Promise<number> {
	const MORE = 'Try 3 more';
	const MANY = 'Try 10 more';
	const STOP = 'Stop here';
	const choice = await vscode.window.showWarningMessage(
		`Vinv: out of budget on ${service} — ${reason}. Give it more attempts?`,
		{ modal: false },
		MORE,
		MANY,
		STOP,
	);
	if (choice === MORE) {
		return 3;
	}
	if (choice === MANY) {
		return 10;
	}
	return 0;
}

/**
 * Runs Auto-Pilot for the workspace. Resolves when the run settles (all
 * green, budgets exhausted, cancelled, or nothing to do). Never throws — any
 * step that throws is caught, logged, and counted against the budget.
 */
export async function startAutoPilot(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	options: AutoPilotRunOptions = {},
): Promise<void> {
	if (pilotRunning) {
		void vscode.window.showInformationMessage('Vinv: Auto-Pilot is already running.');
		return;
	}
	// No engines → nothing here can run; point at the real next step instead of
	// failing later inside discovery/bring-up.
	if (!enginesReady(context)) {
		void vscode.window
			.showInformationMessage(
				'Vinv: Auto-Pilot needs the Vinv engines. Install them first, then run Auto-Pilot again.',
				'Install Engines',
			)
			.then((choice) => {
				if (choice === 'Install Engines') {
					void vscode.commands.executeCommand('vinv-vs.installEngines');
				}
			});
		return;
	}

	pilotRunning = true;
	pilotCts = new vscode.CancellationTokenSource();
	const cts = pilotCts;
	log(`Auto-Pilot started (${options.auto ? 'auto after discovery' : 'command'}) for ${workspaceRoot}`);

	if (options.auto) {
		// Unobtrusive: one message with the two things a watcher needs. The
		// progress notification below carries the live per-step state.
		void vscode.window
			.showInformationMessage('Vinv: Auto-Pilot running — click to watch or cancel.', 'Watch', 'Cancel')
			.then((choice) => {
				if (choice === 'Watch') {
					showAutoPilotLog();
				} else if (choice === 'Cancel') {
					cts.cancel();
				}
			});
	}

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Vinv Auto-Pilot',
				cancellable: true,
			},
			async (progress, progressToken) => {
				progressToken.onCancellationRequested(() => cts.cancel());
				const token = cts.token;
				const report = (label: string): void => {
					pilotLabel = label;
					progress.report({ message: label });
					log(label);
					stateEmitter.fire();
				};
				await drive(context, workspaceRoot, token, report);
			},
		);
	} catch (e) {
		// The loop is defensive throughout; this is the last-resort belt so a
		// bug here can never take the extension host down with it.
		log(`Auto-Pilot crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
		void vscode.window.showErrorMessage(
			'Vinv: Auto-Pilot stopped unexpectedly — see the "Vinv Auto-Pilot" output channel.',
		);
	} finally {
		pilotRunning = false;
		pilotLabel = '';
		cts.dispose();
		if (pilotCts === cts) {
			pilotCts = undefined;
		}
		stateEmitter.fire();
	}
}

/** The main loop: plan → act → feed the outcome back → repeat. */
async function drive(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	token: vscode.CancellationToken,
	report: (label: string) => void,
): Promise<void> {
	let budgets: AutoPilotBudgets = getAutoPilotBudgets();
	let discovered = isProjectDiscovered(workspaceRoot);
	let services: ServiceState[] = discovered ? buildServiceStates(workspaceRoot) : [];
	// The post-green ledger: probes → exercise, with the shared fix budgets.
	let ledger: PipelineLedger = initialPipelineLedger();
	const replace = (next: ServiceState): void => {
		services = services.map((s) => (s.name === next.name ? next : s));
	};

	// Once-per-epoch graph enhancement, right after discovery's artifacts are
	// known — the runner itself respects harness single-flight and the
	// per-epoch terminal record, so this is a cheap no-op almost always.
	if (discovered) {
		await maybeAutoEnhance(context, workspaceRoot);
	}

	for (;;) {
		if (token.isCancellationRequested) {
			report('Cancelled');
			publishPipelinePhase('idle');
			finishSummary(services, true);
			return;
		}
		const action = planPipelineAction(discovered, services, ledger);

		if (action.kind === 'done') {
			publishPipelinePhase('done');
			finishSummary(services, false);
			report('Done');
			return;
		}

		// ---- post-green stages: probes, then exercise -------------------------
		// Insights is not scheduled here: pipelineRunners rebuilds it whenever
		// new capture spans land, so running it again just delayed the stages
		// that actually produce evidence.
		if (action.kind === 'probes' || action.kind === 'exercise') {
			const stage = action.kind;
			publishPipelinePhase(stage);
			report(
				stage === 'probes'
					? 'Probing endpoints (I/O checks)…'
					: 'Exercising every endpoint (behavioral coverage)…',
			);
			let outcome: 'done' | 'failed' | 'skipped' = 'failed';
			let failureDetail = '';
			try {
				if (stage === 'exercise') {
					// The exerciser drives EVERY discovered endpoint itself, closing the
					// coverage loop and clustering behavioral failures into the same
					// issue→episode path. A 'done' pass with issues is a stage failure
					// only for RETRY accounting (the pass already dispatched).
					const result = await runExercisePass(context, workspaceRoot);
					outcome = result.outcome;
					failureDetail = result.error ?? '';
					if (outcome === 'done' && result.issues > 0) {
						outcome = 'failed';
						failureDetail = `behavioral issues found: ${result.issues} cluster(s)`;
						report(`Exercised ${result.endpointsCovered}/${result.total} endpoints — ${result.issues} behavioral issue(s), retrying after the fix`);
					} else if (outcome === 'done') {
						report(`Exercised ${result.endpointsCovered}/${result.total} endpoints — ${result.invariants} invariant(s), no issues`);
					}
				} else {
					// The probe pass itself dispatches fix episodes for failing probes
					// (signature-deduped, budget-aware) — so a 'done' pass with
					// failures is a stage failure only for RETRY accounting: the loop
					// re-verifies after the episode instead of dispatching twice.
					const result = await runProbePass(context, workspaceRoot);
					outcome = result.outcome;
					failureDetail = result.error ?? '';
					if (outcome === 'done' && result.failed > 0) {
						outcome = 'failed';
						failureDetail = `probes failed: ${result.failedIds.sort().join(', ')}`;
						report(`${result.failed}/${result.total} probe(s) failed — retrying after the fix`);
					} else if (outcome === 'done') {
						report(`Probes passed — ${result.total} endpoint check(s) green`);
					}
				}
			} catch (e) {
				outcome = 'failed';
				failureDetail = e instanceof Error ? e.message : String(e);
				log(`stage '${stage}' threw: ${failureDetail}`);
			}
			if (outcome !== 'failed') {
				ledger = applyStageOutcome(ledger, stage, outcome);
				if (outcome === 'skipped') {
					report(`${stage} skipped${failureDetail ? ` — ${failureDetail}` : ''}`);
				}
				continue;
			}
			const signature = failureSignature(stage, failureDetail);
			const { ledger: next, decision } = decideOnStageFailure(ledger, stage, signature, budgets);
			ledger = next;
			if (decision.next === 'give-up') {
				report(`Giving up on ${stage} — ${decision.reason}`);
				log(`  last ${stage} failure: ${failureDetail.slice(0, 2000)}`);
			}
			// decision 'fix': the stage is back to 'pending' with the spend
			// recorded; the pass-internal dispatch already ran (or will on the
			// retry), so the loop simply re-enters the stage.
			continue;
		}

		if (action.kind === 'discover') {
			publishPipelinePhase('discovering');
			report('Discovering the project…');
			try {
				if (isDiscovering()) {
					// A discovery someone else started — wait for it rather than racing.
					while (isDiscovering() && !token.isCancellationRequested) {
						await delay(2000);
					}
				} else {
					await runDiscovery(context, workspaceRoot);
				}
			} catch (e) {
				log(`discovery threw: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (token.isCancellationRequested) {
				continue; // top of loop reports the cancel
			}
			discovered = isProjectDiscovered(workspaceRoot);
			if (!discovered || !isServicesListed(workspaceRoot)) {
				report('Discovery did not complete');
				void vscode.window.showWarningMessage(
					'Vinv: Auto-Pilot stopped — discovery did not produce an index, handbook, and service list. Fix discovery (Project view → Re-discover), then run Auto-Pilot again.',
				);
				return;
			}
			services = buildServiceStates(workspaceRoot);
			// Fresh index → resolve its ambiguous references once for this epoch
			// (terminal per epoch; single-flight respected inside the runner).
			await maybeAutoEnhance(context, workspaceRoot);
			continue;
		}

		publishPipelinePhase('services');
		const svc = services.find((s) => s.name === action.service);
		if (!svc) {
			continue; // defensive: plan and ledger disagree — replan
		}

		// ---- one step, fully guarded ------------------------------------------
		let failureDetail: string | null = null;
		try {
			if (action.kind === 'setup') {
				report(`Setting up ${svc.name} (attempt ${svc.setupAttempts + 1}/${budgets.setupAttempts})…`);
				if (!(await waitForHarnessIdle(token))) {
					continue;
				}
				// Infra preflight BEFORE the attempt is counted: a signed-out CLI
				// cannot set anything up, and burning setup attempts discovering
				// that would also swallow the budget the human needs after login.
				if ((await preflightHarnessAuth(getHarnessId())) !== 'ok') {
					const block = getHarnessBlock(getHarnessId());
					replace(markBlockedOnHarness(svc, blockedDetail(block)));
					report(`${svc.name} blocked — ${blockedDetail(block)}`);
					continue;
				}
				replace(noteSetupAttempt(svc));
				const entry = readServices(workspaceRoot).find((s) => s.name === svc.name);
				if (!entry) {
					replace(markGaveUp(svc, 'service disappeared from .vinv/services.json'));
					continue;
				}
				await runBringupStartViaHarness(context, getHarnessId(), workspaceRoot, entry, undefined, token);
				const outcome = readBringupOutcome(workspaceRoot, svc.name);
				const current = services.find((s) => s.name === svc.name) ?? svc;
				replace(applySetupOutcome(current, outcome.state, 'symptom' in outcome ? outcome.symptom : undefined));
				if (outcome.state === 'verified') {
					report(`${svc.name} set up — start command verified`);
					continue;
				}
				if (outcome.state === 'library') {
					report(`${svc.name} is a library — nothing to run`);
					continue;
				}
				failureDetail =
					('symptom' in outcome ? outcome.symptom : undefined) ??
					'bring-up recorded no verified start command and no symptom';
			} else {
				// action.kind === 'start'
				if (isServiceRunning(svc.name)) {
					replace(markGreen(svc, 'already running'));
					report(`${svc.name} is already running`);
					continue;
				}
				report(`Verifying ${svc.name} serves (replaying its start command)…`);
				// The bring-up contract's own oracle: replay the recorded command,
				// require the port to accept (or a portless survivor past the learned
				// grace), then tear the replay down.
				const verify = await verifyServiceReplay(workspaceRoot, svc.name, token);
				if (token.isCancellationRequested) {
					continue;
				}
				if (verify.notAService) {
					// Affirmative CLI evidence: terminal skip, never a retry loop.
					replace(markNotAService(svc, verify.reason));
					report(`${svc.name} skipped — ${verify.reason}`);
					continue;
				}
				if (verify.verdict === 'pass') {
					// Healthy — now leave it running under tracing for real (the
					// recorded command wraps the tracer, so this run streams traces).
					report(`Starting ${svc.name} under tracing…`);
					startService(workspaceRoot, svc.name);
					replace(markGreen(svc, verify.reason));
					report(`${svc.name} is green — ${verify.reason}`);
					continue;
				}
				failureDetail = `${verify.reason}${verify.outputTail ? `\n\nOutput tail:\n${verify.outputTail}` : ''}`;
			}
		} catch (e) {
			// A thrown step is a failure like any other: logged, budgeted, retried.
			failureDetail = e instanceof Error ? e.message : String(e);
			log(`step '${action.kind}' for ${svc.name} threw: ${failureDetail}`);
		}

		// ---- failure path: budget check → fix episode → retry ------------------
		const step: PilotStep = action.kind === 'setup' ? 'setup' : 'start';
		const current = services.find((s) => s.name === svc.name) ?? svc;
		// Harness precondition failure (needs login / quota / network — the
		// runner classified it and set the session block): terminal for this
		// run WITHOUT consuming any fix budget, and no fix episode is
		// dispatched — an unauthenticated CLI cannot fix anything. The next
		// run, after the human acts, starts with the budgets intact.
		const preBlock = getHarnessBlock(getHarnessId());
		if (preBlock) {
			replace(markBlockedOnHarness(current, blockedDetail(preBlock)));
			report(`${svc.name} blocked — ${blockedDetail(preBlock)}`);
			continue;
		}
		const signature = failureSignature(step, failureDetail ?? '');
		const { state: budgeted, decision } = decideOnFailure(current, step, signature, budgets);
		if (decision.next === 'give-up') {
			// Budget exhausted is a question, not a verdict: the human decides
			// whether this service is worth more effort. Answering raises the
			// stored budgets, so the same service does not re-ask next run.
			const extra = await offerBudgetTopUp(svc.name, decision.reason);
			if (extra > 0) {
				extendAutoPilotBudgets(extra);
				budgets = getAutoPilotBudgets();
				// Reset what this service has already spent — a higher ceiling
				// over exhausted counters would give up again immediately.
				replace(grantMoreBudget(budgeted));
				report(`Budget raised for ${svc.name} — retrying with ${extra} more attempts.`);
				log(`  budget top-up: +${extra} (now ${JSON.stringify(budgets)})`);
				continue;
			}
			replace(markGaveUp(budgeted, decision.reason));
			report(`Giving up on ${svc.name} — ${decision.reason}`);
			log(`  last failure: ${(failureDetail ?? '').slice(0, 2000)}`);
			continue;
		}
		replace(budgeted);
		if (!harnessCanRunUnattended()) {
			replace(
				markGaveUp(
					budgeted,
					'a fix episode is needed, but the selected coding harness cannot run unattended — pick a CLI harness in Configure, or fix manually',
				),
			);
			report(`Giving up on ${svc.name} — no unattended harness for the fix`);
			continue;
		}
		report(`Dispatching a fix episode for ${svc.name}…`);
		log(`  failure (${signature}): ${(failureDetail ?? '').slice(0, 2000)}`);
		if (!(await waitForHarnessIdle(token))) {
			continue;
		}
		try {
			const verified = await runEpisode(
				context,
				workspaceRoot,
				fixTask(svc.name, step, failureDetail ?? ''),
			);
			// The episode itself may have been the first to discover the harness
			// precondition failure — then retrying the step is pointless: mark
			// the service blocked-on-you and move on (budgets stay as they are).
			const postBlock = getHarnessBlock(getHarnessId());
			if (postBlock) {
				const blocked = services.find((s) => s.name === svc.name) ?? budgeted;
				replace(markBlockedOnHarness(blocked, blockedDetail(postBlock)));
				report(`${svc.name} blocked — ${blockedDetail(postBlock)}`);
				continue;
			}
			report(
				verified
					? `Fix episode for ${svc.name} verified — retrying ${step}`
					: `Fix episode for ${svc.name} did not verify — retrying ${step} anyway`,
			);
		} catch (e) {
			log(`fix episode for ${svc.name} threw: ${e instanceof Error ? e.message : String(e)}`);
		}
		// Loop retries the failed step: the service is still needs-setup /
		// needs-start, so planNextAction re-selects it.
	}
}

/** Posts the end-of-run summary notification and logs the details. */
function finishSummary(services: ServiceState[], cancelled: boolean): void {
	const { green, library, gaveUp } = summarize(services);
	const parts: string[] = [`${green.length} service(s) green`];
	if (gaveUp.length) {
		parts.push(`${gaveUp.length} gave up`);
	}
	if (library.length) {
		parts.push(`${library.length} skipped (library)`);
	}
	const headline = `Vinv Auto-Pilot ${cancelled ? 'cancelled' : 'finished'}: ${parts.join(', ')}.`;
	log(headline);
	for (const s of green) {
		log(`  green: ${s.name}${s.reason ? ` — ${s.reason}` : ''}`);
	}
	for (const s of library) {
		log(`  library: ${s.name}${s.reason ? ` — ${s.reason}` : ''}`);
	}
	for (const s of gaveUp) {
		log(`  gave up: ${s.name} — ${s.reason ?? 'unknown'}`);
	}
	const show = gaveUp.length
		? vscode.window.showWarningMessage(
				`${headline} ${gaveUp.map((s) => `${s.name}: ${s.reason ?? 'unknown'}`).join(' · ')}`,
				'Show Log',
			)
		: vscode.window.showInformationMessage(headline, 'Show Log');
	void show.then((choice) => {
		if (choice === 'Show Log') {
			showAutoPilotLog();
		}
	});
}

/**
 * Wires the opt-in-by-default flow: when discovery completes for the open
 * workspace and services are listed, Auto-Pilot starts on its own (autoPilot
 * toggle, default true). Detached so discovery's own lifecycle finishes
 * cleanly; guarded against re-entry and against runs Auto-Pilot itself
 * triggered (its discover step ends in the same 'done' state).
 */
export function registerAutoPilotAutoStart(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		onDiscoveryStateChange((state) => {
			if (state.phase !== 'done' || !isAutoPilotEnabled() || isAutoPilotRunning()) {
				return;
			}
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root || !isServicesListed(root)) {
				return;
			}
			// Detach: let runDiscovery's finally block release its own state first.
			setTimeout(() => {
				if (!isAutoPilotRunning()) {
					void startAutoPilot(context, root, { auto: true });
				}
			}, 0);
		}),
	);
}
