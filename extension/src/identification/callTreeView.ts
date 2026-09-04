import * as vscode from 'vscode';
import { reportWebviewError, trackUi } from '../telemetry/instrument';
import * as path from 'path';
import * as fs from 'fs';
import {
	getCallTree,
	getTraceMap,
	readEntryPoints,
	symbolRootFor,
	type CallNode,
	type TraceMapResult,
} from './identification';
import { captureServiceFor } from '../bringup/bringup';
import { VINV_BASE_CSS, VINV_FONT_MONO } from '../views/webviewTheme';
import { getTraceMemory, memoryForNode, type TraceMemory } from './traceMemory';
import { generateSmokeReport } from '../tracelens/report';
import { openSmokeReport } from './smokeReportView';
import { offerEpisodeForRuntimeErrors } from '../harness/autoTrigger';
import { backingFilePath, buildCallSiteContext } from './callSiteContext';
import { openPathInEditor } from '../support/openDocument';

/** How often the runtime trace overlay is refreshed while the panel is open. */
const TRACEMAP_POLL_MS = 1000;

/**
 * The Windows tracelens binary is built without networkx (Nuitka excludes it),
 * so `report` always fails there — hide the Smoke Report button entirely.
 */
const SMOKE_REPORT_SUPPORTED = process.platform !== 'win32';

/** The custom-editor view type; must match the `contributes.customEditors` id. */
export const CALLTREE_VIEW_TYPE = 'vinv.callTree';

/** Messages the call-tree webview sends back to the extension. */
export interface OutboundMessage {
	type: 'openSource' | 'runSmokeReport' | 'ask';
	file?: string;
	line?: number;
	/** Symbol name — sent with 'ask' so the node can be located in the tree. */
	name?: string;
}

/**
 * Side effects a call-tree message can trigger, injected so the routing is
 * testable without a live webview. Production binds these to the real closures
 * in `openCallTree`; tests pass fakes and assert the exact call.
 */
export interface CallTreeActions {
	openSource: (file: string | undefined, line?: number) => Promise<void>;
	ask: (file?: string, name?: string) => Promise<void>;
	runSmokeReport: () => Promise<void>;
	smokeReportSupported: boolean;
}

/**
 * Routes one call-tree webview message to its side effect. Extracted from the
 * inline onDidReceiveMessage closure so the wiring is unit-tested directly.
 * openSource resolves to absolute, verifies existence, and reports an actionable
 * error on failure (via the injected opener) rather than a silent no-op.
 */
export async function handleCallTreeMessage(
	msg: OutboundMessage,
	actions: CallTreeActions,
): Promise<void> {
	if (msg.type === 'openSource') {
		await actions.openSource(msg.file, msg.line);
	} else if (msg.type === 'ask') {
		await actions.ask(msg.file, msg.name);
	} else if (msg.type === 'runSmokeReport' && actions.smokeReportSupported) {
		await actions.runSmokeReport();
	}
}

/** Recovers the workspace root from a backing file at <root>/.vinv/reports/<f>. */
function workspaceRootFromBacking(fsPath: string): string {
	return path.resolve(path.dirname(fsPath), '..', '..');
}

/**
 * Opens the call-tree (DAG) view for one entry point via its file-backed custom
 * editor. We ensure the backing file exists, then open it with `vscode.openWith`
 * so the resulting tab is bound to that file's URI (draggable/referenceable). The
 * editor (see CallTreeEditorProvider) renders it and keeps the file fresh.
 *
 * The view renders the static call tree first (fast, code-only via `identification
 * calltree`), then overlays the runtime trace by polling `identification tracemap`
 * every second — each node marked executed (✓, count, duration, errors) or not (✗),
 * with live coverage. Internal nodes open their source on click.
 */
export async function openCallTree(
	_context: vscode.ExtensionContext,
	workspaceRoot: string,
	apiId: string,
	label: string,
): Promise<void> {
	const backing = backingFilePath(workspaceRoot, apiId);
	try {
		fs.mkdirSync(path.dirname(backing), { recursive: true });
		if (!fs.existsSync(backing)) {
			fs.writeFileSync(backing, JSON.stringify({ apiId, label, pending: true }, null, 2), 'utf8');
		}
	} catch {
		// Non-fatal: a real failure surfaces when the editor tries to read it.
	}
	await vscode.commands.executeCommand(
		'vscode.openWith',
		vscode.Uri.file(backing),
		CALLTREE_VIEW_TYPE,
		vscode.ViewColumn.Active,
	);
}

/**
 * File-backed custom editor for call-tree views. Reads the endpoint's id/label
 * from the backing JSON, then wires the live render (static tree + tracemap poll)
 * into the webview. Being a custom editor (not a bare panel) means its tab carries
 * the file URI, so it can be dragged into Cursor's chat like any other file.
 */
export class CallTreeEditorProvider implements vscode.CustomReadonlyEditorProvider {
	public constructor(private readonly context: vscode.ExtensionContext) {}

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			CALLTREE_VIEW_TYPE,
			new CallTreeEditorProvider(context),
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
		const fsPath = document.uri.fsPath;
		const workspaceRoot = workspaceRootFromBacking(fsPath);
		let apiId = '';
		let label = '';
		try {
			const j = JSON.parse(fs.readFileSync(fsPath, 'utf8')) as {
				apiId?: string;
				label?: string;
				entrypoint?: { id?: string };
			};
			apiId = j.apiId ?? j.entrypoint?.id ?? '';
			label = j.label ?? apiId;
		} catch {
			// fall through to the empty-id guard below
		}
		if (!apiId) {
			webviewPanel.webview.options = { enableScripts: false };
			webviewPanel.webview.html = '<p>Could not read call-tree backing file.</p>';
			return;
		}
		const wiring = wireCallTree(this.context, workspaceRoot, apiId, label, webviewPanel.webview);
		webviewPanel.onDidDispose(() => wiring.dispose());
	}
}

/**
 * Drives one call-tree webview: renders the static tree, then polls tracemap every
 * second, posting each result to the webview and writing it back to the backing
 * file so the referenceable snapshot stays current. Handles source-open and
 * run-smoke-report messages. Returns a disposable that stops the polling.
 */
function wireCallTree(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	apiId: string,
	label: string,
	webview: vscode.Webview,
): vscode.Disposable {
	webview.options = { enableScripts: true };
	webview.html = getHtml(label);

	const backing = backingFilePath(workspaceRoot, apiId);
	const writeSnapshot = (result: object): void => {
		try {
			fs.mkdirSync(path.dirname(backing), { recursive: true });
			fs.writeFileSync(backing, JSON.stringify({ apiId, label, ...result }, null, 2), 'utf8');
		} catch {
			// Non-fatal: the view still renders; only the referenceable file lags.
		}
	};

	let disposed = false;
	let polling = false;

	const actions: CallTreeActions = {
		openSource: async (file, line) => {
			await openPathInEditor(file, {
				workspaceRoot,
				line: line ?? 1,
				label: 'source file',
				preview: true,
				viewColumn: vscode.ViewColumn.Beside,
			});
		},
		ask: async (file, name) => {
			// Resolve the clicked node against the snapshot this view just wrote,
			// so the question carries the entry-point→symbol path and its
			// endpoint-scoped runtime — not just "some symbol". Resolution is
			// best-effort: an unresolvable node still opens the panel, unseeded.
			let callSite;
			try {
				callSite = buildCallSiteContext(workspaceRoot, apiId, { file, name });
			} catch {
				// Node unresolved — open Ask Vinv unseeded rather than dropping the click.
			}
			await vscode.commands.executeCommand('vinv-vs.askVinv', { callSite });
		},
		runSmokeReport: async () => runSmokeReport(context, workspaceRoot, apiId, label),
		smokeReportSupported: SMOKE_REPORT_SUPPORTED,
	};
	const msgSub = webview.onDidReceiveMessage((msg: OutboundMessage) => {
		const raw = msg as { type?: string; message?: unknown; stack?: unknown };
		if (raw.type === 'webviewError') {
			reportWebviewError('calltree', raw);
			return;
		}
		trackUi('calltree', raw.type ?? 'unknown');
		return handleCallTreeMessage(msg, actions);
	});

	// The unit's root: a declared entry point is named by its id, a function the
	// exerciser drove directly by its symbol. Resolved once — apis.json does not
	// change while a tab is open, and both the static tree and every overlay poll
	// must agree about what they are rooted at.
	const symbol = symbolRootFor(workspaceRoot, apiId);

	// The capture is chosen by the service that DEFINES this unit. Omitting it
	// made the engine fall back to "the freshest trace.jsonl anywhere", and since
	// the poll below rewrites .vinv/reports/calltree-<id>.json — the same snapshot
	// the insight pass writes — merely opening the tab replaced a correct overlay
	// with one read off whichever service happened to trace last. On a repo with
	// four traced services that showed every node "not run" at 0% coverage, with
	// `status: ok` and nothing naming the mismatch. Resolved once: services.json
	// does not change while a tab is open.
	let captureService = captureServiceFor(
		workspaceRoot,
		readEntryPoints(workspaceRoot).find((e) => e.id === apiId)?.file,
	);

	// 1) Static call tree first — fast, no trace needed.
	void (async () => {
		try {
			const tree = await getCallTree(context, workspaceRoot, apiId, symbol);
			// An undeclared unit has no inventory row to join on, so its owning
			// service can only be learned from the tree the engine just resolved.
			if (!captureService) {
				captureService = captureServiceFor(workspaceRoot, tree.entrypoint?.file);
			}
			if (!disposed) {
				void webview.postMessage({ type: 'tree', result: tree });
				writeSnapshot(tree);
			}
		} catch (e) {
			if (!disposed) {
				void webview.postMessage({
					type: 'error',
					message: e instanceof Error ? e.message : String(e),
				});
			}
		}
	})();

	// 2) Runtime overlay — poll tracemap every second while the tab is open.
	const tick = async (): Promise<void> => {
		if (polling || disposed) {
			return;
		}
		polling = true;
		try {
			const map = await getTraceMap(context, workspaceRoot, apiId, captureService, symbol);
			// The binary's overlay has latency but not memory; attribute memory
			// from the raw trace and merge it onto each executed node.
			enrichWithMemory(map, getTraceMemory(workspaceRoot));
			if (!disposed) {
				void webview.postMessage({ type: 'tracemap', result: map });
				writeSnapshot(map);
			}
		} catch (e) {
			// No trace yet, or an older binary without tracemap — keep the static tree.
			if (!disposed) {
				void webview.postMessage({
					type: 'tracemapUnavailable',
					message: e instanceof Error ? e.message : String(e),
				});
			}
		} finally {
			polling = false;
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), TRACEMAP_POLL_MS);

	return {
		dispose(): void {
			disposed = true;
			clearInterval(timer);
			msgSub.dispose();
		},
	};
}

/**
 * Overlays per-function memory onto a tracemap tree in place. For every node the
 * binary marked executed, looks up the memory attributed to that function in the
 * raw trace and sets `runtime.mem_bytes`. No-op when the capture has no memory
 * attribution (memory is undefined) so the view simply omits the memory axis.
 */
function enrichWithMemory(map: TraceMapResult, memory: TraceMemory | undefined): void {
	if (!memory) {
		return;
	}
	const visit = (node: CallNode): void => {
		const rt = node.runtime;
		if (rt && rt.executed) {
			const fact = memoryForNode(memory, node.name, node.file);
			if (fact) {
				rt.mem_bytes = Math.round(fact.memBytes);
			}
		}
		for (const child of node.children ?? []) {
			visit(child);
		}
	};
	if (map.tree) {
		visit(map.tree);
	}
}

/**
 * Builds the tracelens Smoke Report for the current endpoint and opens it as a
 * rendered dashboard. Runs under a progress notification since `report` executes
 * the offline analysis stages; surfaces any failure (no trace, missing binary)
 * as an error toast rather than silently doing nothing.
 */
async function runSmokeReport(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	apiId: string,
	label: string,
): Promise<void> {
	try {
		const report = await vscode.window.withProgress(
			{
				// Status bar, not a toast. A notification-location progress with
				// `cancellable: false` renders NO close button, so the user cannot
				// dismiss or minimize it — it simply occupies the corner until the
				// engine finishes. `generateSmokeReport` takes no cancellation token,
				// so `cancellable: true` would only add a Cancel that does nothing.
				// The status bar is dismissed by nature and the finished report opens
				// itself, which is the actual signal the user is waiting for.
				location: vscode.ProgressLocation.Window,
				title: `Generating Smoke Report for ${label}…`,
			},
			() => generateSmokeReport(context, workspaceRoot, apiId),
		);
		await openSmokeReport(vscode.Uri.file(report.path));
		// Error clusters in the trace offer (or auto-start) a harness fix episode.
		void offerEpisodeForRuntimeErrors(context, workspaceRoot);
	} catch (e) {
		void vscode.window.showErrorMessage(
			`Smoke Report failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

function getHtml(label: string): string {
	const safeLabel = label
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Call Tree</title>
	<style>
		${VINV_BASE_CSS}
		body { padding: 18px 20px; font-size: 12.5px; }
		header {
			margin-bottom: 16px; padding-bottom: 14px;
			display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
			border-bottom: 1px solid var(--line);
		}
		.head-left { min-width: 0; }
		h1 {
			font-family: ${VINV_FONT_MONO}; font-weight: 400;
			font-size: 24px; line-height: 1.1; letter-spacing: -0.01em; margin: 0 0 6px;
		}
		.meta { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		.stats { margin-top: 8px; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
		.stat { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		.stat b { color: var(--ink); font-weight: 600; }
		.cov {
			display: inline-flex; align-items: center; gap: 8px;
			font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted);
		}
		.cov .bar {
			width: 90px; height: 6px; border-radius: 0;
			background: var(--bg-2); border: 1px solid var(--line-strong);
			overflow: hidden; box-sizing: border-box;
		}
		.cov .bar span { display: block; height: 100%; background: var(--ink); }
		.note { margin-top: 8px; font-size: 11px; color: var(--muted); }
		.live { color: var(--accent-fg); }
		#status { color: var(--muted); padding: 8px 0; font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase; }
		#status::before { content: '// '; color: var(--accent-fg); }
		.error, #status.error { color: var(--accent-fg); white-space: pre-wrap; text-transform: none; letter-spacing: normal; font-size: 12px; }
		#status.error::before { content: none; }

		ul.tree { list-style: none; margin: 0; padding: 0; }
		ul.tree ul { list-style: none; margin: 0; padding-left: 18px; border-left: 1px dashed var(--line-strong); margin-left: 8px; }
		li { padding: 1px 0; }
		.node {
			display: inline-flex; align-items: center; gap: 6px;
			padding: 2px 6px; border-radius: 0; max-width: 100%;
		}
		.node.clickable { cursor: pointer; }
		.node.clickable:hover { background: var(--bg-2); box-shadow: inset 2px 0 0 var(--accent-fg); }
		/* A not-run row is de-emphasised by HUE, never by opacity. A blanket
		   opacity multiplies every child toward the background regardless of
		   theme: at 0.45 the path, the "not run" tag and the badges measured
		   1.6:1 (dark) / 1.8:1 (light) — effectively invisible — and the function
		   name 4.4:1 / 3.2:1. The palette's muted tier already encodes "secondary"
		   at a ratio that holds in both themes, so use it and leave the row's
		   detail text at the same contrast it has everywhere else. */
		.node.notrun .name .fn { color: var(--muted); }
		.caret {
			cursor: pointer; width: 14px; display: inline-block; text-align: center;
			color: var(--muted-2); user-select: none; flex: none;
		}
		.caret.empty { visibility: hidden; }
		.name { font-family: inherit; }
		.name .fn { color: var(--ink); }
		.loc { color: var(--muted-2); font-size: 10.5px; }
		.ext .name { color: var(--muted); font-style: italic; }
		.rt { font-size: 10.5px; flex: none; }
		.rt.ok { color: var(--muted); }
		.rt.no { color: var(--muted-2); }
		.rt.err { color: var(--accent-fg); }
		.badge {
			font-size: 9px; padding: 1px 6px; border-radius: 0;
			letter-spacing: 0.16em; text-transform: uppercase;
			border: 1px solid currentColor; color: var(--muted-2); flex: none;
		}
		/* Per-node "ask" affordance. Hidden until the row is hovered/focused so
		   the tree stays a tree; always visible once focused for keyboard use. */
		.ask {
			flex: none; opacity: 0; pointer-events: none;
			display: inline-flex; align-items: center; gap: 4px;
			padding: 0 6px; height: 17px; cursor: pointer;
			font-family: inherit; font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
			background: transparent; color: var(--muted);
			border: 1px solid var(--line-strong); border-radius: 0;
			transition: opacity 0.12s, color 0.15s, border-color 0.15s, background 0.15s;
		}
		.node:hover .ask, .ask:focus-visible { opacity: 1; pointer-events: auto; }
		.ask:hover { background: var(--accent); border-color: var(--accent); color: #ffffff; }
		.gap { margin-top: 24px; }
		.gap h2 {
			font-size: 10px; font-weight: 400; letter-spacing: 0.24em; text-transform: uppercase;
			color: var(--muted); margin: 0 0 10px; padding-top: 12px;
			border-top: 1px solid var(--ink); display: inline-block;
		}
		.gap h2::before { content: '// '; color: var(--accent-fg); }
		.gap ul { list-style: none; margin: 0; padding: 0; }
		.gap-hint { color: var(--muted-2); font-size: 10.5px; margin: -4px 0 8px; max-width: 640px; }
		.gap li { padding: 2px 0; font-size: 11.5px; color: var(--muted); }
		.collapsed > ul { display: none; }

		.head-actions { display: inline-flex; align-items: center; gap: 8px; flex: none; }
		.smoke-btn {
			display: inline-flex; align-items: center; gap: 6px; flex: none;
			height: 26px; padding: 0 11px; border-radius: 0; cursor: pointer;
			font-size: 9.5px; font-weight: 500; font-family: inherit;
			letter-spacing: 0.2em; text-transform: uppercase;
			background: var(--ink); color: var(--bg); border: 1px solid var(--ink);
			transition: background 0.2s, border-color 0.2s;
		}
		.smoke-btn:hover { background: var(--accent); border-color: var(--accent); color: #ffffff; }
		.smoke-btn svg { width: 13px; height: 13px; display: block; }
		.view-switch { display: inline-flex; gap: 4px; flex: none; }
		.view-switch button {
			display: inline-flex; align-items: center; justify-content: center;
			height: 26px; padding: 0 10px;
			background: transparent; border: 1px solid var(--line); border-radius: 0;
			color: var(--muted); cursor: pointer;
			font-size: 9.5px; font-family: inherit;
			letter-spacing: 0.18em; text-transform: uppercase; white-space: nowrap;
			transition: color 0.2s, border-color 0.2s, background 0.2s;
		}
		.view-switch button:hover { color: var(--ink); border-color: var(--ink); }
		.view-switch button.active {
			background: var(--ink); border-color: var(--ink); color: var(--bg);
		}

		.metric-switch {
			display: inline-flex; flex: none;
			border: 1px solid var(--line-strong); border-radius: 0; overflow: hidden;
		}
		.metric-switch button {
			background: transparent; color: var(--muted);
			border: none; padding: 3px 10px; cursor: pointer;
			font-size: 9.5px; font-family: inherit;
			letter-spacing: 0.18em; text-transform: uppercase;
		}
		.metric-switch button + button { border-left: 1px solid var(--line-strong); }
		.metric-switch button.active { background: var(--ink); color: var(--bg); }

		#flame { position: relative; margin-top: 6px; }
		.flame-frame {
			position: absolute; box-sizing: border-box; overflow: hidden;
			white-space: nowrap; text-overflow: ellipsis;
			font-size: 10.5px; line-height: 20px; padding: 0 5px;
			border: 1px solid var(--line-strong); border-radius: 0;
		}
		.flame-frame:hover { outline: 1px solid var(--accent-fg); outline-offset: -1px; }
		.flame-hint { color: var(--muted); font-size: 11px; padding: 8px 0; }
	</style>
</head>
<body>
	<header>
		<div class="head-left">
			<h1 id="title">${safeLabel}</h1>
			<div class="meta" id="root-meta"></div>
			<div class="stats" id="stats"></div>
			<div class="note" id="note"></div>
		</div>
		<div class="head-actions">
			${
				SMOKE_REPORT_SUPPORTED
					? `<button id="btn-smoke" class="smoke-btn" title="Generate a smoke report for this endpoint">
				<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.5 1a5.5 5.5 0 0 1 4.38 8.82l3.15 3.15a.75.75 0 0 1-1.06 1.06l-3.15-3.15A5.5 5.5 0 1 1 6.5 1Zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/></svg>
				<span>Smoke Report</span>
			</button>`
					: ''
			}
			<div class="metric-switch" id="metric-switch" style="display:none;">
				<button id="btn-metric-time" class="active">Time</button>
				<button id="btn-metric-mem">Memory</button>
			</div>
			<div class="view-switch">
				<button id="btn-external" title="Show external/library calls">Library Calls</button>
			</div>
			<div class="view-switch" id="view-toggle">
				<button id="btn-tree" class="active" title="Call tree">Tree</button>
				<button id="btn-flame" title="Flamegraph (by latency)">Flamegraph</button>
			</div>
		</div>
	</header>
	<div id="status">Building call tree…</div>
	<ul class="tree" id="tree"></ul>
	<div id="flame" style="display:none;"></div>
	<div class="gap" id="gap" style="display:none;">
		<h2 title="Functions the runtime trace caught that static analysis could not predict — usually dynamic calls like framework hooks, default factories, or callbacks. A short list here means the predicted graph is accurate.">Also ran (not in the predicted tree)</h2>
		<div class="gap-hint">Caught at runtime but invisible to static analysis — dynamic calls such as framework hooks, default factories, and callbacks. A short list = an accurate prediction.</div>
		<ul id="gap-list"></ul>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		window.addEventListener('error', function (e) { vscode.postMessage({ type: 'webviewError', message: String((e && e.message) || 'unknown'), stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : undefined }); });
		window.addEventListener('unhandledrejection', function (e) { vscode.postMessage({ type: 'webviewError', message: 'unhandledrejection: ' + String((e && e.reason) || ''), stack: e && e.reason && e.reason.stack ? String(e.reason.stack).slice(0, 2000) : undefined }); });

		// Remember the latest result so the Tree/Flamegraph toggle can re-render
		// without waiting for the next poll.
		let lastResult = null;
		let lastIsTraceMap = false;
		let viewMode = 'tree';
		// Which metric weights the flamegraph: 'time' (latency) or 'mem' (memory).
		let flameMetric = 'time';
		// Whether external/library calls (node.resolved === false) are shown.
		// Off by default — the tree/flamegraph focus on the project's own functions.
		let showExternal = false;

		function setView(mode) {
			if (viewMode === mode) { return; }
			viewMode = mode;
			document.getElementById('btn-tree').classList.toggle('active', mode === 'tree');
			document.getElementById('btn-flame').classList.toggle('active', mode === 'flame');
			// The metric switch only applies to the flamegraph.
			document.getElementById('metric-switch').style.display = mode === 'flame' ? 'inline-flex' : 'none';
			if (lastResult) { render(lastResult, lastIsTraceMap); }
		}
		document.getElementById('btn-tree').addEventListener('click', () => setView('tree'));
		document.getElementById('btn-flame').addEventListener('click', () => setView('flame'));

		function setMetric(metric) {
			if (flameMetric === metric) { return; }
			flameMetric = metric;
			document.getElementById('btn-metric-time').classList.toggle('active', metric === 'time');
			document.getElementById('btn-metric-mem').classList.toggle('active', metric === 'mem');
			document.getElementById('btn-flame').title = metric === 'mem' ? 'Flamegraph (by memory)' : 'Flamegraph (by latency)';
			if (lastResult) { render(lastResult, lastIsTraceMap); }
		}
		document.getElementById('btn-metric-time').addEventListener('click', () => setMetric('time'));
		document.getElementById('btn-metric-mem').addEventListener('click', () => setMetric('mem'));

		const btnSmoke = document.getElementById('btn-smoke');
		if (btnSmoke) {
			btnSmoke.addEventListener('click', () => {
				vscode.postMessage({ type: 'runSmokeReport' });
			});
		}

		const btnExternal = document.getElementById('btn-external');
		btnExternal.addEventListener('click', () => {
			showExternal = !showExternal;
			btnExternal.classList.toggle('active', showExternal);
			btnExternal.title = showExternal ? 'Hide external/library calls' : 'Show external/library calls';
			if (lastResult) { render(lastResult, lastIsTraceMap); }
		});

		function el(tag, cls, text) {
			const e = document.createElement(tag);
			if (cls) { e.className = cls; }
			if (text != null) { e.textContent = text; }
			return e;
		}

		// Build a <li> for a call node. When the node carries a runtime overlay
		// (from tracemap), annotate executed/not + call count, duration and errors.
		function isExternal(node) { return node && node.resolved === false; }

		function renderNode(node) {
			const li = document.createElement('li');
			const kids = (Array.isArray(node.children) ? node.children : [])
				.filter((c) => showExternal || !isExternal(c));

			const row = el('div', 'node');
			const caret = el('span', 'caret' + (kids.length ? '' : ' empty'), kids.length ? '▾' : '•');
			row.appendChild(caret);

			const external = node.resolved === false;
			if (external) { row.classList.add('ext'); }

			const rt = node.runtime;
			if (rt && !rt.executed) { row.classList.add('notrun'); }

			const name = el('span', 'name');
			name.appendChild(el('span', 'fn', (node.name || node.call || '?') + '()'));
			row.appendChild(name);

			if (!external && node.file != null) {
				row.appendChild(el('span', 'loc', node.file + ':' + node.line));
				row.classList.add('clickable');
				row.title = 'Open ' + node.file + ':' + node.line;
				row.addEventListener('click', (ev) => {
					if (ev.target === caret) { return; }
					vscode.postMessage({ type: 'openSource', file: node.file, line: node.line });
				});
			}

			// Runtime overlay tag.
			if (rt) {
				if (rt.executed) {
					const hasErr = rt.error > 0;
					const tag = el('span', 'rt ' + (hasErr ? 'err' : 'ok'));
					let txt = '✓ ×' + rt.calls + ' (' + rt.total_ms + 'ms)';
					// Wall time alone cannot tell "slow because it computes" from
					// "slow because it waits", and only the first is worth
					// optimizing here. Shown once waiting dominates the call.
					const blocked = typeof rt.blocked_ms === 'number' ? rt.blocked_ms : null;
					const mostlyWaiting = blocked !== null && rt.total_ms > 0 && blocked / rt.total_ms >= 0.5;
					if (mostlyWaiting) { txt += ' · ' + blocked + 'ms waiting'; }
					const mem = typeof rt.mem_bytes === 'number' ? rt.mem_bytes : rt.mem_delta_bytes;
					if (typeof mem === 'number') { txt += ' · ' + fmtBytes(mem); }
					if (hasErr) {
						txt += ' ⚠ ' + rt.error + ' err' + (rt.errors && rt.errors.length ? ' [' + rt.errors.join(', ') + ']' : '');
					}
					tag.textContent = txt;
					tag.title = 'This function executed ' + rt.calls + ' time(s) during the captured traffic, spending ' + rt.total_ms + 'ms total' +
						(blocked !== null ? ', of which ' + blocked + 'ms was spent waiting on I/O rather than computing' : '') +
						(hasErr ? '; ' + rt.error + ' call(s) raised an exception' : '');
					row.appendChild(tag);
				} else {
					const notRun = el('span', 'rt no', '✗ not run');
					notRun.title = 'The call graph predicts this function CAN be reached from this endpoint, but no captured request has executed it yet — exercise the endpoint (or add an input in the Journey view) to cover it.';
					row.appendChild(notRun);
				}
			}

			if (external) { row.appendChild(el('span', 'badge ext', 'external')); }
			if (node.ambiguous) { row.appendChild(el('span', 'badge', 'ambiguous×' + node.ambiguous)); }
			if (node.expanded_elsewhere) { row.appendChild(el('span', 'badge', 'shown above')); }
			if (node.truncated) { row.appendChild(el('span', 'badge', node.truncated)); }

			// Ask about THIS frame. Only for internal symbols: an external/library
			// leaf has no indexed source for the answer to reason about.
			if (!external && node.file != null) {
				const ask = el('button', 'ask', 'Ask');
				ask.type = 'button';
				ask.title = 'Ask Vinv about ' + (node.name || node.call || 'this') + '() as reached from this entry point';
				ask.addEventListener('click', (ev) => {
					// The row itself opens source on click; without this the ask
					// button would do both.
					ev.stopPropagation();
					vscode.postMessage({ type: 'ask', file: node.file, line: node.line, name: node.name });
				});
				row.appendChild(ask);
			}

			li.appendChild(row);

			if (kids.length) {
				const ul = el('ul');
				for (const child of kids) { ul.appendChild(renderNode(child)); }
				li.appendChild(ul);
				caret.addEventListener('click', () => {
					const collapsed = li.classList.toggle('collapsed');
					caret.textContent = collapsed ? '▸' : '▾';
				});
			}
			return li;
		}

		function mk(label, val) {
			const d = el('span', 'stat');
			d.appendChild(el('b', null, String(val)));
			d.appendChild(document.createTextNode(' ' + label));
			return d;
		}

		// The latency a node itself carries in the trace (0 if it never ran).
		function selfMs(node) {
			const rt = node && node.runtime;
			return rt && rt.executed && typeof rt.total_ms === 'number' ? rt.total_ms : 0;
		}

		// The memory a node itself carries (net bytes, clamped ≥0 so it can weight a
		// flamegraph; a net-free function contributes no width).
		function selfMem(node) {
			const rt = node && node.runtime;
			const b = rt && rt.executed && typeof rt.mem_bytes === 'number' ? rt.mem_bytes : 0;
			return b > 0 ? b : 0;
		}

		// Self weight of a node for the active flame metric (time vs memory).
		function selfMetric(node) {
			return flameMetric === 'mem' ? selfMem(node) : selfMs(node);
		}

		function fmtBytes(b) {
			const neg = b < 0 ? '-' : '';
			let v = Math.abs(b);
			const units = ['B', 'KB', 'MB', 'GB'];
			let i = 0;
			while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
			const s = i === 0 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString();
			return neg + s + ' ' + units[i];
		}

		// Format a value in the active flame metric's units.
		function fmtMetric(v) {
			return flameMetric === 'mem' ? fmtBytes(v) : fmtMs(v);
		}

		// Build positioned frames straight off the call tree, so the flamegraph is
		// the hierarchy — not a flat list of timings. A frame's width is its own
		// latency OR the summed width of its children, whichever is larger, so a
		// parent always spans the subtree beneath it. Children are packed
		// left-to-right under their parent, one call depth per row (icicle layout).
		// Returns the subtree width (ms) and pushes a frame for every node that
		// (or whose descendants) actually ran.
		function buildFrames(node, depth, x0, frames) {
			const children = (Array.isArray(node.children) ? node.children : [])
				.filter((c) => showExternal || !isExternal(c));
			let cursor = x0;
			let childrenW = 0;
			for (const child of children) {
				const w = buildFrames(child, depth + 1, cursor, frames);
				cursor += w;
				childrenW += w;
			}
			const own = selfMetric(node);
			const width = Math.max(own, childrenW);
			if (width > 0) {
				frames.push({ node: node, depth: depth, x0: x0, width: width, self: own });
			}
			return width;
		}

		// Neutral → brand red by share of the root's total (hotter = heavier on
		// the metric), so the flamegraph reads in the site's white/black/red system.
		// Label color is fixed per theme, with the RED CAP chosen so the label
		// clears 4.5:1 at the hottest frame (measured, not eyeballed):
		// - dark: red over near-black darkens the frame, so white text works at
		//   every mix (worst case 88% red = 6.3:1) — full 10–88% range.
		// - light: red over near-white brightens the frame; white-on-pink fails
		//   until ~88% and near-black ink fails ABOVE ~80%, so light keeps ink
		//   text and caps the mix at 78% (ink = 4.85:1 there). Between 80–88%
		//   NEITHER white nor ink reaches 4.5:1 — that band is unusable, which is
		//   why the old 65% white-switch was still broken.
		// Body theme classes are VS Code's own.
		function isDarkTheme() {
			const c = document.body.classList;
			return c.contains('vscode-dark') ||
				(c.contains('vscode-high-contrast') && !c.contains('vscode-high-contrast-light'));
		}
		function flameStyle(v, rootV) {
			const frac = Math.max(0, Math.min(1, rootV > 0 ? v / rootV : 0));
			const dark = isDarkTheme();
			const mix = Math.round(10 + (dark ? 78 : 68) * frac);
			return {
				background: 'color-mix(in srgb, var(--accent) ' + mix + '%, var(--bg-2))',
				color: dark ? '#ffffff' : 'var(--ink)',
			};
		}

		function fmtMs(v) { return (Math.round(v * 10) / 10) + 'ms'; }

		function renderFlame(result, isTraceMap) {
			const flameEl = document.getElementById('flame');
			flameEl.innerHTML = '';
			const tree = result.tree;

			const frames = [];
			const rootV = tree ? buildFrames(tree, 0, 0, frames) : 0;
			if (!isTraceMap || rootV <= 0) {
				flameEl.style.height = '';
				const hint = flameMetric === 'mem'
					? 'The memory flamegraph is built from per-function allocations (tracemalloc byte deltas). Exercise this endpoint with a memory-enabled capture to populate it.'
					: 'The flamegraph is built from runtime latency (per-function duration). Exercise this endpoint to capture a trace, then switch back here.';
				flameEl.appendChild(el('div', 'flame-hint', hint));
				return;
			}

			const rowH = 22;
			let maxDepth = 0;
			for (const f of frames) { maxDepth = Math.max(maxDepth, f.depth); }

			flameEl.style.height = ((maxDepth + 1) * rowH) + 'px';
			for (const f of frames) {
				const frame = el('div', 'flame-frame');
				frame.style.left = ((f.x0 / rootV) * 100) + '%';
				frame.style.width = ((f.width / rootV) * 100) + '%';
				frame.style.top = (f.depth * rowH) + 'px';
				frame.style.height = (rowH - 2) + 'px';
				const fstyle = flameStyle(f.width, rootV);
				frame.style.background = fstyle.background;
				frame.style.color = fstyle.color;
				const nm = (f.node.name || f.node.call || '?');
				frame.textContent = nm + '  ' + fmtMetric(f.width);
				const pct = Math.round((f.width / rootV) * 100);
				frame.title = nm + '()  ' + fmtMetric(f.width) + ' · ' + pct + '% of total' +
					(f.self && f.self < f.width ? ' · self ' + fmtMetric(f.self) : '') +
					(f.node.file ? '  ·  ' + f.node.file + ':' + f.node.line : '');
				if (f.node.file != null) {
					frame.style.cursor = 'pointer';
					frame.addEventListener('click', () => {
						vscode.postMessage({ type: 'openSource', file: f.node.file, line: f.node.line });
					});
				}
				flameEl.appendChild(frame);
			}
		}

		// Show either the tree or the flamegraph for the current view mode.
		function applyView(result, isTraceMap) {
			const treeEl = document.getElementById('tree');
			const flameEl = document.getElementById('flame');
			if (viewMode === 'flame') {
				treeEl.style.display = 'none';
				flameEl.style.display = 'block';
				renderFlame(result, isTraceMap);
			} else {
				treeEl.style.display = '';
				flameEl.style.display = 'none';
			}
		}

		// Render the whole view from a calltree OR tracemap result. tracemap adds the
		// runtime overlay (per-node) plus coverage, a handler-observed note and the gap.
		function render(result, isTraceMap) {
			const ep = result.entrypoint || {};
			const tree = result.tree;

			// A bare __main__ guard reads the same in every script, so name those by
			// the file that is actually run (mirrors entryPointLabel on the host side,
			// which also covers an apis.json written by an older engine build).
			const headerLabel = ep.kind === 'http_api' && ep.method
				? ep.method + ' ' + ep.path
				: (ep.trigger === '__main__' && ep.file
					? 'python ' + ep.file
					: (ep.trigger || ep.id || 'Call Tree'));
			document.getElementById('title').textContent = headerLabel;
			document.getElementById('root-meta').textContent =
				(ep.handler ? ep.handler + '()' : '') +
				(ep.file ? '  ·  ' + ep.file + ':' + ep.line : '') +
				(ep.framework ? '  ·  ' + ep.framework : '');

			const stats = document.getElementById('stats');
			stats.innerHTML = '';
			const s = result.stats || {};
			if (s.internal_functions != null) { stats.appendChild(mk('internal', s.internal_functions)); }
			if (s.external_calls != null) { stats.appendChild(mk('external', s.external_calls)); }

			const note = document.getElementById('note');
			if (isTraceMap) {
				const cov = result.coverage || {};
				const cw = el('span', 'cov');
				const bar = el('span', 'bar');
				const fill = el('span');
				fill.style.width = (cov.pct || 0) + '%';
				bar.appendChild(fill);
				cw.appendChild(el('span', null, 'coverage'));
				cw.appendChild(bar);
				cw.appendChild(el('b', null, (cov.executed || 0) + '/' + (cov.static_functions || 0) + ' (' + (cov.pct || 0) + '%)'));
				stats.appendChild(cw);

				if (result.handler_observed) {
					const reqs = result.requests_matched || [];
					note.innerHTML = '';
					note.appendChild(el('span', 'live', '● live'));
					note.appendChild(document.createTextNode(' overlaying ' + reqs.length + ' request' + (reqs.length === 1 ? '' : 's') + ' from the capture'));
				} else {
					note.textContent = 'Handler not observed in the trace yet — exercise this endpoint to see runtime coverage.';
				}
			} else {
				note.textContent = '';
			}

			const treeEl = document.getElementById('tree');
			treeEl.innerHTML = '';
			const status = document.getElementById('status');
			if (!tree) {
				status.style.display = 'block';
				status.textContent = 'No call tree was produced for this entry point.';
				applyView(result, isTraceMap);
				return;
			}
			status.style.display = 'none';
			treeEl.appendChild(renderNode(tree));

			// Runtime-only gap (ran but the static graph didn't predict it).
			const gap = document.getElementById('gap');
			const gapList = document.getElementById('gap-list');
			const only = (isTraceMap && result.runtime_only) || [];
			if (only.length) {
				gapList.innerHTML = '';
				for (const r of only) {
					gapList.appendChild(el('li', null,
						r.component + '  ×' + r.calls + ' (' + r.total_ms + 'ms)' +
						(r.errors && r.errors.length ? '  ⚠ ' + r.errors.join(', ') : '')));
				}
				gap.style.display = 'block';
			} else {
				gap.style.display = 'none';
			}

			applyView(result, isTraceMap);
		}

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.type === 'tree') {
				lastResult = msg.result; lastIsTraceMap = false;
				render(msg.result, false);
			} else if (msg.type === 'tracemap') {
				lastResult = msg.result; lastIsTraceMap = true;
				render(msg.result, true);
			} else if (msg.type === 'tracemapUnavailable') {
				// Static tree stays; just hint that the runtime overlay isn't ready.
				const note = document.getElementById('note');
				if (!note.textContent) {
					note.textContent = 'Runtime overlay unavailable (no trace captured yet).';
				}
			} else if (msg.type === 'error') {
				const status = document.getElementById('status');
				status.style.display = 'block';
				status.className = 'error';
				status.textContent = 'Could not build the call tree:\\n' + msg.message;
			}
		});
	</script>
</body>
</html>`;
}
