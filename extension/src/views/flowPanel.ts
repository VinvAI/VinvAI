/**
 * The Vinv Flow panel — the one always-visible home in the sidebar.
 *
 * A vertical pipeline rail: Discover → Services → Traces → Insights → Verify,
 * each stage with live status, what it produced (handbook, start commands,
 * traces, per-endpoint reports, checks — one click each), the single next
 * action when a human is needed, and a highlighted red Issues section with
 * per-issue "Fix with agent". Auto-Pilot's live step pulses on its stage.
 *
 * Rendering follows the existing panels' pattern: the extension posts the
 * whole `FlowModel` on every change; the webview rebuilds the DOM from it
 * (textContent only — no HTML injection) and posts small action messages back.
 * All colors come from the shared theme (webviewTheme.ts), which keys off the
 * body.vscode-light/-dark/-high-contrast classes, so both themes stay legible.
 */
import * as vscode from 'vscode';
import { reportWebviewError, trackUi, trackViewOpened } from '../telemetry/instrument';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { apiIdFromCallTreePath, buildCallTreeReport } from '../harness/insightRunner';
import { captureServiceFor } from '../bringup/bringup';
import { readEntryPoints } from '../identification/identification';
import { VINV_BASE_CSS, VINV_FONT_MONO } from './webviewTheme';
import { openPathInEditor, resolveOpenTarget } from '../support/openDocument';
import type { FlowStateSource } from './flowStateSource';
import type { FlowLink, FlowModel } from './flowModel';

export const FLOW_VIEW_ID = 'vinv.flow';

/** Messages the Flow webview sends back to the extension. */
export interface OutboundMessage {
	type: 'link' | 'fix' | 'evidence' | 'action';
	link?: FlowLink;
	fixArgs?: { issue: string; service?: string; row?: number };
	path?: string;
	line?: number;
	command?: string;
	args?: unknown[];
}

/**
 * Side effects a Flow message can trigger, injected so the routing is testable
 * without a live webview. Production wires these to the real vscode surfaces
 * (see `resolveWebviewView`); tests pass fakes and assert the exact call.
 */
export interface FlowActions {
	openLink: (link: FlowLink) => Promise<void>;
	openFileAt: (fsPath: string | undefined, line?: number) => Promise<void>;
	runCommand: (command: string, ...args: unknown[]) => Promise<void>;
	showError: (message: string) => void;
}

/**
 * Routes one Flow webview message to its side effect. Extracted from the inline
 * onDidReceiveMessage closure so the wiring is unit-tested directly. Every arm
 * guards its payload and reports an actionable error rather than a silent
 * no-op — a malformed `fix`/`action` message tells the user why nothing opened.
 */
export async function handleFlowMessage(
	msg: OutboundMessage,
	actions: FlowActions,
): Promise<void> {
	switch (msg.type) {
		case 'link':
			if (msg.link) {
				await actions.openLink(msg.link);
			} else {
				actions.showError('Vinv: this link is missing its target.');
			}
			return;
		case 'fix':
			if (msg.fixArgs?.issue) {
				await actions.runCommand('vinv-vs.fixWithHarness', msg.fixArgs);
			} else {
				actions.showError('Vinv: cannot start a fix — no issue was attached to this action.');
			}
			return;
		case 'evidence':
			// openFileAt itself reports missing/relative/unreadable paths.
			await actions.openFileAt(msg.path, msg.line);
			return;
		case 'action':
			if (msg.command) {
				await actions.runCommand(msg.command, ...(msg.args ?? []));
			} else {
				actions.showError('Vinv: this action has no command to run.');
			}
			return;
	}
}

export class FlowViewProvider implements vscode.WebviewViewProvider {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly source: FlowStateSource,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		trackViewOpened('flow');
		view.webview.options = { enableScripts: true };
		view.webview.html = getFlowHtml(view.webview.cspSource);

		const post = (model: FlowModel): void => {
			void view.webview.postMessage({ type: 'model', model });
		};
		const sub = this.source.onDidChange(post);
		view.onDidDispose(() => sub.dispose());
		// A collapsed-then-expanded view keeps its HTML but may have missed
		// updates; re-post the current model whenever it becomes visible.
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				post(this.source.getModel());
			}
		});
		post(this.source.getModel());

		const actions: FlowActions = {
			openLink: (link) => openLink(link, this.context),
			openFileAt: (fsPath, line) => openFileAt(fsPath, line),
			runCommand: async (command, ...args) => {
				await vscode.commands.executeCommand(command, ...args);
			},
			showError: (message) => void vscode.window.showErrorMessage(message),
		};
		view.webview.onDidReceiveMessage(
			(msg: OutboundMessage) => {
				const raw = msg as { type?: string; message?: unknown };
				if (raw.type === 'webviewError') {
					reportWebviewError('flow', raw);
					return;
				}
				trackUi('flow', raw.type ?? 'unknown');
				return handleFlowMessage(msg, actions);
			},
			undefined,
			this.context.subscriptions,
		);
	}
}

/** Executes a rail link: a command, a markdown preview, or a file open. */
async function openLink(link: FlowLink, context?: vscode.ExtensionContext): Promise<void> {
	if (link.command) {
		await vscode.commands.executeCommand(link.command, ...(link.args ?? []));
		return;
	}
	if (link.openPath && context && (await rebuildIfMissing(link.openPath, context))) {
		return;
	}
	if (!link.openPath) {
		void vscode.window.showErrorMessage('Vinv: this link has no file to open.');
		return;
	}
	if (link.markdownPreview) {
		// Verify existence first so a moved handbook reports where, not nothing.
		const resolved = resolveOpenTarget(link.openPath, undefined, 'document');
		if (!resolved.ok || !resolved.absPath) {
			void vscode.window.showErrorMessage(resolved.error ?? 'Vinv: could not open document.');
			return;
		}
		await vscode.commands.executeCommand(
			'markdown.showPreview',
			vscode.Uri.file(resolved.absPath),
		);
		return;
	}
	// vscode.open resolves the registered default editor, so calltree-*.json
	// and smoke-*.html land in their custom viewers, plain files in the editor.
	await openFileAt(link.openPath, link.openLine);
}

/**
 * Rebuilds a call-tree snapshot the rail lists but disk does not have, then
 * opens it. Returns true when it handled the click.
 *
 * The rail's report list comes from the insight manifest, which records where
 * each snapshot WAS written — so a report deleted since (or one whose write
 * failed while its manifest entry landed) answered a click with "file not
 * found". That is an error about our own bookkeeping, and the user cannot act
 * on it. The snapshot is reproducible from the index and the capture, so
 * reproduce it.
 */
async function rebuildIfMissing(
	openPath: string,
	context: vscode.ExtensionContext,
): Promise<boolean> {
	const apiId = apiIdFromCallTreePath(openPath);
	if (!apiId || fs.existsSync(openPath)) {
		return false;
	}
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		return false;
	}
	// Pick the capture from the service that DEFINES this endpoint; without it
	// the engine overlays whichever service traced most recently.
	const file = readEntryPoints(root).find((e) => e.id === apiId)?.file;
	try {
		const built = await vscode.window.withProgress(
			// Status bar: this takes no cancellation token, and a notification-location
			// progress without `cancellable` has no close button at all — an
			// undismissable toast for a build that ends by opening its own result.
			{ location: vscode.ProgressLocation.Window, title: `Vinv: Building the call tree for ${apiId}…` },
			() => buildCallTreeReport(context, root, apiId, captureServiceFor(root, file)),
		);
		await openFileAt(built);
	} catch (e) {
		// Naming the endpoint matters: the usual cause is that nothing has traced
		// it yet, which is a thing the user can fix.
		void vscode.window.showErrorMessage(
			`Vinv: could not build the call tree for ${apiId} — ${e instanceof Error ? e.message : String(e)}. ` +
				'Run the service under tracing so there is a capture to overlay.',
		);
	}
	return true;
}

async function openFileAt(fsPath: string | undefined, line?: number): Promise<void> {
	const ext = fsPath ? path.extname(fsPath) : '';
	// .html (smoke reports) and extension-less custom docs go through the default
	// editor so their registered viewers claim them; everything else opens as
	// text at the requested line. Either way openPathInEditor verifies existence
	// and surfaces an actionable error instead of a silent no-op.
	const useDefaultEditor = ext === '.html' || !line;
	await openPathInEditor(fsPath, {
		label: 'file',
		line,
		preview: true,
		useDefaultEditor,
	});
}

function getFlowHtml(cspSource: string): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const csp = [
		`default-src 'none'`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
	].join('; ');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Vinv Flow</title>
	<style>
		${VINV_BASE_CSS}
		body { font-size: 11.5px; padding: 10px 12px 18px; }
		.pilot {
			display: none; align-items: center; gap: 8px;
			margin: 2px 0 12px; padding: 8px 10px;
			border: 1px solid var(--line-strong);
		}
		.pilot.on { display: flex; }
		.pilot .txt { color: var(--ink); font-size: 10.5px; letter-spacing: 0.06em; min-width: 0; }
		.pilot .txt b { display: block; font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--muted); }

		.next {
			display: none; margin: 2px 0 12px; padding: 10px 12px;
			border: 1px solid var(--accent-fg);
		}
		.next.on { display: block; }
		.next .k { font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--accent-fg); margin-bottom: 4px; }
		.next .why { color: var(--muted); margin: 6px 0 10px; line-height: 1.5; }
		.next button {
			display: inline-flex; align-items: center; gap: 6px;
			padding: 6px 12px; cursor: pointer; border-radius: 0;
			font-family: inherit; font-size: 10px; font-weight: 500;
			letter-spacing: 0.2em; text-transform: uppercase;
			background: var(--ink); color: var(--bg); border: 1px solid var(--ink);
			transition: background 0.2s, border-color 0.2s;
		}
		.next button:hover { background: var(--accent); border-color: var(--accent); color: #ffffff; }

		/* ---- the rail ---- */
		.rail { position: relative; }
		.stage { position: relative; padding: 0 0 14px 22px; }
		/* connector line between stage dots */
		.stage::before {
			content: ''; position: absolute; left: 5px; top: 16px; bottom: -2px;
			width: 1px; background: var(--line-strong);
		}
		.stage:last-child::before { display: none; }
		.dot {
			position: absolute; left: 0; top: 4px; width: 11px; height: 11px;
			border-radius: 50%; box-sizing: border-box;
			border: 1.5px solid var(--muted-2); background: var(--bg);
		}
		.stage.done .dot { border-color: var(--ok-fg); background: var(--ok-fg); }
		.stage.error .dot { border-color: var(--accent-fg); background: var(--accent-fg); }
		.stage.running .dot {
			--dot-ring: var(--accent-ring);
			--dot-ring-soft: var(--accent-ring-soft);
			border-color: var(--accent-fg); background: var(--accent-fg);
			box-shadow: 0 0 0 4px var(--dot-ring);
			animation: v-pulse 2.4s ease-in-out infinite;
		}
		.stage h2 {
			margin: 0; font-size: 12.5px; font-weight: 600;
			letter-spacing: 0.04em; color: var(--ink);
			display: flex; align-items: baseline; gap: 8px;
		}
		.stage.waiting h2 { color: var(--muted); font-weight: 400; }
		.stage h2 .st {
			font-size: 8.5px; letter-spacing: 0.2em; text-transform: uppercase;
			color: var(--muted-2);
		}
		.stage.error h2 .st, .stage.running h2 .st { color: var(--accent-fg); }
		.stage.done h2 .st { color: var(--ok-fg); }
		.summary { color: var(--muted); margin: 3px 0 0; line-height: 1.5; }
		.stage.error .summary { color: var(--accent-fg); }
		.activity { color: var(--accent-fg); margin: 3px 0 0; line-height: 1.5; }
		.links { margin: 6px 0 0; }
		.lnk-row { display: flex; align-items: stretch; gap: 2px; }
		.lnk-row > .lnk { flex: 1 1 auto; min-width: 0; }
		.act {
			flex: 0 0 auto; width: 22px; border: 0; border-radius: 3px; cursor: pointer;
			background: transparent; color: var(--vscode-foreground); opacity: .65;
			font-size: 10px; line-height: 1; padding: 0;
		}
		.act:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
		.lnk {
			display: flex; align-items: baseline; gap: 7px;
			width: 100%; text-align: left; box-sizing: border-box;
			padding: 3px 6px; margin: 0 0 1px -6px;
			background: transparent; border: none; border-left: 2px solid transparent;
			border-radius: 0; color: var(--ink); font-family: inherit; font-size: 11px;
			cursor: pointer; line-height: 1.45;
		}
		.lnk:hover { background: var(--bg-2); border-left-color: var(--accent-fg); }
		.lnk:disabled { cursor: default; }
		.lnk:disabled:hover { background: transparent; border-left-color: transparent; }
		.lnk .b {
			flex: none; width: 6px; height: 6px; border-radius: 50%;
			align-self: center; background: var(--muted-2);
		}
		.lnk.s-ok .b { background: var(--ok-fg); }
		.lnk.s-error .b { background: var(--accent-fg); }
		.lnk.s-running .b {
			--dot-ring: var(--accent-ring);
			--dot-ring-soft: var(--accent-ring-soft);
			background: var(--accent-fg);
			box-shadow: 0 0 0 3px var(--dot-ring);
			animation: v-pulse 2.4s ease-in-out infinite;
		}
		.lnk .lab { color: var(--ink); }
		.lnk.s-muted .lab { color: var(--muted); }
		.lnk .det { color: var(--muted-2); font-size: 10px; min-width: 0; }
		/* the "…and N more" / "Show less" toggle at the foot of a capped stage */
		.lnk.more .lab { color: var(--muted); letter-spacing: 0.04em; }
		.lnk.more .b { background: transparent; border: 1px solid var(--muted-2); box-shadow: none; }

		/* ---- issues ---- */
		.issues { display: none; margin-top: 6px; border: 1px solid var(--accent-fg); }
		.issues.on { display: block; }
		.issues .hd {
			padding: 7px 10px; background: var(--accent); color: #ffffff;
			font-size: 9.5px; letter-spacing: 0.22em; text-transform: uppercase;
		}
		.issue { padding: 9px 10px; border-top: 1px solid var(--line); }
		.issue:first-of-type { border-top: none; }
		.issue .t { color: var(--ink); font-weight: 600; line-height: 1.45; }
		.issue .d {
			color: var(--muted); margin-top: 3px; line-height: 1.5;
			font-size: 10.5px; word-break: break-word;
		}
		.issue .acts { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
		.issue button {
			padding: 4px 10px; cursor: pointer; border-radius: 0;
			font-family: inherit; font-size: 9px; font-weight: 500;
			letter-spacing: 0.18em; text-transform: uppercase;
			transition: background 0.2s, color 0.2s, border-color 0.2s;
		}
		.issue .fix { background: var(--accent); border: 1px solid var(--accent); color: #ffffff; }
		.issue .fix:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
		.issue .ev { background: transparent; border: 1px solid var(--line-strong); color: var(--ink); }
		.issue .ev:hover { border-color: var(--ink); }
		.issue .sent { align-self: center; font-size: 11px; letter-spacing: 0.04em; color: var(--muted); border: 1px dashed var(--line-strong); padding: 3px 8px; }

		/* ---- destinations footer ---- */
		.dests { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
		.dests .k {
			font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
			color: var(--muted-2); margin-bottom: 5px;
		}

		.empty { color: var(--muted); line-height: 1.6; padding: 4px 0; }
		.brand {
			display: flex; align-items: center; gap: 8px; margin: 0 0 12px;
			font-size: 10px; font-weight: 600; letter-spacing: 0.24em;
			text-transform: uppercase; color: var(--ink);
		}
		.brand em { font-family: ${VINV_FONT_MONO}; font-style: normal; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--muted); font-size: 11px; }
	</style>
</head>
<body>
	<div class="brand">Vinv Flow <em>start to finish</em></div>
	<div class="pilot" id="pilot"><span class="v-dot"></span><span class="txt" id="pilot-txt"></span></div>
	<div class="next" id="next">
		<div class="k">Next step</div>
		<div id="next-label" style="font-weight:600;"></div>
		<div class="why" id="next-why"></div>
		<button id="next-btn" type="button">Do it</button>
	</div>
	<div class="rail" id="rail"></div>
	<div class="issues" id="issues">
		<div class="hd" id="issues-hd">Problems found</div>
		<div id="issues-list"></div>
	</div>
	<div class="dests" id="dests">
		<div class="k">Open</div>
		<div id="dests-list"></div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		let model = null;
		let nextAction = null;
		// Stage ids whose overflow rows are showing. Lives outside render() so a
		// model post (they arrive on every pipeline tick) does not re-collapse a
		// list the user just opened.
		const expanded = new Set();

		function el(tag, cls, text) {
			const e = document.createElement(tag);
			if (cls) { e.className = cls; }
			if (text != null) { e.textContent = text; }
			return e;
		}

		function renderLink(link) {
			const b = el('button', 'lnk s-' + (link.state || 'muted'));
			b.type = 'button';
			b.appendChild(el('span', 'b'));
			b.appendChild(el('span', 'lab', link.label));
			if (link.detail) { b.appendChild(el('span', 'det', link.detail)); }
			const actionable = !!(link.command || link.openPath);
			if (actionable) {
				if (link.detail) { b.title = link.detail; }
				b.addEventListener('click', () => vscode.postMessage({ type: 'link', link }));
			} else {
				b.disabled = true;
			}
			const actions = (link.action ? [link.action] : []).concat(link.extraActions || []);
			if (!actions.length) { return b; }
			// The actions are SIBLINGS, not children: link rows are <button>, and a
			// nested button is invalid HTML that browsers reparent.
			const row = el('div', 'lnk-row');
			row.appendChild(b);
			const glyph = { play: '▶', stop: '■', gear: '⚙' };
			actions.forEach(function (action) {
				const act = el('button', 'act');
				act.type = 'button';
				act.title = action.title;
				act.textContent = glyph[action.icon] || '▶';
				act.addEventListener('click', (e) => {
					e.stopPropagation(); // never also trigger the row behind it
					vscode.postMessage({
						type: 'link',
						link: { label: link.label, command: action.command, args: action.args },
					});
				});
				row.appendChild(act);
			});
			return row;
		}

		/** The row that opens or closes a stage's overflow rows. */
		function renderMore(stageId, hidden, open) {
			const b = el('button', 'lnk s-muted more');
			b.type = 'button';
			b.appendChild(el('span', 'b'));
			b.appendChild(el('span', 'lab', open ? 'Show less' : '…and ' + hidden + ' more'));
			b.title = open ? 'Collapse this list' : 'Show the remaining ' + hidden;
			b.addEventListener('click', () => {
				if (open) { expanded.delete(stageId); } else { expanded.add(stageId); }
				render();
			});
			return b;
		}

		const STATUS_WORD = { done: 'done', running: 'running', waiting: 'waiting', error: 'needs attention' };

		function render() {
			if (!model) { return; }

			// Auto-Pilot banner (the spine's header).
			const pilot = document.getElementById('pilot');
			pilot.classList.toggle('on', model.autoPilot.running);
			if (model.autoPilot.running) {
				const txt = document.getElementById('pilot-txt');
				txt.textContent = '';
				txt.appendChild(el('b', null, 'Auto-Pilot is driving'));
				txt.appendChild(document.createTextNode(model.autoPilot.label || 'working…'));
			}

			// Single next action.
			const next = document.getElementById('next');
			nextAction = model.nextAction || null;
			next.classList.toggle('on', !!nextAction);
			if (nextAction) {
				document.getElementById('next-label').textContent = nextAction.label;
				document.getElementById('next-why').textContent = nextAction.why;
			}

			// The rail.
			const rail = document.getElementById('rail');
			rail.textContent = '';
			for (const s of model.stages) {
				const st = el('div', 'stage ' + s.status);
				st.appendChild(el('span', 'dot'));
				const h = el('h2', null, s.title);
				h.appendChild(el('span', 'st', STATUS_WORD[s.status] || s.status));
				st.appendChild(h);
				if (s.activity) {
					st.appendChild(el('div', 'activity', s.activity));
				} else {
					st.appendChild(el('div', 'summary', s.summary));
				}
				if (s.links.length) {
					const box = el('div', 'links');
					const shown = s.links.filter((l) => !l.overflow);
					const hidden = s.links.filter((l) => l.overflow);
					for (const l of shown) { box.appendChild(renderLink(l)); }
					if (hidden.length) {
						const open = expanded.has(s.id);
						box.appendChild(renderMore(s.id, hidden.length, open));
						if (open) { for (const l of hidden) { box.appendChild(renderLink(l)); } }
					}
					st.appendChild(box);
				}
				rail.appendChild(st);
			}

			// Issues.
			const wrap = document.getElementById('issues');
			wrap.classList.toggle('on', model.issues.length > 0);
			document.getElementById('issues-hd').textContent =
				model.issues.length === 1 ? '1 problem found' : model.issues.length + ' problems found';
			const list = document.getElementById('issues-list');
			list.textContent = '';
			for (const issue of model.issues) {
				const item = el('div', 'issue');
				item.appendChild(el('div', 't', issue.title));
				if (issue.detail) { item.appendChild(el('div', 'd', issue.detail)); }
				const acts = el('div', 'acts');
				if (issue.dispatched) {
					// Auto-dispatch already fired — show the state, not a button
					// (a second click would just hit the dedup anyway).
					acts.appendChild(el('span', 'sent', 'Fix sent — agent working'));
				} else {
					const fix = el('button', 'fix', 'Fix with agent');
					fix.type = 'button';
					fix.addEventListener('click', () =>
						vscode.postMessage({ type: 'fix', fixArgs: issue.fixArgs }));
					acts.appendChild(fix);
				}
				if (issue.evidencePath) {
					const ev = el('button', 'ev', 'See evidence');
					ev.type = 'button';
					ev.addEventListener('click', () =>
						vscode.postMessage({ type: 'evidence', path: issue.evidencePath, line: issue.evidenceLine }));
					acts.appendChild(ev);
				}
				item.appendChild(acts);
				list.appendChild(item);
			}

			// Destinations. Reuses renderLink so a footer row behaves exactly like
			// a stage row — same hover, same dot, same message back.
			const dests = document.getElementById('dests-list');
			dests.textContent = '';
			for (const d of model.destinations || []) { dests.appendChild(renderLink(d)); }
		}

		document.getElementById('next-btn').addEventListener('click', () => {
			if (nextAction) {
				vscode.postMessage({ type: 'action', command: nextAction.command, args: nextAction.args });
			}
		});

		window.addEventListener('message', (event) => {
			if (event.data && event.data.type === 'model') {
				model = event.data.model;
				render();
			}
		});
	</script>
</body>
</html>`;
}
