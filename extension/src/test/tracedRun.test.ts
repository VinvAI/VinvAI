/**
 * Parsing the recorded tracelens start command into the pieces a traced driver
 * run needs (tracelens binary, interpreter, target packages, cwd). The live run
 * itself is exercised against a real project; this pins the parse.
 */
import * as assert from 'assert';
import * as path from 'path';
import { nativePath, parseTracedCommand, splitEnvPrefix } from '../harness/tracedRun';

suite('tracedRun: parse the recorded tracelens command', () => {
	const cmd =
		'C:/p/.venv/Scripts/tracelens.exe run --target-package smolagents ' +
		'--output C:/p/.vinv/captures/vinv-bringup/smolagents/trace.jsonl ' +
		'-- C:/p/.venv/Scripts/python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000';

	test('extracts tracelens, python, package, and cwd', () => {
		const cfg = parseTracedCommand(cmd, 'C:/p/examples/async_agent', 'C:/p');
		assert.ok(cfg);
		assert.strictEqual(cfg!.tracelens, 'C:/p/.venv/Scripts/tracelens.exe');
		assert.strictEqual(cfg!.python, 'C:/p/.venv/Scripts/python.exe');
		assert.deepStrictEqual(cfg!.targetPackages, ['smolagents']);
		assert.strictEqual(cfg!.cwd, 'C:/p/examples/async_agent');
	});

	test('multiple target packages are all captured, long and short flags alike', () => {
		// The binary must actually be tracelens (see the guard test below), and
		// `-t` is a real tracelens spelling of --target-package.
		const cfg = parseTracedCommand(
			'/v/bin/tracelens run -t a --target-package b -o x.jsonl -- py driver.py',
			undefined,
			'/root',
		);
		assert.ok(cfg);
		assert.deepStrictEqual(cfg!.targetPackages, ['a', 'b']);
		assert.strictEqual(cfg!.cwd, '/root', 'falls back to workspace root when no working_directory');
	});

	test('a non-tracelens command is not a traced config', () => {
		assert.strictEqual(parseTracedCommand('python -m uvicorn main:app', undefined, '/r'), null);
		assert.strictEqual(parseTracedCommand('', undefined, '/r'), null);
	});
});

/**
 * The live shape of a recorded command, which the parse above did not survive.
 *
 * Bring-up drives Git Bash on Windows, so what it records is spelled the way
 * bash spells it: a `PATH="…:$PATH"` prefix and `/c/…` paths. `spawn` reads
 * neither — it took the entire string as the program name and failed ENOENT, so
 * the first end-to-end try-run wrote a driver, saved it, and produced no trace.
 */
suite('tracedRun: a command recorded by a shell', () => {
	const LIVE =
		'PATH="/c/p/.venv/Scripts:$PATH" /c/p/.venv/Scripts/tracelens run ' +
		'--target-package smolagents --target-package examples ' +
		'--output C:/p/.vinv/captures/x/trace.jsonl --sample-rate 1.0 ' +
		'-- /c/p/.venv/Scripts/python.exe -m uvicorn examples.async_agent.main:app --port 8000';

	test('the env prefix is environment, not part of the program name', () => {
		const { env, rest } = splitEnvPrefix(LIVE);
		assert.deepStrictEqual(env, { PATH: '/c/p/.venv/Scripts:$PATH' });
		assert.ok(rest.startsWith('/c/p/.venv/Scripts/tracelens run '), rest.slice(0, 40));
	});

	test('several assignments peel off, and a command with none is untouched', () => {
		const { env, rest } = splitEnvPrefix("A=1 B='two words' C=3 prog --flag");
		assert.deepStrictEqual(env, { A: '1', B: 'two words', C: '3' });
		assert.strictEqual(rest, 'prog --flag');
		assert.deepStrictEqual(splitEnvPrefix('prog --flag'), { env: {}, rest: 'prog --flag' });
	});

	test('the parsed binaries are runnable spellings, with no assignment glued on', () => {
		const cfg = parseTracedCommand(LIVE, undefined, 'C:/p');
		assert.ok(cfg);
		assert.ok(!cfg!.tracelens.includes('PATH='), `env prefix leaked: ${cfg!.tracelens}`);
		assert.ok(!cfg!.tracelens.startsWith('/c/'), `unconverted MSYS path: ${cfg!.tracelens}`);
		assert.deepStrictEqual(cfg!.targetPackages, ['smolagents', 'examples']);
		assert.deepStrictEqual(cfg!.env, { PATH: '/c/p/.venv/Scripts:$PATH' });
		if (process.platform === 'win32') {
			assert.strictEqual(cfg!.tracelens, path.win32.join('C:\\', 'p/.venv/Scripts/tracelens'));
			assert.strictEqual(cfg!.python, path.win32.join('C:\\', 'p/.venv/Scripts/python.exe'));
		}
	});

	test('nativePath converts a drive root and leaves real POSIX paths alone', () => {
		assert.strictEqual(nativePath('/usr/local/bin/tracelens'), '/usr/local/bin/tracelens');
		assert.strictEqual(nativePath('relative/path'), 'relative/path');
		assert.strictEqual(
			nativePath('/c/p/x'),
			process.platform === 'win32' ? path.win32.join('C:\\', 'p/x') : '/c/p/x',
		);
	});
});
