/**
 * Vinv Graph Explorer: an interactive knowledge-graph view of the code index.
 *
 * Renders <workspace>/.vinv/index (chunks + edges + PageRank + epochs) as a
 * force-directed canvas graph — file-level by default (collapse-for-scale),
 * expandable to symbols — with deterministic architectural-layer coloring, a
 * runtime overlay joined from tracemaps (executed / latency / errors), a
 * diff-impact mode driven by content epochs, a dependency-ordered guided tour,
 * and local fuzzy + semantic search.
 *
 * Like the call-tree view, it is a file-backed custom editor bound to
 * .vinv/reports/graph.json so its tab can be dragged/@-referenced into chat.
 * All layout runs inside the webview (self-contained JS, no CDN — the CSP
 * allows nothing external).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getGraphHtml } from './graphExplorerHtml';
import { buildGraphSnapshot, hasIndexStore, type GraphSnapshot } from '../graph/indexGraph';
import { runIndexQuery, hitsToRows } from '../qna/answer';
import { loadEntryPoints } from '../identification/identification';
import { endpointsForRows } from '../identification/endpointsForRow';

/** The custom-editor view type; must match `contributes.customEditors`. */
export const GRAPH_VIEW_TYPE = 'vinv.graphExplorer';

/** Messages the graph webview sends back to the extension. */
interface OutboundMessage {
	type:
		| 'openSource'
		| 'semanticSearch'
		| 'ask'
		| 'harness'
		| 'refresh'
		| 'trace'
		| 'trajectory';
	file?: string;
	line?: number;
	query?: string;
	row?: number;
	issue?: string;
}

function backingFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'graph.json');
}

function workspaceRootFromBacking(fsPath: string): string {
	return path.resolve(path.dirname(fsPath), '..', '..');
}

/**
 * Opens the call-tree / flamegraph view for the endpoint(s) that reach a clicked
 * graph node. A symbol node passes its `row`; a file node passes its `file` (we
 * union the endpoints across the file's symbols). Behaviour:
 *   • exactly one endpoint reaches the node → open it directly, no prompt;
 *   • several → a QuickPick filtered to just those, closest handler first;
 *   • none resolved → fall back to the full workspace entry-point picker.
 */
async function openTraceForNode(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	row: number | undefined,
	file: string | undefined,
): Promise<void> {
	const openFullPicker = () => vscode.commands.executeCommand('vinv-vs.openCallTree');
	let snapshot: GraphSnapshot;
	let entries;
	try {
		snapshot = buildGraphSnapshot(workspaceRoot);
		entries = await loadEntryPoints(context, workspaceRoot);
	} catch {
		// Resolution is a convenience; on any failure keep the existing behaviour.
		await openFullPicker();
		return;
	}

	// Target rows: the clicked symbol, or every symbol in the clicked file.
	let targetRows: number[] = [];
	if (typeof row === 'number') {
		targetRows = [row];
	} else if (file) {
		targetRows = snapshot.files.find((f) => f.file === file)?.rows ?? [];
	}

	const reaching = endpointsForRows(entries, snapshot, targetRows);
	if (reaching.length === 0) {
		await openFullPicker();
		return;
	}
	if (reaching.length === 1) {
		const e = reaching[0].entry;
		await vscode.commands.executeCommand('vinv-vs.openCallTree', {
			apiId: e.id,
			label: e.trigger || e.id,
		});
		return;
	}

	const picked = await vscode.window.showQuickPick(
		reaching.map(({ entry, depth }) => ({
			label: entry.trigger || entry.id,
			description: entry.handler ? `${entry.handler}()` : entry.kind,
			detail: `${entry.file}:${entry.line} · ${depth === 0 ? 'in this file' : 'calls this file'}`,
			id: entry.id,
		})),
		{ placeHolder: 'Multiple endpoints reach this node — pick one to trace' },
	);
	if (!picked) {
		return;
	}
	await vscode.commands.executeCommand('vinv-vs.openCallTree', {
		apiId: picked.id,
		label: picked.label,
	});
}

/** Builds the snapshot, writes the referenceable backing file, and opens the view. */
export async function openGraphExplorer(
	_context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<void> {
	if (!hasIndexStore(workspaceRoot)) {
		void vscode.window.showInformationMessage(
			'Vinv: No code index yet — run Discover Project first, then open the graph.',
		);
		return;
	}
	const backing = backingFilePath(workspaceRoot);
	try {
		fs.mkdirSync(path.dirname(backing), { recursive: true });
		fs.writeFileSync(backing, JSON.stringify(buildGraphSnapshot(workspaceRoot)), 'utf8');
	} catch (e) {
		void vscode.window.showErrorMessage(
			`Vinv: Could not build the graph snapshot: ${e instanceof Error ? e.message : String(e)}`,
		);
		return;
	}
	await vscode.commands.executeCommand(
		'vscode.openWith',
		vscode.Uri.file(backing),
		GRAPH_VIEW_TYPE,
		vscode.ViewColumn.Active,
	);
}

/** File-backed custom editor rendering the interactive graph. */
export class GraphExplorerEditorProvider implements vscode.CustomReadonlyEditorProvider {
	public constructor(private readonly context: vscode.ExtensionContext) {}

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			GRAPH_VIEW_TYPE,
			new GraphExplorerEditorProvider(context),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): void {
		const workspaceRoot = workspaceRootFromBacking(document.uri.fsPath);
		const webview = webviewPanel.webview;
		webview.options = { enableScripts: true };
		webview.html = getGraphHtml();

		const postSnapshot = (snapshot: GraphSnapshot): void => {
			void webview.postMessage({ type: 'snapshot', snapshot });
		};

		const rebuild = (): void => {
			try {
				const snapshot = buildGraphSnapshot(workspaceRoot);
				fs.mkdirSync(path.dirname(document.uri.fsPath), { recursive: true });
				fs.writeFileSync(document.uri.fsPath, JSON.stringify(snapshot), 'utf8');
				postSnapshot(snapshot);
			} catch (e) {
				void webview.postMessage({
					type: 'error',
					message: e instanceof Error ? e.message : String(e),
				});
			}
		};

		// The view ALWAYS rebuilds from the store on open — the backing file is
		// a referenceable artifact, not a cache. Serving it stale meant reopened
		// tabs showed an old epoch with no runtime while the store had moved on.
		// While open, changes to the index store or new trace captures refresh
		// the snapshot live (debounced — reindex touches many files at once).
		let refreshTimer: NodeJS.Timeout | undefined;
		const scheduleRefresh = (): void => {
			if (refreshTimer) {
				clearTimeout(refreshTimer);
			}
			refreshTimer = setTimeout(() => rebuild(), 1500);
		};
		const storeWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, '.vinv/index/meta.json'),
		);
		const captureWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, '.vinv/captures/**/trace.jsonl'),
		);
		for (const w of [storeWatcher, captureWatcher]) {
			w.onDidChange(scheduleRefresh);
			w.onDidCreate(scheduleRefresh);
		}

		const msgSub = webview.onDidReceiveMessage(async (msg: OutboundMessage) => {
			const raw = msg as { type?: string; message?: unknown; stack?: unknown };
			if (raw.type === 'webviewError') {
				return;
			}
			switch (msg.type) {
				case 'openSource': {
					if (!msg.file) {
						return;
					}
					const abs = path.isAbsolute(msg.file) ? msg.file : path.join(workspaceRoot, msg.file);
					const pos = new vscode.Position(Math.max(0, (msg.line ?? 1) - 1), 0);
					await vscode.window.showTextDocument(vscode.Uri.file(abs), {
						selection: new vscode.Range(pos, pos),
						preview: true,
						viewColumn: vscode.ViewColumn.Beside,
					});
					return;
				}
				case 'refresh':
					rebuild();
					return;
				case 'semanticSearch': {
					if (!msg.query) {
						return;
					}
					try {
						const snapshot = buildGraphSnapshot(workspaceRoot);
						const hits = await runIndexQuery(this.context, workspaceRoot, msg.query, 8);
						void webview.postMessage({
							type: 'searchResults',
							rows: hitsToRows(snapshot, hits),
							hits: hits.map((h) => ({
								file: h.file,
								name: h.name,
								line: h.lines?.[0] ?? 1,
								score: h.score,
								summary: h.summary,
							})),
						});
					} catch (e) {
						void webview.postMessage({
							type: 'searchResults',
							rows: [],
							hits: [],
							error: e instanceof Error ? e.message : String(e),
						});
					}
					return;
				}
				case 'ask':
					await vscode.commands.executeCommand('vinv-vs.askVinv', {
						seedRow: msg.row,
					});
					return;
				case 'harness':
					await vscode.commands.executeCommand('vinv-vs.fixWithHarness', {
						row: msg.row,
						issue: msg.issue,
					});
					return;
				case 'trace':
					// Infer which endpoint(s) reach the clicked node and open the
					// call-tree view (with its latency/memory flamegraph) directly;
					// only prompt when the node is ambiguous or unresolved.
					await openTraceForNode(this.context, workspaceRoot, msg.row, msg.file);
					return;
				case 'trajectory':
					await vscode.commands.executeCommand('vinv-vs.showTrajectory');
					return;
			}
		});

		rebuild();
		webviewPanel.onDidDispose(() => {
			msgSub.dispose();
			storeWatcher.dispose();
			captureWatcher.dispose();
			if (refreshTimer) {
				clearTimeout(refreshTimer);
			}
		});
	}
}
