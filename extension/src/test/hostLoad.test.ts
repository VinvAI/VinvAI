/**
 * The extension-host load controls: the shared parse cache, the artifact-watch
 * relevance filter, and the heavy-pass arbiter.
 *
 * All three exist for the same reason — the host runs on ONE thread shared with
 * every other extension in the window, and the cockpit's analyses re-read
 * multi-MB artifacts from many independent callers. These tests pin the
 * behaviour that makes that safe: a cache that cannot serve a changed file, a
 * filter that cannot let a source's own output retrigger it, and an arbiter
 * that refuses rather than stacks.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	cachedParse,
	clearParseCache,
	parseCacheGeneration,
	parseCacheStats,
} from '../support/parseCache';
import { isModelRelevantArtifact } from '../views/artifactWatch';
import {
	claimHeavyPass,
	currentHeavyPass,
	detectRunningPass,
	releaseHeavyPass,
	resetHeavyPasses,
} from '../harness/heavyPass';
import { ensureExecutableOnce, resetExecutableBitCache } from '../support/executableBit';

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-hostload-'));
}

/**
 * Writes `data` to `file` and forces a distinct mtime.
 *
 * The cache keys on (size, mtime), and a same-size rewrite inside the
 * filesystem's mtime resolution is precisely the case it cannot detect — so
 * tests that mean "the file changed" must make that observable rather than
 * relying on wall-clock luck.
 */
function writeChanged(file: string, data: string): void {
	fs.writeFileSync(file, data, 'utf8');
	const future = new Date(Date.now() + 10_000);
	fs.utimesSync(file, future, future);
}

suite('parse cache (extension-host read amplification)', () => {
	setup(() => clearParseCache());

	test('a second read of an unchanged file reuses the first parse', () => {
		const dir = tmpDir();
		const file = path.join(dir, 'chunks.jsonl');
		fs.writeFileSync(file, '{"a":1}\n', 'utf8');

		let parses = 0;
		const parse = (f: string): unknown => {
			parses += 1;
			return JSON.parse(fs.readFileSync(f, 'utf8'));
		};

		const first = cachedParse(file, parse);
		const second = cachedParse(file, parse);
		assert.strictEqual(parses, 1, 'second call must not re-parse');
		assert.strictEqual(first, second, 'callers share one parsed value');
	});

	test('a changed file is re-parsed, and the stale value is not served', () => {
		const dir = tmpDir();
		const file = path.join(dir, 'trace.jsonl');
		fs.writeFileSync(file, '{"event":"exit","component":"a"}\n', 'utf8');

		const parse = (f: string): string => fs.readFileSync(f, 'utf8').trim();
		assert.ok(cachedParse(file, parse).includes('"a"'));

		writeChanged(file, '{"event":"exit","component":"b"}\n');
		assert.ok(
			cachedParse(file, parse).includes('"b"'),
			'a rewritten file must never serve the previous parse',
		);
	});

	test('an unreadable file parses through without being cached', () => {
		const missing = path.join(tmpDir(), 'gone.jsonl');
		let parses = 0;
		const parse = (): string[] => {
			parses += 1;
			return [];
		};
		cachedParse(missing, parse);
		cachedParse(missing, parse);
		// No stat, no key, no entry — the caller's own error path stays intact.
		assert.strictEqual(parses, 2);
		assert.strictEqual(parseCacheStats().entries, 0);
	});

	test('the generation advances only on a fresh parse', () => {
		const dir = tmpDir();
		const file = path.join(dir, 'a.jsonl');
		fs.writeFileSync(file, 'x', 'utf8');
		const parse = (f: string): string => fs.readFileSync(f, 'utf8');

		const start = parseCacheGeneration();
		cachedParse(file, parse);
		const afterMiss = parseCacheGeneration();
		assert.notStrictEqual(afterMiss, start, 'a miss must advance the generation');

		cachedParse(file, parse);
		assert.strictEqual(
			parseCacheGeneration(),
			afterMiss,
			'a hit must leave derived memos keyed on this generation valid',
		);

		writeChanged(file, 'y');
		cachedParse(file, parse);
		assert.notStrictEqual(
			parseCacheGeneration(),
			afterMiss,
			'a changed file must invalidate derived memos',
		);
	});
});

suite('artifact watch relevance', () => {
	test('per-run scratch never rebuilds a view model', () => {
		// A single isolated harness run checks out the whole repo under here.
		assert.strictEqual(isModelRelevantArtifact('/w/.vinv/runs/abc/tree/src/main.py'), false);
		assert.strictEqual(isModelRelevantArtifact('/w/.vinv/runs/abc/trajectory.jsonl'), false);
		assert.strictEqual(isModelRelevantArtifact('/w/.vinv/logs/harness-agent.log'), false);
		assert.strictEqual(isModelRelevantArtifact('/w/.vinv/tmp/scratch.json'), false);
	});

	test('the background sources never retrigger each other', () => {
		assert.strictEqual(isModelRelevantArtifact('/w/.vinv/flow_state.json'), false);
		assert.strictEqual(isModelRelevantArtifact('/w/.vinv/reports/findings.json'), false);
		assert.strictEqual(isModelRelevantArtifact('/w/.vinv/reports/journey.json'), false);
	});

	test('real evidence still rebuilds', () => {
		assert.ok(isModelRelevantArtifact('/w/.vinv/captures/sess/svc/trace.jsonl'));
		assert.ok(isModelRelevantArtifact('/w/.vinv/index/meta.json'));
		assert.ok(isModelRelevantArtifact('/w/.vinv/services.json'));
		assert.ok(isModelRelevantArtifact('/w/.vinv/reports/calltree-api.json'));
	});

	test('windows separators and a service named like an ignored subtree', () => {
		assert.strictEqual(
			isModelRelevantArtifact('C:\\w\\.vinv\\runs\\abc\\tree\\a.py'),
			false,
		);
		// "logs" as a SERVICE name under captures is evidence, not scratch: only
		// the first segment under .vinv is matched.
		assert.ok(isModelRelevantArtifact('/w/.vinv/captures/sess/logs/trace.jsonl'));
	});
});

suite('heavy pass arbiter', () => {
	setup(() => resetHeavyPasses());
	teardown(() => resetHeavyPasses());

	test('a second pass is refused while one holds the workspace', () => {
		assert.ok(claimHeavyPass('discovery', 'Discovery'));
		assert.strictEqual(claimHeavyPass('probes', 'The probe pass'), false);
		assert.strictEqual(currentHeavyPass()?.id, 'discovery');
	});

	test('releasing hands the workspace to the next pass', () => {
		assert.ok(claimHeavyPass('discovery', 'Discovery'));
		releaseHeavyPass('discovery');
		assert.strictEqual(currentHeavyPass(), undefined);
		assert.ok(claimHeavyPass('probes', 'The probe pass'));
	});

	test('a pass cannot release a claim it does not hold', () => {
		assert.ok(claimHeavyPass('discovery', 'Discovery'));
		releaseHeavyPass('exercise');
		assert.strictEqual(
			currentHeavyPass()?.id,
			'discovery',
			'a bailing caller must not free another pass',
		);
	});

	test('re-entering the same pass is refused too', () => {
		assert.ok(claimHeavyPass('exercise', 'The exercise pass'));
		assert.strictEqual(claimHeavyPass('exercise', 'The exercise pass'), false);
	});
});

suite('executable bit', () => {
	setup(() => resetExecutableBitCache());

	test('chmods once per path, not once per spawn', function () {
		if (process.platform === 'win32') {
			this.skip(); // mode bits carry no meaning here
		}
		const dir = tmpDir();
		const bin = path.join(dir, 'engine');
		fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o644 });

		ensureExecutableOnce(bin);
		assert.ok(fs.statSync(bin).mode & 0o111, 'first call must set the bit');

		// Clear it behind the helper's back: a second call must NOT restore it,
		// which is what proves the work is not being redone on every spawn.
		fs.chmodSync(bin, 0o644);
		ensureExecutableOnce(bin);
		assert.strictEqual(fs.statSync(bin).mode & 0o111, 0, 'second call must be a no-op');
	});

	test('a different binary is chmodded on its own first call', function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const dir = tmpDir();
		const a = path.join(dir, 'a');
		const b = path.join(dir, 'b');
		for (const f of [a, b]) {
			fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o644 });
		}
		ensureExecutableOnce(a);
		ensureExecutableOnce(b);
		assert.ok(fs.statSync(b).mode & 0o111, 'the memo is per path, not global');
	});
});

suite('running-pass detection', () => {
	test('reports the first probe that says it is running', () => {
		assert.strictEqual(
			detectRunningPass([
				{ running: () => false, label: 'A probe pass' },
				{ running: () => true, label: 'An exercise pass' },
			]),
			'An exercise pass',
		);
	});

	test('a probe that throws is not evidence of a running pass', () => {
		assert.strictEqual(
			detectRunningPass([
				{ running: () => { throw new Error('unreadable'); }, label: 'A probe pass' },
			]),
			undefined,
		);
	});

	test('nothing running yields undefined', () => {
		assert.strictEqual(detectRunningPass([{ running: () => false, label: 'x' }]), undefined);
	});
});
