import * as assert from 'assert';
import {
	CHECK_INTERVAL_MS,
	MIN_FETCH_INTERVAL_MS,
	parseNotices,
	selectNotice,
	shouldFetchNow,
	versionSatisfies,
	type Notice,
	type NoticeAction,
} from '../notices/notices';

const NOW = Date.parse('2026-07-30T00:00:00Z');

/** A valid notice for 0.1.4, expiring well after NOW. */
function notice(overrides: Partial<Notice> = {}): Notice {
	return {
		id: 'test-notice',
		severity: 'info',
		appliesTo: '<0.1.5',
		title: 'Update Vinv',
		body: 'Services could report not running while loading.',
		expires: '2026-09-01',
		actions: [],
		...overrides,
	};
}

/** A payload as it would arrive from the endpoint. */
function payload(...notices: unknown[]): string {
	return JSON.stringify({ notices });
}

suite('notice version ranges', () => {
	test('an update notice does not fire at users who already updated', () => {
		assert.strictEqual(versionSatisfies('0.1.4', '<0.1.5'), true);
		assert.strictEqual(versionSatisfies('0.1.5', '<0.1.5'), false);
		assert.strictEqual(versionSatisfies('0.2.0', '<0.1.5'), false);
	});

	test('comparators and conjunctions', () => {
		assert.strictEqual(versionSatisfies('0.1.4', '>=0.1.0 <0.2.0'), true);
		assert.strictEqual(versionSatisfies('0.2.1', '>=0.1.0 <0.2.0'), false);
		assert.strictEqual(versionSatisfies('0.1.4', '<=0.1.4'), true);
		assert.strictEqual(versionSatisfies('0.1.4', '>0.1.4'), false);
		assert.strictEqual(versionSatisfies('0.1.4', '0.1.4'), true);
		assert.strictEqual(versionSatisfies('0.1.4', '0.1.3'), false);
		assert.strictEqual(versionSatisfies('0.1.4', '*'), true);
	});

	test('a range this subset cannot parse means the notice does not apply', () => {
		for (const range of ['^0.1.0', '~0.1.4', '0.1.x', '>= 0.1', '', 'latest']) {
			assert.strictEqual(versionSatisfies('0.1.4', range), false, range);
		}
	});

	test('an unparseable running version matches nothing, including *', () => {
		assert.strictEqual(versionSatisfies('', '*'), false);
	});
});

suite('notice payload parsing', () => {
	test('a well-formed notice survives intact', () => {
		const [parsed] = parseNotices(payload(notice()));
		assert.strictEqual(parsed.id, 'test-notice');
		assert.strictEqual(parsed.severity, 'info');
		assert.strictEqual(parsed.appliesTo, '<0.1.5');
	});

	test('garbage yields no notices rather than throwing', () => {
		assert.deepStrictEqual(parseNotices('not json'), []);
		assert.deepStrictEqual(parseNotices(''), []);
		assert.deepStrictEqual(parseNotices('{}'), []);
		assert.deepStrictEqual(parseNotices('{"notices":"nope"}'), []);
		assert.deepStrictEqual(parseNotices(payload(null, 42, 'x')), []);
	});

	test('an oversized body is refused outright', () => {
		assert.deepStrictEqual(parseNotices('x'.repeat(64 * 1024 + 1)), []);
	});

	test('a notice with no expiry or no range is dropped', () => {
		assert.deepStrictEqual(parseNotices(payload({ ...notice(), expires: undefined })), []);
		assert.deepStrictEqual(parseNotices(payload({ ...notice(), expires: 'someday' })), []);
		assert.deepStrictEqual(parseNotices(payload({ ...notice(), appliesTo: '' })), []);
		assert.deepStrictEqual(parseNotices(payload({ ...notice(), title: '' })), []);
		assert.deepStrictEqual(parseNotices(payload({ ...notice(), id: 'has spaces' })), []);
	});

	test('at most 20 notices are read from one file', () => {
		const many = Array.from({ length: 30 }, (_, i) => notice({ id: `n-${i}` }));
		assert.strictEqual(parseNotices(payload(...many)).length, 20);
	});

	test('title and body are collapsed and capped', () => {
		const [parsed] = parseNotices(
			payload(notice({ title: `a\nb   c${'!'.repeat(200)}`, body: 'x'.repeat(400) })),
		);
		assert.strictEqual(parsed.title.startsWith('a b c'), true);
		assert.strictEqual(parsed.title.length, 120);
		assert.strictEqual(parsed.body.length, 300);
	});
});

suite('notice CTAs', () => {
	/** The actions surviving a payload whose notice carries `actions`. */
	const actions = (...raw: unknown[]): NoticeAction[] =>
		parseNotices(payload(notice({ actions: raw as never })))[0].actions;

	test('the notice supplies its own label and order', () => {
		const parsed = actions(
			{ kind: 'open', label: 'What Changed', url: 'https://vinv.ai/changelog' },
			{ kind: 'checkForUpdates', label: 'Update Now' },
		);
		assert.deepStrictEqual(
			parsed.map((a) => a.label),
			['What Changed', 'Update Now'],
		);
		assert.deepStrictEqual(
			parsed.map((a) => a.kind),
			['open', 'checkForUpdates'],
		);
	});

	test('the three allowed kinds resolve', () => {
		assert.strictEqual(actions({ kind: 'checkForUpdates', label: 'Go' }).length, 1);
		assert.strictEqual(actions({ kind: 'updateEngines', label: 'Go' }).length, 1);
		assert.strictEqual(
			actions({ kind: 'open', label: 'Go', url: 'https://vinv.ai/x' }).length,
			1,
		);
	});

	test('a payload naming a VS Code command gets no button', () => {
		assert.deepStrictEqual(
			actions({ kind: 'command', label: 'Go', command: 'workbench.action.terminal.sendSequence' }),
			[],
		);
		assert.deepStrictEqual(actions({ command: 'workbench.action.terminal.new', label: 'Go' }), []);
	});

	test('links are https on an allowlisted host only', () => {
		const link = (url: string): number => actions({ kind: 'open', label: 'Read', url }).length;
		assert.strictEqual(link('https://vinv.ai/changelog'), 1);
		assert.strictEqual(link('https://github.com/VinvAI/VinvAI/releases'), 1);
		assert.strictEqual(link('http://vinv.ai/changelog'), 0);
		assert.strictEqual(link('https://vinv.ai.evil.example/x'), 0);
		assert.strictEqual(link('https://example.com/x'), 0);
		assert.strictEqual(link('javascript:alert(1)'), 0);
		assert.strictEqual(link('not a url'), 0);
	});

	test('an unusable action is dropped and the notice still shows', () => {
		const [parsed] = parseNotices(
			payload(notice({ actions: [{ kind: 'checkForUpdates' }, 'nope', null] as never })),
		);
		assert.deepStrictEqual(parsed.actions, []);
		assert.strictEqual(parsed.title, 'Update Vinv');
	});

	test('at most two buttons, and no label may collide', () => {
		assert.strictEqual(
			actions(
				{ kind: 'checkForUpdates', label: 'One' },
				{ kind: 'updateEngines', label: 'Two' },
				{ kind: 'open', label: 'Three', url: 'https://vinv.ai/x' },
			).length,
			2,
		);
		assert.strictEqual(
			actions(
				{ kind: 'checkForUpdates', label: 'Same' },
				{ kind: 'updateEngines', label: 'Same' },
			).length,
			1,
		);
	});

	test('a button cannot impersonate the dismiss button', () => {
		assert.deepStrictEqual(
			actions({ kind: 'checkForUpdates', label: "Don't Show Notices" }),
			[],
		);
	});

	test('missing or malformed actions leave the notice with none', () => {
		assert.deepStrictEqual(parseNotices(payload({ ...notice(), actions: undefined })), [
			{ ...notice(), actions: [] },
		]);
		assert.deepStrictEqual(
			parseNotices(payload({ ...notice(), actions: 'checkForUpdates' }))[0].actions,
			[],
		);
	});
});

suite('choosing the notice to show', () => {
	const pick = (notices: Notice[], version = '0.1.4', seenIds: string[] = []): Notice | null =>
		selectNotice({ notices, version, seenIds, now: NOW });

	test('nothing to show is null, not an empty toast', () => {
		assert.strictEqual(pick([]), null);
	});

	test('a notice for older versions never reaches an updated user', () => {
		assert.strictEqual(pick([notice()], '0.1.5'), null);
	});

	test('an expired notice is dropped even though the file still serves it', () => {
		assert.strictEqual(pick([notice({ expires: '2026-07-29' })]), null);
	});

	test('a seen id never fires again', () => {
		assert.strictEqual(pick([notice()], '0.1.4', ['test-notice']), null);
	});

	test('warnings outrank info regardless of file order', () => {
		const chosen = pick([
			notice({ id: 'info-first' }),
			notice({ id: 'the-warning', severity: 'warning' }),
		]);
		assert.strictEqual(chosen?.id, 'the-warning');
	});

	test('among equals the file order decides', () => {
		const chosen = pick([notice({ id: 'first' }), notice({ id: 'second' })]);
		assert.strictEqual(chosen?.id, 'first');
	});
});


suite('notice delivery schedule', () => {
	const T0 = Date.parse('2026-09-01T09:00:00Z');

	test('a fresh install fetches on its first activation', () => {
		// Nothing stored yet, so the stamp reads 0. This is the moment a notice
		// about the version just installed matters most; making it wait an hour
		// would be the worst possible time to be quiet.
		assert.strictEqual(shouldFetchNow(T0, 0), true);
	});

	test('a second window moments later does not fetch again', () => {
		// The stamp is global, so opening five windows is still one request.
		assert.strictEqual(shouldFetchNow(T0 + 1_000, T0), false);
	});

	test('a window left open fetches again once the gap has passed', () => {
		assert.strictEqual(shouldFetchNow(T0 + MIN_FETCH_INTERVAL_MS, T0), true);
		assert.strictEqual(shouldFetchNow(T0 + MIN_FETCH_INTERVAL_MS - 1, T0), false);
	});

	test('the gap is shorter than the tick, or the check silently halves', () => {
		// Load-bearing, not cosmetic: the timer's origin is when the check was
		// armed and the stamp is written later, when the fetch starts. Equal
		// values make every tick land just short of the gap.
		assert.ok(
			MIN_FETCH_INTERVAL_MS < CHECK_INTERVAL_MS,
			'the fetch gap must be strictly shorter than the tick interval',
		);
	});

	test('every tick fetches, across a long uninterrupted session', () => {
		// The regression this replaced: with tick === gap this fetched on hours
		// 1, 3 and 5 of a six-hour session rather than every hour, because the
		// stamp lands a few ms after the tick that wrote it — and drifts further
		// right on each pass, so the error compounds.
		const DRIFT_MS = 40;
		let last = 0; // fresh install
		const fetchedAtHour: number[] = [];
		for (let tick = 1; tick <= 6; tick++) {
			const now = T0 + tick * CHECK_INTERVAL_MS;
			if (shouldFetchNow(now, last)) {
				fetchedAtHour.push(tick);
				last = now + DRIFT_MS;
			}
		}
		assert.deepStrictEqual(fetchedAtHour, [1, 2, 3, 4, 5, 6]);
	});

	test('an upload is picked up within one tick of going live', () => {
		// The question a release asks: someone installed, never restarted, and a
		// notice goes up. The worst case is an upload landing just after a fetch.
		const lastFetch = T0;
		const uploadedAt = T0 + 1_000;
		let seenAt: number | null = null;
		for (let tick = 1; tick <= 4 && seenAt === null; tick++) {
			const now = T0 + tick * CHECK_INTERVAL_MS;
			if (shouldFetchNow(now, lastFetch)) {
				seenAt = now;
			}
		}
		assert.ok(seenAt !== null, 'the notice was never picked up');
		assert.ok(
			seenAt - uploadedAt <= CHECK_INTERVAL_MS,
			`picked up ${(seenAt - uploadedAt) / 60000} minutes after upload`,
		);
	});
});
