/**
 * Gathers everything the Flow panel shows into one live `FlowModel`.
 *
 * Two feeds merge here:
 *  1. Observable workspace facts — discovery state, services on disk, capture
 *     sessions, reports, the runtime-error overlay — so the rail is truthful
 *     even before the pipeline has produced anything.
 *  2. The pipeline state hub (src/harness/pipelineState.ts): insight manifest,
 *     identified issues, probe results, enhance-graph state, diff impact and
 *     the coarse pipeline phase. Where the hub speaks it takes precedence over
 *     the fallback derivations; the hub is the only harness pipeline module
 *     the views read (never the producer runners).
 *
 * Every recompute also mirrors the model to .vinv/flow_state.json (plain JSON,
 * agent-legible over MCP). The write is change-gated and the watcher ignores
 * the file, so there is no self-triggering loop.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { enginesReady } from '../engines/install';
import {
	getDiscoveryState,
	isProjectDiscovered,
	onDiscoveryStateChange,
} from '../index/discovery';
import { readServices, readBringupOutcome, isServiceStarted, serviceSlug } from '../bringup/bringup';
import { isServiceRunning, onServiceExit } from '../bringup/serviceRunner';
import { getAutoPilotStatus, onAutoPilotStateChange } from '../harness/autoPilot';
import {
	getDiffImpact,
	getEnhanceState,
	getExerciseState,
	getInsightState,
	getIssueList,
	getPipelinePhase,
	getProbeState,
	onDiffImpactChange,
	onEnhanceStateChange,
	onExerciseStateChange,
	onInsightStateChange,
	onIssueListChange,
	onPipelinePhaseChange,
	onProbeStateChange,
} from '../harness/pipelineState';
import { collectRuntimeErrorClusters } from '../harness/runtimeAnalysis';
import {
	findTraceFiles,
	hasIndexStore,
	indexStoreDir,
	loadNodes,
	loadRuntimeOverlay,
	loadStoreEpoch,
} from '../graph/indexGraph';
import { readAdjudicated, readPendingEdges } from '../graph/graphEnhancer';
import { getHandbookPath, isHandbookGenerated } from '../handbook/handbook';
import { computeNextStep } from './nextStep';
import {
	computeFlowModel,
	flowStateJson,
	type FlowFacts,
	type FlowModel,
	type IssueFact,
	type ReportFact,
	type ServiceFact,
} from './flowModel';

const DEBOUNCE_MS = 400;

/** Longest issue evidence shown in the panel before truncation. */
const ISSUE_DETAIL_MAX = 500;

/** Where the agent-legible mirror lives. */
export function flowStateFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'flow_state.json');
}

/** The index epoch used to scope issue dismissals ("once per epoch"). */
export function currentEpoch(workspaceRoot: string): number {
	try {
		return loadStoreEpoch(indexStoreDir(workspaceRoot));
	} catch {
		return 0;
	}
}

/** Derives the per-service fact list from disk + live debug sessions. */
function serviceFacts(root: string): ServiceFact[] {
	return readServices(root).map((s) => {
		const running = isServiceRunning(s.name);
		const outcome = readBringupOutcome(root, s.name);
		const verified = isServiceStarted(root, s.name);
		const state: ServiceFact['state'] = running
			? 'running'
			: verified
				? 'ready'
				: outcome.state === 'library'
					? 'library'
					: outcome.state === 'failed'
						? 'failed'
						: 'unattempted';
		const startCommandPath = path.join(root, '.vinv', 'start_commands', `${serviceSlug(s.name)}.json`);
		return {
			name: s.name,
			state,
			detail: 'symptom' in outcome ? outcome.symptom : undefined,
			startCommandPath: fs.existsSync(startCommandPath) ? startCommandPath : undefined,
		};
	});
}

/** Counts captured sessions (entries under .vinv/captures). */
function sessionCount(root: string): number {
	try {
		return fs.readdirSync(path.join(root, '.vinv', 'captures')).length;
	} catch {
		return 0;
	}
}

/** Scans .vinv/reports for call-tree and smoke artifacts (fallback manifest). */
function scanReports(root: string): ReportFact[] {
	const dir = path.join(root, '.vinv', 'reports');
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: ReportFact[] = [];
	for (const name of names.sort()) {
		const full = path.join(dir, name);
		if (/^calltree-.*\.json$/.test(name)) {
			let label = name.replace(/^calltree-/, '').replace(/\.json$/, '');
			try {
				const j = JSON.parse(fs.readFileSync(full, 'utf8')) as { label?: string };
				if (j.label) {
					label = j.label;
				}
			} catch {
				// Unreadable snapshot: the filename-derived label still identifies it.
			}
			out.push({ kind: 'calltree', label, path: full });
		} else if (/^smoke-.*\.html$/.test(name)) {
			out.push({
				kind: 'smoke',
				label: name.replace(/^smoke-/, '').replace(/\.html$/, ''),
				path: full,
			});
		}
	}
	return out;
}

/**
 * Signature of everything the runtime-error overlay derives from, so the
 * (expensive) cluster scan reruns only when a capture or the index changed —
 * the statusBar uses the same trick.
 */
function overlaySignature(root: string): string {
	const parts: string[] = [String(currentEpoch(root))];
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

/** Clamp for issue evidence shown in the panel. */
function clampDetail(detail: string | undefined): string | undefined {
	if (!detail) {
		return undefined;
	}
	return detail.length > ISSUE_DETAIL_MAX ? `${detail.slice(0, ISSUE_DETAIL_MAX - 1)}…` : detail;
}

export class FlowStateSource implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<FlowModel>();
	/** Fires with the fresh model after every recompute. */
	readonly onDidChange = this.emitter.event;

	private readonly context: vscode.ExtensionContext;
	private readonly disposables: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private collecting = false;
	private queued = false;
	private model: FlowModel;
	private lastWritten = '';
	private issueMemo: { sig: string; issues: IssueFact[] } = { sig: '', issues: [] };

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.model = computeFlowModel(this.emptyFacts());

		const watcher = vscode.workspace.createFileSystemWatcher('**/.vinv/**');
		const onFs = (uri: vscode.Uri): void => {
			// Our own mirror write must not re-trigger a recompute.
			if (path.basename(uri.fsPath) !== 'flow_state.json') {
				this.refreshSoon();
			}
		};
		this.disposables.push(
			watcher,
			watcher.onDidCreate(onFs),
			watcher.onDidChange(onFs),
			watcher.onDidDelete(onFs),
			onDiscoveryStateChange(() => this.refreshSoon()),
			onAutoPilotStateChange(() => this.refreshSoon()),
			onServiceExit(() => this.refreshSoon()),
			// The pipeline hub: every stage it publishes re-renders the rail.
			onInsightStateChange(() => this.refreshSoon()),
			onIssueListChange(() => this.refreshSoon()),
			onProbeStateChange(() => this.refreshSoon()),
			onExerciseStateChange(() => this.refreshSoon()),
			onEnhanceStateChange(() => this.refreshSoon()),
			onDiffImpactChange(() => this.refreshSoon()),
			onPipelinePhaseChange(() => this.refreshSoon()),
			vscode.debug.onDidStartDebugSession(() => this.refreshSoon()),
			vscode.debug.onDidTerminateDebugSession(() => this.refreshSoon()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshSoon()),
		);
		this.refreshSoon();
	}

	/** The latest computed model (panel resolve renders it immediately). */
	getModel(): FlowModel {
		return this.model;
	}

	/** Debounced recompute — every event funnels through here. */
	refreshSoon(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
	}

	private emptyFacts(): FlowFacts {
		return {
			enginesReady: false,
			discovery: { phase: 'idle', label: '' },
			discovered: false,
			services: [],
			sessionCount: 0,
			tracedEndpoints: [],
			reports: [],
			issues: [],
			probes: [],
			pendingEdges: 0,
			autoPilot: { running: false, label: '' },
		};
	}

	/** Runtime-error clusters as issues, memoized on the overlay signature. */
	private runtimeIssues(root: string): IssueFact[] {
		if (!hasIndexStore(root)) {
			return [];
		}
		const sig = overlaySignature(root);
		if (sig === this.issueMemo.sig) {
			return this.issueMemo.issues;
		}
		let issues: IssueFact[] = [];
		try {
			const nodes = loadNodes(indexStoreDir(root));
			const overlay = loadRuntimeOverlay(root, nodes);
			issues = collectRuntimeErrorClusters(nodes, overlay).clusters.map((c) => {
				const n = nodes[c.row];
				return {
					id: `runtime:${n ? `${n.file}:${n.name}` : c.row}`,
					title: n ? `${n.name} is failing in live runs` : 'A function is failing in live runs',
					detail: c.line,
					evidencePath: n ? path.join(root, n.file) : undefined,
					evidenceLine: n?.start_line,
					row: c.row,
				};
			});
		} catch {
			// Store unreadable mid-reindex: keep the last known issues.
			issues = this.issueMemo.issues;
		}
		this.issueMemo = { sig, issues };
		return issues;
	}

	private async collectFacts(root: string): Promise<FlowFacts> {
		const facts = this.emptyFacts();
		facts.enginesReady = enginesReady(this.context);
		const d = getDiscoveryState();
		facts.discovery = { phase: d.phase, label: d.label, detail: d.detail };
		facts.discovered = isProjectDiscovered(root);
		facts.handbookPath = isHandbookGenerated(root) ? getHandbookPath(root) : undefined;
		facts.services = serviceFacts(root);
		facts.sessionCount = sessionCount(root);
		facts.reports = scanReports(root);
		facts.autoPilot = getAutoPilotStatus();
		facts.pipelinePhase = getPipelinePhase();
		try {
			const storeDir = indexStoreDir(root);
			const done = readAdjudicated(storeDir);
			facts.pendingEdges = readPendingEdges(storeDir).filter(
				(r) => !done.has(`${r.src_id}\u0000${r.name}`),
			).length;
		} catch {
			facts.pendingEdges = 0;
		}

		// ---- pipeline hub overlays ------------------------------------------

		// Insight manifest: authoritative report list + real trace counts, with
		// change-awareness staleness folded in.
		const insight = getInsightState();
		facts.insight = { phase: insight.phase, label: insight.label, error: insight.error };
		const impact = getDiffImpact();
		if (insight.manifest && insight.manifest.endpoints.length > 0) {
			const staleIds = new Set(impact?.staleEndpoints ?? []);
			facts.tracedEndpoints = insight.manifest.endpoints.map((e) => ({
				apiId: e.id,
				label: e.trigger,
				traceCount: e.traceCount,
			}));
			const reports: ReportFact[] = [];
			for (const e of insight.manifest.endpoints) {
				const stale = e.stale || staleIds.has(e.id);
				if (e.calltreePath) {
					reports.push({ kind: 'calltree', label: e.trigger, path: e.calltreePath, stale });
				}
				if (e.reportPath) {
					reports.push({ kind: 'smoke', label: e.trigger, path: e.reportPath, stale });
				}
			}
			facts.reports = reports;
		}

		// Issue list: once the hub has published, it is the truth for runtime/
		// endpoint/probe issues; bring-up failures stay a view-side derivation.
		const hubIssues = getIssueList();
		const baseIssues: IssueFact[] = hubIssues.updatedAt
			? hubIssues.issues.map((i) => ({
					id: i.id,
					title: i.title,
					detail: clampDetail(i.detail),
					row: i.rows?.[0],
					dispatched: i.dispatched,
				}))
			: this.runtimeIssues(root);
		facts.issues = [
			...baseIssues,
			...facts.services
				.filter((s) => s.state === 'failed')
				.map((s) => ({
					id: `bringup:${s.name}`,
					title: `Service '${s.name}' could not be set up`,
					detail: clampDetail(s.detail),
					service: s.name,
				})),
		];

		// Probes: pass/fail rows for the Verify stage. Probes still awaiting
		// authoring are neither passing nor failing and stay out of the count.
		const probe = getProbeState();
		facts.probe = { phase: probe.phase, label: probe.label };
		facts.probes = Object.values(probe.results).flatMap((run) =>
			run.probes
				.filter((p) => p.verdict === 'pass' || p.verdict === 'fail' || p.verdict === 'error')
				.map((p) => ({
					label: `${p.method} ${p.path}`,
					passed: p.verdict === 'pass',
					detail:
						p.detail ??
						(p.httpStatus !== undefined
							? `HTTP ${p.httpStatus}${p.latencyMs !== undefined ? ` · ${p.latencyMs}ms` : ''}`
							: undefined),
				})),
		);

		// Behavioral exercise: coverage/invariants/issues from the exerciser, plus
		// the scorecard artifact when it has been written.
		const exercise = getExerciseState();
		if (exercise.total > 0 || exercise.phase !== 'idle') {
			const scorecard = path.join(root, '.vinv', 'exercise', 'scorecard.md');
			facts.exercise = {
				phase: exercise.phase,
				label: exercise.label,
				endpointsCovered: exercise.endpointsCovered,
				total: exercise.total,
				invariants: exercise.invariants,
				issues: exercise.issues,
				scorecardPath: fs.existsSync(scorecard) ? scorecard : undefined,
			};
		}

		// Enhancement is once-per-epoch and terminal: after a run (or while one
		// is in flight) the remaining ambiguity is a recorded fact, not a nag —
		// hide the "Sharpen the map" affordance.
		if (getEnhanceState().status !== 'never-run') {
			facts.pendingEdges = 0;
		}

		if (impact && impact.changedSymbols.length > 0) {
			facts.diffImpact = {
				changedSymbols: impact.changedSymbols.length,
				impactedSymbols: impact.impactedCount,
			};
		}

		try {
			facts.nextStep = await computeNextStep(this.context, root);
		} catch {
			// Compass unavailable: the rail still renders; no next-action card.
		}
		return facts;
	}

	private async refresh(): Promise<void> {
		if (this.collecting) {
			this.queued = true;
			return;
		}
		this.collecting = true;
		try {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const facts = root ? await this.collectFacts(root) : this.emptyFacts();
			this.model = computeFlowModel(facts);
			this.emitter.fire(this.model);
			if (root) {
				this.writeMirror(root, this.model);
			}
		} catch {
			// Never let a state read take the panel down; the next event retries.
		} finally {
			this.collecting = false;
			if (this.queued) {
				this.queued = false;
				this.refreshSoon();
			}
		}
	}

	/** Change-gated write of the agent-legible mirror. */
	private writeMirror(root: string, model: FlowModel): void {
		try {
			// Compare without the timestamp so an unchanged model writes nothing.
			const bare = JSON.stringify(flowStateJson(model, ''));
			if (bare === this.lastWritten) {
				return;
			}
			const file = flowStateFilePath(root);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				`${JSON.stringify(flowStateJson(model, new Date().toISOString()), null, 2)}\n`,
				'utf8',
			);
			this.lastWritten = bare;
		} catch {
			// The mirror is best-effort; the panel is the primary surface.
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
	}
}
