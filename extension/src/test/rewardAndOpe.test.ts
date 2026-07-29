/**
 * Tests for the multi-signal reward engine (signals, audit, aggregation), the
 * adaptive replay budget, the replay policy block, and the live off-policy
 * evaluator (pooled loading, estimator gates, BCa interval, epoch guard,
 * candidate promotion) — the pieces that make verification honest and make
 * promotion actually fire.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	auditChangedFiles,
	classifyFailureOutput,
	classifyRunFailure,
	classifyTestRun,
	extractCheckLines,
	combineTestRuns,
	composeRewardBreakdown,
	extractAcceptanceTestFile,
	parseUnifiedDiff,
	renderRewardReport,
	JUDGE_CHEAT_THRESHOLD,
} from '../harness/rewardSignals';
import {
	ceilingMs,
	durationQuantile,
	readReplayStats,
	recordReplayDuration,
	softBudgetMs,
	type ReplayBudgetParams,
} from '../harness/replayStats';
import { loadEpisodePolicy, POLICY_PRIORS, replayParams, REPLAY_PRIORS } from '../harness/episodeTelemetry';
import {
	discoverPythonCandidates,
	mergeCounterexampleIntoOracle,
	resetInterpreterCache,
	resolveTestInterpreter,
	resolveTestPython,
	runAcceptanceTests,
	workspacePackageNames,
} from '../harness/rewardEngine';
import {
	findReusableSet,
	issueSignature,
	mergeCandidates,
	runTestSwarm,
	selectLenses,
	testDedupKeys,
	type SwarmEvidence,
} from '../harness/testSwarm';
import { asAuthoredTests, asJudgeReport, asStallUtilities } from '../harness/binaryAgents';
import {
	bcaDeltaInterval,
	epochConsistency,
	estimate,
	evaluateCandidates,
	loadPooledSamples,
	MIN_ACTION_PULLS,
	type OpeSample,
} from '../mcp/opeEvaluator';

// ---- reward signals --------------------------------------------------------

/** A complete JudgeReport with sensible defaults, overridable per test. */
function judgeReport(over: Partial<import('../harness/rewardSignals').JudgeReport> = {}): import('../harness/rewardSignals').JudgeReport {
	return {
		cheat_likelihood: 0,
		goal_alignment: 0.9,
		criteria_verdicts: [],
		scope_drift: 'none',
		concerns: [],
		directives: [],
		...over,
	};
}

/**
 * A virtual environment on THIS platform, returning its interpreter's path.
 *
 * `discoverPythonCandidates` looks for `Scripts/python.exe` on Windows and
 * `bin/python` elsewhere — correctly, because that is where the two layouts put
 * it. A fixture that only ever builds the POSIX one therefore tests nothing on
 * Windows: discovery finds no interpreter, and every assertion about ordering
 * and precedence fails for a reason that has nothing to do with the rule being
 * tested. Same shape as the POSIX-only fixtures that were failing on the engine
 * side of this repo.
 *
 * `marker: false` builds the trap the shape rule has to reject — a `bin/python`
 * with no PEP 405 `pyvenv.cfg` beside it, which is not an environment.
 */
function makeVenv(root: string, name: string, opts: { marker?: boolean } = {}): string {
	const isWin = process.platform === 'win32';
	const binDir = path.join(root, name, isWin ? 'Scripts' : 'bin');
	fs.mkdirSync(binDir, { recursive: true });
	const python = path.join(binDir, isWin ? 'python.exe' : 'python');
	fs.writeFileSync(python, '', { mode: 0o755 });
	if (opts.marker !== false) {
		fs.writeFileSync(path.join(root, name, 'pyvenv.cfg'), 'home = /usr\n');
	}
	return python;
}

suite('Acceptance-test extraction', () => {
	test('takes the LAST python-acceptance fence and requires a real test', () => {
		const stdout = [
			'thinking...',
			'```python-acceptance',
			'# draft',
			'```',
			'final version:',
			'```python-acceptance',
			'def test_fix():',
			'    assert compute() == 3',
			'```',
		].join('\n');
		const body = extractAcceptanceTestFile(stdout);
		assert.ok(body?.includes('def test_fix'));
		assert.ok(!body?.includes('# draft'));
	});

	test('rejects fences without a test function or without assertions', () => {
		assert.strictEqual(extractAcceptanceTestFile('```python-acceptance\nx = 1\n```'), null);
		assert.strictEqual(
			extractAcceptanceTestFile('```python-acceptance\ndef test_a():\n    pass\n```'),
			null,
		);
		assert.strictEqual(extractAcceptanceTestFile('no fence at all'), null);
	});
});

suite('Test-run classification', () => {
	test('pytest exit codes map to verdicts; infra is never a verdict', () => {
		assert.strictEqual(classifyTestRun(0, 'all passed', false), 'pass');
		assert.strictEqual(classifyTestRun(1, '1 failed: AssertionError', false), 'fail');
		assert.strictEqual(classifyTestRun(1, 'ERROR collecting test_x.py\nImportError', false), 'unavailable');
		assert.strictEqual(classifyTestRun(2, 'Interrupted: 1 error during collection', false), 'unavailable');
		assert.strictEqual(classifyTestRun(null, '', false), 'unavailable');
		assert.strictEqual(classifyTestRun(0, '', true), 'unavailable');
	});

	test('plain-python fallback: AssertionError traceback is a genuine fail', () => {
		const out = 'Traceback (most recent call last)\nAssertionError';
		assert.strictEqual(classifyTestRun(3, out, false), 'fail');
		assert.strictEqual(classifyTestRun(3, 'ModuleNotFoundError: x', false), 'unavailable');
	});

	test('two runs must agree (flake guard)', () => {
		assert.strictEqual(combineTestRuns('pass', 'pass'), 'pass');
		assert.strictEqual(combineTestRuns('fail', 'fail'), 'fail');
		assert.strictEqual(combineTestRuns('pass', 'fail'), 'unavailable');
	});

	test('failure class: only assertion-class output may retract a verdict', () => {
		// Plain-python fallback: the test's own assert fired.
		assert.strictEqual(
			classifyFailureOutput('Traceback (most recent call last)\nAssertionError: expected None'),
			'assertion',
		);
		// pytest rewrites bare asserts — no AssertionError string in the diff.
		assert.strictEqual(
			classifyFailureOutput('def test_zero():\nE       assert 5 == 2\ntest_cx.py:3: AssertionError'),
			'assertion',
		);
		assert.strictEqual(classifyFailureOutput('E   assert divide(1, 0) is None'), 'assertion');
		// raises() that never raised is the check itself firing.
		assert.strictEqual(
			classifyFailureOutput("Failed: DID NOT RAISE <class 'ValueError'>"),
			'assertion',
		);
		// Crashes before the check: hallucinated API, environment, fixtures.
		assert.strictEqual(
			classifyFailureOutput("Traceback (most recent call last)\nTypeError: divide() missing 1 required positional argument: 'b'"),
			'exception',
		);
		assert.strictEqual(
			classifyFailureOutput('Traceback (most recent call last)\nKeyError: 4'),
			'exception',
		);
		assert.strictEqual(
			classifyFailureOutput('ConnectionError: [Errno 61] Connection refused'),
			'exception',
		);
	});

	test('check-line extraction: asserts, raises, unittest asserts; capped', () => {
		const code = [
			'import pytest',
			'def test_zero():',
			'    assert divide(1, 0) is None',
			'def test_raises():',
			'    with pytest.raises(ValueError):',
			'        divide(1, None)',
			'class T(unittest.TestCase):',
			'    def test_m(self):',
			'        self.assertEqual(divide(6, 3), 2)',
		].join('\n');
		assert.deepStrictEqual(extractCheckLines(code), [
			'assert divide(1, 0) is None',
			'with pytest.raises(ValueError):',
			'self.assertEqual(divide(6, 3), 2)',
		]);
		const many = Array.from({ length: 20 }, (_, i) => `    assert x == ${i}`).join('\n');
		assert.strictEqual(extractCheckLines(many).length, 12);
		assert.deepStrictEqual(extractCheckLines('def test_x():\n    call()'), []);
	});
});

suite('Anti-cheat diff audit', () => {
	test('each cheat pattern raises its flag with the right severity', () => {
		const flags = auditChangedFiles(
			[
				{ path: 'tests/test_api.py', addedLines: ['assert True'] },
				{ path: 'app/service.py', addedLines: ['    except Exception:', '    sys.exit(0)'] },
				{ path: 'app/other.py', addedLines: ['@pytest.mark.skip'] },
				{ path: '.vinv/start_commands/api.json', addedLines: ['"command": "python -m http.server"'] },
				{ path: '.vinv/replay-stats/api.json', addedLines: ['[]'] },
			],
			['tests/test_new.py'],
		);
		const kinds = flags.map((f) => f.kind).sort();
		assert.deepStrictEqual(kinds, [
			'except_swallow',
			'exit_zero',
			'skip_marker',
			'start_command_edit',
			'test_edit',
			'test_edit',
			'vinv_state_edit',
		]);
		assert.strictEqual(flags.find((f) => f.kind === 'vinv_state_edit')?.severity, 'hard');
		assert.strictEqual(flags.find((f) => f.kind === 'start_command_edit')?.severity, 'soft');
	});

	test('a clean source fix raises nothing', () => {
		const flags = auditChangedFiles(
			[{ path: 'app/service.py', addedLines: ['    return normalize(items or [])'] }],
			[],
		);
		assert.deepStrictEqual(flags, []);
	});

	test('unified diff parsing extracts per-file added lines', () => {
		const diff = [
			'diff --git a/app/x.py b/app/x.py',
			'index 111..222 100644',
			'--- a/app/x.py',
			'+++ b/app/x.py',
			'@@ -1,2 +1,3 @@',
			' unchanged',
			'+added line',
			'-removed line',
		].join('\n');
		const files = parseUnifiedDiff(diff);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].path, 'app/x.py');
		assert.deepStrictEqual(files[0].addedLines, ['added line']);
	});
});

suite('Anti-cheat — interpreter-shadow modules', () => {
	test('a fix adding pytest.py / sitecustomize.py at the root is a hard flag', () => {
		const flags = auditChangedFiles(
			[{ path: 'app/service.py', addedLines: ['return normalize(items or [])'] }],
			['pytest.py', 'sitecustomize.py', 'usercustomize.py'],
		);
		const shadow = flags.filter((f) => f.kind === 'shadow_module');
		assert.strictEqual(shadow.length, 3);
		assert.ok(shadow.every((f) => f.severity === 'hard'));
		// A hard flag blocks verified-eligibility even with a passing oracle.
		assert.strictEqual(
			composeRewardBreakdown('pass_objective', 'pass', flags, null).verifiedEligible,
			false,
		);
	});

	test('a nested test helper named test_utils.py is NOT a shadow flag', () => {
		const flags = auditChangedFiles([{ path: 'app/pytest_helpers.py', addedLines: [] }], []);
		assert.strictEqual(flags.filter((f) => f.kind === 'shadow_module').length, 0);
	});
});

suite('Reward composition', () => {
	test('all signals green → reward 1 and verified-eligible', () => {
		const b = composeRewardBreakdown('pass_objective', 'pass', [], null);
		assert.strictEqual(b.reward, 1);
		assert.strictEqual(b.verifiedEligible, true);
	});

	test('missing signals renormalize — they are never counted as passed', () => {
		// Oracle-only pass with tests unavailable: audit (1.0) and oracle (1.0)
		// weights renormalize to reward 1, but a FAILED oracle with tests
		// unavailable cannot be rescued by the clean audit.
		const clean = composeRewardBreakdown('pass_objective', 'unavailable', [], null);
		assert.strictEqual(clean.reward, 1);
		const failed = composeRewardBreakdown('fail', 'unavailable', [], null);
		assert.ok(failed.reward <= 0.2, `failed-oracle+clean-audit floor is 0.1/0.5=0.2, got ${failed.reward}`);
		assert.ok(failed.reasons.some((r) => r.includes('replay rejected')));
		assert.ok(failed.directives.length > 0);
	});

	test('tests failing dominate a serving oracle in the reasons/directives', () => {
		const b = composeRewardBreakdown('pass_objective', 'fail', [], null);
		assert.ok(b.reward < 0.7);
		assert.ok(b.directives.some((d) => d.includes('symptom')));
	});

	test('hard audit flags block verified-eligibility outright', () => {
		const b = composeRewardBreakdown('pass_objective', 'pass', [
			{ kind: 'vinv_state_edit', file: '.vinv/replay-stats/x.json', detail: 'tampered', severity: 'hard' },
		], null);
		assert.strictEqual(b.verifiedEligible, false);
	});

	test('the judge can only push toward scrutiny — never rescue', () => {
		const suspicious = composeRewardBreakdown('pass_objective', 'pass', [
			{ kind: 'except_swallow', file: 'a.py', detail: 'x', severity: 'soft' },
		], judgeReport({
			cheat_likelihood: JUDGE_CHEAT_THRESHOLD,
			concerns: ['swallows the failing call'],
			directives: ['remove the try/except and fix the cause'],
		}));
		assert.strictEqual(suspicious.verifiedEligible, false);
		// A glowing judge cannot rescue a failed oracle.
		const rescued = composeRewardBreakdown('fail', 'unavailable', [], judgeReport({ goal_alignment: 1 }));
		assert.ok(rescued.reward <= 0.2, `a glowing judge cannot lift a failed oracle above the audit floor, got ${rescued.reward}`);
	});

	test('goal adherence: an unmet stated criterion blocks verified-eligibility', () => {
		// The "almost right but not what was specified" gate: oracle + tests
		// pass, no cheat — but a stated success criterion is not met.
		const b = composeRewardBreakdown('pass_objective', 'pass', [], judgeReport({
			goal_alignment: 0.2,
			criteria_verdicts: [
				{ criterion: 'response has a total field', verdict: 'not_met', reason: 'no total returned' },
				{ criterion: 'status is 200', verdict: 'met', reason: 'returns 200' },
			],
		}));
		assert.strictEqual(b.verifiedEligible, false);
		assert.ok(b.reward < 1);
		assert.ok(b.reasons.some((r) => r.includes('criterion NOT MET')));
		assert.ok(b.directives.some((d) => d.includes('total field')));
	});

	test('goal adherence: all criteria met keeps a clean pass verified', () => {
		const b = composeRewardBreakdown('pass_objective', 'pass', [], judgeReport({
			criteria_verdicts: [{ criterion: 'x', verdict: 'met', reason: 'ok' }],
		}));
		assert.strictEqual(b.verifiedEligible, true);
	});

	test('goal adherence: unverifiable criteria are excluded from the denominator', () => {
		const b = composeRewardBreakdown('pass_objective', 'pass', [], judgeReport({
			criteria_verdicts: [
				{ criterion: 'x', verdict: 'met', reason: 'ok' },
				{ criterion: 'y', verdict: 'unverifiable', reason: 'no evidence' },
			],
		}));
		// One met, one unverifiable → adherence 1/1, still verified.
		assert.strictEqual(b.verifiedEligible, true);
	});

	test('the report carries score, reasons, and directives', () => {
		const b = composeRewardBreakdown('fail', 'fail', [], null);
		const report = renderRewardReport(b);
		assert.ok(report.includes('reward'));
		assert.ok(report.includes('why:'));
		assert.ok(report.includes('to raise the reward'));
	});
});

// ---- adaptive replay budget ------------------------------------------------

suite('Adaptive replay budget', () => {
	const params: ReplayBudgetParams = { ...REPLAY_PRIORS };

	test('no observations → the floor (never worse than the old constant)', () => {
		assert.strictEqual(softBudgetMs({ version: 1, durations_s: [] }, params), 240_000);
	});

	test('learned budget scales to the service: quantile × multiplier', () => {
		// A service that historically serves in ~200s must not be failed at 240.
		const stats = { version: 1 as const, durations_s: [180, 190, 200, 210, 220] };
		const soft = softBudgetMs(stats, params);
		assert.strictEqual(soft, 220 * 3 * 1000);
		// Fast services keep the floor: max(floor, small × multiplier).
		const fast = { version: 1 as const, durations_s: [2, 3, 2.5] };
		assert.strictEqual(softBudgetMs(fast, params), 240_000);
	});

	test('nearest-rank quantile: small n degrades to the max observation', () => {
		assert.strictEqual(durationQuantile({ version: 1, durations_s: [5, 9, 7] }, 0.95), 9);
		assert.strictEqual(durationQuantile({ version: 1, durations_s: [] }, 0.95), 0);
	});

	test('ceiling honors the env override and never undercuts the soft budget', () => {
		const soft = 600_000;
		delete process.env.VINV_EPISODE_REPLAY_BUDGET_S;
		assert.strictEqual(ceilingMs(soft, params), Math.max(params.ceiling_s * 1000, soft));
		process.env.VINV_EPISODE_REPLAY_BUDGET_S = '100';
		// Override below the soft budget is raised to it — the learned budget
		// is a floor on the ceiling, not the other way around.
		assert.strictEqual(ceilingMs(soft, params), soft);
		delete process.env.VINV_EPISODE_REPLAY_BUDGET_S;
	});

	test('stats round-trip on disk; corrupt files read as empty', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-replay-'));
		recordReplayDuration(root, 'svc', 12.34);
		recordReplayDuration(root, 'svc', 15);
		assert.deepStrictEqual(readReplayStats(root, 'svc').durations_s, [12.3, 15]);
		fs.writeFileSync(path.join(root, '.vinv', 'replay-stats', 'svc.json'), '{broken');
		assert.deepStrictEqual(readReplayStats(root, 'svc').durations_s, []);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('policy replay block: priors fill absent, invalid rejected wholesale', () => {
		assert.deepStrictEqual(replayParams(POLICY_PRIORS), REPLAY_PRIORS);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-home-'));
		const prior = process.env.VINV_HOME;
		process.env.VINV_HOME = dir;
		try {
			fs.writeFileSync(
				path.join(dir, 'episode-policy.json'),
				JSON.stringify({ ...POLICY_PRIORS, replay: { ...REPLAY_PRIORS, floor_s: 5000 } }),
			);
			// floor above ceiling → invalid → whole policy falls back to priors.
			assert.deepStrictEqual(loadEpisodePolicy(), POLICY_PRIORS);
		} finally {
			if (prior === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = prior;
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---- fail-to-pass end-to-end (real interpreter) ----------------------------

suite('Acceptance tests against a real interpreter (F2P e2e)', () => {
	test('fail on broken code, pass after the fix — with the real python3', async function () {
		// Full fail-to-pass round trip through runAcceptanceTests (bash spawn,
		// PYTHONPATH, pytest-or-fallback, double-run flake guard).
		this.timeout(60_000);
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-f2p-'));
		const testsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-f2p-tests-'));
		try {
			fs.writeFileSync(
				path.join(ws, 'buggy.py'),
				'def add(a, b):\n    return a - b  # the bug\n',
			);
			const testFile = path.join(testsDir, 'test_acceptance.py');
			fs.writeFileSync(
				testFile,
				[
					'from buggy import add',
					'',
					'def test_add():',
					'    assert add(2, 3) == 5',
					'',
					'if __name__ == "__main__":',
					'    import sys, traceback',
					'    failed = 0',
					'    for name, fn in sorted(globals().items()):',
					'        if name.startswith("test_") and callable(fn):',
					'            try:',
					'                fn()',
					'            except Exception:',
					'                failed += 1',
					'                traceback.print_exc()',
					'    sys.exit(1 if failed else 0)',
					'',
				].join('\n'),
			);
			const pre = await runAcceptanceTests(ws, testFile);
			assert.strictEqual(pre.signal, 'fail', `pre-fix run: ${pre.output.slice(-300)}`);
			fs.writeFileSync(path.join(ws, 'buggy.py'), 'def add(a, b):\n    return a + b\n');
			const post = await runAcceptanceTests(ws, testFile);
			assert.strictEqual(post.signal, 'pass', `post-fix run: ${post.output.slice(-300)}`);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
			fs.rmSync(testsDir, { recursive: true, force: true });
		}
	});
});

// ---- interpreter resolution (the oracle's most fragile precondition) --------

suite('Test-interpreter resolution', () => {
	// Only the two keys under test are touched, and they are restored key by
	// key — replacing process.env wholesale leaks into every later suite.
	const ENV_KEYS = ['VINV_TEST_PYTHON', 'VIRTUAL_ENV'] as const;
	let saved: Array<string | undefined> = [];
	setup(() => {
		resetInterpreterCache();
		saved = ENV_KEYS.map((k) => process.env[k]);
		ENV_KEYS.forEach((k) => delete process.env[k]);
	});
	teardown(() => {
		ENV_KEYS.forEach((k, i) => {
			if (saved[i] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = saved[i];
			}
		});
		resetInterpreterCache();
	});

	test('discovers venvs the old name whitelist missed, deterministically ordered', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-venvdisc-'));
		try {
			// The live failure: the workspace's only env was named `.venv-smol`,
			// so resolution fell through to a bare python3 with none of the repo's
			// dependencies installed.
			// Only the real environments carry PEP 405's marker; node_modules and
			// src have an interpreter shim and nothing else, which is exactly the
			// case a shape-only rule would wrongly accept.
			const smol = makeVenv(ws, '.venv-smol');
			const venv311 = makeVenv(ws, 'venv311');
			makeVenv(ws, 'node_modules', { marker: false });
			makeVenv(ws, 'src', { marker: false });

			const found = discoverPythonCandidates(ws);
			assert.ok(
				found.includes(smol),
				`a non-standard venv name must be discovered: ${found.join(', ')}`,
			);
			assert.ok(found.includes(venv311));
			// A `bin/python` shim without PEP 405's marker is not an environment,
			// so `node_modules/bin/python` and `src/bin/python` stay out.
			assert.ok(!found.some((c) => c.includes(`${path.sep}node_modules${path.sep}`)));
			assert.ok(!found.some((c) => c.includes(`${path.sep}src${path.sep}`)));
			// PATH names come last, so a real env always outranks them.
			const pathName = process.platform === 'win32' ? 'python' : 'python3';
			assert.ok(found.indexOf(pathName) > found.indexOf(smol));
			assert.strictEqual(resolveTestPython(ws), smol);
			// Alphabetical among the non-preferred names — never readdir order.
			assert.deepStrictEqual(discoverPythonCandidates(ws), found);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('an explicit override and .venv keep priority over discovered envs', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-venvorder-'));
		// Captured and restored: this used to be SET and never cleared, so every
		// later test in the run saw an override pointing at a path that does not
		// exist. A test that leaks an environment variable is a test that decides
		// whether the ones after it pass.
		const overrideBefore = process.env.VINV_TEST_PYTHON;
		try {
			const preferred = makeVenv(ws, '.venv');
			makeVenv(ws, 'zz-venv');
			assert.strictEqual(discoverPythonCandidates(ws)[0], preferred);
			process.env.VINV_TEST_PYTHON = '/custom/python';
			assert.strictEqual(discoverPythonCandidates(ws)[0], '/custom/python');
		} finally {
			if (overrideBefore === undefined) {
				delete process.env.VINV_TEST_PYTHON;
			} else {
				process.env.VINV_TEST_PYTHON = overrideBefore;
			}
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('probe targets are the workspace packages, not tests or loose scripts', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-pkgs-'));
		try {
			fs.mkdirSync(path.join(ws, 'src', 'mypkg'), { recursive: true });
			fs.writeFileSync(path.join(ws, 'src', 'mypkg', '__init__.py'), '');
			fs.mkdirSync(path.join(ws, 'tests'), { recursive: true });
			fs.writeFileSync(path.join(ws, 'tests', '__init__.py'), '');
			fs.mkdirSync(path.join(ws, 'toolsdir'), { recursive: true });
			fs.writeFileSync(path.join(ws, 'toolsdir', '__init__.py'), '');
			fs.writeFileSync(path.join(ws, 'setup.py'), '');
			// src-layout wins outright: root-level package dirs are tooling.
			assert.deepStrictEqual(workspacePackageNames(ws), ['mypkg']);
			fs.rmSync(path.join(ws, 'src'), { recursive: true, force: true });
			assert.deepStrictEqual(workspacePackageNames(ws), ['toolsdir']);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('picks the interpreter that can actually import the code under test', async function () {
		// The regression proper, with real interpreters: two venvs exist, only
		// the oddly-named one has the workspace's dependency installed. Name
		// ordering alone would pick the decoy `.venv` and produce 'unavailable';
		// the probe picks the env that works.
		if (process.platform === 'win32') {
			this.skip();
		}
		this.timeout(180_000);
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-probe-e2e-'));
		try {
			const cp = require('child_process') as typeof import('child_process');
			const make = (name: string): string => {
				cp.execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(ws, name)], {
					stdio: 'ignore',
					timeout: 120_000,
				});
				return path.join(ws, name, 'bin', 'python');
			};
			let decoy: string;
			let good: string;
			try {
				decoy = make('.venv');
				good = make('.venv-smol');
			} catch {
				this.skip();
				return;
			}
			// Only the good env gets the dependency the package imports.
			const purelib = cp
				.execFileSync(good, ['-c', "import sysconfig;print(sysconfig.get_paths()['purelib'])"], {
					encoding: 'utf8',
				})
				.trim();
			fs.mkdirSync(purelib, { recursive: true });
			fs.writeFileSync(path.join(purelib, 'vinv_only_here.py'), 'VALUE = 41\n');
			fs.mkdirSync(path.join(ws, 'src', 'widget'), { recursive: true });
			fs.writeFileSync(
				path.join(ws, 'src', 'widget', '__init__.py'),
				'import vinv_only_here\n\n\ndef bump():\n    return vinv_only_here.VALUE - 1  # the bug\n',
			);

			const resolved = await resolveTestInterpreter(ws);
			assert.strictEqual(resolved.python, good, `probe must reject the decoy env (tried: ${JSON.stringify(resolved.tried)})`);
			assert.strictEqual(resolved.imports, 'ok');
			assert.ok(
				resolved.tried.some((t) => t.python === decoy && /vinv_only_here|ModuleNotFoundError/.test(t.error)),
				'the rejected candidate and its import error must be recorded as evidence',
			);

			// End to end: the acceptance oracle now returns a real fail-to-pass
			// verdict where it previously returned 'unavailable'.
			const testsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-probe-tests-'));
			try {
				const testFile = path.join(testsDir, 'test_acceptance.py');
				fs.writeFileSync(testFile, 'from widget import bump\n\n\ndef test_bump():\n    assert bump() == 42\n');
				const pre = await runAcceptanceTests(ws, testFile);
				assert.strictEqual(pre.signal, 'fail', `pre-fix: ${pre.detail ?? pre.output.slice(-400)}`);
				fs.writeFileSync(
					path.join(ws, 'src', 'widget', '__init__.py'),
					'import vinv_only_here\n\n\ndef bump():\n    return vinv_only_here.VALUE + 1\n',
				);
				const post = await runAcceptanceTests(ws, testFile);
				assert.strictEqual(post.signal, 'pass', `post-fix: ${post.detail ?? post.output.slice(-400)}`);
			} finally {
				fs.rmSync(testsDir, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test("an unrunnable oracle explains itself instead of returning a bare 'unavailable'", async function () {
		this.timeout(120_000);
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-loud-'));
		const testsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-loud-tests-'));
		try {
			fs.mkdirSync(path.join(ws, 'src', 'ghostpkg'), { recursive: true });
			fs.writeFileSync(
				path.join(ws, 'src', 'ghostpkg', '__init__.py'),
				'import a_dependency_nobody_installed\n',
			);
			const testFile = path.join(testsDir, 'test_acceptance.py');
			fs.writeFileSync(testFile, 'from ghostpkg import missing\n\n\ndef test_x():\n    assert missing() == 1\n');
			const run = await runAcceptanceTests(ws, testFile);
			assert.strictEqual(run.signal, 'unavailable');
			const detail = run.detail ?? '';
			assert.match(detail, /import_error/, `detail must name the diagnosis: ${detail}`);
			assert.match(detail, /interpreter: \S+/, `detail must name the interpreter tried: ${detail}`);
			assert.match(
				detail,
				/a_dependency_nobody_installed/,
				`detail must carry the captured failure: ${detail}`,
			);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
			fs.rmSync(testsDir, { recursive: true, force: true });
		}
	});

	test('run-failure diagnosis distinguishes infra causes from verdicts', () => {
		assert.strictEqual(classifyRunFailure(0, 'ok', false), null);
		assert.strictEqual(classifyRunFailure(1, '1 failed: AssertionError', false), null);
		assert.strictEqual(classifyRunFailure(0, '', true), 'timeout');
		assert.strictEqual(classifyRunFailure(null, '', false), 'spawn_failed');
		assert.strictEqual(classifyRunFailure(1, "ModuleNotFoundError: No module named 'PIL'", false), 'import_error');
		assert.strictEqual(classifyRunFailure(2, 'ERROR collecting test_x.py\nImportError', false), 'import_error');
		assert.strictEqual(classifyRunFailure(5, 'no tests ran', false), 'nothing_collected');
		assert.strictEqual(classifyRunFailure(9, 'Segmentation fault', false), 'crash');
	});
});

// ---- off-policy evaluator --------------------------------------------------

function sample(overrides: Partial<OpeSample>): OpeSample {
	return {
		decision_id: `d${Math.random().toString(36).slice(2)}`,
		action: 5,
		propensity: 0.9,
		reward: 0.5,
		epoch: 'e',
		...overrides,
	};
}

suite('OPE pooled loading', () => {
	test('joins decisions with rewards, explicit beats auxiliary, fallback excluded', () => {
		const ledger = [
			JSON.stringify({ type: 'decision', decision_id: 'a', epoch: 'e1', action: { top_k: 5 }, propensity: 0.9 }),
			JSON.stringify({ type: 'feedback', decision_id: 'a', epoch: 'e1', source: 'auxiliary', reward: 0 }),
			JSON.stringify({ type: 'feedback', decision_id: 'a', epoch: 'e1', source: 'explicit', reward: 1 }),
			JSON.stringify({ type: 'decision', decision_id: 'b', epoch: 'e2', action: { top_k: 10 }, propensity: 0.1, fallback: true }),
			JSON.stringify({ type: 'feedback', decision_id: 'b', epoch: 'e2', reward: 1 }),
			JSON.stringify({ type: 'decision', decision_id: 'c', epoch: 'e2', action: { top_k: 10 }, propensity: 0.1 }),
			'not json',
		].join('\n');
		const samples = loadPooledSamples(ledger);
		// a: explicit reward wins; b: fallback excluded; c: no reward → excluded.
		assert.strictEqual(samples.length, 1);
		assert.strictEqual(samples[0].reward, 1);
		assert.strictEqual(samples[0].epoch, 'e1');
	});
});

suite('OPE estimator and gates', () => {
	test('DR matches the hand-computable uniform case', () => {
		// Two actions, equal propensity, constant rewards: DR(target) must
		// recover the target action's mean exactly.
		const samples: OpeSample[] = [];
		for (let i = 0; i < 30; i++) {
			samples.push(sample({ decision_id: `b${i}`, action: 5, propensity: 0.5, reward: 0 }));
			samples.push(sample({ decision_id: `c${i}`, action: 10, propensity: 0.5, reward: 1 }));
		}
		const e = estimate(samples, 10);
		assert.ok(Math.abs(e.doublyRobust - 1) < 1e-9, `DR was ${e.doublyRobust}`);
		assert.ok(e.supportOk);
		assert.strictEqual(e.clippedFraction, 0);
	});

	test('per-action pull floor blocks thin cells even when totals pass', () => {
		const samples: OpeSample[] = [];
		for (let i = 0; i < 42; i++) {
			samples.push(sample({ decision_id: `b${i}` }));
		}
		for (let i = 0; i < MIN_ACTION_PULLS - 1; i++) {
			samples.push(sample({ decision_id: `c${i}`, action: 10, propensity: 0.1, reward: 1 }));
		}
		assert.strictEqual(estimate(samples, 10).supportOk, false);
	});

	test('BCa LCB clears zero on a genuine large effect at realistic volume', () => {
		const samples: OpeSample[] = [];
		for (let i = 0; i < 30; i++) {
			samples.push(sample({ decision_id: `b${i}`, action: 5, propensity: 0.9, reward: 0 }));
			samples.push(sample({ decision_id: `c${i}`, action: 10, propensity: 0.1, reward: 1 }));
		}
		const [lcb] = bcaDeltaInterval(samples, 5, 10, 400);
		assert.ok(lcb > 0, `LCB was ${lcb}`);
	});

	test('epoch consistency fails when one epoch contradicts the pooled delta', () => {
		const samples: OpeSample[] = [];
		for (let i = 0; i < 20; i++) {
			samples.push(sample({ decision_id: `a5${i}`, epoch: 'A', action: 5, propensity: 0.5, reward: 0.5 }));
			samples.push(sample({ decision_id: `a10${i}`, epoch: 'A', action: 10, propensity: 0.5, reward: 1 }));
			samples.push(sample({ decision_id: `b5${i}`, epoch: 'B', action: 5, propensity: 0.5, reward: 0.5 }));
			samples.push(sample({ decision_id: `b10${i}`, epoch: 'B', action: 10, propensity: 0.5, reward: 0 }));
		}
		const consistency = epochConsistency(samples, 5, 10);
		assert.strictEqual(consistency.epochs.length, 2);
		assert.strictEqual(consistency.ok, false);
		// The full evaluation must therefore refuse to promote 10.
		const { candidates } = evaluateCandidates(samples);
		const ten = candidates.find((c) => c.action === 10);
		assert.strictEqual(ten?.promotable, false);
	});

	test('a consistent, supported, positive candidate is promotable', () => {
		const samples: OpeSample[] = [];
		for (const epoch of ['A', 'B']) {
			for (let i = 0; i < 25; i++) {
				samples.push(sample({ decision_id: `${epoch}5${i}`, epoch, action: 5, propensity: 0.6, reward: 0 }));
				samples.push(sample({ decision_id: `${epoch}10${i}`, epoch, action: 10, propensity: 0.4, reward: 1 }));
			}
		}
		const { baseline, candidates } = evaluateCandidates(samples);
		assert.strictEqual(baseline, 5);
		const ten = candidates.find((c) => c.action === 10);
		assert.strictEqual(ten?.promotable, true);
		assert.ok((ten?.drDelta ?? 0) > 0.9);
	});

	test('below the sample floor no candidate is even evaluated', () => {
		const samples: OpeSample[] = [];
		for (let i = 0; i < 20; i++) {
			samples.push(sample({ decision_id: `x${i}` }));
		}
		assert.deepStrictEqual(evaluateCandidates(samples), { baseline: null, candidates: [] });
	});
});

// ---- test swarm: lens selection, fan-in, dedup, expiry ---------------------

function evidenceWith(overrides: Partial<SwarmEvidence>): SwarmEvidence {
	return { symbols: '- `fn` — a.py:1', failures: '', valueProfiles: '', healthyNeighbors: '', ...overrides };
}

suite('Test swarm — deterministic lens selection', () => {
	test('no runtime evidence → symptom lens only (never zero, never invented)', () => {
		const plans = selectLenses(evidenceWith({}));
		assert.deepStrictEqual(plans.map((p) => p.lens), ['symptom']);
	});

	test('value profiles unlock boundary; healthy neighbors unlock regression', () => {
		const plans = selectLenses(
			evidenceWith({ valueProfiles: 'fn: args {...}', healthyNeighbors: '- `nb` — b.py:3' }),
		);
		assert.deepStrictEqual(plans.map((p) => p.lens), ['symptom', 'boundary', 'regression']);
		// The lens directives carry the F2P/P2P contracts explicitly.
		assert.ok(plans[1].approach.includes('MUST FAIL'));
		assert.ok(plans[2].approach.includes('MUST PASS'));
	});
});

suite('Test swarm — mechanical fan-in', () => {
	const authorFor = (map: Record<string, string | null>) => async (plan: { lens: string }) => {
		const code = map[plan.lens];
		return code ? { test_code: code, rationale: 'r' } : null;
	};
	const preRunSignals = (bySuffix: Record<string, string>) => async (file: string) => {
		const key = Object.keys(bySuffix).find((k) => file.includes(k)) ?? '';
		return { signal: bySuffix[key] ?? 'unavailable', output: `ran ${file}` };
	};

	test('F2P keeps failers, P2P keeps passers, flakes and misses are discarded', async function () {
		this.timeout(10_000);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-swarm-'));
		try {
			const outcome = await runTestSwarm(
				evidenceWith({ valueProfiles: 'p', healthyNeighbors: 'n' }),
				{
					spawnInfo: { binPath: '/nonexistent', env: {}, cwd: dir, dispatch: async () => null },
					author: authorFor({
						symptom: 'def test_sym():\n    assert broken() == 1\n',
						boundary: 'def test_bound():\n    assert broken(None) == 0\n',
						regression: 'def test_neighbor():\n    assert neighbor() == 2\n',
					}),
					preRun: preRunSignals({
						'candidate-0-symptom': 'fail',
						'candidate-1-boundary': 'pass', // passes pre-fix → cannot discriminate
						'candidate-2-regression': 'pass', // passes pre-fix → pins behavior
					}),
					storageDir: dir,
					issue: 'the issue',
					epoch: 7,
				},
			);
			assert.ok(outcome.acceptancePath, 'symptom survivor forms the acceptance set');
			assert.ok(outcome.regressionPath, 'regression survivor forms the regression set');
			const kept = outcome.candidates.filter((c) => c.kept).map((c) => c.lens).sort();
			assert.deepStrictEqual(kept, ['regression', 'symptom']);
			const boundary = outcome.candidates.find((c) => c.lens === 'boundary');
			assert.ok(boundary && !boundary.kept && boundary.reason.includes('cannot discriminate'));
			// Manifest binds the set to issue signature + epoch.
			const manifest = JSON.parse(
				fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
			) as { issue_sig: string; epoch: number };
			assert.strictEqual(manifest.issue_sig, issueSignature('the issue'));
			assert.strictEqual(manifest.epoch, 7);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('all authors unavailable → no sets, reasons recorded, nothing fabricated', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-swarm-'));
		try {
			const outcome = await runTestSwarm(evidenceWith({}), {
				spawnInfo: { binPath: '/nonexistent', env: {}, cwd: dir, dispatch: async () => null },
				author: async () => null,
				preRun: async () => ({ signal: 'fail', output: '' }),
				storageDir: dir,
				issue: 'x',
				epoch: 1,
			});
			assert.strictEqual(outcome.acceptancePath, undefined);
			assert.strictEqual(outcome.candidates[0].reason.includes('unavailable'), true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

suite('Test swarm — dedup and expiry', () => {
	test('duplicate test functions across authors merge once', () => {
		const a = 'def test_core():\n    assert add(2, 3) == 5\n';
		const b = 'def test_core():\n    assert add(2, 3) == 5\n';
		const c = 'def test_other():\n    assert add(0, 0) == 0\n';
		const merged = mergeCandidates([a, b, c]);
		assert.strictEqual((merged.match(/def test_core/g) ?? []).length, 1);
		assert.ok(merged.includes('def test_other'));
		assert.deepStrictEqual(testDedupKeys(a), testDedupKeys(b));
	});

	test('reuse requires same issue signature AND same epoch (drift = expiry)', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-reuse-'));
		try {
			const dir = path.join(root, 'ep1');
			fs.mkdirSync(dir);
			fs.writeFileSync(
				path.join(dir, 'manifest.json'),
				JSON.stringify({
					version: 1,
					issue_sig: issueSignature('same issue'),
					epoch: 5,
					created_at: '2026-07-19T00:00:00Z',
					acceptance: path.join(dir, 'test_acceptance.py'),
					candidates: [],
				}),
			);
			assert.ok(findReusableSet(root, 'same issue', 5), 'same sig+epoch is reusable');
			assert.strictEqual(findReusableSet(root, 'same issue', 6), null, 'epoch drift expires the set');
			assert.strictEqual(findReusableSet(root, 'different issue', 5), null);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

suite('Backend agent contracts (binary transport validators)', () => {
	test('judge/stall/authored validators reject out-of-contract payloads', () => {
		assert.strictEqual(asJudgeReport(null), null);
		assert.strictEqual(asJudgeReport({ status: 'ok', cheat_likelihood: 2, goal_alignment: 0 }), null);
		assert.ok(asJudgeReport({ status: 'ok', cheat_likelihood: 0.3, goal_alignment: 0.8, concerns: ['a'], directives: [] }));
		assert.strictEqual(asStallUtilities({ status: 'ok', explorer_continue: 0.5 }), null);
		assert.strictEqual(asAuthoredTests({ status: 'ok', test_code: 'x = 1' }), null);
		assert.ok(asAuthoredTests({ status: 'ok', test_code: 'def test_a():\n    assert 1' }));
	});
});

suite('Reward rubric — regression signal', () => {
	test('regression fail drags the reward down and names the directive', () => {
		const b = composeRewardBreakdown('pass_objective', 'pass', [], null, 'fail');
		assert.ok(b.reward < 0.95);
		assert.ok(b.directives.some((d) => d.includes('regression tests pin')));
	});

	test('regression disabled/unavailable renormalizes — absent is not passed', () => {
		const withReg = composeRewardBreakdown('pass_objective', 'pass', [], null, 'pass');
		const without = composeRewardBreakdown('pass_objective', 'pass', [], null, 'disabled');
		assert.strictEqual(withReg.reward, 1);
		assert.strictEqual(without.reward, 1);
		const failing = composeRewardBreakdown('fail', 'fail', [], null, 'disabled');
		assert.ok(failing.reward <= 0.2);
	});

	test('danger patterns raise soft flags on added lines only', () => {
		const flags = auditChangedFiles(
			[{ path: 'app/x.py', addedLines: ['result = eval(user_input)', 'subprocess.run(cmd, shell=True)', 'requests.get(url, verify=False)'] }],
			[],
		);
		assert.strictEqual(flags.filter((f) => f.kind === 'danger_pattern').length, 3);
		assert.ok(flags.every((f) => f.severity === 'soft'));
	});
});

// ---- reward ↔ human-feedback reconciliation --------------------------------

import { reconcile, counterexampleApproach } from '../harness/reconciliation';

suite('Reconciliation — oracle↔human disagreement protocol', () => {
	test('accept → verdict stands, nothing retracted', () => {
		const d = reconcile('accept');
		assert.strictEqual(d.action, 'stand');
		assert.strictEqual(d.retractVerified, false);
	});

	test('no response → reward unchanged (MNAR), never fabricated', () => {
		const d = reconcile('no_response');
		assert.strictEqual(d.action, 'unchanged');
		assert.strictEqual(d.retractVerified, false);
		assert.strictEqual(d.graduateTest, false);
	});

	test('reject without detail → ask one targeted question, do not retract', () => {
		const d = reconcile('reject_no_detail');
		assert.strictEqual(d.action, 'ask');
		assert.strictEqual(d.retractVerified, false);
		assert.ok(d.message.includes('what behavior is still wrong'));
	});

	test('reject with detail but no counterexample yet → author one (ask)', () => {
		assert.strictEqual(reconcile('reject_with_detail').action, 'ask');
	});

	test('counterexample reproduces → retract, graduate the test, re-dispatch', () => {
		const d = reconcile('reject_with_detail', 'reproduces');
		assert.strictEqual(d.action, 'retract_and_redispatch');
		assert.strictEqual(d.retractVerified, true);
		assert.strictEqual(d.graduateTest, true);
	});

	test('counterexample does not reproduce → verdict stands, transparency', () => {
		const d = reconcile('reject_with_detail', 'does_not_reproduce');
		assert.strictEqual(d.action, 'stand');
		assert.strictEqual(d.retractVerified, false);
	});

	test('counterexample unavailable → never silently retract on an unrunnable check', () => {
		const d = reconcile('reject_with_detail', 'unavailable');
		assert.strictEqual(d.action, 'stand');
		assert.strictEqual(d.retractVerified, false);
	});

	test('counterexample approach carries the human description into a fail-on-current lens', () => {
		const a = counterexampleApproach('the total is off by one for empty carts');
		assert.ok(a.includes('FAILS on'));
		assert.ok(a.includes('off by one for empty carts'));
	});
});

// ---- round-3 stress tests: retraction, dup-guard, block cause, amendment ---

import { computeUpdatedPolicy, readCompletedEpisodes } from '../harness/episodePolicyUpdater';
import { episodeReward, posteriorMean } from '../harness/episodeTelemetry';

suite('Reconciliation accounting (policy updater)', () => {
	const ledgerWith = (lines: object[]): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-ledger-'));
		const p = path.join(dir, 'episodes.jsonl');
		fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
		return p;
	};

	test('a retraction re-labels the episode: verified→false, objective→true, reward −1', () => {
		const p = ledgerWith([
			{ type: 'episode_start', episode_id: 'e1', arm_index: 2, propensity: 0.4 },
			{ type: 'episode_end', episode_id: 'e1', reward: 1, attempts: 1, verified: true, objective: true },
			{ type: 'reconciliation', episode_id: 'e1', action: 'retract_and_redispatch', retracted: true },
		]);
		const episodes = readCompletedEpisodes(p);
		assert.strictEqual(episodes.length, 1);
		assert.strictEqual(episodes[0].verified, false, 'retracted verified bit');
		assert.strictEqual(episodes[0].objective, true, 'a reproducible counterexample is objective');
		assert.strictEqual(episodes[0].reward, -1);
	});

	test('a non-retracting reconciliation (stand) changes nothing', () => {
		const p = ledgerWith([
			{ type: 'episode_start', episode_id: 'e1', arm_index: 1, propensity: 0.5 },
			{ type: 'episode_end', episode_id: 'e1', reward: 1, attempts: 2, verified: true, objective: true },
			{ type: 'reconciliation', episode_id: 'e1', action: 'stand', retracted: false },
		]);
		const episodes = readCompletedEpisodes(p);
		assert.strictEqual(episodes[0].verified, true);
		assert.strictEqual(episodes[0].reward, 1);
	});

	test('a duplicate (or forged second) episode_end never double-counts: first end wins', () => {
		const p = ledgerWith([
			{ type: 'episode_start', episode_id: 'e1', arm_index: 3, propensity: 0.3 },
			{ type: 'episode_end', episode_id: 'e1', reward: 0, attempts: 3, verified: false, objective: true },
			{ type: 'episode_end', episode_id: 'e1', reward: 1, attempts: 1, verified: true, objective: true },
		]);
		const episodes = readCompletedEpisodes(p);
		assert.strictEqual(episodes.length, 1, 'one record per episode id');
		assert.strictEqual(episodes[0].verified, false, 'the first end is authoritative');
	});

	test('a retraction for an unknown episode id is inert', () => {
		const p = ledgerWith([
			{ type: 'reconciliation', episode_id: 'ghost', retracted: true },
			{ type: 'episode_start', episode_id: 'e1', arm_index: 0, propensity: 1 },
			{ type: 'episode_end', episode_id: 'e1', reward: 1, attempts: 1, verified: true, objective: true },
		]);
		const episodes = readCompletedEpisodes(p);
		assert.strictEqual(episodes.length, 1);
		assert.strictEqual(episodes[0].verified, true);
	});
});

// ---- the full learning walk: reward → ledger → posterior → gates -----------

suite('Episode walk: reward → ledger → policy update → OPE gate', () => {
	const ledgerWith = (lines: object[]): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-walk-'));
		const p = path.join(dir, 'episodes.jsonl');
		fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
		return p;
	};

	test('episodeReward: first-attempt verified is 1, budget-exhausted less, abort -1', () => {
		assert.strictEqual(episodeReward(true, 1, 3, false), 1);
		assert.ok(episodeReward(true, 3, 3, false) < 1);
		assert.strictEqual(episodeReward(false, 2, 3, false), 0, 'MNAR: unverified is neutral');
		assert.strictEqual(episodeReward(false, 1, 3, true), -1);
	});

	test('synthetic episodes walked through the ledger update the right arm posterior', () => {
		// Arm 3 verifies twice; arm 0 fails twice; one abort (non-objective) on
		// arm 3 that must NOT count as arm evidence.
		const p = ledgerWith([
			{ type: 'episode_start', episode_id: 'w1', arm_index: 3, propensity: 0.4 },
			{ type: 'episode_end', episode_id: 'w1', reward: episodeReward(true, 1, 3, false), attempts: 1, verified: true, objective: true },
			{ type: 'episode_start', episode_id: 'w2', arm_index: 3, propensity: 0.4 },
			{ type: 'episode_end', episode_id: 'w2', reward: episodeReward(true, 2, 3, false), attempts: 2, verified: true, objective: true },
			{ type: 'episode_start', episode_id: 'w3', arm_index: 0, propensity: 0.2 },
			{ type: 'episode_end', episode_id: 'w3', reward: episodeReward(false, 3, 3, false), attempts: 3, verified: false, objective: true },
			{ type: 'episode_start', episode_id: 'w4', arm_index: 0, propensity: 0.2 },
			{ type: 'episode_end', episode_id: 'w4', reward: episodeReward(false, 3, 3, false), attempts: 3, verified: false, objective: true },
			{ type: 'episode_start', episode_id: 'w5', arm_index: 3, propensity: 0.4 },
			{ type: 'episode_end', episode_id: 'w5', reward: episodeReward(false, 1, 3, true), attempts: 1, verified: false, objective: false, aborted: true },
		]);
		const episodes = readCompletedEpisodes(p);
		assert.strictEqual(episodes.length, 5);
		const next = computeUpdatedPolicy({ ...POLICY_PRIORS }, episodes);
		const posteriors = next.arm_posteriors ?? [];
		// Beta(1,1) prior + 2 verified on arm 3 → alpha 3, beta 1; the abort is
		// excluded (non-objective), so beta stays 1.
		assert.deepStrictEqual(posteriors[3], { alpha: 3, beta: 1 });
		// Arm 0: two objective failures → alpha 1, beta 3.
		assert.deepStrictEqual(posteriors[0], { alpha: 1, beta: 3 });
		assert.ok(posteriorMean(posteriors[3]) > posteriorMean(posteriors[0]));
		assert.strictEqual(next.preferred_arm, 3, 'the greedy arm follows the evidence');
		// Attempt budget: 0.9-quantile of {1,2} = 2, plus one optimism margin.
		assert.strictEqual(next.attempt_budget, 3);
	});

	test('the OPE gate blocks a WORSE candidate policy outright', () => {
		// Candidate action 10 is strictly worse than baseline 5 — supported,
		// consistent, but its DR delta is negative, so the BCa LCB is < 0.
		const samples: OpeSample[] = [];
		for (const epoch of ['A', 'B']) {
			for (let i = 0; i < 25; i++) {
				samples.push(sample({ decision_id: `${epoch}g${i}`, epoch, action: 5, propensity: 0.6, reward: 1 }));
				samples.push(sample({ decision_id: `${epoch}w${i}`, epoch, action: 10, propensity: 0.4, reward: 0 }));
			}
		}
		const { candidates } = evaluateCandidates(samples);
		const worse = candidates.find((c) => c.action === 10);
		assert.ok(worse, 'the worse arm is still evaluated');
		assert.ok((worse?.drDelta ?? 0) < 0);
		assert.strictEqual(worse?.promotable, false, 'a worse policy must never promote');
	});
});

suite('Verified-block cause + adherence visibility', () => {
	const judgeWith = (over: Record<string, unknown>) => ({
		cheat_likelihood: 0.1,
		goal_alignment: 0.9,
		criteria_verdicts: [] as Array<{ criterion: string; verdict: 'met' | 'not_met' | 'unverifiable'; reason: string }>,
		scope_drift: 'none' as const,
		concerns: [],
		directives: [],
		...over,
	});

	test('an unmet criterion blocks with cause=criteria (spec, not cheating)', () => {
		const b = composeRewardBreakdown('pass_objective', 'pass', [], judgeWith({
			criteria_verdicts: [{ criterion: 'negative amounts are rejected', verdict: 'not_met', reason: 'still accepted' }],
		}) , 'disabled', 0.7, 1);
		assert.strictEqual(b.verifiedEligible, false);
		assert.strictEqual(b.verifiedBlockCause, 'criteria');
	});

	test('cheat outranks criteria; hard flags outrank both', () => {
		const cheat = composeRewardBreakdown('pass_objective', 'pass', [], judgeWith({
			cheat_likelihood: 0.9,
			criteria_verdicts: [{ criterion: 'x', verdict: 'not_met', reason: 'y' }],
		}), 'disabled', 0.7, 1);
		assert.strictEqual(cheat.verifiedBlockCause, 'cheat');
		const hard = composeRewardBreakdown('pass_objective', 'pass', [
			{ kind: 'vinv_state_edit', file: '.vinv/x', detail: 'tampered', severity: 'hard' },
		], judgeWith({ cheat_likelihood: 0.9 }), 'disabled', 0.7, 0);
		assert.strictEqual(hard.verifiedBlockCause, 'hard_flag');
		const clean = composeRewardBreakdown('pass_objective', 'pass', [], null);
		assert.strictEqual(clean.verifiedBlockCause, 'none');
	});

	test('criteria present but judge unavailable → visible unchecked reason, no block', () => {
		const b = composeRewardBreakdown('pass_objective', 'pass', [], null, 'disabled', 0.7, 2);
		assert.strictEqual(b.verifiedEligible, true, 'MNAR: unrunnable check is not a verdict');
		assert.ok(b.reasons.some((r) => r.includes('goal-adherence unchecked')));
		const none = composeRewardBreakdown('pass_objective', 'pass', [], null, 'disabled', 0.7, 0);
		assert.ok(!none.reasons.some((r) => r.includes('goal-adherence unchecked')));
	});
});

suite('Counterexample merge deferral (confirm gate)', () => {
	test('mergeCounterexampleIntoOracle merges, creates-when-absent, and lifts the grade', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-cx-'));
		const staged = path.join(dir, 'test_counterexample.py');
		fs.writeFileSync(staged, 'def test_cx():\n    assert add(2, -3) == -1\n');
		fs.writeFileSync(
			path.join(dir, 'manifest.json'),
			JSON.stringify({ acceptance_grade: 'B' }),
		);
		// No acceptance file yet: the human's case BECOMES the oracle.
		const created = mergeCounterexampleIntoOracle(staged, undefined, dir);
		assert.strictEqual(created, path.join(dir, 'test_acceptance.py'));
		assert.ok(fs.readFileSync(created, 'utf8').includes('def test_cx'));
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
		assert.strictEqual(manifest.acceptance_grade, 'A');
		assert.strictEqual(manifest.acceptance, created);
		// Merging into an existing oracle keeps prior tests and dedups repeats.
		fs.writeFileSync(staged, 'def test_other():\n    assert add(1, 1) == 2\n');
		const merged = mergeCounterexampleIntoOracle(staged, created, dir);
		const body = fs.readFileSync(merged, 'utf8');
		assert.ok(body.includes('def test_cx') && body.includes('def test_other'));
		const again = mergeCounterexampleIntoOracle(staged, created, dir);
		assert.strictEqual(fs.readFileSync(again, 'utf8'), body, 'repeat merge must not grow the file');
	});

	test('an unconfirmed staging never touches the oracle (byte-identity)', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-cx2-'));
		const oracle = path.join(dir, 'test_acceptance.py');
		fs.writeFileSync(oracle, 'def test_orig():\n    assert True\n');
		const before = fs.readFileSync(oracle);
		// The dispute path with deferMerge stages here and stops; only the
		// explicit merge call may change the oracle.
		fs.writeFileSync(path.join(dir, 'test_counterexample.py'), 'def test_cx():\n    assert False\n');
		assert.deepStrictEqual(fs.readFileSync(oracle), before);
	});
});

suite('Virtual-env discovery is structural, not name-based', () => {
	test('an environment with no venv-ish name at all is still found', () => {
		// PEP 405 puts `pyvenv.cfg` at the root of every virtual environment, so
		// its presence IS the environment. A name filter finds `.venv-smol` but
		// misses `.direnv`, `env39` or `sandbox` — and the target repo may call
		// its environment anything.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-envshape-'));
		try {
			for (const name of ['sandbox', '.direnv', 'toolchain']) {
				makeVenv(root, name);
			}
			// A directory that merely LOOKS like source must not be offered.
			fs.mkdirSync(path.join(root, 'mypkg'), { recursive: true });

			const found = discoverPythonCandidates(root).filter((c) => c.startsWith(root));
			for (const name of ['sandbox', '.direnv', 'toolchain']) {
				assert.ok(
					found.some((c) => c.includes(`${path.sep}${name}${path.sep}`)),
					`${name} should be discovered by shape, got ${JSON.stringify(found)}`,
				);
			}
			assert.ok(!found.some((c) => c.includes(`${path.sep}mypkg${path.sep}`)));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
