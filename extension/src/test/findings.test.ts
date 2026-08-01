/**
 * Findings view: assembly of the USP surface (issues, episodes with CIs,
 * regress kinds, latency profile, state ledger) and the machine summary.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildFindings, buildServiceIndex, writeFindingsSummary } from '../views/findingsModel';
import { handleFindingsMessage, type FindingsActions } from '../views/findingsView';

function tmpRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-findings-'));
}

function write(root: string, rel: string, data: unknown): void {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		typeof data === 'string' ? data : JSON.stringify(data, null, 2),
		'utf8',
	);
}

/**
 * A capture holding one enter/exit pair per span.
 *
 * The latency profile is built from these, not from the scorecard: a report of
 * what an exerciser drove could only ever describe the units it drove, and
 * described them in HTTP terms. Tests therefore have to supply the evidence,
 * the same way the product does.
 */
function writeCapture(root: string, service: string, spans: [string, number, string?][]): void {
	const lines: string[] = [];
	for (const [component, ms, errorType] of spans) {
		lines.push(JSON.stringify({ event: 'enter', component, depth: 0, request_id: 'r1' }));
		lines.push(
			JSON.stringify({
				event: 'exit',
				component,
				duration_ms: ms,
				status: errorType ? 'error' : 'ok',
				error_type: errorType ?? null,
				request_id: 'r1',
			}),
		);
	}
	write(root, `.vinv/captures/vinv-bringup/${service}/trace.jsonl`, lines.join('\n') + '\n');
}

function seed(root: string): void {
	write(root, '.vinv/exercise/scorecard.json', {
		coverage: { after_exercised: { endpoints_with_coverage: 16, endpoints_total: 23, symbols_covered: 37, symbols_total: 44 } },
		issue_clusters: 2,
		state_pollution: { created: 8, cleaned: 1, uncleaned: 7 },
		scenarios: { run: 1, completed: 0, expired: [{ name: 'POST /utils/test-email/', reason: 'setup step got 400' }] },
		endpoints: [
			{ endpoint: 'GET /api/v1/users/', p50_ms: 3.1, p95_ms: 240.5, coverage: '2/4', handler_observed: true, statuses: { '200': 4, '500': 2 } },
			{ endpoint: 'GET /health', p50_ms: 1.2, p95_ms: 2.4, coverage: '1/1', handler_observed: true, statuses: { '200': 9 } },
		],
	});
	write(root, '.vinv/exercise/issues.json', {
		clusters: [
			{ kind: 'server-error', title: 'GET /api/v1/users/ — HTTP 500', signature: 'abc123' },
			{ kind: 'crash', title: 'POST /x — connection closed', signature: 'def456' },
		],
	});
	write(root, '.vinv/exercise/profile.json', {
		opportunities: [{ kind: 'latency-p95', endpoint: 'GET /api/v1/users/', detail: 'P95 240.5ms exceeds 200ms', value: 240.5 }],
	});
	// Two episodes: an accept with a CI excluding zero, then a revert.
	write(root, '.vinv/exercise/optimize.jsonl', [
		JSON.stringify({
			at: 1000, label: 'users index', action: 'accept', reason: 'significant',
			opportunity: { kind: 'latency-p95', endpoint: 'GET /api/v1/users/', detail: 'slow' },
			attempts: [{ approach: 'add index', behavior_suite_passed: true, reverted: false,
				comparison: { rel_improvement: 0.46, ci_low: 0.31, ci_high: 0.58 } }],
			files_changed: ['app/crud.py'],
		}),
		JSON.stringify({
			at: 2000, label: 'cache users', action: 'revert-and-stop', reason: 'no gain',
			opportunity: { kind: 'latency-p95', endpoint: 'GET /api/v1/users/', detail: 'slow' },
			attempts: [{ approach: 'memoize list_users', behavior_suite_passed: false, reverted: true, comparison: null }],
			files_changed: [],
		}),
	].join('\n'));
	write(root, '.vinv/exercise/regress.jsonl', [
		JSON.stringify({ at: 1500, cases: 100, behavior_diffs: 2, contract_diffs: 0, perf_diffs: 1, environment_diffs: 0, diffs: [] }),
		JSON.stringify({
			at: 2500, cases: 125, behavior_diffs: 0, contract_diffs: 0, perf_diffs: 0,
			environment_diffs: 1, auth_cases_skipped: 0,
			diffs: [{ kind: 'environment', endpoint: 'POST /private/users/', detail: '200 → 400 [planted]' }],
		}),
	].join('\n'));
	write(root, '.vinv/exercise/state_ledger.jsonl', [
		JSON.stringify({ method: 'POST', path: '/users/', cleaned: true, cleaned_via: 'DELETE /users/{user_id}' }),
		JSON.stringify({ method: 'POST', path: '/password-recovery/{email}', cleaned: false }),
	].join('\n'));
}

suite('findings: assembly', () => {
	test('headline, episodes (newest first), regress latest+history, ledger', () => {
		const root = tmpRepo();
		seed(root);
		const f = buildFindings(root);

		assert.strictEqual(f.headline.issuesFound, 2);
		assert.strictEqual(f.headline.episodesAccepted, 1);
		assert.strictEqual(f.headline.episodesReverted, 1);
		assert.strictEqual(f.headline.regressCases, 125);
		assert.strictEqual(f.headline.regressRealDiffs, 0); // env drift is not a real diff

		assert.strictEqual(f.episodes[0].label, 'cache users'); // newest first
		assert.strictEqual(f.episodes[1].attempts[0].ciLow, 0.31);
		assert.strictEqual(f.episodes[1].filesChanged[0], 'app/crud.py');

		assert.strictEqual(f.regress.latest?.environment, 1);
		assert.strictEqual(f.regress.history.length, 2);
		assert.strictEqual(f.opportunities.length, 1);

		assert.strictEqual(f.state.rows.length, 2);
		assert.strictEqual(f.state.rows[0].via, 'DELETE /users/{user_id}');
		assert.strictEqual(f.scenarios.expired.length, 1);
	});

	test('empty repo degrades to zeros, never throws', () => {
		const f = buildFindings(tmpRepo());
		assert.strictEqual(f.headline.issuesFound, 0);
		assert.strictEqual(f.episodes.length, 0);
		assert.strictEqual(f.regress.latest, null);
	});

	test('machine summary writes the identical object to findings.json', () => {
		const root = tmpRepo();
		seed(root);
		const f = buildFindings(root);
		const file = writeFindingsSummary(root, f);
		const back = JSON.parse(fs.readFileSync(file, 'utf8'));
		assert.deepStrictEqual(back, JSON.parse(JSON.stringify(f)));
		assert.strictEqual(back.schemaVersion, 1);
	});
});

suite('findings: message routing', () => {
	test('openSource, refresh and walk route through', async () => {
		const log: string[] = [];
		const a: FindingsActions = {
			openSource: async (f, l) => void log.push(`open:${f}:${l}`),
			refresh: async () => void log.push('refresh'),
			dispatchFix: async (sig) => void log.push(`fix:${sig}`),
			walk: async () => void log.push('walk'),
			runExercise: async () => void log.push('exercise'),
			autoPilot: async () => void log.push('autopilot'),
		};
		await handleFindingsMessage({ type: 'openSource', file: 'x.py', line: 3 }, a);
		await handleFindingsMessage({ type: 'refresh' }, a);
		await handleFindingsMessage({ type: 'dispatchFix', signature: 'abc123' }, a);
		// A fix message with no signature names no cluster — routing it would
		// dispatch against `undefined`.
		await handleFindingsMessage({ type: 'dispatchFix' }, a);
		// The walkthrough is reached FROM the report now — Journey has no entry
		// point of its own outside the command palette, so this is the path.
		await handleFindingsMessage({ type: 'walk' }, a);
		// The empty state's two buttons. Without a route they render as controls
		// that do nothing, which is worse than the text they replaced.
		await handleFindingsMessage({ type: 'runExercise' }, a);
		await handleFindingsMessage({ type: 'autoPilot' }, a);
		assert.deepStrictEqual(log, [
			'open:x.py:3', 'refresh', 'fix:abc123', 'walk', 'exercise', 'autopilot',
		]);
	});
});

suite('findings: issue clusters carry their evidence', () => {
	// The tile read scorecard.issue_clusters while the list read issues.json, so
	// a pass that died before its `scorecard` step (or an imported run that wrote
	// one) showed "Issues found 0" above a list of six.
	test('the headline counts issues.json, not a stale scorecard', () => {
		const root = tmpRepo();
		seed(root);
		write(root, '.vinv/exercise/scorecard.json', { issue_clusters: 0 });
		const f = buildFindings(root);
		assert.strictEqual(f.headline.issuesFound, 2);
		assert.strictEqual(f.headline.issuesFound, f.issues.length, 'tile and list must agree');
	});

	test('a cluster surfaces its exemplar, evidence file and actionability', () => {
		const root = tmpRepo();
		write(root, '.vinv/exercise/issues.json', {
			clusters: [
				{
					kind: 'server-error',
					title: 'POST /chat — HTTP 500',
					signature: '77a9224c',
					method: 'POST',
					path: '/chat',
					count: 3,
					exemplar: {
						input: { body: null, path_params: {}, query: {} },
						strategy: 'schema_negative',
						status: 500,
						error: null,
						detail: 'HTTP 500',
						expected: '4xx (a correct service rejects this)',
					},
					covered_frames: ['main.chat', 'main.parse'],
				},
				// A diagnostic about an upstream dependency: no edit here fixes it.
				{ kind: 'signature-drift', title: 'urllib3 changed', signature: 'dd00', method: 'CALL', path: 'urllib3.request' },
			],
		});
		const [http, drift] = buildFindings(root).issues;

		assert.strictEqual(http.endpoint, 'POST /chat');
		assert.strictEqual(http.count, 3);
		assert.strictEqual(http.dispatchable, true);
		assert.strictEqual(http.evidenceFile, 'results.jsonl');
		assert.strictEqual(http.exemplar?.expected, '4xx (a correct service rejects this)');
		assert.strictEqual(http.exemplar?.status, 500);
		assert.strictEqual(http.exemplar?.strategy, 'schema_negative');
		// Every field of the input was empty — that IS the test case (a bodyless
		// POST), so it must render as the payload rather than collapse to nothing.
		assert.ok(http.exemplar?.input.includes('body'), `expected the payload, got: ${http.exemplar?.input}`);
		assert.deepStrictEqual(http.coveredFrames, ['main.chat', 'main.parse']);

		assert.strictEqual(drift.dispatchable, false, 'a diagnostic must not offer a fix');
		assert.strictEqual(drift.evidenceFile, 'signatures.json');
		assert.strictEqual(drift.exemplar, null);
	});

	test('a populated input drops only the empty halves', () => {
		const root = tmpRepo();
		write(root, '.vinv/exercise/issues.json', {
			clusters: [{
				kind: 'server-error', title: 't', signature: 's', method: 'GET', path: '/x',
				exemplar: { input: { body: { name: 'ada' }, path_params: {}, query: {} }, status: 500 },
			}],
		});
		const input = buildFindings(root).issues[0].exemplar?.input ?? '';
		assert.ok(input.includes('ada'), `expected the body, got: ${input}`);
		assert.ok(!input.includes('path_params'), `empty halves must be dropped, got: ${input}`);
	});
});

suite('findings: service attribution', () => {
	/** Two services whose handlers live in distinct entrypoint modules. */
	function twoServiceRepo(): string {
		const root = tmpRepo();
		write(root, '.vinv/services.json', [
			{ name: 'api', command: 'python -m uvicorn app.server.main:app --port 8000' },
			{ name: 'worker', command: 'python -m uvicorn app.worker.main:app --port 8001' },
		]);
		write(root, '.vinv/identification/apis.json', {
			entrypoints: [
				{ id: 'GET_home', trigger: 'GET /', file: 'app/server/main.py' },
				{ id: 'POST_job', trigger: 'POST /jobs', file: 'app/worker/main.py' },
				{ id: 'GET_orphan', trigger: 'GET /orphan', file: 'scripts/adhoc.py' },
			],
		});
		return root;
	}

	test('an endpoint resolves to the service whose entrypoint module owns its file', () => {
		const idx = buildServiceIndex(twoServiceRepo());
		assert.strictEqual(idx.get('GET /'), 'api');
		assert.strictEqual(idx.get('POST /jobs'), 'worker');
		// Keyed on the id form too — the scorecard and profile spell it that way.
		assert.strictEqual(idx.get('GET_home'), 'api');
		// Owned by neither entrypoint module: absent, not guessed.
		assert.strictEqual(idx.get('GET /orphan'), undefined);
	});

	test('issues carry their service, and unattributable ones stay unattributed', () => {
		const root = twoServiceRepo();
		write(root, '.vinv/exercise/issues.json', {
			clusters: [
				{ kind: 'server-error', title: 'boom', signature: 'a', method: 'GET', path: '/' },
				{ kind: 'server-error', title: 'slow', signature: 'b', method: 'POST', path: '/jobs' },
				{ kind: 'server-error', title: 'huh', signature: 'c', method: 'GET', path: '/orphan' },
			],
		});
		const f = buildFindings(root);
		assert.deepStrictEqual(
			f.issues.map((i) => i.service),
			['api', 'worker', undefined],
		);
		// Only services that actually own a finding drive the filter chips —
		// distinct from `services`, the bring-up inventory.
		assert.deepStrictEqual(f.servicesWithFindings, ['api', 'worker']);
	});

	/**
	 * A CLI invocation's id is minted by the exerciser as `<service>#<index>`
	 * and appears in no apis.json, so the file-ownership join can never resolve
	 * it. Before the prefix was read, every CLI row and CLI issue counted as
	 * unattributed and vanished the moment a service chip was clicked.
	 */
	test('a CLI command attributes to the service its unit id names', () => {
		const root = tmpRepo();
		write(root, '.vinv/services.json', {
			services: [{ name: 'acme-tool', kind: 'python_cli', command: 'acme-tool' }],
		});
		write(root, '.vinv/identification/apis.json', {
			status: 'ok',
			entrypoints: [
				{
					kind: 'cli_command', id: 'acme-tool#0', trigger: 'check', handler: 'check_cmd',
					file: 'acme/cli.py', line: 10, framework: 'click',
				},
			],
		});
		// A driven call is declared nowhere — the exerciser's own plan is the only
		// place it is named, and its spans are matched by that dotted target.
		write(root, '.vinv/exercise/profile.json', {
			endpoints: [
				{ api_id: 'acme.mod:summarize', method: 'CALL', path: 'acme.mod:summarize', unit_kind: 'function_call' },
			],
		});
		write(root, '.vinv/exercise/scorecard.json', {
			coverage: { after_exercised: { units_by_kind: { cli_invocation: 1, function_call: 1 } } },
		});
		writeCapture(root, 'acme-tool', [
			['acme.cli.check_cmd', 12],
			['acme.mod.summarize', 30],
		]);
		write(root, '.vinv/exercise/issues.json', {
			clusters: [{ kind: 'crash', title: 'exited 2', signature: 'z', endpoint_id: 'acme-tool#0' }],
		});
		const f = buildFindings(root);

		const cli = f.endpoints.find((e) => e.unitKind === 'cli_invocation');
		const call = f.endpoints.find((e) => e.unitKind === 'function_call');
		assert.strictEqual(cli?.service, 'acme-tool');
		assert.strictEqual(f.issues[0].service, 'acme-tool');
		assert.deepStrictEqual(f.servicesWithFindings, ['acme-tool']);
		// A driven call's target is a module path, which names a file rather than
		// a service — unattributed on purpose, not by omission.
		assert.strictEqual(call?.service, undefined);
		assert.strictEqual(call?.p50Ms, 30, 'a driven call is timed like anything else');
		assert.deepStrictEqual(f.headline.unitsByKind, { cli_invocation: 1, function_call: 1 });
	});

	test('the latency profile lists what the captures saw, not what a report claims', () => {
		const root = tmpRepo();
		write(root, '.vinv/identification/apis.json', {
			status: 'ok',
			entrypoints: [
				{ kind: 'http_api', id: 'GET_a', trigger: 'GET /a', handler: 'a', file: 'app/api.py', line: 1, framework: 'fastapi' },
				{ kind: 'http_api', id: 'GET_never', trigger: 'GET /never', handler: 'never', file: 'app/api.py', line: 9, framework: 'fastapi' },
			],
		});
		// A scorecard claiming a unit ran must not put it on the page, and must
		// not supply its numbers either.
		write(root, '.vinv/exercise/scorecard.json', {
			endpoints: [{ endpoint: 'GET /never', p50_ms: 5, p95_ms: 9, coverage: '4/4', handler_observed: true }],
		});
		writeCapture(root, 'api', [
			['app.api.a', 10],
			['app.api.a', 400, 'KeyError'],
		]);

		const f = buildFindings(root);

		assert.strictEqual(f.endpoints.length, 1, 'only the unit the captures actually saw');
		assert.strictEqual(f.endpoints[0].endpoint, 'GET /a');
		assert.strictEqual(f.endpoints[0].unitKind, 'http_endpoint');
		assert.strictEqual(f.endpoints[0].p95Ms, 400);
		assert.deepStrictEqual(f.endpoints[0].statuses, { ok: 1, error: 1 });
		assert.strictEqual(f.endpoints[0].handlerObserved, true, 'it ran — never badged "not reached"');
		assert.strictEqual(f.endpoints[0].coverage, '', 'no overlay yet is blank, never 0/0');
	});

	test('no identification or services artifact leaves everything unattributed', () => {
		const root = tmpRepo();
		write(root, '.vinv/exercise/issues.json', {
			clusters: [{ kind: 'server-error', title: 'boom', signature: 'a', method: 'GET', path: '/' }],
		});
		const f = buildFindings(root);
		assert.strictEqual(f.issues[0].service, undefined);
		assert.deepStrictEqual(f.servicesWithFindings, []);
	});
});
