import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
	defaultEnginesCloneDir,
	enginesRootDir,
	pythonEnginePath,
	resolveIndexBinary,
} from '../engines/resolve';
import { binaryFilePath } from '../vinvHome';

/** Every engine the extension runs. */
export const ENGINE_NAMES: ReadonlyArray<string> = [
	'index',
	'tracelens',
	'handbook',
	'bringup',
	'identification',
	'goal',
];

/** The vinv.enginesPath setting (an explicit engines-root override). */
function enginesPathSetting(): string | undefined {
	const v = vscode.workspace.getConfiguration('vinv').get<string>('enginesPath');
	return v && v.trim().length > 0 ? v.trim() : undefined;
}

/** The engines monorepo root for this window, or null when not installed. */
export function enginesRoot(context: vscode.ExtensionContext): string | null {
	return enginesRootDir({
		override: enginesPathSetting(),
		extensionDir: context.extensionPath,
	});
}

/**
 * Absolute path of an engine executable.
 *
 * Python engines resolve to their console script inside the engines monorepo's
 * uv-workspace venv (`<engines-root>/.venv/bin/<name>`), a machine-stable
 * path. That stability matters because bring-up bakes the tracelens binary's
 * absolute path into the verified start commands it records
 * (.vinv/start_commands/<service>.json), which are replayed across windows
 * and sessions.
 *
 * The Rust `index` binary resolves through its own chain: config override →
 * the checkout's release build → the downloaded ~/.vinv/bin copy → PATH.
 *
 * When nothing is installed yet a nominal (non-existing) path is returned so
 * error messages can name where the engine is expected; isBinAvailable is the
 * existence check.
 */
export function getBinPath(context: vscode.ExtensionContext, name: string): string {
	if (name === 'index') {
		return (
			resolveIndexBinary({
				override: enginesPathSetting(),
				extensionDir: context.extensionPath,
			}) ?? binaryFilePath('index')
		);
	}
	const root = enginesRoot(context) ?? defaultEnginesCloneDir();
	return pythonEnginePath(root, name);
}

/** True when the named engine exists on disk. */
export function isBinAvailable(context: vscode.ExtensionContext, name: string): boolean {
	return fs.existsSync(getBinPath(context, name));
}

/** Shown when an engine is missing: the one next step that fixes it. */
export function showEnginesMissingError(name: string): void {
	void vscode.window
		.showErrorMessage(
			`Vinv: The ${name} engine was not found. Install the Vinv engines (clone + uv sync) to enable it.`,
			'Install Vinv Engines',
		)
		.then((choice) => {
			if (choice === 'Install Vinv Engines') {
				void vscode.commands.executeCommand('vinv-vs.installEngines');
			}
		});
}

const terminals = new Map<string, vscode.Terminal>();

/**
 * Opens (or reuses) a named terminal with the engine's dir on PATH and runs an
 * initial command for the given engine.
 */
export function openBinTerminal(
	context: vscode.ExtensionContext,
	name: string,
	terminalName: string,
	initialCommand: string,
): void {
	const binPath = getBinPath(context, name);
	if (!isBinAvailable(context, name)) {
		showEnginesMissingError(name);
		return;
	}

	// Ensure the binary is executable (git/copy may not preserve the bit).
	try {
		fs.chmodSync(binPath, 0o755);
	} catch {
		// Non-fatal: surface any real failure when the command actually runs.
	}

	const binDir = path.dirname(binPath);
	let terminal = terminals.get(name);
	if (!terminal || terminal.exitStatus !== undefined) {
		terminal = vscode.window.createTerminal({
			name: terminalName,
			env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
		});
		terminals.set(name, terminal);
		context.subscriptions.push(terminal);
	}

	terminal.show();
	terminal.sendText(initialCommand);
}
