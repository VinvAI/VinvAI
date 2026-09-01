/**
 * The event schema — every event Vinv can emit and every property it can carry,
 * in one file, on one screen.
 *
 * This is deliberately a types-only registry rather than a discriminated union
 * of event objects. Two reasons:
 *
 *   1. It is the audit surface. "What does Vinv send?" is answered by reading
 *      this file top to bottom, with no call sites in the way. That property is
 *      what the privacy claim rests on, so it is worth designing for.
 *   2. Call sites stay `track('name', { ... })` with full inference on the
 *      property bag, instead of `{ name: 'name', ... }` repeated at 40 sites.
 *
 * Property rules, enforced at runtime by sanitize.ts and worth knowing before
 * adding a line here:
 *   - booleans, finite numbers, and short opaque tokens only;
 *   - durations go through bucketMs, counts through bucketCount;
 *   - anything drawn from user data (a service kind, an editor name) goes
 *     through allowlist() first, because "short and lowercase" is not the same
 *     as "bounded".
 */
import type { ErrorClass } from './sanitize';

/** Where an event about a long-running operation came from. */
export type LongOpId =
	| 'index'
	| 'exercise'
	| 'probes'
	| 'insights'
	| 'episode'
	| 'autopilot'
	| 'calltree'
	| 'flow_build'
	| 'ide_chat'
	| 'harness_run'
	| 'optimize';

/** The four stages of runDiscovery, in order. */
export type DiscoveryStage = 'index' | 'handbook' | 'deadcode' | 'bringup';

export type Outcome = 'ok' | 'error' | 'cancelled';

/**
 * Stable ids for user-visible failures. Assigned BY HAND at the call site, which
 * is the whole point: the message text stays on the machine and this id is what
 * travels, so the set of things Vinv can say about a failure is closed and
 * reviewable rather than being whatever string the code happened to build.
 */
export type ErrorCode =
	| 'engines.not_found'
	| 'engines.install_failed'
	| 'engines.not_a_checkout'
	| 'engines.version_skew'
	| 'index.sidecar_unhealthy'
	| 'index.failed'
	| 'index.no_workspace'
	| 'harness.blocked'
	| 'harness.not_installed'
	| 'harness.no_headless'
	| 'harness.unreachable'
	| 'harness.prompt_failed'
	| 'harness.handoff_failed'
	| 'harness.no_deliverable'
	| 'harness.run_failed'
	| 'episode.no_index'
	| 'episode.revert_failed'
	| 'episode.already_running'
	| 'bringup.no_start_command'
	| 'bringup.start_failed'
	| 'bringup.hint_not_persisted'
	| 'bringup.no_spans'
	| 'autopilot.crashed'
	| 'autopilot.budget_exhausted'
	| 'flow.open_failed'
	| 'flow.calltree_failed'
	| 'graph.snapshot_failed'
	| 'report.action_failed'
	| 'document.open_failed'
	| 'mcp.no_targets';

/**
 * Every surface that can report an interaction or a crash.
 *
 * A closed set, because this is a property value: leaving it open would let a
 * renamed panel silently create a new bucket, and the point of these ids is
 * that "which surface do users actually use" stays answerable across releases.
 */
export type WebviewId =
	| 'ask_vinv'
	| 'graph_explorer'
	| 'findings'
	| 'optimization'
	| 'journey'
	| 'calltree'
	| 'episode'
	| 'flow'
	| 'traces'
	| 'deadcode'
	| 'configure'
	| 'config_requests'
	| 'smoke_report'
	| 'status_bar'
	| 'debug';

/** The Flow rail's stages — the pipeline the user actually watches. */
export type FlowStage = 'discover' | 'services' | 'test' | 'findings';

export interface EventProps {
	// -- lifecycle & onboarding funnel ---------------------------------------
	/** Once ever, per install. The denominator for every rate below. */
	install_first_seen: {
		editor: string;
		platform: string;
	};
	/** Every activation. DAU, activation cost, and the state of the installed base. */
	app_activated: {
		activation_ms: number;
		engines_installed: boolean;
		project_indexed: boolean;
		has_captures: boolean;
		services_count: number;
		workspace_open: boolean;
	};
	/** The Get Started walkthrough was opened automatically. */
	welcome_shown: { is_update: boolean };
	/** What the once-per-install open-source toast actually converted to. */
	oss_toast_action: { action: 'star' | 'get_started' | 'dismissed' };
	/**
	 * A funnel stage was reached for the first time on this install. Deduped
	 * against a globalState high-water mark, so it is once per install, not
	 * once per window and not once per reload.
	 */
	onboarding_stage: {
		stage: 'engines_installed' | 'discovered' | 'traced';
		days_since_install: number;
	};
	/** The aha moment: this install has observed a real trace hit for the first time. */
	milestone_first_trace: {
		days_since_install: number;
		hours_since_first_activation: number;
	};
	/** Where the next-step compass thinks the user is stuck. */
	next_step_shown: { step: string };

	// -- direct user activity --------------------------------------------------
	/**
	 * One interaction inside a Vinv surface — a button, a link, a filter, a
	 * thumbs-up.
	 *
	 * Deliberately ONE event with `view` + `action` properties rather than an
	 * event name per button. Vinv has a dozen panels and well over sixty
	 * distinct interactions; a name each would make the registry unreadable and
	 * force a schema change every time a button is added, which is exactly when
	 * instrumentation gets skipped. `action` values come from the panels' own
	 * message types, so they are already a closed vocabulary.
	 */
	ui_action: {
		view: WebviewId;
		action: string;
		detail?: string;
	};
	/** A panel or custom editor was opened. Answers which surfaces earn their keep. */
	view_opened: { view: WebviewId };
	/** A Flow rail stage changed state — the pipeline progression users watch. */
	flow_stage_changed: { stage: FlowStage; status: string };

	// -- commands -------------------------------------------------------------
	/** Every command invocation, via registerTrackedCommand. */
	command_finished: {
		command_id: string;
		outcome: Outcome;
		duration_ms: number;
		error_class?: ErrorClass;
	};
	/** The most common dead-end in the extension: a command run with no folder open. */
	command_blocked_no_folder: { command_id: string };

	// -- engines install: the biggest observability blind spot -----------------
	engines_install_started: {
		has_git: boolean;
		has_uv: boolean;
		has_rust: boolean;
		has_bash: boolean;
	};
	engines_prereq_missing: { tool: 'git' | 'uv' | 'rust' };
	/**
	 * Did an install that started ever finish? Reconciled on a later activation
	 * when the terminal never reported back — 'abandoned' is the number that
	 * decides whether the terminal-based installer survives.
	 */
	engines_install_settled: {
		outcome: 'ready' | 'abandoned';
		minutes_bucket: number;
	};
	engines_update_result: {
		outcome: 'ok' | 'failed' | 'skipped';
		mode: string;
	};
	/** The real distribution behind the 600s first-run model-download timeout. */
	embedder_ready: { waited_ms: number; cold_start: boolean };
	embedder_failed: {
		stage: 'spawn' | 'health_timeout';
		waited_ms: number;
		error_class: ErrorClass;
	};

	// -- the discovery pipeline ------------------------------------------------
	discovery_started: {
		trigger: 'auto' | 'command' | 'autopilot';
		force: boolean;
		harness_id: string;
	};
	/** One row per stage. Makes "which stage kills the pipeline" a single query. */
	discovery_stage: {
		stage: DiscoveryStage;
		outcome: Outcome;
		duration_ms: number;
	};
	discovery_finished: {
		outcome: 'done' | 'incomplete' | 'cancelled';
		index_ok: boolean;
		handbook_ok: boolean;
		deadcode_ok: boolean;
		bringup_ok: boolean;
		services_count: number;
		total_ms: number;
	};
	/** Was a silent console.error in discovery.ts. */
	autosetup_service_failed: { error_class: ErrorClass; services_total: number };
	/** The top two install blockers. */
	indexing_failed: {
		stage: 'sidecar_unhealthy' | 'attempts_exhausted';
		attempts: number;
		store_issue: boolean;
		error_class: ErrorClass;
	};
	/** Was a silent console.error in extension.ts. */
	mcp_registration_failed: { error_class: ErrorClass };

	// -- long operations -------------------------------------------------------
	long_op_finished: {
		op: LongOpId;
		outcome: Outcome;
		duration_ms: number;
	};

	// -- the agent harness -----------------------------------------------------
	/** How many users are dead in the water because their agent CLI is not signed in. */
	harness_blocked: { harness_id: string; kind: 'auth' | 'quota' | 'network' };
	harness_run_finished: {
		harness_id: string;
		failure_kind: string;
		exit_class: string;
		duration_ms: number;
	};
	episode_finished: {
		outcome: string;
		attempts: number;
		verified: boolean;
		f2p_gated: boolean;
	};
	autopilot_finished: {
		outcome: string;
		services_total: number;
		services_green: number;
		episodes: number;
		budget_exhausted: boolean;
	};

	// -- errors ----------------------------------------------------------------
	/**
	 * A user-visible error or warning was shown. `action_taken` also reveals
	 * remediation buttons that nobody ever clicks.
	 */
	error_shown: {
		code: ErrorCode;
		surface: 'error' | 'warning';
		action_taken: string;
	};
	/** A renderer crash. `digest` groups identical bugs; the message never travels. */
	webview_error: {
		view: WebviewId;
		error_class: ErrorClass;
		digest: string;
	};
	/** ENOENT here is the classic "engines installed but not on PATH". */
	spawn_failed: { engine: string; code: string };

	// -- shape & settings ------------------------------------------------------
	/** What real projects using Vinv actually look like. */
	workspace_shape: {
		languages: string;
		service_kinds: string;
		services_count: number;
		endpoints_bucket: number;
		symbols_bucket: number;
	};
	/** Do people turn Auto-Pilot off? */
	feature_toggled: { setting: string; value: string };
}

export type EventName = keyof EventProps;
