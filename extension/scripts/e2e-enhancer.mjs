/**
 * E2E for the graph-enhancement agents against a LIVE store and a REAL key.
 *
 * Bundles src/graph/graphEnhancer.ts (vscode stubbed — the functions under
 * test never touch it) and runs:
 *   1. readPendingEdges/readAdjudicated on the real store,
 *   2. adjudicateOne on the N highest-rank pending references via the real
 *      OpenAI chat API (validated contract, retry-on-violation),
 *   3. appends the resolutions to edge_overrides.jsonl,
 *   4. verifies the Shapley/policy updater on a synthetic ledger.
 *
 * Usage: OPENAI_API_KEY=... node scripts/e2e-enhancer.mjs <repo-root> [batch]
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import https from 'https';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.argv[2] ?? process.cwd());
const batch = Number.parseInt(process.argv[3] ?? '8', 10);
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.VINV_E2E_MODEL ?? 'gpt-5.4-nano';
if (!apiKey) {
	console.error('OPENAI_API_KEY is required');
	process.exit(2);
}

const out = mkdtempSync(join(tmpdir(), 'vinv-e2e-enhancer-'));
const stub = join(out, 'vscode-stub.mjs');
writeFileSync(stub, 'export default {}; export const window = {}; export const commands = {};');

await build({
	entryPoints: [join(here, '..', 'src', 'graph', 'graphEnhancer.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: join(out, 'graphEnhancer.mjs'),
	alias: { vscode: stub },
	logLevel: 'silent',
});
const enhancer = await import(pathToFileURL(join(out, 'graphEnhancer.mjs')).href);

await build({
	entryPoints: [join(here, '..', 'src', 'harness', 'episodePolicyUpdater.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: join(out, 'updater.mjs'),
	alias: { vscode: stub },
	logLevel: 'silent',
});
const updater = await import(pathToFileURL(join(out, 'updater.mjs')).href);

function chat(messages) {
	const body = JSON.stringify({ model, messages });
	return new Promise((resolveP, rejectP) => {
		const req = https.request(
			'https://api.openai.com/v1/chat/completions',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
			},
			(res) => {
				let data = '';
				res.on('data', (c) => (data += c));
				res.on('end', () => {
					try {
						const parsed = JSON.parse(data);
						if (res.statusCode < 200 || res.statusCode >= 300) {
							rejectP(new Error(parsed.error?.message ?? `HTTP ${res.statusCode}`));
							return;
						}
						resolveP(parsed.choices[0].message.content);
					} catch (e) {
						rejectP(e);
					}
				});
			},
		);
		req.on('error', rejectP);
		req.setTimeout(120_000, () => req.destroy(new Error('timeout')));
		req.write(body);
		req.end();
	});
}

const storeDir = join(repoRoot, '.vinv', 'index');
if (!existsSync(join(storeDir, 'pending_edges.jsonl'))) {
	console.log('no pending edges in the store — nothing to adjudicate; PASS (vacuous)');
	process.exit(0);
}

const done = enhancer.readAdjudicated(storeDir);
const queue = enhancer
	.readPendingEdges(storeDir)
	.filter((r) => !done.has(`${r.src_id}\u0000${r.name}`));
console.log(`pending: ${queue.length} unadjudicated reference(s)`);
let sample;
if (process.argv[3] === 'all') {
	sample = queue;
} else {
	// Sample half from the top of the rank queue (often generic names, where the
	// correct action is abstention) and half with specific multi-word names
	// (where the evidence usually suffices to resolve) — both behaviors must show.
	const specific = queue.filter((r) => r.name.length >= 10);
	sample = [...queue.slice(0, Math.ceil(batch / 2)), ...specific.slice(0, Math.floor(batch / 2))];
}
console.log(`processing ${sample.length} reference(s)`);

let resolved = 0;
let abstained = 0;
let completedCount = 0;
const overrides = [];
const t0 = Date.now();
const workers = Math.max(1, Math.min(sample.length, Number.parseInt(process.env.VINV_ENHANCER_CONCURRENCY ?? '6', 10) || 6));
let cursor = 0;
async function worker() {
	for (;;) {
		const i = cursor++;
		if (i >= sample.length) return;
		const record = sample[i];
		const dst = await enhancer.adjudicateOne(record, chat);
		completedCount += 1;
		if (dst) {
			resolved += 1;
			overrides.push({ src_id: record.src_id, dst_id: dst, name: record.name, kind: 'invoke' });
			console.log(`  [${completedCount}/${sample.length}] resolve ${record.src_name} -> ${record.name} = ${dst}`);
		} else {
			abstained += 1;
			console.log(`  [${completedCount}/${sample.length}] abstain ${record.src_name} -> ${record.name}`);
		}
	}
}
await Promise.all(Array.from({ length: workers }, worker));
console.log(
	`adjudicated ${sample.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${resolved} resolved, ${abstained} abstained`,
);
if (overrides.length > 0) {
	appendFileSync(
		join(storeDir, 'edge_overrides.jsonl'),
		overrides.map((r) => JSON.stringify(r)).join('\n') + '\n',
	);
	console.log(`appended ${overrides.length} override(s) to edge_overrides.jsonl`);
}

// Sanity on live data: every resolution must reference a real chunk id.
const chunkIds = new Set(
	readFileSync(join(storeDir, 'chunks.jsonl'), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l).id),
);
for (const o of overrides) {
	if (!chunkIds.has(o.dst_id)) {
		console.error(`FAIL: adjudicated dst_id ${o.dst_id} is not a real chunk`);
		process.exit(1);
	}
}

// Policy updater on a synthetic-but-realistic ledger: arm 3 dominant with
// enough evidence to clear the (deliberately conservative) Bernstein bound.
const episodes = [];
for (let i = 0; i < 30; i++) {
	episodes.push({ armIndex: 3, propensity: 0.8, reward: 1, attempts: 1, verified: true });
}
for (let i = 0; i < 10; i++) {
	episodes.push({ armIndex: 1, propensity: 0.1, reward: 0, attempts: 3, verified: false });
}
const next = updater.computeUpdatedPolicy(
	{ ...(await importPriors()), preferred_arm: 1 },
	episodes,
);
async function importPriors() {
	await build({
		entryPoints: [join(here, '..', 'src', 'harness', 'episodeTelemetry.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		outfile: join(out, 'telemetry.mjs'),
		alias: { vscode: stub },
		logLevel: 'silent',
	});
	const t = await import(pathToFileURL(join(out, 'telemetry.mjs')).href);
	return t.POLICY_PRIORS;
}
if (next.preferred_arm !== 3) {
	console.error(`FAIL: updater did not promote the dominant arm (got ${next.preferred_arm})`);
	process.exit(1);
}
console.log(
	`policy updater: promoted arm ${next.preferred_arm}, budget ${next.attempt_budget}, attribution ${JSON.stringify(next.attribution)}`,
);
console.log('E2E enhancer PASS');
