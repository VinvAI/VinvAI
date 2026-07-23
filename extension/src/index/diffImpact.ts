/**
 * Change awareness — closes "no way to see what changed on its own".
 *
 * On every incremental reindex (the save-triggered `index update` in
 * autoReindex.ts advances the store epoch), a DiffImpact summary is computed
 * from the SAME data the Graph Explorer's diff mode renders — per-chunk
 * content epochs plus the inbound invoke closure — and published on
 * pipelineState: which symbols changed this epoch, how many symbols/files
 * fall in the blast radius, and which previously analyzed endpoints have a
 * changed symbol inside their call tree.
 *
 * Those endpoints are marked "stale — re-verify" in the insight manifest and
 * a probe pass is scheduled automatically for them (when a traced service is
 * running), so a change is not only VISIBLE on its own but also RE-VERIFIED
 * on its own.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	buildGraphSnapshot,
	hasIndexStore,
	type GraphEdge,
	type GraphNode,
} from '../graph/indexGraph';
import {
	publishDiffImpact,
	publishInsightState,
	getInsightState,
	type DiffImpact,
	type EndpointInsight,
} from '../harness/pipelineState';
import { insightManifestPath, readInsightManifest } from '../harness/insightRunner';
import { runProbePass } from '../harness/probeRunner';

/**
 * Computes the change/blast-radius picture — PURE (unit tested): mirrors the
 * Graph Explorer's diff-impact mode exactly (changed = node epoch equals the
 * store epoch; impact = inbound closure over non-contains edges).
 */
export function computeDiffImpact(
	nodes: ReadonlyArray<Pick<GraphNode, 'name' | 'file' | 'epoch'> & { row?: number }>,
	edges: ReadonlyArray<Pick<GraphEdge, 'src' | 'dst' | 'kind'>>,
	storeEpoch: number,
): Omit<DiffImpact, 'staleEndpoints' | 'computedAt'> {
	const changedRows: number[] = [];
	const changedSymbols: DiffImpact['changedSymbols'] = [];
	if (storeEpoch > 0) {
		nodes.forEach((n, row) => {
			if (n.epoch === storeEpoch) {
				changedRows.push(row);
				changedSymbols.push({ row, name: n.name, file: n.file });
			}
		});
	}
	const inbound = new Map<number, number[]>();
	for (const e of edges) {
		if (e.kind === 'contains') {
			continue;
		}
		const list = inbound.get(e.dst);
		if (list) {
			list.push(e.src);
		} else {
			inbound.set(e.dst, [e.src]);
		}
	}
	const seen = new Set(changedRows);
	let frontier = changedRows;
	while (frontier.length > 0) {
		const next: number[] = [];
		for (const row of frontier) {
			for (const caller of inbound.get(row) ?? []) {
				if (!seen.has(caller)) {
					seen.add(caller);
					next.push(caller);
				}
			}
		}
		frontier = next;
	}
	const impactedFiles = new Set<string>();
	for (const row of seen) {
		const n = nodes[row];
		if (n) {
			impactedFiles.add(n.file);
		}
	}
	return {
		epoch: storeEpoch,
		changedSymbols,
		impactedCount: seen.size,
		impactedFiles: [...impactedFiles],
	};
}

/**
 * Endpoint ids whose recorded call-tree symbols overlap a changed symbol —
 * PURE (unit tested). Overlap is by symbol name (the manifest records the
 * tree's names) with a file-level fallback for renamed symbols.
 */
export function staleEndpointIds(
	endpoints: ReadonlyArray<Pick<EndpointInsight, 'id' | 'symbols'>>,
	changedSymbols: ReadonlyArray<{ name: string; file: string }>,
): string[] {
	if (changedSymbols.length === 0) {
		return [];
	}
	const changedNames = new Set(changedSymbols.map((c) => c.name));
	return endpoints
		.filter((e) => e.symbols.some((s) => changedNames.has(s)))
		.map((e) => e.id);
}

/** Marks stale endpoints in the persisted manifest and republishes it. */
function markManifestStale(workspaceRoot: string, staleIds: ReadonlySet<string>): void {
	const manifest = readInsightManifest(workspaceRoot);
	if (!manifest) {
		return;
	}
	const next = {
		...manifest,
		endpoints: manifest.endpoints.map((e) => ({ ...e, stale: staleIds.has(e.id) })),
	};
	try {
		const target = insightManifestPath(workspaceRoot);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const tmp = `${target}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(next, null, '\t')}\n`, 'utf8');
		fs.renameSync(tmp, target);
	} catch {
		// Persisting staleness is best-effort; the published state still has it.
	}
	const current = getInsightState();
	publishInsightState({ ...current, manifest: next });
}

let lastPublishedEpoch = -1;

/**
 * Recomputes and publishes the diff-impact summary for the current store
 * epoch, marks overlapped endpoints stale, and schedules their automatic
 * re-verification (a probe pass scoped to the stale endpoints). Idempotent
 * per epoch. Never throws.
 */
export async function refreshDiffImpact(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<void> {
	try {
		if (!hasIndexStore(workspaceRoot)) {
			return;
		}
		const snapshot = buildGraphSnapshot(workspaceRoot);
		if (snapshot.store_epoch <= 0 || snapshot.store_epoch === lastPublishedEpoch) {
			return;
		}
		lastPublishedEpoch = snapshot.store_epoch;
		const base = computeDiffImpact(snapshot.nodes, snapshot.edges, snapshot.store_epoch);
		const manifest = readInsightManifest(workspaceRoot);
		const stale = staleEndpointIds(manifest?.endpoints ?? [], base.changedSymbols);
		const impact: DiffImpact = {
			...base,
			staleEndpoints: stale,
			computedAt: new Date().toISOString(),
		};
		publishDiffImpact(impact);
		if (stale.length > 0) {
			markManifestStale(workspaceRoot, new Set(stale));
			// Automatic re-verification: replay the stale endpoints' probes against
			// the live service. runProbePass is serialized and skips cleanly when
			// no traced service is running — no user click anywhere.
			void runProbePass(context, workspaceRoot, { endpointIds: stale });
		}
	} catch {
		// Change awareness must never break the reindex path.
	}
}

/**
 * Wires the reindex hook: whenever the store's meta.json changes (the
 * incremental update path bumps the epoch on real content changes), the
 * summary refreshes after a short debounce.
 */
export function registerChangeAwareness(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const root = folder.uri.fsPath;
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(root, '.vinv/index/meta.json'),
	);
	let timer: NodeJS.Timeout | undefined;
	const schedule = (): void => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => void refreshDiffImpact(context, root), 8_000);
	};
	watcher.onDidChange(schedule);
	watcher.onDidCreate(schedule);
	context.subscriptions.push(watcher, {
		dispose: () => {
			if (timer) {
				clearTimeout(timer);
			}
		},
	});
}
