import * as vscode from 'vscode';
import * as fs from 'fs';
import {
	runIndexing,
	isProjectIndexed,
	getIndexStoreDir,
	type IndexProgress,
} from './indexing';
import { maybeAutoEnhance } from './enhanceRunner';
import {
	isHandbookGenerated,
	getHandbookPath,
	type HandbookProgress,
} from '../handbook/handbook';
import {
	readServices,
	isServiceStarted,
	isServicesListed,
	getServicesPath,
	type BringupProgress,
} from '../bringup/bringup';
import { getHarnessId, isAutoDiscoverEnabled, isAutoPilotEnabled } from '../config/settings';
import {
	runHandbookViaHarness,
	runBringupListViaHarness,
	runBringupStartViaHarness,
} from '../harness/harnessRunner';
import { ensureHarnessChosen } from '../harness/harnessPicker';

/** Combined outcome of a Discover Project run. */
export interface DiscoveryResult {
	indexOk: boolean;
	handbookOk: boolean;
	bringupOk: boolean;
}

/** Per-stage progress callbacks for a discovery run. */
export interface DiscoveryProgress {
	onIndex?: (p: IndexProgress) => void;
	onHandbook?: (p: HandbookProgress) => void;
	onBringup?: (p: BringupProgress) => void;
}

/** Options controlling how a discovery run behaves. */
export interface DiscoveryOptions {
	/**
	 * Delete the existing index, handbook, and service inventory before running so
	 * every artifact is regenerated from scratch. Off by default — a normal
	 * re-discover reuses the (expensive) handbook and only fills gaps.
	 */
	force?: boolean;
}

/** Coarse lifecycle phase of discovery, surfaced by the Project status view. */
export type DiscoveryPhase = 'idle' | 'running' | 'done' | 'failed';

/** A point-in-time snapshot of discovery for the status UI. */
export interface DiscoveryState {
	phase: DiscoveryPhase;
	/** Short status line (e.g. "Indexing — 40% · 1200 symbols"). */
	label: string;
	/** Extra detail for failures, shown as a tooltip. */
	detail?: string;
}

const stateEmitter = new vscode.EventEmitter<DiscoveryState>();
/** Fires whenever discovery's phase/label changes, so views can refresh. */
export const onDiscoveryStateChange = stateEmitter.event;

let discoveryState: DiscoveryState = { phase: 'idle', label: '' };

/** The latest discovery state (drives the persistent Project status row). */
export function getDiscoveryState(): DiscoveryState {
	return discoveryState;
}

function setDiscoveryState(next: DiscoveryState): void {
	discoveryState = next;
	stateEmitter.fire(next);
}

// Holds the cancellation source for the in-flight run. Its presence is also our
// "a discovery is running" flag and the thing the Stop action cancels — one
// handle that fans out to all three stages.
let activeCts: vscode.CancellationTokenSource | undefined;

/** True while a discovery run is in progress. */
export function isDiscovering(): boolean {
	return activeCts !== undefined;
}

/** Cancels the in-flight discovery run (kills every stage's process group). */
export function stopDiscovery(): void {
	activeCts?.cancel();
}

/** Deletes all discovery artifacts so a forced run regenerates them. */
function purgeArtifacts(workspaceRoot: string): void {
	for (const p of [
		getIndexStoreDir(workspaceRoot),
		getHandbookPath(workspaceRoot),
		getServicesPath(workspaceRoot),
	]) {
		try {
			fs.rmSync(p, { recursive: true, force: true });
		} catch {
			// Best-effort; the stage will overwrite in place if removal fails.
		}
	}
}

/** Names the stages that did not complete, for a failure tooltip. */
function failureDetail(indexOk: boolean, handbookOk: boolean, bringupOk: boolean): string {
	const failed: string[] = [];
	if (!indexOk) {
		failed.push('index');
	}
	if (!handbookOk) {
		failed.push('handbook');
	}
	if (!bringupOk) {
		failed.push('services');
	}
	return failed.length ? `Did not complete: ${failed.join(', ')}` : '';
}

/**
 * Discovers a project in two phases:
 *   1. index build (.vinv/index) and handbook generation (.vinv/vinv.md) run in
 *      parallel — they share LLM credentials but are otherwise independent, so a
 *      failure in one does not block the other.
 *   2. Once *both* complete, bringup enumerates the stack into
 *      .vinv/services.json. bringup reads the handbook, so it runs only after the
 *      handbook exists (a freshly generated one, or a pre-existing file).
 *
 * A single CancellationTokenSource is threaded into all three stages, so the Stop
 * action (or a superseding run) cancels the whole pipeline at once. Concurrent
 * runs are rejected — only one discovery is in flight at a time.
 */
export async function runDiscovery(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	progress: DiscoveryProgress = {},
	options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
	if (activeCts) {
		void vscode.window.showInformationMessage('Vinv: Discovery is already running.');
		return { indexOk: false, handbookOk: false, bringupOk: false };
	}

	const cts = new vscode.CancellationTokenSource();
	activeCts = cts;
	// A single context key spanning the whole multi-phase run so UI (the sidebar
	// welcome view) stays in its "discovering" state until bring-up finishes —
	// runIndexing's own vinv.indexing key clears when indexing alone is done.
	void vscode.commands.executeCommand('setContext', 'vinv.discovering', true);
	setDiscoveryState({ phase: 'running', label: 'Starting…' });

	// Mirror each stage's progress into the persistent status row, then forward to
	// the caller's own callbacks (the Configure panel drives its bars from these).
	const onIndex = (p: IndexProgress): void => {
		setDiscoveryState({ phase: 'running', label: `Indexing — ${p.label}` });
		progress.onIndex?.(p);
	};
	const onHandbook = (p: HandbookProgress): void => {
		setDiscoveryState({ phase: 'running', label: `Handbook — ${p.label}` });
		progress.onHandbook?.(p);
	};
	const onBringup = (p: BringupProgress): void => {
		setDiscoveryState({ phase: 'running', label: `Services — ${p.label}` });
		progress.onBringup?.(p);
	};

	try {
		if (options.force) {
			purgeArtifacts(workspaceRoot);
		}

		// The LLM stages (handbook, bring-up) run through the user's coding-agent
		// CLI; indexing embeds locally via the vinv-embedder sidecar. Ask which
		// agent the first time (picker of installed harnesses), then remember it —
		// don't silently default to claude-code. Null means the user dismissed the
		// first-time picker: still index locally, but skip the LLM stages.
		const harness = await ensureHarnessChosen();

		const [indexOk, handbookOk] = await Promise.all([
			runIndexing(context, workspaceRoot, onIndex, cts.token),
			harness
				? runHandbookViaHarness(context, harness, workspaceRoot, onHandbook, cts.token)
				: Promise.resolve(false),
		]);

		// Bring-up needs the handbook on disk to enumerate services. Run it once
		// both prior phases have finished; skip (without erroring) if cancelled, if
		// no harness was chosen, or if no handbook was produced (nothing to read).
		let bringupOk = false;
		if (harness && !cts.token.isCancellationRequested && isHandbookGenerated(workspaceRoot)) {
			bringupOk = await runBringupListViaHarness(context, harness, workspaceRoot, onBringup, cts.token);
		}

		if (cts.token.isCancellationRequested) {
			setDiscoveryState({ phase: 'idle', label: 'Discovery stopped' });
		} else if (indexOk && handbookOk && bringupOk) {
			// Automatic state-machine transition: once services are listed, set every
			// one up (bring it up + verify a start command) without waiting for the
			// user to click each. Already-verified services are skipped. When
			// Auto-Pilot is enabled it owns this whole phase (with retries, health
			// verification, and fix episodes) — it starts off the 'done' state below
			// (see registerAutoPilotAutoStart), so running the plain sweep here too
			// would double-dispatch every setup.
			if (!isAutoPilotEnabled()) {
				await autoSetupServices(context, workspaceRoot, cts.token);
			}
			setDiscoveryState({ phase: 'done', label: 'Discovered' });
			// The fresh index may have published ambiguous references — resolve
			// them automatically, once per index epoch, with no toast: the runner
			// records {epoch, resolved, remaining} and never re-offers the same
			// epoch (see enhanceRunner). Detached; it never contends with harness
			// work (single-flight respected inside).
			void maybeAutoEnhance(context, workspaceRoot);
		} else {
			setDiscoveryState({
				phase: 'failed',
				label: 'Discovery incomplete',
				detail: failureDetail(indexOk, handbookOk, bringupOk),
			});
		}

		return { indexOk, handbookOk, bringupOk };
	} finally {
		activeCts = undefined;
		cts.dispose();
		void vscode.commands.executeCommand('setContext', 'vinv.discovering', false);
	}
}

/**
 * Sets up every listed service that isn't already verified — the automatic
 * "list → set up" transition. Sequential (bring-up is single-flight) and
 * best-effort: a failure on one service is logged and doesn't stop the rest.
 * Honors the discovery cancellation token between services.
 */
async function autoSetupServices(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	token: vscode.CancellationToken,
): Promise<void> {
	const pending = readServices(workspaceRoot).filter(
		(s) => !isServiceStarted(workspaceRoot, s.name),
	);
	let done = 0;
	for (const service of pending) {
		if (token.isCancellationRequested) {
			return;
		}
		setDiscoveryState({
			phase: 'running',
			label: `Setting up services — ${service.name} (${++done}/${pending.length})`,
		});
		try {
			await runBringupStartViaHarness(context, getHarnessId(), workspaceRoot, service, undefined, token);
		} catch (e) {
			console.error(`Vinv: auto-setup failed for ${service.name}`, e);
		}
	}
}

/** True when discovery produced all three artifacts: index, handbook, services. */
export function isProjectDiscovered(workspaceRoot: string): boolean {
	return (
		isProjectIndexed(workspaceRoot) &&
		isHandbookGenerated(workspaceRoot) &&
		isServicesListed(workspaceRoot)
	);
}

let autoDiscovering = false;

/**
 * Runs discovery automatically for the open workspace when it makes sense to —
 * triggered on extension startup and on workspace-folder changes. It is a no-op
 * (returns silently) unless every precondition holds:
 *   • the auto-discover toggle is on (Settings tab / vinv.autoDiscover.enabled),
 *   • a folder is open, and
 *   • the project isn't already fully discovered (index + handbook + services).
 *
 * The last guard keeps reopening an already-discovered workspace cheap:
 * re-indexing and the expensive handbook/bring-up agents only run the first time
 * (or after a failed/partial run), not on every reload. Users can always
 * re-trigger manually from the Project status row or the Configure panel.
 */
export async function maybeAutoDiscover(context: vscode.ExtensionContext): Promise<void> {
	if (autoDiscovering) {
		return;
	}
	if (!isAutoDiscoverEnabled()) {
		return;
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const root = folder.uri.fsPath;
	if (isProjectDiscovered(root)) {
		return; // already discovered — nothing to do
	}
	autoDiscovering = true;
	try {
		await runDiscovery(context, root);
	} finally {
		autoDiscovering = false;
	}
}
