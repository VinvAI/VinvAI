/**
 * One-call registration for the post-green pipeline's background runners:
 *
 *  - auto-insights on new capture spans (insightRunner),
 *  - change awareness + automatic re-verification on reindex (diffImpact),
 *  - once-per-epoch graph enhancement (enhanceRunner).
 *
 * Kept separate from registerAutoTriggers to avoid an import cycle
 * (insightRunner dispatches through autoTrigger). Called from
 * registerCommands during activation.
 */
import * as vscode from 'vscode';
import { registerInsightRunner } from './insightRunner';
import { registerChangeAwareness } from '../index/diffImpact';
import { registerAutoEnhance } from '../index/enhanceRunner';
import { primeExerciseState } from './exerciseRunner';
import { triageFindings } from './findingTriage';

/** Wires every pipeline background runner. Idempotent per activation. */
export function registerPipelineRunners(context: vscode.ExtensionContext): void {
	registerInsightRunner(context);
	registerChangeAwareness(context);
	registerAutoEnhance(context);
	// Surface any persisted behavioral-exercise artifacts immediately on reload.
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (root) {
		primeExerciseState(root);
		// And judge whatever they contain that has never been judged. Triage
		// otherwise only runs when a pass produces something, so findings written
		// before it existed — or before a harness was chosen — would sit unjudged
		// for as long as the project stayed settled. Not awaited, and silent when
		// there is nothing to do or no agent to ask.
		void triageFindings(context, root, 'pass-finished');
	}
}
