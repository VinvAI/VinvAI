import * as vscode from 'vscode';
import {
	hasCaptures,
	entryPointLabel,
	loadEntryPoints,
	getTraceSummary,
	type EntryPoint,
} from '../identification/identification';
import { buildFilteredTrace } from '../identification/traceFilter';
import type { SessionTimeRange } from './sessionsView';
import { VINV_BASE_CSS, VINV_FONT_MONO } from './webviewTheme';

/**
 * The Traces panel — every traced entry point with its live hit count, opened
 * from the Flow title bar's "View Traces" button.
 *
 * This is the Sessions sidebar list rehoused. The rail dropped its Traces stage
 * (see flowModel's FlowStageId), but the list itself was the one part of it
 * people actually used, and a sidebar tree could not hold a search box and a
 * range filter side by side. Same data path as SessionsProvider — entry points
 * from `identification consolidate`, hit counts from `identification
 * tracesummary`, polled while visible and window-filtered through
 * buildFilteredTrace — so the two never disagree about what ran.
 */

const TRACE_POLL_MS = 1000;

/** The ES-style quick ranges, mirroring the Sessions time-filter picker. */
const TIME_PRESETS: ReadonlyArray<SessionTimeRange> = [
	{ label: 'Last 1 minute', windowMs: 60_000 },
	{ label: 'Last 5 minutes', windowMs: 5 * 60_000 },
	{ label: 'Last 10 minutes', windowMs: 10 * 60_000 },
	{ label: 'Last 30 minutes', windowMs: 30 * 60_000 },
	{ label: 'Last 1 hour', windowMs: 60 * 60_000 },
];

interface TraceRow {
	id: string;
	trigger: string;
	handler: string;
	file: string;
	line: number;
	kind: string;
	count: number;
}

let panel: vscode.WebviewPanel | undefined;

/** Opens (or reveals) the Traces panel. */
export async function openTraces(context: vscode.ExtensionContext): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		void vscode.window.showWarningMessage('Vinv: Open a folder first.');
		return;
	}
	if (panel) {
		panel.reveal(vscode.ViewColumn.Active);
		return;
	}
	panel = vscode.window.createWebviewPanel(
		'vinv.traces',
		'Vinv Traces',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);

	let entries: EntryPoint[] = [];
	let counts = new Map<string, number>();
	let range: SessionTimeRange | undefined;
	let polling = false;
	let disposed = false;

	const rows = (): TraceRow[] =>
		entries
			.map((e) => ({
				id: e.id,
				trigger: entryPointLabel(e),
				handler: e.handler ?? '',
				file: e.file,
				line: e.line,
				kind: e.kind,
				count: counts.get(e.id) ?? 0,
			}))
			// Busiest first, then alphabetical — the same order the tree used, so
			// muscle memory carries over.
			.sort((a, b) => b.count - a.count || a.trigger.localeCompare(b.trigger));

	const post = (): void => {
		if (!disposed) {
			void panel?.webview.postMessage({
				type: 'data',
				rows: rows(),
				ranges: TIME_PRESETS.map((r) => r.label),
				activeRange: range?.label ?? '',
				haveCaptures: hasCaptures(root),
			});
		}
	};

	const pollOnce = async (): Promise<void> => {
		if (polling || disposed || !panel?.visible) {
			return;
		}
		// Entry points are loaded once when the panel opens, and the poll below
		// only ever refreshed COUNTS — so a panel opened before discovery finished
		// (or before `bringup list` inventoried the CLIs) showed "No traced
		// endpoints match" forever. Retried here, AHEAD of the captures gate: the
		// list is what the panel is for, and a repo with no captures yet is
		// precisely when it is both empty and worth filling. One identification
		// call per tick while empty, none once it fills.
		if (entries.length === 0) {
			polling = true;
			try {
				entries = await loadEntryPoints(context, root);
				if (entries.length > 0) {
					post();
				}
			} catch {
				// Discovery not ready yet — the next tick tries again.
			} finally {
				polling = false;
			}
		}
		// Counts come from the captures; without any there is nothing to count,
		// but the entry list above is still worth showing at zero.
		if (!hasCaptures(root)) {
			return;
		}
		polling = true;
		try {
			// A window filter is applied by handing the binary a trimmed trace, not
			// by filtering counts after the fact: the counts have to come from the
			// same pass that produced them or the totals stop adding up.
			let traceFile: string | undefined;
			if (range) {
				const nowSec = Date.now() / 1000;
				traceFile = buildFilteredTrace(root, {
					fromSec: nowSec - range.windowMs / 1000,
					toSec: nowSec,
				});
			}
			const summary = await getTraceSummary(context, root, traceFile);
			const next = new Map<string, number>();
			for (const e of summary.endpoints ?? []) {
				next.set(e.id, e.trace_count);
			}
			counts = next;
			post();
		} catch {
			// No trace yet, or an older binary without tracesummary — keep the last
			// counts and let the next tick try again.
		} finally {
			polling = false;
		}
	};

	panel.webview.html = html();
	panel.onDidDispose(() => {
		disposed = true;
		panel = undefined;
	});
	panel.webview.onDidReceiveMessage((msg: { type?: string; id?: string; label?: string; range?: string }) => {
		if (msg.type === 'open' && msg.id) {
			void vscode.commands.executeCommand('vinv-vs.openCallTree', {
				apiId: msg.id,
				label: msg.label ?? msg.id,
			});
		} else if (msg.type === 'range') {
			range = TIME_PRESETS.find((r) => r.label === msg.range);
			void pollOnce();
			post();
		} else if (msg.type === 'ready') {
			post();
		}
	});

	const timer = setInterval(() => void pollOnce(), TRACE_POLL_MS);
	panel.onDidDispose(() => clearInterval(timer));

	entries = await loadEntryPoints(context, root);
	post();
	void pollOnce();
}

function html(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${VINV_BASE_CSS}
.wrap { padding: 18px 20px 40px; }
h1 { font-size: 11px; letter-spacing: .24em; text-transform: uppercase; color: var(--muted);
     margin: 0 0 16px; font-weight: 400; }
h1::before { content: '// '; color: var(--accent-fg); }
.bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
input, select { background: var(--bg-2); color: var(--ink); border: 1px solid var(--line-strong);
  border-radius: 0; padding: 6px 9px; font-family: ${VINV_FONT_MONO}; font-size: 12px; }
input { flex: 1; min-width: 180px; }
input:focus, select:focus { border-color: var(--accent-fg); outline: none; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; font-size: 10px; letter-spacing: .18em; text-transform: uppercase;
     color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line-strong); padding: 7px 8px; }
td { border-bottom: 1px solid var(--line); padding: 7px 8px; vertical-align: top; }
tr.row { cursor: pointer; }
tr.row:hover td { background: var(--bg-2); }
.trigger { color: var(--ink); }
.handler { color: var(--muted); }
.count { text-align: right; font-variant-numeric: tabular-nums; }
.count.hit { color: var(--accent-fg); }
.kind { font-size: 9px; letter-spacing: .18em; text-transform: uppercase; color: var(--muted);
        border: 1px solid currentColor; padding: 1px 6px; }
.empty { color: var(--muted); padding: 24px 0; }
</style></head>
<body><div class="wrap">
<h1>Traced endpoints</h1>
<div class="bar">
  <input id="q" type="text" placeholder="Filter endpoints…" autocomplete="off">
  <select id="range"><option value="">All time</option></select>
</div>
<div id="out"><div class="empty">Loading…</div></div>
</div>
<script>
const vscode = acquireVsCodeApi();
let ROWS = [];
const q = document.getElementById('q');
const range = document.getElementById('range');
const out = document.getElementById('out');
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function render(){
  const needle = q.value.trim().toLowerCase();
  const rows = ROWS.filter(r => !needle ||
    (r.trigger + ' ' + r.handler + ' ' + r.file).toLowerCase().includes(needle));
  if (!rows.length) { out.innerHTML = '<div class="empty">No traced endpoints match.</div>'; return; }
  out.innerHTML = '<table><thead><tr><th>Endpoint</th><th>Handler</th><th>Kind</th>' +
    '<th style="text-align:right">Hits</th></tr></thead><tbody>' +
    rows.map(r => '<tr class="row" data-id="' + esc(r.id) + '" data-label="' + esc(r.trigger) + '">' +
      '<td class="trigger">' + esc(r.trigger) + '</td>' +
      '<td class="handler">' + esc(r.handler || '—') + '</td>' +
      '<td><span class="kind">' + esc(r.kind) + '</span></td>' +
      '<td class="count' + (r.count > 0 ? ' hit' : '') + '">' + r.count + '</td></tr>').join('') +
    '</tbody></table>';
  out.querySelectorAll('tr.row').forEach(tr => tr.addEventListener('click', () =>
    vscode.postMessage({ type: 'open', id: tr.dataset.id, label: tr.dataset.label })));
}
q.addEventListener('input', render);
range.addEventListener('change', () => vscode.postMessage({ type: 'range', range: range.value }));
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type !== 'data') return;
  ROWS = m.rows;
  if (range.options.length === 1) {
    m.ranges.forEach(r => { const o = document.createElement('option'); o.value = r; o.textContent = r; range.appendChild(o); });
  }
  range.value = m.activeRange;
  if (!m.haveCaptures) { out.innerHTML = '<div class="empty">No captures yet — run a service under tracing first.</div>'; return; }
  render();
});
vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}

/** Registers the `vinv-vs.openTraces` command. */
export function registerTracesPanel(context: vscode.ExtensionContext): vscode.Disposable {
	return vscode.commands.registerCommand('vinv-vs.openTraces', () => openTraces(context));
}
