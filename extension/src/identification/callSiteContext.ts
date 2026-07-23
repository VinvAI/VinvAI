import * as fs from 'fs';
import * as path from 'path';
import { buildGraphSnapshot, type GraphSnapshot } from '../graph/indexGraph';
import type { CallNode, CallTreeEntrypoint, TraceMapResult } from './identification';

/** Cap on how much of each list the digest renders — the prompt budget belongs
 * to the graph evidence; this section is orientation, not a data dump. */
const MAX_PATH = 40;
const MAX_NOT_RUN = 12;
const MAX_RUNTIME_ONLY = 8;

/** Makes an entry-point id safe to use as a filename component. */
export function sanitizeId(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, '_') || 'entry';
}

/**
 * The workspace-local backing file a call-tree view renders from:
 * <workspace>/.vinv/reports/calltree-<id>.json. The view rewrites it on every
 * tracemap poll, so reading it here yields the same snapshot the user is
 * currently looking at — no need to marshal the tree through the webview.
 */
export function backingFilePath(workspaceRoot: string, apiId: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', `calltree-${sanitizeId(apiId)}.json`);
}

/**
 * Everything the call-tree view knows about one node, resolved into the two
 * forms the QnA path consumes: anchor rows for the context walk, and a rendered
 * digest for the prompt.
 */
export interface CallSiteContext {
	apiId: string;
	/** Rendered digest injected into the evidence context. */
	markdown: string;
	/** Graph rows for every symbol on the entry-point→target path. */
	anchorRows: number[];
	/** The clicked symbol's row, when it resolves to an indexed symbol. */
	seedRow?: number;
	/** Short label for the panel's context chip. */
	label: string;
}

/**
 * Normalizes a path to a workspace-relative, forward-slashed form so call-tree
 * nodes (which may be absolute, and on Windows backslashed) compare equal to
 * graph-snapshot nodes (which are always relative and forward-slashed).
 */
function normalizeRel(workspaceRoot: string, p: string): string {
	const abs = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
	return path.relative(workspaceRoot, abs).split(path.sep).join('/');
}

/** The identity a call node matches on, normalized for comparison. */
function nodeKey(workspaceRoot: string, file: string | undefined, name: string | undefined): string {
	return `${file ? normalizeRel(workspaceRoot, file) : ''}::${name ?? ''}`;
}

/**
 * Depth-first search for the target symbol, returning the full chain from the
 * tree root down to it (inclusive). The chain — not just the node — is what
 * makes the answer endpoint-aware: it is the concrete path the runtime took,
 * which the graph walk reconstructs only as undirected relevance.
 */
function findCallPath(
	workspaceRoot: string,
	root: CallNode,
	target: { file?: string; name?: string },
): CallNode[] | undefined {
	const want = nodeKey(workspaceRoot, target.file, target.name);
	const walk = (node: CallNode, trail: CallNode[]): CallNode[] | undefined => {
		const next = [...trail, node];
		if (nodeKey(workspaceRoot, node.file, node.name) === want) {
			return next;
		}
		for (const child of node.children ?? []) {
			const found = walk(child, next);
			if (found) {
				return found;
			}
		}
		return undefined;
	};
	return walk(root, []);
}

/** Every resolved descendant of `node` that the trace shows never ran. */
function collectNotRun(node: CallNode, out: CallNode[]): void {
	for (const child of node.children ?? []) {
		if (child.resolved !== false && child.runtime && !child.runtime.executed) {
			out.push(child);
		}
		collectNotRun(child, out);
	}
}

function fmtBytes(b: number): string {
	const neg = b < 0 ? '-' : '';
	let v = Math.abs(b);
	const units = ['B', 'KB', 'MB', 'GB'];
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${neg}${i === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** One node rendered with its endpoint-scoped runtime overlay, if it has one. */
function fmtNode(workspaceRoot: string, node: CallNode): string {
	const where = node.file ? ` — ${normalizeRel(workspaceRoot, node.file)}:${node.line ?? '?'}` : '';
	const head = `${node.name ?? node.call ?? '?'}()${where}`;
	const rt = node.runtime;
	if (!rt) {
		return head;
	}
	if (!rt.executed) {
		return `${head} — NOT EXECUTED under this entry point`;
	}
	const bits: string[] = [`×${rt.calls ?? 0}`];
	if (typeof rt.total_ms === 'number') {
		bits.push(`${rt.total_ms}ms`);
	}
	if (typeof rt.mem_bytes === 'number') {
		bits.push(fmtBytes(rt.mem_bytes));
	}
	if (rt.error) {
		bits.push(`${rt.error} error(s)${rt.errors?.length ? ` [${rt.errors.join(', ')}]` : ''}`);
	}
	return `${head} — ${bits.join(', ')}`;
}

/** A human label for the entry point, matching what the view's header shows. */
function entrypointLabel(ep: CallTreeEntrypoint | undefined, apiId: string): string {
	if (!ep) {
		return apiId;
	}
	return ep.kind === 'http_api' && ep.method ? `${ep.method} ${ep.path ?? ''}`.trim() : (ep.trigger ?? ep.id);
}

/**
 * Renders the digest. The scope disclaimer is load-bearing, not decoration:
 * the graph snapshot's runtime overlay reports LIFETIME totals across every
 * capture on disk, while these numbers are scoped to this entry point's matched
 * requests. Both appear in the same prompt, so the model is told which is which
 * — otherwise it reads a disagreement as a contradiction and hedges.
 */
function renderMarkdown(
	workspaceRoot: string,
	apiId: string,
	doc: TraceMapResult,
	callPath: CallNode[],
	target: CallNode,
): string {
	const ep = doc.entrypoint;
	const lines: string[] = [];
	const label = entrypointLabel(ep, apiId);
	const isTraced = doc.handler_observed === true;
	const requests = doc.requests_matched?.length ?? 0;

	lines.push('## Runtime call path (from the Call Tree view the question was asked from)');
	lines.push('');
	lines.push(
		`The question is about \`${target.name ?? target.call ?? '?'}\` as it is reached from the entry point **${label}**` +
			(ep ? ` (handler \`${ep.handler}()\` at ${normalizeRel(workspaceRoot, ep.file)}:${ep.line}${ep.framework ? `, ${ep.framework}` : ''})` : '') +
			'.',
	);
	lines.push('');
	if (isTraced) {
		lines.push(
			`SCOPE: every call count, duration and memory figure in THIS section is scoped to this entry point's ` +
				`${requests} matched request(s) in the current capture. Runtime numbers elsewhere in this context are ` +
				`LIFETIME per-symbol totals across all captures. The two are measuring different things — if they ` +
				`disagree, both are correct at their own scope; do not treat that as a contradiction.`,
		);
	} else {
		lines.push(
			'SCOPE: the handler has NOT been observed in any capture yet, so this section carries the static call ' +
				'path only — it has no runtime evidence for this entry point. Do not infer that the code never runs; ' +
				'infer only that it has not been exercised under this entry point in a captured trace.',
		);
	}
	lines.push('');

	lines.push('### Path from the entry point to the symbol in question');
	const shown = callPath.slice(0, MAX_PATH);
	shown.forEach((node, i) => {
		const marker = i === shown.length - 1 && shown.length === callPath.length ? '  <-- the symbol in question' : '';
		const flags: string[] = [];
		if (node.ambiguous) {
			flags.push(`call name was ambiguous across ${node.ambiguous} symbols`);
		}
		if (node.truncated) {
			flags.push(`subtree truncated (${node.truncated})`);
		}
		if (node.expanded_elsewhere) {
			flags.push('subtree shown under another caller (shared in the DAG)');
		}
		lines.push(
			`${i + 1}. ${fmtNode(workspaceRoot, node)}${marker}` +
				(flags.length ? `\n   - NOTE: ${flags.join('; ')}` : ''),
		);
	});
	if (callPath.length > shown.length) {
		lines.push(`… ${callPath.length - shown.length} further frame(s) omitted.`);
	}
	lines.push('');

	if (doc.coverage) {
		const c = doc.coverage;
		lines.push('### Coverage under this entry point');
		lines.push(
			`${c.executed}/${c.static_functions} statically reachable functions executed (${c.pct}%); ` +
				`${c.never_executed} never ran.`,
		);
		lines.push('');
	}

	if (isTraced) {
		const notRun: CallNode[] = [];
		collectNotRun(target, notRun);
		if (notRun.length) {
			lines.push('### Reachable from the symbol in question but never executed');
			lines.push(
				'These are called in the code but absent from the trace — dead paths, unmet guards, or untested branches.',
			);
			for (const n of notRun.slice(0, MAX_NOT_RUN)) {
				lines.push(`- ${n.name ?? n.call ?? '?'}()${n.file ? ` — ${normalizeRel(workspaceRoot, n.file)}:${n.line ?? '?'}` : ''}`);
			}
			if (notRun.length > MAX_NOT_RUN) {
				lines.push(`- … and ${notRun.length - MAX_NOT_RUN} more.`);
			}
			lines.push('');
		}
	}

	const only = doc.runtime_only ?? [];
	if (only.length) {
		lines.push('### Ran under this entry point but the static call graph did not predict it');
		lines.push(
			'This is the static analysis\'s blind spot for this entry point (dynamic dispatch, framework hooks, ' +
				'reflection). It cannot be recovered from the code graph — treat it as ground truth.',
		);
		for (const r of only.slice(0, MAX_RUNTIME_ONLY)) {
			lines.push(
				`- ${r.component} ×${r.calls} (${r.total_ms}ms)${r.errors?.length ? ` — errors: ${r.errors.join(', ')}` : ''}`,
			);
		}
		if (only.length > MAX_RUNTIME_ONLY) {
			lines.push(`- … and ${only.length - MAX_RUNTIME_ONLY} more.`);
		}
		lines.push('');
	}

	return lines.join('\n').trimEnd();
}

/**
 * Builds the context for one call-tree node. Reads the view's own backing
 * snapshot (already fresh — the view rewrites it every poll) and resolves the
 * entry-point→node path into graph rows the context walk can anchor on.
 *
 * Returns undefined when the snapshot is unreadable or the node isn't in the
 * tree; every caller treats that as "ask unseeded" rather than an error, so a
 * stale index or a mid-poll write can never block the question.
 */
export function buildCallSiteContext(
	workspaceRoot: string,
	apiId: string,
	target: { file?: string; name?: string },
	snapshot?: GraphSnapshot,
): CallSiteContext | undefined {
	let doc: TraceMapResult;
	try {
		doc = JSON.parse(fs.readFileSync(backingFilePath(workspaceRoot, apiId), 'utf8')) as TraceMapResult;
	} catch {
		return undefined;
	}
	if (!doc.tree) {
		return undefined;
	}
	const callPath = findCallPath(workspaceRoot, doc.tree, target);
	if (!callPath?.length) {
		return undefined;
	}
	const node = callPath[callPath.length - 1];

	// Resolve each frame to its graph row. A frame with no indexed symbol
	// (external, or indexed under a different name) simply contributes no
	// anchor — the path still renders, it just anchors on fewer rows.
	let rows: number[] = [];
	try {
		const snap = snapshot ?? buildGraphSnapshot(workspaceRoot);
		const byKey = new Map<string, number>();
		for (const n of snap.nodes) {
			const k = `${n.file.split(path.sep).join('/')}::${n.name}`;
			if (!byKey.has(k)) {
				byKey.set(k, n.row);
			}
		}
		rows = callPath
			.map((f) => (f.file ? byKey.get(nodeKey(workspaceRoot, f.file, f.name)) : undefined))
			.filter((r): r is number => r !== undefined);
	} catch {
		// No index store yet: the digest still stands on its own.
	}
	// The clicked symbol anchors the walk; its callers are supporting context.
	const seedRow = rows.length ? rows[rows.length - 1] : undefined;

	return {
		apiId,
		markdown: renderMarkdown(workspaceRoot, apiId, doc, callPath, node),
		anchorRows: [...new Set(rows)],
		seedRow,
		label: `${node.name ?? node.call ?? '?'} in ${entrypointLabel(doc.entrypoint, apiId)}`,
	};
}
