/**
 * The background report mirrors: findings.json / journey.json are produced by
 * a change-gated pass over the same pure assemblies the views render — an
 * agent reads fresh mirrors without a human ever opening a tab.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeReportMirrors, type ReportMirrorMemo } from '../views/reportMirrorSource';

function tmpRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-mirror-'));
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
	write(root, '.vinv/services.json', {
		services: [{ name: 'app', kind: 'python_web', port: 8000, command: 'fastapi run' }],
	});
	write(root, '.vinv/exercise/plan.json', {
		endpoints: [
			{ api_id: 'GET_items', method: 'GET', path: '/api/v1/items/', handler: 'read_items' },
		],
	});
	write(root, '.vinv/exercise/scorecard.json', {
		coverage: {
			after_exercised: {
				endpoints_with_coverage: 1, endpoints_total: 1,
				symbols_covered: 3, symbols_total: 4,
			},
		},
		scenarios: { run: 0, completed: 0, expired: [] },
		state_pollution: { created: 0, cleaned: 0, uncleaned: 0 },
		issues: [],
		endpoints: [
			{
				endpoint: 'GET /api/v1/items/', coverage: '3/4', pct: 75,
				handler_observed: true, p50_ms: 12, p95_ms: 288,
				invariants: 0, statuses: { '200': 5 },
			},
		],
	});
}

const EMPTY: ReportMirrorMemo = { findings: '', journey: '' };

suite('report mirrors: background, change-gated production', () => {
	test('one pass writes both mirrors with the assembled content', () => {
		const root = tmpRepo();
		seed(root);
		const result = writeReportMirrors(root, EMPTY);
		assert.strictEqual(result.wroteFindings, true);
		assert.strictEqual(result.wroteJourney, true);

		const findings = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'reports', 'findings.json'), 'utf8'),
		);
		assert.strictEqual(findings.headline.endpointsCovered, 1);
		assert.strictEqual(findings.endpoints[0].p95Ms, 288);

		const journey = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'reports', 'journey.json'), 'utf8'),
		);
		assert.strictEqual(journey.steps.length, 1);
		assert.strictEqual(journey.steps[0].handlerObserved, true);
	});

	test('an unchanged workspace writes nothing (the change gate holds)', () => {
		const root = tmpRepo();
		seed(root);
		const first = writeReportMirrors(root, EMPTY);
		const findingsFile = path.join(root, '.vinv', 'reports', 'findings.json');
		const before = fs.statSync(findingsFile).mtimeMs;
		const second = writeReportMirrors(root, first.memo);
		assert.strictEqual(second.wroteFindings, false);
		assert.strictEqual(second.wroteJourney, false);
		assert.strictEqual(fs.statSync(findingsFile).mtimeMs, before, 'file untouched');
	});

	test('a changed artifact re-writes only from fresh content', () => {
		const root = tmpRepo();
		seed(root);
		const first = writeReportMirrors(root, EMPTY);

		// The exerciser updates the scorecard: p95 improved after an optimization.
		const scorecard = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'exercise', 'scorecard.json'), 'utf8'),
		);
		scorecard.endpoints[0].p95_ms = 40;
		write(root, '.vinv/exercise/scorecard.json', scorecard);

		const second = writeReportMirrors(root, first.memo);
		assert.strictEqual(second.wroteFindings, true);
		const findings = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'reports', 'findings.json'), 'utf8'),
		);
		assert.strictEqual(findings.endpoints[0].p95Ms, 40);
	});

	test('an empty workspace still produces well-formed (empty) mirrors', () => {
		const root = tmpRepo();
		const result = writeReportMirrors(root, EMPTY);
		assert.strictEqual(result.wroteFindings, true);
		const findings = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'reports', 'findings.json'), 'utf8'),
		);
		assert.deepStrictEqual(findings.issues, []);
		const journey = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'reports', 'journey.json'), 'utf8'),
		);
		assert.deepStrictEqual(journey.steps, []);
	});
});
