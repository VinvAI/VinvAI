import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildRemovalPrompt,
	buildVerifyPrompt,
	explainRemoval,
	parseRemoval,
	parseVerdict,
	readFindings,
	symbolKey,
	verifyDeadSymbol,
	type AgentDispatch,
	type SymbolHistory,
} from '../harness/deadCodeVerify';
import type { DeadSymbol } from '../index/deadCodeScan';

const sym: DeadSymbol = {
	file: 'exerciser/_worker.py',
	line: 78,
	end: 141,
	kind: 'function',
	name: 'run_worker',
	ambiguous: false,
	deadCallers: [],
};

const lost: SymbolHistory = {
	reason: 'lost its calls',
	born: '2026-07-28',
	commits: 2,
	recent: ['53da72c 2026-07-31 feat: report how a run went'],
	ambiguous: false,
};
const never: SymbolHistory = {
	reason: 'never wired',
	born: '2026-07-28',
	commits: 1,
	recent: [],
	ambiguous: false,
};

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-dead-'));
}

suite('dead code verify: the prompt asks for a check, not a restatement', () => {
	test('the verify prompt states what the scan cannot see', () => {
		const p = buildVerifyPrompt(sym, 'def run_worker():\n    pass', never);
		assert.ok(p.includes('run_worker'), p);
		assert.ok(p.includes('exerciser/_worker.py:78'));
		// Without these the agent has no reason to doubt the finding, and simply
		// agrees with it.
		assert.ok(/reflection/.test(p), p);
		assert.ok(p.includes('is NOT the same as "it is safe to delete"'), p);
		assert.ok(p.includes('"safe_to_delete"'));
	});

	test('the verify prompt passes the history and flags an unreliable one', () => {
		const p = buildVerifyPrompt(sym, 'x', { ...never, ambiguous: true });
		assert.ok(p.includes('never wired'), p);
		assert.ok(p.includes('name is not unique'), p);
	});

	test('the removal prompt names the commits and refuses invented shas', () => {
		const p = buildRemovalPrompt(sym, 'x', lost);
		assert.ok(p.includes('53da72c'), p);
		assert.ok(p.includes('leave the'), p);
		assert.ok(p.includes('"old_flow"') && p.includes('"new_flow"'), p);
	});
});

suite('dead code verify: a transitively dead symbol says so', () => {
	test('the prompt states that callers exist and are themselves dead', () => {
		const chained = { ...sym, deadCallers: ['gaia_scorer.py:34:question_scorer'] };
		const p = buildVerifyPrompt(chained, 'x', never);
		assert.ok(p.includes('this symbol IS called'), p);
		assert.ok(p.includes('gaia_scorer.py:34:question_scorer'), p);
		// Without this the agent finds the call site and answers "still-used",
		// contradicting a report that was right about the chain.
		assert.ok(p.includes('TOP of that chain'), p);
	});

	test('a chain-top symbol is told nothing references it', () => {
		const p = buildVerifyPrompt(sym, 'x', never);
		assert.ok(p.includes('top of its chain'), p);
		assert.ok(!p.includes('this symbol IS called'), p);
	});
});

suite('dead code verify: replies are parsed conservatively', () => {
	test('a verdict without "what" is not a verdict', () => {
		assert.strictEqual(parseVerdict('{"verdict": {"verdict": "confirmed-dead"}}'), null);
	});

	test('an unusable reply yields nothing rather than a default verdict', () => {
		assert.strictEqual(parseVerdict('the agent rambled'), null);
		assert.strictEqual(parseRemoval('{"removal": {}}'), null);
	});

	test('safe_to_delete is opt-in — anything but true reads as false', () => {
		const yes = parseVerdict('{"verdict": {"what": "w", "safe_to_delete": true}}');
		const nope = parseVerdict('{"verdict": {"what": "w", "safe_to_delete": "yes"}}');
		assert.strictEqual(yes?.safeToDelete, true);
		// A string "yes" is exactly the shape that would delete working code.
		assert.strictEqual(nope?.safeToDelete, false);
	});

	test('an unknown verdict or confidence falls back to the cautious value', () => {
		const v = parseVerdict('{"verdict": {"what": "w", "verdict": "probably", "confidence": "certain"}}');
		assert.strictEqual(v?.verdict, 'unclear');
		assert.strictEqual(v?.confidence, 'low');
	});

	test('a removal story keeps the commit, the replacement and both flows', () => {
		const r = parseRemoval(
			'{"removal": {"commit": "53da72c", "why": "moved to v2", "replacement": "run_v2",' +
				' "old_flow": "a -> run_worker", "new_flow": "a -> run_v2"}}',
		);
		assert.strictEqual(r?.commit, '53da72c');
		assert.strictEqual(r?.replacement, 'run_v2');
		assert.strictEqual(r?.oldFlow, 'a -> run_worker');
		assert.strictEqual(r?.newFlow, 'a -> run_v2');
	});
});

suite('dead code verify: results persist per symbol', () => {
	test('a verdict is stored under the symbol identity, not its line alone', async () => {
		const root = tmp();
		const dispatch: AgentDispatch = async () =>
			'{"verdict": {"what": "spawns a worker", "verdict": "confirmed-dead", "safe_to_delete": true}}';
		const v = await verifyDeadSymbol(root, sym, 'src', never, dispatch);
		assert.strictEqual(v?.verdict, 'confirmed-dead');
		const stored = readFindings(root).symbols[symbolKey(sym)];
		assert.strictEqual(stored?.verdict?.what, 'spawns a worker');
	});

	test('a removal answer merges beside an existing verdict rather than replacing it', async () => {
		const root = tmp();
		await verifyDeadSymbol(root, sym, 'src', never, async () => '{"verdict": {"what": "w"}}');
		await explainRemoval(root, sym, 'src', lost, async () => '{"removal": {"why": "superseded"}}');
		const stored = readFindings(root).symbols[symbolKey(sym)];
		assert.strictEqual(stored?.verdict?.what, 'w');
		assert.strictEqual(stored?.removal?.why, 'superseded');
	});

	test('an unusable reply records nothing at all', async () => {
		const root = tmp();
		const out = await verifyDeadSymbol(root, sym, 'src', never, async () => 'no json here');
		assert.strictEqual(out, null);
		// A fabricated "probably safe" would be strictly worse than silence.
		assert.deepStrictEqual(readFindings(root).symbols, {});
	});

	test('a harness that cannot answer is a null, not a thrown error', async () => {
		const root = tmp();
		const out = await explainRemoval(root, sym, 'src', lost, async () => null);
		assert.strictEqual(out, null);
	});
});
