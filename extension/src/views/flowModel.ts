/**
 * Pure view-model for the Vinv Flow panel — the one place the "flow from start
 * to end" is computed. No vscode import, no I/O: flowStateSource.ts gathers
 * observable facts (and, once wired, the pipeline's own state API) into a
 * `FlowFacts`, and this module turns it into the five-stage rail the panel
 * renders and the JSON written to .vinv/flow_state.json. Being pure, it is
 * unit-tested without a VS Code host (see test/flowModel.test.ts).
 */

// ---- inputs ----------------------------------------------------------------

/** One service's observable state, already classified by the source. */
export interface ServiceFact {
	name: string;
	state: 'running' | 'ready' | 'failed' | 'library' | 'unattempted';
	/** e.g. the recorded failure symptom for a failed bring-up. */
	detail?: string;
	/** .vinv/start_commands/<slug>.json when it exists on disk. */
	startCommandPath?: string;
}

/** One report artifact under .vinv/reports. */
export interface ReportFact {
	kind: 'calltree' | 'smoke';
	/** Human label, e.g. "GET /health". */
	label: string;
	path: string;
	/** Change awareness: a symbol in this report changed since it was built. */
	stale?: boolean;
}

/** One traced entry point with its live hit count. */
export interface TracedEndpointFact {
	apiId: string;
	label: string;
	traceCount: number;
}

/** One live problem (runtime errors, failed bring-ups, pipeline issues). */
export interface IssueFact {
	/** Stable content-derived id (drives once-per-epoch dismissals). */
	id: string;
	title: string;
	detail?: string;
	service?: string;
	evidencePath?: string;
	evidenceLine?: number;
	/** Graph node row, when known — seeds the fix episode. */
	row?: number;
	/** True once the pipeline auto-dispatched a fix episode for this issue —
	 * the panel then shows "Fix sent" instead of an actionable button. */
	dispatched?: boolean;
}

/** One verification probe outcome (from the pipeline, when connected). */
export interface ProbeFact {
	label: string;
	passed: boolean;
	detail?: string;
}

/** Everything the rail is computed from. Plain data, JSON-safe. */
export interface FlowFacts {
	enginesReady: boolean;
	discovery: { phase: 'idle' | 'running' | 'done' | 'failed'; label: string; detail?: string };
	discovered: boolean;
	/** .vinv/vinv.md when it exists. */
	handbookPath?: string;
	services: ServiceFact[];
	/** Captured session count under .vinv/captures. */
	sessionCount: number;
	tracedEndpoints: TracedEndpointFact[];
	reports: ReportFact[];
	issues: IssueFact[];
	probes: ProbeFact[];
	/** Ambiguous references awaiting the graph-enhancement agent. */
	pendingEdges: number;
	diffImpact?: { changedSymbols: number; impactedSymbols: number };
	autoPilot: { running: boolean; label: string };
	/** Coarse pipeline phase from the harness hub — refines the spine. */
	pipelinePhase?: 'idle' | 'discovering' | 'services' | 'insights' | 'probes' | 'exercise' | 'done';
	/** Live insight-build state from the hub (call trees + reports). */
	insight?: {
		phase: 'idle' | 'running' | 'done' | 'failed' | 'skipped';
		label: string;
		error?: string;
	};
	/** Live probe-run state from the hub. */
	probe?: { phase: 'idle' | 'running' | 'done' | 'failed' | 'skipped'; label: string };
	/** Live behavioral-exercise state from the hub (coverage + invariants + issues). */
	exercise?: {
		phase: 'idle' | 'running' | 'done' | 'failed' | 'skipped';
		label: string;
		endpointsCovered: number;
		total: number;
		invariants: number;
		issues: number;
		/** Absolute path of the behavior scorecard, when written. */
		scorecardPath?: string;
	};
	/** The onboarding compass's answer (computed by nextStep.ts). */
	nextStep?: { label: string; detail: string; command: string; args?: unknown[] };
}

// ---- outputs ---------------------------------------------------------------

export type FlowStageId = 'discover' | 'services' | 'traces' | 'insights' | 'verify';
export type FlowStageStatus = 'done' | 'running' | 'waiting' | 'error';

/** A clickable row inside a stage. Exactly one of `command`/`openPath` is set. */
export interface FlowLink {
	label: string;
	detail?: string;
	command?: string;
	args?: unknown[];
	openPath?: string;
	openLine?: number;
	/** Open .md as a rendered preview instead of raw text. */
	markdownPreview?: boolean;
	/** Row dot: ok (green-ish), running (pulsing), error (red), muted. */
	state?: 'ok' | 'running' | 'error' | 'muted';
}

export interface FlowStage {
	id: FlowStageId;
	/** Plain-language title, e.g. "Traces". */
	title: string;
	/** One-line plain-language explanation of what the stage is. */
	blurb: string;
	status: FlowStageStatus;
	/** One-line "what happened / what it's waiting for". */
	summary: string;
	/** Live Auto-Pilot step when this stage is the active one (the spine). */
	activity?: string;
	links: FlowLink[];
}

export interface FlowIssue extends IssueFact {
	/** Arguments for the existing vinv-vs.fixWithHarness command. */
	fixArgs: { issue: string; service?: string; row?: number };
}

export interface FlowNextAction {
	label: string;
	/** One-line why. */
	why: string;
	command: string;
	args?: unknown[];
}

export interface FlowModel {
	stages: FlowStage[];
	issues: FlowIssue[];
	/** The single next human action; absent while Auto-Pilot drives. */
	nextAction?: FlowNextAction;
	autoPilot: { running: boolean; label: string };
}

// ---- computation -----------------------------------------------------------

/** Maps the harness hub's coarse pipeline phase onto a rail stage. */
export function pipelineStage(
	phase: FlowFacts['pipelinePhase'],
): FlowStageId | undefined {
	switch (phase) {
		case 'discovering':
			return 'discover';
		case 'services':
			return 'services';
		case 'insights':
			return 'insights';
		case 'probes':
			return 'verify';
		case 'exercise':
			return 'verify';
		default:
			return undefined;
	}
}

/**
 * Maps Auto-Pilot's live step label onto the rail stage it is working, so the
 * rail's pulsing stage IS Auto-Pilot's spine. The hub's coarse pipeline phase
 * takes precedence when published (see computeFlowModel); this label mapping
 * covers the setup steps that predate a phase. Labels come from autoPilot.ts's
 * report() strings; unknown labels highlight nothing (the per-stage facts
 * still render truthfully).
 */
export function autoPilotStage(label: string): FlowStageId | undefined {
	const l = label.toLowerCase();
	if (l.includes('discover')) {
		return 'discover';
	}
	if (l.includes('setting up') || l.includes('set up')) {
		return 'services';
	}
	if (l.includes('under tracing') || l.includes('starting') || l.includes('already running')) {
		return 'traces';
	}
	if (
		l.includes('verifying') ||
		l.includes('fix episode') ||
		l.includes('dispatch') ||
		l.includes('giving up') ||
		l.includes('green')
	) {
		return 'verify';
	}
	return undefined;
}

/** Cap a link list, folding the tail into a "…and N more" muted row. */
function capLinks(links: FlowLink[], max: number): FlowLink[] {
	if (links.length <= max) {
		return links;
	}
	const shown = links.slice(0, max - 1);
	shown.push({ label: `…and ${links.length - (max - 1)} more`, state: 'muted' });
	return shown;
}

function discoverStage(f: FlowFacts): FlowStage {
	let status: FlowStageStatus;
	let summary: string;
	const links: FlowLink[] = [];
	if (f.discovery.phase === 'running') {
		status = 'running';
		summary = f.discovery.label || 'Reading your project…';
	} else if (f.discovery.phase === 'failed') {
		status = 'error';
		summary = f.discovery.label || 'The project scan did not finish';
		links.push({
			label: 'Scan again',
			detail: f.discovery.detail,
			command: 'vinv-vs.rediscover',
			state: 'error',
		});
	} else if (f.discovered) {
		status = 'done';
		const n = f.services.length;
		summary = n > 0 ? `Project mapped — ${n} service${n === 1 ? '' : 's'} found` : 'Project mapped';
	} else {
		status = 'waiting';
		summary = f.enginesReady
			? 'Waiting for the first scan of this project'
			: 'Install the Vinv engines to begin';
	}
	if (f.discovered) {
		if (f.handbookPath) {
			links.push({
				label: 'Project handbook',
				detail: 'What Vinv learned about this codebase, in plain words',
				openPath: f.handbookPath,
				markdownPreview: true,
				state: 'ok',
			});
		}
		links.push({
			label: 'Code map',
			detail: 'Every function on one interactive map',
			command: 'vinv-vs.openGraphExplorer',
			state: 'ok',
		});
		if (f.pendingEdges > 0) {
			links.push({
				label: `Sharpen the map (${f.pendingEdges} unresolved links)`,
				detail: 'Let your agent resolve the references the scanner would not guess',
				command: 'vinv-vs.enhanceGraph',
				state: 'muted',
			});
		}
	}
	return {
		id: 'discover',
		title: 'Discover',
		blurb: 'Vinv reads the project and writes down what it found',
		status,
		summary,
		links,
	};
}

function servicesStage(f: FlowFacts): FlowStage {
	const real = f.services.filter((s) => s.state !== 'library');
	const set = real.filter((s) => s.state === 'ready' || s.state === 'running');
	const failed = real.filter((s) => s.state === 'failed');
	let status: FlowStageStatus;
	let summary: string;
	if (!f.discovered) {
		status = 'waiting';
		summary = 'Starts after the project scan';
	} else if (failed.length > 0) {
		status = 'error';
		summary = `${failed.length} service${failed.length === 1 ? '' : 's'} could not be set up`;
	} else if (real.length > 0 && set.length === real.length) {
		status = 'done';
		summary = `All ${real.length} service${real.length === 1 ? '' : 's'} know how to start`;
	} else if (real.length === 0) {
		status = f.services.length > 0 ? 'done' : 'waiting';
		summary =
			f.services.length > 0 ? 'Only libraries here — nothing needs to run' : 'No services listed yet';
	} else {
		status = 'waiting';
		summary = `${set.length}/${real.length} services set up so far`;
	}
	const links: FlowLink[] = f.services.map((s) => {
		const detailByState: Record<ServiceFact['state'], string> = {
			running: 'running now, with tracing on',
			ready: 'ready — how it starts is on record',
			failed: s.detail || 'set-up failed',
			library: 'a library — nothing to run',
			unattempted: 'not set up yet',
		};
		const link: FlowLink = {
			label: s.name,
			detail: detailByState[s.state],
			state:
				s.state === 'running'
					? 'running'
					: s.state === 'ready'
						? 'ok'
						: s.state === 'failed'
							? 'error'
							: 'muted',
		};
		if (s.startCommandPath) {
			// "How each service starts" — the recorded, verified start command.
			link.openPath = s.startCommandPath;
		} else if (s.state === 'unattempted' || s.state === 'failed') {
			link.command = 'vinv-vs.serviceSetup';
			link.args = [s.name];
		}
		return link;
	});
	return {
		id: 'services',
		title: 'Services',
		blurb: 'How each part of the project starts',
		status,
		summary,
		links: capLinks(links, 8),
	};
}

function tracesStage(f: FlowFacts): FlowStage {
	const live = f.services.some((s) => s.state === 'running');
	let status: FlowStageStatus;
	let summary: string;
	if (live) {
		status = 'running';
		summary = 'Recording live — every call, timing, and error';
	} else if (f.sessionCount > 0) {
		status = 'done';
		summary = `${f.sessionCount} traced run${f.sessionCount === 1 ? '' : 's'} captured`;
	} else {
		status = 'waiting';
		summary = 'Waiting for the first traced run';
	}
	const links: FlowLink[] = [];
	if (f.sessionCount > 0 || live) {
		links.push({
			label: 'What actually ran',
			detail: 'Every entry point that was hit, busiest first',
			command: 'vinv.sessions.focus',
			state: 'ok',
		});
	}
	const busiest = [...f.tracedEndpoints]
		.filter((e) => e.traceCount > 0)
		.sort((a, b) => b.traceCount - a.traceCount)
		.slice(0, 3);
	for (const e of busiest) {
		links.push({
			label: e.label,
			detail: `${e.traceCount} traced request${e.traceCount === 1 ? '' : 's'}`,
			command: 'vinv-vs.openCallTree',
			args: [{ apiId: e.apiId, label: e.label }],
			state: 'ok',
		});
	}
	return {
		id: 'traces',
		title: 'Traces',
		blurb: 'What actually ran, recorded call by call',
		status,
		summary,
		links,
	};
}

function insightsStage(f: FlowFacts): FlowStage {
	const links: FlowLink[] = f.reports.map((r) => ({
		label: r.kind === 'smoke' ? `Health report — ${r.label}` : `Where time went — ${r.label}`,
		detail:
			(r.kind === 'smoke'
				? 'Pass/fail, slow spots, and errors for this endpoint'
				: 'Call tree and flamegraph for this endpoint') +
			(r.stale ? ' · code changed since this was built' : ''),
		openPath: r.path,
		state: r.stale ? 'muted' : 'ok',
	}));
	let status: FlowStageStatus;
	let summary: string;
	if (f.insight?.phase === 'running') {
		status = 'running';
		summary = f.insight.label || 'Building call trees and reports…';
	} else if (f.insight?.phase === 'failed') {
		status = 'error';
		summary = f.insight.error || 'Report building failed';
	} else if (f.reports.length > 0) {
		status = 'done';
		summary = `${f.reports.length} report${f.reports.length === 1 ? '' : 's'} ready`;
	} else if (f.sessionCount > 0) {
		status = 'waiting';
		summary = 'Reports build on their own after a traced run';
	} else {
		status = 'waiting';
		summary = 'Reports appear once something has run';
	}
	if (f.diffImpact && f.diffImpact.changedSymbols > 0) {
		links.push({
			label: 'What your latest changes touch',
			detail: `${f.diffImpact.changedSymbols} changed, ${f.diffImpact.impactedSymbols} affected — shown on the code map`,
			command: 'vinv-vs.openGraphExplorer',
			state: 'ok',
		});
	}
	return {
		id: 'insights',
		title: 'Insights',
		blurb: 'Call trees, flamegraphs, and health reports',
		status,
		summary,
		links: capLinks(links, 8),
	};
}

/** The behavioral-coverage summary row + scorecard link for the Verify stage. */
function exerciseLinks(f: FlowFacts): FlowLink[] {
	const ex = f.exercise;
	if (!ex || (ex.total === 0 && ex.phase === 'idle')) {
		return [];
	}
	const parts = [`Behavior coverage ${ex.endpointsCovered}/${ex.total} endpoints`];
	if (ex.invariants > 0) {
		parts.push(`${ex.invariants} invariants`);
	}
	if (ex.issues > 0) {
		parts.push(`${ex.issues} behavioral issue${ex.issues === 1 ? '' : 's'}`);
	}
	const links: FlowLink[] = [
		{
			label: parts.join(' · '),
			detail:
				ex.phase === 'running'
					? ex.label || 'exercising every discovered endpoint…'
					: 'Vinv drove every discovered endpoint itself, not just observed traffic',
			openPath: ex.scorecardPath,
			state: ex.phase === 'running' ? 'running' : ex.issues > 0 ? 'error' : 'ok',
		},
	];
	return links;
}

function verifyStage(f: FlowFacts): FlowStage {
	const links: FlowLink[] = exerciseLinks(f);
	let status: FlowStageStatus;
	let summary: string;
	if (f.probe?.phase === 'running') {
		status = 'running';
		summary = f.probe.label || 'Checking the live endpoints…';
		for (const p of f.probes) {
			links.push({
				label: p.label,
				detail: p.detail ?? (p.passed ? 'passing' : 'failing'),
				state: p.passed ? 'ok' : 'error',
			});
		}
	} else if (f.probes.length > 0) {
		const passed = f.probes.filter((p) => p.passed).length;
		status = passed === f.probes.length && f.issues.length === 0 ? 'done' : 'error';
		summary = `${passed}/${f.probes.length} checks passing`;
		for (const p of f.probes) {
			links.push({
				label: p.label,
				detail: p.detail ?? (p.passed ? 'passing' : 'failing'),
				state: p.passed ? 'ok' : 'error',
			});
		}
	} else if (f.issues.length > 0) {
		status = 'error';
		summary = `${f.issues.length} problem${f.issues.length === 1 ? '' : 's'} found in live runs`;
	} else if (f.sessionCount > 0) {
		status = 'done';
		summary = 'No failures seen in what ran';
	} else {
		status = 'waiting';
		summary = 'Checks run once something has been traced';
	}
	return {
		id: 'verify',
		title: 'Verify',
		blurb: 'Does it actually work? Problems land here',
		status,
		summary,
		links: capLinks(links, 8),
	};
}

/** Computes the whole rail from observable facts. Pure. */
export function computeFlowModel(f: FlowFacts): FlowModel {
	const stages = [
		discoverStage(f),
		servicesStage(f),
		tracesStage(f),
		insightsStage(f),
		verifyStage(f),
	];

	// Auto-Pilot's live step is the spine: its current stage pulses with the
	// live label, whatever the artifact-derived status would have said. The
	// hub's coarse phase names the stage when published; the step label fills
	// the gap for the setup steps that predate a phase.
	if (f.autoPilot.running) {
		const active = pipelineStage(f.pipelinePhase) ?? autoPilotStage(f.autoPilot.label);
		for (const s of stages) {
			if (s.id === active) {
				s.status = 'running';
				s.activity = f.autoPilot.label ? `Auto-Pilot: ${f.autoPilot.label}` : 'Auto-Pilot running';
			}
		}
	}

	const issues: FlowIssue[] = f.issues.map((i) => ({
		...i,
		fixArgs: {
			issue: i.detail ? `${i.title}\n\n${i.detail}` : i.title,
			service: i.service,
			row: i.row,
		},
	}));

	// One next action, only when a human is actually needed. While Auto-Pilot
	// drives, the rail's pulsing stage is the answer, not a button.
	let nextAction: FlowNextAction | undefined;
	if (!f.autoPilot.running && f.nextStep) {
		nextAction = {
			label: f.nextStep.label,
			why: f.nextStep.detail,
			command: f.nextStep.command,
			args: f.nextStep.args,
		};
	}

	return { stages, issues, nextAction, autoPilot: f.autoPilot };
}

/**
 * The agent-legible mirror of the panel: plain JSON written to
 * .vinv/flow_state.json on every update, so agents debugging over MCP can read
 * the same state the human sees.
 */
export function flowStateJson(model: FlowModel, updatedAt: string): object {
	return {
		updated_at: updatedAt,
		auto_pilot: model.autoPilot,
		next_action: model.nextAction
			? {
					label: model.nextAction.label,
					why: model.nextAction.why,
					command: model.nextAction.command,
				}
			: null,
		stages: model.stages.map((s) => ({
			id: s.id,
			title: s.title,
			status: s.status,
			summary: s.summary,
			activity: s.activity ?? null,
			items: s.links.map((l) => ({
				label: l.label,
				detail: l.detail ?? null,
				path: l.openPath ?? null,
				command: l.command ?? null,
			})),
		})),
		issues: model.issues.map((i) => ({
			id: i.id,
			title: i.title,
			detail: i.detail ?? null,
			service: i.service ?? null,
			evidence: i.evidencePath ? `${i.evidencePath}${i.evidenceLine ? `:${i.evidenceLine}` : ''}` : null,
		})),
	};
}
