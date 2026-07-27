/**
 * runEngine process I/O — the audit's BLOCK-1/BLOCK-2 regressions.
 *
 * BLOCK-1: the engine child was spawned with the default stdio ('pipe') and only
 * stderr was ever read. The exerciser CLI writes its ENTIRE result document to
 * stdout, and `plan` alone exceeds the 64 KB OS pipe buffer once OpenAPI $refs
 * are inlined. An unread pipe blocks the child in write(), it never exits, and
 * the step timer kills it — so the exercise pass failed on every repo large
 * enough to matter while passing on a three-endpoint demo.
 *
 * These spawn a real node child, because that is the only way the deadlock
 * reproduces: it lives in OS pipe buffering, not in our code's logic.
 */
import * as assert from 'assert';
import * as os from 'os';
import { runEngine } from '../harness/exerciseRunner';

/** Bytes well past the 64 KB pipe buffer that blocks an undrained child. */
const OVER_PIPE_BUFFER = 200_000;

suite('runEngine: child stdout must be drained', () => {
	test('a child writing far more than the pipe buffer still completes', async () => {
		const script = `process.stdout.write("x".repeat(${OVER_PIPE_BUFFER})); process.exit(0);`;
		const res = await runEngine(process.execPath, ['-e', script], os.tmpdir(), process.env);
		// Undrained, this resolves {ok:false, error:"exerciser timed out after 180s"}
		// ~3 minutes from now instead of succeeding in milliseconds.
		assert.strictEqual(res.ok, true, `expected success, got: ${res.error}`);
	});

	test('a large write on BOTH streams still completes', async () => {
		const script =
			`process.stderr.write("e".repeat(${OVER_PIPE_BUFFER}));` +
			`process.stdout.write("o".repeat(${OVER_PIPE_BUFFER}));` +
			`process.exit(0);`;
		const res = await runEngine(process.execPath, ['-e', script], os.tmpdir(), process.env);
		assert.strictEqual(res.ok, true, `expected success, got: ${res.error}`);
	});

	test('a non-zero exit is still reported as a failure', async () => {
		const script = 'process.stderr.write("boom"); process.exit(3);';
		const res = await runEngine(process.execPath, ['-e', script], os.tmpdir(), process.env);
		assert.strictEqual(res.ok, false);
		assert.ok(res.error && res.error.includes('boom'), `error should carry stderr: ${res.error}`);
	});

	test('a structured CLI failure on stdout survives as the error detail', async () => {
		// cli.py reports failures as {"status":"error",...} on STDOUT, not stderr.
		// Before the drain there was no stdout to fall back to and the user saw a
		// bare "exit 1".
		const script = 'process.stdout.write(\'{"status":"error","detail":"no endpoints"}\'); process.exit(1);';
		const res = await runEngine(process.execPath, ['-e', script], os.tmpdir(), process.env);
		assert.strictEqual(res.ok, false);
		assert.ok(
			res.error && res.error.includes('no endpoints'),
			`error should fall back to the stdout tail: ${res.error}`,
		);
	});

	test('a spawn failure resolves instead of throwing', async () => {
		const res = await runEngine(
			'definitely-not-a-real-binary-vinv-test',
			[],
			os.tmpdir(),
			process.env,
		);
		assert.strictEqual(res.ok, false);
		assert.ok(res.error, 'a spawn failure must carry a reason');
	});
});
