/**
 * Opening a file that a webview button asked for, safely.
 *
 * Every judgment card, flow rail, graph node and call-tree row can post a path
 * back to the extension and expect the editor to open it. Historically each
 * handler did `showTextDocument(Uri.file(p))` inside a try with an EMPTY catch:
 * when the path was relative, missing, or moved, the click became a silent
 * no-op — the exact live defect users hit ("view context pack does nothing").
 *
 * This module is the single choke point for those opens. It (a) resolves the
 * path to ABSOLUTE against the workspace root, (b) verifies the file exists, and
 * (c) on ANY failure raises an actionable `showErrorMessage` naming the file and
 * the reason — never an empty catch. `resolveOpenTarget` is pure (no vscode) so
 * the resolution/existence contract is unit-testable in isolation.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Result of resolving a webview-supplied path to an absolute, existing file. */
export interface ResolvedTarget {
	ok: boolean;
	/** Absolute path, present iff `ok`. */
	absPath?: string;
	/** User-facing message, present iff `!ok`. */
	error?: string;
}

/**
 * Pure resolution + existence check. No vscode, no I/O beyond the injectable
 * `exists` probe, so tests can drive every branch deterministically.
 *
 * @param rawPath  what the webview posted (may be absolute, relative, or empty)
 * @param workspaceRoot  absolute root used to anchor a relative path
 * @param label  noun for the error message, e.g. "context pack"
 * @param exists  existence probe (defaults to fs.existsSync)
 */
export function resolveOpenTarget(
	rawPath: string | undefined,
	workspaceRoot: string | undefined,
	label = 'file',
	exists: (p: string) => boolean = fs.existsSync,
): ResolvedTarget {
	if (!rawPath || !rawPath.trim()) {
		return { ok: false, error: `Vinv: no ${label} path was provided to open.` };
	}
	let abs = rawPath;
	if (!path.isAbsolute(abs)) {
		if (!workspaceRoot) {
			return {
				ok: false,
				error: `Vinv: cannot open ${label} "${rawPath}" — path is relative and no workspace is open.`,
			};
		}
		abs = path.join(workspaceRoot, abs);
	}
	if (!exists(abs)) {
		return { ok: false, error: `Vinv: ${label} not found at ${abs}` };
	}
	return { ok: true, absPath: abs };
}

/** How to open a resolved file. */
export interface OpenInEditorOptions {
	/** Anchors a relative path; omit when the path is already absolute. */
	workspaceRoot?: string;
	/** 1-based line to reveal/select. */
	line?: number;
	/** Passed to showTextDocument; defaults to false (a real, kept tab). */
	preview?: boolean;
	viewColumn?: vscode.ViewColumn;
	/** Noun for any error message, e.g. "context pack". */
	label?: string;
	/**
	 * Open through the registered default editor (`vscode.open`) instead of the
	 * text editor — needed for custom viewers (call-tree JSON, smoke HTML).
	 * `line` is ignored in this mode.
	 */
	useDefaultEditor?: boolean;
}

/**
 * Resolve, verify, and open a webview-supplied path. Returns true on success;
 * on ANY failure it shows an actionable error and returns false — the caller
 * never has to (and must never) swallow the outcome silently.
 */
export async function openPathInEditor(
	rawPath: string | undefined,
	opts: OpenInEditorOptions = {},
): Promise<boolean> {
	const label = opts.label ?? 'file';
	const resolved = resolveOpenTarget(rawPath, opts.workspaceRoot, label);
	if (!resolved.ok || !resolved.absPath) {
		void vscode.window.showErrorMessage(resolved.error ?? `Vinv: could not open ${label}.`);
		return false;
	}
	const uri = vscode.Uri.file(resolved.absPath);
	try {
		if (opts.useDefaultEditor) {
			await vscode.commands.executeCommand('vscode.open', uri);
		} else {
			const showOpts: vscode.TextDocumentShowOptions = {
				preview: opts.preview ?? false,
				viewColumn: opts.viewColumn,
			};
			if (opts.line && opts.line > 0) {
				const pos = new vscode.Position(Math.max(0, opts.line - 1), 0);
				showOpts.selection = new vscode.Range(pos, pos);
			}
			await vscode.window.showTextDocument(uri, showOpts);
		}
		return true;
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		void vscode.window.showErrorMessage(
			`Vinv: could not open ${label} at ${resolved.absPath} — ${reason}`,
		);
		return false;
	}
}
