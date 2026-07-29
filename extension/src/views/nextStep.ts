/**
 * "What should I do next?" — the onboarding compass.
 *
 * Vinv's surfaces span engines-install → discovery → graph → services →
 * tracing → QnA → episodes; a new user should never have to hunt for the next
 * one. This module reads only observable workspace facts (no stored wizard
 * state that can drift) and names the single most valuable next action, with
 * the command that performs it. Exposed as a command (compass icon +
 * palette) and used by the status bar tooltip.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { enginesReady } from '../engines/install';
import { isProjectIndexed } from '../index/indexing';
import { readServices, isServiceStarted } from '../bringup/bringup';
import { readAdjudicated, readPendingEdges } from '../graph/graphEnhancer';
import { readEnhanceRecord, shouldAutoEnhance } from '../index/enhanceRunner';
import { indexStoreDir, loadStoreEpoch } from '../graph/indexGraph';
import { getAutoPilotStatus } from '../harness/autoPilot';
import { getPipelinePhase } from '../harness/pipelineState';
import { autoPilotStage, pipelineStage, type FlowStageId } from './flowModel';
import type { FlowStateSource } from './flowStateSource';

export interface NextStep {
	/** One-line imperative, e.g. "Discover this project". */
	label: string;
	/** Why this is the next step and what it unlocks. */
	detail: string;
	/** Command that performs it. */
	command: string;
	/** Optional command arguments. */
	args?: unknown[];
}

/** True when at least one capture session exists (runtime evidence). */
function hasCaptures(workspaceRoot: string): boolean {
	try {
		return fs.readdirSync(path.join(workspaceRoot, '.vinv', 'captures')).length > 0;
	} catch {
		return false;
	}
}

/** Unresolved ambiguous references awaiting the adjudication agent. */
function openPendingEdges(workspaceRoot: string): number {
	const storeDir = indexStoreDir(workspaceRoot);
	const done = readAdjudicated(storeDir);
	return readPendingEdges(storeDir).filter((r) => !done.has(`${r.src_id}\u0000${r.name}`))
		.length;
}

/**
 * The post-green pipeline stages, as observable disk facts.
 *
 * Auto-Pilot schedules these from an in-memory ledger (planPipelineAction),
 * which a compass reading a cold workspace cannot see — so these read the
 * artifact each pass actually writes. Same order the scheduler drains them in,
 * so driving manually walks the same path Auto-Pilot would.
 *
 * Insights is deliberately absent: pipelineRunners rebuilds it automatically
 * whenever new capture spans land, so it is never something the user has to be
 * told to do.
 */
function hasProbes(workspaceRoot: string): boolean {
	try {
		return fs
			.readdirSync(path.join(workspaceRoot, '.vinv', 'probes'))
			.some((f) => f.endsWith('.json'));
	} catch {
		return false;
	}
}

function hasExerciseScorecard(workspaceRoot: string): boolean {
	return fs.existsSync(path.join(workspaceRoot, '.vinv', 'exercise', 'scorecard.json'));
}

/**
 * Enhancement is once-per-epoch and TERMINAL, so a raw pending count is the
 * wrong gate: the agent abstains on genuinely indistinguishable candidates and
 * abstentions are never written to edge_overrides.jsonl, leaving the count
 * permanently non-zero — which pinned the compass on "Enhance the graph"
 * forever, even in a fully wired workspace. Ask the same question the runner
 * and the Flow rail ask instead: has THIS epoch been handled?
 */
function graphNeedsEnhancing(workspaceRoot: string): boolean {
	let epoch = 0;
	try {
		epoch = loadStoreEpoch(indexStoreDir(workspaceRoot));
	} catch {
		return false;
	}
	return shouldAutoEnhance(
		readEnhanceRecord(workspaceRoot),
		epoch,
		openPendingEdges(workspaceRoot),
	);
}

/**
 * Computes the single most valuable next action from observable state. Always
 * returns a step — a fully set-up project gets "ask Vinv something".
 */
export async function computeNextStep(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<NextStep> {
	// While Auto-Pilot drives the workspace, the compass IS its live state,
	// naming the Flow rail stage it is working — the manual ladder below stays
	// the answer whenever it is off or idle.
	const pilot = getAutoPilotStatus();
	if (pilot.running) {
		const stageTitles: Record<FlowStageId, string> = {
			discover: 'Discover',
			services: 'Services',
			traces: 'Traces',
			insights: 'Insights',
			verify: 'Verify',
		};
		// Same precedence as the Flow rail's spine: the hub's coarse phase when
		// published, the step label otherwise — so compass and rail always agree.
		const stage = pipelineStage(getPipelinePhase()) ?? autoPilotStage(pilot.label);
		const where = stage ? ` · ${stageTitles[stage]}` : '';
		return {
			label: pilot.label ? `Auto-Pilot${where}: ${pilot.label}` : 'Auto-Pilot running',
			detail:
				'Auto-Pilot is setting up, starting, and fixing services on its own. Click to watch the log or cancel the run.',
			command: 'vinv-vs.autoPilot',
		};
	}
	if (!enginesReady(context)) {
		return {
			label: 'Install Vinv engines',
			detail:
				'One click clones the open-source engines to ~/.vinv/engines and runs uv sync — tracing, indexing and analysis all come from them.',
			command: 'vinv-vs.installEngines',
		};
	}
	if (!isProjectIndexed(workspaceRoot)) {
		return {
			label: 'Discover this project',
			detail:
				'Builds the code graph, the handbook and the service list — everything else grows from it.',
			command: 'vinv-vs.indexProject',
		};
	}
	const services = readServices(workspaceRoot);
	const unstarted = services.filter((s) => !isServiceStarted(workspaceRoot, s.name));
	if (unstarted.length > 0) {
		return {
			label: `Set up ${unstarted[0].name}`,
			detail:
				'Bring-up verifies a start command for the service so it can run under tracing with one click.',
			command: 'vinv-vs.serviceSetup',
			args: [unstarted[0].name],
		};
	}
	if (!hasCaptures(workspaceRoot)) {
		return {
			label: services.length > 0 ? `Run ${services[0].name} under tracing` : 'Open the Graph Explorer',
			detail:
				services.length > 0
					? 'Running a service records runtime ground truth — call trees, latency, errors — that answers and context packs cite.'
					: 'Explore the code graph; run any code under tracing to add runtime evidence.',
			command: services.length > 0 ? 'vinv-vs.runService' : 'vinv-vs.openGraphExplorer',
			args: services.length > 0 ? [services[0].name] : undefined,
		};
	}
	// The post-green pipeline, in the scheduler's own order. These used to be
	// missing entirely: Auto-Pilot ran insights → probes → exercise, but a user
	// driving manually went straight from "a capture exists" to "everything is
	// wired" and was never told any of it was outstanding.
	if (!hasProbes(workspaceRoot)) {
		return {
			label: 'Run probes',
			detail:
				'Exercises each green service to find what actually breaks — the evidence issues and episodes are built from.',
			command: 'vinv-vs.runProbes',
		};
	}
	if (!hasExerciseScorecard(workspaceRoot)) {
		return {
			label: 'Exercise the services',
			detail:
				'Plan → run → profile → scorecard over every endpoint, which is what fills the Journey and Findings views. No standalone command yet — Auto-Pilot drives this stage.',
			command: 'vinv-vs.autoPilot',
		};
	}
	// Deliberately LAST of the actionable rungs. Enhancement sharpens PageRank,
	// slices and blast radius, but nothing upstream needs it — putting it early
	// blocked the path to services and tracing behind an optional refinement.
	if (graphNeedsEnhancing(workspaceRoot)) {
		return {
			label: 'Enhance the graph',
			detail:
				'An agent resolves the ambiguous cross-file references the deterministic resolver refused to guess — sharper PageRank, slices and blast radius.',
			command: 'vinv-vs.enhanceGraph',
		};
	}
	return {
		label: 'Ask Vinv about this codebase',
		detail:
			'Everything is wired: static graph + runtime evidence, insights built, probes and exercise run. Ask a question, or send a task to your coding harness as a closed-loop episode.',
		command: 'vinv-vs.askVinv',
	};
}

/**
 * Keeps the Get Started walkthrough honest about pre-existing state. The
 * walkthrough's onCommand completion events only fire for actions taken while
 * this VS Code is watching — work done earlier or out of band (a key entered
 * on a previous install, auto-discovery, captures from past sessions) would
 * leave those steps unchecked forever. These context keys re-derive each
 * step's "already done" state from the same observable facts the compass
 * reads, so a user who is already ahead sees the steps checked off instead of
 * being asked to redo them.
 */
export function registerWalkthroughStepContexts(context: vscode.ExtensionContext): void {
	const sync = (): void => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const set = (key: string, value: boolean): void => {
			void vscode.commands.executeCommand('setContext', key, value);
		};
		set('vinv.state.enginesInstalled', enginesReady(context));
		set('vinv.state.discovered', !!root && isProjectIndexed(root));
		set('vinv.state.traced', !!root && hasCaptures(root));
	};
	// Auto-discovery bypasses the Discover command and tracing writes capture
	// files, not commands — watch the artifacts themselves, debounced because a
	// live trace touches its capture dir continuously.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const syncSoon = (): void => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(sync, 1000);
	};
	sync();
	const watcher = vscode.workspace.createFileSystemWatcher('**/.vinv/{index,captures}/**');
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(syncSoon),
		watcher.onDidChange(syncSoon),
		watcher.onDidDelete(syncSoon),
		vscode.workspace.onDidChangeWorkspaceFolders(syncSoon),
		{ dispose: () => timer && clearTimeout(timer) },
	);
}

/** Persisted dismissal record: issue ids the user waved off, per index epoch. */
interface DismissedIssues {
	epoch: number;
	ids: string[];
}

const DISMISS_KEY = 'vinv.flow.dismissedIssues';

/**
 * Surfaces the problems Auto-Pilot gave up on as ONE warning per run, with a
 * "Show in Flow" jump into the rail's red Issues section. No recurring nags:
 * an issue shown once this session never re-toasts, and a dismissed issue
 * stays dismissed for the current index epoch (workspaceState-persisted) — a
 * re-index starts a fresh epoch and a fresh slate.
 */
export function registerFlowIssueWarnings(
	context: vscode.ExtensionContext,
	source: FlowStateSource,
): void {
	let pilotWasRunning = false;
	const shownThisSession = new Set<string>();

	context.subscriptions.push(
		source.onDidChange((model) => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const finished = pilotWasRunning && !model.autoPilot.running;
			pilotWasRunning = model.autoPilot.running;
			// Only the moment a run ends can mean "Auto-Pilot gave up on these";
			// steady-state issues already glow red in the Flow panel itself.
			if (!root || !finished || model.issues.length === 0) {
				return;
			}
			let epoch = 0;
			try {
				epoch = loadStoreEpoch(indexStoreDir(root));
			} catch {
				// No store yet: epoch 0 still scopes dismissals consistently.
			}
			const rec = context.workspaceState.get<DismissedIssues>(DISMISS_KEY);
			const dismissed = new Set(rec && rec.epoch === epoch ? rec.ids : []);
			const fresh = model.issues.filter(
				(i) => !dismissed.has(i.id) && !shownThisSession.has(i.id),
			);
			if (fresh.length === 0) {
				return;
			}
			for (const i of fresh) {
				shownThisSession.add(i.id);
			}
			const headline =
				fresh.length === 1
					? `Vinv: Auto-Pilot could not fix this — ${fresh[0].title}`
					: `Vinv: Auto-Pilot left ${fresh.length} problems it could not fix — ${fresh[0].title}, …`;
			void vscode.window
				.showWarningMessage(headline, 'Show in Flow', 'Dismiss')
				.then(async (choice) => {
					if (choice === 'Show in Flow') {
						await vscode.commands.executeCommand('vinv.flow.focus');
					} else if (choice === 'Dismiss') {
						await context.workspaceState.update(DISMISS_KEY, {
							epoch,
							ids: [...dismissed, ...fresh.map((i) => i.id)],
						} satisfies DismissedIssues);
					}
				});
		}),
	);
}

/** Registers the compass command: shows the step and offers to run it. */
export function registerNextStep(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('vinv-vs.nextStep', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			const step = await computeNextStep(context, folder.uri.fsPath);
			const go = await vscode.window.showInformationMessage(
				`Vinv next step: ${step.label}`,
				{ detail: step.detail, modal: false },
				'Do It',
				'Open Walkthrough',
			);
			if (go === 'Do It') {
				await vscode.commands.executeCommand(step.command, ...(step.args ?? []));
			} else if (go === 'Open Walkthrough') {
				await vscode.commands.executeCommand(
					'workbench.action.openWalkthrough',
					'VinvAI.VinvAI#vinv.gettingStarted',
				);
			}
		}),
	);
}
