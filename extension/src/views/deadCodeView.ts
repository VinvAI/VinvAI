/**
 * Dead-code panel — the report `index deadcode` writes, as a browsable surface.
 *
 * Two panes, because the list and the evidence answer different questions: the
 * left one is "what is dead", the right one is "should I actually delete this".
 * Nothing here recomputes reachability; it renders `.vinv/reports/deadcode.json`
 * and reads the source only to show the definition under discussion.
 *
 * The empty state is a first-class case rather than an error. A workspace that
 * has not been discovered yet has no report, and saying "not done yet" is the
 * honest reading — an empty list would claim there is no dead code, which is a
 * different and unearned statement.
 */
import * as vscode from 'vscode';
import { trackUi } from '../telemetry/instrument';
import * as fs from 'fs';
import * as path from 'path';
import { VINV_BASE_CSS, VINV_FONT_MONO } from './webviewTheme';
import { readDeadCodeScan, runDeadCodeScan, type DeadSymbol } from '../index/deadCodeScan';
import { runHarnessPrompt } from '../harness/harnessRunner';
import { getHarnessId } from '../config/settings';
import {
	explainRemoval,
	readFindings,
	symbolHistory,
	symbolKey,
	verifyDeadSymbol,
	type AgentDispatch,
} from '../harness/deadCodeVerify';

let panel: vscode.WebviewPanel | undefined;

/** Lines around a definition, with the definition itself marked. */
interface Snippet {
	file: string;
	start: number;
	lines: string[];
	/** Inclusive 1-based range of the definition within the file. */
	from: number;
	to: number;
	error?: string;
}

/** Context lines shown either side of a definition. */
const PAD = 3;
/** Cap on a rendered definition — a 400-line function is not read in a panel. */
const MAX_BODY = 60;

export function readSnippet(workspaceRoot: string, sym: DeadSymbol): Snippet {
	const file = path.join(workspaceRoot, sym.file);
	const end = sym.end && sym.end >= sym.line ? sym.end : sym.line;
	const to = Math.min(end, sym.line + MAX_BODY);
	try {
		const all = fs.readFileSync(file, 'utf8').split(/\r?\n/);
		const start = Math.max(1, sym.line - PAD);
		const stop = Math.min(all.length, to + PAD);
		return {
			file: sym.file,
			start,
			lines: all.slice(start - 1, stop),
			from: sym.line,
			to,
		};
	} catch {
		// The report can outlive the code it describes: a symbol deleted since the
		// scan is exactly the case where the file is gone, and that is worth saying
		// rather than rendering as an empty box.
		return {
			file: sym.file,
			start: sym.line,
			lines: [],
			from: sym.line,
			to,
			error: 'This file is no longer readable — it may have been moved or deleted since the scan.',
		};
	}
}

function esc(s: string): string {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function openDeadCode(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		void vscode.window.showErrorMessage('Open a workspace folder to view dead code.');
		return;
	}
	const workspaceRoot = folder.uri.fsPath;

	if (panel) {
		panel.reveal(vscode.ViewColumn.Active);
	} else {
		panel = vscode.window.createWebviewPanel('vinv.deadCode', 'Vinv Dead Code', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		panel.onDidDispose(() => {
			panel = undefined;
		});
		panel.webview.html = getDeadCodeHtml();
		attach(panel, context, workspaceRoot);
	}

	const current = panel;
	const push = (): void => {
		void current.webview.postMessage({
			type: 'report',
			scan: readDeadCodeScan(workspaceRoot),
			repo: path.basename(workspaceRoot),
		});
	};

	push();
}

/**
 * Wires the panel's messages. Attached once per panel: it used to run on every
 * `openDeadCode` call, so clicking the toolbar icon twice left two listeners on
 * one webview and every agent action dispatched twice.
 */
function attach(view: vscode.WebviewPanel, context: vscode.ExtensionContext, workspaceRoot: string): void {
	const current = view;
	const push = (): void => {
		void current.webview.postMessage({
			type: 'report',
			scan: readDeadCodeScan(workspaceRoot),
			repo: path.basename(workspaceRoot),
		});
	};

	// Why the answer was empty, kept from the last run so the panel can say it.
	let lastDetail = '';

	/**
	 * The harness call — `runHarnessPrompt`, the same path Ask Vinv uses.
	 *
	 * NOT `dispatchAgentPrompt`: that one answers null for any harness whose kind
	 * is not 'cli', so on an IDE-chat harness (Copilot, Cursor, Claude Code in
	 * the editor) both buttons did nothing at all and said nothing about why.
	 * `runHarnessPrompt` drives ide-chat harnesses too and, when it cannot, comes
	 * back with a reason worth showing.
	 */
	const dispatch: AgentDispatch = async (name, prompt) => {
		const run = await runHarnessPrompt(getHarnessId(), workspaceRoot, name, prompt, {
			// These agents run for minutes; the button carries the live feed rather
			// than sitting on an unexplained "Asking the agent…".
			onUpdate: (line) => void current.webview.postMessage({ type: 'agentProgress', line }),
		});
		lastDetail = run.ok ? '' : (run.detail ?? 'harness run failed');
		return run.ok ? run.stdout : null;
	};

	current.webview.onDidReceiveMessage(async (msg: { type: string; symbol?: DeadSymbol }) => {
	 trackUi('deadcode', msg.type);
	 try {
		if (msg.type === 'ready' || msg.type === 'refresh') {
			push();
			return;
		}
		if (msg.type === 'regenerate') {
			// Re-runs the engine and pushes whatever it produced. `push` sends a
			// null scan when the report is absent, so a failed run lands on the
			// "not done yet" state rather than leaving stale rows on screen.
			const ok = await runDeadCodeScan(context, workspaceRoot, (p) =>
				void current.webview.postMessage({ type: 'scanProgress', label: p.label }));
			push();
			if (!ok) {
				void current.webview.postMessage({ type: 'scanFailed' });
			}
			return;
		}
		if (msg.type === 'select' && msg.symbol) {
			const sym = msg.symbol;
			void current.webview.postMessage({ type: 'snippet', snippet: readSnippet(workspaceRoot, sym) });
			// History decides whether "Compare diff" is offered at all, and it is
			// two git calls for ONE symbol — cheap here, minutes if the scan did it
			// for every finding up front.
			const history = await symbolHistory(workspaceRoot, sym);
			void current.webview.postMessage({
				type: 'context',
				key: symbolKey(sym),
				history,
				findings: readFindings(workspaceRoot).symbols[symbolKey(sym)] ?? {},
			});
			return;
		}
		if ((msg.type === 'verify' || msg.type === 'removal') && msg.symbol) {
			const sym = msg.symbol;
			const snippet = readSnippet(workspaceRoot, sym);
			const source = snippet.lines.join('\n');
			const history = await symbolHistory(workspaceRoot, sym);
			const result =
				msg.type === 'verify'
					? await verifyDeadSymbol(workspaceRoot, sym, source, history, dispatch)
					: await explainRemoval(workspaceRoot, sym, source, history, dispatch);
			// A null result is reported as such rather than left spinning: the
			// harness may be an ide-chat one with no headless channel, or the reply
			// may have carried no usable envelope.
			void current.webview.postMessage({
				type: msg.type === 'verify' ? 'verifyResult' : 'removalResult',
				key: symbolKey(sym),
				result,
				harness: getHarnessId(),
				detail: result ? '' : lastDetail,
			});
			return;
		}
		if (msg.type === 'openSource' && msg.symbol) {
			const uri = vscode.Uri.file(path.join(workspaceRoot, msg.symbol.file));
			void vscode.window.showTextDocument(uri, {
				selection: new vscode.Range(msg.symbol.line - 1, 0, msg.symbol.line - 1, 0),
			});
		}
	 } catch (err) {
		// Anything thrown here used to reject the handler silently, and the panel
		// sat on a disabled "Asking the agent…" button for good — no result, no
		// error, nothing to act on. Whatever failed, the action gets an answer.
		const detail = err instanceof Error ? err.message : String(err);
		if (msg.type === 'verify' || msg.type === 'removal') {
			void current.webview.postMessage({
				type: msg.type === 'verify' ? 'verifyResult' : 'removalResult',
				key: msg.symbol ? symbolKey(msg.symbol) : '',
				result: null,
				detail,
				harness: getHarnessId(),
			});
		} else if (msg.type === 'regenerate') {
			void current.webview.postMessage({ type: 'scanFailed', detail });
		}
	 }
	}, undefined, context.subscriptions);
}

export function getDeadCodeHtml(): string {
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
${VINV_BASE_CSS}
	body { margin: 0; font-family: ${VINV_FONT_MONO}; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
	/* Header idiom shared with the Findings view: a light 24px mono display
	 * heading, a letter-spaced uppercase strapline, and the tiles inside the
	 * header rather than in a band of their own. */
	header { border-bottom: 1px solid var(--line); padding: 18px 20px 14px; }
	.htop { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; }
	h1 { font-family: ${VINV_FONT_MONO}; font-weight: 400; font-size: 24px; line-height: 1.1; margin: 0 0 6px; }
	.meta { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
	.filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	select, input { font-family: inherit; font-size: 11px; background: var(--bg); color: var(--ink);
		border: 1px solid var(--line); padding: 6px 8px; outline: none; }
	select:focus, input:focus { border-color: var(--accent-fg); }
	input { width: 220px; }
	.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px; margin-top: 12px; }
	.tile { border: 1px solid var(--line-strong); padding: 10px 12px; background: var(--bg-2); }
	.tile .k { color: var(--muted); font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; }
	.tile .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
	.tile .v small { font-size: 11px; font-weight: 400; color: var(--muted); }
	.tile.hot .v { color: var(--accent-fg); }
	main { flex: 1; display: flex; min-height: 0; }
	aside { width: 34%; min-width: 260px; border-right: 1px solid var(--line); display: flex; flex-direction: column; }
	.listhead { padding: 9px 14px; border-bottom: 1px solid var(--line); background: var(--bg-2);
		font-size: 9px; text-transform: uppercase; letter-spacing: 0.2em; color: var(--muted);
		display: flex; justify-content: space-between; }
	.list { overflow-y: auto; flex: 1; }
	.row { width: 100%; text-align: left; background: none; color: inherit; font-family: inherit;
		border: 0; border-bottom: 1px solid var(--line); border-left: 3px solid transparent;
		padding: 11px 14px; cursor: pointer; display: flex; flex-direction: column; gap: 5px; }
	.row:hover { background: var(--bg-2); }
	.row.sel { background: var(--bg-2); border-left-color: var(--accent); }
	.row .n { font-size: 12px; font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
	.row .f { font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tag { font-size: 9px; letter-spacing: .06em; text-transform: uppercase; padding: 2px 6px;
		border: 1px solid var(--line-strong); color: var(--muted); white-space: nowrap; }
	.tag.unreachable { border-color: var(--accent-ring); background: var(--accent-ring-soft); color: var(--accent-fg); }
	.tag.testonly { border-color: var(--line-strong); color: var(--ink-soft); }
	section.detail { flex: 1; display: flex; flex-direction: column; overflow-y: auto; min-width: 0; }
	.dhead { padding: 18px 20px; border-bottom: 1px solid var(--line); background: var(--bg-2); }
	.dtitle { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
	.dtitle h2 { margin: 0; font-size: 18px; }
	.dpath { font-size: 11px; color: var(--muted); margin-top: 6px; }
	.attrs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px;
		border: 1px solid var(--line); padding: 11px 13px; background: var(--bg); font-size: 11px; }
	.attrs .k { color: var(--muted); display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 0.2em; }
	.attrs .v { margin-top: 3px; display: block; }
	.code { margin: 18px 20px; border: 1px solid var(--line); background: var(--bg-2); overflow-x: auto; }
	.code .ln { display: flex; font-size: 11px; white-space: pre; }
	.code .ln .no { width: 52px; flex: none; text-align: right; padding: 1px 10px 1px 0; color: var(--muted-2);
		border-right: 1px solid var(--line); }
	.code .ln .tx { padding: 1px 12px; }
	.code .ln.hit { background: var(--accent-ring-soft); border-left: 2px solid var(--accent); }
	.code .ln.hit .tx { color: var(--ink); }
	.sectionlabel { font-size: 10px; font-weight: 400; letter-spacing: 0.24em; text-transform: uppercase;
		color: var(--muted); margin: 18px 20px 8px; padding-top: 10px;
		border-top: 1px solid var(--ink); display: inline-block; }
	.sectionlabel::before { content: '// '; color: var(--accent-fg); }
	.empty { padding: 48px 20px; text-align: center; color: var(--muted); font-size: 12px; line-height: 1.7; }
	.empty strong { display: block; color: var(--ink); font-size: 14px; margin-bottom: 8px; }
	.note { padding: 14px 20px; border-top: 1px solid var(--line); font-size: 11px; color: var(--muted); line-height: 1.6; }
	.actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
	.act { font-family: inherit; font-size: 11px; padding: 7px 11px; cursor: pointer;
		border: 1px solid var(--line-strong); background: var(--bg); color: var(--ink); }
	.act:hover:not(:disabled) { border-color: var(--accent-fg); color: var(--accent-fg); }
	.act:disabled { opacity: .55; cursor: default; }
	.act.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
	.act.primary:hover:not(:disabled) { background: var(--accent-hover); color: #ffffff; }
	.done { font-size: 10px; color: var(--muted); align-self: center; }
	.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: none;
		align-items: center; justify-content: center; padding: 28px; z-index: 40; }
	.overlay.open { display: flex; }
	.modal { background: var(--bg); border: 1px solid var(--line-strong); width: 100%; max-width: 820px;
		max-height: 84vh; display: flex; flex-direction: column; }
	.modal h3 { margin: 0; font-size: 13px; }
	.mhead { padding: 13px 16px; border-bottom: 1px solid var(--line); background: var(--bg-2);
		display: flex; align-items: center; justify-content: space-between; gap: 10px; }
	.mbody { padding: 16px; overflow-y: auto; font-size: 12px; line-height: 1.65; }
	.mfoot { padding: 11px 16px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; }
	.field { margin-bottom: 14px; }
	.field .k { font-size: 9px; text-transform: uppercase; letter-spacing: 0.2em; color: var(--muted); display: block; }
	.field .v { margin-top: 3px; white-space: pre-wrap; }
	.flow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.flow .box { border: 1px solid var(--line); padding: 10px 12px; background: var(--bg-2); }
	.x { background: none; border: 0; color: var(--muted); cursor: pointer; font-family: inherit; font-size: 14px; }
</style></head>
<body>
<header>
	<div class="htop">
		<div>
			<h1>Dead code</h1>
			<div class="meta">WHAT NOTHING REFERENCES · WHAT ONLY THE TESTS REACH</div>
			<div class="meta" id="sub" style="letter-spacing:0.08em; margin-top:4px;">—</div>
		</div>
		<div class="filters">
			<span class="done" id="lastscan">never scanned</span>
			<button class="act" id="regen" type="button">Regenerate report</button>
			<select id="bucket">
				<option value="all">All buckets</option>
				<option value="unreachable">Unreachable</option>
				<option value="testOnly">Test-only</option>
			</select>
			<input id="q" type="text" placeholder="Search symbol or file…">
		</div>
	</div>
	<div class="tiles" id="tiles"></div>
</header>
<main>
	<aside>
		<div class="listhead"><span>Detected dead symbols</span><span id="count">0</span></div>
		<div class="list" id="list"></div>
	</aside>
	<section class="detail" id="detail"></section>
</main>
<div class="overlay" id="overlay"><div class="modal">
	<div class="mhead"><h3 id="mtitle">—</h3><button class="x" id="mclose" type="button">✕</button></div>
	<div class="mbody" id="mbody"></div>
	<div class="mfoot"><button class="act" id="mdismiss" type="button">Close</button></div>
</div></div>
<script>
	const vscode = acquireVsCodeApi();
	let scan = null;
	let repo = '';
	let all = [];
	let rows = [];
	let selected = 0;
	// Per-symbol history and stored agent findings, keyed by symbolKey. History
	// decides whether "Compare diff" is offered at all — a symbol that never had
	// a caller has no removal to explain.
	let ctx = {};
	let current = null;

	function esc(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function flatten() {
		const out = [];
		for (const s of (scan.unreachable || [])) { out.push({ ...s, bucket: 'unreachable' }); }
		for (const s of (scan.testOnly || [])) { out.push({ ...s, bucket: 'testOnly' }); }
		return out;
	}

	// Only the TOP of a chain is a decision. A symbol reached solely from another
	// dead one goes when its caller goes, so it is folded under it rather than
	// listed as a separate finding.
	function tops(list) { return list.filter((r) => !(r.deadCallers && r.deadCallers.length)); }
	function foldedUnder(r) {
		const key = keyOf(r);
		return all.filter((o) => (o.deadCallers || []).indexOf(key) !== -1);
	}

	function label(b) { return b === 'unreachable' ? 'UNREACHABLE' : 'TEST-ONLY'; }
	function cls(b) { return b === 'unreachable' ? 'unreachable' : 'testonly'; }

	function tiles() {
		const total = rows.length;
		const folded = all.length - rows.length;
		const u = rows.filter((r) => r.bucket === 'unreachable').length;
		const t = rows.filter((r) => r.bucket === 'testOnly').length;
		const amb = rows.filter((s) => s.ambiguous).length;
		const pct = (n) => total ? Math.round((n / total) * 100) + '%' : '0%';
		document.getElementById('tiles').innerHTML =
			tile('Total dead code', total + ' <small>' + (folded ? 'chains · +' + folded + ' folded in' : 'symbols') + '</small>', false) +
			tile('Bucket: unreachable', u + ' <small>(' + pct(u) + ')</small>', true) +
			tile('Bucket: test-only', t + ' <small>(' + pct(t) + ')</small>', false) +
			tile('Flagged ambiguous', amb + ' <small>to check by hand</small>', false);
	}
	function tile(k, v, hot) {
		return '<div class="tile' + (hot ? ' hot' : '') + '"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
	}

	function visible() {
		const b = document.getElementById('bucket').value;
		const q = document.getElementById('q').value.trim().toLowerCase();
		return rows.filter((r) =>
			(b === 'all' || r.bucket === b) &&
			(!q || r.name.toLowerCase().includes(q) || r.file.toLowerCase().includes(q)));
	}

	function renderList() {
		const rs = visible();
		document.getElementById('count').textContent = 'Count: ' + rs.length;
		document.getElementById('list').innerHTML = rs.map((r, i) =>
			'<button class="row' + (i === selected ? ' sel' : '') + '" data-i="' + i + '">' +
				'<span class="n"><span>' + esc(r.name) + '</span>' +
				'<span class="tag ' + cls(r.bucket) + '">' + label(r.bucket) + '</span></span>' +
				'<span class="f">' + esc(r.file) + ':' + r.line + '</span>' +
				'<span class="f">' + esc(r.kind) + (r.ambiguous ? ' · name not unique' : '') + '</span>' +
			'</button>').join('');
		if (rs.length) { select(Math.min(selected, rs.length - 1)); } else { document.getElementById('detail').innerHTML =
			'<div class="empty"><strong>No symbol matches this filter.</strong>Clear the search or switch buckets.</div>'; }
	}

	function select(i) {
		selected = i;
		const rs = visible();
		const r = rs[i];
		if (!r) { return; }
		[...document.querySelectorAll('.row')].forEach((el, n) => el.classList.toggle('sel', n === i));
		document.getElementById('detail').innerHTML =
			'<div class="dhead">' +
				'<div class="dtitle"><h2>' + esc(r.name) + '</h2>' +
				'<span class="tag ' + cls(r.bucket) + '">' + label(r.bucket) + '</span></div>' +
				'<div class="dpath">' + esc(r.file) + ' · line ' + r.line + '</div>' +
				'<div class="actions" id="actions"></div>' +
				'<div class="attrs">' +
					'<div><span class="k">Kind</span><span class="v">' + esc(r.kind) + '</span></div>' +
					'<div><span class="k">Why it is listed</span><span class="v">' +
						(r.bucket === 'unreachable'
							? 'No reference anywhere, tests included'
							: 'Reached only from the test suite') + '</span></div>' +
					'<div><span class="k">Attribution</span><span class="v">' +
						(r.ambiguous
							? 'Name is not unique — verify before deleting'
							: 'Name is unique in this project') + '</span></div>' +
				'</div>' +
			'</div>' +
			(function () {
				const kids = foldedUnder(r);
				if (!kids.length) { return ''; }
				// Deleting the top takes these with it; they are not separate calls.
				return '<div class="sectionlabel">Goes with it (' + kids.length + ')</div>' +
					'<div class="note">Reached only from this symbol, so they are dead for the same reason ' +
					'and would be removed alongside it:<br>' +
					kids.map((k) => '· <strong>' + esc(k.name) + '</strong> — ' + esc(k.file) + ':' + k.line).join('<br>') +
					'</div>';
			})() +
			'<div class="sectionlabel">Definition</div>' +
			'<div class="code" id="code"><div class="ln"><span class="tx">Loading…</span></div></div>' +
			'<div class="note">' +
				(r.bucket === 'unreachable'
					? 'Nothing in the repository calls this. Deleting it should change no behaviour — confirm it is not reached by reflection, a plugin registry, or a name built at runtime.'
					: 'Only the test suite reaches this. Deleting it takes its tests with it, so decide whether the code should be wired in rather than removed.') +
			'</div>';
		current = r;
		renderActions();
		vscode.postMessage({ type: 'select', symbol: r });
	}

	// Both buttons hand the symbol to the coding harness; neither edits anything.
	// "Compare diff" appears only when history says the callers were REMOVED —
	// for a symbol that never had one there is no removal to explain, and asking
	// invites an invented story about a commit that does not exist.
	function renderActions() {
		const box = document.getElementById('actions');
		if (!box || !current) { return; }
		const c = ctx[keyOf(current)] || {};
		const lost = c.history && c.history.reason === 'lost its calls';
		const f = c.findings || {};
		box.innerHTML =
			'<button class="act primary" id="act-verify" type="button">Verify with agent</button>' +
			(lost ? '<button class="act" id="act-removal" type="button">Compare diff (lost its calls)</button>' : '') +
			(f.verdict ? '<button class="act" id="act-seen-verdict" type="button">View last verdict</button>' : '') +
			(f.removal ? '<button class="act" id="act-seen-removal" type="button">View last diff report</button>' : '') +
			(c.history ? '<span class="done">history: ' + esc(c.history.reason) +
				' · ' + c.history.commits + ' commit(s)' +
				(c.history.ambiguous ? ' · name not unique, history may be another symbol' : '') + '</span>' : '');
		bind('act-verify', () => run('verify', 'Verify with agent'));
		bind('act-removal', () => run('removal', 'Compare diff (lost its calls)'));
		bind('act-seen-verdict', () => showVerdict(f.verdict));
		bind('act-seen-removal', () => showRemoval(f.removal));
	}
	function bind(id, fn) { const el = document.getElementById(id); if (el) { el.addEventListener('click', fn); } }
	function keyOf(r) { return r.file + ':' + r.line + ':' + r.name; }

	function run(kind, label) {
		const btn = document.getElementById(kind === 'verify' ? 'act-verify' : 'act-removal');
		if (btn) {
			// These take minutes. A live button would queue a second agent over the
			// same symbol.
			btn.disabled = true;
			btn.textContent = 'Asking the agent…';
			btn.dataset.label = label;
		}
		vscode.postMessage({ type: kind, symbol: current });
	}

	function restore(kind) {
		const btn = document.getElementById(kind === 'verify' ? 'act-verify' : 'act-removal');
		if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Ask the agent'; }
	}

	function openModal(title, body) {
		document.getElementById('mtitle').textContent = title;
		document.getElementById('mbody').innerHTML = body;
		document.getElementById('overlay').classList.add('open');
	}
	function closeModal() { document.getElementById('overlay').classList.remove('open'); }

	function field(k, v) {
		return v ? '<div class="field"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>' : '';
	}

	function showVerdict(v) {
		if (!v) { return; }
		openModal('Agent verdict — ' + (current ? current.name : ''),
			field('Verdict', v.verdict) +
			field('Safe to delete', v.safeToDelete ? 'yes' : 'no — not established') +
			field('Confidence', v.confidence) +
			field('What it does', v.what) +
			field('How it checked', v.why) +
			field('Risk if removed', v.risk) +
			'<div class="field"><span class="k">Checked</span><span class="v">' + esc(v.checkedAt || '') + '</span></div>');
	}

	function showRemoval(r) {
		if (!r) { return; }
		openModal('Why the callers went — ' + (current ? current.name : ''),
			field('Commit that removed the last call', r.commit || 'not identified') +
			field('Why', r.why) +
			field('Replacement', r.replacement || 'nothing took over') +
			'<div class="flow">' +
				'<div class="box"><span class="k">Old flow</span><div class="v">' + esc(r.oldFlow || '—') + '</div></div>' +
				'<div class="box"><span class="k">New flow</span><div class="v">' + esc(r.newFlow || '—') + '</div></div>' +
			'</div>');
	}

	function renderSnippet(s) {
		const box = document.getElementById('code');
		if (!box) { return; }
		if (s.error) { box.innerHTML = '<div class="ln"><span class="tx">' + esc(s.error) + '</span></div>'; return; }
		box.innerHTML = s.lines.map((text, i) => {
			const no = s.start + i;
			const hit = no >= s.from && no <= s.to;
			return '<div class="ln' + (hit ? ' hit' : '') + '"><span class="no">' + no + '</span>' +
				'<span class="tx">' + esc(text) + '</span></div>';
		}).join('');
	}

	function renderEmpty() {
		document.getElementById('tiles').innerHTML = '';
		document.getElementById('count').textContent = '0';
		document.getElementById('list').innerHTML = '';
		document.getElementById('detail').innerHTML =
			'<div class="empty"><strong>Dead code analysis not done yet.</strong>' +
			'Run Discover Project — the scan runs alongside indexing and the handbook, and writes ' +
			'.vinv/reports/deadcode.json and .vinv/deadcode.md.</div>';
	}

	document.getElementById('bucket').addEventListener('change', () => { selected = 0; renderList(); });
	document.getElementById('q').addEventListener('input', () => { selected = 0; renderList(); });
	document.getElementById('list').addEventListener('click', (e) => {
		const row = e.target.closest('[data-i]');
		if (row) { select(Number(row.getAttribute('data-i'))); }
	});

	window.addEventListener('message', (event) => {
		const m = event.data;
		if (m.type === 'agentProgress') {
			const b = document.getElementById('act-verify');
			const r = document.getElementById('act-removal');
			const live = (b && b.disabled) ? b : ((r && r.disabled) ? r : null);
			if (live && m.line) { live.textContent = String(m.line).slice(0, 48); }
			return;
		}
		if (m.type === 'scanProgress') {
			const b = document.getElementById('regen');
			if (b) { b.textContent = m.label || 'Scanning…'; }
			return;
		}
		if (m.type === 'scanFailed') {
			regenDone();
			openModal('Scan did not complete',
				(m.detail ? '<div class="field"><span class="k">Error</span><span class="v">' + esc(m.detail) + '</span></div>' : '') +
				'The dead-code engine produced no usable report. ' +
				'That happens when the index engine is missing, the run was cancelled, or it exited with an error. ' +
				'The previous report, if any, is untouched.');
			return;
		}
		if (m.type === 'snippet') { renderSnippet(m.snippet); return; }
		if (m.type === 'context') {
			ctx[m.key] = { history: m.history, findings: m.findings || {} };
			renderActions();
			return;
		}
		if (m.type === 'verifyResult' || m.type === 'removalResult') {
			const kind = m.type === 'verifyResult' ? 'verify' : 'removal';
			restore(kind);
			if (!m.result) {
				openModal('No answer',
					'<div class="field"><span class="k">Harness asked</span><span class="v">' +
						esc(m.harness || '(none selected)') + '</span></div>' +
					(m.detail ? '<div class="field"><span class="k">Error</span><span class="v">' + esc(m.detail) + '</span></div>' : '') +
					'The harness returned nothing usable. That happens when the selected agent has no ' +
					'headless channel (an IDE-chat harness such as Copilot or Cursor cannot be driven ' +
					'programmatically), when its CLI is not installed or not logged in, or when the reply ' +
					'carried no JSON envelope. Check the harness in Configure Project. Nothing was recorded.');
				return;
			}
			ctx[m.key] = ctx[m.key] || { findings: {} };
			ctx[m.key].findings = ctx[m.key].findings || {};
			ctx[m.key].findings[kind === 'verify' ? 'verdict' : 'removal'] = m.result;
			renderActions();
			if (kind === 'verify') { showVerdict(m.result); } else { showRemoval(m.result); }
			return;
		}
		if (m.type !== 'report') { return; }
		scan = m.scan;
		repo = m.repo || '';
		regenDone();
		setLastScan(scan);
		// A new scan can move or drop symbols, so cached history is no longer
		// about the rows now on screen. Stored agent findings are keyed by symbol
		// identity and survive on disk; they reload on the next selection.
		ctx = {};
		current = null;
		if (!scan) { document.getElementById('sub').textContent = repo; renderEmpty(); return; }
		all = flatten();
		rows = tops(all);
		document.getElementById('sub').textContent =
			repo + ' · ' + scan.definitions + ' definitions across ' + scan.files + ' files · scanned ' +
			String(scan.generatedAt || '').slice(0, 19).replace('T', ' ');
		tiles();
		selected = 0;
		renderList();
	});
	function setLastScan(scan) {
		const when = scan && scan.generatedAt
			? String(scan.generatedAt).slice(0, 19).replace('T', ' ')
			: '';
		document.getElementById('lastscan').textContent = when ? 'Last scan: ' + when : 'never scanned';
	}
	function regenDone() {
		const b = document.getElementById('regen');
		if (b) { b.disabled = false; b.textContent = 'Regenerate report'; }
	}
	document.getElementById('regen').addEventListener('click', () => {
		const b = document.getElementById('regen');
		// The engine takes seconds, not minutes, but a second click would spawn a
		// second scan writing the same report.
		b.disabled = true;
		b.textContent = 'Scanning…';
		vscode.postMessage({ type: 'regenerate' });
	});
	document.getElementById('mclose').addEventListener('click', closeModal);
	document.getElementById('mdismiss').addEventListener('click', closeModal);
	vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}
