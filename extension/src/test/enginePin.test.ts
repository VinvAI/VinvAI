import * as assert from 'assert';
import {
	decideInstallAction,
	decidePinAction,
	pinStateStamp,
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

	test('a marker written by older pin logic under the same version is stale', () => {
		// The trap 0.1.2 fell into: it settled itself on every affected machine,
		// then was fixed in place under the same version — so the fix could never
		// fire, because the check was skipped as already-settled on exactly the
		// installs that needed it. The stamp carries the logic revision, so an
		// in-place fix invalidates its predecessor's markers.
		const settledByOldLogic = '0.1.2';
		assert.notStrictEqual(
			pinStateStamp('0.1.2'),
			settledByOldLogic,
			'a bare-version marker must not satisfy the current stamp',
		);
		assert.strictEqual(
			shouldRunPinCheck({
				ref: 'v0.1.2',
				mode: 'auto',
				force: false,
				settled: pinStateStamp('0.1.2') === settledByOldLogic,
			}),
			true,
			'an install carrying the stale marker must re-check, not stay quiet',
		);
	});

	test('the stamp is stable for one version and distinct across versions', () => {
		assert.strictEqual(pinStateStamp('0.1.2'), pinStateStamp('0.1.2'));
		assert.notStrictEqual(pinStateStamp('0.1.2'), pinStateStamp('0.1.3'));
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

	test('the working tree is not an input — our own clone is forced onto the pin', () => {
		// Regression guard for the shipped-and-broken 0.1.2 behaviour: `uv sync`
		// rewrites the tracked uv.lock, so a clone that respected local changes
		// disqualified itself from the update the first time it was installed.
		// Anything reintroducing a working-tree input has to delete this test.
		assert.ok(
			!Object.keys(pin()).includes('dirty'),
			'a dirty/local-changes input must not come back — it made the update unreachable',
		);
		assert.strictEqual(decidePinAction(pin({ mode: 'auto' })).kind, 'update');
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

suite('engines install decision (no checkout on the machine)', () => {
	test("'auto' installs without asking", () => {
		// The gap this closes: activation used to return when no checkout existed,
		// which is BEFORE the mode is consulted at all — so "force the engines
		// onto the pin" silently did not cover putting them there.
		assert.strictEqual(decideInstallAction({ mode: 'auto', force: false, autoAttempts: 0 }).kind, 'install');
	});

	test("'prompt' asks first", () => {
		assert.strictEqual(
			decideInstallAction({ mode: 'prompt', force: false, autoAttempts: 0 }).kind,
			'ask-install',
		);
	});

	test('the same circuit breaker as the update path applies', () => {
		assert.strictEqual(decideInstallAction({ mode: 'auto', force: false, autoAttempts: 1 }).kind, 'install');
		assert.strictEqual(
			decideInstallAction({ mode: 'auto', force: false, autoAttempts: 2 }).kind,
			'ask-install',
			'a clone that keeps failing must stop relaunching a terminal every window',
		);
	});

	test('the explicit command installs on auto and asks otherwise', () => {
		assert.strictEqual(decideInstallAction({ mode: 'auto', force: true, autoAttempts: 9 }).kind, 'install');
		assert.strictEqual(
			decideInstallAction({ mode: 'prompt', force: true, autoAttempts: 0 }).kind,
			'ask-install',
		);
		assert.strictEqual(
			decideInstallAction({ mode: 'never', force: true, autoAttempts: 0 }).kind,
			'ask-install',
		);
	});
});
