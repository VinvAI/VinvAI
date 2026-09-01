/**
 * Findings view — "what Vinv found and fixed", rendered for humans; the same
 * data lands in .vinv/reports/findings.json for agents. File-backed custom
 * editor over that summary file (same pattern as call trees / journey), so
 * the machine surface and the tab's backing file are one and the same.
 *
 * Sections: headline tiles → issue clusters → optimization episodes (each
 * attempt drawn with its paired-bootstrap 95% CI on a signed axis; accepted
 * episodes show the exact evidence that cleared the bar) → regression replay
 * (kinds breakdown + history) → per-unit latency profile (p50/p95 bars)
 * → state-pollution ledger → detected opportunities awaiting episodes.
 *
 * "Unit", not "endpoint": the exerciser drives HTTP routes, CLI invocations
 * and functions called directly, all three land in the scorecard, and the
 * Traces panel has always listed all three. This panel used to call every one
 * of them an endpoint, so a toolchain repo with no routes at all still read as
 * "N endpoints covered". The nouns now follow the rows (see UNIT_NOUNS).
 */

import * as vscode from 'vscode';
import { reportWebviewError, trackUi } from '../telemetry/instrument';
import * as fs from 'fs';
import * as path from 'path';
import { VINV_BASE_CSS, VINV_FONT_MONO } from './webviewTheme';
import { buildFindings, writeFindingsSummary } from './findingsModel';
import { openJourney } from './journeyView';
import { openPathInEditor } from '../support/openDocument';
import { dispatchClusterFix } from '../harness/exerciseRunner';

export const FINDINGS_VIEW_TYPE = 'vinv.findings';

export interface FindingsOutbound {
	type:
		| 'openSource' | 'refresh' | 'dispatchFix' | 'walk' | 'runExercise' | 'autoPilot';
	file?: string;
	line?: number;
	/** Cluster fingerprint for 'dispatchFix'. */
	signature?: string;
}

export interface FindingsActions {
	openSource: (file: string | undefined, line?: number) => Promise<void>;
	refresh: () => Promise<void>;
	dispatchFix: (signature: string) => Promise<void>;
	/** Open the per-unit walkthrough (call tree, flamegraph, exact I/O). */
	walk: () => Promise<void>;
	/** Drive the inventoried services under the tracer. */
	runExercise: () => Promise<void>;
	/** Set up, bring up and exercise everything — the zero-traces path. */
	autoPilot: () => Promise<void>;
}

export async function handleFindingsMessage(
	msg: FindingsOutbound,
	actions: FindingsActions,
): Promise<void> {
	if (msg.type === 'openSource') {
		await actions.openSource(msg.file, msg.line);
	} else if (msg.type === 'refresh') {
		await actions.refresh();
	} else if (msg.type === 'dispatchFix' && msg.signature) {
		await actions.dispatchFix(msg.signature);
	} else if (msg.type === 'walk') {
		await actions.walk();
	} else if (msg.type === 'runExercise') {
		await actions.runExercise();
	} else if (msg.type === 'autoPilot') {
		await actions.autoPilot();
	}
}

function backingFile(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'findings.json');
}

/**
 * The service the next resolveCustomEditor should open filtered to.
 *
 * Threaded through module state rather than the document URI: the custom editor
 * is keyed on findings.json, so encoding the filter in the URI would either make
 * VS Code treat each service as a different document (a tab per service) or be
 * dropped entirely. The filter is a VIEW preference, not a different document,
 * so it rides alongside and is consumed once.
 */
let pendingServiceFilter: string | undefined;

export async function openFindings(workspaceRoot: string, service?: string): Promise<void> {
	pendingServiceFilter = service;
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
	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			FINDINGS_VIEW_TYPE,
			new FindingsEditorProvider(context),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	// The context is the dispatch path's dedup store — "Fix this" cannot record
	// what it handed off without it.
	private constructor(private readonly context: vscode.ExtensionContext) {}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): void {
		const workspaceRoot = path.resolve(path.dirname(document.uri.fsPath), '..', '..');
		const wiring = wireFindings(this.context, workspaceRoot, webviewPanel.webview);
		webviewPanel.onDidDispose(() => wiring.dispose());
	}
}

function wireFindings(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	webview: vscode.Webview,
): vscode.Disposable {
	webview.options = { enableScripts: true };
	webview.html = getHtml();

	// Consumed once: a later refresh of the same panel must not silently snap the
	// user back to the service the rail happened to open it with.
	const initialService = pendingServiceFilter;
	pendingServiceFilter = undefined;

	let disposed = false;
	const push = async (): Promise<void> => {
		const findings = buildFindings(workspaceRoot);
		if (disposed) {
			return;
		}
		void webview.postMessage({ type: 'findings', findings, service: initialService });
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
		dispatchFix: async (signature) => {
			const result = await dispatchClusterFix(context, workspaceRoot, signature);
			const say = {
				dispatched: 'Vinv: fix episode dispatched — watch the harness log for progress.',
				busy:
					'Vinv: the harness is already running something. This cluster stays eligible — ' +
					'try again once the current episode finishes.',
				'not-actionable':
					'Vinv: this cluster is a diagnostic about the environment or an upstream ' +
					'dependency — no edit to this repo fixes it.',
				'unknown-cluster':
					'Vinv: that cluster is no longer in issues.json — a newer exercise pass replaced it.',
			}[result.outcome];
			void (result.outcome === 'dispatched'
				? vscode.window.showInformationMessage(say)
				: vscode.window.showWarningMessage(say));
			// Re-render either way: on success the button should not stay clickable,
			// on failure it must come back so the user can retry.
			await push();
		},
		// The deep walkthrough stays its own surface — a flamegraph and an
		// input-authoring form do not belong inline in a scrolling report — but it
		// is now reached FROM here rather than being a sibling tab with no entry
		// point of its own.
		walk: () => openJourney(workspaceRoot),
		// Every unanalysed section in one go: the batcher decides how many prompts
		// that is, which is the whole reason it exists.
		runExercise: async () => {
			await vscode.commands.executeCommand('vinv-vs.runExercise');
		},
		autoPilot: async () => {
			await vscode.commands.executeCommand('vinv-vs.autoPilot');
		},
	};

	const sub = webview.onDidReceiveMessage((msg: FindingsOutbound | { type: 'webviewError' }) => {
		if (msg.type === 'webviewError') {
			reportWebviewError('findings', msg as { message?: unknown });
			return;
		}
		trackUi('findings', msg.type);
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
		h1 { font-family: ${VINV_FONT_MONO}; font-weight: 400;
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
		.walk-cta { color: var(--muted); font-size: 11px; margin-bottom: 10px;
			display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.walk-cta button { font-family: inherit; font-size: 9px; font-weight: 500;
			letter-spacing: 0.18em; text-transform: uppercase; padding: 5px 12px;
			cursor: pointer; border-radius: 0;
			background: transparent; border: 1px solid var(--line-strong); color: var(--ink); }
		.walk-cta button:hover { border-color: var(--ink); }
		.badge.accept { background: var(--ok); border-color: var(--ok); color: #ffffff; }
		.badge.revert { color: var(--accent-fg); }
		.badge.env { color: var(--muted); }
		.epi { border: 1px solid var(--line-strong); padding: 10px 12px; margin-bottom: 10px; }
		.epi .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.epi .label { font-weight: 600; }
		.epi .why { color: var(--muted); font-size: 11px; margin-top: 4px; }
		.epi .files { color: var(--muted-2); font-size: 10.5px; margin-top: 4px; }
		.att { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
		.att .ap { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 11px; }
		.att .suite { flex: none; font-size: 10px; color: var(--ok-fg); }
		.att .suite.fail { color: var(--accent-fg); }
		.att .cin { flex: none; font-size: 10px; color: var(--muted); white-space: nowrap; }
		/* CI bar: signed axis, zero tick in the middle-ish; interval drawn as a
		   filled band, point estimate as a notch. Improvement = toward +. */
		.ci { flex: none; position: relative; width: 180px; height: 14px;
			background: var(--bg-2); border: 1px solid var(--line-strong); }
		.ci .zero { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line-strong); }
		.ci .band { position: absolute; top: 2px; bottom: 2px; }
		.ci .band.good { background: var(--ok); }
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
		.svcbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 14px; }
		.svclabel { font-size: 9px; letter-spacing: .24em; text-transform: uppercase; color: var(--muted); margin-right: 2px; }
		.svclabel::before { content: '// '; color: var(--accent-fg); }
		.chip { font-family: inherit; font-size: 10px; letter-spacing: .12em; text-transform: uppercase;
			padding: 3px 9px; border: 1px solid var(--line-strong); background: transparent;
			color: var(--muted); border-radius: 0; cursor: pointer; }
		.chip:hover { border-color: var(--ink); color: var(--ink); }
		.chip.on { background: var(--ink); border-color: var(--ink); color: var(--bg); }
		.chip .n { opacity: .65; margin-left: 3px; }
		.svcnote { font-size: 10px; color: var(--muted-2); margin-left: 4px; cursor: help; }
		.hint { color: var(--muted-2); font-size: 10.5px; margin-top: 6px; }
		.grow { flex: 1; }
		/* Evidence table inside a cluster: label column narrow, value wraps. */
		.kv { margin-top: 8px; font-size: 11px; }
		.kv th { width: 74px; padding: 3px 10px 3px 0; border-bottom: 1px solid var(--line);
			vertical-align: top; white-space: nowrap; }
		.kv td { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ${VINV_FONT_MONO};
			font-size: 10.5px; }
		button.act { font: inherit; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
			padding: 3px 10px; cursor: pointer; background: var(--ink); color: var(--bg);
			border: 1px solid var(--ink); }
		button.act:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); }
		button.act:disabled { cursor: default; background: var(--bg-2); color: var(--muted);
			border-color: var(--line-strong); }
		.files a { color: var(--muted-2); }
		/* A dead-code row is a link to its own report, so the whole card reacts. */
		.dead { border: 1px solid var(--line-strong); padding: 9px 12px; margin-bottom: 8px;
			cursor: pointer; background: transparent; }
		.dead:hover { border-color: var(--ink); background: var(--bg-2); }
		.dead .label { font-weight: 600; overflow-wrap: anywhere; }
		.dead .what { color: var(--muted); font-size: 11px; margin-top: 4px; overflow-wrap: anywhere; }
		.dead .go { color: var(--muted-2); font-size: 9px; letter-spacing: 0.18em;
			text-transform: uppercase; white-space: nowrap; }
		.badge.orphan { color: var(--muted-2); }
		.badge.wired { color: var(--accent-fg); }
	</style>
</head>
<body>
	<header>
		<h1>Findings</h1>
		<div class="meta">WHAT VINV FOUND · WHAT IT FIXED · THE EVIDENCE</div>
		<div class="tiles" id="tiles"></div>
	</header>
	<div id="svcbar" class="svcbar" hidden></div>
	<div id="content"><div class="empty">Assembling findings…</div></div>

	<script>
	const vscode = acquireVsCodeApi();
	window.addEventListener('error', (e) => vscode.postMessage({ type: 'webviewError', message: String(e.message || 'unknown') }));

	const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	const pct = (x) => (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%';

	/**
	 * What the exerciser drove, named honestly.
	 *
	 * The exerciser has three oracles — HTTP routes, CLI invocations, driven
	 * function calls — and the Traces panel has always listed all three. This
	 * panel called every one of them an "endpoint", so a repo whose units are a
	 * CLI and two functions read as "3 endpoints" and its latency table headed a
	 * column "Endpoint" over a row saying RUN acme-tool. The nouns below are the
	 * scorecard's own (exerciser/scorecard.py _UNIT_NOUNS), so the panel and the
	 * markdown report say the same words.
	 */
	const UNIT_NOUNS = {
		http_endpoint: ['endpoint', 'endpoints'],
		cli_invocation: ['CLI invocation', 'CLI invocations'],
		function_call: ['driven call', 'driven calls'],
	};
	const kindNoun = (kind, plural) => (UNIT_NOUNS[kind] || ['unit', 'units'])[plural ? 1 : 0];
	// A single-kind set gets its own noun; a mixed one gets "units", which is
	// what the word was always standing in for.
	function unitNoun(byKind, plural) {
		const kinds = Object.keys(byKind || {}).filter((k) => (byKind[k] || 0) > 0);
		return kinds.length === 1 ? kindNoun(kinds[0], plural) : (plural ? 'units' : 'unit');
	}
	const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
	/** "12 endpoints · 3 CLI invocations" — only worth saying when mixed. */
	function kindBreakdown(byKind) {
		const kinds = Object.keys(byKind || {}).filter((k) => (byKind[k] || 0) > 0).sort();
		if (kinds.length < 2) return '';
		return kinds.map((k) => byKind[k] + ' ' + kindNoun(k, byKind[k] !== 1)).join(' · ');
	}
	function countByKind(rows) {
		const counts = {};
		for (const r of rows || []) {
			const k = r.unitKind || 'http_endpoint';
			counts[k] = (counts[k] || 0) + 1;
		}
		return counts;
	}

	/**
	 * Has anything been exercised at all?
	 *
	 * A wall of zeros cannot say WHICH zero it is, and the two meanings are
	 * opposites: "we drove your services and found nothing wrong" is the best
	 * possible result, while "nothing has run yet" means the panel is reporting
	 * on an empty set. Read off totals and volumes, never off the issue count —
	 * zero issues is exactly what a clean exercised repo looks like.
	 */
	function nothingExercised(f) {
		const h = f.headline;
		// A cluster is a failure OBSERVED in a live run, so one existing is proof
		// that something ran — the reverse of reading zero clusters as "clean",
		// which is the inference this function exists to refuse. Without this a
		// pass whose coverage assembly did not write a scorecard hid the findings
		// it had just made behind "nothing has been exercised".
		if (h.issuesFound > 0) {
			return false;
		}
		return h.endpointsTotal === 0
			&& h.symbolsTotal === 0
			&& h.regressCases === 0
			&& (h.episodesAccepted + h.episodesReverted) === 0;
	}

	function tiles(f) {
		const h = f.headline;
		if (nothingExercised(f)) {
			const svc = (f.services || []);
			const named = svc.slice(0, 3).map((s) => esc(s.name)).join(', ');
			document.getElementById('tiles').innerHTML =
				'<div class="tile empty-state" style="grid-column:1/-1;text-align:left">' +
				'<div class="k">No traces yet</div>' +
				'<div class="v" style="font-size:12px;font-weight:normal;line-height:1.5">' +
				'Nothing has been exercised, so there is nothing to report — these are not ' +
				'findings of zero problems.' +
				(svc.length
					? ' Vinv found <b>' + svc.length + '</b> service' + (svc.length === 1 ? '' : 's') +
					  ' to drive' + (named ? ' (' + named + (svc.length > 3 ? ', …' : '') + ')' : '') + '.'
					: ' No services are inventoried yet — run <b>Discover</b> first.') +
				'<br><br>Coverage, issues and dead code all appear here once a run has been ' +
				'captured.' +
				'<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
				// Auto-Pilot leads: with zero traces the service is usually not up
				// either, and Exercise alone would have nothing to drive. Both are
				// offered because a user who already has a service running should
				// not have to sit through setup to get to the part they wanted.
				'<button id="empty-autopilot" class="act" title="Sets the services up, brings them up, ' +
				'drives them, and dispatches fixes">Auto-Pilot — set up and run everything</button>' +
				'<button id="empty-exercise" class="act" title="Drives the services that are ' +
				'already up. Bring one up first, or use Auto-Pilot.">Run Exercise</button>' +
				'</div>' +
				'</div></div>';
			// Wired here rather than in the shared post-render pass: this markup is
			// written by an early return, so that pass never sees these nodes.
			const ap = document.getElementById('empty-autopilot');
			if (ap) { ap.addEventListener('click', () => vscode.postMessage({ type: 'autoPilot' })); }
			const ex = document.getElementById('empty-exercise');
			if (ex) { ex.addEventListener('click', () => vscode.postMessage({ type: 'runExercise' })); }
			return;
		}
		const byKind = h.unitsByKind || {};
		const breakdown = kindBreakdown(byKind);
		const t = [
			{ k: cap(unitNoun(byKind, true)) + ' covered', v: h.endpointsCovered + '<small>/' + h.endpointsTotal + '</small>',
				tip: 'HTTP endpoints, CLI invocations and driven function calls where at least one exercised run actually got into your code' +
					(breakdown ? ' — ' + breakdown : '') },
			{ k: 'Functions covered', v: h.symbolsCovered + '<small>/' + h.symbolsTotal + '</small>',
				tip: 'Functions those ' + unitNoun(byKind, true) + ' can reach that a captured run actually executed' },
			{ k: 'Issues found', v: h.issuesFound, hot: h.issuesFound > 0,
				tip: 'Distinct failures observed in live runs, grouped by root cause' },
			{ k: 'Optimizations accepted', v: h.episodesAccepted + '<small>/' + (h.episodesAccepted + h.episodesReverted) + ' attempts</small>',
				tip: 'Speedups that measured faster with behavior unchanged; the rest were rolled back' },
			{ k: 'Regression checks', v: h.regressCases + '<small> · ' + h.regressRealDiffs + ' real changes</small>', hot: h.regressRealDiffs > 0,
				tip: 'Recorded request/response pairs replayed against the current code; a real change means the same request now answers differently' },
			{ k: 'Test data cleaned up', v: h.stateCleaned + '<small>/' + h.stateCreated + ' created</small>',
				tip: 'Records the test runs created in your service, and how many were deleted again afterwards' },
		];
		document.getElementById('tiles').innerHTML = t.map((x) =>
			'<div class="tile' + (x.hot ? ' hot' : '') + '"' + (x.tip ? ' title="' + x.tip + '"' : '') + '><div class="k">' + x.k + '</div><div class="v">' + x.v + '</div></div>').join('');
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

	// The active service filter. '' = every service (including unattributed
	// findings, which carry no service at all).
	let SERVICE = '';
	let RAW = null;

	/**
	 * Narrows a findings document to one service.
	 *
	 * Every per-unit collection is filtered, not just the issue list, so the
	 * headline tiles, the latency table and the opportunity list all describe the
	 * same subset the issues do. Collections with no service attribution
	 * (episodes, regress history, the state ledger) are left whole rather than
	 * dropped, because hiding them would read as "this service has none" when the
	 * truth is "we cannot tell whose they are".
	 */
	function narrow(f, service) {
		if (!service) return f;
		// A row with NO service is shown under every service, never hidden. The
		// attribution can be lost upstream (a merge across services that does not
		// carry the label through), and when it is, filtering it away reports
		// "this service is clean" for findings that exist. Noise is recoverable;
		// silence about a real failure is not.
		const mine = r => !r.service || r.service === service;
		const issues = f.issues.filter(mine);
		const endpoints = (f.endpoints || []).filter(mine);
		return Object.assign({}, f, {
			issues,
			endpoints,
			opportunities: (f.opportunities || []).filter(mine),
			headline: Object.assign({}, f.headline, {
				issuesFound: issues.length,
				endpointsTotal: endpoints.length || f.headline.endpointsTotal,
				// Recounted from the narrowed rows, so the tile's noun describes the
				// subset on screen: a service whose only units are CLI invocations
				// should not inherit "endpoints" from the whole-workspace mix.
				unitsByKind: endpoints.length ? countByKind(endpoints) : f.headline.unitsByKind,
			}),
		});
	}

	function svcbar(f) {
		const bar = document.getElementById('svcbar');
		// servicesWithFindings, NOT services: the filter may only offer services
		// the issue list can actually be narrowed to. The plain services field is
		// the bring-up inventory and includes ones that came up clean, so chipping
		// off it would offer filters that always render an empty panel.
		// (No backticks in here — this comment sits inside a template literal.)
		const services = f.servicesWithFindings || [];
		if (services.length === 0) { bar.hidden = true; return; }
		bar.hidden = false;
		const unattributed = f.issues.some(i => !i.service);
		const chip = (val, label, count) =>
			'<button class="chip' + (SERVICE === val ? ' on' : '') + '" data-svc="' + esc(val) + '">' +
			esc(label) + (count === null ? '' : ' <span class="n">' + count + '</span>') + '</button>';
		let html = '<span class="svclabel">Service</span>' +
			chip('', 'All', f.issues.length);
		for (const s of services) {
			html += chip(s, s, f.issues.filter(i => i.service === s).length);
		}
		if (unattributed) {
			html += '<span class="svcnote" title="These findings could not be traced to a single service — the unit maps to none, or to more than one. Driven function calls land here by design: their target is a module path, which names a file rather than a service">' +
				f.issues.filter(i => !i.service).length + ' unattributed</span>';
		}
		bar.innerHTML = html;
		bar.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
			SERVICE = b.getAttribute('data-svc');
			draw();
		}));
	}

	function draw() {
		svcbar(RAW);
		render(narrow(RAW, SERVICE));
	}

	function render(f) {
		tiles(f);
		let html = '';

		// Services lead, because "what did Vinv bring up" is the first question and
		// the answer used to live only in the Journey tab, which had no entry point.
		if (f.services && f.services.length) {
			html += '<h2>Services</h2>';
			html += '<table><tr><th>Service</th><th>Kind</th><th>Port</th><th>Starts with</th></tr>';
			for (const s of f.services) {
				html += '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.kind) + '</td>' +
					'<td>' + (s.port == null ? '—' : esc(String(s.port))) + '</td>' +
					'<td><code>' + esc(s.command) + '</code></td></tr>';
			}
			html += '</table>';
		}

		// What ran and how it went, before what went wrong: a run that mostly
		// worked should read as a run that mostly worked.
		html += latencySection(f);

		html += '<h2>Issue clusters (' + f.issues.length + ')</h2>';
		html += f.issues.length === 0 ? '<div class="empty">No failures found in anything that was exercised.</div>' : '';
		for (const i of f.issues) {
			const ex = i.exemplar;
			html += '<div class="epi"><div class="head"><span class="badge revert">' + esc(i.kind) + '</span>' +
				'<span class="label">' + esc(i.title) + '</span>' +
				(i.count > 1 ? '<span class="badge" title="Failing cases that collapsed into this one root cause">' + i.count + '&times;</span>' : '') +
				'<span class="grow"></span>' +
				(i.dispatchable
					? '<button class="act" data-fix="' + esc(i.signature) + '" title="Hand this cluster to your coding harness as a fix episode, with its evidence attached">Fix this</button>'
					: '<span class="badge env" title="A diagnostic about the environment or an upstream dependency — no edit to this repo fixes it, so it is never dispatched">not actionable</span>') +
				'</div>';
			if (ex) {
				html += '<table class="kv">';
				const row = (k, v, tip) => v
					? '<tr><th' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + esc(k) + '</th><td>' + esc(v) + '</td></tr>'
					: '';
				// A number is an HTTP status and says so; a word ('ok', 'error',
				// 'timeout') is how a CLI invocation or a driven call ended, and
				// labelling that "HTTP error" would invent a protocol it never spoke.
				const got = typeof ex.status === 'number' ? 'HTTP ' + ex.status : (ex.status || '');
				html += row('Where', i.endpoint, 'The endpoint, CLI invocation or function call that was driven');
				html += row('Sent', ex.input, 'The exact input that reproduced this failure — the request for a route, the command line for a CLI invocation, the arguments for a driven call');
				html += row('Strategy', ex.strategy, 'How the exerciser generated that input');
				html += row('Got', got + (ex.detail && ex.detail !== got ? (got ? ' — ' : '') + ex.detail : ''), 'What actually came back');
				html += row('Expected', ex.expected, 'What a correct answer would have been');
				html += row('Error', ex.error, 'The exception the call raised, when it raised one');
				html += '</table>';
			}
			if (i.coveredFrames.length) {
				html += '<div class="files" title="Functions the failing run actually reached — start reading here">reached ' +
					i.coveredFrames.slice(0, 6).map(esc).join(' · ') +
					(i.coveredFrames.length > 6 ? ' +' + (i.coveredFrames.length - 6) + ' more' : '') + '</div>';
			}
			html += '<div class="files"><span title="A stable id for this failure — the same root cause keeps this fingerprint across runs, so fixes and re-checks line up">fingerprint ' + esc(i.signature) + '</span>' +
				' · <a href="#" data-open=".vinv/exercise/' + esc(i.evidenceFile) + '" title="The artifact holding every failing row behind this cluster">' + esc(i.evidenceFile) + '</a></div>';
			html += '</div>';
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
			html += '<h2>Detected time-savers not yet attempted (' + f.opportunities.length + ')</h2>';
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
				'<span class="badge" title="Recorded request/response pairs replayed against the current code">' + r.cases + ' cases</span>' +
				'<span class="badge' + (r.behavior ? ' revert' : '') + '" title="The same request now returns a different answer">behavior ' + r.behavior + '</span>' +
				'<span class="badge' + (r.contract ? ' revert' : '') + '" title="The response&#39;s shape changed — fields appeared, vanished, or changed type">contract ' + r.contract + '</span>' +
				'<span class="badge' + (r.perf ? ' revert' : '') + '" title="The same request got clearly slower than it used to be">perf ' + r.perf + '</span>' +
				'<span class="badge env" title="Differences caused by data the test engine itself planted in earlier runs (its own residue) — the world changed, not your code">environment ' + r.environment + '</span>' +
				(r.authSkipped ? '<span class="badge">auth skipped ' + r.authSkipped + '</span>' : '') + '</div>';
			for (const d of r.diffs) {
				html += '<div class="att"><span class="badge' + (d.kind === 'environment' ? ' env' : ' revert') + '">' + esc(d.kind) + '</span>' +
					'<span class="ap">' + esc(d.endpoint) + ' — ' + esc(d.detail) + '</span></div>';
			}
			if (f.regress.history.length > 1) {
				const hmax = Math.max(1, ...f.regress.history.map((x) => x.behavior + x.contract + x.perf + x.environment));
				html += '<div class="att"><span class="ap hint">real-change history (newest right; grey = environment drift)</span><span class="spark">' +
					f.regress.history.map((x) => {
						const real = x.behavior + x.contract + x.perf;
						const env = x.environment;
						return '<i style="height:' + Math.max(2, (real / hmax) * 24) + 'px" title="' + real + ' real"></i>' +
							'<i class="env" style="height:' + Math.max(2, (env / hmax) * 24) + 'px" title="' + env + ' environment"></i>';
					}).join('') + '</span></div>';
			}
			html += '<div class="hint">environment = drift the engine attributed to its own planted state, not a code regression</div></div>';
		}

	// What ran, and how it went. This is the answer to the first question anyone
	// has after a run — which units were exercised, how much of each one
	// executed, how fast, and what came back — so it is built here and rendered
	// at the TOP. It used to sit six sections down, below dead code and the
	// regression replay, where the successful half of a run was effectively
	// invisible.
	function latencySection(f) {
		let html = '';
		// The unit noun for THIS table's rows, not the headline's: a service filter
		// can narrow a mixed workspace down to one kind.
		const rowKinds = countByKind(f.endpoints);
		const mixed = Object.keys(rowKinds).length > 1;
		html += '<h2>Latency profile per ' + unitNoun(rowKinds, false) + '</h2>';
		// A bare table header over zero rows reads as broken rather than empty, so
		// the whole table is skipped and the section says why it is empty.
		if (f.endpoints.length === 0) {
			html += '<div class="empty">Nothing has been exercised yet — no endpoint, CLI invocation or driven call — so there is no latency to profile.</div>';
		} else {
		html += '<div class="walk-cta">Need the call tree, flamegraph and the exact inputs and outputs for one of these? ' +
			'<button id="walk" type="button">Walk them one by one</button></div>';
		const maxP95 = Math.max(1, ...f.endpoints.map((e) => e.p95Ms));
		html += '<table><tr><th>' + cap(unitNoun(rowKinds, false)) + '</th>' +
			// Only when the rows disagree: a Kind column over a single-kind table
			// repeats what the header already said.
			(mixed ? '<th title="Which oracle drove this: an HTTP route, a CLI invocation recorded in .vinv/services.json, or a function called directly with generated arguments">Kind</th>' : '') +
			'<th title="Functions this unit can reach that a captured run actually executed (ran / reachable)">Coverage</th>' +
			'<th title="Typical time — half of the checked runs were faster than this">p50</th>' +
			'<th title="The slow tail — 19 of 20 runs were faster than this">p95</th>' +
			'<th style="width:30%" title="The slow tail, drawn relative to the slowest unit">p95 bar</th>' +
			'<th title="How each run ended: HTTP status for a route, ok/error/timeout for a CLI invocation or driven call">Statuses</th></tr>';
		for (const e of f.endpoints) {
			const hot = e.p95Ms >= 200;
			const http = (e.unitKind || 'http_endpoint') === 'http_endpoint';
			// "not reached" means something different per kind, and the HTTP wording
			// (turned away by a login) is nonsense for a CLI run.
			const notReached = http
				? 'No request has reached the function that serves this endpoint yet — usually it needs a login or a valid multi-step setup first'
				: 'The captures never show this unit\\'s own code running — the run may have failed before entering it, or tracing did not cover its package';
			html += '<tr><td>' + esc(e.endpoint) + (e.handlerObserved ? '' : ' <span class="badge" title="' + notReached + '">not reached</span>') + '</td>' +
				(mixed ? '<td>' + esc(kindNoun(e.unitKind || 'http_endpoint', false)) + '</td>' : '') +
				'<td>' + esc(e.coverage) + '</td><td>' + e.p50Ms + 'ms</td><td' + (hot ? ' class="badge revert"' : '') + '>' + e.p95Ms + 'ms</td>' +
				'<td><span class="bar' + (hot ? ' hot' : '') + '"><span style="width:' + Math.max(1, (e.p95Ms / maxP95) * 100) + '%"></span></span></td>' +
				'<td>' + esc(Object.entries(e.statuses).map(([k, v]) => k + '×' + v).join(' ')) + '</td></tr>';
		}
		html += '</table>';
		}
		return html;
	}

		html += '<h2>Data the tests created (' + f.state.cleaned + '/' + f.state.created + ' cleaned up)</h2>';
		if (f.state.rows.length === 0) {
			html += '<div class="empty">The test runs created nothing in your service — or nothing has been recorded yet.</div>';
		} else {
			html += '<table><tr><th>Created via</th><th>Status</th></tr>';
			for (const row of f.state.rows) {
				html += '<tr><td>' + esc(row.endpoint) + '</td><td>' +
					(row.cleaned ? 'cleaned up via ' + esc(row.via ?? '') : '<span class="badge env" title="This record is still in your service — the engine could not delete it and will retry before the next run">still there</span>') + '</td></tr>';
			}
			html += '</table>';
		}

		if (f.scenarios.expired && f.scenarios.expired.length) {
			html += '<h2>Expired scenarios</h2>';
			for (const s of f.scenarios.expired) {
				html += '<div class="epi"><div class="head"><span class="badge revert" title="This recorded multi-step flow no longer matches the service (a login changed, data was reset) — it will be re-written before the next run">expired</span>' +
					'<span class="label">' + esc(s.name) + '</span></div><div class="why">' + esc(s.reason) + '</div></div>';
			}
		}

		html += '<div class="hint">Machine-readable copy of everything above: .vinv/reports/findings.json (this tab\\'s backing file).</div>';
		document.getElementById('content').innerHTML = html;
		// Wired after the mount because the section is rebuilt on every push.
		const walk = document.getElementById('walk');
		if (walk) { walk.addEventListener('click', () => vscode.postMessage({ type: 'walk' })); }
	}

	// One delegated listener: the content is re-rendered wholesale on every push,
	// so per-element handlers would be rebound (and leak) on each refresh.
	document.getElementById('content').addEventListener('click', (e) => {
		const fix = e.target.closest('[data-fix]');
		if (fix) {
			// Disable on click: the dispatch is a single hand-off and the harness
			// runs one episode at a time — a second click cannot start a second.
			fix.disabled = true;
			fix.textContent = 'Dispatching…';
			vscode.postMessage({ type: 'dispatchFix', signature: fix.getAttribute('data-fix') });
			return;
		}
		const open = e.target.closest('[data-open]');
		if (open) {
			e.preventDefault();
			vscode.postMessage({ type: 'openSource', file: open.getAttribute('data-open') });
			return;
		}
	});

	window.addEventListener('message', (event) => {
		if (event.data.type === 'findings') {
			RAW = event.data.findings;
			// An explicit filter only applies if that service actually has findings;
			// otherwise the panel would open looking empty for no stated reason.
			if (event.data.service && (RAW.servicesWithFindings || []).includes(event.data.service)) {
				SERVICE = event.data.service;
			}
			draw();
		}
	});
	</script>
</body>
</html>`;
}
