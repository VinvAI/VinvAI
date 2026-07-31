import * as assert from 'assert';
import * as path from 'path';
import { awaitEnginesTerminal } from '../engines/install';
import { engineRunDonePath, engineSyncStampPath } from '../engines/resolve';
import {
	decideInstallAction,
	decidePinAction,
	environmentNeedsSync,
	pinStateStamp,
	shouldRunPinCheck,
	type EngineUpdateMode,
} from '../engines/update';
import { discoveryStamp, shouldRediscoverForUpdate } from '../index/discovery';

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

	test('a pin move invalidates the stamp even when the version is unchanged', () => {
		// The regression this guards: keyed on version alone, every pin move
		// inside one version was ignored, so a rebuilt vsix left the engines
		// checkout wherever it already was.
		assert.notStrictEqual(pinStateStamp('0.1.4', 'aaaaaaa'), pinStateStamp('0.1.4', 'bbbbbbb'));
		assert.strictEqual(pinStateStamp('0.1.4', 'aaaaaaa'), pinStateStamp('0.1.4', 'aaaaaaa'));
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

suite('engines environment freshness', () => {
	test('never built is always stale', () => {
		assert.strictEqual(
			environmentNeedsSync({ synced: false, stampMtimeMs: 9, headMtimeMs: 1 }),
			true,
			'a checkout with no venv needs a sync no matter what the mtimes say',
		);
	});

	test('a stamp older than the checkout was written before it moved', () => {
		// The case this exists for: the checkout was moved to the pin by hand at
		// 05:14 while the environment dated from 02:58, so HEAD matched, the pin
		// check reported up-to-date, and the engines ran v0.1.2 code against a
		// v0.1.1 environment — 878 lines of uv.lock and two pyprojects apart.
		assert.strictEqual(
			environmentNeedsSync({ synced: true, stampMtimeMs: 2_58, headMtimeMs: 5_14 }),
			true,
		);
	});

	test('a stamp newer than the checkout is current', () => {
		assert.strictEqual(
			environmentNeedsSync({ synced: true, stampMtimeMs: 5_15, headMtimeMs: 5_14 }),
			false,
		);
	});

	test('a synced checkout with no stamp is NOT stale', () => {
		// The deadlock this replaces, and the one an already-installed checkout
		// lands in: reading the venv's own mtime, a `uv sync` that legitimately had
		// nothing to rewrite left tracelens older than the .git/HEAD every checkout
		// touches, so correct engines reported stale on every activation and no
		// sync could ever clear it. An absent stamp means "synced by a build that
		// did not stamp", which is unknown — and unknown never churns a terminal.
		assert.strictEqual(
			environmentNeedsSync({ synced: true, stampMtimeMs: null, headMtimeMs: 5_14 }),
			false,
		);
	});

	test('unreadable mtimes never churn a terminal on a guess', () => {
		assert.strictEqual(
			environmentNeedsSync({ synced: true, stampMtimeMs: 5_14, headMtimeMs: null }),
			false,
		);
	});

	test('the success stamp and the finished marker are different files', () => {
		// They answer different questions — "built for this commit" vs "the
		// terminal is no longer running" — and collapsing them would make a failed
		// build look like a successful sync.
		const root = path.join('C:', 'engines');
		assert.notStrictEqual(engineSyncStampPath(root), engineRunDonePath(root));
		for (const p of [engineSyncStampPath(root), engineRunDonePath(root)]) {
			assert.strictEqual(path.dirname(p), root, 'markers live in the engines root');
		}
	});

	test('waiting on the engines terminal is a no-op when none is running', async () => {
		// Callers await it unconditionally, so idle must not cost them anything.
		await awaitEnginesTerminal();
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

// ---------------------------------------------------------------------------
// Re-discovery after an extension update. An update also moves the engines to a
// new pin, and the artifacts on disk were produced by engines this build no
// longer ships — so the workspace is re-discovered, which is also what makes
// Auto-Pilot start (its auto-start hangs off discovery COMPLETING).
// ---------------------------------------------------------------------------

suite('shouldRediscoverForUpdate', () => {
	const at = (overrides: Partial<Parameters<typeof shouldRediscoverForUpdate>[0]> = {}) => ({
		discovered: true,
		seen: discoveryStamp('0.2.0'),
		stamp: discoveryStamp('0.2.1'),
		...overrides,
	});

	test('a version change on a discovered workspace re-discovers', () => {
		assert.strictEqual(shouldRediscoverForUpdate(at()), true);
	});

	test('the same build does not re-discover on every window reload', () => {
		assert.strictEqual(shouldRediscoverForUpdate(at({ seen: discoveryStamp('0.2.1') })), false);
	});

	test('an undiscovered workspace is left to the normal first-run path', () => {
		// Not "false because nothing changed" — false because re-discovery is not
		// this decision's job when there is nothing to re-do.
		assert.strictEqual(shouldRediscoverForUpdate(at({ discovered: false })), false);
		assert.strictEqual(
			shouldRediscoverForUpdate(at({ discovered: false, seen: undefined })),
			false,
		);
	});

	test('no recorded build IS treated as an update', () => {
		// Every workspace discovered before the marker existed looks like this, and
		// its artifacts are the oldest on the machine. Staying quiet here is the one
		// case where installing a build provably changes nothing, so it re-discovers
		// — once, since the marker is written as soon as the pass completes.
		assert.strictEqual(shouldRediscoverForUpdate(at({ seen: undefined })), true);
	});

	test('a marker left by the version-only logic is stale', () => {
		// The state on every install carrying a bare '0.2.1' from an earlier build
		// of this same version: it must run the pass, not read as already-current.
		assert.strictEqual(shouldRediscoverForUpdate(at({ seen: '0.2.1' })), true);
	});

	test('a forced revision re-discovers a version that did not move', () => {
		// The whole point of REDISCOVER_REV: same version number, new build, and
		// every install of it re-discovers with no user action.
		assert.strictEqual(shouldRediscoverForUpdate(at({ seen: '0.2.1#0' })), true);
		assert.notStrictEqual(discoveryStamp('0.2.1'), '0.2.1');
	});

	test('an unknown current version never forces work', () => {
		// packageJSON.version missing — an empty stamp must not make every
		// activation look like a change.
		assert.strictEqual(discoveryStamp(''), '');
		assert.strictEqual(shouldRediscoverForUpdate(at({ stamp: '' })), false);
	});

	test('a downgrade counts too', () => {
		// Rolling back also changes which engines the extension is cut against, so
		// the artifacts are equally stale. This is a change test, not an ordering one.
		assert.strictEqual(
			shouldRediscoverForUpdate(at({ seen: discoveryStamp('0.2.1'), stamp: discoveryStamp('0.2.0') })),
			true,
		);
	});
});
