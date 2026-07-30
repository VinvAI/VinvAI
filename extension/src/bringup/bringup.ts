import * as path from 'path';
import * as fs from 'fs';

import {
	entrypointModule,
	judgeOwnCode,
	missingTargetPackage,
	serviceForEndpointFile,
	withTargetPackage,
	type OwnCodeVerdict,
} from './targetPackages';

/** Project-local service inventory: <workspace>/.vinv/services.json */
export function getServicesPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'services.json');
}

/** True when a non-empty service inventory has been written for the workspace. */
export function isServicesListed(workspaceRoot: string): boolean {
	try {
		return fs.statSync(getServicesPath(workspaceRoot)).size > 0;
	} catch {
		return false;
	}
}

/** One Python service from .vinv/services.json (bringup Stage 2a output). */
export interface ServiceEntry {
	name: string;
	kind?: string;
	command?: string;
	working_directory?: string;
	port?: number | null;
	modules?: string[];
}

/**
 * Reads and parses <workspace>/.vinv/services.json into its service entries.
 * Returns an empty array when the file is missing or unparseable, so callers can
 * treat "no inventory yet" and "empty inventory" uniformly.
 */
export function readServices(workspaceRoot: string): ServiceEntry[] {
	try {
		const raw = fs.readFileSync(getServicesPath(workspaceRoot), 'utf8');
		const parsed = JSON.parse(raw) as { services?: ServiceEntry[] };
		return Array.isArray(parsed.services) ? parsed.services : [];
	} catch {
		return [];
	}
}

/** A point-in-time bring-up progress update (see runBringupListViaHarness). */
export interface BringupProgress {
	/** Always null: the harness emits phase labels, not a completion fraction. */
	percent: number | null;
	/** Human-readable status line for the UI. */
	label: string;
}


/**
 * Project-local verified start command for a service:
 * .vinv/start_commands/<slug>.json. The engine slugs the service name when it
 * writes this file, so a name like `Admin backend (Python)` lands at
 * `Admin_backend__Python_.json` — reading it back under the raw name silently
 * reports the service as never brought up.
 */
function getStartCommandPath(workspaceRoot: string, service: string): string {
	return path.join(workspaceRoot, '.vinv', 'start_commands', `${serviceSlug(service)}.json`);
}

/**
 * Filesystem-safe slug for a service name, mirroring bringup's own
 * `re.sub(r"[^A-Za-z0-9_.-]", "_", service) or "service"` EXACTLY. Both the
 * start-hint file this side writes and the start-command file the engine writes
 * are named by this slug, so a divergence here would not error — it would
 * silently drop the operator's answer, or hide a verified bring-up.
 */
export function serviceSlug(service: string): string {
	return service.replace(/[^A-Za-z0-9_.-]/g, '_') || 'service';
}

/** Project-local operator start hint: .vinv/start_hints/<service>.json */
function getStartHintPath(workspaceRoot: string, service: string): string {
	return path.join(workspaceRoot, '.vinv', 'start_hints', `${serviceSlug(service)}.json`);
}

/**
 * Reads how the operator said they start this service, or null when they have
 * never been asked (or the file was hand-edited into something unusable).
 *
 * This is a hint about WHICH command to trace — never a verified artifact. It
 * is deliberately NOT consulted by isServiceStarted/readStartCommands: only a
 * `verified: true` record from a real traced bring-up may drive the Run button.
 */
export function readStartHint(workspaceRoot: string, service: string): string | null {
	try {
		const raw = fs.readFileSync(getStartHintPath(workspaceRoot, service), 'utf8');
		const parsed = JSON.parse(raw) as { command?: unknown };
		const command = typeof parsed.command === 'string' ? parsed.command.trim() : '';
		return command || null;
	} catch {
		return null;
	}
}

/**
 * Records the operator's start command so every later bring-up of this service
 * picks it up without asking again (bringup's `_read_start_hint` reads this
 * path when no explicit `--start-hint` is passed). Throws on write failure —
 * the caller must not report a persisted hint that never landed.
 *
 * Returns the file it wrote, so callers can point the operator at the real
 * path: the filename is a slug, which is not `<service>.json` for a name like
 * `api/v2`.
 */
export function writeStartHint(workspaceRoot: string, service: string, command: string): string {
	const file = getStartHintPath(workspaceRoot, service);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${JSON.stringify(
			{
				service,
				command: command.trim(),
				source: 'operator',
				recorded_at: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
		'utf8',
	);
	return file;
}

/**
 * True when a service has a recorded, **verified** start command on disk.
 *
 * `bringup start` now always writes .vinv/start_commands/<service>.json — even
 * on a failed bring-up, where it records `verified: false` plus the closest
 * commands it ran for debugging. So mere file existence no longer means the
 * service came up; we must read the file and require `verified === true` (and a
 * non-empty `commands` list). Checking only `size > 0` would mark a failed
 * bring-up as "started".
 */
export function isServiceStarted(workspaceRoot: string, service: string): boolean {
	try {
		const raw = fs.readFileSync(getStartCommandPath(workspaceRoot, service), 'utf8');
		const parsed = JSON.parse(raw) as { verified?: boolean; commands?: StartCommand[] };
		return parsed.verified === true && Array.isArray(parsed.commands) && parsed.commands.length > 0;
	} catch {
		return false;
	}
}

/** The bring-up outcome for a service, read from its recorded attempt. */
export type BringupOutcome =
	| { state: 'unattempted' }
	| { state: 'verified' }
	/** The agent investigated and concluded there is nothing to run (a pure
	 * library module) — recorded as verified:false with an empty command list. */
	| { state: 'library'; symptom?: string }
	| { state: 'failed'; symptom?: string };

/**
 * Classifies the recorded bring-up attempt. Distinguishes "never tried",
 * "verified", "tried and failed", and the honest negative: the agent proved
 * the module is a library with no server to start.
 */
export function readBringupOutcome(workspaceRoot: string, service: string): BringupOutcome {
	let raw: string;
	try {
		raw = fs.readFileSync(getStartCommandPath(workspaceRoot, service), 'utf8');
	} catch {
		return { state: 'unattempted' };
	}
	try {
		const parsed = JSON.parse(raw) as {
			verified?: boolean;
			commands?: StartCommand[];
			failure_symptom?: string;
			failure_kind?: string;
		};
		if (parsed.verified === true && (parsed.commands?.length ?? 0) > 0) {
			return { state: 'verified' };
		}
		const symptom = parsed.failure_symptom;
		// A recorded kind is a fact; the prose heuristic below is a guess. Where
		// we wrote the record ourselves, don't re-derive it from the wording.
		if (parsed.failure_kind === 'untraced') {
			return { state: 'failed', symptom };
		}
		const noCommand = !Array.isArray(parsed.commands) || parsed.commands.length === 0;
		const libraryClues = /library|no module named .*__main__|cannot be directly executed|no.*entrypoint/i;
		if (noCommand || (symptom !== undefined && libraryClues.test(symptom))) {
			return { state: 'library', symptom };
		}
		return { state: 'failed', symptom };
	} catch {
		return { state: 'unattempted' };
	}
}

/**
 * The capture subdirectory to overlay an endpoint from — the slug of whichever
 * service defines it, or undefined when the join is ambiguous.
 *
 * Lives here, next to `readServices`, because THREE call sites need it and
 * missing one is not a cosmetic slip: the call-tree view re-runs `tracemap`
 * every second and rewrites the very snapshot the insight pass wrote, so a view
 * that omits the service silently replaces a correct overlay with one read off
 * whichever service traced most recently.
 */
export function captureServiceFor(
	workspaceRoot: string,
	file: string | undefined,
): string | undefined {
	if (!file) {
		return undefined;
	}
	const name = serviceForEndpointFile(readServices(workspaceRoot), file);
	// Captures are keyed by the SLUG (.vinv/captures/<session>/<slug>/), which is
	// what the engine matches the directory name against.
	return name ? serviceSlug(name) : undefined;
}

/**
 * Span component names from a trace — ENTER events only.
 *
 * The enter filter is the whole point. tracelens writes an `enter` AND a
 * matching `exit` for every span, so scanning the file for `"component"` counted
 * each one twice and the audit told the user a service had "served 4 requests"
 * when it served 2. Parsed per line rather than regexed over the whole text
 * precisely so `event` can be consulted; a bring-up capture is a few thousand
 * lines and this runs once, so the cost is irrelevant next to being right.
 */
function traceComponents(traceFile: string): string[] {
	let text: string;
	try {
		text = fs.readFileSync(traceFile, 'utf8');
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const ev = JSON.parse(trimmed) as { component?: unknown; event?: unknown };
			if (ev.event === 'enter' && typeof ev.component === 'string') {
				out.push(ev.component);
			}
		} catch {
			// torn or partial line — a live capture is appended to while we read
		}
	}
	return out;
}

/** Where this service's bring-up capture landed, per its own record. */
function recordedTracePath(workspaceRoot: string, service: string): string {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(getStartCommandPath(workspaceRoot, service), 'utf8'),
		) as { verification?: { trace_jsonl?: unknown } };
		const recorded = parsed.verification?.trace_jsonl;
		if (typeof recorded === 'string' && recorded.trim()) {
			return recorded;
		}
	} catch {
		// fall through to the conventional location
	}
	return path.join(
		workspaceRoot, '.vinv', 'captures', 'vinv-bringup', serviceSlug(service), 'trace.jsonl',
	);
}

/**
 * Did this service's OWN code actually get traced?
 *
 * A bring-up passes on "the port answered and spans exist", which both hold
 * when tracelens instrumented the wrong package: the framework's inbound spans
 * land, the handlers under them do not, and every downstream surface reports
 * zero coverage with no error to explain it. This asks the question that
 * distinguishes them, and only where the answer is unambiguous — see
 * judgeOwnCode, which refuses to call a port-only probe a failure.
 */
export function auditOwnCodeTracing(
	workspaceRoot: string,
	service: ServiceEntry,
): OwnCodeVerdict {
	return judgeOwnCode(
		traceComponents(recordedTracePath(workspaceRoot, service.name)),
		service.command ? entrypointModule(service.command) : null,
	);
}

/**
 * Adds the entrypoint's package to a recorded start command that omits it.
 *
 * The extension already computes the right `--module` values and the bring-up
 * prompt tells the agent to use them verbatim; an agent that drops one leaves a
 * record that starts the service green and traces none of its own code, forever,
 * because the record is replayed exactly as written and lives outside the repo
 * where no later fix pass reaches it. Observed on three of four services in one
 * workspace, so this is not a rare miss.
 *
 * Repairing rather than re-asking, because the value is derived, not judged, and
 * the edit is additive — see withTargetPackage. Returns the package it added, or
 * null when there was nothing to fix.
 */
export function repairRecordedTargetPackages(
	workspaceRoot: string,
	service: ServiceEntry,
): string | null {
	const file = getStartCommandPath(workspaceRoot, service.name);
	let parsed: { commands?: StartCommand[] } & Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof parsed;
	} catch {
		return null;
	}
	const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
	let added: string | null = null;
	for (const c of commands) {
		const missing = missingTargetPackage(c.command, service);
		if (missing) {
			c.command = withTargetPackage(c.command, missing);
			added = missing;
		}
	}
	if (!added) {
		return null;
	}
	try {
		fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
	} catch {
		return null; // the caller must not claim a repair that never landed
	}
	return added;
}

/**
 * Records a bring-up as NOT verified because its own code was never traced.
 *
 * Downgrading rather than warning is deliberate: `verified: true` is what makes
 * the Run button, the exercise pass and Auto-Pilot treat the service as usable
 * evidence, and a service that serves requests while tracing none of its own
 * code produces confident, empty findings. The symptom text is what the fixing
 * agent reads, so it names the concrete defect and the file to repair.
 */
export function markUntracedBringup(
	workspaceRoot: string,
	service: string,
	verdict: Extract<OwnCodeVerdict, { state: 'absent' }>,
	/**
	 * Set when the recorded command was just corrected. The record is still not
	 * verified — this capture genuinely traced nothing — but "fix the flags" is
	 * now stale advice contradicting a fix that already happened, and "set it up
	 * again" would send the user back through the step that produced the bad
	 * command in the first place. What is actually needed is another run.
	 */
	repairedPackage?: string,
): void {
	const file = getStartCommandPath(workspaceRoot, service);
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {
		return;
	}
	parsed.verified = false;
	// Explicit, because readBringupOutcome otherwise classifies from the symptom
	// PROSE — and a sentence about the module a start command runs trips its
	// "this is a library with nothing to start" heuristic, which would park the
	// service as unstartable instead of queueing the repair.
	parsed.failure_kind = 'untraced';
	parsed.failure_symptom = repairedPackage
		? `The service started and served ${verdict.requests} request(s), but every span came from ` +
			`somewhere other than its own package '${verdict.rootPackage}' — this capture was made ` +
			`before the command was fixed. '--target-package ${repairedPackage}' has since been added ` +
			`to this file, so nothing here needs editing: RUN the service again and the next capture ` +
			`will carry its own code.`
		: `The service started and served ${verdict.requests} request(s), but every span came from ` +
			`somewhere other than its own package '${verdict.rootPackage}' — tracelens instrumented ` +
			`the wrong code. Fix the '--target-package' flags in this file's start command so they ` +
			`include '${verdict.rootPackage}'. Until they do, every endpoint reports 0% coverage and ` +
			`no latency, with nothing raising an error to explain it.`;
	try {
		fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
	} catch {
		// The in-memory verdict still reaches the caller.
	}
}

/** One verified command from .vinv/start_commands/<service>.json (bringup Stage 2b output). */
export interface StartCommand {
	purpose?: string;
	command: string;
	working_directory?: string;
	session_name?: string | null;
}

/**
 * Reads the verified start command(s) recorded for a service by `bringup start`.
 * Each file holds an ordered list (e.g. a dependency to bring up first, then the
 * service itself under tracelens). Returns [] when no verified file exists.
 */
export function readStartCommands(workspaceRoot: string, service: string): StartCommand[] {
	try {
		const raw = fs.readFileSync(getStartCommandPath(workspaceRoot, service), 'utf8');
		const parsed = JSON.parse(raw) as { verified?: boolean; commands?: StartCommand[] };
		// A `verified: false` file holds the closest commands a FAILED bring-up
		// ran — they are not known-good, so don't offer them for replay.
		if (parsed.verified !== true) {
			return [];
		}
		return Array.isArray(parsed.commands) ? parsed.commands : [];
	} catch {
		return [];
	}
}
