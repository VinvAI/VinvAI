/**
 * The optimization RL loop, closed: measured optimization verdicts
 * (optimization_outcome events, contract C1) train the composition bandit,
 * calibrate predicted-vs-measured speedups (contract C2), COMA counterfactual
 * credit assignment replaces Shapley-over-means, and the sparse-feature
 * optimism floor keeps thin evidence explorable (local-maxima dip guard).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	EPISODE_FEATURES,
	appendEpisodeEvent,
	effectiveEpsilon,
	episodeLedgerPath,
	explorationFloor,
	loadEpisodePolicy,
	POLICY_PRIORS,
	selectEpisodeArm,
	sparseFeatureFraction,
	type ArmPosterior,
	type EpisodePolicy,
} from '../harness/episodeTelemetry';
import {
	calibrationFilePath,
	computeOptimizationCalibration,
	computeUpdatedPolicy,
	counterfactualAttribution,
	maybeUpdateEpisodePolicy,
	readCompletedEpisodes,
	readOptimizationOutcomes,
	type CompletedEpisode,
	type OptimizationOutcome,
} from '../harness/episodePolicyUpdater';

/** Writes a throwaway ledger of raw JSONL lines and returns its path. */
const ledgerWith = (lines: object[]): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-opt-ledger-'));
	const p = path.join(dir, 'episodes.jsonl');
	fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
	return p;
};

/** A contract-C1 optimization_outcome ledger line (uses `at`, not `ts`). */
const outcomeLine = (
	episodeId: string,
	verdict: string,
	over: Partial<{ row: number; waste_kind: string; predicted_ms: number; delta_ms: number; attempt: number }> = {},
): object => ({
	type: 'optimization_outcome',
	at: 1_760_000_000,
	episode_id: episodeId,
	row: over.row ?? 7,
	waste_kind: over.waste_kind ?? 'n_plus_one',
	predicted_ms: over.predicted_ms ?? 100,
	delta_ms: over.delta_ms ?? 80,
	verdict,
	attempt: over.attempt ?? 1,
});

suite('Optimization outcomes close the RL loop (contract C1)', () => {
	const startEnd = (id: string, arm: number): object[] => [
		{ type: 'episode_start', episode_id: id, arm_index: arm, propensity: 0.4 },
		// An optimization episode (kind 'general') ends with NO objective
		// oracle verdict — the measurement resolves later, asynchronously.
		{ type: 'episode_end', episode_id: id, reward: 0, attempts: 1, verified: false, objective: false },
	];

	test("'proven' re-labels the episode an objective SUCCESS for its arm", () => {
		const p = ledgerWith([...startEnd('o1', 3), outcomeLine('o1', 'proven')]);
		const episodes = readCompletedEpisodes(p);
		assert.strictEqual(episodes.length, 1);
		assert.strictEqual(episodes[0].verified, true);
		assert.strictEqual(episodes[0].objective, true);
		assert.strictEqual(episodes[0].reward, 1);
		// …and the posterior actually trains: Beta(1,1) prior + 1 success.
		const next = computeUpdatedPolicy({ ...POLICY_PRIORS }, episodes);
		assert.deepStrictEqual(next.arm_posteriors![3], { alpha: 2, beta: 1 });
	});

	test("'regressed' and 'reverted-behavior' are objective FAILURES", () => {
		for (const verdict of ['regressed', 'reverted-behavior']) {
			const p = ledgerWith([...startEnd('o2', 2), outcomeLine('o2', verdict)]);
			const [e] = readCompletedEpisodes(p);
			assert.strictEqual(e.verified, false, verdict);
			assert.strictEqual(e.objective, true, verdict);
			assert.strictEqual(e.reward, -1, verdict);
			const next = computeUpdatedPolicy({ ...POLICY_PRIORS }, [e]);
			assert.deepStrictEqual(next.arm_posteriors![2], { alpha: 1, beta: 2 });
		}
	});

	test("'inconclusive' is EXCLUDED — the episode stays non-objective", () => {
		const p = ledgerWith([...startEnd('o3', 1), outcomeLine('o3', 'inconclusive')]);
		const [e] = readCompletedEpisodes(p);
		assert.strictEqual(e.objective, false, 'no measurement, no bandit evidence');
		const next = computeUpdatedPolicy({ ...POLICY_PRIORS }, [e]);
		assert.deepStrictEqual(next.arm_posteriors![1], { alpha: 1, beta: 1 }, 'prior untouched');
	});

	test('within a row the LATEST verdict wins (a retry supersedes)', () => {
		const p = ledgerWith([
			...startEnd('o4', 3),
			outcomeLine('o4', 'regressed', { row: 5, attempt: 1 }),
			outcomeLine('o4', 'proven', { row: 5, attempt: 2 }),
		]);
		const [e] = readCompletedEpisodes(p);
		assert.strictEqual(e.verified, true, 'attempt 2 proved the same row');
	});

	test('across rows a failure DOMINATES a proven sibling', () => {
		const p = ledgerWith([
			...startEnd('o5', 3),
			outcomeLine('o5', 'proven', { row: 1 }),
			outcomeLine('o5', 'reverted-behavior', { row: 2 }),
		]);
		const [e] = readCompletedEpisodes(p);
		assert.strictEqual(e.verified, false, 'one shipped regression outweighs one proof');
		assert.strictEqual(e.objective, true);
	});

	test('an outcome for an unknown episode id is inert; retraction outranks proven', () => {
		const p = ledgerWith([
			outcomeLine('ghost', 'proven'),
			...startEnd('o6', 0),
			outcomeLine('o6', 'proven'),
			{ type: 'reconciliation', episode_id: 'o6', retracted: true },
		]);
		const episodes = readCompletedEpisodes(p);
		assert.strictEqual(episodes.length, 1);
		assert.strictEqual(episodes[0].verified, false, 'human counterexample wins');
		assert.strictEqual(episodes[0].reward, -1);
	});

	test('full path: synthetic ledger events → maybeUpdateEpisodePolicy trains the arm and writes the calibration artifact', () => {
		const previous = process.env.VINV_HOME;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-opt-home-'));
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-opt-ws-'));
		try {
			process.env.VINV_HOME = home;
			appendEpisodeEvent({
				type: 'episode_start',
				ts: new Date(0).toISOString(),
				episode_id: 'e1',
				arm_index: 3,
				propensity: 0.4,
			});
			appendEpisodeEvent({
				type: 'episode_end',
				ts: new Date(0).toISOString(),
				episode_id: 'e1',
				verified: false,
				aborted: false,
				objective: false,
				attempts: 1,
				reward: 0,
			});
			// The verdict bridge appends the EXACT contract-C1 line (raw, `at`
			// not `ts`) to the same ledger — simulate it verbatim.
			fs.appendFileSync(
				episodeLedgerPath(),
				JSON.stringify(outcomeLine('e1', 'proven', { predicted_ms: 100, delta_ms: 150 })) + '\n',
			);
			const next = maybeUpdateEpisodePolicy(ws);
			assert.deepStrictEqual(
				next.arm_posteriors![3],
				{ alpha: 2, beta: 1 },
				'the proven verdict trained arm 3 as an objective success',
			);
			const calibration = JSON.parse(fs.readFileSync(calibrationFilePath(ws), 'utf8')) as {
				updated_at: string;
				by_waste_kind: Record<string, { n: number; mean_ratio: number; shrunk_ratio: number }>;
			};
			const kind = calibration.by_waste_kind.n_plus_one;
			assert.strictEqual(kind.n, 1);
			assert.ok(Math.abs(kind.mean_ratio - 1.5) < 1e-12, '|150|/100');
			assert.ok(Math.abs(kind.shrunk_ratio - 1.5) < 1e-12, 'single kind: global mean = own mean');
			assert.ok(calibration.updated_at.length > 0);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(ws, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previous;
			}
		}
	});
});

suite('COMA counterfactual credit assignment (episodePolicyUpdater)', () => {
	test('hand-computed grid: exact advantages, evidence weighting, empty pairs skipped', () => {
		// Grid (bit0 = slice_depth, bit1 = include_runtime, bit2 = snippet_chars).
		// Observed arms 0–3 (snippet lean), 4 objective episodes each, Beta(1,1)
		// prior: arm0 2s/2f → μ=1/2; arm1 4s/0f → μ=5/6; arm2 1s/3f → μ=1/3;
		// arm3 3s/1f → μ=2/3. Arms 4–7 never pulled → pure prior μ=1/2, n=0.
		// Four arms since snippet_chars left the grid (see EPISODE_FEATURES). The
		// HALF-EMPTY-PAIR property this test was written for is preserved by leaving
		// the runtime-on arms (2,3) unpulled instead of the old snippet-rich 4-7:
		// comparing an observed mean against an untouched prior would credit
		// distance-from-0.5 rather than the feature, so such pairs must be skipped.
		const posteriors: ArmPosterior[] = [
			{ alpha: 3, beta: 3 }, // arm0 3s/3f -> mu 1/2
			{ alpha: 5, beta: 1 }, // arm1 5s/1f -> mu 5/6
			{ alpha: 1, beta: 1 }, // arm2 never pulled -> pure prior
			{ alpha: 1, beta: 1 }, // arm3 never pulled -> pure prior
		];
		const counts = [4, 4, 0, 0];
		const n0 = 2;
		const phi = counterfactualAttribution(posteriors, counts, n0);
		// slice_depth: pair (1,0) has evidence, pairN=8, Δ = 5/6 − 1/2 = 1/3; pair
		// (3,2) has zero evidence → skipped. raw = 1/3; total paired evidence N=8
		// → shrunk = (1/3)·8/(8+2) = 4/15.
		assert.ok(Math.abs(phi.slice_depth - 4 / 15) < 1e-12, `slice_depth ${phi.slice_depth}`);
		// include_runtime: BOTH its pairs (2,0) and (3,1) have an unpulled side, so
		// every pair is half-empty and all are skipped: raw = 0, shrunk = 0. This is
		// the property the removed snippet_chars case used to cover.
		assert.ok(Math.abs(phi.include_runtime - 0) < 1e-12, `include_runtime ${phi.include_runtime}`);
	});

	test('no evidence at all → all-zero advantages (never NaN)', () => {
		const arms = 1 << EPISODE_FEATURES.length;
		const flat: ArmPosterior[] = Array.from({ length: arms }, () => ({ alpha: 1, beta: 1 }));
		const phi = counterfactualAttribution(flat, new Array<number>(arms).fill(0), 2);
		assert.deepStrictEqual(phi, { slice_depth: 0, include_runtime: 0 });
	});

	test('computeUpdatedPolicy credits the feature whose toggle drives success', () => {
		// Runtime-on arms verify, runtime-off arms fail — attribution must give
		// include_runtime a clearly positive advantage and keep the output shape.
		const episodes: CompletedEpisode[] = [];
		for (let i = 0; i < 10; i++) {
			episodes.push({ armIndex: 3, propensity: 0.5, reward: 1, attempts: 1, verified: true, objective: true });
			episodes.push({ armIndex: 1, propensity: 0.5, reward: 0, attempts: 1, verified: false, objective: true });
		}
		const next = computeUpdatedPolicy({ ...POLICY_PRIORS }, episodes);
		assert.ok(next.attribution, 'attribution report still computed');
		assert.ok(next.attribution!.include_runtime > 0.4, `runtime credited (${next.attribution!.include_runtime})`);
		// slice_depth is EXACTLY zero here, not merely small. Both arms pulled (3 =
		// 0b11 and 1 = 0b01) carry slice_depth 1, so its pairs (1,0) and (3,2) each
		// have an unpulled side, every pair is half-empty, and all are skipped —
		// the same rule asserted at 1e-12 above. A loose bound here would pass even
		// if the untoggled feature were credited at 0.5, which is the whole thing
		// this assertion exists to rule out.
		assert.ok(
			Math.abs(next.attribution!.slice_depth) < 1e-12,
			`untoggled feature must be exactly zero, got ${next.attribution!.slice_depth}`,
		);
	});
});

suite('Optimization calibration maths (contract C2)', () => {
	const outcome = (
		wasteKind: string,
		predictedMs: number,
		deltaMs: number,
		verdict = 'proven',
	): OptimizationOutcome => ({
		episodeId: 'e',
		row: 1,
		wasteKind,
		predictedMs,
		deltaMs,
		verdict,
		attempt: 1,
	});

	test('n0=3 shrinkage: 1 sample sits near the global mean, many near their own', () => {
		const outcomes = [
			...Array.from({ length: 10 }, () => outcome('dense_kind', 100, 200)), // ratio 2.0 ×10
			outcome('sparse_kind', 100, 20), // ratio 0.2 ×1
		];
		const calibration = computeOptimizationCalibration(outcomes)!;
		const globalMean = (10 * 2.0 + 0.2) / 11;
		const sparse = calibration.by_waste_kind.sparse_kind;
		const dense = calibration.by_waste_kind.dense_kind;
		assert.strictEqual(sparse.n, 1);
		assert.ok(Math.abs(sparse.mean_ratio - 0.2) < 1e-12);
		// (1·0.2 + 3·global)/4 — three parts global, one part own.
		assert.ok(Math.abs(sparse.shrunk_ratio - (0.2 + 3 * globalMean) / 4) < 1e-12);
		assert.ok(
			Math.abs(sparse.shrunk_ratio - globalMean) < Math.abs(sparse.mean_ratio - globalMean) / 2,
			'a 1-sample kind sits closer to the global mean than to its own',
		);
		assert.strictEqual(dense.n, 10);
		assert.ok(Math.abs(dense.shrunk_ratio - (10 * 2.0 + 3 * globalMean) / 13) < 1e-12);
		assert.ok(Math.abs(dense.shrunk_ratio - 2.0) < 0.1, 'a 10-sample kind stays near its own mean');
	});

	test('only resolved outcomes calibrate; |delta| is used; bad predictions skipped', () => {
		const calibration = computeOptimizationCalibration([
			outcome('k', 100, -50, 'regressed'), // resolved: ratio |−50|/100 = 0.5
			outcome('k', 100, 999, 'inconclusive'), // no measurement — excluded
			outcome('k', 100, 999, 'reverted-behavior'), // behavior break — excluded
			outcome('k', 0, 10, 'proven'), // no defined ratio — skipped
		])!;
		assert.strictEqual(calibration.by_waste_kind.k.n, 1);
		assert.ok(Math.abs(calibration.by_waste_kind.k.mean_ratio - 0.5) < 1e-12);
		assert.strictEqual(
			computeOptimizationCalibration([outcome('k', 100, 1, 'inconclusive')]),
			null,
			'no resolved evidence → no artifact, never an empty husk',
		);
	});

	test('readOptimizationOutcomes parses contract-C1 lines and skips torn ones', () => {
		const p = ledgerWith([
			outcomeLine('e1', 'proven', { waste_kind: 'dup_compute', predicted_ms: 40, delta_ms: 30 }),
			{ type: 'episode_start', episode_id: 'e1', arm_index: 0, propensity: 1 },
		]);
		fs.appendFileSync(p, '{"type":"optimization_outcome","episode_id":"torn'); // torn tail
		const outcomes = readOptimizationOutcomes(p);
		assert.strictEqual(outcomes.length, 1);
		assert.strictEqual(outcomes[0].wasteKind, 'dup_compute');
		assert.strictEqual(outcomes[0].predictedMs, 40);
	});
});

suite('Sparse-feature optimism floor (local-maxima dip guard)', () => {
	// Arms 0–1 heavily observed, arms 2–3 (include_runtime level 1) never pulled:
	// exactly one of the TWO features has a sparse level. (It was one of three
	// when snippet_chars was a feature; that bit was inert and left the grid —
	// see EPISODE_FEATURES. The property under test is unchanged.)
	const lopsided: ArmPosterior[] = [
		{ alpha: 50, beta: 50 },
		{ alpha: 50, beta: 50 },
		{ alpha: 1, beta: 1 },
		{ alpha: 1, beta: 1 },
	];

	test('the floor stays bounded away from zero while a feature level is under-observed', () => {
		const policy: EpisodePolicy = { ...POLICY_PRIORS, episodes_seen: 1_000_000 };
		// Decayed ε has annealed to the minimum…
		assert.strictEqual(effectiveEpsilon(policy, 8), policy.epsilon_min);
		// …but one sparse feature of two keeps the floor at ε0·(1/2).
		assert.ok(Math.abs(sparseFeatureFraction(policy, lopsided) - 1 / 2) < 1e-12);
		const floor = explorationFloor(policy, lopsided);
		assert.ok(Math.abs(floor - policy.epsilon0 / 2) < 1e-12, `floor ${floor}`);
		assert.ok(floor > effectiveEpsilon(policy, 8), 'optimism bonus beats the annealed ε');
		// Once every feature level has ≥K observations the bonus vanishes.
		const saturated: ArmPosterior[] = Array.from({ length: 1 << EPISODE_FEATURES.length }, () => ({ alpha: 50, beta: 50 }));
		assert.strictEqual(sparseFeatureFraction(policy, saturated), 0);
		assert.strictEqual(explorationFloor(policy, saturated), policy.epsilon_min);
		// Cold start: everything sparse → the ceiling ε0, never above it.
		const cold: ArmPosterior[] = Array.from({ length: 1 << EPISODE_FEATURES.length }, () => ({ alpha: 1, beta: 1 }));
		assert.strictEqual(explorationFloor(policy, cold), policy.epsilon0);
	});

	// LIVENESS SMOKE TEST, not a proof of the optimism floor — labelled because a
	// green assertion here does NOT establish the guard works. Measured on this
	// grid: sparse arms are drawn 94/400 WITH the floor and 91/400 with it
	// neutralised (epsilon0 = epsilon_min). That difference is noise, and it has
	// to be: a 'sparse' arm is by definition prior-dominated, i.e. Beta(1,1) with
	// a WIDE posterior, so Thompson sampling reaches it unaided. The floor is not
	// what gets you there.
	//
	// The floor's real contract is an EPSILON-FLOOR fact — eps0 * sparseFraction,
	// held above the annealed epsilon — and the test above asserts exactly that
	// and does discriminate. This one only pins that such arms remain REACHABLE
	// at all, which is worth keeping and worth not overclaiming. (Halving the
	// grid to 4 arms also doubled each arm's uniform epsilon share, so the floor
	// carries even less of the sampling load than it did at 8.)
	test('an arm carrying the sparse feature level is still REACHABLE (liveness)', () => {
		// A confident posterior on arm 1 that would starve arms 2–3 (the unobserved
		// include_runtime level) under pure Thompson + annealed ε; the dip guard
		// must keep them reachable.
		const posteriors: ArmPosterior[] = [
			{ alpha: 10, beta: 90 },
			{ alpha: 90, beta: 10 },
			{ alpha: 1, beta: 1 },
			{ alpha: 1, beta: 1 },
		];
		const policy: EpisodePolicy = {
			...POLICY_PRIORS,
			episodes_seen: 1_000_000, // annealed: decayed ε = ε_min
			arm_posteriors: posteriors,
		};
		let seed = 424242;
		const rng = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		let sparseHits = 0;
		for (let i = 0; i < 400; i++) {
			const d = selectEpisodeArm(policy, rng);
			if (d.armIndex >= 2) {
				sparseHits += 1;
			}
			assert.ok(d.propensity > 0 && d.propensity <= 1 + 1e-9);
		}
		assert.ok(sparseHits > 0, `sparse-feature arms sampled (${sparseHits}/400)`);
	});
});
