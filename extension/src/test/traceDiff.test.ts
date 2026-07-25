/**
 * Trace-diff verdict: prove an optimization by comparing a function's per-call
 * cost between the before/after traces — which works even when the request
 * FAILED, because the functions that ran before the failure are still traced.
 * Same paired-bootstrap statistics as the probe engine; a trace-shaped behavior
 * oracle (the flow must fail the same way).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { indexStoreDir, loadNodes } from '../graph/indexGraph';
import { collectCallSamples, sameErrorSignature, traceDiffVerdict } from '../harness/traceDiff';

let root: string;

function nodes() {
	const store = indexStoreDir(root);
	fs.mkdirSync(store, { recursive: true });
	const names = ['validate', 'run'];
	const chunks = names.map((name, i) => ({
		id: `id${i}`,
		file: 'src/app/svc.py',
		lang: 'python',
		kind: 'function',
		name,
		start_line: i + 1,
		end_line: i + 9,
		rank: 0.5,
		epoch: 1,
		parent: null,
	}));
	fs.writeFileSync(path.join(store, 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
	fs.writeFileSync(path.join(store, 'meta.json'), JSON.stringify({ epoch: 1 }));
	return loadNodes(store);
}

/** validate runs `n` times at ~`dur`ms; run ALWAYS raises → a failing flow. */
function writeTrace(file: string, dur: number, n: number, runErrors = true): void {
	const lines: string[] = [];
	for (let i = 0; i < n; i++) {
		lines.push(JSON.stringify({ component: 'app.svc.validate', event: 'exit', duration_ms: dur + (i % 3), error_type: null, mem_delta_bytes: dur * 100 }));
	}
	lines.push(JSON.stringify({ component: 'app.svc.run', event: 'exit', duration_ms: 5, error_type: runErrors ? 'AgentGenerationError' : null }));
	fs.writeFileSync(file, lines.join('\n') + '\n');
}

suite('traceDiff: verdict from before/after traces', () => {
	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-td-'));
	});
	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('collectCallSamples pulls a per-call vector for the target function', () => {
		const N = nodes();
		const f = path.join(root, 'before.jsonl');
		writeTrace(f, 30, 40);
		const row = N.findIndex((n) => n.name === 'validate');
		assert.strictEqual(collectCallSamples(f, N, row, 'duration').length, 40);
		assert.strictEqual(collectCallSamples(f, N, row, 'bytes').length, 40);
	});

	test('a faster function on a FAILING flow is PROVEN', () => {
		const N = nodes();
		const before = path.join(root, 'before.jsonl');
		const after = path.join(root, 'after.jsonl');
		writeTrace(before, 30, 40);
		writeTrace(after, 6, 40); // fixed; flow still fails the same way
		const row = N.findIndex((n) => n.name === 'validate');
		const b = collectCallSamples(before, N, row, 'duration');
		const a = collectCallSamples(after, N, row, 'duration');
		assert.ok(sameErrorSignature(before, after), 'flow fails identically before and after');
		const v = traceDiffVerdict(b, a, true);
		assert.strictEqual(v.status, 'proven');
		assert.ok(v.comparison.ci_low > 0, 'CI excludes zero on the faster side');
	});

	test('no change is INCONCLUSIVE', () => {
		const N = nodes();
		const before = path.join(root, 'before.jsonl');
		writeTrace(before, 30, 40);
		const row = N.findIndex((n) => n.name === 'validate');
		const b = collectCallSamples(before, N, row, 'duration');
		assert.strictEqual(traceDiffVerdict(b, b.slice(), true).status, 'inconclusive');
	});

	test('a behavior change (different error signature) is REGRESSED', () => {
		const N = nodes();
		const before = path.join(root, 'before.jsonl');
		const afterOk = path.join(root, 'afterok.jsonl');
		writeTrace(before, 30, 40);
		writeTrace(afterOk, 6, 40, /* runErrors */ false); // flow now SUCCEEDS — behavior changed
		const row = N.findIndex((n) => n.name === 'validate');
		const b = collectCallSamples(before, N, row, 'duration');
		const a = collectCallSamples(afterOk, N, row, 'duration');
		assert.ok(!sameErrorSignature(before, afterOk), 'error signature differs');
		assert.strictEqual(traceDiffVerdict(b, a, false).status, 'regressed');
	});

	test('memory (bytes) proves through the same path', () => {
		const N = nodes();
		const before = path.join(root, 'before.jsonl');
		const after = path.join(root, 'after.jsonl');
		writeTrace(before, 30, 40);
		writeTrace(after, 6, 40);
		const row = N.findIndex((n) => n.name === 'validate');
		const v = traceDiffVerdict(
			collectCallSamples(before, N, row, 'bytes'),
			collectCallSamples(after, N, row, 'bytes'),
			true,
		);
		assert.strictEqual(v.status, 'proven');
	});
});
