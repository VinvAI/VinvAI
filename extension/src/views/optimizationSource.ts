/**
 * The background analyzer behind the Optimization view. It watches the same
 * artifacts everything else in the cockpit reads — raw captures and the index —
 * and keeps a ranked list of optimizable symbols current WITHOUT blocking: an
 * event schedules a debounced recompute, the recompute is skipped entirely when
 * nothing the analysis depends on changed (overlay signature memo), and the
 * result is mirrored to .vinv/reports/optimization.json so the view (and any
 * agent) reads an always-fresh file instead of computing on open.
 *
 * It also owns the predicted→proven loop's bookkeeping. A symbol the user sends
 * to the harness is FROZEN here at dispatch (prediction + before-cost + noise
 * band); every later recompute reconciles that dispatched candidate against the
 * newest capture and, once a fresh after-run arrives, resolves it to
 * proven / inconclusive / regressed. Tracked (dispatched + resolved) candidates
 * survive recomputes and an extension restart because they are persisted in the
 * mirror and re-seeded on construction.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	hasIndexStore,
	indexStoreDir,
	loadEdges,
	loadNodes,
	loadRuntimeOverlay,
	loadStoreEpoch,
	findTraceFiles,
	type GraphNode,
	type RuntimeOverlay,
} from '../graph/indexGraph';
import {
	collectCacheCandidates,
	collectRequestSpans,
	collectSymbolTimings,
	type SymbolSessionTiming,
} from '../harness/runtimeAnalysis';
import {
	candidateAttemptKeys,
	computeOptimizationCandidates,
	loadOptimizationCalibration,
	markDispatched,
	recordCandidateSightings,
	reconcileOutcome,
	traceRelativeSpread,
	type OptimizationCandidate,
	type OptimizationStatus,
} from '../harness/optimizationAnalysis';

const DEBOUNCE_MS = 800;

/** What the view renders and the mirror serializes. */
export interface OptimizationModel {
	updatedAt: string;
	/** True once there is an index AND at least one traced symbol. */
	hasTrace: boolean;
	/** Ranked candidates, dispatched/resolved ones interleaved by priority. */
	candidates: OptimizationCandidate[];
}

/** Where the agent-legible mirror lives (a sibling of graph.json/findings.json). */
export function optimizationFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'optimization.json');
}

/** Signature of everything the analysis derives from — memo key for recompute. */
function overlaySignature(root: string): string {
	let epoch = 0;
	try {
		epoch = loadStoreEpoch(indexStoreDir(root));
	} catch {
		epoch = 0;
	}
	const parts: string[] = [String(epoch)];
	for (const f of findTraceFiles(path.join(root, '.vinv', 'captures'))) {
		try {
			const s = fs.statSync(f);
			parts.push(`${f}:${s.size}:${s.mtimeMs}`);
		} catch {
			parts.push(`${f}:missing`);
		}
	}
	return parts.join('|');
}

/**
 * Display priority: a running dispatch first (the user is waiting on it), then
 * open candidates by predicted recoverable time, then resolved outcomes by the
 * magnitude of what they moved — proven wins and regressions both stay visible.
 */
function priority(c: OptimizationCandidate): number {
	switch (c.status) {
		case 'dispatched':
			return 0;
		case 'candidate':
			return 1;
		default:
			return 2;
	}
}

function sortCandidates(list: OptimizationCandidate[]): OptimizationCandidate[] {
	return [...list].sort((a, b) => {
		const pa = priority(a);
		const pb = priority(b);
		if (pa !== pb) {
			return pa - pb;
		}
		if (pa === 1) {
			return b.predicted_ms - a.predicted_ms;
		}
		if (pa === 2) {
			return Math.abs(b.outcome?.delta_ms ?? 0) - Math.abs(a.outcome?.delta_ms ?? 0);
		}
		return 0;
	});
}

let currentSource: OptimizationSource | undefined;

/** The live source, for the command layer to freeze a candidate on dispatch. */
export function optimizationSourceInstance(): OptimizationSource | undefined {
	return currentSource;
}

export class OptimizationSource implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<OptimizationModel>();
	/** Fires with the fresh model after every recompute. */
	readonly onDidChange = this.emitter.event;

	private readonly disposables: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private collecting = false;
	private queued = false;
	private model: OptimizationModel = { updatedAt: '', hasTrace: false, candidates: [] };
	private lastWritten = '';
	private memoSig = '\u0000none';
	private memoCandidates: OptimizationCandidate[] = [];
	/** Dispatched + resolved candidates, by row — survive recompute & restart. */
	private tracked = new Map<number, OptimizationCandidate>();

	constructor() {
		currentSource = this;
		this.seedTrackedFromDisk();

		// Narrow watchers: only the raw captures and the index epoch drive the
		// analysis. Deliberately NOT '**/.vinv/**' — writing our own mirror under
		// .vinv/reports must not retrigger a recompute.
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			const root = folder.uri.fsPath;
			const captures = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(root, '.vinv/captures/**'),
			);
			const meta = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(root, '.vinv/index/meta.json'),
			);
			const bump = (): void => this.refreshSoon();
			this.disposables.push(
				captures,
				captures.onDidCreate(bump),
				captures.onDidChange(bump),
				captures.onDidDelete(bump),
				meta,
				meta.onDidCreate(bump),
				meta.onDidChange(bump),
			);
		}
		this.refreshSoon();
	}

	/** The latest computed model (view resolve renders it immediately). */
	getModel(): OptimizationModel {
		return this.model;
	}

	/** Debounced recompute — every event funnels through here. */
	refreshSoon(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
	}

	/**
	 * Freezes the candidate on `row` at dispatch and shows it as running. Called
	 * by the optimize-hotspot command BEFORE it hands the episode to the harness,
	 * so the before-cost is captured against the pre-fix trace.
	 *
	 * A panel click must ALWAYS be recorded. The row may not be in the live
	 * model at click time — the model can be stale/empty, or the symbol can rank
	 * below the display cap — and the earlier version silently no-op'd there, so
	 * a dispatched episode (populate_template) never showed up in the panel and
	 * lingered as a plain candidate. Now we fall back to a fresh recompute and,
	 * failing that, synthesize a minimal candidate from the graph + trace, so the
	 * dispatch is tracked no matter what the model currently holds.
	 */
	markRowDispatched(
		root: string,
		row: number,
		opts: { engine?: 'bridge' | 'watch' } = {},
	): OptimizationCandidate | undefined {
		let timings: SymbolSessionTiming[] | undefined;
		let relSpread: number | undefined;
		let existing = this.tracked.get(row) ?? this.model.candidates.find((c) => c.row === row);
		try {
			const nodes = loadNodes(indexStoreDir(root));
			const allTimings = collectSymbolTimings(root, nodes);
			timings = allTimings.get(row);
			// The trace-derived relative jitter gives the frozen noise band its
			// smallest-detectable floor (see noiseBand's derivation note).
			relSpread = traceRelativeSpread(allTimings);
			if (!existing) {
				existing = this.computeCandidates(root).find((c) => c.row === row);
			}
			if (!existing) {
				const n = nodes[row];
				const l = timings && timings.length > 0 ? timings[timings.length - 1] : undefined;
				if (n) {
					existing = {
						row,
						name: n.name,
						file: n.file,
						line: n.start_line,
						total_ms: l?.total_ms ?? 0,
						calls: l?.calls ?? 0,
						waste_prior: 0,
						predicted_ms: 0,
						waste_kind: 'per-call',
						reason: '',
						status: 'candidate',
					};
				}
			}
		} catch {
			timings = undefined;
		}
		if (!existing) {
			return undefined; // row unresolvable against the store — nothing to track
		}
		const frozen = markDispatched(existing, timings, `Optimize ${existing.name}`, relSpread);
		if (frozen.outcome) {
			// 'bridge' rows are judged by the exerciseOptimize verdict engine
			// (paired-bootstrap CI bound to the episode); the capture watcher must
			// leave them alone rather than reconcile against "any newer session".
			frozen.outcome.engine = opts.engine ?? 'watch';
		}
		this.tracked.set(row, frozen);
		this.rebuildModelFrom(this.memoCandidates, root);
		return frozen;
	}

	/**
	 * Resolves a bridge-dispatched row from the verdict engine's episode-bound
	 * measurement — the ONE authority for rows it dispatched. The CI evidence
	 * and the fact of the revert land on the outcome so the report renders the
	 * honest story ("reverted" is a real rollback, not copy). Returns the
	 * resolved candidate so the bridge can enrich its outcome event with the
	 * frozen prediction (waste_kind, predicted_ms).
	 */
	resolveRowFromVerdict(
		root: string,
		row: number,
		resolution: {
			status: OptimizationStatus;
			comparison: {
				before_median: number;
				after_median: number;
				rel_improvement: number;
				ci_low: number;
				ci_high: number;
				improved: boolean;
			} | null;
			behaviorOk: boolean;
			reverted: boolean;
		},
	): OptimizationCandidate | undefined {
		const tracked = this.tracked.get(row);
		if (!tracked || tracked.status !== 'dispatched' || !tracked.outcome) {
			return undefined;
		}
		const ci = resolution.comparison ?? undefined;
		const resolved: OptimizationCandidate = {
			...tracked,
			status: resolution.status,
			outcome: {
				...tracked.outcome,
				behavior_ok: resolution.behaviorOk,
				ci,
				reverted: resolution.reverted,
				// The engine measured endpoint latency medians; surface the delta in
				// the same field the report reads (negative = faster).
				measured_after: ci ? ci.after_median : tracked.outcome.measured_after,
				measured_before: ci ? ci.before_median : tracked.outcome.measured_before,
				delta_ms: ci ? ci.after_median - ci.before_median : tracked.outcome.delta_ms,
			},
		};
		this.tracked.set(row, resolved);
		this.rebuildModelFrom(this.memoCandidates, root);
		return resolved;
	}

	private seedTrackedFromDisk(): void {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return;
		}
		try {
			const raw = fs.readFileSync(optimizationFilePath(root), 'utf8');
			const parsed = JSON.parse(raw) as { candidates?: OptimizationCandidate[] };
			for (const c of parsed.candidates ?? []) {
				// Only non-open statuses are worth persisting across restarts; a
				// plain 'candidate' is re-derived from the trace every recompute.
				if (c && typeof c.row === 'number' && c.status && c.status !== 'candidate') {
					this.tracked.set(c.row, c);
				}
			}
		} catch {
			// No prior mirror (or unreadable): start with an empty tracked set.
		}
	}

	/** True when the symbol showed NO errors in its latest captured run. */
	private behaviorOk(overlay: Record<number, RuntimeOverlay>, row: number): boolean {
		const rt = overlay[row];
		return !rt || rt.current_errors === 0;
	}

	private async refresh(): Promise<void> {
		if (this.collecting) {
			this.queued = true;
			return;
		}
		this.collecting = true;
		try {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root || !hasIndexStore(root)) {
				this.publish({ updatedAt: new Date().toISOString(), hasTrace: false, candidates: [] }, root);
				return;
			}
			const sig = overlaySignature(root);
			if (sig !== this.memoSig) {
				this.memoCandidates = this.computeCandidates(root);
				this.memoSig = sig;
				// Fresh evidence: record which persisted attempt keys are still
				// alive in this capture session (the doom-loop store's expiry clock).
				this.recordAttemptSightings(root, this.memoCandidates);
			}
			this.rebuildModelFrom(this.memoCandidates, root);
		} catch {
			// Never let a state read take the view down; the next event retries.
		} finally {
			this.collecting = false;
			if (this.queued) {
				this.queued = false;
				this.refreshSoon();
			}
		}
	}

	/** The expensive pass: load evidence and rank candidates. */
	private computeCandidates(root: string): OptimizationCandidate[] {
		const storeDir = indexStoreDir(root);
		const nodes: GraphNode[] = loadNodes(storeDir);
		const edges = loadEdges(storeDir, nodes.length);
		const timings = collectSymbolTimings(root, nodes);
		const cacheByRow = new Map(collectCacheCandidates(root, nodes).map((c) => [c.row, c]));
		const spans = collectRequestSpans(root, nodes);
		// Ranking-time calibration: predicted_ms deflated by the learned
		// per-waste-kind outcome ratio when the artifact exists (default 1).
		const calibration = loadOptimizationCalibration(root);
		return computeOptimizationCandidates({ nodes, edges, timings, cacheByRow, spans, calibration });
	}

	/**
	 * The doom-loop store's expiry clock: mark which persisted attempt keys the
	 * fresh ranking still contains, attributed to the NEWEST capture session
	 * (the same directory-keyed session identity every cross-session analysis
	 * uses). Best-effort — the model publish must never fail on it.
	 */
	private recordAttemptSightings(root: string, candidates: OptimizationCandidate[]): void {
		try {
			let session: string | undefined;
			let newest = -1;
			for (const f of findTraceFiles(path.join(root, '.vinv', 'captures'))) {
				try {
					const m = fs.statSync(f).mtimeMs;
					if (m > newest) {
						newest = m;
						session = path.dirname(f);
					}
				} catch {
					// Trace vanished mid-scan — skip it.
				}
			}
			if (session) {
				recordCandidateSightings(root, session, candidateAttemptKeys(candidates));
			}
		} catch {
			// The sighting is bookkeeping for expiry; never take the view down.
		}
	}

	/**
	 * Merges tracked (dispatched/resolved) candidates over the freshly ranked
	 * ones, reconciling any dispatched candidate against the newest capture, and
	 * publishes. Cheap enough to run on every event even when the ranking memo
	 * is unchanged (a dispatched fix's after-run must be picked up promptly).
	 */
	private rebuildModelFrom(fresh: OptimizationCandidate[], root: string | undefined): void {
		if (!root) {
			this.publish({ updatedAt: new Date().toISOString(), hasTrace: false, candidates: [] }, root);
			return;
		}
		let timings = new Map<number, SymbolSessionTiming[]>();
		let overlay: Record<number, RuntimeOverlay> = {};
		try {
			const nodes = loadNodes(indexStoreDir(root));
			timings = collectSymbolTimings(root, nodes);
			overlay = loadRuntimeOverlay(root, nodes);
		} catch {
			// Store unreadable mid-reindex: reconcile with what we have (nothing),
			// which simply leaves dispatched candidates waiting another cycle.
		}

		// Reconcile every dispatched candidate; resolved ones stay tracked so the
		// outcome remains visible until a later analysis supersedes the row.
		// Bridge-owned rows are exempt: their verdict comes from the episode-bound
		// paired-bootstrap engine, never from whatever capture landed most recently.
		for (const [row, tracked] of this.tracked) {
			if (tracked.status === 'dispatched' && tracked.outcome?.engine !== 'bridge') {
				this.tracked.set(row, reconcileOutcome(tracked, timings.get(row), this.behaviorOk(overlay, row)));
			}
		}

		const byRow = new Map<number, OptimizationCandidate>();
		for (const c of fresh) {
			byRow.set(c.row, c);
		}
		// Tracked entries win over the freshly-derived plain candidate for a row.
		for (const [row, tracked] of this.tracked) {
			byRow.set(row, tracked);
		}
		const candidates = sortCandidates([...byRow.values()]);
		this.publish(
			{ updatedAt: new Date().toISOString(), hasTrace: candidates.length > 0, candidates },
			root,
		);
	}

	private publish(model: OptimizationModel, root: string | undefined): void {
		this.model = model;
		this.emitter.fire(model);
		if (root) {
			this.writeMirror(root, model);
		}
	}

	/** Change-gated write of the agent-legible mirror. */
	private writeMirror(root: string, model: OptimizationModel): void {
		try {
			const bare = JSON.stringify(model.candidates);
			if (bare === this.lastWritten) {
				return;
			}
			const file = optimizationFilePath(root);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				`${JSON.stringify({ updated_at: model.updatedAt, candidates: model.candidates }, null, 2)}\n`,
				'utf8',
			);
			this.lastWritten = bare;
		} catch {
			// The mirror is best-effort; the view is the primary surface.
		}
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		for (const d of this.disposables) {
			d.dispose();
		}
		this.emitter.dispose();
		if (currentSource === this) {
			currentSource = undefined;
		}
	}
}
