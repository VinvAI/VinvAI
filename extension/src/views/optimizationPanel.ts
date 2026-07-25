/**
 * The Optimization nudge — the ambient half of the feature that has NO
 * persistent surface of its own. The background analyzer (OptimizationSource)
 * keeps .vinv/reports/optimization.json current; the ranked evidence lives in
 * the full-page report tab (optimizationReportView.ts), opened by a button on
 * the Flow rail exactly like the graph explorer. This module is only the quiet
 * pointer to it: when the opportunity board holds actionable entries and the
 * user has not opened the report this session, say so — once.
 */
import * as vscode from 'vscode';
import { loadOpportunityBoard } from '../harness/opportunityBoard';
import { optimizeReportOpenedThisSession } from './optimizationReportView';
import type { OptimizationSource } from './optimizationSource';

/**
 * How many actionable (posted, not yet dispatched/resolved) entries the
 * opportunity board currently holds for a workspace. The board is the one
 * cross-restart record of undispatched opportunities, so the nudge speaks even
 * when the in-memory ranking is still warming up. Exported for the nudge line
 * on the status bar, which shares this exact definition of "actionable".
 */
export function actionableOpportunityCount(workspaceRoot: string): number {
	try {
		return loadOpportunityBoard(workspaceRoot).filter((e) => e.status === 'posted').length;
	} catch {
		return 0; // unreadable board — say nothing rather than something wrong
	}
}

/** The one quiet sentence both ambient surfaces show. */
export function timeSaverLine(count: number): string {
	return `${count} verified time-saver${count === 1 ? '' : 's'} found — open Optimize`;
}

/**
 * A once-per-session, non-modal nudge. Rides the background analyzer's change
 * events (already debounced), fires only while the Optimize report has NOT
 * been opened this session, and never fires twice — a steady backlog does not
 * nag.
 */
export function registerOptimizationNudge(
	context: vscode.ExtensionContext,
	source: OptimizationSource,
): void {
	let nudged = false;
	context.subscriptions.push(
		source.onDidChange(() => {
			if (nudged || optimizeReportOpenedThisSession()) {
				return;
			}
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root) {
				return;
			}
			const actionable = actionableOpportunityCount(root);
			if (actionable === 0) {
				return;
			}
			nudged = true;
			void vscode.window
				.showInformationMessage(`Vinv: ${timeSaverLine(actionable)}.`, 'Open Optimize', 'Dismiss')
				.then((choice) => {
					if (choice === 'Open Optimize') {
						void vscode.commands.executeCommand('vinv-vs.openOptimization');
					}
				});
		}),
	);
}
