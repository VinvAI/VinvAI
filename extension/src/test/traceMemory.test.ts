/**
 * Per-symbol memory aggregation from a tracelens capture — the data path the
 * call-tree memory flamegraph renders from (callTreeView metric 'mem').
 * Lines mirror the real exporter schema, including the post-fix `null` that a
 * memory-off capture now writes (previously an ambiguous 0).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getTraceMemory, memoryForNode } from '../identification/traceMemory';

function workspaceWithTrace(lines: string[]): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-mem-'));
	const dir = path.join(root, '.vinv', 'captures', 'vinv-bringup', 'svc');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'trace.jsonl'), lines.join('\n') + '\n');
	return root;
}

const exit = (component: string, mem: number | null): string =>
	JSON.stringify({
		event: 'exit',
		component,
		duration_ms: 1.2,
		mem_delta_bytes: mem,
		status: 'ok',
	});

suite('Trace memory aggregation (flamegraph data path)', () => {
	test('sums real per-call deltas per component; short-name index resolves nodes', () => {
		// Values from a real captured run (memdemo): retain keeps ~2MB per call,
		// scratch nets ~60 bytes because its buffer is freed.
		const root = workspaceWithTrace([
			exit('memdemo.main.retain_two_megabytes', 2_097_273),
			exit('memdemo.main.retain_two_megabytes', 2_097_241),
			exit('memdemo.main.scratch_allocation', 60),
			JSON.stringify({ event: 'enter', component: 'memdemo.main.main' }),
		]);
		try {
			const memory = getTraceMemory(root);
			assert.ok(memory, 'memory attribution present → facts returned');
			const retain = memoryForNode(memory, 'retain_two_megabytes', 'memdemo/main.py');
			assert.strictEqual(retain?.calls, 2);
			assert.strictEqual(retain?.memBytes, 4_194_514);
			assert.strictEqual(memoryForNode(memory, 'scratch_allocation', undefined)?.memBytes, 60);
			assert.strictEqual(memoryForNode(memory, 'not_traced', undefined), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('a memory-off capture (null deltas) yields undefined — the axis is omitted', () => {
		const root = workspaceWithTrace([
			exit('svc.mod.fn', null),
			exit('svc.mod.other', null),
		]);
		try {
			assert.strictEqual(getTraceMemory(root), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
