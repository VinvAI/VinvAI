/**
 * Closes the episode loop: the index follows the code automatically.
 *
 * Two responsibilities, both passive until the project has a built index:
 *
 * 1. Auto incremental reindex — every workspace save schedules a debounced
 *    `index update` (the binary reuses unchanged files' vectors, so a typical
 *    save re-embeds a handful of symbols). The store's content epoch advances
 *    only when symbol content actually changed, so cosmetic runs are free.
 *
 * 2. Epoch-tagging of capture sessions — when tracelens writes a new
 *    `trace.jsonl` under .vinv/captures, an `epoch.json` is stamped beside it
 *    recording the index epoch at capture time. The runtime MCP joins this
 *    against per-chunk epochs to tell which runtime facts describe code that
 *    has since changed (see traceStore.sourceEpoch / analysis staleness).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getBinPath, isBinAvailable } from '../tracelens/bin';
import { ensureEmbedder } from '../engines/install';
import { getIndexEnv } from '../config/settings';
import { getIndexStoreDir, isProjectIndexed } from './indexing';

const DEBOUNCE_MS = 5_000;

/** Current content epoch of the workspace index, or null when unreadable. */
export function readIndexEpoch(workspaceRoot: string): number | null {
	try {
		const meta = JSON.parse(
			fs.readFileSync(path.join(getIndexStoreDir(workspaceRoot), 'meta.json'), 'utf8'),
		) as { epoch?: number };
		return typeof meta.epoch === 'number' ? meta.epoch : 0;
	} catch {
		return null;
	}
}

let updateRunning = false;
let updateQueued = false;
let debounceTimer: NodeJS.Timeout | undefined;

/** Runs one `index update`, queueing (not stacking) runs that arrive mid-flight. */
function runUpdate(context: vscode.ExtensionContext, workspaceRoot: string): void {
	if (updateRunning) {
		updateQueued = true;
		return;
	}
	if (!isBinAvailable(context, 'index') || !isProjectIndexed(workspaceRoot)) {
		return;
	}
	updateRunning = true;
	const binPath = getBinPath(context, 'index');
	// Incremental updates re-embed changed chunks — the sidecar must be up.
	void ensureEmbedder(context).then((ok) => {
		if (!ok) {
			updateRunning = false;
			return;
		}
		const child = spawn(
			binPath,
			['update', workspaceRoot, '--store-dir', getIndexStoreDir(workspaceRoot)],
			{ env: getIndexEnv(path.dirname(binPath)), windowsHide: true },
		);
		child.on('error', () => {
			updateRunning = false;
		});
		child.on('close', () => {
			updateRunning = false;
			if (updateQueued) {
				updateQueued = false;
				runUpdate(context, workspaceRoot);
			}
		});
	});
}

/**
 * Stamp `epoch.json` beside a freshly created trace so its runtime facts are
 * anchored to the code state they observed. Never overwrites an existing tag:
 * the first stamp (earliest epoch) is the honest one.
 */
function stampSessionEpoch(workspaceRoot: string, traceFile: string): void {
	const tagPath = path.join(path.dirname(traceFile), 'epoch.json');
	if (fs.existsSync(tagPath)) {
		return;
	}
	const epoch = readIndexEpoch(workspaceRoot);
	if (epoch === null) {
		return;
	}
	try {
		fs.writeFileSync(
			tagPath,
			JSON.stringify({ epoch, captured_unix: Math.floor(Date.now() / 1000) }),
		);
	} catch {
		// Capture dir vanished mid-write; the session stays untagged (kept as
		// epoch-unknown by the reader).
	}
}

/**
 * Wire up save-triggered incremental reindexing and capture epoch-tagging for
 * the first workspace folder. Idempotent per activation; disposables land in
 * context.subscriptions.
 */
export function startAutoReindex(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const workspaceRoot = folder.uri.fsPath;

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			const rel = path.relative(workspaceRoot, doc.uri.fsPath);
			// Only real workspace files; edits to Vinv's own artifacts don't
			// change indexed code.
			if (rel.startsWith('..') || rel.split(path.sep)[0] === '.vinv') {
				return;
			}
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(() => runUpdate(context, workspaceRoot), DEBOUNCE_MS);
		}),
	);

	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(folder, '.vinv/captures/**/trace.jsonl'),
	);
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate((uri) => stampSessionEpoch(workspaceRoot, uri.fsPath)),
	);
}
