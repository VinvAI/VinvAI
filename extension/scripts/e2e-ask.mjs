/**
 * E2E for the Ask Vinv evidence pipeline against a LIVE store — the code path
 * the panel's Ask button runs up to the harness dispatch:
 *   gatherEvidence (index query → graph slice → runtime evidence)
 *   → buildQnaPrompt.
 *
 * Usage: node scripts/e2e-ask.mjs <repo-root> "<question>"
 * The answer step itself runs through the user's coding-agent CLI in-product,
 * so this harness stops at the composed prompt and verifies the evidence.
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.argv[2] ?? process.cwd());
const question = process.argv[3] ?? 'How does the bringup verify a recorded start command?';

const out = mkdtempSync(join(tmpdir(), 'vinv-e2e-ask-'));
const stub = join(out, 'vscode-stub.mjs');
// The stub has to satisfy every vscode surface the pipeline actually touches on
// this path, not just the ones it names. `workspace.getConfiguration` is the one
// that matters: engine resolution calls it before the index binary is located,
// so a stub without it threw "getConfiguration is not a function" inside
// runIndexQuery — which gatherEvidence catches — and the run always ended
// "no evidence at all: retrieval or store is broken". This harness could not
// pass on a healthy machine, and its failure text blamed the store.
writeFileSync(
	stub,
	`const cfg = { get: (_key, fallback) => fallback, has: () => false, inspect: () => undefined, update: async () => {} };
export const workspace = { workspaceFolders: [], getConfiguration: () => cfg };
export const window = { showErrorMessage: () => Promise.resolve(undefined), showWarningMessage: () => Promise.resolve(undefined) };
export const commands = { executeCommand: () => Promise.resolve(undefined) };
export default { workspace, window, commands };`,
);

await build({
	entryPoints: [join(here, '..', 'src', 'qna', 'answer.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: join(out, 'answer.mjs'),
	alias: { vscode: stub },
	logLevel: 'silent',
});
const qna = await import(pathToFileURL(join(out, 'answer.mjs')).href);

const fakeContext = { extensionPath: out };
const t0 = Date.now();
console.log(`[1/3] gathering evidence for: "${question}"`);
const evidence = await qna.gatherEvidence(fakeContext, repoRoot, question);
console.log(
	`      hits=${evidence.hits.length} slice=${evidence.slice.length} ` +
		`citations=${evidence.citations.length} context=${evidence.contextMarkdown.length} chars ` +
		`(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);
if (evidence.hits.length === 0 && evidence.slice.length === 0) {
	console.error('FAIL: no evidence at all — retrieval or store is broken');
	process.exit(1);
}

console.log('[2/3] building the harness prompt…');
const prompt = qna.buildQnaPrompt(question, evidence);
console.log(`      prompt is ${prompt.length} chars`);

console.log('[3/3] evidence citations:');
console.log('---');
for (const c of evidence.citations.slice(0, 8)) {
	console.log(`  cite ${c.file}:${c.line} (${c.kind}) ${c.name}`);
}
console.log(
	evidence.citations.length > 0
		? 'PASS: evidence pipeline produced grounded citations'
		: 'WARN: no citations in the gathered evidence',
);
