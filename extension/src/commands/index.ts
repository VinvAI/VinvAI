import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { openDebugPanel } from '../debug/debugPanel';
import { SessionsProvider, type SessionTimeRange } from '../views/sessionsView';
import { ServicesProvider } from '../views/servicesView';
import { openConfigureForm } from '../config/configureProject';
import { openTracelensTerminal, openIndexTerminal } from '../tracelens/tracelens';
import { runDiscovery, stopDiscovery } from '../index/discovery';
import { readServices, isServiceStarted } from '../bringup/bringup';
import { offerHintedRetry } from '../bringup/startHint';
import { runBringupStartViaHarness } from '../harness/harnessRunner';
import { pickHarness } from '../harness/harnessPicker';
import { startService, stopService } from '../bringup/serviceRunner';
import { openCallTree } from '../identification/callTreeView';
import { openJourney } from '../views/journeyView';
import { openFindings } from '../views/findingsView';
import type { CallSiteContext } from '../identification/callSiteContext';
import { loadEntryPoints } from '../identification/identification';
import { registerDetectedTargets } from '../mcp/mcpRegistrar';
import { openGraphExplorer } from '../views/graphExplorer';
import { openAskVinv } from '../views/askVinv';
import { adjudicatePendingEdges } from '../graph/graphEnhancer';
import {
	offerEpisodeForBringupFailure,
	offerEpisodeForCacheCandidates,
	offerEpisodeForHotspots,
	offerEpisodeForMemoryTrends,
} from '../harness/autoTrigger';
import {
	disputeVerifiedEpisode,
	runEpisode,
	resumeJudgment,
	type EpisodeTask,
} from '../harness/episodeLoop';
import {
	cancelAutoPilot,
	getAutoPilotStatus,
	isAutoPilotRunning,
	showAutoPilotLog,
	startAutoPilot,
} from '../harness/autoPilot';
import { classifyIntent, criteriaFor } from '../harness/taskIntent';
import { registerPipelineRunners } from '../harness/pipelineRunners';
import { runInsightPass } from '../harness/insightRunner';
import { runProbePass } from '../harness/probeRunner';
import { writeEnhanceRecord, stateFromRecord } from '../index/enhanceRunner';
import { publishEnhanceState } from '../harness/pipelineState';
import { indexStoreDir, loadStoreEpoch } from '../graph/indexGraph';
import { loadSession, setEpisodeBudget, setGoal } from '../harness/session';
import { buildTrajectoryReport } from '../harness/trajectoryReport';
import { exportDiagnostics } from '../support/diagnostics';

/** Resolves a service name from a tree-item arg (`.id`) or a string. */
function serviceNameFrom(arg?: { id?: string } | string): string | undefined {
	return typeof arg === 'string' ? arg : arg?.id;
}

/** The ES-style quick ranges offered in the Sessions time-filter picker. */
const SESSION_TIME_PRESETS: ReadonlyArray<SessionTimeRange> = [
	{ label: 'Last 1 minute', windowMs: 60_000 },
	{ label: 'Last 5 minutes', windowMs: 5 * 60_000 },
	{ label: 'Last 10 minutes', windowMs: 10 * 60_000 },
	{ label: 'Last 30 minutes', windowMs: 30 * 60_000 },
	{ label: 'Last 1 hour', windowMs: 60 * 60_000 },
];

/** Parses a duration like "90s", "15m", "2h", "1d" into ms; undefined if invalid. */
function parseDuration(v: string): number | undefined {
	const m = /^\s*(\d+)\s*(s|m|h|d)\s*$/i.exec(v);
	if (!m) {
		return undefined;
	}
	const n = parseInt(m[1], 10);
	const unit = m[2].toLowerCase();
	const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
	return n * mult;
}

export function registerCommands(
	context: vscode.ExtensionContext,
	sessionsProvider: SessionsProvider,
	servicesProvider: ServicesProvider,
): void {
	// Background pipeline runners (auto-insights, change awareness, once-per-
	// epoch enhancement) — registered here so activation stays one call site.
	registerPipelineRunners(context);
	context.subscriptions.push(
		vscode.commands.registerCommand('vinv-vs.openDebugPanel', openDebugPanel),
		// Manual escape hatches for the automatic pipeline stages — the same
		// serialized passes the watchers and Auto-Pilot run, invokable on demand.
		vscode.commands.registerCommand('vinv-vs.runInsights', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			const result = await runInsightPass(context, folder.uri.fsPath);
			void vscode.window.showInformationMessage(
				result.outcome === 'done'
					? `Vinv: Insights built for ${result.endpoints} endpoint(s); ${result.issues} issue(s) identified.`
					: `Vinv: Insight pass ${result.outcome}${result.error ? ` — ${result.error}` : ''}.`,
			);
		}),
		vscode.commands.registerCommand('vinv-vs.runProbes', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			const result = await runProbePass(context, folder.uri.fsPath);
			void vscode.window.showInformationMessage(
				result.outcome === 'done'
					? `Vinv: Probes ran — ${result.total - result.failed}/${result.total} passed.`
					: `Vinv: Probe pass ${result.outcome}${result.error ? ` — ${result.error}` : ''}.`,
			);
		}),
		vscode.commands.registerCommand('vinv-vs.refreshSessions', () => sessionsProvider.refresh()),
		// Filter the Sessions trace-hit counts to a time window (ES-style quick
		// ranges plus a custom "last N"). "All time" clears the filter.
		vscode.commands.registerCommand('vinv-vs.filterSessionsByTime', async () => {
			const active = sessionsProvider.getTimeRange();
			type Pick = vscode.QuickPickItem & { range?: SessionTimeRange; custom?: boolean };
			const items: Pick[] = [
				{ label: 'All time', description: active ? undefined : 'current' },
				...SESSION_TIME_PRESETS.map((r) => ({
					label: r.label,
					description: active?.label === r.label ? 'current' : undefined,
					range: r,
				})),
				{ label: 'Custom…', detail: 'Enter a duration such as 90s, 15m, 2h, 1d', custom: true },
			];
			const chosen = await vscode.window.showQuickPick(items, {
				placeHolder: 'Vinv: Filter traces by time range',
			});
			if (!chosen) {
				return;
			}
			if (chosen.custom) {
				const input = await vscode.window.showInputBox({
					prompt: 'Vinv: Show traces from the last… (e.g. 90s, 15m, 2h, 1d)',
					validateInput: (v) =>
						parseDuration(v) === undefined ? 'Enter a duration like 90s, 15m, 2h, 1d' : undefined,
				});
				if (!input) {
					return;
				}
				const windowMs = parseDuration(input);
				if (windowMs === undefined) {
					return;
				}
				sessionsProvider.setTimeRange({ label: `Last ${input.trim()}`, windowMs });
				return;
			}
			// "All time" has no range → clears the filter.
			sessionsProvider.setTimeRange(chosen.range);
		}),
		// Open the call-tree (DAG) view for an entry point. Invoked three ways:
		//   • Sessions row click — passes { apiId, label }.
		//   • Programmatically / keybinding — passes a bare entry-point id string.
		//   • Command Palette (no argument) — we prompt with a QuickPick of the
		//     workspace's entry points.
		vscode.commands.registerCommand(
			'vinv-vs.openCallTree',
			async (arg?: { apiId?: string; label?: string } | string) => {
				const folder = vscode.workspace.workspaceFolders?.[0];
				if (!folder) {
					void vscode.window.showErrorMessage('Open a workspace folder to view call trees.');
					return;
				}
				const root = folder.uri.fsPath;

				let apiId: string | undefined;
				let label: string | undefined;
				if (typeof arg === 'string') {
					apiId = arg;
				} else if (arg?.apiId) {
					apiId = arg.apiId;
					label = arg.label;
				}

				// No id supplied (palette invocation): let the user pick an entry point.
				if (!apiId) {
					const entries = await loadEntryPoints(context, root);
					if (entries.length === 0) {
						void vscode.window.showInformationMessage(
							'No entry points found. Index the project first, then try again.',
						);
						return;
					}
					const picked = await vscode.window.showQuickPick(
						entries.map((e) => ({
							label: e.trigger || e.id,
							description: e.handler ? `${e.handler}()` : e.kind,
							detail: `${e.file}:${e.line} · ${e.framework}`,
							id: e.id,
						})),
						{ placeHolder: 'Select an entry point to open its call tree' },
					);
					if (!picked) {
						return;
					}
					apiId = picked.id;
					label = picked.label;
				}

				void openCallTree(context, root, apiId, label ?? apiId);
			},
		),
		// One place to walk everything Vinv verified: services, then every
		// endpoint's call tree + flamegraph + exercised IO, with next/prev.
		vscode.commands.registerCommand('vinv-vs.openJourney', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage('Open a workspace folder to view the journey.');
				return;
			}
			await openJourney(folder.uri.fsPath);
		}),
		// "What Vinv found and fixed" — issues, optimization episodes with CI
		// evidence, regress diff kinds, latency profile, state ledger.
		vscode.commands.registerCommand('vinv-vs.openFindings', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showErrorMessage('Open a workspace folder to view findings.');
				return;
			}
			await openFindings(folder.uri.fsPath);
		}),
		vscode.commands.registerCommand('vinv-vs.configureProject', () => openConfigureForm(context)),
		vscode.commands.registerCommand('vinv-vs.runTracelens', () => openTracelensTerminal(context)),
		vscode.commands.registerCommand('vinv-vs.runIndex', () => openIndexTerminal(context)),
		vscode.commands.registerCommand('vinv-vs.indexProject', () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder to discover it.');
				return;
			}
			void runDiscovery(context, folder.uri.fsPath);
		}),
		// Re-discover from the Project status row: a normal resume run that reuses
		// the (expensive) handbook and only fills missing artifacts.
		vscode.commands.registerCommand('vinv-vs.rediscover', () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder to discover it.');
				return;
			}
			void runDiscovery(context, folder.uri.fsPath);
		}),
		// Force a full rebuild: deletes the index, handbook, and service list first,
		// so everything is regenerated. Confirmed because it is slow and discards work.
		vscode.commands.registerCommand('vinv-vs.rediscoverForce', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder to discover it.');
				return;
			}
			const choice = await vscode.window.showWarningMessage(
				'Re-discover from scratch? This deletes the existing index, handbook, and service list, then regenerates them (can take a few minutes).',
				{ modal: true },
				'Re-discover',
			);
			if (choice !== 'Re-discover') {
				return;
			}
			void runDiscovery(context, folder.uri.fsPath, {}, { force: true });
		}),
		vscode.commands.registerCommand('vinv-vs.stopDiscovery', () => stopDiscovery()),
		// Auto-Pilot: one command that drives the whole workspace to green —
		// discover, set up every service, run each under tracing, verify it
		// serves, and dispatch fix episodes on failure. Invoked while a run is in
		// flight, it becomes the watch/cancel surface instead of double-starting.
		vscode.commands.registerCommand('vinv-vs.autoPilot', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			if (isAutoPilotRunning()) {
				const status = getAutoPilotStatus();
				const choice = await vscode.window.showInformationMessage(
					`Vinv: Auto-Pilot is running${status.label ? ` — ${status.label}` : ''}.`,
					'Show Log',
					'Cancel Auto-Pilot',
				);
				if (choice === 'Show Log') {
					showAutoPilotLog();
				} else if (choice === 'Cancel Auto-Pilot') {
					cancelAutoPilot();
				}
				return;
			}
			await startAutoPilot(context, folder.uri.fsPath);
		}),
		// Run a verified service from the Services view. Invoked from a row's inline
		// ▶ (arg = the tree item) or from the view-title Start… button (no arg → a
		// QuickPick dropdown of services that are set up).
		vscode.commands.registerCommand(
			'vinv-vs.serviceStart',
			async (arg?: { id?: string } | string) => {
				const folder = vscode.workspace.workspaceFolders?.[0];
				if (!folder) {
					void vscode.window.showWarningMessage('Vinv: Open a folder first.');
					return;
				}
				const root = folder.uri.fsPath;
				let name = serviceNameFrom(arg);
				if (!name) {
					const ready = readServices(root).filter((s) => isServiceStarted(root, s.name));
					if (ready.length === 0) {
						void vscode.window.showInformationMessage(
							'Vinv: No services set up yet. Set one up from the Services view first.',
						);
						return;
					}
					name = await vscode.window.showQuickPick(
						ready.map((s) => s.name),
						{ placeHolder: 'Vinv: Start a service' },
					);
					if (!name) {
						return;
					}
				}
				startService(root, name);
			},
		),
		// Stop a running service (ends its debug session).
		vscode.commands.registerCommand(
			'vinv-vs.serviceStop',
			(arg?: { id?: string } | string) => {
				const name = serviceNameFrom(arg);
				if (name) {
					stopService(name);
				}
			},
		),
		// Set up a not-yet-verified service: bring it up under tracelens (which
		// installs, starts, verifies, and records its start command). After that the
		// row flips to "ready" and can be run with ▶.
		vscode.commands.registerCommand(
			'vinv-vs.serviceSetup',
			async (arg?: { id?: string } | string) => {
				const folder = vscode.workspace.workspaceFolders?.[0];
				if (!folder) {
					void vscode.window.showWarningMessage('Vinv: Open a folder first.');
					return;
				}
				const root = folder.uri.fsPath;
				const name = serviceNameFrom(arg);
				if (!name) {
					return;
				}
				const entry = readServices(root).find((s) => s.name === name);
				if (!entry) {
					return;
				}
				const harnessId = await pickHarness(`Bring up '${name}' with which coding agent?`);
				if (!harnessId) {
					return;
				}
				await runBringupStartViaHarness(context, harnessId, root, entry);
				servicesProvider.refresh();
				// A failed bring-up usually means the agent could not work out WHICH
				// command starts this service — so ask the one person who knows before
				// spending an episode re-deriving it. Both steps are no-ops unless the
				// recorded outcome is a real failure, and a hinted retry that verifies
				// leaves nothing for the episode offer to do.
				const retried = await offerHintedRetry(context, root, entry);
				if (retried) {
					servicesProvider.refresh();
				}
				// Still failing (or the operator skipped the prompt): close the loop by
				// turning the recorded symptom into a fix episode instead of a dead
				// status label.
				await offerEpisodeForBringupFailure(context, root, name);
			},
		),
		vscode.commands.registerCommand('vinv-vs.refreshServices', () => servicesProvider.refresh()),
		vscode.commands.registerCommand('vinv-vs.runService', async (serviceName?: string) => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			const root = folder.uri.fsPath;
			let name = serviceName;
			// Invoked from a keybinding (no service supplied): pick among the
			// services that have a verified start command, mirroring how F5 runs the
			// selected debug config.
			if (!name) {
				const started = readServices(root).filter((s) => isServiceStarted(root, s.name));
				if (started.length === 0) {
					void vscode.window.showWarningMessage(
						'Vinv: No verified services to run. Bring up a service first.',
					);
					return;
				}
				if (started.length === 1) {
					name = started[0].name;
				} else {
					name = await vscode.window.showQuickPick(
						started.map((s) => s.name),
						{ placeHolder: 'Vinv: Select a service to run' },
					);
					if (!name) {
						return;
					}
				}
			}
			startService(root, name);
		}),
		// Open the interactive code-graph explorer (force layout over the index
		// store with runtime overlay, diff impact, guided tour, and search).
		vscode.commands.registerCommand('vinv-vs.openGraphExplorer', () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			void openGraphExplorer(context, folder.uri.fsPath);
		}),
		// Open the Ask Vinv QnA panel. The graph explorer passes { seedRow } to
		// pre-scope the question to one symbol; the call-tree view passes
		// { callSite } to additionally scope it to one entry point's execution.
		vscode.commands.registerCommand(
			'vinv-vs.askVinv',
			(arg?: { seedRow?: number; callSite?: CallSiteContext }) => {
				openAskVinv(context, { seedRow: arg?.seedRow, callSite: arg?.callSite });
			},
		),
		// Agent-driven graph enhancement: resolve every ambiguous cross-file
		// reference the deterministic resolver refused to guess, then apply the
		// adjudicated edges with an incremental index update.
		vscode.commands.registerCommand('vinv-vs.enhanceGraph', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			const root = folder.uri.fsPath;
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Vinv: Resolving ambiguous references…',
					cancellable: true,
				},
				async (progress, token) => {
					const outcome = await adjudicatePendingEdges(context, root, {
						token,
						onProgress: (done, total) =>
							progress.report({ message: `${done}/${total} adjudicated` }),
					});
					// A manual run settles the epoch exactly like the automatic one:
					// record {epoch, resolved, remaining} so nothing re-offers it.
					try {
						const record = {
							epoch: loadStoreEpoch(indexStoreDir(root)),
							resolved: outcome.resolved,
							// Abstentions and never-attempted (cancelled) references both
							// remain ambiguous — a terminal fact for this epoch.
							remaining: Math.max(0, outcome.pending - outcome.resolved),
							ranAt: new Date().toISOString(),
						};
						writeEnhanceRecord(root, record);
						publishEnhanceState(stateFromRecord(record));
					} catch {
						// Recording is best-effort; the run itself already applied.
					}
					if (outcome.pending === 0) {
						void vscode.window.showInformationMessage(
							'Vinv: No ambiguous references — the graph is fully resolved.',
						);
						return;
					}
					void vscode.window.showInformationMessage(
						`Vinv: Graph enhanced — ${outcome.resolved} reference(s) resolved, ` +
							`${outcome.abstained} abstained (insufficient evidence)` +
							(outcome.applied ? '; index updated.' : '.'),
					);
				},
			);
		}),
		// Start a closed-loop harness episode. Invoked from the graph explorer
		// ("Send to harness" with a node row), the QnA panel (dispatch), the
		// auto-trigger notifications, or the palette (prompts for the issue).
		vscode.commands.registerCommand(
			'vinv-vs.fixWithHarness',
			async (arg?: { row?: number; rows?: number[]; issue?: string; service?: string }) => {
				const folder = vscode.workspace.workspaceFolders?.[0];
				if (!folder) {
					void vscode.window.showWarningMessage('Vinv: Open a folder first.');
					return;
				}
				const root = folder.uri.fsPath;
				let issue = arg?.issue?.trim();
				if (!issue) {
					issue = (
						await vscode.window.showInputBox({
							prompt: 'Vinv: Describe the issue or task for the coding harness',
							placeHolder: 'e.g. POST /orders returns 500 when the cart is empty',
						})
					)?.trim();
				}
				if (!issue) {
					return;
				}
				// No silent default: every click-driven dispatch asks which agent
				// gets the task (the last choice is preselected and remembered).
				const harnessId = await pickHarness();
				if (!harnessId) {
					return;
				}
				const service = arg?.service;
				// Seeds: an explicit node row (graph button) and/or the rows the
				// QnA panel was anchored on when the user dispatched from chat.
				const seedRows = [
					...(arg?.row !== undefined ? [arg.row] : []),
					...(arg?.rows ?? []),
				].filter((r, i, all) => all.indexOf(r) === i);
				// A service-fix always has real failure evidence behind it; free text
				// from the palette or the QnA dispatch may be a question, and must
				// not be handed criteria that assert a defect exists.
				const intent = service ? 'defect' : classifyIntent(issue);
				const task: EpisodeTask = {
					kind: service ? 'service-fix' : 'general',
					trigger: arg?.row !== undefined ? 'graph' : service ? 'service-exit' : 'manual',
					service,
					intent,
					title: issue.length > 72 ? `${issue.slice(0, 69)}…` : issue,
					issue,
					seedRows: seedRows.length ? seedRows : undefined,
					// Concrete criteria only — generic restatements must not hard-gate
					// a verified pass (scope-drift + regression tests cover them).
					successCriteria: criteriaFor(intent, service),
				};
				await runEpisode(context, root, task, harnessId);
			},
		),
		// Session controls: the standing goal and the episode budget live on the
		// active session (.vinv/askvinv/sessions/) and are readable/writable from
		// BOTH sides — these commands are the VS Code side; VINV: directives in
		// harness output are the chat side.
		vscode.commands.registerCommand('vinv-vs.setGoal', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			const current = loadSession(folder.uri.fsPath);
			const goal = await vscode.window.showInputBox({
				prompt: 'Vinv: Standing goal for harness episodes (empty clears it)',
				value: current.goal,
				placeHolder: 'e.g. make every service start cleanly and pass its smoke checks',
			});
			if (goal === undefined) {
				return;
			}
			const updated = setGoal(folder.uri.fsPath, goal.trim());
			void vscode.window.showInformationMessage(
				updated.goal
					? `Vinv: Goal set — episodes will cite it (${updated.episode_budget} episode budget).`
					: 'Vinv: Goal cleared — episodes run per-task.',
			);
		}),
		vscode.commands.registerCommand('vinv-vs.setEpisodeBudget', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			const current = loadSession(folder.uri.fsPath);
			const raw = await vscode.window.showInputBox({
				prompt: 'Vinv: Episodes to spend on the current goal (1-20)',
				value: String(current.episode_budget),
				validateInput: (v) =>
					/^\d{1,2}$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 20
						? undefined
						: 'Enter a whole number between 1 and 20',
			});
			if (raw === undefined) {
				return;
			}
			const updated = setEpisodeBudget(folder.uri.fsPath, Number.parseInt(raw.trim(), 10));
			void vscode.window.showInformationMessage(
				`Vinv: Episode budget is now ${updated.episode_budget} (${updated.episodes_used} used on this goal).`,
			);
		}),
		// Performance sweep: dispatch the trace's latency Pareto head to the
		// harness as an optimization episode (algorithm/caching/async decisions
		// belong to the agent; the evidence and verification belong to Vinv).
		vscode.commands.registerCommand('vinv-vs.optimizeHotspots', () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			void offerEpisodeForHotspots(context, folder.uri.fsPath);
		}),
		// Memory sweep: symbols retaining memory every session with a positive
		// Theil–Sen trend become a leak-investigation episode.
		vscode.commands.registerCommand('vinv-vs.analyzeMemoryTrends', () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			void offerEpisodeForMemoryTrends(context, folder.uri.fsPath);
		}),
		// Cache sweep: deterministic symbols recomputing identical inputs
		// (same args_hash) become a memoization episode.
		vscode.commands.registerCommand('vinv-vs.analyzeCacheOpportunities', () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			void offerEpisodeForCacheCandidates(context, folder.uri.fsPath);
		}),
		// Brings back an escalation the operator closed without deciding — the
		// episode is suspended, not aborted, until they answer.
		vscode.commands.registerCommand('vinv-vs.resumeJudgment', async () => {
			await resumeJudgment();
		}),
		// Post-completion dispute: a VERIFIED episode the human says is still
		// wrong → counterexample test → reproduces = retract + re-dispatch with
		// the strengthened oracle; the reconciliation protocol's production
		// surface (oracle↔human disagreement is never silently averaged).
		vscode.commands.registerCommand('vinv-vs.disputeVerified', async (episodeId?: string) => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a workspace folder first.');
				return;
			}
			await disputeVerifiedEpisode(context, folder.uri.fsPath, episodeId);
		}),
		// The cross-episode audit trail: goal, per-episode arms/rewards/evidence,
		// stall negotiations, agent disputes, and policy updates — rendered from
		// session.json + the episode ledger into a markdown report.
		vscode.commands.registerCommand('vinv-vs.showTrajectory', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			const root = folder.uri.fsPath;
			const target = path.join(root, '.vinv', 'reports', 'trajectory.md');
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, buildTrajectoryReport(root), 'utf8');
			await vscode.commands.executeCommand(
				'markdown.showPreview',
				vscode.Uri.file(target),
			);
		}),
		// Support escape hatch: engine logs, episode ledger, config shape —
		// exported for the user to review and attach to a bug report.
		vscode.commands.registerCommand('vinv-vs.exportDiagnostics', () => exportDiagnostics(context)),
		vscode.commands.registerCommand('vinv-vs.registerCursorMcp', () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				void vscode.window.showWarningMessage('Vinv: Open a folder first.');
				return;
			}
			const outcomes = registerDetectedTargets(context, folder.uri.fsPath);
			if (outcomes.length) {
				const labels = outcomes.map((o) => o.label).join(', ');
				void vscode.window.showInformationMessage(
					`Vinv: Registered MCP servers for ${labels}. Reload the agent to load them.`,
				);
			} else {
				void vscode.window.showWarningMessage(
					'Vinv: No agent tools detected to register (looked for Cursor, Claude Code, VS Code, Codex).',
				);
			}
		}),
	);
}
