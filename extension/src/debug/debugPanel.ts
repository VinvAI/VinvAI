import * as vscode from 'vscode';

export async function openDebugPanel(): Promise<void> {
	await vscode.window.showInformationMessage(
		'Vinv Debug panel is not wired yet. Connect to the Vinv backend to inspect sessions and traces.',
	);
}
