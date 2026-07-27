/**
 * Parsing the recorded tracelens start command into the pieces a traced driver
 * run needs (tracelens binary, interpreter, target packages, cwd). The live run
 * itself is exercised against a real project; this pins the parse.
 */
import * as assert from 'assert';
import { parseTracedCommand } from '../harness/tracedRun';

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
