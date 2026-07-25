/**
 * Probe deadlines derive from the endpoint's OWN persisted latency history —
 * max(p99 × 20, slowest × 2) — with the flat 10s prior only when no history
 * exists, and the VINV_PROBE_TIMEOUT_S env override always winning.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	persistedLatencyHistory,
	probeFilePath,
	probeTimeoutMs,
} from '../harness/probeRunner';

suite('probeTimeoutMs: history-derived deadlines', () => {
	let savedEnv: string | undefined;

	setup(() => {
		savedEnv = process.env.VINV_PROBE_TIMEOUT_S;
		delete process.env.VINV_PROBE_TIMEOUT_S;
	});

	teardown(() => {
		if (savedEnv === undefined) {
			delete process.env.VINV_PROBE_TIMEOUT_S;
		} else {
			process.env.VINV_PROBE_TIMEOUT_S = savedEnv;
		}
	});

	test('no history falls back to the flat 10s prior', () => {
		assert.strictEqual(probeTimeoutMs(), 10_000);
		assert.strictEqual(probeTimeoutMs([]), 10_000);
	});

	test('history yields p99 × 20 (the tail sets the hang threshold)', () => {
		// p99 of [5, 7, 288] is 288 → 288 × 20 dominates 288 × 2.
		assert.strictEqual(probeTimeoutMs([7, 288, 5]), 288 * 20);
	});

	test('the floor is the slowest response × 2, not an absolute number', () => {
		// 101 samples of 10ms plus one 400ms outlier: p99 lands on a 10ms sample,
		// so p99×20 = 200 — the slowest×2 floor (800) must win, or a single slow
		// cold start would time out forever after.
		const history = [...Array.from({ length: 101 }, () => 10), 400];
		assert.strictEqual(probeTimeoutMs(history), 800);
	});

	test('non-positive and non-finite samples are ignored', () => {
		assert.strictEqual(probeTimeoutMs([0, -3, Number.NaN, Number.POSITIVE_INFINITY]), 10_000);
	});

	test('the env override always wins, history or not', () => {
		process.env.VINV_PROBE_TIMEOUT_S = '3';
		assert.strictEqual(probeTimeoutMs([7, 288, 5]), 3_000);
		assert.strictEqual(probeTimeoutMs(), 3_000);
	});
});

suite('persistedLatencyHistory: the endpoint joins its own records', () => {
	test('joins results.jsonl by METHOD+path and the probe file by id', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-probe-timeout-'));
		const exDir = path.join(root, '.vinv', 'exercise');
		fs.mkdirSync(exDir, { recursive: true });
		fs.writeFileSync(
			path.join(exDir, 'results.jsonl'),
			[
				JSON.stringify({ method: 'GET', path: '/api/v1/items/', latency_ms: 12.5 }),
				JSON.stringify({ method: 'GET', path: '/api/v1/items/', latency_ms: 288 }),
				JSON.stringify({ method: 'GET', path: '/other', latency_ms: 999 }),
				JSON.stringify({ method: 'GET', path: '/api/v1/items/' }), // no latency
				'{"torn',
			].join('\n'),
			'utf8',
		);
		const probeFile = probeFilePath(root, 'app');
		fs.mkdirSync(path.dirname(probeFile), { recursive: true });
		fs.writeFileSync(
			probeFile,
			JSON.stringify({
				version: 1,
				service: 'app',
				generatedAt: 'now',
				probes: [],
				lastRun: {
					probes: [
						{ id: 'abc', latencyMs: 30 },
						{ id: 'zzz', latencyMs: 555 },
					],
				},
			}),
			'utf8',
		);

		const history = persistedLatencyHistory(root, 'app', {
			id: 'abc',
			method: 'GET',
			path: '/api/v1/items/',
		});
		assert.deepStrictEqual([...history].sort((a, b) => a - b), [12.5, 30, 288]);
	});

	test('no artifacts at all yields an empty history (flat prior applies)', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-probe-timeout-'));
		const history = persistedLatencyHistory(root, 'app', {
			id: 'abc',
			method: 'GET',
			path: '/x',
		});
		assert.deepStrictEqual(history, []);
		assert.strictEqual(probeTimeoutMs(history), 10_000);
	});
});
