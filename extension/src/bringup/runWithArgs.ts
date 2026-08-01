/**
 * Asking the operator WHICH invocation to run, and with WHAT arguments.
 *
 * Every prompt in the run path lives here, and nowhere else. That separation is
 * load-bearing rather than tidy: `startService` is called by probeRunner, by
 * Auto-Pilot and by the replay gate, all headless, and a modal inside it would
 * hang a pipeline nobody is watching. So the rule is one line long — **the
 * command layer decides, the runner obeys**. By the time a choice reaches
 * `startService` it is already made.
 *
 * The form is a QuickPick over the parameters rather than a chain of input
 * boxes, because a chain has no back button: get the third of five values wrong
 * and Escape throws away the two before it. Here every value is visible at once,
 * any one can be re-edited, and the command that will actually run is shown
 * underneath — which is the thing the operator is really checking.
 */
import * as vscode from 'vscode';

import {
	InvocationRenderError,
	defaultArgs,
	readInvocations,
	readLastInvocation,
	readRunArgs,
	resolvedCommand,
	type Invocation,
	type InvocationParam,
} from './invocations';
import { readEntryPoints } from '../identification/identification';

/** What the operator settled on, ready to hand to `startService`. */
export interface RunChoice {
	invocation: string;
	args: Record<string, string>;
}

/** The command as it will be run, or the reason it cannot be. */
function preview(invocation: Invocation, args: Record<string, string>): string {
	try {
		return resolvedCommand(invocation, args);
	} catch (e) {
		return e instanceof InvocationRenderError ? `⚠ ${e.message}` : String(e);
	}
}

/**
 * The values offered for a parameter, resolved at prompt time.
 *
 * `choices_from: "entrypoints"` is read from the live inventory rather than a
 * list frozen into the record: a library's exported callables change with every
 * index build, so a pinned list would offer functions that no longer exist.
 */
function choicesFor(param: InvocationParam, workspaceRoot: string): string[] | undefined {
	if (param.choices && param.choices.length > 0) {
		return param.choices;
	}
	if (param.choices_from !== 'entrypoints') {
		return undefined;
	}
	const handlers = readEntryPoints(workspaceRoot)
		.filter((e) => e.kind !== 'http_api' && e.handler)
		.map((e) => e.handler as string);
	return handlers.length > 0 ? [...new Set(handlers)].sort() : undefined;
}

/** Prompts for one parameter's value, seeded with what it currently holds. */
async function editParam(
	param: InvocationParam,
	current: string,
	workspaceRoot: string,
): Promise<string | undefined> {
	const choices = choicesFor(param, workspaceRoot);
	if (choices) {
		// An optional enum can be cleared: for a library's `{only}` slot, blank is
		// the meaningful answer — drive every entry point — not a missing one.
		const items: vscode.QuickPickItem[] = choices.map((c) => ({
			label: c,
			description: c === param.default ? 'default' : undefined,
		}));
		if (!param.required) {
			items.unshift({ label: '(none)', description: 'leave this out of the command' });
		}
		const picked = await vscode.window.showQuickPick(items, {
			title: `${param.name}${param.help ? ` — ${param.help}` : ''}`,
			ignoreFocusOut: true,
		});
		if (!picked) {
			return undefined;
		}
		return picked.label === '(none)' ? '' : picked.label;
	}
	if (param.type === 'flag') {
		const picked = await vscode.window.showQuickPick(
			[
				{ label: 'on', description: `pass ${param.render ?? `--${param.name}`}` },
				{ label: 'off', description: 'leave it out' },
			],
			{ title: `${param.name}${param.help ? ` — ${param.help}` : ''}`, ignoreFocusOut: true },
		);
		return picked ? (picked.label === 'on' ? 'true' : 'false') : undefined;
	}
	return vscode.window.showInputBox({
		title: `${param.name}${param.help ? ` — ${param.help}` : ''}`,
		value: current,
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (param.required && !value.trim()) {
				return `${param.name} is required.`;
			}
			if (param.type === 'int' && value.trim() && !/^-?\d+$/.test(value.trim())) {
				return `${param.name} must be a whole number.`;
			}
			if (param.type === 'float' && value.trim() && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
				return `${param.name} must be a number.`;
			}
			return null;
		},
	});
}

/** Which of several recorded invocations to run. */
async function pickInvocation(
	workspaceRoot: string,
	service: string,
	invocations: Invocation[],
): Promise<Invocation | undefined> {
	if (invocations.length === 1) {
		return invocations[0];
	}
	const last = readLastInvocation(workspaceRoot, service);
	const items = invocations.map((i) => ({
		label: i.id,
		description: [
			i.purpose,
			i.default ? 'default' : undefined,
			i.id === last ? 'last run' : undefined,
			typeof i.expect_exit === 'number' && i.expect_exit !== 0
				? `exits ${i.expect_exit}`
				: undefined,
		]
			.filter(Boolean)
			.join(' · '),
		// The command itself, because "check" and "check --strict" are the same
		// word to a picker and completely different runs to the operator.
		detail: preview(i, defaultArgs(i)),
		invocation: i,
	}));
	// The one they ran last first: re-running with a tweak is the common case.
	items.sort((a, b) => Number(b.invocation.id === last) - Number(a.invocation.id === last));
	const picked = await vscode.window.showQuickPick(items, {
		title: `Vinv: which '${service}' invocation?`,
		placeHolder: 'Pick the command to run under tracing',
		ignoreFocusOut: true,
	});
	return picked?.invocation;
}

/**
 * The full ask: which invocation, then its arguments, then Run.
 *
 * Returns undefined when the operator backed out at any step — the caller must
 * then do nothing at all, rather than falling back to running the defaults,
 * which is the one outcome an Escape key definitely did not mean.
 *
 * Returns `null` when there is nothing to ask about (no recorded invocations),
 * so the caller can run the service the plain way.
 */
export async function askForRun(
	workspaceRoot: string,
	service: string,
): Promise<RunChoice | null | undefined> {
	const invocations = readInvocations(workspaceRoot, service);
	if (invocations.length === 0) {
		return null;
	}
	const chosen = await pickInvocation(workspaceRoot, service, invocations);
	if (!chosen) {
		return undefined;
	}
	const params = chosen.params ?? [];
	// Last-used beats the default: the second run of a fiddly command should be
	// one click, and whatever took three tries to get right is worth keeping.
	const args: Record<string, string> = {
		...defaultArgs(chosen),
		...readRunArgs(workspaceRoot, service, chosen.id),
	};
	if (params.length === 0) {
		return { invocation: chosen.id, args };
	}

	for (;;) {
		const rendered = preview(chosen, args);
		const runItem: vscode.QuickPickItem = {
			label: '$(play) Run',
			detail: rendered,
			alwaysShow: true,
		};
		const paramItems: vscode.QuickPickItem[] = params.map((p) => ({
			label: p.name,
			description: args[p.name] ? args[p.name] : '(not set)',
			detail: [
				p.help,
				p.required ? 'required' : undefined,
				p.default !== undefined && args[p.name] !== p.default
					? `default: ${p.default || '(none)'}`
					: undefined,
			]
				.filter(Boolean)
				.join(' · '),
		}));
		const picked = await vscode.window.showQuickPick(
			[runItem, { label: '', kind: vscode.QuickPickItemKind.Separator }, ...paramItems],
			{
				title: `Vinv: run '${service} · ${chosen.id}'`,
				placeHolder: 'Pick a value to change, or Run',
				ignoreFocusOut: true,
			},
		);
		if (!picked) {
			return undefined;
		}
		if (picked === runItem || picked.label.endsWith('Run')) {
			if (rendered.startsWith('⚠')) {
				// Refuse rather than shell out to something that did not render —
				// the failure is in the record, and running a half-built command
				// would blame the tool for it.
				void vscode.window.showWarningMessage(`Vinv: ${rendered.slice(2)}`);
				continue;
			}
			return { invocation: chosen.id, args };
		}
		const param = params.find((p) => p.name === picked.label);
		if (!param) {
			continue;
		}
		const value = await editParam(param, args[param.name] ?? '', workspaceRoot);
		if (value !== undefined) {
			args[param.name] = value;
		}
	}
}
