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
 * A discovery stage's outcome, which has one state the generic Outcome does not:
 * 'skipped'.
 *
 * A stage that never ran used to emit NOTHING, and the silence was
 * indistinguishable from a stage that ran and passed. That gap is exactly what
 * made a real failure unreadable: bringup only runs when a handbook exists, so a
 * missing handbook produced a session with no bringup row at all, and "no
 * services were found" could not be told apart from "services were never looked
 * for". A skip is a fact about the pipeline and has to travel like one.
 */
export type StageOutcome = Outcome | 'skipped';

/**
 * Why a discovery stage never ran. Paired with outcome 'skipped'.
 *
 * 'no_harness' is the one worth naming on its own: the LLM stages need a coding
 * agent, and the first-run picker returning null is a user-facing dead end that
 * looked, in the data, exactly like success.
 */
export type StageSkipReason = 'no_harness' | 'no_handbook' | 'cancelled';

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
	/**
	 * A command was invoked. Paired with `command_finished`.
	 *
	 * Not redundant with it: a command that never finishes — the handler hangs
	 * on a harness dispatch, the window closes mid-run — emits only this one, and
	 * the gap between the two counts is the only way to see it. A completion-only
	 * event cannot report the runs that never complete.
	 */
	command_started: { command_id: string };
	/** Every command invocation, via registerTrackedCommand. */
	command_finished: {
		command_id: string;
		outcome: Outcome;
		duration_ms: number;
		error_class?: ErrorClass;
		/** Groups identical failures across users; the message never travels. */
		error_digest?: string;
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
	/**
	 * A prerequisite the installer needs is not usable.
	 *
	 * `reason` separates the two cases that need different fixes: 'absent' is an
	 * onboarding problem (tell the user to install it), 'version' is ours (the
	 * tool is there and we rejected it), and collapsing them — as this event did
	 * — makes a version floor we chose look like a tool the user never installed.
	 */
	engines_prereq_missing: { tool: 'git' | 'uv' | 'rust'; reason: 'absent' | 'version' };
	/**
	 * Which route an engines install took, and whether a fallback was armed.
	 *
	 * The two routes fail for completely unrelated reasons — the wheel needs a
	 * published artifact for the platform, the source build needs a working C
	 * linker — so an install-success rate that does not say which one ran cannot
	 * be acted on. This is also the only way to see the fallback earning its
	 * keep: a rising count of source-route recoveries means the wheel is not
	 * reaching people it should.
	 */
	engines_install_route: { route: 'wheel' | 'source'; has_recovery: boolean };
	/**
	 * Did an install that started ever finish? Reconciled on a later activation
	 * when the terminal never reported back — 'abandoned' is the number that
	 * decides whether the terminal-based installer survives.
	 *
	 * The prereq flags are repeated at SETTLE time, not just at start: an install
	 * that abandons with a prerequisite still missing is a different failure from
	 * one that abandons with everything present, and only the settle-time state
	 * can tell them apart.
	 */
	engines_install_settled: {
		outcome: 'ready' | 'abandoned';
		minutes_bucket: number;
		has_git: boolean;
		has_uv: boolean;
		has_rust: boolean;
	};
	engines_update_result: {
		outcome: 'ok' | 'failed' | 'skipped';
		mode: string;
	};
	/**
	 * The environment, probed once per activation.
	 *
	 * The single most useful row in this file for answering "what state is this
	 * user actually in". Every failure event says what broke; this says what the
	 * machine had when it broke — and the two most common dead ends (no agent
	 * installed at all, engines never installed) are invisible in a failure
	 * event, because in both cases nothing ever runs to fail.
	 */
	environment_probed: {
		engines_installed: boolean;
		has_git: boolean;
		has_uv: boolean;
		has_rust: boolean;
		/** False here is the dead end: no agent, so no LLM stage can ever run. */
		any_harness_installed: boolean;
		harness_installed_count: number;
		/** Whether the remembered harness is a real choice or the fallback default. */
		harness_chosen: boolean;
		/** Whether the SELECTED harness is present, as opposed to any harness. */
		selected_harness_installed: boolean;
		workspace_open: boolean;
		project_indexed: boolean;
		handbook_present: boolean;
		services_present: boolean;
	};
	/** The real distribution behind the 600s first-run model-download timeout. */
	embedder_ready: { waited_ms: number; cold_start: boolean };
	embedder_failed: {
		stage: 'spawn' | 'health_timeout';
		waited_ms: number;
		error_class: ErrorClass;
	};

	// -- the discovery pipeline ------------------------------------------------
	/**
	 * A discovery run began, with the state it began FROM.
	 *
	 * The preflight fields are the point. Every question worth asking about a
	 * failed run — was an agent even installed, was there already an index, had
	 * a handbook survived from last time — is a question about the starting
	 * state, and the run itself overwrites most of it before it finishes.
	 * Reconstructing it afterwards from other events is guesswork.
	 */
	discovery_started: {
		trigger: 'auto' | 'command' | 'autopilot';
		force: boolean;
		harness_id: string;
		/** Whether the SELECTED harness is actually present on this machine. */
		harness_installed: boolean;
		/** Whether ANY agent is installed. False is a dead end, not a bad choice. */
		any_harness_installed: boolean;
		index_present: boolean;
		handbook_present: boolean;
		services_present: boolean;
	};
	/**
	 * One row per stage. Makes "which stage kills the pipeline" a single query.
	 *
	 * The three error fields are what turn that query from "which" into "why".
	 * Without them a failed stage is a bare boolean, and a stage failing on every
	 * machine of one platform is indistinguishable from a stage failing because
	 * the user never signed into their agent CLI — which is a support answer, not
	 * a bug. All three are absent on a successful stage.
	 */
	discovery_stage: {
		stage: DiscoveryStage;
		outcome: StageOutcome;
		duration_ms: number;
		/** Coarse cause. `auth` vs `enoent` vs `spawn` separates the top three. */
		error_class?: ErrorClass;
		/** Groups identical failures across users; the message never travels. */
		error_digest?: string;
		/** The hand-assigned id, where the stage knows precisely what went wrong. */
		error_code?: ErrorCode;
		/** Set only with outcome 'skipped'. */
		skip_reason?: StageSkipReason;
	};
	discovery_finished: {
		outcome: 'done' | 'incomplete' | 'cancelled';
		index_ok: boolean;
		handbook_ok: boolean;
		deadcode_ok: boolean;
		bringup_ok: boolean;
		services_count: number;
		/**
		 * Whether bringup actually executed this run.
		 *
		 * `services_count` reads services.json off disk, so a file left by an
		 * EARLIER run counts even when bringup never ran this time. Without this
		 * flag the count silently overstates how often discovery produces
		 * services, and only on machines where it has ever worked once — which
		 * biases the metric in precisely the direction that hides a regression.
		 */
		bringup_ran: boolean;
		total_ms: number;
	};
	/** Was a silent console.error in discovery.ts. */
	autosetup_service_failed: { error_class: ErrorClass; services_total: number };
	/** An indexing run began, and what it began from. */
	indexing_started: {
		store_present: boolean;
		/** A present-but-incomplete store is the torn-save case worth separating. */
		store_complete: boolean;
		max_attempts: number;
	};
	/**
	 * One attempt of the retry loop settled.
	 *
	 * Per attempt, not per run: a run that succeeds on the third try and one
	 * that succeeds on the first collapse into the same successful run, and only
	 * the first is a bug. This is also the only place the retry loop's own
	 * failure detail survives — `indexing_failed` fires once, after all three.
	 */
	indexing_attempt: {
		attempt: number;
		outcome: Outcome;
		duration_ms: number;
		error_class?: ErrorClass;
		error_digest?: string;
	};
	/** The top two install blockers. */
	indexing_failed: {
		stage: 'sidecar_unhealthy' | 'attempts_exhausted';
		attempts: number;
		store_issue: boolean;
		error_class: ErrorClass;
	};
	/**
	 * The user stopped a long operation, and where.
	 *
	 * A cancellation is not a neutral non-event: on a first run the model
	 * download is minutes long, and a user walking away from it produces exactly
	 * the same "no index" end state as a hard failure. `checkpoint` is what
	 * separates "gave up waiting" from "changed their mind at the end".
	 */
	run_cancelled: {
		op: LongOpId;
		checkpoint: string;
		elapsed_ms: number;
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
	/**
	 * The harness dropdown was shown, with what the presence scan found.
	 *
	 * This answers the question every other harness event assumes away: what
	 * agents does the user actually HAVE? A dispatch that fails because the
	 * chosen CLI is missing, and a user who has no agent installed at all, are
	 * the same row everywhere else — and the second is an onboarding problem, not
	 * a bug.
	 *
	 * ONE BOOLEAN PER HARNESS, not a list: property values are bounded tokens
	 * (see sanitize.ts), an array would not survive the allowlist, and a
	 * per-harness column is what makes "how many users have any agent at all"
	 * a single query instead of a string parse. Keep these in sync with
	 * HARNESSES in harnessRunner.ts — `scanned_count` catches the drift when
	 * they fall behind.
	 */
	harness_picker_shown: {
		/** 'first_run' is the once-per-install picker discovery forces; the rest are clicks. */
		reason: 'first_run' | 'explicit';
		/** The preselected id — the remembered choice, or the claude-code default. */
		remembered_id: string;
		/** False when `remembered_id` is only the default, not a real choice. */
		harness_chosen: boolean;
		/** How many of the scanned harnesses are installed/reachable right now. */
		ready_count: number;
		/** Total harnesses offered. Diverging from the booleans below means drift. */
		scanned_count: number;
		avail_claude_code: boolean;
		avail_codex: boolean;
		avail_cursor: boolean;
		avail_gemini: boolean;
		avail_copilot_chat: boolean;
		avail_cursor_chat: boolean;
		avail_windsurf: boolean;
	};
	/** How the picker ended. The dismissal rate is the first-run drop-off. */
	harness_picker_resolved: {
		reason: 'first_run' | 'explicit';
		outcome: 'picked' | 'installed' | 'dismissed';
		/** 'none' when dismissed — the id is never a free-text value. */
		harness_id: string;
		/** True when the pick was a not-installed row that triggered an install. */
		was_missing: boolean;
	};
	/**
	 * One raw dispatch to an agent CLI settled. The missing half of the
	 * discovery funnel: a handbook stage that fails is a boolean, and this is the
	 * row that says whether the CLI was absent, refused, timed out or crashed.
	 */
	harness_run_finished: {
		harness_id: string;
		outcome: Outcome;
		failure_kind: string;
		exit_class: string;
		duration_ms: number;
		/** Coarse cause, shared vocabulary with every other failure event. */
		error_class?: ErrorClass;
		/** Groups identical failures; the CLI's output never travels. */
		error_digest?: string;
	};
	/**
	 * One closed-loop episode settled.
	 *
	 * `attempts` is the point: an episode that verifies on the first try and one
	 * that verifies on the fourth are the same success everywhere else, and the
	 * gap between them is the cost the user actually paid.
	 *
	 * (The declared `f2p_gated` field was dropped: no fail-to-pass gate exists
	 * anywhere in the episode loop, so it could only ever have been a constant.)
	 */
	episode_finished: {
		outcome: string;
		attempts: number;
		verified: boolean;
		harness_id: string;
		duration_ms: number;
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
