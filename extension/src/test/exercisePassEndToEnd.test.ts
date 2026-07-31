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
	mergeIssueDocuments,
	mergeProfiles,
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
			pickTargets: () => [],
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
		const commands = rec.calls.map((c) => c.args[0]);
		// `plan`/`run` are the HTTP-shaped commands and must NOT run: there is no
		// service to plan against. `profile`/`scorecard` are not — they assemble
		// whatever the service-free oracles drove, and without them the pass wrote
		// issues.json alone, leaving every coverage counter at zero and the
		// Findings panel reporting "nothing has been exercised" over real findings.
		assert.deepStrictEqual(commands, ['invocations', 'campaign', 'profile', 'scorecard']);
		assert.ok(
			rec.calls.every((c) => !c.args.includes('--base-url')),
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

	// The pass used to return a hardcoded `endpointsCovered: 0, total: 0` here
	// however much it had driven, because nothing on this path assembled a
	// profile. Those zeros are what the Findings panel reads as "nothing has been
	// exercised" — so a repo with a full set of captures, a driven CLI and three
	// live findings rendered "No traces yet" and hid all three.
	test('assembled coverage reaches the pass result rather than a hardcoded zero', async () => {
		const root = workspace({ 'issues.json': { cluster_count: 0, clusters: [] } });
		const rec = recorder();
		const record = rec.ports.runEngine;
		rec.ports.runEngine = async (bin, args, cwd, env) => {
			// The engine writes profile.json; the fake must too, or the read-back is
			// testing a fixture rather than the wiring that reads it.
			if (args[0] === 'profile') {
				fs.writeFileSync(
					path.join(root, '.vinv', 'exercise', 'profile.json'),
					JSON.stringify({
						endpoint_count: 3,
						endpoints_with_coverage: 2,
						invariants_learned: 5,
						endpoints: [],
					}),
					'utf8',
				);
			}
			return record(bin, args, cwd, env);
		};

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		assert.strictEqual(result.total, 3, 'the pass reported no units over an assembled profile');
		assert.strictEqual(result.endpointsCovered, 2);
		assert.strictEqual(result.invariants, 5);
	});

	test('a failed assembly costs counters, not the findings', async () => {
		const root = workspace({
			'issues.json': {
				cluster_count: 1,
				clusters: [
					{
						signature: 'sig-live',
						kind: 'function-crash',
						title: 'demo:fn — TypeError',
						endpoint_id: 'demo:fn',
						method: 'CALL',
						path: 'demo:fn',
					},
				],
			},
		});
		const rec = recorder();
		const record = rec.ports.runEngine;
		rec.ports.runEngine = async (bin, args, cwd, env) =>
			args[0] === 'profile'
				? { ok: false, error: 'profile exploded' }
				: record(bin, args, cwd, env);

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		assert.strictEqual(result.outcome, 'done', 'a coverage step must not fail an earned pass');
		assert.strictEqual(result.issues, 1);
		assert.strictEqual(rec.dispatched.length, 1, 'the finding was still handed off');
		assert.ok(
			!rec.calls.some((c) => c.args[0] === 'scorecard'),
			'the scorecard is pure assembly over the profile — there is nothing to assemble',
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
			pickTargets: () => [{ service: 'api', port: 8000 }],
			serviceRunning: () => true,
		});

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		assert.strictEqual(result.outcome, 'done');
		// plan → run → campaign → regress → profile → scorecard. `campaign` runs
		// AFTER `run` because `run` rewrites issues.json wholesale; `regress`
		// replays the pairs `run` recorded, so it cannot precede it either.
		assert.deepStrictEqual(
			rec.calls.map((c) => c.args[0]),
			['plan', 'run', 'campaign', 'regress', 'profile', 'scorecard'],
		);
		const campaign = rec.calls.find((c) => c.args[0] === 'campaign');
		assert.ok(campaign?.args.includes('--base-url'), 'the HTTP oracle arms when a service is up');
		const regress = rec.calls.find((c) => c.args[0] === 'regress');
		assert.ok(regress?.args.includes('--base-url'), 'the replay needs the live service');
		assert.strictEqual(rec.dispatched.length, 1);
		assert.strictEqual(result.invariants, 5, 'the profile is read back into the result');
	});

	test('a failed plan stops the pass before it can report coverage', async () => {
		const rec = recorder({
			pickTargets: () => [{ service: 'api', port: 8000 }],
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
			pickTargets: () => [{ service: 'api', port: 8000 }],
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

	// Same contract as campaign: the replay is a history-builder, not a gate. A
	// first pass in a fresh workspace has no prior baseline to differ from, and
	// failing the pass over that would throw away everything `run` earned.
	test('a regress failure does NOT fail the pass', async () => {
		// Overriding runEngine replaces the recorder's own recording one, so the
		// override has to keep recording or rec.calls silently stays empty.
		const ran: string[] = [];
		const rec = recorder({
			pickTargets: () => [{ service: 'api', port: 8000 }],
			serviceRunning: () => true,
			runEngine: async (_b, args) => {
				ran.push(String(args[0]));
				return {
					ok: args[0] !== 'regress',
					error: args[0] === 'regress' ? 'no suite to replay' : undefined,
				};
			},
		});

		const result = await exercisePassOnce(fakeContext(), workspace(), rec.ports);

		assert.strictEqual(result.outcome, 'done');
		assert.ok(
			ran.includes('scorecard'),
			`the pass must carry on to the scorecard after a failed replay; ran: ${ran.join(' → ')}`,
		);
	});
});

// =========================================================================
// A workspace with more than one service
//
// The engine is single-service by construction: `run` rewrites issues.json
// wholesale, and `profile` joins coverage against ONE capture directory. So the
// naive `for (const target of targets)` around the whole pass reports a
// confident, clean scorecard for the service that ran last and silently
// discards every other. These are the tests that fail on that implementation.
// =========================================================================

/** The cluster `run --service <slug>` pretends to have found for that service. */
function clusterFor(slug: string): Record<string, unknown> {
	return {
		signature: `sig-${slug}`,
		kind: 'server-error',
		title: `GET /${slug} — HTTP 500`,
		endpoint_id: `GET_${slug}`,
		method: 'GET',
		path: `/${slug}`,
	};
}

/**
 * A fake engine that behaves the way the real one does about these two files:
 * `run` REPLACES issues.json with only its own service's cluster, and `profile`
 * REBUILDS profile.json with every endpoint but real coverage only for the
 * service whose capture it was pointed at.
 */
function wholesaleWritingEngine(
	root: string,
	slugs: readonly string[],
	calls: EngineCall[],
	fail: (command: string, slug: string | undefined) => string | undefined = () => undefined,
): ExercisePassPorts['runEngine'] {
	const write = (name: string, doc: unknown): void =>
		fs.writeFileSync(
			path.join(root, '.vinv', 'exercise', name),
			JSON.stringify(doc, null, 2),
			'utf8',
		);
	return async (_bin, args, cwd) => {
		calls.push({ args, cwd });
		const command = String(args[0]);
		const at = args.indexOf('--service');
		const slug = at >= 0 ? args[at + 1] : undefined;
		const error = fail(command, slug);
		if (error) {
			return { ok: false, error };
		}
		if (command === 'run' && slug) {
			write('issues.json', { version: 1, cluster_count: 1, clusters: [clusterFor(slug)] });
		}
		if (command === 'profile' && slug) {
			write('profile.json', {
				status: 'ok',
				endpoint_count: slugs.length,
				endpoints_with_coverage: 1,
				total_symbols_covered: 4,
				total_symbols: 4 * slugs.length,
				invariants_learned: 2,
				opportunities: [{ kind: 'p95-outlier', endpoint: `GET /${slug}` }],
				endpoints: slugs.map((s) => ({
					api_id: `GET_${s}`,
					method: 'GET',
					path: `/${s}`,
					// Only the service whose capture this run read can be seen.
					coverage: { covered: s === slug ? 4 : 0, total: 4, pct: s === slug ? 100 : 0 },
					invariants: s === slug ? [{ kind: 'shape' }, { kind: 'status' }] : [],
				})),
			});
		}
		return { ok: true };
	};
}

suite('the exercise pass: several services', () => {
	test('drives EVERY running service, not just the first', async () => {
		const root = workspace();
		const calls: EngineCall[] = [];
		const rec = recorder({
			pickTargets: () => [
				{ service: 'api', port: 8000 },
				{ service: 'worker', port: 9000 },
			],
			serviceRunning: () => true,
			runEngine: wholesaleWritingEngine(root, ['api', 'worker'], calls),
		});

		await exercisePassOnce(fakeContext(), root, rec.ports);

		const planned = calls.filter((c) => c.args[0] === 'plan');
		assert.deepStrictEqual(
			planned.map((c) => c.args[c.args.indexOf('--service') + 1]),
			['api', 'worker'],
			'a second service was discovered and never planned',
		);
		assert.deepStrictEqual(
			calls.filter((c) => c.args[0] === 'run').map((c) => c.args[c.args.indexOf('--base-url') + 1]),
			['http://127.0.0.1:8000', 'http://127.0.0.1:9000'],
			'each service must be driven on its OWN port',
		);
		// Assembly over the merged artifacts describes the workspace, so it runs
		// once — running it per service would just overwrite itself N times.
		assert.strictEqual(calls.filter((c) => c.args[0] === 'scorecard').length, 1);
	});

	test("a service's findings survive the next service's run", async () => {
		const root = workspace();
		const calls: EngineCall[] = [];
		const rec = recorder({
			pickTargets: () => [
				{ service: 'api', port: 8000 },
				{ service: 'worker', port: 9000 },
			],
			serviceRunning: () => true,
			runEngine: wholesaleWritingEngine(root, ['api', 'worker'], calls),
		});

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		// The whole point. `run --service worker` overwrote issues.json with only
		// its own cluster; the pass had to have read api's back first.
		const issues = readExerciseJson<ExerciseIssuesDoc>(root, 'issues.json');
		assert.deepStrictEqual(
			issues?.clusters.map((c) => c.signature).sort(),
			['sig-api', 'sig-worker'],
			'the first service’s findings were overwritten by the second’s run',
		);
		assert.strictEqual(issues?.cluster_count, 2);
		assert.strictEqual(result.issues, 2, 'the pass reported fewer findings than it holds');
		assert.deepStrictEqual(
			rec.dispatched.flatMap((d) => d.titles).sort(),
			['Behavior: GET /api — HTTP 500', 'Behavior: GET /worker — HTTP 500'],
			'a defect in the service that ran first reached nobody',
		);
	});

	test('coverage is merged per endpoint, from the capture that actually saw it', async () => {
		const root = workspace();
		const calls: EngineCall[] = [];
		const rec = recorder({
			pickTargets: () => [
				{ service: 'api', port: 8000 },
				{ service: 'worker', port: 9000 },
			],
			serviceRunning: () => true,
			runEngine: wholesaleWritingEngine(root, ['api', 'worker'], calls),
		});

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		// `profile --service worker` scored GET /api at 0 because it read the
		// wrong capture. Reporting that as the answer is the silent under-report
		// this merge exists to remove.
		assert.strictEqual(result.endpointsCovered, 2, 'an exercised endpoint was reported uncovered');
		assert.strictEqual(result.total, 2);
		assert.strictEqual(result.invariants, 4, 'invariants learned per service were not totalled');
		const profile = readExerciseJson<Record<string, any>>(root, 'profile.json');
		assert.strictEqual(profile?.total_symbols_covered, 8);
		assert.strictEqual(
			profile?.opportunities.length,
			2,
			'opportunities must be union-deduped, not concatenated per service',
		);
	});

	test('one wedged service does not discard the others’ findings', async () => {
		const root = workspace();
		const calls: EngineCall[] = [];
		const rec = recorder({
			pickTargets: () => [
				{ service: 'api', port: 8000 },
				{ service: 'worker', port: 9000 },
			],
			serviceRunning: () => true,
			runEngine: wholesaleWritingEngine(root, ['api', 'worker'], calls, (command, slug) =>
				command === 'run' && slug === 'worker' ? 'connection refused' : undefined,
			),
		});

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		// Partial coverage of a workspace is not a clean pass...
		assert.strictEqual(result.outcome, 'failed');
		assert.match(String(result.error), /worker: run failed — connection refused/);
		// ...but what api earned is real, published, and handed on.
		assert.strictEqual(result.issues, 1);
		assert.deepStrictEqual(rec.dispatched.flatMap((d) => d.titles), [
			'Behavior: GET /api — HTTP 500',
		]);
		assert.ok(
			calls.some((c) => c.args[0] === 'scorecard'),
			'the pass stopped at the wedged service instead of reporting what worked',
		);
	});

	test('the campaign budget is split across services, not spent once per service', async () => {
		const root = workspace();
		const calls: EngineCall[] = [];
		const rec = recorder({
			pickTargets: () => [
				{ service: 'api', port: 8000 },
				{ service: 'worker', port: 9000 },
			],
			serviceRunning: () => true,
			runEngine: wholesaleWritingEngine(root, ['api', 'worker'], calls),
		});

		await exercisePassOnce(fakeContext(), root, rec.ports);

		const budgets = calls
			.filter((c) => c.args[0] === 'campaign')
			.map((c) => Number(c.args[c.args.indexOf('--budget') + 1]));
		assert.strictEqual(budgets.length, 2, 'each service needs its own HTTP oracle armed');
		// The oracles a campaign arms are workspace-scoped apart from the HTTP
		// one, so N full budgets would re-drive the same targets for the same
		// findings — and every play can fork a worker that imports target code.
		assert.ok(
			budgets.reduce((a, b) => a + b, 0) <= 12,
			`the workspace budget must not multiply by service count; got ${budgets.join(' + ')}`,
		);
	});

	test('several services discovered but none running still takes the service-free pass', async () => {
		const root = workspace({ 'issues.json': { cluster_count: 0, clusters: [] } });
		const rec = recorder({
			pickTargets: () => [
				{ service: 'api', port: 8000 },
				{ service: 'worker', port: 9000 },
			],
			serviceRunning: () => false,
		});

		const result = await exercisePassOnce(fakeContext(), root, rec.ports);

		assert.strictEqual(result.outcome, 'done');
		// The service-free sequence exactly: nothing HTTP-shaped, because no
		// service came up, but still the coverage assembly that gives the panel
		// something to count.
		assert.deepStrictEqual(
			rec.calls.map((c) => c.args[0]),
			['invocations', 'campaign', 'profile', 'scorecard'],
		);
	});
});

// =========================================================================
// The merges themselves, as pure functions
// =========================================================================

suite('merging artifacts across services', () => {
	test('clusters dedupe by signature, first sighting wins', () => {
		const merged = mergeIssueDocuments([
			{ clusters: [{ signature: 'a', kind: 'server-error', path: '/x', count: 3 }] },
			{ clusters: [{ signature: 'a', kind: 'server-error', path: '/x', count: 1 }] },
			{ clusters: [{ signature: 'b', kind: 'function-crash', path: 'm:f' }] },
			null,
		]);
		assert.deepStrictEqual(merged.clusters.map((c) => c.signature), ['b', 'a']);
		assert.strictEqual(merged.cluster_count, 2);
		assert.strictEqual(merged.clusters.find((c) => c.signature === 'a')?.count, 3);
	});

	test('a cluster keeps the evidence fields the Findings view renders', () => {
		const merged = mergeIssueDocuments([
			{
				clusters: [
					{
						signature: 's',
						kind: 'server-error',
						exemplar: { status: 500, input: { q: 1 } },
						covered_frames: ['app.main:handler'],
					},
				],
			},
		]);
		assert.deepStrictEqual(merged.clusters[0].covered_frames, ['app.main:handler']);
		assert.deepStrictEqual(merged.clusters[0].exemplar, { status: 500, input: { q: 1 } });
	});

	test('an unsigned cluster is not collapsed into another unsigned one', () => {
		const merged = mergeIssueDocuments([
			{ clusters: [{ kind: 'k', endpoint_id: 'e1', title: 't' }, { kind: 'k', endpoint_id: 'e2', title: 't' }] },
		]);
		assert.strictEqual(merged.cluster_count, 2);
	});

	test('a single profile is returned byte-identical', () => {
		const doc = { endpoint_count: 3, endpoints: [], invariants_learned: 5 };
		assert.strictEqual(mergeProfiles([doc]), doc);
	});

	test('the merged profile totals the endpoints once, not once per service', () => {
		const shape = (covered: number, other: number) => ({
			status: 'ok',
			endpoints: [
				{ api_id: 'A', coverage: { covered, total: 4 }, invariants: covered ? [{}, {}] : [] },
				{ api_id: 'B', coverage: { covered: other, total: 6 }, invariants: other ? [{}] : [] },
			],
		});
		const merged = mergeProfiles([shape(4, 0), shape(0, 6)]);
		assert.strictEqual(merged?.endpoint_count, 2, 'the shared endpoints were counted twice');
		assert.strictEqual(merged?.endpoints_with_coverage, 2);
		assert.strictEqual(merged?.total_symbols_covered, 10);
		assert.strictEqual(merged?.total_symbols, 10);
		assert.strictEqual(merged?.invariants_learned, 3);
	});

	test('nothing to merge is null, not an empty profile reported as a clean run', () => {
		assert.strictEqual(mergeProfiles([]), null);
		assert.strictEqual(mergeProfiles([null, null]), null);
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
