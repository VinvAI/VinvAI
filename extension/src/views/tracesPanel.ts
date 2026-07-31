import * as vscode from 'vscode';
import {
	hasCaptures,
	entryPointLabel,
	loadEntryPoints,
	readEntryPoints,
	getTraceSummary,
} from '../identification/identification';
import { buildFilteredTrace } from '../identification/traceFilter';
import { entryPointHits } from '../identification/entryPointHits';
import type { SessionTimeRange } from './sessionsView';
import { readUnitStats, type UnitStats } from './unitStats';
import { readUnitInventory, type InventoryUnit } from './unitInventory';
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
	/** Percentage of the unit's call tree that ran, per the runtime overlay. */
	coveragePct?: number;
	coverageText?: string;
	/** Duration of this unit's own invocations, from the captured spans. */
	p50?: number;
	p95?: number;
	/** Invocations that returned, and that raised, with the exception types. */
	ok?: number;
	raised?: number;
	errorTypes?: string[];
	/** Runtime errors under this unit's call tree. */
	errors?: number;
	/** Whether a call-tree snapshot has already been built for this unit. */
	built?: boolean;
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

	// Declared entry points PLUS the units only an exerciser knows about (a
	// driven function is declared nowhere) — see readUnitInventory.
	let entries: InventoryUnit[] = [];
	let counts = new Map<string, number>();
	let stats = new Map<string, UnitStats>();
	/** The engine's own words when the inventory could not be loaded. */
	let loadError = '';
	let range: SessionTimeRange | undefined;
	let polling = false;
	let disposed = false;

	const rows = (): TraceRow[] =>
		entries
			.map((e) => {
				const s = stats.get(e.id);
				return {
					id: e.id,
					trigger: entryPointLabel(e),
					handler: e.handler ?? '',
					file: e.file,
					line: e.line,
					kind: e.kind,
					count: counts.get(e.id) ?? 0,
					coveragePct: s?.coverage?.pct,
					coverageText: s?.coverage ? `${s.coverage.executed}/${s.coverage.total}` : undefined,
					p50: s?.p50Ms,
					p95: s?.p95Ms,
					ok: s?.ok,
					raised: s?.error,
					errorTypes: s?.errorTypes,
					errors: s?.errorCount,
					built: s?.hasCallTree,
				};
			})
			// What ran comes first — a panel whose first screen is a wall of
			// never-exercised rows buries the run the user just made. Busiest
			// first, then alphabetical, which is the order the tree used, so
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
				error: loadError,
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
				entries = readUnitInventory(root, await loadEntryPoints(context, root));
				loadError = '';
				if (entries.length > 0) {
					post();
				}
			} catch (e) {
				// The engine ANSWERED, with an error — most often "no code index for
				// this workspace". Swallowing it left the panel on its loading state
				// forever with nothing on screen to act on, so it is carried to the
				// view. The on-disk inventory is tried anyway: a stale entry-point
				// list at zero hits beats an empty panel.
				loadError = e instanceof Error ? e.message : String(e);
				entries = readUnitInventory(root, readEntryPoints(root));
				post();
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
			// Non-HTTP entry points FIRST, so the engine's own numbers overwrite
			// them wherever both have an answer: tracesummary counts distinct
			// server requests, which is the better unit for a route, and it is
			// the number every other HTTP surface agrees with.
			for (const [id, hits] of entryPointHits(root, entries, traceFile)) {
				next.set(id, hits);
			}
			for (const e of summary.endpoints ?? []) {
				next.set(e.id, e.trace_count);
			}
			counts = next;
			// Latency and outcome are read from the SAME captures the counts come
			// from, and through the same time window: a filtered range must narrow
			// the percentiles too, or the panel would show last week's p95 beside
			// this minute's hit count.
			stats = readUnitStats(root, entries, traceFile);
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

	// Unguarded, this rejection escaped the command: the first post() never ran
	// and the webview kept its "Loading…" placeholder for the life of the tab,
	// with the reason — usually a missing code index — visible nowhere.
	try {
		entries = readUnitInventory(root, await loadEntryPoints(context, root));
	} catch (e) {
		loadError = e instanceof Error ? e.message : String(e);
		entries = readUnitInventory(root, readEntryPoints(root));
	}
	post();
	void pollOnce();
}

/** Exported for the webview render tests (the script is evaluated headless). */
export function getTracesHtml(): string {
	return html();
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
body { --warn: #b45309; }
body.vscode-dark, body.vscode-high-contrast:not(.vscode-high-contrast-light) { --warn: #d29922; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; font-size: 10px; letter-spacing: .18em; text-transform: uppercase;
     color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line-strong); padding: 7px 8px;
     white-space: nowrap; }
th.num { text-align: right; }
td { border-bottom: 1px solid var(--line); padding: 7px 8px; vertical-align: middle; }
tr.row { cursor: pointer; }
tr.row:hover td { background: var(--bg-2); }
tr.cold td { color: var(--muted); }
.trigger { color: var(--ink); }
.file { color: var(--muted); font-size: 10px; }
.handler { color: var(--muted); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.count.hit { color: var(--accent-fg); }
.kind { font-size: 9px; letter-spacing: .18em; text-transform: uppercase; color: var(--muted);
        border: 1px solid currentColor; padding: 1px 6px; white-space: nowrap; }
.dash { color: var(--muted); }
/* Coverage reads as a bar first and a number second — the shape of "most of
   this never ran" is the point, and 12/40 does not carry it at a glance. */
.cov { display: flex; align-items: center; gap: 7px; justify-content: flex-end; }
.bar-t { width: 46px; height: 4px; background: var(--line); position: relative; flex: none; }
.bar-t i { position: absolute; inset: 0 auto 0 0; background: var(--ok-fg); }
.bar-t.low i { background: var(--accent-fg); }
.bar-t.mid i { background: var(--warn); }
.bar-t.traced i { opacity: .55; }
.chip { font-variant-numeric: tabular-nums; padding: 1px 5px; border: 1px solid currentColor;
        margin-right: 4px; font-size: 10px; white-space: nowrap; }
.chip.ok { color: var(--ok-fg); }
.chip.warn { color: var(--warn); }
.chip.bad { color: var(--accent-fg); }
.slow { color: var(--warn); }
.err { color: var(--accent-fg); }
.act { text-align: right; white-space: nowrap; }
button.tree { background: transparent; color: var(--ink); border: 1px solid var(--line-strong);
  border-radius: 0; padding: 3px 9px; font-family: ${VINV_FONT_MONO}; font-size: 10px;
  letter-spacing: .1em; text-transform: uppercase; cursor: pointer; }
button.tree:hover { border-color: var(--accent-fg); color: var(--accent-fg); }
.legend { color: var(--muted); font-size: 10px; margin: 10px 0 0; line-height: 1.7; }
.empty { color: var(--muted); padding: 24px 0; }
</style></head>
<body><div class="wrap">
<h1>Traced entry points</h1>
<div class="bar">
  <input id="q" type="text" placeholder="Filter entry points…" autocomplete="off">
  <select id="range"><option value="">All time</option></select>
</div>
<div id="out"><div class="empty">Loading…</div></div>
<p class="legend">Every column is read from the tracelens captures, for every kind of unit: hits are the entry point's own invocations, P50/P95 the duration of those invocations, and Outcome whether they returned or raised. Coverage is how much of the unit's call tree the captures executed. A time filter narrows all of them together. Outcome is not HTTP status codes — a capture records that a span returned or raised, which is a fact about a CLI run and a driven function too.</p>
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
  if (!rows.length) { out.innerHTML = '<div class="empty">No entry points match.</div>'; return; }
  // The unit differs by kind and the column cannot show both, so each cell
  // says which one it is: a route counts requests, everything else counts the
  // times its own handler ran (one CLI run, one worker task, one script).
  const unit = (r) => r.kind === 'http_api'
    ? 'Distinct traced requests that reached this endpoint'
    : 'Times this entry point ran in the captures (its handler entered ' + r.count + '×)';
  const dash = '<span class="dash">—</span>';
  const ms = (v) => v === undefined || v === null ? dash
    : (v >= 1000 ? (Math.round(v / 100) / 10) + 's' : Math.round(v) + 'ms');
  function cov(r) {
    if (r.coveragePct === undefined || r.coveragePct === null) return dash;
    const pct = Math.max(0, Math.min(100, r.coveragePct));
    const band = pct >= 70 ? '' : (pct >= 35 ? ' mid' : ' low');
    return '<span class="cov" title="' + esc(r.coverageText +
      ' symbols of this unit\\'s call tree executed in the captures') + '">' +
      '<span class="bar-t' + band + '"><i style="width:' + pct + '%"></i></span>' +
      pct + '%</span>';
  }
  // The capture's own verdict per invocation. Not HTTP status codes: tracelens
  // records whether a span returned or raised (and with what), not the response
  // code a framework wrote — and this column has to mean the same thing for a
  // CLI run and a driven function as it does for a route.
  function outcome(r) {
    if (r.ok === undefined && r.raised === undefined) return dash;
    const ok = r.ok || 0, raised = r.raised || 0;
    let out = '';
    if (ok) out += '<span class="chip ok" title="Invocations that returned normally">ok ×' + ok + '</span>';
    if (raised) {
      const types = (r.errorTypes || []).join(', ');
      out += '<span class="chip bad" title="' + esc('Invocations that raised' + (types ? ': ' + types : '')) +
        '">raised ×' + raised + '</span>';
    }
    return out || dash;
  }
  out.innerHTML = '<table><thead><tr>' +
    '<th>Entry point</th><th>Kind</th><th>Handler</th>' +
    '<th class="num" title="How often this ran: requests for HTTP routes, invocations for everything else">Hits</th>' +
    '<th class="num" title="Symbols of this unit\\'s call tree that executed">Coverage</th>' +
    '<th class="num" title="Median duration of this unit\\'s own invocations, from the captured spans">P50</th>' +
    '<th class="num" title="95th-percentile duration — the slow tail users actually feel">P95</th>' +
    '<th title="How the captured invocations ended: returned, or raised (with the exception type)">Outcome</th>' +
    '<th class="num" title="Runtime errors raised anywhere under this unit\\'s call tree">Errors</th>' +
    '<th></th></tr></thead><tbody>' +
    rows.map(r => '<tr class="row' + (r.count > 0 ? '' : ' cold') + '" data-id="' + esc(r.id) + '" data-label="' + esc(r.trigger) + '">' +
      '<td class="trigger">' + esc(r.trigger) + '<div class="file">' + esc(r.file) + '</div></td>' +
      '<td><span class="kind">' + esc(r.kind.replace(/_/g, ' ')) + '</span></td>' +
      '<td class="handler">' + esc(r.handler || '—') + '</td>' +
      '<td class="num count' + (r.count > 0 ? ' hit' : '') + '" title="' + esc(unit(r)) + '">' + r.count + '</td>' +
      '<td class="num">' + cov(r) + '</td>' +
      '<td class="num">' + ms(r.p50) + '</td>' +
      '<td class="num' + (r.p95 >= 1000 ? ' slow' : '') + '">' + ms(r.p95) + '</td>' +
      '<td>' + outcome(r) + '</td>' +
      '<td class="num' + (r.errors > 0 ? ' err' : '') + '">' + (r.errors === undefined ? dash : r.errors) + '</td>' +
      '<td class="act"><button class="tree" title="' +
        esc(r.built ? 'Open the call tree with its runtime overlay' : 'Build and open the call tree for this unit') +
        '">Call tree</button></td>' +
      '</tr>').join('') +
    '</tbody></table>';
  const open = (tr) => vscode.postMessage({ type: 'open', id: tr.dataset.id, label: tr.dataset.label });
  out.querySelectorAll('tr.row').forEach(tr => {
    tr.addEventListener('click', () => open(tr));
    // The button is the discoverable affordance; the row stays clickable so the
    // habit from the old list still works. stopPropagation keeps one click from
    // firing both.
    tr.querySelector('button.tree').addEventListener('click', (ev) => { ev.stopPropagation(); open(tr); });
  });
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
  // An empty list with a reason is actionable; an empty list without one reads
  // as a broken panel. The engine's own sentence names the missing piece (most
  // often the code index) far better than any wording invented here.
  if (!ROWS.length && m.error) {
    out.innerHTML = '<div class="empty">No entry points could be listed.<br><br>' + esc(m.error) + '</div>';
    return;
  }
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
