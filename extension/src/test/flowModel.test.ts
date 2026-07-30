import * as assert from 'assert';
import {
	autoPilotStage,
	computeFlowModel,
	flowStateJson,
	pipelineStage,
	type FlowFacts,
	type FlowModel,
} from '../views/flowModel';

/** Baseline facts: engines installed, nothing else has happened yet. */
function facts(overrides: Partial<FlowFacts> = {}): FlowFacts {
	return {
		enginesReady: true,
		discovery: { phase: 'idle', label: '' },
		discovered: false,
		services: [],
		sessionCount: 0,
		tracedEndpoints: [],
		reports: [],
		issues: [],
		probes: [],
		pendingEdges: 0,
		autoPilot: { running: false, label: '' },
		...overrides,
	};
}

function stage(model: FlowModel, id: string) {
	const s = model.stages.find((x) => x.id === id);
	assert.ok(s, `stage ${id} exists`);
	return s;
}

suite('flowModel: rail stages', () => {
	test('the rail is always the same four stages in flow order', () => {
		const model = computeFlowModel(facts());
		assert.deepStrictEqual(
			model.stages.map((s) => s.id),
			['discover', 'services', 'test', 'findings'],
		);
	});

	test('a fresh workspace waits everywhere and downstream stages say why', () => {
		const model = computeFlowModel(facts());
		for (const s of model.stages) {
			assert.strictEqual(s.status, 'waiting', `${s.id} waits`);
		}
		assert.ok(stage(model, 'services').summary.length > 0);
	});

	test('missing engines are named as the blocker on Discover', () => {
		const model = computeFlowModel(facts({ enginesReady: false }));
		assert.ok(stage(model, 'discover').summary.toLowerCase().includes('engines'));
	});

	test('running discovery pulses with its live label', () => {
		const model = computeFlowModel(
			facts({ discovery: { phase: 'running', label: 'Indexing — 40%' } }),
		);
		const d = stage(model, 'discover');
		assert.strictEqual(d.status, 'running');
		assert.strictEqual(d.summary, 'Indexing — 40%');
	});

	test('failed discovery is an error with a retry link', () => {
		const model = computeFlowModel(
			facts({ discovery: { phase: 'failed', label: 'Discovery failed' } }),
		);
		const d = stage(model, 'discover');
		assert.strictEqual(d.status, 'error');
		assert.strictEqual(d.links[0].command, 'vinv-vs.rediscover');
	});

	test('a discovered project exposes the handbook and code map, one click each', () => {
		const model = computeFlowModel(
			facts({ discovered: true, handbookPath: '/w/.vinv/vinv.md' }),
		);
		const d = stage(model, 'discover');
		assert.strictEqual(d.status, 'done');
		const handbook = d.links.find((l) => l.label === 'Project handbook');
		assert.strictEqual(handbook?.openPath, '/w/.vinv/vinv.md');
		assert.strictEqual(handbook?.markdownPreview, true);
		assert.ok(d.links.some((l) => l.command === 'vinv-vs.openGraphExplorer'));
	});

	test('services stage tracks set-up progress and treats libraries honestly', () => {
		const done = computeFlowModel(
			facts({
				discovered: true,
				services: [
					{ name: 'api', state: 'ready', startCommandPath: '/w/.vinv/start_commands/api.json' },
					{ name: 'worker', state: 'running' },
					{ name: 'shared', state: 'library' },
				],
			}),
		);
		const s = stage(done, 'services');
		assert.strictEqual(s.status, 'done');
		// The verified start command is one click away ("how each service starts").
		assert.strictEqual(
			s.links.find((l) => l.label === 'api')?.openPath,
			'/w/.vinv/start_commands/api.json',
		);

		const failed = computeFlowModel(
			facts({
				discovered: true,
				services: [{ name: 'api', state: 'failed', detail: 'port already in use' }],
			}),
		);
		const f = stage(failed, 'services');
		assert.strictEqual(f.status, 'error');
		// A failed service's row offers set-up again via the existing command.
		assert.strictEqual(f.links[0].command, 'vinv-vs.serviceSetup');
		assert.deepStrictEqual(f.links[0].args, ['api']);
	});

	test('test stage offers the trigger once a service can be driven', () => {
		const idle = computeFlowModel(facts({ discovered: true }));
		const t0 = stage(idle, 'test');
		assert.strictEqual(t0.status, 'waiting');
		assert.ok(!t0.links.some((l) => l.command === 'vinv-vs.runExercise'));

		const ready = computeFlowModel(
			facts({ discovered: true, services: [{ name: 'api', state: 'running' }] }),
		);
		const t1 = stage(ready, 'test');
		assert.strictEqual(t1.links[0].command, 'vinv-vs.runExercise');
		assert.strictEqual(t1.links[0].label, 'Test it');
	});

	test('test stage reports coverage and offers a re-run once a pass has landed', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				services: [{ name: 'api', state: 'running' }],
				exercise: {
					phase: 'done',
					label: '',
					endpointsCovered: 9,
					total: 9,
					invariants: 4,
					issues: 0,
					scorecardPath: '/w/.vinv/exercise/scorecard.json',
				},
			}),
		);
		const t = stage(model, 'test');
		assert.strictEqual(t.status, 'done');
		assert.ok(t.summary.includes('9/9 endpoints exercised'));
		assert.strictEqual(t.links[0].label, 'Test again');
		assert.ok(t.links.some((l) => l.openPath === '/w/.vinv/exercise/scorecard.json'));
	});

	test('test stage falls back to probe results when no exercise has run', () => {
		const probes = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				probes: [
					{ label: 'api · GET /health', passed: true },
					{ label: 'api · POST /orders', passed: false, detail: '500 on empty cart' },
				],
			}),
		);
		const t = stage(probes, 'test');
		assert.strictEqual(t.status, 'error');
		assert.strictEqual(t.summary, '1/2 checks passing');
	});

	test('findings stage groups by service and opens the view filtered', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				issues: [
					{ id: 'a', title: 'load_cart is failing', service: 'api' },
					{ id: 'b', title: 'timeout in checkout', service: 'api' },
					{ id: 'c', title: 'orphan capture' },
				],
			}),
		);
		const f = stage(model, 'findings');
		assert.strictEqual(f.status, 'error');
		assert.ok(f.summary.includes('3 findings'));
		const api = f.links.find((l) => l.label === 'api');
		assert.strictEqual(api?.command, 'vinv-vs.openFindings');
		assert.deepStrictEqual(api?.args, [{ service: 'api' }]);
		assert.ok(api?.detail?.includes('2 findings'));
		// An unattributed finding must not filter on the empty string.
		const loose = f.links.find((l) => l.label === 'Workspace');
		assert.deepStrictEqual(loose?.args, [{ service: undefined }]);
	});

	test('findings stage is clean once something ran without problems', () => {
		const clean = computeFlowModel(facts({ discovered: true, sessionCount: 1 }));
		const f = stage(clean, 'findings');
		assert.strictEqual(f.status, 'done');
		assert.strictEqual(f.links[0].command, 'vinv-vs.openFindings');
	});
});

suite('flowModel: pipeline hub overlays', () => {
	// Insights lost its stage — pipelineRunners rebuilds reports in the
	// background whenever new spans land, so it is not a step anyone waits on
	// and it must not claim the rail's pulsing slot.
	test('an insight build does not claim a rail stage', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				insight: { phase: 'running', label: 'building call tree for GET /orders (2/5)…' },
			}),
		);
		assert.deepStrictEqual(
			model.stages.map((s) => s.id),
			['discover', 'services', 'test', 'findings'],
		);
		assert.ok(!model.stages.some((s) => s.summary.includes('building call tree')));
	});

	test('a running probe pass pulses Test with its label', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				probe: { phase: 'running', label: 'probing api (3/9)…' },
			}),
		);
		const t = stage(model, 'test');
		assert.strictEqual(t.status, 'running');
		assert.strictEqual(t.summary, 'probing api (3/9)…');
	});

	test('the coarse pipeline phase maps onto rail stages', () => {
		assert.strictEqual(pipelineStage('discovering'), 'discover');
		assert.strictEqual(pipelineStage('services'), 'services');
		assert.strictEqual(pipelineStage('insights'), undefined);
		assert.strictEqual(pipelineStage('probes'), 'test');
		assert.strictEqual(pipelineStage('exercise'), 'test');
		assert.strictEqual(pipelineStage('idle'), undefined);
		assert.strictEqual(pipelineStage('done'), undefined);
		assert.strictEqual(pipelineStage(undefined), undefined);
	});

	test('the hub phase outranks the step label for the spine', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				autoPilot: { running: true, label: 'Setting up api (attempt 1/2)…' },
				pipelinePhase: 'exercise',
			}),
		);
		assert.strictEqual(stage(model, 'test').status, 'running');
		assert.ok(stage(model, 'test').activity?.includes('Auto-Pilot'));
		assert.notStrictEqual(stage(model, 'services').status, 'running');
	});
});

suite('flowModel: Auto-Pilot spine', () => {
	test('live labels map onto rail stages', () => {
		assert.strictEqual(autoPilotStage('Discovering the project…'), 'discover');
		assert.strictEqual(autoPilotStage('Setting up api (attempt 1/2)…'), 'services');
		assert.strictEqual(autoPilotStage('Starting api under tracing…'), 'services');
		assert.strictEqual(autoPilotStage('Verifying api serves (replaying its start command)…'), 'test');
		assert.strictEqual(autoPilotStage('Dispatching a fix episode for api…'), 'findings');
		assert.strictEqual(autoPilotStage(''), undefined);
	});

	test('the active stage pulses with the live label and no next action shows', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				services: [{ name: 'api', state: 'unattempted' }],
				autoPilot: { running: true, label: 'Setting up api (attempt 1/2)…' },
				nextStep: { label: 'x', detail: 'y', command: 'z' },
			}),
		);
		const s = stage(model, 'services');
		assert.strictEqual(s.status, 'running');
		assert.strictEqual(s.activity, 'Auto-Pilot: Setting up api (attempt 1/2)…');
		assert.strictEqual(model.nextAction, undefined, 'no human action while Auto-Pilot drives');
	});

	test('with Auto-Pilot off, the compass answer becomes the single next action', () => {
		const model = computeFlowModel(
			facts({
				nextStep: {
					label: 'Discover this project',
					detail: 'Builds the code graph and the handbook.',
					command: 'vinv-vs.indexProject',
				},
			}),
		);
		assert.strictEqual(model.nextAction?.label, 'Discover this project');
		assert.strictEqual(model.nextAction?.command, 'vinv-vs.indexProject');
	});
});

suite('flowModel: issues + agent mirror', () => {
	test('issues carry ready-to-fire fixWithHarness arguments', () => {
		const model = computeFlowModel(
			facts({
				issues: [
					{
						id: 'runtime:app/cart.py:load_cart',
						title: 'load_cart is failing in live runs',
						detail: 'load_cart at app/cart.py:12 — 3 error(s): KeyError',
						evidencePath: '/w/app/cart.py',
						evidenceLine: 12,
						row: 7,
					},
				],
			}),
		);
		assert.strictEqual(model.issues.length, 1);
		const fix = model.issues[0].fixArgs;
		assert.ok(fix.issue.startsWith('load_cart is failing in live runs'));
		assert.ok(fix.issue.includes('KeyError'), 'evidence rides along');
		assert.strictEqual(fix.row, 7);
	});

	test('flow_state.json is plain, stable JSON an agent can read', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				handbookPath: '/w/.vinv/vinv.md',
				sessionCount: 1,
				issues: [{ id: 'i1', title: 'broken', evidencePath: '/w/a.py', evidenceLine: 3 }],
				nextStep: { label: 'Fix it', detail: 'because', command: 'vinv-vs.fixWithHarness' },
			}),
		);
		const json = JSON.parse(JSON.stringify(flowStateJson(model, '2026-07-23T00:00:00Z'))) as {
			updated_at: string;
			stages: { id: string; status: string; items: { path: string | null }[] }[];
			issues: { evidence: string | null }[];
			next_action: { command: string } | null;
		};
		assert.strictEqual(json.updated_at, '2026-07-23T00:00:00Z');
		assert.strictEqual(json.stages.length, 4);
		assert.strictEqual(json.stages[0].id, 'discover');
		assert.ok(json.stages[0].items.some((i) => i.path === '/w/.vinv/vinv.md'));
		assert.strictEqual(json.issues[0].evidence, '/w/a.py:3');
		assert.strictEqual(json.next_action?.command, 'vinv-vs.fixWithHarness');
	});
});
