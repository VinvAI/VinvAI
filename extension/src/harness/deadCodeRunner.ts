/**
 * The editor-side half of the dead-code analysis: pick the sections, show the
 * progress, dispatch the batches, persist the verdicts.
 *
 * Split from `deadCodeAnalysis` so the batching itself — how many sections per
 * prompt, how many prompts at once, how a partial reply is salvaged — stays a
 * pure function testable without a window. Everything that needs `vscode` lives
 * here: the harness choice, the progress notification, and the one message the
 * user gets at the end.
 */

import * as vscode from 'vscode';

import { getHarnessId } from '../config/settings';
import { dispatchAgentPrompt } from './harnessRunner';
import { ensureHarnessChosen } from './harnessPicker';
import * as fs from 'fs';
import * as path from 'path';

import {
	MAX_CONCURRENT_BATCHES,
	SECTIONS_PER_BATCH,
	analyzeDeadSections,
	batchSections,
	buildContextRetriever,
	buildDriverPrompt,
	parseDriverReply,
	readAnalysis,
	revivedSymbols,
	writeAnalysis,
	type BatchOutcome,
} from './deadCodeAnalysis';
import { runDriverUnderTracing, tracedConfig } from './tracedRun';
import {
	recordRun,
	summarizeTrace,
	type DeadCodeRunOutcome,
	type DeadCodeRunRecord,
} from './deadCodeRuns';
import { enqueueDeadCodeBatch, readPendingBatches, removeBatch } from './deadCodeQueue';
import {
	buildGraphSnapshot,
	indexStoreDir,
	loadChunkTexts,
	type GraphSnapshot,
} from '../graph/indexGraph';
import { buildDeadCode, writeDeadCodeReport, type DeadSection } from '../views/deadCodeModel';

export interface AnalyzeOptions {
	/** Analyse exactly this section (the report tab's own button). */
	sectionId?: string;
	/** Re-ask about sections that already have a verdict. */
	reanalyseAll?: boolean;
}

/** Prevents a second fan-out over the same sections while one is in flight. */
let running = false;

export function isDeadCodeAnalysisRunning(): boolean {
	return running;
}

/** One try-run at a time — a second driver would race the first for the trace. */
let tryRunInFlight = false;

/** How one try-run of a dead section settled. */
export interface TryRunOutcome {
	outcome: DeadCodeRunOutcome;
	detail: string;
	/** Section symbols the fresh trace covered, when any. */
	revived: string[];
	/** Where the run was written down, when it got far enough to be recorded. */
	recorded?: boolean;
}

/**
 * "Try run this path": ask the harness to WRITE a driver for the section, run
 * it under tracelens with the workspace's own recorded configuration, and
 * report which of the section's symbols the fresh trace actually reached.
 *
 * The trace lands under .vinv/captures/, which is where every scan already
 * looks — so a revived symbol leaves the dead list by the normal join, not by
 * this function editing any verdict. The section id then changes (ids hash the
 * member identities), which is correct: a half-alive section is a different
 * finding than the one the driver was written against.
 */
export async function tryRunDeadSection(
	workspaceRoot: string,
	sectionId: string,
): Promise<TryRunOutcome> {
	const unavailable = (detail: string): TryRunOutcome => {
		void vscode.window.showWarningMessage(`Vinv: ${detail}`);
		return { outcome: 'unavailable', detail, revived: [] };
	};
	if (tryRunInFlight) {
		return unavailable('a dead-code try-run is already in flight — one driver at a time.');
	}

	const scan = buildDeadCode(workspaceRoot);
	const section = scan.sections.items.find((s) => s.id === sectionId);
	if (!section) {
		return unavailable(
			'that dead-code section is no longer in the index — the code it covered changed.',
		);
	}
	const env = tracedConfig(workspaceRoot);
	if (!env) {
		return unavailable(
			'no tracelens-wrapped start command is recorded for this workspace, so nothing can run ' +
				'under trace. Bring a service up once (Services panel ▶) first.',
		);
	}
	const harnessId = await ensureHarnessChosen(
		'Which coding agent should write the driver? (change anytime in Configure)',
	);
	if (!harnessId) {
		return { outcome: 'unavailable', detail: 'harness picker dismissed', revived: [] };
	}

	/**
	 * Writes the run down and returns it. Every terminal outcome goes through
	 * here — a section whose driver never came back is exactly the section a
	 * user would otherwise ask about twice.
	 */
	const settle = (
		outcome: DeadCodeRunOutcome,
		detail: string,
		extra: Partial<DeadCodeRunRecord> = {},
	): TryRunOutcome => {
		const revived = extra.revived ?? [];
		try {
			recordRun(workspaceRoot, {
				sectionId: section.id,
				title: section.title,
				at: new Date().toISOString(),
				outcome,
				detail,
				revived,
				rows: section.symbols.items.map((s) => s.row),
				driverFile: null,
				traceFile: null,
				exitCode: null,
				timedOut: false,
				notes: '',
				outputTail: '',
				trace: null,
				...extra,
			});
		} catch {
			// The message still reaches the user; only the history lags.
		}
		return { outcome, detail, revived, recorded: true };
	};

	tryRunInFlight = true;
	try {
		// Same context the analysis prompt gets: the live neighbourhood is where
		// the driver's imports and scaffolding will come from.
		let sources = new Map<number, string>();
		try {
			sources = loadChunkTexts(
				indexStoreDir(workspaceRoot),
				section.symbols.items.map((s) => s.row),
			);
		} catch {
			// summaries alone still make a writable prompt
		}
		let context;
		try {
			context = buildContextRetriever(buildGraphSnapshot(workspaceRoot))(section);
		} catch {
			context = undefined;
		}

		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Window,
				title: `Vinv: trying to run dead section ${section.title} under trace…`,
			},
			async (): Promise<TryRunOutcome> => {
				const dispatchName = `deadcode-driver-${section.id}`;
				const reply = await dispatchAgentPrompt(
					getHarnessId() || harnessId,
					workspaceRoot,
					dispatchName,
					buildDriverPrompt(section, sources, env, context),
				);
				// Three distinct failures, three distinct messages — "no driver" with
				// no cause is a support question, not a report.
				if (reply === null) {
					const detail =
						'the harness never replied — it is signed out, over quota, timed out ' +
						`(VINV_AGENT_TIMEOUT_S, default 300s), or its CLI is missing. ` +
						`See .vinv/logs/harness-agent-${dispatchName}.log for the transcript.`;
					void vscode.window.showWarningMessage(`Vinv: ${detail}`);
					return settle('no-reply', detail);
				}
				const parsed = parseDriverReply(reply);
				if (parsed.kind === 'declined') {
					const detail =
						'the agent read this section and judged it not drivable from a script ' +
						'(e.g. build-tool config or code needing infrastructure a driver cannot fake). ' +
						'That is a verdict, not a failure — re-running will not change it.';
					void vscode.window.showInformationMessage(`Vinv: ${detail}`);
					return settle('declined', detail);
				}
				if (parsed.kind === 'unusable') {
					const detail =
						'the harness replied but no driver could be parsed from its answer — worth one ' +
						`retry. See .vinv/logs/harness-agent-${dispatchName}.log for what it said.`;
					void vscode.window.showWarningMessage(`Vinv: ${detail}`);
					return settle('unusable-reply', detail);
				}
				const driver = parsed;

				// A real file, never inline: tracelens degrades AST coverage for
				// `python -c` (see tracedRun's module doc).
				const tmpDir = path.join(workspaceRoot, '.vinv', 'tmp');
				fs.mkdirSync(tmpDir, { recursive: true });
				const driverFile = path.join(tmpDir, `deadcode-driver-${section.id}.py`);
				fs.writeFileSync(driverFile, driver.code, 'utf8');
				// Under captures/ so the very next scan joins it — the same discovery
				// path every service capture takes.
				const outTrace = path.join(
					workspaceRoot,
					'.vinv',
					'captures',
					`deadcode-${section.id}-${Date.now()}`,
					'trace.jsonl',
				);
				fs.mkdirSync(path.dirname(outTrace), { recursive: true });

				const run = await runDriverUnderTracing(workspaceRoot, driverFile, [], outTrace);
				const evidence = {
					driverFile,
					traceFile: outTrace,
					exitCode: run.exitCode,
					timedOut: run.timedOut,
					notes: driver.notes,
					outputTail: run.outputTail.slice(-4000),
					trace: summarizeTrace(outTrace),
				};
				if (!run.ok) {
					const detail =
						`the driver produced no trace (exit ${run.exitCode ?? 'none'}` +
						`${run.timedOut ? ', timed out' : ''}). Tail: ${run.outputTail.slice(-300) || '(no output)'}`;
					void vscode.window.showWarningMessage(`Vinv: ${detail}`);
					return settle('run-failed', detail, evidence);
				}

				// The verdict is counted from the re-scan, never inferred from the
				// driver's exit code: a green run that never reached the section is
				// still "not reached", and a raising run that did reach it is revived.
				let revived: string[] = [];
				try {
					revived = revivedSymbols(section, buildGraphSnapshot(workspaceRoot).runtime);
				} catch {
					revived = [];
				}
				try {
					writeDeadCodeReport(workspaceRoot, buildDeadCode(workspaceRoot));
				} catch {
					// the surfaces re-derive on their next push anyway
				}
				if (revived.length > 0) {
					const detail =
						`the driver executed ${revived.length} of ${section.symbols.items.length} section ` +
						`symbol(s) under trace (${revived.slice(0, 5).join(', ')}${revived.length > 5 ? '…' : ''}) — ` +
						'they are no longer dead. This section re-forms around what is still untraced.';
					void vscode.window.showInformationMessage(`Vinv: ${detail}`);
					return settle('revived', detail, { ...evidence, revived });
				}
				const detail =
					`the driver ran and traced${run.exitCode === 0 ? '' : ` (exit ${run.exitCode})`}, but ` +
					'none of this section’s symbols executed — the path stayed dead even when driven. ' +
					`Driver notes: ${driver.notes || '(none)'}`;
				void vscode.window.showWarningMessage(`Vinv: ${detail}`);
				return settle('not-reached', detail, evidence);
			},
		);
	} finally {
		tryRunInFlight = false;
	}
}

/**
 * Analyses dead-code sections and returns what landed.
 *
 * The scan is re-derived first rather than read from `deadcode.json`: section ids
 * come from the member symbols, so analysing against a stale scan would attach
 * verdicts to ids the current store no longer has, and the Findings list would
 * show "not analysed" forever with no way to tell why.
 */
export async function analyzeDeadCodeSections(
	workspaceRoot: string,
	opts: AnalyzeOptions = {},
): Promise<BatchOutcome | null> {
	if (running) {
		void vscode.window.showInformationMessage(
			'Vinv: a dead-code analysis is already running — its verdicts land in Findings when it finishes.',
		);
		return null;
	}

	// One snapshot serves the scan AND the PPR context retrieval — building the
	// graph twice for one run is the same avoidable multiplication the batching
	// exists to remove.
	let snapshot: GraphSnapshot | undefined;
	try {
		snapshot = buildGraphSnapshot(workspaceRoot);
	} catch {
		snapshot = undefined; // buildDeadCode reports the empty state itself
	}
	const scan = buildDeadCode(workspaceRoot, snapshot);
	try {
		writeDeadCodeReport(workspaceRoot, scan);
	} catch {
		// The scan drives this run either way; only the artifact lags.
	}
	if (!scan.hasTrace) {
		void vscode.window.showWarningMessage(
			'Vinv: nothing has been traced yet, so no code can be called dead. Run a service and exercise it first.',
		);
		return null;
	}

	const analysed = new Set(Object.keys(readAnalysis(workspaceRoot)?.verdicts ?? {}));
	let targets: DeadSection[] = scan.sections.items;
	if (opts.sectionId) {
		targets = targets.filter((s) => s.id === opts.sectionId);
		if (targets.length === 0) {
			void vscode.window.showWarningMessage(
				'Vinv: that dead-code section is no longer in the index — the code it covered changed.',
			);
			return null;
		}
	} else if (!opts.reanalyseAll) {
		targets = targets.filter((s) => !analysed.has(s.id));
	}
	// Sweep in what earlier runs left queued: a batch whose dispatch died (crash,
	// blocked harness, unusable reply) is still a file, and its sections join this
	// run whether or not the filter above would have picked them.
	if (!opts.sectionId) {
		const pending = readPendingBatches(workspaceRoot);
		if (pending.length > 0) {
			const have = new Set(targets.map((s) => s.id));
			const wanted = new Set(pending.flatMap((p) => p.request.sectionIds));
			for (const s of scan.sections.items) {
				if (wanted.has(s.id) && !have.has(s.id)) {
					targets.push(s);
					have.add(s.id);
				}
			}
			// Consumed either way: sections that still exist re-enqueue below under
			// this run's batching; ids that no longer resolve can never dispatch.
			for (const p of pending) {
				removeBatch(p.file);
			}
		}
	}
	if (targets.length === 0) {
		void vscode.window.showInformationMessage(
			'Vinv: every dead-code section already has a verdict. Use Re-analyse all to ask again.',
		);
		return null;
	}

	const harnessId = await ensureHarnessChosen(
		'Which coding agent should read the dead code? (change anytime in Configure)',
	);
	if (!harnessId) {
		return null; // the user dismissed the picker — not a failure to report
	}

	running = true;
	try {
		// The queue IS the dispatch plan: every batch becomes a durable file before
		// any agent is spawned, keyed by its section ids so the completion hook can
		// settle exactly the file its batch came from. batchSections is
		// deterministic, so the file set and the executor's batching agree.
		const planned = batchSections(targets, SECTIONS_PER_BATCH);
		const fileByKey = new Map<string, string>();
		for (const batch of planned) {
			const ids = batch.map((s) => s.id);
			try {
				fileByKey.set(ids.join(','), enqueueDeadCodeBatch(workspaceRoot, ids));
			} catch {
				// The batch still dispatches this run; it just is not crash-durable.
			}
		}

		let saveError: unknown;
		const outcome = await vscode.window.withProgress(
			{
				// Window, not notification: this spawns agent CLIs and runs for
				// minutes, and a non-cancellable notification is corner real estate the
				// user cannot dismiss. The result is a message either way.
				location: vscode.ProgressLocation.Window,
				title:
					`Vinv: reading ${targets.length} dead-code section(s) — ` +
					`${planned.length} batch(es), ${Math.min(MAX_CONCURRENT_BATCHES, planned.length)} at a time…`,
			},
			() =>
				analyzeDeadSections(
					workspaceRoot,
					targets,
					(name, prompt) =>
						dispatchAgentPrompt(getHarnessId() || harnessId, workspaceRoot, name, prompt),
					{
						snapshot,
						// Persist per batch, not once at the end: a crash after batch 3 of
						// 8 keeps three batches' verdicts and leaves five files queued —
						// exactly the split that actually happened.
						onBatch: (batch, verdicts) => {
							const file = fileByKey.get(batch.map((s) => s.id).join(','));
							if (Object.keys(verdicts).length === 0) {
								return; // failed batch: verdicts absent, file stays queued
							}
							try {
								writeAnalysis(workspaceRoot, scan.storeEpoch, verdicts);
								if (file) {
									removeBatch(file);
								}
							} catch (e) {
								saveError = e; // keep the file — the ask is still owed
							}
						},
					},
				),
		);

		if (saveError !== undefined) {
			void vscode.window.showErrorMessage(
				`Vinv: the agent answered but some verdicts could not be saved: ${
					saveError instanceof Error ? saveError.message : String(saveError)
				}. Their batches stay queued for the next run.`,
			);
			return outcome;
		}

		// Say what landed AND what did not. A run that explained three of eight
		// sections and reported only success would leave the other five reading as
		// "the agent had nothing to say", which is a different claim entirely.
		if (outcome.answered === 0) {
			void vscode.window.showWarningMessage(
				`Vinv: the agent returned no usable verdict for any of the ${outcome.requested} section(s). ` +
					'They stay queued — the next analysis run asks again; nothing was guessed on their behalf.',
			);
		} else if (outcome.detail) {
			void vscode.window.showWarningMessage(
				`Vinv: ${outcome.answered} of ${outcome.requested} dead-code section(s) analysed — ${outcome.detail}.`,
			);
		} else {
			void vscode.window.showInformationMessage(
				`Vinv: analysed ${outcome.answered} dead-code section(s) in ${outcome.batches} batch(es).`,
			);
		}
		return outcome;
	} finally {
		running = false;
	}
}
