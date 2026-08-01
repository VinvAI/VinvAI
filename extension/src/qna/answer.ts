/**
 * Ask Vinv answer pipeline: retrieve from the code index, expand a budgeted
 * graph slice, attach runtime evidence, and answer through the user's
 * coding-harness CLI (the same agent handbook/bring-up use).
 *
 * Every answer logs a retrieval decision to the shared bandit ledger and the
 * panel's thumbs write explicit feedback for the same decision_id, so QnA
 * becomes one more reward source for the retrieval policy.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { getBinPath, isBinAvailable } from '../tracelens/bin';
import { getHarnessId, getIndexEnv } from '../config/settings';
import { runHarnessPrompt } from '../harness/harnessRunner';
import { ensureEmbedder } from '../engines/install';
import {
	buildGraphSnapshot,
	loadChunkTexts,
	type FailureExemplar,
	type GraphNode,
	type GraphSnapshot,
} from '../graph/indexGraph';
import {
	contextWalk,
	groundSymbolMentions,
	rrfAnchorWeight,
	type WalkAnchor,
} from '../graph/contextWalk';
import {
	appendRetrievalEvent,
	loadPolicyForEpoch,
	queryFeatures,
	retrievalEpoch,
} from '../mcp/retrievalTelemetry';
import { loadEpisodePolicy, walkParams, type WalkParams } from '../harness/episodeTelemetry';
import {
	collectCacheCandidates,
	collectMemoryTrends,
	describeLineage,
	selectionStage,
	selectHotspots,
} from '../harness/runtimeAnalysis';
import { indexStoreDir } from '../graph/indexGraph';

/**
 * Live progress of the retrieval leg. `stage` is what the caller renders
 * against — the panel picks a different loader scene for a sidecar cold start
 * than for the index search itself — so consumers never have to pattern-match
 * on the human label to work out what is happening.
 */
export type QnaProgress = (label: string, stage: 'embedder' | 'retrieval') => void;

/** One hit from `index query`, as rendered by the Rust binary. */
export interface IndexHit {
	score: number;
	file: string;
	name: string;
	kind: string;
	lang: string;
	lines: [number, number];
	rank: number;
	summary: string;
	snippet: string;
}

interface IndexQueryResult {
	status: string;
	error?: string;
	results?: IndexHit[];
}

/** Runs `index query` against the workspace store and parses the hits. */
export async function runIndexQuery(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	query: string,
	topK: number,
	// Live narration for a caller with a progress surface: the sidecar's cold
	// start dominates the wall-clock of a first question (minutes, on CPU), and
	// without this the panel showed one frozen label for all of it.
	onProgress?: QnaProgress,
): Promise<IndexHit[]> {
	if (!isBinAvailable(context, 'index')) {
		throw new Error('the Vinv index engine is not installed yet');
	}
	const binPath = getBinPath(context, 'index');
	const storeDir = indexStoreDir(workspaceRoot);
	// Queries embed through the local sidecar, and getIndexEnv (below) points
	// INDEX_GATEWAY_URL at exactly that sidecar — so when it never comes up
	// there is no remote gateway left that could serve the embedding, and the
	// query below can only fail. Spawning it anyway just spends a subprocess to
	// rediscover that, then reports the binary's generic complaint several
	// layers away from the thing the user actually has to start. Say it here.
	if (!(await ensureEmbedder(context, (label) => onProgress?.(label, 'embedder')))) {
		throw new Error(
			'the local embedding sidecar never came up, so the question could not be embedded — ' +
				'Vinv tried to start `vinv-embedder serve` and it did not begin serving. ' +
				'Check .vinv/logs, or run "Vinv: Install Vinv Engines" if the engines are missing.',
		);
	}
	onProgress?.('searching the code index…', 'retrieval');
	return new Promise((resolve, reject) => {
		execFile(
			binPath,
			['query', query, '--repo-path', workspaceRoot, '--store-dir', storeDir, '--top-k', String(topK)],
			{ maxBuffer: 32 * 1024 * 1024, env: getIndexEnv(path.dirname(binPath)) },
			(error, stdout, stderr) => {
				if (!stdout) {
					reject(new Error(error?.message ?? stderr ?? 'index query produced no output'));
					return;
				}
				try {
					const parsed = JSON.parse(stdout) as IndexQueryResult;
					if (parsed.status === 'error') {
						reject(new Error(parsed.error ?? 'index query failed'));
						return;
					}
					resolve(parsed.results ?? []);
				} catch {
					reject(new Error('index query returned unreadable output'));
				}
			},
		);
	});
}

/**
 * Ask Vinv's per-anchor SOURCE budget.
 *
 * Reads the policy's explicit `qna_snippet_chars`. It previously decoded
 * `(preferred_arm >> 2) & 1` — a bandit bit learned against context PACKS,
 * where it sliced summaries (max 696 chars) and so could never bite, then
 * applied here to anchor SOURCE, where it does (median 436, p95 3769, 30.3%
 * of symbols over the old 800 level). The arm no longer carries that feature;
 * see EPISODE_FEATURES in harness/episodeTelemetry.ts.
 */
function episodeArmSnippetChars(policy: ReturnType<typeof loadEpisodePolicy>): number {
	return policy.qna_snippet_chars;
}

/** Maps index hits to graph node rows (join on file + name + start line). */
export function hitsToRows(snapshot: GraphSnapshot, hits: IndexHit[]): number[] {
	const byKey = new Map<string, number>();
	const byLoose = new Map<string, number>();
	for (const n of snapshot.nodes) {
		byKey.set(`${n.file}\u0000${n.name}\u0000${n.start_line}`, n.row);
		if (!byLoose.has(`${n.file}\u0000${n.name}`)) {
			byLoose.set(`${n.file}\u0000${n.name}`, n.row);
		}
	}
	const rows: number[] = [];
	for (const h of hits) {
		const row =
			byKey.get(`${h.file}\u0000${h.name}\u0000${h.lines?.[0] ?? 0}`) ??
			byLoose.get(`${h.file}\u0000${h.name}`);
		if (row !== undefined && !rows.includes(row)) {
			rows.push(row);
		}
	}
	return rows;
}

/** One cited source in an answer, tagged by evidence class. */
export interface Citation {
	file: string;
	name: string;
	line: number;
	kind: 'static' | 'runtime' | 'stale';
}

export interface QnaEvidence {
	hits: IndexHit[];
	slice: GraphNode[];
	citations: Citation[];
	/** Markdown block describing everything the model saw. */
	contextMarkdown: string;
	decisionId: string;
	/** Walk mass per admitted row — the relevance math, auditable. */
	walkMass: Map<number, number>;
	/** The anchor rows the walk restarted at (seeds + resolved hits). */
	anchorRows: number[];
	/**
	 * Why retrieval returned nothing, when the index query itself FAILED (as
	 * opposed to legitimately matching nothing). Retrieval is degraded, not
	 * fatal, for a seeded question — the clicked node still anchors the walk —
	 * so this is reported rather than thrown, and the caller decides. Absent on
	 * every successful query.
	 */
	retrievalError?: string;
}

/**
 * Renders one observed failure as evidence the model can actually reason
 * about: identity (type + message), locus (traceback tail), path (observed
 * caller chain), and input (the arguments the failing call received).
 */
function renderFailure(f: FailureExemplar, indent: string): string {
	// Superseded failures render as one compact HISTORY line — present for
	// context, impossible to mistake for a live problem.
	if (f.superseded === 'not_reproduced') {
		return `${indent}- [RESOLVED] ${f.error_type}${f.error_message ? `: ${f.error_message}` : ''} — last seen at epoch ${f.capture_epoch ?? '?'} (×${f.count}); a later run of this symbol completed without it.`;
	}
	if (f.superseded === 'code_changed') {
		return `${indent}- [UNVERIFIED FIX] ${f.error_type}${f.error_message ? `: ${f.error_message}` : ''} — observed at epoch ${f.capture_epoch ?? '?'} (×${f.count}); the code has changed since and no fresh run has confirmed either way.`;
	}
	const lines: string[] = [];
	lines.push(
		`${indent}- ${f.error_type}${f.error_message ? `: ${f.error_message}` : ''} (×${f.count} observed, ${Math.round(f.duration_ms)}ms, request ${f.request_id || 'unknown'})`,
	);
	if (f.caller_chain.length) {
		lines.push(`${indent}  observed call path: ${[...f.caller_chain].reverse().join(' → ')} → (this symbol)`);
	}
	if (f.args_schema || f.args_summary) {
		const summary = f.args_summary ? ` ${JSON.stringify(f.args_summary)}` : '';
		lines.push(`${indent}  failing-call args: ${f.args_schema ?? ''}${summary}`);
	}
	if (f.error_stack) {
		lines.push(`${indent}  traceback (tail):`);
		lines.push('```');
		lines.push(f.error_stack.trim());
		lines.push('```');
	}
	return lines.join('\n');
}

/**
 * The SUBJECT section for a seeded question ("this file" / "this symbol").
 * When the user asks from a graph node, deixis must be resolved for the
 * model: which file "this" is, the file's preamble (imports — read from disk,
 * bounded by the first symbol's start line, so it is exactly the module
 * header and never a truncation of code), every symbol it defines, and its
 * DIRECTED relations — what it calls/imports and what calls it, from both
 * the static edges and the observed runtime flow. Without this the question
 * text alone drives retrieval and "what does this file call" matches noise.
 */
export function composeSubjectSection(
	workspaceRoot: string,
	snapshot: GraphSnapshot,
	seedRows: number[],
): string {
	const seedFiles = [...new Set(seedRows.map((r) => snapshot.nodes[r]?.file).filter(Boolean))];
	if (seedFiles.length === 0) {
		return '';
	}
	const lines: string[] = [];
	lines.push('## Question subject (what "this" refers to)');
	for (const file of seedFiles) {
		const rows = snapshot.nodes.filter((n) => n.file === file).map((n) => n.row);
		const rowSet = new Set(rows);
		lines.push(`\nThe question is about \`${file}\` (${rows.length} symbols).`);
		// Preamble = everything before the first symbol: module docstring and,
		// critically, the import block — the literal answer to "what does this
		// file call" for imports.
		const firstLine = Math.min(...rows.map((r) => snapshot.nodes[r].start_line));
		try {
			const src = fs.readFileSync(path.join(workspaceRoot, file), 'utf8').split('\n');
			const preamble = src.slice(0, Math.max(0, firstLine - 1)).join('\n').trim();
			if (preamble) {
				lines.push(`\nFile preamble (module header + imports):\n\`\`\`\n${preamble}\n\`\`\``);
			}
		} catch {
			// Unreadable file: the symbol list below still identifies the subject.
		}
		lines.push('\nSymbols defined here:');
		for (const r of rows) {
			const n = snapshot.nodes[r];
			lines.push(`- ${n.name} (${n.kind}) at line ${n.start_line}: ${n.summary}`);
		}
		// Directed relations, grouped per counterpart file so "which modules"
		// is answerable directly.
		const calls = new Map<string, Set<string>>();
		const calledBy = new Map<string, Set<string>>();
		const note = (map: Map<string, Set<string>>, row: number, via: string): void => {
			const n = snapshot.nodes[row];
			if (!n || n.file === file) {
				return;
			}
			const set = map.get(n.file) ?? new Set<string>();
			set.add(`${n.name}${via}`);
			map.set(n.file, set);
		};
		for (const e of snapshot.edges) {
			if (e.kind === 'contains') {
				continue;
			}
			if (rowSet.has(e.src)) {
				note(calls, e.dst, ` (${e.kind})`);
			}
			if (rowSet.has(e.dst)) {
				note(calledBy, e.src, ` (${e.kind})`);
			}
		}
		for (const f of snapshot.flow_edges) {
			if (rowSet.has(f.src)) {
				note(calls, f.dst, ` (observed ×${f.calls})`);
			}
			if (rowSet.has(f.dst)) {
				note(calledBy, f.src, ` (observed ×${f.calls})`);
			}
		}
		const emit = (title: string, map: Map<string, Set<string>>): void => {
			if (map.size === 0) {
				return;
			}
			lines.push(`\n${title}:`);
			for (const [target, names] of map) {
				lines.push(`- \`${target}\`: ${[...names].join(', ')}`);
			}
		};
		emit('This file calls / imports (static edges + observed runtime flow)', calls);
		emit('This file is called by', calledBy);
		if (calls.size === 0 && calledBy.size === 0) {
			lines.push(
				'\nNo static or observed cross-file relations are recorded for this file in the index.',
			);
		}
	}
	return lines.join('\n');
}

/**
 * Assembles the evidence bundle for a question: top index hits, a budgeted
 * graph-slice expansion around them, and runtime facts (calls/latency/errors +
 * staleness vs the store epoch) for every touched symbol. Also logs the
 * retrieval decision so panel feedback can reward it.
 */
export interface EvidenceOptions {
	topK?: number;
	sliceBudget?: number;
	seedRows?: number[];
	/** Additional anchor rows resolved by a retrial (missing-entity → anchor). */
	extraAnchorRows?: number[];
	/** Slice-budget multiplier applied by retrials (walk.retry_budget_growth^attempt). */
	budgetGrowth?: number;
	/** The previous attempt's insufficiency, embedded as context for the model. */
	priorInsufficiency?: { missing: string[]; note: string };
	/**
	 * Endpoint-scoped runtime context captured when the question was asked from
	 * a Call Tree view: the concrete entry-point→symbol path, its per-request
	 * runtime, coverage, and the runtime-only gap. Carries facts the graph walk
	 * structurally cannot reach — the walk knows lifetime per-symbol aggregates
	 * and undirected relevance, not which entry point was in play. Its
	 * `anchorRows` join the walk at full weight (see extraAnchorRows).
	 */
	callSite?: { markdown: string; anchorRows: number[] };
	/**
	 * Reuse a snapshot built once per QUESTION. Retrials accumulate anchor rows
	 * as raw indices; rebuilding the snapshot between attempts (while a
	 * concurrent reindex may shift rows) would silently re-point those anchors
	 * at different symbols. One snapshot per question makes rows stable for the
	 * whole retrial loop — and saves a full store read per attempt.
	 */
	snapshot?: GraphSnapshot;
	/**
	 * Live narration of the retrieval leg (sidecar cold start, index query).
	 * Every retrial attempt calls gatherEvidence again, so the panel keeps
	 * reporting instead of going quiet after the first pass.
	 */
	onProgress?: QnaProgress;
}

/**
 * The deictic search query for a seeded question: the question text grounded
 * with the subject's own identifiers so retrieval can't wander.
 */
export function seededSearchQuery(
	snapshot: GraphSnapshot,
	question: string,
	seedRows: number[],
): string {
	return seedRows.length > 0
		? `${question} ${seedRows
				.map((r) => `${snapshot.nodes[r].file} ${snapshot.nodes[r].name}`)
				.join(' ')}`
		: question;
}

/**
 * Pure evidence assembly: hits + snapshot → anchors → context walk → rendered
 * markdown. Everything after retrieval, with no vscode dependency — the exact
 * code the panel runs is therefore also drivable headlessly (e2e tests) and
 * by any other host.
 */
export function assembleEvidence(
	workspaceRoot: string,
	snapshot: GraphSnapshot,
	question: string,
	hits: IndexHit[],
	options?: EvidenceOptions,
): QnaEvidence {
	const episodePolicy = loadEpisodePolicy();
	const walk = walkParams(episodePolicy);
	const explicitSeeds = (options?.seedRows ?? []).filter(
		(r) => r >= 0 && r < snapshot.nodes.length,
	);
	// Anchors of the walk: explicit seeds carry full reset weight (the user
	// literally pointed at them); retrieval hits carry reciprocal-rank weight
	// 1/(k₀+r); retrial anchors carry full weight (they name what was missing).
	const hitRows = hitsToRows(snapshot, hits);
	// Deduped: a row that is both a seed and a retrial/hit anchor keeps its
	// strongest (first-listed) weight rather than accumulating reset mass.
	const anchorSeen = new Set<number>();
	const callSiteRows = (options?.callSite?.anchorRows ?? []).filter(
		(r) => r >= 0 && r < snapshot.nodes.length,
	);
	const anchors: WalkAnchor[] = [
		...explicitSeeds.map((row) => ({ row, weight: 1 })),
		...(options?.extraAnchorRows ?? [])
			.filter((r) => r >= 0 && r < snapshot.nodes.length)
			.map((row) => ({ row, weight: 1 })),
		// Every frame on the observed call path is a full-weight anchor: the
		// runtime proved they participate in the behaviour being asked about,
		// which is stronger evidence than any retrieval score.
		...callSiteRows.map((row) => ({ row, weight: 1 })),
		...hitRows.map((row, i) => ({ row, weight: rrfAnchorWeight(i, walk.rrf_k0) })),
	].filter((a) => {
		if (anchorSeen.has(a.row)) {
			return false;
		}
		anchorSeen.add(a.row);
		return true;
	});
	const budget = Math.ceil(
		(options?.sliceBudget ?? episodePolicy.slice_budget) * (options?.budgetGrowth ?? 1),
	);
	const walked = contextWalk(
		snapshot.nodes,
		snapshot.edges,
		snapshot.flow_edges,
		anchors,
		walk,
		budget,
	);
	const slice = walked.rows.map((row) => snapshot.nodes[row]).filter(Boolean);

	const decisionId = crypto.randomUUID();
	const citations: Citation[] = [];
	const lines: string[] = [];
	// The subject comes FIRST: for a seeded question the model must know what
	// "this" is before it reads anything retrieved.
	const subject = composeSubjectSection(workspaceRoot, snapshot, explicitSeeds);
	if (subject) {
		lines.push(subject);
		lines.push('');
	}
	// The call path comes before retrieved evidence for the same reason the
	// subject does: it establishes WHICH execution of the symbol is being asked
	// about, so everything below is read in that frame.
	if (options?.callSite?.markdown) {
		lines.push(options.callSite.markdown);
		lines.push('');
	}
	if (options?.priorInsufficiency) {
		lines.push('## Previous attempt was judged insufficient');
		lines.push('');
		lines.push(options.priorInsufficiency.note);
		if (options.priorInsufficiency.missing.length) {
			lines.push(
				`It reported these as missing: ${options.priorInsufficiency.missing.join('; ')}. ` +
					'The context below was re-gathered with those as additional anchors.',
			);
		}
		lines.push('');
	}
	// Per-symbol snippet budget comes from the learned arm, matching what the
	// episode packs use — one budget, learned, no second hardcoded cap.
	const snippetChars = episodeArmSnippetChars(episodePolicy);
	// Anchor symbols carry their SOURCE (semantic zoom: full detail at the
	// focus, summaries in the periphery). Without this the model must reason
	// about the very symbol the question points at from a one-line summary.
	const anchorRowSet = [
		...new Set([...explicitSeeds, ...(options?.extraAnchorRows ?? [])]),
	].filter((r) => r >= 0 && r < snapshot.nodes.length);
	if (anchorRowSet.length) {
		// The INDEXED text is the version the ranks, edges, and traces describe
		// (reading the live file by stored line numbers returns the wrong code
		// once functions move). Disk is compared exactly to flag drift.
		const chunkTexts = loadChunkTexts(indexStoreDir(workspaceRoot), anchorRowSet);
		lines.push('## Anchor symbol source (the code the question is about)');
		for (const row of anchorRowSet) {
			const n = snapshot.nodes[row];
			const indexed = chunkTexts.get(row);
			let diskSegment: string | undefined;
			try {
				diskSegment = fs
					.readFileSync(path.join(workspaceRoot, n.file), 'utf8')
					.split('\n')
					.slice(Math.max(0, n.start_line - 1), n.end_line)
					.join('\n');
			} catch {
				// File unreadable (deleted/moved): the indexed text still stands.
			}
			const body = indexed ?? diskSegment;
			if (!body) {
				continue;
			}
			// The anchor's snippet budget grows with the SAME retrial factor as
			// the node budget — otherwise a truncated seed body makes the
			// sufficiency verdict permanently unsatisfiable (the model keeps
			// asking for the rest of the code retrials can never provide).
			const anchorChars = Math.ceil(snippetChars * (options?.budgetGrowth ?? 1));
			let entry = `### ${n.name} — ${n.file}:${n.start_line}-${n.end_line} (as indexed, epoch ${n.epoch})\n\`\`\`${n.lang}\n${body.slice(0, anchorChars)}\n\`\`\``;
			// A body cut mid-function inside a fence is indistinguishable from a
			// short function. The anchor is the symbol the question is ABOUT, so a
			// silent cut is the worst one available: measured on this repo, 30.3%
			// of symbols exceed the 800-char level. Say what was withheld and how
			// to get it — the same stated-size-plus-escape-hatch the context pack
			// uses, rather than leaving the model to infer completeness.
			if (body.length > anchorChars) {
				entry +=
					`\nNOTE: source truncated — showing ${anchorChars} of ${body.length} characters. ` +
					`Read \`${n.file}\` lines ${n.start_line}-${n.end_line} for the rest.`;
			}
			if (indexed !== undefined && diskSegment !== undefined && indexed.trim() !== diskSegment.trim()) {
				entry +=
					'\nNOTE: the file has changed on disk since this was indexed — line numbers and code above reflect the indexed epoch (which is what the runtime traces were captured against).';
			}
			lines.push(entry);
		}
		lines.push('');
	}
	lines.push(`## Retrieved symbols (top ${hits.length})`);
	for (const h of hits) {
		const snippet = h.snippet ?? '';
		const shown = snippet.slice(0, snippetChars);
		lines.push(
			`### ${h.name} (${h.kind}) — ${h.file}:${h.lines?.[0] ?? '?'}\n` +
				`${h.summary}\n\n\`\`\`${h.lang}\n${shown}\n\`\`\`` +
				(snippet.length > snippetChars
					? `\nNOTE: snippet truncated — showing ${snippetChars} of ${snippet.length} characters. ` +
						`Read \`${h.file}\` for the rest.`
					: ''),
		);
	}
	// Unambiguous failure attribution FIRST: exactly which symbols raised, per
	// the captures. CURRENT failures only — an error retired by a later clean
	// run (or awaiting one after a code change) must never read as live.
	const currentOf = (row: number): FailureExemplar[] =>
		(snapshot.runtime[row]?.failures ?? []).filter((f) => f.superseded === null);
	// current_errors is the source of truth for "failing now". An exemplar may
	// be absent (dropped by the storage cap) even when current_errors > 0 — the
	// digest must still name the site so it never diverges from the issue list.
	const isFailingNow = (row: number): boolean =>
		(snapshot.runtime[row]?.current_errors ?? 0) > 0 || currentOf(row).length > 0;
	const failureSites = slice.filter((n) => isFailingNow(n.row));
	if (failureSites.length) {
		lines.push('\n## Observed failure sites (runtime ground truth — errors were raised IN these symbols and nowhere else)');
		for (const n of failureSites) {
			const cur = currentOf(n.row).slice(0, walk.failure_exemplars);
			if (cur.length) {
				for (const f of cur) {
					lines.push(
						`- \`${n.name}\` (${n.file}:${n.start_line}) raised ${f.error_type}${f.error_message ? `: ${f.error_message}` : ''} ×${f.count}` +
							(f.caller_chain.length
								? ` — reached via ${[...f.caller_chain].reverse().join(' → ')} → \`${n.name}\``
								: ''),
					);
				}
			} else {
				// current_errors > 0 but no stored exemplar: name it from types.
				const rt = snapshot.runtime[n.row];
				lines.push(
					`- \`${n.name}\` (${n.file}:${n.start_line}) raised ${rt.current_errors} error(s) in the latest run (${rt.error_types.join(', ') || 'type not recorded'})`,
				);
			}
		}
	}
	const resolvedSites = slice.filter(
		(n) =>
			currentOf(n.row).length === 0 &&
			(snapshot.runtime[n.row]?.failures ?? []).some((f) => f.superseded !== null),
	);
	if (resolvedSites.length) {
		lines.push('\n## Previously observed failures now superseded (history — NOT live problems)');
		for (const n of resolvedSites) {
			for (const f of (snapshot.runtime[n.row]?.failures ?? [])
				.filter((x) => x.superseded !== null)
				.slice(0, walk.failure_exemplars)) {
				lines.push(renderFailure(f, '').replace(/^- /, `- \`${n.name}\` (${n.file}:${n.start_line}): `));
			}
		}
	}
	// The slice is the context walk's stationary distribution, budget-cut.
	// Every entry shows its walk mass so relevance is auditable, and every
	// runtime fact carries its full evidence (message, path, args, traceback).
	lines.push(
		`\n## Graph slice (${slice.length} symbols by context-walk relevance; ` +
			`personalized PageRank from ${walked.rows.length ? anchors.length : 0} anchors)`,
	);
	// Traceability boundary, derived from the captures themselves: languages
	// with ANY runtime overlay are traced; symbols in other languages carry no
	// runtime facts because no tracer observed them — absence of evidence, not
	// evidence of health. Without this line the model conflates the two.
	const tracedLangs = [
		...new Set(
			Object.keys(snapshot.runtime)
				.map((row) => snapshot.nodes[Number(row)]?.lang)
				.filter((l): l is string => Boolean(l)),
		),
	];
	const untracedLangs = [
		...new Set(slice.map((n) => n.lang).filter((l) => l && !tracedLangs.includes(l))),
	];
	if (tracedLangs.length > 0 && untracedLangs.length > 0) {
		lines.push(
			`Runtime evidence in this workspace exists only for ${tracedLangs.join(', ')} symbols; ` +
				`${untracedLangs.join(', ')} symbols below are UNTRACED (no runtime facts are possible for them yet), ` +
				'which is not evidence they are healthy.',
		);
	}
	for (const n of slice) {
		const rt = snapshot.runtime[n.row];
		const stale = snapshot.store_epoch > 0 && rt && n.epoch === snapshot.store_epoch;
		const kind: Citation['kind'] = stale ? 'stale' : rt ? 'runtime' : 'static';
		citations.push({ file: n.file, name: n.name, line: n.start_line, kind });
		const mass = walked.mass.get(n.row);
		let entry = `- ${n.name} (${n.kind}, ${n.layer}) — ${n.file}:${n.start_line}`;
		if (mass !== undefined) {
			entry += ` (walk mass ${mass.toExponential(2)})`;
		}
		entry += `: ${n.summary}`;
		if (rt) {
			entry += ` [runtime: ×${rt.calls} calls, ${Math.round(rt.total_ms)}ms total`;
			if (rt.errors > 0) {
				entry += `, ${rt.errors} lifetime errors (${rt.error_types.join(', ')})`;
				entry += `; latest run${rt.latest_epoch !== null ? ` (epoch ${rt.latest_epoch})` : ''}: ${rt.current_errors} error(s)`;
			}
			entry += stale
				? '; NOTE this symbol changed after the trace was captured — runtime facts may be stale]'
				: ']';
		}
		lines.push(entry);
		// Current failures first (full evidence), then superseded history
		// (compact) — both within the same learned exemplar budget.
		const ordered = [...(rt?.failures ?? [])].sort(
			(a, b) => Number(a.superseded !== null) - Number(b.superseded !== null) || b.count - a.count,
		);
		for (const f of ordered.slice(0, walk.failure_exemplars)) {
			lines.push(renderFailure(f, '  '));
		}
		// Inputs observed for SUCCESSFUL calls — the actual arguments a symbol ran
		// with (e.g. page_size), which no failure exemplar would carry.
		for (const a of (rt?.arg_exemplars ?? []).slice(0, walk.failure_exemplars)) {
			const summary = a.args_summary ? ` ${JSON.stringify(a.args_summary)}` : '';
			lines.push(
				`  observed call args${a.count > 1 ? ` (×${a.count})` : ''}: ${a.args_schema ?? ''}${summary}` +
					(a.max_duration_ms ? ` — up to ${Math.round(a.max_duration_ms)}ms` : ''),
			);
		}
	}
	// Cross-session runtime analyses — the SAME Pareto-relative computations
	// the episode triggers use (no thresholds), rendered so performance,
	// memory, and recomputation questions are answered from measured ground
	// truth instead of static guesswork. Per-symbol facts above show local
	// cost; these show the workspace-wide ranking a "what is slow / leaking /
	// wasteful" question actually needs. Omitted entirely when no overlay
	// exists (nothing measured — nothing to claim).
	if (Object.keys(snapshot.runtime).length > 0) {
		// Every heading in this section states its bound. The reader here is an
		// AGENT, and an agent shown three candidates with no total concludes there
		// are three — any plan it then writes ("I've addressed the memoization
		// opportunities") is false by construction. A human reading a panel can
		// click through; this is the evidence the model reasons from.
		const hot = selectHotspots(snapshot.nodes, snapshot.runtime);
		const hotspots = hot.items;
		if (hotspots.length > 0) {
			lines.push('\n## Runtime cost analyses (measured across all captures)');
			lines.push(
				`Latency Pareto head (share of ALL traced time) — ${describeLineage(hot.lineage, 'hotspot')}:`,
			);
			for (const h of hotspots) {
				lines.push(
					`- ${h.name} (${h.file}:${h.line}) — ${Math.round(h.total_ms)}ms over ${h.calls} call(s), ${(h.share * 100).toFixed(1)}% of traced time`,
				);
			}
		}
		const trends = collectMemoryTrends(workspaceRoot, snapshot.nodes);
		if (trends.length > 0) {
			// collectMemoryTrends returns everything it found — no analysis bound —
			// so the only cap here is this display one, and it says so.
			const shownTrends = trends.slice(0, walk.failure_exemplars);
			lines.push(
				'Memory-leak suspects (retained in EVERY session, positive Theil–Sen trend)' +
					(trends.length > shownTrends.length
						? ` — showing the top ${shownTrends.length} of ${trends.length}`
						: '') +
					':',
			);
			for (const s of shownTrends) {
				lines.push(
					`- ${s.name} (${s.file}:${s.line}) — ${Math.round(s.total_retained_bytes / 1024)}KB over ${s.sessions} sessions, +${Math.round(s.slope_bytes_per_session / 1024)}KB/session`,
				);
			}
		} else if (hotspots.length > 0) {
			lines.push(
				'Memory-leak suspects: none detected (needs 3+ capture sessions with persistent retention).',
			);
		}
		const cache = collectCacheCandidates(workspaceRoot, snapshot.nodes);
		const cacheable = cache.items;
		if (cacheable.length > 0) {
			// TWO bounds stack here: the analysis Pareto head, and this display cap
			// on top of it. Measured on this repo the chain is 24 found -> 4 ranked
			// -> 3 shown, and the heading used to say none of it.
			//
			// The display cap is APPENDED to the lineage rather than described in a
			// trailing clause, because it is a bound like any other and belongs in
			// the same accounting. It is a 'cap': slicing the top N measures
			// nothing about what it removed, so chainStatus correctly refuses to
			// call this chain complete.
			const shownCache = cacheable.slice(0, walk.failure_exemplars);
			const rankedMs = cacheable.reduce((s, c) => s + c.reclaimable_ms, 0);
			const shownMs = shownCache.reduce((s, c) => s + c.reclaimable_ms, 0);
			const cacheLineage =
				shownCache.length < cacheable.length
					? [
							...cache.lineage,
							selectionStage('display-cap', {
								returned: shownCache.length,
								total: cacheable.length,
								coverage_achieved: rankedMs > 0 ? shownMs / rankedMs : 0,
								stopped_by: 'cap',
								droppedMagnitude: rankedMs - shownMs,
								unit: 'ms',
							}),
						]
					: cache.lineage;
			lines.push(
				`Duplicate-recomputation (memoization) candidates — ${describeLineage(cacheLineage, 'candidate')}:`,
			);
			for (const c of shownCache) {
				lines.push(
					`- ${c.name} (${c.file}:${c.line}) — ${c.calls} calls, only ${c.distinct_args} distinct arg hash(es), ~${Math.round(c.reclaimable_ms)}ms reclaimable`,
				);
			}
		}
	}
	return {
		hits,
		slice,
		citations,
		contextMarkdown: lines.join('\n'),
		decisionId,
		walkMass: walked.mass,
		anchorRows: anchors.map((a) => a.row),
	};
}

/**
 * The panel's evidence entry point: retrieval (index binary) + assembly + the
 * retrieval-decision telemetry that lets panel feedback reward this decision.
 * Budgets come from the LEARNED policies, not constants: top-k from the
 * retrieval policy for this store epoch when one has been promoted, walk
 * parameters and slice budget from the episode policy.
 */
export async function gatherEvidence(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	question: string,
	options?: EvidenceOptions,
): Promise<QnaEvidence> {
	const epoch = retrievalEpoch(indexStoreDir(workspaceRoot));
	const learnedTopK = loadPolicyForEpoch(epoch)?.top_k;
	const topK = options?.topK ?? learnedTopK ?? 5;
	const snapshot = options?.snapshot ?? buildGraphSnapshot(workspaceRoot);
	const seeds = (options?.seedRows ?? []).filter((r) => r >= 0 && r < snapshot.nodes.length);
	let hits: IndexHit[] = [];
	let retrievalError: string | undefined;
	try {
		hits = await runIndexQuery(
			context,
			workspaceRoot,
			seededSearchQuery(snapshot, question, seeds),
			topK,
			options?.onProgress,
		);
	} catch (e) {
		// No embeddings/key or empty store: continue with graph-only evidence —
		// which is real evidence for a SEEDED question (the node the user clicked
		// anchors the walk) and is nothing at all without one. Kept on the result
		// instead of being dropped: callers that have no other anchor must be able
		// to tell "found nothing" from "could not look".
		retrievalError = e instanceof Error ? e.message : String(e);
	}
	const evidence = assembleEvidence(workspaceRoot, snapshot, question, hits, options);
	if (retrievalError) {
		evidence.retrievalError = retrievalError;
	}
	appendRetrievalEvent({
		type: 'decision',
		ts: new Date().toISOString(),
		decision_id: evidence.decisionId,
		epoch,
		surface: 'qna',
		features: queryFeatures(question),
		action: { top_k: topK, policy: learnedTopK !== undefined ? 'active' : 'baseline' },
		served_top_k: topK,
		propensity: 1,
		result_count: hits.length,
	});
	return evidence;
}

/**
 * Records feedback against the answer's decision. `source` distinguishes the
 * panel's thumbs ('explicit') from the deterministic critic ('critic'): the
 * off-policy pipeline keeps one event per (decision_id, source) and
 * prioritizes 'explicit', so a critic bit never overwrites a human signal.
 */
export function recordQnaFeedback(
	workspaceRoot: string,
	decisionId: string,
	reward: number,
	// 'implicit' = a behavioral signal (the user re-asked a near-identical
	// question without grading the answer — the classic reformulation-as-
	// dissatisfaction IR signal). Kept as its own source so off-policy
	// evaluation never silently mixes it with explicit thumbs or the critic.
	source: 'explicit' | 'critic' | 'implicit' = 'explicit',
): void {
	appendRetrievalEvent({
		type: 'feedback',
		ts: new Date().toISOString(),
		decision_id: decisionId,
		epoch: retrievalEpoch(indexStoreDir(workspaceRoot)),
		surface: 'qna',
		source,
		reward: Math.max(-1, Math.min(1, reward)),
	});
}

/**
 * Records that a thumbs-DOWN answer surfaced these files for this question —
 * negative alias evidence.
 *
 * STAGED TELEMETRY (honest status): this is currently write-only. The events
 * accumulate the evidence a future enrichment consumer will need to de-weight
 * aliases that repeatedly mislead (the intended acting threshold is 2+
 * independent negatives). No consumer reads it yet, and enrichTagsFromFeedback
 * only ADDS aliases from positive feedback — so today this changes nothing
 * except the durable record. It is deliberately inert rather than
 * delete-on-single-negative: a lone thumbs-down is too noisy to act on, and
 * an over-eager de-weighting would degrade retrieval. Wired as data first,
 * behavior second.
 */
export function recordNegativeTagEvidence(
	workspaceRoot: string,
	decisionId: string,
	question: string,
	files: string[],
): void {
	appendRetrievalEvent({
		type: 'negative_tag_evidence',
		ts: new Date().toISOString(),
		decision_id: decisionId,
		epoch: retrievalEpoch(indexStoreDir(workspaceRoot)),
		query_hash: crypto.createHash('sha256').update(question).digest('hex').slice(0, 24),
		files: files.slice(0, 12),
	});
}

const SYSTEM_PROMPT_BASE =
	'You are Vinv, a codebase copilot with access to runtime ground truth. ' +
	'Answer the question using ONLY the provided static symbols, graph slice, and runtime evidence. ' +
	'Cite symbols as `file:line` when you reference them. Distinguish clearly between what the code ' +
	'says (static) and what actually happened at runtime (trace evidence), and call out stale evidence. ' +
	'If the provided context is insufficient, say what is missing instead of guessing.\n\n';

const VERDICT_PLAIN =
	'End EVERY answer with a machine-readable sufficiency verdict on its own line, exactly:\n' +
	'```json\n{"sufficient": true|false, "missing": ["<named symbol, file, value, or evidence kind>", ...]}\n```\n' +
	'Set "sufficient": false whenever your answer had to hedge because evidence was absent, and name ' +
	'each missing item concretely — Vinv re-walks the context graph anchored on what you name and asks again.';

/**
 * The escalation-channel verdict: `missing` widened with typed, read-only
 * evidence requests Vinv can execute between attempts. Only served when the
 * qnaEscalation flag is shadow/on — the default path's prompt is unchanged.
 */
const VERDICT_WITH_ACTIONS =
	'End EVERY answer with a machine-readable sufficiency verdict on its own line, exactly:\n' +
	'```json\n{"sufficient": true|false, "missing": ["<named symbol/file/value/evidence kind>", ...], ' +
	'"actions": [{"kind": "search|read|walk|runtime", "target": "<query or symbol/file name>"}, ...]}\n```\n' +
	'Set "sufficient": false whenever your answer had to hedge because evidence was absent. Alongside ' +
	'`missing`, you may request read-only evidence actions Vinv executes before asking you again: ' +
	'search (a fresh index query), read (full indexed source of a named symbol/file), walk (re-walk the ' +
	'graph anchored on named symbols), runtime (runtime facts for a named symbol). Name concrete targets.';

/** Verdict channel selector for buildQnaPrompt. */
export type VerdictChannel = 'plain' | 'actions';

/**
 * One read-only evidence action the model may request in its verdict when the
 * escalation channel is enabled. Every action resolves to graph rows and joins
 * the next walk as full-weight anchors — the typed, richer sibling of a
 * `missing` string, executed against the same surfaces the walk already uses.
 */
export interface VerdictAction {
	kind: 'search' | 'read' | 'walk' | 'runtime';
	/** Query text (search) or symbol/file names (read/walk/runtime). */
	target: string;
}

/** The model's self-reported evidence verdict, parsed from the answer tail. */
export interface SufficiencyVerdict {
	sufficient: boolean;
	missing: string[];
	/** Typed evidence requests (escalation channel; empty when absent/off). */
	actions: VerdictAction[];
	/** The answer with the verdict block stripped (what the user sees). */
	body: string;
	/**
	 * True when no well-formed verdict was found and the lenient default
	 * (sufficient) applied. Kept so callers can LOG the anomaly — a truncated
	 * answer that lost its verdict must not silently count as a success.
	 */
	defaulted: boolean;
}

/**
 * Parses the trailing sufficiency verdict. A missing/malformed verdict counts
 * as sufficient — retrials only trigger on an explicit, well-formed "false",
 * so a model that ignores the protocol degrades to today's single-shot flow.
 *
 * Deliberately fence-tolerant: the verdict is the LAST brace-balanced JSON
 * object containing a "sufficient" key, whether or not the model closed (or
 * even opened) the ```json fence — dropped closing fences are common enough
 * that requiring one silently disables the retrial loop.
 */
export function parseSufficiency(answer: string): SufficiencyVerdict {
	const text = answer.trimEnd();
	const keyAt = text.lastIndexOf('"sufficient"');
	const open = keyAt === -1 ? -1 : text.lastIndexOf('{', keyAt);
	if (open === -1) {
		return { sufficient: true, missing: [], actions: [], body: answer, defaulted: true };
	}
	let depth = 0;
	let end = -1;
	let inString = false;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === '\\') {
				i += 1;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === '{') {
			depth += 1;
		} else if (ch === '}') {
			depth -= 1;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) {
		return { sufficient: true, missing: [], actions: [], body: answer, defaulted: true };
	}
	try {
		const parsed = JSON.parse(text.slice(open, end + 1)) as {
			sufficient?: unknown;
			missing?: unknown;
			actions?: unknown;
		};
		const missing = Array.isArray(parsed.missing)
			? parsed.missing.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
			: [];
		const kinds = new Set(['search', 'read', 'walk', 'runtime']);
		const actions: VerdictAction[] = Array.isArray(parsed.actions)
			? parsed.actions.flatMap((a): VerdictAction[] => {
					const kind = (a as VerdictAction)?.kind;
					const target = (a as VerdictAction)?.target;
					return typeof kind === 'string' &&
						kinds.has(kind) &&
						typeof target === 'string' &&
						target.trim() !== ''
						? [{ kind: kind as VerdictAction['kind'], target: target.trim() }]
						: [];
				})
			: [];
		// Strip the verdict (and its opening fence, when present) from the body.
		let cut = open;
		const fenceAt = text.lastIndexOf('```', open);
		if (fenceAt !== -1 && /^```(json)?\s*$/.test(text.slice(fenceAt, open).trim())) {
			cut = fenceAt;
		}
		return {
			sufficient: parsed.sufficient !== false,
			missing,
			actions,
			body: text.slice(0, cut).trimEnd(),
			defaulted: false,
		};
	} catch {
		return { sufficient: true, missing: [], actions: [], body: answer, defaulted: true };
	}
}

/**
 * Deterministic symbol grounding for critique/issue text: rows whose symbol
 * name appears verbatim (word-aligned) in the text. Verdicts and stack traces
 * carry exact identifiers, and an exact join beats embedding similarity for
 * those — the graph-retrieval equivalent of HippoRAG's entity anchoring.
 */
export function nameMatchRows(snapshot: GraphSnapshot, text: string, cap: number): number[] {
	return groundSymbolMentions(snapshot.nodes, text, cap);
}

/**
 * Maps an insufficiency verdict onto retrieval parameters — the CRAG-style
 * corrective step. Every missing item the model named is resolved to graph
 * rows two ways: exact word-aligned symbol-name joins (identifiers named in
 * the critique), plus the SAME index search the first pass used (for items
 * described rather than named). Those rows become full-weight anchors of the
 * next walk.
 */
export async function resolveMissingAnchors(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	snapshot: GraphSnapshot,
	missing: string[],
	topKPerItem: number,
	missingCap?: number,
): Promise<number[]> {
	const rows: number[] = [];
	const add = (row: number): void => {
		if (!rows.includes(row)) {
			rows.push(row);
		}
	};
	// The word-aligned name join is cheap and runs for EVERY item; the index
	// search stratum (one subprocess + one embedding call per item) is capped
	// by the learned retry_missing_cap so a model naming twenty gaps cannot
	// spawn twenty binaries.
	const searchable = missingCap !== undefined ? missing.slice(0, missingCap) : missing;
	for (const item of missing) {
		for (const row of nameMatchRows(snapshot, item, topKPerItem)) {
			add(row);
		}
	}
	for (const item of searchable) {
		try {
			const hits = await runIndexQuery(context, workspaceRoot, item, topKPerItem);
			for (const row of hitsToRows(snapshot, hits)) {
				add(row);
			}
		} catch {
			// Index unavailable for this item — the retrial proceeds with the
			// anchors that did resolve (and the grown budget).
		}
	}
	return rows;
}

/** Re-exported so panel code can honor the learned retrial parameters. */
export function qnaWalkParams(): WalkParams {
	return walkParams(loadEpisodePolicy());
}

/**
 * Executes the verdict's typed evidence actions — READ-ONLY, against the same
 * surfaces the walk already uses — and returns the graph rows they resolve to.
 * Every action degrades to anchor rows for the next walk: `search` runs a
 * fresh index query (capped by the same learned retry_missing_cap that bounds
 * `missing` fan-out); `read`/`walk`/`runtime` ground their named targets with
 * the word-aligned symbol join. Rows returned as anchors get full source
 * (read), pull their neighborhoods into the slice (walk), and render their
 * runtime overlay (runtime) through the EXISTING assembly — no parallel
 * evidence mechanism.
 */
export async function resolveVerdictActions(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	snapshot: GraphSnapshot,
	actions: VerdictAction[],
	topKPerItem: number,
	searchCap?: number,
): Promise<number[]> {
	const rows: number[] = [];
	const add = (row: number): void => {
		if (!rows.includes(row)) {
			rows.push(row);
		}
	};
	let searches = 0;
	for (const a of actions) {
		if (a.kind === 'search') {
			if (searchCap !== undefined && searches >= searchCap) {
				continue;
			}
			searches += 1;
			try {
				const hits = await runIndexQuery(context, workspaceRoot, a.target, topKPerItem);
				for (const row of hitsToRows(snapshot, hits)) {
					add(row);
				}
			} catch {
				// Index unavailable — the remaining actions still resolve.
			}
		} else {
			for (const row of nameMatchRows(snapshot, a.target, topKPerItem)) {
				add(row);
			}
		}
	}
	return rows;
}

/** Builds the full prompt for either the cloud LLM or the harness CLI. */
export function buildQnaPrompt(
	question: string,
	evidence: QnaEvidence,
	channel: VerdictChannel = 'plain',
): string {
	const system =
		SYSTEM_PROMPT_BASE + (channel === 'actions' ? VERDICT_WITH_ACTIONS : VERDICT_PLAIN);
	return `${system}\n\n# Question\n${question}\n\n# Context\n${evidence.contextMarkdown}\n\n# Answer`;
}

/** One turn of a model conversation. */
export interface ChatTurn {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

/**
 * Multi-turn chat through the user's coding-harness CLI — the shared plumbing
 * for QnA-adjacent agents (the graph enhancer's adjudication/tag agents, which
 * hold contract-violation retry conversations). The conversation is flattened
 * into a single prompt per call; the CLI's stdout is the reply.
 */
export function chatViaHarness(
	workspaceRoot: string,
): (messages: ChatTurn[]) => Promise<string> {
	return async (messages: ChatTurn[]): Promise<string> => {
		const prompt = messages
			.map((m) =>
				m.role === 'system'
					? m.content
					: `# ${m.role === 'user' ? 'User' : 'Your previous reply'}\n${m.content}`,
			)
			.join('\n\n');
		const run = await runHarnessPrompt(getHarnessId(), workspaceRoot, 'chat', prompt);
		if (!run.ok) {
			throw new Error(run.detail ?? 'harness run failed');
		}
		const text = run.stdout.trim();
		if (!text) {
			throw new Error('the harness returned an empty answer');
		}
		return text;
	};
}
