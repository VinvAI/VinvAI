/**
 * The extension half of the end-to-end contract, driven over REAL artifact shapes.
 *
 * `exerciser/tests/test_integration_end_to_end.py` runs the engine and asserts
 * that what it writes carries the fields this side reads. This is the other end
 * of that handshake: it lays down artifacts in the exact shape the engine
 * produces and drives the extension's readers over them — the scheduler, the
 * verdict, the dispatch selection, the agent-channel drain and the config panel
 * — so a stage that stopped consuming its input fails here rather than in
 * production.
 *
 * Why it is written this way: this branch hit the same defect five times, a
 * producer whose output nothing consumes, with BOTH ends reporting success.
 * Neither a writer-side test nor a reader-side test catches that; only a test
 * that fixes the shape once and runs both sides against it does.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	applyStageOutcome,
	initialPipelineLedger,
	planPipelineAction,
	settleUnreachableStages,
	type ServiceState,
} from '../harness/autoPilotMachine';
import {
	engineVerdict,
	exerciseStateFromArtifacts,
	isAssertShapedKind,
	isDispatchableKind,
	issueEpisodesFromClusters,
	type ExerciseIssuesDoc,
} from '../harness/exerciseRunner';
import {
	applyAnswers,
	buildPrompt,
	drainAgentChannels,
	parseAnswers,
	pendingQuestions,
	readChannels,
} from '../harness/agentChannel';
import {
	buildAnswers,
	buildModel,
	configAnswersPath,
	getConfigPanelHtml,
	handlePanelMessage,
	readConfigRequests,
	writeAnswers,
	type ConfigPanelActions,
} from '../views/configRequestPanel';

// =========================================================================
// A workspace holding exactly what the engine writes
// =========================================================================

/** Artifacts in the shape `exerciser` produces them, keyed by filename. */
function workspace(files: Record<string, unknown>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-'));
	fs.mkdirSync(path.join(root, '.vinv', 'exercise'), { recursive: true });
	for (const [name, doc] of Object.entries(files)) {
		fs.writeFileSync(
			path.join(root, '.vinv', 'exercise', name),
			JSON.stringify(doc, null, 2),
			'utf8',
		);
	}
	return root;
}

/** A cluster exactly as `issues.build_clusters` emits one. */
function cluster(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		signature: 'a1b2c3d4e5f6',
		kind: 'function-crash',
		title: 'demo.pure:divide — ZeroDivisionError: division by zero',
		endpoint_id: 'demo.pure:divide',
		method: 'CALL',
		path: 'demo.pure:divide',
		exemplar: { strategy: 'function/boundary', error: 'division by zero' },
		...over,
	};
}

/**
 * An `issues.json` exactly as `issues.publish` writes one.
 *
 * It carries `cluster_count` AND `clusters`, and the extension reads the first.
 * Building the fixture by hand with only `clusters` is how a reader-side test
 * passes against a document the writer never produced — so this is the one
 * place the shape is written down.
 */
function issuesDoc(clusters: Record<string, unknown>[]): Record<string, unknown> {
	return {
		source: 'exerciser',
		generated_at: '2026-07-28T00:00:00Z',
		ingested_by: 'campaign',
		cluster_count: clusters.length,
		clusters,
	};
}

/** A campaign summary as `run_campaign` persists it. */
function campaignResult(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		status: 'ok',
		own_packages_unimportable: [],
		diagnostics: [],
		interpreter: { python: '/usr/bin/python3', handed_off: false, target_installed: true },
		repo: '/repo',
		actions: 12,
		plays_run: 8,
		inconclusive_plays: 0,
		issues_merged: 1,
		violations: 1,
		stopped: 'budget-exhausted',
		...over,
	};
}

// =========================================================================
// Stage 1 — the scheduler reaches the oracles on a library workspace
// =========================================================================

function svc(over: Partial<ServiceState> = {}): ServiceState {
	return { name: 'api', phase: 'green', setupAttempts: 0, fixEpisodes: {}, ...over };
}

suite('end to end: a workspace with nothing to serve still gets exercised', () => {
	test('discovery → exercise → done, with the live-session stages settled', () => {
		const libraries = [svc({ phase: 'library' }), svc({ name: 'b', phase: 'gave-up' })];
		let ledger = settleUnreachableStages(libraries, initialPipelineLedger());

		// probes reads a traced session; there is none, so it is DECIDED rather
		// than left looking like outstanding work.
		assert.strictEqual(ledger.probes, 'skipped');

		// The one stage that needs no port is the one that runs.
		assert.deepStrictEqual(planPipelineAction(true, libraries, ledger), { kind: 'exercise' });
		ledger = applyStageOutcome(ledger, 'exercise', 'done');
		assert.deepStrictEqual(planPipelineAction(true, libraries, ledger), { kind: 'done' });
	});

	test('a green service still drains probes first', () => {
		const green = [svc({ phase: 'green' })];
		const ledger = settleUnreachableStages(green, initialPipelineLedger());
		assert.deepStrictEqual(planPipelineAction(true, green, ledger), { kind: 'probes' });
	});
});

// =========================================================================
// Stage 2 — the verdict describes the run
// =========================================================================

suite('end to end: what the run concluded reaches the surface', () => {
	test('a clean campaign reads as clean', () => {
		const root = workspace({
			'campaign_result.json': campaignResult(),
			'issues.json': issuesDoc([]),
		});
		assert.match(engineVerdict(root, 0), /no issues found/);
	});

	test('an environment failure is never rendered as a clean run', () => {
		const root = workspace({
			'campaign_result.json': campaignResult({
				status: 'environment',
				own_packages_unimportable: ['demo'],
				diagnostics: ["8/8 plays could not import the repo's own package(s) demo"],
			}),
			'issues.json': { clusters: [] },
		});
		const verdict = engineVerdict(root, 0);
		assert.match(verdict, /could not import/);
		assert.doesNotMatch(verdict, /no issues found/);
	});

	test('the RUN outranks the last play', () => {
		// `functions.json` is rewritten by every crash play with a single target,
		// so its status describes one arm. Reading it as the run's verdict was the
		// bug; `campaign_result.json` is the run.
		const root = workspace({
			'functions.json': { status: 'environment', diagnostics: ['one target failed'] },
			'campaign_result.json': campaignResult(),
			'issues.json': issuesDoc([]),
		});
		assert.doesNotMatch(engineVerdict(root, 0), /one target failed/);
	});

	test('a direct `exerciser functions` run still has a verdict', () => {
		const root = workspace({
			'functions.json': { status: 'environment', diagnostics: ['nothing imported'] },
		});
		assert.match(engineVerdict(root, 0), /nothing imported/);
	});

	test('the state the UI renders is built from the same artifacts', () => {
		const root = workspace({ 'issues.json': issuesDoc([cluster()]) });
		const issues = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'exercise', 'issues.json'), 'utf8'),
		) as ExerciseIssuesDoc;
		// The reader takes `cluster_count`, so the writer has to emit it — asserted
		// here rather than assumed, because a fixture carrying only `clusters`
		// passes a reader test while the real document would not.
		assert.strictEqual(issues.cluster_count, 1);
		assert.strictEqual(issues.clusters.length, 1);
		const state = exerciseStateFromArtifacts(null, issues, 'done', engineVerdict(root, 1));
		assert.strictEqual(state.issues, 1);
		assert.strictEqual(state.phase, 'done');
	});
});

// =========================================================================
// Stage 3 — findings reach the dispatch path
// =========================================================================

suite('end to end: a finding becomes an episode', () => {
	test('an engine cluster is dispatchable and becomes an episode', () => {
		const c = cluster();
		assert.ok(isDispatchableKind(String(c.kind)), 'a crash cluster must dispatch');
		const episodes = issueEpisodesFromClusters([c as never]);
		assert.strictEqual(episodes.length, 1);
		assert.ok(
			JSON.stringify(episodes[0]).includes('demo.pure:divide'),
			'the episode must name the target the engine found',
		);
	});

	test('error-shaped and assert-shaped clusters are separated', () => {
		const crash = cluster();
		const violation = cluster({ kind: 'invariant-violation', signature: 'ffff0000' });
		assert.strictEqual(isAssertShapedKind(String(crash.kind)), false);
		assert.strictEqual(isAssertShapedKind(String(violation.kind)), true);
	});
});

// =========================================================================
// Stage 4 — the agent channel round trip
// =========================================================================

/** A channel file exactly as `agent_loop.AgentChannel.save` writes one. */
function channelDoc(topic: string, key: string, subject: string): Record<string, unknown> {
	return {
		version: 1,
		topic,
		questions: {
			[key]: {
				key,
				topic,
				subject,
				prompt: `Give a value for \`${subject}\`.`,
				reply_schema: '{"value": "<string>"|null, "is_secret": true|false}',
				context: { variable: subject, modules: ['demo.settings'], tried: ['vinv'] },
				answer: null,
			},
		},
	};
}

suite('end to end: the engine asks and the harness answers', () => {
	test('pending questions across topics go out in ONE prompt and come back', async () => {
		const root = workspace({
			'agent_config.json': channelDoc('config', 'config:DEMO_REGION', 'DEMO_REGION'),
			'agent_contract.json': channelDoc('contract', 'contract:demo.x:fn', 'demo.x:fn'),
		});

		const pending = pendingQuestions(readChannels(root));
		assert.strictEqual(pending.length, 2, 'both topics are pending');

		const prompts: string[] = [];
		const report = await drainAgentChannels(root, async (_name, prompt) => {
			prompts.push(prompt);
			return {
				ok: true,
				stdout:
					'Here you go:\n```json\n' +
					JSON.stringify({
						answers: {
							'config:DEMO_REGION': { value: 'eu-west-1', is_secret: false },
							'contract:demo.x:fn': { contract: { n: 'int' }, baseline: { n: 3 } },
						},
					}) +
					'\n```',
			};
		});

		assert.strictEqual(prompts.length, 1, 'one run per drain, not one per question');
		assert.ok(prompts[0].includes('DEMO_REGION') && prompts[0].includes('demo.x:fn'));
		assert.strictEqual(report.answered, 2);
		assert.deepStrictEqual(report.topics, ['config', 'contract']);

		// Written back where the ENGINE reads them.
		const doc = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'exercise', 'agent_config.json'), 'utf8'),
		) as { questions: Record<string, { answer: unknown }> };
		assert.deepStrictEqual(doc.questions['config:DEMO_REGION'].answer, {
			value: 'eu-west-1',
			is_secret: false,
		});
		assert.strictEqual(pendingQuestions(readChannels(root)).length, 0);
	});

	test('an existing answer is never overwritten', async () => {
		const root = workspace({
			'agent_config.json': channelDoc('config', 'config:A', 'A'),
		});
		applyAnswers(readChannels(root), { 'config:A': { value: 'human-corrected' } });

		await drainAgentChannels(root, async () => ({
			ok: true,
			stdout: JSON.stringify({ answers: { 'config:A': { value: 'model-guess' } } }),
		}));

		const doc = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'exercise', 'agent_config.json'), 'utf8'),
		) as { questions: Record<string, { answer: { value: string } }> };
		assert.strictEqual(doc.questions['config:A'].answer.value, 'human-corrected');
	});

	test('a failed harness leaves the queue pending and says why', async () => {
		const root = workspace({ 'agent_config.json': channelDoc('config', 'config:A', 'A') });
		const report = await drainAgentChannels(root, async () => ({
			ok: false,
			stdout: '',
			detail: 'not signed in',
		}));
		assert.strictEqual(report.answered, 0);
		assert.strictEqual(report.ok, false);
		assert.match(report.detail, /not signed in/);
		assert.strictEqual(pendingQuestions(readChannels(root)).length, 1);
	});

	test('an unparseable reply is not a fabricated answer', async () => {
		const root = workspace({ 'agent_config.json': channelDoc('config', 'config:A', 'A') });
		const report = await drainAgentChannels(root, async () => ({
			ok: true,
			stdout: 'I am not going to answer that.',
		}));
		assert.strictEqual(report.answered, 0);
		assert.strictEqual(pendingQuestions(readChannels(root)).length, 1);
	});

	test('the prompt never instructs the model to invent a credential', () => {
		const questions = pendingQuestions(
			readChannels(workspace({ 'agent_config.json': channelDoc('config', 'c:K', 'API_KEY') })),
		);
		assert.match(buildPrompt(questions), /Never invent a credential/);
	});

	test('a reply wrapped in prose still parses', () => {
		assert.deepStrictEqual(parseAnswers('blah {"answers": {"a": 1}} trailing'), { a: 1 });
		assert.deepStrictEqual(parseAnswers('nothing here'), {});
	});
});

// =========================================================================
// Stage 5 — the last rung: a human
// =========================================================================

suite('end to end: what nothing could synthesise reaches a person', () => {
	const requestsDoc = {
		version: 1,
		repo: '/repo',
		requests: [
			{
				variable: 'DEMO_REGION',
				secret: false,
				description: 'Which region the client talks to.',
				example: 'eu-west-1',
				blocked_modules: ['demo.settings'],
				blocked_count: 1,
				tried: ['vinv'],
				reason: 'ValidationError: DEMO_REGION field required',
				status: 'awaiting-user',
			},
			{
				variable: 'OPENAI_API_KEY',
				secret: true,
				description: 'Provider credential.',
				example: null,
				blocked_modules: ['demo.llm'],
				blocked_count: 1,
				tried: [],
				reason: 'KeyError: OPENAI_API_KEY',
				status: 'awaiting-user',
			},
		],
	};

	test('the engine question renders, and answering it writes where the engine reads', async () => {
		const root = workspace({ 'config_requests.json': requestsDoc });
		const requests = readConfigRequests(root);
		assert.deepStrictEqual(
			requests.map((r) => r.variable),
			['DEMO_REGION', 'OPENAI_API_KEY'],
		);

		const html = getConfigPanelHtml('vscode-resource:', buildModel(root));
		assert.ok(html.includes('DEMO_REGION'));
		assert.ok(html.includes('type="password"'), 'a secret must not render as plain text');
		assert.ok(html.includes('nonce-'), 'scripts run under a nonce, not unsafe-inline');

		let reran = 0;
		const errors: string[] = [];
		const actions: ConfigPanelActions = {
			save: (answers) => writeAnswers(root, answers),
			rerun: async () => {
				reran += 1;
			},
			showError: (message) => errors.push(message),
		};
		const outcome = await handlePanelMessage(
			{ type: 'submit', values: { DEMO_REGION: 'eu-west-1', OPENAI_API_KEY: 'sk-typed' } },
			requests,
			actions,
		);
		assert.strictEqual(outcome.saved, 2);
		assert.strictEqual(reran, 1, 'answering has to take effect');
		assert.deepStrictEqual(errors, [], 'a clean save reports nothing');

		const answers = JSON.parse(fs.readFileSync(configAnswersPath(root), 'utf8')) as {
			answers: Record<string, string>;
		};
		assert.deepStrictEqual(answers.answers, {
			DEMO_REGION: 'eu-west-1',
			OPENAI_API_KEY: 'sk-typed',
		});
	});

	test('the question file never carries the answer', () => {
		const root = workspace({ 'config_requests.json': requestsDoc });
		writeAnswers(root, { OPENAI_API_KEY: 'sk-typed-secret' });
		const questions = fs.readFileSync(
			path.join(root, '.vinv', 'exercise', 'config_requests.json'),
			'utf8',
		);
		assert.ok(!questions.includes('sk-typed-secret'), 'the credential is in the QUESTION file');
	});

	test('a blank field is not a value', () => {
		const root = workspace({ 'config_requests.json': requestsDoc });
		assert.deepStrictEqual(buildAnswers(readConfigRequests(root), { DEMO_REGION: '   ' }), {});
	});

	test('an answer to something nobody asked for is dropped', () => {
		const root = workspace({ 'config_requests.json': requestsDoc });
		assert.deepStrictEqual(
			buildAnswers(readConfigRequests(root), { NOT_ASKED: 'x', DEMO_REGION: 'ok' }),
			{ DEMO_REGION: 'ok' },
		);
	});

	test('the target repo\'s own error text cannot become markup', () => {
		const root = workspace({
			'config_requests.json': {
				version: 1,
				requests: [
					{
						variable: 'X',
						secret: false,
						description: '<img src=x onerror=alert(1)>',
						blocked_modules: [],
						blocked_count: 0,
						tried: [],
						reason: '</pre><script>alert(2)</script>',
						status: 'awaiting-user',
					},
				],
			},
		});
		const html = getConfigPanelHtml('vscode-resource:', buildModel(root));
		assert.ok(!html.includes('<img src=x'), 'a description became markup');
		assert.ok(!html.includes('<script>alert(2)'), "the repo's error text became markup");
		assert.ok(html.includes('&lt;script&gt;'), 'and it is still shown, escaped');
	});

	test('nothing being asked renders as nothing being asked', () => {
		const root = workspace({ 'config_requests.json': { version: 1, requests: [] } });
		const html = getConfigPanelHtml('vscode-resource:', buildModel(root));
		assert.ok(html.includes('Nothing to configure'));
	});
});
