/**
 * Golden I/O baseline tests — the input/output regression map:
 *  - response shape hashing (structure, not values),
 *  - baseline record/compare semantics (degraded / same / improved / recorded),
 *  - the ratchet (improvement re-records, degradation never does),
 *  - the real HTTP capture path against a stub server (probeRunner.httpProbe).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
	applyBaselines,
	baselineFilePath,
	compareObservation,
	jsonShapeSignature,
	readBaseline,
	responseShapeHash,
	statusClassOf,
	type BaselineEntry,
	type ObservedResponse,
} from '../harness/probeBaseline';
import { httpProbe, type ProbeSpec } from '../harness/probeRunner';

function observed(over: Partial<ObservedResponse> = {}): ObservedResponse {
	return {
		probeId: 'p1',
		endpointId: 'GET /users',
		method: 'GET',
		path: '/users/7',
		httpStatus: 200,
		handler: 'app.get_user',
		shapeHash: 'json:aaaa',
		...over,
	};
}

function golden(over: Partial<BaselineEntry> = {}): BaselineEntry {
	return {
		probeId: 'p1',
		method: 'GET',
		path: '/users/7',
		statusClass: '2xx-3xx',
		httpStatus: 200,
		handler: 'app.get_user',
		shapeHash: 'json:aaaa',
		capturedAt: '2026-01-01T00:00:00Z',
		...over,
	};
}

suite('Response shape hashing', () => {
	test('values are erased: same structure, different values → same hash', () => {
		const a = responseShapeHash('{"id": 1, "name": "alice", "tags": ["x"]}', 'application/json');
		const b = responseShapeHash('{"name": "bob", "id": 999, "tags": ["y", "z"]}', 'application/json');
		assert.strictEqual(a, b, 'key order and values must not churn the hash');
		assert.ok(a.startsWith('json:'));
	});

	test('a dropped field or a type change changes the hash', () => {
		const base = responseShapeHash('{"id": 1, "name": "a"}', 'application/json');
		assert.notStrictEqual(base, responseShapeHash('{"id": 1}', 'application/json'));
		assert.notStrictEqual(base, responseShapeHash('{"id": "1", "name": "a"}', 'application/json'));
	});

	test('arrays collapse to their element-shape union (row count irrelevant)', () => {
		assert.strictEqual(jsonShapeSignature([{ a: 1 }, { a: 2 }, { a: 3 }]), '[{a:number}]');
		assert.strictEqual(jsonShapeSignature([]), '[]');
		assert.strictEqual(jsonShapeSignature([1, 'x']), '[number|string]');
	});

	test('non-JSON bodies hash to their content-type class; empty is empty', () => {
		assert.strictEqual(responseShapeHash('<html></html>', 'text/html; charset=utf-8'), 'raw:text/html');
		assert.strictEqual(responseShapeHash('', 'application/json'), 'empty');
		// A json content-type with an unparsable body degrades to the raw class.
		assert.strictEqual(responseShapeHash('not json {', 'application/json'), 'raw:application/json');
	});
});

suite('Baseline comparison semantics', () => {
	test('status classes rank: 2xx-3xx > 4xx > 5xx > no-response', () => {
		assert.strictEqual(statusClassOf(204), '2xx-3xx');
		assert.strictEqual(statusClassOf(301), '2xx-3xx');
		assert.strictEqual(statusClassOf(404), '4xx');
		assert.strictEqual(statusClassOf(503), '5xx');
		assert.strictEqual(statusClassOf(null), 'no-response');
	});

	test('a worsened status class is degraded; an improved one is improved', () => {
		assert.strictEqual(compareObservation(golden(), observed({ httpStatus: 500 })).verdict, 'degraded');
		assert.strictEqual(compareObservation(golden(), observed({ httpStatus: null })).verdict, 'degraded');
		const up = compareObservation(
			golden({ statusClass: '5xx', httpStatus: 500 }),
			observed({ httpStatus: 200 }),
		);
		assert.strictEqual(up.verdict, 'improved');
	});

	test('same class, changed response STRUCTURE on a healthy endpoint = degraded', () => {
		const cmp = compareObservation(golden(), observed({ shapeHash: 'json:bbbb' }));
		assert.strictEqual(cmp.verdict, 'degraded');
		assert.ok(cmp.detail?.includes('shape changed'));
		// On an already-failing baseline the shape is not part of the contract.
		const failing = compareObservation(
			golden({ statusClass: '4xx', httpStatus: 404 }),
			observed({ httpStatus: 404, shapeHash: 'json:bbbb' }),
		);
		assert.strictEqual(failing.verdict, 'same');
	});

	test('identical observation is same', () => {
		assert.strictEqual(compareObservation(golden(), observed()).verdict, 'same');
	});
});

suite('Baseline persistence and the ratchet', () => {
	test('first healthy run records; a failing first observation stays unbaselined', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-baseline-'));
		try {
			const verdicts = applyBaselines(root, [
				observed(),
				observed({ probeId: 'p2', path: '/broken', httpStatus: 500 }),
			]);
			assert.strictEqual(verdicts.get('p1')?.verdict, 'recorded');
			assert.strictEqual(verdicts.get('p2'), undefined, 'broken responses never seed a golden');
			const file = readBaseline(root, 'GET /users');
			assert.ok(file && file.entries.p1);
			assert.strictEqual(file?.entries.p2, undefined);
			// File lands at the api-id path with unsafe characters sanitized.
			assert.ok(fs.existsSync(baselineFilePath(root, 'GET /users')));
			assert.ok(baselineFilePath(root, 'GET /users').endsWith('GET__users.json'));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('re-runs compare: same → same, regression → degraded (baseline untouched)', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-baseline-'));
		try {
			applyBaselines(root, [observed()]);
			assert.strictEqual(applyBaselines(root, [observed()]).get('p1')?.verdict, 'same');
			const degraded = applyBaselines(root, [observed({ httpStatus: 500 })]);
			assert.strictEqual(degraded.get('p1')?.verdict, 'degraded');
			// The golden entry survives the degradation — a broken run must never
			// redefine the contract it just broke.
			assert.strictEqual(readBaseline(root, 'GET /users')?.entries.p1.statusClass, '2xx-3xx');
			assert.strictEqual(applyBaselines(root, [observed()]).get('p1')?.verdict, 'same');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('the ratchet: an improved run upgrades the baseline in place', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-baseline-'));
		try {
			// Seed a baseline, then hand-degrade it to a failing class (as if the
			// endpoint was first observed healthy, later baselined while broken).
			applyBaselines(root, [observed()]);
			const file = readBaseline(root, 'GET /users');
			assert.ok(file);
			file.entries.p1.statusClass = '5xx';
			file.entries.p1.httpStatus = 500;
			fs.writeFileSync(baselineFilePath(root, 'GET /users'), JSON.stringify(file));
			const verdicts = applyBaselines(root, [observed()]);
			assert.strictEqual(verdicts.get('p1')?.verdict, 'improved');
			// The next run compares against the upgraded (healthy) contract.
			assert.strictEqual(readBaseline(root, 'GET /users')?.entries.p1.statusClass, '2xx-3xx');
			assert.strictEqual(applyBaselines(root, [observed()]).get('p1')?.verdict, 'same');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

// ---- the real HTTP capture path (stub server) -------------------------------

function spec(over: Partial<ProbeSpec> = {}): ProbeSpec {
	return {
		id: 'p1',
		endpointId: 'GET /users',
		method: 'GET',
		path: '/users/7',
		expected: { statusClass: '2xx-3xx', handler: 'app.get_user', noServerError: true },
		status: 'ready',
		source: 'trace',
		...over,
	};
}

suite('httpProbe shape capture against a stub server', () => {
	test('captures status and a structural hash; values do not churn it', async function () {
		this.timeout(10_000);
		let payload = { id: 1, name: 'alice' };
		let status = 200;
		const server = http.createServer((_req, res) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		try {
			const first = await httpProbe(port, spec());
			assert.strictEqual(first.status, 200);
			assert.ok(first.shapeHash.startsWith('json:'));
			// Same structure, different values → identical shape hash.
			payload = { id: 42, name: 'bob' };
			const second = await httpProbe(port, spec());
			assert.strictEqual(second.shapeHash, first.shapeHash);
			// Structural change → different hash; status change → captured.
			(payload as Record<string, unknown>).extra = true;
			status = 500;
			const third = await httpProbe(port, spec());
			assert.strictEqual(third.status, 500);
			assert.notStrictEqual(third.shapeHash, first.shapeHash);
		} finally {
			server.close();
		}
	});

	test('end-to-end regression loop: record golden, then flag the degradation', async function () {
		this.timeout(10_000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-baseline-e2e-'));
		let healthy = true;
		const server = http.createServer((_req, res) => {
			if (healthy) {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end('{"items": [{"id": 1}], "total": 1}');
			} else {
				// The "optimized" handler dropped a field — same status, new shape.
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end('{"items": [{"id": 1}]}');
			}
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		try {
			const toObservation = async (): Promise<ObservedResponse> => {
				const res = await httpProbe(port, spec());
				return {
					probeId: 'p1',
					endpointId: 'GET /users',
					method: 'GET',
					path: '/users/7',
					httpStatus: res.status,
					handler: 'app.get_user',
					shapeHash: res.shapeHash,
				};
			};
			assert.strictEqual(
				applyBaselines(root, [await toObservation()]).get('p1')?.verdict,
				'recorded',
			);
			healthy = false;
			const after = applyBaselines(root, [await toObservation()]).get('p1');
			assert.strictEqual(after?.verdict, 'degraded');
			assert.ok(after?.detail?.includes('shape changed'));
		} finally {
			server.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
