/**
 * Optimization report — the full-page counterpart to the sidebar Optimize
 * panel. A file-backed custom editor over .vinv/reports/optimization.json (the
 * same pattern as the graph explorer / findings), so the tab's backing file is
 * the machine-readable mirror the OptimizationSource already writes and can be
 * dragged / @-referenced into chat.
 *
 * The sidebar view is the ambient, always-visible backlog + nudge; this tab is
 * where the evidence lives — recoverable-time ranking, and for every dispatched
 * hotspot the predicted→proven verdict drawn on a shared ms axis (predicted bar
 * vs measured drop, with the trace's own noise band). It reads the live model
 * straight from the source singleton when present, and falls back to the
 * backing file when the tab is opened before activation has wired the source.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VINV_BASE_CSS, VINV_FONT_SERIF } from './webviewTheme';
import { openPathInEditor } from '../support/openDocument';
import {
	optimizationSourceInstance,
	optimizationFilePath,
	type OptimizationModel,
} from './optimizationSource';
import type { OptimizationCandidate } from '../harness/optimizationAnalysis';

export const OPTIMIZATION_REPORT_VIEW_TYPE = 'vinv.optimizationReport';

/**
 * Whether the Optimize report has been on screen at any point this session
 * (opened via command/rail button, or restored with the window). The ambient
 * surfaces (status bar line, once-per-session nudge) only speak while this is
 * false — a user who has already seen the report needs no pointer to it.
 */
let openedThisSession = false;

export function optimizeReportOpenedThisSession(): boolean {
	return openedThisSession;
}

/** Messages the report webview sends back to the extension. */
export interface OptimizationReportOutbound {
	type: 'optimize' | 'openSource' | 'measure';
	row?: number;
	file?: string;
	line?: number;
}

/** Side effects a report message can trigger, injected so routing is testable. */
export interface OptimizationReportActions {
	optimize: (row: number) => Promise<void>;
	openSource: (file: string | undefined, line?: number) => Promise<void>;
	/** Re-run the flow under tracing so the after-run can be measured. */
	measure: () => Promise<void>;
}

/** Routes one report webview message to its side effect. */
export async function handleOptimizationReportMessage(
	msg: OptimizationReportOutbound,
	actions: OptimizationReportActions,
): Promise<void> {
	if (msg.type === 'optimize' && typeof msg.row === 'number') {
		await actions.optimize(msg.row);
	} else if (msg.type === 'openSource') {
		await actions.openSource(msg.file, msg.line);
	} else if (msg.type === 'measure') {
		await actions.measure();
	}
}

/** Opens (creating the backing file if needed) the full-page report tab. */
export async function openOptimizationReport(workspaceRoot: string): Promise<void> {
	const backing = optimizationFilePath(workspaceRoot);
	try {
		fs.mkdirSync(path.dirname(backing), { recursive: true });
		if (!fs.existsSync(backing)) {
			fs.writeFileSync(backing, JSON.stringify({ updated_at: '', candidates: [] }, null, 2), 'utf8');
		}
	} catch {
		// The editor's own read surfaces real failures.
	}
	await vscode.commands.executeCommand(
		'vscode.openWith',
		vscode.Uri.file(backing),
		OPTIMIZATION_REPORT_VIEW_TYPE,
		vscode.ViewColumn.Active,
	);
}

export class OptimizationReportEditorProvider implements vscode.CustomReadonlyEditorProvider {
	public static register(_context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			OPTIMIZATION_REPORT_VIEW_TYPE,
			new OptimizationReportEditorProvider(),
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
		// Every path to the report lands here (command, rail button, restored tab).
		openedThisSession = true;
		// .vinv/reports/optimization.json → workspace root is two dirs up.
		const workspaceRoot = path.resolve(path.dirname(document.uri.fsPath), '..', '..');
		const wiring = wireReport(workspaceRoot, document.uri.fsPath, webviewPanel.webview);
		webviewPanel.onDidDispose(() => wiring.dispose());
	}
}

/** Reads the mirror file into a model when the live source is unavailable. */
function readModelFromDisk(backingPath: string): OptimizationModel {
	try {
		const parsed = JSON.parse(fs.readFileSync(backingPath, 'utf8')) as {
			updated_at?: string;
			candidates?: OptimizationCandidate[];
		};
		const candidates = parsed.candidates ?? [];
		return { updatedAt: parsed.updated_at ?? '', hasTrace: candidates.length > 0, candidates };
	} catch {
		return { updatedAt: '', hasTrace: false, candidates: [] };
	}
}

function wireReport(
	workspaceRoot: string,
	backingPath: string,
	webview: vscode.Webview,
): vscode.Disposable {
	webview.options = { enableScripts: true };
	webview.html = getReportHtml();

	const post = (model: OptimizationModel): void => {
		void webview.postMessage({ type: 'model', model });
	};

	// Prefer the live source (instant updates, no re-read); fall back to the
	// mirror file, watched for changes, when the source is not up yet.
	const source = optimizationSourceInstance();
	const disposables: vscode.Disposable[] = [];
	if (source) {
		post(source.getModel());
		disposables.push(source.onDidChange(post));
	} else {
		post(readModelFromDisk(backingPath));
		const watcher = vscode.workspace.createFileSystemWatcher(backingPath);
		const reread = (): void => post(readModelFromDisk(backingPath));
		disposables.push(watcher, watcher.onDidChange(reread), watcher.onDidCreate(reread));
	}

	const actions: OptimizationReportActions = {
		optimize: async (row) => {
			await vscode.commands.executeCommand('vinv-vs.optimizeHotspot', row);
		},
		openSource: async (file, line) => {
			await openPathInEditor(file, {
				workspaceRoot,
				line: line ?? 1,
				label: 'source file',
				preview: true,
				viewColumn: vscode.ViewColumn.Beside,
			});
		},
		measure: async () => {
			await vscode.commands.executeCommand('vinv-vs.measureOptimization');
		},
	};

	disposables.push(
		webview.onDidReceiveMessage((msg: OptimizationReportOutbound | { type: 'webviewError' }) => {
			if (msg.type === 'webviewError') {
				return;
			}
			return handleOptimizationReportMessage(msg, actions);
		}),
	);

	return {
		dispose(): void {
			for (const d of disposables) {
				d.dispose();
			}
		},
	};
}

/** Exported for the standalone browser harness (visual verification). */
export function getOptimizationReportHtml(): string {
	return getReportHtml();
}

function getReportHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Vinv Optimize</title>
	<style>
		${VINV_BASE_CSS}
		body { padding: 18px 22px 40px; font-size: 12.5px; }
		header { border-bottom: 1px solid var(--line); margin-bottom: 14px; padding-bottom: 12px; }
		h1 { font-family: ${VINV_FONT_SERIF}; font-style: italic; font-weight: 400; font-size: 24px; line-height: 1.1; margin: 0 0 6px; }
		.meta { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-top: 12px; }
		.tile { border: 1px solid var(--line-strong); padding: 10px 12px; background: var(--bg-2); }
		.tile .k { color: var(--muted); font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; }
		.tile .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
		.tile .v small { font-size: 11px; font-weight: 400; color: var(--muted); }
		.tile.hot .v { color: var(--accent-fg); }
		.tile.good .v { color: var(--ink); }
		h2 { font-size: 10px; font-weight: 400; letter-spacing: 0.24em; text-transform: uppercase; color: var(--muted); margin: 24px 0 12px; padding-top: 12px; border-top: 1px solid var(--ink); display: inline-block; }
		h2::before { content: '// '; color: var(--accent-fg); }
		.row { border: 1px solid var(--line-strong); padding: 12px 14px; margin-bottom: 10px; }
		.row.working { border-color: var(--accent-fg); }
		.row.proven { border-left: 3px solid var(--ink); }
		.row.regressed { border-left: 3px solid var(--accent-fg); }
		.rhd { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
		.rhd .nm { font-weight: 600; font-size: 14px; }
		.rhd .loc { color: var(--muted-2); font-size: 10.5px; }
		.rhd .pred { margin-left: auto; color: var(--accent-fg); font-weight: 600; }
		.rhd .pred small { font-weight: 400; font-size: 10px; color: var(--muted); }
		.tag { font-size: 8.5px; letter-spacing: 0.16em; text-transform: uppercase; padding: 2px 6px; border: 1px solid var(--line-strong); color: var(--muted); }
		.tag.cache { color: var(--ink); border-color: var(--ink); }
		.why { color: var(--muted); font-size: 11.5px; margin: 8px 0 10px; line-height: 1.55; }
		/* predicted vs measured, on one ms axis */
		.axis { margin: 8px 0 10px; }
		.axis .lab { display: flex; justify-content: space-between; color: var(--muted-2); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 3px; }
		.bar { position: relative; height: 9px; background: var(--bg-2); border: 1px solid var(--line-strong); margin-bottom: 4px; }
		.bar span { position: absolute; left: 0; top: 0; bottom: 0; }
		.bar .predicted { background: var(--muted-2); }
		.bar .measured { background: var(--ink); }
		.bar .measured.bad { background: var(--accent); }
		.verdict { padding: 8px 10px; border: 1px solid var(--line); margin: 2px 0 10px; line-height: 1.55; }
		.verdict.proven { border-color: var(--ink); }
		.verdict.regressed { border-color: var(--accent-fg); color: var(--accent-fg); }
		.verdict b { letter-spacing: 0.02em; }
		.acts { display: flex; gap: 8px; flex-wrap: wrap; }
		.acts button { padding: 6px 13px; cursor: pointer; border-radius: 0; font-family: inherit; font-size: 9px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; transition: background 0.2s, color 0.2s, border-color 0.2s; }
		.acts .go { background: var(--accent); border: 1px solid var(--accent); color: #ffffff; }
		.acts .go:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
		.acts .code { background: transparent; border: 1px solid var(--line-strong); color: var(--ink); }
		.acts .code:hover { border-color: var(--ink); }
		.working-note { align-self: center; color: var(--accent-fg); font-size: 11px; }
		.empty { color: var(--muted); font-size: 12px; line-height: 1.6; padding: 8px 0; max-width: 60ch; }
		.hint { color: var(--muted-2); font-size: 10.5px; margin-top: 20px; }
	</style>
</head>
<body>
	<header>
		<h1>Optimize</h1>
		<div class="meta">RECOVERABLE TIME · PREDICTED → PROVEN</div>
		<div class="tiles" id="tiles"></div>
	</header>
	<div id="content"><div class="empty">Loading…</div></div>

	<script>
		const vscode = acquireVsCodeApi();
		window.addEventListener('error', (e) => vscode.postMessage({ type: 'webviewError', message: String(e.message || 'unknown') }));
		const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		const ms = (n) => Math.round(n) + 'ms';
		const KIND = { 'cache': 'cache', 'fanout': 'fan-out', 'per-call': 'per-call', 'n-plus-1': 'N+1', 'serial-async': 'async' };
		// Plain-language description behind each waste-kind tag, so the label
		// reads cold without knowing the analyzer's vocabulary.
		const KIND_TIP = {
			'cache': 'The same work runs again and again with the same inputs — remembering the first result and reusing it would skip the repeats.',
			'fanout': 'One call sets off many downstream calls; trimming or batching them recovers the time.',
			'per-call': 'Each individual call is slow in its own body — the cost is in this function, not in what it calls.',
			'n-plus-1': 'The same lookup repeats once per item in a list instead of once for the whole list.',
			'serial-async': 'Independent waits run one after another when they could overlap.',
		};
		// Direction of a measured delta (after − before): negative = faster.
		const dir = (delta) => delta == null ? '' : (delta < 0 ? ' faster' : (delta > 0 ? ' slower' : ''));
		// Micro-glossary: every statistical term on a card carries a plain-language
		// tooltip (mirrors the existing inconclusive sentence's honesty).
		const GLOSS = {
			noise: 'Noise band: how much this timing naturally wobbles between identical runs of the same code. A change inside the band cannot be told apart from noise, so no claim is made either way.',
			ci: '95% confidence interval from a paired bootstrap: the same frozen request set is replayed before and after the change, and the interval is the range of plausible true speedups given trace noise. A speedup only counts when the whole interval is on the faster side of zero.',
			self: 'Self time: milliseconds spent in this function&#39;s own body, not in the functions it calls. A symbol with a big total but near-zero self time is a delegator — its cost lives in its callees.',
			predicted: 'Predicted recoverable time: an estimate of how much of this symbol&#39;s measured cost a fix could remove. It sets the expectation and the ranking; the measured after-run is the truth.',
		};
		const gloss = (txt, key) => '<span title="' + GLOSS[key] + '">' + txt + '</span>';
		// Amdahl ceiling badge — rendered only when the analyzer supplied the
		// optional amdahl_ceiling field (feature-detected, never required).
		function ceilingTag(c) {
			const raw = c.amdahl_ceiling;
			if (typeof raw !== 'number' || !isFinite(raw) || raw < 0) { return ''; }
			const p = raw > 1 ? raw : raw * 100;
			return '<span class="tag" title="Amdahl ceiling: this symbol is only one part of the whole flow, so even a perfect fix cannot speed the end-to-end flow up by more than this share.">whole-flow ceiling ≤' + (p < 10 ? p.toFixed(1) : String(Math.round(p))) + '%</span>';
		}

		function tiles(cands) {
			const open = cands.filter((c) => c.status === 'candidate');
			const proven = cands.filter((c) => c.status === 'proven');
			const working = cands.filter((c) => c.status === 'dispatched');
			const recoverable = open.reduce((s, c) => s + c.predicted_ms, 0);
			const saved = proven.reduce((s, c) => s + Math.abs((c.outcome || {}).delta_ms || 0), 0);
			const t = [
				{ k: 'Open opportunities', v: open.length, hot: open.length > 0 },
				{ k: 'Recoverable (predicted)', v: '~' + ms(recoverable) },
				{ k: 'In progress', v: working.length },
				{ k: 'Proven saved', v: ms(saved), good: saved > 0 },
			];
			document.getElementById('tiles').innerHTML = t.map((x) =>
				'<div class="tile' + (x.hot ? ' hot' : '') + (x.good ? ' good' : '') + '"><div class="k">' + x.k + '</div><div class="v">' + x.v + '</div></div>').join('');
		}

		function axis(c, scale) {
			const o = c.outcome || {};
			const predW = Math.max(1, (c.predicted_ms / scale) * 100);
			let html = '<div class="axis"><div class="lab"><span>' + gloss('predicted ~' + ms(c.predicted_ms), 'predicted') + '</span>';
			const measured = o.delta_ms != null ? Math.abs(o.delta_ms) : null;
			if (measured != null) { html += '<span>measured ' + ms(measured) + dir(o.delta_ms) + '</span>'; }
			html += '</div>';
			html += '<div class="bar"><span class="predicted" style="width:' + predW + '%"></span></div>';
			if (measured != null) {
				const bad = c.status !== 'proven';
				html += '<div class="bar"><span class="measured' + (bad ? ' bad' : '') + '" style="width:' + Math.max(1, (measured / scale) * 100) + '%"></span></div>';
			}
			html += '</div>';
			return html;
		}

		function verdict(c) {
			const o = c.outcome || {};
			const pc = (v) => (v * 100).toFixed(1) + '%';
			const ciNote = o.ci
				? ' ' + gloss('Paired-bootstrap: ' + pc(o.ci.rel_improvement) + ' (95% CI [' + pc(o.ci.ci_low) + ', ' + pc(o.ci.ci_high) + ']) over the frozen probe set.', 'ci')
				: '';
			// What ACTUALLY happened to the change. reverted true/false is the
			// verdict engine reporting a real rollback / a real keep; undefined
			// means the watcher-only fallback judged from session timings — that
			// path never touches the working tree, so we must say so instead of
			// claiming a revert that never ran.
			const kept = o.reverted === true
				? ' The change was reverted to the pre-episode snapshot.'
				: (o.reverted === false ? ' The change was kept.' : '');
			const noAutoRevert = ' No automatic revert ran — this verdict came from the capture watcher (session timings, no managed episode), so the change is still in your working tree; review it and revert it yourself if unwanted.';
			if (c.status === 'proven') {
				return '<div class="verdict proven"><b>Proven ' + ms(Math.abs(o.delta_ms || 0)) + ' faster</b> — predicted ~' + ms(o.predicted_ms || 0) +
					(o.ci ? '.' : ', measured beyond the ±' + ms(o.noise_band_ms || 0) + ' ' + gloss('noise band', 'noise') + '.') + ' Behavior unchanged.' + ciNote + kept + '</div>';
			}
			if (c.status === 'regressed') {
				const broke = o.behavior_ok === false;
				return '<div class="verdict regressed"><b>' + (broke ? 'Regressed — behavior changed' : 'Regressed ' + ms(Math.abs(o.delta_ms || 0)) + dir(o.delta_ms)) + '</b> — ' +
					(broke ? 'the after-run no longer answered identically.' : (o.ci ? 'the after-run was significantly slower.' : 'the after-run was slower beyond the ' + gloss('noise band', 'noise') + '.')) +
					ciNote + (kept || noAutoRevert) + '</div>';
			}
			if (c.status === 'inconclusive') {
				return '<div class="verdict"><b>Inconclusive</b> — ' +
					(o.ci ? 'no significant speedup (the ' + gloss('95% CI', 'ci') + ' includes zero or the effect is below 10%), so no honest claim can be made.'
						: 'the change landed inside the ±' + ms(o.noise_band_ms || 0) + ' ' + gloss('noise band', 'noise') + ', so no honest speedup can be claimed.') +
					ciNote + (kept || noAutoRevert) + '</div>';
			}
			return '';
		}

		function card(c, scale) {
			const cls = c.status === 'dispatched' ? 'working' : (c.status === 'proven' ? 'proven' : (c.status === 'regressed' ? 'regressed' : ''));
			let h = '<div class="row ' + cls + '">';
			h += '<div class="rhd"><span class="nm">' + esc(c.name) + '</span>' +
				'<span class="tag ' + esc(c.waste_kind) + '"' + (KIND_TIP[c.waste_kind] ? ' title="' + KIND_TIP[c.waste_kind] + '"' : '') + '>' + (KIND[c.waste_kind] || esc(c.waste_kind)) + '</span>' +
				ceilingTag(c) +
				'<span class="loc">' + esc(c.file) + ':' + c.line + ' · ' + ms(c.total_ms) + ' across ' + c.calls + ' call(s)' + (c.self_ms != null ? ' · ' + gloss(ms(c.self_ms) + ' self', 'self') : '') + '</span>' +
				'<span class="pred" title="' + GLOSS.predicted + '">~' + ms(c.predicted_ms) +
				(typeof c.predicted_ms_effective === 'number' && isFinite(c.predicted_ms_effective) ? ' <small>≈' + ms(c.predicted_ms_effective) + ' whole-flow</small>' : '') +
				'</span></div>';
			h += '<div class="why">' + esc(c.reason) + '</div>';
			h += axis(c, scale);
			h += verdict(c);
			h += '<div class="acts">';
			if (c.status === 'dispatched') {
				h += '<button class="go" data-measure="1">Measure now</button>';
				h += '<span class="working-note">Sent to the agent. When it has finished, click <b>Measure now</b> to re-trace the same flow — the measured before/after then appears here.</span>';
			} else {
				h += '<button class="go" data-opt="' + c.row + '">' + (c.status === 'candidate' ? 'Optimize' : 'Optimize again') + '</button>';
			}
			h += '<button class="code" data-file="' + esc(c.file) + '" data-line="' + c.line + '">See code</button>';
			h += '</div></div>';
			return h;
		}

		function render(model) {
			const cands = model.candidates || [];
			tiles(cands);
			const content = document.getElementById('content');
			if (!model.hasTrace || cands.length === 0) {
				content.innerHTML = '<div class="empty">No optimizable hotspots yet. Run a service under Vinv and exercise it — traced symbols with removable overhead (duplicate work, loops, slow calls) appear here, ranked by the time a fix would recover, each with a one-click optimize that is verified by re-tracing.</div>';
				return;
			}
			const scale = Math.max(1, ...cands.map((c) => Math.max(c.predicted_ms, Math.abs((c.outcome || {}).delta_ms || 0))));
			let html = '<h2>Opportunities (' + cands.length + ')</h2>';
			for (const c of cands) { html += card(c, scale); }
			html += '<div class="hint">Machine-readable copy: .vinv/reports/optimization.json (this tab\\'s backing file).</div>';
			content.innerHTML = html;
			content.querySelectorAll('button[data-opt]').forEach((b) =>
				b.addEventListener('click', () => vscode.postMessage({ type: 'optimize', row: Number(b.getAttribute('data-opt')) })));
			content.querySelectorAll('button[data-file]').forEach((b) =>
				b.addEventListener('click', () => vscode.postMessage({ type: 'openSource', file: b.getAttribute('data-file'), line: Number(b.getAttribute('data-line')) })));
			content.querySelectorAll('button[data-measure]').forEach((b) =>
				b.addEventListener('click', () => vscode.postMessage({ type: 'measure' })));
		}

		window.addEventListener('message', (event) => {
			if (event.data && event.data.type === 'model') { render(event.data.model); }
		});
	</script>
</body>
</html>`;
}
