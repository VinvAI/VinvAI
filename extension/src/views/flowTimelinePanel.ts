/**
 * The Vinv Timeline panel — the pipeline rail, in the editor area.
 *
 * This is the sidebar's old body, moved. The rail earned the room: four stages
 * with what each produced, the issues with their per-issue fix, and the single
 * next action, all of which were competing for a strip a few hundred pixels
 * wide. The sidebar now answers "is anything running", and this answers "what
 * happened, and what can I do about it".
 *
 * It renders from the same `FlowStateSource` the sidebar does and reuses the
 * same markup (`getRailHtml`) and the same message routing
 * (`handleFlowMessage`), so there is one renderer and one set of side effects
 * behind two surfaces — a second copy would be a second thing to keep true.
 */
import * as vscode from 'vscode';

import { trackUi, trackViewOpened, reportWebviewError } from '../telemetry/instrument';
import {
	buildFlowActions,
	getRailHtml,
	handleFlowMessage,
	type OutboundMessage,
} from './flowPanel';
import type { FlowStateSource } from './flowStateSource';
import type { FlowModel } from './flowModel';

/** One panel per window, revealed rather than duplicated (see tracesPanel). */
let panel: vscode.WebviewPanel | undefined;

/** Opens (or reveals) the Timeline panel. */
export function openFlowTimeline(
	context: vscode.ExtensionContext,
	source: FlowStateSource,
): void {
	if (panel) {
		panel.reveal(vscode.ViewColumn.Active);
		return;
	}
	trackViewOpened('flow_timeline');
	panel = vscode.window.createWebviewPanel(
		'vinv.flowTimeline',
		'Vinv Timeline',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	const view = panel;
	view.webview.html = getRailHtml(view.webview.cspSource);

	const post = (model: FlowModel): void => {
		void view.webview.postMessage({ type: 'model', model });
	};
	const sub = source.onDidChange(post);
	// retainContextWhenHidden keeps the DOM, but a panel that was hidden while
	// the pipeline moved on would still be showing the model it was hidden with.
	const visibility = view.onDidChangeViewState(() => {
		if (view.visible) {
			post(source.getModel());
		}
	});
	post(source.getModel());

	const actions = buildFlowActions(context);
	view.webview.onDidReceiveMessage(
		(msg: OutboundMessage) => {
			const raw = msg as { type?: string; message?: unknown };
			if (raw.type === 'webviewError') {
				reportWebviewError('flow_timeline', raw);
				return;
			}
			trackUi('flow_timeline', raw.type ?? 'unknown');
			return handleFlowMessage(msg, actions);
		},
		undefined,
		context.subscriptions,
	);

	view.onDidDispose(() => {
		sub.dispose();
		visibility.dispose();
		panel = undefined;
	});
}
