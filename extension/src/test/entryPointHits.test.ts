/**
 * Counting the entry points the engine's tracesummary cannot count.
 *
 * `identification tracesummary` covers HTTP routes only, so every CLI command,
 * worker, scheduled job and `__main__` script in the Traces panel sat at zero
 * hits no matter how often it ran — while its capture plainly held the handler's
 * enter/exit events. These pin the two halves of the fix: the file→module join
 * (which must not collect a namesake's calls) and the incremental read (the
 * panel polls every second against a trace that grows, or is rewritten).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	componentMatches,
	countInvocations,
	entryPointHits,
	moduleCandidates,
	resetHitCache,
} from '../identification/entryPointHits';

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-hits-'));
}

/** Writes (or appends) trace events as JSONL. */
function writeTrace(file: string, events: object[], append = false): void {
	const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (append) {
		fs.appendFileSync(file, body, 'utf8');
	} else {
		fs.writeFileSync(file, body, 'utf8');
	}
}

const ran = (component: string, request = 'r1'): object => ({
	event: 'enter',
	component,
	request_id: request,
});
const returned = (component: string): object => ({
	event: 'exit',
	component,
	duration_ms: 1,
});

suite('entry-point hits: joining a traced component to its entry point', () => {
	const cli = { id: 'CLI_generate_cmd', handler: 'generate_cmd', file: 'handbook/src/handbook/cli.py' };

	test('a src layout resolves to the import package, not the repo path', () => {
		assert.deepStrictEqual(moduleCandidates('handbook/src/handbook/cli.py'), [
			'handbook.cli',
			'handbook.src.handbook.cli',
		]);
		assert.deepStrictEqual(moduleCandidates('app/api.py'), ['app.api']);
		assert.deepStrictEqual(moduleCandidates('pkg/src/pkg/__init__.py'), ['pkg', 'pkg.src.pkg']);
		assert.deepStrictEqual(moduleCandidates('app\\worker\\tasks.py'), ['app.worker.tasks']);
	});

	test('the handler must be the LAST segment, under the file’s own module', () => {
		assert.strictEqual(componentMatches('handbook.cli.generate_cmd', cli), true);
		// A class method in that same file still belongs to the entry point.
		assert.strictEqual(componentMatches('handbook.cli.Runner.generate_cmd', cli), true);
		// A caller of the handler is not the handler.
		assert.strictEqual(componentMatches('handbook.cli.main', cli), false);
		// The same name in a different package is a different function.
		assert.strictEqual(
			componentMatches('other.tool.generate_cmd', cli),
			false,
			'a namesake elsewhere must never inflate this count',
		);
		assert.strictEqual(componentMatches('handbook.cli.generate_cmd', { ...cli, handler: null }), false);
	});
});

suite('entry-point hits: counting from the captures', () => {
	setup(() => resetHitCache());

	test('a CLI run that the HTTP summary cannot see is counted', () => {
		const root = tmpDir();
		const trace = path.join(root, '.vinv', 'captures', 'vinv-bringup', 'handbook', 'trace.jsonl');
		writeTrace(trace, [
			ran('handbook.cli.main'),
			ran('handbook.cli.generate_cmd'),
			returned('handbook.cli.generate_cmd'),
			returned('handbook.cli.main'),
		]);
		const hits = entryPointHits(root, [
			{ id: 'CLI_main', handler: 'main', file: 'handbook/src/handbook/cli.py' },
			{ id: 'CLI_generate_cmd', handler: 'generate_cmd', file: 'handbook/src/handbook/cli.py' },
			{ id: 'CLI_unrelated', handler: 'serve', file: 'other/src/other/cli.py' },
		]);
		assert.strictEqual(hits.get('CLI_main'), 1);
		assert.strictEqual(hits.get('CLI_generate_cmd'), 1);
		assert.strictEqual(hits.has('CLI_unrelated'), false, 'never-run entry points stay absent (rendered 0)');
	});

	test('captures across services all count, and a second run adds to the first', () => {
		const root = tmpDir();
		const a = path.join(root, '.vinv', 'captures', 'run-a', 'handbook', 'trace.jsonl');
		const b = path.join(root, '.vinv', 'captures', 'run-b', 'handbook', 'trace.jsonl');
		writeTrace(a, [ran('handbook.cli.main', 'r1')]);
		writeTrace(b, [ran('handbook.cli.main', 'r2')]);
		const entries = [{ id: 'CLI_main', handler: 'main', file: 'handbook/src/handbook/cli.py' }];
		assert.strictEqual(entryPointHits(root, entries).get('CLI_main'), 2);
	});

	test('an appended trace is read incrementally, not re-counted from zero', () => {
		const root = tmpDir();
		const trace = path.join(root, 'trace.jsonl');
		writeTrace(trace, [ran('pkg.mod.handle')]);
		assert.strictEqual(countInvocations([trace]).get('pkg.mod.handle'), 1);
		// The poll that follows must see 2, not 1 (re-read) and not 3 (double count).
		writeTrace(trace, [ran('pkg.mod.handle')], true);
		assert.strictEqual(countInvocations([trace]).get('pkg.mod.handle'), 2);
		// A poll with nothing new keeps the total steady.
		assert.strictEqual(countInvocations([trace]).get('pkg.mod.handle'), 2);
	});

	test('a rewritten trace (the time-window filter) restarts rather than appends', () => {
		const root = tmpDir();
		const trace = path.join(root, 'filtered.jsonl');
		writeTrace(trace, [ran('pkg.mod.handle'), ran('pkg.mod.handle')]);
		assert.strictEqual(countInvocations([trace]).get('pkg.mod.handle'), 2);
		// Same path, different content: a narrower window holding one call.
		writeTrace(trace, [ran('pkg.other.handle')]);
		const counts = countInvocations([trace]);
		assert.strictEqual(counts.get('pkg.other.handle'), 1);
		assert.strictEqual(
			counts.get('pkg.mod.handle'),
			undefined,
			'the previous window’s calls must not survive into the new one',
		);
	});

	test('a torn final line is not lost — it is counted once completed', () => {
		const root = tmpDir();
		const trace = path.join(root, 'trace.jsonl');
		// The writer is mid-flush: the last line has no newline and no closing brace.
		fs.writeFileSync(trace, JSON.stringify(ran('pkg.mod.handle')) + '\n{"event":"ent', 'utf8');
		assert.strictEqual(countInvocations([trace]).get('pkg.mod.handle'), 1);
		fs.appendFileSync(trace, 'er","component":"pkg.mod.handle"}\n', 'utf8');
		assert.strictEqual(countInvocations([trace]).get('pkg.mod.handle'), 2);
	});

	test('a workspace with no captures counts nothing rather than throwing', () => {
		assert.strictEqual(
			entryPointHits(tmpDir(), [{ id: 'CLI_main', handler: 'main', file: 'a/cli.py' }]).size,
			0,
		);
	});
});
