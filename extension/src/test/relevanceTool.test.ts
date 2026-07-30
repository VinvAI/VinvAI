/**
 * `relevant_to` — the relevance walk exposed to the agent.
 *
 * The contract these lock down is not "the walk works" (contextGraph.test.ts
 * covers the maths) but that the TOOL never answers ambiguously: an empty index
 * is not "nothing is relevant", an unknown symbol is not "no results", and a
 * budgeted list says so rather than reading as the whole truth.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveAnchors, toolRelevantTo } from '../mcp/relevanceTool';
import type { GraphNode } from '../graph/indexGraph';

function node(row: number, name: string, file: string): GraphNode {
	return {
		row,
		name,
		file,
		kind: 'function',
		lang: 'python',
		layer: 'service',
		start_line: 1,
		end_line: 10,
		summary: `function ${name}`,
		rank: 0.5,
		epoch: 1,
	} as unknown as GraphNode;
}

suite('relevant_to: anchor resolution', () => {
	const nodes = [
		node(0, 'handle', 'app/api.py'),
		node(1, 'handle', 'app/worker.py'),
		node(2, 'unique_name', 'app/util.py'),
	];

	test('a bare name matching several symbols resolves to ALL of them', () => {
		// The walk takes multiple anchors natively, so ambiguity is answered by
		// ranking rather than by an arbitrary pick — picking one silently would
		// be a guess presented as a resolution.
		const { rows, unresolved } = resolveAnchors(nodes, ['handle']);
		assert.deepStrictEqual(rows.sort(), [0, 1]);
		assert.deepStrictEqual(unresolved, []);
	});

	test('file:name disambiguates', () => {
		const { rows } = resolveAnchors(nodes, ['app/worker.py:handle']);
		assert.deepStrictEqual(rows, [1]);
	});

	test('an unknown symbol is REPORTED, not silently dropped', () => {
		const { rows, unresolved } = resolveAnchors(nodes, ['unique_name', 'nope']);
		assert.deepStrictEqual(rows, [2]);
		assert.deepStrictEqual(unresolved, ['nope'], 'the caller must learn their symbol was not found');
	});

	test('a partial resolution still returns the rows it did resolve', () => {
		const { rows, unresolved } = resolveAnchors(nodes, ['nope', 'unique_name']);
		assert.deepStrictEqual(rows, [2]);
		assert.deepStrictEqual(unresolved, ['nope']);
	});
});

suite('relevant_to: never answers ambiguously', () => {
	function emptyWorkspace(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-relevant-'));
	}

	test('no symbols is an error, not an empty result', () => {
		const r = toolRelevantTo(emptyWorkspace(), []);
		assert.strictEqual(r.status, 'error');
		assert.match(String(r.message), /at least one symbol/);
	});

	test('an absent index says so rather than reporting nothing is relevant', () => {
		const ws = emptyWorkspace();
		try {
			const r = toolRelevantTo(ws, ['anything']);
			// Either no store at all or an empty one — both must be distinguishable
			// from a successful walk that found nothing, which is the whole point.
			assert.ok(
				r.status === 'no_index' || r.status === 'error' || r.status === 'unresolved',
				`an empty workspace must not return status 'ok': ${r.status}`,
			);
			assert.notStrictEqual(r.status, 'ok');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});
