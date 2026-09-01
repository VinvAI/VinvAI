import * as assert from 'assert';
import * as fs from 'fs';
import { parseNotices, selectNotice, versionSatisfies } from '../notices/notices';

suite('staged notices.json payload', () => {
	const raw = fs.readFileSync('.github/assets/notices.json', 'utf8');

	test('it survives the extension parser intact', () => {
		const parsed = parseNotices(raw);
		assert.strictEqual(parsed.length, 1);
		const n = parsed[0];
		const source = JSON.parse(raw).notices[0];
		// Silent truncation is the trap: text() slices at MAX_BODY (300) with no
		// error, so an over-long body ships cut mid-sentence.
		assert.strictEqual(n.body, source.body, 'body was truncated by the parser');
		assert.strictEqual(n.title, source.title, 'title was truncated by the parser');
		assert.strictEqual(n.actions.length, 2);
	});

	test('it reaches every version below 0.2.13 and nobody above', () => {
		for (const v of ['0.1.5', '0.2.0', '0.2.11', '0.2.12']) {
			assert.ok(versionSatisfies(v, '<0.2.13'), `${v} should be targeted`);
		}
		for (const v of ['0.2.13', '0.3.0', '1.0.0']) {
			assert.ok(!versionSatisfies(v, '<0.2.13'), `${v} must not be targeted`);
		}
	});

	test('a 0.2.12 user actually gets it, and only once', () => {
		const notices = parseNotices(raw);
		const now = Date.parse('2026-09-02T00:00:00Z');
		const chosen = selectNotice({ notices, version: '0.2.12', seenIds: [], now });
		assert.ok(chosen, 'a 0.2.12 user must be shown the notice');
		assert.strictEqual(
			selectNotice({ notices, version: '0.2.12', seenIds: [chosen.id], now }),
			null,
			'a seen notice must not repeat',
		);
	});

	test('it has not expired', () => {
		const notices = parseNotices(raw);
		assert.ok(Date.parse(notices[0].expires) > Date.now(), 'notice is already expired');
	});
});
