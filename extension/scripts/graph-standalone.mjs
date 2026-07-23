/**
 * Renders the real Graph Explorer webview HTML as a standalone browser page,
 * fed the LIVE snapshot from a repo's index store — for visual verification
 * outside VS Code (design QA, screenshots, docs).
 *
 * Usage: node scripts/graph-standalone.mjs <repo-root> <out.html>
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.argv[2] ?? process.cwd());
const outFile = resolve(process.argv[3] ?? 'graph-standalone.html');

const out = mkdtempSync(join(tmpdir(), 'vinv-graph-standalone-'));
await build({
	entryPoints: [join(here, '..', 'src', 'graph', 'indexGraph.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: join(out, 'indexGraph.mjs'),
	logLevel: 'silent',
});
await build({
	entryPoints: [join(here, '..', 'src', 'views', 'graphExplorerHtml.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: join(out, 'html.mjs'),
	logLevel: 'silent',
});
const { buildGraphSnapshot } = await import(pathToFileURL(join(out, 'indexGraph.mjs')).href);
const { getGraphHtml } = await import(pathToFileURL(join(out, 'html.mjs')).href);

const snapshot = buildGraphSnapshot(repoRoot);
console.log(
	`[snapshot] ${snapshot.node_count} symbols, ${snapshot.edge_count} edges, epoch ${snapshot.store_epoch}`,
);

// Stub the VS Code webview API and deliver the snapshot exactly as the panel
// does: a `{type:'snapshot', snapshot}` message after load.
const bootstrap = `<script>
window.acquireVsCodeApi = function () {
	return { postMessage: function (m) { console.log('[vscode message]', JSON.stringify(m).slice(0, 200)); } };
};
window.addEventListener('load', function () {
	setTimeout(function () {
		window.postMessage({ type: 'snapshot', snapshot: ${JSON.stringify(snapshot)} }, '*');
	}, 50);
});
</script>`;

const html = getGraphHtml().replace('<script>', `${bootstrap}\n<script>`);
writeFileSync(outFile, html);
console.log(`[written] ${outFile}`);
