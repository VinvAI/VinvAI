/**
 * E2E for the stall breaker against the REAL model: does the Nash-bargaining
 * judge continue when the evidence contains an unexploited signal, and
 * escalate when two attempts show the same dead end with nothing new?
 *
 * Also exercises the session round-trip: directives parsed from simulated
 * harness output must land in .vinv/session.json.
 *
 * Usage: OPENAI_API_KEY=... node scripts/e2e-stall.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import https from 'https';

const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.VINV_E2E_MODEL ?? 'gpt-5.4-nano';
if (!apiKey) {
	console.error('OPENAI_API_KEY is required');
	process.exit(2);
}

const out = mkdtempSync(join(tmpdir(), 'vinv-e2e-stall-'));
const stub = join(out, 'vscode-stub.mjs');
writeFileSync(stub, 'export default {}; export const window = {}; export const commands = {};');

async function bundle(entry, name) {
	await build({
		entryPoints: [join(here, '..', 'src', ...entry)],
		bundle: true,
		format: 'esm',
		platform: 'node',
		outfile: join(out, name),
		alias: { vscode: stub },
		logLevel: 'silent',
	});
	return import(pathToFileURL(join(out, name)).href);
}
const stall = await bundle(['harness', 'stallBreaker.ts'], 'stall.mjs');
const session = await bundle(['harness', 'session.ts'], 'session.mjs');

function chat(messages) {
	const body = JSON.stringify({ model, messages });
	return new Promise((resolveP, rejectP) => {
		const req = https.request(
			'https://api.openai.com/v1/chat/completions',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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

let failures = 0;

// Case 1: evidence with an unexploited, named signal — a healthy judge
// usually continues with a mutation that references it. The judge MAY still
// escalate (it is allowed to be conservative), so the hard assertion is only
// on the mutation being concrete when continuing.
const signalA = [
	'replay failed: payment-api exited with code 1 after 0.4s',
	"ModuleNotFoundError: No module named 'stripe'",
	'start command: uv run python -m vinv_payment.main',
	'note: pyproject.toml lists stripe>=8 under [project.optional-dependencies].payments',
].join('\n');
const signalB = signalA.replace('0.4s', '0.5s');
const v1 = await stall.breakStall('payment-api will not start', signalA, signalB, chat);
console.log(
	`case 1 (unexploited signal): ${v1.action} nash=${v1.nash_continue.toFixed(3)} mutation="${v1.mutation}"`,
);
if (v1.action === 'continue') {
	const concrete = /stripe|optional|dependen|extras|pyproject|install/i.test(v1.mutation);
	if (!concrete) {
		console.error('FAIL: continued but the mutation ignores the evidence signal');
		failures += 1;
	}
}

// Case 2: same dead end twice, no new signal, destructive-looking territory —
// the judge should escalate rather than burn more attempts.
const deadEnd = [
	'replay failed: port 5432 refused connection',
	'attempted fixes so far: restarted service, regenerated config, reinstalled dependencies',
	'the database host is external (db.prod.internal) and unreachable from this machine',
].join('\n');
const v2 = await stall.breakStall('api cannot reach external prod database', deadEnd, deadEnd, chat);
console.log(
	`case 2 (dead end, external dependency): ${v2.action} nash=${v2.nash_continue.toFixed(3)}`,
);
if (v2.action !== 'escalate') {
	console.error('FAIL: judge kept going against an unreachable external dependency');
	failures += 1;
}

// Case 3: session round-trip — directives from simulated harness stdout.
const ws = mkdtempSync(join(tmpdir(), 'vinv-e2e-session-'));
const directives = session.parseHarnessDirectives(
	'thinking...\nVINV: SET_EPISODE_BUDGET 9\nVINV: SET_GOAL keep all services green\ndone.',
);
session.setEpisodeBudget(ws, directives.episodeBudget);
session.setGoal(ws, directives.goal);
const persisted = JSON.parse(readFileSync(join(ws, '.vinv', 'session.json'), 'utf8'));
if (persisted.episode_budget !== 9 || persisted.goal !== 'keep all services green') {
	console.error('FAIL: session round-trip did not persist the harness directives');
	failures += 1;
} else {
	console.log('case 3 (session round-trip): budget=9, goal persisted');
}

if (failures > 0) {
	console.error(`E2E stall FAIL (${failures})`);
	process.exit(1);
}
console.log('E2E stall PASS');
