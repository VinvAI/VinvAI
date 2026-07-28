/**
 * The human end of configuration escalation.
 *
 * Everything reaching this panel has already survived the engine trying not to
 * need it: what the repo publishes, then induction from the target's own
 * failure. So the ways this can be wrong are not "it looks bad" — they are:
 *
 *  - an empty field written as a VALUE, satisfying a presence check and failing
 *    somewhere less obvious than where it would have failed honestly;
 *  - a secret echoed back into the panel model, a log, or a status line;
 *  - answers replaced rather than merged, losing what was answered yesterday;
 *  - an answer saved that nothing acts on, so the user presses save and the
 *    stall simply continues.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	buildAnswers,
	buildModel,
	getConfigPanelHtml,
	handlePanelMessage,
	readConfigRequests,
	writeAnswers,
	type ConfigPanelActions,
	type ConfigRequest,
} from '../views/configRequestPanel';

function request(variable: string, extra: Partial<ConfigRequest> = {}): ConfigRequest {
	return {
		variable,
		secret: false,
		description: `what ${variable} is`,
		example: null,
		blocked_modules: ['app.core.config'],
		blocked_count: 1,
		tried: ['vinv-placeholder'],
		reason: 'Field required',
		status: 'awaiting-user',
		...extra,
	};
}

function workspace(requests: ConfigRequest[] | null): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-cfgpanel-'));
	fs.mkdirSync(path.join(root, '.vinv', 'exercise'), { recursive: true });
	if (requests !== null) {
		fs.writeFileSync(
			path.join(root, '.vinv', 'exercise', 'config_requests.json'),
			JSON.stringify({ version: 1, requests }),
			'utf8',
		);
	}
	return root;
}

function readAnswers(root: string): Record<string, string> {
	const doc = JSON.parse(
		fs.readFileSync(path.join(root, '.vinv', 'exercise', 'config_answers.json'), 'utf8'),
	) as { answers?: Record<string, string> };
	return doc.answers ?? {};
}

suite('reading what is being asked', () => {
	test('requests are read from the engine artifact', () => {
		const root = workspace([request('PROJECT_NAME'), request('API_KEY', { secret: true })]);
		assert.deepStrictEqual(
			readConfigRequests(root).map((r) => r.variable),
			['PROJECT_NAME', 'API_KEY'],
		);
	});

	test('an absent artifact means nothing is being asked, not an error', () => {
		assert.deepStrictEqual(readConfigRequests(workspace(null)), []);
	});

	test('an empty request list clears the panel', () => {
		// The engine rewrites this file every run, including empty, so a stale
		// prompt for a variable that is now satisfied cannot persist.
		assert.deepStrictEqual(buildModel(workspace([])).requests, []);
	});

	test('a malformed artifact does not throw', () => {
		const root = workspace([]);
		fs.writeFileSync(
			path.join(root, '.vinv', 'exercise', 'config_requests.json'),
			'{ not json',
			'utf8',
		);
		assert.deepStrictEqual(readConfigRequests(root), []);
	});
});

suite('validating what was typed', () => {
	test('a blank field is not written as a value', () => {
		// An empty string IS a value: the engine would export it, satisfy the
		// presence check, and fail somewhere less obvious.
		const answers = buildAnswers([request('A'), request('B')], { A: '   ', B: 'real' });
		assert.deepStrictEqual(answers, { B: 'real' });
	});

	test('values are trimmed', () => {
		assert.deepStrictEqual(buildAnswers([request('A')], { A: '  x  ' }), { A: 'x' });
	});

	test('an answer for something not being asked is dropped', () => {
		assert.deepStrictEqual(buildAnswers([request('A')], { A: '1', SNEAKY: '2' }), { A: '1' });
	});
});

suite('persisting answers', () => {
	test('answers land where the engine reads them', () => {
		const root = workspace([request('PROJECT_NAME')]);
		assert.strictEqual(writeAnswers(root, { PROJECT_NAME: 'demo' }), 1);
		assert.deepStrictEqual(readAnswers(root), { PROJECT_NAME: 'demo' });
	});

	test('a later answer merges rather than replacing', () => {
		// Answering two variables today and one tomorrow must not lose the first.
		const root = workspace([request('A'), request('B')]);
		writeAnswers(root, { A: '1' });
		writeAnswers(root, { B: '2' });
		assert.deepStrictEqual(readAnswers(root), { A: '1', B: '2' });
	});

	test('re-answering a variable updates it', () => {
		const root = workspace([request('A')]);
		writeAnswers(root, { A: 'wrong' });
		writeAnswers(root, { A: 'right' });
		assert.deepStrictEqual(readAnswers(root), { A: 'right' });
	});
});

suite('the submit arm', () => {
	function actions(root: string, log: string[]): ConfigPanelActions {
		return {
			save: (answers) => writeAnswers(root, answers),
			rerun: async () => { log.push('rerun'); },
			showError: (m) => log.push(`error:${m}`),
		};
	}

	test('a filled form saves and re-runs', async () => {
		// Saving without re-running is the same stall in a different place.
		const root = workspace([request('A')]);
		const log: string[] = [];
		const outcome = await handlePanelMessage(
			{ type: 'submit', values: { A: 'x' } },
			[request('A')],
			actions(root, log),
		);
		assert.strictEqual(outcome.saved, 1);
		assert.strictEqual(outcome.reran, true);
		assert.deepStrictEqual(log, ['rerun']);
		assert.deepStrictEqual(readAnswers(root), { A: 'x' });
	});

	test('an entirely blank form re-runs nothing and says so', async () => {
		const root = workspace([request('A')]);
		const log: string[] = [];
		const outcome = await handlePanelMessage(
			{ type: 'submit', values: { A: '  ' } },
			[request('A')],
			actions(root, log),
		);
		assert.strictEqual(outcome.saved, 0);
		assert.strictEqual(outcome.reran, false);
		assert.ok(log[0].startsWith('error:'));
	});

	test('a failed write does not claim success and does not re-run', async () => {
		const log: string[] = [];
		const outcome = await handlePanelMessage({ type: 'submit', values: { A: 'x' } }, [request('A')], {
			save: () => { throw new Error('disk full'); },
			rerun: async () => { log.push('rerun'); },
			showError: (m) => log.push(`error:${m}`),
		});
		assert.strictEqual(outcome.saved, 0);
		assert.strictEqual(outcome.reran, false, 're-ran on answers that were never saved');
		assert.ok(log.some((l) => l.includes('disk full')));
	});

	test('an unknown message is ignored', async () => {
		const outcome = await handlePanelMessage({ type: 'noise' }, [request('A')], {
			save: () => { throw new Error('should not be called'); },
			rerun: async () => { throw new Error('should not be called'); },
			showError: () => { throw new Error('should not be called'); },
		});
		assert.deepStrictEqual(outcome, { saved: 0, reran: false });
	});
});

suite('the rendered form', () => {
	test('a secret renders as a masked field and is marked', () => {
		const html = getConfigPanelHtml('vscode-resource:', {
			requests: [request('OPENAI_API_KEY', { secret: true })],
			repoLabel: 'demo',
		});
		assert.match(html, /type="password"/);
		assert.match(html, /badge secret/);
	});

	test('a non-secret renders as a plain field', () => {
		const html = getConfigPanelHtml('vscode-resource:', {
			requests: [request('PROJECT_NAME')],
			repoLabel: 'demo',
		});
		assert.match(html, /type="text"/);
		assert.doesNotMatch(html, /type="password"/);
	});

	test('the description, example and blocked modules are shown', () => {
		const html = getConfigPanelHtml('vscode-resource:', {
			requests: [
				request('POSTGRES_SERVER', {
					description: 'Database host the app connects to.',
					example: 'localhost',
					blocked_modules: ['app.core.db'],
					blocked_count: 2,
				}),
			],
			repoLabel: 'demo',
		});
		assert.match(html, /Database host the app connects to\./);
		assert.match(html, /localhost/);
		assert.match(html, /blocks 2 modules/);
		assert.match(html, /app\.core\.db/);
	});

	test('html in a value cannot break out of the markup', () => {
		const html = getConfigPanelHtml('vscode-resource:', {
			requests: [request('X', { description: '<img src=x onerror=alert(1)>' })],
			repoLabel: 'demo',
		});
		assert.doesNotMatch(html, /<img src=x/);
		assert.match(html, /&lt;img src=x/);
	});

	test('nothing to configure renders an explanation, not an empty form', () => {
		const html = getConfigPanelHtml('vscode-resource:', { requests: [], repoLabel: 'demo' });
		assert.match(html, /Nothing to configure/);
		assert.doesNotMatch(html, /<form/);
	});

	test('the csp source is honoured', () => {
		const html = getConfigPanelHtml('vscode-resource://abc', { requests: [], repoLabel: 'd' });
		assert.match(html, /Content-Security-Policy/);
		assert.match(html, /vscode-resource:\/\/abc/);
	});
});
