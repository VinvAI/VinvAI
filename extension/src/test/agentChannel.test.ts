/**
 * The consumer that never existed.
 *
 * `exerciser/agent_loop.py` describes its transport as "the extension (or any
 * agent) dispatches them and writes back a verdict". A grep of `extension/src`
 * for `agent_*.json` returned nothing, so every question the fault, fixture and
 * config oracles ever raised was written to disk and left there — the engine
 * side complete and inert.
 *
 * These tests are built around the ways a dispatcher could be worse than no
 * dispatcher at all:
 *
 *  - it clears the queue with fabricated answers when the harness fails, so an
 *    oracle proceeds on invented data believing it was told;
 *  - it overwrites an answer a human corrected with a later model's guess;
 *  - it re-asks what is already answered, so the permanent cache buys nothing;
 *  - it runs the harness when there is nothing to ask.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	applyAnswers,
	buildPrompt,
	drainAgentChannels,
	parseAnswers,
	pendingQuestions,
	readChannels,
} from '../harness/agentChannel';

function makeWorkspace(channels: Record<string, unknown>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-channel-'));
	const dir = path.join(root, '.vinv', 'exercise');
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, doc] of Object.entries(channels)) {
		fs.writeFileSync(path.join(dir, name), JSON.stringify(doc, null, 2), 'utf8');
	}
	return root;
}

function question(key: string, topic: string, extra: Record<string, unknown> = {}) {
	return {
		key,
		topic,
		subject: `subject-${key}`,
		prompt: `what is ${key}?`,
		reply_schema: '{"value": "<string>"}',
		context: { variable: key },
		answer: null,
		...extra,
	};
}

suite('agent channel dispatch', () => {
	test('every topic is read through one dispatcher', () => {
		const root = makeWorkspace({
			'agent_config.json': { topic: 'config', questions: { a: question('a', 'config') } },
			'agent_contract.json': { topic: 'contract', questions: { b: question('b', 'contract') } },
			'agent_fixture.json': { topic: 'fixture', questions: { c: question('c', 'fixture') } },
			'functions.json': { status: 'ok' },
		});
		const channels = readChannels(root);
		assert.deepStrictEqual(
			channels.map((c) => c.topic).sort(),
			['config', 'contract', 'fixture'],
		);
		assert.strictEqual(pendingQuestions(channels).length, 3);
	});

	test('an answered question is not pending', () => {
		const root = makeWorkspace({
			'agent_config.json': {
				topic: 'config',
				questions: {
					a: question('a', 'config', { answer: { value: 'x' } }),
					b: question('b', 'config'),
				},
			},
		});
		assert.deepStrictEqual(
			pendingQuestions(readChannels(root)).map((q) => q.key),
			['b'],
		);
	});

	test('a falsy answer still counts as answered', () => {
		// `false` and `0` are legitimate replies; only null/absent mean unanswered.
		const root = makeWorkspace({
			'agent_contract.json': {
				topic: 'contract',
				questions: {
					a: question('a', 'contract', { answer: false }),
					b: question('b', 'contract', { answer: 0 }),
				},
			},
		});
		assert.strictEqual(pendingQuestions(readChannels(root)).length, 0);
	});

	test('a malformed channel file is skipped, not fatal', () => {
		const root = makeWorkspace({
			'agent_config.json': { topic: 'config', questions: { a: question('a', 'config') } },
		});
		fs.writeFileSync(
			path.join(root, '.vinv', 'exercise', 'agent_broken.json'),
			'{ half-written',
			'utf8',
		);
		const channels = readChannels(root);
		assert.strictEqual(channels.length, 1);
		assert.strictEqual(channels[0].topic, 'config');
	});

	test('a workspace with no channels yields nothing', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-empty-'));
		assert.deepStrictEqual(readChannels(root), []);
	});
});

suite('reply parsing', () => {
	test('a fenced reply is read', () => {
		const answers = parseAnswers('Sure!\n```json\n{"answers": {"a": {"value": "x"}}}\n```\n');
		assert.deepStrictEqual(answers, { a: { value: 'x' } });
	});

	test('a bare reply is read', () => {
		assert.deepStrictEqual(parseAnswers('{"answers": {"a": 1}}'), { a: 1 });
	});

	test('nested objects do not truncate the parse', () => {
		const answers = parseAnswers(
			'{"answers": {"a": {"value": {"deep": [1, 2]}, "is_secret": false}}}',
		);
		assert.deepStrictEqual(answers, { a: { value: { deep: [1, 2] }, is_secret: false } });
	});

	test('a brace inside a string does not truncate the parse', () => {
		const answers = parseAnswers('{"answers": {"a": {"value": "a } brace"}}}');
		assert.deepStrictEqual(answers, { a: { value: 'a } brace' } });
	});

	test('prose with no json yields nothing rather than throwing', () => {
		assert.deepStrictEqual(parseAnswers("I couldn't determine these."), {});
		assert.deepStrictEqual(parseAnswers(''), {});
	});

	test('an object without an answers key is not mistaken for one', () => {
		assert.deepStrictEqual(parseAnswers('{"value": "x"}'), {});
	});
});

suite('writing answers back', () => {
	test('answers land in the file the question came from', () => {
		const root = makeWorkspace({
			'agent_config.json': { topic: 'config', questions: { a: question('a', 'config') } },
		});
		const channels = readChannels(root);
		assert.strictEqual(applyAnswers(channels, { a: { value: 'eu-west-2' } }), 1);

		const doc = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'exercise', 'agent_config.json'), 'utf8'),
		);
		assert.deepStrictEqual(doc.questions.a.answer, { value: 'eu-west-2' });
	});

	test('an existing answer is never overwritten', () => {
		// The engine caches permanently and a human may have corrected one. A
		// later model run must not silently undo that.
		const root = makeWorkspace({
			'agent_config.json': {
				topic: 'config',
				questions: { a: question('a', 'config', { answer: { value: 'human-said-this' } }) },
			},
		});
		const channels = readChannels(root);
		assert.strictEqual(applyAnswers(channels, { a: { value: 'model-guess' } }), 0);

		const doc = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'exercise', 'agent_config.json'), 'utf8'),
		);
		assert.deepStrictEqual(doc.questions.a.answer, { value: 'human-said-this' });
	});

	test('an answer for an unknown id is ignored', () => {
		const root = makeWorkspace({
			'agent_config.json': { topic: 'config', questions: { a: question('a', 'config') } },
		});
		assert.strictEqual(applyAnswers(readChannels(root), { nope: 1 }), 0);
	});
});

suite('draining end to end', () => {
	test('an empty queue runs no harness at all', async () => {
		const root = makeWorkspace({
			'agent_config.json': {
				topic: 'config',
				questions: { a: question('a', 'config', { answer: { value: 'x' } }) },
			},
		});
		let ran = false;
		const report = await drainAgentChannels(root, async () => {
			ran = true;
			return { ok: true, stdout: '' };
		});
		assert.strictEqual(ran, false, 'the harness was run with nothing to ask');
		assert.strictEqual(report.pending, 0);
		assert.strictEqual(report.ok, true);
	});

	test('pending questions are answered and reported', async () => {
		const root = makeWorkspace({
			'agent_config.json': { topic: 'config', questions: { a: question('a', 'config') } },
			'agent_contract.json': { topic: 'contract', questions: { b: question('b', 'contract') } },
		});
		const report = await drainAgentChannels(root, async () => ({
			ok: true,
			stdout: '{"answers": {"a": {"value": "x"}, "b": {"content": "str"}}}',
		}));
		assert.strictEqual(report.answered, 2);
		assert.deepStrictEqual(report.topics, ['config', 'contract']);
		assert.strictEqual(pendingQuestions(readChannels(root)).length, 0);
	});

	test('every pending question goes in ONE run', async () => {
		const questions: Record<string, unknown> = {};
		for (const key of ['a', 'b', 'c', 'd']) {questions[key] = question(key, 'config');}
		const root = makeWorkspace({ 'agent_config.json': { topic: 'config', questions } });

		let runs = 0;
		await drainAgentChannels(root, async () => {
			runs++;
			return { ok: true, stdout: '{"answers": {}}' };
		});
		assert.strictEqual(runs, 1, 'a run per question is a bill that grows with the repo');
	});

	test('a failed harness leaves the queue pending and says why', async () => {
		const root = makeWorkspace({
			'agent_config.json': { topic: 'config', questions: { a: question('a', 'config') } },
		});
		const report = await drainAgentChannels(root, async () => ({
			ok: false,
			stdout: '',
			detail: 'cursor-agent is not signed in',
		}));

		assert.strictEqual(report.answered, 0);
		assert.strictEqual(report.ok, false);
		assert.match(report.detail, /not signed in/);
		// The crucial part: nothing was invented to clear the queue.
		assert.strictEqual(pendingQuestions(readChannels(root)).length, 1);
	});

	test('an unusable reply leaves the queue pending and says so', async () => {
		const root = makeWorkspace({
			'agent_config.json': { topic: 'config', questions: { a: question('a', 'config') } },
		});
		const report = await drainAgentChannels(root, async () => ({
			ok: true,
			stdout: "I don't know.",
		}));
		assert.strictEqual(report.answered, 0);
		assert.strictEqual(report.ok, false);
		assert.match(report.detail, /nothing usable/);
		assert.strictEqual(pendingQuestions(readChannels(root)).length, 1);
	});

	test('a partially answered batch keeps the rest pending', async () => {
		const root = makeWorkspace({
			'agent_config.json': {
				topic: 'config',
				questions: { a: question('a', 'config'), b: question('b', 'config') },
			},
		});
		await drainAgentChannels(root, async () => ({
			ok: true,
			stdout: '{"answers": {"a": {"value": "x"}}}',
		}));
		assert.deepStrictEqual(
			pendingQuestions(readChannels(root)).map((q) => q.key),
			['b'],
		);
	});
});

suite('the prompt', () => {
	test('it carries each question id, prompt and reply shape', () => {
		const prompt = buildPrompt([question('k1', 'config'), question('k2', 'contract')]);
		assert.ok(prompt.includes('k1') && prompt.includes('k2'));
		assert.ok(prompt.includes('what is k1?'));
		assert.ok(prompt.includes('{"value": "<string>"}'));
		assert.ok(prompt.includes('{"answers"'), 'the reply envelope must be stated');
	});

	test('it forbids guessing and forbids inventing credentials', () => {
		const prompt = buildPrompt([question('k1', 'config')]);
		assert.match(prompt, /omit its id entirely rather than guessing/);
		assert.match(prompt, /Never invent a credential/);
	});
});
