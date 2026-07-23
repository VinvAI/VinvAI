import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** The custom-editor view type; must match the `contributes.customEditors` id. */
export const SMOKE_VIEW_TYPE = 'vinv.smokeReport';

/**
 * Renders a tracelens Smoke Report (a self-contained HTML file under
 * .vinv/reports) as a live dashboard, using a **custom editor** rather than a
 * bare webview panel.
 *
 * The distinction matters for referencing: a custom editor's tab is bound to the
 * file's URI, so the tab can be dragged into Cursor's chat (or `@`-referenced)
 * exactly like a normal file — a plain WebviewPanel has no URI and can't be. The
 * report still renders interactively (its inline CSS/JS run in a sandboxed
 * iframe); we just host it in a file-backed tab.
 */
export class SmokeReportEditorProvider implements vscode.CustomReadonlyEditorProvider {
	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			SMOKE_VIEW_TYPE,
			new SmokeReportEditorProvider(),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	resolveCustomEditor(
		document: vscode.CustomDocument,
		webviewPanel: vscode.WebviewPanel,
	): void {
		webviewPanel.webview.options = { enableScripts: true };

		const render = (): void => {
			let html: string;
			try {
				html = fs.readFileSync(document.uri.fsPath, 'utf8');
			} catch (e) {
				html = `<p>Could not read report: ${e instanceof Error ? e.message : String(e)}</p>`;
			}
			webviewPanel.webview.html = frameHtml(html);
		};
		render();

		// Re-render if the report file is regenerated (e.g. a Smoke Report re-run
		// for this endpoint) while its tab is open.
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(
				vscode.Uri.file(path.dirname(document.uri.fsPath)),
				path.basename(document.uri.fsPath),
			),
		);
		watcher.onDidChange(render);
		webviewPanel.onDidDispose(() => watcher.dispose());
	}
}

/**
 * Opens the Smoke Report file in its custom editor, revealing it in the active
 * column. Because it opens the file URI (via `vscode.openWith`), the resulting
 * tab is file-backed and therefore draggable/referenceable.
 */
export async function openSmokeReport(uri: vscode.Uri): Promise<void> {
	await vscode.commands.executeCommand(
		'vscode.openWith',
		uri,
		SMOKE_VIEW_TYPE,
		vscode.ViewColumn.Active,
	);
}

/**
 * Wraps the report document in a full-bleed sandboxed iframe. The report goes in
 * via the `srcdoc` attribute (HTML-escaped) so the browser parses it as its own
 * document; `allow-scripts` lets its inline dashboard JS run, but without
 * `allow-same-origin` it stays sandboxed from the extension host.
 */
function frameHtml(reportHtml: string): string {
	const escaped = reportHtml
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body { --bg: #ffffff; }
		body.vscode-dark, body.vscode-high-contrast:not(.vscode-high-contrast-light) { --bg: #000000; }
		html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); }
		/* Theme-follow the frame's backing color: a hardcoded white here flashed
		   (and haloed) around the report on dark themes. The report document
		   itself sets its own explicit background+foreground pair. */
		iframe { border: 0; width: 100%; height: 100vh; display: block; background: var(--bg); }
	</style>
</head>
<body>
	<iframe sandbox="allow-scripts" srcdoc="${escaped}"></iframe>
</body>
</html>`;
}
