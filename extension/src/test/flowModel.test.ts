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
	test('the rail is always the same five stages in flow order', () => {
		const model = computeFlowModel(facts());
		assert.deepStrictEqual(
			model.stages.map((s) => s.id),
			['discover', 'services', 'traces', 'insights', 'verify'],
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

	test('traces stage: live while something runs, done once captured', () => {
		const live = computeFlowModel(
			facts({ discovered: true, services: [{ name: 'api', state: 'running' }] }),
		);
		assert.strictEqual(stage(live, 'traces').status, 'running');

		const captured = computeFlowModel(facts({ discovered: true, sessionCount: 2 }));
		const t = stage(captured, 'traces');
		assert.strictEqual(t.status, 'done');
		assert.ok(t.summary.includes('2'));
		assert.ok(t.links.some((l) => l.command === 'vinv.sessions.focus'));
	});

	test('busiest traced endpoints open their call tree directly', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				tracedEndpoints: [
					{ apiId: 'get-health', label: 'GET /health', traceCount: 9 },
					{ apiId: 'never-hit', label: 'GET /unused', traceCount: 0 },
				],
			}),
		);
		const links = stage(model, 'traces').links;
		const ep = links.find((l) => l.label === 'GET /health');
		assert.strictEqual(ep?.command, 'vinv-vs.openCallTree');
		assert.deepStrictEqual(ep?.args, [{ apiId: 'get-health', label: 'GET /health' }]);
		assert.ok(!links.some((l) => l.label === 'GET /unused'), 'never-hit endpoints stay out');
	});

	test('insights stage lists every report with a plain-language label', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				reports: [
					{ kind: 'calltree', label: 'GET /health', path: '/w/.vinv/reports/calltree-a.json' },
					{ kind: 'smoke', label: 'GET /health', path: '/w/.vinv/reports/smoke-a.html' },
				],
			}),
		);
		const i = stage(model, 'insights');
		assert.strictEqual(i.status, 'done');
		assert.strictEqual(i.links[0].label, 'Where time went — GET /health');
		assert.strictEqual(i.links[1].label, 'Health report — GET /health');
		assert.strictEqual(i.links[1].openPath, '/w/.vinv/reports/smoke-a.html');
	});

	test('verify stage prefers probe results, else derives from issues', () => {
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
		const v = stage(probes, 'verify');
		assert.strictEqual(v.status, 'error');
		assert.strictEqual(v.summary, '1/2 checks passing');

		const clean = computeFlowModel(facts({ discovered: true, sessionCount: 1 }));
		assert.strictEqual(stage(clean, 'verify').status, 'done');

		const broken = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				issues: [{ id: 'runtime:a', title: 'load_cart is failing in live runs' }],
			}),
		);
		assert.strictEqual(stage(broken, 'verify').status, 'error');
	});
});

suite('flowModel: pipeline hub overlays', () => {
	test('a running insight build pulses the Insights stage with its label', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				insight: { phase: 'running', label: 'building call tree for GET /orders (2/5)…' },
			}),
		);
		const i = stage(model, 'insights');
		assert.strictEqual(i.status, 'running');
		assert.strictEqual(i.summary, 'building call tree for GET /orders (2/5)…');
	});

	test('a failed insight build is an error with the failure detail', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				insight: { phase: 'failed', label: '', error: 'identification binary missing' },
			}),
		);
		const i = stage(model, 'insights');
		assert.strictEqual(i.status, 'error');
		assert.strictEqual(i.summary, 'identification binary missing');
	});

	test('stale reports say the code changed and stop claiming freshness', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				reports: [
					{ kind: 'calltree', label: 'GET /a', path: '/w/a.json', stale: true },
					{ kind: 'calltree', label: 'GET /b', path: '/w/b.json' },
				],
			}),
		);
		const links = stage(model, 'insights').links;
		assert.ok(links[0].detail?.includes('code changed since'));
		assert.strictEqual(links[0].state, 'muted');
		assert.strictEqual(links[1].state, 'ok');
	});

	test('a running probe pass pulses Verify with its label', () => {
		const model = computeFlowModel(
			facts({
				discovered: true,
				sessionCount: 1,
				probe: { phase: 'running', label: 'probing api (3/9)…' },
			}),
		);
		const v = stage(model, 'verify');
		assert.strictEqual(v.status, 'running');
		assert.strictEqual(v.summary, 'probing api (3/9)…');
	});

	test('the coarse pipeline phase maps onto rail stages', () => {
		assert.strictEqual(pipelineStage('discovering'), 'discover');
		assert.strictEqual(pipelineStage('services'), 'services');
		assert.strictEqual(pipelineStage('insights'), 'insights');
		assert.strictEqual(pipelineStage('probes'), 'verify');
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
				pipelinePhase: 'insights',
			}),
		);
		assert.strictEqual(stage(model, 'insights').status, 'running');
		assert.ok(stage(model, 'insights').activity?.includes('Auto-Pilot'));
		assert.notStrictEqual(stage(model, 'services').status, 'running');
	});
});

suite('flowModel: Auto-Pilot spine', () => {
	test('live labels map onto rail stages', () => {
		assert.strictEqual(autoPilotStage('Discovering the project…'), 'discover');
		assert.strictEqual(autoPilotStage('Setting up api (attempt 1/2)…'), 'services');
		assert.strictEqual(autoPilotStage('Starting api under tracing…'), 'traces');
		assert.strictEqual(autoPilotStage('Verifying api serves (replaying its start command)…'), 'verify');
		assert.strictEqual(autoPilotStage('Dispatching a fix episode for api…'), 'verify');
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
		assert.strictEqual(json.stages.length, 5);
		assert.strictEqual(json.stages[0].id, 'discover');
		assert.ok(json.stages[0].items.some((i) => i.path === '/w/.vinv/vinv.md'));
		assert.strictEqual(json.issues[0].evidence, '/w/a.py:3');
		assert.strictEqual(json.next_action?.command, 'vinv-vs.fixWithHarness');
	});
});
