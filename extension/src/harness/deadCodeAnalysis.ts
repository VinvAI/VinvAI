/**
 * What the dead code DOES, and what to do with it — asked in batches.
 *
 * A dead-code section is a question no static analysis answers: the graph can
 * prove nothing executed `refund_partial`, and cannot say whether that is a
 * feature that was never shipped, a migration half-finished, or a helper made
 * redundant three refactors ago. Only reading it answers that, so this hands
 * sections to the coding harness and asks for three things per section — what it
 * does, why nothing reaches it, and how it would be integrated or re-imagined.
 *
 * BATCHED, for the reason `agentChannel` is batched: a run per section is a bill
 * that grows with the repo, and dead code is exactly the finding that arrives
 * forty at a time. Sections travel `SECTIONS_PER_BATCH` to a prompt, batches run
 * `MAX_CONCURRENT_BATCHES` at a time, and the reply is one JSON envelope keyed by
 * section id so a batch that only understood three of its five still lands those
 * three. Nothing here takes the episode lock — `dispatchAgentPrompt` is the
 * lock-free channel the verification agents already fan out on.
 *
 * The batch is also better ANALYSIS, not only cheaper: sections in one prompt are
 * visible to each other, so the agent can say "this is the older copy of the
 * section below" — a judgment a per-section run structurally cannot reach.
 *
 * Honest on failure, same rule as the channel drain: a section the harness did
 * not answer keeps no verdict at all. A fabricated "probably safe to delete"
 * would be strictly worse than silence, because deletion is the one action here
 * that cannot be undone by reading more code.
 */

import * as fs from 'fs';
import * as path from 'path';

import { indexStoreDir, loadChunkTexts, type GraphSnapshot } from '../graph/indexGraph';
import { parseEnvelope } from './agentChannel';
import type { DeadSection } from '../views/deadCodeModel';

/** Sections per harness run. Enough to compare, few enough to read carefully. */
export const SECTIONS_PER_BATCH = 5;
/** Batches in flight at once. */
export const MAX_CONCURRENT_BATCHES = 4;
/** Source characters carried per symbol, and per batch overall. */
const MAX_SYMBOL_CHARS = 1_800;
const MAX_BATCH_CHARS = 60_000;
/** Symbols whose source is inlined per section (the rest travel as signatures). */
const MAX_SOURCED_SYMBOLS = 8;

/** What to do with a section, in the agent's judgment. */
export type DeadCodeAction = 'integrate' | 'reimagine' | 'delete' | 'keep' | 'unclear';

/** One section's verdict. Every field is the agent's, none is derived. */
export interface DeadSectionVerdict {
	id: string;
	/** Plain-language account of what the code does. */
	what: string;
	/** Why nothing reaches it — the agent's reading, not the graph's inference. */
	why: string;
	action: DeadCodeAction;
	/** Concrete steps to wire it back in, when `action` is integrate. */
	integrate: string;
	/** What it could become instead, when `action` is reimagine. */
	reimagine: string;
	/** What breaks or is lost if it is removed. Asked for every action. */
	risk: string;
	confidence: 'high' | 'medium' | 'low';
}

export interface DeadCodeAnalysis {
	schemaVersion: 1;
	/** Index epoch the verdicts were formed against — stale ones are visible, not hidden. */
	storeEpoch: number;
	generatedAt: string;
	verdicts: Record<string, DeadSectionVerdict>;
}

/** The `dispatchAgentPrompt` shape, injected so batching is testable offline. */
export type AgentDispatch = (name: string, prompt: string) => Promise<string | null>;

export interface BatchOutcome {
	/** Sections handed to the harness. */
	requested: number;
	/** Sections a usable verdict came back for. */
	answered: number;
	/** Harness runs actually spawned. */
	batches: number;
	verdicts: Record<string, DeadSectionVerdict>;
	/** Why coverage is short, when it is. Empty string when everything landed. */
	detail: string;
}

/**
 * Underscore, not a hyphen: the section reports are `deadcode-<id>.json` and the
 * custom editor claims `deadcode-[0-9a-f]*.json`, so a `deadcode-analysis.json`
 * would be opened as a section report and render as a corrupt one.
 */
export function analysisPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'deadcode_analysis.json');
}

export function readAnalysis(workspaceRoot: string): DeadCodeAnalysis | null {
	try {
		const doc = JSON.parse(fs.readFileSync(analysisPath(workspaceRoot), 'utf8')) as DeadCodeAnalysis;
		return doc && typeof doc === 'object' && doc.verdicts ? doc : null;
	} catch {
		return null;
	}
}

/**
 * Merges new verdicts over stored ones and writes the file.
 *
 * Merge, never replace: a run that analysed five sections must not erase the
 * thirty-five a previous run explained. Sections whose code changed get a fresh
 * id from `sectionId`, so a stale verdict is orphaned rather than silently
 * reattached to code it never described.
 */
export function writeAnalysis(
	workspaceRoot: string,
	storeEpoch: number,
	verdicts: Record<string, DeadSectionVerdict>,
): string {
	const file = analysisPath(workspaceRoot);
	const prior = readAnalysis(workspaceRoot);
	const doc: DeadCodeAnalysis = {
		schemaVersion: 1,
		storeEpoch,
		generatedAt: new Date().toISOString(),
		verdicts: { ...(prior?.verdicts ?? {}), ...verdicts },
	};
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
	return file;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** One live symbol retrieved as context for a dead section's prompt. */
export interface LiveContextSymbol {
	name: string;
	file: string;
	line: number;
	summary: string;
	/** PPR mass — meaningful only relative to siblings in the same retrieval. */
	score: number;
}

/** How many live-neighbourhood symbols ride along per section. */
const CONTEXT_SYMBOLS = 6;

/**
 * Multi-hop live context for each section — HippoRAG's retrieval step, run over
 * the code graph we already have.
 *
 * HippoRAG's insight is that single-hop retrieval misses associative context,
 * and that Personalized PageRank seeded at the query's entities over a knowledge
 * graph finds the multi-hop neighbourhood a flat similarity search cannot. The
 * Vinv index IS such a graph — symbols as entities, invoke/inherit edges as
 * relations, observed flow edges as the runtime-confirmed subset — so the idea
 * ports without the package: seed PPR at the dead section's symbols, walk, and
 * keep the highest-mass TRACED symbols outside the section. That is "the live
 * code most associated with this dead island, within a few hops", which is
 * exactly what an agent needs to judge integration: the neighbourhood it would
 * wire the section back into. (The hipporag package itself is a Python
 * LLM+embedding pipeline — a heavy dependency for what is, here, forty lines of
 * power iteration over data already on disk.)
 *
 * Built once per analysis run and closed over per section, because the adjacency
 * build is the expensive part and it is identical for every section.
 */
export function buildContextRetriever(
	snap: GraphSnapshot,
	k = CONTEXT_SYMBOLS,
): (section: DeadSection) => LiveContextSymbol[] {
	const index = new Map<number, number>();
	snap.nodes.forEach((n, i) => index.set(n.row, i));
	const n = snap.nodes.length;
	const neighbours: number[][] = Array.from({ length: n }, () => []);
	const link = (a: number, b: number): void => {
		const ia = index.get(a);
		const ib = index.get(b);
		if (ia === undefined || ib === undefined || ia === ib) {
			return;
		}
		neighbours[ia].push(ib);
		neighbours[ib].push(ia);
	};
	for (const e of snap.edges) {
		if (e.kind !== 'contains') {
			link(e.src, e.dst);
		}
	}
	// Observed calls count double by being present twice (static + flow): runtime-
	// confirmed association SHOULD pull harder than a static reference.
	for (const f of snap.flow_edges) {
		link(f.src, f.dst);
	}

	const DAMPING = 0.85;
	const ITERATIONS = 18;

	return (section) => {
		const seedRows = section.symbols.items
			.map((s) => s.row)
			.filter((row) => index.has(row));
		if (seedRows.length === 0 || n === 0) {
			return [];
		}
		const seed = new Float64Array(n);
		for (const row of seedRows) {
			seed[index.get(row) as number] += 1 / seedRows.length;
		}
		let p = Float64Array.from(seed);
		for (let it = 0; it < ITERATIONS; it++) {
			const next = new Float64Array(n);
			for (let i = 0; i < n; i++) {
				const mass = p[i];
				if (mass === 0) {
					continue;
				}
				const ns = neighbours[i];
				if (ns.length === 0) {
					next[i] += DAMPING * mass; // dangling node keeps its mass
					continue;
				}
				const share = (DAMPING * mass) / ns.length;
				for (const j of ns) {
					next[j] += share;
				}
			}
			for (let i = 0; i < n; i++) {
				next[i] += (1 - DAMPING) * seed[i];
			}
			p = next;
		}
		const inSection = new Set(section.symbols.items.map((s) => s.row));
		const scored: Array<{ node: (typeof snap.nodes)[number]; score: number }> = [];
		for (let i = 0; i < n; i++) {
			const node = snap.nodes[i];
			// Live only: the point is the TRACED neighbourhood. Dead neighbours are
			// either in this section already or a separate finding of their own.
			if (p[i] === 0 || inSection.has(node.row) || !snap.runtime[node.row]) {
				continue;
			}
			scored.push({ node, score: p[i] });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, k).map(({ node, score }) => ({
			name: node.name,
			file: node.file,
			line: node.start_line,
			summary: node.summary,
			score,
		}));
	};
}

/**
 * One section rendered for the prompt: identity, the reachability evidence, and
 * the source of its most central symbols.
 *
 * The live callers matter more than any other field — "live code calls this and
 * the path was never taken" and "nothing references this at all" lead to
 * opposite recommendations, and the agent cannot recover that from source alone.
 */
export function renderSection(
	section: DeadSection,
	sources: Map<number, string>,
	context?: LiveContextSymbol[],
): string {
	const symbols = section.symbols.items;
	const lines: string[] = [
		`### section \`${section.id}\``,
		`files: ${section.files.join(', ')}`,
		`${symbols.length} untraced symbol(s), ${section.lines} source lines, layer ${section.layer}`,
		section.liveCallers.length
			? `REACHED FROM LIVE CODE — these executed and statically reference it: ${section.liveCallers.slice(0, 8).join('; ')}`
			: 'NO REFERENCES — nothing in the indexed graph points at this section at all.',
	];
	if (context && context.length) {
		lines.push(
			'Live neighbourhood (traced code most associated with this section, multi-hop):',
			...context.map(
				(c) => `- ${c.name} (${c.file}:${c.line})${c.summary ? ` — ${c.summary}` : ''}`,
			),
		);
	}
	lines.push('');
	symbols.forEach((s, i) => {
		const head = `- ${s.kind} ${s.name} (${s.file}:${s.startLine}-${s.endLine}, ${s.lines} lines)`;
		if (i >= MAX_SOURCED_SYMBOLS) {
			lines.push(`${head}${s.summary ? ` — ${s.summary}` : ''}`);
			return;
		}
		const src = sources.get(s.row);
		lines.push(head);
		if (s.summary) {
			lines.push(`  summary: ${s.summary}`);
		}
		if (src) {
			lines.push('```', clip(src, MAX_SYMBOL_CHARS), '```');
		}
	});
	return lines.join('\n');
}

/** The prompt for one batch of sections. */
export function buildBatchPrompt(
	sections: DeadSection[],
	sources: Map<number, string>,
	contexts?: Map<string, LiveContextSymbol[]>,
): string {
	let body = '';
	const rendered: string[] = [];
	for (const section of sections) {
		const text = renderSection(section, sources, contexts?.get(section.id));
		// A batch that overruns the context answers nothing at all, which is worse
		// than a batch that carries four sections instead of five. The dropped ones
		// stay unanswered and the caller reports the shortfall.
		if (body.length + text.length > MAX_BATCH_CHARS && rendered.length > 0) {
			break;
		}
		body += text;
		rendered.push(text);
	}
	return [
		'Vinv traced this repository at runtime and found code that no capture ever',
		'executed. Each section below is a connected island of untraced symbols.',
		'',
		'For each section, read the code IN THIS REPOSITORY (open the files, follow',
		'the imports, check the tests and the git history if you need them) and',
		'report what it is and what should happen to it.',
		'',
		'Judge each section on the evidence, not on the fact that it is untraced:',
		'- "REACHED FROM LIVE CODE" means running code references it and the path was',
		'  never taken. That is usually a guard, a config branch, or an unshipped',
		'  feature — rarely something to delete.',
		'- "NO REFERENCES" means nothing points at it. It may still be a public API,',
		'  a plugin entry point, a CLI command, or reflection/registry-loaded code',
		'  that a static graph cannot see. Say so when it is.',
		'- Coverage is only as wide as what was exercised. Absence of a trace is',
		'  never proof the code is unused.',
		'- "Live neighbourhood" lists the traced code most associated with a section',
		'  (a graph walk from its symbols) — the place an integration would wire into.',
		'',
		'Rules:',
		'- Ground every claim in what the code actually says. If you cannot tell,',
		'  set action "unclear" and say what you would need to decide.',
		'- Omit a section entirely rather than guessing about it.',
		'- Recommend "delete" only when you have positively established the code is',
		'  redundant — not merely that you found no caller.',
		'',
		...rendered,
		'',
		'Reply with ONE json object and nothing else:',
		'{"verdicts": {"<section id>": {',
		'  "what": "what this code does, in plain language",',
		'  "why": "why nothing reaches it, as far as the code shows",',
		'  "action": "integrate" | "reimagine" | "delete" | "keep" | "unclear",',
		'  "integrate": "concrete steps to wire it back in (empty if not applicable)",',
		'  "reimagine": "what it could become instead (empty if not applicable)",',
		'  "risk": "what breaks or is lost if this is removed",',
		'  "confidence": "high" | "medium" | "low"',
		'}, ...}}',
	].join('\n');
}

const ACTIONS: ReadonlySet<string> = new Set([
	'integrate',
	'reimagine',
	'delete',
	'keep',
	'unclear',
]);

/**
 * Verdicts out of one reply, keeping only those for sections that were asked
 * about.
 *
 * An id the batch never sent is dropped: models hallucinate keys, and a verdict
 * attached to a section this run never looked at would be indistinguishable from
 * one it did.
 */
export function parseVerdicts(stdout: string, asked: Set<string>): Record<string, DeadSectionVerdict> {
	const raw = parseEnvelope(stdout, 'verdicts');
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {};
	}
	const out: Record<string, DeadSectionVerdict> = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!asked.has(id) || !value || typeof value !== 'object') {
			continue;
		}
		const v = value as Record<string, unknown>;
		const what = String(v.what ?? '').trim();
		if (!what) {
			continue; // "what does it do" is the one answer with no useful default
		}
		const action = String(v.action ?? '').trim().toLowerCase();
		const confidence = String(v.confidence ?? '').trim().toLowerCase();
		out[id] = {
			id,
			what,
			why: String(v.why ?? '').trim(),
			action: (ACTIONS.has(action) ? action : 'unclear') as DeadCodeAction,
			integrate: String(v.integrate ?? '').trim(),
			reimagine: String(v.reimagine ?? '').trim(),
			risk: String(v.risk ?? '').trim(),
			confidence:
				confidence === 'high' || confidence === 'medium' || confidence === 'low'
					? confidence
					: 'low',
		};
	}
	return out;
}

/** What the traced-run driver prompt needs to know about the workspace. */
export interface DriverEnvironment {
	python: string;
	targetPackages: string[];
	cwd: string;
}

/**
 * The prompt that asks the harness to WRITE a driver for one dead section —
 * the "try run this path" half of the surface, where analysis asks what the
 * code is and this asks whether it can be made to execute at all.
 *
 * The driver runs under tracelens with the workspace's own recorded
 * configuration, so the deliverable is deliberately narrow: one standalone
 * Python script that imports the real modules and drives the section's
 * symbols. A driver that RAISES is still useful — tracelens records every
 * function that ran before the raise — so the prompt says so; an agent that
 * believes only a green run counts will fabricate scaffolding to swallow
 * errors, which hides exactly the evidence the trace exists to capture.
 */
export function buildDriverPrompt(
	section: DeadSection,
	sources: Map<number, string>,
	env: DriverEnvironment,
	context?: LiveContextSymbol[],
): string {
	return [
		'Vinv traced this repository at runtime and the section below never',
		'executed. Write a DRIVER that tries to run it, so a fresh trace can',
		'prove whether this code is executable at all.',
		'',
		renderSection(section, sources, context),
		'',
		'The driver will be executed as:',
		`  ${env.python} <driver.py>     (under tracelens, cwd: ${env.cwd})`,
		`Instrumented packages: ${env.targetPackages.join(', ') || '(none recorded)'}`,
		'',
		'Rules:',
		'- ONE standalone Python script. Import the real modules from this',
		'  repository and call the section’s symbols (or the live callers that',
		'  lead into them) with plausible arguments. Read the code first to build',
		'  the minimum real scaffolding — objects, fixtures, temp files.',
		'- Prefer driving the code IN-PROCESS over the network: import the handler',
		'  and call it, rather than starting a server.',
		'- A driver that raises is still a useful driver — every function that ran',
		'  before the raise is traced. Do NOT wrap everything in try/except to make',
		'  the run look green; let real failures propagate.',
		'- No destructive operations: nothing that deletes, migrates, or mutates',
		'  state outside temp directories.',
		'- It must finish within 60 seconds.',
		'',
		'Reply with ONE json object and nothing else:',
		'{"driver": {"code": "<the complete python script>",',
		'  "notes": "what it drives and any setup it fakes"}}',
		'If this section genuinely cannot be driven from a script (e.g. it is',
		'dead build-tool config), reply {"driver": null} and nothing else.',
	].join('\n');
}

/** The driver out of a reply; null when the agent declined or replied unusably. */
export function parseDriver(stdout: string): { code: string; notes: string } | null {
	const raw = parseEnvelope(stdout, 'driver');
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const code = String((raw as Record<string, unknown>).code ?? '').trim();
	if (!code) {
		return null;
	}
	return { code, notes: String((raw as Record<string, unknown>).notes ?? '').trim() };
}

/**
 * Which of a section's symbols a runtime overlay now covers — the verdict of a
 * try-run, counted rather than asserted. Pure so the claim is testable.
 */
export function revivedSymbols(
	section: DeadSection,
	runtime: Record<number, unknown>,
): string[] {
	return section.symbols.items.filter((s) => runtime[s.row]).map((s) => s.name);
}

/** Splits into batches of at most `size`, preserving order. */
export function batchSections(sections: DeadSection[], size = SECTIONS_PER_BATCH): DeadSection[][] {
	const out: DeadSection[][] = [];
	for (let i = 0; i < sections.length; i += Math.max(1, size)) {
		out.push(sections.slice(i, i + Math.max(1, size)));
	}
	return out;
}

/**
 * Runs `tasks` with at most `limit` in flight, preserving result order.
 *
 * A pool rather than `Promise.all` over everything: forty sections is eight
 * batches, and eight concurrent agent CLIs on a laptop is how a machine
 * thrashes. It is also not `for await` — that is the per-section serial cost this
 * whole module exists to remove.
 */
export async function pooled<T, R>(
	items: T[],
	limit: number,
	run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= items.length) {
				return;
			}
			results[i] = await run(items[i], i);
		}
	};
	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
	);
	return results;
}

/**
 * Asks the harness about every section, in concurrent batches.
 *
 * `sources` is loaded once for the whole set rather than per batch: chunks.jsonl
 * is a single linear scan and reading it eight times to serve eight batches is
 * the same avoidable multiplication the batching is here to remove.
 */
export async function analyzeDeadSections(
	workspaceRoot: string,
	sections: DeadSection[],
	dispatch: AgentDispatch,
	opts?: {
		batchSize?: number;
		concurrency?: number;
		/** Enables the PPR live-neighbourhood context in every batch prompt. */
		snapshot?: GraphSnapshot;
		/**
		 * Called as each batch settles, with what it produced (possibly `{}`).
		 * This is the durability hook: the runner persists verdicts and settles
		 * queue files here, per batch, so a crash mid-run keeps everything the
		 * finished batches already earned.
		 */
		onBatch?: (
			batch: DeadSection[],
			verdicts: Record<string, DeadSectionVerdict>,
		) => void | Promise<void>;
	},
): Promise<BatchOutcome> {
	if (sections.length === 0) {
		return { requested: 0, answered: 0, batches: 0, verdicts: {}, detail: 'no dead code to analyse' };
	}
	const rows = sections.flatMap((s) => s.symbols.items.slice(0, MAX_SOURCED_SYMBOLS).map((x) => x.row));
	let sources = new Map<number, string>();
	try {
		sources = loadChunkTexts(indexStoreDir(workspaceRoot), rows);
	} catch {
		// Summaries and signatures alone still make a usable prompt.
	}
	// Context is retrieved once per section up front — the retriever's adjacency
	// build is shared, and a failure here costs the neighbourhood lists, never
	// the analysis.
	let contexts: Map<string, LiveContextSymbol[]> | undefined;
	if (opts?.snapshot) {
		try {
			const retrieve = buildContextRetriever(opts.snapshot);
			contexts = new Map(sections.map((s) => [s.id, retrieve(s)]));
		} catch {
			contexts = undefined;
		}
	}

	const batches = batchSections(sections, opts?.batchSize ?? SECTIONS_PER_BATCH);
	const replies = await pooled(
		batches,
		opts?.concurrency ?? MAX_CONCURRENT_BATCHES,
		async (batch, i) => {
			const asked = new Set(batch.map((s) => s.id));
			const reply = await dispatch(`deadcode-${i + 1}`, buildBatchPrompt(batch, sources, contexts));
			const verdicts = reply ? parseVerdicts(reply, asked) : {};
			if (opts?.onBatch) {
				await opts.onBatch(batch, verdicts);
			}
			return verdicts;
		},
	);

	const verdicts: Record<string, DeadSectionVerdict> = Object.assign({}, ...replies);
	const answered = Object.keys(verdicts).length;
	return {
		requested: sections.length,
		answered,
		batches: batches.length,
		verdicts,
		detail:
			answered === sections.length
				? ''
				: answered === 0
					? 'the harness returned nothing usable — no section has a verdict'
					: `${sections.length - answered} of ${sections.length} section(s) came back without a verdict`,
	};
}
