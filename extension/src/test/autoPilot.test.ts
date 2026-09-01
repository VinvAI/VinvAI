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
	decideAfterHarnessPick,
	decideHarnessGate,
	decideOnFailure,
	grantMoreBudget,
	DEFAULT_BUDGETS,
	failureSignature,
	initialServiceState,
	markGaveUp,
	markGreen,
	noteSetupAttempt,
	initialPipelineLedger,
	planNextAction,
	planPipelineAction,
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

suite('Auto-Pilot budgets: configurable and toppable-up', () => {
	test('a top-up clears spent counters so the raised ceiling actually buys work', () => {
		// The bug this guards: raising the budget alone leaves setupAttempts and
		// fixEpisodes at the old limit, so the next failure gives up again and
		// re-asks the user immediately — an infinite prompt loop.
		const exhausted: ServiceState = {
			name: 'api',
			phase: 'gave-up',
			setupAttempts: 3,
			fixEpisodes: { 'setup:boom': 2 },
		};
		const granted = grantMoreBudget(exhausted);
		assert.strictEqual(granted.setupAttempts, 0);
		assert.deepStrictEqual(granted.fixEpisodes, {});
		assert.strictEqual(granted.phase, 'needs-setup', 'a gave-up service is retryable again');

		// With counters cleared and a raised ceiling, the next failure retries
		// instead of giving up.
		const raised = { setupAttempts: 4, fixEpisodesPerSignature: 5, totalFixEpisodes: 9 };
		const { decision } = decideOnFailure(granted, 'setup', 'setup:boom', raised);
		assert.notStrictEqual(decision.next, 'give-up');
	});

	test('a top-up does not resurrect a service the user chose to stop', () => {
		const running: ServiceState = {
			name: 'api',
			phase: 'needs-start',
			setupAttempts: 1,
			fixEpisodes: {},
		};
		// Phase is only rewritten for gave-up; anything else is left alone.
		assert.strictEqual(grantMoreBudget(running).phase, 'needs-start');
	});
});

suite('autoPilotMachine: exercise is not starved by a stuck service', () => {
	const ledger = initialPipelineLedger();

	test('a service still on its FIRST setup attempt is worth waiting for', () => {
		const services = [svc({ name: 'api', setupAttempts: 0 }), svc({ name: 'web', phase: 'green' })];
		// Services first while bring-up is making progress: every service that
		// comes up adds endpoints for the exercise pass to drive.
		assert.deepStrictEqual(planPipelineAction(true, services, ledger), {
			kind: 'setup',
			service: 'api',
		});
	});

	test('a service RETRYING setup no longer blocks exercise', () => {
		const services = [svc({ name: 'api', setupAttempts: 2 }), svc({ name: 'web', phase: 'green' })];
		// The regression: 'api' retried within budget forever and testing never
		// ran, even though 'web' was up and serving the whole time.
		assert.deepStrictEqual(planPipelineAction(true, services, ledger), { kind: 'exercise' });
	});

	test('with nothing green, a retry is not preempted — an empty pass proves nothing', () => {
		const services = [svc({ name: 'api', setupAttempts: 2 })];
		// The exerciser drives live services on their ports, so exercising with
		// nothing up reports 0/N covered and "no issues" — a pass that tested
		// nothing, banked as done. Keep fixing bring-up instead.
		assert.deepStrictEqual(planPipelineAction(true, services, ledger), {
			kind: 'setup',
			service: 'api',
		});
	});

	test('a CLI/library workspace still reaches exercise', () => {
		// Nothing is green and nothing ever will be, but 'library' is terminal, so
		// the scheduler drains to exercise rather than stalling. The green gate
		// above only guards preemption of an in-flight retry — it must not make
		// exercise unreachable for workspaces that never serve anything.
		const services = [svc({ name: 'cli', phase: 'library' })];
		assert.deepStrictEqual(planPipelineAction(true, services, ledger), { kind: 'exercise' });
	});

	test('exercise is scheduled once, not re-entered after it has run', () => {
		const services = [svc({ name: 'api', setupAttempts: 2 }), svc({ name: 'web', phase: 'green' })];
		const after = { ...ledger, exercise: 'done' as const };
		assert.deepStrictEqual(planPipelineAction(true, services, after), {
			kind: 'setup',
			service: 'api',
		});
	});
});

suite('autoPilotMachine: the harness gate', () => {
	test('an explicitly chosen, present harness is the only silent start', () => {
		assert.strictEqual(decideHarnessGate(true, true), 'proceed');
	});

	test('never chosen asks, even though the id accessor would answer claude-code', () => {
		// The regression this pins: "unchosen" defaults to claude-code
		// downstream, so a run would silently drive the whole workspace through
		// an agent the user never picked and may not have installed.
		assert.strictEqual(decideHarnessGate(false, true), 'ask');
		assert.strictEqual(decideHarnessGate(false, false), 'ask');
	});

	test('a chosen harness that has since disappeared asks again', () => {
		assert.strictEqual(decideHarnessGate(true, false), 'ask');
	});

	test('dismissing the prompt stops the run — it does not fall back', () => {
		assert.strictEqual(decideAfterHarnessPick(null, true), 'stop-unpicked');
		assert.strictEqual(decideAfterHarnessPick(null, false), 'stop-unpicked');
	});

	test('a pick that is present proceeds; one still absent stops', () => {
		assert.strictEqual(decideAfterHarnessPick('codex', true), 'proceed');
		// The picker installs before resolving, so absent here means the install
		// is still running — stop rather than dispatch into a missing CLI.
		assert.strictEqual(decideAfterHarnessPick('codex', false), 'stop-absent');
	});
});
