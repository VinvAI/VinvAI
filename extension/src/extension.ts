import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { registerCommands } from './commands';
import { SessionsProvider } from './views/sessionsView';
import { ServicesProvider } from './views/servicesView';
import { FlowStateSource } from './views/flowStateSource';
import { FlowViewProvider, FLOW_VIEW_ID } from './views/flowPanel';
import { OptimizationSource } from './views/optimizationSource';
import { registerOptimizationNudge } from './views/optimizationPanel';
import { ReportMirrorSource } from './views/reportMirrorSource';
import { maybeAutoDiscover } from './index/discovery';
import { startAutoReindex } from './index/autoReindex';
import { initServiceRunner } from './bringup/serviceRunner';
import { SmokeReportEditorProvider } from './identification/smokeReportView';
import { CallTreeEditorProvider } from './identification/callTreeView';
import { GraphExplorerEditorProvider } from './views/graphExplorer';
import { JourneyEditorProvider } from './views/journeyView';
import { FindingsEditorProvider } from './views/findingsView';
import { OptimizationReportEditorProvider } from './views/optimizationReportView';
import { registerAutoTriggers } from './harness/autoTrigger';
import { registerAutoPilotAutoStart } from './harness/autoPilot';
import { abortExerciseEngine } from './harness/exerciseRunner';
import { initStatusBar } from './views/statusBar';
import {
	registerFlowIssueWarnings,
	registerNextStep,
	registerWalkthroughStepContexts,
} from './views/nextStep';
import { ensureVinvGitignored } from './config/gitignore';
import { excludeVinvFromWatcher } from './config/watcherExclude';
import { releaseOpenRuns, sweepStaleRunTrees } from './harness/runIsolation';
import { registerDetectedTargets, registerNativeVsCodeProvider } from './mcp/mcpRegistrar';
import { isMcpEnabled } from './config/settings';
import {
	enginesReady,
	maybeOfferEmbedderWarmup,
	registerEnginesCommands,
} from './engines/install';
import { maybeUpdateEngines, registerEngineUpdate } from './engines/update';
import { maybeShowNotices } from './notices/notices';
import { stopEmbedderIfStarted } from './embedder/sidecar';

/**
 * How long `activate` took, for the diagnostics export.
 *
 * VS Code holds the window on "Activating extensions…" until this function's
 * promise settles, and everything in it runs on the host's single thread — so
 * any blocking work here is felt by every extension in the window, not just
 * this one. Recording the number is what makes a regression here visible
 * instead of anecdotal.
 */
let activationMs = 0;

/** Milliseconds `activate` spent before VS Code considered the extension live. */
export function activationDurationMs(): number {
	return activationMs;
}

/** Above this, activation is slow enough to be worth naming in the log. */
const SLOW_ACTIVATION_MS = 1_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const activationStart = Date.now();
	// On activation (install / window reload), reveal the Vinv sidebar so users
	// land on it rather than the default Explorer.
	void vscode.commands.executeCommand('workbench.view.extension.vinv');

	// Derive the walkthrough steps' "already done" contexts from workspace
	// state, so steps completed before this session (or out of band) show as
	// checked instead of asking the user to redo them.
	registerWalkthroughStepContexts(context);

	// Open the Get Started walkthrough once per install. The marker lives in
	// the extension's install directory, which VS Code replaces on every
	// install/update — so a new install always brings the welcome up, while
	// window reloads (marker survives) never re-interrupt.
	const welcomeMarker = path.join(context.extensionPath, '.vinv-welcomed');
	if (!fs.existsSync(welcomeMarker)) {
		try {
			fs.writeFileSync(welcomeMarker, 'shown', 'utf8');
		} catch {
			// Read-only install dir: worst case the welcome reopens next reload.
		}
		void vscode.commands.executeCommand(
			'workbench.action.openWalkthrough',
			'VinvAI.VinvAI#vinv.gettingStarted',
		);
	}

	// Announce, once per install/update, that Vinv is now open source. Uses the
	// same install-dir marker technique as the welcome above: shown on a fresh
	// install, never re-interrupts on a window reload. Non-blocking toast.
	const ossMarker = path.join(context.extensionPath, '.vinv-oss-announced');
	if (!fs.existsSync(ossMarker)) {
		try {
			fs.writeFileSync(ossMarker, 'shown', 'utf8');
		} catch {
			// Read-only install dir: worst case the notice reappears next reload.
		}
		void vscode.window
			.showInformationMessage(
				'🎉 Vinv is now free & open source. Everything runs on your machine: no account, no API keys, no telemetry. Your agent stops guessing: it gets the real run, joined to your code.',
				'⭐ Star on GitHub',
				'Get Started',
			)
			.then((choice) => {
				if (choice === '⭐ Star on GitHub') {
					void vscode.env.openExternal(vscode.Uri.parse('https://github.com/VinvAI/VinvAI'));
				} else if (choice === 'Get Started') {
					void vscode.commands.executeCommand(
						'workbench.action.openWalkthrough',
						'VinvAI.VinvAI#vinv.gettingStarted',
					);
				}
			});
	}

	// The one-click engines install (git clone + uv sync in a terminal).
	registerEnginesCommands(context);
	registerEngineUpdate(context);

	// The engines live outside the vsix, so installing or updating the extension
	// does not bring them with it. Once per extension version, force the checkout
	// onto the engines ref this build was cut against — installing it first when
	// the machine has none. Fire-and-forget: it is a couple of git reads, and the
	// clone/build itself runs in a terminal, so activation never blocks.
	//
	// Held, not discarded: auto-discovery below waits on this before it waits on
	// the terminal it may launch. Without the handle it would ask "is an engines
	// run in flight?" while this pass was still deciding, get "no", and index a
	// checkout that was about to be moved underneath it.
	const enginePass = maybeUpdateEngines(context);

	// The one channel that reaches an install that is already broken: a static
	// notices file, polled at most twice a day, filtered here, at most one toast.
	// This is the extension's ONLY outbound request — a GET that uploads nothing —
	// and it is silent when the endpoint is unreachable. Off with vinv.notices.enabled.
	void maybeShowNotices(context);

	// Engines present? Offer the one-time embedding-model warmup so the first
	// index build doesn't stall inside the sidecar. When they are missing, the
	// next-step ladder and the Project view point at "Install Vinv Engines".
	if (enginesReady(context)) {
		void maybeOfferEmbedderWarmup(context);
	}

	// Keep Vinv's local artifacts (.vinv/) out of source control, like .claude/.
	ensureVinvGitignored();

	// Keep .vinv out of the FILE WATCHER too. It holds the index store (tens of
	// MB), every capture, and one full git checkout per isolated run — none of
	// which any editor feature needs to observe. .gitignore already keeps it out
	// of search; the watcher does not read .gitignore, so without this VS Code
	// natively watches thousands of files that only Vinv writes. Vinv's own
	// watchers are unaffected: an explicit createFileSystemWatcher still fires.
	void excludeVinvFromWatcher();

	// Collect run checkouts a previous window left behind (a crash, or a close
	// mid-episode). Each is a full worktree inside .vinv/runs, so a few stale
	// ones are thousands of watched files and extra repositories for VS Code's
	// git extension to poll. Fire-and-forget: nothing waits on it.
	const sweepRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (sweepRoot) {
		void sweepStaleRunTrees(sweepRoot).then((n) => {
			if (n > 0) {
				console.log(`Vinv: released ${n} stale run worktree(s)`);
			}
		});
	}

	// Kept as data sources, not as sidebar trees: Flow already shows services
	// and Findings already shows sessions, so a second copy of each in the rail
	// was duplicate surface. The providers stay because the palette commands
	// (refreshSessions, filterSessionsByTime, the services refresh after a
	// bring-up) still drive them.
	const servicesProvider = new ServicesProvider(context);
	const sessionsProvider = new SessionsProvider(context);
	// The Flow panel — the always-visible home: one vertical rail from
	// Discover to Verify, with everything each stage produced one click away.
	// Its state source also mirrors the model to .vinv/flow_state.json for
	// agents, and feeds the give-up warnings ("Show in Flow").
	const flowSource = new FlowStateSource(context);
	context.subscriptions.push(
		flowSource,
		vscode.window.registerWebviewViewProvider(FLOW_VIEW_ID, new FlowViewProvider(context, flowSource)),
	);
	registerFlowIssueWarnings(context, flowSource);

	// The Optimization analyzer — a background pass that ranks traced symbols by
	// RECOVERABLE time (total_ms × waste_prior) and owns the predicted→proven
	// loop: a click sends one symbol to the harness; the after-run measures the
	// delta against this trace's own noise band. It has NO sidebar surface — the
	// ranked evidence opens as a full-page tab (the Optimize button on the Flow
	// rail / the "Open Optimize Panel" command), and its mirror is
	// .vinv/reports/optimization.json (agent-legible over MCP). The nudge is the
	// only ambient trace: a one-time pointer to the report when work appears.
	const optimizationSource = new OptimizationSource();
	context.subscriptions.push(optimizationSource);
	registerOptimizationNudge(context, optimizationSource);

	// The agent-facing report mirrors (findings.json / journey.json) are kept
	// current in the background — before this source they were produced only
	// inside the webview lifecycle, so they went stale until a human opened a
	// tab. Debounced over .vinv artifacts, change-gated, atomic.
	context.subscriptions.push(new ReportMirrorSource());

	// Status-bar indicator + management quick pick for services the user runs via
	// the ▶ flow (the multi-service analogue of the debug toolbar).
	initServiceRunner(context);

	// File-backed custom editors so their tabs (bound to a .vinv/reports file URI)
	// can be dragged/@-referenced in chat: smoke reports render the HTML, call trees
	// render the live tree/flamegraph from a JSON snapshot, and the graph explorer
	// renders the interactive code graph from the index store.
	context.subscriptions.push(
		SmokeReportEditorProvider.register(context),
		CallTreeEditorProvider.register(context),
		GraphExplorerEditorProvider.register(context),
		JourneyEditorProvider.register(context),
		FindingsEditorProvider.register(context),
		OptimizationReportEditorProvider.register(context),
	);

	registerCommands(context, sessionsProvider, servicesProvider);

	// Status bar: index epoch + running services + episode state; click opens
	// the Graph Explorer.
	initStatusBar(context);

	// Onboarding compass: "What should I do next?" computed from observable
	// workspace state, so the next step is always one command away.
	registerNextStep(context);

	// Closed-loop hooks: a failing service run (or smoke-report error cluster)
	// offers — or, with the autoEpisodes toggle, auto-starts — a harness fix
	// episode that composes a context pack, dispatches, verifies by replay, and
	// escalates to the user only when in doubt.
	registerAutoTriggers(context);

	// Auto-Pilot's opt-in-by-default trigger: when discovery completes and
	// services are listed, drive everything to green (setup → run under tracing
	// → verify → fix on failure) without waiting for per-service clicks. Gated
	// by the autoPilot toggle (default on) — see startAutoPilot.
	registerAutoPilotAutoStart(context);

	// On VS Code ≥ 1.101 the Vinv MCP servers are contributed through the native
	// provider API — auto-started by agent mode with no config file written. The
	// provider re-reads the toggle and workspace folder on every definition
	// request, so it is registered unconditionally once.
	registerNativeVsCodeProvider(context, isMcpEnabled);

	// Register the Vinv MCP servers into every agent tool detected on this machine
	// (Cursor, Claude Code, VS Code, Codex) on startup and whenever a folder is
	// added. Gated by the vinv.mcp.enabled toggle and idempotent: it only rewrites
	// a client's config when the content actually changes — see registerDetectedTargets.
	syncMcpRegistration();

	// Discover the workspace automatically on startup and whenever a folder is
	// added, so the user doesn't have to click Discover Project manually. It is a
	// no-op unless the toggle is on and the project is UNDISCOVERED — an already
	// discovered workspace is left alone, including across an install or update
	// (that force-rebuild is commented out in maybeAutoDiscover). It also waits
	// out any engines terminal the pass above starts.
	void enginePass.then(() => maybeAutoDiscover(context));

	// Keep the index following the code: debounced incremental `index update`
	// on save, and epoch tags on new capture sessions so runtime facts can be
	// dated against index state.
	startAutoReindex(context);

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			ensureVinvGitignored();
			syncMcpRegistration();
			void maybeAutoDiscover(context);
		}),
	);

	activationMs = Date.now() - activationStart;
	if (activationMs > SLOW_ACTIVATION_MS) {
		// Nothing in activate() should be slow enough to reach here: the heavy
		// derivations (the failing-symbol count, the Flow model, the optimization
		// ranking) are all scheduled, not awaited. If this fires, something has
		// been put back on the blocking path.
		console.warn(
			`Vinv: activation took ${activationMs}ms — heavy work has moved onto the activation path`,
		);
	}

	/** Registers Vinv's MCP servers into detected agent tools when the toggle is on. */
	function syncMcpRegistration(): void {
		if (!isMcpEnabled()) {
			return;
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}
		try {
			registerDetectedTargets(context, folder.uri.fsPath);
		} catch (e) {
			console.error('Vinv: MCP auto-registration failed', e);
		}
	}
}

export function deactivate(): void {
	// Stop the embedding sidecar — only when this window was the one to start it.
	stopEmbedderIfStarted();
	// Tear down an in-flight exercise step. Without this, closing the window leaves
	// the engine driving the user's service with no parent and no UI to stop it.
	abortExerciseEngine();
	// Release any run worktree still open. The episode loop's own `finally`
	// covers a normal end; a window closed mid-episode never reaches it, and the
	// orphaned checkout was permanent — thousands of files left inside .vinv for
	// this extension, VS Code's watcher and its git extension to keep observing.
	// Best-effort: deactivate is not awaited, so the activation sweep is the
	// backstop for whatever this does not finish.
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (root) {
		releaseOpenRuns(root);
	}
}
