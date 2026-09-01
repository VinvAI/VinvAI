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
import { runDeadCodeScan, type DeadCodeProgress } from './deadCodeScan';
import { awaitEnginesTerminal } from '../engines/install';
import { bucketCount, bucketMs, classifyError, track, type DiscoveryStage } from '../telemetry';

/** Combined outcome of a Discover Project run. */
export interface DiscoveryResult {
	indexOk: boolean;
	handbookOk: boolean;
	deadCodeOk: boolean;
	bringupOk: boolean;
}

/** Per-stage progress callbacks for a discovery run. */
export interface DiscoveryProgress {
	onIndex?: (p: IndexProgress) => void;
	onHandbook?: (p: HandbookProgress) => void;
	onDeadCode?: (p: DeadCodeProgress) => void;
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
	/**
	 * How this run was reached. Reporting only — it separates "auto-discovery on
	 * activation" from "the user clicked Discover" from "Auto-Pilot drove it",
	 * which behave very differently and would otherwise be one undifferentiated
	 * number.
	 */
	trigger?: 'auto' | 'command' | 'autopilot';
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

/**
 * Runs one discovery stage, recording how long it took and how it ended.
 *
 * Cancellation is read from the shared token rather than inferred from a thrown
 * value, because these stages signal a stopped run by returning false, not by
 * throwing — counting that as a failure would make the Stop button look like a
 * bug in whatever stage happened to be running.
 */
async function timeStage(
	stage: DiscoveryStage,
	run: () => Thenable<boolean>,
	token: vscode.CancellationToken,
): Promise<boolean> {
	const started = Date.now();
	let ok = false;
	try {
		ok = await run();
		return ok;
	} finally {
		track('discovery_stage', {
			stage,
			outcome: token.isCancellationRequested ? 'cancelled' : ok ? 'ok' : 'error',
			duration_ms: bucketMs(Date.now() - started),
		});
	}
}

/** Service count for reporting; a half-written services file must not throw here. */
function safeServiceCount(workspaceRoot: string): number {
	try {
		return readServices(workspaceRoot).length;
	} catch {
		return 0;
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
 *   1. index build (.vinv/index), handbook generation (.vinv/vinv.md) and the
 *      dead-code scan (.vinv/deadcode.md) run in parallel — independent of one
 *      another, so a failure in one does not block the others. The dead-code
 *      scan reads source rather than the index store, which is why it does not
 *      have to wait for indexing to finish.
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
		return { indexOk: false, handbookOk: false, deadCodeOk: false, bringupOk: false };
	}

	const discoveryStarted = Date.now();
	track('discovery_started', {
		trigger: options.trigger ?? 'command',
		force: !!options.force,
		harness_id: getHarnessId(),
	});

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
	const onDeadCode = (p: DeadCodeProgress): void => {
		setDiscoveryState({ phase: 'running', label: `Dead code — ${p.label}` });
		progress.onDeadCode?.(p);
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

		// Each stage reports its own duration and outcome as it settles, rather
		// than one event for the phase: the whole question this answers is WHICH
		// stage kills a discovery, and a combined result cannot say.
		const [indexOk, handbookOk, deadCodeOk] = await Promise.all([
			timeStage('index', () => runIndexing(context, workspaceRoot, onIndex, cts.token), cts.token),
			harness
				? timeStage(
						'handbook',
						() => runHandbookViaHarness(context, harness, workspaceRoot, onHandbook, cts.token),
						cts.token,
					)
				: Promise.resolve(false),
			// Reads source rather than the store, so it does not wait on indexing —
			// and needs no harness, so it runs even when the LLM stages are skipped.
			timeStage(
				'deadcode',
				() => runDeadCodeScan(context, workspaceRoot, onDeadCode, cts.token),
				cts.token,
			),
		]);

		// Bring-up needs the handbook on disk to enumerate services. Run it once
		// both prior phases have finished; skip (without erroring) if cancelled, if
		// no harness was chosen, or if no handbook was produced (nothing to read).
		let bringupOk = false;
		if (harness && !cts.token.isCancellationRequested && isHandbookGenerated(workspaceRoot)) {
			bringupOk = await timeStage(
				'bringup',
				() => runBringupListViaHarness(context, harness, workspaceRoot, onBringup, cts.token),
				cts.token,
			);
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

		track('discovery_finished', {
			outcome: cts.token.isCancellationRequested
				? 'cancelled'
				: indexOk && handbookOk && bringupOk
					? 'done'
					: 'incomplete',
			index_ok: indexOk,
			handbook_ok: handbookOk,
			deadcode_ok: deadCodeOk,
			bringup_ok: bringupOk,
			services_count: bucketCount(safeServiceCount(workspaceRoot)),
			total_ms: bucketMs(Date.now() - discoveryStarted),
		});

		// deadCodeOk is reported but deliberately absent from the completion
		// condition above: the scan is a report, and losing it does not leave the
		// project undiscovered the way a missing index or service inventory does.
		return { indexOk, handbookOk, deadCodeOk, bringupOk };
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
			// Was console.error alone. A service that never gets set up is the
			// difference between Vinv working and Vinv appearing to do nothing,
			// so the failure needs to be countable.
			track('autosetup_service_failed', {
				error_class: classifyError(e),
				services_total: bucketCount(pending.length),
			});
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
 * The extension version a workspace last auto-discovered under.
 *
 * Keyed PER WORKSPACE, not globally: one machine holds several, each carries its
 * own index and services, and each needs its own pass after an update. A single
 * global marker would let whichever window activated first consume the update on
 * behalf of workspaces that never re-ran anything.
 */
const DISCOVERED_VERSION_KEY = 'vinv.autoDiscover.versionByWorkspace';

/**
 * Raise this to force ONE automatic re-discovery pass on every workspace, on the
 * next activation, without the package version having to move.
 *
 * The marker is keyed by version, on the assumption that a build worth
 * re-discovering for arrives with a new version number. That assumption does not
 * hold while iterating: a vsix rebuilt under the same version ships different
 * engines (the pin moves several times inside one version), so its artifacts are
 * stale in exactly the way this exists to catch, and every install of it read as
 * already-current and did nothing. Bumping this invalidates every marker written
 * by an earlier build of the same version, which is what makes "installing this
 * version re-discovers, with no user action" true.
 *
 * Cost of a bump: one re-index + handbook + bring-up pass per workspace. Do it
 * when the build changes what those artifacts contain, not on every rebuild.
 */
const REDISCOVER_REV = 1;

/** Identity a discovery marker is valid for: the version AND the forced revision. */
export function discoveryStamp(version: string): string {
	return version ? `${version}#${REDISCOVER_REV}` : '';
}

function discoveredStamps(context: vscode.ExtensionContext): Record<string, string> {
	return context.globalState.get<Record<string, string>>(DISCOVERED_VERSION_KEY) ?? {};
}

async function rememberDiscoveredStamp(
	context: vscode.ExtensionContext,
	root: string,
	stamp: string,
): Promise<void> {
	await context.globalState.update(DISCOVERED_VERSION_KEY, {
		...discoveredStamps(context),
		[root]: stamp,
	});
}

/**
 * Whether an already-discovered workspace should be discovered AGAIN because the
 * build it last ran under is not this one. Pure — the caller supplies the facts —
 * so the "does this re-index on every window reload" question has an answer that
 * can be tested rather than argued about.
 *
 * `stamp` is discoveryStamp(version), not the bare version, so a forced revision
 * bump reaches installs whose version number did not move.
 *
 * `seen === undefined` DOES count: a workspace with no record was discovered by
 * a build that predates the marker, so its artifacts are the oldest ones here,
 * and "I have no record of this workspace" is the one state where staying quiet
 * guarantees the install changes nothing. This reverses the earlier rule, which
 * skipped it to avoid re-indexing a workspace that might be current — the wrong
 * direction to err in once installing a build is supposed to bring the workspace
 * onto it with no user action. It costs one pass, and only ever one: the marker
 * is written as soon as it completes.
 */
export function shouldRediscoverForUpdate(input: {
	discovered: boolean;
	seen: string | undefined;
	stamp: string;
}): boolean {
	if (!input.discovered) {
		return false; // not discovered at all — the normal first-run path handles it
	}
	if (!input.stamp) {
		return false; // unknown build (no packageJSON version) — never force work
	}
	return input.seen !== input.stamp;
}

/**
 * Runs discovery automatically for the open workspace when it makes sense to —
 * triggered on extension startup and on workspace-folder changes. It is a no-op
 * (returns silently) unless every precondition holds:
 *   • the auto-discover toggle is on (Settings tab / vinv.autoDiscover.enabled),
 *   • a folder is open, and
 *   • the project isn't already fully discovered (index + handbook + services).
 *
 * The already-discovered guard keeps reopening a workspace cheap: re-indexing and
 * the expensive handbook/bring-up agents do not run on every reload. It is now
 * ABSOLUTE — an install or update no longer overrides it. The update exception
 * that used to live here (force-rebuild when this build is not the one the
 * workspace last ran under) is commented out below, with the trade-off it gives
 * up; "Re-discover Project (Force Rebuild)" is the user-driven equivalent.
 *
 * The stamp bookkeeping is kept regardless, so restoring the exception needs no
 * migration: every workspace still records the build it was last seen under.
 *
 * It waits for a running engines terminal, and then runs WHATEVER that terminal
 * did. Those are two separate things and both are deliberate. Waiting matters
 * because a clone or a `git checkout` mid-flight is a moving target to index.
 * Running regardless matters because the alternative — proceeding only once the
 * engines look correct — is what made this unreachable in 0.2.1: the readiness
 * check reported a false "environment is stale" that no sync could clear, so
 * re-discovery waited for a condition that could never arrive and never ran at
 * all. A pass that fails leaves the marker unwritten and is retried on the next
 * activation; a pass that never fires is invisible.
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
	const version = String(context.extension.packageJSON.version ?? '');
	const stamp = discoveryStamp(version);
	const discovered = isProjectDiscovered(root);

	// A rebuild from scratch, not a resume: this is "Re-discover Project (Force
	// Rebuild)" fired by the install itself, minus that command's confirmation.
	// Reusing the artifacts is the thing being fixed — they were produced by
	// engines this build no longer ships — so gap-filling would keep exactly what
	// is stale. Only ever set on the re-discovery path; a first run has nothing
	// to delete.
	const force = false;

	if (discovered) {
		// DISABLED: an install or update no longer force-rebuilds a workspace that
		// is already discovered. The pass it fired is the full one — delete the
		// artifacts, re-index, re-run the handbook and bring-up agents — and it ran
		// unprompted on every version bump, on every workspace, with no way to
		// decline it. An already-discovered workspace is now left exactly as it is.
		//
		// The trade-off this gives up is real and is the reason the behavior
		// existed: the artifacts on disk were produced by the engines the PREVIOUS
		// build pinned, and the contracts between them are versioned (index store
		// format, MCP payload shapes, recorded start commands). A stale store can
		// therefore surface as a v4/v5 refusal or an empty MCP result rather than
		// as anything self-describing. Auto-Pilot also hangs off discovery
		// COMPLETING, so a workspace that never re-discovers does not auto-start
		// the pipeline after an update.
		//
		// Both are now the user's call: "Vinv: Re-discover Project (Force Rebuild)"
		// does exactly what this block did, with a confirmation. To restore the
		// automatic behavior, un-comment below and make `force` a `let` again.
		//
		// const seen = discoveredStamps(context)[root];
		// if (shouldRediscoverForUpdate({ discovered, seen, stamp })) {
		// 	console.log(
		// 		`Vinv: this workspace last discovered under ${seen ?? 'an unrecorded build'}, this build is ${stamp} — force re-discovering`,
		// 	);
		// 	force = true;
		// }

		// Record what this workspace is on so the NEXT build is detectable, and
		// leave the artifacts alone.
		await rememberDiscoveredStamp(context, root, stamp);
		return;
	}

	autoDiscovering = true;
	try {
		// Let the engines terminal finish first — pass or fail. Resolves at once
		// when nothing is running, which is the usual case.
		await awaitEnginesTerminal();
		await runDiscovery(context, root, {}, { force });
		// Only a pass that actually produced the artifacts counts. The marker used
		// to be written whatever came back, which quietly cancelled the retry the
		// comment promised: a run that failed — engines still building, indexing
		// died, the user cancelled — recorded this build as done and nothing
		// re-ran until the next one. Asking the artifacts, rather than the run's
		// own result, is also what keeps this from looping: a workspace that ends
		// up discovered is always marked, so it is never re-discovered twice.
		if (isProjectDiscovered(root)) {
			await rememberDiscoveredStamp(context, root, stamp);
		}
	} finally {
		autoDiscovering = false;
	}
}
