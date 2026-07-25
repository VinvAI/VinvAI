/**
 * Background producer of the agent-facing report mirrors:
 *
 *   .vinv/reports/findings.json — buildFindings (what Vinv found and fixed)
 *   .vinv/reports/journey.json  — buildJourney  (the start-to-end walkthrough)
 *
 * Before this source existed, both files were written only inside the webview
 * lifecycle — an agent reading the mirrors saw data frozen at whenever a human
 * last opened the Findings/Journey tab. This is the same background-source
 * pattern OptimizationSource uses: a debounced watcher over the artifacts the
 * assemblies read (.vinv/exercise/**, captures, services.json, calltree
 * reports), a change-gated atomic write, and the source's own outputs excluded
 * from the watch so a write never re-triggers a recompute. The views keep
 * reading/writing exactly as before — their on-open write and this one produce
 * byte-identical content from the same pure assemblies.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildFindings } from './findingsModel';
import { buildJourney } from './journeyModel';

const DEBOUNCE_MS = 800;

/** Basenames under .vinv/reports this source writes — never watch-triggers. */
const SELF_OUTPUTS = new Set(['findings.json', 'journey.json']);

/** Last-written content per mirror, for the change gate. */
export interface ReportMirrorMemo {
	findings: string;
	journey: string;
}

/** What one mirror pass did (exported for the unit test's assertions). */
export interface ReportMirrorResult {
	memo: ReportMirrorMemo;
	wroteFindings: boolean;
	wroteJourney: boolean;
}

function writeAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, content, 'utf8');
	fs.renameSync(tmp, file);
}

/**
 * One change-gated mirror pass, pure of vscode: assemble both models from disk
 * and write whichever serialization differs from the memo. Neither assembly
 * embeds a timestamp, so an unchanged workspace writes nothing. Exported for
 * direct unit testing against a fixture directory.
 */
export function writeReportMirrors(
	workspaceRoot: string,
	memo: ReportMirrorMemo,
): ReportMirrorResult {
	const reports = path.join(workspaceRoot, '.vinv', 'reports');
	const findings = `${JSON.stringify(buildFindings(workspaceRoot), null, 2)}\n`;
	const journey = `${JSON.stringify(buildJourney(workspaceRoot), null, 2)}\n`;
	const wroteFindings = findings !== memo.findings;
	if (wroteFindings) {
		writeAtomic(path.join(reports, 'findings.json'), findings);
	}
	const wroteJourney = journey !== memo.journey;
	if (wroteJourney) {
		writeAtomic(path.join(reports, 'journey.json'), journey);
	}
	return { memo: { findings, journey }, wroteFindings, wroteJourney };
}

export class ReportMirrorSource implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private memo: ReportMirrorMemo = { findings: '', journey: '' };

	constructor() {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(folder.uri.fsPath, '.vinv/**'),
			);
			const onFs = (uri: vscode.Uri): void => {
				// Our own mirror writes must never re-trigger a recompute.
				if (!SELF_OUTPUTS.has(path.basename(uri.fsPath))) {
					this.refreshSoon();
				}
			};
			this.disposables.push(
				watcher,
				watcher.onDidCreate(onFs),
				watcher.onDidChange(onFs),
				watcher.onDidDelete(onFs),
				vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshSoon()),
			);
		}
		this.refreshSoon();
	}

	/** Debounced recompute — every artifact event funnels through here. */
	refreshSoon(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => this.refresh(), DEBOUNCE_MS);
	}

	private refresh(): void {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return;
		}
		try {
			this.memo = writeReportMirrors(root, this.memo).memo;
		} catch {
			// Best-effort mirror: a torn artifact mid-run retries on the next event.
		}
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
