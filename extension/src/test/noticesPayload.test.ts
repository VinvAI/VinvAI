/**
 * Validates a STAGED notice payload before it is uploaded.
 *
 * The live file is edited and uploaded out of band (see AGENTS.md) and the
 * parser fails quietly in both directions that matter: `text()` slices title
 * and body at their caps with no error, so an over-long body ships cut
 * mid-sentence, and an `appliesTo` range that excludes the shipped version
 * reaches nobody.
 *
 * The staged file is gitignored, so it is absent in CI and on any checkout that
 * is not mid-announcement — these tests skip there rather than fail. They exist
 * for the person editing the payload, which is the only moment the check can
 * still prevent a bad upload.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseNotices, selectNotice, versionSatisfies } from '../notices/notices';

/** Repo root, from `extension/out/test/` at runtime. */
const PAYLOAD = path.resolve(__dirname, '..', '..', '..', '.github', 'assets', 'notices.json');

function staged(): string | null {
	try {
		return fs.readFileSync(PAYLOAD, 'utf8');
	} catch {
		return null;
	}
}

suite('staged notices.json payload', () => {
	test('it survives the extension parser intact', function () {
		const raw = staged();
		if (raw === null) {
			this.skip();
		}
		const parsed = parseNotices(raw);
		assert.ok(parsed.length > 0, 'the staged payload parsed to no notices at all');
		const sources = JSON.parse(raw).notices as Array<{ title: string; body?: string }>;
		parsed.forEach((n, i) => {
			// Silent truncation is the trap: text() slices at MAX_TITLE/MAX_BODY
			// with no error, so an over-long field ships cut mid-sentence.
			assert.strictEqual(n.title, sources[i].title, `notice ${n.id}: title was truncated`);
			assert.strictEqual(n.body, sources[i].body ?? '', `notice ${n.id}: body was truncated`);
		});
	});

	test('every notice targets versions below its range and none above', function () {
		const raw = staged();
		if (raw === null) {
			this.skip();
		}
		for (const n of parseNotices(raw)) {
			const m = /^<(\d+\.\d+\.\d+)$/.exec(n.appliesTo);
			if (!m) {
				continue; // only the "<x.y.z" form is checkable this way
			}
			const [maj, min, patch] = m[1].split('.').map(Number);
			const below = `${maj}.${min}.${Math.max(0, patch - 1)}`;
			assert.ok(versionSatisfies(below, n.appliesTo), `${below} should match ${n.appliesTo}`);
			assert.ok(!versionSatisfies(m[1], n.appliesTo), `${m[1]} must not match ${n.appliesTo}`);
		}
	});

	test('a targeted user is selected, shown once, and it has not expired', function () {
		const raw = staged();
		if (raw === null) {
			this.skip();
		}
		const notices = parseNotices(raw);
		const now = Date.now();
		for (const n of notices) {
			assert.ok(Date.parse(n.expires) > now, `notice ${n.id} is already expired`);
		}
		const m = /^<(\d+\.\d+\.\d+)$/.exec(notices[0].appliesTo);
		if (!m) {
			return;
		}
		const [maj, min, patch] = m[1].split('.').map(Number);
		const targeted = `${maj}.${min}.${Math.max(0, patch - 1)}`;
		const chosen = selectNotice({ notices, version: targeted, seenIds: [], now });
		assert.ok(chosen, `a ${targeted} user must be shown a notice`);
		assert.strictEqual(
			selectNotice({ notices, version: targeted, seenIds: [chosen.id], now }),
			null,
			'a seen notice must not repeat',
		);
	});
});
