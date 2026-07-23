/**
 * Once-per-epoch graph enhancement — closes "Enhance graph nags repeatedly
 * and never resolves".
 *
 * The old flow raised an "N references are ambiguous — Resolve Now?" toast
 * after every discovery, forever, even when a previous run had already tried
 * (and abstained on) the same references. Now the enhancement runs
 * AUTOMATICALLY, at most ONCE per index epoch, through the harness:
 *
 *  - after discovery (and on every epoch advance with new ambiguities) the
 *    runner checks .vinv/index/enhance_state.json;
 *  - the same epoch is NEVER re-run or re-offered — a run that leaves
 *    references unresolved is the terminal "done, N unresolvable" state for
 *    that epoch, not a nag;
 *  - a NEW epoch re-arms the runner only when open ambiguities actually
 *    exist.
 *
 * Harness single-flight is respected: the adjudication chat rides
 * runHarnessPrompt's lock, and the runner never starts while an episode or
 * another harness run is in flight (it simply retries on the next trigger).
 * Progress and the remaining-ambiguity count are published on pipelineState.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	adjudicatePendingEdges,
	readAdjudicated,
	readPendingEdges,
} from '../graph/graphEnhancer';
import { indexStoreDir, loadStoreEpoch } from '../graph/indexGraph';
import { isHarnessBusy } from '../harness/harnessRunner';
import { isEpisodeRunning } from '../harness/episodeLoop';
import { publishEnhanceState, type EnhanceState } from '../harness/pipelineState';

/** The terminal per-epoch record: .vinv/index/enhance_state.json */
export function enhanceStatePath(workspaceRoot: string): string {
	return path.join(indexStoreDir(workspaceRoot), 'enhance_state.json');
}

/** The persisted record shape. */
export interface EnhanceRecord {
	epoch: number;
	resolved: number;
	remaining: number;
	ranAt: string;
}

/** Reads the persisted record, or null when never run / unreadable. */
export function readEnhanceRecord(workspaceRoot: string): EnhanceRecord | null {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(enhanceStatePath(workspaceRoot), 'utf8'),
		) as EnhanceRecord;
		return typeof parsed.epoch === 'number' ? parsed : null;
	} catch {
		return null;
	}
}

/** Persists the record — the "never ask about this epoch again" fact. */
export function writeEnhanceRecord(workspaceRoot: string, record: EnhanceRecord): void {
	const target = enhanceStatePath(workspaceRoot);
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const tmp = `${target}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(record, null, '\t')}\n`, 'utf8');
		fs.renameSync(tmp, target);
	} catch {
		// Unwritable store dir: worst case the run repeats next epoch check.
	}
}

/**
 * The gate — PURE (unit tested): enhancement runs only when the store has a
 * real epoch, open ambiguities exist, and this exact epoch has not already
 * been handled (resolved OR exhausted — both are terminal for the epoch).
 */
export function shouldAutoEnhance(
	record: { epoch: number } | null,
	currentEpoch: number,
	openAmbiguities: number,
): boolean {
	if (currentEpoch <= 0 || openAmbiguities <= 0) {
		return false;
	}
	return record === null || record.epoch !== currentEpoch;
}

/** Derives the published state from a persisted record. */
export function stateFromRecord(record: EnhanceRecord | null): EnhanceState {
	if (!record) {
		return { epoch: -1, resolved: 0, remaining: 0, status: 'never-run' };
	}
	return {
		epoch: record.epoch,
		resolved: record.resolved,
		remaining: record.remaining,
		status: record.remaining > 0 ? 'exhausted' : 'resolved',
	};
}

/** Open (not yet adjudicated) ambiguous references in the store. */
function openAmbiguityCount(workspaceRoot: string): number {
	const storeDir = indexStoreDir(workspaceRoot);
	const done = readAdjudicated(storeDir);
	return readPendingEdges(storeDir).filter((r) => !done.has(`${r.src_id}\u0000${r.name}`)).length;
}

let enhanceRunning = false;

/** True while an auto-enhancement run is in flight. */
export function isEnhanceRunning(): boolean {
	return enhanceRunning;
}

/**
 * Runs the once-per-epoch enhancement if (and only if) the gate says so.
 * Returns 'ran' | 'skipped'. Never throws; never nags — there is no toast,
 * only pipelineState.
 */
export async function maybeAutoEnhance(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): Promise<'ran' | 'skipped'> {
	if (enhanceRunning) {
		return 'skipped';
	}
	let epoch: number;
	try {
		epoch = loadStoreEpoch(indexStoreDir(workspaceRoot));
	} catch {
		return 'skipped';
	}
	const record = readEnhanceRecord(workspaceRoot);
	const open = openAmbiguityCount(workspaceRoot);
	if (!shouldAutoEnhance(record, epoch, open)) {
		// Same epoch already handled (or nothing open): surface the terminal
		// fact — including "done, N unresolvable" — and stay quiet.
		if (record && record.epoch === epoch) {
			publishEnhanceState(stateFromRecord(record));
		} else if (open === 0 && epoch > 0) {
			// Nothing ambiguous this epoch: record it so the check is O(1) next time.
			const clean: EnhanceRecord = {
				epoch,
				resolved: record?.resolved ?? 0,
				remaining: 0,
				ranAt: new Date().toISOString(),
			};
			writeEnhanceRecord(workspaceRoot, clean);
			publishEnhanceState(stateFromRecord(clean));
		}
		return 'skipped';
	}
	// Single-flight discipline: adjudication rides the harness lock — don't
	// contend with a running episode/setup, just retry on the next trigger.
	if (isHarnessBusy() || isEpisodeRunning()) {
		return 'skipped';
	}
	enhanceRunning = true;
	publishEnhanceState({ epoch, resolved: 0, remaining: open, status: 'running' });
	try {
		const outcome = await adjudicatePendingEdges(context, workspaceRoot, {
			onProgress: (done, total) =>
				publishEnhanceState({
					epoch,
					resolved: done,
					remaining: total - done,
					status: 'running',
				}),
		});
		// The applied `index update` may have advanced the epoch — record the
		// POST-run epoch so our own update never re-arms the runner.
		let recordedEpoch = epoch;
		try {
			recordedEpoch = loadStoreEpoch(indexStoreDir(workspaceRoot));
		} catch {
			// Keep the pre-run epoch.
		}
		const remaining = openAmbiguityCount(workspaceRoot);
		const final: EnhanceRecord = {
			epoch: recordedEpoch,
			resolved: outcome.resolved,
			remaining,
			ranAt: new Date().toISOString(),
		};
		writeEnhanceRecord(workspaceRoot, final);
		publishEnhanceState(stateFromRecord(final));
		return 'ran';
	} catch {
		// A crashed run is NOT terminal for the epoch (nothing recorded) — the
		// next trigger may retry it; the UI sees the last known state.
		publishEnhanceState(stateFromRecord(readEnhanceRecord(workspaceRoot)));
		return 'skipped';
	} finally {
		enhanceRunning = false;
	}
}

/**
 * Wires the epoch watcher: whenever the index store's meta.json changes (an
 * incremental update advanced the epoch), re-check the gate. Also surfaces
 * the persisted record on activation so views have the terminal fact.
 */
export function registerAutoEnhance(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const root = folder.uri.fsPath;
	publishEnhanceState(stateFromRecord(readEnhanceRecord(root)));
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(root, '.vinv/index/meta.json'),
	);
	let timer: NodeJS.Timeout | undefined;
	const schedule = (): void => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => void maybeAutoEnhance(context, root), 10_000);
	};
	watcher.onDidChange(schedule);
	watcher.onDidCreate(schedule);
	context.subscriptions.push(watcher, {
		dispose: () => {
			if (timer) {
				clearTimeout(timer);
			}
		},
	});
}
