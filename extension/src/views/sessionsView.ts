import * as vscode from 'vscode';
import {
	hasCaptures,
	entryPointLabel,
	loadEntryPoints,
	getTraceSummary,
	type EntryPoint,
} from '../identification/identification';
import { buildFilteredTrace } from '../identification/traceFilter';
import { onDiscoveryStateChange } from '../index/discovery';
import { bucketCount, installAgeDays, installAgeHours, track } from '../telemetry';

/**
 * A trace time filter chosen from the Sessions view. `windowMs` is a sliding
 * window ending "now" (ES-style "last N"); undefined means all time.
 */
export interface SessionTimeRange {
	label: string;
	windowMs: number;
}

/** How often the live trace-hit counts are refreshed while the view is visible. */
const TRACE_POLL_MS = 1000;

/**
 * Lists the workspace's entry points in the Sessions view once a session has been
 * captured. The gate is <workspace>/.vinv/captures: bringup/service runs write
 * tracelens output there, so its presence means there is a session to inspect.
 *
 * The list comes from `identification consolidate` (every entry point the service
 * defines, from source via the code index). On top of that, while the view is
 * visible, `identification tracesummary` is polled every second to get each HTTP
 * endpoint's live trace-hit count; the rows are sorted by that count (busiest
 * first) and the count is shown on each row. Polling is visibility-gated (see
 * setVisible) so it stops when the view is hidden.
 */
export class SessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private loadPromise: Promise<EntryPoint[]> | undefined;
	/** Live trace-hit counts keyed by entry-point id (from tracesummary). */
	private counts = new Map<string, number>();
	/** True once a tracesummary poll has returned, so counts are meaningful. */
	private haveCounts = false;
	/**
	 * In-window guard so the once-per-install globalState read below does not run
	 * on every one-second poll. The durable "already reported" record is the
	 * globalState key, not this — see reportFirstTrace.
	 */
	private firstTraceChecked = false;
	private pollTimer: NodeJS.Timeout | undefined;
	private polling = false;
	private visible = false;
	/** Active trace time filter; undefined = all time (default). */
	private timeRange: SessionTimeRange | undefined;
	/** The view, so the active filter can be surfaced as its message banner. */
	private view: vscode.TreeView<vscode.TreeItem> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		context.subscriptions.push(
			// Captures appear after a discovery (which also builds the index the
			// consolidate command reads) and after a service run finishes — refresh on
			// either so the entry points show up without a manual reload.
			onDiscoveryStateChange(() => this.refresh()),
			vscode.debug.onDidTerminateDebugSession(() => this.refresh()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
			{ dispose: () => this.stopPolling() },
		);
	}

	/** Drops the cached consolidate result so the next render re-runs it. */
	refresh(): void {
		this.loadPromise = undefined;
		this._onDidChangeTreeData.fire();
	}

	/** Lets the provider surface the active time filter as the view's message. */
	attachView(view: vscode.TreeView<vscode.TreeItem>): void {
		this.view = view;
		this.updateMessage();
	}

	getTimeRange(): SessionTimeRange | undefined {
		return this.timeRange;
	}

	/**
	 * Sets (or clears, with undefined) the trace time filter. Re-polls immediately
	 * so the hit counts reflect the new window without waiting for the next tick.
	 */
	setTimeRange(range: SessionTimeRange | undefined): void {
		this.timeRange = range;
		this.updateMessage();
		void this.pollOnce();
	}

	private updateMessage(): void {
		if (this.view) {
			this.view.message = this.timeRange ? `Traces: ${this.timeRange.label}` : undefined;
		}
	}

	/**
	 * Starts/stops the tracesummary poll loop with the view's visibility. Wired to
	 * the TreeView's onDidChangeVisibility so we don't spawn a process every second
	 * for a view the user isn't looking at.
	 */
	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) {
			this.startPolling();
		} else {
			this.stopPolling();
		}
	}

	private startPolling(): void {
		if (this.pollTimer) {
			return;
		}
		void this.pollOnce();
		this.pollTimer = setInterval(() => void this.pollOnce(), TRACE_POLL_MS);
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	/**
	 * One tracesummary pass: refresh the per-endpoint hit counts and re-render if
	 * anything changed. Skips when the view is hidden, there's no workspace, or no
	 * capture exists yet. Overlapping polls are coalesced (one in flight at a time);
	 * errors (no trace yet, or an older binary without tracesummary) leave the last
	 * counts untouched and are swallowed so the loop keeps trying.
	 */
	private async pollOnce(): Promise<void> {
		if (this.polling || !this.visible) {
			return;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root || !hasCaptures(root)) {
			return;
		}
		this.polling = true;
		try {
			// With a time filter active, hand the binary a window-filtered trace so
			// the hit counts cover only the selected range; otherwise count the full
			// capture. buildFilteredTrace is cached, so this stays ~instant per poll.
			let traceFile: string | undefined;
			if (this.timeRange) {
				const nowSec = Date.now() / 1000;
				traceFile = buildFilteredTrace(root, {
					fromSec: nowSec - this.timeRange.windowMs / 1000,
					toSec: nowSec,
				});
			}
			const summary = await getTraceSummary(this.context, root, traceFile);
			const next = new Map<string, number>();
			for (const e of summary.endpoints ?? []) {
				next.set(e.id, e.trace_count);
			}
			// Funnel milestone — the "aha" moment: the first time this install ever
			// observes a real trace hit. Once per install (globalState-stamped).
			if (!this.firstTraceChecked && [...next.values()].some((n) => n > 0)) {
				this.firstTraceChecked = true;
				this.reportFirstTrace();
			}
			if (this.countsChanged(next)) {
				this.counts = next;
				this.haveCounts = true;
				this._onDidChangeTreeData.fire();
			} else if (!this.haveCounts) {
				this.haveCounts = true;
			}
		} catch {
			// No trace yet, or a binary without tracesummary — keep the last counts.
		} finally {
			this.polling = false;
		}
	}

	/**
	 * The activation milestone that matters most: this install has just seen a
	 * real request flow through a real service under tracing. Everything before
	 * it is setup; everything after it is the product working.
	 *
	 * Stamped in globalState rather than held in memory, because the poll that
	 * detects it runs in every open window — an in-memory flag would report the
	 * same milestone once per window instead of once per install.
	 */
	private reportFirstTrace(): void {
		const KEY = 'vinv.telemetry.firstTrace';
		if (this.context.globalState.get<boolean>(KEY)) {
			return;
		}
		void this.context.globalState.update(KEY, true);
		track('milestone_first_trace', {
			days_since_install: bucketCount(installAgeDays()),
			hours_since_first_activation: bucketCount(installAgeHours()),
		});
	}

	private countsChanged(next: Map<string, number>): boolean {
		if (next.size !== this.counts.size) {
			return true;
		}
		for (const [id, n] of next) {
			if (this.counts.get(id) !== n) {
				return true;
			}
		}
		return false;
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
		if (element) {
			return [];
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return [];
		}
		// No captured session yet → leave the view empty so its welcome shows.
		if (!hasCaptures(root)) {
			return [];
		}
		if (!this.loadPromise) {
			this.loadPromise = loadEntryPoints(this.context, root);
		}
		try {
			const entrypoints = await this.loadPromise;
			// Sort busiest-first by live trace count (entries without a count — non-HTTP
			// kinds, or not-yet-hit — sort after, keeping consolidate's original order).
			const ordered = entrypoints
				.map((ep, idx) => ({ ep, idx }))
				.sort((a, b) => {
					const ca = this.counts.get(a.ep.id) ?? -1;
					const cb = this.counts.get(b.ep.id) ?? -1;
					return cb - ca || a.idx - b.idx;
				});
			return ordered.map(
				({ ep }) => new SessionItem(ep, this.haveCounts ? this.counts.get(ep.id) : undefined),
			);
		} catch (e) {
			return [errorItem(e instanceof Error ? e.message : String(e))];
		}
	}
}

/** A non-clickable row that surfaces a consolidate failure in the tree. */
function errorItem(message: string): vscode.TreeItem {
	const item = new vscode.TreeItem('Could not list entry points');
	item.iconPath = new vscode.ThemeIcon('warning');
	item.tooltip = message;
	item.description = message;
	item.contextValue = 'vinv.entrypoint.error';
	return item;
}

/** Codicon id for an entry-point kind, falling back to a generic event icon. */
function iconForKind(kind: string): string {
	switch (kind) {
		case 'http_api':
			return 'globe';
		case 'cli_command':
			return 'terminal';
		case 'background_task':
			return 'server-process';
		case 'scheduled_job':
			return 'clock';
		case 'event_hook':
			return 'pulse';
		case 'script_main':
			return 'file-code';
		default:
			return 'symbol-event';
	}
}

/**
 * One entry-point row. The label is the trigger (e.g. "GET /health" or a command
 * name); the description shows the live trace-hit count (when known) and the
 * resolving handler. Clicking opens the call-tree (DAG) view rooted at this entry
 * point's handler.
 */
export class SessionItem extends vscode.TreeItem {
	constructor(entry: EntryPoint, traceCount?: number) {
		super(entryPointLabel(entry), vscode.TreeItemCollapsibleState.None);
		// Slugged entry-point ids can collide (e.g. two routes normalising to the
		// same id); qualify with kind/file/line so each tree row stays unique.
		this.id = `${entry.kind}:${entry.id}:${entry.file}:${entry.line}`;
		this.iconPath = new vscode.ThemeIcon(iconForKind(entry.kind));
		// Show just the live trace-hit count as the row's trailing text once it's
		// known; the handler lives in the tooltip. (Tree rows are plain text — VS
		// Code can't render a real round pill here.)
		const handler = entry.handler ?? entry.framework;
		this.description = traceCount === undefined ? handler : String(traceCount);
		this.contextValue = 'vinv.entrypoint';
		this.tooltip = [
			entryPointLabel(entry),
			traceCount !== undefined ? `trace hits: ${traceCount}` : undefined,
			entry.handler ? `handler: ${entry.handler}` : undefined,
			`${entry.file}:${entry.line}`,
			`${entry.framework} · ${entry.kind}`,
		]
			.filter(Boolean)
			.join('\n');

		// Open the call-tree view on click — the entry-point id roots the graph.
		this.command = {
			command: 'vinv-vs.openCallTree',
			title: 'Open Call Tree',
			arguments: [{ apiId: entry.id, label: entryPointLabel(entry) }],
		};
	}
}
