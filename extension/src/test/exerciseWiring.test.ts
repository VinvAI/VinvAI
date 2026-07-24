import * as assert from 'assert';
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
		...over,
	};
}

suite('exercise pipeline stage', () => {
	test('exercise runs after probes and before done', () => {
		let ledger = initialPipelineLedger();
		ledger = applyStageOutcome(ledger, 'insights', 'done');
		ledger = applyStageOutcome(ledger, 'probes', 'done');
		assert.deepStrictEqual(planPipelineAction(true, [svc()], ledger), { kind: 'exercise' });
		ledger = applyStageOutcome(ledger, 'exercise', 'done');
		assert.deepStrictEqual(planPipelineAction(true, [svc()], ledger), { kind: 'done' });
	});

	test('an exercise failure rides the shared fix-episode budget', () => {
		let ledger = initialPipelineLedger();
		ledger = applyStageOutcome(ledger, 'insights', 'done');
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
		const verify = model.stages.find((s) => s.id === 'verify');
		assert.ok(verify);
		const row = verify.links.find((l) => l.label.includes('Behavior coverage'));
		assert.ok(row, 'a behavior-coverage row should be present');
		assert.ok(row.label.includes('14/23 endpoints'));
		assert.ok(row.label.includes('41 invariants'));
		assert.strictEqual(row.state, 'error'); // issues > 0
	});

	test('no exercise facts → no behavior row (unchanged rail)', () => {
		const model = computeFlowModel(facts());
		const verify = model.stages.find((s) => s.id === 'verify');
		assert.ok(verify);
		assert.ok(!verify.links.some((l) => l.label.includes('Behavior coverage')));
	});
});
