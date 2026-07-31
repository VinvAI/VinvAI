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
 * row with its driver, its traces, and a summary read back OUT of those traces.
 * The summary is counted from the captures rather than reported by the driver,
 * for the same reason the revived-symbol verdict is: the driver's own account
 * of what it did is a claim, and the trace is the measurement.
 *
 * The summary is per-CASE and carries VALUES. "It executed" is a fact about the
 * tracer; what a developer came for is what the code does, which needs several
 * different inputs and the outputs they produced. tracelens already records a
 * bounded summary of every argument and return, so this reads them back and
 * pairs them into input→output rows — no extra capture, only a reader that
 * stops throwing the values away.
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

import type { SummaryDict } from '../runtime/traceStore';

/** How one try-run settled. Mirrors what the runner can conclude. */
export type DeadCodeRunOutcome =
	| 'revived' // the trace reached section symbols — they are no longer dead
	| 'not-reached' // the driver ran and traced, but none of the section executed
	| 'no-reply' // the harness never answered (blocked, timed out, CLI missing)
	| 'declined' // the agent judged the section not drivable from a script
	| 'unusable-reply' // the harness answered, but no driver could be parsed
	| 'run-failed' // the driver produced no trace at all
	| 'unavailable'; // preconditions missing (section gone, no tracelens config…)

/** A rendered argument or return value, exactly as the trace summarized it. */
export interface ObservedValue {
	/** Parameter name, or 'return'. */
	name: string;
	render: string;
}

/** One observed call: what went in, what came back out. */
export interface ObservedCall {
	args: ObservedValue[];
	/** Rendered return value; empty when the call raised instead of returning. */
	result: string;
	/** Exception type when the call raised, else null. */
	error: string | null;
	ms: number;
}

/** One function as the fresh trace saw it. */
export interface TracedFunction {
	component: string;
	calls: number;
	ms: number;
	errors: number;
	/** The caller observed inside this run, when the trace showed one. */
	parent?: string | null;
	/** Depth of the shallowest observed call — the walkthrough's ordering. */
	depth?: number;
	/**
	 * Distinct input→output observations, most informative first.
	 *
	 * This is the point of the whole surface: "helper_a ran" is a fact about the
	 * tracer, "helper_a([]) → 0" is a fact about the code. Bounded because a
	 * probe case that loops a thousand times has a thousand near-identical calls
	 * and the first few already say what it does.
	 */
	samples?: ObservedCall[];
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

/**
 * One probe case of one try-run: its own process, its own capture.
 *
 * Cases are captured separately rather than marked inside one trace because the
 * driver runs as `__main__` and is not an instrumented target package — its own
 * frames never reach the trace, so there is nothing in a merged capture to
 * attribute a call to the case that made it. One process per case makes the
 * attribution structural instead of inferred.
 */
export interface DeadCodeCaseRun {
	/** The argv value that selected it; empty when the script ran with no argv. */
	name: string;
	/** What the agent said this case shows. */
	why: string;
	traceFile: string;
	exitCode: number | null;
	timedOut: boolean;
	/** Tail of this case's own output — the evidence when it produced nothing. */
	outputTail: string;
	trace: DeadCodeTraceSummary | null;
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
	/**
	 * The agent's own note about what the driver drives and what it fakes — and,
	 * on a `declined` run, its stated reason for refusing. A decline is the only
	 * outcome with no driver and no trace, so without this the row holds nothing
	 * a reader could check.
	 */
	notes: string;
	/** Tail of the driver's combined output — the evidence when it failed. */
	outputTail: string;
	/** Every case of this run, in declared order. Empty on runs that never got that far. */
	cases?: DeadCodeCaseRun[];
	/** The whole run merged — what executed across all cases. */
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
/** Distinct input→output observations kept per function, per capture. */
const MAX_SAMPLES_PER_FUNCTION = 4;

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

interface RawRow {
	event?: string;
	component?: string;
	request_id?: string;
	thread_id?: number;
	depth?: number;
	parent_component?: string | null;
	args_summary?: Record<string, SummaryDict>;
	result_summary?: SummaryDict | null;
	duration_ms?: number | string;
	error_type?: string | null;
}

/**
 * A tracelens value summary as one readable cell.
 *
 * Deliberately lossy and never a reconstruction: the tracer already bounded
 * these (first 32 chars of a string, first 5 keys of a dict), so the honest
 * rendering shows the bound rather than implying the whole value was seen.
 */
export function renderSummary(s: SummaryDict | null | undefined): string {
	if (!s || typeof s !== 'object') {
		return '?';
	}
	if (s.summary_error) {
		return '<unsummarizable>';
	}
	if (s.truncated) {
		return '<too large to record>';
	}
	if (s.v !== undefined) {
		return String(s.v);
	}
	if (s.head !== undefined) {
		const shown = JSON.stringify(s.head);
		return s.len !== undefined && s.len > s.head.length ? `${shown}… (${s.len} chars)` : shown;
	}
	if (s.keys_head !== undefined) {
		const keys = s.keys_head.join(', ');
		return `{${keys}${s.len !== undefined && s.len > s.keys_head.length ? ', …' : ''}} (${s.len ?? '?'} keys)`;
	}
	if (s.elem_type !== undefined) {
		return `[${s.elem_type} × ${s.len ?? '?'}]`;
	}
	if (s.shape !== undefined) {
		return `${s.dtype ? `${s.dtype} ` : ''}array${JSON.stringify(s.shape)}`;
	}
	if (s.cols_head !== undefined) {
		return `table(${s.cols_head.join(', ')})`;
	}
	if (s.type !== undefined) {
		return s.type === 'NoneType' ? 'None' : `<${s.type}>`;
	}
	if (s.len !== undefined) {
		return `(${s.len} items)`;
	}
	return '?';
}

/** The key a call stack belongs to — a thread inside a request. */
function frameKey(row: RawRow): string {
	return `${row.request_id ?? ''}|${row.thread_id ?? 0}`;
}

/**
 * Whether a second sample of the same function is worth keeping.
 *
 * The samples exist to show a RANGE of behaviour, so a case that calls one
 * helper four hundred times with the same argument contributes one row, not
 * four hundred — the second identical observation adds nothing a reader did not
 * already have.
 */
function sampleSignature(call: ObservedCall): string {
	return `${call.args.map((a) => `${a.name}=${a.render}`).join(',')}→${call.error ?? call.result}`;
}

/**
 * Reads tracelens captures back into "what ran, with what, returning what".
 *
 * `enter` rows carry the per-parameter `args_summary` and `exit` rows carry the
 * `result_summary`, so a call's inputs and its output live on two different
 * lines. They are paired here by walking the per-request/per-thread call stack,
 * which is what makes an input→output row possible at all; matching on
 * component alone would cross-pair recursive and repeated calls.
 *
 * Returns null when no file holds a function exit — an empty summary and a
 * missing trace are different states, and the view says so rather than
 * rendering zeros that look like a measurement.
 */
export function summarizeTraces(traceFiles: string[]): DeadCodeTraceSummary | null {
	const byComponent = new Map<string, TracedFunction>();
	const signatures = new Map<string, Set<string>>();
	const errorTypes = new Set<string>();
	let calls = 0;
	let totalMs = 0;
	let errors = 0;

	for (const traceFile of traceFiles) {
		let text: string;
		try {
			text = fs.readFileSync(traceFile, 'utf8');
		} catch {
			continue;
		}
		// Open frames per thread-of-request, innermost last.
		const stacks = new Map<string, { component: string; args: ObservedValue[] }[]>();
		for (const line of text.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			let ev: RawRow;
			try {
				ev = JSON.parse(line) as RawRow;
			} catch {
				continue; // torn tail line — the run was killed mid-write
			}
			if (!ev.component) {
				continue;
			}
			if (ev.event === 'enter') {
				const args = Object.entries(ev.args_summary ?? {}).map(([name, summary]) => ({
					name,
					render: renderSummary(summary),
				}));
				const stack = stacks.get(frameKey(ev)) ?? [];
				stack.push({ component: ev.component, args });
				stacks.set(frameKey(ev), stack);
				continue;
			}
			if (ev.event !== 'exit') {
				continue;
			}
			const ms = Number(ev.duration_ms ?? 0) || 0;
			const errored = Boolean(ev.error_type && ev.error_type !== 'None');
			const entry = byComponent.get(ev.component) ?? {
				component: ev.component,
				calls: 0,
				ms: 0,
				errors: 0,
				parent: ev.parent_component ?? null,
				depth: ev.depth,
				samples: [],
			};
			entry.calls += 1;
			entry.ms += ms;
			entry.errors += errored ? 1 : 0;
			if (typeof ev.depth === 'number' && (entry.depth === undefined || ev.depth < entry.depth)) {
				entry.depth = ev.depth;
				entry.parent = ev.parent_component ?? null;
			}

			// Unwind to this exit's own frame: a frame whose exit never landed
			// (killed mid-call) must not be paired with a later function's result.
			const stack = stacks.get(frameKey(ev)) ?? [];
			let open: { component: string; args: ObservedValue[] } | undefined;
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i].component === ev.component) {
					open = stack[i];
					stack.length = i;
					break;
				}
			}
			const sample: ObservedCall = {
				args: open?.args ?? [],
				result: errored ? '' : renderSummary(ev.result_summary),
				error: errored ? String(ev.error_type) : null,
				ms: Math.round(ms * 100) / 100,
			};
			const seen = signatures.get(ev.component) ?? new Set<string>();
			const signature = sampleSignature(sample);
			if (!seen.has(signature) && (entry.samples?.length ?? 0) < MAX_SAMPLES_PER_FUNCTION) {
				seen.add(signature);
				(entry.samples ??= []).push(sample);
			}
			signatures.set(ev.component, seen);

			byComponent.set(ev.component, entry);
			calls += 1;
			totalMs += ms;
			if (errored) {
				errors += 1;
				errorTypes.add(String(ev.error_type));
			}
		}
	}

	if (byComponent.size === 0) {
		return null;
	}
	// Callees before callers, the walkthrough ordering the rest of the dead-code
	// surface uses — a reader follows what a value did, not what ran most.
	const top = [...byComponent.values()]
		.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0) || b.calls - a.calls || b.ms - a.ms)
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

/** One capture's summary — `summarizeTraces` over a single file. */
export function summarizeTrace(traceFile: string): DeadCodeTraceSummary | null {
	return summarizeTraces([traceFile]);
}

/** One line for a list: what the last run of this section established. */
export function runHeadline(run: DeadCodeRunRecord): string {
	switch (run.outcome) {
		case 'revived':
			return `ran under trace — ${run.revived.length} symbol(s) executed`;
		case 'not-reached':
			return 'ran under trace — nothing in the section executed';
		case 'declined':
			// A decline leaves no driver and no trace, so the reason is the entire
			// evidence. Without one there is nothing to weigh, and saying so is
			// what stops an unexplained refusal reading as a settled verdict.
			return run.notes
				? 'the agent judged this not drivable from a script'
				: 'the agent refused without saying why — not a settled verdict';
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
