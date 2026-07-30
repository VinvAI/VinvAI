import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getBinPath, isBinAvailable, showEnginesMissingError } from '../tracelens/bin';
import { ensureEmbedder } from '../engines/install';
import { getIndexEnv } from '../config/settings';

/** Project-local index store directory: <workspace>/.vinv/index */
export function getIndexStoreDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'index');
}

/**
 * A *fully built* index exists when `meta.json` is present alongside the vector
 * file. The index binary writes every store file atomically (temp + rename) and
 * saves `meta.json` last — after chunks.jsonl, vectors.f32, edges.jsonl and
 * manifest.json — so its presence is the completion signal; checking vectors.f32
 * too avoids reporting a hand-pruned or corrupt store as complete.
 */
export function isProjectIndexed(workspaceRoot: string): boolean {
	const storeDir = getIndexStoreDir(workspaceRoot);
	return (
		fs.existsSync(path.join(storeDir, 'meta.json')) &&
		fs.existsSync(path.join(storeDir, 'vectors.f32'))
	);
}

/**
 * A store can pass isProjectIndexed (both files exist) and still be torn: an
 * interrupted save can leave chunks.jsonl one generation ahead of vectors.f32,
 * which the binary reports as "corrupt index: N vector values for M chunks".
 * Validate the row math: vectors.f32 must hold exactly chunks × dim × 4 bytes.
 * A fully staged vectors.tmp of the right size also passes — the index binary
 * completes that interrupted commit itself on the next load, which is far
 * cheaper than the full re-embed a wipe would force.
 */
export function isStoreConsistent(storeDir: string): boolean {
	try {
		const meta = JSON.parse(
			fs.readFileSync(path.join(storeDir, 'meta.json'), 'utf8'),
		) as { dim?: number };
		if (!meta.dim || meta.dim <= 0) {
			return false;
		}
		const chunkText = fs.readFileSync(path.join(storeDir, 'chunks.jsonl'), 'utf8');
		let chunks = 0;
		for (const line of chunkText.split('\n')) {
			if (line.trim()) {
				chunks++;
			}
		}
		const expectedBytes = chunks * meta.dim * 4;
		return ['vectors.f32', 'vectors.tmp'].some((name) => {
			const p = path.join(storeDir, name);
			return fs.existsSync(p) && fs.statSync(p).size === expectedBytes;
		});
	} catch {
		return false;
	}
}

let indexing = false;

/** A point-in-time indexing progress update for the UI. */
export interface IndexProgress {
	/** Completion fraction 0–100, or null while the run is in flight. */
	percent: number | null;
	/** Human-readable status line for the UI. */
	label: string;
}

/** The single JSON document the index binary prints on stdout when it exits. */
interface IndexResult {
	status: string;
	error?: string;
	files?: number;
	symbols?: number;
}

/**
 * Parses the one-line JSON result from the binary's stdout. Unlike the old
 * Python engine, the Rust index emits no incremental progress stream — stdout
 * carries exactly one JSON object at exit and stderr only warnings/failures —
 * so the run's counts (files/symbols) are only known at the end.
 */
function parseResult(stdout: string): IndexResult | null {
	// Take the last parseable line: warnings never go to stdout, but be robust.
	const lines = stdout.split('\n').filter((l) => l.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(lines[i]) as IndexResult;
		} catch {
			// Not JSON; keep looking.
		}
	}
	return null;
}

/**
 * Runs `index index` for the workspace into <workspace>/.vinv/index, surfacing
 * an in-flight notification in the VS Code notification area and (via
 * onProgress) in the Configure panel. Resolves true only on actual completion —
 * exit code 0 *and* a written store — never on a timeout.
 */
export function runIndexing(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	onProgress?: (p: IndexProgress) => void,
	extToken?: vscode.CancellationToken,
): Thenable<boolean> {
	if (indexing) {
		return Promise.resolve(false);
	}
	if (!isBinAvailable(context, 'index')) {
		showEnginesMissingError('index');
		return Promise.resolve(false);
	}

	const binPath = getBinPath(context, 'index');
	try {
		fs.chmodSync(binPath, 0o755);
	} catch {
		// Non-fatal.
	}

	const storeDir = getIndexStoreDir(workspaceRoot);
	const MAX_ATTEMPTS = 3;

	indexing = true;
	void vscode.commands.executeCommand('setContext', 'vinv.indexing', true);

	type Outcome = { outcome: 'ok' | 'cancelled' | 'failed'; detail?: string };

	// A single spawn of the index binary. Drives the progress notification and
	// resolves with the outcome; it never shows UI itself so the retry loop owns
	// all messaging.
	const runAttempt = (
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		token: vscode.CancellationToken,
		attempt: number,
	): Promise<Outcome> =>
		new Promise<Outcome>((resolve) => {
			// The index binary is a single native process (its summarizer runs on
			// in-process threads, not child workers), so a plain kill reaches
			// everything — no process-group signalling needed.
			const child = spawn(binPath, ['index', workspaceRoot, '--store-dir', storeDir], {
				env: getIndexEnv(path.dirname(binPath)),
				windowsHide: true, // headless CLI: never flash a console window on Windows
			});

			const kill = (signal: NodeJS.Signals) => {
				try {
					child.kill(signal);
				} catch {
					// Already gone.
				}
			};

			// A Stop from the Project status row cancels the shared discovery
			// token; honour it the same way as the notification's Cancel button.
			const extCancelReg = extToken?.onCancellationRequested(() => {
				kill('SIGTERM');
				setTimeout(() => kill('SIGKILL'), 2000);
			});

			const tag = attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : '';
			const label = 'Indexing files & symbols…';
			progress.report({ message: `${label}${tag}` });
			onProgress?.({ percent: null, label });

			// stdout carries the final one-line JSON result; stderr only carries
			// failures / warnings, which we keep for diagnostics.
			let stdout = '';
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				stdout += chunk;
			});

			let stderrBuffer = '';
			let lastError = '';
			const tail: string[] = []; // last few stderr lines, for diagnostics
			const handleLine = (line: string) => {
				if (!line.trim()) {
					return;
				}
				tail.push(line.trim());
				if (tail.length > 12) {
					tail.shift();
				}
				if (
					/unauthor|forbidden|denied|connection (refused|reset|error)|is not set/i.test(
						line,
					)
				) {
					lastError = line.trim();
				}
			};
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (chunk: string) => {
				stderrBuffer += chunk;
				const lines = stderrBuffer.split('\n');
				stderrBuffer = lines.pop() ?? '';
				for (const line of lines) {
					handleLine(line);
				}
			});

			let settled = false;
			const settle = (o: Outcome) => {
				if (settled) {
					return;
				}
				settled = true;
				extCancelReg?.dispose();
				resolve(o);
			};

			child.on('error', (err) => settle({ outcome: 'failed', detail: err.message }));
			// Completion is real only when the binary exits cleanly AND the store
			// landed on disk — never on a slow run the user gave up on.
			child.on('close', (code) => {
				const result = parseResult(stdout);
				if (token.isCancellationRequested || extToken?.isCancellationRequested) {
					settle({ outcome: 'cancelled' });
				} else if (code !== 0) {
					settle({
						outcome: 'failed',
						detail: result?.error || lastError || `exited with code ${code ?? 'null'}`,
					});
				} else if (!isProjectIndexed(workspaceRoot)) {
					settle({
						outcome: 'failed',
						detail: result?.error || lastError || tail.slice(-2).join(' | '),
					});
				} else {
					const counts =
						result?.files !== undefined && result?.symbols !== undefined
							? `${result.files} files · ${result.symbols} symbols`
							: 'Index ready';
					onProgress?.({ percent: 100, label: counts });
					settle({ outcome: 'ok' });
				}
			});

			token.onCancellationRequested(() => {
				kill('SIGTERM');
				setTimeout(() => kill('SIGKILL'), 2000);
			});
		});

	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Vinv: Indexing project…',
			cancellable: true,
		},
		async (progress, token) => {
			try {
				// Embeddings come from the local sidecar; bring it up (or reuse a
				// healthy instance) before the first attempt spawns the binary.
				progress.report({ message: 'Starting embedding sidecar…' });
				// Cancel has to take effect DURING this wait, not after it. The first
				// run downloads a ~500 MB model, and the token was only consulted
				// once this resolved — so for the whole download the button looked
				// dead and the toast sat on screen with no way to get rid of it.
				// Racing the token closes the notification immediately. The sidecar
				// keeps warming in the background (there is nothing to kill that
				// would not have to be redone), which is the point: the user wanted
				// their screen back, not the download undone.
				const cancelled = new Promise<'cancelled'>((resolve) => {
					token.onCancellationRequested(() => resolve('cancelled'));
					extToken?.onCancellationRequested(() => resolve('cancelled'));
				});
				const embedder = await Promise.race([ensureEmbedder(context), cancelled]);
				if (embedder === 'cancelled') {
					return false;
				}
				if (!embedder) {
					void vscode.window.showErrorMessage(
						'Vinv: The embedding sidecar (vinv-embedder) did not come up. The first run ' +
							'downloads a ~500 MB model, which can take a few minutes — if it just started, ' +
							'wait and try again. If it persists, run "Vinv: Install Engines".',
					);
					return false;
				}
				let firstDetail = '';
				let lastDetail = '';
				for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
					if (token.isCancellationRequested || extToken?.isCancellationRequested) {
						return false;
					}

					// Start each attempt from a clean store so a half-written or torn
					// index from a failed attempt can't be mistaken for a complete one.
					// Existence of meta.json + vectors.f32 is not enough — an
					// interrupted save can leave both present but one generation apart,
					// and retrying over that store fails at load every time — so also
					// verify the chunk/vector row math before trusting it.
					if (
						fs.existsSync(storeDir) &&
						(!isProjectIndexed(workspaceRoot) || !isStoreConsistent(storeDir))
					) {
						try {
							fs.rmSync(storeDir, { recursive: true, force: true });
						} catch {
							// Non-fatal; the binary will overwrite in place.
						}
					}
					if (attempt > 1) {
						const label = `Retrying… (attempt ${attempt}/${MAX_ATTEMPTS})`;
						progress.report({ message: label });
						onProgress?.({ percent: null, label });
					}

					const result = await runAttempt(progress, token, attempt);

					if (result.outcome === 'ok') {
						void vscode.window.showInformationMessage('Vinv: Index ready.');
						return true;
					}
					if (result.outcome === 'cancelled') {
						return false;
					}

					// Transient failure: back off briefly and retry while attempts remain.
					// Keep the FIRST failure's detail too — later attempts often fail on
					// a downstream symptom (e.g. "corrupt index" after a torn save) that
					// hides the root cause the first attempt reported.
					lastDetail = result.detail ?? '';
					if (!firstDetail) {
						firstDetail = lastDetail;
					}
					if (attempt < MAX_ATTEMPTS) {
						await new Promise((r) => setTimeout(r, 1500 * attempt));
						continue;
					}
				}

				const base = `Vinv: Indexing failed after ${MAX_ATTEMPTS} attempts`;
				const details =
					firstDetail && firstDetail !== lastDetail
						? `first error: ${firstDetail}; last error: ${lastDetail}`
						: lastDetail;
				const storeIssue = /corrupt index|rename|sharing violation|access is denied|permission denied|no space/i.test(
					details,
				);
				void vscode.window.showErrorMessage(
					details
						? storeIssue
							? `${base}. The index store hit a filesystem error — often a transient file lock from antivirus or a concurrent process. ${details}`
							: `${base}. This is usually a transient embedding/gateway failure or an LLM Configuration issue. Last output: ${details}`
						: `${base}. Check your LLM Configuration (API key, base URL, embedding model).`,
				);
				return false;
			} finally {
				indexing = false;
				void vscode.commands.executeCommand('setContext', 'vinv.indexing', false);
			}
		},
	);
}
