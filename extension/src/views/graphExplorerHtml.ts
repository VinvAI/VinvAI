/**
 * The Graph Explorer webview document. Split from graphExplorer.ts so the
 * provider (message handling) and the presentation (layout, rendering,
 * interaction) can evolve independently.
 *
 * Readability is the design constraint everything below serves:
 * - SELECTION ISOLATES: clicking a node dims everything except the node and
 *   its direct neighbors; the detail panel lists those links for navigation.
 * - LABELS NEVER COLLIDE: a greedy screen-space occupancy check places labels
 *   in rank order and simply skips ones that would overlap; zooming in frees
 *   space and more labels appear.
 * - LAYERS ARE FILTERS: the legend chips toggle layers (tests/docs off by
 *   default on large graphs) so the working set stays human-scale.
 * - THE LAYOUT BREATHES: repulsion and edge rest-length scale with node count,
 *   a collision pass separates overlapping discs, and the view auto-fits.
 */
import { VINV_BASE_CSS, VINV_FONT_SERIF } from './webviewTheme';

export function getGraphHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Vinv Graph</title>
	<style>
		${VINV_BASE_CSS}
		/* Manual theme override (header toggle): the same two palettes the
		   vscode-light/vscode-dark classes map to, declared AFTER the base so
		   an explicit choice beats whatever the editor stamped on <body>. */
		body.vinv-light {
			--bg: #ffffff; --bg-2: #f4f4f4; --ink: #0a0a0a; --ink-soft: #1a1a1a;
			--muted: #616161; --muted-2: #7a7a7a;
			--accent: #d71921; --accent-fg: #d71921; --accent-hover: #b3151c;
			--line: rgba(10, 10, 10, 0.14); --line-strong: rgba(10, 10, 10, 0.32);
			--grid: rgba(10, 10, 10, 0.05); --grain: rgba(10, 10, 10, 0.05);
			--grain-blend: multiply;
		}
		body.vinv-dark {
			--bg: #000000; --bg-2: #0b0b0b; --ink: #ffffff; --ink-soft: #ededed;
			--muted: #8f8f8f; --muted-2: #6e6e6e;
			--accent: #d71921; --accent-fg: #ff4048; --accent-hover: #e2262f;
			--line: rgba(255, 255, 255, 0.14); --line-strong: rgba(255, 255, 255, 0.32);
			--grid: rgba(255, 255, 255, 0.05); --grain: rgba(255, 255, 255, 0.05);
			--grain-blend: screen;
		}
		html, body { height: 100%; overflow: hidden; }
		body { display: flex; flex-direction: column; font-size: 12px; }
		header {
			flex: none; display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
			padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--bg);
		}
		h1 {
			font-family: ${VINV_FONT_SERIF}; font-style: italic; font-weight: 400;
			font-size: 20px; margin: 0; letter-spacing: -0.01em;
		}
		.meta { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		.spacer { flex: 1; }
		#search {
			width: 250px; padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: 0;
			background: var(--bg); color: var(--ink); font-family: inherit; font-size: 11.5px;
		}
		#search:focus { outline: none; border-color: var(--accent-fg); }
		.mode-switch { display: inline-flex; border: 1px solid var(--line-strong); }
		.mode-switch button {
			background: transparent; color: var(--muted); border: none; padding: 5px 11px; cursor: pointer;
			font-size: 9.5px; font-family: inherit; letter-spacing: 0.18em; text-transform: uppercase;
		}
		.mode-switch button + button { border-left: 1px solid var(--line-strong); }
		.mode-switch button.active { background: var(--ink); color: var(--bg); }
		main { flex: 1; display: flex; min-height: 0; }
		#canvas-wrap { flex: 1; position: relative; min-width: 0; }
		canvas { position: absolute; inset: 0; cursor: grab; }
		canvas.dragging { cursor: grabbing; }
		/* UI chrome always paints above the canvas: an explicit stacking order so
		   panels, legend, tour, and status can never sink behind nodes. */
		#legend, #tourbox, #status { z-index: 10; }
		aside { z-index: 11; }
		#legend {
			position: absolute; left: 12px; bottom: 12px; padding: 10px 12px;
			background: var(--bg); border: 1px solid var(--line-strong); font-size: 10px;
		}
		#legend .row {
			display: flex; align-items: center; gap: 7px; padding: 2px 0; color: var(--muted);
			cursor: pointer; user-select: none;
		}
		#legend .row:hover { color: var(--ink); }
		#legend .row.off { opacity: 0.35; text-decoration: line-through; }
		#legend .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
		#legend .hint { margin-top: 6px; color: var(--muted-2); font-size: 9px; }
		#tourbox {
			position: absolute; left: 12px; top: 12px; max-width: 420px; padding: 12px 14px;
			background: var(--bg); border: 1px solid var(--line-strong); display: none;
		}
		#tourbox .t-name { font-weight: 600; margin: 6px 0 4px; }
		#tourbox .t-summary { color: var(--muted); line-height: 1.5; }
		#tourbox .t-nav { margin-top: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
		aside {
			flex: none; width: 320px; border-left: 1px solid var(--line-strong);
			overflow-y: auto; padding: 14px 16px; display: none; background: var(--bg);
		}
		aside.open { display: block; }
		/* Edge tab to re-open / collapse the detail panel without losing the
		   selection — the canvas gets the full width back when hidden. */
		#panel-toggle {
			position: absolute; right: 0; top: 50%; transform: translateY(-50%);
			z-index: 12; display: none; padding: 12px 3px;
			background: var(--bg); border: 1px solid var(--line-strong); border-right: none;
			cursor: pointer; font-family: inherit; font-size: 9px; letter-spacing: 0.18em;
			text-transform: uppercase; color: var(--muted); writing-mode: vertical-rl;
		}
		#panel-toggle:hover { color: var(--ink); }
		.aside-head {
			display: flex; align-items: baseline; justify-content: space-between;
			gap: 8px; margin-bottom: 8px;
		}
		.aside-close {
			background: none; border: 1px solid var(--line-strong); color: var(--muted);
			cursor: pointer; font: inherit; font-size: 11px; line-height: 1; padding: 3px 8px; flex: none;
		}
		.aside-close:hover { color: var(--ink); border-color: var(--ink); }
		aside h2 { font-size: 13px; margin: 0 0 2px; word-break: break-all; }
		aside .sub { color: var(--muted); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 10px; }
		aside .summary { color: var(--muted); line-height: 1.55; margin: 8px 0; }
		aside .actions { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
		aside .section { margin-top: 14px; }
		.sym, .link-row {
			padding: 5px 7px; cursor: pointer; border-left: 2px solid transparent;
			display: flex; justify-content: space-between; gap: 6px; align-items: baseline;
		}
		.sym:hover, .link-row:hover { background: var(--bg-2); border-left-color: var(--accent-fg); }
		.sym .nm, .link-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.sym .rt, .link-row .dir { flex: none; font-size: 9.5px; color: var(--muted-2); text-transform: uppercase; letter-spacing: 0.1em; }
		.sym .rt.err { color: var(--accent-fg); }
		#status {
			position: absolute; top: 12px; right: 12px; padding: 6px 10px;
			font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted);
			background: var(--bg); border: 1px solid var(--line-strong);
			display: none;
		}
	</style>
</head>
<body>
	<header>
		<div>
			<h1>Code Graph</h1>
			<div class="meta" id="meta">loading…</div>
		</div>
		<div class="spacer"></div>
		<input id="search" type="text" placeholder="search symbols… (Enter = semantic)" />
		<div class="mode-switch">
			<button id="m-explore" class="active" title="Browse the whole graph — click a node to isolate it and its links">Explore</button>
			<button id="m-runtime" title="Overlay captured traces: ringed nodes actually executed (red ring = errors)">Runtime</button>
			<button id="m-diff" title="What changed this epoch (solid red ring) and everything downstream of it (dashed ring)">Diff Impact</button>
			<button id="m-tour" title="Dependency-ordered walkthrough of the highest-ranked symbols">Tour</button>
		</div>
		<button class="v-btn primary" id="btn-ask" title="Ask a question about the selected node (or the whole codebase)">Ask Vinv</button>
		<button class="v-btn" id="btn-trajectory" title="Show episode history, goals, rewards, evidence, disputes, reverts, and learned policy changes">Trajectory</button>
		<button class="v-btn" id="btn-theme" title="Cycle the graph theme: follow the editor, always light, or always dark">Theme: Auto</button>
		<button class="v-btn" id="btn-fit" title="Zoom to fit the whole graph and clear the selection">Fit</button>
		<button class="v-btn" id="btn-refresh" title="Rebuild the snapshot from the index store on disk">Refresh</button>
	</header>
	<main>
		<div id="canvas-wrap">
			<canvas id="canvas"></canvas>
			<div id="legend"></div>
			<div id="status"></div>
			<button id="panel-toggle" title="Show / hide the details panel">details</button>
			<div id="tourbox">
				<span class="v-label">guided tour</span>
				<div class="t-name" id="t-name"></div>
				<div class="t-summary" id="t-summary"></div>
				<div class="t-nav">
					<button class="v-btn" id="t-prev">Prev</button>
					<span class="meta" id="t-step"></span>
					<button class="v-btn" id="t-next">Next</button>
					<button class="v-btn" id="t-open">Open in Editor</button>
				</div>
			</div>
		</div>
		<aside id="detail"></aside>
	</main>

	<script>
	const vscode = acquireVsCodeApi();
	window.addEventListener('error', function (e) { vscode.postMessage({ type: 'webviewError', message: String((e && e.message) || 'unknown'), stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : undefined }); });
	window.addEventListener('unhandledrejection', function (e) { vscode.postMessage({ type: 'webviewError', message: 'unhandledrejection: ' + String((e && e.reason) || ''), stack: e && e.reason && e.reason.stack ? String(e.reason.stack).slice(0, 2000) : undefined }); });

	// Layer palette derived from the Vinv brand: the accent red (#d71921,
	// hue ≈ 357°) is RESERVED for state — errors, selection, changed-this-epoch —
	// so no layer may sit near it on the wheel. Layers take the complementary
	// and analogous-to-complementary arc (teal → blue → violet) plus warm
	// support tones, all at matched, muted saturation/lightness so they read as
	// one editorial family on both white and black, and none competes with red.
	const LAYER_COLORS = {
		api: '#b98a2e',      // ochre — entry points, warm support
		service: '#3d7ea6',  // steel blue — complementary arc
		data: '#2e8a6e',     // sea green
		ui: '#7a5fa6',       // violet
		util: '#6e7f8c',     // slate
		config: '#a67c52',   // umber
		scripts: '#3f9aa6',  // teal — direct complement of the brand red
		tests: '#7e8a4f',    // olive
		docs: '#8f8f8f',     // neutral gray (matches dark --muted)
		other: '#6e6e6e',    // neutral dark (matches dark --muted-2; was #5c5c5c,
		                     // which sat at exactly the 3:1 floor on black)
	};
	// State red (errors, selection, changed-this-epoch) is read from the theme
	// each time it is used: --accent-fg keeps the brand hue but shifts lightness
	// per theme (#d71921 on white, #ff4048 on black), because the print red at
	// 4.05:1 on black made the whole Runtime overlay unreadable in dark themes.
	function accentFg() { return cssVar('--accent-fg'); }
	// Layers that start hidden on big graphs — one legend click brings them back.
	const NOISY_LAYERS = ['tests', 'docs'];
	const BIG_GRAPH_FILES = 120;

	let snapshot = null;
	// Dead code used to be a fifth mode here. A canvas filter can say WHERE the
	// untraced nodes are and nothing else — not what they do, not whether anything
	// still points at them, not what to do about them — so it moved to Findings,
	// where it is a list of sections each opening its own walkthrough report.
	let mode = 'explore';           // explore | runtime | diff | tour
	let expanded = new Set();       // files rendered at symbol level
	let selected = null;            // display-node id
	let neighborIds = new Set();    // direct neighbors of the selected node
	let highlightRows = new Set();  // search highlight (symbol rows)
	let highlightFiles = new Set();
	let hiddenLayers = new Set();   // legend-toggled off
	let tourIndex = 0;
	let impactedFiles = new Set();  // diff mode: changed + inbound closure
	let changedFiles = new Set();
	let hoverId = null;

	// ---- display graph (file nodes + expanded symbol nodes) ----
	let dnodes = [];   // {id, kind:'file'|'symbol', label, file, row?, layer, r, x, y, vx, vy, rank, changed, rt}
	let dedges = [];   // {a, b, w} indices into dnodes
	let dflow = [];    // observed call flow: {a, b, calls, ms, errors, only} directed a->b
	let byId = new Map();
	let adjacency = new Map(); // id -> Set of neighbor ids

	function fileRuntime(group) {
		if (!snapshot) { return null; }
		let calls = 0, ms = 0, errors = 0, current = 0, executed = 0;
		for (const row of group.rows) {
			const rt = snapshot.runtime[row];
			if (rt) {
				executed += 1; calls += rt.calls; ms += rt.total_ms; errors += rt.errors;
				current += rt.current_errors ?? rt.errors;
			}
		}
		return executed ? { executed, calls, ms, errors, current_errors: current } : null;
	}

	// Deterministic per-node hash → [0,1). Positions are seeded from stable ids
	// (never Math.random) so the map does not reshuffle between refreshes —
	// users build spatial memory, protect it.
	function hash01(str) {
		let h = 2166136261 >>> 0;
		for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
		return (h >>> 0) / 4294967296;
	}
	const GOLDEN = 2.399963229728653; // golden angle, radians

	function buildDisplayGraph() {
		if (!snapshot) { return; }
		const prev = new Map(dnodes.map((n) => [n.id, n]));
		// Where each file lived last build (file node or centroid of its
		// symbols): expanding dissolves a file into children AT its position and
		// collapsing merges them back — no teleporting.
		const filePos = new Map();
		for (const n of dnodes) {
			const cur = filePos.get(n.file) || { x: 0, y: 0, c: 0 };
			cur.x += n.x; cur.y += n.y; cur.c += 1;
			filePos.set(n.file, cur);
		}
		dnodes = []; dedges = []; byId = new Map(); adjacency = new Map();
		const visibleFiles = snapshot.files.filter((g) => !hiddenLayers.has(g.layer));
		const nodeIndex = new Map();
		const add = (n) => {
			nodeIndex.set(n.id, dnodes.length);
			byId.set(n.id, n);
			dnodes.push(n);
		};
		for (const g of visibleFiles) {
			if (expanded.has(g.file)) {
				for (const row of g.rows) {
					const s = snapshot.nodes[row];
					add({
						id: 'sym:' + row, kind: 'symbol', label: s.name, file: s.file, row,
						layer: s.layer, r: Math.max(4, 4 + Math.sqrt(s.rank) * 14),
						rank: s.rank, changed: snapshot.store_epoch > 0 && s.epoch === snapshot.store_epoch,
						rt: snapshot.runtime[row] || null,
					});
				}
			} else {
				add({
					id: 'file:' + g.file, kind: 'file', label: g.file.split('/').pop(), file: g.file,
					layer: g.layer, r: Math.max(6, 6 + Math.sqrt(g.rank) * 16),
					rank: g.rank, changed: g.changed, rt: fileRuntime(g), symbols: g.symbols,
				});
			}
		}
		// Aggregate edges onto display nodes.
		const rowTarget = (row) => {
			const s = snapshot.nodes[row];
			if (hiddenLayers.has(s.layer)) { return null; }
			return expanded.has(s.file) ? 'sym:' + row : 'file:' + s.file;
		};
		const agg = new Map();
		for (const e of snapshot.edges) {
			if (e.kind === 'contains') { continue; }
			const ta = rowTarget(e.src), tb = rowTarget(e.dst);
			if (!ta || !tb) { continue; }
			const a = nodeIndex.get(ta), b = nodeIndex.get(tb);
			if (a === undefined || b === undefined || a === b) { continue; }
			const key = a < b ? a + ':' + b : b + ':' + a;
			const cur = agg.get(key);
			if (cur) { cur.w += 1; } else { agg.set(key, { a, b, w: 1 }); }
		}
		dedges = [...agg.values()];
		// Observed call flow (directed) aggregated onto the same display nodes.
		// This is what connects "disjoint" nodes the static parser can't link:
		// dynamic dispatch, decorators, framework routing all show up here.
		const flowAgg = new Map();
		for (const f of (snapshot.flow_edges || [])) {
			const ta = rowTarget(f.src), tb = rowTarget(f.dst);
			if (!ta || !tb) { continue; }
			const a = nodeIndex.get(ta), b = nodeIndex.get(tb);
			if (a === undefined || b === undefined || a === b) { continue; }
			const key = a + '>' + b;
			const cur = flowAgg.get(key);
			if (cur) {
				cur.calls += f.calls; cur.ms += f.total_ms; cur.errors += f.errors;
				cur.only = cur.only && f.observed_only;
			} else {
				flowAgg.set(key, { a, b, calls: f.calls, ms: f.total_ms, errors: f.errors, only: f.observed_only });
			}
		}
		dflow = [...flowAgg.values()];
		const link = (ia, ib) => {
			const ida = dnodes[ia].id, idb = dnodes[ib].id;
			if (!adjacency.has(ida)) { adjacency.set(ida, new Set()); }
			if (!adjacency.has(idb)) { adjacency.set(idb, new Set()); }
			adjacency.get(ida).add(idb);
			adjacency.get(idb).add(ida);
		};
		for (const e of dedges) { link(e.a, e.b); }
		for (const f of dflow) { link(f.a, f.b); }
		bakeLayout(prev, filePos);
		if (selected && !byId.has(selected)) { select(null); }
		if (selected) { neighborIds = adjacency.get(selected) || new Set(); }
		// Every status line counts dnodes, and this is the ONE place dnodes
		// changes — legend toggle, expand, collapse. Refreshing per call site
		// missed all three: showing the hidden-by-default tests/docs layers
		// grows the set from 336 to 577, so a status line computed elsewhere kept
		// reporting "332 of 336" while the truth on screen was "573 of 577", and
		// expanding a file left the file-node count sitting over a canvas of
		// symbol nodes.
		setStatus(modeStatus());
	}

	// ---- diff impact: changed symbols + inbound invoke closure, per file ----
	function computeImpact() {
		changedFiles = new Set(); impactedFiles = new Set();
		if (!snapshot || snapshot.store_epoch <= 0) { return; }
		const changedRows = [];
		for (const n of snapshot.nodes) {
			if (n.epoch === snapshot.store_epoch) { changedRows.push(n.row); changedFiles.add(n.file); }
		}
		const inbound = new Map();
		for (const e of snapshot.edges) {
			if (e.kind === 'contains') { continue; }
			if (!inbound.has(e.dst)) { inbound.set(e.dst, []); }
			inbound.get(e.dst).push(e.src);
		}
		const seen = new Set(changedRows);
		let frontier = changedRows;
		while (frontier.length) {
			const next = [];
			for (const row of frontier) {
				for (const caller of inbound.get(row) || []) {
					if (!seen.has(caller)) { seen.add(caller); next.push(caller); }
				}
			}
			frontier = next;
		}
		for (const row of seen) { impactedFiles.add(snapshot.nodes[row].file); }
	}

	// ---- baked multilevel layout ------------------------------------------
	// The pipeline the universe design prescribes, computed at build time and
	// fully deterministic (hash-seeded, fixed iteration counts — the map never
	// reshuffles between refreshes):
	//   1. cluster: directory-based "solar systems"; an expanded file becomes
	//      its own system of symbol planets
	//   2. lay out each system locally: hub (top rank) centered, satellites on
	//      a golden-angle spiral, intra-system links relaxed together
	//   3. lay out the supergraph of systems: system rank → radius from the
	//      galactic center, LINKED SYSTEMS pulled adjacent, discs never overlap
	//   4. isolated files ring the rim as an ordered asteroid belt
	// The browser then only animates nodes to their baked targets.

	let nodeAnim = null;
	function animateNodes(dur) {
		for (const n of dnodes) { n.ax = n.x; n.ay = n.y; }
		nodeAnim = { start: performance.now(), dur: dur || 340 };
	}
	function stepNodes() {
		if (!nodeAnim) { return; }
		const t = Math.min(1, (performance.now() - nodeAnim.start) / nodeAnim.dur);
		const e = easeInOut(t);
		for (const n of dnodes) {
			n.x = n.ax + (n.tx - n.ax) * e;
			n.y = n.ay + (n.ty - n.ay) * e;
		}
		if (t >= 1) { nodeAnim = null; }
	}

	// Members of one system placed around its local origin: phyllotaxis seed
	// (hub in the middle), then a short relaxation that pulls linked members
	// together while pairwise separation keeps clean, even spacing.
	function layoutSystem(key, members) {
		members.sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1));
		let avg = 0;
		for (const m of members) { avg += m.r * 2; }
		avg /= members.length;
		const c = avg + 16, rot = hash01(key) * Math.PI * 2;
		members.forEach((m, k) => {
			m.lx = c * Math.sqrt(k) * Math.cos(k * GOLDEN + rot);
			m.ly = c * Math.sqrt(k) * Math.sin(k * GOLDEN + rot);
		});
		if (members.length < 3) { return; }
		const mIdx = new Map(members.map((m, i) => [m.id, i]));
		const springs = [];
		for (let i = 0; i < members.length; i++) {
			for (const nb of adjacency.get(members[i].id) || []) {
				const j = mIdx.get(nb);
				if (j !== undefined && i < j) { springs.push([i, j]); }
			}
		}
		for (let it = 0; it < 110; it++) {
			for (const [i, j] of springs) {
				const a = members[i], b = members[j];
				const dx = b.lx - a.lx, dy = b.ly - a.ly;
				const d = Math.max(1, Math.hypot(dx, dy));
				const rest = a.r + b.r + 30;
				const f = ((d - rest) / d) * 0.05;
				a.lx += dx * f; a.ly += dy * f; b.lx -= dx * f; b.ly -= dy * f;
			}
			for (let i = 0; i < members.length; i++) {
				for (let j = i + 1; j < members.length; j++) {
					const a = members[i], b = members[j];
					let dx = b.lx - a.lx, dy = b.ly - a.ly;
					let d = Math.hypot(dx, dy);
					if (d < 0.5) {
						const t2 = hash01(a.id + b.id) * Math.PI * 2;
						dx = Math.cos(t2); dy = Math.sin(t2); d = 1;
					}
					const rep = Math.min(6, 500 / (d * d));
					a.lx -= (dx / d) * rep; a.ly -= (dy / d) * rep;
					b.lx += (dx / d) * rep; b.ly += (dy / d) * rep;
					const minD = a.r + b.r + 14;
					if (d < minD) {
						const push = (minD - d) / 2;
						a.lx -= (dx / d) * push; a.ly -= (dy / d) * push;
						b.lx += (dx / d) * push; b.ly += (dy / d) * push;
					}
				}
			}
			for (const m of members) { m.lx *= 0.996; m.ly *= 0.996; }
		}
	}

	function bakeLayout(prev, filePos) {
		if (!dnodes.length) { return; }
		// -- linked nodes form systems; isolated files go to the rim belt
		const linked = [], isolated = [];
		for (const n of dnodes) {
			n.isolated = !(adjacency.get(n.id) || { size: 0 }).size;
			(n.isolated ? isolated : linked).push(n);
		}
		// -- cluster by directory (expanded files are their own system);
		// oversized directories split one path segment deeper so no system
		// outgrows a readable disc
		const clusters = new Map();
		const dirKey = (n, depth) => {
			const segs = n.file.split('/');
			return segs.slice(0, Math.min(depth, segs.length - 1)).join('/') || '(root)';
		};
		const assign = (nodes, depth) => {
			const groups = new Map();
			for (const n of nodes) {
				const k = n.kind === 'symbol' ? '@' + n.file : dirKey(n, depth);
				if (!groups.has(k)) { groups.set(k, []); }
				groups.get(k).push(n);
			}
			for (const [k, members] of groups) {
				const splittable = members.some((m) => m.kind !== 'symbol' && m.file.split('/').length - 1 > depth);
				if (members.length > 22 && splittable && depth < 7) { assign(members, depth + 1); }
				else { clusters.set(k + '·' + depth, members); }
			}
		};
		assign(linked, 2);
		// -- local layout per system, then measure its disc
		const systems = [];
		for (const [key, members] of clusters) {
			layoutSystem(key, members);
			let R = 0, rank = 0;
			for (const m of members) {
				R = Math.max(R, Math.hypot(m.lx, m.ly) + m.r);
				rank += m.rank;
			}
			systems.push({ key, members, R: R + 34, rank });
		}
		// -- supergraph edges: how strongly two systems are linked
		const sysOf = new Map();
		systems.forEach((s, i) => { for (const m of s.members) { sysOf.set(m.id, i); } });
		const sysEdges = new Map();
		const addSysEdge = (ia, ib, w) => {
			const a = sysOf.get(dnodes[ia].id), b = sysOf.get(dnodes[ib].id);
			if (a === undefined || b === undefined || a === b) { return; }
			const k = a < b ? a + ':' + b : b + ':' + a;
			sysEdges.set(k, (sysEdges.get(k) || 0) + w);
		};
		for (const e of dedges) { addSysEdge(e.a, e.b, e.w); }
		for (const f of dflow) { addSysEdge(f.a, f.b, 1); }
		// -- seed systems: rank percentile → radius (dense important core,
		// sparse periphery), angle from the dominant-layer wedge so color
		// regions stay coherent
		const order = [...systems].sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : 1));
		const pct = new Map();
		order.forEach((s, i) => pct.set(s.key, order.length > 1 ? i / (order.length - 1) : 1));
		let discArea = 0;
		for (const s of systems) { discArea += s.R * s.R; }
		const RU = Math.max(420, Math.sqrt(discArea) * 2.4);
		for (const s of systems) {
			const counts = new Map();
			for (const m of s.members) { counts.set(m.layer, (counts.get(m.layer) || 0) + 1); }
			s.layer = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
		}
		const perLayer = new Map();
		for (const s of systems) { perLayer.set(s.layer, (perLayer.get(s.layer) || 0) + 1); }
		const wedges = new Map();
		let acc = 0;
		for (const l of snapshot.layers) {
			const cnt = perLayer.get(l) || 0;
			if (!cnt) { continue; }
			const w = (cnt / systems.length) * Math.PI * 2;
			wedges.set(l, { start: acc, width: w });
			acc += w;
		}
		for (const s of systems) {
			s.rT = Math.max(s.R + 10, RU * Math.pow(1 - pct.get(s.key), 1.7));
			const w = wedges.get(s.layer) || { start: 0, width: Math.PI * 2 };
			const a = w.start + w.width * (0.1 + 0.8 * hash01(s.key));
			s.x = Math.cos(a) * s.rT; s.y = Math.sin(a) * s.rT;
		}
		// -- relax the supergraph: linked systems attract, discs repel and may
		// never overlap, the rank radius acts as gentle gravity
		const ITERS = 240;
		for (let it = 0; it < ITERS; it++) {
			const cool = 1 - it / ITERS;
			for (const [k, w] of sysEdges) {
				const sp = k.split(':');
				const a = systems[+sp[0]], b = systems[+sp[1]];
				const dx = b.x - a.x, dy = b.y - a.y;
				const d = Math.max(1, Math.hypot(dx, dy));
				const rest = a.R + b.R + 130;
				const f = ((d - rest) / d) * 0.03 * Math.min(2.5, Math.log1p(w));
				a.x += dx * f; a.y += dy * f; b.x -= dx * f; b.y -= dy * f;
			}
			for (let i = 0; i < systems.length; i++) {
				for (let j = i + 1; j < systems.length; j++) {
					const a = systems[i], b = systems[j];
					let dx = b.x - a.x, dy = b.y - a.y;
					let d = Math.hypot(dx, dy);
					if (d < 0.5) {
						const t2 = hash01(a.key + b.key) * Math.PI * 2;
						dx = Math.cos(t2); dy = Math.sin(t2); d = 1;
					}
					const rep = Math.min(24, ((a.R + b.R) * 26) / d) * cool * 0.05;
					a.x -= (dx / d) * rep; a.y -= (dy / d) * rep;
					b.x += (dx / d) * rep; b.y += (dy / d) * rep;
					const minD = a.R + b.R + 56;
					if (d < minD) {
						const push = (minD - d) / 2;
						a.x -= (dx / d) * push; a.y -= (dy / d) * push;
						b.x += (dx / d) * push; b.y += (dy / d) * push;
					}
				}
			}
			for (const s of systems) {
				const d = Math.hypot(s.x, s.y) || 1;
				const f = ((s.rT - d) / d) * 0.06 * cool;
				s.x += s.x * f; s.y += s.y * f;
			}
		}
		// -- compose member targets from system positions
		for (const s of systems) {
			for (const m of s.members) { m.tx = s.x + m.lx; m.ty = s.y + m.ly; }
		}
		// -- rim belt: isolated files in ordered concentric rings outside all
		// systems, contiguous by layer, each ring stretched to wrap evenly
		let edgeR = RU * 0.7;
		for (const s of systems) { edgeR = Math.max(edgeR, Math.hypot(s.x, s.y) + s.R); }
		isolated.sort((a, b) => a.layer === b.layer
			? b.rank - a.rank
			: snapshot.layers.indexOf(a.layer) - snapshot.layers.indexOf(b.layer));
		{
			let rimR = edgeR + 120;
			let ring = [], ringArc = 0;
			const flush = () => {
				if (!ring.length) { return; }
				const stretch = (Math.PI * 2) / ringArc;
				let a = 0;
				for (const [m, step] of ring) {
					const ang = (a + step / 2) * stretch;
					m.tx = Math.cos(ang) * rimR; m.ty = Math.sin(ang) * rimR;
					a += step;
				}
				ring = []; ringArc = 0; rimR += 52;
			};
			for (const m of isolated) {
				const step = (2 * m.r + 14) / rimR;
				if (ringArc + step > Math.PI * 2) { flush(); }
				ring.push([m, step]);
				ringArc += step;
			}
			flush();
		}
		// -- animation start positions: stay where you were; new nodes bloom
		// from their file's previous spot (expand/collapse dissolves in place)
		const firstLoad = prev.size === 0;
		for (const n of dnodes) {
			const old = prev.get(n.id);
			if (firstLoad || (!old && !filePos.get(n.file))) { n.x = n.tx; n.y = n.ty; continue; }
			if (old) { n.x = old.x; n.y = old.y; continue; }
			const fp = filePos.get(n.file);
			n.x = fp.x / fp.c; n.y = fp.y / fp.c;
		}
		resolveOverlaps();
		animateNodes(firstLoad ? 1 : 340);
	}

	// Deterministic safety net over the baked TARGETS: overlap is a bug at
	// every zoom level, so sweep until no two node bodies intersect.
	function resolveOverlaps() {
		if (!dnodes.length) { return; }
		let maxR = 0;
		for (const n of dnodes) { maxR = Math.max(maxR, n.r); }
		const PAD = 6, CELL = maxR * 2 + PAD;
		for (let iter = 0; iter < 60; iter++) {
			let moved = false;
			const grid = new Map();
			for (let i = 0; i < dnodes.length; i++) {
				const n = dnodes[i];
				const key = Math.floor(n.tx / CELL) + ':' + Math.floor(n.ty / CELL);
				if (!grid.has(key)) { grid.set(key, []); }
				grid.get(key).push(i);
			}
			for (let i = 0; i < dnodes.length; i++) {
				const n = dnodes[i];
				const cx = Math.floor(n.tx / CELL), cy = Math.floor(n.ty / CELL);
				for (let gx = cx - 1; gx <= cx + 1; gx++) {
					for (let gy = cy - 1; gy <= cy + 1; gy++) {
						for (const j of grid.get(gx + ':' + gy) || []) {
							if (j <= i) { continue; }
							const m = dnodes[j];
							let dx = n.tx - m.tx, dy = n.ty - m.ty;
							let d = Math.sqrt(dx * dx + dy * dy);
							if (d < 0.5) {
								// Coincident: split deterministically by id hash.
								const a = hash01(n.id + m.id) * Math.PI * 2;
								dx = Math.cos(a); dy = Math.sin(a); d = 1;
							}
							const minD = n.r + m.r + PAD;
							if (d >= minD) { continue; }
							const push = (minD - d) / d * 0.52;
							n.tx += dx * push; n.ty += dy * push;
							m.tx -= dx * push; m.ty -= dy * push;
							moved = true;
						}
					}
				}
			}
			if (!moved) { break; }
		}
	}

	// ---- rendering ----
	const canvas = document.getElementById('canvas');
	const ctx = canvas.getContext('2d');
	let view = { x: 0, y: 0, scale: 1 };
	let dpr = window.devicePixelRatio || 1;

	function resize() {
		const wrap = document.getElementById('canvas-wrap');
		dpr = window.devicePixelRatio || 1;
		canvas.width = wrap.clientWidth * dpr;
		canvas.height = wrap.clientHeight * dpr;
		// Pin the element to CSS pixels: a canvas is a replaced element, so
		// without this it renders at its intrinsic (dpr-scaled) buffer size and
		// the whole scene sits shifted and clipped on high-dpi displays — this
		// was the "fit never looks centered" bug.
		canvas.style.width = wrap.clientWidth + 'px';
		canvas.style.height = wrap.clientHeight + 'px';
	}
	window.addEventListener('resize', resize);
	// The wrap also changes size when the detail panel opens/closes — without
	// this the drawing buffer goes stale and the graph squishes under the panel.
	new ResizeObserver(resize).observe(document.getElementById('canvas-wrap'));

	// ---- camera: every move is animated (ease-in-out ~300ms), never a teleport,
	// so the user keeps the thread of "where am I". User input cancels flights.
	let camAnim = null;
	function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
	function flyTo(x, y, scale, dur) {
		camAnim = {
			start: performance.now(), dur: dur || 320,
			fx: view.x, fy: view.y, fs: view.scale, tx: x, ty: y, ts: scale,
		};
	}
	function stopFly() { camAnim = null; }
	function stepCamera() {
		if (!camAnim) { return; }
		const t = Math.min(1, (performance.now() - camAnim.start) / camAnim.dur);
		const e = easeInOut(t);
		view.x = camAnim.fx + (camAnim.tx - camAnim.fx) * e;
		view.y = camAnim.fy + (camAnim.ty - camAnim.fy) * e;
		// Interpolate scale in log space so zooming feels constant-rate.
		view.scale = camAnim.fs * Math.pow(camAnim.ts / camAnim.fs, e);
		if (t >= 1) { camAnim = null; }
	}

	// Fit the view to a node subset (default: everything). Modes pass only the
	// nodes they light up, so switching tabs re-frames on what matters there.
	function fitView(nodes, instant) {
		const set = nodes && nodes.length ? nodes : dnodes;
		if (!set.length) { return; }
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (const n of set) {
			const x = n.tx ?? n.x, y = n.ty ?? n.y; // fit the BAKED layout, not a mid-animation frame
			minX = Math.min(minX, x - n.r); maxX = Math.max(maxX, x + n.r);
			minY = Math.min(minY, y - n.r); maxY = Math.max(maxY, y + n.r);
		}
		const w = canvas.width / dpr, h = canvas.height / dpr;
		const pad = 70;
		const sx = (w - pad * 2) / Math.max(1, maxX - minX);
		const sy = (h - pad * 2) / Math.max(1, maxY - minY);
		// Subset fits (runtime/diff overlays) never zoom past 0.85× — closer
		// than that turns the ghosted context into giant blobs.
		const cap = set.length < dnodes.length ? 0.85 : 2.2;
		const scale = Math.max(0.05, Math.min(cap, Math.min(sx, sy)));
		const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
		if (instant) { stopFly(); view.x = cx; view.y = cy; view.scale = scale; }
		else { flyTo(cx, cy, scale); }
	}

	// The nodes a mode is ABOUT: runtime → traced, diff → impacted; falls back
	// to the whole graph when the overlay is empty.
	function modeNodes() {
		if (mode === 'runtime') {
			const t = dnodes.filter((n) => n.rt);
			if (t.length) { return t; }
		}
		if (mode === 'diff') {
			const t = dnodes.filter((n) => impactedFiles.has(n.file));
			if (t.length) { return t; }
		}
		return dnodes;
	}

	// Focus one node: center it and zoom so its whole neighborhood is readable —
	// scale derives from the neighborhood extent, clamped to a comfortable band
	// (this is what stops the tour from over-zooming past legibility).
	function focusNode(n) {
		if (!n) { return; }
		const nx = n.tx ?? n.x, ny = n.ty ?? n.y;
		const hood = [n, ...[...(adjacency.get(n.id) || [])].map((id) => byId.get(id)).filter(Boolean)];
		let span = 140;
		for (const m of hood) {
			span = Math.max(span, Math.abs((m.tx ?? m.x) - nx) * 2 + m.r * 2, Math.abs((m.ty ?? m.y) - ny) * 2 + m.r * 2);
		}
		const w = canvas.width / dpr, h = canvas.height / dpr;
		const scale = Math.max(0.55, Math.min(1.7, (Math.min(w, h) * 0.72) / span));
		flyTo(nx, ny, scale);
		select(n.id);
	}

	function worldToScreen(x, y) {
		return [
			(x - view.x) * view.scale + canvas.width / (2 * dpr),
			(y - view.y) * view.scale + canvas.height / (2 * dpr),
		];
	}
	function screenToWorld(sx, sy) {
		return [
			(sx - canvas.width / (2 * dpr)) / view.scale + view.x,
			(sy - canvas.height / (2 * dpr)) / view.scale + view.y,
		];
	}

	function cssVar(name) {
		return getComputedStyle(document.body).getPropertyValue(name).trim();
	}

	// Greedy screen-space label placement: rank order, skip on overlap.
	function placeLabels(candidates, muted, ink) {
		const placed = []; // {x, y, w, h}
		ctx.font = '10px ui-monospace, monospace';
		candidates.sort((a, b) => b.priority - a.priority);
		const budget = 40;
		let used = 0;
		for (const c of candidates) {
			if (used >= budget) { break; }
			const w = ctx.measureText(c.text).width + 4;
			const h = 12;
			const lx = c.x + c.r + 5, ly = c.y - h / 2;
			let collides = lx + w > canvas.width / dpr || ly < 0;
			if (!collides) {
				for (const p of placed) {
					if (lx < p.x + p.w && lx + w > p.x && ly < p.y + p.h && ly + h > p.y) { collides = true; break; }
				}
			}
			if (collides) { continue; }
			placed.push({ x: lx, y: ly, w, h });
			ctx.globalAlpha = c.alpha;
			// Halo behind the text so it stays readable over edges.
			ctx.fillStyle = cssVar('--bg');
			ctx.fillRect(lx - 2, ly, w, h);
			ctx.fillStyle = c.emphasis ? ink : muted;
			ctx.fillText(c.text, lx, c.y + 3);
			used += 1;
		}
		ctx.globalAlpha = 1;
	}

	function nodeAlpha(n) {
		// Selection isolates: the node, its neighbors, everything else recedes.
		if (selected) {
			return (n.id === selected || neighborIds.has(n.id)) ? 1 : 0.07;
		}
		let alpha = 1;
		if (mode === 'runtime') { alpha = n.rt ? 1 : 0.18; }
		if (mode === 'diff') { alpha = impactedFiles.has(n.file) ? 1 : 0.12; }
		if (highlightFiles.size) {
			alpha = (highlightFiles.has(n.file) || (n.row !== undefined && highlightRows.has(n.row))) ? 1 : 0.12;
		}
		return alpha;
	}

	function draw() {
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
		if (!snapshot) { return; }
		const ink = cssVar('--ink'), line = cssVar('--line-strong'), muted = cssVar('--muted');
		const accent = accentFg();

		// Edges: when a node is selected only ITS edges render at full strength.
		ctx.lineWidth = 0.6;
		for (const e of dedges) {
			const a = dnodes[e.a], b = dnodes[e.b];
			const touchesSelection = selected && (a.id === selected || b.id === selected);
			if (selected && !touchesSelection) { continue; }
			const [ax, ay] = worldToScreen(a.x, a.y);
			const [bx, by] = worldToScreen(b.x, b.y);
			ctx.strokeStyle = touchesSelection ? accent : line;
			ctx.globalAlpha = touchesSelection ? 0.8 : Math.min(0.4, 0.08 + e.w * 0.03);
			ctx.lineWidth = touchesSelection ? 1.2 : 0.6;
			ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
		}
		ctx.globalAlpha = 1;

		// Observed call flow: directed arrows in Runtime mode (always for the
		// selection). Solid = flow the static graph also predicted; the brighter
		// dashed arrows are runtime-only discoveries (dynamic dispatch, framework
		// routing) — the edges only tracing can add to the picture.
		if (mode === 'runtime' || selected) {
			for (const f of dflow) {
				const a = dnodes[f.a], b = dnodes[f.b];
				const touchesSelection = selected && (a.id === selected || b.id === selected);
				if (mode !== 'runtime' && !touchesSelection) { continue; }
				if (selected && !touchesSelection) { continue; }
				const [ax, ay] = worldToScreen(a.x, a.y);
				const [bx, by] = worldToScreen(b.x, b.y);
				const dx = bx - ax, dy = by - ay;
				const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
				const rB = Math.max(2.5, b.r * view.scale) + 4;
				const ex = bx - (dx / d) * rB, ey = by - (dy / d) * rB;
				// Red only for a call path that failed in its LATEST run — a
				// fixed path returns to ink instead of staying red on history.
				const flowLive = (f.current_errors ?? f.errors) > 0;
				ctx.strokeStyle = flowLive ? accent : ink;
				ctx.globalAlpha = touchesSelection ? 0.9 : Math.min(0.75, 0.35 + Math.log1p(f.calls) * 0.12);
				ctx.lineWidth = touchesSelection ? 1.6 : 1.1;
				if (f.only) { ctx.setLineDash([5, 3]); }
				ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke();
				ctx.setLineDash([]);
				// Arrowhead at the callee end.
				const ang = Math.atan2(dy, dx), ah = 6;
				ctx.beginPath();
				ctx.moveTo(ex, ey);
				ctx.lineTo(ex - ah * Math.cos(ang - 0.45), ey - ah * Math.sin(ang - 0.45));
				ctx.moveTo(ex, ey);
				ctx.lineTo(ex - ah * Math.cos(ang + 0.45), ey - ah * Math.sin(ang + 0.45));
				ctx.stroke();
			}
			ctx.globalAlpha = 1;
		}

		const labelCandidates = [];
		// Two passes: the selection group paints LAST so the selected node and
		// its neighbors are always in the visual foreground — a dimmed node can
		// never cover a highlighted one.
		const inGroup = (n) => selected && (n.id === selected || neighborIds.has(n.id));
		const drawOrder = selected
			? [...dnodes.filter((n) => !inGroup(n)), ...dnodes.filter(inGroup)]
			: dnodes;
		for (const n of drawOrder) {
			const [x, y] = worldToScreen(n.x, n.y);
			const r = Math.max(2.5, n.r * view.scale);
			if (x < -40 || y < -40 || x > canvas.width / dpr + 40 || y > canvas.height / dpr + 40) { continue; }
			const alpha = nodeAlpha(n);
			if (alpha <= 0.001) { continue; }
			// Never-ran nodes in Runtime mode render as full-strength OUTLINES,
			// not alpha-faded fills: an 18% fill composites to ~1.2:1 against
			// either background (invisible on black), while a hollow disc at the
			// layer color keeps every layer ≥3:1 on both themes and still reads
			// as "did not run" next to the filled + ringed executed nodes.
			// Selection isolation and search dimming still apply through alpha.
			const hollow = mode === 'runtime' && !n.rt;
			ctx.globalAlpha = hollow && !selected && !highlightFiles.size ? 1 : alpha;
			ctx.fillStyle = LAYER_COLORS[n.layer] || LAYER_COLORS.other;
			ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
			if (hollow) {
				ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.2; ctx.stroke();
			} else {
				ctx.fill();
			}
			if (n.kind === 'symbol') {
				ctx.strokeStyle = ink; ctx.lineWidth = 0.8;
				ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
			}
			if (mode === 'runtime' && n.rt && alpha > 0.5) {
				const live = (n.rt.current_errors ?? n.rt.errors) > 0;
				ctx.strokeStyle = live ? accent : ink;
				ctx.lineWidth = live ? 2.2 : 1.2;
				ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.stroke();
			}
			if (mode === 'diff' && changedFiles.has(n.file) && alpha > 0.5) {
				ctx.strokeStyle = accent; ctx.lineWidth = 2;
				ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.stroke();
			} else if (mode === 'diff' && impactedFiles.has(n.file) && alpha > 0.5) {
				ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
				ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.stroke();
				ctx.setLineDash([]);
			}
			if (n.id === selected) {
				ctx.strokeStyle = accent; ctx.lineWidth = 2;
				ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.stroke();
			}
			if (n.id === hoverId && n.id !== selected) {
				ctx.strokeStyle = ink; ctx.lineWidth = 1.4;
				ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
			}
			ctx.globalAlpha = 1;

			// Label candidates: selection group always; otherwise big or hovered
			// or search-lit nodes, budgeted and deduplicated by placeLabels.
			const inSelectionGroup = selected && (n.id === selected || neighborIds.has(n.id));
			const lit = highlightFiles.size > 0 && alpha === 1;
			const big = r > 8 || view.scale > 1.5;
			if (inSelectionGroup || lit || n.id === hoverId || (!selected && big && alpha > 0.5)) {
				labelCandidates.push({
					x, y, r, text: n.label, alpha: Math.min(1, alpha + 0.15),
					emphasis: inSelectionGroup || n.id === hoverId,
					priority: (inSelectionGroup ? 1000 : 0) + (n.id === hoverId ? 500 : 0) + (lit ? 250 : 0) + n.rank * 100 + r,
				});
			}
		}
		placeLabels(labelCandidates, muted, ink);
	}

	function loop() { stepCamera(); stepNodes(); draw(); requestAnimationFrame(loop); }

	// ---- interactions ----
	let dragNode = null, panning = false, lastMouse = null, moved = false;
	canvas.addEventListener('mousedown', (ev) => {
		stopFly();
		moved = false;
		lastMouse = [ev.offsetX, ev.offsetY];
		const [wx, wy] = screenToWorld(ev.offsetX, ev.offsetY);
		dragNode = pick(wx, wy);
		panning = !dragNode;
		canvas.classList.add('dragging');
	});
	window.addEventListener('mousemove', (ev) => {
		const rect = canvas.getBoundingClientRect();
		const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
		if (!lastMouse) {
			if (mx >= 0 && my >= 0 && mx <= rect.width && my <= rect.height) {
				const [wx, wy] = screenToWorld(mx, my);
				const hit = pick(wx, wy);
				hoverId = hit ? hit.id : null;
				canvas.style.cursor = hit ? 'pointer' : 'grab';
			}
			return;
		}
		const dx = mx - lastMouse[0], dy = my - lastMouse[1];
		if (Math.abs(dx) + Math.abs(dy) > 2) { moved = true; }
		if (dragNode) {
			dragNode.x += dx / view.scale; dragNode.y += dy / view.scale;
			// Dragging repositions just this node; sync its baked target so a
			// later layout animation doesn't yank it back.
			dragNode.tx = dragNode.x; dragNode.ty = dragNode.y;
		} else if (panning) {
			view.x -= dx / view.scale; view.y -= dy / view.scale;
		}
		lastMouse = [mx, my];
	});
	window.addEventListener('mouseup', (ev) => {
		canvas.classList.remove('dragging');
		if (!moved && lastMouse) {
			const rect = canvas.getBoundingClientRect();
			const [wx, wy] = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
			const hit = pick(wx, wy);
			if (hit) { select(hit.id); } else { select(null); }
		}
		dragNode = null; panning = false; lastMouse = null;
	});
	canvas.addEventListener('dblclick', (ev) => {
		const [wx, wy] = screenToWorld(ev.offsetX, ev.offsetY);
		const hit = pick(wx, wy);
		if (!hit) { return; }
		if (hit.kind === 'file') { expandFile(hit.file); }
		else { expanded.delete(hit.file); buildDisplayGraph(); }
	});
	canvas.addEventListener('wheel', (ev) => {
		ev.preventDefault();
		stopFly();
		const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
		const [wx, wy] = screenToWorld(ev.offsetX, ev.offsetY);
		view.scale = Math.max(0.08, Math.min(6, view.scale * factor));
		const [nx, ny] = screenToWorld(ev.offsetX, ev.offsetY);
		view.x += wx - nx; view.y += wy - ny;
	}, { passive: false });

	function pick(wx, wy) {
		// Hit-testing happens in SCREEN pixels, not world units: zoomed out, a
		// node's world radius shrinks below a pixel and clicks would need to be
		// pixel-perfect. A floor of 10 screen px keeps every node clickable at
		// any zoom (this was the "clicking does nothing" bug at fitted views).
		let best = null, bestD = Infinity;
		for (const n of dnodes) {
			if (nodeAlpha(n) <= 0.001) { continue; }  // filtered out — not clickable
			const dx = (n.x - wx) * view.scale, dy = (n.y - wy) * view.scale;
			const d = Math.sqrt(dx * dx + dy * dy);
			const hitR = Math.max(10, n.r * view.scale) + 2;
			if (d < hitR && d < bestD) { best = n; bestD = d; }
		}
		return best;
	}

	// Expanding a file selects its top symbol so the change is visible.
	function expandFile(file) {
		expanded.add(file);
		buildDisplayGraph();
		const g = snapshot.files.find((f) => f.file === file);
		if (g && g.rows.length) {
			const top = [...g.rows].sort((a, b) => snapshot.nodes[b].rank - snapshot.nodes[a].rank)[0];
			focusNodeByRow(top);
		}
	}

	function focusNodeByRow(row) {
		const s = snapshot.nodes[row];
		focusNode(byId.get('sym:' + row) || byId.get('file:' + s.file));
	}

	// ---- detail panel ----
	function esc(t) {
		return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
	function rtLabel(rt) {
		if (!rt) { return ''; }
		let t = '×' + rt.calls + ' · ' + Math.round(rt.ms ?? rt.total_ms ?? 0) + 'ms';
		// current_errors is the DEFECT count (contained raises and 4xx rejections
		// already removed); errors is the raw lifetime tally. The warning triangle
		// is a defect signal, so it has to read the former — keying it off the raw
		// count put a ⚠ on every symbol that ever raised inside a try/except.
		const defects = rt.current_errors ?? rt.errors;
		if (defects > 0) { t += ' · ⚠' + defects; }
		return t;
	}

	// The links section, split by DIRECTION: what this node calls, what calls
	// it (statically), and the observed runtime flow through it. Every row
	// jumps to that node so callers/callees are one click away.
	function linksHtml(id) {
		const me = byId.get(id);
		if (!me) { return ''; }
		const idx = dnodes.indexOf(me);
		const calls = new Map(), calledBy = new Map(); // id -> {node, note}
		const put = (map, node, note) => {
			if (node && node.id !== id && !map.has(node.id)) { map.set(node.id, { node, note }); }
		};
		// Static direction comes from the underlying row-level edges.
		const rowsOfMe = new Set(
			me.kind === 'symbol' ? [me.row]
				: (snapshot.files.find((f) => f.file === me.file) || { rows: [] }).rows,
		);
		const rowTargetId = (row) => {
			const s = snapshot.nodes[row];
			return expanded.has(s.file) ? 'sym:' + row : 'file:' + s.file;
		};
		for (const e of snapshot.edges) {
			if (e.kind === 'contains') { continue; }
			if (rowsOfMe.has(e.src)) { put(calls, byId.get(rowTargetId(e.dst)), e.kind); }
			if (rowsOfMe.has(e.dst)) { put(calledBy, byId.get(rowTargetId(e.src)), e.kind); }
		}
		// Observed runtime flow (directed, with call counts).
		for (const f of dflow) {
			if (f.a === idx) { put(calls, dnodes[f.b], '×' + f.calls + ' observed'); }
			if (f.b === idx) { put(calledBy, dnodes[f.a], '×' + f.calls + ' observed'); }
		}
		const section = (title, map, arrow) => {
			if (!map.size) { return ''; }
			const entries = [...map.values()].sort((a, b) => b.node.rank - a.node.rank);
			let h = '<div class="section"><span class="v-label">' + title + ' · ' + entries.length + '</span><div>';
			for (const { node: m, note } of entries.slice(0, 30)) {
				h += '<div class="link-row" data-goto="' + esc(m.id) + '" title="jump to ' + esc(m.label) + '">' +
					'<span class="nm">' + arrow + ' ' + esc(m.kind === 'file' ? m.file : m.label) + '</span>' +
					'<span class="dir">' + esc(note) + '</span></div>';
			}
			return h + '</div></div>';
		};
		let html = section('calls', calls, '→') + section('called by', calledBy, '←');
		if (!html) {
			html = '<div class="section"><span class="v-label">linked · 0</span>' +
				'<div class="sub">no static or observed links — run a service under tracing to discover runtime flow</div></div>';
		}
		return html;
	}

	// The detail panel can be hidden without losing the selection: × collapses
	// it, the edge tab brings it back, and picking a new node reopens it.
	let panelCollapsed = false;
	function updatePanelChrome() {
		const aside = document.getElementById('detail');
		const toggle = document.getElementById('panel-toggle');
		aside.classList.toggle('open', !!selected && !panelCollapsed);
		toggle.style.display = selected ? 'block' : 'none';
		toggle.textContent = panelCollapsed ? '◂ show details' : 'hide details ▸';
	}
	document.getElementById('panel-toggle').addEventListener('click', () => {
		panelCollapsed = !panelCollapsed;
		updatePanelChrome();
	});
	window.addEventListener('keydown', (ev) => {
		if (ev.key === 'Escape' && ev.target !== searchEl && selected) { select(null); }
	});

	function select(id) {
		if (id && id !== selected) { panelCollapsed = false; }
		selected = id;
		neighborIds = id ? (adjacency.get(id) || new Set()) : new Set();
		const aside = document.getElementById('detail');
		if (!id) { aside.innerHTML = ''; updatePanelChrome(); return; }
		const n = byId.get(id);
		if (!n) { return; }
		updatePanelChrome();
		const closeBtn = '<button class="aside-close" data-close title="Hide this panel — the selection stays">×</button>';
		let html = '';
		if (n.kind === 'file') {
			const g = snapshot.files.find((f) => f.file === n.file);
			html += '<div class="aside-head"><span class="v-label">file · ' + esc(n.layer) + '</span>' + closeBtn + '</div>';
			html += '<h2>' + esc(n.file) + '</h2>';
			html += '<div class="sub">' + g.symbols + ' symbols · rank ' + g.rank.toFixed(3) +
				(g.changed ? ' · <span style="color:var(--accent-fg)">changed this epoch</span>' : '') + '</div>';
			// A raise a caller caught leaves current_errors at 0 with a lifetime
			// error still on the books, which lands it in "resolved" — where it
			// would be labelled "not reproduced in latest run" about an exception
			// that reproduces on EVERY run and is deliberately handled. It is
			// neither a defect nor a fix, so it gets its own line and its own
			// (neutral) color rather than borrowing either verdict.
			const containedOf = (r) => (r.failures || [])[0];
			const isContained = (r) => (r.errors || 0) > 0 && containedOf(r)?.contained === true;
			if (n.rt) {
				// Live error badge reflects the latest run; lifetime history is
				// noted separately so a fixed file is not flagged red. A file whose
				// only lifetime errors were CAUGHT gets neither badge: "none in
				// latest run" would be false (it raised, and was handled) and the
				// success color would credit a fix that never happened. The
				// per-symbol "handled:" line below says what actually happened.
				const liveErr = n.rt.current_errors ?? n.rt.errors;
				const historyIsAllHandled = g.rows.every(
					(row) => !((snapshot.runtime[row] || {}).errors > 0) || isContained(snapshot.runtime[row] || {}),
				);
				const errBadge = liveErr
					? ' · <span style="color:var(--accent-fg)">⚠' + liveErr + ' errors (latest run)</span>'
					: (n.rt.errors && !historyIsAllHandled
							? ' · <span style="color:' + cssVar('--ok-fg') + '">' + n.rt.errors + ' errors in history, none in latest run</span>'
							: '');
				html += '<div class="sub">runtime: ' + n.rt.executed + ' symbols executed · ×' + n.rt.calls +
					' · ' + Math.round(n.rt.ms) + 'ms' + errBadge + '</div>';
			}
			// The red ring means observed errors — the panel must let the user
			// act on them, not just admire the color: name the failing symbols
			// and offer the same one-click fix episode symbols get.
			const errRows = g.rows.filter((row) => {
				const r = snapshot.runtime[row] || {};
				return (r.current_errors ?? r.errors) > 0;
			});
			const settledRows = g.rows.filter((row) => {
				const r = snapshot.runtime[row] || {};
				return (r.current_errors ?? r.errors) === 0 && (r.errors || 0) > 0;
			});
			const handledRows = settledRows.filter((row) => isContained(snapshot.runtime[row] || {}));
			const resolvedRows = settledRows.filter((row) => !isContained(snapshot.runtime[row] || {}));
			if (errRows.length) {
				html += '<div class="sub" style="color:var(--accent-fg)">failing: ' +
					errRows.map((row) => {
						const s = snapshot.nodes[row];
						const rt = snapshot.runtime[row];
						// The observed failure identity, not just the class name.
						const f = (rt.failures || [])[0];
						const detail = f && f.error_message
							? f.error_type + ': ' + f.error_message
							: (rt.error_types || []).join(', ');
						return esc(s.name) + ' (' + esc(detail) + ')';
					}).join(' · ') + '</div>';
			}
			if (handledRows.length) {
				html += '<div class="sub">handled: ' +
					handledRows.map((row) => {
						const s = snapshot.nodes[row];
						const f = containedOf(snapshot.runtime[row]);
						const by = f.contained_by ? 'caught by ' + f.contained_by : 'caught by a caller';
						return esc(s.name) + ' (' + esc(f.error_type) + ' — ' + esc(by) + ')';
					}).join(' · ') + '</div>';
			}
			if (resolvedRows.length) {
				html += '<div class="sub" style="color:' + cssVar('--ok-fg') + '">resolved: ' +
					resolvedRows.map((row) => {
						const s = snapshot.nodes[row];
						const rt = snapshot.runtime[row];
						const f = (rt.failures || [])[0];
						const what = f ? f.error_type : (rt.error_types || []).join(', ');
						const why = f && f.superseded === 'code_changed'
							? 'code changed, unverified' : 'not reproduced in latest run';
						return esc(s.name) + ' (' + esc(what) + ' — ' + esc(why) + ')';
					}).join(' · ') + '</div>';
			}
			html += '<div class="actions">' +
				'<button class="v-btn primary" data-act="expand" title="Replace this file node with one node per symbol">Expand Symbols</button>' +
				'<button class="v-btn" data-act="open" data-file="' + esc(n.file) + '" data-line="1" title="Open this file in the editor">Open File in Editor</button>' +
				'<button class="v-btn" data-act="ask-file" title="Ask a question with this file preloaded as context">Ask Vinv About This File</button>' +
				(errRows.length ? '<button class="v-btn" data-act="harness" data-row="' + errRows[0] + '" title="Dispatch a fix episode to the coding agent with the observed errors as evidence">Fix with Coding Agent</button>' : '') +
				(n.rt ? '<button class="v-btn" data-act="trace" title="Open the runtime call tree and latency flamegraph">Trace &amp; Flamegraph</button>' : '') +
				'</div>';
			html += '<div class="section"><span class="v-label">symbols</span><div>';
			const rows = [...g.rows].sort((a, b) => snapshot.nodes[b].rank - snapshot.nodes[a].rank);
			for (const row of rows.slice(0, 80)) {
				const s = snapshot.nodes[row];
				const rt = snapshot.runtime[row];
				const isNew = snapshot.store_epoch > 0 && s.epoch === snapshot.store_epoch;
				html += '<div class="sym" data-act="open" data-file="' + esc(s.file) + '" data-line="' + s.start_line + '" title="jump to ' + esc(s.file) + ':' + s.start_line + '">' +
					'<span class="nm">' + esc(s.name) + (isNew ? ' <span style="color:var(--accent-fg)">●</span>' : '') + '</span>' +
					'<span class="rt' + (rt && (rt.current_errors ?? rt.errors) > 0 ? ' err' : '') + '">' + (rt ? rtLabel(rt) : '') + '</span></div>';
			}
			html += '</div></div>';
			// Diff context: say WHAT changed here this epoch, not just that it did.
			if (snapshot.store_epoch > 0) {
				const changedRows = g.rows.filter((row) => snapshot.nodes[row].epoch === snapshot.store_epoch);
				if (changedRows.length) {
					html += '<div class="section"><span class="v-label">changed in epoch ' + snapshot.store_epoch + ' · ' + changedRows.length + '</span><div>';
					for (const row of changedRows.slice(0, 20)) {
						const s = snapshot.nodes[row];
						html += '<div class="sym" data-act="open" data-file="' + esc(s.file) + '" data-line="' + s.start_line + '" title="jump to ' + esc(s.file) + ':' + s.start_line + '">' +
							'<span class="nm">' + esc(s.name) + '</span><span class="rt">reindexed</span></div>';
					}
					html += '</div></div>';
				}
			}
			html += linksHtml(id);
		} else {
			const s = snapshot.nodes[n.row];
			const rt = snapshot.runtime[n.row];
			html += '<div class="aside-head"><span class="v-label">' + esc(s.kind) + ' · ' + esc(s.layer) + '</span>' + closeBtn + '</div>';
			html += '<h2>' + esc(s.name) + '</h2>';
			html += '<div class="sub">' + esc(s.file) + ':' + s.start_line + ' · rank ' + s.rank.toFixed(3) + ' · epoch ' + s.epoch + '</div>';
			html += '<div class="summary">' + esc(s.summary) + '</div>';
			if (rt) {
				html += '<div class="sub">runtime: ' + rtLabel(rt) +
					(rt.error_types && rt.error_types.length ? ' [' + esc(rt.error_types.join(', ')) + ']' : '') + '</div>';
				// Without this, a symbol that raises by design shows a bare error
				// type and nothing to say a caller absorbed it — the reader is left
				// to assume a defect the rest of the panel has already dismissed.
				const cf = (rt.failures || [])[0];
				if (cf && cf.contained === true) {
					html += '<div class="sub">' + esc(cf.error_type) + ' is caught by ' +
						esc(cf.contained_by || 'a caller') + ' — control flow, not a failure</div>';
				}
			} else {
				html += '<div class="sub">runtime: never executed in captured traces</div>';
			}
			html += '<div class="actions">' +
				'<button class="v-btn primary" data-act="open" data-file="' + esc(s.file) + '" data-line="' + s.start_line + '" title="Jump to ' + esc(s.file) + ':' + s.start_line + '">Open in Editor</button>' +
				'<button class="v-btn" data-act="ask" data-row="' + n.row + '" title="Ask a question with this symbol preloaded as context">Ask Vinv About This</button>' +
				'<button class="v-btn" data-act="harness" data-row="' + n.row + '" title="Dispatch a fix episode to the coding agent with this symbol as evidence">Fix with Coding Agent</button>' +
				(rt ? '<button class="v-btn" data-act="trace" title="Open the runtime call tree and latency flamegraph">Trace &amp; Flamegraph</button>' : '') +
				'<button class="v-btn" data-act="collapse" title="Fold the symbols back into a single file node">Collapse to File</button>' +
				'</div>';
			html += linksHtml(id);
		}
		aside.innerHTML = html;
		const closeEl = aside.querySelector('[data-close]');
		if (closeEl) {
			closeEl.addEventListener('click', () => { panelCollapsed = true; updatePanelChrome(); });
		}
		aside.querySelectorAll('[data-goto]').forEach((el) => {
			el.addEventListener('click', () => {
				focusNode(byId.get(el.getAttribute('data-goto')));
			});
		});
		aside.querySelectorAll('[data-act]').forEach((el) => {
			el.addEventListener('click', (ev) => {
				ev.stopPropagation();
				const act = el.getAttribute('data-act');
				if (act === 'open') {
					vscode.postMessage({ type: 'openSource', file: el.getAttribute('data-file'), line: Number(el.getAttribute('data-line')) });
				} else if (act === 'expand') {
					expandFile(n.file);
				} else if (act === 'collapse') {
					expanded.delete(n.file); buildDisplayGraph(); select('file:' + n.file);
				} else if (act === 'ask') {
					vscode.postMessage({ type: 'ask', row: Number(el.getAttribute('data-row')) });
				} else if (act === 'ask-file') {
					const g2 = snapshot.files.find((f) => f.file === n.file);
					const row = g2 && g2.rows.length ? g2.rows[0] : undefined;
					vscode.postMessage({ type: 'ask', row });
				} else if (act === 'trace') {
					// Send the clicked node so the host can infer which endpoint(s)
					// reach it — a symbol node carries its row, a file node its path.
					vscode.postMessage({ type: 'trace', row: n.row, file: n.file });
				} else if (act === 'harness') {
					const row = Number(el.getAttribute('data-row'));
					const s2 = snapshot.nodes[row];
					const rt2 = snapshot.runtime[row];
					// Dispatch on the CURRENT failure (latest run) with its real
					// message — never a since-fixed error from history.
					const live2 = rt2 ? (rt2.current_errors ?? rt2.errors) : 0;
					const f2 = rt2 && (rt2.failures || []).find((f) => f.superseded === null);
					const issue = live2 > 0
						? s2.name + ' at ' + s2.file + ':' + s2.start_line + ' raised ' +
							(f2 ? f2.error_type + ': ' + (f2.error_message || '') : live2 + ' runtime error(s): ' + (rt2.error_types || []).join(', '))
						: '';
					vscode.postMessage({ type: 'harness', row, issue });
				}
			});
		});
	}

	// ---- modes ----
	// Every mode states what it is showing (or why it is empty) in the status
	// chip, so a dimmed or unchanged canvas is never a mystery.
	function modeStatus() {
		if (!snapshot) { return ''; }
		if (mode === 'runtime') {
			const traced = Object.keys(snapshot.runtime).length;
			if (!traced) {
				return 'no trace yet — run a service (Services panel ▶) to light this up';
			}
			const flows = (snapshot.flow_edges || []).length;
			const discovered = (snapshot.flow_edges || []).filter((f) => f.observed_only).length;
			return traced + ' symbols traced · ' + flows + ' observed call edges (' +
				discovered + ' runtime-only, dashed) — arrows show caller → callee';
		}
		if (mode === 'diff') {
			if (snapshot.store_epoch <= 0) { return 'no epochs yet — reindex after a change'; }
			return changedFiles.size
				? changedFiles.size + ' files changed this epoch (solid ring) → ' +
					Math.max(0, impactedFiles.size - changedFiles.size) + ' impacted downstream (dashed) · click any node to inspect'
				: 'nothing changed in epoch ' + snapshot.store_epoch;
		}
		return '';
	}
	function setMode(m) {
		mode = m;
		for (const id of ['explore', 'runtime', 'diff', 'tour']) {
			document.getElementById('m-' + id).classList.toggle('active', id === m);
		}
		document.getElementById('tourbox').style.display = m === 'tour' ? 'block' : 'none';
		// A mode switch is a change of QUESTION: drop the previous selection so
		// stale isolation can't mask the overlay, then fly the camera to frame
		// exactly the nodes this mode lights up.
		select(null);
		if (m === 'diff') { computeImpact(); }
		if (m === 'tour') { tourIndex = 0; showTourStep(); }
		else { fitView(modeNodes()); }
		setStatus(modeStatus());
	}
	['explore', 'runtime', 'diff', 'tour'].forEach((m) => {
		document.getElementById('m-' + m).addEventListener('click', () => setMode(m));
	});
	// ---- guided tour ----
	function showTourStep() {
		const tour = snapshot ? snapshot.tour : [];
		const stepEl = document.getElementById('t-step');
		if (!tour.length) {
			document.getElementById('t-name').textContent = 'No tour available';
			document.getElementById('t-summary').textContent = 'Index the project to generate a dependency-ordered tour.';
			stepEl.textContent = '0 / 0';
			return;
		}
		tourIndex = Math.max(0, Math.min(tour.length - 1, tourIndex));
		// The index clamps, so Prev at step 1 and Next at the last step were live
		// buttons that did nothing — a click with no feedback reads as broken.
		document.getElementById('t-prev').disabled = tourIndex === 0;
		document.getElementById('t-next').disabled = tourIndex === tour.length - 1;
		const stop = tour[tourIndex];
		const s = snapshot.nodes[stop.row];
		document.getElementById('t-name').textContent = s.name + ' — ' + s.file + ':' + s.start_line;
		document.getElementById('t-summary').textContent = s.summary || '(no summary)';
		stepEl.textContent = (tourIndex + 1) + ' / ' + tour.length + ' · ' + stop.reason;
		focusNodeByRow(stop.row);
	}
	document.getElementById('t-prev').addEventListener('click', () => { tourIndex -= 1; showTourStep(); });
	document.getElementById('t-next').addEventListener('click', () => { tourIndex += 1; showTourStep(); });
	document.getElementById('t-open').addEventListener('click', () => {
		const stop = snapshot && snapshot.tour[tourIndex];
		if (stop) {
			const s = snapshot.nodes[stop.row];
			vscode.postMessage({ type: 'openSource', file: s.file, line: s.start_line });
		}
	});

	// ---- search ----
	const searchEl = document.getElementById('search');
	function localSearch(q) {
		highlightRows = new Set(); highlightFiles = new Set();
		if (!q || !snapshot) { return; }
		const needle = q.toLowerCase();
		for (const n of snapshot.nodes) {
			if (n.name.toLowerCase().includes(needle) || n.file.toLowerCase().includes(needle)) {
				highlightRows.add(n.row); highlightFiles.add(n.file);
			}
		}
	}
	searchEl.addEventListener('input', () => { localSearch(searchEl.value.trim()); });
	searchEl.addEventListener('keydown', (ev) => {
		if (ev.key === 'Enter' && searchEl.value.trim()) {
			setStatus('semantic search…');
			vscode.postMessage({ type: 'semanticSearch', query: searchEl.value.trim() });
		}
		if (ev.key === 'Escape') { searchEl.value = ''; localSearch(''); }
	});

	function setStatus(text) {
		const el = document.getElementById('status');
		el.textContent = text || '';
		el.style.display = text ? 'block' : 'none';
	}

	document.getElementById('btn-refresh').addEventListener('click', () => {
		setStatus('rebuilding…');
		vscode.postMessage({ type: 'refresh' });
	});
	document.getElementById('btn-trajectory').addEventListener('click', () => {
		vscode.postMessage({ type: 'trajectory' });
	});
	// ---- theme toggle: auto (follow editor) → light → dark ----
	// The canvas re-reads CSS variables every frame, so switching the class is
	// all it takes. The choice persists via webview state (survives reloads)
	// with localStorage as fallback outside VS Code.
	let themeMode = 'auto';
	try {
		themeMode = ((vscode.getState && vscode.getState()) || {}).theme
			|| localStorage.getItem('vinv-theme') || 'auto';
	} catch (e) { themeMode = 'auto'; }
	function applyTheme() {
		document.body.classList.toggle('vinv-light', themeMode === 'light');
		document.body.classList.toggle('vinv-dark', themeMode === 'dark');
		document.getElementById('btn-theme').textContent =
			'Theme: ' + themeMode.charAt(0).toUpperCase() + themeMode.slice(1);
	}
	document.getElementById('btn-theme').addEventListener('click', () => {
		themeMode = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto';
		try {
			if (vscode.setState) {
				vscode.setState({ ...((vscode.getState && vscode.getState()) || {}), theme: themeMode });
			}
		} catch (e) { /* state API unavailable outside VS Code */ }
		try { localStorage.setItem('vinv-theme', themeMode); } catch (e) { /* ditto */ }
		applyTheme();
	});
	applyTheme();

	document.getElementById('btn-fit').addEventListener('click', () => {
		select(null);
		fitView(modeNodes());
	});
	// Header Ask: opens the QnA panel scoped to the selection when there is one.
	document.getElementById('btn-ask').addEventListener('click', () => {
		const n = selected ? byId.get(selected) : null;
		const row = n ? (n.kind === 'symbol' ? n.row
			: (snapshot.files.find((f) => f.file === n.file) || { rows: [] }).rows[0]) : undefined;
		vscode.postMessage({ type: 'ask', row });
	});

	// ---- legend: layer chips double as visibility filters ----
	function renderLegend() {
		const el = document.getElementById('legend');
		el.innerHTML = '<span class="v-label">layers · click to toggle</span>' + snapshot.layers.map((l) =>
			'<div class="row' + (hiddenLayers.has(l) ? ' off' : '') + '" data-layer="' + l + '">' +
			'<span class="dot" style="background:' + (LAYER_COLORS[l] || 'var(--muted-2)') + '"></span>' + l + '</div>'
		).join('') + '<div class="hint">double-click a file to expand symbols</div>';
		el.querySelectorAll('[data-layer]').forEach((row) => {
			row.addEventListener('click', () => {
				const layer = row.getAttribute('data-layer');
				if (hiddenLayers.has(layer)) { hiddenLayers.delete(layer); } else { hiddenLayers.add(layer); }
				renderLegend();
				buildDisplayGraph();
				fitView(modeNodes());
			});
		});
	}

	// ---- inbound messages ----
	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'snapshot') {
			const first = !snapshot;
			snapshot = msg.snapshot;
			const rtCount = Object.keys(snapshot.runtime).length;
			document.getElementById('meta').textContent =
				snapshot.node_count + ' symbols · ' + snapshot.edge_count + ' edges · epoch ' +
				snapshot.store_epoch + (rtCount ? ' · ' + rtCount + ' traced' : ' · no trace yet');
			if (first && snapshot.files.length > BIG_GRAPH_FILES) {
				for (const l of NOISY_LAYERS) {
					if (snapshot.layers.includes(l)) { hiddenLayers.add(l); }
				}
			}
			buildDisplayGraph();
			renderLegend();
			computeImpact();
			setStatus(modeStatus());
			if (first) { fitView(modeNodes(), true); }
		} else if (msg.type === 'searchResults') {
			setStatus(msg.error ? 'semantic search failed' : '');
			highlightRows = new Set(msg.rows || []);
			highlightFiles = new Set((msg.rows || []).map((r) => snapshot.nodes[r].file));
			if (msg.rows && msg.rows.length) { focusNodeByRow(msg.rows[0]); }
		} else if (msg.type === 'error') {
			setStatus('error: ' + msg.message);
		}
	});

	resize();
	loop();
	</script>
</body>
</html>`;
}
