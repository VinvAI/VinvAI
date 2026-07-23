import * as path from 'path';
import * as fs from 'fs';

/** Project-local handbook output: <workspace>/.vinv/vinv.md */
export function getHandbookPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'vinv.md');
}

/** True when a non-empty handbook has already been generated for the workspace. */
export function isHandbookGenerated(workspaceRoot: string): boolean {
	try {
		return fs.statSync(getHandbookPath(workspaceRoot)).size > 0;
	} catch {
		return false;
	}
}

/** A point-in-time handbook progress update (see runHandbookViaHarness). */
export interface HandbookProgress {
	/** Always null: the harness emits no completion fraction, only phase labels. */
	percent: number | null;
	/** Human-readable status line for the UI. */
	label: string;
}
