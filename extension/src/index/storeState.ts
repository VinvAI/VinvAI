/**
 * Questions about an index store on disk, answered without importing vscode.
 *
 * The store is a directory of plain files, so deciding whether it can be reused
 * needs nothing from the extension host — and keeping that decision here means
 * it is unit-testable against real fixtures rather than only inside a live
 * window. `index/indexing.ts` wraps these with the workspace paths and the
 * version this build expects.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * A *fully built* store: the vector file alongside the metadata the writer
 * saves last. Mirrors the completeness rule `isProjectIndexed` applies.
 */
export function storeIsComplete(storeDir: string): boolean {
	return (
		fs.existsSync(path.join(storeDir, 'meta.json')) &&
		fs.existsSync(path.join(storeDir, 'vectors.f32'))
	);
}

/** The store's format version, or undefined when it cannot be read. */
export function storeVersion(storeDir: string): number | undefined {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(storeDir, 'meta.json'), 'utf8')) as {
			version?: unknown;
		};
		return typeof meta.version === 'number' ? meta.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The embedding model recorded in the store, or undefined on an old or
 * unreadable one. Informational: the version is what decides reuse, since it is
 * bumped in lockstep with any change that makes existing vectors unqueryable.
 * This is for saying WHICH model a store was built with when explaining a
 * rebuild.
 */
export function storeEmbeddingModel(storeDir: string): string | undefined {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(storeDir, 'meta.json'), 'utf8')) as {
			embedding_model?: unknown;
		};
		return typeof meta.embedding_model === 'string' ? meta.embedding_model : undefined;
	} catch {
		return undefined;
	}
}

/**
 * True when this store can be reused as-is by a build expecting
 * `expectedVersion`.
 *
 * Equality, not `>=`: a store written by a NEWER engine holds vectors in a
 * format this build does not know, and reading them would be as wrong as
 * reading an older one. Either direction earns a rebuild.
 */
export function indexStoreIsCurrent(storeDir: string, expectedVersion: number): boolean {
	return storeIsComplete(storeDir) && storeVersion(storeDir) === expectedVersion;
}
