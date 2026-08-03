/**
 * One registry of the heavy, workspace-wide passes, so overlapping ones are
 * refused with an explanation instead of stacking silently.
 *
 * Each pass already guarded ITSELF — `runDiscovery` has `activeCts`,
 * `runInsightPass` has `insightRunning`, `runProbePass` has `probeRunning`,
 * `runEpisode` has `episodeRunning`. What was missing is arbitration BETWEEN
 * them. Nothing stopped discovery, an insight pass, a probe pass, an exercise
 * pass and a graph enhancement from running at once, and the automatic paths
 * knew better than the manual ones: Auto-Pilot and the auto-triggers wait on
 * `isHarnessBusy()`, while the palette and Flow-rail commands dispatched
 * straight through.
 *
 * That mattered less for CPU than for WRITE VOLUME. Every one of these passes
 * writes into `.vinv`, and each write wakes the debounced background sources
 * that rebuild the Flow model and the report mirrors. Concurrent passes
 * multiply that traffic, and because it all lands on the extension host's
 * single thread the window stops servicing anything else — which is exactly
 * when a user, seeing nothing happen, clicks another action.
 *
 * Deliberately NOT a queue. A refused pass tells the user what is already
 * running and stops; silently deferring work they asked for, to start minutes
 * later against a workspace that has since changed, is worse than saying no.
 *
 * Deliberately NOT applied to episodes. `runEpisode` has its own richer
 * precondition chain (harness auth, index presence, budget) and its own
 * message, and each episode works in an isolated worktree.
 */
import * as vscode from 'vscode';

/** A pass that holds the workspace, with the label shown to whoever collides. */
interface HeldPass {
	id: string;
	label: string;
	at: number;
}

let held: HeldPass | undefined;

/** The pass currently holding the workspace, if any. */
export function currentHeavyPass(): { id: string; label: string } | undefined {
	return held ? { id: held.id, label: held.label } : undefined;
}

/**
 * Claims the workspace for `id`. Returns false — after showing the user which
 * pass is already running — when another holds it.
 *
 * `label` is what a colliding caller is told is in the way, so it should read
 * as a thing ("Graph enhancement"), not an imperative.
 */
export function claimHeavyPass(id: string, label: string): boolean {
	if (held) {
		void vscode.window.showInformationMessage(
			held.id === id
				? `Vinv: ${label} is already running.`
				: `Vinv: ${held.label} is running — wait for it to finish, then try ${label} again.`,
		);
		return false;
	}
	held = { id, label, at: Date.now() };
	return true;
}

/**
 * Releases the workspace. Safe to call for a pass that never claimed it (a
 * caller that bailed early), and it will not release another pass's claim.
 */
export function releaseHeavyPass(id: string): void {
	if (held?.id === id) {
		held = undefined;
	}
}

/** Drops any claim — for tests, and for a window tearing down mid-pass. */
export function resetHeavyPasses(): void {
	held = undefined;
}

/**
 * A pass whose own module-level flag says it is running, or undefined.
 *
 * Every long-running pass already published this state — `isProbeRunning`,
 * `isInsightRunning`, `isExerciseRunning`, `isEnhanceRunning`,
 * `harnessRunsInFlight` — and NOTHING read any of them. The state was there,
 * the arbitration was not, which is why several passes could run at once.
 *
 * This is the subscriber. It exists as a second check alongside the claim
 * because a pass can be started by a path that never claims (Auto-Pilot drives
 * the runners directly, so its work is legitimate but unclaimed) — a manual
 * click during that should still be told to wait rather than pile on.
 */
export function detectRunningPass(probes: ReadonlyArray<{ running: () => boolean; label: string }>):
	| string
	| undefined {
	for (const p of probes) {
		try {
			if (p.running()) {
				return p.label;
			}
		} catch {
			// A probe that cannot answer is not evidence of a running pass.
		}
	}
	return undefined;
}
