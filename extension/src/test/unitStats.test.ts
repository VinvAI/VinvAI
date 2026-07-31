/**
 * Per-unit numbers, computed from the captures rather than from a report.
 *
 * Latency and outcome used to be read out of `.vinv/exercise/scorecard.json` —
 * an exerciser's summary of the units IT drove, keyed by the label it displayed
 * them under. That made a unit no exerciser had driven unmeasurable however
 * much traffic the captures held, described CLI runs and driven functions in
 * HTTP terms or not at all, and joined through a display label that silently
 * missed whenever it disagreed with the entry-point id. These pin the
 * replacement: the spans themselves, joined the same way the hit count is, with
 * the same answer available for every kind of unit.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	joinUnitStats,
	percentile,
	readUnitStats,
	statsFromFacts,
} from '../views/unitStats';
import { resetHitCache, type ComponentFacts } from '../identification/entryPointHits';
import type { EndpointInsight } from '../harness/pipelineState';

const units = [
	{ id: 'GET_health', handler: 'health', file: 'app/api.py' },
	{ id: 'CLI_generate', handler: 'generate_cmd', file: 'handbook/src/handbook/cli.py' },
	{ id: 'CALL_summarize', handler: 'summarize', file: 'acme/mod.py' },
];

function facts(over: Partial<ComponentFacts> = {}): ComponentFacts {
	return { calls: 0, durations: [], ok: 0, error: 0, errorTypes: new Map(), ...over };
}

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

/** Writes a capture holding one enter/exit pair per (component, duration). */
function writeCapture(root: string, service: string, spans: [string, number, string?][]): void {
	const dir = path.join(root, '.vinv', 'captures', 'vinv-bringup', service);
	fs.mkdirSync(dir, { recursive: true });
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
	fs.writeFileSync(path.join(dir, 'trace.jsonl'), lines.join('\n') + '\n', 'utf8');
}

suite('unit stats: percentiles from the spans themselves', () => {
	test('p50 and p95 are nearest-rank over the captured durations', () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		assert.strictEqual(percentile(values, 50), 6);
		assert.strictEqual(percentile(values, 95), 10);
		assert.strictEqual(percentile([], 95), undefined, 'no spans is not zero latency');
	});

	test('an outcome is returned-or-raised, with the exception types worst first', () => {
		const s = statsFromFacts(
			facts({
				calls: 5,
				durations: [10, 20, 30],
				ok: 3,
				error: 2,
				errorTypes: new Map([
					['ValueError', 1],
					['KeyError', 3],
				]),
			}),
		);

		assert.strictEqual(s.ok, 3);
		assert.strictEqual(s.error, 2);
		assert.deepStrictEqual(s.errorTypes, ['KeyError', 'ValueError']);
		assert.strictEqual(s.p50Ms, 20);
	});

	test('coverage is taken from the overlay, and 0/0 is no denominator', () => {
		const withCov = joinUnitStats(new Map(), [
			insight({ coverage: { total: 40, executed: 9, pct: 22.5 } }),
		]);
		assert.deepStrictEqual(withCov.get('GET_health')?.coverage, {
			total: 40,
			executed: 9,
			pct: 22.5,
		});

		// A unit whose static tree could not be built has nothing to be a
		// percentage of; 0% would read as "none of it ran".
		const noTree = joinUnitStats(new Map(), [insight({ coverage: { total: 0, executed: 0, pct: 0 } })]);
		assert.strictEqual(noTree.get('GET_health')?.coverage, undefined);
	});

	test('the engine’s overlay outranks a direct read of the captures', () => {
		// One join, one definition of "an invocation of this unit". The captures
		// are read here only until the insight pass has built the unit; once it
		// has, the number this panel shows is the number every other Vinv
		// surface quotes, because it came from the same tracemap.
		const fromCaptures = new Map([['GET_health', facts({ calls: 2, durations: [1, 2], ok: 2 })]]);
		const s = joinUnitStats(fromCaptures, [
			insight({
				latency: {
					calls: 9, ok: 8, error: 1, errorTypes: ['KeyError'],
					p50Ms: 40, p95Ms: 900, maxMs: 950, blockedMs: 12,
				},
			}),
		]).get('GET_health');

		assert.strictEqual(s?.p95Ms, 900, 'the overlay’s distribution, not the local one');
		assert.strictEqual(s?.measuredBy, 'overlay');
		assert.deepStrictEqual(s?.errorTypes, ['KeyError']);
	});

	test('until the pass has run, the captures still answer', () => {
		const s = joinUnitStats(
			new Map([['GET_health', facts({ calls: 2, durations: [10, 20], ok: 2 })]]),
			[insight({ latency: undefined })],
		).get('GET_health');

		assert.strictEqual(s?.p95Ms, 20);
		assert.strictEqual(s?.measuredBy, 'captures', 'and the row says which pass measured it');
	});

	test('errors and the built-tree flag still come from the manifest', () => {
		const s = joinUnitStats(new Map(), [insight({ errorCount: 3, calltreePath: null })]).get(
			'GET_health',
		);

		assert.strictEqual(s?.errorCount, 3);
		assert.strictEqual(s?.hasCallTree, false);
	});
});

suite('unit stats: every kind of unit, from the captures alone', () => {
	setup(() => resetHitCache());

	test('an HTTP route, a CLI command and a driven function all get numbers', () => {
		// The point of the rewrite: no exerciser ran here and there is no
		// scorecard on disk, yet all three units are measured.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-stats-'));
		writeCapture(root, 'api', [
			['app.api.health', 4],
			['app.api.health', 8],
			['handbook.cli.generate_cmd', 1200],
			['acme.mod.summarize', 30, 'ValueError'],
		]);

		const stats = readUnitStats(root, units);

		assert.strictEqual(stats.get('GET_health')?.p95Ms, 8);
		assert.strictEqual(stats.get('CLI_generate')?.p50Ms, 1200, 'a CLI run is timed like anything else');
		assert.strictEqual(stats.get('CALL_summarize')?.error, 1);
		assert.deepStrictEqual(stats.get('CALL_summarize')?.errorTypes, ['ValueError']);
		assert.strictEqual(stats.get('CALL_summarize')?.ok, 0);
	});

	test('captures across services are summed, not last-one-wins', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-stats-'));
		writeCapture(root, 'a', [['app.api.health', 10]]);
		writeCapture(root, 'b', [['app.api.health', 20]]);

		const s = readUnitStats(root, units).get('GET_health');

		assert.strictEqual((s?.ok ?? 0) + (s?.error ?? 0), 2, 'both services counted');
	});

	test('a unit the captures never saw has no row, not a row of zeros', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-stats-'));
		writeCapture(root, 'api', [['app.api.health', 4]]);

		const stats = readUnitStats(root, units);

		assert.ok(stats.has('GET_health'));
		assert.strictEqual(stats.has('CLI_generate'), false, '0ms would be a measurement nobody made');
	});

	test('a workspace with no captures reads as empty, not as an error', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-stats-'));

		assert.strictEqual(readUnitStats(root, units).size, 0);
	});

	test('a single trace file narrows the numbers to that window', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-stats-'));
		writeCapture(root, 'a', [['app.api.health', 10]]);
		writeCapture(root, 'b', [['app.api.health', 900]]);
		const only = path.join(root, '.vinv', 'captures', 'vinv-bringup', 'a', 'trace.jsonl');

		const s = readUnitStats(root, units, only).get('GET_health');

		assert.strictEqual(s?.p95Ms, 10, 'the other capture is outside the window');
	});
});
