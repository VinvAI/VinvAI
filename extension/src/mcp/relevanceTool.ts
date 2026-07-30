/**
 * `relevant_to` — the relevance walk, handed to the agent.
 *
 * Vinv already ranks context by typed-edge personalized PageRank: π = α·s +
 * (1−α)·π·W̃ over the code graph, restarted at anchor symbols, with per-edge-type
 * row-normalised kernels and name-specificity (1/df) standing in for IDF. That
 * is what composes an episode's context pack and what Ask Vinv retrieves with.
 *
 * It was not reachable by the agent working the episode. The pack runs the walk
 * ONCE, up front, from seeds derived before any investigation has happened, and
 * every retrieval tool offered afterwards answers a different question:
 * `vinv_query` is embedding similarity, `slice` is a backward DYNAMIC slice over
 * traces, `blast_radius` is plain transitive traversal. None of them can
 * reproduce the pack's own ranking, so an agent that discovers three symbols
 * that actually matter cannot say "re-rank relevance around THESE" — the single
 * most useful thing a graph-relevance retriever offers.
 *
 * That gap made the pack's own promise unkeepable: it tells the agent "this pack
 * is the seed, not the ceiling" and then names tools that cannot reproduce how
 * the seed was chosen. This closes it — same walk, same parameters, agent-chosen
 * anchors, on demand.
 *
 * Read-only over the index store, pure math over the snapshot (contextWalk does
 * no I/O), and it reports its own bound rather than returning a silently
 * truncated list.
 */

import {
	buildGraphSnapshot,
	type GraphNode,
	type GraphSnapshot,
} from '../graph/indexGraph';
import { contextWalk, type WalkAnchor } from '../graph/contextWalk';
import { WALK_PRIORS } from '../harness/episodeTelemetry';

/**
 * Default node budget. Larger than the episode pack's, deliberately: the pack
 * spends its budget blind, before the agent has read anything, so it stays tight
 * to leave prompt room. A `relevant_to` call is made by an agent that already
 * knows what it is looking for, and paying for a wider slice is the point of
 * asking.
 */
const DEFAULT_BUDGET = 40;

/** Ceiling on the requested budget — a walk is cheap, serialising 7577 nodes is not. */
const MAX_BUDGET = 200;

/**
 * Resolves a caller-supplied symbol to graph rows.
 *
 * Accepts an exact dotted qualname, a bare symbol name, or `file:name`. A name
 * that matches several symbols returns ALL of them rather than guessing: the
 * walk takes multiple anchors natively, so ambiguity is answered by ranking
 * rather than by an arbitrary pick.
 */
export function resolveAnchors(
	nodes: GraphNode[],
	symbols: string[],
): { rows: number[]; unresolved: string[] } {
	const rows: number[] = [];
	const unresolved: string[] = [];
	for (const raw of symbols) {
		const want = raw.trim();
		if (!want) {
			continue;
		}
		const lower = want.toLowerCase();
		const matches = nodes.filter((n) => {
			if (!n) {
				return false;
			}
			const qual = `${n.file}:${n.name}`.toLowerCase();
			return n.name.toLowerCase() === lower || qual === lower || qual.endsWith(`:${lower}`);
		});
		if (matches.length === 0) {
			unresolved.push(want);
			continue;
		}
		for (const m of matches) {
			if (!rows.includes(m.row)) {
				rows.push(m.row);
			}
		}
	}
	return { rows, unresolved };
}

export interface RelevantToResult {
	status: string;
	[key: string]: unknown;
}

/**
 * Ranks the graph by relevance to the given symbols.
 *
 * `max_hops` bounds ADMISSION, not ranking: only nodes within that many hops of
 * an anchor may enter, but order is always walk mass. Omitted means unbounded,
 * which is what an agent chasing an indirect cause wants.
 */
export function toolRelevantTo(
	workspaceRoot: string,
	symbols: string[],
	budget?: number,
	maxHops?: number,
): RelevantToResult {
	if (symbols.length === 0) {
		return {
			status: 'error',
			message: 'relevant_to needs at least one symbol to anchor the walk on.',
		};
	}
	let snapshot: GraphSnapshot;
	try {
		snapshot = buildGraphSnapshot(workspaceRoot);
	} catch (e) {
		return {
			status: 'error',
			message: `no readable Vinv index store: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	if (snapshot.nodes.length === 0) {
		return {
			status: 'no_index',
			message:
				'The index store is empty — run discovery before asking what is relevant. ' +
				'This is not a report that nothing is relevant.',
		};
	}

	const { rows: anchorRows, unresolved } = resolveAnchors(snapshot.nodes, symbols);
	if (anchorRows.length === 0) {
		return {
			status: 'unresolved',
			message: `none of these symbols are in the index: ${unresolved.join(', ')}`,
			hint: 'Try vinv_query for a semantic search, or pass file:name to disambiguate.',
		};
	}

	const effectiveBudget = Math.max(1, Math.min(budget ?? DEFAULT_BUDGET, MAX_BUDGET));
	const anchors: WalkAnchor[] = anchorRows.map((row) => ({ row, weight: 1 }));
	const walked = contextWalk(
		snapshot.nodes,
		snapshot.edges,
		snapshot.flow_edges,
		anchors,
		{ ...WALK_PRIORS, beta: { ...WALK_PRIORS.beta } },
		effectiveBudget,
		maxHops,
	);

	const items = walked.rows
		.map((row) => {
			const n = snapshot.nodes[row];
			if (!n) {
				return undefined;
			}
			const rt = snapshot.runtime[row];
			return {
				name: n.name,
				kind: n.kind,
				file: n.file,
				line: n.start_line,
				/** Stationary mass — the ranking quantity, exposed so it is auditable. */
				walk_mass: walked.mass.get(row) ?? 0,
				is_anchor: anchorRows.includes(row),
				summary: n.summary || undefined,
				/** Present only when this symbol was actually observed running. */
				runtime: rt
					? {
							calls: rt.calls,
							total_ms: Math.round(rt.total_ms),
							current_errors: rt.current_errors,
						}
					: undefined,
			};
		})
		.filter(Boolean);

	// The walk's support is every row it reached with non-zero mass; `budget`
	// is what we handed back. Reporting both is the difference between "40
	// relevant symbols" and "40 of 312, ranked" — the second is a fact, the
	// first is an impression.
	const support = walked.mass.size;
	return {
		status: 'ok',
		anchors: anchorRows.map((r) => snapshot.nodes[r]?.name).filter(Boolean),
		unresolved: unresolved.length ? unresolved : undefined,
		returned: items.length,
		reached: support,
		stopped_by: items.length < effectiveBudget ? 'exhausted' : 'budget',
		budget: effectiveBudget,
		max_hops: maxHops ?? null,
		ranking: 'typed-edge personalized PageRank (walk mass), anchors restarted at weight 1',
		symbols: items,
	};
}
