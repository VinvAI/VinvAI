/**
 * Tests for the post-green pipeline's pure logic:
 *  - the extended Auto-Pilot machine (insights → probes stages + budgets),
 *  - probe synthesis from observed trace values (and its authoring gaps),
 *  - probe judging and the authored-probe contract,
 *  - diff-impact computation and stale-endpoint detection,
 *  - the once-per-epoch enhancement gate,
 *  - issue composition and signature dedup.
 *
 * All pure — no filesystem, no processes, no engine binaries.
 */
import * as assert from 'assert';
import {
	applyStageOutcome,
	decideOnStageFailure,
	DEFAULT_BUDGETS,
	initialPipelineLedger,
	initialServiceState,
	planPipelineAction,
	rearmProbesAfterExercise,
	settleUnreachableStages,
	type PipelineLedger,
	type ServiceState,
} from '../harness/autoPilotMachine';
import {
	asAuthoredProbes,
	concretizePath,
	exampleFromSummary,
	judgeProbe,
	pathParamNames,
	synthesizeProbeSpecs,
	type ArgExample,
} from '../harness/probeRunner';
import { computeDiffImpact, staleEndpointIds } from '../index/diffImpact';
import { parsePorcelain, withinWindow, RECENT_WINDOW_MINUTES } from '../graph/changedFiles';
import { shouldAutoEnhance, stateFromRecord } from '../index/enhanceRunner';
import { composeIssues, issueSignature, summarizeTree } from '../harness/insightRunner';
import type { CallNode } from '../identification/identification';
import type { EndpointInsight, ProbeOutcome } from '../harness/pipelineState';

function svc(over: Partial<ServiceState> = {}): ServiceState {
	return { name: 'api', phase: 'green', setupAttempts: 0, fixEpisodes: {}, ...over };
}

function endpoint(over: Partial<EndpointInsight> = {}): EndpointInsight {
	return {
		id: 'GET /health',
		trigger: 'GET /health',
		handler: 'app.health',
		calltreePath: null,
		reportPath: null,
		traceCount: 1,
		errorCount: 0,
		symbols: ['app.health'],
		lastBuilt: '2026-01-01T00:00:00Z',
		...over,
	};
}

suite('pipeline machine: scheduling', () => {
	test('services drain before any post-green stage', () => {
		const ledger = initialPipelineLedger();
		const action = planPipelineAction(
			true,
			[svc({ phase: 'needs-setup' }), svc({ name: 'b', phase: 'green' })],
			ledger,
		);
		assert.deepStrictEqual(action, { kind: 'setup', service: 'api' });
	});

	test('after green comes probes, then exercise, then done', () => {
		let ledger = initialPipelineLedger();
		const services = [svc()];
		// Insights is not a scheduled stage: pipelineRunners rebuilds it on new
		// capture spans, so the pipeline goes straight to the evidence stages.
		assert.deepStrictEqual(planPipelineAction(true, services, ledger), { kind: 'probes' });
		ledger = applyStageOutcome(ledger, 'probes', 'done');
		assert.deepStrictEqual(planPipelineAction(true, services, ledger), { kind: 'exercise' });
		ledger = applyStageOutcome(ledger, 'exercise', 'done');
		assert.deepStrictEqual(planPipelineAction(true, services, ledger), { kind: 'done' });
	});

	// The scheduler runs probes BEFORE exercise, and on a cold workspace that
	// order can never work: probes replay requests a trace already saw, exercise
	// is what CREATES the first ones. So every first run went probes → skipped →
	// exercise → traffic finally exists → and probes was already terminal, so it
	// never ran. You needed a second Auto-Pilot run before probes did anything.
	test('probes re-arm once exercise has produced traffic to replay', () => {
		let ledger = initialPipelineLedger();
		const services = [svc()];

		assert.deepStrictEqual(planPipelineAction(true, services, ledger), { kind: 'probes' });
		// Cold workspace: nothing has hit an endpoint, so probes has nothing.
		ledger = applyStageOutcome(ledger, 'probes', 'skipped');
		assert.deepStrictEqual(planPipelineAction(true, services, ledger), { kind: 'exercise' });

		// Exercise drives every discovered endpoint itself — that IS the traffic.
		ledger = applyStageOutcome(ledger, 'exercise', 'done');
		ledger = rearmProbesAfterExercise(ledger);
		assert.deepStrictEqual(
			planPipelineAction(true, services, ledger),
			{ kind: 'probes' },
			'probes must get its one real chance',
		);

		// And it is ONE chance: a second skip must not re-arm again, or the
		// scheduler ping-pongs between the two stages forever.
		ledger = applyStageOutcome(ledger, 'probes', 'skipped');
		ledger = rearmProbesAfterExercise(ledger);
		assert.deepStrictEqual(planPipelineAction(true, services, ledger), { kind: 'done' });
	});

	test('re-arming touches nothing it should not', () => {
		const base = initialPipelineLedger();
		// A probe stage that RAN is governed by its own outcome, not by this.
		for (const phase of ['done', 'failed', 'pending'] as const) {
			const ledger = { ...base, probes: phase, exercise: 'done' as const };
			assert.strictEqual(
				rearmProbesAfterExercise(ledger),
				ledger,
				`a '${phase}' probe stage must be left alone`,
			);
		}
		// Exercise that did not finish produced no traffic, so probes would just
		// skip again — re-arming there only burns a stage.
		for (const phase of ['pending', 'failed', 'skipped'] as const) {
			const ledger = { ...base, probes: 'skipped' as const, exercise: phase };
			assert.strictEqual(
				rearmProbesAfterExercise(ledger),
				ledger,
				`exercise '${phase}' must not re-arm probes`,
			);
		}
	});

	test('a workspace of libraries still exercises — nothing to serve is not nothing to drive', () => {
		// insights and probes read what a live traced session recorded, so with
		// nothing green they are correctly skipped. The exercise stage drives code
		// in workers off the source and the index: no port, no traffic, no service.
		// Gating it on `anyGreen` made Vinv a no-op on every library repo.
		let ledger = initialPipelineLedger();
		const libraries = [svc({ phase: 'library' }), svc({ name: 'b', phase: 'gave-up' })];
		assert.deepStrictEqual(planPipelineAction(true, libraries, ledger), { kind: 'exercise' });
		ledger = applyStageOutcome(ledger, 'exercise', 'done');
		assert.deepStrictEqual(planPipelineAction(true, libraries, ledger), { kind: 'done' });
	});

	test('without a green service probes stays skipped', () => {
		const ledger = initialPipelineLedger();
		const libraries = [svc({ phase: 'library' })];
		// Never 'probes' — it has no traced session to read.
		assert.notDeepStrictEqual(planPipelineAction(true, libraries, ledger), { kind: 'probes' });
	});

	test('a stage no service will ever feed is settled, not left pending forever', () => {
		// Leaving it 'pending' reached 'done' with a stage that reads, to anything
		// showing the ledger, as work still to come.
		const libraries = [svc({ phase: 'library' }), svc({ name: 'b', phase: 'gave-up' })];
		const settled = settleUnreachableStages(libraries, initialPipelineLedger());
		assert.strictEqual(settled.probes, 'skipped');
		// The one stage that CAN run on a library repo is untouched.
		assert.strictEqual(settled.exercise, 'pending');
		assert.deepStrictEqual(planPipelineAction(true, libraries, settled), { kind: 'exercise' });
	});

	test('settling is idempotent and never overwrites a stage that ran', () => {
		const green = [svc({ phase: 'green' })];
		const ledger = initialPipelineLedger();
		// A green service means every stage is reachable — nothing is settled.
		assert.deepStrictEqual(settleUnreachableStages(green, ledger), ledger);

		const libraries = [svc({ phase: 'library' })];
		const ran = applyStageOutcome(initialPipelineLedger(), 'probes', 'done');
		const settled = settleUnreachableStages(libraries, ran);
		assert.strictEqual(settled.probes, 'done');
		assert.deepStrictEqual(settleUnreachableStages(libraries, settled), settled);
	});

	test('skipped and failed stages are terminal for the run', () => {
		let ledger = applyStageOutcome(initialPipelineLedger(), 'probes', 'failed');
		assert.deepStrictEqual(planPipelineAction(true, [svc()], ledger), { kind: 'exercise' });
		ledger = applyStageOutcome(ledger, 'exercise', 'skipped');
		assert.deepStrictEqual(planPipelineAction(true, [svc()], ledger), { kind: 'done' });
	});

	test('undiscovered workspaces still discover first', () => {
		assert.deepStrictEqual(planPipelineAction(false, [], initialPipelineLedger()), {
			kind: 'discover',
		});
	});
});

suite('pipeline machine: stage failure budgets', () => {
	test('a first failure spends a fix episode and re-arms the stage', () => {
		const { ledger, decision } = decideOnStageFailure(
			initialPipelineLedger(),
			'probes',
			'sigA',
			DEFAULT_BUDGETS,
		);
		assert.deepStrictEqual(decision, { next: 'fix' });
		assert.strictEqual(ledger.probes, 'pending');
		assert.strictEqual(ledger.fixEpisodes['sigA'], 1);
	});

	test('the same signature gives up after its per-signature budget', () => {
		let ledger: PipelineLedger = initialPipelineLedger();
		for (let i = 0; i < DEFAULT_BUDGETS.fixEpisodesPerSignature; i++) {
			const r = decideOnStageFailure(ledger, 'probes', 'sigA', DEFAULT_BUDGETS);
			assert.strictEqual(r.decision.next, 'fix');
			ledger = r.ledger;
		}
		const final = decideOnStageFailure(ledger, 'probes', 'sigA', DEFAULT_BUDGETS);
		assert.strictEqual(final.decision.next, 'give-up');
		assert.strictEqual(final.ledger.probes, 'failed');
	});

	test('the absolute cap stops signature-shifting stage failures', () => {
		const shifty: PipelineLedger = {
			...initialPipelineLedger(),
			fixEpisodes: { s1: 2, s2: 2, s3: 2 },
		};
		const { decision, ledger } = decideOnStageFailure(shifty, 'probes', 'sBrandNew', DEFAULT_BUDGETS);
		assert.strictEqual(decision.next, 'give-up');
		assert.strictEqual(ledger.probes, 'failed');
	});

	test('decideOnStageFailure never mutates its input', () => {
		const before = initialPipelineLedger();
		decideOnStageFailure(before, 'probes', 'sigA', DEFAULT_BUDGETS);
		assert.deepStrictEqual(before.fixEpisodes, {});
		assert.strictEqual(before.probes, 'pending');
	});

	test('initialServiceState still drives the ladder the pipeline sits on', () => {
		// A smoke check that the widened PilotStep type kept the service machine intact.
		assert.strictEqual(initialServiceState('a', 'verified', false).phase, 'needs-start');
	});
});

suite('probe synthesis: observed values → specs', () => {
	test('scalars and short strings are complete examples; truncated are not', () => {
		assert.deepStrictEqual(exampleFromSummary({ v: 42 }), { value: '42', complete: true });
		assert.deepStrictEqual(exampleFromSummary({ v: true }), { value: 'true', complete: true });
		assert.deepStrictEqual(exampleFromSummary({ head: 'abc', len: 3 }), {
			value: 'abc',
			complete: true,
		});
		// head holds only the first 32 chars — a longer string is incomplete input.
		assert.strictEqual(exampleFromSummary({ head: 'x'.repeat(32), len: 64 })?.complete, false);
		assert.strictEqual(exampleFromSummary({ truncated: true })?.complete, false);
		assert.strictEqual(exampleFromSummary(undefined), null);
	});

	test('path parameter tokens across framework syntaxes', () => {
		assert.deepStrictEqual(pathParamNames('/users/{id}/posts/{post_id}'), ['id', 'post_id']);
		assert.deepStrictEqual(pathParamNames('/users/<int:user_id>'), ['user_id']);
		assert.deepStrictEqual(pathParamNames('/users/:id'), ['id']);
		assert.deepStrictEqual(pathParamNames('/health'), []);
	});

	test('concretization substitutes observed values and flags gaps', () => {
		const examples: Record<string, ArgExample> = { id: { value: '7', complete: true } };
		assert.deepStrictEqual(concretizePath('/users/{id}', examples), {
			path: '/users/7',
			complete: true,
		});
		assert.strictEqual(concretizePath('/users/{id}/x/{other}', examples).complete, false);
		// Incomplete evidence never lands in a URL.
		assert.strictEqual(
			concretizePath('/u/{id}', { id: { value: 'partial', complete: false } }).complete,
			false,
		);
	});

	test('GET with observed params is ready; POST needs authoring', () => {
		const specs = synthesizeProbeSpecs(
			[
				endpoint({ id: 'a', trigger: 'GET /users/{id}', handler: 'app.get_user' }),
				endpoint({ id: 'b', trigger: 'POST /users', handler: 'app.create_user' }),
				endpoint({ id: 'c', trigger: 'GET /orders/{id}', handler: 'app.get_order' }),
			],
			new Map([['app.get_user', { id: { value: '7', complete: true } }]]),
		);
		const byEndpoint = new Map(specs.map((s) => [s.endpointId, s]));
		assert.strictEqual(byEndpoint.get('a')?.status, 'ready');
		assert.strictEqual(byEndpoint.get('a')?.path, '/users/7');
		assert.strictEqual(byEndpoint.get('b')?.status, 'needs-authoring');
		assert.ok(byEndpoint.get('b')?.authoringReason?.includes('body'));
		// No observed value for the order id → authoring, with the reason recorded.
		assert.strictEqual(byEndpoint.get('c')?.status, 'needs-authoring');
	});

	test('expectations derive from the observed health of the endpoint', () => {
		const specs = synthesizeProbeSpecs(
			[
				endpoint({ id: 'clean', trigger: 'GET /ok', errorCount: 0 }),
				endpoint({ id: 'dirty', trigger: 'GET /bad', errorCount: 3 }),
			],
			new Map(),
		);
		assert.strictEqual(specs.find((s) => s.endpointId === 'clean')?.expected.statusClass, '2xx-3xx');
		assert.strictEqual(specs.find((s) => s.endpointId === 'dirty')?.expected.statusClass, 'no-5xx');
	});

	test('non-HTTP triggers are skipped', () => {
		assert.deepStrictEqual(
			synthesizeProbeSpecs([endpoint({ trigger: 'worker process_queue' })], new Map()),
			[],
		);
	});
});

suite('probe judging', () => {
	const clean = { expected: { statusClass: '2xx-3xx' as const, handler: null, noServerError: true as const } };
	const dirty = { expected: { statusClass: 'no-5xx' as const, handler: null, noServerError: true as const } };

	test('2xx passes, 5xx always fails, no response always fails', () => {
		assert.strictEqual(judgeProbe(clean, 200).verdict, 'pass');
		assert.strictEqual(judgeProbe(clean, 500).verdict, 'fail');
		assert.strictEqual(judgeProbe(dirty, 503).verdict, 'fail');
		assert.strictEqual(judgeProbe(clean, null, 'connection refused').verdict, 'fail');
	});

	test('4xx fails a clean-observed endpoint but passes a no-5xx one', () => {
		assert.strictEqual(judgeProbe(clean, 404).verdict, 'fail');
		assert.strictEqual(judgeProbe(dirty, 404).verdict, 'pass');
	});

	test('authored-probe contract: shape-checked, concrete, capped', () => {
		assert.deepStrictEqual(asAuthoredProbes(null), []);
		assert.deepStrictEqual(asAuthoredProbes({ probes: 'nope' }), []);
		const parsed = asAuthoredProbes({
			probes: [
				{ method: 'post', path: '/users', body: '{"name":"x"}', content_type: 'application/json' },
				{ method: 'GET', path: 'users' }, // not absolute — rejected
				{ method: 'GET' }, // no path — rejected
			],
		});
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0].method, 'POST');
	});
});

suite('diff impact: change awareness', () => {
	const nodes = [
		{ name: 'a', file: 'a.py' }, // in the changed set
		{ name: 'b', file: 'b.py' }, // calls a → impacted
		{ name: 'c', file: 'c.py' }, // calls b → impacted transitively
		{ name: 'd', file: 'd.py' }, // unrelated
	];
	const edges: Array<{ src: number; dst: number; kind: 'invoke' | 'contains' }> = [
		{ src: 1, dst: 0, kind: 'invoke' },
		{ src: 2, dst: 1, kind: 'invoke' },
		{ src: 3, dst: 0, kind: 'contains' }, // contains edges never carry impact
	];

	test('changed symbols + inbound closure, mirroring the explorer diff mode', () => {
		const impact = computeDiffImpact(nodes, edges, new Set(['a.py']));
		assert.deepStrictEqual(
			impact.changedSymbols.map((c) => c.name),
			['a'],
		);
		assert.strictEqual(impact.impactedCount, 3); // a + b + c, never d
		assert.deepStrictEqual([...impact.impactedFiles].sort(), ['a.py', 'b.py', 'c.py']);
	});

	test('a clean working tree reports no changes (was: every symbol on a first index)', () => {
		// Regression: the old predicate was `node.epoch === storeEpoch`, and a
		// first index assigns EVERY chunk epoch 1 with a store epoch of 1 — so
		// the whole map rendered as changed. The changed set is now the authority.
		const impact = computeDiffImpact(nodes, edges, new Set(), 1);
		assert.strictEqual(impact.changedSymbols.length, 0);
		assert.strictEqual(impact.impactedCount, 0);
		assert.deepStrictEqual(impact.impactedFiles, []);
	});

	test('every changed file seeds the closure, and impact unions across them', () => {
		const impact = computeDiffImpact(nodes, edges, new Set(['a.py', 'd.py']));
		assert.deepStrictEqual(
			impact.changedSymbols.map((c) => c.name).sort(),
			['a', 'd'],
		);
		assert.strictEqual(impact.impactedCount, 4); // a + b + c, plus d itself
	});

	test('endpoints overlapping a changed symbol are stale — others are not', () => {
		const stale = staleEndpointIds(
			[
				{ id: 'hit', symbols: ['x', 'a'] },
				{ id: 'miss', symbols: ['y'] },
			],
			[{ name: 'a', file: 'a.py' }],
		);
		assert.deepStrictEqual(stale, ['hit']);
		assert.deepStrictEqual(staleEndpointIds([{ id: 'e', symbols: ['a'] }], []), []);
	});
});

suite('diff impact: what counts as changed', () => {
	const NUL = '\0';

	test('porcelain -z yields staged, unstaged and untracked paths', () => {
		const out = [
			' M src/a.ts', // unstaged modification
			'M  src/b.ts', // staged modification
			'MM src/c.ts', // staged AND further modified
			'?? src/new.ts', // untracked
			'A  src/added.ts', // staged add
			'D  src/gone.ts', // staged delete
		].join(NUL) + NUL;
		assert.deepStrictEqual(
			[...parsePorcelain(out)].sort(),
			['src/a.ts', 'src/added.ts', 'src/b.ts', 'src/c.ts', 'src/gone.ts', 'src/new.ts'],
		);
	});

	test('a rename reports both sides and consumes its source token', () => {
		// `R  new\0old\0 M other\0` — the source token must NOT be parsed as an entry.
		const out = 'R  src/new.ts' + NUL + 'src/old.ts' + NUL + ' M src/other.ts' + NUL;
		assert.deepStrictEqual(
			[...parsePorcelain(out)].sort(),
			['src/new.ts', 'src/old.ts', 'src/other.ts'],
		);
	});

	test('paths are rebased onto the workspace prefix, outsiders dropped', () => {
		// Workspace is <repo>/extension; git reports repo-root-relative paths.
		const out = [' M extension/src/a.ts', ' M index/src/lib.rs'].join(NUL) + NUL;
		assert.deepStrictEqual([...parsePorcelain(out, 'extension/')], ['src/a.ts']);
	});

	test('a clean tree parses to an empty set', () => {
		assert.strictEqual(parsePorcelain('').size, 0);
		assert.strictEqual(parsePorcelain(NUL).size, 0);
	});

	test('the no-repo fallback keeps only files inside the window', () => {
		const now = 1_700_000_000_000;
		const min = 60_000;
		const recent = withinWindow(
			[
				{ file: 'fresh.ts', mtimeMs: now - 5 * min },
				{ file: 'edge.ts', mtimeMs: now - RECENT_WINDOW_MINUTES * min }, // exactly at the floor
				{ file: 'stale.ts', mtimeMs: now - 31 * min },
				{ file: 'ancient.ts', mtimeMs: now - 400 * min },
			],
			now,
		);
		assert.deepStrictEqual([...recent].sort(), ['edge.ts', 'fresh.ts']);
	});

	test('the fallback window is 30 minutes', () => {
		assert.strictEqual(RECENT_WINDOW_MINUTES, 30);
	});
});

suite('enhance gate: once per epoch, terminal after', () => {
	test('runs only for a new epoch with open ambiguities', () => {
		assert.strictEqual(shouldAutoEnhance(null, 3, 5), true);
		assert.strictEqual(shouldAutoEnhance({ epoch: 2 }, 3, 5), true);
	});

	test('never re-offers the same epoch — even with references remaining', () => {
		assert.strictEqual(shouldAutoEnhance({ epoch: 3 }, 3, 5), false);
	});

	test('no ambiguities or no epoch means nothing to do', () => {
		assert.strictEqual(shouldAutoEnhance(null, 3, 0), false);
		assert.strictEqual(shouldAutoEnhance(null, 0, 9), false);
	});

	test('a run with remaining references is the terminal exhausted state', () => {
		assert.strictEqual(
			stateFromRecord({ epoch: 3, resolved: 2, remaining: 4, ranAt: 'x' }).status,
			'exhausted',
		);
		assert.strictEqual(
			stateFromRecord({ epoch: 3, resolved: 6, remaining: 0, ranAt: 'x' }).status,
			'resolved',
		);
		assert.strictEqual(stateFromRecord(null).status, 'never-run');
	});
});

suite('issue identification', () => {
	test('summarizeTree collects symbols, error counts and types', () => {
		const tree: CallNode = {
			name: 'root',
			runtime: { executed: true, error: 1, errors: ['ValueError'] },
			children: [
				{ name: 'child', runtime: { executed: true, error: 2, errors: ['KeyError'] } },
				{ name: 'quiet', runtime: { executed: true, error: 0 } },
			],
		};
		const s = summarizeTree(tree);
		assert.deepStrictEqual(s.symbols.sort(), ['child', 'quiet', 'root']);
		assert.strictEqual(s.errorCount, 3);
		assert.deepStrictEqual(s.errorTypes.sort(), ['KeyError', 'ValueError']);
		assert.deepStrictEqual(summarizeTree(undefined), { symbols: [], errorCount: 0, errorTypes: [] });
	});

	test('signatures are stable across numeric noise, distinct across content', () => {
		assert.strictEqual(
			issueSignature('runtime-error', 'f at a.py:10 — 3 error(s): ValueError'),
			issueSignature('runtime-error', 'f at a.py:99 — 7 error(s): ValueError'),
		);
		assert.notStrictEqual(
			issueSignature('runtime-error', 'f: ValueError'),
			issueSignature('runtime-error', 'f: KeyError'),
		);
	});

	test('composeIssues merges all three evidence kinds and carries dispatch flags', () => {
		const probeFail: ProbeOutcome = {
			id: 'p1',
			endpointId: 'e1',
			method: 'GET',
			path: '/x',
			verdict: 'fail',
			httpStatus: 500,
		};
		const clusters = [{ row: 4, line: 'f at a.py:10 — 3 error(s): ValueError' }];
		const eps = [endpoint({ id: 'e1', trigger: 'GET /x', errorCount: 2 })];
		const types = new Map([['e1', ['ValueError']]]);
		const first = composeIssues(clusters, eps, types, [probeFail], new Set());
		assert.strictEqual(first.length, 3);
		assert.ok(first.every((i) => !i.dispatched));
		// Re-compose with the first issue recorded as dispatched: the flag survives.
		const second = composeIssues(clusters, eps, types, [probeFail], new Set([first[0].id]));
		assert.strictEqual(second.find((i) => i.id === first[0].id)?.dispatched, true);
		assert.strictEqual(second.filter((i) => i.dispatched).length, 1);
	});

	test('healthy evidence produces no issues', () => {
		assert.deepStrictEqual(composeIssues([], [endpoint()], new Map(), [], new Set()), []);
	});
});
