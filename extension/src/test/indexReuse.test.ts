/**
 * Tests for `indexIsCurrent` — the guard that decides whether an install owes
 * the repository a full re-embed.
 *
 * The store version IS the embedding model: v5 is a 768-dim CodeRankEmbed store
 * and v6 the 384-dim granite one, bumped in lockstep whenever a change makes
 * existing vectors unqueryable. So the only store worth rebuilding is one whose
 * version is not this build's.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// EXPECTED_STORE_VERSION is duplicated here rather than imported: indexing.ts
// pulls in vscode, which cannot load outside the extension host.
import { indexStoreIsCurrent, storeEmbeddingModel } from '../index/storeState';

const EXPECTED_STORE_VERSION = 6;

/** A workspace whose store holds `meta` — omit files to model a partial store. */
function workspace(meta: unknown, opts: { vectors?: boolean; metaFile?: boolean } = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-index-'));
	const store = path.join(root, '.vinv', 'index');
	fs.mkdirSync(store, { recursive: true });
	if (opts.metaFile !== false) {
		fs.writeFileSync(
			path.join(store, 'meta.json'),
			typeof meta === 'string' ? meta : JSON.stringify(meta),
			'utf8',
		);
	}
	if (opts.vectors !== false) {
		fs.writeFileSync(path.join(store, 'vectors.f32'), 'x', 'utf8');
	}
	return root;
}

/** The store dir inside a workspace, as indexing.ts computes it. */
const current = (root: string): boolean =>
	indexStoreIsCurrent(path.join(root, '.vinv', 'index'), EXPECTED_STORE_VERSION);

suite('index reuse — when an install owes a rebuild', () => {
	test('a complete store at this version is reused', () => {
		const root = workspace({
			version: EXPECTED_STORE_VERSION,
			embedding_model: 'ibm-granite/granite-embedding-small-english-r2',
			dim: 384,
		});
		assert.strictEqual(current(root), true);
	});

	test('a CodeRankEmbed store from the previous version is not', () => {
		const root = workspace({
			version: EXPECTED_STORE_VERSION - 1,
			embedding_model: 'nomic-ai/CodeRankEmbed',
			dim: 768,
		});
		assert.strictEqual(current(root), false);
	});

	test('a store from a NEWER version is not reused either', () => {
		// Downgrading the extension must not read vectors written by a format it
		// does not know; equality, not >=, is the contract.
		const root = workspace({ version: EXPECTED_STORE_VERSION + 1 });
		assert.strictEqual(current(root), false);
	});

	test('a half-written store is not reused', () => {
		const noVectors = workspace({ version: EXPECTED_STORE_VERSION }, { vectors: false });
		assert.strictEqual(current(noVectors), false);
		const noMeta = workspace(null, { metaFile: false });
		assert.strictEqual(current(noMeta), false);
	});

	test('an unreadable or version-less meta is not reused', () => {
		assert.strictEqual(current(workspace('{not json')), false);
		assert.strictEqual(current(workspace({ embedding_model: 'x' })), false);
	});

	test('a workspace with no store at all is not reused', () => {
		assert.strictEqual(current(fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-bare-'))), false);
	});

	test('the recorded model is readable, for explaining a rebuild', () => {
		const root = workspace({ version: 5, embedding_model: 'nomic-ai/CodeRankEmbed' });
		assert.strictEqual(
			storeEmbeddingModel(path.join(root, '.vinv', 'index')),
			'nomic-ai/CodeRankEmbed',
		);
	});
});
