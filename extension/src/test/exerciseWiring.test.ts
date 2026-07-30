import * as assert from 'assert';
import * as fsx from 'fs';
import * as osx from 'os';
import * as pathx from 'path';
import {
	applyStageOutcome,
	decideOnStageFailure,
	initialPipelineLedger,
	planPipelineAction,
	DEFAULT_BUDGETS,
	type ServiceState,
} from '../harness/autoPilotMachine';
import {
	exerciseStateFromArtifacts,
	issueEpisodesFromClusters,
	type ExerciseIssuesDoc,
	type ExerciseProfile,
	isAssertShapedKind,
	isDispatchableKind,
	evidenceFileForKind,
	engineVerdict,
	ASSERT_SUCCESS_CRITERIA,
} from '../harness/exerciseRunner';
import { computeFlowModel, type FlowFacts } from '../views/flowModel';

function svc(over: Partial<ServiceState> = {}): ServiceState {
	return { name: 'api', phase: 'green', setupAttempts: 0, fixEpisodes: {}, ...over };
}

function facts(over: Partial<FlowFacts> = {}): FlowFacts {
	return {
		enginesReady: true,
		discovery: { phase: 'done', label: '' },
		discovered: true,
		services: [{ name: 'api', state: 'running' }],
		sessionCount: 1,
		tracedEndpoints: [],
		reports: [],
		issues: [],
		probes: [],
		pendingEdges: 0,
		autoPilot: { running: false, label: '' },
		configRequests: 0,
		...over,
	};
}

suite('exercise pipeline stage', () => {
	test('exercise runs after probes and before done', () => {
		let ledger = initialPipelineLedger();
		ledger = applyStageOutcome(ledger, 'probes', 'done');
		assert.deepStrictEqual(planPipelineAction(true, [svc()], ledger), { kind: 'exercise' });
		ledger = applyStageOutcome(ledger, 'exercise', 'done');
		assert.deepStrictEqual(planPipelineAction(true, [svc()], ledger), { kind: 'done' });
	});

	test('an exercise failure rides the shared fix-episode budget', () => {
		let ledger = initialPipelineLedger();
		ledger = applyStageOutcome(ledger, 'probes', 'done');
		const { ledger: next, decision } = decideOnStageFailure(ledger, 'exercise', 'sigX', DEFAULT_BUDGETS);
		assert.deepStrictEqual(decision, { next: 'fix' });
		assert.strictEqual(next.exercise, 'pending');
		assert.strictEqual(next.fixEpisodes['sigX'], 1);
	});

	test('a fresh ledger has exercise pending', () => {
		assert.strictEqual(initialPipelineLedger().exercise, 'pending');
	});
});

suite('exercise state derivation (pure)', () => {
	const profile: ExerciseProfile = {
		endpoint_count: 23,
		endpoints_with_coverage: 14,
		total_symbols_covered: 61,
		total_symbols: 120,
		invariants_learned: 41,
		endpoints: [],
	};
	const issues: ExerciseIssuesDoc = {
		cluster_count: 3,
		clusters: [
			{ signature: 'abc123', kind: 'server-error', title: 'POST /items — HTTP 500',
			  endpoint_id: 'POST_items', method: 'POST', path: '/items' },
		],
	};

	test('state reflects the artifacts', () => {
		const s = exerciseStateFromArtifacts(profile, issues, 'done', 'ok');
		assert.strictEqual(s.endpointsCovered, 14);
		assert.strictEqual(s.total, 23);
		assert.strictEqual(s.invariants, 41);
		assert.strictEqual(s.issues, 3);
	});

	test('missing artifacts degrade to zeros, never throw', () => {
		const s = exerciseStateFromArtifacts(null, null, 'skipped', 'no engine');
		assert.strictEqual(s.total, 0);
		assert.strictEqual(s.issues, 0);
	});

	test('clusters become issue episodes with evidence', () => {
		const eps = issueEpisodesFromClusters(issues.clusters);
		assert.strictEqual(eps.length, 1);
		assert.ok(eps[0].title.startsWith('Behavior: '));
		assert.ok(eps[0].detail.includes('abc123'));
		assert.ok(eps[0].detail.includes('POST /items'));
	});

	test('assert-shaped kinds are recognised and phrased as silent violations', () => {
		assert.ok(isAssertShapedKind('invariant-violation'));
		assert.ok(isAssertShapedKind('baseline-degraded'));
		assert.ok(!isAssertShapedKind('server-error'));
		assert.ok(!isAssertShapedKind('crash'));
		const eps = issueEpisodesFromClusters([
			{ signature: 'def456', kind: 'invariant-violation',
			  title: "GET /health — stable_enum violated: 'status' took a value outside its learned set",
			  endpoint_id: 'GET_health', method: 'GET', path: '/health' },
		]);
		assert.ok(eps[0].detail.includes('without raising'));
		assert.ok(eps[0].detail.includes('invariants.json'));
	});

	test('assert-shaped success criteria are value-shaped, not error-shaped', () => {
		assert.ok(ASSERT_SUCCESS_CRITERIA.some((c) => c.includes('golden baseline')));
		assert.ok(ASSERT_SUCCESS_CRITERIA.some((c) => c.includes('does not delete or weaken')));
		assert.ok(!ASSERT_SUCCESS_CRITERIA.some((c) => c.includes('no longer produce these errors')));
	});

	// The five non-HTTP oracles publish into issues.json now, so this path sees
	// kinds it never saw before. Each needs the right evidence file, and the one
	// kind that is not a defect must not be dispatched as one.
	test('every oracle kind points at the artifact that holds its evidence', () => {
		const kinds: Array<[string, string]> = [
			['function-crash', 'function_results.jsonl'],
			['import-error', 'function_results.jsonl'],
			['differential-mismatch', 'differential_results.jsonl'],
			['fault-divergence', 'fault_results.jsonl'],
			['concurrency-divergence', 'concurrency_results.jsonl'],
			['concurrency-hang', 'concurrency_results.jsonl'],
			['server-error', 'results.jsonl'],
		];
		for (const [kind, file] of kinds) {
			assert.strictEqual(
				evidenceFileForKind(kind),
				file,
				`${kind} must point a developer at ${file}`,
			);
			const eps = issueEpisodesFromClusters([
				{ signature: `sig-${kind}`, kind,
				  title: `pkg.m:f — something went wrong`,
				  endpoint_id: 'pkg.m:f', method: 'CALL', path: 'pkg.m:f' },
			]);
			assert.strictEqual(eps.length, 1, `${kind} must dispatch`);
			assert.ok(
				eps[0].detail.includes(file),
				`${kind} detail must name ${file}, got: ${eps[0].detail}`,
			);
		}
	});

	test('signature-drift is reported but never dispatched as a defect', () => {
		// It is an observation about a signature CHANGING, not a claim that
		// anything is broken — there is no failing behaviour for an agent to fix,
		// so dispatching it would spend a whole episode discovering that.
		assert.strictEqual(isDispatchableKind('signature-drift'), false);
		assert.strictEqual(isDispatchableKind('function-crash'), true);
		const eps = issueEpisodesFromClusters([
			{ signature: 'drift1', kind: 'signature-drift',
			  title: 'pkg.m:f — signature changed', endpoint_id: 'pkg.m:f',
			  method: 'CALL', path: 'pkg.m:f' },
			{ signature: 'crash1', kind: 'function-crash',
			  title: 'pkg.m:g — ValueError', endpoint_id: 'pkg.m:g',
			  method: 'CALL', path: 'pkg.m:g' },
		]);
		assert.strictEqual(eps.length, 1, 'only the crash is dispatchable');
		assert.ok(eps[0].detail.includes('pkg.m:g'));
	});

	test('an unknown kind still dispatches, against the default artifact', () => {
		// Failing closed here would mean a future oracle silently surfaces
		// nothing — the exact failure this whole connector exists to end.
		assert.strictEqual(isDispatchableKind('some-future-kind'), true);
		assert.strictEqual(evidenceFileForKind('some-future-kind'), 'results.jsonl');
	});

	test('the non-HTTP oracles describe their location as a callable, not a route', () => {
		const eps = issueEpisodesFromClusters([
			{ signature: 'c1', kind: 'function-crash',
			  title: 'pkg.m:f — PatternError', endpoint_id: 'pkg.m:f',
			  method: 'CALL', path: 'pkg.m:f' },
		]);
		assert.ok(eps[0].detail.includes('CALL pkg.m:f'));
	});
});

suite('exercise facts render into the Verify stage', () => {
	test('behavior-coverage row appears with counts', () => {
		const model = computeFlowModel(
			facts({
				exercise: {
					phase: 'done',
					label: 'done',
					endpointsCovered: 14,
					total: 23,
					invariants: 41,
					issues: 3,
				},
			}),
		);
		// Coverage is the Test stage's SUMMARY now, not a link row: the rail line
		// is what the user reads at a glance, and the links below it are things
		// to click (run it again, open the scorecard).
		const test = model.stages.find((s) => s.id === 'test');
		assert.ok(test);
		assert.ok(test.summary.includes('14/23 endpoints exercised'));
		assert.ok(test.summary.includes('41 invariants'));
		assert.ok(test.summary.includes('3 behavioral issues'));
		assert.strictEqual(test.status, 'error'); // issues > 0
	});

	test('no exercise facts → Test stage reports nothing driven yet', () => {
		const model = computeFlowModel(facts());
		const test = model.stages.find((s) => s.id === 'test');
		assert.ok(test);
		assert.ok(!test.summary.includes('exercised'));
		assert.strictEqual(test.status, 'waiting');
	});
});

/**
 * The reading end of `functions.json`.
 *
 * The engine refuses to call a run clean when it could not import the code —
 * `status: "environment"` plus a diagnostic naming the cause. The CLI prints
 * those loudly; the extension read neither, so in the product a run that never
 * executed the target rendered as "drove the service-free oracles" with zero
 * issues. That is the silent zero the engine-side work exists to remove,
 * reproduced one layer up.
 */
suite('the engine verdict reaches the UI', () => {
	function workspaceWith(doc: unknown | null): string {
		const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'vinv-verdict-'));
		fsx.mkdirSync(pathx.join(root, '.vinv', 'exercise'), { recursive: true });
		if (doc !== null) {
			fsx.writeFileSync(
				pathx.join(root, '.vinv', 'exercise', 'functions.json'),
				JSON.stringify(doc),
				'utf8',
			);
		}
		return root;
	}

	test('an environment failure is stated, not rendered as a clean run', () => {
		const root = workspaceWith({
			status: 'environment',
			diagnostics: ['14/15 module(s) could not be imported by /usr/bin/python3'],
		});
		const verdict = engineVerdict(root, 0);
		assert.match(verdict, /could not be imported/);
		assert.doesNotMatch(verdict, /no issues found/);
	});

	test('an environment failure with no diagnostic still says nothing was exercised', () => {
		const verdict = engineVerdict(workspaceWith({ status: 'environment' }), 0);
		assert.match(verdict, /nothing was exercised/);
	});

	test('a diagnostic on an ok run is surfaced too', () => {
		const root = workspaceWith({
			status: 'ok',
			diagnostics: ['2 environment variable(s) were escalated: VINV_REGION'],
		});
		assert.match(engineVerdict(root, 3), /escalated: VINV_REGION/);
	});

	test('a genuinely clean run says so', () => {
		const verdict = engineVerdict(workspaceWith({ status: 'ok', diagnostics: [] }), 0);
		assert.match(verdict, /no issues found/);
	});

	test('a missing artifact degrades to the plain label rather than throwing', () => {
		assert.strictEqual(typeof engineVerdict(workspaceWith(null), 0), 'string');
	});
});

suite('the verdict describes the run, not the last play', () => {
	function workspace(files: Record<string, unknown>): string {
		const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'vinv-verdict2-'));
		fsx.mkdirSync(pathx.join(root, '.vinv', 'exercise'), { recursive: true });
		for (const [name, doc] of Object.entries(files)) {
			fsx.writeFileSync(
				pathx.join(root, '.vinv', 'exercise', name),
				JSON.stringify(doc),
				'utf8',
			);
		}
		return root;
	}

	test('campaign_result.json wins over functions.json', () => {
		// `functions.json` is rewritten by every crash play with
		// `only_targets=[one]`, so its `status` is computed over a SINGLE module.
		// One unimportable target made the extension announce that the whole run
		// never executed.
		const root = workspace({
			'functions.json': { status: 'environment', diagnostics: ['one target failed to import'] },
			'campaign_result.json': { status: 'ok', diagnostics: [] },
		});
		assert.doesNotMatch(engineVerdict(root, 0), /could not be imported/);
		assert.match(engineVerdict(root, 0), /no issues found/);
	});

	test('and states the campaign-level environment failure when there is one', () => {
		const root = workspace({
			'functions.json': { status: 'ok', diagnostics: [] },
			'campaign_result.json': {
				status: 'environment',
				diagnostics: ['4/4 plays could not import the repo\'s own package(s) acme_core'],
			},
		});
		assert.match(engineVerdict(root, 0), /could not import the repo/);
	});

	test('functions.json is still the fallback for a direct `exerciser functions` run', () => {
		const root = workspace({
			'functions.json': { status: 'environment', diagnostics: ['nothing imported'] },
		});
		assert.match(engineVerdict(root, 0), /nothing imported/);
	});
});
