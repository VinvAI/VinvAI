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
	/**
	 * Values the exerciser gave up on and is asking a human for
	 * (.vinv/exercise/config_requests.json). Non-zero means a run is blocked on
	 * a person, so the rail has to say so — the panel that collects them opens
	 * only as a side effect of an exercise pass, and a closed tab was previously
	 * unrecoverable without re-running the whole pipeline.
	 */
	configRequests: number;
}

// ---- outputs ---------------------------------------------------------------

/**
 * The rail is four stages: find the code, get it running, drive it, read what
 * came back. Traces/Insights/Verify used to sit between the last two and were
 * cut — they reported machinery (captures recorded, reports built, probes run)
 * rather than anything the user decides on, and the one genuinely useful view
 * among them (the per-endpoint trace list) now has its own panel behind the
 * title-bar "View Traces" button instead of a rail stage nobody clicked.
 */
export type FlowStageId = 'discover' | 'services' | 'test' | 'findings';
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
	/**
	 * A second control on the same row, right-aligned — for when the row's own
	 * click already means something else. A ready service opens its recorded
	 * start command when clicked, so "run it" needs its own affordance rather
	 * than displacing that.
	 */
	action?: { icon: 'play' | 'stop'; title: string; command: string; args?: unknown[] };
	/**
	 * This row is past the stage's visible cap: the panel keeps it collapsed
	 * behind the "…and N more" toggle rather than showing it inline.
	 */
	overflow?: boolean;
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
	/**
	 * Everything that is not a pipeline stage, in one always-present footer.
	 *
	 * The rail is the only surface a user never has to go looking for, so it —
	 * not a nav bar repeated inside every panel — is where the other destinations
	 * live. Before this, Journey and the configuration panel had no entry point
	 * at all outside the command palette.
	 */
	destinations: FlowLink[];
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
		// Insights has no stage of its own any more: pipelineRunners rebuilds
		// reports whenever new spans land, so it is background work, not a step
		// anyone waits on. Leaving it unmapped means the rail keeps pulsing on
		// whichever stage the user actually cares about.
		case 'insights':
			return undefined;
		case 'probes':
			return 'test';
		case 'exercise':
			return 'test';
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
	// Bring-up owns "starting under tracing": the capture is a side effect of
	// getting the service up, not a step of its own.
	if (l.includes('under tracing') || l.includes('starting') || l.includes('already running')) {
		return 'services';
	}
	if (l.includes('verifying') || l.includes('probing') || l.includes('exercising')) {
		return 'test';
	}
	if (
		l.includes('fix episode') ||
		l.includes('dispatch') ||
		l.includes('giving up') ||
		l.includes('green')
	) {
		return 'findings';
	}
	return undefined;
}

/**
 * Cap what a stage shows at rest by marking the tail `overflow` — the panel
 * folds those rows behind an expandable "…and N more" toggle. The tail is
 * carried, not dropped: a workspace with nine services used to have one it
 * could not reach from the rail at all, because the row that stood in for it
 * was inert text.
 */
function capLinks(links: FlowLink[], max: number): FlowLink[] {
	if (links.length <= max) {
		return links;
	}
	return links.map((l, i) => (i < max - 1 ? l : { ...l, overflow: true }));
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
		summary =
			real.length === 1
				? 'This service knows how to start'
				: `All ${real.length} services know how to start`;
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
		// A service that knows how to start should be startable from here —
		// there is no Services tree to go to any more, and the row's own click
		// is already spoken for by the start-command file.
		if (s.state === 'ready') {
			link.action = {
				icon: 'play',
				title: `Start ${s.name} under tracing`,
				command: 'vinv-vs.serviceStart',
				args: [s.name],
			};
		} else if (s.state === 'running') {
			link.action = {
				icon: 'stop',
				title: `Stop ${s.name}`,
				command: 'vinv-vs.serviceStop',
				args: [s.name],
			};
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

/**
 * The Test stage: Vinv drives every discovered endpoint itself (the exercise
 * pass) and reports what came back. Triggerable — unlike the old Verify stage,
 * which only ever reflected whatever Auto-Pilot had already decided to run,
 * this one hands the user the button.
 */
function testStage(f: FlowFacts): FlowStage {
	const ex = f.exercise;
	const runnable = f.services.some((s) => s.state === 'running' || s.state === 'ready');
	const running = ex?.phase === 'running' || f.probe?.phase === 'running';
	const links: FlowLink[] = [];

	// The trigger is the first row, and it is present whenever there is
	// something to drive — including after a finished pass, because re-running
	// after a fix is the common case.
	if (runnable) {
		links.push({
			label: running ? 'Testing…' : ex && ex.total > 0 ? 'Test again' : 'Test it',
			detail: 'Drives every discovered endpoint, not just what traffic happened to hit',
			command: 'vinv-vs.runExercise',
			state: running ? 'running' : 'ok',
		});
	}

	let status: FlowStageStatus;
	let summary: string;
	if (ex?.phase === 'running') {
		status = 'running';
		summary = ex.label || 'Driving every discovered endpoint…';
	} else if (f.probe?.phase === 'running') {
		status = 'running';
		summary = f.probe.label || 'Checking the live endpoints…';
	} else if (ex && ex.total > 0) {
		status = ex.issues > 0 ? 'error' : 'done';
		const parts = [`${ex.endpointsCovered}/${ex.total} endpoints exercised`];
		if (ex.invariants > 0) {
			parts.push(`${ex.invariants} invariant${ex.invariants === 1 ? '' : 's'}`);
		}
		if (ex.issues > 0) {
			parts.push(`${ex.issues} behavioral issue${ex.issues === 1 ? '' : 's'}`);
		}
		summary = parts.join(' · ');
	} else if (f.probes.length > 0) {
		const passed = f.probes.filter((p) => p.passed).length;
		status = passed === f.probes.length && f.issues.length === 0 ? 'done' : 'error';
		// Probes and runtime issues are different evidence: every probe can pass
		// while a traced run still threw. Reporting only the probe tally then put
		// a red "needs attention" directly above "2/2 checks passing" and never
		// named the reason, so the summary carries both.
		summary = `${passed}/${f.probes.length} checks passing`;
		if (passed === f.probes.length && f.issues.length > 0) {
			summary += ` · ${f.issues.length} problem${f.issues.length === 1 ? '' : 's'} in live runs`;
		}
		// The probe rows themselves are pushed once, below, for every branch —
		// pushing them here too would list each probe twice.
	} else if (f.issues.length > 0) {
		status = 'error';
		summary = `${f.issues.length} problem${f.issues.length === 1 ? '' : 's'} found in live runs`;
	} else if (runnable) {
		// Ahead of the sessionCount branch below, deliberately. This stage asks
		// "have the endpoints been DRIVEN", and sessionCount only says traces
		// exist — ambient traffic hitting a running service produces those
		// without the exercise pass ever running. Reporting "no failures seen"
		// there would call an untested service tested.
		status = 'waiting';
		summary = 'Ready to test — nothing has been driven yet';
	} else if (f.sessionCount > 0) {
		// Not runnable, but traces exist: the service is stopped and all we can
		// honestly say is that nothing failed in what did run.
		status = 'done';
		summary = 'No failures seen in what ran';
	} else {
		status = 'waiting';
		summary = 'Set a service up first, then test it';
	}

	if (ex?.scorecardPath) {
		links.push({
			label: 'Behavior scorecard',
			detail: 'Per-endpoint coverage, invariants, and what came back',
			openPath: ex.scorecardPath,
			state: ex.issues > 0 ? 'error' : 'ok',
		});
	}
	for (const p of f.probes) {
		links.push({
			label: p.label,
			detail: p.detail ?? (p.passed ? 'passing' : 'failing'),
			state: p.passed ? 'ok' : 'error',
		});
	}
	return {
		id: 'test',
		title: 'Test',
		blurb: 'Drive every endpoint and see what comes back',
		status,
		summary,
		links: capLinks(links, 8),
	};
}

/**
 * The Findings stage: what Vinv found, grouped by the service it belongs to.
 * Each row opens the Findings view already filtered to that service, so the
 * rail answers "which service is unhappy" and the view answers "why".
 */
function findingsStage(f: FlowFacts): FlowStage {
	const byService = new Map<string, number>();
	for (const i of f.issues) {
		const key = i.service ?? '';
		byService.set(key, (byService.get(key) ?? 0) + 1);
	}

	let status: FlowStageStatus;
	let summary: string;
	if (f.issues.length > 0) {
		status = 'error';
		const svcCount = byService.size;
		summary =
			`${f.issues.length} finding${f.issues.length === 1 ? '' : 's'}` +
			(svcCount > 1 ? ` across ${svcCount} services` : '');
	} else if (f.exercise?.total || f.probes.length > 0 || f.sessionCount > 0) {
		status = 'done';
		summary = 'Nothing outstanding';
	} else {
		status = 'waiting';
		summary = 'Findings appear once something has been tested';
	}

	const links: FlowLink[] = [];
	for (const [service, n] of byService) {
		links.push({
			label: service || 'Workspace',
			detail: `${n} finding${n === 1 ? '' : 's'}`,
			command: 'vinv-vs.openFindings',
			// An empty key means the finding is not attributable to one service;
			// pass undefined so the view opens unfiltered rather than filtering
			// on the empty string and showing nothing.
			args: [{ service: service || undefined }],
			state: 'error',
		});
	}
	if (links.length === 0) {
		links.push({
			label: 'Open findings',
			detail: 'Everything Vinv has found and fixed',
			command: 'vinv-vs.openFindings',
			state: 'ok',
		});
	}
	return {
		id: 'findings',
		title: 'Findings',
		blurb: 'What Vinv found, per service',
		status,
		summary,
		links: capLinks(links, 8),
	};
}

/**
 * The footer's destinations, in the order a person needs them: the thing
 * blocking a run first, then read-what-happened, then explore, then ask.
 */
function destinationsFor(f: FlowFacts): FlowLink[] {
	const links: FlowLink[] = [];
	if (f.configRequests > 0) {
		links.push({
			label: `Vinv needs ${f.configRequests} value${f.configRequests === 1 ? '' : 's'}`,
			detail: 'a run is blocked until these are filled in',
			command: 'vinv-vs.openConfigRequests',
			state: 'error',
		});
	}
	links.push(
		{
			// One landing surface: services, issues, episodes, regression replay and
			// the endpoint profile, with the per-endpoint walkthrough reached from
			// inside it. Listing Journey as a sibling here asked the user to choose
			// between two tabs whose names do not tell them apart.
			label: 'Report',
			detail: 'services, findings, evidence — and the walk through what ran',
			command: 'vinv-vs.openFindings',
			state: 'ok',
		},
		{
			label: 'Code map',
			detail: 'every function, and what never ran',
			command: 'vinv-vs.openGraphExplorer',
			state: 'ok',
		},
		{
			label: 'Ask Vinv',
			detail: 'a question answered from the traces',
			command: 'vinv-vs.askVinv',
			state: 'ok',
		},
	);
	return links;
}

/** Computes the whole rail from observable facts. Pure. */
export function computeFlowModel(f: FlowFacts): FlowModel {
	const stages = [
		discoverStage(f),
		servicesStage(f),
		testStage(f),
		findingsStage(f),
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

	return { stages, issues, nextAction, autoPilot: f.autoPilot, destinations: destinationsFor(f) };
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
