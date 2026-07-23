/**
 * Renders the real Vinv Flow panel webview HTML as a standalone browser page,
 * fed a FlowModel computed from THIS repo's actual .vinv state — for visual QA
 * and screenshots outside VS Code.
 *
 * Usage: node scripts/flow-standalone.mjs <repo-root> <out.html> [dark]
 */
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.argv[2] ?? process.cwd());
const outFile = resolve(process.argv[3] ?? 'flow-standalone.html');
const theme = process.argv[4] === 'dark' ? 'vscode-dark' : 'vscode-light';

const out = mkdtempSync(join(tmpdir(), 'vinv-flow-standalone-'));
const stub = join(out, 'vscode-stub.mjs');
writeFileSync(
	stub,
	'export default {};\nexport const window = {}, commands = {}, workspace = {}, Uri = {}, env = {};\n',
);
await build({
	entryPoints: [join(here, '..', 'src', 'views', 'flowModel.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: join(out, 'flowModel.mjs'),
	logLevel: 'silent',
});
await build({
	entryPoints: [join(here, '..', 'src', 'views', 'flowPanel.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: join(out, 'flowPanel.mjs'),
	logLevel: 'silent',
	alias: { vscode: stub },
	// getFlowHtml is module-private — re-export it from the bundle.
	footer: { js: '\nexport { getFlowHtml };\n' },
});
const { computeFlowModel } = await import(pathToFileURL(join(out, 'flowModel.mjs')).href);
const { getFlowHtml } = await import(pathToFileURL(join(out, 'flowPanel.mjs')).href);

// ---- Build FlowFacts from the repo's real .vinv state -----------------------
const vinv = (p) => join(repoRoot, '.vinv', p);
const readJson = (p) => {
	try {
		return JSON.parse(readFileSync(p, 'utf8'));
	} catch {
		return null;
	}
};

const handbook = existsSync(vinv('vinv.md'));
const services = readJson(vinv('services.json'))?.services ?? [];
const apis = readJson(vinv('identification/apis.json'))?.apis ?? [];
let captureRuns = 0;
try {
	captureRuns = readdirSync(vinv('captures')).length;
} catch {}
const reports = [];
try {
	for (const f of readdirSync(vinv('reports')))
		// Endpoint health reports only — QA artifacts (flow-*.html, graph.html)
		// are not insights and must not appear as such.
		if (/^smoke-.+\.html$/.test(f)) reports.push({ id: f, kind: 'smoke', label: f.replace(/^smoke-|\.html$/g, ''), path: vinv(`reports/${f}`), stale: false });
} catch {}

/** @type {import('../src/views/flowModel').FlowFacts} */
const facts = {
	enginesReady: true,
	discovery: {
		phase: handbook ? 'done' : 'idle',
		label: handbook ? 'Project mapped' : 'Not discovered yet',
	},
	discovered: handbook || existsSync(vinv('index/meta.json')),
	handbookPath: handbook ? vinv('vinv.md') : undefined,
	services: services.length
		? services.map((s) => ({ name: s.name, state: 'ready' }))
		: [
				{ name: 'embedder', state: 'running' },
				{ name: 'web', state: 'unattempted' },
			],
	sessionCount: captureRuns,
	tracedEndpoints: apis.slice(0, 3).map((a) => ({
		apiId: a.id,
		label: `${a.method ?? ''} ${a.path ?? ''}`.trim() || a.id,
		traceCount: a.id === 'POST_checkout' ? 2 : 41,
	})),
	reports,
	issues: [
		{
			id: 'demo-broken-pipe',
			title: '_handle_embeddings is failing in live runs',
			detail: 'BrokenPipeError observed on 6 of 82 requests (client disconnected mid-encode).',
			service: 'embedder',
			evidencePath: vinv('captures/embedder-live2/trace.jsonl'),
			dispatched: true,
		},
	],
	probes: [
		{ label: 'POST /v1/embeddings responds with aligned vectors', passed: true },
		{ label: 'GET /health serves while encoding', passed: true },
	],
	pendingEdges: 0,
	diffImpact: { changedSymbols: 1, impactedSymbols: 2 },
	autoPilot: { running: true, label: 'Building insights for embedder' },
	pipelinePhase: 'insights',
	insight: { phase: 'running', label: `building report ${reports.length + 1}` },
	probe: { phase: 'done', label: '2/2 checks passing' },
	nextStep: undefined,
};

// Optional facts override for rendering specific pipeline moments (used by
// the journey-GIF builder): FLOW_FACTS_OVERRIDE='{"json":"merged over facts"}'.
if (process.env.FLOW_FACTS_OVERRIDE) {
	Object.assign(facts, JSON.parse(process.env.FLOW_FACTS_OVERRIDE));
}

let model;
try {
	model = computeFlowModel(facts);
} catch (e) {
	console.error('computeFlowModel failed on real facts:', e.message);
	process.exit(1);
}

const bootstrap = `<script>
window.acquireVsCodeApi = function () { return { postMessage: function (m) { console.log('[msg]', JSON.stringify(m)); } }; };
window.addEventListener('load', function () {
	document.body.className = ${JSON.stringify(theme)};
	setTimeout(function () { window.postMessage({ type: 'model', model: ${JSON.stringify(model)} }, '*'); }, 30);
});
</script>
<style>body { max-width: 420px; margin: 0 auto; ${theme === 'vscode-dark' ? 'background:#1e1e1e;color:#ccc;' : 'background:#fff;color:#333;'} }
:root { --vscode-foreground: ${theme === 'vscode-dark' ? '#cccccc' : '#333333'}; --vscode-editor-background: ${theme === 'vscode-dark' ? '#1e1e1e' : '#ffffff'}; --vscode-descriptionForeground: ${theme === 'vscode-dark' ? '#9d9d9d' : '#717171'}; --vscode-focusBorder: #0078d4; --vscode-errorForeground: ${theme === 'vscode-dark' ? '#f48771' : '#a1260d'}; --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-badge-background: ${theme === 'vscode-dark' ? '#4d4d4d' : '#c4c4c4'}; --vscode-badge-foreground: ${theme === 'vscode-dark' ? '#ffffff' : '#333333'}; --vscode-panel-border: ${theme === 'vscode-dark' ? '#414141' : '#d4d4d4'}; --vscode-textLink-foreground: ${theme === 'vscode-dark' ? '#4daafc' : '#006ab1'}; }</style>`;

const html = getFlowHtml("'self'")
	// Standalone page: the webview CSP (nonce'd) would block the injected
	// bootstrap script — drop it; this file is local visual QA only.
	.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
	.replace(/nonce="[^"]*"/g, '')
	.replace('<script', `${bootstrap}\n<script`);
writeFileSync(outFile, html);
console.log(`[flow] stages=${model.stages.map((s) => `${s.id}:${s.status}`).join(' ')} issues=${model.issues.length}`);
console.log(`[written] ${outFile}`);
