/**
 * Tests for finding triage: the verdict sidecar, the batch judge, and the
 * one-way safety rule — an unjudged or unjudgeable finding is always SHOWN.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { asFindingVerdicts, type AgentSpawn } from '../harness/binaryAgents';
import {
	isHiddenFinding,
	isPendingFinding,
	judgeFindings,
	readVerdicts,
	verdictStorePath,
	writeVerdicts,
	type JudgeableFinding,
} from '../harness/findingVerification';

function tmpRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-verdicts-'));
	fs.mkdirSync(path.join(root, '.vinv', 'exercise'), { recursive: true });
	return root;
}

const FINDINGS: JudgeableFinding[] = [
	{ signature: 'sig-a', kind: 'http_5xx', title: 'GET /orders 500', evidence: 'TypeError' },
	{ signature: 'sig-b', kind: 'http_4xx', title: 'GET /me 401', evidence: 'no token' },
];

/** The transport is stubbed out: these tests cover batching, not the spawn path. */
const SPAWN: AgentSpawn = {
	binPath: process.execPath,
	env: {},
	cwd: os.tmpdir(),
	dispatch: () => Promise.resolve(null),
};

/** A `run` that answers with one parsed reply, as runGoalAgent would. */
function replying(raw: Record<string, unknown> | null) {
	return () => Promise.resolve(raw);
}

suite('finding verification — verdict store', () => {
	test('a missing or corrupt sidecar reads as empty, never throws', () => {
		const root = tmpRepo();
		assert.deepStrictEqual(readVerdicts(root), {});
		fs.writeFileSync(verdictStorePath(root), '{not json', 'utf8');
		assert.deepStrictEqual(readVerdicts(root), {});
		fs.writeFileSync(verdictStorePath(root), '[]', 'utf8');
		assert.deepStrictEqual(readVerdicts(root), {});
	});

	test('verdicts round-trip and merge without losing earlier ones', () => {
		const root = tmpRepo();
		writeVerdicts(root, {
			'sig-a': { verdict: 'real', confidence: 0.9, reason: 'r', verified_at: 't', harness: 'h' },
		});
		writeVerdicts(root, {
			'sig-b': { verdict: 'false_positive', confidence: 0.8, reason: 'd', verified_at: 't', harness: 'h' },
		});
		const store = readVerdicts(root);
		assert.strictEqual(store['sig-a'].verdict, 'real');
		assert.strictEqual(store['sig-b'].verdict, 'false_positive');
	});

	test('only a false_positive hides; unjudged and real are shown', () => {
		const store = readVerdicts(tmpRepo());
		assert.strictEqual(isPendingFinding(store, 'sig-a'), true);
		assert.strictEqual(isHiddenFinding(store, 'sig-a'), false);
		const judged = {
			'sig-a': { verdict: 'false_positive' as const, confidence: 1, reason: '', verified_at: '', harness: '' },
			'sig-b': { verdict: 'real' as const, confidence: 1, reason: '', verified_at: '', harness: '' },
		};
		assert.strictEqual(isHiddenFinding(judged, 'sig-a'), true);
		assert.strictEqual(isHiddenFinding(judged, 'sig-b'), false);
		assert.strictEqual(isPendingFinding(judged, 'sig-b'), false);
	});

	test('an unsigned finding is never hidden', () => {
		assert.strictEqual(isPendingFinding({}, ''), false);
		assert.strictEqual(isHiddenFinding({}, ''), false);
	});
});

suite('finding verification — reply contract', () => {
	test('a malformed entry is dropped rather than defaulted', () => {
		const out = asFindingVerdicts({
			verdicts: [
				{ id: 'a', verdict: 'real', confidence: 0.5, reason: 'ok' },
				{ id: 'b', verdict: 'maybe', confidence: 1, reason: 'bad verdict' },
				{ id: '', verdict: 'false_positive', confidence: 1, reason: 'no id' },
				'not an object',
			],
		});
		assert.strictEqual(out?.length, 1);
		assert.strictEqual(out?.[0].id, 'a');
	});

	test('confidence is clamped, and a non-numeric one does not become a verdict', () => {
		const out = asFindingVerdicts({
			verdicts: [
				{ id: 'a', verdict: 'real', confidence: 4, reason: '' },
				{ id: 'b', verdict: 'real', confidence: 'high', reason: '' },
			],
		});
		assert.strictEqual(out?.[0].confidence, 1);
		assert.strictEqual(out?.[1].confidence, 0);
	});

	test('a reply with no verdicts array is null, not an empty result', () => {
		assert.strictEqual(asFindingVerdicts(null), null);
		assert.strictEqual(asFindingVerdicts({ verdicts: 'nope' }), null);
	});
});

suite('finding verification — judging a batch', () => {
	test('verdicts come back keyed by signature, stamped with the harness', async () => {
		const out = await judgeFindings(SPAWN, 'claude', FINDINGS, replying({
			verdicts: [
				{ id: 'sig-a', verdict: 'real', confidence: 0.9, reason: 'unhandled TypeError' },
				{ id: 'sig-b', verdict: 'false_positive', confidence: 0.8, reason: 'documented 401' },
			],
		}));
		assert.strictEqual(out?.['sig-a'].verdict, 'real');
		assert.strictEqual(out?.['sig-b'].verdict, 'false_positive');
		assert.strictEqual(out?.['sig-b'].harness, 'claude');
		assert.ok(out?.['sig-a'].verified_at.length > 0);
	});

	test('a verdict for an id that was not in the batch is refused', async () => {
		const out = await judgeFindings(SPAWN, 'claude', FINDINGS, replying({
			verdicts: [{ id: 'sig-never-asked', verdict: 'false_positive', confidence: 1, reason: '' }],
		}));
		assert.deepStrictEqual(out, {});
	});

	test('an unreachable judge yields null, so nothing is hidden', async () => {
		assert.strictEqual(await judgeFindings(SPAWN, 'claude', FINDINGS, replying(null)), null);
	});

	test('a malformed reply yields null, so nothing is hidden', async () => {
		// A reply that parsed to an object but carries no verdicts array.
		assert.strictEqual(
			await judgeFindings(SPAWN, 'claude', FINDINGS, replying({ note: 'they look fine' })),
			null,
		);
	});

	test('an empty batch is "nothing to do", distinct from unavailable', async () => {
		assert.deepStrictEqual(await judgeFindings(SPAWN, 'claude', [], replying(null)), {});
		assert.deepStrictEqual(
			await judgeFindings(SPAWN, 'claude', [{ signature: '  ', kind: 'k', title: 't', evidence: '' }], replying(null)),
			{},
		);
	});
});
