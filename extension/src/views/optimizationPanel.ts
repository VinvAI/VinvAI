/**
 * The Optimization nudge — the ambient half of the feature that has NO
 * persistent surface of its own. The background analyzer (OptimizationSource)
 * keeps .vinv/reports/optimization.json current; the ranked evidence lives in
 * the full-page report tab (optimizationReportView.ts), opened by a button on
 * the Flow rail exactly like the graph explorer. This module is only the quiet
 * pointer to it: the first time opportunities appear, offer to open the report.
 */
import * as vscode from 'vscode';
import type { OptimizationSource } from './optimizationSource';

/**
 * A once-per-session, non-modal nudge. The first time the background analyzer
 * surfaces open opportunities, offer to open the report. Deliberately quiet —
 * it fires only on the 0→N transition and never again, so a steady backlog does
 * not nag.
 */
export function registerOptimizationNudge(
	context: vscode.ExtensionContext,
	source: OptimizationSource,
): void {
	let nudged = false;
	context.subscriptions.push(
		source.onDidChange((model) => {
			if (nudged) {
				return;
			}
			const open = model.candidates.filter((c) => c.status === 'candidate').length;
			if (open === 0) {
				return;
			}
			nudged = true;
			void vscode.window
				.showInformationMessage(
					`Vinv: ${open} optimization opportunit${open === 1 ? 'y' : 'ies'} found — ranked by recoverable time.`,
					'Open Optimize',
					'Dismiss',
				)
				.then((choice) => {
					if (choice === 'Open Optimize') {
						void vscode.commands.executeCommand('vinv-vs.openOptimization');
					}
				});
		}),
	);
}
