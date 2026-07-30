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
import {
	MAX_CONCURRENT_BATCHES,
	SECTIONS_PER_BATCH,
	analyzeDeadSections,
	batchSections,
	readAnalysis,
	writeAnalysis,
	type BatchOutcome,
} from './deadCodeAnalysis';
import { enqueueDeadCodeBatch, readPendingBatches, removeBatch } from './deadCodeQueue';
import { buildGraphSnapshot, type GraphSnapshot } from '../graph/indexGraph';
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
