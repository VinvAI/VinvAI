import * as vscode from 'vscode';
import { ensureExecutableOnce } from '../support/executableBit';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getBinPath, isBinAvailable } from './bin';
import { getIndexEnv } from '../config/settings';
import { probeTraceFile } from '../identification/traceFilter';

/**
 * Runs `tracelens report <trace> --out <html> --api-id <id>` to build the
 * self-contained Smoke Report dashboard for one endpoint, and returns the
 * rendered HTML.
 *
 * `report` is an offline analysis stage: it reads the captured trace.jsonl (the
 * same one tracemap/tracesummary probe), auto-discovers the identification dir
 * from the trace path, scopes to the given endpoint, and writes a single static
 * HTML file with inline CSS/JS/SVG (no external/CDN resources).
 *
 * The report is written into the workspace at <workspace>/.vinv/reports/smoke-<id>.html
 * so it's a real, persistent file (referenceable in chat like any other), and its
 * on-disk path and rendered HTML are returned for the webview to display.
 *
 * Rejects when the tracelens engine isn't installed, no trace has been
 * captured yet, or the command exits abnormally.
 */
export interface SmokeReport {
	/** Absolute path of the generated HTML file under .vinv/reports. */
	path: string;
	/** The rendered, self-contained HTML document. */
	html: string;
}

export function generateSmokeReport(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	apiId: string,
): Promise<SmokeReport> {
	if (!isBinAvailable(context, 'tracelens')) {
		return Promise.reject(new Error('the tracelens engine is not installed yet.'));
	}
	const traceFile = probeTraceFile(workspaceRoot);
	if (!traceFile) {
		return Promise.reject(
			new Error('No captured trace found. Exercise this endpoint to capture a trace, then retry.'),
		);
	}

	const binPath = getBinPath(context, 'tracelens');
	ensureExecutableOnce(binPath);

	// The api id is sanitised so it's safe as a filename regardless of how the
	// endpoint id is shaped.
	const safeId = apiId.replace(/[^A-Za-z0-9._-]/g, '_');
	const reportsDir = path.join(workspaceRoot, '.vinv', 'reports');
	const outPath = path.join(reportsDir, `smoke-${safeId}.html`);
	try {
		fs.mkdirSync(reportsDir, { recursive: true });
	} catch {
		// Non-fatal: a real failure surfaces when the command writes its output.
	}

	return new Promise<SmokeReport>((resolve, reject) => {
		const child = spawn(
			binPath,
			['report', traceFile, '--out', outPath, '--api-id', apiId],
			{ cwd: workspaceRoot, env: getIndexEnv(path.dirname(binPath)), windowsHide: true },
		);
		let err = '';
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			err += chunk;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(err.trim() || `tracelens report exited with code ${code ?? 'null'}`));
				return;
			}
			let html: string;
			try {
				html = fs.readFileSync(outPath, 'utf8');
			} catch (e) {
				reject(new Error(`report produced no output: ${e instanceof Error ? e.message : String(e)}`));
				return;
			}
			resolve({ path: outPath, html });
		});
	});
}
