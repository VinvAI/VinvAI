/**
 * Pipeline state hub — the ONE place the UI reads the post-green pipeline
 * from. Every stage that runs after "service is green" (auto-insights, issue
 * identification, endpoint I/O probes, graph enhancement, change awareness)
 * publishes its progress and results here; views subscribe to the events and
 * read the getters. Producers live in insightRunner.ts, probeRunner.ts,
 * src/index/enhanceRunner.ts and src/index/diffImpact.ts — the UI should
 * never import those directly.
 *
 * Contract for consumers (the views):
 *  - subscribe to the on*Change events, re-read the matching getter;
 *  - every getter returns the CURRENT snapshot (never null-then-throw);
 *  - all publish* functions are producer-side and idempotent to re-fire.
 */
import * as vscode from 'vscode';

// ---- auto-insight stage (calltrees + smoke/flamegraph reports) -------------

/** Where the insight stage currently sits. */
export type InsightPhase = 'idle' | 'running' | 'done' | 'failed' | 'skipped';

/** How much of a unit's static call tree the capture actually executed. */
export interface InsightCoverage {
	/** Resolved symbols in the static tree (the denominator). */
	total: number;
	/** How many of them the trace observed running. */
	executed: number;
	/** executed/total as a percentage, as the engine rounded it. */
	pct: number;
}

/** A unit's own invocations, as the runtime overlay measured them. */
export interface InsightLatency {
	calls: number;
	ok: number;
	error: number;
	errorTypes: string[];
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
	/** Of the total wall time, the part spent waiting rather than computing. */
	blockedMs: number;
}

/** One endpoint's built insight artifacts, as recorded in the manifest. */
export interface EndpointInsight {
	/** Entry-point id (identification's api id). */
	id: string;
	/** Human trigger, e.g. "GET /health". */
	trigger: string;
	handler: string | null;
	/**
	 * Kind of starting point — `http_api`, `cli_command`, `script_main`, … Absent
	 * on manifests written before non-HTTP units were built at all.
	 */
	kind?: string;
	/**
	 * Coverage from the runtime overlay, for every traced unit.
	 *
	 * The engine computes this on every tracemap and it was thrown away here, so
	 * the only way to show "how much of this ran" was to re-read and re-walk each
	 * calltree-<id>.json — which is why no surface showed it. The exerciser's
	 * scorecard has a coverage number too, but only for units IT drove; this one
	 * exists for anything the captures saw.
	 */
	coverage?: InsightCoverage;
	/**
	 * Latency and outcome for this unit, from the same overlay as the coverage.
	 * Absent on manifests written before the engine emitted it.
	 */
	latency?: InsightLatency;
	/** Absolute path of the call-tree JSON artifact, or null when it failed. */
	calltreePath: string | null;
	/** Absolute path of the smoke/flamegraph HTML report, or null when it failed. */
	reportPath: string | null;
	/** Distinct trace requests that exercised this endpoint. */
	traceCount: number;
	/** Total runtime errors observed under this endpoint's call tree. */
	errorCount: number;
	/** Symbol names in this endpoint's call tree (the change-overlap join key). */
	symbols: string[];
	/** ISO timestamp of the build. */
	lastBuilt: string;
	/** Set by change awareness: a symbol in this tree changed since the build. */
	stale?: boolean;
}

/** The persisted insight manifest (.vinv/reports/index.json). */
export interface InsightManifest {
	version: 1;
	builtAt: string;
	/** Index epoch at build time (null when no store was readable). */
	epoch: number | null;
	endpoints: EndpointInsight[];
}

/** A point-in-time snapshot of the insight stage for the UI. */
export interface InsightState {
	phase: InsightPhase;
	/** Short status line ("building call tree for GET /orders (2/5)…"). */
	label: string;
	manifest: InsightManifest | null;
	/** Failure detail when phase === 'failed'. */
	error?: string;
}

let insightState: InsightState = { phase: 'idle', label: '', manifest: null };
const insightEmitter = new vscode.EventEmitter<InsightState>();
/** Fires whenever the auto-insight stage starts, progresses, or settles. */
export const onInsightStateChange = insightEmitter.event;
/** The latest insight-stage snapshot. */
export function getInsightState(): InsightState {
	return insightState;
}
/** Producer-side: publish a new insight snapshot (insightRunner only). */
export function publishInsightState(next: InsightState): void {
	insightState = next;
	insightEmitter.fire(next);
}

// ---- issue list (auto identification) --------------------------------------

/** Where an issue was observed. */
export type IssueKind =
	/** A symbol raising errors in the live trace (runtime overlay). */
	| 'runtime-error'
	/** An endpoint whose smoke/tracemap data shows errors under its handler. */
	| 'endpoint-errors'
	/** An I/O probe replayed against the live service and failed. */
	| 'probe-failure';

/** One identified issue. `id` is the content-derived dedup signature. */
export interface Issue {
	/** Stable content signature — the dedup key for auto-dispatch. */
	id: string;
	kind: IssueKind;
	/** One-line headline for lists. */
	title: string;
	/** Full evidence text (what a fix episode would receive). */
	detail: string;
	/** Entry-point id when the issue is endpoint-scoped. */
	endpointId?: string;
	/** Service name when the issue is service-scoped (probe failures). */
	service?: string;
	/** Graph rows of the failing symbols (pack seeds), when known. */
	rows?: number[];
	/** First failing symbol's graph row (convenience for single-row consumers). */
	row?: number;
	/** True once this issue has been dispatched as a fix episode. */
	dispatched: boolean;
}

/** The current identified-issue picture. */
export interface IssueList {
	updatedAt: string;
	issues: Issue[];
}

let issueList: IssueList = { updatedAt: '', issues: [] };
const issueEmitter = new vscode.EventEmitter<IssueList>();
/** Fires whenever the identified-issue list is recomputed. */
export const onIssueListChange = issueEmitter.event;
/** The latest identified-issue list. */
export function getIssueList(): IssueList {
	return issueList;
}
/** Producer-side: publish a recomputed issue list. */
export function publishIssueList(next: IssueList): void {
	issueList = next;
	issueEmitter.fire(next);
}
/** Producer-side: mark issues dispatched (after auto-episode hand-off). */
export function markIssuesDispatched(ids: ReadonlySet<string>): void {
	if (ids.size === 0) {
		return;
	}
	issueList = {
		...issueList,
		issues: issueList.issues.map((i) => (ids.has(i.id) ? { ...i, dispatched: true } : i)),
	};
	issueEmitter.fire(issueList);
}

// ---- endpoint I/O probes ----------------------------------------------------

export type ProbePhase = 'idle' | 'running' | 'done' | 'failed' | 'skipped';

/** How one probe settled. */
export type ProbeVerdict = 'pass' | 'fail' | 'needs-authoring' | 'error';

/** One executed (or unexecutable) probe's outcome. */
export interface ProbeOutcome {
	/** Probe id (endpoint id + method+path hash). */
	id: string;
	endpointId: string;
	method: string;
	path: string;
	verdict: ProbeVerdict;
	/** HTTP status when the request completed. */
	httpStatus?: number;
	latencyMs?: number;
	/** Why it failed / needs authoring. */
	detail?: string;
	/** Structural hash of the response body (probeBaseline.responseShapeHash). */
	shapeHash?: string;
	/** Golden-baseline verdict for this probe (probeBaseline.applyBaselines):
	 * degraded/same/improved vs the recorded healthy contract, or 'recorded'
	 * when this run seeded the baseline. Absent when no baseline applies. */
	baseline?: 'degraded' | 'same' | 'improved' | 'recorded';
	/** Human detail for a degraded/improved baseline verdict. */
	baselineDetail?: string;
}

/** One probe run's results for a service. */
export interface ProbeRunSummary {
	service: string;
	ranAt: string;
	total: number;
	passed: number;
	failed: number;
	needsAuthoring: number;
	/** Probes whose baseline verdict was 'degraded' (additive; absent on old runs). */
	degraded?: number;
	/** Probes whose baseline verdict was 'improved' (additive; absent on old runs). */
	improved?: number;
	probes: ProbeOutcome[];
}

/** A point-in-time snapshot of the probe stage. */
export interface ProbeState {
	phase: ProbePhase;
	label: string;
	/** Last completed run per service (keyed by service name). */
	results: Record<string, ProbeRunSummary>;
}

let probeState: ProbeState = { phase: 'idle', label: '', results: {} };
const probeEmitter = new vscode.EventEmitter<ProbeState>();
/** Fires whenever the probe stage starts, progresses, or settles. */
export const onProbeStateChange = probeEmitter.event;
/** The latest probe-stage snapshot. */
export function getProbeState(): ProbeState {
	return probeState;
}
/** Producer-side: publish a new probe snapshot (probeRunner only). */
export function publishProbeState(next: ProbeState): void {
	probeState = next;
	probeEmitter.fire(next);
}

// ---- behavioral exercise stage ----------------------------------------------

/** Where the behavioral-exercise stage currently sits. */
export type ExercisePhase = 'idle' | 'running' | 'done' | 'failed' | 'skipped';

/** A point-in-time snapshot of the behavioral-exercise stage for the UI. */
export interface ExerciseState {
	phase: ExercisePhase;
	/** Short status line ("exercising POST /utils/test-email (3/23)…"). */
	label: string;
	/** Endpoints the exerciser reached with real coverage. */
	endpointsCovered: number;
	/** Total endpoints discovered for this service. */
	total: number;
	/** Invariants learned across all endpoints. */
	invariants: number;
	/** Behavioral issue clusters (5xx/crash/invariant-violation). */
	issues: number;
	/** Failure detail when phase === 'failed'. */
	error?: string;
}

let exerciseState: ExerciseState = {
	phase: 'idle',
	label: '',
	endpointsCovered: 0,
	total: 0,
	invariants: 0,
	issues: 0,
};
const exerciseEmitter = new vscode.EventEmitter<ExerciseState>();
/** Fires whenever the behavioral-exercise stage starts, progresses, or settles. */
export const onExerciseStateChange = exerciseEmitter.event;
/** The latest exercise-stage snapshot. */
export function getExerciseState(): ExerciseState {
	return exerciseState;
}
/** Producer-side: publish a new exercise snapshot (exerciseRunner only). */
export function publishExerciseState(next: ExerciseState): void {
	exerciseState = next;
	exerciseEmitter.fire(next);
}

// ---- graph enhancement (once per index epoch) -------------------------------

/** Terminal-per-epoch enhancement record (.vinv/index/enhance_state.json). */
export interface EnhanceState {
	/** Index epoch this record describes (-1 = never run). */
	epoch: number;
	/** References the agent resolved in that run. */
	resolved: number;
	/** References still ambiguous after the run — a terminal fact, not a nag. */
	remaining: number;
	/** Lifecycle: running now, or how the last run for this epoch ended. */
	status: 'never-run' | 'running' | 'resolved' | 'exhausted';
}

let enhanceState: EnhanceState = { epoch: -1, resolved: 0, remaining: 0, status: 'never-run' };
const enhanceEmitter = new vscode.EventEmitter<EnhanceState>();
/** Fires whenever the once-per-epoch graph enhancement changes state. */
export const onEnhanceStateChange = enhanceEmitter.event;
/** The latest enhancement snapshot. */
export function getEnhanceState(): EnhanceState {
	return enhanceState;
}
/** Producer-side: publish the enhancement state (enhanceRunner only). */
export function publishEnhanceState(next: EnhanceState): void {
	enhanceState = next;
	enhanceEmitter.fire(next);
}

// ---- change awareness (diff impact) -----------------------------------------

/** One changed symbol this epoch. */
export interface ChangedSymbol {
	row: number;
	name: string;
	file: string;
}

/** What changed this index epoch and how far it reaches. */
export interface DiffImpact {
	/** The store epoch this summary describes. */
	epoch: number;
	changedSymbols: ChangedSymbol[];
	/** Symbols in the inbound (caller) closure of the changes. */
	impactedCount: number;
	/** Files containing changed or impacted symbols. */
	impactedFiles: string[];
	/** Endpoint ids whose call tree overlaps a changed symbol — "stale, re-verify". */
	staleEndpoints: string[];
	computedAt: string;
}

let diffImpact: DiffImpact | null = null;
const diffEmitter = new vscode.EventEmitter<DiffImpact>();
/** Fires whenever a reindex produces a new change/blast-radius picture. */
export const onDiffImpactChange = diffEmitter.event;
/** The latest diff-impact summary, or null before the first reindex. */
export function getDiffImpact(): DiffImpact | null {
	return diffImpact;
}
/** Producer-side: publish a new diff-impact summary (diffImpact only). */
export function publishDiffImpact(next: DiffImpact): void {
	diffImpact = next;
	diffEmitter.fire(next);
}

// ---- overall pipeline phase --------------------------------------------------

/** The coarse phase of the whole drive-to-insights pipeline. */
export type PipelinePhase =
	| 'idle'
	| 'discovering'
	| 'services'
	| 'insights'
	| 'probes'
	| 'exercise'
	| 'done';

let pipelinePhase: PipelinePhase = 'idle';
const phaseEmitter = new vscode.EventEmitter<PipelinePhase>();
/** Fires on every coarse pipeline-phase transition (Auto-Pilot drives this). */
export const onPipelinePhaseChange = phaseEmitter.event;
/** The current coarse pipeline phase. */
export function getPipelinePhase(): PipelinePhase {
	return pipelinePhase;
}
/** Producer-side: publish the coarse phase (autoPilot only). */
export function publishPipelinePhase(next: PipelinePhase): void {
	if (pipelinePhase !== next) {
		pipelinePhase = next;
		phaseEmitter.fire(next);
	}
}
