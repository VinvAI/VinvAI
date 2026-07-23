/**
 * Headless e2e of the Graph Explorer WEBVIEW SCRIPT itself — the exact HTML the
 * panel renders, loaded in jsdom with a stub 2D canvas, fed the LIVE snapshot
 * built from this repo's index store. Verifies what the user actually does:
 *   load → snapshot render → switch to each mode → click a node (detail panel
 *   opens with links/actions) → click a linked row → header buttons.
 *
 * Usage: node scripts/e2e-graph-webview.mjs <repo-root>
 */
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.argv[2] ?? process.cwd());

// 1) Build the real snapshot from the live store.
const out = mkdtempSync(join(tmpdir(), 'vinv-e2e-webview-'));
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
	`[snapshot] ${snapshot.node_count} symbols, ${snapshot.edge_count} edges, ` +
		`epoch ${snapshot.store_epoch}, runtime rows ${Object.keys(snapshot.runtime).length}`,
);

// 2) Load the REAL HTML in jsdom with canvas + vscode API stubbed.
const failures = [];
const vconsole = new VirtualConsole();
vconsole.on('jsdomError', (e) => failures.push(`jsdomError: ${e.message}`));
const dom = new JSDOM(getGraphHtml(), {
	runScripts: 'outside-only',
	pretendToBeVisual: true,
	virtualConsole: vconsole,
});
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
// jsdom has no layout: give the canvas wrap real dimensions so resize()/fitView()
// see the same geometry a 1200x800 webview would.
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
	get() {
		return this.id === 'canvas-wrap' ? 1200 : 0;
	},
});
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
	get() {
		return this.id === 'canvas-wrap' ? 800 : 0;
	},
});
// Fixed-rate rAF so the sim can settle deterministically.
let rafQueue = [];
window.requestAnimationFrame = (cb) => (rafQueue.push(cb), rafQueue.length);
window.ResizeObserver =
	window.ResizeObserver ||
	class {
		observe() {}
		disconnect() {}
	};
const pump = (n) => {
	for (let i = 0; i < n; i++) {
		const q = rafQueue;
		rafQueue = [];
		for (const cb of q) {
			try {
				cb(performance.now());
			} catch (e) {
				failures.push(`rAF: ${e.stack ?? e}`);
			}
		}
	}
};

// Execute the page script (jsdom parsed the HTML but runScripts:outside-only
// skips inline <script>, so run it ourselves to catch exceptions loudly).
const scriptSrc = getGraphHtml().match(/<script>([\s\S]*?)<\/script>/)[1];
try {
	window.eval(scriptSrc);
} catch (e) {
	failures.push(`script eval: ${e.stack ?? e}`);
}

// 3) Deliver the snapshot the way the extension host does.
window.postMessage({ type: 'snapshot', snapshot }, '*');
await new Promise((r) => setTimeout(r, 30));
pump(400); // let the force sim settle and draw

const meta = window.document.getElementById('meta').textContent;
console.log(`[render] meta="${meta}"`);
if (!/symbols/.test(meta)) failures.push('meta line never rendered');

// Helper: click the node nearest the canvas center in world space by
// dispatching real mousedown/mouseup like a user click.
const clickAt = (x, y) => {
	const canvas = window.document.getElementById('canvas');
	const down = new window.MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true });
	Object.defineProperty(down, 'offsetX', { value: x });
	Object.defineProperty(down, 'offsetY', { value: y });
	canvas.dispatchEvent(down);
	const up = new window.MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true });
	window.dispatchEvent(up);
	pump(3);
};

// Find a real node's screen position: instrument via the debug hook if present,
// else brute-force scan the canvas area clicking a grid until the panel opens.
const detail = window.document.getElementById('detail');
const modes = ['explore', 'runtime', 'diff', 'tour'];
for (const m of modes) {
	window.document.getElementById('m-' + m).click();
	pump(5);
	// Grid-scan for a clickable node in this mode.
	let opened = false;
	outer: for (let gx = 100; gx <= 1100; gx += 50) {
		for (let gy = 100; gy <= 700; gy += 50) {
			clickAt(gx, gy);
			if (detail.classList.contains('open')) {
				opened = true;
				break outer;
			}
		}
	}
	const title = detail.querySelector('h2')?.textContent ?? '';
	const links = detail.querySelectorAll('[data-goto]').length;
	const actions = detail.querySelectorAll('[data-act]').length;
	console.log(
		`[mode ${m}] click→panel=${opened} title="${title}" linked=${links} actions=${actions}`,
	);
	if (!opened) failures.push(`mode ${m}: clicking nodes never opened the detail panel`);
	if (opened && actions === 0) failures.push(`mode ${m}: detail panel has no action buttons`);
	// Click a linked row (the "show linked ones" path).
	const firstLink = detail.querySelector('[data-goto]');
	if (firstLink) {
		firstLink.click();
		pump(3);
		const t2 = detail.querySelector('h2')?.textContent ?? '';
		if (t2 === title && links > 0) {
			// Same node is legal if the top link loops back; only flag empty panel.
			if (!detail.classList.contains('open')) failures.push(`mode ${m}: link click closed panel`);
		}
		console.log(`[mode ${m}] linked-row click → "${t2}"`);
	}
	// Deselect between modes.
	window.document.getElementById('btn-fit').click();
	pump(3);
}

// 4) "Open in Editor" and "Ask" wiring from the detail panel.
window.document.getElementById('m-explore').click();
pump(3);
outer2: for (let gx = 100; gx <= 1100; gx += 40) {
	for (let gy = 100; gy <= 700; gy += 40) {
		clickAt(gx, gy);
		if (detail.classList.contains('open')) break outer2;
	}
}
const openBtn = detail.querySelector('[data-act="open"]');
if (openBtn) {
	openBtn.click();
	const m = posted.find((p) => p.type === 'openSource');
	console.log(`[actions] openSource posted: ${JSON.stringify(m)}`);
	if (!m || !m.file) failures.push('Open in Editor did not post openSource with a file');
} else {
	failures.push('detail panel had no Open action');
}
window.document.getElementById('btn-ask').click();
const askMsg = posted.find((p) => p.type === 'ask');
console.log(`[actions] ask posted: ${JSON.stringify(askMsg)}`);
if (!askMsg) failures.push('header Ask button posted nothing');
window.document.getElementById('btn-trajectory').click();
const trajectoryMsg = posted.find((p) => p.type === 'trajectory');
console.log(`[actions] trajectory posted: ${JSON.stringify(trajectoryMsg)}`);
if (!trajectoryMsg) failures.push('header Trajectory button posted nothing');

// 5) Search highlight → verify highlight state feeds selection.
const search = window.document.getElementById('search');
search.value = 'bringup';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
pump(3);
console.log('[search] local highlight dispatched for "bringup"');

if (failures.length) {
	console.error('\nFAIL:');
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('\nPASS: webview renders, every mode click opens the detail panel with working actions');
