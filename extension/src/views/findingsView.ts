/**
 * Findings view — "what Vinv found and fixed", rendered for humans; the same
 * data lands in .vinv/reports/findings.json for agents. File-backed custom
 * editor over that summary file (same pattern as call trees / journey), so
 * the machine surface and the tab's backing file are one and the same.
 *
 * Sections: headline tiles → issue clusters → optimization episodes (each
 * attempt drawn with its paired-bootstrap 95% CI on a signed axis; accepted
 * episodes show the exact evidence that cleared the bar) → regression replay
 * (kinds breakdown + history) → per-endpoint latency profile (p50/p95 bars)
 * → state-pollution ledger → detected opportunities awaiting episodes.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VINV_BASE_CSS, VINV_FONT_SERIF } from './webviewTheme';
import { buildFindings, writeFindingsSummary } from './findingsModel';
import { openPathInEditor } from '../support/openDocument';

export const FINDINGS_VIEW_TYPE = 'vinv.findings';

export interface FindingsOutbound {
	type: 'openSource' | 'refresh';
	file?: string;
	line?: number;
}

export interface FindingsActions {
	openSource: (file: string | undefined, line?: number) => Promise<void>;
	refresh: () => Promise<void>;
}

export async function handleFindingsMessage(
	msg: FindingsOutbound,
	actions: FindingsActions,
): Promise<void> {
	if (msg.type === 'openSource') {
		await actions.openSource(msg.file, msg.line);
	} else if (msg.type === 'refresh') {
		await actions.refresh();
	}
}

function backingFile(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'findings.json');
}

export async function openFindings(workspaceRoot: string): Promise<void> {
	const backing = backingFile(workspaceRoot);
	try {
		fs.mkdirSync(path.dirname(backing), { recursive: true });
		if (!fs.existsSync(backing)) {
			fs.writeFileSync(backing, JSON.stringify({ pending: true }, null, 2), 'utf8');
		}
	} catch {
		// editor read surfaces real failures
	}
	await vscode.commands.executeCommand(
		'vscode.openWith',
		vscode.Uri.file(backing),
		FINDINGS_VIEW_TYPE,
		vscode.ViewColumn.Active,
	);
}

export class FindingsEditorProvider implements vscode.CustomReadonlyEditorProvider {
	public static register(_context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			FINDINGS_VIEW_TYPE,
			new FindingsEditorProvider(),
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
		const workspaceRoot = path.resolve(path.dirname(document.uri.fsPath), '..', '..');
		const wiring = wireFindings(workspaceRoot, webviewPanel.webview);
		webviewPanel.onDidDispose(() => wiring.dispose());
	}
}

function wireFindings(workspaceRoot: string, webview: vscode.Webview): vscode.Disposable {
	webview.options = { enableScripts: true };
	webview.html = getHtml();

	let disposed = false;
	const push = async (): Promise<void> => {
		const findings = buildFindings(workspaceRoot);
		if (disposed) {
			return;
		}
		void webview.postMessage({ type: 'findings', findings });
		try {
			writeFindingsSummary(workspaceRoot, findings);
		} catch {
			// summary lags; the view is current
		}
	};

	const actions: FindingsActions = {
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
	};

	const sub = webview.onDidReceiveMessage((msg: FindingsOutbound | { type: 'webviewError' }) => {
		if (msg.type === 'webviewError') {
			return;
		}
		return handleFindingsMessage(msg, actions);
	});
	void push();

	return {
		dispose(): void {
			disposed = true;
			sub.dispose();
		},
	};
}

/** Exported for the standalone browser harness (visual verification). */
export function getFindingsHtml(): string {
	return getHtml();
}

function getHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Vinv Findings</title>
	<style>
		${VINV_BASE_CSS}
		body { padding: 18px 20px; font-size: 12.5px; }
		header { border-bottom: 1px solid var(--line); margin-bottom: 14px; padding-bottom: 12px; }
		h1 { font-family: ${VINV_FONT_SERIF}; font-style: italic; font-weight: 400;
			font-size: 24px; line-height: 1.1; margin: 0 0 6px; }
		.meta { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
			gap: 10px; margin-top: 12px; }
		.tile { border: 1px solid var(--line-strong); padding: 10px 12px; background: var(--bg-2); }
		.tile .k { color: var(--muted); font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; }
		.tile .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
		.tile .v small { font-size: 11px; font-weight: 400; color: var(--muted); }
		.tile.hot .v { color: var(--accent-fg); }
		h2 { font-size: 10px; font-weight: 400; letter-spacing: 0.24em; text-transform: uppercase;
			color: var(--muted); margin: 22px 0 10px; padding-top: 12px;
			border-top: 1px solid var(--ink); display: inline-block; }
		h2::before { content: '// '; color: var(--accent-fg); }
		table { border-collapse: collapse; width: 100%; font-size: 11px; }
		th { text-align: left; font-weight: 400; color: var(--muted); font-size: 9.5px;
			letter-spacing: 0.18em; text-transform: uppercase; padding: 4px 10px 4px 0;
			border-bottom: 1px solid var(--line-strong); }
		td { padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
		.badge { font-size: 9px; padding: 1px 6px; letter-spacing: 0.16em; text-transform: uppercase;
			border: 1px solid currentColor; color: var(--muted-2); white-space: nowrap; }
		.badge.accept { background: var(--ink); border-color: var(--ink); color: var(--bg); }
		.badge.revert { color: var(--accent-fg); }
		.badge.env { color: var(--muted); }
		.epi { border: 1px solid var(--line-strong); padding: 10px 12px; margin-bottom: 10px; }
		.epi .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.epi .label { font-weight: 600; }
		.epi .why { color: var(--muted); font-size: 11px; margin-top: 4px; }
		.epi .files { color: var(--muted-2); font-size: 10.5px; margin-top: 4px; }
		.att { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
		.att .ap { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 11px; }
		.att .suite { flex: none; font-size: 10px; }
		.att .suite.fail { color: var(--accent-fg); }
		.att .cin { flex: none; font-size: 10px; color: var(--muted); white-space: nowrap; }
		/* CI bar: signed axis, zero tick in the middle-ish; interval drawn as a
		   filled band, point estimate as a notch. Improvement = toward +. */
		.ci { flex: none; position: relative; width: 180px; height: 14px;
			background: var(--bg-2); border: 1px solid var(--line-strong); }
		.ci .zero { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line-strong); }
		.ci .band { position: absolute; top: 2px; bottom: 2px; }
		.ci .band.good { background: var(--ink); }
		.ci .band.bad { background: var(--accent); }
		.ci .pt { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent-fg); }
		.bar { position: relative; height: 8px; background: var(--bg-2);
			border: 1px solid var(--line-strong); min-width: 120px; }
		.bar span { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink); }
		.bar.hot span { background: var(--accent); }
		.spark { display: inline-flex; align-items: flex-end; gap: 2px; height: 26px; }
		.spark i { display: inline-block; width: 7px; background: var(--ink); }
		.spark i.env { background: var(--muted-2); }
		.empty { color: var(--muted); font-size: 11px; padding: 6px 0; }
		.hint { color: var(--muted-2); font-size: 10.5px; margin-top: 6px; }
	</style>
</head>
<body>
	<header>
		<h1>Findings</h1>
		<div class="meta">WHAT VINV FOUND · WHAT IT FIXED · THE EVIDENCE</div>
		<div class="tiles" id="tiles"></div>
	</header>
	<div id="content"><div class="empty">Assembling findings…</div></div>

	<script>
	const vscode = acquireVsCodeApi();
	window.addEventListener('error', (e) => vscode.postMessage({ type: 'webviewError', message: String(e.message || 'unknown') }));

	const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	const pct = (x) => (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%';

	function tiles(f) {
		const h = f.headline;
		const t = [
			{ k: 'Endpoint coverage', v: h.endpointsCovered + '<small>/' + h.endpointsTotal + '</small>' },
			{ k: 'Symbol coverage', v: h.symbolsCovered + '<small>/' + h.symbolsTotal + '</small>' },
			{ k: 'Issues found', v: h.issuesFound, hot: h.issuesFound > 0 },
			{ k: 'Optimizations accepted', v: h.episodesAccepted + '<small>/' + (h.episodesAccepted + h.episodesReverted) + ' episodes</small>' },
			{ k: 'Regression cases', v: h.regressCases + '<small> · ' + h.regressRealDiffs + ' real diffs</small>', hot: h.regressRealDiffs > 0 },
			{ k: 'State unwound', v: h.stateCleaned + '<small>/' + h.stateCreated + ' created</small>' },
		];
		document.getElementById('tiles').innerHTML = t.map((x) =>
			'<div class="tile' + (x.hot ? ' hot' : '') + '"><div class="k">' + x.k + '</div><div class="v">' + x.v + '</div></div>').join('');
	}

	function ciBar(a) {
		// Axis spans [-max, +max] where max covers the interval; zero always visible.
		if (a.ciLow == null || a.ciHigh == null) return '<span class="badge">no measurement</span>';
		const m = Math.max(Math.abs(a.ciLow), Math.abs(a.ciHigh), 0.05) * 1.15;
		const x = (v) => ((v + m) / (2 * m)) * 100;
		const good = a.ciLow > 0;
		return '<span class="ci" title="rel ' + pct(a.rel ?? 0) + ' · 95% CI [' + pct(a.ciLow) + ', ' + pct(a.ciHigh) + ']">' +
			'<span class="zero" style="left:' + x(0) + '%"></span>' +
			'<span class="band ' + (good ? 'good' : 'bad') + '" style="left:' + x(a.ciLow) + '%;width:' + Math.max(1.5, x(a.ciHigh) - x(a.ciLow)) + '%"></span>' +
			(a.rel != null ? '<span class="pt" style="left:' + x(a.rel) + '%"></span>' : '') +
			'</span>';
	}

	// The interval spelled out next to its bar, so the evidence is legible
	// without hovering (positive = faster).
	function ciText(a) {
		if (a.ciLow == null || a.ciHigh == null) return '';
		return '<span class="cin" title="Paired-bootstrap 95% confidence interval of the relative speedup over the frozen probe set; the claim only counts when the whole interval is above zero">' +
			pct(a.rel ?? 0) + ' [' + pct(a.ciLow) + ', ' + pct(a.ciHigh) + ']</span>';
	}

	function render(f) {
		tiles(f);
		let html = '';

		html += '<h2>Issue clusters (' + f.issues.length + ')</h2>';
		html += f.issues.length === 0 ? '<div class="empty">No behavioral failures clustered.</div>' : '';
		for (const i of f.issues) {
			html += '<div class="epi"><div class="head"><span class="badge revert">' + esc(i.kind) + '</span>' +
				'<span class="label">' + esc(i.title) + '</span></div>' +
				'<div class="files">signature ' + esc(i.signature) + '</div></div>';
		}

		html += '<h2>Optimization episodes (' + f.episodes.length + ')</h2>';
		if (f.episodes.length === 0) {
			html += '<div class="empty">No optimization episodes recorded yet. An episode is appended to .vinv/exercise/optimize.jsonl each time a verified optimization runs to a verdict — dispatched from the Optimize panel or report, or by the exerciser — and lands here with each attempt&#39;s paired-bootstrap CI, behavior-suite result, and whether the change was kept or reverted.</div>';
		}
		for (const e of f.episodes) {
			const cls = e.action === 'accept' ? 'accept' : 'revert';
			html += '<div class="epi"><div class="head">' +
				'<span class="badge ' + cls + '">' + esc(e.action) + '</span>' +
				'<span class="label">' + esc(e.label) + '</span>' +
				'<span class="badge">' + esc(e.opportunity.kind) + '</span></div>' +
				'<div class="why">' + esc(e.reason) + '</div>';
			e.attempts.forEach((a, i) => {
				html += '<div class="att">' +
					'<span class="badge' + (a.reverted ? ' revert' : ' accept') + '" title="' + (a.reverted ? 'This attempt&#39;s change was rolled back to the pre-episode snapshot' : 'This attempt&#39;s change stayed in the codebase') + '">' +
					(a.reverted ? 'reverted' : 'kept') + '</span>' +
					'<span class="ap">' + (e.attempts.length > 1 ? (i + 1) + '. ' : '') + esc(a.approach) + '</span>' +
					'<span class="suite' + (a.behaviorSuitePassed ? '' : ' fail') + '" title="' + (a.behaviorSuitePassed ? 'Every recorded behavior still byte/shape-identical after this change' : 'This change altered observable outputs — a faster-but-wrong result, so it was reverted no matter how big the speedup') + '">' +
					(a.behaviorSuitePassed ? 'suite ✓' : 'suite ✗') + '</span>' + ciBar(a) + ciText(a) + '</div>';
			});
			if (e.filesChanged.length) html += '<div class="files">changed: ' + e.filesChanged.map(esc).join(', ') + '</div>';
			html += '</div>';
		}

		if (f.opportunities.length) {
			html += '<h2>Detected opportunities awaiting episodes (' + f.opportunities.length + ')</h2>';
			for (const o of f.opportunities) {
				html += '<div class="epi"><div class="head"><span class="badge">' + esc(o.kind) + '</span>' +
					'<span class="label">' + esc(o.endpoint) + '</span></div>' +
					'<div class="why">' + esc(o.detail) + '</div></div>';
			}
		}

		html += '<h2>Regression replay</h2>';
		const r = f.regress.latest;
		if (!r) {
			html += '<div class="empty">No regress runs recorded yet.</div>';
		} else {
			html += '<div class="epi"><div class="head">' +
				'<span class="badge">' + r.cases + ' cases</span>' +
				'<span class="badge' + (r.behavior ? ' revert' : '') + '">behavior ' + r.behavior + '</span>' +
				'<span class="badge' + (r.contract ? ' revert' : '') + '">contract ' + r.contract + '</span>' +
				'<span class="badge' + (r.perf ? ' revert' : '') + '">perf ' + r.perf + '</span>' +
				'<span class="badge env" title="Differences caused by data the test engine itself planted in earlier runs (its own residue) — the world changed, not your code">environment ' + r.environment + '</span>' +
				(r.authSkipped ? '<span class="badge">auth skipped ' + r.authSkipped + '</span>' : '') + '</div>';
			for (const d of r.diffs) {
				html += '<div class="att"><span class="badge' + (d.kind === 'environment' ? ' env' : ' revert') + '">' + esc(d.kind) + '</span>' +
					'<span class="ap">' + esc(d.endpoint) + ' — ' + esc(d.detail) + '</span></div>';
			}
			if (f.regress.history.length > 1) {
				const hmax = Math.max(1, ...f.regress.history.map((x) => x.behavior + x.contract + x.perf + x.environment));
				html += '<div class="att"><span class="ap hint">real-diff history (newest right; grey = environment drift)</span><span class="spark">' +
					f.regress.history.map((x) => {
						const real = x.behavior + x.contract + x.perf;
						const env = x.environment;
						return '<i style="height:' + Math.max(2, (real / hmax) * 24) + 'px" title="' + real + ' real"></i>' +
							'<i class="env" style="height:' + Math.max(2, (env / hmax) * 24) + 'px" title="' + env + ' environment"></i>';
					}).join('') + '</span></div>';
			}
			html += '<div class="hint">environment = drift the engine attributed to its own planted state, not a code regression</div></div>';
		}

		html += '<h2>Latency profile per endpoint</h2>';
		const maxP95 = Math.max(1, ...f.endpoints.map((e) => e.p95Ms));
		html += '<table><tr><th>Endpoint</th><th>Coverage</th><th>p50</th><th>p95</th><th style="width:30%">p95 bar</th><th>Statuses</th></tr>';
		for (const e of f.endpoints) {
			const hot = e.p95Ms >= 200;
			html += '<tr><td>' + esc(e.endpoint) + (e.handlerObserved ? '' : ' <span class="badge" title="No request has reached this endpoint&#39;s handler function yet — usually it needs auth or a valid multi-step setup">handler unseen</span>') + '</td>' +
				'<td>' + esc(e.coverage) + '</td><td>' + e.p50Ms + 'ms</td><td' + (hot ? ' class="badge revert"' : '') + '>' + e.p95Ms + 'ms</td>' +
				'<td><span class="bar' + (hot ? ' hot' : '') + '"><span style="width:' + Math.max(1, (e.p95Ms / maxP95) * 100) + '%"></span></span></td>' +
				'<td>' + esc(Object.entries(e.statuses).map(([k, v]) => k + '×' + v).join(' ')) + '</td></tr>';
		}
		html += '</table>';

		html += '<h2>State ledger (' + f.state.cleaned + '/' + f.state.created + ' unwound)</h2>';
		if (f.state.rows.length === 0) {
			html += '<div class="empty">Nothing planted — or nothing recorded yet.</div>';
		} else {
			html += '<table><tr><th>Created via</th><th>Status</th></tr>';
			for (const row of f.state.rows) {
				html += '<tr><td>' + esc(row.endpoint) + '</td><td>' +
					(row.cleaned ? 'cleaned via ' + esc(row.via ?? '') : '<span class="badge env">uncleaned</span>') + '</td></tr>';
			}
			html += '</table>';
		}

		if (f.scenarios.expired && f.scenarios.expired.length) {
			html += '<h2>Expired scenarios</h2>';
			for (const s of f.scenarios.expired) {
				html += '<div class="epi"><div class="head"><span class="badge revert">expired</span>' +
					'<span class="label">' + esc(s.name) + '</span></div><div class="why">' + esc(s.reason) + '</div></div>';
			}
		}

		html += '<div class="hint">Machine-readable copy of everything above: .vinv/reports/findings.json (this tab\\'s backing file).</div>';
		document.getElementById('content').innerHTML = html;
	}

	window.addEventListener('message', (event) => {
		if (event.data.type === 'findings') render(event.data.findings);
	});
	</script>
</body>
</html>`;
}
