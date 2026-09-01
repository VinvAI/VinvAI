/**
 * Auto-Pilot's decision core — PURE functions only (no vscode, no fs, no
 * process state), so every branch of the drive-to-green policy is unit
 * testable without an extension host. The orchestrator (autoPilot.ts) owns
 * all side effects: it observes workspace facts, asks these functions what to
 * do next, performs the action, and feeds the outcome back in.
 *
 * The machine per workspace:
 *
 *   discover (if needed)
 *     → for each listed service without a verified start command: setup
 *     → for each set-up service: start under tracing + verify it serves
 *     → green
 *
 * Any step failure spends budget: a fix episode is dispatched (deduplicated
 * by content-derived failure signature, same hashing family as the
 * error-cluster dedup), the step is retried after the verdict, and a service
 * whose budgets are exhausted is given up on — never looped forever.
 */
import * as crypto from 'crypto';

/** Where one service currently sits in the drive-to-green ladder. */
export type ServicePhase =
	/** No verified start command yet — the next action is a harness setup. */
	| 'needs-setup'
	/** Setup verified — the next action is start-under-tracing + health check. */
	| 'needs-start'
	/** Started and verified serving (or already running) — terminal success. */
	| 'green'
	/** The bring-up agent proved there is nothing to run — terminal, not a failure. */
	| 'library'
	/** Budgets exhausted or unfixable — terminal failure, reason recorded. */
	| 'gave-up';

/** Auto-Pilot's per-service ledger: phase plus the budgets already spent. */
export interface ServiceState {
	name: string;
	phase: ServicePhase;
	/** Harness setup attempts spent (initial try + retries). */
	setupAttempts: number;
	/** Fix episodes spent, keyed by failure signature (the dedup). */
	fixEpisodes: Record<string, number>;
	/** Why the service is library/gave-up/green — the summary line. */
	reason?: string;
}

/** Retry budgets, injectable so tests can shrink them. */
export interface AutoPilotBudgets {
	/** Max harness setup attempts per service (default 3). */
	setupAttempts: number;
	/** Max fix episodes per distinct failure signature (default 2). */
	fixEpisodesPerSignature: number;
	/**
	 * Absolute cap on fix episodes per service across ALL signatures — the
	 * guard against a failure whose signature shifts every attempt (timestamps
	 * the normalizer misses, alternating errors) draining episodes forever.
	 */
	totalFixEpisodes: number;
}

export const DEFAULT_BUDGETS: AutoPilotBudgets = {
	setupAttempts: 3,
	fixEpisodesPerSignature: 2,
	totalFixEpisodes: 6,
};

/** The single next thing Auto-Pilot should do. */
export type PilotAction =
	| { kind: 'discover' }
	| { kind: 'setup'; service: string }
	| { kind: 'start'; service: string }
	| { kind: 'done' };

/** Which step a failure happened in (drives budget accounting). */
export type PilotStep = 'setup' | 'start' | 'probes' | 'exercise';

/** What to do about a failed step. */
export type FailureDecision =
	/** Dispatch a fix episode for this signature, then retry the step. */
	| { next: 'fix' }
	/** Budgets exhausted — mark the service gave-up with this reason. */
	| { next: 'give-up'; reason: string };

/**
 * Content-derived signature for one failure, stable across retries: digits
 * are normalized (ports, pids, durations, timestamps all vary run-to-run
 * without changing what is broken) and whitespace collapsed before hashing —
 * same family as the error-cluster / test-swarm dedup (sha256 prefix).
 */
export function failureSignature(step: PilotStep, detail: string): string {
	const normalized = `${step} ${detail
		.replace(/\d+/g, '#')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
		.slice(0, 600)}`;
	return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

/**
 * Builds a service's starting state from the observable facts the
 * orchestrator reads off disk:
 *   - `setup`: the recorded bring-up outcome ('verified' | 'library' |
 *     'failed' | 'unattempted' — the readBringupOutcome states)
 *   - `running`: whether the service already has a live traced session.
 *
 * A previously FAILED bring-up re-enters as needs-setup — retrying it (with
 * fixes) is exactly Auto-Pilot's job. A 'library' outcome is honored as
 * terminal: the agent proved there is nothing to run.
 */
export function initialServiceState(
	name: string,
	setup: 'verified' | 'library' | 'failed' | 'unattempted',
	running: boolean,
): ServiceState {
	const base: ServiceState = { name, phase: 'needs-setup', setupAttempts: 0, fixEpisodes: {} };
	if (setup === 'library') {
		return { ...base, phase: 'library', reason: 'library module — nothing to run' };
	}
	if (setup === 'verified') {
		return running
			? { ...base, phase: 'green', reason: 'already running' }
			: { ...base, phase: 'needs-start' };
	}
	return base;
}

/**
 * The scheduler: given whether the workspace is discovered and every
 * service's state, name the single next action. Setups drain before any
 * start (the harness is single-flight and setups are the scarce, serialized
 * resource; starts are cheap once commands are recorded). Terminal phases
 * (green / library / gave-up) never re-enter.
 */
export function planNextAction(discovered: boolean, services: ServiceState[]): PilotAction {
	if (!discovered) {
		return { kind: 'discover' };
	}
	const toSetup = services.find((s) => s.phase === 'needs-setup');
	if (toSetup) {
		return { kind: 'setup', service: toSetup.name };
	}
	const toStart = services.find((s) => s.phase === 'needs-start');
	if (toStart) {
		return { kind: 'start', service: toStart.name };
	}
	return { kind: 'done' };
}

/** Records one setup attempt having been SPENT (call before running it). */
export function noteSetupAttempt(svc: ServiceState): ServiceState {
	return { ...svc, setupAttempts: svc.setupAttempts + 1 };
}

/**
 * Applies a finished setup attempt's recorded outcome. 'failed' leaves the
 * service in needs-setup — the caller then consults decideOnFailure for
 * whether to fix-and-retry or give up.
 */
export function applySetupOutcome(
	svc: ServiceState,
	outcome: 'verified' | 'library' | 'failed' | 'unattempted',
	symptom?: string,
): ServiceState {
	if (outcome === 'verified') {
		return { ...svc, phase: 'needs-start', reason: undefined };
	}
	if (outcome === 'library') {
		return {
			...svc,
			phase: 'library',
			reason: symptom ? `library module — ${symptom}` : 'library module — nothing to run',
		};
	}
	// failed or (still) unattempted: stays needs-setup; the failure decision
	// (fix / give up) is a separate, budget-aware question.
	return { ...svc, phase: 'needs-setup' };
}

/** Marks a service green (started and verified serving). */
export function markGreen(svc: ServiceState, reason: string): ServiceState {
	return { ...svc, phase: 'green', reason };
}

/** Marks a service given-up with the reason the summary will show. */
export function markGaveUp(svc: ServiceState, reason: string): ServiceState {
	return { ...svc, phase: 'gave-up', reason };
}

/**
 * Marks a service blocked on a harness PRECONDITION failure (CLI needs login,
 * quota exhausted, vendor unreachable). Terminal for THIS run — the human must
 * act — but crucially it consumes NOTHING: no setup attempt, no fix episode,
 * no per-signature spend. The next Auto-Pilot run (after `cursor-agent login`
 * or the like) starts the service with its budgets intact.
 */
export function markBlockedOnHarness(svc: ServiceState, detail: string): ServiceState {
	return { ...svc, phase: 'gave-up', reason: `blocked on you: ${detail}` };
}

/**
 * The harness precondition, decided before a run starts — the peer of the
 * engines gate. Auto-Pilot dispatches EVERY stage to the coding agent, so a
 * run begun without a usable one does not fail up front: it grinds the whole
 * service list into give-ups. The subtlety this encodes is that "no harness
 * chosen" and "chose the default" are indistinguishable downstream — the id
 * accessor falls back to claude-code and cannot report "unset" — so the gate
 * takes `chosen` as its own input rather than inferring it from the id.
 *
 * 'proceed': a harness was explicitly chosen AND is present right now.
 * 'ask': prompt the human — either they never chose, or what they chose is
 * gone (uninstalled, renamed binary, chat extension removed).
 */
export type HarnessGate = 'proceed' | 'ask';

export function decideHarnessGate(chosen: boolean, present: boolean): HarnessGate {
	return chosen && present ? 'proceed' : 'ask';
}

/**
 * What to do with the answer to that prompt. Kept separate from the picker so
 * the policy is testable without a QuickPick: the picker installs what it can
 * before it resolves, so a pick that is STILL absent means the install is
 * mid-flight (or the harness has no installer) — a stop, not a silent start
 * against an agent that is not there.
 *
 * 'stop-unpicked': dismissed; 'stop-absent': picked but not present yet.
 */
export type HarnessPickOutcome = 'proceed' | 'stop-unpicked' | 'stop-absent';

export function decideAfterHarnessPick(
	picked: string | null,
	present: boolean,
): HarnessPickOutcome {
	if (!picked) {
		return 'stop-unpicked';
	}
	return present ? 'proceed' : 'stop-absent';
}

/**
 * Marks a service as not-a-service: the replay ran to completion cleanly, so
 * this is a CLI/script misclassified as a service. Terminal like 'library' —
 * it must never re-enter setup or consume fix budgets (the historical
 * get-stuck mode was retrying exactly these).
 */
export function markNotAService(svc: ServiceState, reason: string): ServiceState {
	return { ...svc, phase: 'library', reason };
}

/** Total fix episodes this service has spent across all signatures. */
function totalFixes(svc: ServiceState): number {
	return Object.values(svc.fixEpisodes).reduce((a, b) => a + b, 0);
}

/**
 * The budget policy for one failed step. Returns the updated state (fix
 * spend recorded) plus the decision:
 *
 *   - a SETUP failure that has consumed every setup attempt → give up;
 *   - a failure whose signature already spent its per-signature fix budget →
 *     give up (another identical episode would re-derive the same non-fix);
 *   - a service at the absolute fix cap → give up (signature-shifting guard);
 *   - otherwise → spend one fix episode on this signature, then retry.
 *
 * Note setup attempts are counted by noteSetupAttempt when the attempt is
 * made — this function only reads them.
 */
export function decideOnFailure(
	svc: ServiceState,
	step: PilotStep,
	signature: string,
	budgets: AutoPilotBudgets = DEFAULT_BUDGETS,
): { state: ServiceState; decision: FailureDecision } {
	if (step === 'setup' && svc.setupAttempts >= budgets.setupAttempts) {
		return {
			state: svc,
			decision: {
				next: 'give-up',
				reason: `setup failed ${svc.setupAttempts}x (budget ${budgets.setupAttempts})`,
			},
		};
	}
	const spentOnSignature = svc.fixEpisodes[signature] ?? 0;
	if (spentOnSignature >= budgets.fixEpisodesPerSignature) {
		return {
			state: svc,
			decision: {
				next: 'give-up',
				reason: `the same failure persisted through ${spentOnSignature} fix episode(s) (budget ${budgets.fixEpisodesPerSignature} per failure)`,
			},
		};
	}
	if (totalFixes(svc) >= budgets.totalFixEpisodes) {
		return {
			state: svc,
			decision: {
				next: 'give-up',
				reason: `${totalFixes(svc)} fix episodes spent without going green (absolute cap ${budgets.totalFixEpisodes})`,
			},
		};
	}
	return {
		state: {
			...svc,
			fixEpisodes: { ...svc.fixEpisodes, [signature]: spentOnSignature + 1 },
		},
		decision: { next: 'fix' },
	};
}

// ---- post-green pipeline stages (probes → exercise) -------------------------

/** Lifecycle of one workspace-level pipeline stage. */
export type StagePhase = 'pending' | 'done' | 'failed' | 'skipped';

/**
 * The workspace-level ledger for the stages that run AFTER services are green:
 * the auto-insight build (calltrees + smoke reports + issue identification)
 * and the endpoint I/O probe run. Budgets share the fix-episode accounting the
 * per-service ledger uses (per-signature dedup + absolute cap), so a probe
 * failure loops through exactly the same fix machinery as a start failure.
 */
export interface PipelineLedger {
	probes: StagePhase;
	/**
	 * The behavioral-exercise stage: after probes, the exerciser plans, executes,
	 * profiles and learns invariants for EVERY discovered endpoint (not just the
	 * ones traffic happened to hit). Same fix-episode budget accounting as the
	 * other stages.
	 */
	exercise: StagePhase;
	/** Fix episodes spent on stage failures, keyed by failure signature. */
	fixEpisodes: Record<string, number>;
	/**
	 * Whether probes have already been re-armed once after exercise produced the
	 * workspace's first endpoint traffic. Bounds the re-arm to a single extra
	 * attempt — see rearmProbesAfterExercise.
	 */
	probesRearmed?: boolean;
}

/** A fresh ledger: all post-green stages pending. */
export function initialPipelineLedger(): PipelineLedger {
	return { probes: 'pending', exercise: 'pending', fixEpisodes: {} };
}

/**
 * Give probes a second chance once exercise has produced traffic to replay.
 *
 * The scheduler runs probes BEFORE exercise, and on a cold workspace that order
 * can never work: probes replay requests a trace already saw, exercise is what
 * CREATES the first ones. So the first run always went probes → 'skipped'
 * (nothing observed) → exercise → traffic at last exists → and probes was
 * already terminal, so it never ran. Every first pipeline run burned the stage
 * and left "no observed endpoints to probe" as the only trace of it; you needed
 * a second Auto-Pilot run before probes did anything at all.
 *
 * Deliberately narrow:
 *   - only a stage that SKIPPED is re-armed. 'failed' means it ran and found
 *     real problems, which the fix-episode budget already governs; 'done' means
 *     it did its job.
 *   - only when exercise actually finished ('done'). A failed or skipped
 *     exercise has produced no new traffic, so probes would skip again.
 *   - once per run, via `probesRearmed`. Without the flag, probes skipping a
 *     second time (a service that serves nothing) would re-arm forever.
 */
export function rearmProbesAfterExercise(ledger: PipelineLedger): PipelineLedger {
	if (ledger.probesRearmed || ledger.probes !== 'skipped' || ledger.exercise !== 'done') {
		return ledger;
	}
	return { ...ledger, probes: 'pending', probesRearmed: true };
}

/** The next thing the FULL pipeline (services + post-green stages) should do. */
export type PipelineAction = PilotAction | { kind: 'probes' } | { kind: 'exercise' };

/**
 * The full-pipeline scheduler: services drain first (planNextAction), then the
 * post-green stages.
 *
 * `probes` genuinely requires a live traced session — it reads what a running
 * service recorded, so with nothing green there is nothing to read. `exercise`
 * does NOT: its crash, differential, fault and concurrency oracles drive code in
 * workers from the source and the index, and need no port, no process and no
 * traffic. Gating it on `anyGreen` too meant a workspace of libraries did nothing
 * at all after discovery — on a clone of langchain, Auto-Pilot fired zero
 * oracles. (The 511-target/1,944-call figure quoted for that repo comes from the
 * standalone `functions` command with a raised `--max-targets`; this stage runs
 * `campaign`, whose per-oracle cap is 50. The point is the same and the scale is
 * not.) A library is not "nothing to observe"; it is nothing to SERVE.
 *
 * Insights is NOT a stage here: pipelineRunners rebuilds it on its own whenever
 * new capture spans land, so scheduling it again was redundant work on the
 * critical path to the stages that actually produce evidence.
 *
 * Terminal stage phases (done/failed/skipped) never re-enter; failures are
 * retried via decideOnStageFailure, which flips the stage back to 'pending'
 * while budget remains.
 */
/**
 * True when this service has already spent a setup attempt — i.e. the scheduler
 * is retrying it rather than trying it for the first time. A first attempt is
 * worth waiting for; a retry is what starves the stages behind it.
 */
function isRetryingSetup(services: ServiceState[], name: string): boolean {
	const svc = services.find((s) => s.name === name);
	return !!svc && svc.setupAttempts > 0;
}

export function planPipelineAction(
	discovered: boolean,
	services: ServiceState[],
	ledger: PipelineLedger,
): PipelineAction {
	const serviceAction = planNextAction(discovered, services);
	if (serviceAction.kind !== 'done') {
		// One service stuck in setup retries must not starve testing of the
		// services that ARE up. Exercise waits while bring-up is on its first
		// attempt — services first is the better order, since every service that
		// comes up adds endpoints to drive — but once the blocking service is
		// merely retrying, exercise goes ahead against whatever is already green.
		//
		// The green requirement is not incidental: the exerciser drives live
		// services on their running ports, and coverage is counted by joining its
		// requests back to traced spans. With nothing serving there is nothing to
		// hit, so an early pass would report 0/N covered and no issues — a clean
		// bill of health for a run that tested nothing — and mark the stage done
		// so it never ran again.
		if (
			ledger.exercise === 'pending' &&
			serviceAction.kind === 'setup' &&
			isRetryingSetup(services, serviceAction.service) &&
			services.some((s) => s.phase === 'green')
		) {
			return { kind: 'exercise' };
		}
		return serviceAction;
	}
	const anyGreen = services.some((s) => s.phase === 'green');
	if (anyGreen && ledger.probes === 'pending') {
		return { kind: 'probes' };
	}
	if (ledger.exercise === 'pending') {
		return { kind: 'exercise' };
	}
	return { kind: 'done' };
}

/**
 * Settle the stages this workspace can never reach.
 *
 * `probes` needs a live traced session, so on a workspace of libraries it is not
 * "still to do" — it is decided. Leaving it 'pending' let the scheduler reach
 * 'done' with a stage that reads, to anything displaying the ledger, as
 * outstanding work that never arrives. A stage nothing will run is 'skipped',
 * which is a phase the ledger already has.
 *
 * `exercise` is deliberately NOT settled here: it needs nothing serving, so on a
 * library-only workspace it is the one stage that still has real work to do (see
 * planPipelineAction).
 *
 * Idempotent, and never downgrades a stage that actually ran: only 'pending' is
 * rewritten.
 */
export function settleUnreachableStages(
	services: ServiceState[],
	ledger: PipelineLedger,
): PipelineLedger {
	if (services.some((s) => s.phase === 'green')) {
		return ledger;
	}
	return ledger.probes === 'pending' ? { ...ledger, probes: 'skipped' } : ledger;
}

/** The post-green stages, in the order the scheduler drains them. */
export type PipelineStage = 'probes' | 'exercise';

/** Records how a stage attempt settled. */
export function applyStageOutcome(
	ledger: PipelineLedger,
	stage: PipelineStage,
	outcome: StagePhase,
): PipelineLedger {
	return { ...ledger, [stage]: outcome };
}

/**
 * Budget policy for a failed pipeline stage — the same shape as
 * decideOnFailure: per-signature fix budget, absolute cap, give-up beyond
 * either. On 'fix' the returned ledger has the spend recorded AND the stage
 * flipped back to 'pending' so the scheduler retries it after the episode.
 */
export function decideOnStageFailure(
	ledger: PipelineLedger,
	stage: PipelineStage,
	signature: string,
	budgets: AutoPilotBudgets = DEFAULT_BUDGETS,
): { ledger: PipelineLedger; decision: FailureDecision } {
	const spentOnSignature = ledger.fixEpisodes[signature] ?? 0;
	if (spentOnSignature >= budgets.fixEpisodesPerSignature) {
		return {
			ledger: { ...ledger, [stage]: 'failed' },
			decision: {
				next: 'give-up',
				reason: `the same ${stage} failure persisted through ${spentOnSignature} fix episode(s) (budget ${budgets.fixEpisodesPerSignature} per failure)`,
			},
		};
	}
	const total = Object.values(ledger.fixEpisodes).reduce((a, b) => a + b, 0);
	if (total >= budgets.totalFixEpisodes) {
		return {
			ledger: { ...ledger, [stage]: 'failed' },
			decision: {
				next: 'give-up',
				reason: `${total} fix episodes spent on pipeline stages (absolute cap ${budgets.totalFixEpisodes})`,
			},
		};
	}
	return {
		ledger: {
			...ledger,
			[stage]: 'pending',
			fixEpisodes: { ...ledger.fixEpisodes, [signature]: spentOnSignature + 1 },
		},
		decision: { next: 'fix' },
	};
}

/** The final tallies the summary notification reports. */
export interface PilotSummary {
	green: ServiceState[];
	library: ServiceState[];
	gaveUp: ServiceState[];
}

/** Buckets terminal states for the end-of-run summary. */
export function summarize(services: ServiceState[]): PilotSummary {
	return {
		green: services.filter((s) => s.phase === 'green'),
		library: services.filter((s) => s.phase === 'library'),
		gaveUp: services.filter((s) => s.phase === 'gave-up'),
	};
}


/**
 * Clears a service's spent attempt counters so a topped-up budget actually
 * buys more work. Raising the ceiling alone is not enough: the per-signature
 * and total episode counts are already at the old limit, so the very next
 * failure would give up again and re-ask. Called when the user grants more
 * effort from the exhaustion prompt.
 */
export function grantMoreBudget(svc: ServiceState): ServiceState {
	return { ...svc, setupAttempts: 0, fixEpisodes: {}, phase: svc.phase === 'gave-up' ? 'needs-setup' : svc.phase };
}
