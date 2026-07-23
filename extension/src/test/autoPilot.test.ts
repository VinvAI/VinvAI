/**
 * Tests for Auto-Pilot's pure decision core (autoPilotMachine.ts): the next-
 * action scheduler, per-service state construction, the failure/budget policy
 * (setup attempts, fix episodes per failure signature, the absolute cap), the
 * signature normalization, and the end-of-run summary. All pure — no vscode,
 * no filesystem.
 */
import * as assert from 'assert';
import {
	applySetupOutcome,
	decideOnFailure,
	DEFAULT_BUDGETS,
	failureSignature,
	initialServiceState,
	markGaveUp,
	markGreen,
	noteSetupAttempt,
	planNextAction,
	summarize,
	type AutoPilotBudgets,
	type ServiceState,
} from '../harness/autoPilotMachine';

const budgets: AutoPilotBudgets = { ...DEFAULT_BUDGETS };

function svc(over: Partial<ServiceState> = {}): ServiceState {
	return { name: 'api', phase: 'needs-setup', setupAttempts: 0, fixEpisodes: {}, ...over };
}

suite('autoPilotMachine: initial state', () => {
	test('unattempted and failed bring-ups both need setup', () => {
		assert.strictEqual(initialServiceState('a', 'unattempted', false).phase, 'needs-setup');
		// A failed prior bring-up re-enters setup — retrying it is Auto-Pilot's job.
		assert.strictEqual(initialServiceState('a', 'failed', false).phase, 'needs-setup');
	});

	test('verified maps to needs-start, or green when already running', () => {
		assert.strictEqual(initialServiceState('a', 'verified', false).phase, 'needs-start');
		const running = initialServiceState('a', 'verified', true);
		assert.strictEqual(running.phase, 'green');
		assert.strictEqual(running.reason, 'already running');
	});

	test('library outcomes are terminal skips, never failures', () => {
		const lib = initialServiceState('a', 'library', false);
		assert.strictEqual(lib.phase, 'library');
		assert.ok(lib.reason?.includes('library'));
	});
});

suite('autoPilotMachine: scheduler', () => {
	test('discover comes before everything', () => {
		assert.deepStrictEqual(planNextAction(false, [svc({ phase: 'needs-start' })]), {
			kind: 'discover',
		});
	});

	test('all setups drain before any start', () => {
		const action = planNextAction(true, [
			svc({ name: 'ready', phase: 'needs-start' }),
			svc({ name: 'raw', phase: 'needs-setup' }),
		]);
		assert.deepStrictEqual(action, { kind: 'setup', service: 'raw' });
	});

	test('starts follow, then done when everything is terminal', () => {
		assert.deepStrictEqual(
			planNextAction(true, [
				svc({ name: 'a', phase: 'green' }),
				svc({ name: 'b', phase: 'needs-start' }),
			]),
			{ kind: 'start', service: 'b' },
		);
		assert.deepStrictEqual(
			planNextAction(true, [
				svc({ name: 'a', phase: 'green' }),
				svc({ name: 'b', phase: 'library' }),
				svc({ name: 'c', phase: 'gave-up' }),
			]),
			{ kind: 'done' },
		);
	});

	test('no services at all is done (nothing to drive)', () => {
		assert.deepStrictEqual(planNextAction(true, []), { kind: 'done' });
	});
});

suite('autoPilotMachine: setup outcomes', () => {
	test('verified moves to needs-start and clears any stale reason', () => {
		const next = applySetupOutcome(svc({ reason: 'old' }), 'verified');
		assert.strictEqual(next.phase, 'needs-start');
		assert.strictEqual(next.reason, undefined);
	});

	test('library is terminal with the symptom in the reason', () => {
		const next = applySetupOutcome(svc(), 'library', 'no __main__ to run');
		assert.strictEqual(next.phase, 'library');
		assert.ok(next.reason?.includes('no __main__'));
	});

	test('failed and unattempted stay in needs-setup for the failure policy', () => {
		assert.strictEqual(applySetupOutcome(svc(), 'failed', 'boom').phase, 'needs-setup');
		assert.strictEqual(applySetupOutcome(svc(), 'unattempted').phase, 'needs-setup');
	});

	test('noteSetupAttempt increments without mutating the input', () => {
		const before = svc();
		const after = noteSetupAttempt(before);
		assert.strictEqual(after.setupAttempts, 1);
		assert.strictEqual(before.setupAttempts, 0);
	});
});

suite('autoPilotMachine: failure signatures', () => {
	test('stable across run-to-run numeric noise', () => {
		const a = failureSignature('start', 'port 8000 never accepted within 45s (pid 1234)');
		const b = failureSignature('start', 'port 8000 never accepted within 62s (pid 9876)');
		assert.strictEqual(a, b);
	});

	test('distinct failures and distinct steps get distinct signatures', () => {
		const a = failureSignature('start', 'connection refused');
		const b = failureSignature('start', 'ModuleNotFoundError: flask');
		const c = failureSignature('setup', 'connection refused');
		assert.notStrictEqual(a, b);
		assert.notStrictEqual(a, c);
	});

	test('whitespace and case do not change the signature', () => {
		assert.strictEqual(
			failureSignature('setup', 'Error:  Something\n\tBroke'),
			failureSignature('setup', 'error: something broke'),
		);
	});
});

suite('autoPilotMachine: budget policy', () => {
	test('first failure spends a fix episode on its signature', () => {
		const { state, decision } = decideOnFailure(svc({ setupAttempts: 1 }), 'setup', 'sigA', budgets);
		assert.deepStrictEqual(decision, { next: 'fix' });
		assert.strictEqual(state.fixEpisodes['sigA'], 1);
	});

	test('setup gives up once the attempt budget is spent', () => {
		const { decision } = decideOnFailure(
			svc({ setupAttempts: budgets.setupAttempts }),
			'setup',
			'sigA',
			budgets,
		);
		assert.strictEqual(decision.next, 'give-up');
		assert.ok(decision.next === 'give-up' && /setup failed/.test(decision.reason));
	});

	test('the same signature gives up after its per-signature fix budget', () => {
		let state = svc({ phase: 'needs-start' });
		for (let i = 0; i < budgets.fixEpisodesPerSignature; i++) {
			const r = decideOnFailure(state, 'start', 'sigA', budgets);
			assert.strictEqual(r.decision.next, 'fix');
			state = r.state;
		}
		const final = decideOnFailure(state, 'start', 'sigA', budgets);
		assert.strictEqual(final.decision.next, 'give-up');
		assert.ok(
			final.decision.next === 'give-up' && /persisted through 2 fix episode/.test(final.decision.reason),
		);
	});

	test('a NEW signature re-arms the fix budget (per-signature dedup)', () => {
		const exhausted = svc({
			phase: 'needs-start',
			fixEpisodes: { sigA: budgets.fixEpisodesPerSignature },
		});
		const { decision, state } = decideOnFailure(exhausted, 'start', 'sigB', budgets);
		assert.deepStrictEqual(decision, { next: 'fix' });
		assert.strictEqual(state.fixEpisodes['sigB'], 1);
	});

	test('the absolute cap stops signature-shifting failures', () => {
		// Enough distinct signatures to sail past every per-signature budget.
		const shifty = svc({
			phase: 'needs-start',
			fixEpisodes: { s1: 2, s2: 2, s3: 2 }, // 6 == DEFAULT totalFixEpisodes
		});
		const { decision } = decideOnFailure(shifty, 'start', 'sBrandNew', budgets);
		assert.strictEqual(decision.next, 'give-up');
		assert.ok(decision.next === 'give-up' && /absolute cap/.test(decision.reason));
	});

	test('decideOnFailure never mutates its input', () => {
		const before = svc({ setupAttempts: 1 });
		decideOnFailure(before, 'setup', 'sigA', budgets);
		assert.deepStrictEqual(before.fixEpisodes, {});
	});
});

suite('autoPilotMachine: terminal transitions and summary', () => {
	test('markGreen and markGaveUp record the reason', () => {
		assert.strictEqual(markGreen(svc(), 'port 8000 is serving').phase, 'green');
		const gone = markGaveUp(svc(), 'budget exhausted');
		assert.strictEqual(gone.phase, 'gave-up');
		assert.strictEqual(gone.reason, 'budget exhausted');
	});

	test('summarize buckets terminal states', () => {
		const all = [
			svc({ name: 'a', phase: 'green' }),
			svc({ name: 'b', phase: 'green' }),
			svc({ name: 'c', phase: 'library' }),
			svc({ name: 'd', phase: 'gave-up', reason: 'nope' }),
		];
		const s = summarize(all);
		assert.deepStrictEqual(
			[s.green.length, s.library.length, s.gaveUp.length],
			[2, 1, 1],
		);
		assert.strictEqual(s.gaveUp[0].name, 'd');
	});

	test('drive-to-green walkthrough: fail, fix, retry, green', () => {
		// The canonical loop: setup fails once, one fix episode, retry verifies,
		// start fails once, one fix, retry serves — service ends green with
		// budgets to spare.
		let state = initialServiceState('api', 'unattempted', false);
		assert.deepStrictEqual(planNextAction(true, [state]), { kind: 'setup', service: 'api' });

		state = noteSetupAttempt(state);
		state = applySetupOutcome(state, 'failed', 'ModuleNotFoundError: flask');
		let r = decideOnFailure(state, 'setup', failureSignature('setup', 'ModuleNotFoundError: flask'), budgets);
		assert.strictEqual(r.decision.next, 'fix');
		state = r.state;

		// Retry after the fix verdict: this time bring-up verifies.
		assert.deepStrictEqual(planNextAction(true, [state]), { kind: 'setup', service: 'api' });
		state = noteSetupAttempt(state);
		state = applySetupOutcome(state, 'verified');
		assert.deepStrictEqual(planNextAction(true, [state]), { kind: 'start', service: 'api' });

		// Start-side failure, one fix, then green.
		r = decideOnFailure(state, 'start', failureSignature('start', 'replay exited with code 1'), budgets);
		assert.strictEqual(r.decision.next, 'fix');
		state = markGreen(r.state, 'port 8000 is serving');

		assert.deepStrictEqual(planNextAction(true, [state]), { kind: 'done' });
		assert.strictEqual(summarize([state]).green.length, 1);
	});
});
