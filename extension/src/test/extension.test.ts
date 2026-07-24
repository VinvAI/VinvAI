import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as path from 'path';
import { buildServerSpecs, MCP_TARGETS } from '../mcp/mcpRegistrar';
import { rankSuspects } from '../runtime/sbfl';
import { backwardSlice, blastRadius } from '../runtime/slice';
import { EnterRow, ExitRow, TraceCorpus, loadCorpus } from '../runtime/traceStore';
import { chunkForComponent } from '../runtime/indexJoin';
import { binaryFilePath } from '../vinvHome';
import { ENGINE_NAMES } from '../tracelens/bin';
import {
	appendRetrievalEvent,
	explorationEpsilon,
	loadPolicyForEpoch,
	loadTelemetryState,
	queryFeatures,
	retrievalActionSet,
	retrievalEpoch,
	saveTelemetryState,
	selectRetrievalAction,
} from '../mcp/retrievalTelemetry';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('shared binaries honor the VINV_HOME contract', () => {
		const previous = process.env.VINV_HOME;
		try {
			process.env.VINV_HOME = path.join(path.sep, 'tmp', 'vinv-test-home');
			assert.strictEqual(
				binaryFilePath('index'),
				path.join(
					path.sep,
					'tmp',
					'vinv-test-home',
					'bin',
					process.platform === 'win32' ? 'index.exe' : 'index',
				),
			);
			assert.throws(() => binaryFilePath('../index'), /Invalid binary name/);
		} finally {
			if (previous === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previous;
			}
		}
	});

	test('every shipped engine, including goal authoring and the exerciser, is known', () => {
		assert.deepStrictEqual(ENGINE_NAMES, [
			'index',
			'tracelens',
			'handbook',
			'bringup',
			'identification',
			'goal',
			'exerciser',
		]);
	});

	test('extension identity matches the walkthrough/command wiring', () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
		) as { publisher: string; name: string };
		assert.strictEqual(`${manifest.publisher}.${manifest.name}`, 'VinvAI.VinvAI');
	});

	test('MCP registration exposes index and runtime servers without secrets', () => {
		const context = { extensionPath: path.join(path.sep, 'opt', 'vinv-vs') } as vscode.ExtensionContext;
		const specs = buildServerSpecs(context, path.join(path.sep, 'workspace'));
		assert.deepStrictEqual(
			specs.map((spec) => spec.key),
			['vinv-index', 'vinv-runtime'],
		);
		for (const spec of specs) {
			assert.strictEqual(spec.env.ELECTRON_RUN_AS_NODE, '1');
			assert.strictEqual('OPENAI_API_KEY' in spec.env, false);
			assert.strictEqual(spec.args.at(-1), path.join(path.sep, 'workspace'));
		}
	});

	test('Claude Code local-scope registration merges without clobbering foreign state', () => {
		const previousUserProfile = process.env.USERPROFILE;
		const previousHome = process.env.HOME;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-claude-'));
		try {
			// os.homedir() resolves from USERPROFILE (win32) / HOME (posix).
			process.env.USERPROFILE = home;
			process.env.HOME = home;
			const claude = MCP_TARGETS.find((t) => t.id === 'claude')!;
			const context = { extensionPath: path.join(home, 'ext') } as vscode.ExtensionContext;
			const ws = fs.mkdtempSync(path.join(home, 'ws-'));
			const specs = buildServerSpecs(context, ws);
			const claudeJson = path.join(home, '.claude.json');

			// Existing Claude Code state, a case-differing project key, and a foreign
			// server must all survive our write untouched.
			fs.writeFileSync(
				claudeJson,
				JSON.stringify({
					oauthAccount: { email: 'x@y.z' },
					projects: {
						[process.platform === 'win32' ? ws.toUpperCase() : ws]: {
							allowedTools: ['Bash'],
							mcpServers: { 'their-server': { command: 'their' } },
						},
					},
				}),
			);
			assert.strictEqual(claude.write(specs, ws), true);
			const config = JSON.parse(fs.readFileSync(claudeJson, 'utf8')) as {
				oauthAccount: { email: string };
				projects: Record<
					string,
					{ allowedTools: string[]; mcpServers: Record<string, unknown> }
				>;
			};
			assert.strictEqual(config.oauthAccount.email, 'x@y.z');
			const projectKeys = Object.keys(config.projects);
			assert.strictEqual(projectKeys.length, 1, 'reuses the existing project key');
			const project = config.projects[projectKeys[0]];
			assert.deepStrictEqual(project.allowedTools, ['Bash']);
			assert.ok(project.mcpServers['their-server']);
			assert.ok(project.mcpServers['vinv-index']);
			assert.ok(project.mcpServers['vinv-runtime']);
			assert.strictEqual(claude.isRegistered(ws), true);
			// Idempotent: an unchanged write reports no change.
			assert.strictEqual(claude.write(specs, ws), false);

			// An unparseable ~/.claude.json is never overwritten.
			fs.writeFileSync(claudeJson, '{not json');
			assert.strictEqual(claude.write(specs, ws), false);
			assert.strictEqual(fs.readFileSync(claudeJson, 'utf8'), '{not json');

			// Migration: entries an older version wrote into the repo's .mcp.json are
			// stripped; a file that held only our entries is deleted outright.
			fs.writeFileSync(
				claudeJson,
				JSON.stringify({ projects: { [ws]: { mcpServers: {} } } }),
			);
			const legacy = path.join(ws, '.mcp.json');
			fs.writeFileSync(
				legacy,
				JSON.stringify({ mcpServers: { 'vinv-index': {}, keep: { command: 'k' } } }),
			);
			claude.write(specs, ws);
			const repoConfig = JSON.parse(fs.readFileSync(legacy, 'utf8')) as {
				mcpServers: Record<string, unknown>;
			};
			assert.deepStrictEqual(Object.keys(repoConfig.mcpServers), ['keep']);
			fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { 'vinv-index': {} } }));
			claude.write(specs, ws);
			assert.strictEqual(fs.existsSync(legacy), false);

			// remove() strips only our servers and stays reversible.
			assert.strictEqual(claude.remove(ws), true);
			assert.strictEqual(claude.isRegistered(ws), false);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			if (previousUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousUserProfile;
			}
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});

	test('retrieval telemetry is content-safe and invalidates stale policy epochs', () => {
		const previous = process.env.VINV_HOME;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-policy-'));
		const store = path.join(home, 'store');
		fs.mkdirSync(store);
		fs.writeFileSync(path.join(store, 'meta.json'), '{"version":4,"updated_unix":1}');
		fs.writeFileSync(path.join(store, 'manifest.json'), '{}');
		try {
			process.env.VINV_HOME = home;
			const epoch = retrievalEpoch(store);
			const query = 'where is sk-secret-sensitive-value handled?';
			const features = queryFeatures(query);
			assert.strictEqual(JSON.stringify(features).includes(query), false);
			fs.writeFileSync(
				path.join(home, 'retrieval-policy.json'),
				JSON.stringify({ version: 1, epoch: 'stale', top_k: 3 }),
			);
			assert.strictEqual(loadPolicyForEpoch(epoch), null);
			appendRetrievalEvent({
				type: 'decision',
				ts: new Date().toISOString(),
				epoch,
				features,
			});
			const telemetry = fs.readFileSync(
				path.join(home, 'telemetry', 'retrieval.jsonl'),
				'utf8',
			);
			assert.strictEqual(telemetry.includes(query), false);
			fs.writeFileSync(
				path.join(home, 'retrieval-policy.json'),
				JSON.stringify({ version: 1, epoch, top_k: 3 }),
			);
			assert.deepStrictEqual(loadPolicyForEpoch(epoch), {
				version: 1,
				epoch,
				top_k: 3,
				canary_fraction: 0.05,
			});
			const policy = loadPolicyForEpoch(epoch);
			assert.deepStrictEqual(selectRetrievalAction(5, policy, 'canary', 0.01), {
				topK: 3,
				propensity: 0.05,
				policy: 'canary',
				shadowTopK: null,
			});
			assert.deepStrictEqual(selectRetrievalAction(5, policy, 'canary', 0.5), {
				topK: 5,
				propensity: 0.95,
				policy: 'baseline',
				shadowTopK: 3,
			});
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previous;
			}
		}
	});

	test('epsilon-greedy exploration logs exact per-action propensities', () => {
		const previousEpsilon = process.env.VINV_RETRIEVAL_EPSILON;
		const previousActions = process.env.VINV_RETRIEVAL_ACTIONS;
		try {
			process.env.VINV_RETRIEVAL_EPSILON = '0.2';
			process.env.VINV_RETRIEVAL_ACTIONS = '3,5,8,10';
			const actions = retrievalActionSet(5);
			assert.deepStrictEqual(actions, [3, 5, 8, 10]);
			assert.strictEqual(explorationEpsilon(), 0.2);
			// Greedy draw (randomValue >= epsilon): requested action with
			// propensity (1-eps) + eps/|A| = 0.8 + 0.05.
			const greedy = selectRetrievalAction(5, null, 'explore', 0.9);
			assert.strictEqual(greedy.topK, 5);
			assert.strictEqual(greedy.policy, 'baseline');
			assert.ok(Math.abs(greedy.propensity - 0.85) < 1e-12);
			// Exploring draw: randomValue 0.15 < eps; 0.15/0.2 in binary floating
			// point is just below 0.75, landing on index 2 (action 8) with
			// propensity eps/|A| = 0.05.
			const explored = selectRetrievalAction(5, null, 'explore', 0.15);
			assert.strictEqual(explored.topK, 8);
			assert.strictEqual(explored.policy, 'explore');
			assert.ok(Math.abs(explored.propensity - 0.05) < 1e-12);
			// Propensities over the action set sum to one.
			const total = actions
				.map((action) =>
					action === 5 ? 0.8 + 0.2 / actions.length : 0.2 / actions.length,
				)
				.reduce((sum, value) => sum + value, 0);
			assert.ok(Math.abs(total - 1) < 1e-12);
			// A requested top_k outside the set joins it, keeping support valid.
			assert.deepStrictEqual(retrievalActionSet(7), [3, 5, 7, 8, 10]);
		} finally {
			if (previousEpsilon === undefined) {
				delete process.env.VINV_RETRIEVAL_EPSILON;
			} else {
				process.env.VINV_RETRIEVAL_EPSILON = previousEpsilon;
			}
			if (previousActions === undefined) {
				delete process.env.VINV_RETRIEVAL_ACTIONS;
			} else {
				process.env.VINV_RETRIEVAL_ACTIONS = previousActions;
			}
		}
	});

	test('telemetry state persists rollback and pending decisions across restarts', () => {
		const previous = process.env.VINV_HOME;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-state-'));
		try {
			process.env.VINV_HOME = home;
			// A missing file yields a clean, mutable slate.
			const fresh = loadTelemetryState();
			assert.strictEqual(fresh.policy_disabled, false);
			assert.deepStrictEqual(fresh.pending, []);
			saveTelemetryState({
				version: 1,
				policy_disabled: true,
				consecutive_canary_losses: 3,
				pending: [
					{
						decision_id: 'd-1',
						epoch: 'e-1',
						ts: new Date(0).toISOString(),
						canary: true,
						files: ['src/a.ts'],
					},
				],
			});
			const restored = loadTelemetryState();
			assert.strictEqual(restored.policy_disabled, true);
			assert.strictEqual(restored.consecutive_canary_losses, 3);
			assert.strictEqual(restored.pending.length, 1);
			assert.strictEqual(restored.pending[0].decision_id, 'd-1');
			// Corrupt state must not crash the server or fabricate a policy.
			fs.writeFileSync(path.join(home, 'telemetry', 'state.json'), '{not json');
			const recovered = loadTelemetryState();
			assert.strictEqual(recovered.policy_disabled, false);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previous;
			}
		}
	});

	test('Ochiai ranks failure-specific symbols above common symbols', () => {
		const commonOk = exit('pass', 'common', 0, null, 'ok');
		const commonFail = exit('fail', 'common', 0, null, 'ok');
		const bugFail = exit('fail', 'compute_total', 1, 'common', 'error');
		const corpus = makeCorpus([], [commonOk, commonFail, bugFail]);
		const result = rankSuspects(corpus);
		assert.strictEqual(result.degenerate, false);
		assert.strictEqual(result.suspects[0].component, 'compute_total');
		assert.strictEqual(result.suspects[0].directErrors, 1);
		assert.deepStrictEqual(result.suspects[0].errorTypes, ['ZeroDivisionError']);
	});

	test('slice and blast radius reconstruct the observed caller chain', () => {
		const enters: EnterRow[] = [
			enter('fail', 'checkout', 0, null),
			enter('fail', 'compute_total', 1, 'checkout'),
		];
		const exits: ExitRow[] = [
			exit('fail', 'checkout', 0, null, 'error'),
			exit('fail', 'compute_total', 1, 'checkout', 'error'),
		];
		const corpus = makeCorpus(enters, exits);
		const slice = backwardSlice(corpus, 'compute_total');
		assert.deepStrictEqual(
			slice.paths[0].frames.map((frame) => frame.component),
			['checkout', 'compute_total'],
		);
		const radius = blastRadius(corpus, 'checkout');
		assert.deepStrictEqual(radius.downstream, ['compute_total']);
		assert.deepStrictEqual(radius.directCallees, [{ component: 'compute_total', calls: 1 }]);
	});
});

function enter(
	requestId: string,
	component: string,
	depth: number,
	parent: string | null,
): EnterRow {
	return {
		kind: 'enter',
		ts: '2026-01-01T00:00:00Z',
		request_id: requestId,
		component,
		depth,
		parent_component: parent,
		thread_id: 1,
		args_summary: {},
	};
}

function exit(
	requestId: string,
	component: string,
	depth: number,
	parent: string | null,
	status: 'ok' | 'error',
): ExitRow {
	return {
		kind: 'exit',
		ts: '2026-01-01T00:00:00Z',
		request_id: requestId,
		component,
		depth,
		parent_component: parent,
		thread_id: 1,
		duration_ms: 1,
		status,
		error_type: status === 'error' ? 'ZeroDivisionError' : null,
		result_summary: null,
		oracle_violations: [],
	};
}

suite('Epoch-tagged traces join to index chunks', () => {
	test('capture epochs date runtime facts against per-chunk content epochs', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-epoch-'));

		// An index whose `charge` chunk last changed at epoch 5, and two chunks
		// sharing the name `helper` in different modules (disambiguation case).
		const indexDir = path.join(root, '.vinv', 'index');
		fs.mkdirSync(indexDir, { recursive: true });
		fs.writeFileSync(
			path.join(indexDir, 'chunks.jsonl'),
			[
				JSON.stringify({
					id: 'billing/payments.py:10:charge',
					file: 'billing/payments.py',
					name: 'charge',
					sha: 'aa',
					epoch: 5,
				}),
				JSON.stringify({
					id: 'billing/util.py:1:helper',
					file: 'billing/util.py',
					name: 'helper',
					sha: 'bb',
					epoch: 2,
				}),
				JSON.stringify({
					id: 'auth/util.py:1:helper',
					file: 'auth/util.py',
					name: 'helper',
					sha: 'cc',
					epoch: 3,
				}),
			].join('\n'),
		);

		// A capture session stamped at epoch 3 — before `charge` last changed.
		const sessionDir = path.join(root, '.vinv', 'captures', 's1', 'svc');
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(path.join(sessionDir, 'epoch.json'), JSON.stringify({ epoch: 3 }));
		fs.writeFileSync(
			path.join(sessionDir, 'trace.jsonl'),
			JSON.stringify({
				event: 'enter',
				ts: 't',
				request_id: 'r1',
				component: 'billing.payments.charge',
				depth: 0,
				parent_component: null,
				thread_id: 1,
				args_summary: {},
			}) + '\n',
		);

		const corpus = loadCorpus(root);
		const record = corpus.bySymbol.get('billing.payments.charge');
		assert.ok(record);
		assert.strictEqual(record.lastObservedEpoch, 3);
		assert.strictEqual(record.observedUntagged, false);
		assert.strictEqual(corpus.epochBySource.size, 1);

		// The join resolves the component to its chunk; epoch 5 > observed 3
		// means these runtime facts describe since-changed code.
		const chunk = chunkForComponent(root, 'billing.payments.charge');
		assert.ok(chunk);
		assert.strictEqual(chunk.epoch, 5);
		assert.ok(chunk.epoch > record.lastObservedEpoch!);

		// Ambiguous short names disambiguate via the qualname's module segments.
		assert.strictEqual(
			chunkForComponent(root, 'auth.util.helper')?.id,
			'auth/util.py:1:helper',
		);
		assert.strictEqual(
			chunkForComponent(root, 'billing.util.helper')?.id,
			'billing/util.py:1:helper',
		);

		fs.rmSync(root, { recursive: true, force: true });
	});
});

function makeCorpus(enters: EnterRow[], exits: ExitRow[]): TraceCorpus {
	const bySymbol = new Map<string, TraceCorpus['bySymbol'] extends Map<string, infer R> ? R : never>();
	const byRequest = new Map<string, TraceCorpus['byRequest'] extends Map<string, infer R> ? R : never>();
	const callers = new Map<string, Map<string, number>>();
	const callees = new Map<string, Map<string, number>>();
	for (const row of [...enters, ...exits]) {
		let record = bySymbol.get(row.component);
		if (!record) {
			record = {
				component: row.component,
				enters: [],
				exits: [],
				requests: new Set(),
				lastObservedEpoch: null,
				observedUntagged: true,
			};
			bySymbol.set(row.component, record);
		}
		record.requests.add(row.request_id);
		if (row.kind === 'enter') {
			record.enters.push(row);
		} else {
			record.exits.push(row);
		}
		let outcome = byRequest.get(row.request_id);
		if (!outcome) {
			outcome = { request_id: row.request_id, failed: false, components: new Set(), roots: [] };
			byRequest.set(row.request_id, outcome);
		}
		outcome.components.add(row.component);
		if (row.depth === 0 && !outcome.roots.includes(row.component)) {
			outcome.roots.push(row.component);
		}
		if (row.kind === 'exit' && row.status === 'error') {
			outcome.failed = true;
		}
		if (row.kind === 'enter' && row.parent_component) {
			incrementEdge(callees, row.parent_component, row.component);
			incrementEdge(callers, row.component, row.parent_component);
		}
	}
	return {
		sources: ['fixture.jsonl'],
		epochBySource: new Map(),
		enters,
		exits,
		bySymbol,
		byRequest,
		callers,
		callees,
		empty: enters.length + exits.length === 0,
	};
}

function incrementEdge(edges: Map<string, Map<string, number>>, from: string, to: string): void {
	const inner = edges.get(from) ?? new Map<string, number>();
	inner.set(to, (inner.get(to) ?? 0) + 1);
	edges.set(from, inner);
}
