/**
 * Focused headless check: a snapshot whose nodes have NO edges at all (the
 * "disjoint node" case). Clicking any node must still open the detail panel
 * with Open/Ask/Fix actions, and the panel must explain the missing links.
 */
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'vinv-e2e-unlinked-'));
await build({
	entryPoints: [join(here, '..', 'src', 'views', 'graphExplorerHtml.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: join(out, 'html.mjs'),
	logLevel: 'silent',
});
const { getGraphHtml } = await import(pathToFileURL(join(out, 'html.mjs')).href);

const node = (row, file, name, extra = {}) => ({
	row, id: 'id' + row, file, lang: 'python', kind: 'function', name,
	start_line: 5, end_line: 20, summary: 'demo ' + name, rank: 0.4, epoch: 1,
	parent: null, layer: 'service', ...extra,
});
const snapshot = {
	generated_at: new Date().toISOString(),
	workspace: '/tmp/ws',
	store_epoch: 1,
	node_count: 3,
	edge_count: 0,
	layers: ['service', 'other'],
	nodes: [
		node(0, 'a/isolated.py', 'lonely'),
		node(1, 'b/other.py', 'fn_b'),
		node(2, 'c/third.py', 'fn_c'),
	],
	edges: [], // completely disjoint graph
	files: [
		{ file: 'a/isolated.py', layer: 'service', rows: [0], rank: 0.4, changed: false, symbols: 1 },
		{ file: 'b/other.py', layer: 'service', rows: [1], rank: 0.4, changed: false, symbols: 1 },
		{ file: 'c/third.py', layer: 'service', rows: [2], rank: 0.4, changed: false, symbols: 1 },
	],
	file_edges: [],
	tour: [],
	runtime: { 0: { executed: true, calls: 3, total_ms: 12, errors: 1, error_types: ['ValueError'] } },
	flow_edges: [],
};

const failures = [];
const vconsole = new VirtualConsole();
vconsole.on('jsdomError', (e) => failures.push('jsdomError: ' + e.message));
const dom = new JSDOM(getGraphHtml(), { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vconsole });
const { window } = dom;
const posted = [];
window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
const noop = () => {};
const ctxStub = new Proxy(
	{ measureText: () => ({ width: 24 }), canvas: {} },
	{ get: (t, p) => (p in t ? t[p] : typeof p === 'string' ? noop : undefined), set: () => true },
);
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
	return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
};
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
	get() { return this.id === 'canvas-wrap' ? 1200 : 0; },
});
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
	get() { return this.id === 'canvas-wrap' ? 800 : 0; },
});
let rafQueue = [];
window.requestAnimationFrame = (cb) => (rafQueue.push(cb), rafQueue.length);
window.ResizeObserver = window.ResizeObserver || class { observe() {} disconnect() {} };
const pump = (n) => {
	for (let i = 0; i < n; i++) {
		const q = rafQueue; rafQueue = [];
		for (const cb of q) { try { cb(performance.now()); } catch (e) { failures.push('rAF: ' + (e.stack ?? e)); } }
	}
};
const scriptSrc = getGraphHtml().match(/<script>([\s\S]*?)<\/script>/)[1];
try { window.eval(scriptSrc); } catch (e) { failures.push('eval: ' + (e.stack ?? e)); }

window.postMessage({ type: 'snapshot', snapshot }, '*');
await new Promise((r) => setTimeout(r, 30));
pump(400);

const detail = window.document.getElementById('detail');
const clickAt = (x, y) => {
	const canvas = window.document.getElementById('canvas');
	const down = new window.MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true });
	Object.defineProperty(down, 'offsetX', { value: x });
	Object.defineProperty(down, 'offsetY', { value: y });
	canvas.dispatchEvent(down);
	window.dispatchEvent(new window.MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
	pump(3);
};

for (const mode of ['explore', 'runtime', 'diff']) {
	window.document.getElementById('m-' + mode).click();
	pump(5);
	let opened = 0;
	const titles = new Set();
	for (let gx = 40; gx <= 1160; gx += 20) {
		for (let gy = 40; gy <= 760; gy += 20) {
			clickAt(gx, gy);
			if (detail.classList.contains('open')) {
				opened += 1;
				titles.add(detail.querySelector('h2')?.textContent ?? '');
				const acts = detail.querySelectorAll('[data-act]').length;
				if (acts === 0) failures.push(mode + ': panel opened without actions');
				clickAt(5, 5); // deselect on empty space
			}
		}
	}
	console.log('[' + mode + '] panel opened at ' + opened + ' grid points, distinct nodes: ' + [...titles].join(', '));
	if (titles.size < 3) failures.push(mode + ': not every disjoint node opened a panel (got ' + titles.size + '/3)');
}

// The no-links explanation must be present for a disjoint node.
window.document.getElementById('m-explore').click();
pump(3);
outer: for (let gx = 40; gx <= 1160; gx += 20) {
	for (let gy = 40; gy <= 760; gy += 20) {
		clickAt(gx, gy);
		if (detail.classList.contains('open')) break outer;
	}
}
const body = detail.innerHTML;
if (!/no static or observed links/.test(body)) {
	failures.push('disjoint node panel does not explain its missing links');
}
if (!/data-act="open"/.test(body)) {
	failures.push('disjoint node panel has no Open action');
}

if (failures.length) {
	console.error('\nFAIL:');
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('\nPASS: every disjoint node opens its panel with code/ask/fix actions and a links explanation');
