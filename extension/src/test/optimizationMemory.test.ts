/**
 * Memory dimension: the analyzer surfaces allocation churn (and leaks) in BYTES,
 * ranked in its own dimension separate from the ms candidates, driven through
 * the real disk pipeline (loadNodes → collectSymbolTimings → the analyzer).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { indexStoreDir, loadEdges, loadNodes } from '../graph/indexGraph';
import { collectMemoryTrends, collectSymbolTimings, unbounded } from '../harness/runtimeAnalysis';
import { computeOptimizationCandidates, dimensionOf, unitOf } from '../harness/optimizationAnalysis';

function writeStore(root: string, names: string[]): void {
	const store = indexStoreDir(root);
	fs.mkdirSync(store, { recursive: true });
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
	fs.writeFileSync(path.join(store, 'edges.jsonl'), '');
	fs.writeFileSync(path.join(store, 'meta.json'), JSON.stringify({ epoch: 1 }));
}

suite('optimizationAnalysis: dimension mapping', () => {
	test('waste kinds map to the right dimension and unit', () => {
		assert.strictEqual(dimensionOf('cache'), 'latency');
		assert.strictEqual(dimensionOf('serial-async'), 'parallelism');
		assert.strictEqual(dimensionOf('alloc-churn'), 'memory');
		assert.strictEqual(dimensionOf('mem-leak'), 'memory');
		assert.strictEqual(unitOf('memory'), 'bytes');
		assert.strictEqual(unitOf('latency'), 'ms');
	});
});

suite('optimization memory dimension (disk pipeline)', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-mem-'));
		writeStore(root, ['buildBig', 'tiny']);
		const lines: string[] = [];
		// buildBig allocates 500KB per call ×20; tiny allocates 10B once. Both
		// carry mem_delta_bytes so the tracer's memory visibility flag is set.
		for (let i = 0; i < 20; i++) {
			lines.push(JSON.stringify({ component: 'app.svc.buildBig', event: 'enter', request_id: 'R', thread_id: 1, ts: new Date(1000 + i).toISOString(), args_hash: `x${i}` }));
			lines.push(JSON.stringify({ component: 'app.svc.buildBig', event: 'exit', ts: new Date(1000 + i).toISOString(), duration_ms: 1, error_type: null, mem_delta_bytes: 500000 }));
		}
		lines.push(JSON.stringify({ component: 'app.svc.tiny', event: 'enter', request_id: 'R', thread_id: 1, ts: new Date(2000).toISOString(), args_hash: 't' }));
		lines.push(JSON.stringify({ component: 'app.svc.tiny', event: 'exit', ts: new Date(2000).toISOString(), duration_ms: 1, error_type: null, mem_delta_bytes: 10 }));
		const d = path.join(root, '.vinv', 'captures', 'r1', 'svc');
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, 'trace.jsonl'), lines.join('\n') + '\n');
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('a heavy allocator is surfaced as a memory candidate in bytes', () => {
		const store = indexStoreDir(root);
		const nodes = loadNodes(store);
		const list = computeOptimizationCandidates({
			nodes,
			edges: loadEdges(store, nodes.length),
			timings: collectSymbolTimings(root, nodes),
			cache: unbounded([], 'cache-pareto'),
			memoryLeaks: collectMemoryTrends(root, nodes),
		}).items;
		const big = list.find((c) => c.name === 'buildBig');
		assert.ok(big, 'buildBig allocates heavily and should surface');
		assert.strictEqual(big!.dimension, 'memory');
		assert.strictEqual(big!.unit, 'bytes');
		assert.strictEqual(big!.waste_kind, 'alloc-churn');
		assert.ok(big!.predicted_ms > 1_000_000, 'predicted is in bytes (half of ~10MB allocated)');
		assert.ok(!list.some((c) => c.name === 'tiny'), 'tiny is below the memory Pareto head');
	});
});
