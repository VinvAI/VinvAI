/**
 * Infrastructure/precondition failure handling for harness runs — the "CLI is
 * not logged in" class of defect that must terminate work on the FIRST
 * occurrence instead of burning attempts, stall judges, and fix budgets.
 *
 * Covers:
 *   - classifyHarnessFailure: per-CLI auth/quota/network fingerprints, the
 *     weak-vs-strong pattern rule, and the false-positive guards;
 *   - the session block registry (mark/get/clear) and preflightHarnessAuth
 *     semantics (failed probes never cached → re-dispatch after login
 *     proceeds fresh);
 *   - gateAttemptRun, the episode loop's seam: an infra-classified run is
 *     terminal after ONE attempt — no verification, stall-judge, dispute, or
 *     escalation machinery may engage, and the outcome is objective:false;
 *   - runHarnessPrompt end-to-end against a fake signed-out CLI (real spawn,
 *     real classification, block set) and after "login" (block cleared);
 *   - markBlockedOnHarness: an Auto-Pilot blocked dispatch consumes NO setup
 *     attempts and NO fix-episode budget.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	classifyHarnessFailure,
	clearHarnessBlock,
	dispatchAgentPrompt,
	getHarness,
	getHarnessBlock,
	harnessBlockRemediation,
	INFRA_BLOCK_LABELS,
	markHarnessBlocked,
	preflightHarnessAuth,
	resetHarnessBlockStateForTests,
	runHarnessPrompt,
} from '../harness/harnessRunner';
import { gateAttemptRun } from '../harness/episodeLoop';
import {
	decideOnFailure,
	DEFAULT_BUDGETS,
	markBlockedOnHarness,
	summarize,
	type ServiceState,
} from '../harness/autoPilotMachine';

const CURSOR_AUTH_ERROR =
	'Error: Authentication required. Please run cursor-agent login first, or set CURSOR_API_KEY environment variable';

suite('classifyHarnessFailure: auth patterns per CLI', () => {
	test('cursor: the live-defect output classifies as auth on exit 1', () => {
		assert.strictEqual(classifyHarnessFailure(CURSOR_AUTH_ERROR, 1), 'auth');
	});

	test('cursor: the same refusal on exit 0 (short output) is still auth', () => {
		// Some CLIs print the refusal and exit 0 — a strong pattern must not
		// depend on the exit code.
		assert.strictEqual(classifyHarnessFailure(CURSOR_AUTH_ERROR, 0), 'auth');
	});

	test('claude: /login, expired OAuth, and invalid key all classify as auth', () => {
		assert.strictEqual(classifyHarnessFailure('Please run /login', 1), 'auth');
		assert.strictEqual(
			classifyHarnessFailure('OAuth token has expired. Please obtain a new token.', 1),
			'auth',
		);
		assert.strictEqual(classifyHarnessFailure('API Error: Invalid API key', 1), 'auth');
	});

	test('claude: a bare ANTHROPIC_API_KEY mention is weak — needs a failing exit', () => {
		assert.strictEqual(classifyHarnessFailure('set the ANTHROPIC_API_KEY env var', 1), 'auth');
		// The same words in a SUCCESSFUL run are an agent's answer, not a failure.
		assert.strictEqual(classifyHarnessFailure('set the ANTHROPIC_API_KEY env var', 0), 'other');
	});

	test('codex: not-logged-in and codex login classify as auth', () => {
		assert.strictEqual(
			classifyHarnessFailure('Not logged in. Run codex login to authenticate.', 1),
			'auth',
		);
	});

	test('gemini: invalid API key classifies as auth', () => {
		assert.strictEqual(
			classifyHarnessFailure('[400] API key not valid. Please pass a valid API key.', 1),
			'auth',
		);
	});
});

suite('classifyHarnessFailure: quota and network', () => {
	test('vendor quota messages classify as quota', () => {
		assert.strictEqual(
			classifyHarnessFailure('Your credit balance is too low to access the API.', 1),
			'quota',
		); // anthropic
		assert.strictEqual(
			classifyHarnessFailure('You exceeded your current quota, please check your plan.', 1),
			'quota',
		); // openai
		assert.strictEqual(classifyHarnessFailure('error code: insufficient_quota', 1), 'quota');
		assert.strictEqual(classifyHarnessFailure('429 RESOURCE_EXHAUSTED', 1), 'quota'); // google
		assert.strictEqual(classifyHarnessFailure('usage limit reached — upgrade to continue', 1), 'quota');
	});

	test('unreachable-vendor errors classify as network', () => {
		assert.strictEqual(
			classifyHarnessFailure('getaddrinfo ENOTFOUND api.anthropic.com', 1),
			'network',
		);
		assert.strictEqual(classifyHarnessFailure('connect ECONNREFUSED 104.18.0.1:443', 1), 'network');
		assert.strictEqual(classifyHarnessFailure('TypeError: fetch failed', 1), 'network');
		// Weak network words on a clean exit are not a failure at all.
		assert.strictEqual(classifyHarnessFailure('the app logged: fetch failed once', 0), 'other');
	});

	test('auth outranks network when both appear', () => {
		assert.strictEqual(
			classifyHarnessFailure('fetch failed after: Authentication required', 1),
			'auth',
		);
	});
});

suite('classifyHarnessFailure: false-positive guards', () => {
	test('an ordinary failing run stays other', () => {
		assert.strictEqual(classifyHarnessFailure('Error: 3 tests failed\nexit 1', 1), 'other');
		assert.strictEqual(classifyHarnessFailure('', 1), 'other');
		assert.strictEqual(classifyHarnessFailure('build succeeded', 0), 'other');
	});

	test('a long successful answer that MENTIONS a login command is not infra', () => {
		// An agent explaining harness auth to the user must never classify its
		// own success as an auth failure.
		const answer = `${'The auth flow works like this. '.repeat(100)}\nIf signed out, run cursor-agent login.`;
		assert.ok(answer.length > 2000);
		assert.strictEqual(classifyHarnessFailure(answer, 0), 'other');
	});
});

suite('harness block registry + preflight', () => {
	setup(() => resetHarnessBlockStateForTests());
	teardown(() => resetHarnessBlockStateForTests());

	test('mark → get → clear round-trips, with the remediation attached', () => {
		assert.strictEqual(getHarnessBlock('cursor'), undefined);
		const block = markHarnessBlocked('cursor', 'auth', { notify: false });
		assert.strictEqual(block.kind, 'auth');
		assert.ok(block.remediation.includes('cursor-agent login'));
		assert.deepStrictEqual(getHarnessBlock('cursor'), block);
		clearHarnessBlock('cursor');
		assert.strictEqual(getHarnessBlock('cursor'), undefined);
	});

	test('remediation names the exact command per harness', () => {
		assert.ok(harnessBlockRemediation(getHarness('cursor'), 'auth').includes('cursor-agent login'));
		assert.ok(harnessBlockRemediation(getHarness('claude-code'), 'auth').includes('/login'));
		assert.ok(harnessBlockRemediation(getHarness('codex'), 'auth').includes('codex login'));
		assert.ok(/quota|credits/i.test(harnessBlockRemediation(getHarness('cursor'), 'quota')));
		assert.ok(/network|reach/i.test(harnessBlockRemediation(getHarness('cursor'), 'network')));
	});

	test('a probe-less harness never keeps a stale block standing (re-dispatch proceeds)', async () => {
		markHarnessBlocked('claude-code', 'auth', { notify: false });
		// claude-code has no cheap auth probe: preflight must not permanently
		// bury the harness — it clears the block and lets the dispatch itself
		// re-classify in one cheap failure.
		assert.strictEqual(await preflightHarnessAuth('claude-code'), 'ok');
		assert.strictEqual(getHarnessBlock('claude-code'), undefined);
	});

	test('a blocked harness makes dispatchAgentPrompt degrade to null without spawning', async () => {
		markHarnessBlocked('cursor', 'auth', { notify: false });
		const t0 = Date.now();
		const reply = await dispatchAgentPrompt('cursor', os.tmpdir(), 'infra-test', 'hello');
		assert.strictEqual(reply, null);
		assert.ok(Date.now() - t0 < 1000, 'must short-circuit, not spawn a doomed CLI');
	});
});

suite('gateAttemptRun: the episode terminal seam', () => {
	const cursor = getHarness('cursor');

	test('an auth-failing run is terminal after ONE attempt — no verify/stall/judge', () => {
		const stop = gateAttemptRun(
			{ ok: false, infra: 'auth', detail: 'Run `cursor-agent login` …' },
			cursor,
		);
		assert.ok(stop, 'infra runs must stop the episode');
		assert.strictEqual(stop.kind, 'auth');
		// The Flow/issue surface shows blocked-on-you, not "agent working".
		assert.strictEqual(stop.endLabel, 'blocked: agent CLI needs login');
		assert.ok(stop.remediation.includes('cursor-agent login'));
	});

	test('quota and network map to their own blocked labels', () => {
		assert.strictEqual(
			gateAttemptRun({ ok: false, infra: 'quota' }, cursor)?.endLabel,
			'blocked: agent CLI quota exhausted',
		);
		assert.strictEqual(
			gateAttemptRun({ ok: false, infra: 'network' }, cursor)?.endLabel,
			'blocked: agent CLI cannot reach its service',
		);
		assert.deepStrictEqual(Object.keys(INFRA_BLOCK_LABELS).sort(), ['auth', 'network', 'quota']);
	});

	test('ordinary outcomes pass through to the normal verification machinery', () => {
		assert.strictEqual(gateAttemptRun({ ok: true }, cursor), null);
		assert.strictEqual(
			gateAttemptRun({ ok: false, detail: 'exited with code 2' }, cursor),
			null,
		);
	});

	test('missing detail falls back to the catalog remediation', () => {
		const stop = gateAttemptRun({ ok: false, infra: 'auth' }, cursor);
		assert.ok(stop?.remediation.includes('cursor-agent login'));
	});
});

suite('runHarnessPrompt: fake signed-out CLI (integration)', function () {
	// Real spawns through the real dispatch path — allow generous time.
	this.timeout(20_000);

	let binDir = '';
	let workspace = '';
	let savedPath: string | undefined;
	const fake = () => path.join(binDir, 'cursor-agent');

	/** Installs a fake `cursor-agent` shell script first on PATH. */
	function installFake(script: string): void {
		fs.writeFileSync(fake(), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	}

	suiteSetup(function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-fake-cli-'));
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-infra-ws-'));
		savedPath = process.env.PATH;
		process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
	});

	suiteTeardown(() => {
		if (savedPath !== undefined) {
			process.env.PATH = savedPath;
		}
		resetHarnessBlockStateForTests();
		fs.rmSync(binDir, { recursive: true, force: true });
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	setup(() => resetHarnessBlockStateForTests());

	test('a signed-out dispatch classifies auth, carries the remediation, and blocks the session', async () => {
		installFake(`cat >/dev/null\necho "${CURSOR_AUTH_ERROR}" >&2\nexit 1`);
		const run = await runHarnessPrompt('cursor', workspace, 'infra-auth', 'fix the bug');
		assert.strictEqual(run.ok, false);
		assert.strictEqual(run.infra, 'auth');
		assert.ok(run.detail?.includes('cursor-agent login'), `detail was: ${run.detail}`);
		assert.strictEqual(getHarnessBlock('cursor')?.kind, 'auth');
		// The episode loop's gate turns exactly this result into a terminal
		// infra stop BEFORE any verification/stall machinery — one attempt.
		const stop = gateAttemptRun(run, getHarness('cursor'));
		assert.strictEqual(stop?.endLabel, 'blocked: agent CLI needs login');
	});

	test('preflight probe (`cursor-agent status`) fails closed, then passes after login', async () => {
		installFake(`echo "${CURSOR_AUTH_ERROR}" >&2\nexit 1`);
		assert.strictEqual(await preflightHarnessAuth('cursor'), 'auth');
		assert.strictEqual(getHarnessBlock('cursor')?.kind, 'auth');
		// Failed probes are never cached: the next dispatch attempt re-probes.
		assert.strictEqual(await preflightHarnessAuth('cursor'), 'auth');
		// "Login": the same probe now succeeds — the block clears and the same
		// signature can dispatch fresh (blocked ≠ dispatched).
		installFake('echo "Logged in as tester"\nexit 0');
		assert.strictEqual(await preflightHarnessAuth('cursor'), 'ok');
		assert.strictEqual(getHarnessBlock('cursor'), undefined);
	});

	test('re-dispatch after login proceeds fresh and a success clears the block', async () => {
		// First: signed out — dispatch fails and blocks.
		installFake(`cat >/dev/null\necho "${CURSOR_AUTH_ERROR}" >&2\nexit 1`);
		const blocked = await runHarnessPrompt('cursor', workspace, 'infra-relogin', 'fix it');
		assert.strictEqual(blocked.infra, 'auth');
		assert.ok(getHarnessBlock('cursor'));
		// Then: the human logs in (fake now handles both `status` and a run).
		installFake('if [ "$1" = "status" ]; then echo ok; exit 0; fi\ncat >/dev/null\necho "done: applied the fix"\nexit 0');
		const rerun = await runHarnessPrompt('cursor', workspace, 'infra-relogin', 'fix it');
		assert.strictEqual(rerun.ok, true, `detail: ${rerun.detail}`);
		assert.strictEqual(rerun.infra, undefined);
		assert.ok(rerun.stdout.includes('applied the fix'));
		assert.strictEqual(getHarnessBlock('cursor'), undefined);
	});
});

suite('autoPilotMachine: blocked dispatch consumes no budgets', () => {
	const svc = (): ServiceState => ({
		name: 'api',
		phase: 'needs-setup',
		setupAttempts: 2,
		fixEpisodes: { 'setup:something': 1 },
	});

	test('markBlockedOnHarness is terminal but spends nothing', () => {
		const before = svc();
		const blocked = markBlockedOnHarness(before, 'Cursor CLI needs login — run `cursor-agent login`');
		assert.strictEqual(blocked.phase, 'gave-up');
		assert.ok(blocked.reason?.startsWith('blocked on you:'));
		assert.ok(blocked.reason?.includes('cursor-agent login'));
		// The whole point: no setup attempt and no fix episode was consumed —
		// the next run (after login) starts with the budgets intact.
		assert.strictEqual(blocked.setupAttempts, before.setupAttempts);
		assert.deepStrictEqual(blocked.fixEpisodes, before.fixEpisodes);
	});

	test('contrast: the normal failure path DOES spend a fix episode', () => {
		const { state } = decideOnFailure(svc(), 'setup', 'setup:new-sig', DEFAULT_BUDGETS);
		assert.strictEqual(state.fixEpisodes['setup:new-sig'], 1);
	});

	test('a blocked service surfaces in the gave-up summary bucket (blocked-on-you)', () => {
		const { gaveUp } = summarize([markBlockedOnHarness(svc(), 'needs login')]);
		assert.strictEqual(gaveUp.length, 1);
		assert.ok(gaveUp[0].reason?.includes('blocked on you'));
	});
});
