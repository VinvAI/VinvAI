/**
 * Joining a traced unit to what is known about it.
 *
 * The Traces panel had one column — hits — while coverage, latency and status
 * codes sat unread in two artifacts written by two different passes, keyed two
 * different ways. These pin the join's rules: which artifact wins where they
 * disagree, that a coverage number always says which pass measured it, and that
 * a row matching nothing is dropped rather than guessed at.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { joinUnitStats, readUnitStats, type ScorecardRow } from '../views/unitStats';
import type { EndpointInsight } from '../harness/pipelineState';

const units = [
	{ id: 'GET_health', trigger: 'GET /health', file: 'app/api.py' },
	{ id: 'CLI_generate', trigger: 'generate', file: 'handbook/cli.py' },
];

function insight(over: Partial<EndpointInsight> = {}): EndpointInsight {
	return {
		id: 'GET_health',
		trigger: 'GET /health',
		handler: 'health',
		calltreePath: '/w/.vinv/reports/calltree-GET_health.json',
		reportPath: null,
		traceCount: 4,
		errorCount: 0,
		symbols: [],
		lastBuilt: '2026-07-31T10:00:00.000Z',
		...over,
	};
}

suite('unit stats: joining the artifacts that hold the facts', () => {
	test('an exercised unit carries latency, statuses and its own coverage', () => {
		const row: ScorecardRow = {
			endpoint: 'GET /health',
			api_id: 'GET_health',
			coverage: '12/40',
			pct: 30,
			p50_ms: 8,
			p95_ms: 240,
			statuses: { '200': 11, '500': 1 },
			checks: 12,
			failed: 1,
		};

		const s = joinUnitStats([row], [insight()], units).get('GET_health');

		assert.strictEqual(s?.p50Ms, 8);
		assert.strictEqual(s?.p95Ms, 240);
		assert.deepStrictEqual(s?.statuses, { '200': 11, '500': 1 });
		assert.strictEqual(s?.checks, 12);
		assert.strictEqual(s?.failed, 1);
		assert.deepStrictEqual(s?.coverage, { executed: 12, total: 40, pct: 30, source: 'exercised' });
	});

	test('a unit only the captures saw still gets coverage, marked as traced', () => {
		// Production traffic and bring-up smoke runs never go through an
		// exerciser, so the overlay is the only measurement there is.
		const s = joinUnitStats(
			[],
			[insight({ coverage: { total: 40, executed: 9, pct: 22.5 } })],
			units,
		).get('GET_health');

		assert.deepStrictEqual(s?.coverage, { total: 40, executed: 9, pct: 22.5, source: 'traced' });
	});

	test('the exerciser’s coverage wins over the overlay’s, and says so', () => {
		// Two different claims: what the suite's inputs reached vs what a capture
		// happened to catch. The view must never present one as the other.
		const s = joinUnitStats(
			[{ endpoint: 'GET /health', api_id: 'GET_health', coverage: '30/40', pct: 75 }],
			[insight({ coverage: { total: 40, executed: 9, pct: 22.5 } })],
			units,
		).get('GET_health');

		assert.strictEqual(s?.coverage?.executed, 30);
		assert.strictEqual(s?.coverage?.source, 'exercised');
	});

	test('a scorecard with no api_id joins on the unit label', () => {
		// vinv's own exerciser writes only the label; the ingest path stamps ids.
		const s = joinUnitStats([{ endpoint: 'generate', coverage: '5/5', pct: 100 }], [], units);

		assert.strictEqual(s.get('CLI_generate')?.coverage?.pct, 100);
	});

	test('a row matching no known unit is dropped, not guessed at', () => {
		const s = joinUnitStats([{ endpoint: 'GET /gone', coverage: '1/2' }], [], units);

		assert.strictEqual(s.size, 0);
	});

	test('0/0 is no denominator, not zero coverage', () => {
		// A unit whose static tree could not be built has nothing to be a
		// percentage of; rendering 0% would read as "none of it ran".
		const s = joinUnitStats([{ endpoint: 'GET /health', coverage: '0/0', pct: 0 }], [], units);

		assert.strictEqual(s.get('GET_health')?.coverage, undefined);
	});

	test('errors and the built-tree flag come from the manifest', () => {
		const s = joinUnitStats([], [insight({ errorCount: 3, calltreePath: null })], units).get(
			'GET_health',
		);

		assert.strictEqual(s?.errorCount, 3);
		assert.strictEqual(s?.hasCallTree, false);
	});

	test('a workspace with neither artifact reads as empty, not as an error', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-stats-'));

		assert.strictEqual(readUnitStats(root, units).size, 0);
	});

	test('both artifacts are read off disk and merged', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-stats-'));
		fs.mkdirSync(path.join(root, '.vinv', 'exercise'), { recursive: true });
		fs.mkdirSync(path.join(root, '.vinv', 'reports'), { recursive: true });
		fs.writeFileSync(
			path.join(root, '.vinv', 'exercise', 'scorecard.json'),
			JSON.stringify({ endpoints: [{ endpoint: 'GET /health', p95_ms: 120, checks: 4, failed: 0 }] }),
			'utf8',
		);
		fs.writeFileSync(
			path.join(root, '.vinv', 'reports', 'index.json'),
			JSON.stringify({ version: 1, endpoints: [insight({ errorCount: 2 })] }),
			'utf8',
		);

		const s = readUnitStats(root, units).get('GET_health');

		assert.strictEqual(s?.p95Ms, 120);
		assert.strictEqual(s?.errorCount, 2);
	});
});
