/**
 * Runs a triage pass: the vscode-aware half of finding verification.
 *
 * findingVerification holds the rules (what a verdict is, what may hide a
 * finding, when the quiet period expires) and is free of vscode so it can be
 * unit-tested. This module supplies the things only the extension host knows —
 * where the goal engine lives, which harness is chosen, how to reach it — and
 * turns them into one pass over the findings that have no verdict yet.
 *
 * Nothing here decides anything. Every early return is a reason to leave the
 * findings exactly as they are, which means showing them: no engine, no
 * harness, nothing unjudged, or a judge that could not answer.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getBinPath } from '../tracelens/bin';
import { getHandbookEnv, getHarnessId, hasChosenHarness } from '../config/settings';
import { dispatchAgentPrompt } from './harnessRunner';
import {
	cancelQuietTimer,
	judgeFindings,
	pendingFindingsFrom,
	noteFindingsChanged,
	readVerdicts,
	writeVerdicts,
} from './findingVerification';

/** Why a pass was started — for the log line, and for the telemetry that reads it. */
export type TriageReason = 'pass-finished' | 'quiet-period';

function readClusters(workspaceRoot: string): Array<Record<string, unknown>> {
	try {
		const doc = JSON.parse(
			fs.readFileSync(path.join(workspaceRoot, '.vinv', 'exercise', 'issues.json'), 'utf8'),
		) as { clusters?: unknown };
		return Array.isArray(doc.clusters) ? (doc.clusters as Array<Record<string, unknown>>) : [];
	} catch {
		return [];
	}
}

/** One pass at a time per workspace: a quiet timer and a finishing pass can race. */
const running = new Set<string>();

/**
 * Judges every finding that has no verdict yet.
 *
 * Resolves the number of verdicts stored, or null when no judgement was
 * possible — the caller treats both as "leave the view alone", and they are
 * distinguished only for the log.
 */
export async function triageFindings(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	reason: TriageReason,
): Promise<number | null> {
	if (running.has(workspaceRoot)) {
		return null;
	}
	// A finishing pass supersedes any armed quiet timer for this workspace.
	cancelQuietTimer(workspaceRoot);
	const pending = pendingFindingsFrom(readClusters(workspaceRoot), readVerdicts(workspaceRoot));
	if (pending.length === 0) {
		return 0;
	}
	if (!hasChosenHarness()) {
		// No agent to ask. The findings stay pending and stay visible; the next
		// pass after a harness is chosen picks them up unchanged.
		return null;
	}
	const harnessId = getHarnessId();
	const goalBin = getBinPath(context, 'goal');
	if (!fs.existsSync(goalBin)) {
		return null;
	}
	running.add(workspaceRoot);
	try {
		const verdicts = await judgeFindings(
			{
				binPath: goalBin,
				env: getHandbookEnv(path.dirname(goalBin), workspaceRoot),
				cwd: workspaceRoot,
				dispatch: (name, prompt) => dispatchAgentPrompt(harnessId, workspaceRoot, name, prompt),
			},
			harnessId,
			pending,
		);
		if (!verdicts) {
			console.warn(
				`Vinv: finding triage (${reason}) could not reach ${harnessId}; ` +
					`${pending.length} finding(s) stay unverified and visible.`,
			);
			return null;
		}
		const count = Object.keys(verdicts).length;
		if (count > 0) {
			writeVerdicts(workspaceRoot, verdicts);
		}
		return count;
	} finally {
		running.delete(workspaceRoot);
	}
}

/**
 * Arms the quiet-period fallback after new findings land mid-pass.
 *
 * The normal path is the pass finishing. This covers the pass that never
 * finishes — cancelled, crashed, or a service that hangs — so findings are not
 * left pending forever with no one to judge them.
 */
export function armTriageFallback(context: vscode.ExtensionContext, workspaceRoot: string): void {
	noteFindingsChanged(workspaceRoot, () => {
		void triageFindings(context, workspaceRoot, 'quiet-period');
	});
}
