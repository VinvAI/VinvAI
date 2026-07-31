/**
 * The Vinv status bar item: a persistent, glanceable indicator of the state
 * the extension is otherwise silent about — index epoch, running services,
 * an in-flight harness episode, and live failing symbols. Clicking it opens
 * the Graph Explorer.
 *
 * Placement: LEFT-aligned at high priority. Right-aligned items compete with
 * every other extension's items and get pushed toward the overflow menu, which
 * is exactly how the graph entry point became invisible; the left side keeps
 * it in a stable, always-rendered spot next to the branch indicator.
 *
 * Color: the item wears the Vinv red (theme-aware `charts.red`) as product
 * identity, and switches to the status bar's error background whenever the
 * captures show symbols failing in their latest run — red-as-brand when all
 * is well, red-as-alarm when runtime evidence says something is broken.
 *
 * While work is actually running (a service up, or a harness episode in
 * flight) it takes the warning background and a spinning icon. That state
 * deliberately does NOT use red: red is the resting colour here, so painting
 * live work red would be indistinguishable from idle. Precedence is
 * failing > running > rest.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	findTraceFiles,
	loadNodes,
	loadRuntimeOverlay,
	loadStoreEpoch,
	hasIndexStore,
	indexStoreDir,
} from '../graph/indexGraph';
import { collectRuntimeErrorClusters } from '../harness/runtimeAnalysis';
import { runningServiceNames, onServiceExit } from '../bringup/serviceRunner';
import { isEpisodeRunning } from '../harness/episodeLoop';
import { getExerciseState, onExerciseStateChange } from '../harness/pipelineState';
import { isDiscovering } from '../index/discovery';
import { actionableOpportunityCount, timeSaverLine } from './optimizationPanel';
import { optimizeReportOpenedThisSession } from './optimizationReportView';

const REFRESH_MS = 15_000;

/**
 * Signature of everything the runtime overlay is derived from: the store epoch
 * plus (path:size:mtime) of every capture/report source. Recomputing the
 * failing-symbol count only when this changes keeps the 15s refresh free —
 * parsing multi-MB traces on every tick would not be.
 */
function overlaySignature(workspaceRoot: string): string {
	const parts: string[] = [String(loadStoreEpoch(indexStoreDir(workspaceRoot)))];
	const stat = (f: string): void => {
		try {
			const s = fs.statSync(f);
			parts.push(`${f}:${s.size}:${s.mtimeMs}`);
		} catch {
			parts.push(`${f}:missing`);
		}
	};
	for (const f of findTraceFiles(path.join(workspaceRoot, '.vinv', 'captures'))) {
		stat(f);
	}
	for (const dir of [
		path.join(workspaceRoot, '.vinv', 'identification'),
		path.join(workspaceRoot, '.vinv', 'reports'),
	]) {
		try {
			for (const f of fs.readdirSync(dir)) {
				if (/\.tracemap\.json$/.test(f) || /^calltree-.*\.json$/.test(f)) {
					stat(path.join(dir, f));
				}
			}
		} catch {
			// No such dir yet — nothing to observe.
		}
	}
	return parts.join('|');
}

interface FailMemo {
	sig: string;
	count: number;
}

export function initStatusBar(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10_000);
	item.command = 'vinv-vs.openGraphExplorer';
	item.name = 'Vinv';
	context.subscriptions.push(item);

	let failMemo: FailMemo = { sig: '', count: 0 };
	const currentFailingCount = (root: string): number => {
		const sig = overlaySignature(root);
		if (sig === failMemo.sig) {
			return failMemo.count;
		}
		let count = 0;
		try {
			const nodes = loadNodes(indexStoreDir(root));
			const overlay = loadRuntimeOverlay(root, nodes);
			count = collectRuntimeErrorClusters(nodes, overlay).clusters.length;
		} catch {
			// Unreadable store mid-reindex: report calm, retry next tick.
		}
		failMemo = { sig, count };
		return count;
	};

	const update = (): void => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			item.hide();
			return;
		}
		const root = folder.uri.fsPath;
		// Trusted so the tooltip's command: links (Ask Vinv, next step) work.
		const tooltip = new vscode.MarkdownString();
		tooltip.isTrusted = true;
		if (!hasIndexStore(root)) {
			item.text = '$(circuit-board) Vinv';
			item.color = new vscode.ThemeColor('charts.red');
			item.backgroundColor = undefined;
			tooltip.appendMarkdown(
				'**Vinv** — no code index yet.\n\n' +
					'[Discover Project](command:vinv-vs.indexProject) to index this workspace, ' +
					'then click to open the Graph Explorer.',
			);
			item.tooltip = tooltip;
			item.show();
			return;
		}
		const epoch = loadStoreEpoch(indexStoreDir(root));
		const running = runningServiceNames();
		const failing = currentFailingCount(root);
		// The spinner is the part that catches the eye from across the screen —
		// motion reads before colour does, and it costs no width.
		// Every kind of live work, not just a running SERVICE. An exercise pass
		// and a discovery run are the two the tray spends most of its time
		// showing, and leaving them out was why the bar stayed still through
		// exactly the wait this indicator exists for.
		const exercising = getExerciseState().phase === 'running';
		const spinning =
			running.length > 0 || isEpisodeRunning() || exercising || isDiscovering();
		let text = `$(${spinning ? 'sync~spin' : 'circuit-board'}) Vinv e${epoch}`;
		tooltip.appendMarkdown(
			`**Vinv** — code map version ${epoch} (updates every time the code is re-indexed)\n\n`,
		);
		if (running.length > 0) {
			text += ` · ${running.length}▶`;
			tooltip.appendMarkdown(`Running services: ${running.join(', ')}\n\n`);
		}
		if (isEpisodeRunning()) {
			text += ' · agent working';
			tooltip.appendMarkdown('An agent is working on a fix right now.\n\n');
		}
		if (failing > 0) {
			text += ` · ${failing}✗`;
			tooltip.appendMarkdown(
				`**${failing} function${failing === 1 ? '' : 's'} failing** in the latest captured run — ` +
					'the graph shows exactly where.\n\n',
			);
		}
		// The quiet time-saver line: only while the board holds actionable
		// opportunities AND the Optimize report has not been opened this session.
		// Passive by design — it sits in the bar/tooltip, it never pops anything.
		const savers = optimizeReportOpenedThisSession() ? 0 : actionableOpportunityCount(root);
		if (savers > 0) {
			text += ` · ${savers}⚡`;
			tooltip.appendMarkdown(
				`**${timeSaverLine(savers)}** — [Open Optimize](command:vinv-vs.openOptimization)\n\n`,
			);
		}
		// Live work has to look DIFFERENT from rest, and red cannot do that job
		// here: red is what this item already is when nothing is happening, so
		// "turn it red while busy" would render as no change at all. A filled
		// warning pill plus the spinner is the contrast that reads at a glance,
		// and it is the same vocabulary VS Code's own long-running tasks use.
		//
		// Precedence is deliberate: broken outranks busy. A run that is producing
		// failures should keep saying so while it runs, rather than downgrading
		// itself to "working on it".
		item.backgroundColor =
			failing > 0
				? new vscode.ThemeColor('statusBarItem.errorBackground')
				: spinning
					? new vscode.ThemeColor('statusBarItem.warningBackground')
					: undefined;
		// When a background is set VS Code supplies the matching foreground, so
		// an explicit colour there would fight it. Only the resting state gets
		// the Vinv red.
		item.color = failing > 0 || spinning ? undefined : new vscode.ThemeColor('charts.red');
		tooltip.appendMarkdown(
			'$(circuit-board) Click to open the **Graph Explorer**\n\n' +
				'[Ask Vinv](command:vinv-vs.askVinv) · ' +
				'[What should I do next?](command:vinv-vs.nextStep)',
		);
		item.text = text;
		item.tooltip = tooltip;
		item.show();
	};

	update();
	const timer = setInterval(update, REFRESH_MS);
	context.subscriptions.push(
		{ dispose: () => clearInterval(timer) },
		// A 15s poll is fine for epoch and failing counts, which change slowly.
		// It is not fine for the running indicator: a service that stops would
		// keep spinning for up to fifteen seconds, which is precisely the kind
		// of stale "still working" signal that teaches people to ignore it.
		onServiceExit(() => update()),
		// Same reason: the 15s poll is far too slow to track a pass that starts
		// and finishes between ticks.
		onExerciseStateChange(() => update()),
		// Refresh promptly when the window regains focus (an agent or terminal
		// may have reindexed while the user was away).
		vscode.window.onDidChangeWindowState((s) => {
			if (s.focused) {
				update();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(update),
	);
}
