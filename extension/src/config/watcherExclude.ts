/**
 * Keeps `.vinv/` out of VS Code's native file watcher.
 *
 * `.vinv` is Vinv's own artifact directory and nothing else reads it: the index
 * store (tens of MB of chunks/vectors), every capture, the per-run logs, and —
 * the expensive one — a full git worktree checkout per isolated harness run.
 * `ensureVinvGitignored` already keeps all of that out of search and source
 * control, but `files.watcherExclude` is a SEPARATE mechanism: the watcher does
 * not consult .gitignore, so by default the editor natively watches thousands
 * of files that only this extension ever writes.
 *
 * This does not blind Vinv to its own artifacts. An explicit
 * `createFileSystemWatcher` is honoured regardless of this setting — the
 * exclusion applies to the implicit workspace-wide watch that feeds the
 * explorer, git decorations and the like.
 *
 * Written to the WORKSPACE scope, and only when absent: the value is a
 * user-editable setting, so an explicit `false` the user set is left alone.
 */
import * as vscode from 'vscode';

/** The glob VS Code keys the exclusion by. */
export const VINV_WATCH_GLOB = '**/.vinv/**';

/**
 * Adds `**\/.vinv/**` to `files.watcherExclude` for this workspace when the key
 * is not already present. Returns true when a write happened.
 *
 * Never throws: an untrusted or virtual workspace rejects configuration writes,
 * and that is not a reason to fail activation.
 */
export async function excludeVinvFromWatcher(): Promise<boolean> {
	try {
		if (!vscode.workspace.workspaceFolders?.length) {
			return false;
		}
		const config = vscode.workspace.getConfiguration('files');
		const inspected = config.inspect<Record<string, boolean>>('watcherExclude');
		// Any explicit setting for our glob — at any scope — is the user's call.
		for (const scope of [
			inspected?.workspaceFolderValue,
			inspected?.workspaceValue,
			inspected?.globalValue,
		]) {
			if (scope && VINV_WATCH_GLOB in scope) {
				return false;
			}
		}
		const current = inspected?.workspaceValue ?? {};
		await config.update(
			'watcherExclude',
			{ ...current, [VINV_WATCH_GLOB]: true },
			vscode.ConfigurationTarget.Workspace,
		);
		return true;
	} catch {
		// Untrusted/virtual workspace, or a read-only settings file.
		return false;
	}
}
