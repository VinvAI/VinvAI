import * as assert from 'assert';
import {
	decidePinAction,
	shouldRunPinCheck,
	type EngineUpdateMode,
} from '../engines/update';

/** Baseline: a stamped build whose managed clone sits on the wrong commit. */
function pin(
	overrides: Partial<Parameters<typeof decidePinAction>[0]> = {},
): Parameters<typeof decidePinAction>[0] {
	return {
		head: 'aaaaaaa',
		pinnedCommit: 'bbbbbbb',
		managed: true,
		dirty: false,
		mode: 'prompt' as EngineUpdateMode,
		force: false,
		autoAttempts: 0,
		...overrides,
	};
}

suite('engines pin check gating', () => {
	test('an unstamped dev build never checks, even when forced', () => {
		assert.strictEqual(
			shouldRunPinCheck({ ref: '', mode: 'auto', force: false, settled: false }),
			false,
		);
		assert.strictEqual(
			shouldRunPinCheck({ ref: '', mode: 'auto', force: true, settled: false }),
			false,
		);
	});

	test('a settled version does not re-check on window reload', () => {
		assert.strictEqual(
			shouldRunPinCheck({ ref: 'v1', mode: 'prompt', force: false, settled: true }),
			false,
		);
	});

	test("mode 'never' opts out of the automatic check", () => {
		assert.strictEqual(
			shouldRunPinCheck({ ref: 'v1', mode: 'never', force: false, settled: false }),
			false,
		);
	});

	test('the explicit command overrides both the mode and the settled marker', () => {
		assert.strictEqual(
			shouldRunPinCheck({ ref: 'v1', mode: 'never', force: true, settled: true }),
			true,
		);
	});

	test('a stamped build checks once per version', () => {
		assert.strictEqual(
			shouldRunPinCheck({ ref: 'v1', mode: 'prompt', force: false, settled: false }),
			true,
		);
	});
});

suite('engines pin decision', () => {
	test('HEAD already at the pinned commit is up to date', () => {
		assert.strictEqual(
			decidePinAction(pin({ head: 'abc123', pinnedCommit: 'abc123' })).kind,
			'up-to-date',
		);
	});

	test('an unresolvable ref is not mistaken for a match', () => {
		// Both null would compare equal; the pin is simply not fetched yet.
		assert.notStrictEqual(decidePinAction(pin({ pinnedCommit: null })).kind, 'up-to-date');
	});

	test("a checkout we do not own is never modified, whatever the mode", () => {
		for (const mode of ['auto', 'prompt', 'never'] as EngineUpdateMode[]) {
			assert.strictEqual(decidePinAction(pin({ managed: false, mode })).kind, 'foreign');
			assert.strictEqual(
				decidePinAction(pin({ managed: false, mode, force: true })).kind,
				'foreign',
				'forcing must not override the foreign-checkout guard',
			);
		}
	});

	test('local changes in our own clone stop the update', () => {
		assert.strictEqual(decidePinAction(pin({ dirty: true, mode: 'auto' })).kind, 'dirty');
		assert.strictEqual(
			decidePinAction(pin({ dirty: true, force: true, mode: 'auto' })).kind,
			'dirty',
		);
	});

	test("'auto' updates without asking", () => {
		assert.strictEqual(decidePinAction(pin({ mode: 'auto' })).kind, 'update');
	});

	test("'prompt' asks first", () => {
		assert.strictEqual(decidePinAction(pin({ mode: 'prompt' })).kind, 'ask');
	});

	test("'auto' falls back to asking once it has kept relaunching", () => {
		assert.strictEqual(decidePinAction(pin({ mode: 'auto', autoAttempts: 1 })).kind, 'update');
		assert.strictEqual(decidePinAction(pin({ mode: 'auto', autoAttempts: 2 })).kind, 'ask');
	});

	test('the explicit command asks unless the mode is auto', () => {
		assert.strictEqual(decidePinAction(pin({ mode: 'never', force: true })).kind, 'ask');
		assert.strictEqual(decidePinAction(pin({ mode: 'prompt', force: true })).kind, 'ask');
		assert.strictEqual(decidePinAction(pin({ mode: 'auto', force: true })).kind, 'update');
	});

	test('the attempt cap does not block a forced update', () => {
		assert.strictEqual(
			decidePinAction(pin({ mode: 'auto', force: true, autoAttempts: 9 })).kind,
			'update',
		);
	});
});
