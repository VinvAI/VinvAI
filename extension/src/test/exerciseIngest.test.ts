/**
 * Tests for ingesting an EXTERNAL endpoint-test run: the validation that
 * refuses to guess an oracle, per-endpoint coverage joined from routed server
 * spans, and the service disambiguation that keeps two apps' `GET /` apart.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { apiIdFor, ingestRun, validateRun } from '../harness/exerciseIngest';
import { hasExercisePass, readScorecardSummary } from '../harness/exerciseRunner';

function tmpRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-ingest-'));
	fs.mkdirSync(path.join(root, '.vinv', 'exercise'), { recursive: true });
	return root;
}

/** A capture whose request tree is rooted at a named inbound span. */
function writeRoutedCapture(root: string, session: string, endpoint: string, symbols: string[]): void {
	const dir = path.join(root, '.vinv', 'captures', session, 'svc');
	fs.mkdirSync(dir, { recursive: true });
	const lines: string[] = [];
	const req = `req-${session}`;
	const push = (event: string, component: string, depth: number, parent: string | null) =>
		lines.push(
			JSON.stringify({
				ts: '2026-01-01T00:00:00.000Z',
				request_id: req,
				component,
				event,
				depth,
				parent_component: parent,
				duration_ms: event === 'exit' ? 5 : undefined,
				status: 'ok',
			}),
		);
	push('enter', endpoint, 0, null);
	for (const s of symbols) {
		push('enter', s, 1, endpoint);
	}
	for (const s of [...symbols].reverse()) {
		push('exit', s, 1, endpoint);
	}
	push('exit', endpoint, 0, null);
	fs.writeFileSync(path.join(dir, 'trace.jsonl'), lines.join('\n') + '\n', 'utf8');
	fs.writeFileSync(path.join(dir, 'epoch.json'), JSON.stringify({ epoch: 1, captured_unix: 1 }), 'utf8');
}

suite('exerciseIngest: validation refuses to invent an oracle', () => {
	test('a check without a pass/fail verdict is rejected', () => {
		const r = validateRun({ checks: [{ endpoint: 'POST /x', name: 'no verdict' }] });
		assert.strictEqual(r.ok, false);
		assert.ok(
			!r.ok && /passed must be a boolean/.test(r.error),
			`expected the verdict to be required, got: ${!r.ok ? r.error : ''}`,
		);
	});

	test('a malformed endpoint is rejected with the expected shape', () => {
		const r = validateRun({ checks: [{ endpoint: 'run-agent', name: 'x', passed: true }] });
		assert.strictEqual(r.ok, false);
		assert.ok(!r.ok && /METHOD \/path/.test(r.error));
	});

	test('a CLI invocation and a driven call are valid units', () => {
		// A repo with no service still exercises units. Refusing these left an
		// agent that had genuinely driven a CLI with nowhere to report it, and
		// the views then read as "never tested" rather than "not recordable".
		const r = validateRun({
			checks: [
				{ endpoint: 'RUN acme-tool report --since 7d', name: 'weekly report', passed: true },
				{ endpoint: 'CALL acme.mod.summarize', name: 'summarize', passed: true },
			],
		});
		assert.strictEqual(r.ok, true);
	});

	test('the rejection message names all three unit forms', () => {
		const r = validateRun({ checks: [{ endpoint: 'whatever', name: 'x', passed: true }] });
		assert.strictEqual(r.ok, false);
		assert.ok(!r.ok && /RUN <command>/.test(r.error));
		assert.ok(!r.ok && /CALL module\.function/.test(r.error));
	});

	test('a unit label without a verb is still rejected', () => {
		// Widening the grammar must not turn it off: a bare string is not a unit.
		assert.strictEqual(validateRun({ checks: [{ endpoint: 'acme-tool report', name: 'x', passed: true }] }).ok, false);
		assert.strictEqual(validateRun({ checks: [{ endpoint: 'RUN', name: 'x', passed: true }] }).ok, false);
	});

	test('an empty run is rejected', () => {
		assert.strictEqual(validateRun({ checks: [] }).ok, false);
		assert.strictEqual(validateRun(null).ok, false);
	});

	test('a well-formed run passes', () => {
		const r = validateRun({ checks: [{ endpoint: 'GET /a', name: 'ok', passed: true }] });
		assert.strictEqual(r.ok, true);
	});

	test('nothing is written when validation fails', () => {
		const root = tmpRepo();
		const res = ingestRun(root, { checks: [{ endpoint: 'bad', name: 'x', passed: true }] });
		assert.strictEqual(res.status, 'error');
		assert.deepStrictEqual(res.written, []);
		assert.ok(!fs.existsSync(path.join(root, '.vinv', 'exercise', 'scorecard.json')));
	});
});

suite('exerciseIngest: coverage joins from routed server spans', () => {
	test('symbols under a request tree are credited to that endpoint only', () => {
		const root = tmpRepo();
		// Index rows must exist for components to resolve; two files, two symbols.
		const store = path.join(root, '.vinv', 'index');
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(
			path.join(store, 'chunks.jsonl'),
			[
				JSON.stringify({ id: 'a', file: 'src/app/handler.py', name: 'handle', kind: 'function', start_line: 1 }),
				JSON.stringify({ id: 'b', file: 'src/app/db.py', name: 'query', kind: 'function', start_line: 1 }),
			].join('\n') + '\n',
			'utf8',
		);
		writeRoutedCapture(root, 's1', 'POST /run', ['app.handler.handle', 'app.db.query']);

		const res = ingestRun(root, {
			source: 'test',
			checks: [
				{ endpoint: 'POST /run', name: 'happy path', passed: true, status: 200, latency_ms: 10 },
				{ endpoint: 'GET /nope', name: 'unknown route', passed: true, status: 404, latency_ms: 1 },
			],
		});

		assert.strictEqual(res.status, 'ok');
		assert.strictEqual(res.endpoints, 2);
		// Only the routed endpoint has coverage; the 404 reached no user code.
		assert.strictEqual(res.endpoints_with_coverage, 1);
		assert.ok(res.symbols_covered > 0, 'expected the routed request to credit symbols');
		assert.deepStrictEqual(res.endpoints_without_traces, ['GET /nope']);
	});
});

suite('exerciseIngest: service disambiguation', () => {
	test('two services serving GET / stay separate endpoints', () => {
		const root = tmpRepo();
		const res = ingestRun(root, {
			checks: [
				{ endpoint: 'GET /', service: 'api', name: 'root', passed: true, status: 200, latency_ms: 5 },
				{ endpoint: 'GET /', service: 'ui', name: 'root', passed: true, status: 200, latency_ms: 900 },
			],
		});
		assert.strictEqual(res.endpoints, 2, 'same path on two services must not merge');
		const plan = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'exercise', 'plan.json'), 'utf8'),
		);
		const paths = plan.endpoints.map((e: { path: string }) => e.path);
		assert.ok(
			paths.every((p: string) => /\[(api|ui)\]/.test(p)),
			`expected service-suffixed paths, got ${JSON.stringify(paths)}`,
		);
	});

	test('a single service keeps clean unsuffixed paths', () => {
		const root = tmpRepo();
		ingestRun(root, {
			checks: [{ endpoint: 'GET /', service: 'api', name: 'root', passed: true, status: 200 }],
		});
		const plan = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'exercise', 'plan.json'), 'utf8'),
		);
		assert.strictEqual(plan.endpoints[0].path, '/');
	});
});

suite('exerciseIngest: artifacts and provenance', () => {
	test('writes all five artifacts, stamped with the caller as source', () => {
		const root = tmpRepo();
		const res = ingestRun(root, {
			source: 'claude-code e2e',
			checks: [
				{ endpoint: 'POST /a', name: 'ok', passed: true, status: 200, latency_ms: 5 },
				{
					endpoint: 'POST /a',
					name: 'malformed body',
					passed: false,
					severity: 'high',
					status: 500,
					latency_ms: 5,
					detail: 'server error 500 on invalid input (should be 4xx)',
				},
			],
		});
		assert.strictEqual(res.status, 'ok');
		assert.strictEqual(res.written.length, 5);
		const ex = path.join(root, '.vinv', 'exercise');
		for (const f of ['plan.json', 'scorecard.json', 'issues.json', 'profile.json', 'results.jsonl']) {
			assert.ok(fs.existsSync(path.join(ex, f)), `${f} must be written`);
		}
		const scorecard = JSON.parse(fs.readFileSync(path.join(ex, 'scorecard.json'), 'utf8'));
		assert.strictEqual(scorecard.source, 'claude-code e2e', 'provenance must record the caller');
		assert.strictEqual(scorecard.ingested_by, 'vinv_ingest_run');
		const issues = JSON.parse(fs.readFileSync(path.join(ex, 'issues.json'), 'utf8'));
		assert.strictEqual(issues.cluster_count, 1, 'the single failure forms one cluster');
		assert.strictEqual(issues.clusters[0].kind, 'high');
	});

	// The compass gated "Exercise the services" on scorecard.json EXISTING, so an
	// ingested run — which writes the same file — silently deleted that rung from
	// the ladder: probes, then straight to "Ask Vinv about this codebase".
	test('an ingested run is not counted as a vinv exercise pass', () => {
		const root = tmpRepo();
		assert.strictEqual(hasExercisePass(root), false, 'no scorecard yet');
		ingestRun(root, {
			source: 'claude-code e2e',
			checks: [{ endpoint: 'POST /a', name: 'ok', passed: true, status: 200 }],
		});
		assert.ok(
			fs.existsSync(path.join(root, '.vinv', 'exercise', 'scorecard.json')),
			'the ingest writes the same artifact the exerciser does',
		);
		assert.strictEqual(
			hasExercisePass(root),
			false,
			'an imported run must still leave the exercise rung outstanding',
		);
		assert.strictEqual(readScorecardSummary(root)?.ingestedBy, 'vinv_ingest_run');
	});

	test("the exerciser's own scorecard does count as a pass", () => {
		const root = tmpRepo();
		fs.writeFileSync(
			path.join(root, '.vinv', 'exercise', 'scorecard.json'),
			JSON.stringify({
				version: 1,
				service: 'api',
				coverage: { after_exercised: { endpoints_with_coverage: 2, endpoints_total: 3 } },
				invariants_learned: 7,
				issue_clusters: 1,
			}),
			'utf8',
		);
		assert.strictEqual(hasExercisePass(root), true);
		assert.deepStrictEqual(readScorecardSummary(root), {
			source: 'api',
			ingestedBy: undefined,
			endpointsCovered: 2,
			total: 3,
			invariants: 7,
			issues: 1,
			// Empty here on purpose: this scorecard predates units_by_kind and
			// carries no unit list to count, which is exactly the shape an
			// ingested or older run has. The summary must still read it.
			unitsByKind: {},
		});
	});

	test('failures sharing a root cause collapse into one cluster', () => {
		const root = tmpRepo();
		const mk = (n: string) => ({
			endpoint: 'POST /a',
			name: n,
			passed: false,
			severity: 'high',
			status: 500,
			detail: 'server error 500 on invalid input (should be 4xx) - parse outside try',
		});
		const res = ingestRun(root, { checks: [mk('empty body'), mk('array body'), mk('scalar body')] });
		assert.strictEqual(res.failed, 3);
		assert.strictEqual(res.issue_clusters, 1, 'one defect reached three ways is one issue');
	});

	test('api ids are stable and filesystem-safe', () => {
		assert.strictEqual(apiIdFor('POST /run-agent'), 'POST_run_agent');
		assert.strictEqual(apiIdFor('GET /'), 'GET_root');
	});
});
