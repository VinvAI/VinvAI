/**
 * The human end of configuration escalation.
 *
 * The engine tries hard not to need this. It reads what the repo publishes
 * (`.env`, `.env.example`), then induces the rest from the target's own failure
 * — supply a value, read the complaint, escalate the shape, retry. What reaches
 * here is only what neither of those could produce: a value with real-world
 * meaning that no ladder can invent, or a credential, which nothing may
 * synthesise ever.
 *
 * Those land in `.vinv/exercise/config_requests.json` already described — what
 * the variable is, an example of a well-formed value, whether it is secret,
 * which modules it blocks, and what the harness already tried. This renders
 * that as a form, writes `config_answers.json`, and re-runs. Nothing here
 * decides anything; the engine did the deciding and this is the field it could
 * not fill.
 *
 * Two rules the UI has to keep:
 *
 *  - a secret is typed into a masked field and written ONLY to
 *    `config_answers.json` — never echoed back into the panel's model, never
 *    logged, never put in a status line. `config_requests.json` carries the
 *    question and never the answer.
 *  - a request the engine has stopped asking for disappears. The file is
 *    rewritten every run, including empty, so a stale prompt for a variable
 *    that is now satisfied cannot persist.
 *
 * The pure parts — reading the model, validating, building the answers document
 * — are exported and unit-tested without a webview, matching the convention in
 * `exerciseRunner`/`flowPanel`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { trackUi } from '../telemetry/instrument';

import { VINV_BASE_CSS, VINV_FONT_MONO } from './webviewTheme';

/** One variable the engine could not supply, as `envconfig` describes it. */
export interface ConfigRequest {
	variable: string;
	secret: boolean;
	description: string;
	example?: string | null;
	blocked_modules: string[];
	blocked_count: number;
	tried: string[];
	reason: string;
	status: string;
}

export interface ConfigRequestsDoc {
	version?: number;
	repo?: string;
	answers_path?: string;
	requests?: ConfigRequest[];
}

export function configRequestsPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'exercise', 'config_requests.json');
}

export function configAnswersPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'exercise', 'config_answers.json');
}

/**
 * What the engine is currently asking for, or an empty list.
 *
 * An unreadable or absent file means nothing is being asked — not an error. The
 * engine writes this file on every run, so its absence means no run has got far
 * enough to ask, and a panel showing nothing is the correct rendering of that.
 */
export function readConfigRequests(workspaceRoot: string): ConfigRequest[] {
	try {
		const doc = JSON.parse(
			fs.readFileSync(configRequestsPath(workspaceRoot), 'utf8'),
		) as ConfigRequestsDoc;
		const requests = doc.requests;
		return Array.isArray(requests) ? requests.filter((r) => r && r.variable) : [];
	} catch {
		return [];
	}
}

/**
 * Keep only answers to variables actually being asked for, with a real value.
 *
 * A blank field means "I don't know either" and must not be written: an empty
 * string is a VALUE, and the engine would dutifully export it, satisfy the
 * variable's presence check, and fail somewhere less obvious. Leaving it unset
 * keeps the induction ladder and the escalation working on it.
 */
export function buildAnswers(
	requests: ConfigRequest[],
	submitted: Record<string, string>,
): Record<string, string> {
	const asked = new Set(requests.map((r) => r.variable));
	const answers: Record<string, string> = {};
	for (const [name, raw] of Object.entries(submitted)) {
		if (!asked.has(name)) {continue;}
		const value = typeof raw === 'string' ? raw.trim() : '';
		if (!value) {continue;}
		answers[name] = value;
	}
	return answers;
}

/**
 * Merge new answers into whatever is already on disk and write it.
 *
 * Merged rather than replaced: a user answering two variables today and one
 * tomorrow must not lose the first two, and the engine reads this file whole.
 */
export function writeAnswers(
	workspaceRoot: string,
	answers: Record<string, string>,
): number {
	const target = configAnswersPath(workspaceRoot);
	let existing: Record<string, string> = {};
	try {
		const doc = JSON.parse(fs.readFileSync(target, 'utf8')) as { answers?: Record<string, string> };
		if (doc.answers && typeof doc.answers === 'object') {existing = doc.answers;}
	} catch {
		existing = {};
	}
	const merged = { ...existing, ...answers };
	fs.mkdirSync(path.dirname(target), { recursive: true });
	// OWNER-ONLY. This is the one file in `.vinv/` whose entire content is
	// credentials a human typed, and the default 0644 makes it readable by every
	// account on the machine — the standard other tools hold plaintext secrets to
	// is 0600 (`~/.aws/credentials`, `~/.netrc`, which ssh and curl refuse when
	// it is group-readable). `mode` on writeFileSync only applies when the file
	// is CREATED, so an existing file is chmod-ed explicitly; both are no-ops on
	// Windows, which is why they are not a substitute for `.vinv/` being
	// gitignored.
	fs.writeFileSync(target, JSON.stringify({ version: 1, answers: merged }, null, 2), {
		encoding: 'utf8',
		mode: 0o600,
	});
	try {
		fs.chmodSync(target, 0o600);
	} catch {
		// A filesystem without POSIX modes is not a reason to fail the save.
	}
	return Object.keys(answers).length;
}

/** The model the webview renders. Secrets carry no value, only the question. */
export interface ConfigPanelModel {
	requests: ConfigRequest[];
	repoLabel: string;
}

export function buildModel(workspaceRoot: string): ConfigPanelModel {
	return {
		requests: readConfigRequests(workspaceRoot),
		repoLabel: path.basename(workspaceRoot),
	};
}

/** Actions the panel performs, injected so the wiring is testable. */
export interface ConfigPanelActions {
	/** Persist answers; returns how many landed. */
	save: (answers: Record<string, string>) => number;
	/** Re-run the pipeline so the answers take effect. */
	rerun: () => Promise<void>;
	showError: (message: string) => void;
	/**
	 * Confirm what landed and where.
	 *
	 * Saving disposes the panel, so without this the entire visible response to
	 * pasting a credential is the tab vanishing. Say what was written and that a
	 * re-run started, or the user has no way to tell a save from a crash.
	 */
	notify: (message: string) => void;
}

/**
 * The message arm, separated from the panel so it can be driven directly.
 *
 * Returns what happened so a caller (and a test) can assert on it rather than
 * inferring from side effects.
 */
export async function handlePanelMessage(
	message: { type?: string; values?: Record<string, string> },
	requests: ConfigRequest[],
	actions: ConfigPanelActions,
): Promise<{ saved: number; reran: boolean }> {
	if (message?.type !== 'submit') {return { saved: 0, reran: false };}
	const answers = buildAnswers(requests, message.values ?? {});
	if (Object.keys(answers).length === 0) {
		actions.showError('Nothing to save — fill in at least one value.');
		return { saved: 0, reran: false };
	}
	let saved = 0;
	try {
		saved = actions.save(answers);
	} catch (err) {
		actions.showError(
			`Could not write the answers: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { saved: 0, reran: false };
	}
	// Names the file so a user who pasted a credential can go verify where it
	// went — and its permissions — without taking our word for it.
	actions.notify(
		`Saved ${saved} value${saved === 1 ? '' : 's'} to .vinv/exercise/config_answers.json ` +
			'(owner-only) — re-running.',
	);
	// Re-running is the whole point — an answer that sits on disk until someone
	// remembers to press play is the same stall in a different place.
	await actions.rerun();
	return { saved, reran: true };
}

/** The panel's HTML, in the Vinv design system. */
export function getConfigPanelHtml(cspSource: string, model: ConfigPanelModel): string {
	// A nonce rather than `'unsafe-inline'` for scripts. The panel renders strings
	// this process did not author — a variable name and description from a model,
	// and the TARGET REPO's own error text under "why Vinv is asking". Escaping is
	// what stops those becoming markup and it is applied at every interpolation;
	// the nonce is the second wall, so a missed one is not immediately executable.
	// Styles keep `'unsafe-inline'`: the stylesheet is a literal in this file.
	const nonce = randomBytes(16).toString('base64');
	const rows = model.requests
		.map((r) => {
			const kind = r.secret ? 'password' : 'text';
			const badge = r.secret
				? '<span class="badge secret">secret</span>'
				: '<span class="badge">value</span>';
			const example = r.example
				? `<div class="hint">example: <code>${escapeHtml(r.example)}</code></div>`
				: '';
			const blocked = r.blocked_count
				? `<div class="hint">blocks ${r.blocked_count} module${r.blocked_count === 1 ? '' : 's'}: <code>${escapeHtml(r.blocked_modules.slice(0, 3).join(', '))}</code></div>`
				: '';
			const tried = r.tried?.length
				? `<div class="hint dim">already tried: ${escapeHtml(r.tried.join(', '))}</div>`
				: '';
			return `
			<div class="field">
				<label for="f-${escapeHtml(r.variable)}">
					<span class="name">${escapeHtml(r.variable)}</span>${badge}
				</label>
				<div class="desc">${escapeHtml(r.description)}</div>
				${example}${blocked}${tried}
				<input id="f-${escapeHtml(r.variable)}" data-var="${escapeHtml(r.variable)}"
				       type="${kind}" autocomplete="off" spellcheck="false"
				       placeholder="${r.secret ? 'paste the value — it is written only to .vinv, never shown again' : 'value'}" />
				<details class="why"><summary>why Vinv is asking</summary>
					<pre>${escapeHtml(r.reason)}</pre>
				</details>
			</div>`;
		})
		.join('\n');

	const body = model.requests.length
		? `<form id="form">${rows}
			<div class="actions">
				<button type="submit" class="primary">Save &amp; re-run</button>
			</div>
		 </form>`
		: `<div class="empty">
				<p>Nothing to configure.</p>
				<p class="dim">Vinv resolved this repository's environment on its own,
				   or no run has needed configuration yet.</p>
			</div>`;

	return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${VINV_BASE_CSS}
body { font-family: ${VINV_FONT_MONO}; padding: 18px 20px; }
h1 { font-family: ${VINV_FONT_MONO}; font-weight: 400; font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: 12px; margin-bottom: 18px; }
.field { border: 1px solid var(--line); padding: 12px 14px; margin-bottom: 14px; }
label { display: flex; align-items: center; gap: 8px; }
.name { font-weight: 600; letter-spacing: .02em; }
.badge { font-size: 10px; text-transform: uppercase; letter-spacing: .08em;
         border: 1px solid var(--line-strong); padding: 1px 6px; color: var(--muted); }
.badge.secret { border-color: var(--accent-fg); color: var(--accent-fg); }
.desc { color: var(--ink-soft); font-size: 12.5px; margin: 6px 0; }
.hint { color: var(--muted); font-size: 11.5px; }
.hint.dim, .dim { color: var(--muted-2); }
input { width: 100%; box-sizing: border-box; margin-top: 8px; padding: 7px 9px;
        font-family: ${VINV_FONT_MONO}; font-size: 12.5px; border: 1px solid var(--line-strong);
        background: var(--bg-2); color: var(--ink); border-radius: 0; }
input:focus { outline: 2px solid var(--accent-fg); outline-offset: -2px; }
.why { margin-top: 8px; }
.why summary { cursor: pointer; font-size: 11.5px; color: var(--muted); }
.why pre { white-space: pre-wrap; font-size: 11px; color: var(--muted);
           border-left: 2px solid var(--line); padding-left: 8px; margin: 6px 0 0; }
.actions { margin-top: 16px; }
button.primary { font-family: ${VINV_FONT_MONO}; font-size: 12.5px; padding: 8px 16px;
                 background: var(--ok); color: #ffffff; border: none; cursor: pointer; }
button.primary:hover { background: var(--ok-hover); }
.empty { color: var(--muted); font-size: 13px; }
</style></head><body>
<h1>Vinv needs a few values</h1>
<div class="sub">${escapeHtml(model.repoLabel)} — Vinv derived everything it could from this
repository and its own failures. These are what it could not.</div>
${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const form = document.getElementById('form');
if (form) {
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		const values = {};
		for (const input of document.querySelectorAll('input[data-var]')) {
			values[input.getAttribute('data-var')] = input.value;
		}
		vscode.postMessage({ type: 'submit', values });
	});
}
</script></body></html>`;
}

function escapeHtml(text: string): string {
	return String(text ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Open the panel for a workspace. Returns undefined when nothing is being asked.
 */
export function openConfigRequestPanel(
	workspaceRoot: string,
	actions: ConfigPanelActions,
): vscode.WebviewPanel | undefined {
	const model = buildModel(workspaceRoot);
	if (model.requests.length === 0) {return undefined;}

	const panel = vscode.window.createWebviewPanel(
		'vinv.configRequests',
		'Vinv — configure this project',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.webview.html = getConfigPanelHtml(panel.webview.cspSource, model);
	panel.webview.onDidReceiveMessage(async (message) => {
		trackUi('config_requests', (message as { type?: string })?.type ?? 'unknown');
		const outcome = await handlePanelMessage(message, model.requests, actions);
		if (outcome.saved > 0) {panel.dispose();}
	});
	return panel;
}
