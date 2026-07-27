/**
 * Headless driver for a REAL Vinv fix episode — runEpisode() outside VS Code.
 *
 * This is the full closed loop: context pack → harness dispatch (cursor-agent)
 * → verification → judgment. Nothing is simulated; the agent edits the real
 * working tree of the target repo.
 *
 * How it works (same shape as e2e-stall.mjs): a `vscode` stub module is written
 * to a temp dir, `src/harness/episodeLoop.ts` is esbuild-bundled with
 * `alias: { vscode: stub }`, and the bundle is `import()`ed. On top of that, an
 * onResolve plugin swaps `views/askVinv` for a headless stub whose
 * requestEpisodeVerdict auto-answers — without it, any non-pass terminal opens
 * a webview and the process hangs forever.
 *
 * Usage:
 *   node scripts/e2e-episode.mjs <repoPath> [issueFile] [--title=...] [--verdict=abort|approve]
 *
 * With no args it runs the built-in smolagents `for/while ... else` case.
 *
 * Preconditions:
 *   - <repoPath>/.vinv/index/chunks.jsonl exists (hard gate in runEpisode).
 *   - the configured harness CLI is installed and authenticated
 *     (`cursor-agent status` must exit 0).
 *   - ~/.vinv/config.json sets {"harness":"cursor","autoEpisodes":false}.
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve as presolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flags = Object.fromEntries(
	argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')),
);
const positional = argv.filter((a) => !a.startsWith('--'));

const repoPath = presolve(positional[0] ?? process.env.VINV_E2E_REPO ?? process.cwd());

const DEFAULT_TITLE = 'for/while ... else clause is silently dropped by the local Python executor';
const DEFAULT_ISSUE = `In \`src/smolagents/local_python_executor.py\`, the functions \`evaluate_for\` and
\`evaluate_while\` never execute the loop's \`else:\` clause. Python's
\`for ... else\` / \`while ... else\` runs the else body when the loop finishes
WITHOUT hitting a \`break\`; smolagents' interpreter ignores \`node.orelse\`
entirely, so the else body is silently dropped.

This is a SILENT WRONG ANSWER — no exception is raised, the interpreter just
returns a different value than CPython would.

Repro (for ... else):

    from smolagents.local_python_executor import evaluate_python_code, BASE_PYTHON_TOOLS as T
    code = "result = 0\\nfor i in range(4):\\n    result += i\\nelse:\\n    result += 100\\nresult"
    evaluate_python_code(code, static_tools=T)

  expected: (106, False)   # CPython: 0+1+2+3 = 6, then else adds 100
  actual:   (6, False)     # the else body never runs

Repro (while ... else):

    code = "n = 0\\nwhile n < 3:\\n    n += 1\\nelse:\\n    n += 100\\nn"
    evaluate_python_code(code, static_tools=T)

  expected: (103, False)
  actual:   (3, False)

The fix must also preserve correct \`break\` semantics: when the loop exits via
\`break\`, the \`else\` body must NOT run. \`continue\` must not suppress it.

Fix \`evaluate_for\` and \`evaluate_while\` in
src/smolagents/local_python_executor.py so both honour \`node.orelse\`.`;

const issue = flags.issue
	? flags.issue
	: positional[1]
		? readFileSync(positional[1], 'utf8')
		: DEFAULT_ISSUE;
const title = flags.title ?? DEFAULT_TITLE;
// The verdict the headless operator returns on any escalation. 'abort' is the
// honest default: it ends the episode without claiming a pass and without
// reverting the agent's edits (only 'revert' reverts), so an external check can
// judge the diff on its own merits.
const autoVerdict = flags.verdict ?? 'abort';

if (!existsSync(join(repoPath, '.vinv', 'index', 'chunks.jsonl'))) {
	console.error(`no code index at ${repoPath}/.vinv/index/chunks.jsonl — runEpisode will refuse`);
	process.exit(2);
}

const out = mkdtempSync(join(tmpdir(), 'vinv-e2e-episode-'));

// ---------------------------------------------------------------------------
// vscode stub — only what the episode path actually touches.
// ---------------------------------------------------------------------------
const vscodeStub = join(out, 'vscode-stub.mjs');
writeFileSync(
	vscodeStub,
	`
const noop = () => {};
const nothing = () => Promise.resolve(undefined);

class CancellationTokenSource {
  constructor() {
    this._cbs = [];
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: (cb) => { this._cbs.push(cb); return { dispose: noop }; },
    };
  }
  cancel() { this.token.isCancellationRequested = true; for (const cb of this._cbs) { try { cb(); } catch {} } }
  dispose() { this._cbs = []; }
}

class EventEmitter {
  constructor() { this._h = []; this.event = (cb) => { this._h.push(cb); return { dispose: noop }; }; }
  fire(v) { for (const h of this._h) { try { h(v); } catch {} } }
  dispose() { this._h = []; }
}

const statusBarItem = () => ({
  text: '', tooltip: '', command: undefined, backgroundColor: undefined,
  name: '', accessibilityInformation: undefined, alignment: 2, priority: 0, id: 'stub',
  show: noop, hide: noop, dispose: noop,
});

// withProgress must invoke its callback IMMEDIATELY — the episode body lives
// inside it. A token that is never cancelled keeps the loop running.
export const window = {
  withProgress: (_opts, task) =>
    Promise.resolve(
      task(
        { report: noop },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: noop }) },
      ),
    ),
  showInformationMessage: nothing,
  showWarningMessage: nothing,
  showErrorMessage: nothing,
  showInputBox: nothing,
  showQuickPick: nothing,
  showTextDocument: nothing,
  createStatusBarItem: statusBarItem,
  createOutputChannel: () => ({ append: noop, appendLine: noop, show: noop, hide: noop, dispose: noop, clear: noop, replace: noop, name: 'stub' }),
  createTerminal: () => ({ show: noop, hide: noop, sendText: noop, dispose: noop, name: 'stub', exitStatus: undefined, processId: Promise.resolve(undefined) }),
  createWebviewPanel: () => { throw new Error('headless: createWebviewPanel is not available (a judgment escaped the askVinv stub)'); },
  activeTextEditor: undefined,
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: () => ({ dispose: noop }),
  tabGroups: { all: [], close: nothing, onDidChangeTabs: () => ({ dispose: noop }) },
};

export const workspace = {
  getConfiguration: () => ({ get: () => undefined, has: () => false, inspect: () => undefined, update: nothing }),
  workspaceFolders: [],
  fs: { readFile: nothing, writeFile: nothing },
  openTextDocument: nothing,
  onDidSaveTextDocument: () => ({ dispose: noop }),
  onDidChangeConfiguration: () => ({ dispose: noop }),
  createFileSystemWatcher: () => ({ onDidCreate: () => ({ dispose: noop }), onDidChange: () => ({ dispose: noop }), onDidDelete: () => ({ dispose: noop }), dispose: noop }),
  applyEdit: nothing,
};

export const commands = { executeCommand: nothing, registerCommand: () => ({ dispose: noop }) };

export const Uri = {
  file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => 'file://' + p, with: function () { return this; } }),
  parse: (s) => ({ scheme: 'file', fsPath: s, path: s, toString: () => s, with: function () { return this; } }),
  joinPath: (base, ...parts) => Uri.file([base.fsPath, ...parts].join('/')),
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export class ThemeColor { constructor(id) { this.id = id; } }
export class ThemeIcon { constructor(id) { this.id = id; } }
export class Position { constructor(line, character) { this.line = line; this.character = character; } }
export class Range { constructor(a, b, c, d) { this.start = a; this.end = b ?? a; this._c = c; this._d = d; } }
export class Selection extends Range {}
export class Location { constructor(uri, range) { this.uri = uri; this.range = range; } }
export const Disposable = { from: (...items) => ({ dispose: () => items.forEach((i) => i?.dispose?.()) }) };
export const env = { appName: 'Vinv Headless', appRoot: '', machineId: 'headless', clipboard: { writeText: nothing, readText: nothing }, openExternal: nothing };
export const extensions = { getExtension: () => undefined, all: [] };
export const languages = { registerCodeLensProvider: () => ({ dispose: noop }), registerHoverProvider: () => ({ dispose: noop }) };
export { CancellationTokenSource, EventEmitter };
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
export class MarkdownString { constructor(v) { this.value = v ?? ''; } appendMarkdown(v) { this.value += v; return this; } }
export class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }

export default {
  window, workspace, commands, Uri, ViewColumn, ProgressLocation, StatusBarAlignment,
  ThemeColor, ThemeIcon, Position, Range, Selection, Location, Disposable, env, extensions,
  languages, CancellationTokenSource, EventEmitter, TreeItemCollapsibleState, TreeItem,
  MarkdownString, RelativePattern,
};
`,
);

// ---------------------------------------------------------------------------
// askVinv stub — the anti-hang. Every escalation resolves instantly instead of
// opening a webview and waiting for a click that can never come.
// isAskVinvOpen() returns TRUE so presentJudgment takes the transcript branch
// and never reaches openJudgmentDialog (which would call createWebviewPanel).
// ---------------------------------------------------------------------------
const askStub = join(out, 'askvinv-stub.mjs');
writeFileSync(
	askStub,
	`
const VERDICT = ${JSON.stringify(autoVerdict)};
// esbuild INLINES this module into the bundle, so a separate import() of this
// file would be a different module instance with its own empty arrays. The
// record therefore lives on globalThis, which both instances share.
const rec = (globalThis.__vinvE2E ??= { feed: [], escalations: [] });
export const __feed = rec.feed;
export const __escalations = rec.escalations;
export function isAskVinvOpen() { return true; }
export function postEpisodeUpdate(msg) {
  rec.feed.push(msg);
  console.log('  [' + msg.kind + '] ' + String(msg.text ?? '').split('\\n')[0]);
}
export function requestEpisodeVerdict(req) {
  console.log('\\n  === ESCALATION (auto-answered "' + VERDICT + '") ===');
  console.log('  title: ' + req.title);
  console.log('  pack:  ' + req.packPath);
  console.log('  detail:\\n' + String(req.detail ?? '').split('\\n').map((l) => '    ' + l).join('\\n'));
  console.log('  === end escalation ===\\n');
  rec.escalations.push({ title: req.title, detail: req.detail, packPath: req.packPath, mode: req.mode });
  return Promise.resolve({ action: VERDICT });
}
export function requestDisputeNote() { return Promise.resolve(undefined); }
export function requestRetractionConfirm() { return Promise.resolve('declined'); }
export function setEpisodeCancel() {}
export function openAskVinv() {}
export function handleAskVinvAction() { return Promise.resolve(); }
export function dispatchAskVinvFix() { return Promise.resolve(); }
export function setActiveSessionId() {}
`,
);

// Redirect every import of views/askVinv (relative specifiers, so esbuild's
// `alias` — which only handles bare package names — cannot do it).
const askVinvRedirect = {
	name: 'askvinv-headless',
	setup(b) {
		b.onResolve({ filter: /(^|\/)views\/askVinv$/ }, () => ({ path: askStub }));
	},
};

const bundlePath = join(out, 'episodeLoop.mjs');
await build({
	entryPoints: [join(here, '..', 'src', 'harness', 'episodeLoop.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	outfile: bundlePath,
	alias: { vscode: vscodeStub },
	plugins: [askVinvRedirect],
	logLevel: 'warning',
});

const loop = await import(pathToFileURL(bundlePath).href);
const ask = await import(pathToFileURL(askStub).href);

// runEpisode only reads context.extensionPath.
const context = { extensionPath: presolve(here, '..'), subscriptions: [] };

const task = {
	kind: flags.kind ?? 'general',
	intent: 'defect',
	trigger: 'manual',
	title,
	issue,
	successCriteria: [],
};

console.log(`repo:    ${repoPath}`);
console.log(`harness: ${flags.harness ?? 'cursor'}`);
console.log(`task:    ${task.title}`);
console.log(`verdict on escalation: ${autoVerdict}`);
console.log('--- episode start ---');

const startedAt = Date.now();
let verified;
let err;
try {
	verified = await loop.runEpisode(context, repoPath, task, flags.harness ?? 'cursor');
} catch (e) {
	err = e;
}
const secs = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log('--- episode end ---');
if (err) {
	console.error(`runEpisode THREW after ${secs}s:`);
	console.error(err?.stack ?? String(err));
	process.exit(1);
}
console.log(`runEpisode returned: ${verified}   (${secs}s, ${ask.__escalations.length} escalation(s))`);
writeFileSync(
	join(out, 'result.json'),
	JSON.stringify({ verified, seconds: Number(secs), feed: ask.__feed, escalations: ask.__escalations }, null, 2),
);
console.log(`transcript: ${join(out, 'result.json')}`);
process.exit(verified ? 0 : 3);
