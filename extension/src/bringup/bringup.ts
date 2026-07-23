import * as path from 'path';
import * as fs from 'fs';

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
		};
		if (parsed.verified === true && (parsed.commands?.length ?? 0) > 0) {
			return { state: 'verified' };
		}
		const symptom = parsed.failure_symptom;
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
