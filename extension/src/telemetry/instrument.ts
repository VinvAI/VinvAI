/**
 * The instrumentation wrappers.
 *
 * The design rule for this whole effort is ONE WRAPPER PER CATEGORY OF SITE, not
 * one edit per site. The extension has 42 commands, 11 progress-reporting
 * operations, ~40 user-visible error surfaces and 21 copies of the same
 * "no folder open" dead-end. Hand-editing each would be a diff nobody can
 * review, and would rot the moment someone adds the 43rd command.
 *
 * So each wrapper is a drop-in replacement for the vscode API it fronts, with
 * identical semantics plus one event. Behaviour must be unchanged — in
 * particular `registerTrackedCommand` still rethrows, so VS Code still shows the
 * error it always showed.
 */
import * as vscode from 'vscode';
import type { ErrorCode, LongOpId, Outcome, WebviewId } from './events';
import { bucketMs, classifyError, messageDigest, track } from './index';

/** VS Code signals user cancellation by name, not by type. */
function isCancellation(e: unknown): boolean {
	if (e instanceof vscode.CancellationError) {
		return true;
	}
	const name = (e as { name?: unknown } | null)?.name;
	return name === 'Canceled' || name === 'CancellationError';
}

/**
 * Drop-in for `vscode.commands.registerCommand`, plus a `command_finished`
 * event carrying the outcome and how long it took.
 *
 * One semantic note: wrapping makes a synchronous handler's return value a
 * Thenable. That is safe here — `executeCommand` already returns a Thenable
 * regardless of what the handler returns, and no Vinv call site consumes a
 * command result synchronously.
 */
export function registerTrackedCommand(
	id: string,
	handler: (...args: never[]) => unknown,
	thisArg?: unknown,
): vscode.Disposable {
	return vscode.commands.registerCommand(id, async (...args: never[]) => {
		const started = Date.now();
		let outcome: Outcome = 'ok';
		let errorClass;
		let errorDigest;
		// Emitted before the handler runs, so a command that hangs or takes the
		// window down with it still leaves a record that it was invoked. A
		// completion-only event cannot count the runs that never complete.
		track('command_started', { command_id: id });
		try {
			return await (handler as (...a: unknown[]) => unknown).apply(thisArg, args);
		} catch (e) {
			outcome = isCancellation(e) ? 'cancelled' : 'error';
			errorClass = classifyError(e);
			errorDigest = messageDigest(
				typeof (e as { message?: unknown } | null)?.message === 'string'
					? ((e as { message: string }).message)
					: '',
			);
			// Rethrow: the user's experience of a failing command is unchanged.
			throw e;
		} finally {
			track('command_finished', {
				command_id: id,
				outcome,
				duration_ms: bucketMs(Date.now() - started),
				error_class: errorClass,
				error_digest: errorDigest,
			});
		}
	});
}

/**
 * The workspace-folder precondition, in one place.
 *
 * `'Vinv: Open a folder first.'` was copied into 21 command handlers, which made
 * the single most common dead-end in the extension both unmeasurable and
 * tedious to change. Returns the folder itself rather than a path so it is a
 * drop-in for the `workspaceFolders?.[0]` it replaces.
 */
export function requireWorkspaceFolder(commandId: string): vscode.WorkspaceFolder | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		return folder;
	}
	void vscode.window.showWarningMessage('Vinv: Open a folder first.');
	track('command_blocked_no_folder', { command_id: commandId });
	return undefined;
}

/**
 * Shows an error AND records that it was shown.
 *
 * The message text is never transmitted. What travels is `code` — a stable id
 * assigned here, at the call site, by a human — so the set of failures Vinv can
 * report is closed and reviewable instead of being whatever string the code
 * happened to build. `action_taken` comes back too, which is how you find
 * remediation buttons that nobody ever clicks.
 */
export async function notifyError(
	code: ErrorCode,
	message: string,
	...actions: string[]
): Promise<string | undefined> {
	const choice = await vscode.window.showErrorMessage(message, ...actions);
	track('error_shown', { code, surface: 'error', action_taken: actionToken(choice) });
	return choice;
}

/** As notifyError, for the warning surface. */
export async function notifyWarning(
	code: ErrorCode,
	message: string,
	...actions: string[]
): Promise<string | undefined> {
	const choice = await vscode.window.showWarningMessage(message, ...actions);
	track('error_shown', { code, surface: 'warning', action_taken: actionToken(choice) });
	return choice;
}

/**
 * Button labels are human prose ("⭐ Star on GitHub"), which the allowlist would
 * reject and which would be unbounded cardinality anyway. What matters is which
 * of the offered buttons was pressed, so send the index-free token form.
 */
function actionToken(choice: string | undefined): string {
	return choice === undefined ? 'dismissed' : token(choice);
}

/**
 * Records one interaction inside a Vinv surface.
 *
 * Every panel already routes its user interactions through a single
 * `onDidReceiveMessage` switch keyed by a message type, so this sits at that
 * switch and captures the whole surface in one line rather than one line per
 * button. `action` is that message type: a vocabulary the panels already
 * define, already closed, and already named after what the user did.
 *
 * `detail` is for the one extra dimension that matters for some actions (which
 * tab, which verdict, which filter). It is normalised to a token — never a
 * path, an endpoint id, or anything drawn from the user's code.
 */
export function trackUi(view: WebviewId, action: string, detail?: string): void {
	track('ui_action', {
		view,
		action: token(action),
		detail: detail === undefined ? undefined : token(detail),
	});
}

/**
 * Records a renderer crash reported over the shared `webviewError` channel.
 *
 * Six panels already install `window.onerror` / `unhandledrejection` handlers
 * that post `{ type: 'webviewError', message, stack }` to the extension host —
 * and every one of those handlers currently drops the message on the floor.
 * Renderer crashes are therefore completely invisible today, which is why the
 * Graph Explorer or the Journey view failing to draw produces no signal at all.
 *
 * The message and the stack are NOT sent: a stack is absolute paths and a
 * message can quote the user's code. What travels is the error class and a
 * one-way digest, which is enough to count distinct renderer bugs and rank
 * them, and not enough to reconstruct anything.
 */
export function reportWebviewError(view: WebviewId, raw: { message?: unknown }): void {
	const message = typeof raw.message === 'string' ? raw.message : '';
	track('webview_error', {
		view,
		error_class: classifyError(message ? { message } : undefined),
		digest: messageDigest(message),
	});
}

/** Records that a panel or custom editor was opened. */
export function trackViewOpened(view: WebviewId): void {
	track('view_opened', { view });
}

/** Normalises an arbitrary label into something the allowlist will accept. */
function token(value: string): string {
	return (
		String(value)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.slice(0, 48) || 'unknown'
	);
}

/**
 * Times a long-running operation and records how it ended.
 *
 * These are the waits users actually feel — indexing, exercising endpoints, an
 * agent episode — so their duration distribution and their cancellation rate
 * are the closest thing to a direct measure of patience running out.
 */
export async function trackLongOp<T>(op: LongOpId, run: () => Promise<T>): Promise<T> {
	const started = Date.now();
	let outcome: Outcome = 'ok';
	try {
		return await run();
	} catch (e) {
		outcome = isCancellation(e) ? 'cancelled' : 'error';
		throw e;
	} finally {
		track('long_op_finished', {
			op,
			outcome,
			duration_ms: bucketMs(Date.now() - started),
		});
	}
}
