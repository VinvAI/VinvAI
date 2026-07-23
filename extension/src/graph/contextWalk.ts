/**
 * Context walk — typed-edge personalized PageRank over the code graph.
 *
 * This replaces the old unweighted BFS slice with the standard relevance
 * primitive of graph retrieval (HippoRAG, Aider's repo-map): a random walk
 * with restart at the ANCHORS (the symbols the question/task is about), whose
 * stationary distribution
 *
 *     π = α·s + (1−α)·π·W̃,      W̃ = Σ_t β_t·W̃_t / Σ_t β_t
 *
 * assigns every node relevance mass that decays geometrically with graph
 * distance from the anchors, aggregated over ALL connecting paths — multi-hop
 * retrieval in one deterministic linear-algebra step, no per-hop rules.
 *
 * Design properties (each mirrors the SOTA it comes from):
 *  - TYPED edges: static invoke/inherit/contains and OBSERVED runtime flow
 *    each form their own row-normalized kernel W̃_t, mixed by learnable
 *    weights β_t (supervised-random-walk shape; flat priors — no edge type is
 *    hand-privileged, and runtime evidence is finally walkable).
 *  - Anchor reset s: explicit seeds and retrieval hits, hits weighted by
 *    reciprocal rank 1/(k₀+r) (RRF — scale-free, no score calibration) and
 *    every anchor by name specificity 1/df(name) (HippoRAG's IDF analogue,
 *    so ubiquitous names don't dominate the walk).
 *  - Convergence is a tolerance, not an iteration constant: power iteration
 *    contracts at rate (1−α), so iterations = ⌈ln(tol)/ln(1−α)⌉.
 *  - Admission is budgeted: nodes enter the slice by π until the budget is
 *    spent; anchors are always admitted. Everything is deterministic.
 *
 * Free of `vscode` and of any I/O — pure math over the snapshot, so it is
 * unit-testable and identically usable by QnA, context packs, and MCP tools.
 */
import type { FlowEdge, GraphEdge, GraphNode } from './indexGraph';
import type { WalkParams } from '../harness/episodeTelemetry';

/** One anchor of the walk: a node the evidence gathering is ABOUT. */
export interface WalkAnchor {
	row: number;
	/**
	 * Prior weight before specificity scaling — 1 for explicit seeds (the user
	 * pointed at the node), rrfAnchorWeight(rank) = 1/(k₀+rank+1) for the
	 * retrieval hit at 0-based rank `rank`.
	 */
	weight: number;
}

export interface WalkResult {
	/** Rows admitted to the slice, highest walk mass first (anchors included). */
	rows: number[];
	/**
	 * Stationary mass per ADMITTED row. The full distribution over all rows
	 * sums to 1; this map covers the admitted subset, so its sum is ≤ 1 (equal
	 * when the budget covers the walk's whole support).
	 */
	mass: Map<number, number>;
	/** Iterations the power method ran (⌈ln(tol)/ln(1−α)⌉). */
	iterations: number;
}

interface TypedNeighbor {
	to: number;
	/** Within-type transition weight (multiplicity), pre-normalization. */
	w: number;
}

/**
 * Builds the per-type neighbor lists. Edges are treated as bidirectional for
 * relevance: callers and callees are both context for a symbol (a walk that
 * only followed call direction could never reach the caller that passed the
 * bad argument). Flow edges carry log1p(calls) multiplicity — observed
 * frequency raises relevance with diminishing returns.
 */
function typedAdjacency(
	nodeCount: number,
	edges: GraphEdge[],
	flowEdges: FlowEdge[],
): Record<string, TypedNeighbor[][]> {
	const types: Record<string, TypedNeighbor[][]> = {
		invoke: Array.from({ length: nodeCount }, () => []),
		inherit: Array.from({ length: nodeCount }, () => []),
		contains: Array.from({ length: nodeCount }, () => []),
		flow: Array.from({ length: nodeCount }, () => []),
	};
	for (const e of edges) {
		if (e.src === e.dst || e.src >= nodeCount || e.dst >= nodeCount) {
			continue;
		}
		const t = types[e.kind];
		if (!t) {
			continue;
		}
		t[e.src].push({ to: e.dst, w: 1 });
		t[e.dst].push({ to: e.src, w: 1 });
	}
	for (const f of flowEdges) {
		if (f.src === f.dst || f.src >= nodeCount || f.dst >= nodeCount) {
			continue;
		}
		const w = Math.log1p(f.calls);
		types.flow[f.src].push({ to: f.dst, w });
		types.flow[f.dst].push({ to: f.src, w });
	}
	return types;
}

/**
 * Anchor specificity: 1/df(name) where df = how many symbols share the
 * anchor's name. A name defined once pins the walk precisely; a name defined
 * in forty files carries little identifying information and gets little reset
 * mass — the graph-retrieval analogue of IDF (HippoRAG's node specificity).
 */
export function nameSpecificity(nodes: GraphNode[]): Map<number, number> {
	const df = new Map<string, number>();
	for (const n of nodes) {
		if (n.name) {
			df.set(n.name, (df.get(n.name) ?? 0) + 1);
		}
	}
	const spec = new Map<number, number>();
	for (const n of nodes) {
		spec.set(n.row, 1 / (df.get(n.name) ?? 1));
	}
	return spec;
}

/**
 * The walk itself. Returns the budgeted slice rows (by descending stationary
 * mass, anchors always included) plus the mass map so callers can render the
 * relevance of every admitted node — the math stays auditable end to end.
 */
export function contextWalk(
	nodes: GraphNode[],
	edges: GraphEdge[],
	flowEdges: FlowEdge[],
	anchors: WalkAnchor[],
	params: WalkParams,
	budget: number,
	/**
	 * Optional hop bound on ADMISSION: only nodes within this many hops of an
	 * anchor (over the union adjacency) may enter the slice. Ranking is still
	 * by walk mass; this bounds the slice's reach — the pack bandit's
	 * slice_depth arm keeps its literal meaning through this parameter.
	 */
	maxHops?: number,
): WalkResult {
	const n = nodes.length;
	const valid = anchors.filter((a) => a.row >= 0 && a.row < n);
	if (n === 0 || valid.length === 0 || budget <= 0) {
		return { rows: [], mass: new Map(), iterations: 0 };
	}
	const types = typedAdjacency(n, edges, flowEdges);
	const beta = params.beta;
	// Σβ = 0 is the no-kernel limit of the walk: with no transition mixture to
	// follow, the stationary distribution IS the reset distribution (validated
	// policies can't produce this, but math inputs are guarded regardless —
	// dividing by zero here would render "walk mass NaN" everywhere).
	const betaSum = beta.invoke + beta.inherit + beta.contains + beta.flow;
	const kernelActive = betaSum > 0;
	// Per-node normalized transition list mixing the typed kernels:
	// P(u→v) = Σ_t (β_t/Σβ) · w_t(u,v)/deg_t(u). A node missing a type keeps
	// that type's share for redistribution via the dangling term, exactly as
	// standard PageRank treats dangling nodes.
	const trans: TypedNeighbor[][] = Array.from({ length: n }, () => []);
	const outShare = new Float64Array(n); // Σ of type shares that have neighbors
	for (const [typeName, adj] of Object.entries(kernelActive ? types : {})) {
		const share = (beta as unknown as Record<string, number>)[typeName] / betaSum;
		if (share === 0) {
			continue;
		}
		for (let u = 0; u < n; u++) {
			const neighbors = adj[u];
			if (!neighbors.length) {
				continue;
			}
			let degree = 0;
			for (const nb of neighbors) {
				degree += nb.w;
			}
			if (degree <= 0) {
				continue;
			}
			outShare[u] += share;
			for (const nb of neighbors) {
				trans[u].push({ to: nb.to, w: (share * nb.w) / degree });
			}
		}
	}
	// Reset distribution s over anchors: prior weight × name specificity,
	// normalized to a probability vector.
	const spec = nameSpecificity(nodes);
	const s = new Float64Array(n);
	let sSum = 0;
	for (const a of valid) {
		const m = a.weight * (spec.get(a.row) ?? 1);
		s[a.row] += m;
		sSum += m;
	}
	if (sSum <= 0) {
		return { rows: [], mass: new Map(), iterations: 0 };
	}
	for (let i = 0; i < n; i++) {
		s[i] /= sSum;
	}
	const alpha = params.alpha;
	const iterations = kernelActive
		? Math.max(1, Math.ceil(Math.log(params.tol) / Math.log(1 - alpha)))
		: 0;
	let pi = Float64Array.from(s);
	for (let it = 0; it < iterations; it++) {
		const next = new Float64Array(n);
		let dangling = 0;
		for (let u = 0; u < n; u++) {
			const mass = pi[u];
			if (mass === 0) {
				continue;
			}
			// The share of this node's transition kernel with no neighbors goes
			// back to the reset distribution (dangling mass), keeping Σπ = 1.
			dangling += mass * (1 - outShare[u]);
			for (const nb of trans[u]) {
				next[nb.to] += mass * nb.w;
			}
		}
		for (let i = 0; i < n; i++) {
			next[i] = alpha * s[i] + (1 - alpha) * (next[i] + dangling * s[i]);
		}
		pi = next;
	}
	// Budgeted admission: anchors first (the walk is about them), then by mass.
	const anchorRows = new Set(valid.map((a) => a.row));
	// Optional hop bound: BFS distance from the anchors over the union
	// adjacency (all types + flow), computed only when a bound was asked for.
	let withinHops: ((row: number) => boolean) | undefined;
	if (maxHops !== undefined && Number.isFinite(maxHops)) {
		const dist = new Int32Array(n).fill(-1);
		let frontier = [...anchorRows];
		for (const r of frontier) {
			dist[r] = 0;
		}
		for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
			const next: number[] = [];
			for (const u of frontier) {
				for (const list of [types.invoke[u], types.inherit[u], types.contains[u], types.flow[u]]) {
					for (const nb of list) {
						if (dist[nb.to] === -1) {
							dist[nb.to] = hop;
							next.push(nb.to);
						}
					}
				}
			}
			frontier = next;
		}
		withinHops = (row: number): boolean => dist[row] !== -1;
	}
	const order = [...pi.keys()]
		.filter((row) => pi[row] > 0 && !anchorRows.has(row) && (withinHops?.(row) ?? true))
		.sort((a, b) => pi[b] - pi[a] || a - b);
	const rows: number[] = [...anchorRows].sort((a, b) => pi[b] - pi[a] || a - b);
	for (const row of order) {
		if (rows.length >= budget) {
			break;
		}
		rows.push(row);
	}
	const mass = new Map<number, number>();
	for (const row of rows) {
		mass.set(row, pi[row]);
	}
	return { rows, mass, iterations };
}

/**
 * RRF anchor weights for retrieval hits: hit at 0-based rank r gets
 * 1/(k₀ + r + 1). Rank-based (scale-free) so BM25/vector scores never need
 * cross-calibration — Cormack, Clarke & Büttcher (SIGIR 2009).
 */
export function rrfAnchorWeight(rank: number, k0: number): number {
	return 1 / (k0 + rank + 1);
}

/**
 * Structural constants of textual symbol grounding, defined ONCE for every
 * surface that resolves free text to graph rows (issue statements, retrial
 * critiques, stack traces). These are not behavioral tuning knobs:
 * MIN_GROUND_NAME suppresses ubiquitous short tokens whose occurrence in
 * text carries almost no identifying information (their df is huge — the
 * same reason 1/df downweights them as anchors), and the identifier
 * alphabet defines word-alignment for identifier boundaries.
 */
export const MIN_GROUND_NAME = 4;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * Deterministic symbol grounding: rows whose symbol name occurs word-aligned
 * in the text, ranked by PageRank. Homonyms are resolved by joint (file,
 * name) evidence — when the text also names a symbol's file, that symbol
 * eclipses same-named symbols elsewhere. Shared by QnA retrial anchoring and
 * pack seed derivation so both surfaces ground identically.
 */
export function groundSymbolMentions(
	nodes: GraphNode[],
	text: string,
	cap: number,
): number[] {
	const found: Array<{ row: number; name: string; rank: number; fileMatch: boolean }> = [];
	const hay = text.toLowerCase();
	for (const n of nodes) {
		if (n.name.length < MIN_GROUND_NAME || n.layer === 'docs') {
			continue;
		}
		const needle = n.name.toLowerCase();
		let at = hay.indexOf(needle);
		let aligned = false;
		while (at !== -1 && !aligned) {
			const before = at === 0 ? '' : hay[at - 1];
			const after = hay[at + needle.length] ?? '';
			aligned = !IDENT_CHAR.test(before) && !IDENT_CHAR.test(after);
			at = hay.indexOf(needle, at + 1);
		}
		if (aligned) {
			found.push({
				row: n.row,
				name: n.name,
				rank: n.rank,
				fileMatch: hay.includes(n.file.toLowerCase()),
			});
		}
	}
	const jointNames = new Set(found.filter((f) => f.fileMatch).map((f) => f.name));
	const resolved = found.filter((f) => f.fileMatch || !jointNames.has(f.name));
	resolved.sort(
		(a, b) => Number(b.fileMatch) - Number(a.fileMatch) || b.rank - a.rank || a.row - b.row,
	);
	return resolved.slice(0, cap).map((f) => f.row);
}
