/**
 * Dead-code scan — `index deadcode`, written to `.vinv/reports/deadcode.json`.
 *
 * The engine reads SOURCE, not the index store, and that is deliberate: the
 * store's `invoke` edges are resolved by name, so when two symbols share one
 * the calls collapse onto a single node and its twin reads as uncalled. For a
 * report whose purpose is deletion that error is the expensive direction — it
 * removes working code — so reachability is recomputed from the AST each run.
 *
 * Consequently this stage does NOT depend on indexing having finished, which is
 * why discovery can run it alongside the index build and the handbook rather
 * than after them.
 *
 * Two buckets, because they call for different actions:
 *   unreachable — nothing in the repository references it, tests included.
 *   testOnly    — the suite reaches it and no product path does. Tested code
 *                 that was never wired in; deleting it takes its tests too, so
 *                 it is a judgement queue rather than a delete list.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getBinPath, isBinAvailable } from '../tracelens/bin';
import { getIndexEnv } from '../config/settings';

export interface DeadCodeProgress {
	label: string;
}

/** One unreferenced definition, exactly as the engine reports it. */
export interface DeadSymbol {
	file: string;
	line: number;
	/** Last line of the definition — what the panel renders as the body. */
	end: number;
	/** 'function' | 'method' | 'class'. */
	kind: string;
	name: string;
	/**
	 * The name is also bound elsewhere (a local variable, or a second
	 * definition), so a reference to it cannot be attributed with certainty.
	 * Reported rather than withheld — a flag to check by hand, not a verdict.
	 */
	ambiguous: boolean;
	/**
	 * Dead symbols that reference this one, as `file:line:name`.
	 *
	 * Empty means nothing at all points at it — the top of a chain, and a
	 * decision of its own. Non-empty means it is dead only because its callers
	 * are, so it is folded under them rather than listed separately.
	 */
	deadCallers: string[];
}

export interface DeadCodeScan {
	schemaVersion: 1;
	generatedAt: string;
	/** Python files scanned, and definitions considered. */
	files: number;
	definitions: number;
	unreachable: DeadSymbol[];
	testOnly: DeadSymbol[];
	/** Methods that may be overrides or duck-typed — counted, not listed. */
	probable: number;
}

export function deadCodeReportPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'deadcode.json');
}

export function readDeadCodeScan(workspaceRoot: string): DeadCodeScan | null {
	try {
		const doc = JSON.parse(fs.readFileSync(deadCodeReportPath(workspaceRoot), 'utf8')) as DeadCodeScan;
		return doc && Array.isArray(doc.unreachable) ? doc : null;
	} catch {
		return null;
	}
}

/** Human-readable copy, beside the handbook at `.vinv/deadcode.md`. */
export function deadCodeMarkdownPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'deadcode.md');
}

function writeAtomic(file: string, body: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, body, 'utf8');
	fs.renameSync(tmp, file);
}

/**
 * The report as prose, grouped by file.
 *
 * Sits next to `vinv.md` because it answers the same kind of question about the
 * repository and is read the same way — by a person deciding what to do, or by
 * an agent given the workspace. The JSON copy is the machine surface; this one
 * carries the caveats, which a bare list of symbols cannot.
 */
export function renderMarkdown(scan: DeadCodeScan): string {
	const group = (rows: DeadSymbol[]): string => {
		if (rows.length === 0) {
			return '_Nothing._\n';
		}
		const byFile = new Map<string, DeadSymbol[]>();
		for (const r of rows) {
			byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
		}
		let out = '';
		for (const file of [...byFile.keys()].sort()) {
			out += `\n**${file}**\n\n`;
			for (const s of (byFile.get(file) ?? []).sort((a, b) => a.line - b.line)) {
				const flag = s.ambiguous ? ' _(name not unique — check by hand)_' : '';
				out += `- \`${s.name}\` — ${s.kind}, line ${s.line}${flag}\n`;
			}
		}
		return out;
	};

	return [
		'# Dead code',
		'',
		`Generated ${scan.generatedAt} from ${scan.definitions} definitions across ${scan.files} Python files.`,
		'',
		'Reachability is computed from the source AST, not from the index: the',
		'index resolves calls by name, so two symbols sharing one collapse onto a',
		'single node and the other reads as uncalled — which would delete working',
		'code. Test files are not parsed at all, so a call from a test does not',
		'count as a reason to keep product code.',
		'',
		`## Unreachable (${scan.unreachable.length})`,
		'',
		'Nothing in the repository references these, tests included.',
		group(scan.unreachable),
		`## Test-only (${scan.testOnly.length})`,
		'',
		'Reachable from the suite and nowhere else — tested, but wired into no',
		'product path. Deleting one takes its tests with it, so this is a list to',
		'judge, not a list to remove.',
		group(scan.testOnly),
		'## Not listed',
		'',
		`- ${scan.probable} method(s) that may be overrides or duck-typed.`,
		'- Anything reached by reflection, a plugin registry, or a name built at',
		'  runtime. Absence from a static scan is not proof that nothing calls it —',
		'  confirm before deleting.',
		'',
	].join('\n');
}

function write(workspaceRoot: string, scan: DeadCodeScan): void {
	writeAtomic(deadCodeReportPath(workspaceRoot), `${JSON.stringify(scan, null, 2)}\n`);
	writeAtomic(deadCodeMarkdownPath(workspaceRoot), renderMarkdown(scan));
}

/**
 * Runs the scan and writes the report. Resolves false when the engine is
 * missing, the run was cancelled, or it produced nothing parsable — never on a
 * partial write, since the report is replaced atomically or not at all.
 *
 * A failure here costs the dead-code report and nothing else: it is one of
 * three independent discovery stages, and the other two do not read it.
 */
export function runDeadCodeScan(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	onProgress?: (p: DeadCodeProgress) => void,
	token?: vscode.CancellationToken,
): Promise<boolean> {
	if (!isBinAvailable(context, 'index')) {
		// Silent: the index stage running beside this one raises the missing-engine
		// error already, and two notifications for one cause is noise.
		return Promise.resolve(false);
	}
	const binPath = getBinPath(context, 'index');

	return new Promise<boolean>((resolve) => {
		onProgress?.({ label: 'Scanning for unreferenced code…' });
		const child = spawn(binPath, ['deadcode', workspaceRoot, '--json'], {
			env: getIndexEnv(path.dirname(binPath)),
			windowsHide: true,
		});

		let stdout = '';
		let settled = false;
		const finish = (ok: boolean): void => {
			if (!settled) {
				settled = true;
				resolve(ok);
			}
		};

		child.stdout?.on('data', (d: Buffer) => {
			stdout += d.toString();
		});
		// stderr carries the engine's own diagnostics; the report is stdout only.
		child.stderr?.resume();

		const cancel = token?.onCancellationRequested(() => {
			try {
				child.kill();
			} catch {
				// Already gone.
			}
			finish(false);
		});

		child.on('error', () => {
			cancel?.dispose();
			finish(false);
		});

		child.on('close', (code) => {
			cancel?.dispose();
			if (code !== 0 || token?.isCancellationRequested) {
				finish(false);
				return;
			}
			try {
				const raw = JSON.parse(stdout) as {
					files?: number;
					definitions?: number;
					unreachable?: unknown[];
					test_only?: unknown[];
					probable?: number;
				};
				const norm = (rows: unknown[] | undefined): DeadSymbol[] =>
					(rows ?? []).map((r) => {
						const o = r as Record<string, unknown>;
						return {
							file: String(o.file ?? ''),
							line: Number(o.line ?? 0),
							end: Number(o.end ?? o.line ?? 0),
							kind: String(o.kind ?? ''),
							name: String(o.name ?? ''),
							ambiguous: o.ambiguous === true,
							deadCallers: Array.isArray(o.dead_callers) ? (o.dead_callers as string[]) : [],
						};
					});
				const scan: DeadCodeScan = {
					schemaVersion: 1,
					generatedAt: new Date().toISOString(),
					files: Number(raw.files ?? 0),
					definitions: Number(raw.definitions ?? 0),
					unreachable: norm(raw.unreachable),
					testOnly: norm(raw.test_only),
					probable: Number(raw.probable ?? 0),
				};
				write(workspaceRoot, scan);
				onProgress?.({
					label: `${scan.unreachable.length} unreachable, ${scan.testOnly.length} test-only`,
				});
				finish(true);
			} catch {
				// Unparsable output is no report at all — better than a half-written
				// one that later reads as "nothing is dead".
				finish(false);
			}
		});
	});
}
