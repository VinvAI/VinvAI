import * as vscode from 'vscode';
import { openBinTerminal } from './bin';

/** Opens (or reuses) a Tracelens terminal with the bundled binary on PATH. */
export function openTracelensTerminal(context: vscode.ExtensionContext): void {
	openBinTerminal(context, 'tracelens', 'Tracelens', 'tracelens --help');
}

/** Opens (or reuses) an index terminal with the bundled binary on PATH. */
export function openIndexTerminal(context: vscode.ExtensionContext): void {
	openBinTerminal(context, 'index', 'Vinv Index', 'index --help');
}
