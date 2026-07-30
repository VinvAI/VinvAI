/**
 * Closed-loop harness episodes: compose a context pack → dispatch it to the
 * user's coding-harness CLI → verify the outcome on EVIDENCE → on failure
 * re-compose with the observed failure and re-dispatch → escalate to the user
 * only when the evidence is inconclusive or the attempt budget is spent.
 *
 * Verification mirrors the bring-up replay gate that already ships on the
 * Python side (bringup verify_replay): for a service episode the recorded
 * start command is replayed exactly as the extension replays it (`bash -lc`,
 * fresh process group, foreground) and success is the port accepting a
 * connection while the replay is alive — polled, so a slow boot just takes
 * longer; there is no fixed per-command timeout, only an overall budget.
 *
 * Every episode logs bandit events (arm, propensity, per-attempt verdicts,
 * final reward) to ~/.vinv/telemetry/episodes.jsonl for off-policy evaluation.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import { spawn } from 'child_process';
import { buildGraphSnapshot, hasIndexStore, type GraphSnapshot } from '../graph/indexGraph';
import { enrichTagsFromFeedback } from '../graph/graphEnhancer';
import { deriveSeedRows, packBudgets, writeContextPack, type PackTask } from './contextPack';
import type { IndexHit } from '../qna/answer';
import { optimizationSourceInstance } from '../views/optimizationSource';

/**
 * When the operator accepts an agent's dispute on an OPTIMIZE episode ("agree
 * there is no issue"), the ranked opportunity is not real. Mark its row(s)
 * DISMISSED so the Optimize panel shows a terminal "not a real opportunity"
 * badge carrying the dispute, instead of leaving the row stuck at 'dispatched'
 * (a non-measurable symbol never gets a session-timing verdict, so nothing else
 * would ever resolve it). Guarded by task.optimization so only optimize
 * episodes touch the board — a no-op for service-fix / error-cluster episodes.
 */
function dismissDisputedOptimization(root: string, task: EpisodeTask, dispute: string): void {
	try {
		const source = optimizationSourceInstance();
		if (!source || !task.optimization) {
			return;
		}
		for (const row of task.seedRows ?? []) {
			source.dismissRow(root, row, dispute);
		}
	} catch {
		// Panel bookkeeping must never break the episode's own completion.
	}
}

/**
 * Renders the winning pack's cited symbols as retrieval hits so a verified
 * fix can teach the index (cross-feed). Ranks by PageRank, caps the set so a
 * huge slice doesn't dominate the enrichment prompt.
 */
function sliceRowsToHits(snapshot: GraphSnapshot, rows: number[]): IndexHit[] {
	return rows
		.map((r) => snapshot.nodes[r])
		.filter((n): n is NonNullable<typeof n> => Boolean(n && n.name))
		.sort((a, b) => b.rank - a.rank)
		.slice(0, 12)
		.map((n) => ({
			score: n.rank,
			file: n.file,
			name: n.name,
			kind: n.kind,
			lang: n.lang,
			lines: [n.start_line, n.end_line] as [number, number],
			rank: n.rank,
			summary: n.summary,
			snippet: '',
		}));
}
import {
	appendEpisodeEvent,
	episodeReward,
	loadEpisodePolicy,
	replayParams,
	selectEpisodeArm,
} from './episodeTelemetry';
import { ceilingMs, readReplayStats, recordReplayDuration, softBudgetMs } from './replayStats';
import { maybeUpdateEpisodePolicy } from './episodePolicyUpdater';
import {
	trajectoryDigest,
	appendTranscriptEntry,
	ensureSessionPersisted,
	amendEpisodeOutcome,
	loadSession,
	loadSessionById,
	parseHarnessDirectives,
	recordEpisodeOutcome,
	setEpisodeBudget,
	setGoal,
} from './session';
import { breakStall, evidenceSimilarity } from './stallBreaker';
import { reconcile } from './reconciliation';
import { captureWorkspaceSnapshot, revertToSnapshot } from './workspaceSnapshot';
import { openRun, closeRun, releaseRun } from './runIsolation';
import {
	acceptanceDir,
	auditWorkspaceDiff,
	generateAcceptanceTests,
	judgeEpisodeDiff,
	newAcceptanceToken,
	appendPoolEvent,
	runAcceptanceTests,
	runMutationSmoke,
	staticPreGate,
	mergeCounterexampleIntoOracle,
	strengthenAcceptanceFromNote,
	type AcceptanceState,
} from './rewardEngine';
import { runGoalAgent, type AgentSpawn } from './binaryAgents';
import { findReusableSet, runTestSwarm, type SwarmEvidence } from './testSwarm';
import { loadCorpus, resolveSymbol } from '../runtime/traceStore';
import { valuesOf } from '../runtime/valueProfiles';
import { getBinPath } from '../tracelens/bin';
import { vinvHomeDir } from '../vinvHome';
import * as path from 'path';
import {
	composeRewardBreakdown,
	renderRewardReport,
	parseUnifiedDiff,
	type OracleSignal,
	type RewardBreakdown,
	type TestSignal,
} from './rewardSignals';
import {
	getHarnessId,
	getHandbookEnv,
	isAcceptanceTestsEnabled,
	isAutoEpisodesEnabled,
} from '../config/settings';
import {
	dispatchAgentPrompt,
	getHarness,
	getHarnessBlock,
	harnessBlockRemediation,
	INFRA_BLOCK_LABELS,
	isHarnessBusy,
	preflightHarnessAuth,
	runHarnessPrompt,
	type HarnessDef,
	type HarnessInfraKind,
	type HarnessRunResult,
} from './harnessRunner';
import { VINV_BASE_CSS } from '../views/webviewTheme';
import { openPathInEditor } from '../support/openDocument';
import {
	isAskVinvOpen,
	postEpisodeUpdate,
	requestDisputeNote,
	requestRetractionConfirm,
	requestEpisodeVerdict,
	setEpisodeCancel,
} from '../views/askVinv';
import { isIdeChatAvailable } from './ideChat';
import { enqueueEpisodeRequest } from './requestQueue';
import { readServices, readStartCommands, serviceSlug } from '../bringup/bringup';
import { hiddenBackgroundOptions, killProcessTree, resolveBash } from '../proc';

export interface EpisodeTask extends PackTask {
	/** 'service-fix' verifies by replaying the service; 'general' escalates. */
	kind: 'service-fix' | 'general';
	/** Seeds the first attempt's prior-failure evidence (e.g. a dispute's
	 * counterexample failing output) so the pack opens with the proof. */
	priorFailureSeed?: string;
	/** What triggered this episode (for telemetry): 'service-exit', 'smoke-errors',
	 * 'invariant-violation' (assert-shaped: output changed but nothing raised),
	 * 'graph', 'qna', 'manual'. */
	trigger: string;
}

interface VerifyResult {
	/**
	 * 'answered' is a SUCCESS terminal state for question-intent episodes: the
	 * agent explained the code and no change was required. It exists because
	 * such episodes previously came back 'inconclusive' and escalated, which
	 * framed a correct answer as a verification failure needing arbitration.
	 */
	verdict: 'pass' | 'fail' | 'inconclusive' | 'answered';
	reason: string;
	outputTail?: string;
	/**
	 * True only for an OBJECTIVE pass — a recorded port actually accepted a
	 * connection. A portless pass (mere process survival) is heuristic: the
	 * agent controls the recorded command, so a trivially-surviving `sleep`
	 * would otherwise auto-verify. Weak passes still surface as success to the
	 * user but do NOT train the composition bandit (reward-hacking guard).
	 */
	objective?: boolean;
	/**
	 * Affirmative "this is a run-to-completion CLI, not a service" evidence:
	 * the replay exited 0 well inside the grace window. Auto-Pilot treats it
	 * as a terminal skip (like 'library') instead of a retryable failure.
	 */
	notAService?: boolean;
}

/** Grace (seconds) a portless service must stay alive to count as serving.
 * Env override wins; the policy's replay prior is the default. */
function portlessGraceSeconds(prior: number): number {
	const raw = Number.parseFloat(process.env.VINV_EPISODE_REPLAY_GRACE_S ?? '');
	return Number.isFinite(raw) && raw > 0 ? raw : prior;
}

/**
 * Absolute wall-clock cap on one replay verification, in ms — the guarantee
 * that a replay can NEVER poll forever (the "replay gets stuck" class of bug:
 * a process that stays alive, keeps printing, and never serves). The env
 * override (VINV_REPLAY_DEADLINE_S, shared name with the bringup engine's
 * gate) wins outright; otherwise the cap sits at max(hard ceiling, 180s) so
 * the learned adaptive budget is never shortened — the deadline only catches
 * what the progress-extension logic cannot.
 */
function replayDeadlineMs(hardMs: number): number {
	const raw = Number.parseFloat(process.env.VINV_REPLAY_DEADLINE_S ?? '');
	if (Number.isFinite(raw) && raw > 0) {
		return raw * 1000;
	}
	return Math.max(hardMs, 180_000);
}

function portIsServing(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: '127.0.0.1', port, timeout: 1000 });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		const fail = () => {
			socket.destroy();
			resolve(false);
		};
		socket.once('error', fail);
		socket.once('timeout', fail);
	});
}

/** The service's expected port: services.json first, then the start record. */
function servicePort(workspaceRoot: string, service: string): number | null {
	const entry = readServices(workspaceRoot).find((s) => s.name === service);
	if (typeof entry?.port === 'number' && entry.port > 0) {
		return entry.port;
	}
	try {
		const raw = fs.readFileSync(
			`${workspaceRoot}/.vinv/start_commands/${serviceSlug(service)}.json`,
			'utf8',
		);
		const parsed = JSON.parse(raw) as { verification?: { port?: number } };
		const p = parsed.verification?.port;
		return typeof p === 'number' && p > 0 ? p : null;
	} catch {
		return null;
	}
}

/**
 * The recorded trace path for a service, if its start record names one. Used
 * as a tamper guard: the recorded start command wraps the service in the
 * tracer, so a genuine replay refreshes the trace file. A replay whose port
 * serves WITHOUT refreshing the recorded trace is consistent with the start
 * command having been swapped for something that merely squats the port
 * (`python -m http.server`-style reward hacking) — such a pass is surfaced
 * but never counted as objective.
 */
function recordedTracePath(workspaceRoot: string, service: string): string | null {
	try {
		const raw = fs.readFileSync(
			`${workspaceRoot}/.vinv/start_commands/${service}.json`,
			'utf8',
		);
		const parsed = JSON.parse(raw) as { verification?: { trace_jsonl?: string | null } };
		const p = parsed.verification?.trace_jsonl;
		return typeof p === 'string' && p.length > 0 ? p : null;
	} catch {
		return null;
	}
}

/** True when the trace file was modified at/after `sinceMs` (1s clock slack). */
function traceRefreshedSince(tracePath: string, sinceMs: number): boolean {
	try {
		return fs.statSync(tracePath).mtimeMs >= sinceMs - 1000;
	} catch {
		return false;
	}
}

/**
 * Replays the recorded start command exactly as the extension's Run button
 * does and decides on evidence: replay exit before serving = fail; port
 * accepting while alive = pass; portless survivor past the grace = pass.
 * Always tears the replay down (whole process group) so no orphan squats the
 * port for the real launch.
 *
 * The waiting budget is ADAPTIVE, not a constant (see replayStats.ts): the
 * soft budget is learned from this service's own recorded boot durations
 * (quantile × multiplier, floored at the prior), and past it the replay keeps
 * waiting only while the process shows recent output progress — the
 * systemd EXTEND_TIMEOUT / Kubernetes startupProbe pattern — up to a hard
 * ceiling. Outcome labeling follows the liveness/progress distinction:
 *  - never served + SILENT past the soft budget → objective fail (hung);
 *  - never served but STILL VISIBLY BOOTING at the hard ceiling →
 *    inconclusive (never an objective rejection — a slow boot is
 *    infrastructure, not evidence about the fix, and must not train the
 *    composition bandit as one).
 */
export async function verifyServiceReplay(
	workspaceRoot: string,
	service: string,
	token?: vscode.CancellationToken,
	evidenceChars?: number,
): Promise<VerifyResult> {
	const commands = readStartCommands(workspaceRoot, service);
	if (commands.length === 0) {
		// The oracle could not RUN (no recorded command) — this is not the
		// oracle rejecting the fix, so it must not train the bandit as a
		// composition failure. objective: false marks it infra-unavailable.
		return {
			verdict: 'fail',
			objective: false,
			reason: `no verified start command recorded for ${service} (.vinv/start_commands/${service}.json must have verified: true)`,
		};
	}
	const script = commands
		.map((c) =>
			c.working_directory ? `cd ${JSON.stringify(c.working_directory)} && ${c.command}` : c.command,
		)
		.join(' && ');
	const port = servicePort(workspaceRoot, service);
	const policy = loadEpisodePolicy();
	const rp = replayParams(policy);
	const stats = readReplayStats(workspaceRoot, service);
	const softMs = softBudgetMs(stats, rp);
	const hardMs = ceilingMs(softMs, rp);
	const deadlineMs = replayDeadlineMs(hardMs);
	const graceMs = portlessGraceSeconds(rp.portless_grace_s) * 1000;
	const tracePath = recordedTracePath(workspaceRoot, service);

	const bash = resolveBash();
	if (!bash) {
		return {
			verdict: 'inconclusive',
			reason: 'no bash found on PATH to replay the start command',
		};
	}
	if (port !== null && (await portIsServing(port))) {
		// The port answers BEFORE the replay has started anything, so nothing the
		// probe observes below can be attributed to the recorded command — the
		// port check would be measuring whatever is squatting there, typically a
		// previous run's server that survived its kill (a real Windows failure
		// mode in this repo: killing the bash wrapper leaves the python server
		// holding the port). The trace-refresh guard cannot catch that case
		// either, because a surviving TRACED server keeps writing the trace file,
		// so the file refreshes and the squatter reads as an objective pass —
		// which is exactly how a repaired command "verified" while the capture
		// still showed the old flags' output.
		return {
			verdict: 'inconclusive',
			reason:
				`port ${port} was already serving before the replay started — a previous run of ` +
				`'${service}' is likely still holding it. Stop that process and retry; a served ` +
				'port cannot be attributed to the recorded command while something else owns it.',
		};
	}
	const child = spawn(bash, ['-lc', script], hiddenBackgroundOptions({
		cwd: commands[0].working_directory ?? workspaceRoot,
		env: process.env,
	}));
	// The capture ring holds what the POLICY says an attempt's evidence is
	// worth (failure_evidence_chars), not an unrelated constant — this is the
	// single budget the whole failure-feedback chain honors.
	const ring = evidenceChars ?? policy.failure_evidence_chars;
	let tail = '';
	let lastActivityMs = Date.now();
	const absorb = (chunk: string) => {
		tail = (tail + chunk).slice(-ring);
		lastActivityMs = Date.now();
	};
	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', absorb);
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', absorb);

	let exitCode: number | null | undefined;
	child.on('exit', (code) => {
		exitCode = code;
	});

	const started = Date.now();
	try {
		for (;;) {
			if (token?.isCancellationRequested) {
				return { verdict: 'inconclusive', reason: 'verification cancelled', outputTail: tail };
			}
			const elapsed = Date.now() - started;
			if (exitCode !== undefined) {
				// A clean, quick exit is affirmative evidence of a
				// run-to-completion CLI, not a broken service — surface it as a
				// distinct classification so Auto-Pilot SKIPS (terminal, like
				// 'library') instead of burning retry + fix budgets on it. This
				// was the historical get-stuck mode for misclassified scripts.
				if (exitCode === 0 && elapsed < graceMs) {
					return {
						verdict: 'fail',
						objective: true,
						notAService: true,
						reason:
							`ran to completion in ${(elapsed / 1000).toFixed(1)}s (exit 0) — a ` +
							'run-to-completion CLI, not a long-running service; reclassify as ' +
							'kind=cli and skip bring-up',
						outputTail: tail,
					};
				}
				// The oracle RAN and the service died — an objective rejection.
				return {
					verdict: 'fail',
					objective: true,
					reason:
						`replaying the recorded start command exited with code ${exitCode ?? 'null'} after ` +
						`${(elapsed / 1000).toFixed(1)}s — a verified start command must keep the server in ` +
						'the foreground and serving',
					outputTail: tail,
				};
			}
			if (port !== null && (await portIsServing(port))) {
				// A served port is objective evidence — unless the recorded trace
				// file exists but did not refresh, which is consistent with the
				// start command having been swapped for a port-squatter. Such a
				// pass is surfaced (the human sees the flag) but never objective
				// and never teaches the bandit or the budget stats.
				if (tracePath !== null && !traceRefreshedSince(tracePath, started)) {
					return {
						verdict: 'pass',
						objective: false,
						reason:
							`port ${port} is serving, but the recorded trace file did not refresh during the ` +
							`replay (${tracePath}) — the start command may no longer run the traced service; ` +
							'verify the fix by hand before trusting it',
						outputTail: tail,
					};
				}
				recordReplayDuration(workspaceRoot, service, elapsed / 1000);
				return { verdict: 'pass', reason: `port ${port} is serving`, objective: true, outputTail: tail };
			}
			if (port === null && elapsed >= graceMs) {
				// Survival is not correctness, and the agent controls the recorded
				// command — a heuristic (non-objective) pass, never an oracle.
				return {
					verdict: 'pass',
					reason: `process stayed alive for ${(elapsed / 1000).toFixed(0)}s (no port recorded — heuristic pass, not objectively verified)`,
					objective: false,
					outputTail: tail,
				};
			}
			if (elapsed >= softMs) {
				const silentMs = Date.now() - lastActivityMs;
				if (silentMs >= rp.activity_window_s * 1000) {
					// Past the learned budget AND silent: hung, not slow — objective.
					return {
						verdict: 'fail',
						objective: true,
						reason:
							`port ${port} never accepted a connection within ${(softMs / 1000).toFixed(0)}s ` +
							`(learned budget) and the process produced no output for ${(silentMs / 1000).toFixed(0)}s — ` +
							'treating the replay as hung',
						outputTail: tail,
					};
				}
				if (elapsed >= hardMs) {
					// Still visibly booting at the ceiling: the oracle cannot tell a
					// slow boot from a broken one — inconclusive, the human decides.
					// Never an objective rejection (a mislabeled slow boot would
					// train the bandit on infrastructure, not on the fix).
					return {
						verdict: 'inconclusive',
						reason:
							`port ${port} had not accepted a connection after ${(hardMs / 1000).toFixed(0)}s, but the ` +
							'process was still producing output — cannot distinguish a slow boot from a broken one; ' +
							'the replay was stopped at the hard ceiling',
						outputTail: tail,
					};
				}
				// Progress extension: alive and recently active — keep waiting.
			}
			if (elapsed >= deadlineMs) {
				// The absolute cap: alive, maybe even chatty, but it NEVER served.
				// Non-objective (a hard cap is infrastructure, not oracle evidence)
				// but always terminal — no replay may poll forever.
				return {
					verdict: 'fail',
					objective: false,
					reason: `deadline: port ${port ?? '(none)'} never served within ${(deadlineMs / 1000).toFixed(0)}s`,
					outputTail: tail,
				};
			}
			await new Promise((r) => setTimeout(r, 500));
		}
	} finally {
		killProcessTree(child, 'SIGTERM');
		setTimeout(() => killProcessTree(child, 'SIGKILL'), 4000);
	}
}

/** How an episode ends when its harness hits a precondition failure. */
export interface InfraStop {
	kind: HarnessInfraKind;
	/** Issue/Flow state label, e.g. 'blocked: agent CLI needs login'. */
	endLabel: string;
	/** The one actionable remediation sentence for the notification. */
	remediation: string;
}

/**
 * Pure gate between a harness run and ALL verification machinery: an infra
 * precondition failure (CLI signed out, key invalid, quota exhausted, vendor
 * unreachable) can never be fixed by retrying, so it ends the episode on the
 * FIRST occurrence — one attempt, no re-dispatch, no stall judge, no dispute
 * negotiation, objective:false (never composition-failure evidence for the
 * bandit). Returns null for every other outcome (normal verification runs).
 */
export function gateAttemptRun(
	run: Pick<HarnessRunResult, 'ok' | 'infra' | 'detail'>,
	harness: HarnessDef,
): InfraStop | null {
	if (!run.infra) {
		return null;
	}
	return {
		kind: run.infra,
		endLabel: INFRA_BLOCK_LABELS[run.infra],
		remediation: run.detail ?? harnessBlockRemediation(harness, run.infra),
	};
}

/** Escalation verdict from the user when evidence alone cannot decide. */
type Escalation = 'approve' | 'retry' | 'abort' | 'revert';

/** What the operator is judging: who ran, and how far into the budget. */
interface EscalationContext {
	/** Display label of the coding agent the episode is dispatched to. */
	agent?: string;
	attempt?: number;
	attemptBudget?: number;
}

/** The operator's verdict, plus any free-text instruction they injected. */
interface EscalationResult {
	action: Escalation;
	/** Verbatim operator direction from "Something else…"; drives a retry. */
	note?: string;
	/**
	 * Proposals the operator ticked in an `answer`-mode judgment. Each becomes
	 * its OWN defect-intent episode with the proposal as the issue — which is
	 * the whole point of the proposal channel: an agent that answers a question
	 * and spots three optimizations should not have to smuggle that work through
	 * a dispute, and the operator should not have to retype it as a new task.
	 */
	selectedProposals?: string[];
}

/**
 * What kind of decision the operator is being asked for.
 *
 * 'defect'  — the classic case: work was attempted and could not be verified.
 * 'answer'  — the agent answered a QUESTION. There is no dispute to arbitrate;
 *             the operator is accepting an answer and choosing which of the
 *             agent's proposals (if any) become real work. The buttons differ
 *             because the outcomes differ — "agree there is no issue" is not
 *             the opposite of "I want the information", and offering only those
 *             two is what made a correct answer look like a failed episode.
 */
type JudgmentMode = 'defect' | 'answer';

/** A judgment awaiting the operator, re-presentable on any surface. */
interface ParkedJudgment {
	title: string;
	detail: string;
	mode: JudgmentMode;
	/** Agent-proposed follow-up work, offered as selectable episodes. */
	proposals: string[];
	packPath: string;
	canRevert: boolean;
	context?: EscalationContext;
	/** Settles the awaiting episode. Called exactly once, from any surface. */
	resolve: (r: EscalationResult) => void;
}

/**
 * The one judgment the operator owes us, if any. Module-scoped because it
 * outlives the panel that raised it — that is the entire point: closing a tab
 * suspends the decision instead of deciding it.
 */
let parked: ParkedJudgment | undefined;
let parkedItem: vscode.StatusBarItem | undefined;

/** True when an episode is suspended waiting for the operator. */
export function hasParkedJudgment(): boolean {
	return parked !== undefined;
}

function clearParked(): void {
	parked = undefined;
	parkedItem?.hide();
}

/** Suspends a judgment and makes it findable again (status bar + toast). */
function park(j: ParkedJudgment): void {
	parked = j;
	if (!parkedItem) {
		parkedItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		parkedItem.command = 'vinv-vs.resumeJudgment';
	}
	parkedItem.text = '$(bell) Vinv: judgment needed';
	parkedItem.tooltip = `Vinv episode is waiting on you — ${j.title}`;
	parkedItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	parkedItem.show();
	void vscode.window
		.showWarningMessage(
			`Vinv: the episode is waiting on your judgment — ${j.title}`,
			'Resume',
			'Abort episode',
		)
		.then((pick) => {
			// Only act if THIS judgment is still the parked one; a resume in the
			// meantime (status bar, command palette) already took ownership.
			if (parked !== j) {
				return;
			}
			if (pick === 'Resume') {
				void resumeJudgment();
			} else if (pick === 'Abort episode') {
				clearParked();
				j.resolve({ action: 'abort' });
			}
		});
}

/**
 * Brings a parked judgment back — from the status bar, the command palette, or
 * the toast. Re-presents on the best available surface; if the operator closes
 * it again it simply parks again.
 */
export async function resumeJudgment(): Promise<void> {
	const j = parked;
	if (!j) {
		void vscode.window.showInformationMessage('Vinv: no episode is waiting on a judgment.');
		return;
	}
	clearParked();
	await presentJudgment(j);
}

/**
 * Puts a judgment in front of the operator: inline in the Ask Vinv transcript
 * when it is open (where they can already act, and where it scrolls back),
 * otherwise as the standalone dialog.
 */
async function presentJudgment(j: ParkedJudgment): Promise<void> {
	if (isAskVinvOpen()) {
		const verdict = await requestEpisodeVerdict({
			title: j.title,
			detail: j.detail,
			mode: j.mode,
			proposals: j.proposals,
			packPath: j.packPath,
			canRevert: j.canRevert,
			agent: j.context?.agent,
			attempt: j.context?.attempt,
			attemptBudget: j.context?.attemptBudget,
			// The transcript can only carry this card while it is showing the
			// episode's own session; otherwise fall back to the dialog.
			sessionId: currentEpisodeSessionId,
		});
		if (verdict !== 'unavailable') {
			if (verdict.action === 'retry' && j.mode !== 'answer') {
				// Same courtesy as the dialog: show the brief before the next attempt.
				// Not for an answer follow-up — that is a conversation, not a re-brief,
				// and yanking a markdown file into the editor mid-question is noise.
				// openPathInEditor verifies + reports a missing pack rather than
				// swallowing the failure; the retry proceeds regardless.
				await openPathInEditor(j.packPath, { label: 'context pack', preview: false });
			}
			j.resolve(verdict);
			return;
		}
		// Transcript closed mid-decision — fall through to the dialog rather
		// than dropping the judgment.
	}
	openJudgmentDialog(j);
}

/**
 * Asks the operator to judge a stuck episode, and resolves when they answer —
 * however long that takes and whichever surface they answer on. The episode's
 * cancellation token is the only thing that can settle it without them: a
 * cancelled episode resolves 'abort' so a parked judgment can never hang.
 */
async function escalate(
	title: string,
	detail: string,
	packPath: string,
	canRevert = false,
	context?: EscalationContext,
	token?: vscode.CancellationToken,
	opts: { mode?: JudgmentMode; proposals?: string[] } = {},
): Promise<EscalationResult> {
	const mode = opts.mode ?? 'defect';
	postEpisodeUpdate({
		kind: 'note',
		// An answered question is not a problem the operator has to solve, and
		// the chat line must not claim it is.
		text:
			mode === 'answer'
				? `✓ answered — your call on what happens next: ${title}`
				: `⚠ needs your judgment: ${title}`,
		sessionId: currentEpisodeSessionId,
	});
	return await new Promise<EscalationResult>((resolve) => {
		let settled = false;
		let cancelReg: vscode.Disposable | undefined;
		const j: ParkedJudgment = {
			title,
			detail,
			mode,
			proposals: opts.proposals ?? [],
			packPath,
			canRevert,
			context,
			resolve: (r) => {
				if (settled) {
					return;
				}
				settled = true;
				cancelReg?.dispose();
				if (parked === j) {
					clearParked();
				}
				resolve(r);
			},
		};
		cancelReg = token?.onCancellationRequested(() => j.resolve({ action: 'abort' }));
		if (token?.isCancellationRequested) {
			j.resolve({ action: 'abort' });
			return;
		}
		void presentJudgment(j);
	});
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** A message the judgment card posts back to the extension. */
export interface JudgmentMessage {
	type: string;
	action?: string;
	note?: string;
	selectedProposals?: string[];
	message?: unknown;
	stack?: unknown;
}

/**
 * Side effects a judgment-card message can trigger, injected so the routing is
 * testable without a live webview. `openPack` opens the episode's context pack
 * and — crucially — surfaces an actionable error when it cannot (missing/moved
 * pack), replacing the empty catch that made "view context pack" a silent no-op.
 */
export interface JudgmentActions {
	openPack: () => Promise<void>;
	settle: (result: EscalationResult) => void;
}

/**
 * Routes one judgment-card message. Extracted from the inline
 * onDidReceiveMessage closure so the wiring is unit-tested directly. Both the
 * "view context pack" button and "reject & retry" open the pack through
 * `openPack`; a retry settles regardless of whether the pack opened, but the
 * user is told when it didn't rather than left with a dead button.
 */
export async function handleJudgmentMessage(
	m: JudgmentMessage,
	actions: JudgmentActions,
): Promise<void> {
	if (m.type === 'webviewError') {
		return;
	}
	if (m.type === 'openPack') {
		// Inspection only — the dialog stays up, no verdict implied.
		await actions.openPack();
		return;
	}
	if (m.type !== 'verdict') {
		return;
	}
	if (m.action === 'retry') {
		// Show the pack so the user can inspect/edit before the next attempt.
		await actions.openPack();
		actions.settle({
			action: 'retry',
			note: m.note?.trim() || undefined,
			selectedProposals: m.selectedProposals?.length ? m.selectedProposals : undefined,
		});
		return;
	}
	if (m.action === 'approve' || m.action === 'abort' || m.action === 'revert') {
		actions.settle({
			action: m.action,
			selectedProposals: m.selectedProposals?.length ? m.selectedProposals : undefined,
		});
	}
}

/**
 * Ask the operator to judge a stuck episode.
 *
 * Rendered as a Vinv-themed webview dialog (same design system as every other
 * panel) so the FULL decision basis is read directly in the dialog: what the
 * agent said, why it escalated (stall / dispute / failed verification), which
 * agent ran and on which attempt — with the verdict buttons beneath the text.
 * "Something else…" reveals an inline text box; whatever the operator types is
 * returned as `note` and injected into the next attempt's pack as
 * authoritative direction. "Reject & retry" also opens the pack for
 * inspection/edit.
 *
 * The buttons depend on `mode`, because the outcome space does. A 'defect'
 * judgment asks whether the attempted work is acceptable. An 'answer' judgment
 * asks nothing of the kind: the agent answered a question, so accepting the
 * answer is the normal path, and the real decision is which of its proposals
 * become work. Offering only "accept as done / reject & retry" there forced a
 * false choice — agreeing there was no issue looked like discarding the answer,
 * and the operator had no way at all to say "yes, do the things you proposed".
 *
 * Closing the panel is NOT a verdict: the judgment is parked (see `park`) and
 * the episode waits, because a closed tab — or an editor reload — must not be
 * indistinguishable from a deliberate abort.
 */
function openJudgmentDialog(j: ParkedJudgment): void {
	const { title, detail, mode, proposals, packPath, canRevert, context } = j;
	const panel = vscode.window.createWebviewPanel(
		'vinvEscalation',
		`Vinv: your judgment — ${title}`,
		{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	const badges: string[] = [];
	if (context?.agent) {
		badges.push(`<span class="v-badge">agent: ${escapeHtml(context.agent)}</span>`);
	}
	if (context?.attempt !== undefined) {
		badges.push(
			`<span class="v-badge">attempt ${context.attempt} of ${context.attemptBudget ?? '?'}</span>`,
		);
	}
	panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
${VINV_BASE_CSS}
	.wrap { max-width: 860px; margin: 0 auto; padding: 28px 26px 40px; }
	h1.v-display { font-size: 26px; margin: 8px 0 10px; }
	.meta { display: flex; gap: 8px; margin-bottom: 20px; }
	.section-label { margin: 18px 0 8px; }
	#evidence {
		background: var(--bg-2); border: 1px solid var(--line); padding: 14px 16px;
		font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
		max-height: 46vh; overflow: auto; margin: 0;
	}
	.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
	.v-btn.danger:hover { background: var(--accent); border-color: var(--accent); color: #ffffff; }
	#custom { margin-top: 16px; display: flex; gap: 10px; align-items: flex-start; }
	#custom[hidden] { display: none; }
	#note {
		flex: 1; min-height: 64px; padding: 9px 12px; border: 1px solid var(--line-strong);
		border-radius: 0; background: var(--bg); color: var(--ink);
		font-family: inherit; font-size: 12.5px; resize: vertical;
	}
	#note:focus { outline: none; border-color: var(--accent); }
	.hint { color: var(--muted); font-size: 11px; margin-top: 14px; }
	#proposals { margin: 10px 0 0; padding: 0; list-style: none; }
	#proposals li {
		display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px;
		border: 1px solid var(--line); border-bottom: none; background: var(--bg-2);
		font-size: 12.5px; line-height: 1.5;
	}
	#proposals li:last-child { border-bottom: 1px solid var(--line); }
	#proposals input { margin-top: 3px; flex: none; accent-color: var(--accent); }
	#proposals label { cursor: pointer; }
</style></head>
<body>
<div class="wrap">
	<div class="v-label">${mode === 'answer' ? 'vinv answered — what next?' : 'vinv needs your judgment'}</div>
	<h1 class="v-display">${escapeHtml(title)}</h1>
	${badges.length ? `<div class="meta">${badges.join('')}</div>` : ''}
	<div class="v-label section-label">${mode === 'answer' ? 'what the agent found' : 'what happened'}</div>
	<pre id="evidence">${escapeHtml(detail)}</pre>
	${
		proposals.length
			? `<div class="v-label section-label">proposed work — tick what you want done</div>
	<ul id="proposals">${proposals
		.map(
			(p, i) =>
				`<li><input type="checkbox" id="p${i}" value="${escapeHtml(p)}"><label for="p${i}">${escapeHtml(p)}</label></li>`,
		)
		.join('')}</ul>`
			: ''
	}
	<div class="actions">
		${
			mode === 'answer'
				? `<button class="v-btn primary" data-act="approve" title="${
						proposals.length
							? 'Close this episode and queue the ticked proposals as their own episodes'
							: 'Close this episode — the question is answered'
					}">${proposals.length ? 'accept answer &amp; queue selected' : 'accept answer'}</button>
		<button class="v-btn" id="btn-custom" title="Ask a follow-up or redirect the agent">ask a follow-up…</button>`
				: `<button class="v-btn primary" data-act="approve" title="Close the episode — the work is acceptable">accept as done</button>
		<button class="v-btn" data-act="retry" title="Open the context pack, then try again">reject &amp; retry</button>
		<button class="v-btn" id="btn-custom" title="Type an instruction for the agent, then retry with it">something else…</button>`
		}
		${canRevert ? '<button class="v-btn danger" data-act="revert" title="Undo everything this episode changed, then stop">revert &amp; abort</button>' : ''}
		<button class="v-btn danger" data-act="abort" title="Stop now and keep the changes made so far">abort episode</button>
		${packPath ? '<button class="v-btn" id="btn-pack" title="Open the exact brief the agent received">view context pack</button>' : ''}
	</div>
	<div id="custom" hidden>
		<textarea id="note" placeholder="${
			mode === 'answer'
				? 'e.g. also explain how revocation latency is bounded today'
				: 'e.g. the slow path is the count query — cache it; do not touch the frontend'
		}"></textarea>
		<button class="v-btn primary" id="send-note">${mode === 'answer' ? 'send' : 'send &amp; retry'}</button>
	</div>
	<div class="hint">Closing this panel does not decide anything — the episode waits, and
	“Vinv: Resume Judgment” (or the status-bar bell) brings this back.</div>
</div>
<script>
	const vscode = acquireVsCodeApi();
	window.addEventListener('error', function (e) { vscode.postMessage({ type: 'webviewError', message: String((e && e.message) || 'unknown'), stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : undefined }); });
	window.addEventListener('unhandledrejection', function (e) { vscode.postMessage({ type: 'webviewError', message: 'unhandledrejection: ' + String((e && e.reason) || ''), stack: e && e.reason && e.reason.stack ? String(e.reason.stack).slice(0, 2000) : undefined }); });
	function selected() {
		return Array.prototype.slice
			.call(document.querySelectorAll('#proposals input:checked'))
			.map(function (c) { return c.value; });
	}
	document.querySelectorAll('[data-act]').forEach((b) =>
		b.addEventListener('click', () =>
			vscode.postMessage({ type: 'verdict', action: b.dataset.act, selectedProposals: selected() })));
	document.getElementById('btn-custom').addEventListener('click', () => {
		const c = document.getElementById('custom');
		c.hidden = false;
		document.getElementById('note').focus();
	});
	document.getElementById('send-note').addEventListener('click', () => {
		const t = document.getElementById('note').value.trim();
		if (t) { vscode.postMessage({ type: 'verdict', action: 'retry', note: t, selectedProposals: selected() }); }
	});
	const packBtn = document.getElementById('btn-pack');
	if (packBtn) { packBtn.addEventListener('click', () => vscode.postMessage({ type: 'openPack' })); }
</script>
</body></html>`;

	{
		let settled = false;
		const settle = (result: EscalationResult): void => {
			if (!settled) {
				settled = true;
				j.resolve(result);
				panel.dispose();
			}
		};
		const actions: JudgmentActions = {
			// Absolute pack path from writeContextPack; the opener still resolves +
			// verifies and, if the pack was moved/deleted, shows "context pack not
			// found at <path>" instead of the old silent no-op.
			openPack: async () => {
				await openPathInEditor(packPath, {
					label: 'context pack',
					preview: false,
					viewColumn: vscode.ViewColumn.Beside,
				});
			},
			settle,
		};
		panel.webview.onDidReceiveMessage((m: JudgmentMessage) => handleJudgmentMessage(m, actions));
		// Closed without a verdict (tab closed, editor reload): park it. The
		// episode stays suspended on the operator rather than being aborted by
		// an accident of window management.
		panel.onDidDispose(() => {
			if (!settled) {
				settled = true;
				park(j);
			}
		});
	}
}

// One episode at a time — an episode drives the (already single-flight)
// harness plus service replays; overlapping episodes would corrupt both.
let episodeRunning = false;

/**
 * The session the RUNNING episode was dispatched under. Every episode-side
 * write and chat post carries this id, so the user can switch sessions while
 * the episode runs: its feed, escalations, and outcome all stay bound to the
 * session that started it. Module-scoped is safe because episodes are
 * single-flight (episodeRunning above).
 */
let currentEpisodeSessionId: string | undefined;

/** True when an episode is currently in flight. */
export function isEpisodeRunning(): boolean {
	return episodeRunning;
}

/**
 * Runs one full closed-loop episode. Returns true when the task verified (or
 * the user approved it), false otherwise. All outcomes are logged to the
 * episode ledger with the arm's exact propensity.
 */
export async function runEpisode(
	_context: vscode.ExtensionContext,
	workspaceRoot: string,
	task: EpisodeTask,
	harnessId?: string,
	// A trajectory continuation re-binds to the session that started the run —
	// switching sessions between episodes must not redirect the trajectory.
	sessionId?: string,
): Promise<boolean> {
	if (episodeRunning || isHarnessBusy()) {
		void vscode.window.showWarningMessage(
			'Vinv: A harness run is already in progress — wait for it to finish before starting an episode.',
		);
		return false;
	}
	// Click-driven dispatches pass the picker's choice; background triggers
	// (auto-episodes, chat requests) fall back to the remembered harness.
	const chosenHarness = harnessId ?? getHarnessId();
	const harness = getHarness(chosenHarness);
	if (harness.kind === 'ide-chat' ? !isIdeChatAvailable(harness) : !harness.bin) {
		void vscode.window.showErrorMessage(
			`Vinv: ${harness.label} cannot run episodes here. ${harness.installHint}`,
		);
		return false;
	}
	if (!hasIndexStore(workspaceRoot)) {
		void vscode.window.showWarningMessage(
			'Vinv: No code index yet — run Discover Project before dispatching episodes.',
		);
		return false;
	}
	// Infra preflight: a signed-out (or quota-dead, or unreachable) CLI can
	// never complete an episode — refuse to dispatch, and to spend acceptance
	// tests or judge work, BEFORE any budget is touched. markHarnessBlocked
	// already surfaced the remediation once this session; the chat note keeps
	// the issue visibly blocked-on-you rather than "agent working". A later
	// dispatch of the same issue re-probes and proceeds fresh after login.
	const preflight = await preflightHarnessAuth(chosenHarness);
	if (preflight !== 'ok') {
		const block = getHarnessBlock(chosenHarness);
		postEpisodeUpdate({
			kind: 'note',
			text:
				`⛔ episode "${task.title}" not dispatched — ${INFRA_BLOCK_LABELS[preflight]}. ` +
				(block?.remediation ?? harnessBlockRemediation(harness, preflight)),
			sessionId,
		});
		return false;
	}

	const policy = loadEpisodePolicy();
	const decision = selectEpisodeArm(policy);
	// The episode's isolated tree. The trigger id IS the episode id — one
	// identity for the run, its worktree, its branch and every record it
	// writes — so nothing has to be correlated after the fact. The agent edits
	// `run.tree`; workspaceRoot still anchors .vinv, the event ledger and the
	// learning aggregates, so concurrent episodes stay invisible to each other
	// in the tree while remaining one dataset for the bandit.
	const triggerRun = await openRun(workspaceRoot, {
		kind: task.kind,
		harness: chosenHarness,
		task: task.trigger,
	});
	const episodeId = triggerRun.id;
	appendEpisodeEvent({
		type: 'episode_start',
		ts: new Date().toISOString(),
		episode_id: episodeId,
		trigger: task.trigger,
		kind: task.kind,
		service: task.service ?? null,
		harness: chosenHarness,
		arm_index: decision.armIndex,
		arm: decision.arm,
		propensity: decision.propensity,
		epsilon: decision.epsilon,
		explored: decision.explored,
		attempt_budget: policy.attempt_budget,
		issue_chars: task.issue.length,
	});

	episodeRunning = true;
	let attempts = 0;
	let verified = false;
	let aborted = false;
	// Set when the harness hit a precondition failure (auth/quota/network):
	// the episode ended as infra-blocked — terminal after ONE attempt, shown
	// as blocked-on-you, and never trained into the bandit.
	let infraBlocked: InfraStop | undefined;
	// True only when the terminal verdict came from the OBJECTIVE oracle (service
	// replay pass, or a definitive oracle failure the human did not override) —
	// not from a human "approve as done", an abort, or a no-oracle general task.
	// Only objective episodes train the composition bandit.
	let objectiveOutcome = false;
	// The most recent verify verdict that was a GENUINE oracle rejection (the
	// service ran and failed), as opposed to infra-unavailable (no start
	// command / no bash) or an inconclusive general task. A revert/abort that
	// follows an objective rejection is objective negative evidence about the
	// arm; a revert after an infra failure is not. One rule for every escalation
	// site keeps the labeling consistent (review Findings A + B).
	let lastObjectiveFail = false;
	let lastPackPath = '';
	let lastEvidence = '';
	/**
	 * The agent's last disputed premise, kept for the outcome digest.
	 *
	 * A dispute produces no verification evidence by construction — the agent
	 * declined to treat the issue as real — so `lastEvidence` stays empty and the
	 * episode recorded the digest "no evidence". That is false: the dispute IS
	 * the evidence, and the trajectory prints it two lines below the digest that
	 * denies it exists.
	 */
	let lastDispute = '';
	// The last attempt's full reward breakdown — logged at episode_end so the
	// ledger carries the multi-signal reward, not only the shaped scalar.
	let lastBreakdown: RewardBreakdown | undefined;
	// Work the agent proposed but did not do (`vinv: proposal …`). Kept across
	// attempts so it reaches the judgment even if a later attempt is quieter,
	// and so an operator note referring to "#1" still has its referent.
	let lastProposals: string[] = [];
	// The composition of the last attempt, kept so a VERIFIED objective outcome
	// can teach the retrieval index (cross-feed) — a verified fix is far stronger
	// evidence that its cited symbols were the right context than a QnA thumbs-up.
	let lastSnapshot: GraphSnapshot | undefined;
	let lastSliceRows: number[] = [];
	// Pre-episode snapshot: the whole working state committed to a hidden ref
	// so every escalation can offer a one-click, exact revert of the agent's
	// changes. Null when the workspace isn't a git repo — then no offer.
	// Snapshot the tree the agent will actually edit. On an isolated run that is
	// the worktree, so revert can never reach across into another episode's
	// files — the exact failure that forced episodes to be single-flight.
	const snapshotSha = await captureWorkspaceSnapshot(triggerRun.tree, episodeId).catch(
		() => null,
	);
	/**
	 * Turns the proposals the operator ticked into real, queued episodes.
	 *
	 * This is the path that did not exist: the agent would answer a question,
	 * list three optimizations, and ask "want me to implement #1 and #2?" — and
	 * every button on the judgment meant something else. "Accept as done" threw
	 * the plan away; "reject & retry" re-ran the same unsatisfiable task. Now the
	 * proposals ARE the deliverable, each one a defect-intent episode whose issue
	 * is the proposal text, so the loop can genuinely verify it.
	 *
	 * Queued rather than run inline: the current episode is still settling, and
	 * `runEpisode` refuses to re-enter while the harness is busy.
	 */
	const queueProposalEpisodes = (selected?: string[]): void => {
		if (!selected?.length) {
			return;
		}
		for (const proposal of selected) {
			enqueueEpisodeRequest(workspaceRoot, {
				source: 'chat',
				kind: 'fix',
				issue: proposal,
			});
		}
		void vscode.window.showInformationMessage(
			`Vinv: Queued ${selected.length} proposed change(s) as their own episode(s).`,
		);
		postEpisodeUpdate({
			kind: 'note',
			text: `— queued ${selected.length} proposed change(s): ${selected.join('; ')}`,
			sessionId: owningSessionId,
		});
	};

	const doRevert = async (): Promise<void> => {
		try {
			// Revert the run's own tree — never the shared workspace, which may
			// hold the user's edits or another episode's in-flight work.
			const result = await revertToSnapshot(triggerRun.tree, episodeId);
			appendEpisodeEvent({
				type: 'revert',
				ts: new Date().toISOString(),
				episode_id: episodeId,
				restored: result.restored,
				deleted: result.deleted.length,
			});
			void vscode.window.showInformationMessage(
				`Vinv: Workspace reverted to the pre-episode snapshot — ${result.restored} file(s) restored` +
					(result.deleted.length ? `, ${result.deleted.length} created file(s) removed.` : '.'),
			);
		} catch (e) {
			void vscode.window.showErrorMessage(
				`Vinv: Revert failed: ${e instanceof Error ? e.message : String(e)}. ` +
					`The snapshot is preserved at refs/vinv/pre-episode/${episodeId} — ` +
					'inspect it with `git show` or restore manually with `git restore --source`.',
			);
		}
	};
	// The attempt budget starts at the policy's learned value and can be
	// EXTENDED mid-episode by the stall judge (agent-analyzed budget) up to
	// the policy ceiling — the budget is negotiated, not frozen.
	let attemptBudget = policy.attempt_budget;
	// Session context: the standing goal and the trajectory so far ride along
	// in every pack so the agent sees the whole trajectory, not one failure.
	// The episode BINDS to this session's id now, at dispatch: every write and
	// chat post below carries it, so the user can switch sessions mid-run.
	const session =
		(sessionId ? loadSessionById(workspaceRoot, sessionId) : undefined) ??
		ensureSessionPersisted(workspaceRoot);
	const owningSessionId = session.id;
	currentEpisodeSessionId = owningSessionId;
	const packTask: EpisodeTask = {
		...task,
		goal: task.goal ?? (session.goal || undefined),
		trajectory: task.trajectory ?? (trajectoryDigest(session) || undefined),
	};
	// One cancellation source, two triggers: the chat episode block's inline
	// cancel and (when shown) the notification's Cancel button. With the chat
	// panel open the loud toast is replaced by the quiet status-bar progress —
	// the transcript is already the live surface, and it now carries cancel.
	const cts = new vscode.CancellationTokenSource();
	setEpisodeCancel(() => cts.cancel());
	const chatOpen = isAskVinvOpen();
	try {
		postEpisodeUpdate({
			kind: 'start',
			text: `episode: ${task.title}`,
			agent: harness.label,
			sessionId: owningSessionId,
		});
		await vscode.window.withProgress(
			{
				location: chatOpen ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
				title: `Vinv episode: ${task.title} (via ${harness.label})`,
				cancellable: true,
			},
			async (progress, notifToken) => {
				// The notification's Cancel (absent in Window mode) folds into the
				// shared source; `token` keeps its name so every consumer below —
				// harness runs, replay verification, escalations — is unchanged.
				notifToken.onCancellationRequested(() => cts.cancel());
				const token = cts.token;
				let priorFailure: string | undefined = task.priorFailureSeed;
				// Acceptance/regression oracle: generated ONCE, before any fix is
				// dispatched, from the pre-fix code — so acceptance tests provably
				// reproduce the issue (fail-to-pass), regression tests provably pin
				// current neighbor behavior (pass-to-pass), and the fixing agent
				// never sees either (they live under ~/.vinv/acceptance, outside
				// the workspace). Authors are BACKEND agents (goal binary, one
				// process each, parallel); the harness single-dispatch path remains
				// the fallback when the binary predates the agent subcommands.
				let acceptance: AcceptanceState = { status: 'disabled' };
				let regressionPath: string | undefined;
				// Real index epoch of the generated test set — pool events must carry
				// it (a hardcoded 0 trains any future epoch-decay prior on a constant).
				let acceptanceEpoch = 0;
				// Opaque per-episode key for the acceptance store — decoupled from
				// the episode id (which is discoverable via the pre-episode git ref).
				const acceptanceToken = newAcceptanceToken();
				// The backend-agent transport for this episode: the goal binary +
				// the same env every engine call uses. Null (binary missing) makes
				// every agent unavailable — safe paths throughout.
				const goalBin = getBinPath(_context, 'goal');
				const agentSpawn: AgentSpawn | null = fs.existsSync(goalBin)
					? {
							binPath: goalBin,
							env: getHandbookEnv(path.dirname(goalBin), workspaceRoot),
							cwd: workspaceRoot,
							dispatch: (name, prompt) =>
								dispatchAgentPrompt(
									chosenHarness,
									workspaceRoot,
									name,
									prompt,
									triggerRun.tree,
								),
						}
					: null;
				const stallJudge = (payload: { task: string; evidence_a: string; evidence_b: string }) =>
					agentSpawn
						? runGoalAgent(agentSpawn, 'judge-stall', payload)
						: Promise.resolve(null);
				if (isAcceptanceTestsEnabled() && (agentSpawn || harness.kind === 'cli')) {
					progress.report({ message: 'generating acceptance tests (pre-fix oracle)…' });
					postEpisodeUpdate({
						kind: 'note',
						text: '— generating acceptance/regression tests from the issue (agent-invisible oracle)…',
						sessionId: owningSessionId,
					});
					try {
						const snapshotForSeeds = buildGraphSnapshot(workspaceRoot);
						const seedRows =
							task.seedRows && task.seedRows.length > 0
								? task.seedRows
								: deriveSeedRows(snapshotForSeeds, task.issue, policy.seed_cap);
						const seedNodes = seedRows
							.map((r) => snapshotForSeeds.nodes[r])
							.filter((n): n is NonNullable<typeof n> => Boolean(n));
						const symbolContext = seedNodes
							.map(
								(n) =>
									`- \`${n.name}\` (${n.kind}) — ${n.file}:${n.start_line}${n.summary ? ` — ${n.summary.slice(0, 200)}` : ''}`,
							)
							.join('\n');
						if (agentSpawn) {
							// Evidence assembly for the deterministic lens selection:
							// observed value profiles of the seeds (boundary lens) and
							// healthy observed neighbors (regression lens). Both come
							// from the trace corpus — no traces, no extra lenses.
							const corpus = loadCorpus(workspaceRoot);
							const profileLines: string[] = [];
							for (const n of seedNodes.slice(0, 6)) {
								const resolved = resolveSymbol(corpus, n.name);
								const profile = resolved.match ? valuesOf(corpus, resolved.match) : null;
								if (profile) {
									profileLines.push(
										`${resolved.match} (${profile.calls} observed calls): args ${JSON.stringify(profile.args)} ret ${JSON.stringify(profile.ret)}`,
									);
								}
							}
							const seedRowSet = new Set(seedRows);
							const neighborLines: string[] = [];
							for (const f of snapshotForSeeds.flow_edges) {
								const neighborRow = seedRowSet.has(f.src)
									? f.dst
									: seedRowSet.has(f.dst)
										? f.src
										: null;
								if (neighborRow === null || seedRowSet.has(neighborRow) || f.errors > 0) {
									continue;
								}
								const n = snapshotForSeeds.nodes[neighborRow];
								if (!n) {
									continue;
								}
								const resolved = resolveSymbol(corpus, n.name);
								const profile = resolved.match ? valuesOf(corpus, resolved.match) : null;
								if (profile) {
									neighborLines.push(
										`- \`${n.name}\` — ${n.file}:${n.start_line} — ${f.calls} observed successful calls; ret ${JSON.stringify(profile.ret)}`,
									);
								}
								if (neighborLines.length >= 6) {
									break;
								}
							}
							const failureLines = seedNodes
								.flatMap((n) => snapshotForSeeds.runtime[n.row]?.failures ?? [])
								.filter((f) => f.superseded === null)
								.slice(0, 6)
								.map(
									(f) =>
										`${f.error_type}${f.error_message ? `: ${f.error_message}` : ''} (×${f.count})`,
								);
							const evidence: SwarmEvidence = {
								seedNames: seedNodes.map((n) => n.name),
								symbols:
									symbolContext ||
									'(no symbols grounded from the issue — inspect the repository)',
								failures: failureLines.join('\n'),
								valueProfiles: profileLines.join('\n'),
								healthyNeighbors: neighborLines.join('\n'),
							};
							// Reuse-with-expiry: a same-issue set from the SAME index
							// epoch may be revalidated and reused; any epoch drift means
							// regeneration (code moved — stale tests are never trusted).
							// The store is keyed by an opaque per-episode token (not
							// the git-ref-discoverable episode id); the shared root is
							// scanned by manifest content, so reuse is name-agnostic.
							const acceptanceRoot = path.join(vinvHomeDir(), 'acceptance');
							acceptanceEpoch = snapshotForSeeds.store_epoch;
							const reusable = findReusableSet(
								acceptanceRoot,
								task.issue,
								snapshotForSeeds.store_epoch,
							);
							let reused = false;
							if (reusable?.acceptance) {
								const revalidated = await runAcceptanceTests(workspaceRoot, reusable.acceptance);
								if (revalidated.signal === 'fail') {
									acceptance = {
										status: 'ready',
										path: reusable.acceptance,
										preRunOutput: revalidated.output.slice(-4000),
										grade: reusable.acceptance_grade,
									};
									regressionPath = reusable.regression;
									reused = true;
									postEpisodeUpdate({
										kind: 'note',
										text: '— reusing the prior test set for this issue (same index epoch; pre-fix gates revalidated)',
										sessionId: owningSessionId,
									});
								}
							}
							if (!reused) {
								const outcome = await runTestSwarm(evidence, {
									spawnInfo: agentSpawn,
									preRun: (file) => runAcceptanceTests(workspaceRoot, file),
									storageDir: acceptanceDir(acceptanceToken),
									issue: task.issue,
									goal: packTask.goal,
									epoch: snapshotForSeeds.store_epoch,
									onNote: (text) =>
										postEpisodeUpdate({ kind: 'note', text: `— ${text}`, sessionId: owningSessionId }),
								});
								regressionPath = outcome.regressionPath;
								// Candidate defects (a regression author expected current
								// behavior to pass and it failed) are advisory, preserved,
								// and surfaced — never blocking.
								const defects = outcome.candidates.filter((c) => c.triage === 'candidate_defect');
								if (defects.length) {
									appendEpisodeEvent({
										type: 'candidate_defect',
										ts: new Date().toISOString(),
										episode_id: episodeId,
										count: defects.length,
										files: defects.map((d) => d.path ?? '').filter(Boolean),
									});
									postEpisodeUpdate({
										kind: 'note',
										text: `— ${defects.length} candidate defect(s) preserved: a test author expected different behavior from the current code (advisory, not blocking)`,
										sessionId: owningSessionId,
									});
								}
								if (outcome.acceptancePath) {
									acceptance = {
										status: 'ready',
										path: outcome.acceptancePath,
										preRunOutput: outcome.preRunOutput,
										grade: outcome.acceptanceGrade,
									};
								} else {
									const reasons = outcome.candidates.map((c) => `${c.lens}: ${c.reason}`).join('; ');
									acceptance = {
										status: outcome.candidates.some((c) => c.reason.includes('cannot discriminate'))
											? 'not_discriminating'
											: 'unavailable',
										detail: reasons || 'no author produced a usable file',
									};
								}
							}
						} else {
							// Old binary without agent subcommands: the harness
							// single-dispatch fallback (CLI harnesses only).
							acceptance = await generateAcceptanceTests(
								chosenHarness,
								workspaceRoot,
								task.title,
								task.issue,
								packTask.goal,
								symbolContext || '(no symbols grounded from the issue — inspect the repository)',
								acceptanceToken,
								token,
							);
						}
					} catch (e) {
						acceptance = {
							status: 'unavailable',
							detail: e instanceof Error ? e.message : String(e),
						};
					}
					appendEpisodeEvent({
						type: 'acceptance',
						ts: new Date().toISOString(),
						episode_id: episodeId,
						status: acceptance.status,
						regression: Boolean(regressionPath),
						// Budget raised from 300: an 'unavailable' now carries its
						// diagnosis (interpreter tried, probe errors, output tail), and
						// truncating that back to a generic prefix is exactly the
						// failure this row exists to make debuggable.
						detail: (acceptance.detail ?? '').slice(0, 1200),
					});
					postEpisodeUpdate({
						kind: 'note',
						text:
							acceptance.status === 'ready'
								? `— acceptance tests ready: they fail on the current code (they reproduce the issue) and must pass after the fix${regressionPath ? '; regression tests pin neighbor behavior' : ''}`
								: `— acceptance tests ${acceptance.status}${acceptance.detail ? `: ${acceptance.detail}` : ''}`,
						sessionId: owningSessionId,
					});
				} else if (isAcceptanceTestsEnabled()) {
					// ide-chat harness with no goal binary: no test-author path exists.
					// Say so up front — otherwise the user only learns indirectly when
					// verification comes back "inconclusive" at escalation.
					postEpisodeUpdate({
						kind: 'note',
						text: '— acceptance-test oracle unavailable for this harness/setup (goal binary missing) — verification will rely on replay evidence and your judgment',
						sessionId: owningSessionId,
					});
				}
				// Reconciliation shared by EVERY escalation retry path (dispute, stall,
				// inconclusive, budget-exhaust): an operator note may describe a
				// behavior the automated checks missed — turn it into a counterexample
				// acceptance test so the next attempt is VERIFIED against the human's
				// case, not merely told about it. Best-effort; a non-reproducing or
				// unrunnable counterexample changes nothing. Runs even when no
				// acceptance set existed: a reproducing counterexample then BECOMES
				// the oracle (created, not merged).
				const reconcileNoteIntoOracle = async (note: string): Promise<void> => {
					if (!agentSpawn) {
						return;
					}
					try {
						const cx = await strengthenAcceptanceFromNote(
							agentSpawn,
							workspaceRoot,
							task.issue,
							note,
							acceptance.path,
							acceptanceDir(acceptanceToken),
						);
						if (cx.signal === 'reproduces' && cx.mergedPath) {
							// The strengthened (possibly newly created) oracle is now the
							// episode's acceptance file — Grade A: the human's
							// counterexample is a stated-requirement oracle.
							acceptance = { status: 'ready', path: cx.mergedPath, grade: 'A' };
							if (cx.failingOutput) {
								priorFailure = `human counterexample test fails on current code:\n${cx.failingOutput}`;
							}
						}
						postEpisodeUpdate({
							kind: 'note',
							text:
								cx.signal === 'reproduces'
									? '— your feedback reproduced on the current code: added it as a permanent test the fix must now pass'
									: cx.signal === 'does_not_reproduce'
										? '— a test built from your feedback already passes; carrying your note as guidance'
										: '— carrying your note as guidance (could not build a runnable test from it)',
							sessionId: owningSessionId,
						});
					} catch {
						// Reconciliation is best-effort; never block the retry.
					}
				};
				// Outer loop: if the operator types an instruction at the terminal
				// escalation, that grants one more attempt and re-enters the inner loop.
				outer: for (;;) {
				while (attempts < attemptBudget && !token.isCancellationRequested) {
					attempts += 1;
					progress.report({ message: `attempt ${attempts}/${attemptBudget}: composing context pack…` });
					postEpisodeUpdate({
						kind: 'note',
						text: `— attempt ${attempts}/${attemptBudget}: composing context pack…`,
						sessionId: owningSessionId,
					});
					// A fresh snapshot every attempt: the agent's edits move the epoch,
					// and the next pack must describe the code as it now is.
					let snapshot: GraphSnapshot;
					try {
						snapshot = buildGraphSnapshot(workspaceRoot);
					} catch (e) {
						priorFailure = `could not build graph snapshot: ${e instanceof Error ? e.message : String(e)}`;
						break;
					}
					const pack = writeContextPack(
						workspaceRoot,
						snapshot,
						packTask,
						decision.arm,
						packBudgets(policy),
						attempts,
						priorFailure,
					);
					lastPackPath = pack.path;
					// Capture the composition that produced this attempt so a
					// verified outcome can cross-feed the retrieval index (below).
					lastSnapshot = snapshot;
					lastSliceRows = pack.sliceRows;
					// The stall mutation binds exactly one attempt — clear it so a
					// successful redirect doesn't haunt every later pack.
					packTask.mutation = undefined;

					progress.report({ message: `attempt ${attempts}: ${harness.label} working…` });
					// Without this note the chat sits on "composing context pack…"
					// for the whole run — the pack is done; the agent is working.
					postEpisodeUpdate({
						kind: 'note',
						text: `— attempt ${attempts}: ${harness.label} working…`,
						sessionId: owningSessionId,
					});
					const started = Date.now();
					const run = await runHarnessPrompt(
						chosenHarness,
						workspaceRoot,
						`episode-${task.kind}${task.service ? `-${task.service}` : ''}`,
						pack.content,
						{
							token,
							// The agent works in this episode's own tree.
							cwd: triggerRun.tree,
							onUpdate: (line) => {
								// The chat transcript is the thinking surface; the
								// notification only mirrors lines when the panel is
								// closed (it is then the sole sign of life). With the
								// panel open it stays a calm status toast + cancel.
								if (!isAskVinvOpen()) {
									progress.report({ message: `attempt ${attempts}: ${line.slice(0, 80)}` });
								}
								postEpisodeUpdate({ kind: 'thinking', text: line, sessionId: owningSessionId });
							},
						},
					);
					const dispatchSeconds = (Date.now() - started) / 1000;

					// Precondition failure (CLI signed out, quota exhausted, vendor
					// unreachable): terminal on the FIRST occurrence. No retry can
					// succeed, so none of the machinery below — directives, dispute,
					// verify, stall judge, escalation — may engage; the episode ends
					// blocked-on-you with the exact remediation, objective:false.
					const infraStop = gateAttemptRun(run, harness);
					if (infraStop) {
						appendEpisodeEvent({
							type: 'infra_blocked',
							ts: new Date().toISOString(),
							episode_id: episodeId,
							attempt: attempts,
							kind: infraStop.kind,
							detail: infraStop.remediation.slice(0, 300),
						});
						postEpisodeUpdate({
							kind: 'note',
							text: `⛔ ${harness.label} could not run — ${infraStop.endLabel}. ${infraStop.remediation}`,
							sessionId: owningSessionId,
						});
						lastEvidence = `${infraStop.endLabel} — ${infraStop.remediation}`;
						infraBlocked = infraStop;
						// Terminal (also suppresses the trajectory continuation): this
						// is not negative evidence about the fix or the arm, so
						// lastObjectiveFail stays false and the bandit learns nothing.
						aborted = true;
						return;
					}

					// Tri-directional channel: the USER can steer Vinv from the
					// harness chat; the agent relays it as VINV: directives on stdout.
					const directives = parseHarnessDirectives(run.stdout);
					if (directives.episodeBudget !== undefined) {
						setEpisodeBudget(workspaceRoot, directives.episodeBudget, owningSessionId);
						void vscode.window.showInformationMessage(
							`Vinv: Episode budget set to ${directives.episodeBudget} (relayed from the harness chat).`,
						);
					}
					if (directives.goal !== undefined) {
						// Agent-relayed change: never reset the episode counter
						// (see setGoal) — a per-episode goal change would bypass
						// the budget and loop unbounded.
						setGoal(workspaceRoot, directives.goal, false, owningSessionId);
						void vscode.window.showInformationMessage(
							`Vinv: Standing goal updated from the harness chat: "${directives.goal}".`,
						);
					}
					// Everything the agent proposed but did not do. Carried on the
					// task so it survives into the judgment and the next pack.
					if (directives.proposals.length) {
						lastProposals = directives.proposals;
					}
					// A QUESTION cannot have its premise disputed — there is no
					// premise beyond "explain this". An agent reporting "nothing is
					// broken here" has ANSWERED, and routing that into the Nash judge
					// is what turned a correct answer into an arbitration the operator
					// had to referee. Answer-intent runs settle below, not here.
					const isQuestion = task.intent === 'question';
					// Dispute channel: the coding agent says the PREMISE is wrong
					// ("no issue here" / "the recorded command is wrong"). The two
					// systems then bargain instead of looping: the Nash judge weighs
					// vinv's evidence against the agent's dispute — escalate trips
					// the circuit to the human; continue must name a mutation.
					//
					// Gated on attempts >= 2: the judge's own brief states that two
					// consecutive attempts produced near-identical evidence, which is
					// simply false on attempt 1. Firing it there had it bargaining
					// from a premise that never happened. A first-attempt dispute
					// instead feeds the next attempt as evidence and lets the loop
					// run — the second one escalates if the agent holds its position.
					if (directives.dispute !== undefined && !isQuestion && attempts < 2) {
						priorFailure =
							`attempt ${attempts} disputed the premise rather than failing: ` +
							`${directives.dispute}\n` +
							'Vinv has NOT accepted this. Either substantiate it concretely against the ' +
							'evidence above, or proceed with the task.';
						postEpisodeUpdate({
							kind: 'note',
							text: `— attempt ${attempts}: agent disputed the premise; re-dispatching once before escalating`,
							sessionId: owningSessionId,
						});
						continue;
					}
					if (directives.dispute !== undefined && !isQuestion) {
						lastDispute = directives.dispute;
						progress.report({ message: `attempt ${attempts}: agent disputes the premise — negotiating…` });
						const verdict = await breakStall(
							task.title,
							`Vinv's evidence for the issue:\n${task.issue}`,
							`The coding agent disputes the premise: ${directives.dispute}\n` +
								`Agent output (tail):\n${run.stdout.slice(-policy.failure_evidence_chars)}`,
							stallJudge,
						);
						appendEpisodeEvent({
							type: 'dispute',
							ts: new Date().toISOString(),
							episode_id: episodeId,
							attempt: attempts,
							dispute: directives.dispute.slice(0, 300),
							action: verdict.action,
							mutation: verdict.mutation.slice(0, 300),
						});
						if (verdict.action === 'escalate') {
							const { action: call, note, selectedProposals } = await escalate(
								task.title,
								// The dispute is prose that itself contains quotes; wrapping
								// it in more quotes produced unreadable nesting at exactly
								// the moment the operator most needs to read it. Give it its
								// own block instead.
								'The coding agent disputes the task premise. In its words:\n\n' +
									`${directives.dispute}\n\n` +
									'The negotiation judge agrees this needs your call. ' +
									'Accept = agree there is no issue (close the episode); ' +
									'Reject & retry = the issue is real, try again.',
								lastPackPath,
								snapshotSha !== null,
								{ agent: harness.label, attempt: attempts, attemptBudget },
								token,
								{ proposals: lastProposals },
							);
							if (call === 'approve') {
								verified = true;
								// The operator agreed the disputed premise is not real — for an
								// optimize episode that means the ranked row is not a genuine
								// opportunity, so record it dismissed (a terminal panel badge)
								// rather than leaving it stuck 'dispatched'.
								dismissDisputedOptimization(workspaceRoot, task, directives.dispute);
								queueProposalEpisodes(selectedProposals);
								return;
							}
							if (call === 'revert') {
								await doRevert();
								aborted = true;
								return;
							}
							if (call === 'abort') {
								aborted = true;
								return;
							}
							queueProposalEpisodes(selectedProposals);
							// Operator-directed retry: their instruction is authoritative,
							// and may push past the planned budget.
							if (note) {
								packTask.operator_note = note;
								if (attempts >= attemptBudget) {
									attemptBudget += 1;
								}
							}
							packTask.mutation = verdict.mutation;
							// NEVER assert what the operator said — they may have typed the
							// exact opposite. Hardcoding "the operator says the issue is
							// real" meant a note like "good analysis, do #1 and #2" reached
							// the next agent alongside a sentence contradicting it. Carry
							// the agent's own prior output too, so references like "#1" in
							// the operator's note still resolve.
							priorFailure = note
								? `attempt ${attempts} disputed the premise:\n${directives.dispute}\n\n` +
									'The operator read that and gave the direction recorded under ' +
									'"Operator direction" — follow it. What that attempt reported:\n' +
									`${run.stdout.slice(-policy.failure_evidence_chars)}`
								: `attempt ${attempts} disputed the premise ("${directives.dispute}") and the ` +
									'operator asked for another attempt without further direction.';
							if (note) {
								await reconcileNoteIntoOracle(note);
							}
							continue;
						}
						packTask.mutation = verdict.mutation;
					}

					// ONE evidence budget for the whole chain — the policy's learned
					// failure_evidence_chars — applied at capture; downstream consumers
					// (pack, escalation, judge) receive it whole, never re-truncated.
					const evidenceBudget = policy.failure_evidence_chars;
					let verify: VerifyResult;
					// Static pre-gate (cheapest check first): every changed python
					// file must PARSE before replay/test budget is spent. A parse
					// failure is an objective rejection of the attempt with the
					// exact error as evidence for the next pack.
					const gate = run.ok ? await staticPreGate(workspaceRoot, episodeId) : null;
					const preGateFailed = gate !== null && !gate.ok;
					if (!run.ok) {
						verify = {
							verdict: 'fail',
							objective: false, // the harness itself failed to run — infra, not an oracle rejection
							reason: `harness run failed: ${run.detail ?? 'unknown'}`,
							outputTail: run.stdout.slice(-evidenceBudget),
						};
					} else if (preGateFailed && gate) {
						verify = {
							verdict: 'fail',
							objective: true,
							reason:
								`static pre-gate: ${gate.failures.length} changed file(s) do not parse:\n` +
								gate.failures.map((f) => `${f.file}: ${f.error}`).join('\n'),
							outputTail: run.stdout.slice(-evidenceBudget),
						};
					} else if (task.kind === 'service-fix' && task.service) {
						progress.report({ message: `attempt ${attempts}: verifying ${task.service} by replay…` });
						verify = await verifyServiceReplay(workspaceRoot, task.service, token, evidenceBudget);
					} else if (isQuestion) {
						// A question's oracle is that it was answered. There is nothing to
						// replay, and 'inconclusive' was the wrong word for it: a correct,
						// complete answer was being reported as a failed verification and
						// pushed at the operator as a problem to adjudicate. It settles as
						// an ANSWER — the episode succeeded — and the only thing left for
						// the operator is which proposals (if any) become work.
						verify = {
							verdict: 'answered',
							reason: 'the question was answered; no code change was required',
							outputTail: run.stdout.slice(-evidenceBudget),
						};
					} else {
						// General tasks: the acceptance tests (when they exist) are the
						// oracle — see below. Without them, evidence is the agent's own
						// report and the human decides. When an oracle WAS attempted and
						// did not survive, say why: 'no automatic verification for this
						// task kind' reads as "nothing could ever have checked this",
						// which is false — and it buried a one-line interpreter fix
						// behind a generic shrug while a correct fix went uncertified.
						verify = {
							verdict: 'inconclusive',
							reason:
								acceptance.status === 'unavailable' || acceptance.status === 'not_discriminating'
									? `no automatic verification: the acceptance oracle is ${acceptance.status}${acceptance.detail ? ` — ${acceptance.detail.slice(0, 400)}` : ''}`
									: 'no automatic verification for this task kind',
							outputTail: run.stdout.slice(-evidenceBudget),
						};
					}

					// ---- multi-signal reward: tests, regression, audit, judge -------
					// The oracle signal for the rubric, before any augmentation. A
					// pre-gate failure never mislabels the replay oracle: the replay
					// did not run, so the oracle is unavailable, and the parse errors
					// carry the evidence instead.
					const oracleSignal: OracleSignal =
						task.kind !== 'service-fix'
							? 'none'
							: preGateFailed
								? 'unavailable'
								: verify.verdict === 'pass'
									? verify.objective === true
										? 'pass_objective'
										: 'pass_heuristic'
									: verify.verdict === 'fail'
										? verify.objective === true
											? 'fail'
											: 'unavailable'
										: 'unavailable';

					// Acceptance tests: the agent-invisible oracle. For a service
					// episode they tighten "serves on the port" into "serves AND
					// behaves as the issue asks"; for a general episode they ARE the
					// oracle that never existed before. Run only when the attempt is
					// otherwise a candidate (general always; service on oracle pass —
					// a dead service needs no behavioral verdict; a non-parsing patch
					// needs neither).
					let testsSignal: TestSignal =
						acceptance.status === 'ready' ? 'unavailable' : acceptance.status;
					if (
						run.ok &&
						!preGateFailed &&
						acceptance.status === 'ready' &&
						acceptance.path &&
						(task.kind !== 'service-fix' || verify.verdict === 'pass')
					) {
						progress.report({ message: `attempt ${attempts}: running acceptance tests…` });
						const acceptanceRunStart = Date.now();
						const t = await runAcceptanceTests(workspaceRoot, acceptance.path);
						testsSignal = t.signal;
						appendPoolEvent({
							episode_id: episodeId,
							attempt: attempts,
							epoch: acceptanceEpoch,
							role: 'acceptance',
							file: acceptance.path,
							signal: t.signal === 'pass' || t.signal === 'fail' ? t.signal : null,
							grade: acceptance.grade,
							duration_ms: Date.now() - acceptanceRunStart,
						});
						if (task.kind !== 'service-fix') {
							if (t.signal === 'pass') {
								verify = {
									verdict: 'pass',
									objective: true,
									reason:
										'acceptance tests pass — generated pre-fix from the issue, failing then, agent-invisible',
									outputTail: t.output.slice(-evidenceBudget),
								};
							} else if (t.signal === 'fail') {
								verify = {
									verdict: 'fail',
									objective: true,
									reason:
										'the pre-generated acceptance tests still fail — the change does not produce the behavior the issue asks for',
									outputTail: t.output.slice(-evidenceBudget),
								};
							}
							// unavailable → stays inconclusive; the human decides.
						} else if (verify.verdict === 'pass' && t.signal === 'fail') {
							verify = {
								verdict: 'fail',
								objective: true,
								reason:
									'the service serves, but the pre-generated acceptance tests still fail — booting is not the behavior the issue asks for',
								outputTail: t.output.slice(-evidenceBudget),
							};
						}
					}

					// Regression tests (pass-to-pass): pinned pre-fix neighbor
					// behavior must survive the fix. A regression failure is an
					// objective rejection — the fix broke what it was not asked to
					// touch (collateral-damage detection).
					let regressionSignal: TestSignal = regressionPath ? 'unavailable' : 'disabled';
					if (run.ok && !preGateFailed && regressionPath && verify.verdict === 'pass') {
						progress.report({ message: `attempt ${attempts}: running regression tests…` });
						const regressionRunStart = Date.now();
						const rr = await runAcceptanceTests(workspaceRoot, regressionPath);
						regressionSignal = rr.signal;
						appendPoolEvent({
							episode_id: episodeId,
							attempt: attempts,
							epoch: acceptanceEpoch,
							role: 'regression',
							file: regressionPath,
							signal: rr.signal === 'pass' || rr.signal === 'fail' ? rr.signal : null,
							duration_ms: Date.now() - regressionRunStart,
						});
						if (rr.signal === 'fail') {
							verify = {
								verdict: 'fail',
								objective: true,
								reason:
									'regression: tests that passed on the pre-fix code now fail — the fix broke neighboring behavior it was not asked to change',
								outputTail: rr.output.slice(-evidenceBudget),
							};
						}
					}

					// Anti-cheat audit + bounded judge, on candidate passes only. The
					// judge is a BACKEND agent (goal binary) and can push a flagged
					// pass down to a failure with reasons — never the reverse (soft
					// signals cannot rescue a failed gate).
					let breakdown: RewardBreakdown;
					if (verify.verdict === 'pass') {
						// Audit the run's own tree: the snapshot ref it diffs against
						// was captured there, and in the shared root the diff would
						// also sweep up whatever other episodes and the user changed.
						const flags = await auditWorkspaceDiff(triggerRun.tree, episodeId);
						// The judge runs on: any audit flag, a non-objective pass, OR
						// whenever stated success criteria exist — a served-port +
						// tests-pass fix can still fail to meet the SPECIFIED goal
						// ("almost right but not what was asked"), which only the
						// goal-adherence judge catches.
						const needJudge =
							flags.length > 0 || verify.objective !== true || task.successCriteria.length > 0;
						const judge = needJudge
							? await judgeEpisodeDiff(
									workspaceRoot,
									episodeId,
									task.title,
									task.issue,
									flags,
									agentSpawn,
									packTask.goal,
									task.successCriteria,
								)
							: null;
						breakdown = composeRewardBreakdown(
							oracleSignal,
							testsSignal,
							flags,
							judge,
							regressionSignal,
							policy.judge_cheat_threshold ?? undefined,
							task.successCriteria.length,
							acceptance.status === 'ready' ? acceptance.grade : undefined,
						);
						if (!breakdown.verifiedEligible) {
							// Branch the header by CAUSE: a conduct finding (hard flag /
							// cheat) is "gaming the checks"; an unmet stated criterion is
							// "right code, wrong spec" — mislabeling one as the other
							// poisons the feedback the next attempt learns from.
							const header =
								breakdown.verifiedBlockCause === 'criteria'
									? 'the change passes the mechanical checks but does not satisfy a stated success criterion:'
									: 'verification checks flagged this change as potentially gaming the checks rather than fixing the issue:';
							verify = {
								verdict: 'fail',
								// Cheat suspicion is about the agent's conduct, not the
								// composition arm — never objective negative evidence.
								objective: false,
								reason: `${header}\n` + breakdown.reasons.join('\n'),
								outputTail: verify.outputTail,
							};
						}
					} else {
						breakdown = composeRewardBreakdown(
							oracleSignal,
							testsSignal,
							[],
							null,
							regressionSignal,
							policy.judge_cheat_threshold ?? undefined,
							task.successCriteria.length,
							acceptance.status === 'ready' ? acceptance.grade : undefined,
						);
					}
					// Advisory mutation smoke on a candidate pass: does the oracle
					// notice small perturbations of the CHANGED functions? Survivors
					// = unpoliced neighborhood. Logged + telemetry only — never a
					// gate, and never revealed to the fixing agent (Goodhart guard).
					if (
						verify.verdict === 'pass' &&
						acceptance.status === 'ready' &&
						acceptance.path &&
						!preGateFailed
					) {
						try {
							const { execFile: ef } = await import('child_process');
							const diffText: string = await new Promise((resolveDiff) =>
								ef(
									'git',
									['diff', `refs/vinv/pre-episode/${episodeId}`, '--'],
									{ cwd: workspaceRoot, maxBuffer: 64 * 1024 * 1024 },
									(err, stdout) => resolveDiff(err ? '' : stdout),
								),
							);
							if (diffText) {
								const smoke = await runMutationSmoke(
									workspaceRoot,
									parseUnifiedDiff(diffText),
									acceptance.path,
								);
								if (smoke.status === 'ok' && smoke.mutants > 0) {
									appendEpisodeEvent({
										type: 'mutation_smoke',
										ts: new Date().toISOString(),
										episode_id: episodeId,
										attempt: attempts,
										mutants: smoke.mutants,
										killed: smoke.killed,
										survivors: smoke.survivors.slice(0, 8),
									});
									postEpisodeUpdate({
										kind: 'note',
										text: `— mutation smoke: acceptance tests killed ${smoke.killed}/${smoke.mutants} small perturbations of the changed code${smoke.killed < smoke.mutants ? ' (survivors logged — the oracle has unpoliced neighborhoods; advisory)' : ''}`,
										sessionId: owningSessionId,
									});
								}
							}
						} catch {
							// Advisory only — any failure is silent unavailability.
						}
					}
					lastBreakdown = breakdown;
					// The reward report rides into the next pack so a low score
					// arrives with its reasons and the exact directives that raise it.
					packTask.reward_report =
						verify.verdict === 'pass' ? undefined : renderRewardReport(breakdown);

					// Track whether this failure was a genuine oracle rejection, so
					// a later revert/abort is labeled objective (or not) uniformly.
					lastObjectiveFail = verify.verdict === 'fail' && verify.objective === true;

					appendEpisodeEvent({
						type: 'attempt',
						ts: new Date().toISOString(),
						episode_id: episodeId,
						attempt: attempts,
						harness_ok: run.ok,
						dispatch_seconds: Math.round(dispatchSeconds * 10) / 10,
						verdict: verify.verdict,
						reason: verify.reason.slice(0, 300),
						pack_path: pack.path,
						slice_size: pack.sliceRows.length,
						reward: breakdown.reward,
						oracle: breakdown.oracle,
						tests: breakdown.tests,
						regression: breakdown.regression,
						audit_flags: breakdown.flags.map((f) => f.kind),
						judge_cheat: breakdown.judge?.cheat_likelihood ?? null,
					});

					if (verify.verdict === 'pass') {
						verified = true;
						// Only a served-port pass is objective; a portless survival
						// pass surfaces as success but does not train the bandit.
						objectiveOutcome = verify.objective === true;
						void vscode.window.showInformationMessage(
							`Vinv: Episode "${task.title}" verified after ${attempts} attempt(s) — ${verify.reason}.`,
						);
						return;
					}
					if (verify.verdict === 'answered') {
						// The episode already succeeded. This judgment is not "is this
						// acceptable?" — it is "which of these proposals do you want?",
						// and closing it without ticking anything is a perfectly normal,
						// successful end. Never treated as a stall or a dispute.
						verified = true;
						// No oracle ran, so this must not train the composition bandit.
						objectiveOutcome = false;
						const { action: call, note, selectedProposals } = await escalate(
							task.title,
							`${verify.reason}\n\nWhat the agent reported:\n${verify.outputTail ?? ''}`,
							pack.path,
							snapshotSha !== null,
							{ agent: harness.label, attempt: attempts, attemptBudget },
							token,
							{ mode: 'answer', proposals: lastProposals },
						);
						queueProposalEpisodes(selectedProposals);
						if (call === 'revert') {
							await doRevert();
							verified = false;
							aborted = true;
							return;
						}
						if (call === 'abort') {
							// Abort after an answer is not a failure — the answer stands.
							return;
						}
						if (call === 'retry' && note) {
							// A follow-up question, not a rejection: same episode, extra
							// direction, and the previous answer carried forward so the
							// agent is not starting over.
							verified = false;
							packTask.operator_note = note;
							priorFailure =
								'The operator read the answer below and asked a follow-up (see ' +
								`"Operator direction"). Previous answer:\n${verify.outputTail ?? ''}`;
							if (attempts >= attemptBudget) {
								attemptBudget += 1;
							}
							continue;
						}
						void vscode.window.showInformationMessage(
							`Vinv: Episode "${task.title}" answered after ${attempts} attempt(s).`,
						);
						return;
					}
					if (verify.verdict === 'inconclusive') {
						const { action: call, note, selectedProposals } = await escalate(
							task.title,
							`${verify.reason}\n\nAgent output (tail):\n${verify.outputTail ?? ''}`,
							pack.path,
							snapshotSha !== null,
							{ agent: harness.label, attempt: attempts, attemptBudget },
							token,
							{ proposals: lastProposals },
						);
						queueProposalEpisodes(selectedProposals);
						if (call === 'approve') {
							verified = true;
							return;
						}
						if (call === 'revert') {
							await doRevert();
							aborted = true;
							return;
						}
						if (call === 'abort') {
							aborted = true;
							return;
						}
						// Operator-directed retry: their instruction is authoritative,
						// and may push past the planned budget.
						if (note) {
							packTask.operator_note = note;
							if (attempts >= attemptBudget) {
								attemptBudget += 1;
							}
						}
						priorFailure = `the operator reviewed attempt ${attempts} and requested a retry; verification was inconclusive: ${verify.reason}`;
						if (note) {
							await reconcileNoteIntoOracle(note);
						}
						continue;
					}
					// Definitive failure: feed the evidence back into the next pack —
					// whole. composePackContent applies failure_evidence_chars once;
					// no second gate here.
					const evidence = `${verify.reason}\n${verify.outputTail ?? ''}`;
					priorFailure =
						`attempt ${attempts} failed verification: ${verify.reason}\n` +
						`output tail:\n${verify.outputTail ?? ''}`;
					// Stall detection: near-identical evidence twice in a row means a
					// plain retry is worthless. A Nash-bargaining judge (explorer vs
					// auditor) decides between one more MUTATED attempt and escalation.
					const previousEvidence = lastEvidence;
					const similarity = previousEvidence ? evidenceSimilarity(previousEvidence, evidence) : 0;
					lastEvidence = evidence;
					if (similarity >= policy.stall_similarity) {
						progress.report({ message: `attempt ${attempts}: stall detected — negotiating…` });
						const verdict = await breakStall(task.title, previousEvidence, evidence, stallJudge);
						appendEpisodeEvent({
							type: 'stall',
							ts: new Date().toISOString(),
							episode_id: episodeId,
							attempt: attempts,
							similarity: Math.round(similarity * 100) / 100,
							action: verdict.action,
							nash_continue: Math.round(verdict.nash_continue * 1000) / 1000,
							mutation: verdict.mutation.slice(0, 300),
						});
						if (verdict.action === 'escalate') {
							const { action: call, note, selectedProposals } = await escalate(
								task.title,
								`Two attempts produced near-identical failures (similarity ${similarity.toFixed(2)}); ` +
									`the stall judge recommends your review.\nLast failure:\n${priorFailure}`,
								pack.path,
								snapshotSha !== null,
								{ agent: harness.label, attempt: attempts, attemptBudget },
								token,
								{ proposals: lastProposals },
							);
							queueProposalEpisodes(selectedProposals);
							if (call === 'approve') {
								verified = true;
								return;
							}
							if (call === 'revert') {
								await doRevert();
								aborted = true;
								return;
							}
							if (call === 'abort') {
								aborted = true;
								return;
							}
							// Operator chose retry: adopt the judge's mutation, and honor any
							// typed instruction as authoritative direction.
							if (note) {
								packTask.operator_note = note;
								await reconcileNoteIntoOracle(note);
							}
						}
						postEpisodeUpdate({
							kind: 'note',
							text: `— negotiated: continuing with a changed approach: ${verdict.mutation.slice(0, 160)}`,
							sessionId: owningSessionId,
						});
						packTask.mutation = verdict.mutation;
						// Agent-analyzed budget extension: a negotiated continue on the
						// final attempt earns one more, up to the policy ceiling.
						if (attempts >= attemptBudget && attemptBudget < policy.attempt_budget_max) {
							attemptBudget += 1;
						}
					}
				}
				if (token.isCancellationRequested) {
					aborted = true;
					break outer;
				}
				if (verified || aborted) {
					break outer;
				}
				// Budget exhausted without a pass: the human decides.
				const { action: call, note, selectedProposals } = await escalate(
					task.title,
					`All ${attemptBudget} attempts failed verification.\nLast failure:\n${priorFailure ?? 'unknown'}`,
					lastPackPath,
					snapshotSha !== null,
					{ agent: harness.label, attempt: attempts, attemptBudget },
					token,
					{ proposals: lastProposals },
				);
				queueProposalEpisodes(selectedProposals);
				if (call === 'approve') {
					verified = true;
					break outer;
				}
				if (call === 'revert') {
					await doRevert();
					aborted = true;
					break outer;
				}
				if (call === 'retry') {
					// Operator directed another attempt (with or without an instruction):
					// grant it and re-enter the inner loop.
					if (note) {
						packTask.operator_note = note;
						await reconcileNoteIntoOracle(note);
					}
					attemptBudget += 1;
					continue outer;
				}
				aborted = true;
				break outer;
				}
			},
		);
	} finally {
		// Stamp the run and fold it into the root aggregates, then drop the
		// worktree while KEEPING its branch: the checkout is scratch, the branch
		// is the deliverable the user reviews or cherry-picks.
		closeRun(workspaceRoot, triggerRun, {
			episode_id: episodeId,
			kind: task.kind,
			service: task.service ?? null,
			harness: chosenHarness,
			attempts,
			verified,
			aborted,
			objective: objectiveOutcome,
			arm: decision.arm,
			arm_index: decision.armIndex,
		});
		await releaseRun(workspaceRoot, triggerRun);
		episodeRunning = false;
		currentEpisodeSessionId = undefined;
		// The episode is over: a later click on a stale chat cancel control must
		// be a no-op, not a cancel of some future episode.
		setEpisodeCancel(undefined);
		cts.dispose();
		// Unified objective-negative rule for EVERY abort/revert terminal (stall,
		// dispute, inconclusive, budget-exhaust, cancellation): the arm is blamed
		// only when the oracle genuinely rejected the fix (lastObjectiveFail), not
		// for infra failures, inconclusive general tasks, or a mid-run cancel. A
		// served-port pass already set objectiveOutcome=true and cannot be aborted.
		if (aborted) {
			objectiveOutcome = lastObjectiveFail;
		}
		postEpisodeUpdate({
			kind: 'end',
			// An infra block is neither "stopped" (the user did nothing) nor "not
			// verified" (the fix was never judged) — it is blocked ON THE USER,
			// and the label says exactly what unblocks it.
			text: infraBlocked
				? infraBlocked.endLabel
				: verified
					? 'verified'
					: aborted
						? 'stopped'
						: 'not verified',
			ok: verified,
			sessionId: owningSessionId,
			episodeId,
		});
		const reward = episodeReward(verified, Math.max(1, attempts), policy.attempt_budget, aborted);
		appendEpisodeEvent({
			type: 'episode_end',
			ts: new Date().toISOString(),
			episode_id: episodeId,
			verified,
			aborted,
			// Non-null when the episode ended on a harness precondition failure
			// (auth/quota/network) — infra, never composition evidence.
			infra: infraBlocked?.kind ?? null,
			// Whether this outcome trains the composition bandit (oracle verdict)
			// or is excluded (human discretion / abort / no-oracle general task).
			objective: objectiveOutcome,
			attempts,
			reward,
			// The multi-signal breakdown of the FINAL attempt: rubric reward,
			// per-signal outcomes, audit flags, judge likelihoods (null pre-attempt).
			reward_breakdown: lastBreakdown
				? {
						reward: lastBreakdown.reward,
						oracle: lastBreakdown.oracle,
						tests: lastBreakdown.tests,
						regression: lastBreakdown.regression,
						audit_flags: lastBreakdown.flags.map((f) => f.kind),
						judge_cheat: lastBreakdown.judge?.cheat_likelihood ?? null,
						reasons: lastBreakdown.reasons.slice(0, 8),
					}
				: null,
		});
		// Trajectory memory: the outcome joins the session so the NEXT episode's
		// pack cites the full trajectory and its reward trend.
		try {
			recordEpisodeOutcome(workspaceRoot, {
				episode_id: episodeId,
				ts: new Date().toISOString(),
				title: task.title,
				arm_index: decision.armIndex,
				attempts,
				verified,
				aborted,
				reward,
				// Carried so the trajectory can say whether anything executable
				// stood behind the number: `reward` is renormalized over available
				// components, so it alone cannot distinguish a verified pass from an
				// episode where no check could run.
				verification_weight: lastBreakdown?.verificationWeight,
				// The digest line is the first evidence line WHOLE; the pack path
				// points at the complete artifact for anything the line elides.
				evidence:
					lastEvidence.split('\n')[0] ||
					(verified
						? 'verified'
						: lastDispute
							? `agent disputed the premise: ${lastDispute.split('\n')[0]}`
							: 'no evidence'),
				pack_path: lastPackPath || undefined,
				// Full issue + service enable post-completion dispute (the issue
				// signature locates this episode's test set; re-dispatch needs both).
				issue: task.issue,
				service: task.service,
			}, owningSessionId);
			// The transcript gets the outcome too, so switching back to this
			// session later shows the episode happened even though its live
			// feed only rendered where the user was watching.
			appendTranscriptEntry(
				workspaceRoot,
				{
					kind: 'notice',
					ts: new Date().toISOString(),
					text:
						`episode "${task.title}" ` +
						(infraBlocked
							? infraBlocked.endLabel
							: verified
								? 'verified'
								: aborted
									? 'stopped'
									: 'not verified') +
						` after ${attempts} attempt(s)`,
				},
				owningSessionId,
			);
		} catch {
			// Session bookkeeping must never mask the episode result.
		}
		// Close the loop: every finished episode re-estimates the policy from
		// the full ledger (arm posteriors, greedy arm, attempt budget) —
		// including any optimization_outcome verdicts that resolved since the
		// last update (they re-label their episodes as objective evidence) —
		// and refreshes the workspace's optimization-calibration artifact.
		try {
			maybeUpdateEpisodePolicy(workspaceRoot);
		} catch {
			// A failed update never blocks the episode result; the next end retries.
		}
		// Cross-feed: a VERIFIED, objective fix distills the issue's vocabulary
		// into the retrieval index for the symbols that were in the winning pack
		// — closing the episode↔retrieval silo so a fix compounds into better
		// future retrieval (the symmetric counterpart of a QnA thumbs-up).
		// Best-effort and fully non-blocking; never affects the episode result.
		if (verified && objectiveOutcome && lastSnapshot && lastSliceRows.length) {
			try {
				const hits = sliceRowsToHits(lastSnapshot, lastSliceRows);
				if (hits.length) {
					void enrichTagsFromFeedback(workspaceRoot, task.issue, hits).catch(() => undefined);
				}
			} catch {
				// A cross-feed failure must never mask the episode result.
			}
		}
	}
	// Trajectory continuation: a failed (not user-aborted) episode with budget
	// remaining offers the next one — auto-continues when the user enabled
	// auto-episodes, always bounded by the session's episode budget. The next
	// episode draws a fresh arm and its pack cites this failure via the
	// trajectory digest, so it is a new approach, not a blind rerun.
	if (!verified && !aborted) {
		// The continuation reads (and re-enters under) the OWNING session — the
		// user may be looking at a different one by now.
		const after =
			(owningSessionId ? loadSessionById(workspaceRoot, owningSessionId) : undefined) ??
			loadSession(workspaceRoot);
		if (after.episodes_used < after.episode_budget) {
			const remaining = after.episode_budget - after.episodes_used;
			if (isAutoEpisodesEnabled()) {
				void vscode.window.showInformationMessage(
					`Vinv: Continuing the run — episode ${after.episodes_used + 1}/${after.episode_budget} for "${task.title}".`,
				);
				return runEpisode(_context, workspaceRoot, task, chosenHarness, owningSessionId);
			}
			void vscode.window
				.showInformationMessage(
					`Vinv: Episode failed. ${remaining} episode(s) left in the budget for "${task.title}".`,
					'Start next episode',
					'Stop run',
				)
				.then((choice) => {
					if (choice === 'Start next episode') {
						void runEpisode(_context, workspaceRoot, task, chosenHarness, owningSessionId);
					}
				});
		} else {
			void vscode.window.showWarningMessage(
				`Vinv: Episode budget (${after.episode_budget} episodes) is spent for "${task.title}". ` +
					'Raise it with "Vinv: Set Episode Budget" or say so in your harness chat.',
			);
		}
	}
	return verified;
}

/**
 * Post-completion dispute — the production wiring of the reconciliation
 * protocol (reconcile() in reconciliation.ts). A human looks at an episode
 * Vinv marked VERIFIED and says it is still wrong:
 *
 *   1. reconcile('reject_no_detail') → ASK: one targeted question for the
 *      behavior that is still wrong. Cancelling = no_response → reward
 *      unchanged (MNAR), exactly the state machine's rule.
 *   2. The note is authored into a counterexample test and run on the current
 *      code (strengthenAcceptanceFromNote — merge happens only on reproduce).
 *   3. reconcile('reject_with_detail', result) decides:
 *      - reproduces → RETRACT the verified bit (ledger 'reconciliation' event
 *        + session amendment; the policy updater re-labels the episode as an
 *        objective negative — a reproducible failing test is objective
 *        evidence, unlike a bare thumbs-down), then RE-DISPATCH with the
 *        strengthened oracle (same issue signature → the new episode reuses
 *        and revalidates the merged test set).
 *      - does_not_reproduce → verdict STANDS; the acceptance file is opened so
 *        the human sees exactly what the tests check (transparency, never a
 *        silent override).
 *      - unavailable → verdict stands with an honest "could not verify".
 */
export async function disputeVerifiedEpisode(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	episodeId?: string,
): Promise<void> {
	const session = loadSession(workspaceRoot);
	// A "still wrong?" click carries its block's episode id — dispute exactly
	// that episode. Without one (command palette), fall back to the most
	// recently verified episode in the session.
	const disputable = episodeId
		? session.history.find((e) => e.episode_id === episodeId && e.verified && e.issue)
		: [...session.history].reverse().find((e) => e.verified && e.issue);
	if (!disputable) {
		void vscode.window.showInformationMessage(
			episodeId
				? 'Vinv: That episode has no disputable record (no stored issue text, or it was never verified).'
				: 'Vinv: No verified episode with a recorded issue to dispute in this session. ' +
					'(Episodes verified before reconciliation shipped lack the needed record.)',
		);
		return;
	}
	// Busy-guard BEFORE any retraction: retracting with no immediate path to a
	// re-run would strand the user with a "wrong" verdict and no fix underway.
	if (isEpisodeRunning() || isHarnessBusy()) {
		void vscode.window.showInformationMessage(
			'Vinv: an episode is already running — dispute this result after it finishes.',
		);
		return;
	}
	const ask = reconcile('reject_no_detail');
	// Two-surface presentation: the Ask Vinv themed card when the panel is
	// open (the transcript is where the verified result was seen), the plain
	// input box otherwise — the same pattern escalations use.
	let note: string | undefined;
	const carded = await requestDisputeNote({
		title: disputable.title,
		question: ask.message,
		placeholder: 'e.g. add(2, -3) still returns 5 — negative amounts are ignored',
	});
	if (carded === 'unavailable') {
		note = await vscode.window.showInputBox({
			title: `Dispute: ${disputable.title}`,
			prompt: ask.message,
			placeHolder: 'e.g. add(2, -3) still returns 5 — negative amounts are ignored',
			ignoreFocusOut: true,
		});
	} else {
		note = carded;
	}
	if (!note || !note.trim()) {
		const unchanged = reconcile('no_response');
		void vscode.window.showInformationMessage(`Vinv: ${unchanged.message}`);
		return;
	}
	postEpisodeUpdate({ kind: 'start', text: `dispute: ${disputable.title}`, sessionId: undefined });
	postEpisodeUpdate({
		kind: 'note',
		text: '— authoring a counterexample test from your report and running it against the current code…',
		sessionId: undefined,
	});
	const goalBin = getBinPath(context, 'goal');
	const agentSpawn: AgentSpawn | null = fs.existsSync(goalBin)
		? {
				binPath: goalBin,
				env: getHandbookEnv(path.dirname(goalBin), workspaceRoot),
				cwd: workspaceRoot,
				dispatch: (name, prompt) =>
					dispatchAgentPrompt(getHarnessId(), workspaceRoot, name, prompt),
			}
		: null;
	// Locate this issue's test set at the current epoch (may be absent — the
	// counterexample then becomes the oracle in a fresh store).
	let epoch = 0;
	try {
		epoch = buildGraphSnapshot(workspaceRoot).store_epoch;
	} catch {
		// No index — the counterexample can still be authored and run.
	}
	const acceptanceRoot = path.join(vinvHomeDir(), 'acceptance');
	const reusable = findReusableSet(acceptanceRoot, disputable.issue as string, epoch);
	const storageDir = reusable?.acceptance
		? path.dirname(reusable.acceptance)
		: acceptanceDir(newAcceptanceToken());
	const cx = await vscode.window.withProgress(
		// Status bar, not a toast. This spawns an agent and can run for minutes,
		// `strengthenAcceptanceFromNote` takes no cancellation token, and a
		// notification-location progress without `cancellable` has no close button —
		// so as a toast it was minutes of corner real estate the user could not
		// dismiss. Every outcome below ends in its own message or opened file.
		{ location: vscode.ProgressLocation.Window, title: 'Vinv: building a counterexample test from your report…' },
		() =>
			strengthenAcceptanceFromNote(
				agentSpawn,
				workspaceRoot,
				disputable.issue as string,
				note,
				reusable?.acceptance,
				storageDir,
				// Merge is DEFERRED on the dispute path: the permanent oracle takes
				// the counterexample only after the human confirms it captures
				// their report (merging first would pollute the oracle with a test
				// the human never endorsed).
				{ deferMerge: true },
			),
	);
	// Crash-class reproduction cannot retract: the test failed before ever
	// checking the reported case (a hallucinated API, a fixture error). Both
	// classes fail deterministically twice, so only the output classifier can
	// tell them apart — an honest stand, with the test shown.
	if (cx.signal === 'reproduces' && cx.failureClass !== 'assertion') {
		postEpisodeUpdate({
			kind: 'end',
			text: 'the counterexample test crashed before checking your case — verdict unchanged',
			ok: true,
			sessionId: undefined,
		});
		appendEpisodeEvent({
			type: 'reconciliation',
			ts: new Date().toISOString(),
			episode_id: disputable.episode_id,
			action: 'stand_crash_class',
			counterexample: cx.signal,
			retracted: false,
			confirm: 'not_offered',
		});
		void vscode.window.showInformationMessage(
			'Vinv: the test built from your report crashed before checking your case (not an assertion failure) — the verdict is unchanged. The test file is open so you can see what happened.',
		);
		if (cx.stagedPath) {
			try {
				await vscode.window.showTextDocument(vscode.Uri.file(cx.stagedPath), { preview: false });
			} catch {
				// The message already carried the decision.
			}
		}
		return;
	}
	// Confirm-before-retract: the verdict relabel trains the bandit as an
	// objective negative and has no un-retract — the single most irreversible
	// write in the reconciliation system. The human sees the test's checks
	// first; silence is MNAR (verdict unchanged, nothing merged).
	let confirm: 'confirmed' | 'declined' | 'no_response' = 'confirmed';
	if (cx.signal === 'reproduces') {
		const carded2 = await requestRetractionConfirm({
			title: disputable.title,
			checkLines: cx.checkLines ?? [],
			stagedPath: cx.stagedPath ?? '',
		});
		if (carded2 === 'unavailable') {
			const retractLabel = 'Retract — it matches my report';
			const pick = await vscode.window.showWarningMessage(
				`Vinv: a test built from your report fails on the current code. Its checks: ${(cx.checkLines ?? []).join(' | ').slice(0, 300)} — retract the verified verdict for "${disputable.title}"?`,
				retractLabel,
				'Keep verdict',
			);
			confirm = pick === retractLabel ? 'confirmed' : pick === 'Keep verdict' ? 'declined' : 'no_response';
		} else {
			confirm = carded2;
		}
	}
	const decision = reconcile('reject_with_detail', cx.signal);
	const retracting = decision.action === 'retract_and_redispatch' && confirm === 'confirmed';
	// Post-confirm busy re-guard: authoring takes tens of seconds and an
	// auto-trigger may have dispatched meanwhile. Retract and redispatch are
	// atomic with respect to this guard — a blocked redispatch means NOTHING
	// was retracted or merged.
	if (retracting && (isEpisodeRunning() || isHarnessBusy())) {
		appendEpisodeEvent({
			type: 'reconciliation',
			ts: new Date().toISOString(),
			episode_id: disputable.episode_id,
			action: 'blocked_busy',
			counterexample: cx.signal,
			retracted: false,
			confirm,
		});
		postEpisodeUpdate({
			kind: 'end',
			text: 'confirmed — but an episode started meanwhile; nothing retracted. dispute again after it finishes',
			ok: true,
			sessionId: undefined,
		});
		void vscode.window.showInformationMessage(
			'Vinv: an episode started while the counterexample was being built — nothing was retracted or merged. Dispute this result again after it finishes.',
		);
		return;
	}
	// The merge lands only on a confirmed retraction.
	let mergedPath: string | undefined;
	if (retracting && cx.stagedPath) {
		mergedPath = mergeCounterexampleIntoOracle(cx.stagedPath, reusable?.acceptance, storageDir);
	}
	postEpisodeUpdate({
		kind: 'end',
		text: retracting
			? 'counterexample reproduces — verdict retracted'
			: cx.signal === 'reproduces'
				? confirm === 'declined'
					? 'verdict kept — you said the test does not match your report (nothing merged)'
					: 'no confirmation — verdict unchanged (nothing merged)'
				: cx.signal === 'does_not_reproduce'
					? 'verdict stands (your case already passes)'
					: 'inconclusive — could not run a counterexample',
		ok: !retracting,
		sessionId: undefined,
	});
	appendEpisodeEvent({
		type: 'reconciliation',
		ts: new Date().toISOString(),
		episode_id: disputable.episode_id,
		action: retracting
			? decision.action
			: cx.signal === 'reproduces'
				? 'stand_unconfirmed'
				: decision.action,
		counterexample: cx.signal,
		// The policy updater keys retraction on this exact flag — unconfirmed
		// events stay in the ledger for the re-author-on-decline trigger metric
		// but are inert for the bandit.
		retracted: retracting,
		confirm: cx.signal === 'reproduces' ? confirm : undefined,
	});
	if (retracting) {
		amendEpisodeOutcome(
			workspaceRoot,
			disputable.episode_id,
			{
				verified: false,
				evidence: `retracted by reconciliation: human counterexample reproduces (human-confirmed) — ${note.slice(0, 160)}`,
			},
			session.id,
		);
		void vscode.window.showInformationMessage(`Vinv: ${decision.message}`);
		await runEpisode(context, workspaceRoot, {
			kind: disputable.service ? 'service-fix' : 'general',
			trigger: 'reconciliation',
			service: disputable.service,
			title: disputable.title,
			operator_note:
				`A previous fix was verified but you must not trust that verdict — the human reviewer reported: ${note}. ` +
				'A counterexample test encoding this now exists in the acceptance oracle and currently FAILS; make it pass without weakening it.',
			priorFailureSeed: cx.failingOutput
				? `human counterexample test fails on current code:\n${cx.failingOutput}`
				: undefined,
			issue: `${disputable.issue}\n\nHuman-reported gap (a previous "verified" fix missed this): ${note}`,
			successCriteria: disputable.service
				? [
						`The recorded start command in .vinv/start_commands/${disputable.service}.json starts the service in the foreground and it keeps running`,
						'The service accepts connections on its recorded port (when one is recorded)',
					]
				: [note.trim()],
		}, undefined, session.id);
		return;
	}
	// stand / unavailable / kept: verdict unchanged, human sees why.
	void vscode.window.showInformationMessage(
		cx.signal === 'reproduces'
			? confirm === 'declined'
				? 'Vinv: verdict kept — nothing was merged into the oracle. Dispute again with a sharper description any time.'
				: 'Vinv: no confirmation received — the verdict is unchanged and nothing was merged. Dispute again any time.'
			: `Vinv: ${decision.message}`,
	);
	// Transparency on the stand path is unconditional: the authored test is
	// shown whenever it exists — a fresh issue with no prior set included.
	if (cx.signal === 'does_not_reproduce' && (cx.stagedPath || reusable?.acceptance)) {
		try {
			await vscode.window.showTextDocument(
				vscode.Uri.file((cx.stagedPath ?? reusable?.acceptance) as string),
				{ preview: false },
			);
		} catch {
			// The message already carried the decision.
		}
	}
}
