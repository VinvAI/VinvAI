/**
 * The Journey view — one place to walk everything Vinv verified, start to end:
 * services first, then every endpoint in order with its call tree, flamegraph,
 * runtime coverage, and the exact inputs/outputs the exerciser drove — with
 * prev/next navigation (buttons + arrow keys) and a form to add user-authored
 * inputs that feed straight into the exerciser's semantic plan layer.
 *
 * Same architecture as the call-tree view: a file-backed custom editor over
 * <root>/.vinv/reports/journey.json so the tab is a real file (draggable into
 * chat), message routing extracted into `handleJourneyMessage` for direct unit
 * testing, and data assembly delegated to the pure `journeyModel`.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VINV_BASE_CSS, VINV_FONT_SERIF } from './webviewTheme';
import { buildJourney, appendUserPlan, type Journey, type UserPlan } from './journeyModel';
import { openPathInEditor } from '../support/openDocument';

export const JOURNEY_VIEW_TYPE = 'vinv.journey';

/** Messages the journey webview sends back to the extension. */
export interface JourneyOutbound {
	type: 'openSource' | 'addInput' | 'refresh';
	file?: string;
	line?: number;
	apiId?: string;
	endpoint?: string;
	plan?: UserPlan;
}

/** Injected side effects so routing is testable without a live webview. */
export interface JourneyActions {
	openSource: (file: string | undefined, line?: number) => Promise<void>;
	addInput: (apiId: string, endpoint: string, plan: UserPlan) => Promise<number>;
	refresh: () => Promise<void>;
	notify: (message: string, isError: boolean) => void;
}

/**
 * Routes one journey webview message. `addInput` failures are surfaced via
 * `notify` with the validation message verbatim — a malformed plan must tell
 * the user what to fix, never silently drop their input.
 */
export async function handleJourneyMessage(
	msg: JourneyOutbound,
	actions: JourneyActions,
): Promise<void> {
	if (msg.type === 'openSource') {
		await actions.openSource(msg.file, msg.line);
	} else if (msg.type === 'refresh') {
		await actions.refresh();
	} else if (msg.type === 'addInput') {
		if (!msg.apiId || !msg.plan) {
			actions.notify('Add input: missing endpoint or plan.', true);
			return;
		}
		try {
			const count = await actions.addInput(msg.apiId, msg.endpoint ?? msg.apiId, msg.plan);
			actions.notify(
				`Input added (${count} authored plan${count === 1 ? '' : 's'} for this endpoint). ` +
					'The next exerciser run replays it.',
				false,
			);
			await actions.refresh();
		} catch (e) {
			actions.notify(e instanceof Error ? e.message : String(e), true);
		}
	}
}

function backingFile(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'journey.json');
}

/** Opens (creating if needed) the journey editor for a workspace. */
export async function openJourney(workspaceRoot: string): Promise<void> {
	const backing = backingFile(workspaceRoot);
	try {
		fs.mkdirSync(path.dirname(backing), { recursive: true });
		if (!fs.existsSync(backing)) {
			fs.writeFileSync(backing, JSON.stringify({ pending: true }, null, 2), 'utf8');
		}
	} catch {
		// Non-fatal: the editor surfaces a real failure on read.
	}
	await vscode.commands.executeCommand(
		'vscode.openWith',
		vscode.Uri.file(backing),
		JOURNEY_VIEW_TYPE,
		vscode.ViewColumn.Active,
	);
}

export class JourneyEditorProvider implements vscode.CustomReadonlyEditorProvider {
	public static register(_context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			JOURNEY_VIEW_TYPE,
			new JourneyEditorProvider(),
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
		// <root>/.vinv/reports/journey.json → <root>
		const workspaceRoot = path.resolve(path.dirname(document.uri.fsPath), '..', '..');
		const wiring = wireJourney(workspaceRoot, webviewPanel.webview);
		webviewPanel.onDidDispose(() => wiring.dispose());
	}
}

function wireJourney(workspaceRoot: string, webview: vscode.Webview): vscode.Disposable {
	webview.options = { enableScripts: true };
	webview.html = getHtml();

	let disposed = false;
	const backing = backingFile(workspaceRoot);

	const push = async (): Promise<void> => {
		const journey: Journey = buildJourney(workspaceRoot);
		if (disposed) {
			return;
		}
		void webview.postMessage({ type: 'journey', journey });
		try {
			fs.writeFileSync(backing, JSON.stringify(journey, null, 2), 'utf8');
		} catch {
			// referenceable snapshot lags; the view itself is current
		}
	};

	const actions: JourneyActions = {
		openSource: async (file, line) => {
			await openPathInEditor(file, {
				workspaceRoot,
				line: line ?? 1,
				label: 'source file',
				preview: true,
				viewColumn: vscode.ViewColumn.Beside,
			});
		},
		addInput: async (apiId, endpoint, plan) =>
			appendUserPlan(workspaceRoot, apiId, endpoint, plan),
		refresh: push,
		notify: (message, isError) => {
			if (isError) {
				void vscode.window.showErrorMessage(`Vinv Journey: ${message}`);
			} else {
				void vscode.window.showInformationMessage(`Vinv Journey: ${message}`);
			}
		},
	};

	const sub = webview.onDidReceiveMessage((msg: JourneyOutbound | { type: 'webviewError' }) => {
		if (msg.type === 'webviewError') {
			return;
		}
		return handleJourneyMessage(msg, actions);
	});
	void push();

	return {
		dispose(): void {
			disposed = true;
			sub.dispose();
		},
	};
}

/** Exported for the standalone browser harness (visual verification with real data). */
export function getJourneyHtml(): string {
	return getHtml();
}

function getHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Vinv Journey</title>
	<style>
		${VINV_BASE_CSS}
		body { padding: 18px 20px; font-size: 12.5px; }
		header {
			display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
			border-bottom: 1px solid var(--line); margin-bottom: 14px; padding-bottom: 12px;
		}
		h1 {
			font-family: ${VINV_FONT_SERIF}; font-style: italic; font-weight: 400;
			font-size: 24px; line-height: 1.1; margin: 0 0 6px;
		}
		.meta { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		.nav { display: inline-flex; align-items: center; gap: 8px; flex: none; }
		.nav button {
			height: 26px; padding: 0 12px; cursor: pointer; border-radius: 0;
			font-family: inherit; font-size: 9.5px; letter-spacing: 0.2em; text-transform: uppercase;
			background: var(--ink); color: var(--bg); border: 1px solid var(--ink);
		}
		.nav button:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: #fff; }
		.nav button:disabled { opacity: 0.35; cursor: default; }
		.nav .pos { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		.stats { margin-top: 8px; display: flex; gap: 16px; flex-wrap: wrap; }
		.stat { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		.stat b { color: var(--ink); font-weight: 600; }
		.cov { display: inline-flex; align-items: center; gap: 8px; font-size: 10px;
			letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); }
		.cov .bar { width: 90px; height: 6px; background: var(--bg-2);
			border: 1px solid var(--line-strong); overflow: hidden; box-sizing: border-box; }
		.cov .bar span { display: block; height: 100%; background: var(--ink); }
		h2 { font-size: 10px; font-weight: 400; letter-spacing: 0.24em; text-transform: uppercase;
			color: var(--muted); margin: 22px 0 10px; padding-top: 12px;
			border-top: 1px solid var(--ink); display: inline-block; }
		h2::before { content: '// '; color: var(--accent-fg); }
		table { border-collapse: collapse; width: 100%; font-size: 11px; }
		th { text-align: left; font-weight: 400; color: var(--muted); font-size: 9.5px;
			letter-spacing: 0.18em; text-transform: uppercase; padding: 4px 10px 4px 0;
			border-bottom: 1px solid var(--line-strong); }
		td { padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line);
			vertical-align: top; font-family: inherit; }
		td.io-json { max-width: 340px; overflow-wrap: anywhere; color: var(--muted); }
		.st-2xx { color: var(--ink); } .st-4xx { color: var(--muted); } .st-5xx { color: var(--accent-fg); }
		ul.tree { list-style: none; margin: 0; padding: 0; }
		ul.tree ul { list-style: none; margin: 0 0 0 8px; padding-left: 18px;
			border-left: 1px dashed var(--line-strong); }
		.node { display: inline-flex; gap: 6px; padding: 1px 6px; cursor: pointer; max-width: 100%; }
		.node:hover { background: var(--bg-2); box-shadow: inset 2px 0 0 var(--accent-fg); }
		.node.notrun { opacity: 0.45; }
		.loc { color: var(--muted-2); font-size: 10.5px; }
		.rt.ok { color: var(--muted); font-size: 10.5px; }
		.rt.err { color: var(--accent-fg); font-size: 10.5px; }
		.ext { color: var(--muted); font-style: italic; }
		#flame { position: relative; margin-top: 6px; }
		.flame-frame { position: absolute; box-sizing: border-box; overflow: hidden;
			white-space: nowrap; text-overflow: ellipsis; font-size: 10.5px; line-height: 20px;
			padding: 0 5px; border: 1px solid var(--line-strong); cursor: default; }
		.flame-frame:hover { outline: 1px solid var(--accent-fg); outline-offset: -1px; }
		.empty { color: var(--muted); font-size: 11px; padding: 6px 0; }
		.error { color: var(--accent-fg); }
		form.add { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; max-width: 760px; }
		form.add label { display: block; font-size: 9.5px; letter-spacing: 0.18em;
			text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
		form.add textarea, form.add input {
			width: 100%; box-sizing: border-box; background: var(--bg-2); color: var(--ink);
			border: 1px solid var(--line-strong); border-radius: 0; font-family: inherit;
			font-size: 11px; padding: 6px; }
		form.add textarea { min-height: 64px; resize: vertical; }
		form.add .full { grid-column: 1 / -1; }
		form.add button { justify-self: start; height: 26px; padding: 0 12px; cursor: pointer;
			font-family: inherit; font-size: 9.5px; letter-spacing: 0.2em; text-transform: uppercase;
			background: var(--ink); color: var(--bg); border: 1px solid var(--ink); border-radius: 0; }
		form.add button:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
		.svc { padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
		.svc b { font-weight: 600; }
		.svc .cmd { color: var(--muted-2); font-size: 10.5px; overflow-wrap: anywhere; }
		.badge { font-size: 9px; padding: 1px 6px; letter-spacing: 0.16em; text-transform: uppercase;
			border: 1px solid currentColor; color: var(--muted-2); }
	</style>
</head>
<body>
	<header>
		<div class="head-left">
			<h1 id="title">Journey</h1>
			<div class="meta" id="meta">Loading…</div>
			<div class="stats" id="stats"></div>
		</div>
		<div class="nav">
			<span class="pos" id="pos"></span>
			<button id="prev" disabled>‹ Prev</button>
			<button id="next" disabled>Next ›</button>
		</div>
	</header>
	<div id="content"><div class="empty">Assembling the journey…</div></div>

	<script>
	const vscode = acquireVsCodeApi();
	window.addEventListener('error', (e) => vscode.postMessage({ type: 'webviewError', message: String(e.message || 'unknown') }));

	let journey = null;
	let step = 0; // 0 = overview, 1..N = endpoint steps

	const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	const stCls = (s) => s == null ? '' : s >= 500 ? 'st-5xx' : s >= 400 ? 'st-4xx' : 'st-2xx';

	function total() { return journey ? journey.steps.length + 1 : 1; }

	function render() {
		if (!journey) return;
		document.getElementById('pos').textContent = (step + 1) + ' / ' + total();
		document.getElementById('prev').disabled = step === 0;
		document.getElementById('next').disabled = step >= total() - 1;
		if (step === 0) renderOverview(); else renderStep(journey.steps[step - 1]);
	}

	function renderOverview() {
		const j = journey;
		document.getElementById('title').textContent = 'Journey';
		document.getElementById('meta').textContent = 'START TO END · EVERYTHING VINV VERIFIED';
		document.getElementById('stats').innerHTML =
			'<span class="cov">Endpoints <span class="bar"><span style="width:' +
			(j.coverage.endpointsTotal ? Math.round(100 * j.coverage.endpointsCovered / j.coverage.endpointsTotal) : 0) +
			'%"></span></span> ' + j.coverage.endpointsCovered + '/' + j.coverage.endpointsTotal + '</span>' +
			'<span class="cov">Symbols <span class="bar"><span style="width:' +
			(j.coverage.symbolsTotal ? Math.round(100 * j.coverage.symbolsCovered / j.coverage.symbolsTotal) : 0) +
			'%"></span></span> ' + j.coverage.symbolsCovered + '/' + j.coverage.symbolsTotal + '</span>' +
			'<span class="stat">Scenarios <b>' + j.scenarios.completed + '/' + j.scenarios.run + '</b></span>' +
			'<span class="stat">State cleaned <b>' + j.statePollution.cleaned + '/' + j.statePollution.created + '</b></span>';
		let html = '<h2>Services</h2>';
		html += j.services.length === 0 ? '<div class="empty">No services discovered yet.</div>' : '';
		for (const s of j.services) {
			html += '<div class="svc"><b>' + esc(s.name) + '</b> <span class="badge">' + esc(s.kind) + '</span>' +
				(s.port ? ' <span class="loc">:' + s.port + '</span>' : '') +
				'<div class="cmd">' + esc(s.command) + '</div></div>';
		}
		if (j.issues.length) {
			html += '<h2>Open issues (' + j.issues.length + ')</h2>';
			for (const i of j.issues) html += '<div class="svc"><span class="badge">' + esc(i.kind) + '</span> ' + esc(i.title) + '</div>';
		}
		if (j.scenarios.expired && j.scenarios.expired.length) {
			html += '<h2>Expired scenarios</h2>';
			for (const s of j.scenarios.expired) html += '<div class="svc error">' + esc(s.name) + ' — ' + esc(s.reason) + '</div>';
		}
		html += '<h2>Walk</h2><div class="empty">Use Next / → to step through every endpoint: call tree, flamegraph, and the exact inputs and outputs exercised.</div>';
		document.getElementById('content').innerHTML = html;
	}

	function nodeHtml(n) {
		const rt = n.runtime;
		const ext = !n.symbol_id && !n.name;
		const name = esc(n.name || n.call || '?');
		const loc = n.file ? ' <span class="loc">' + esc(n.file) + (n.line ? ':' + n.line : '') + '</span>' : '';
		let badge = '';
		if (rt && rt.executed) {
			badge = ' <span class="rt ' + (rt.error ? 'err' : 'ok') + '">✓ ×' + (rt.calls ?? 1) +
				(rt.total_ms != null ? ' (' + rt.total_ms + 'ms)' : '') +
				(rt.error ? ' ⚠ ' + rt.error + ' err' : '') + '</span>';
		} else if (rt && rt.executed === false) {
			badge = ' <span class="rt" title="Reachable from this endpoint according to the call graph, but no captured request has executed it yet — add an input below to cover it">✗ not run</span>';
		}
		const cls = 'node' + (rt && rt.executed === false ? ' notrun' : '') + (ext ? ' ext' : '');
		const open = n.file ? ' data-file="' + esc(n.file) + '" data-line="' + (n.line || 1) + '"' : '';
		let html = '<li><span class="' + cls + '"' + open + '>' + name + loc + badge + '</span>';
		const kids = n.children || [];
		if (kids.length) html += '<ul>' + kids.map(nodeHtml).join('') + '</ul>';
		return html + '</li>';
	}

	function flameHtml(tree) {
		// Width ∝ runtime total_ms (fallback 1 unit when static-only).
		const W = Math.max(320, document.body.clientWidth - 44);
		const frames = [];
		const weight = (n) => (n.runtime && n.runtime.total_ms) ? Math.max(n.runtime.total_ms, 0.001) : 0;
		const staticW = (n) => 1 + (n.children || []).reduce((a, c) => a + staticW(c), 0);
		const rootW = weight(tree) || staticW(tree);
		const layout = (n, x0, x1, depth) => {
			frames.push({ n, x0, x1, depth });
			const kids = n.children || [];
			const kw = kids.map((c) => weight(c) || (weight(tree) ? 0 : staticW(c)));
			const sum = kw.reduce((a, b) => a + b, 0);
			if (!sum) return;
			let x = x0;
			const span = x1 - x0;
			kids.forEach((c, i) => {
				const w = (kw[i] / sum) * span * Math.min(1, sum / (weight(n) || sum));
				if (w > 0) { layout(c, x, x + w, depth + 1); x += w; }
			});
		};
		layout(tree, 0, 1, 0);
		let maxDepth = 0;
		let html = '';
		for (const f of frames) {
			maxDepth = Math.max(maxDepth, f.depth);
			const w = (f.x1 - f.x0) * W;
			if (w < 2) continue;
			const heat = rootW ? Math.min(1, (weight(f.n) || 0) / rootW) : 0;
			const bg = 'color-mix(in srgb, var(--accent) ' + Math.round(heat * 62) + '%, var(--bg-2))';
			const label = (f.n.name || f.n.call || '?') + (f.n.runtime && f.n.runtime.total_ms != null ? ' · ' + f.n.runtime.total_ms + 'ms' : '');
			html += '<div class="flame-frame" style="left:' + (f.x0 * W).toFixed(1) + 'px;top:' + (f.depth * 22) + 'px;width:' + w.toFixed(1) + 'px;background:' + bg + '" title="' + esc(label) + '">' + esc(label) + '</div>';
		}
		return '<div style="position:relative;height:' + ((maxDepth + 1) * 22 + 4) + 'px">' + html + '</div>';
	}

	function renderStep(s) {
		document.getElementById('title').textContent = s.method + ' ' + s.path;
		document.getElementById('meta').textContent =
			(s.handler ? s.handler.toUpperCase() + '() · ' : '') + s.apiId;
		const pct = s.coverage.total ? Math.round(100 * s.coverage.covered / s.coverage.total) : 0;
		document.getElementById('stats').innerHTML =
			'<span class="cov">Coverage <span class="bar"><span style="width:' + pct + '%"></span></span> ' +
			s.coverage.covered + '/' + s.coverage.total + '</span>' +
			'<span class="stat">p50 <b>' + s.p50Ms + 'ms</b></span>' +
			'<span class="stat">p95 <b>' + s.p95Ms + 'ms</b></span>' +
			'<span class="stat" title="Observed = the endpoint&#39;s handler function actually ran in the trace. Not observed = every request so far was rejected before reaching it (auth, validation) — it still needs a valid input">Handler ' + (s.handlerObserved ? '<b>observed</b>' : 'not observed') + '</span>' +
			'<span class="stat">Invariants <b>' + s.invariants + '</b></span>';

		let html = '<h2>Call tree</h2>';
		if (s.tree) html += '<ul class="tree">' + nodeHtml(s.tree) + '</ul>';
		else html += '<div class="empty' + (s.treeError ? ' error' : '') + '">' +
			esc(s.treeError || 'No call-tree snapshot yet — open this endpoint\\'s call tree once to generate it.') + '</div>';

		html += '<h2>Flamegraph</h2>';
		html += s.tree ? '<div id="flame">' + flameHtml(s.tree) + '</div>'
			: '<div class="empty">Needs a call-tree snapshot.</div>';

		html += '<h2>Exercised inputs → outputs (' + s.io.length + ')</h2>';
		if (s.io.length === 0) {
			html += '<div class="empty">Not exercised yet — run the exerciser to populate this.</div>';
		} else {
			html += '<table><tr><th>Strategy</th><th>Auth</th><th>Status</th><th>Latency</th><th>Input</th><th>Output</th></tr>';
			for (const r of s.io) {
				html += '<tr><td>' + esc(r.strategy) + ' <span class="loc">' + esc(r.inputClass) + '</span></td>' +
					'<td title="' + (r.auth ? 'Sent with real captured credentials (the superuser/user token the login scenario obtained)' : 'Sent anonymously — no credentials attached') + '">' + (r.auth ? '🔑' : '—') + '</td>' +
					'<td class="' + stCls(r.status) + '">' + (r.status ?? (r.error ? 'ERR' : '—')) + '</td>' +
					'<td>' + (r.latencyMs != null ? r.latencyMs + 'ms' : '—') + '</td>' +
					'<td class="io-json">' + esc(r.input) + '</td>' +
					'<td class="io-json">' + esc(r.error || r.output) + '</td></tr>';
			}
			html += '</table>';
		}

		html += '<h2>Add your own input' + (s.userPlanCount ? ' (' + s.userPlanCount + ' authored)' : '') + '</h2>' +
			'<form class="add" id="add-form">' +
			'<div class="full"><label>Body (JSON, empty for none)</label><textarea id="in-body" placeholder="{&quot;email&quot;: &quot;me@example.com&quot;}"></textarea></div>' +
			'<div><label>Path params (JSON object)</label><textarea id="in-path" placeholder="{&quot;user_id&quot;: &quot;…&quot;}"></textarea></div>' +
			'<div><label>Query params (JSON object)</label><textarea id="in-query" placeholder="{&quot;limit&quot;: 10}"></textarea></div>' +
			'<div><label>Expected status</label><input id="in-expect" value="2xx"></div>' +
			'<div style="align-self:end"><button type="submit">Add input</button></div>' +
			'</form>' +
			'<div class="empty">Saved into this endpoint\\'s semantic plan — the next <b>exerciser run</b> executes it (with auth setup if the endpoint\\'s scenario provides it) and it becomes a permanent regression case.</div>';

		document.getElementById('content').innerHTML = html;

		for (const el of document.querySelectorAll('.node[data-file]')) {
			el.addEventListener('click', () =>
				vscode.postMessage({ type: 'openSource', file: el.dataset.file, line: parseInt(el.dataset.line || '1', 10) }));
		}
		document.getElementById('add-form').addEventListener('submit', (ev) => {
			ev.preventDefault();
			const parse = (id, label) => {
				const raw = document.getElementById(id).value.trim();
				if (!raw) return undefined;
				try { return JSON.parse(raw); } catch { throw new Error(label + ' is not valid JSON'); }
			};
			try {
				const body = parse('in-body', 'Body');
				const pathParams = parse('in-path', 'Path params');
				const query = parse('in-query', 'Query params');
				const expectRaw = document.getElementById('in-expect').value.trim() || '2xx';
				const expect = /^\\d+$/.test(expectRaw) ? parseInt(expectRaw, 10) : expectRaw;
				vscode.postMessage({
					type: 'addInput', apiId: s.apiId, endpoint: s.method + ' ' + s.path,
					plan: { inputs: { body: body ?? null, path_params: pathParams ?? {}, query: query ?? {} }, expect: { status: expect, notes: 'user-authored input' } },
				});
			} catch (e) { vscode.postMessage({ type: 'webviewError', message: String(e.message || e) }); alert(String(e.message || e)); }
		});
	}

	document.getElementById('prev').addEventListener('click', () => { if (step > 0) { step--; render(); } });
	document.getElementById('next').addEventListener('click', () => { if (step < total() - 1) { step++; render(); } });
	window.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowLeft' && step > 0) { step--; render(); }
		if (e.key === 'ArrowRight' && step < total() - 1) { step++; render(); }
	});

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'journey') {
			journey = msg.journey;
			if (step >= total()) step = total() - 1;
			render();
		}
	});
	</script>
</body>
</html>`;
}
