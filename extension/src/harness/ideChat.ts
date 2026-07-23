/**
 * IDE-chat hand-off transport: instead of piping a prompt into a headless CLI,
 * the task is handed to the host editor's own agent panel. The panel exposes
 * no stdout or exit event, so the hand-off uses a file protocol:
 *
 *   1. the full instruction is written to .vinv/handoff/<name>.prompt.md,
 *   2. a short bootstrap prompt (read the file, do the task, write your final
 *      report to .vinv/handoff/<name>.response.md) is delivered to the panel —
 *      submitted outright where the editor allows it, pre-filled/copied where
 *      it does not,
 *   3. Vinv polls for the response file; its content stands in for the CLI's
 *      stdout, so directives (VINV:) and verification work unchanged.
 *
 * Per-panel delivery: Copilot Chat accepts `workbench.action.chat.open`
 * (documented VS Code command) which SUBMITS the prompt in a fresh chat — the
 * agent starts with no human step. Cursor's documented prompt deeplink
 * (cursor://anysphere.cursor-deeplink/prompt) only pre-fills — Cursor
 * explicitly refuses auto-execution for deeplinks — and Cascade has no
 * programmatic prompt API at all, so its bootstrap goes to the clipboard.
 * For those two the missing submission is injected as a real OS-level
 * keystroke (autoSend.ts), guarded to only fire while that editor is the
 * foreground app. When the injection cannot run (focus stolen, no macOS
 * accessibility permission, no xdotool), the run downgrades to manual and the
 * wait loop keeps saying so instead of pretending the agent is running.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { HarnessDef, HarnessRunResult } from './harnessRunner';
import { injectSubmitKeys } from './autoSend';

/**
 * True when this harness's chat panel can be reached from the current window:
 * the host editor matches and any required extension is installed.
 */
export function isIdeChatAvailable(harness: HarnessDef): boolean {
	if (harness.kind !== 'ide-chat' || !harness.chat) {
		return false;
	}
	if (harness.chat.appPattern && !harness.chat.appPattern.test(vscode.env.appName)) {
		return false;
	}
	if (
		harness.chat.requiresExtension &&
		!vscode.extensions.getExtension(harness.chat.requiresExtension)
	) {
		return false;
	}
	return true;
}

function handoffDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'handoff');
}

/** Workspace-relative path with forward slashes (readable in any chat panel). */
function relPath(name: string, suffix: string): string {
	return `.vinv/handoff/${name}.${suffix}.md`;
}

function bootstrapPrompt(name: string): string {
	return (
		'You are handling a Vinv task in this workspace.\n' +
		`1. Read and follow the full instructions in \`${relPath(name, 'prompt')}\` (relative to the workspace root).\n` +
		'2. Work autonomously until the task is complete.\n' +
		`3. When you are finished, write your complete final report — everything the instructions ask you to output, including any VINV: directive lines — to \`${relPath(name, 'response')}\`. ` +
		'Vinv is watching for that file; creating it signals you are done, so write it exactly once, at the very end.\n' +
		'You can steer Vinv from this chat via directive lines in that report: `vinv: episodes <n>` sets the session episode budget (1-20), `vinv: goal <text>` updates the standing goal, `vinv: dispute <reason>` contests the task premise.'
	);
}

/** How the bootstrap reached the panel: 'auto' = submitted, the agent is
 * already running; 'manual' = pre-filled/copied, a human must still send it. */
type Delivery = 'auto' | 'manual';

async function copyToClipboard(harness: HarnessDef, bootstrap: string): Promise<void> {
	await vscode.env.clipboard.writeText(bootstrap);
	void vscode.window.showInformationMessage(
		`Vinv: Hand-off prompt copied to the clipboard — open ${harness.label.replace(/ \(.*\)$/, '')} (Ctrl+L / Cmd+L), paste, and send.`,
	);
}

/** Delivers the bootstrap prompt to the panel, auto-submitting where the
 * editor allows it (only Copilot's chat command does today). */
async function deliver(harness: HarnessDef, bootstrap: string): Promise<Delivery> {
	const mechanism = harness.chat?.mechanism;
	if (mechanism === 'chat-command') {
		try {
			// One task, one conversation: chat.open submits into whatever session
			// the panel currently shows, so without this every dispatch would pile
			// onto the previous task's chat and inherit its context. Best-effort:
			// if the command is missing, the submission below still works.
			try {
				await vscode.commands.executeCommand('workbench.action.chat.newChat');
			} catch {
				// Older editors: no new-chat command — reuse the open session.
			}
			// Documented VS Code command: without isPartialQuery the query is
			// SUBMITTED, not just pre-filled — the agent starts immediately.
			// mode: 'agent' selects the agentic (file-editing) mode; editors that
			// predate it ignore the extra property.
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: bootstrap,
				mode: 'agent',
			});
			void vscode.window.showInformationMessage(
				`Vinv: Prompt submitted to ${harness.label} in a fresh chat — the agent is running.`,
			);
			return 'auto';
		} catch {
			await copyToClipboard(harness, bootstrap);
			return 'manual';
		}
	}
	if (mechanism === 'deeplink') {
		// Documented Cursor deeplink; pre-fills the chat (and focuses its
		// input) but never submits it — Cursor rejects deeplink auto-execution
		// by design. So the missing Enter is injected as a real OS keystroke,
		// guarded so it only fires while Cursor is the foreground app (see
		// autoSend.ts). The bootstrap is a few hundred chars — far under the
		// 8,000-char cap.
		const uri = vscode.Uri.parse(
			`cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(bootstrap)}`,
		);
		const opened = await vscode.env.openExternal(uri).then(
			(ok) => ok,
			() => false,
		);
		if (opened) {
			// Give the deeplink time to land in the panel and take focus.
			await new Promise((r) => setTimeout(r, 1500));
			if (await injectSubmitKeys({ appHint: 'Cursor', paste: false })) {
				void vscode.window.showInformationMessage(
					'Vinv: Prompt sent to the Cursor chat panel and submitted — the agent is running.',
				);
				return 'auto';
			}
			void vscode.window.showInformationMessage(
				'Vinv: Prompt placed in the Cursor chat panel — auto-send did not go through, press Enter there to start the agent.',
			);
			return 'manual';
		}
		await copyToClipboard(harness, bootstrap);
		return 'manual';
	}
	// Clipboard route (Cascade): no prompt API at all. Best effort: focus the
	// Cascade input via whichever command this Windsurf build exposes, then
	// inject paste+Enter. The keystrokes are NEVER sent blind — without a
	// confirmed focus command they could land in the code editor (Ctrl+V into
	// a source file), so failing that check falls back to manual paste.
	await vscode.env.clipboard.writeText(bootstrap);
	if (await focusCascadeInput()) {
		await new Promise((r) => setTimeout(r, 600));
		if (await injectSubmitKeys({ appHint: 'Windsurf', paste: true })) {
			void vscode.window.showInformationMessage(
				`Vinv: Prompt pasted into ${harness.label} and submitted — the agent is running.`,
			);
			return 'auto';
		}
	}
	void vscode.window.showInformationMessage(
		`Vinv: Hand-off prompt copied to the clipboard — open ${harness.label.replace(/ \(.*\)$/, '')} (Ctrl+L / Cmd+L), paste, and send.`,
	);
	return 'manual';
}

/**
 * Focuses Cascade's chat input via Windsurf's own command, trying the ids
 * different builds have shipped under. Returns false when none exists — the
 * caller must then NOT inject keystrokes (they would hit the text editor).
 */
async function focusCascadeInput(): Promise<boolean> {
	const known = await vscode.commands.getCommands(true);
	const candidates = [
		'windsurf.prioritized.chat.open',
		'windsurf.prioritized.chat.openNewConversation',
		'windsurf.openChat',
		'codeium.openChatView',
	];
	for (const id of candidates) {
		if (!known.includes(id)) {
			continue;
		}
		try {
			await vscode.commands.executeCommand(id);
			return true;
		} catch {
			// Try the next id.
		}
	}
	return false;
}

/**
 * Hand one prompt to the editor's chat panel and wait for the response file.
 * Mirrors runHarnessPrompt's contract: resolves with the agent's report as
 * `stdout`. There is no timeout — panel agents report no progress — only
 * cancellation (the surrounding progress notifications are all cancellable).
 */
export async function runIdeChatPrompt(
	harness: HarnessDef,
	workspaceRoot: string,
	name: string,
	prompt: string,
	options?: { onUpdate?: (line: string) => void; token?: vscode.CancellationToken },
): Promise<HarnessRunResult> {
	const dir = handoffDir(workspaceRoot);
	const promptPath = path.join(dir, `${name}.prompt.md`);
	const responsePath = path.join(dir, `${name}.response.md`);
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.rmSync(responsePath, { force: true }); // a stale response must not pass for a fresh one
		fs.writeFileSync(promptPath, prompt);
	} catch (e) {
		return {
			ok: false,
			exitCode: null,
			stdout: '',
			detail: `could not write the hand-off files: ${e instanceof Error ? e.message : String(e)}`,
		};
	}

	const delivery = await deliver(harness, bootstrapPrompt(name));
	// The feed line the operator sees while polling. A manual hand-off must
	// keep saying "the ball is in your court" — a generic "waiting for Cursor
	// to finish" reads as if the agent were running when nothing has been
	// submitted yet. (Whether the human has since pressed Enter is
	// unobservable, so the reminder stays conditional.)
	const panelName = harness.label.replace(/ \(.*\)$/, '');
	const waitingLine =
		delivery === 'auto'
			? `waiting for ${harness.label} to finish and write ${relPath(name, 'response')}…`
			: harness.chat?.mechanism === 'clipboard'
				? `action needed if not done yet: open ${panelName} (Ctrl+L / Cmd+L), paste the prompt, and send it — then I wait for ${relPath(name, 'response')}`
				: `action needed if not done yet: press Enter on the pre-filled prompt in ${panelName} — then I wait for ${relPath(name, 'response')}`;

	// Wait for the agent to write the response. Size-stability across two polls
	// guards against reading a file mid-write.
	const wait = async (token: vscode.CancellationToken): Promise<HarnessRunResult> => {
		let lastSize = -1;
		let polls = 0;
		for (;;) {
			if (token.isCancellationRequested) {
				return { ok: false, exitCode: null, stdout: '', detail: 'cancelled' };
			}
			let size: number | null = null;
			try {
				const stat = fs.statSync(responsePath);
				size = stat.size;
			} catch {
				// Not written yet.
			}
			if (size !== null && size > 0 && size === lastSize) {
				try {
					const content = fs.readFileSync(responsePath, 'utf8');
					return { ok: true, exitCode: 0, stdout: content };
				} catch (e) {
					return {
						ok: false,
						exitCode: null,
						stdout: '',
						detail: `could not read the response file: ${e instanceof Error ? e.message : String(e)}`,
					};
				}
			}
			lastSize = size ?? -1;
			polls += 1;
			if (polls % 10 === 1) {
				options?.onUpdate?.(waitingLine);
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
	};

	if (options?.token) {
		return wait(options.token);
	}
	// No caller-supplied cancellation (e.g. the QnA panel): surface our own
	// cancellable notification so an abandoned chat can't hold the harness
	// lock for the rest of the window's life.
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Vinv: ${waitingLine}`,
			cancellable: true,
		},
		(_progress, token) => wait(token),
	);
}
