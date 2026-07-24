/**
 * Journey view: data assembly from .vinv artifacts, user-authored input plans
 * (including expiry revival), and webview message routing.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildJourney, appendUserPlan } from '../views/journeyModel';
import { handleJourneyMessage, type JourneyActions } from '../views/journeyView';

function tmpRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-journey-'));
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

function seedRepo(root: string): void {
	write(root, '.vinv/services.json', {
		services: [{ name: 'app', kind: 'python_web', port: 8000, command: 'fastapi run' }],
	});
	write(root, '.vinv/exercise/plan.json', {
		endpoints: [
			{ api_id: 'POST_users_signup', method: 'POST', path: '/users/signup', handler: 'register_user' },
			{ api_id: 'GET_health', method: 'GET', path: '/health', handler: 'health' },
		],
	});
	write(root, '.vinv/exercise/scorecard.json', {
		coverage: {
			after_exercised: {
				endpoints_with_coverage: 1, endpoints_total: 2,
				symbols_covered: 4, symbols_total: 8,
			},
		},
		scenarios: { run: 1, completed: 1, expired: [] },
		state_pollution: { created: 2, cleaned: 1, uncleaned: 1 },
		issues: [{ kind: 'server-error', title: 'POST /x — HTTP 500' }],
		endpoints: [
			{
				endpoint: 'POST /users/signup', coverage: '4/4', pct: 100,
				handler_observed: true, p50_ms: 2.1, p95_ms: 8.8,
				invariants: 1, statuses: { '200': 2, '400': 8 },
			},
		],
	});
	write(root, '.vinv/reports/calltree-POST_users_signup.json', {
		apiId: 'POST_users_signup',
		tree: {
			name: 'register_user', file: 'app/api.py', line: 146,
			runtime: { executed: true, calls: 10, total_ms: 150.2, error: 8 },
			children: [{ call: 'HTTPException', resolved: false }],
		},
	});
	write(
		root,
		'.vinv/exercise/results.jsonl',
		[
			JSON.stringify({
				api_id: 'POST_users_signup', strategy: 'schema_valid', input_class: 'valid',
				status: 200, latency_ms: 3.2, auth: false,
				input: { body: { email: 'a@x.test' } }, body: { id: 'u1' },
			}),
			JSON.stringify({
				api_id: 'POST_users_signup', strategy: 'authed', input_class: 'authed_valid',
				status: 400, latency_ms: 2.0, auth: true,
				input: { body: { email: 'a@x.test' } }, body: { detail: 'exists' },
			}),
			'{"torn json',
		].join('\n'),
	);
}

suite('journey: data assembly', () => {
	test('assembles services, coverage, and ordered endpoint steps', () => {
		const root = tmpRepo();
		seedRepo(root);
		const j = buildJourney(root);

		assert.strictEqual(j.services.length, 1);
		assert.strictEqual(j.services[0].name, 'app');
		assert.deepStrictEqual(
			j.steps.map((s) => s.apiId),
			['GET_health', 'POST_users_signup'], // path-sorted walk order
		);
		assert.strictEqual(j.coverage.symbolsCovered, 4);
		assert.strictEqual(j.issues.length, 1);

		const signup = j.steps[1];
		assert.strictEqual(signup.coverage.covered, 4);
		assert.strictEqual(signup.handlerObserved, true);
		assert.ok(signup.tree, 'call-tree snapshot attached');
		// IO rows: newest first, torn line tolerated, auth flag carried.
		assert.strictEqual(signup.io.length, 2);
		assert.strictEqual(signup.io[0].auth, true);
		assert.strictEqual(signup.io[0].status, 400);
		assert.ok(signup.io[0].input.includes('a@x.test'));
	});

	test('missing artifacts degrade to empty sections, never throw', () => {
		const j = buildJourney(tmpRepo());
		assert.deepStrictEqual(j.steps, []);
		assert.strictEqual(j.services.length, 0);
	});
});

suite('journey: user-authored input plans', () => {
	test('creates the prompt file and appends to reply.plans', () => {
		const root = tmpRepo();
		const n1 = appendUserPlan(root, 'GET_health', 'GET /health', {
			inputs: { query: { verbose: true } },
		});
		assert.strictEqual(n1, 1);
		const n2 = appendUserPlan(root, 'GET_health', 'GET /health', {
			inputs: { query: { verbose: false } },
			expect: { status: 200 },
		});
		assert.strictEqual(n2, 2);
		const doc = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv/exercise/prompts/GET_health.json'), 'utf8'),
		);
		assert.strictEqual(doc.reply.plans.length, 2);
		assert.strictEqual(doc.reply.plans[0].user_authored, true);
		assert.strictEqual(doc.reply.plans[1].expect.status, 200);
	});

	test('adding an input revives an expired reply (flags cleared)', () => {
		const root = tmpRepo();
		write(root, '.vinv/exercise/prompts/POST_x.json', {
			api_id: 'POST_x',
			reply: { plans: [{ endpoint: 'POST /x', inputs: {} }] },
			reply_expired: 'setup step POST /login got 400',
			reply_expired_for: 'deadbeef',
		});
		appendUserPlan(root, 'POST_x', 'POST /x', { inputs: { body: { a: 1 } } });
		const doc = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv/exercise/prompts/POST_x.json'), 'utf8'),
		);
		assert.strictEqual(doc.reply_expired, undefined);
		assert.strictEqual(doc.reply_expired_for, undefined);
		assert.strictEqual(doc.reply.plans.length, 2);
	});

	test('rejects malformed plans and hostile ids with actionable messages', () => {
		const root = tmpRepo();
		assert.throws(
			() => appendUserPlan(root, 'GET_health', 'GET /health', {} as never),
			/inputs/,
		);
		assert.throws(
			() => appendUserPlan(root, '../escape', 'GET /health', { inputs: {} }),
			/Invalid endpoint id/,
		);
	});
});

suite('journey: message routing', () => {
	function acts(): { a: JourneyActions; log: string[] } {
		const log: string[] = [];
		return {
			log,
			a: {
				openSource: async (f, l) => void log.push(`open:${f}:${l}`),
				addInput: async (id) => {
					if (id === 'BAD') {
						throw new Error('A plan needs an "inputs" object');
					}
					log.push(`add:${id}`);
					return 3;
				},
				refresh: async () => void log.push('refresh'),
				notify: (m, err) => void log.push(`${err ? 'err' : 'info'}:${m.slice(0, 30)}`),
			},
		};
	}

	test('addInput persists, notifies, and refreshes', async () => {
		const { a, log } = acts();
		await handleJourneyMessage(
			{ type: 'addInput', apiId: 'GET_health', endpoint: 'GET /health', plan: { inputs: {} } },
			a,
		);
		assert.deepStrictEqual(log, ['add:GET_health', 'info:Input added (3 authored plans ', 'refresh']);
	});

	test('addInput validation failure surfaces verbatim, no refresh', async () => {
		const { a, log } = acts();
		await handleJourneyMessage(
			{ type: 'addInput', apiId: 'BAD', plan: { inputs: {} } },
			a,
		);
		assert.deepStrictEqual(log, ['err:A plan needs an "inputs" objec']);
	});

	test('openSource and refresh route through', async () => {
		const { a, log } = acts();
		await handleJourneyMessage({ type: 'openSource', file: 'a.py', line: 7 }, a);
		await handleJourneyMessage({ type: 'refresh' }, a);
		assert.deepStrictEqual(log, ['open:a.py:7', 'refresh']);
	});
});
