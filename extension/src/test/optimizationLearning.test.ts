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
		const p = ledgerWith([...startEnd('o1', 6), outcomeLine('o1', 'proven')]);
		const episodes = readCompletedEpisodes(p);
		assert.strictEqual(episodes.length, 1);
		assert.strictEqual(episodes[0].verified, true);
		assert.strictEqual(episodes[0].objective, true);
		assert.strictEqual(episodes[0].reward, 1);
		// …and the posterior actually trains: Beta(1,1) prior + 1 success.
		const next = computeUpdatedPolicy({ ...POLICY_PRIORS }, episodes);
		assert.deepStrictEqual(next.arm_posteriors![6], { alpha: 2, beta: 1 });
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
		const posteriors: ArmPosterior[] = [
			{ alpha: 3, beta: 3 },
			{ alpha: 5, beta: 1 },
			{ alpha: 2, beta: 4 },
			{ alpha: 4, beta: 2 },
			{ alpha: 1, beta: 1 },
			{ alpha: 1, beta: 1 },
			{ alpha: 1, beta: 1 },
			{ alpha: 1, beta: 1 },
		];
		const counts = [4, 4, 4, 4, 0, 0, 0, 0];
		const n0 = 2;
		const phi = counterfactualAttribution(posteriors, counts, n0);
		// slice_depth: pairs (1,0) and (3,2), each pairN=8, Δ=1/3 each; pairs
		// (5,4),(7,6) have zero evidence → skipped. raw = 1/3; total paired
		// evidence N=16 → shrunk = (1/3)·16/(16+2) = 8/27.
		assert.ok(Math.abs(phi.slice_depth - 8 / 27) < 1e-12, `slice_depth ${phi.slice_depth}`);
		// include_runtime: pairs (2,0),(3,1), pairN=8, Δ=−1/6 each → raw −1/6,
		// shrunk = −(1/6)·16/18 = −4/27.
		assert.ok(Math.abs(phi.include_runtime - -4 / 27) < 1e-12, `include_runtime ${phi.include_runtime}`);
		// snippet_chars: every pair (4,0),(5,1),(6,2),(7,3) keeps the observed
		// half's evidence (pairN=4 each — NOT skipped): Δ = 0, −1/3, +1/6, −1/6
		// → raw = −1/12, shrunk = −(1/12)·16/18 = −2/27.
		assert.ok(Math.abs(phi.snippet_chars - -2 / 27) < 1e-12, `snippet_chars ${phi.snippet_chars}`);
	});

	test('no evidence at all → all-zero advantages (never NaN)', () => {
		const flat: ArmPosterior[] = Array.from({ length: 8 }, () => ({ alpha: 1, beta: 1 }));
		const phi = counterfactualAttribution(flat, new Array<number>(8).fill(0), 2);
		assert.deepStrictEqual(phi, { slice_depth: 0, include_runtime: 0, snippet_chars: 0 });
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
		assert.ok(Math.abs(next.attribution!.snippet_chars) < 0.1, 'untoggled feature near zero');
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
	// Arms 0–3 heavily observed, arms 4–7 (snippet rich level) never pulled:
	// exactly one of three features has a sparse level.
	const lopsided: ArmPosterior[] = [
		{ alpha: 50, beta: 50 },
		{ alpha: 50, beta: 50 },
		{ alpha: 50, beta: 50 },
		{ alpha: 50, beta: 50 },
		{ alpha: 1, beta: 1 },
		{ alpha: 1, beta: 1 },
		{ alpha: 1, beta: 1 },
		{ alpha: 1, beta: 1 },
	];

	test('the floor stays bounded away from zero while a feature level is under-observed', () => {
		const policy: EpisodePolicy = { ...POLICY_PRIORS, episodes_seen: 1_000_000 };
		// Decayed ε has annealed to the minimum…
		assert.strictEqual(effectiveEpsilon(policy, 8), policy.epsilon_min);
		// …but one sparse feature of three keeps the floor at ε0·(1/3).
		assert.ok(Math.abs(sparseFeatureFraction(policy, lopsided) - 1 / 3) < 1e-12);
		const floor = explorationFloor(policy, lopsided);
		assert.ok(Math.abs(floor - policy.epsilon0 / 3) < 1e-12, `floor ${floor}`);
		assert.ok(floor > effectiveEpsilon(policy, 8), 'optimism bonus beats the annealed ε');
		// Once every feature level has ≥K observations the bonus vanishes.
		const saturated: ArmPosterior[] = Array.from({ length: 8 }, () => ({ alpha: 50, beta: 50 }));
		assert.strictEqual(sparseFeatureFraction(policy, saturated), 0);
		assert.strictEqual(explorationFloor(policy, saturated), policy.epsilon_min);
		// Cold start: everything sparse → the ceiling ε0, never above it.
		const cold: ArmPosterior[] = Array.from({ length: 8 }, () => ({ alpha: 1, beta: 1 }));
		assert.strictEqual(explorationFloor(policy, cold), policy.epsilon0);
	});

	test('an arm carrying the sparse feature level still gets SAMPLED', () => {
		// A confident posterior on arm 1 that would starve arms 4–7 under pure
		// Thompson + annealed ε; the dip guard must keep them reachable.
		const posteriors: ArmPosterior[] = [
			{ alpha: 10, beta: 90 },
			{ alpha: 90, beta: 10 },
			{ alpha: 10, beta: 90 },
			{ alpha: 10, beta: 90 },
			{ alpha: 1, beta: 1 },
			{ alpha: 1, beta: 1 },
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
			if (d.armIndex >= 4) {
				sparseHits += 1;
			}
			assert.ok(d.propensity > 0 && d.propensity <= 1 + 1e-9);
		}
		assert.ok(sparseHits > 0, `sparse-feature arms sampled (${sparseHits}/400)`);
	});
});
