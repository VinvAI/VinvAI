/**
 * Webview button wiring.
 *
 * The live defect this guards: a webview button ("view context pack", and the
 * rest) whose extension-side handler opened a file inside a try with an EMPTY
 * catch — so a missing/relative/moved path made the click a silent no-op. Every
 * panel's onDidReceiveMessage routing is now an extracted, exported function; we
 * drive each with (a) a valid payload and assert the right side effect, and
 * (b) a broken payload and assert a user-facing error is raised, NOT a silent
 * no-op. The shared path-resolution contract (resolve→absolute→verify→error) is
 * pinned directly on resolveOpenTarget/openPathInEditor.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveOpenTarget, openPathInEditor } from '../support/openDocument';
import { handleFlowMessage, type FlowActions, type OutboundMessage } from '../views/flowPanel';
import {
	handleGraphMessage,
	type GraphActions,
	type OutboundMessage as GraphMessage,
} from '../views/graphExplorer';
import { handleCallTreeMessage, type CallTreeActions } from '../identification/callTreeView';
import { handleJudgmentMessage, type JudgmentActions } from '../harness/episodeLoop';
import { handleAskVinvAction, dispatchAskVinvFix, type AskVinvActions } from '../views/askVinv';

/** A temp workspace root holding one real file, torn down after the suite. */
function makeWorkspace(): { root: string; existing: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-wire-'));
	const dir = path.join(root, '.vinv', 'context');
	fs.mkdirSync(dir, { recursive: true });
	const existing = path.join(dir, 'pack-1.md');
	fs.writeFileSync(existing, '# pack\n', 'utf8');
	return { root, existing, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * A fake file opener that mirrors production: it runs the REAL resolution
 * (resolveOpenTarget) so a valid path records an absolute open and a broken one
 * records the actionable error — exactly the not-silent behaviour under test.
 */
function makeOpener(root: string | undefined, label: string) {
	const opened: string[] = [];
	const errors: string[] = [];
	const open = async (file?: string): Promise<void> => {
		const r = resolveOpenTarget(file, root, label);
		if (r.ok && r.absPath) {
			opened.push(r.absPath);
		} else {
			errors.push(r.error ?? 'unknown');
		}
	};
	return { open, opened, errors };
}

suite('Webview button wiring', () => {
	// ---- shared path-resolution contract (every panel inherits it) ----------
	suite('resolveOpenTarget', () => {
		test('an absolute, existing path resolves', () => {
			const ws = makeWorkspace();
			try {
				const r = resolveOpenTarget(ws.existing, ws.root, 'context pack');
				assert.strictEqual(r.ok, true);
				assert.strictEqual(r.absPath, ws.existing);
			} finally {
				ws.cleanup();
			}
		});

		test('a missing file is an actionable error naming the path — never silent', () => {
			const ws = makeWorkspace();
			try {
				const gone = path.join(ws.root, '.vinv', 'context', 'pack-gone.md');
				const r = resolveOpenTarget(gone, ws.root, 'context pack');
				assert.strictEqual(r.ok, false);
				assert.match(r.error ?? '', /context pack not found at/);
				assert.ok((r.error ?? '').includes(gone));
			} finally {
				ws.cleanup();
			}
		});

		test('a relative path is resolved against the workspace root', () => {
			const ws = makeWorkspace();
			try {
				const r = resolveOpenTarget('.vinv/context/pack-1.md', ws.root, 'context pack');
				assert.strictEqual(r.ok, true);
				assert.strictEqual(r.absPath, ws.existing);
			} finally {
				ws.cleanup();
			}
		});

		test('a relative path with no workspace root errors instead of guessing', () => {
			const r = resolveOpenTarget('pack.md', undefined, 'context pack');
			assert.strictEqual(r.ok, false);
			assert.match(r.error ?? '', /relative and no workspace/);
		});

		test('an empty/undefined path errors', () => {
			assert.strictEqual(resolveOpenTarget(undefined, '/root', 'file').ok, false);
			assert.strictEqual(resolveOpenTarget('   ', '/root', 'file').ok, false);
		});
	});

	suite('openPathInEditor', () => {
		test('opens a real file and reports success', async () => {
			const ws = makeWorkspace();
			try {
				const ok = await openPathInEditor(ws.existing, { label: 'context pack' });
				assert.strictEqual(ok, true);
			} finally {
				ws.cleanup();
			}
		});

		test('a missing file returns false and shows an error — not a silent no-op', async () => {
			const ws = makeWorkspace();
			const orig = vscode.window.showErrorMessage;
			let shown = '';
			(vscode.window as unknown as { showErrorMessage: (m: string) => Promise<undefined> }).showErrorMessage = (m: string) => {
				shown = m;
				return Promise.resolve(undefined);
			};
			try {
				const gone = path.join(ws.root, 'nope.md');
				const ok = await openPathInEditor(gone, { label: 'context pack' });
				assert.strictEqual(ok, false);
				assert.match(shown, /context pack not found at/);
			} finally {
				(vscode.window as unknown as { showErrorMessage: typeof orig }).showErrorMessage = orig;
				ws.cleanup();
			}
		});
	});

	// ---- judgment card (episodeLoop): the reported defect --------------------
	suite('judgment card', () => {
		function actions(root: string, packPath: string) {
			const packOpener = makeOpener(root, 'context pack');
			const settled: { action: string; note?: string }[] = [];
			const acts: JudgmentActions = {
				openPack: () => packOpener.open(packPath),
				settle: (r) => settled.push(r),
			};
			return { acts, opened: packOpener.opened, errors: packOpener.errors, settled };
		}

		test('"view context pack" opens the pack (valid path)', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root, ws.existing);
				await handleJudgmentMessage({ type: 'openPack' }, a.acts);
				assert.deepStrictEqual(a.opened, [ws.existing]);
				assert.strictEqual(a.settled.length, 0, 'inspection implies no verdict');
			} finally {
				ws.cleanup();
			}
		});

		test('"view context pack" with a missing pack raises an error, not a silent no-op', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root, path.join(ws.root, 'gone.md'));
				await handleJudgmentMessage({ type: 'openPack' }, a.acts);
				assert.strictEqual(a.opened.length, 0);
				assert.strictEqual(a.errors.length, 1);
				assert.match(a.errors[0], /context pack not found/);
			} finally {
				ws.cleanup();
			}
		});

		test('"reject & retry" opens the pack AND settles retry', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root, ws.existing);
				await handleJudgmentMessage({ type: 'verdict', action: 'retry', note: '  do X  ' }, a.acts);
				assert.deepStrictEqual(a.opened, [ws.existing]);
				assert.strictEqual(a.settled.length, 1);
				assert.strictEqual(a.settled[0].action, 'retry');
				assert.strictEqual(a.settled[0].note, 'do X');
			} finally {
				ws.cleanup();
			}
		});

		test('retry with a missing pack still settles (proceeds) but surfaces the error', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root, path.join(ws.root, 'gone.md'));
				await handleJudgmentMessage({ type: 'verdict', action: 'retry' }, a.acts);
				assert.strictEqual(a.errors.length, 1, 'user is told the pack was missing');
				assert.strictEqual(a.settled.length, 1, 'retry proceeds regardless');
				assert.strictEqual(a.settled[0].action, 'retry');
			} finally {
				ws.cleanup();
			}
		});

		test('approve settles without opening the pack', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root, ws.existing);
				await handleJudgmentMessage({ type: 'verdict', action: 'approve' }, a.acts);
				assert.strictEqual(a.opened.length, 0);
				assert.strictEqual(a.settled[0].action, 'approve');
			} finally {
				ws.cleanup();
			}
		});

		test('a webviewError message is inert', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root, ws.existing);
				await handleJudgmentMessage({ type: 'webviewError', message: 'x' }, a.acts);
				assert.strictEqual(a.opened.length, 0);
				assert.strictEqual(a.settled.length, 0);
			} finally {
				ws.cleanup();
			}
		});
	});

	// ---- Ask Vinv ------------------------------------------------------------
	suite('Ask Vinv', () => {
		function actions(root: string) {
			const src = makeOpener(root, 'source file');
			const pack = makeOpener(undefined, 'context pack');
			const commands: { command: string; args: unknown[] }[] = [];
			const shownErrors: string[] = [];
			const acts: AskVinvActions = {
				openSource: (file) => src.open(file),
				openPack: (file) => pack.open(file),
				runCommand: async (command, ...args) => {
					commands.push({ command, args });
				},
				showError: (m) => shownErrors.push(m),
			};
			return { acts, src, pack, commands, shownErrors };
		}

		test('openSource opens a valid file (handled)', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root);
				const handled = await handleAskVinvAction(
					{ type: 'openSource', file: ws.existing } as never,
					a.acts,
				);
				assert.strictEqual(handled, true);
				assert.deepStrictEqual(a.src.opened, [ws.existing]);
			} finally {
				ws.cleanup();
			}
		});

		test('openSource with a missing file raises an error, not a silent no-op', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root);
				const handled = await handleAskVinvAction(
					{ type: 'openSource', file: 'src/gone.ts' } as never,
					a.acts,
				);
				assert.strictEqual(handled, true, 'the click was consumed');
				assert.strictEqual(a.src.opened.length, 0);
				assert.strictEqual(a.src.errors.length, 1);
			} finally {
				ws.cleanup();
			}
		});

		test('viewPack opens a valid pack; a missing pack errors', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root);
				await handleAskVinvAction({ type: 'viewPack', file: ws.existing } as never, a.acts);
				assert.deepStrictEqual(a.pack.opened, [ws.existing]);

				const b = actions(ws.root);
				await handleAskVinvAction({ type: 'viewPack', file: '/nope/pack.md' } as never, b.acts);
				assert.strictEqual(b.pack.opened.length, 0);
				assert.strictEqual(b.pack.errors.length, 1);
			} finally {
				ws.cleanup();
			}
		});

		test('disputeStart dispatches the registered command', async () => {
			const a = actions('/root');
			await handleAskVinvAction({ type: 'disputeStart', episodeId: 'e7' } as never, a.acts);
			assert.strictEqual(a.commands[0].command, 'vinv-vs.disputeVerified');
			assert.deepStrictEqual(a.commands[0].args, ['e7']);
		});

		test('a stateful message (ask) is not consumed here', async () => {
			const a = actions('/root');
			const handled = await handleAskVinvAction({ type: 'ask', question: 'hi' } as never, a.acts);
			assert.strictEqual(handled, false);
		});

		test('dispatchAskVinvFix routes a real issue to fixWithHarness', async () => {
			const a = actions('/root');
			await dispatchAskVinvFix(a.acts, '  POST /orders 500  ', [3, 7]);
			assert.strictEqual(a.commands[0].command, 'vinv-vs.fixWithHarness');
			assert.deepStrictEqual(a.commands[0].args[0], { issue: 'POST /orders 500', rows: [3, 7] });
		});

		test('dispatchAskVinvFix on an empty issue errors instead of firing a blank episode', async () => {
			const a = actions('/root');
			await dispatchAskVinvFix(a.acts, '   ', []);
			assert.strictEqual(a.commands.length, 0);
			assert.strictEqual(a.shownErrors.length, 1);
		});
	});

	// ---- Flow rail -----------------------------------------------------------
	suite('Flow rail', () => {
		function actions(root: string) {
			const files = makeOpener(root, 'file');
			const links: unknown[] = [];
			const commands: { command: string; args: unknown[] }[] = [];
			const shownErrors: string[] = [];
			const acts: FlowActions = {
				openLink: async (link) => void links.push(link),
				openFileAt: (p) => files.open(p),
				runCommand: async (command, ...args) => void commands.push({ command, args }),
				showError: (m) => shownErrors.push(m),
			};
			return { acts, files, links, commands, shownErrors };
		}
		const msg = (m: Partial<OutboundMessage>) => m as OutboundMessage;

		test('fix with an issue dispatches fixWithHarness', async () => {
			const a = actions('/root');
			await handleFlowMessage(msg({ type: 'fix', fixArgs: { issue: 'boom', service: 'api' } }), a.acts);
			assert.strictEqual(a.commands[0].command, 'vinv-vs.fixWithHarness');
			assert.deepStrictEqual(a.commands[0].args[0], { issue: 'boom', service: 'api' });
		});

		test('fix with no issue errors instead of doing nothing', async () => {
			const a = actions('/root');
			await handleFlowMessage(msg({ type: 'fix', fixArgs: { issue: '' } }), a.acts);
			assert.strictEqual(a.commands.length, 0);
			assert.strictEqual(a.shownErrors.length, 1);
		});

		test('evidence opens a valid file; a missing one errors (not silent)', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root);
				await handleFlowMessage(msg({ type: 'evidence', path: ws.existing }), a.acts);
				assert.deepStrictEqual(a.files.opened, [ws.existing]);

				const b = actions(ws.root);
				await handleFlowMessage(msg({ type: 'evidence', path: undefined }), b.acts);
				assert.strictEqual(b.files.opened.length, 0);
				assert.strictEqual(b.files.errors.length, 1);
			} finally {
				ws.cleanup();
			}
		});

		test('link with a target runs; a targetless link errors', async () => {
			const a = actions('/root');
			await handleFlowMessage(msg({ type: 'link', link: { label: 'x', command: 'foo' } }), a.acts);
			assert.strictEqual(a.links.length, 1);

			const b = actions('/root');
			await handleFlowMessage(msg({ type: 'link' }), b.acts);
			assert.strictEqual(b.links.length, 0);
			assert.strictEqual(b.shownErrors.length, 1);
		});

		test('action with a command runs; a command-less action errors', async () => {
			const a = actions('/root');
			await handleFlowMessage(msg({ type: 'action', command: 'vinv-vs.showTrajectory', args: [1] }), a.acts);
			assert.strictEqual(a.commands[0].command, 'vinv-vs.showTrajectory');
			assert.deepStrictEqual(a.commands[0].args, [1]);

			const b = actions('/root');
			await handleFlowMessage(msg({ type: 'action' }), b.acts);
			assert.strictEqual(b.commands.length, 0);
			assert.strictEqual(b.shownErrors.length, 1);
		});
	});

	// ---- Graph explorer ------------------------------------------------------
	suite('Graph explorer', () => {
		function actions(root: string) {
			const src = makeOpener(root, 'source file');
			const calls: string[] = [];
			const acts: GraphActions = {
				openSource: (file, line) => {
					void line;
					return src.open(file);
				},
				refresh: () => calls.push('refresh'),
				semanticSearch: async (q) => void calls.push(`search:${q}`),
				ask: async (row) => void calls.push(`ask:${row}`),
				harness: async (row, issue) => void calls.push(`harness:${row}:${issue}`),
				trace: async (row, file) => void calls.push(`trace:${row}:${file}`),
				trajectory: async () => void calls.push('trajectory'),
			};
			return { acts, src, calls };
		}
		const gmsg = (m: Partial<GraphMessage>) => m as GraphMessage;

		test('openSource opens a valid node file; a missing one errors', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root);
				await handleGraphMessage(gmsg({ type: 'openSource', file: ws.existing, line: 2 }), a.acts);
				assert.deepStrictEqual(a.src.opened, [ws.existing]);

				const b = actions(ws.root);
				await handleGraphMessage(gmsg({ type: 'openSource', file: 'x/gone.ts' }), b.acts);
				assert.strictEqual(b.src.opened.length, 0);
				assert.strictEqual(b.src.errors.length, 1);
			} finally {
				ws.cleanup();
			}
		});

		test('ask/harness/trace/trajectory/refresh/search route to their actions', async () => {
			const a = actions('/root');
			await handleGraphMessage(gmsg({ type: 'ask', row: 5 }), a.acts);
			await handleGraphMessage(gmsg({ type: 'harness', row: 5, issue: 'q' }), a.acts);
			await handleGraphMessage(gmsg({ type: 'trace', row: 5, file: 'f.ts' }), a.acts);
			await handleGraphMessage(gmsg({ type: 'trajectory' }), a.acts);
			await handleGraphMessage(gmsg({ type: 'refresh' }), a.acts);
			await handleGraphMessage(gmsg({ type: 'semanticSearch', query: 'auth' }), a.acts);
			assert.deepStrictEqual(a.calls, [
				'ask:5',
				'harness:5:q',
				'trace:5:f.ts',
				'trajectory',
				'refresh',
				'search:auth',
			]);
		});
	});

	// ---- Call-tree view ------------------------------------------------------
	suite('Call-tree view', () => {
		function actions(root: string, smokeReportSupported = true) {
			const src = makeOpener(root, 'source file');
			const calls: string[] = [];
			const acts: CallTreeActions = {
				openSource: (file) => src.open(file),
				ask: async (file, name) => void calls.push(`ask:${file}:${name}`),
				runSmokeReport: async () => void calls.push('smoke'),
				smokeReportSupported,
			};
			return { acts, src, calls };
		}

		test('openSource opens a valid file; a missing one errors', async () => {
			const ws = makeWorkspace();
			try {
				const a = actions(ws.root);
				await handleCallTreeMessage({ type: 'openSource', file: ws.existing }, a.acts);
				assert.deepStrictEqual(a.src.opened, [ws.existing]);

				const b = actions(ws.root);
				await handleCallTreeMessage({ type: 'openSource', file: 'gone.ts' }, b.acts);
				assert.strictEqual(b.src.opened.length, 0);
				assert.strictEqual(b.src.errors.length, 1);
			} finally {
				ws.cleanup();
			}
		});

		test('ask routes to askVinv seeding', async () => {
			const a = actions('/root');
			await handleCallTreeMessage({ type: 'ask', file: 'f.ts', name: 'handler' }, a.acts);
			assert.deepStrictEqual(a.calls, ['ask:f.ts:handler']);
		});

		test('runSmokeReport runs when supported and is skipped when not', async () => {
			const a = actions('/root', true);
			await handleCallTreeMessage({ type: 'runSmokeReport' }, a.acts);
			assert.deepStrictEqual(a.calls, ['smoke']);

			const b = actions('/root', false);
			await handleCallTreeMessage({ type: 'runSmokeReport' }, b.acts);
			assert.deepStrictEqual(b.calls, []);
		});
	});
});
