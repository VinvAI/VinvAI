/**
 * The in-editor half of the packaged acceptance run.
 *
 * VS Code loads this file in the extension host via `--extensionTestsPath`. The
 * extension under test is the one INSTALLED FROM THE VSIX in the profile the
 * driver prepared — there is no `--extensionDevelopmentPath`, so nothing here
 * can accidentally exercise the source tree.
 *
 * Deliberately not mocha: this is one scenario with a long wall clock (the real
 * engine spawns real workers), and a runner's default timeouts and reporters buy
 * nothing at a single test. `run()` resolving is the pass.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'VinvAI.VinvAI';

/** How long the real pipeline gets. Engine workers are real subprocesses. */
const PIPELINE_DEADLINE_MS = 10 * 60 * 1000;

export async function run(): Promise<void> {
	const workspace = process.env.VINV_E2E_WORKSPACE;
	assert.ok(workspace, 'VINV_E2E_WORKSPACE was not passed to the editor');

	await assertTheInstalledExtensionActivates();
	await assertThePipelineRunsTheRealEngine(workspace);
	log('acceptance run passed');
}

/**
 * The packaged extension is present, is the one from the VSIX, and activates.
 *
 * A VSIX that installs but never activates is the failure `test:packaged` cannot
 * see: it inspects the archive's contents and never boots an editor on it.
 */
async function assertTheInstalledExtensionActivates(): Promise<void> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(extension, `${EXTENSION_ID} is not installed in this profile`);
	assert.ok(
		!extension.extensionPath.includes(path.join('extension', 'src')),
		`the SOURCE tree activated, not the VSIX: ${extension.extensionPath}`,
	);

	await extension.activate();
	assert.ok(extension.isActive, 'the extension did not activate');

	// The product's entry point has to be reachable by the id the UI uses; a
	// command that fails to register is invisible to everything except a user.
	const commands = await vscode.commands.getCommands(true);
	assert.ok(
		commands.includes('vinv-vs.autoPilot'),
		'vinv-vs.autoPilot was never registered by the packaged build',
	);
	log(`activated ${EXTENSION_ID} from ${extension.extensionPath}`);
}

/**
 * Press the button, then look at what the ENGINE left on disk.
 *
 * The assertions are about artifacts rather than about UI state on purpose: the
 * artifacts are the product's output, they are what the next run and the coding
 * agent read, and they are the only evidence that the extension found the
 * engine, spawned it, and that it did real work on this project.
 */
async function assertThePipelineRunsTheRealEngine(workspace: string): Promise<void> {
	const exerciseDir = path.join(workspace, '.vinv', 'exercise');
	assert.ok(
		!fs.existsSync(path.join(exerciseDir, 'functions.json')),
		'the fixture already had engine output — the run would prove nothing',
	);

	log('running vinv-vs.autoPilot…');
	// Started, NOT awaited. Auto-Pilot resolves when every stage settles, and one
	// of them drains the agent channels through a coding harness that is not
	// signed in here — so awaiting it would make this test's runtime depend on
	// something it is not asserting. What is being asserted is that the engine
	// ran, and the artifacts are the evidence of that, so the artifacts are what
	// this waits for.
	const pipeline = Promise.resolve(
		vscode.commands.executeCommand('vinv-vs.autoPilot'),
	).catch((err) => log(`auto-pilot reported: ${err instanceof Error ? err.message : String(err)}`));
	const produced = await waitForAny(
		exerciseDir,
		['functions.json', 'campaign_result.json', 'issues.json'],
		PIPELINE_DEADLINE_MS,
	);
	assert.ok(
		produced.length > 0,
		`the pipeline produced no engine artifacts in ${exerciseDir} — ` +
			`present: ${safeList(exerciseDir).join(', ') || '(nothing)'}`,
	);
	log(`engine wrote: ${produced.join(', ')}`);
	// Give the stage a moment to finish writing the rest, but never wait on it.
	await Promise.race([pipeline, new Promise((resolve) => setTimeout(resolve, 30_000))]);

	// The campaign's own summary, which is the run's verdict rather than one
	// play's. Its absence means the exercise stage never reached `campaign`.
	const verdictFile = path.join(exerciseDir, 'campaign_result.json');
	if (fs.existsSync(verdictFile)) {
		const verdict = readJson(verdictFile);
		assert.ok(
			typeof verdict.status === 'string',
			'campaign_result.json carries no status for the extension to read',
		);
		assert.ok(Array.isArray(verdict.diagnostics), 'campaign_result.json carries no diagnostics');
		// The interpreter is the single most important input to the result, and a
		// run that does not record it is not reproducible.
		assert.ok(verdict.interpreter?.python, 'the run did not record which interpreter it used');
		log(`verdict: status=${verdict.status} interpreter=${verdict.interpreter.python}`);
	}

	// Proof the engine did WORK on this project rather than merely starting: the
	// fixture's two functions are the only targets it could have found.
	const functionsFile = path.join(exerciseDir, 'functions.json');
	if (fs.existsSync(functionsFile)) {
		const doc = readJson(functionsFile);
		assert.ok(
			(doc.targets ?? 0) > 0,
			`the engine ran and discovered nothing: ${JSON.stringify(doc.diagnostics ?? [])}`,
		);
		log(`targets=${doc.targets} calls=${doc.calls} clusters=${doc.issue_clusters}`);
	}
}

// =========================================================================

function safeList(directory: string): string[] {
	try {
		return fs.readdirSync(directory);
	} catch {
		return [];
	}
}

/** An engine artifact, read for the handful of fields this asserts on. */
interface EngineArtifact {
	status?: unknown;
	diagnostics?: unknown;
	interpreter?: { python?: string };
	targets?: number;
	calls?: number;
	issue_clusters?: number;
}

function readJson(file: string): EngineArtifact {
	return JSON.parse(fs.readFileSync(file, 'utf8')) as EngineArtifact;
}

/** Poll for whichever of `names` the engine produces, up to `deadlineMs`. */
async function waitForAny(
	directory: string,
	names: string[],
	deadlineMs: number,
): Promise<string[]> {
	const until = Date.now() + deadlineMs;
	for (;;) {
		const present = names.filter((n) => fs.existsSync(path.join(directory, n)));
		if (present.length > 0 || Date.now() > until) {
			return present;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

function log(message: string): void {
	// Goes to the driver's stdout, which is where a failing CI run is read from.
	process.stdout.write(`[vinv-e2e] ${message}\n`);
}
