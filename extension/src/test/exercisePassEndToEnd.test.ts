/**
 * The whole loop: the extension's pass, the REAL engine, and the dispatch.
 *
 * `integrationPipeline.test.ts` drives the readers. This drives the
 * ORCHESTRATION — which engine commands run, in what order, which failures are
 * fatal, and whether findings are handed to the coding agent — against artifacts
 * the engine actually produced rather than any this file wrote.
 *
 * That distinction is the whole reason this exists. Every other test on this
 * side builds its own fixture, so it passes whether or not the engine emits that
 * shape; and every test on the engine side asserts what it wrote, so it passes
 * whether or not anything reads it. The pass returning BEFORE the dispatch block
 * its own docstring said it reached survived both kinds for three rounds.
 *
 * The engine artifacts come from `exerciser/tests/test_integration_end_to_end.py`,
 * which writes them under `src/test/fixtures/engine-artifacts/` on every run. If
 * that directory is absent the artifact-backed tests SKIP rather than silently
 * pass on a fixture nobody produced — a skip is visible, a fabricated pass is not.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';

import {
	dispatchFreshClusters,
	exercisePassOnce,
	readExerciseJson,
	type ExerciseIssuesDoc,
	type ExercisePassPorts,
} from '../harness/exerciseRunner';

// =========================================================================
// Test doubles for the world outside the pass
// =========================================================================

interface EngineCall {
	args: string[];
	cwd: string;
}

interface Recorder {
	calls: EngineCall[];
	dispatched: Array<{ titles: string[]; trigger?: string }>;
	drained: number;
	ports: ExercisePassPorts;
}

/** Ports that record what the pass did, with everything succeeding by default. */
function recorder(over: Partial<ExercisePassPorts> = {}): Recorder {
	const calls: EngineCall[] = [];
	const dispatched: Array<{ titles: string[]; trigger?: string }> = [];
	let drained = 0;
	const rec: Recorder = {
		calls,
		dispatched,
		get drained() {
			return drained;
		},
		ports: {
			binAvailable: () => true,
			binPath: () => path.join(os.tmpdir(), 'bin', 'exerciser'),
			handbookEnv: () => ({}),
			runEngine: async (_bin, args, cwd) => {
				calls.push({ args, cwd });
				return { ok: true };
			},
			// No service by default: the case the branch existed to fix.
			pickTarget: () => null,
			serviceRunning: () => false,
			autoEpisodesEnabled: () => true,
			dispatch: async (_ctx, _root, issues, opts) => {
				dispatched.push({ titles: issues.map((i) => i.title), trigger: opts?.trigger });
				return true;
			},
			drainChannels: async () => {
				drained += 1;
				return { pending: 0, answered: 0, topics: [], detail: 'no questions pending', ok: true };
			},
			...over,
		},
	} as Recorder;
	return rec;
}

/** The slice of ExtensionContext the pass touches: a workspaceState memento. */
function fakeContext(): vscode.ExtensionContext {
	const store = new Map<string, unknown>();
	return {
		workspaceState: {
			get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
			update: async (key: string, value: unknown) => {
				store.set(key, value);
			},
			keys: () => [...store.keys()],
		},
	} as unknown as vscode.ExtensionContext;
}

function workspace(files: Record<string, unknown> = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-pass-'));
	fs.mkdirSync(path.join(root, '.vinv', 'exercise'), { recursive: true });
	for (const [name, doc] of Object.entries(files)) {
		fs.writeFileSync(
			path.join(root, '.vinv', 'exercise', name),
			typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2),
			'utf8',
		);
	}
	return root;
}

// =========================================================================
// Artifacts the ENGINE wrote, not this file
// =========================================================================

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'engine-artifacts');

function engineArtifacts(): Record<string, string> | null {
	try {
		const names = fs.readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.json'));
		if (names.length === 0) {
			return null;
		}
		return Object.fromEntries(
			names.map((n) => [n, fs.readFileSync(path.join(FIXTURE_DIR, n), 'utf8')]),
		);
	} catch {
		return null;
	}
}

// =========================================================================
// The service-free pass, which is what a library repo takes
// =========================================================================

suite('the exercise pass: nothing serving', () => {
	test('runs the campaign, publishes, drains the channels and DISPATCHES', async () => {
		const root = workspace({
			'issues.json': {
				cluster_count: 1,
				clusters: [
					{
						signature: 'sig-crash-1',
						kind: 'function-crash',
						title: 'demo.pure:divide — ZeroDivisionError',
						endpoint_id: 'demo.pure:divide',
						method: 'CALL',
						path: 'demo.pure:divide',
					},
				],
			},
			'campaign_result.json': { status: 'ok', diagnostics: [] },
		});
		const rec = recorder();

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		assert.strictEqual(result.outcome, 'done');
		// The HTTP-shaped commands must NOT run: there is no service.
		const commands = rec.calls.map((c) => c.args[0]);
		assert.deepStrictEqual(commands, ['campaign']);
		assert.ok(
			!rec.calls[0].args.includes('--base-url'),
			'the HTTP oracle must stay unarmed with nothing serving',
		);
		// The regression this suite exists for: the pass returned before here.
		assert.strictEqual(rec.dispatched.length, 1, 'findings were published and handed to nobody');
		// The episode title is composed from the cluster's; assert it CARRIES the
		// finding rather than pinning the composition, which is not this test's claim.
		assert.match(rec.dispatched[0].titles[0], /demo\.pure:divide — ZeroDivisionError/);
	});

	test('a finding is dispatched once, not again on the next pass', async () => {
		const files = {
			'issues.json': {
				cluster_count: 1,
				clusters: [
					{
						signature: 'sig-stable',
						kind: 'function-crash',
						title: 'demo:fn — TypeError',
						endpoint_id: 'demo:fn',
						method: 'CALL',
						path: 'demo:fn',
					},
				],
			},
		};
		const root = workspace(files);
		const context = fakeContext();
		const rec = recorder();

		await exercisePassOnce(context, root, rec.ports);
		await exercisePassOnce(context, root, rec.ports);

		assert.strictEqual(rec.dispatched.length, 1, 'the same defect was dispatched twice');
	});

	test('assert-shaped findings dispatch under their own trigger', async () => {
		const root = workspace({
			'issues.json': {
				cluster_count: 2,
				clusters: [
					{
						signature: 'a',
						kind: 'function-crash',
						title: 'raises',
						endpoint_id: 'x:a',
						method: 'CALL',
						path: 'x:a',
					},
					{
						signature: 'b',
						kind: 'invariant-violation',
						title: 'wrong value',
						endpoint_id: 'x:b',
						method: 'CALL',
						path: 'x:b',
					},
				],
			},
		});
		const rec = recorder();
		await exercisePassOnce(fakeContext(), root, rec.ports);

		const triggers = rec.dispatched.map((d) => d.trigger);
		assert.ok(triggers.includes(undefined), 'the error-shaped batch uses the default trigger');
		assert.ok(
			triggers.includes('invariant-violation'),
			'a silent wrong value needs value-shaped criteria, not "no longer raises"',
		);
	});

	test('a failed campaign is reported and dispatches nothing', async () => {
		const root = workspace({ 'issues.json': { cluster_count: 0, clusters: [] } });
		const rec = recorder({ runEngine: async () => ({ ok: false, error: 'engine exploded' }) });

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		assert.strictEqual(result.outcome, 'failed');
		assert.match(String(result.error), /engine exploded/);
		assert.strictEqual(rec.dispatched.length, 0);
	});

	test('a missing engine skips the pass rather than failing it', async () => {
		const rec = recorder({ binAvailable: () => false });
		const result = await exercisePassOnce(fakeContext(), workspace(), rec.ports);
		assert.strictEqual(result.outcome, 'skipped');
		assert.strictEqual(rec.calls.length, 0);
	});

	test('auto-episodes off means findings are published and not actioned', async () => {
		const root = workspace({
			'issues.json': {
				cluster_count: 1,
				clusters: [
					{
						signature: 's',
						kind: 'function-crash',
						title: 't',
						endpoint_id: 'e',
						method: 'CALL',
						path: 'p',
					},
				],
			},
		});
		const rec = recorder({ autoEpisodesEnabled: () => false });
		const result = await exercisePassOnce(fakeContext(), root, rec.ports);
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(rec.dispatched.length, 0);
	});
});

// =========================================================================
// The served pass, which is the original path
// =========================================================================

suite('the exercise pass: a service is up', () => {
	test('drives the HTTP sequence in order and still dispatches', async () => {
		const root = workspace({
			'issues.json': {
				cluster_count: 1,
				clusters: [
					{
						signature: 'http-1',
						kind: 'server-error',
						title: 'GET /items — HTTP 500',
						endpoint_id: 'GET_items',
						method: 'GET',
						path: '/items',
					},
				],
			},
			'profile.json': {
				endpoint_count: 3,
				endpoints_with_coverage: 2,
				invariants_learned: 5,
				total_symbols: 0,
				total_symbols_covered: 0,
				endpoints: [],
			},
		});
		const rec = recorder({
			pickTarget: () => ({ service: 'api', port: 8000 }),
			serviceRunning: () => true,
		});

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		assert.strictEqual(result.outcome, 'done');
		// plan → run → campaign → profile → scorecard. `campaign` runs AFTER `run`
		// because `run` rewrites issues.json wholesale.
		assert.deepStrictEqual(
			rec.calls.map((c) => c.args[0]),
			['plan', 'run', 'campaign', 'profile', 'scorecard'],
		);
		const campaign = rec.calls.find((c) => c.args[0] === 'campaign');
		assert.ok(campaign?.args.includes('--base-url'), 'the HTTP oracle arms when a service is up');
		assert.strictEqual(rec.dispatched.length, 1);
		assert.strictEqual(result.invariants, 5, 'the profile is read back into the result');
	});

	test('a failed plan stops the pass before it can report coverage', async () => {
		const rec = recorder({
			pickTarget: () => ({ service: 'api', port: 8000 }),
			serviceRunning: () => true,
			runEngine: async (_b, args) => ({ ok: args[0] !== 'plan', error: 'plan blew up' }),
		});
		const result = await exercisePassOnce(fakeContext(), workspace(), rec.ports);
		assert.strictEqual(result.outcome, 'failed');
		assert.match(String(result.error), /plan blew up/);
	});

	test('a campaign failure does NOT discard the HTTP findings already earned', async () => {
		const root = workspace({
			'issues.json': {
				cluster_count: 1,
				clusters: [
					{
						signature: 'earned',
						kind: 'server-error',
						title: 'GET /x — HTTP 500',
						endpoint_id: 'GET_x',
						method: 'GET',
						path: '/x',
					},
				],
			},
		});
		const rec = recorder({
			pickTarget: () => ({ service: 'api', port: 8000 }),
			serviceRunning: () => true,
			runEngine: async (_b, args) => ({
				ok: args[0] !== 'campaign',
				error: args[0] === 'campaign' ? 'campaign failed' : undefined,
			}),
		});

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		assert.strictEqual(result.outcome, 'done', 'the earned findings were thrown away');
		assert.strictEqual(rec.dispatched.length, 1);
	});
});

// =========================================================================
// Against artifacts the engine actually wrote
// =========================================================================

suite('the pass over REAL engine artifacts', () => {
	test('every artifact the engine emitted is consumed without a hand-written fixture', async function () {
		const artifacts = engineArtifacts();
		if (!artifacts) {
			// Visible rather than silent: the Python integration suite writes these.
			this.skip();
			return;
		}
		const root = workspace(artifacts);
		const rec = recorder();

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		assert.strictEqual(result.outcome, 'done');
		const issues = readExerciseJson<ExerciseIssuesDoc>(root, 'issues.json');
		if (issues && issues.cluster_count > 0) {
			assert.strictEqual(
				result.issues,
				issues.cluster_count,
				'the pass reported a different count than the engine wrote',
			);
			assert.ok(rec.dispatched.length >= 1, 'real findings reached nobody');
		}
	});

	test('the engine-written verdict is what the pass publishes', function () {
		const artifacts = engineArtifacts();
		if (!artifacts?.['campaign_result.json']) {
			this.skip();
			return;
		}
		const doc = JSON.parse(artifacts['campaign_result.json']) as {
			status?: string;
			diagnostics?: string[];
		};
		// The two fields `engineVerdict` reads, asserted against what the engine
		// really emitted rather than against a shape this file invented.
		assert.ok(typeof doc.status === 'string', 'the engine stopped emitting `status`');
		assert.ok(Array.isArray(doc.diagnostics), 'the engine stopped emitting `diagnostics`');
	});
});

// =========================================================================
// The dispatch selection itself
// =========================================================================

suite('what becomes an episode', () => {
	test('a diagnostic-only kind is never actioned', async () => {
		const root = workspace({
			'issues.json': {
				cluster_count: 1,
				clusters: [
					{
						signature: 'drift',
						kind: 'signature-drift',
						title: 'upstream changed its API',
						endpoint_id: 'dep:fn',
						method: 'CALL',
						path: 'dep:fn',
					},
				],
			},
		});
		const rec = recorder();
		await dispatchFreshClusters(
			fakeContext(),
			root,
			readExerciseJson<ExerciseIssuesDoc>(root, 'issues.json'),
			rec.ports,
		);
		// There is no edit to this repo that fixes an upstream API change; a fix
		// budget spent on one is spent on something unresolvable.
		const titles = rec.dispatched.flatMap((d) => d.titles).join(' | ');
		assert.ok(!titles.includes('upstream changed its API'), titles);
	});

	test('nothing to report dispatches nothing and still completes', async () => {
		const root = workspace({ 'issues.json': { cluster_count: 0, clusters: [] } });
		const rec = recorder();
		const result = await exercisePassOnce(fakeContext(), root, rec.ports);
		assert.strictEqual(result.outcome, 'done');
		assert.strictEqual(rec.dispatched.length, 0);
	});
});
