/**
 * One dead-code section, as a walkthrough.
 *
 * Reached by clicking a row in the Findings dead-code list. Structured as a TOUR
 * rather than a scrolling dump for the same reason the graph's tour is: a section
 * is eight functions that only make sense in dependency order, and a page of
 * eight code blocks makes the reader do that ordering themselves. One stop at a
 * time, callees first, with the code, its neighbours and its reachability
 * evidence on screen together.
 *
 * The agent's reading sits at the top and never moves: what the code does, why
 * nothing reaches it, and whether to integrate it, re-imagine it, or drop it. An
 * unanalysed section shows the button that asks — never a blank card that reads
 * like a verdict of "nothing to say".
 *
 * File-backed custom editor over .vinv/reports/deadcode-<id>.json, so the tab is
 * draggable into chat and the machine-readable copy IS the tab's backing file —
 * the same contract findings.json and journey.json have.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { VINV_BASE_CSS, VINV_FONT_MONO, VINV_FONT_SERIF } from './webviewTheme';
import {
	buildDeadCode,
	buildSectionReport,
	sectionIdFromPath,
	writeSectionReport,
	type DeadSectionReport,
} from './deadCodeModel';
import { readAnalysis } from '../harness/deadCodeAnalysis';
import { openPathInEditor } from '../support/openDocument';

export const DEAD_SECTION_VIEW_TYPE = 'vinv.deadCodeSection';

export interface DeadSectionOutbound {
	type: 'openSource' | 'refresh' | 'analyze' | 'tryRun' | 'openArtifact';
	file?: string;
	line?: number;
}

export interface DeadSectionActions {
	openSource: (file: string | undefined, line?: number) => Promise<void>;
	refresh: () => Promise<void>;
	/** Ask the harness about this one section (a batch of one). */
	analyze: () => Promise<void>;
	/** Have the harness write a driver and run this section under trace. */
	tryRun: () => Promise<void>;
	/**
	 * Open a file a try-run produced — its driver script or its trace.jsonl.
	 * Separate from `openSource` because these are absolute paths outside the
	 * indexed tree, and because a trace opens at line 1, never at a symbol.
	 */
	openArtifact: (file: string | undefined) => Promise<void>;
}

export async function handleDeadSectionMessage(
	msg: DeadSectionOutbound,
	actions: DeadSectionActions,
): Promise<void> {
	if (msg.type === 'openSource') {
		await actions.openSource(msg.file, msg.line);
	} else if (msg.type === 'refresh') {
		await actions.refresh();
	} else if (msg.type === 'analyze') {
		await actions.analyze();
	} else if (msg.type === 'tryRun') {
		await actions.tryRun();
	} else if (msg.type === 'openArtifact') {
		await actions.openArtifact(msg.file);
	}
}

/**
 * Builds one section's report and opens its tab.
 *
 * Returns false when the id no longer resolves — a reindex that changed the code
 * mints a new section id, and the honest answer is "that section is gone", not an
 * empty tab.
 */
export async function openDeadSection(workspaceRoot: string, id: string): Promise<boolean> {
	const report = assembleSection(workspaceRoot, id);
	if (!report) {
		return false;
	}
	const backing = writeSectionReport(workspaceRoot, report);
	await vscode.commands.executeCommand(
		'vscode.openWith',
		vscode.Uri.file(backing),
		DEAD_SECTION_VIEW_TYPE,
		vscode.ViewColumn.Active,
	);
	return true;
}

/** Re-derives one section from the current store, with its stored verdict. */
function assembleSection(workspaceRoot: string, id: string): DeadSectionReport | null {
	const dead = buildDeadCode(workspaceRoot);
	const section = dead.sections.items.find((s) => s.id === id);
	if (!section) {
		return null;
	}
	const analysis = readAnalysis(workspaceRoot);
	return buildSectionReport(workspaceRoot, section, dead.storeEpoch, analysis?.verdicts[id] ?? null);
}

export class DeadSectionEditorProvider implements vscode.CustomReadonlyEditorProvider {
	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			DEAD_SECTION_VIEW_TYPE,
			new DeadSectionEditorProvider(context),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	private constructor(private readonly context: vscode.ExtensionContext) {}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): void {
		const workspaceRoot = path.resolve(path.dirname(document.uri.fsPath), '..', '..');
		const id = sectionIdFromPath(document.uri.fsPath);
		const wiring = wireDeadSection(
			this.context,
			workspaceRoot,
			id,
			document.uri.fsPath,
			webviewPanel.webview,
		);
		webviewPanel.onDidDispose(() => wiring.dispose());
	}
}

function wireDeadSection(
	_context: vscode.ExtensionContext,
	workspaceRoot: string,
	id: string | null,
	backingPath: string,
	webview: vscode.Webview,
): vscode.Disposable {
	webview.options = { enableScripts: true };
	webview.html = getHtml();

	let disposed = false;
	const push = async (): Promise<void> => {
		// A tab reopened after a reindex must show the CURRENT store, so the report
		// is re-derived rather than served from the backing file. When the section
		// is gone the stored copy is posted with a staleness flag instead — better
		// than an empty tab for code the user was just reading.
		const fresh = id ? assembleSection(workspaceRoot, id) : null;
		if (disposed) {
			return;
		}
		if (fresh) {
			void webview.postMessage({ type: 'section', report: fresh, stale: false });
			try {
				writeSectionReport(workspaceRoot, fresh);
			} catch {
				// the view is current; only the artifact lags
			}
			return;
		}
		let stored: DeadSectionReport | null = null;
		try {
			stored = JSON.parse(fs.readFileSync(backingPath, 'utf8')) as DeadSectionReport;
		} catch {
			stored = null;
		}
		void webview.postMessage({ type: 'section', report: stored, stale: true });
	};

	const actions: DeadSectionActions = {
		openSource: async (file, line) => {
			await openPathInEditor(file, {
				workspaceRoot,
				line: line ?? 1,
				label: 'source file',
				preview: true,
				viewColumn: vscode.ViewColumn.Beside,
			});
		},
		refresh: push,
		analyze: async () => {
			await vscode.commands.executeCommand('vinv-vs.analyzeDeadCode', { sectionId: id });
			await push();
		},
		// The re-push matters most on THIS path: a revived symbol changes the
		// section's membership, and the tab must show that rather than keep
		// calling executed code dead.
		tryRun: async () => {
			await vscode.commands.executeCommand('vinv-vs.tryRunDeadCode', { sectionId: id });
			await push();
		},
		openArtifact: async (file) => {
			await openPathInEditor(file, {
				workspaceRoot,
				line: 1,
				label: 'try-run artifact',
				preview: true,
				viewColumn: vscode.ViewColumn.Beside,
			});
		},
	};

	const sub = webview.onDidReceiveMessage(
		(msg: DeadSectionOutbound | { type: 'webviewError' }) => {
			if (msg.type === 'webviewError') {
				return;
			}
			return handleDeadSectionMessage(msg, actions);
		},
	);
	void push();

	return {
		dispose(): void {
			disposed = true;
			sub.dispose();
		},
	};
}

/** Exported for the standalone browser harness (visual verification). */
export function getDeadSectionHtml(): string {
	return getHtml();
}

function getHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Vinv Dead Code Section</title>
	<style>
		${VINV_BASE_CSS}
		body { padding: 18px 20px; font-size: 12.5px; }
		header { border-bottom: 1px solid var(--line); margin-bottom: 14px; padding-bottom: 12px; }
		h1 { font-family: ${VINV_FONT_SERIF}; font-style: italic; font-weight: 400;
			font-size: 22px; line-height: 1.15; margin: 0 0 6px; overflow-wrap: anywhere; }
		.meta { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		h2 { font-size: 10px; font-weight: 400; letter-spacing: 0.24em; text-transform: uppercase;
			color: var(--muted); margin: 22px 0 10px; padding-top: 12px;
			border-top: 1px solid var(--ink); display: inline-block; }
		h2::before { content: '// '; color: var(--accent-fg); }
		.badge { font-size: 9px; padding: 1px 6px; letter-spacing: 0.16em; text-transform: uppercase;
			border: 1px solid currentColor; color: var(--muted-2); white-space: nowrap; }
		.badge.hot { color: var(--accent-fg); }
		.badge.ok { background: var(--ok); border-color: var(--ok); color: #ffffff; }
		.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.card { border: 1px solid var(--line-strong); padding: 10px 12px; margin-bottom: 10px; }
		.kv { margin-top: 8px; font-size: 11px; width: 100%; border-collapse: collapse; }
		.kv th { width: 96px; text-align: left; font-weight: 400; color: var(--muted);
			font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase;
			padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top;
			white-space: nowrap; }
		.kv td { padding: 4px 0; border-bottom: 1px solid var(--line);
			white-space: pre-wrap; overflow-wrap: anywhere; }
		button.act { font: inherit; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
			padding: 4px 11px; cursor: pointer; background: var(--ink); color: var(--bg);
			border: 1px solid var(--ink); border-radius: 0; }
		button.act:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); }
		button.act:disabled { cursor: default; background: var(--bg-2); color: var(--muted);
			border-color: var(--line-strong); }
		button.ghost { font: inherit; font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase;
			padding: 5px 12px; cursor: pointer; background: transparent; color: var(--ink);
			border: 1px solid var(--line-strong); border-radius: 0; }
		button.ghost:hover:not(:disabled) { border-color: var(--ink); }
		button.ghost:disabled { cursor: default; color: var(--muted-2); border-color: var(--line); }
		.stopbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
			border: 1px solid var(--line-strong); padding: 8px 12px; background: var(--bg-2); }
		.stopbar .n { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); }
		.grow { flex: 1; }
		.sym { font-weight: 600; overflow-wrap: anywhere; }
		.where { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
		pre { margin: 10px 0 0; padding: 10px 12px; background: var(--bg-2);
			border: 1px solid var(--line); overflow-x: auto; font-family: ${VINV_FONT_MONO};
			font-size: 11px; line-height: 1.45; }
		.empty { color: var(--muted); font-size: 11px; padding: 6px 0; }
		table.trace { margin-top: 8px; font-size: 11px; width: 100%; border-collapse: collapse; }
		table.trace th { text-align: left; font-weight: 400; color: var(--muted); font-size: 9.5px;
			letter-spacing: 0.16em; text-transform: uppercase; padding: 4px 8px 4px 0;
			border-bottom: 1px solid var(--line); }
		table.trace td { padding: 3px 8px 3px 0; border-bottom: 1px solid var(--line);
			overflow-wrap: anywhere; }
		table.trace td.num { text-align: right; font-variant-numeric: tabular-nums;
			font-family: ${VINV_FONT_MONO}; white-space: nowrap; }
		table.trace td.err { color: var(--accent-fg); }
		.runbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
		.stat { font-size: 11px; color: var(--muted); }
		.stat b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
		.hint { color: var(--muted-2); font-size: 10.5px; margin-top: 6px; }
		ul.plain { margin: 6px 0 0; padding-left: 18px; }
		ul.plain li { margin: 2px 0; overflow-wrap: anywhere; }
	</style>
</head>
<body>
	<header>
		<h1 id="title">Dead code section</h1>
		<div class="meta" id="sub">LOADING…</div>
	</header>
	<div id="content"><div class="empty">Assembling the walkthrough…</div></div>

	<script>
	const vscode = acquireVsCodeApi();
	window.addEventListener('error', (e) => vscode.postMessage({ type: 'webviewError', message: String(e.message || 'unknown') }));

	const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

	let REPORT = null;
	let STALE = false;
	let STOP = 0;

	const ACTION_LABEL = {
		integrate: 'integrate',
		reimagine: 're-imagine',
		delete: 'safe to delete',
		keep: 'keep as is',
		unclear: 'needs a human',
	};

	// Shared between both card variants: the empirical counterpart to analysis —
	// instead of asking what the code is, ask whether it can be made to RUN.
	const TRY_RUN_BTN =
		'<button class="act" id="tryrun" title="Have the coding harness write a driver that exercises this section, run it under vinv tracing, and report which symbols actually executed — a reached symbol leaves the dead list">Run this Path</button>';

	function verdictCard(v) {
		if (!v) {
			return '<div class="card"><div class="row">' +
				'<span class="badge">not analysed yet</span>' +
				'<span class="grow"></span>' +
				TRY_RUN_BTN +
				'<button class="act" id="analyze" title="Hand this section to your coding harness: it reads the code and reports what it does, why nothing reaches it, and how to integrate or re-imagine it">Ask the agent</button>' +
				'</div><div class="hint">Nothing here is a verdict until the agent has read the code. ' +
				'Analysing every section at once is faster — the Findings panel batches them.</div></div>';
		}
		const cls = v.action === 'delete' ? ' hot' : v.action === 'keep' ? ' ok' : '';
		let html = '<div class="card"><div class="row">' +
			'<span class="badge' + cls + '">' + esc(ACTION_LABEL[v.action] || v.action) + '</span>' +
			'<span class="badge" title="How sure the agent was, by its own account">confidence ' + esc(v.confidence) + '</span>' +
			'<span class="grow"></span>' +
			TRY_RUN_BTN +
			'<button class="act" id="analyze" title="Ask again — useful after the code or the traces changed">Re-analyse</button>' +
			'</div><table class="kv">';
		const row = (k, val, tip) => val
			? '<tr><th' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + esc(k) + '</th><td>' + esc(val) + '</td></tr>'
			: '';
		html += row('What it does', v.what, 'The agent&#39;s account of the code, from reading it');
		html += row('Why it is dead', v.why, 'Why nothing reaches it, as far as the code shows');
		html += row('Integrate', v.integrate, 'Concrete steps to wire this back into the running paths');
		html += row('Re-imagine', v.reimagine, 'What this could become instead of what it is');
		html += row('If removed', v.risk, 'What breaks or is lost if this is deleted');
		return html + '</table></div>';
	}

	const RUN_LABEL = {
		revived: 'symbols executed',
		'not-reached': 'nothing executed',
		declined: 'not drivable',
		'run-failed': 'no trace produced',
		'no-reply': 'harness never replied',
		'unusable-reply': 'no usable driver',
		unavailable: 'could not start',
	};

	function fmtWhen(iso) {
		const t = Date.parse(iso);
		return Number.isFinite(t) ? new Date(t).toLocaleString() : String(iso || '');
	}

	// The traces the try-run produces are the ONLY empirical evidence about this
	// section — everything else on this page is static inference. So the newest
	// run is shown open, with what the capture recorded, and the older ones as
	// one line each so a second attempt can be compared against the first.
	function runsCard(runs) {
		if (!runs || !runs.length) {
			return '<div class="empty">No one has tried to run this section yet. ' +
				'&ldquo;Run this Path&rdquo; asks the agent for a driver, runs it under vinv tracing, ' +
				'and the trace it produces lands here.</div>';
		}
		const latest = runs[0];
		const cls = latest.outcome === 'revived' ? ' ok' : latest.outcome === 'not-reached' ? '' : ' hot';
		let html = '<div class="card"><div class="row">' +
			'<span class="badge' + cls + '">' + esc(RUN_LABEL[latest.outcome] || latest.outcome) + '</span>' +
			'<span class="where">' + esc(fmtWhen(latest.at)) + '</span>' +
			'<span class="grow"></span>' +
			(latest.traceFile
				? '<button class="ghost" data-open="' + esc(latest.traceFile) + '" title="Open the raw capture this run produced (.vinv/captures/…/trace.jsonl)">Open trace</button>'
				: '') +
			(latest.driverFile
				? '<button class="ghost" data-open="' + esc(latest.driverFile) + '" title="Open the driver script the agent wrote for this section">Open driver</button>'
				: '') +
			'</div>';
		html += '<div class="hint">' + esc(latest.detail) + '</div>';
		if (latest.revived && latest.revived.length) {
			html += '<div class="hint">Executed: ' + latest.revived.map(esc).join(' · ') + '</div>';
		}
		if (latest.notes) {
			html += '<div class="hint">Driver notes: ' + esc(latest.notes) + '</div>';
		}
		const t = latest.trace;
		if (t) {
			html += '<div class="runbar">' +
				'<span class="stat"><b>' + t.functions + '</b> functions traced</span>' +
				'<span class="stat"><b>' + t.calls + '</b> calls</span>' +
				'<span class="stat"><b>' + t.totalMs + '</b> ms</span>' +
				'<span class="stat"><b>' + t.errors + '</b> raised' +
				(t.errorTypes && t.errorTypes.length ? ' (' + t.errorTypes.map(esc).join(', ') + ')' : '') +
				'</span></div>';
			html += '<table class="trace"><thead><tr><th>Function the run reached</th>' +
				'<th style="text-align:right">Calls</th><th style="text-align:right">ms</th>' +
				'<th style="text-align:right">Raised</th></tr></thead><tbody>' +
				t.top.map((f) =>
					'<tr><td>' + esc(f.component) + '</td>' +
					'<td class="num">' + f.calls + '</td>' +
					'<td class="num">' + f.ms + '</td>' +
					'<td class="num' + (f.errors ? ' err' : '') + '">' + f.errors + '</td></tr>').join('') +
				'</tbody></table>';
			html += '<div class="hint">Counted from the capture itself, not from what the driver ' +
				'claimed. A function listed here executed; a section symbol missing from it did not.</div>';
		} else if (latest.traceFile) {
			html += '<div class="hint">The capture recorded no function exits — tracelens instrumented ' +
				'nothing this run reached (usually a target package that matches no import package).</div>';
		}
		if (latest.outputTail && latest.outcome === 'run-failed') {
			html += '<pre>' + esc(latest.outputTail.slice(-1500)) + '</pre>';
		}
		html += '</div>';
		if (runs.length > 1) {
			html += '<div class="card"><div class="hint">Earlier attempts</div><ul class="plain">' +
				runs.slice(1, 6).map((r) =>
					'<li>' + esc(fmtWhen(r.at)) + ' — ' + esc(RUN_LABEL[r.outcome] || r.outcome) +
					(r.trace ? ' (' + r.trace.functions + ' functions, ' + r.trace.calls + ' calls)' : '') +
					'</li>').join('') +
				'</ul></div>';
		}
		return html;
	}

	function render() {
		if (!REPORT) {
			document.getElementById('sub').textContent = 'SECTION NOT FOUND';
			document.getElementById('content').innerHTML =
				'<div class="empty">This section is no longer in the current index — the code it described was changed or removed. ' +
				'Open Findings for the current dead-code list.</div>';
			return;
		}
		const s = REPORT.section;
		document.getElementById('title').textContent = s.title;
		document.getElementById('sub').textContent =
			(STALE ? 'STALE SNAPSHOT · ' : '') +
			s.reason.replace('-', ' ').toUpperCase() + ' · ' + s.lines + ' LINES · EPOCH ' + REPORT.storeEpoch;

		let html = verdictCard(REPORT.verdict);

		html += '<h2>Reachability</h2>';
		if (s.liveCallers.length) {
			html += '<div class="card"><div class="row"><span class="badge hot">reached from live code</span></div>' +
				'<div class="hint">These executed in a capture and statically reference this section — the code IS wired up, ' +
				'the path was simply never taken.</div><ul class="plain">' +
				s.liveCallers.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul></div>';
		} else {
			html += '<div class="card"><div class="row"><span class="badge">no references</span></div>' +
				'<div class="hint">Nothing in the indexed graph points at this section. A static graph cannot see ' +
				'reflection, plugin registries or externally-called entry points, so this is strong evidence and not proof.</div></div>';
		}

		html += '<h2>Try-runs (what happened when this was driven)</h2>';
		html += runsCard(REPORT.runs);

		html += '<h2>Walkthrough (' + REPORT.stops.length + ' stops, callees first)</h2>';
		if (!REPORT.stops.length) {
			html += '<div class="empty">No symbols to walk.</div>';
			document.getElementById('content').innerHTML = html;
			wire(); // the try-run card is above this and still has live buttons
			return;
		}
		STOP = Math.max(0, Math.min(REPORT.stops.length - 1, STOP));
		const stop = REPORT.stops[STOP];
		const sym = stop.symbol;
		html += '<div class="stopbar">' +
			'<button class="ghost" id="prev"' + (STOP === 0 ? ' disabled' : '') + '>Prev</button>' +
			'<span class="n">' + (STOP + 1) + ' / ' + REPORT.stops.length + '</span>' +
			'<button class="ghost" id="next"' + (STOP === REPORT.stops.length - 1 ? ' disabled' : '') + '>Next</button>' +
			'<span class="grow"></span>' +
			'<button class="ghost" id="open">Open in editor</button></div>';
		html += '<div class="card"><div class="row"><span class="badge">' + esc(sym.kind) + '</span>' +
			'<span class="sym">' + esc(sym.name) + '</span>' +
			'<span class="where">' + esc(sym.file) + ':' + sym.startLine + '–' + sym.endLine + ' · ' + sym.lines + ' lines</span></div>';
		if (sym.summary) { html += '<div class="hint">' + esc(sym.summary) + '</div>'; }
		if (sym.liveCallers.length) {
			html += '<div class="hint">called by live code: ' + sym.liveCallers.map(esc).join(' · ') + '</div>';
		}
		html += stop.source
			? '<pre>' + esc(stop.source) + '</pre>'
			: '<div class="hint">The index store carries no source text for this row.</div>';
		html += '</div>';

		const sel = s.symbols;
		const capped = (sel.lineage || []).some((x) => x.stopped_by === 'cap');
		if (capped) {
			const st = sel.lineage[sel.lineage.length - 1];
			html += '<div class="hint">Showing ' + st.returned + ' of ' + st.total +
				' symbols in this section — stopped at the item cap, so the ' + st.dropped +
				' not shown are not known to be unimportant.</div>';
		}
		html += '<div class="hint">Machine-readable copy: .vinv/reports/deadcode-' + esc(s.id) + '.json (this tab\\'s backing file).</div>';
		document.getElementById('content').innerHTML = html;
		wire();
	}

	function wire() {
		const on = (id, fn) => { const el = document.getElementById(id); if (el) { el.addEventListener('click', fn); } };
		document.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () =>
			vscode.postMessage({ type: 'openArtifact', file: el.getAttribute('data-open') })));
		on('prev', () => { STOP -= 1; render(); });
		on('next', () => { STOP += 1; render(); });
		on('open', () => {
			const stop = REPORT && REPORT.stops[STOP];
			if (stop) { vscode.postMessage({ type: 'openSource', file: stop.symbol.file, line: stop.symbol.startLine }); }
		});
		on('analyze', () => {
			const btn = document.getElementById('analyze');
			btn.disabled = true;
			btn.textContent = 'Asking…';
			vscode.postMessage({ type: 'analyze' });
		});
		on('tryrun', () => {
			// Minutes of agent + traced-run time; a live button would race a second
			// driver against the first for the same capture.
			const btn = document.getElementById('tryrun');
			btn.disabled = true;
			btn.textContent = 'Running under trace…';
			vscode.postMessage({ type: 'tryRun' });
		});
	}

	window.addEventListener('message', (event) => {
		if (event.data.type === 'section') {
			REPORT = event.data.report;
			STALE = Boolean(event.data.stale);
			render();
		}
	});
	</script>
</body>
</html>`;
}
