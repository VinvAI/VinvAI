/**
 * What "Run this Path" actually produced — kept, summarised, and shown.
 *
 * The try-run writes a driver, runs it under tracelens, and lands a real
 * capture at `.vinv/captures/deadcode-<section>-<ts>/trace.jsonl`. Until this
 * module existed that trace was invisible: the run reported one toast ("3
 * symbols executed"), the toast was dismissed, and the evidence — which
 * functions ran, how long they took, what they raised — sat on disk with
 * nothing pointing at it. A user who ran a section twice could not tell the two
 * runs apart, and a user who ran one once could not answer the first question
 * the result raises: *what did it actually do?*
 *
 * So every try-run, including the ones that failed, is recorded as a durable
 * row with its driver, its trace, and a summary read back OUT of that trace.
 * The summary is counted from the capture rather than reported by the driver,
 * for the same reason the revived-symbol verdict is: the driver's own account
 * of what it did is a claim, and the trace is the measurement.
 *
 * Failures are recorded too, and that is deliberate. "The harness never
 * replied" and "the driver ran and reached nothing" are different facts about
 * the same section, and a surface that only remembers successes tells the user
 * to keep re-running the one section that will never work.
 *
 * Pure filesystem, no `vscode` — the report model imports this, and the model
 * is unit-tested against fixture directories.
 */

import * as fs from 'fs';
import * as path from 'path';

/** How one try-run settled. Mirrors what the runner can conclude. */
export type DeadCodeRunOutcome =
	| 'revived' // the trace reached section symbols — they are no longer dead
	| 'not-reached' // the driver ran and traced, but none of the section executed
	| 'no-reply' // the harness never answered (blocked, timed out, CLI missing)
	| 'declined' // the agent judged the section not drivable from a script
	| 'unusable-reply' // the harness answered, but no driver could be parsed
	| 'run-failed' // the driver produced no trace at all
	| 'unavailable'; // preconditions missing (section gone, no tracelens config…)

/** One function as the fresh trace saw it. */
export interface TracedFunction {
	component: string;
	calls: number;
	ms: number;
	errors: number;
}

/** The shape of what a driver's capture recorded. */
export interface DeadCodeTraceSummary {
	/** Distinct functions the trace observed. */
	functions: number;
	calls: number;
	totalMs: number;
	errors: number;
	/** Busiest functions first — the walkthrough of what the driver reached. */
	top: TracedFunction[];
	/** Distinct error types raised during the run, if any. */
	errorTypes: string[];
}

/** One try-run of one dead-code section, as it happened. */
export interface DeadCodeRunRecord {
	sectionId: string;
	/** The section's title at run time — ids are hashes and read as noise alone. */
	title: string;
	at: string;
	outcome: DeadCodeRunOutcome;
	detail: string;
	/** Section symbols the fresh trace covered. */
	revived: string[];
	/**
	 * Index rows the section held when the driver was written.
	 *
	 * Carried because a SUCCESSFUL run changes the section's id (ids hash the
	 * member identities), so keying only by id would orphan exactly the records
	 * worth reading. Rows let the reformed section still find its own history.
	 */
	rows: number[];
	driverFile: string | null;
	traceFile: string | null;
	exitCode: number | null;
	timedOut: boolean;
	/** The agent's own note about what the driver drives and what it fakes. */
	notes: string;
	/** Tail of the driver's combined output — the evidence when it failed. */
	outputTail: string;
	trace: DeadCodeTraceSummary | null;
}

export interface DeadCodeRunLog {
	schemaVersion: 1;
	generatedAt: string;
	runs: DeadCodeRunRecord[];
}

/** How many runs are kept. Old rows are history, not evidence. */
const MAX_RUNS = 60;
/** Functions listed in one summary. */
const MAX_TRACED_FUNCTIONS = 12;

export function runsPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'deadcode_runs.json');
}

export function readRuns(workspaceRoot: string): DeadCodeRunRecord[] {
	try {
		const doc = JSON.parse(fs.readFileSync(runsPath(workspaceRoot), 'utf8')) as DeadCodeRunLog;
		return Array.isArray(doc?.runs) ? doc.runs : [];
	} catch {
		return [];
	}
}

/** Prepends a run and writes the log (newest first, capped). */
export function recordRun(workspaceRoot: string, run: DeadCodeRunRecord): string {
	const file = runsPath(workspaceRoot);
	const doc: DeadCodeRunLog = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		runs: [run, ...readRuns(workspaceRoot)].slice(0, MAX_RUNS),
	};
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
	return file;
}

/**
 * The runs that belong to a section: same id, or an overlap in the symbols the
 * driver was written against. The overlap clause is what keeps a run visible
 * after it revived something — the section it re-forms into is a different id
 * covering the symbols that stayed dead, and that section's whole story is the
 * run that split it.
 */
export function runsForSection(
	runs: DeadCodeRunRecord[],
	section: { id: string; rows: number[] },
): DeadCodeRunRecord[] {
	const rows = new Set(section.rows);
	return runs.filter(
		(r) => r.sectionId === section.id || (r.rows ?? []).some((row) => rows.has(row)),
	);
}

interface RawExit {
	event?: string;
	component?: string;
	duration_ms?: number | string;
	error_type?: string | null;
}

/**
 * Reads a tracelens capture back into "what ran".
 *
 * Returns null when the file is missing or holds no function exits — an empty
 * summary and a missing trace are different states, and the view says so
 * rather than rendering zeros that look like a measurement.
 */
export function summarizeTrace(traceFile: string): DeadCodeTraceSummary | null {
	let text: string;
	try {
		text = fs.readFileSync(traceFile, 'utf8');
	} catch {
		return null;
	}
	const byComponent = new Map<string, TracedFunction>();
	const errorTypes = new Set<string>();
	let calls = 0;
	let totalMs = 0;
	let errors = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		let ev: RawExit;
		try {
			ev = JSON.parse(line) as RawExit;
		} catch {
			continue; // torn tail line — the run was killed mid-write
		}
		if (ev.event !== 'exit' || !ev.component) {
			continue;
		}
		const ms = Number(ev.duration_ms ?? 0) || 0;
		const errored = Boolean(ev.error_type && ev.error_type !== 'None');
		const entry = byComponent.get(ev.component) ?? {
			component: ev.component,
			calls: 0,
			ms: 0,
			errors: 0,
		};
		entry.calls += 1;
		entry.ms += ms;
		entry.errors += errored ? 1 : 0;
		byComponent.set(ev.component, entry);
		calls += 1;
		totalMs += ms;
		if (errored) {
			errors += 1;
			errorTypes.add(String(ev.error_type));
		}
	}
	if (byComponent.size === 0) {
		return null;
	}
	const top = [...byComponent.values()]
		.sort((a, b) => b.calls - a.calls || b.ms - a.ms)
		.slice(0, MAX_TRACED_FUNCTIONS)
		.map((f) => ({ ...f, ms: Math.round(f.ms * 100) / 100 }));
	return {
		functions: byComponent.size,
		calls,
		totalMs: Math.round(totalMs * 100) / 100,
		errors,
		top,
		errorTypes: [...errorTypes].sort(),
	};
}

/** One line for a list: what the last run of this section established. */
export function runHeadline(run: DeadCodeRunRecord): string {
	switch (run.outcome) {
		case 'revived':
			return `ran under trace — ${run.revived.length} symbol(s) executed`;
		case 'not-reached':
			return 'ran under trace — nothing in the section executed';
		case 'declined':
			return 'the agent judged this not drivable from a script';
		case 'run-failed':
			return 'the driver produced no trace';
		case 'no-reply':
			return 'the harness never replied';
		case 'unusable-reply':
			return 'the harness replied with no usable driver';
		default:
			return 'a try-run could not start';
	}
}
