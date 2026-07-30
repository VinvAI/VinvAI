/**
 * Findings view: assembly of the USP surface (issues, episodes with CIs,
 * regress kinds, latency profile, state ledger) and the machine summary.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildFindings, writeFindingsSummary } from '../views/findingsModel';
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
	test('openSource and refresh route through', async () => {
		const log: string[] = [];
		const a: FindingsActions = {
			openSource: async (f, l) => void log.push(`open:${f}:${l}`),
			refresh: async () => void log.push('refresh'),
			dispatchFix: async (sig) => void log.push(`fix:${sig}`),
		};
		await handleFindingsMessage({ type: 'openSource', file: 'x.py', line: 3 }, a);
		await handleFindingsMessage({ type: 'refresh' }, a);
		await handleFindingsMessage({ type: 'dispatchFix', signature: 'abc123' }, a);
		// A fix message with no signature names no cluster — routing it would
		// dispatch against `undefined`.
		await handleFindingsMessage({ type: 'dispatchFix' }, a);
		assert.deepStrictEqual(log, ['open:x.py:3', 'refresh', 'fix:abc123']);
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
