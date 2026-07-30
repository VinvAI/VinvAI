/**
 * Dead-code SECTIONS — the model behind the Findings surface.
 *
 * The graph explorer used to own this as a canvas filter: press "Dead Code" and
 * every untraced node stays lit. That answers "where is it" and nothing else. A
 * filtered canvas cannot say what a lump of untraced code DOES, whether anything
 * still points at it, or what you would do about it — and those are the only
 * questions that make the observation actionable. So the surface moves to
 * Findings, where every other "here is what we found, here is the evidence, here
 * is the button" row already lives, and the unit of the finding stops being a
 * node and becomes a SECTION.
 *
 * A section is a connected island of untraced symbols: symbols joined by a
 * containment, invoke or inherit edge, plus symbols sharing a file. Islands are
 * the right unit because dead code is almost never one function — it is a helper
 * and its three private callees, or a whole module nothing imports any more. One
 * report per island reads as a story; one row per symbol reads as a lint dump.
 *
 * Two things this model refuses to do:
 *
 *   1. Call anything dead with no trace on disk. With zero captures EVERY symbol
 *      is untraced, so a list of "dead code" would be a list of the codebase.
 *      `hasTrace` is false and `sections` is empty — the absence of evidence is
 *      reported as itself, never as a finding.
 *   2. Drop anything silently. Both bounds (how many sections, how many symbols
 *      inside one) are recorded as `Bounded` lineage stages ranked by source
 *      lines, so a reader can tell "12 sections is all of them" from "12 is the
 *      cap and 300 were dropped".
 *
 * Pure filesystem reads, no `vscode` import — unit-tested against fixture stores
 * exactly like findingsModel and journeyModel.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
	buildGraphSnapshot,
	hasIndexStore,
	indexStoreDir,
	loadChunkTexts,
	type GraphNode,
	type GraphSnapshot,
} from '../graph/indexGraph';
import { selectionStage, type Bounded } from '../harness/runtimeAnalysis';
// Type-only: the verdict is the harness module's shape, and importing it as a
// type keeps the model free of any runtime dependency on the dispatcher.
import type { DeadSectionVerdict } from '../harness/deadCodeAnalysis';

/** Layers whose "never executed" is uninteresting: test and doc chunks. */
const IGNORED_LAYERS = new Set(['tests', 'docs']);

/** Chunk kinds that are not executable symbols and can never be dead code. */
const NON_SYMBOL_KINDS = new Set(['doc', 'file', 'module_doc', 'comment']);

/** How many sections the report carries; the rest are dropped with a lineage. */
export const MAX_SECTIONS = 60;
/** How many symbols one section carries. */
export const MAX_SECTION_SYMBOLS = 40;

/** One untraced symbol inside a section. */
export interface DeadSymbol {
	/** Row in chunks.jsonl — the id every other artifact joins on. */
	row: number;
	name: string;
	kind: string;
	file: string;
	startLine: number;
	endLine: number;
	/** Source lines this symbol occupies (the quantity sections rank by). */
	lines: number;
	summary: string;
	/** Max-normalized PageRank — how central the static graph thinks it is. */
	rank: number;
	/**
	 * Symbols OUTSIDE this section that statically reference it and that a trace
	 * did execute. This is the difference between "nothing points here" and
	 * "live code points here and the path was never taken", which is the whole
	 * question when deciding to delete versus to wire up.
	 */
	liveCallers: string[];
}

/**
 * Why a section is untraced, as far as the static graph can tell.
 *
 * Deliberately two values and not three: clustering pulls every dead caller INTO
 * the section, so a section's external callers are all live by construction.
 * There is no "dead code called by dead code" case left to name.
 */
export type DeadSectionReason = 'orphan' | 'reachable-untested';

export interface DeadSection {
	/** Stable across runs: derived from the member symbol identities, not row order. */
	id: string;
	/** `payments/refund.py — 4 symbols`, the report's headline. */
	title: string;
	files: string[];
	/** Architectural layer of the section's largest file. */
	layer: string;
	symbols: Bounded<DeadSymbol>;
	/** Source lines across every member symbol, including any the cap dropped. */
	lines: number;
	/** Summed PageRank across members — sections sort on this. */
	rank: number;
	/** Union of member liveCallers, deduplicated. */
	liveCallers: string[];
	reason: DeadSectionReason;
	/**
	 * Rows in WALKTHROUGH order — callees before callers, the same
	 * understand-anything ordering `buildTour` uses for the whole graph, restricted
	 * to this section's internal edges.
	 *
	 * Kept separate from `symbols.items`, which is ranked so the cap keeps the
	 * central symbols rather than whichever ones happen to sort first. Two
	 * orderings because they answer different questions: "which of these matter
	 * most" and "in what order does this become readable".
	 */
	tourOrder: number[];
}

export interface DeadCodeReport {
	schemaVersion: 1;
	root: string;
	generatedAt: string;
	storeEpoch: number;
	/**
	 * False when no capture has ever been joined onto the graph. Everything would
	 * read as dead, so `sections` is empty and the surface says why instead of
	 * listing the whole codebase.
	 */
	hasTrace: boolean;
	/** Symbols a trace executed, out of the symbols this model considers at all. */
	traced: number;
	considered: number;
	sections: Bounded<DeadSection>;
}

export function deadCodePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'deadcode.json');
}

/** Backing file for one section's report tab. */
export function deadSectionPath(workspaceRoot: string, id: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', `deadcode-${id}.json`);
}

/** `deadcode-<id>.json` → `<id>`; null for any other name. */
export function sectionIdFromPath(fsPath: string): string | null {
	const m = /^deadcode-([0-9a-f]{12})\.json$/.exec(path.basename(fsPath));
	return m ? m[1] : null;
}

/** True for chunks that represent code that can actually run. */
function isExecutableSymbol(n: GraphNode): boolean {
	return !NON_SYMBOL_KINDS.has(n.kind) && n.lang !== 'doc' && !IGNORED_LAYERS.has(n.layer);
}

function symbolLines(n: GraphNode): number {
	return Math.max(1, (n.end_line || n.start_line) - n.start_line + 1);
}

/** Disjoint-set over row numbers — the section clustering. */
class Union {
	private parent = new Map<number, number>();

	find(x: number): number {
		let root = this.parent.get(x);
		if (root === undefined) {
			this.parent.set(x, x);
			return x;
		}
		while (root !== this.parent.get(root)) {
			root = this.parent.get(root) as number;
		}
		// Path compression keeps this linear on the big-repo case (10k+ symbols).
		let cur = x;
		while (cur !== root) {
			const next = this.parent.get(cur) as number;
			this.parent.set(cur, root);
			cur = next;
		}
		return root;
	}

	join(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) {
			this.parent.set(ra, rb);
		}
	}
}

/**
 * A section id that survives re-indexing.
 *
 * Hashed from `file:name` of every member, NOT from rows: rows are positions in
 * chunks.jsonl and shift whenever anything above them changes, so a row-derived
 * id would mint a new section — and orphan its stored analysis — on every
 * reindex, for code nobody touched.
 */
function sectionId(symbols: DeadSymbol[]): string {
	const identity = symbols
		.map((s) => `${s.file}:${s.name}`)
		.sort()
		.join('\n');
	return crypto.createHash('sha1').update(identity).digest('hex').slice(0, 12);
}

/**
 * Callees-before-callers order for one section, so reading it top to bottom
 * never asks you to understand a call before its target.
 *
 * Kahn's algorithm over the section's INTERNAL invoke/inherit edges only —
 * external ones point at live code by construction and would just make every
 * node look blocked. Cycles (mutual recursion is common in the code that gets
 * abandoned) are broken by releasing the highest-ranked blocked symbol, which is
 * exactly how `buildTour` breaks them for the whole graph; a different rule here
 * would make two walkthroughs of the same repo disagree about reading order.
 */
function tourOrderFor(members: GraphNode[], calleesOf: Map<number, Set<number>>): number[] {
	const inSection = new Set(members.map((m) => m.row));
	const rank = new Map(members.map((m) => [m.row, m.rank]));
	const remaining = new Set(inSection);
	const emitted: number[] = [];
	const emittedSet = new Set<number>();
	while (remaining.size > 0) {
		const ready = [...remaining].filter((row) => {
			const callees = calleesOf.get(row);
			if (!callees) {
				return true;
			}
			for (const callee of callees) {
				if (callee !== row && inSection.has(callee) && !emittedSet.has(callee)) {
					return false;
				}
			}
			return true;
		});
		// Nothing ready means a cycle: release its most central member and continue.
		const batch = ready.length > 0 ? ready : [...remaining];
		batch.sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0) || a - b);
		const take = ready.length > 0 ? batch : [batch[0]];
		for (const row of take) {
			emitted.push(row);
			emittedSet.add(row);
			remaining.delete(row);
		}
	}
	return emitted;
}

function titleFor(files: string[], count: number): string {
	const head = files[0] ?? 'unknown';
	const more = files.length > 1 ? ` +${files.length - 1} file${files.length > 2 ? 's' : ''}` : '';
	return `${head}${more} — ${count} symbol${count === 1 ? '' : 's'}`;
}

/**
 * Derives every dead-code section in a workspace.
 *
 * `snapshot` is injectable so tests can drive the clustering directly instead of
 * having to lay down a whole index store.
 */
export function buildDeadCode(workspaceRoot: string, snapshot?: GraphSnapshot): DeadCodeReport {
	const emptyReport = (snap?: GraphSnapshot): DeadCodeReport => ({
		schemaVersion: 1,
		root: workspaceRoot,
		generatedAt: new Date().toISOString(),
		storeEpoch: snap?.store_epoch ?? 0,
		hasTrace: false,
		traced: 0,
		considered: 0,
		sections: {
			items: [],
			lineage: [
				selectionStage('dead-code-scan', {
					returned: 0,
					total: 0,
					coverage_achieved: 0,
					stopped_by: 'exhausted',
					unit: 'lines',
				}),
			],
		},
	});

	if (!snapshot && !hasIndexStore(workspaceRoot)) {
		return emptyReport();
	}
	let snap: GraphSnapshot;
	try {
		snap = snapshot ?? buildGraphSnapshot(workspaceRoot);
	} catch {
		return emptyReport();
	}

	const considered = snap.nodes.filter(isExecutableSymbol);
	const traced = considered.filter((n) => snap.runtime[n.row]).length;
	// No capture has ever been joined: every symbol is untraced, so "dead" would
	// name the entire codebase. Report the absence, never the list.
	if (Object.keys(snap.runtime).length === 0) {
		return { ...emptyReport(snap), considered: considered.length };
	}

	const deadNodes = considered.filter((n) => !snap.runtime[n.row]);
	const byRow = new Map<number, GraphNode>(considered.map((n) => [n.row, n]));
	const deadRows = new Set(deadNodes.map((n) => n.row));

	const union = new Union();
	for (const n of deadNodes) {
		union.find(n.row);
	}
	// Same file first: a module nobody imports any more is one finding, whether or
	// not its members happen to call each other.
	const firstInFile = new Map<string, number>();
	for (const n of deadNodes) {
		const seen = firstInFile.get(n.file);
		if (seen === undefined) {
			firstInFile.set(n.file, n.row);
		} else {
			union.join(seen, n.row);
		}
	}
	// Then static structure, so a dead helper in one file joins the dead caller
	// that is its only reason to exist in another.
	const calleesOf = new Map<number, Set<number>>();
	for (const e of snap.edges) {
		if (!deadRows.has(e.src) || !deadRows.has(e.dst)) {
			continue;
		}
		union.join(e.src, e.dst);
		if (e.kind === 'invoke' || e.kind === 'inherit') {
			let set = calleesOf.get(e.src);
			if (!set) {
				set = new Set();
				calleesOf.set(e.src, set);
			}
			set.add(e.dst);
		}
	}

	// Live references INTO dead rows, collected once over the edge list rather
	// than re-scanned per symbol (edges are O(100k) on a real repo).
	const liveCallersByRow = new Map<number, Set<string>>();
	for (const e of snap.edges) {
		if (e.kind === 'contains' || !deadRows.has(e.dst) || deadRows.has(e.src)) {
			continue;
		}
		if (!snap.runtime[e.src]) {
			continue; // referenced by code that never ran either — not evidence of life
		}
		const caller = byRow.get(e.src) ?? snap.nodes.find((n) => n.row === e.src);
		if (!caller) {
			continue;
		}
		let set = liveCallersByRow.get(e.dst);
		if (!set) {
			set = new Set();
			liveCallersByRow.set(e.dst, set);
		}
		set.add(`${caller.name} (${caller.file}:${caller.start_line})`);
	}

	const groups = new Map<number, GraphNode[]>();
	for (const n of deadNodes) {
		const root = union.find(n.row);
		const list = groups.get(root);
		if (list) {
			list.push(n);
		} else {
			groups.set(root, [n]);
		}
	}

	const sections: DeadSection[] = [];
	for (const members of groups.values()) {
		// Most central first, so a capped section still shows the symbols a reader
		// would have picked out of it anyway.
		members.sort((a, b) => b.rank - a.rank || a.file.localeCompare(b.file) || a.start_line - b.start_line);
		const all: DeadSymbol[] = members.map((n) => ({
			row: n.row,
			name: n.name,
			kind: n.kind,
			file: n.file,
			startLine: n.start_line,
			endLine: n.end_line,
			lines: symbolLines(n),
			summary: n.summary,
			rank: n.rank,
			liveCallers: [...(liveCallersByRow.get(n.row) ?? [])],
		}));
		const totalLines = all.reduce((s, x) => s + x.lines, 0);
		const kept = all.slice(0, MAX_SECTION_SYMBOLS);
		const keptLines = kept.reduce((s, x) => s + x.lines, 0);
		const files = [...new Set(all.map((s) => s.file))].sort();
		const liveCallers = [
			...new Set(all.flatMap((s) => s.liveCallers)),
		].sort();
		sections.push({
			id: sectionId(all),
			title: titleFor(files, all.length),
			files,
			layer: members[0].layer,
			symbols: {
				items: kept,
				lineage: [
					selectionStage('section-symbols', {
						returned: kept.length,
						total: all.length,
						coverage_achieved: totalLines > 0 ? keptLines / totalLines : 0,
						stopped_by: all.length > MAX_SECTION_SYMBOLS ? 'cap' : 'exhausted',
						droppedMagnitude: totalLines - keptLines,
						unit: 'lines',
					}),
				],
			},
			lines: totalLines,
			rank: all.reduce((s, x) => s + x.rank, 0),
			liveCallers,
			reason: liveCallers.length > 0 ? 'reachable-untested' : 'orphan',
			tourOrder: tourOrderFor(members, calleesOf),
		});
	}

	// Reachable-untested first: live code already points at it, so it is both the
	// likelier mistake and the cheaper thing to act on. Then by volume — a 400-line
	// island is a bigger finding than a 4-line one at the same reason.
	sections.sort(
		(a, b) =>
			Number(b.reason === 'reachable-untested') - Number(a.reason === 'reachable-untested') ||
			b.lines - a.lines ||
			b.rank - a.rank ||
			a.id.localeCompare(b.id),
	);
	const totalLines = sections.reduce((s, x) => s + x.lines, 0);
	const keptSections = sections.slice(0, MAX_SECTIONS);
	const keptLines = keptSections.reduce((s, x) => s + x.lines, 0);

	return {
		schemaVersion: 1,
		root: workspaceRoot,
		generatedAt: new Date().toISOString(),
		storeEpoch: snap.store_epoch,
		hasTrace: true,
		traced,
		considered: considered.length,
		sections: {
			items: keptSections,
			lineage: [
				selectionStage('dead-code-scan', {
					returned: keptSections.length,
					total: sections.length,
					coverage_achieved: totalLines > 0 ? keptLines / totalLines : 0,
					stopped_by: sections.length > MAX_SECTIONS ? 'cap' : 'exhausted',
					droppedMagnitude: totalLines - keptLines,
					unit: 'lines',
				}),
			],
		},
	};
}

/** One stop of a section's walkthrough: a symbol and the code it is. */
export interface DeadSectionStop {
	symbol: DeadSymbol;
	/**
	 * The stored chunk text — the code as of the row's index epoch, i.e. the
	 * version the ranks, edges and trace join all describe. Empty when the store
	 * carries no text for the row.
	 */
	source: string;
}

/** The backing document of one section's report tab. */
export interface DeadSectionReport {
	schemaVersion: 1;
	root: string;
	generatedAt: string;
	storeEpoch: number;
	section: DeadSection;
	/** Walkthrough stops in `tourOrder`, restricted to the symbols the cap kept. */
	stops: DeadSectionStop[];
	/**
	 * The agent's reading of this section, when one has been asked for. Null is a
	 * real state the view renders as "not analysed yet" with the button that asks
	 * — never as an empty verdict.
	 */
	verdict: DeadSectionVerdict | null;
}

/**
 * Assembles one section's walkthrough.
 *
 * Source comes from the index store rather than the live file: chunk text is the
 * code the section's ranks, edges and missing trace actually describe, and
 * re-reading the working tree by stored line numbers silently shows the wrong
 * function the moment anything above it moves.
 */
export function buildSectionReport(
	workspaceRoot: string,
	section: DeadSection,
	storeEpoch: number,
	verdict: DeadSectionVerdict | null,
): DeadSectionReport {
	const kept = new Map(section.symbols.items.map((s) => [s.row, s]));
	const ordered = [
		...section.tourOrder.filter((row) => kept.has(row)),
		// A row the cap kept but the order never mentioned would vanish from the
		// walkthrough entirely — belt and braces against the two lists drifting.
		...section.symbols.items.map((s) => s.row).filter((row) => !section.tourOrder.includes(row)),
	];
	let sources = new Map<number, string>();
	try {
		sources = loadChunkTexts(indexStoreDir(workspaceRoot), ordered);
	} catch {
		// A missing store text column costs the code panes, not the walkthrough.
	}
	return {
		schemaVersion: 1,
		root: workspaceRoot,
		generatedAt: new Date().toISOString(),
		storeEpoch,
		section,
		stops: ordered.map((row) => ({
			symbol: kept.get(row) as DeadSymbol,
			source: sources.get(row) ?? '',
		})),
		verdict,
	};
}

/** Writes one section report and returns its path. */
export function writeSectionReport(workspaceRoot: string, report: DeadSectionReport): string {
	const file = deadSectionPath(workspaceRoot, report.section.id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
	return file;
}

/** Writes the machine-readable dead-code report and returns its path. */
export function writeDeadCodeReport(workspaceRoot: string, report: DeadCodeReport): string {
	const file = deadCodePath(workspaceRoot);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
	return file;
}
