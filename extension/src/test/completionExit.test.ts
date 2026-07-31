/**
 * Run-to-completion units vs. long-running servers.
 *
 * The bug these cover: `handbook` is a `python_cli` that generates a handbook
 * and exits 0 in under a second. serviceRunner's backgrounding heuristic
 * (`code === 0 && elapsed < 5000`) flagged that as `instantExit`, autoTrigger
 * read `instantExit` as failure, and a fix episode dispatched against a CLI
 * that had done exactly what it was asked to do — with server-shaped success
 * criteria ("keeps running", "accepts connections"). Six of the eight services
 * in this repo's own inventory are `python_cli`, so every one of them tripped
 * it on every run.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { completionExitCode } from '../bringup/bringup';

function tempRoot(tag: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `vinv-${tag}-`));
}

function writeStartRecord(root: string, service: string, body: unknown): void {
	const file = path.join(root, '.vinv', 'start_commands', `${service}.json`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(body), 'utf8');
}

function writeServices(root: string, services: unknown[]): void {
	const file = path.join(root, '.vinv', 'services.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ services }), 'utf8');
}

suite('completionExitCode: telling a finished CLI from a dead server', () => {
	test("an exit probe makes the unit run-to-completion, defaulting to 0", () => {
		const root = tempRoot('rtc-probe');
		writeStartRecord(root, 'handbook', {
			service: 'handbook',
			verified: true,
			verification: { probe: { type: 'exit', expect_exit: 0 } },
			commands: [{ command: 'handbook generate' }],
		});
		assert.strictEqual(completionExitCode(root, 'handbook'), 0);
	});

	test('a documented non-zero expect_exit is honored, not normalized to 0', () => {
		// A linter that exits 1 on findings: exit 1 is success, exit 0 would be
		// the anomaly. Collapsing this to 0 would dispatch an episode per run.
		const root = tempRoot('rtc-nonzero');
		writeStartRecord(root, 'lint', {
			service: 'lint',
			verified: true,
			verification: { probe: { type: 'exit', expect_exit: 1 } },
			commands: [{ command: 'lint ./src' }],
		});
		assert.strictEqual(completionExitCode(root, 'lint'), 1);
	});

	test('a non-exit probe means a server, outranking a stale inventory kind', () => {
		const root = tempRoot('rtc-server');
		writeServices(root, [{ name: 'api', kind: 'python_cli', port: null }]);
		writeStartRecord(root, 'api', {
			service: 'api',
			verified: true,
			verification: { port: 8001, probe: { type: 'http', expect_status: 200 } },
			commands: [{ command: 'uvicorn app:main' }],
		});
		assert.strictEqual(completionExitCode(root, 'api'), null);
	});

	test('the inventory kind covers a unit whose bring-up has not verified yet', () => {
		// A `verified: false` record carries no trustworthy probe, but the run
		// button and the exit trigger still fire — the kind must still classify.
		const root = tempRoot('rtc-kind');
		writeServices(root, [
			{ name: 'tracelens', kind: 'python_cli', port: null },
			{ name: 'lens-contracts', kind: 'python_library', port: null },
			{ name: 'vinv-embedder', kind: 'python_web', port: 8776 },
		]);
		assert.strictEqual(completionExitCode(root, 'tracelens'), 0);
		assert.strictEqual(completionExitCode(root, 'lens-contracts'), 0);
		assert.strictEqual(completionExitCode(root, 'vinv-embedder'), null);
	});

	test('an unknown service on an empty workspace is a server, not a crash', () => {
		const root = tempRoot('rtc-empty');
		assert.strictEqual(completionExitCode(root, 'nope'), null);
	});

	test('a malformed start record falls through to the inventory', () => {
		const root = tempRoot('rtc-bad');
		writeServices(root, [{ name: 'handbook', kind: 'python_cli', port: null }]);
		const file = path.join(root, '.vinv', 'start_commands', 'handbook.json');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{ not json', 'utf8');
		assert.strictEqual(completionExitCode(root, 'handbook'), 0);
	});
});
