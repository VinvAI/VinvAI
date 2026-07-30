import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
	buildFileLevel,
	buildTour,
	classifyLayer,
	graphSlice,
	loadEdges,
	loadNodes,
	loadRuntimeAndFlow,
	loadRuntimeOverlay,
	loadStoreEpoch,
	type GraphEdge,
	type GraphNode,
	type GraphSnapshot,
} from '../graph/indexGraph';
import {
	composePackContent,
	deriveSeedRows,
	writeContextPack,
	type PackBudgets,
} from '../harness/contextPack';
import {
	appendEpisodeEvent,
	armLevels,
	effectiveEpsilon,
	episodeArmSet,
	episodeReward,
	levelsToIndex,
	loadEpisodePolicy,
	POLICY_PRIORS,
	selectEpisodeArm,
	WALK_PRIORS,
	type EpisodePolicy,
} from '../harness/episodeTelemetry';
import {
	armIndexForValues,
	bernsteinLcb,
	computeUpdatedPolicy,
	maybeUpdateEpisodePolicy,
	nearestRankQuantile,
	perArmStats,
	readCompletedEpisodes,
	shapleyAttribution,
	shrunkMean,
	type CompletedEpisode,
} from '../harness/episodePolicyUpdater';
import {
	adjudicateOne,
	enrichTagsFromFeedback,
	parseAdjudication,
	parseTagReply,
	readAdjudicated,
	readPendingEdges,
	type PendingEdge,
} from '../graph/graphEnhancer';
import { hitsToRows, type IndexHit } from '../qna/answer';
import { composeGoalContext, goalContextFromSession, parseGoalOutput } from '../harness/goalSuggest';
import { verifyServiceReplay } from '../harness/episodeLoop';
import {
	trajectoryDigest,
	DEFAULT_EPISODE_BUDGET,
	appendTranscriptEntry,
	deleteParkedSession,
	listSessions,
	loadSession,
	parseHarnessDirectives,
	recordEpisodeOutcome,
	resetSession,
	sessionTitle,
	setEpisodeBudget,
	setGoal,
	startFreshSession,
	switchToSession,
} from '../harness/session';
import {
	breakStall,
	evidenceSimilarity,
	nashDecision,
} from '../harness/stallBreaker';
import { isServiceStarted, readBringupOutcome, readStartCommands } from '../bringup/bringup';
import { collectRuntimeErrorClusters, selectHotspots } from '../harness/autoTrigger';
import { isExpectedRejection, isHandledInternally } from '../harness/runtimeAnalysis';
import { composeTrajectoryReport, readEpisodeEvents } from '../harness/trajectoryReport';
import {
	collectCacheCandidates,
	lifetimeFrames,
	collectMemoryTrends,
	collectRequestSpans,
	collectSymbolTimings,
	securityGuardReasons,
	theilSenSlope,
} from '../harness/runtimeAnalysis';
import { computeOptimizationCandidates } from '../harness/optimizationAnalysis';
import {
	captureWorkspaceSnapshot,
	revertToSnapshot,
} from '../harness/workspaceSnapshot';
import { composeSubjectSection } from '../qna/answer';
import {
	enqueueEpisodeRequest,
	readAndClearRequests,
	requestsDir,
	restoreEpisodeRequests,
} from '../harness/requestQueue';
import type { RuntimeOverlay } from '../graph/indexGraph';

const testBudgets: PackBudgets = {
	slice_budget: 24,
	seed_cap: 8,
	failure_evidence_chars: 3000,
	walk: WALK_PRIORS,
};

function makeNode(row: number, overrides: Partial<GraphNode> = {}): GraphNode {
	return {
		row,
		id: `id${row}`,
		file: `src/mod${row}.py`,
		lang: 'python',
		kind: 'function',
		name: `fn${row}`,
		start_line: 1,
		end_line: 10,
		summary: `does thing ${row}`,
		rank: 0.1,
		epoch: 0,
		parent: null,
		layer: 'service',
		...overrides,
	};
}

function makeSnapshot(nodes: GraphNode[], edges: GraphEdge[], storeEpoch = 1): GraphSnapshot {
	return {
		generated_at: new Date().toISOString(),
		workspace: '/tmp/ws',
		store_epoch: storeEpoch,
		node_count: nodes.length,
		edge_count: edges.length,
		layers: ['api', 'service', 'other'],
		nodes,
		edges,
		files: [],
		file_edges: [],
		flow_edges: [],
		tour: [],
		runtime: {},
	};
}

suite('Graph Explorer data model', () => {
	test('layer classification is deterministic path/kind heuristics', () => {
		assert.strictEqual(classifyLayer('README.md', 'doc', 'doc'), 'docs');
		assert.strictEqual(classifyLayer('src/api/routes.py', 'python', 'function'), 'api');
		assert.strictEqual(classifyLayer('tests/test_foo.py', 'python', 'function'), 'tests');
		assert.strictEqual(classifyLayer('app/models/user.py', 'python', 'class'), 'data');
		assert.strictEqual(classifyLayer('web/components/Nav.tsx', 'ts', 'function'), 'ui');
		assert.strictEqual(classifyLayer('src/utils/strings.py', 'python', 'function'), 'util');
		assert.strictEqual(classifyLayer('whatever/thing.py', 'python', 'function'), 'other');
		// Stability: same input, same layer.
		assert.strictEqual(
			classifyLayer('src/api/routes.py', 'python', 'function'),
			classifyLayer('src/api/routes.py', 'python', 'function'),
		);
	});

	test('store parsing survives malformed lines and out-of-range edges', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-store-'));
		try {
			fs.writeFileSync(
				path.join(dir, 'chunks.jsonl'),
				[
					JSON.stringify({ id: 'a', file: 'x.py', lang: 'python', kind: 'function', name: 'a', start_line: 1, end_line: 2, summary: 's', rank: 0.5, epoch: 3 }),
					'not json at all',
					JSON.stringify({ id: 'b', file: 'y.py', lang: 'python', kind: 'function', name: 'b', start_line: 1, end_line: 2, summary: 's', rank: 0.2, epoch: 1 }),
				].join('\n'),
			);
			fs.writeFileSync(
				path.join(dir, 'edges.jsonl'),
				[
					JSON.stringify({ src: 0, dst: 1, kind: 'invoke' }),
					JSON.stringify({ src: 0, dst: 99, kind: 'invoke' }), // out of range
					JSON.stringify({ src: 0, dst: 1, kind: 'weird' }), // unknown kind
				].join('\n'),
			);
			fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ epoch: 3 }));
			const nodes = loadNodes(dir);
			assert.strictEqual(nodes.length, 2);
			assert.strictEqual(nodes[0].row, 0);
			assert.strictEqual(nodes[1].name, 'b');
			const edges = loadEdges(dir, nodes.length);
			assert.strictEqual(edges.length, 1);
			assert.strictEqual(loadStoreEpoch(dir), 3);
			const { files } = buildFileLevel(nodes, edges, 3);
			assert.strictEqual(files.length, 2);
			const changed = files.find((f) => f.file === 'x.py');
			assert.strictEqual(changed?.changed, true, 'epoch==storeEpoch marks the file changed');
			const unchanged = files.find((f) => f.file === 'y.py');
			assert.strictEqual(unchanged?.changed, false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('guided tour visits callees before callers (dependency order)', () => {
		// 0 calls 1, 1 calls 2: learning order must be 2, 1, 0.
		const nodes = [
			makeNode(0, { rank: 0.9 }),
			makeNode(1, { rank: 0.5 }),
			makeNode(2, { rank: 0.4 }),
		];
		const edges: GraphEdge[] = [
			{ src: 0, dst: 1, kind: 'invoke' },
			{ src: 1, dst: 2, kind: 'invoke' },
		];
		const tour = buildTour(nodes, edges, 3);
		const order = tour.map((s) => s.row);
		assert.ok(order.indexOf(2) < order.indexOf(1), '2 (leaf) before 1');
		assert.ok(order.indexOf(1) < order.indexOf(0), '1 before 0 (root caller)');
	});

	test('guided tour terminates on cycles', () => {
		const nodes = [makeNode(0), makeNode(1)];
		const edges: GraphEdge[] = [
			{ src: 0, dst: 1, kind: 'invoke' },
			{ src: 1, dst: 0, kind: 'invoke' },
		];
		const tour = buildTour(nodes, edges, 2);
		assert.strictEqual(tour.length, 2);
	});

	test('graph slice honors depth and budget', () => {
		// star: 0 at the center, 1..5 spokes; 5 links to 6.
		const nodes = Array.from({ length: 7 }, (_, i) => makeNode(i));
		const edges: GraphEdge[] = [
			...[1, 2, 3, 4, 5].map((i) => ({ src: 0, dst: i, kind: 'invoke' as const })),
			{ src: 5, dst: 6, kind: 'invoke' },
		];
		const depth1 = graphSlice(nodes, edges, [0], 1, 100);
		assert.strictEqual(depth1.length, 6, 'depth 1 excludes the second hop');
		const depth2 = graphSlice(nodes, edges, [0], 2, 100);
		assert.strictEqual(depth2.length, 7);
		const capped = graphSlice(nodes, edges, [0], 2, 3);
		assert.strictEqual(capped.length, 3, 'budget caps expansion');
	});

	test('runtime overlay joins tracemap facts by file+name', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-ws-'));
		try {
			const dir = path.join(ws, '.vinv', 'identification');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, 'ep1.tracemap.json'),
				JSON.stringify({
					tree: {
						name: 'fn0',
						file: 'src/mod0.py',
						runtime: { executed: true, calls: 3, total_ms: 12.5, error: 1, errors: ['ValueError'] },
						children: [
							{ name: 'fn1', file: 'src/mod1.py', runtime: { executed: true, calls: 2, total_ms: 4 } },
							{ name: 'ghost', file: 'nowhere.py', runtime: { executed: true, calls: 1 } },
						],
					},
				}),
			);
			const nodes = [makeNode(0), makeNode(1)];
			const overlay = loadRuntimeOverlay(ws, nodes);
			assert.strictEqual(overlay[0].calls, 3);
			assert.strictEqual(overlay[0].errors, 1);
			assert.deepStrictEqual(overlay[0].error_types, ['ValueError']);
			assert.strictEqual(overlay[1].calls, 2);
			assert.strictEqual(Object.keys(overlay).length, 2, 'unmatched trace nodes are dropped');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('runtime overlay joins raw tracelens captures by dotted qualname', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-ws-'));
		try {
			const dir = path.join(ws, '.vinv', 'captures', 'session-x', 'svc');
			fs.mkdirSync(dir, { recursive: true });
			const exit = (component: string, ms: number, errType?: string) =>
				JSON.stringify({
					event: 'exit',
					component,
					duration_ms: ms,
					error_type: errType ?? 'None',
				});
			fs.writeFileSync(
				path.join(dir, 'trace.jsonl'),
				[
					// Plain module function → node in src/mod0.py named fn0.
					exit('src.mod0.fn0', 5),
					exit('src.mod0.fn0', 7, 'ValueError'),
					// Class method: pkg.mod.Class.fn — classless suffix must match.
					exit('src.mod1.Klass.fn1', 3),
					// Framework span (no dot-join possible) is ignored.
					exit('GET /docs', 100),
					// Segment boundary: "od0.fn0" must NOT match src/mod0.py.
					exit('od0.fn0', 999),
				].join('\n'),
			);
			const nodes = [makeNode(0), makeNode(1)];
			const overlay = loadRuntimeOverlay(ws, nodes);
			assert.strictEqual(overlay[0].calls, 2, 'both fn0 exits joined');
			assert.strictEqual(overlay[0].total_ms, 12);
			assert.strictEqual(overlay[0].errors, 1);
			assert.deepStrictEqual(overlay[0].error_types, ['ValueError']);
			assert.strictEqual(overlay[1].calls, 1, 'method matched via classless suffix');
			assert.strictEqual(
				Object.keys(overlay).length,
				2,
				'framework spans and boundary-crossing names never join',
			);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('observed call flow: parent→child pairs become directed flow edges', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-ws-'));
		try {
			const dir = path.join(ws, '.vinv', 'captures', 's', 'svc');
			fs.mkdirSync(dir, { recursive: true });
			const exit = (component: string, parent: string | null, ms: number, errType?: string) =>
				JSON.stringify({
					event: 'exit',
					component,
					parent_component: parent,
					duration_ms: ms,
					error_type: errType ?? 'None',
				});
			fs.writeFileSync(
				path.join(dir, 'trace.jsonl'),
				[
					// fn0 called fn1 twice, once erroring.
					exit('src.mod1.fn1', 'src.mod0.fn0', 4),
					exit('src.mod1.fn1', 'src.mod0.fn0', 6, 'KeyError'),
					// Framework parent ("GET /x") can't join → no flow edge.
					exit('src.mod0.fn0', 'GET /x', 10),
					// Self-loops are dropped.
					exit('src.mod0.fn0', 'src.mod0.fn0', 1),
				].join('\n'),
			);
			const nodes = [makeNode(0), makeNode(1)];
			// Static edge fn1→fn0 exists (reverse direction) → the observed
			// fn0→fn1 flow is still "predicted" (undirected static coverage).
			const { flow } = loadRuntimeAndFlow(ws, nodes, [
				{ src: 1, dst: 0, kind: 'invoke' },
			]);
			assert.strictEqual(flow.length, 1, 'exactly one aggregated flow edge');
			assert.strictEqual(flow[0].src, 0);
			assert.strictEqual(flow[0].dst, 1);
			assert.strictEqual(flow[0].calls, 2);
			assert.strictEqual(flow[0].total_ms, 10);
			assert.strictEqual(flow[0].errors, 1);
			assert.strictEqual(flow[0].observed_only, false, 'static pair covers it');
			// Without the static edge the same flow is a runtime-only discovery.
			const { flow: flow2 } = loadRuntimeAndFlow(ws, nodes, []);
			assert.strictEqual(flow2[0].observed_only, true);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('index hits map to graph rows exactly, then loosely', () => {
		const snapshot = makeSnapshot(
			[makeNode(0, { start_line: 10 }), makeNode(1, { start_line: 20 })],
			[],
		);
		const hits: IndexHit[] = [
			{ score: 1, file: 'src/mod1.py', name: 'fn1', kind: 'function', lang: 'python', lines: [20, 30], rank: 0.1, summary: '', snippet: '' },
			{ score: 0.5, file: 'src/mod0.py', name: 'fn0', kind: 'function', lang: 'python', lines: [999, 1000], rank: 0.1, summary: '', snippet: '' },
		];
		assert.deepStrictEqual(hitsToRows(snapshot, hits), [1, 0]);
	});
});

suite('Context Pack Composer', () => {
	const arm = { slice_depth: 1, include_runtime: true, snippet_chars: 1600 };

	test('pack carries issue, criteria, slice, epoch stamp, and service contract', () => {
		const nodes = [makeNode(0), makeNode(1)];
		const edges: GraphEdge[] = [{ src: 0, dst: 1, kind: 'invoke' }];
		const snapshot = makeSnapshot(nodes, edges, 4);
		snapshot.runtime[0] = { executed: true, calls: 5, total_ms: 20, errors: 2, error_types: ['KeyError'], failures: [], current_errors: 0, latest_epoch: null };
		const { content, sliceRows } = composePackContent(
			snapshot,
			{
				title: 'Fix api',
				issue: 'fn0 crashed with KeyError',
				successCriteria: ['fn0 no longer raises KeyError'],
				service: 'api',
				seedRows: [0],
			},
			arm,
			testBudgets,
			1,
		);
		assert.ok(content.includes('# Vinv Context Pack — Fix api'));
		assert.ok(content.includes('index epoch 4'));
		assert.ok(content.includes('fn0 crashed with KeyError'));
		assert.ok(content.includes('- [ ] fn0 no longer raises KeyError'));
		assert.ok(content.includes('runtime: ×5 calls'), 'runtime evidence included by the arm');
		assert.ok(content.includes('KeyError'));
		assert.ok(content.includes('.vinv/start_commands/api.json'), 'service replay contract present');
		assert.ok(content.includes('FOREGROUND'), 'foreground contract spelled out');
		assert.ok(sliceRows.includes(0) && sliceRows.includes(1), 'slice expanded along the edge');
	});

	test('runtime evidence is excluded when the arm says so; failure feedback is embedded on retries', () => {
		const snapshot = makeSnapshot([makeNode(0)], []);
		snapshot.runtime[0] = { executed: true, calls: 5, total_ms: 20, errors: 0, error_types: [], failures: [], current_errors: 0, latest_epoch: null };
		const noRuntime = composePackContent(
			snapshot,
			{ title: 't', issue: 'fn0 broken', successCriteria: ['fixed'], seedRows: [0] },
			{ ...arm, include_runtime: false },
			testBudgets,
			2,
			'port 8080 never accepted a connection',
		);
		assert.ok(!noRuntime.content.includes('runtime: ×'));
		assert.ok(noRuntime.content.includes('Previous attempt failed verification'));
		assert.ok(noRuntime.content.includes('port 8080 never accepted a connection'));
		assert.ok(noRuntime.content.includes('attempt 2'));
	});

	test('seed rows are derived from symbol names appearing in the issue text', () => {
		const nodes = [
			makeNode(0, { name: 'handle_payment', rank: 0.9 }),
			makeNode(1, { name: 'unrelated_helper', rank: 0.5 }),
		];
		const snapshot = makeSnapshot(nodes, []);
		const seeds = deriveSeedRows(snapshot, 'Traceback: handle_payment raised KeyError', 8);
		assert.deepStrictEqual(seeds, [0]);
	});

	test('writeContextPack lands the file under .vinv/context', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-pack-'));
		try {
			const snapshot = makeSnapshot([makeNode(0)], []);
			const pack = writeContextPack(
				ws,
				snapshot,
				{ title: 't', issue: 'i', successCriteria: ['c'], seedRows: [0] },
				arm,
				testBudgets,
				1,
			);
			assert.ok(pack.path.startsWith(path.join(ws, '.vinv', 'context')));
			assert.ok(fs.readFileSync(pack.path, 'utf8').includes('# Vinv Context Pack'));
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});

suite('Episode telemetry (bandit over pack composition)', () => {
	test('the factored arm grid is a stable 2^3 factorial with invertible indexing', () => {
		const previous = process.env.VINV_EPISODE_ARM_LEVELS;
		try {
			delete process.env.VINV_EPISODE_ARM_LEVELS;
			const arms = episodeArmSet();
			assert.strictEqual(arms.length, 8, 'full factorial over three binary features');
			// Every coalition is an arm and the index round-trips.
			for (let i = 0; i < 8; i++) {
				assert.strictEqual(levelsToIndex(armLevels(i)), i);
			}
			// Env override with valid levels reshapes the grid.
			process.env.VINV_EPISODE_ARM_LEVELS = JSON.stringify({
				slice_depth: [0, 3],
				include_runtime: [false, true],
				snippet_chars: [500, 4000],
			});
			assert.strictEqual(episodeArmSet()[7].slice_depth, 3);
			assert.strictEqual(episodeArmSet()[7].snippet_chars, 4000);
			// Garbage env keeps the policy grid — exploration never stops.
			process.env.VINV_EPISODE_ARM_LEVELS = 'garbage';
			assert.deepStrictEqual(episodeArmSet(), arms);
		} finally {
			if (previous === undefined) {
				delete process.env.VINV_EPISODE_ARM_LEVELS;
			} else {
				process.env.VINV_EPISODE_ARM_LEVELS = previous;
			}
		}
	});

	test('Thompson selection concentrates on the best arm and logs a valid propensity', () => {
		// A confident posterior: arm 5 verifies ~90%, all others ~10%.
		const arms = episodeArmSet(POLICY_PRIORS);
		const posteriors = arms.map((_, a) =>
			a === 5 ? { alpha: 90, beta: 10 } : { alpha: 10, beta: 90 },
		);
		const policy: EpisodePolicy = {
			...POLICY_PRIORS,
			epsilon_min: 0.05,
			epsilon0: 0.05, // pin the OPE support floor at 0.05
			episodes_seen: 400,
			arm_posteriors: posteriors,
		};
		// Deterministic rng for reproducibility.
		let seed = 12345;
		const rng = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		let bestHits = 0;
		const N = 400;
		for (let i = 0; i < N; i++) {
			const d = selectEpisodeArm(policy, rng);
			if (d.armIndex === 5) {
				bestHits += 1;
			}
			// Every logged propensity is a valid probability with the floor mass.
			assert.ok(d.propensity >= 0.05 / arms.length - 1e-9 && d.propensity <= 1 + 1e-9);
		}
		assert.ok(bestHits / N > 0.7, `TS should mostly play the best arm (got ${bestHits}/${N})`);
	});

	test('a cold policy (flat posteriors) explores broadly, not a fixed arm', () => {
		let seed = 999;
		const rng = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const seen = new Set<number>();
		for (let i = 0; i < 200; i++) {
			seen.add(selectEpisodeArm(POLICY_PRIORS, rng).armIndex);
		}
		assert.ok(seen.size >= 5, `cold TS explores many arms (saw ${seen.size})`);
	});

	test('exploration decays with ledger evidence but never below the floor', () => {
		const policy: EpisodePolicy = { ...POLICY_PRIORS, episodes_seen: 0 };
		const cold = effectiveEpsilon(policy, 8);
		const warm = effectiveEpsilon({ ...policy, episodes_seen: 400 }, 8);
		const converged = effectiveEpsilon({ ...policy, episodes_seen: 1_000_000 }, 8);
		assert.strictEqual(cold, policy.epsilon0, 'cold system explores at the ceiling');
		assert.ok(warm < cold, 'evidence reduces exploration');
		assert.strictEqual(converged, policy.epsilon_min, 'never stops exploring entirely');
	});

	test('policy file is honored when valid and rejected wholesale when not', () => {
		const previous = process.env.VINV_HOME;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-episode-policy-'));
		try {
			process.env.VINV_HOME = home;
			// No file → priors.
			const defaults = loadEpisodePolicy();
			assert.strictEqual(defaults.attempt_budget, POLICY_PRIORS.attempt_budget);
			// Valid learned policy is honored.
			fs.writeFileSync(
				path.join(home, 'episode-policy.json'),
				JSON.stringify({ ...POLICY_PRIORS, attempt_budget: 5, preferred_arm: 0, episodes_seen: 12 }),
			);
			const learned = loadEpisodePolicy();
			assert.strictEqual(learned.attempt_budget, 5);
			assert.strictEqual(learned.preferred_arm, 0);
			assert.strictEqual(learned.episodes_seen, 12);
			// Out-of-range values reject the whole file (and log the invalidation).
			fs.writeFileSync(
				path.join(home, 'episode-policy.json'),
				JSON.stringify({ ...POLICY_PRIORS, epsilon0: 0.9, attempt_budget: 100, preferred_arm: 99 }),
			);
			const rejected = loadEpisodePolicy();
			assert.strictEqual(rejected.attempt_budget, POLICY_PRIORS.attempt_budget);
			const ledger = fs.readFileSync(path.join(home, 'telemetry', 'episodes.jsonl'), 'utf8');
			assert.ok(ledger.includes('policy_invalidated'));
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previous;
			}
		}
	});

	test('the loop LEARNS: Thompson selection + ledger update converges to the best arm', function () {
		// 60 episodes, each of which LOADS the policy, appends two ledger events
		// and rewrites the posterior — around 300 synchronous filesystem calls.
		// That is inherent to the thing being tested (the ledger is the mechanism,
		// so stubbing it would test nothing), and it is comfortably past mocha's
		// 2s default on Windows, where each call carries the filter driver's
		// overhead. A slow test is not a hanging one, and it was being reported as
		// a hang.
		this.timeout(60_000);
		// The value-prop test — the old Bernstein-promotion policy never moved
		// from its hand-coded prior in realistic use; this proves TS converges.
		const previous = process.env.VINV_HOME;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-converge-'));
		try {
			process.env.VINV_HOME = home;
			const BEST = 5;
			const pBest = 0.8;
			const pOther = 0.2;
			let s = 20260717 >>> 0;
			const rng = (): number => {
				s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
				return s / 0x7fffffff;
			};
			const EPISODES = 60;
			const bestPlays: number[] = [];
			for (let e = 0; e < EPISODES; e++) {
				const policy = loadEpisodePolicy();
				const d = selectEpisodeArm(policy, rng);
				bestPlays.push(d.armIndex === BEST ? 1 : 0);
				const verified = rng() < (d.armIndex === BEST ? pBest : pOther);
				const id = `c${e}`;
				appendEpisodeEvent({
					type: 'episode_start',
					ts: new Date(0).toISOString(),
					episode_id: id,
					arm_index: d.armIndex,
					arm: d.arm,
					propensity: d.propensity,
				});
				appendEpisodeEvent({
					type: 'episode_end',
					ts: new Date(0).toISOString(),
					episode_id: id,
					verified,
					aborted: false,
					objective: true,
					attempts: 1,
					reward: verified ? 1 : 0,
				});
				maybeUpdateEpisodePolicy();
			}
			const finalPolicy = loadEpisodePolicy();
			const posts = finalPolicy.arm_posteriors!;
			const mean = (i: number): number => posts[i].alpha / (posts[i].alpha + posts[i].beta);
			// 1. The best arm has the highest posterior mean BY A MARGIN over the
			// runner-up (margin-based rather than a brittle exact arm-index equal,
			// so the stochastic trajectory through transcendentals stays robust
			// across libm implementations — review Finding E).
			const bestMean = mean(BEST);
			const runnerUp = Math.max(
				...posts.map((_, i) => i).filter((i) => i !== BEST).map(mean),
			);
			assert.ok(
				bestMean > runnerUp + 0.15,
				`best arm dominates by margin (${bestMean.toFixed(2)} vs ${runnerUp.toFixed(2)})`,
			);
			assert.strictEqual(finalPolicy.preferred_arm, BEST, 'greedy arm = argmax posterior');
			// 2. The posterior recovered the true rate (~0.8) for the best arm.
			assert.ok(bestMean > 0.6, `best-arm posterior recovered a high rate (${bestMean.toFixed(2)})`);
			// 3. Exploitation increased: the best arm is played more in the 2nd half.
			const half = EPISODES / 2;
			const firstHalf = bestPlays.slice(0, half).reduce((a, b) => a + b, 0) / half;
			const secondHalf = bestPlays.slice(half).reduce((a, b) => a + b, 0) / half;
			assert.ok(
				secondHalf > firstHalf,
				`best-arm play-rate rises as it learns (${firstHalf.toFixed(2)} → ${secondHalf.toFixed(2)})`,
			);
		} finally {
			if (previous === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previous;
			}
		}
	});

	test('episode events append to the durable ledger', () => {
		const previous = process.env.VINV_HOME;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-episode-ledger-'));
		try {
			process.env.VINV_HOME = home;
			appendEpisodeEvent({ type: 'episode_start', ts: new Date().toISOString(), episode_id: 'e1' });
			appendEpisodeEvent({ type: 'episode_end', ts: new Date().toISOString(), episode_id: 'e1', reward: 1 });
			const lines = fs
				.readFileSync(path.join(home, 'telemetry', 'episodes.jsonl'), 'utf8')
				.trim()
				.split('\n');
			assert.strictEqual(lines.length, 2);
			assert.strictEqual((JSON.parse(lines[0]) as { type: string }).type, 'episode_start');
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previous;
			}
		}
	});

	test('reward discounts extra attempts, punishes aborts, and treats missing outcomes as neutral', () => {
		assert.strictEqual(episodeReward(true, 1, 3, false), 1);
		assert.ok(episodeReward(true, 2, 3, false) < 1);
		assert.ok(episodeReward(true, 2, 3, false) > 0);
		assert.strictEqual(episodeReward(false, 3, 3, true), -1);
		assert.strictEqual(episodeReward(false, 3, 3, false), 0);
	});
});

suite('Episode policy updater (credit attribution + promotion)', () => {
	function episodesFor(counts: Array<{ arm: number; rewards: number[] }>): CompletedEpisode[] {
		const out: CompletedEpisode[] = [];
		for (const { arm, rewards } of counts) {
			for (const reward of rewards) {
				out.push({ armIndex: arm, propensity: 0.5, reward, attempts: 1, verified: reward > 0, objective: true });
			}
		}
		return out;
	}

	test('completed episodes join start and end events across interleaved ledger lines', () => {
		const previous = process.env.VINV_HOME;
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-updater-ledger-'));
		try {
			process.env.VINV_HOME = home;
			appendEpisodeEvent({
				type: 'episode_start', ts: 't', episode_id: 'a', arm_index: 2, propensity: 0.4,
			});
			appendEpisodeEvent({
				type: 'episode_start', ts: 't', episode_id: 'b', arm_index: 5, propensity: 0.9,
			});
			appendEpisodeEvent({
				type: 'episode_end', ts: 't', episode_id: 'b', reward: 1, attempts: 1, verified: true,
			});
			appendEpisodeEvent({
				type: 'episode_end', ts: 't', episode_id: 'a', reward: -1, attempts: 3, verified: false,
			});
			// A dangling start (no end) is ignored.
			appendEpisodeEvent({
				type: 'episode_start', ts: 't', episode_id: 'c', arm_index: 0, propensity: 0.4,
			});
			const episodes = readCompletedEpisodes();
			assert.strictEqual(episodes.length, 2);
			assert.deepStrictEqual(
				episodes.map((e) => e.armIndex).sort((x, y) => x - y),
				[2, 5],
			);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.VINV_HOME;
			} else {
				process.env.VINV_HOME = previous;
			}
		}
	});

	test('logged arm values re-map onto an evolved grid; unmappable arms are excluded', () => {
		const levels = POLICY_PRIORS.arm_levels;
		// A legacy arm whose values sit on the current grid maps to its coalition.
		assert.strictEqual(
			armIndexForValues({ slice_depth: 2, include_runtime: true, snippet_chars: 800 }, levels),
			3,
		);
		// Values off the grid are unmappable — excluded, never misattributed.
		assert.strictEqual(
			armIndexForValues({ slice_depth: 7, include_runtime: true, snippet_chars: 800 }, levels),
			null,
		);
	});

	test('per-arm stats, shrinkage and the Bernstein bound behave as advertised', () => {
		const episodes = episodesFor([
			{ arm: 0, rewards: [1, 1, 0, 1] },
			{ arm: 1, rewards: [1] },
		]);
		const stats = perArmStats(episodes, 8);
		assert.strictEqual(stats[0].n, 4);
		assert.ok(Math.abs(stats[0].mean - 0.75) < 1e-12);
		assert.strictEqual(stats[1].n, 1);
		// Shrinkage pulls a one-sample arm toward the global mean.
		const globalMean = 4 / 5;
		const shrunk1 = shrunkMean(stats[1], globalMean, 2);
		assert.ok(shrunk1 < 1 && shrunk1 > globalMean - 1e-12);
		// The LCB is below the mean, tightens with n, and is -inf with no data.
		assert.ok(bernsteinLcb(stats[0], 0.1) < stats[0].mean);
		assert.strictEqual(bernsteinLcb(stats[7], 0.1), Number.NEGATIVE_INFINITY);
		const many = perArmStats(
			episodesFor([{ arm: 0, rewards: new Array<number>(200).fill(1) }]),
			8,
		);
		assert.ok(bernsteinLcb(many[0], 0.1) > bernsteinLcb(stats[0], 0.1));
	});

	test('Shapley attribution over the factorial grid is exact and efficient', () => {
		// Construct an additive value function: v = 0.5·runtime + 0.2·depth.
		// Shapley must recover the coefficients exactly, and snippet gets 0.
		const values = new Array<number>(8).fill(0).map((_, i) => {
			const levels = armLevels(i);
			return 0.2 * levels.slice_depth + 0.5 * levels.include_runtime;
		});
		const phi = shapleyAttribution(values);
		assert.ok(Math.abs(phi.slice_depth - 0.2) < 1e-12);
		assert.ok(Math.abs(phi.include_runtime - 0.5) < 1e-12);
		assert.ok(Math.abs(phi.snippet_chars - 0) < 1e-12);
		// Efficiency: contributions sum to v(all) - v(none).
		const sum = phi.slice_depth + phi.include_runtime + phi.snippet_chars;
		assert.ok(Math.abs(sum - (values[7] - values[0])) < 1e-12);
	});

	test('TS posteriors move the greedy arm toward the higher verified-fix rate', () => {
		const current: EpisodePolicy = { ...POLICY_PRIORS, preferred_arm: 0 };
		// Arm 3 verifies, arm 0 fails: greedy arm becomes 3, posteriors reflect it.
		const dense = episodesFor([
			{ arm: 0, rewards: new Array<number>(10).fill(0) },
			{ arm: 3, rewards: new Array<number>(30).fill(1) },
		]);
		const promoted = computeUpdatedPolicy(current, dense);
		assert.strictEqual(promoted.preferred_arm, 3, 'greedy = argmax posterior mean');
		assert.ok(promoted.arm_posteriors, 'posteriors persisted for selection');
		// Beta(1+30, 1+0) for arm 3 vs Beta(1, 1+10) for arm 0.
		assert.strictEqual(promoted.arm_posteriors![3].alpha, 31);
		assert.strictEqual(promoted.arm_posteriors![0].beta, 11);
		assert.strictEqual(promoted.episodes_seen, 40);
		assert.ok(promoted.attribution, 'attribution report is always computed');

		// A sparse arm cannot dominate a well-sampled one on a lucky streak —
		// the Beta(1,1) prior shrinks it (this is the natural TS regularizer).
		const sparse = episodesFor([
			{ arm: 0, rewards: new Array<number>(40).fill(1) }, // 40 wins → mean ~0.976
			{ arm: 3, rewards: [1, 1] }, // 2 wins → mean 0.75
		]);
		assert.strictEqual(computeUpdatedPolicy(current, sparse).preferred_arm, 0);

		// Aborted / human-adjudicated (non-objective) episodes do NOT train arms.
		// Arm 2 carries 5 objective successes, not 3, so it clears the now-enforced
		// `min_promotion_n` gate: this case is about the OBJECTIVE FILTER, and
		// `preferred_arm` is only its observable. (The gate itself — promotion needs
		// min_promotion_n observations AND a promotion_delta margin — has its own
		// test in rewardAndOpe.test.ts. Before the gate was wired up, 3 sufficed
		// here, and so did 1, which is exactly the defect it closes.)
		const withNonObjective: CompletedEpisode[] = [
			...episodesFor([{ arm: 2, rewards: [1, 1, 1, 1, 1] }]),
			{ armIndex: 5, propensity: 0.5, reward: -1, attempts: 1, verified: false, objective: false },
			{ armIndex: 5, propensity: 0.5, reward: 1, attempts: 1, verified: true, objective: false },
		];
		const pol = computeUpdatedPolicy(current, withNonObjective);
		assert.strictEqual(pol.arm_posteriors![5].alpha, 1, 'non-objective episode ignored (alpha stays prior)');
		assert.strictEqual(pol.arm_posteriors![5].beta, 1, 'non-objective episode ignored (beta stays prior)');
		assert.strictEqual(pol.preferred_arm, 2, 'only objective arm 2 learned');
		// Attempt budget: 90th percentile of attempts-to-success plus one
		// attempt of optimism margin (without it the budget ratchets down and
		// can never observe the evidence needed to rise again).
		const attempts: CompletedEpisode[] = [1, 1, 1, 1, 1, 1, 1, 1, 2, 4].map((a) => ({
			armIndex: 0, propensity: 1, reward: 1, attempts: a, verified: true, objective: true,
		}));
		const budget = computeUpdatedPolicy({ ...current, attempt_quantile: 0.9 }, attempts);
		assert.strictEqual(budget.attempt_budget, 3, 'q90 of [1×8,2,4] is 2, +1 margin');
		assert.strictEqual(nearestRankQuantile([1, 1, 1, 1, 1, 1, 1, 1, 2, 4], 1), 4);
		// The margin is capped by the hard ceiling.
		const capped = computeUpdatedPolicy(
			{ ...current, attempt_quantile: 1, attempt_budget_max: 4 },
			attempts,
		);
		assert.strictEqual(capped.attempt_budget, 4, 'ceiling binds: min(4, 4+1)');
	});
});

suite('Graph enhancement agents (adjudication + tag enrichment)', () => {
	test('adjudication replies are validated against the candidate contract', () => {
		const ids = new Set(['a.py:1-2:f', 'b.py:1-2:f']);
		assert.strictEqual(
			parseAdjudication('{"dst_id": "a.py:1-2:f"}', ids).dstId,
			'a.py:1-2:f',
		);
		assert.strictEqual(
			parseAdjudication('```json\n{"dst_id": null, "reason": "twins"}\n```', ids).dstId,
			null,
		);
		assert.throws(() => parseAdjudication('not json', ids));
		assert.throws(() => parseAdjudication('{"dst_id": "invented.py:9-9:g"}', ids));
		assert.throws(() => parseAdjudication('{"answer": "a.py:1-2:f"}', ids));
	});

	test('a contract violation is fed back verbatim and the retry corrects; exhaustion abstains', async () => {
		const record: PendingEdge = {
			src_id: 's.py:1-5:caller',
			src_file: 's.py',
			src_name: 'caller',
			name: 'f',
			candidates: [
				{ id: 'a.py:1-2:f', file: 'a.py', kind: 'function', summary: 'does f' },
				{ id: 'b.py:1-2:f', file: 'b.py', kind: 'function', summary: 'does f too' },
			],
		};
		// First reply violates the contract; the retry must see the rejection.
		const transcripts: string[][] = [];
		const replies = ['{"dst_id": "made-up"}', '{"dst_id": "a.py:1-2:f"}'];
		const chat = (messages: Array<{ role: string; content: string }>): Promise<string> => {
			transcripts.push(messages.map((m) => m.content));
			return Promise.resolve(replies.shift() ?? '{"dst_id": null, "reason": "out"}');
		};
		const dst = await adjudicateOne(record, chat);
		assert.strictEqual(dst, 'a.py:1-2:f');
		assert.strictEqual(transcripts.length, 2);
		assert.ok(
			transcripts[1].some((c) => c.includes('That reply was rejected')),
			'the rejection reason is in the retry conversation',
		);
		// A model that never conforms abstains — it never guesses.
		const stubborn = await adjudicateOne(record, () => Promise.resolve('nope'));
		assert.strictEqual(stubborn, null);
	});

	test('pending edges read highest-rank caller first and skip already-adjudicated ones', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-enhancer-'));
		try {
			fs.writeFileSync(
				path.join(dir, 'chunks.jsonl'),
				[
					JSON.stringify({ id: 'low.py:1-2:l', rank: 0.1 }),
					JSON.stringify({ id: 'high.py:1-2:h', rank: 0.9 }),
				].join('\n'),
			);
			const pending = (src: string, name: string) =>
				JSON.stringify({
					src_id: src, src_file: src.split(':')[0], src_name: 'x', name,
					candidates: [{ id: 'c.py:1-2:c', file: 'c.py', kind: 'function', summary: '' }],
				});
			fs.writeFileSync(
				path.join(dir, 'pending_edges.jsonl'),
				[pending('low.py:1-2:l', 'c'), pending('high.py:1-2:h', 'c'), 'garbage'].join('\n'),
			);
			const ordered = readPendingEdges(dir);
			assert.strictEqual(ordered.length, 2);
			assert.strictEqual(ordered[0].src_id, 'high.py:1-2:h', 'rank orders the queue');
			fs.writeFileSync(
				path.join(dir, 'edge_overrides.jsonl'),
				JSON.stringify({ src_id: 'high.py:1-2:h', dst_id: 'c.py:1-2:c', name: 'c' }) + '\n',
			);
			const done = readAdjudicated(dir);
			assert.ok(done.has('high.py:1-2:h\u0000c'));
			assert.strictEqual(ordered.filter((r) => !done.has(`${r.src_id}\u0000${r.name}`)).length, 1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('tag replies are validated and enrichment merges instead of clobbering', async () => {
		const ids = new Set(['a.py:1-2:f']);
		assert.deepStrictEqual(
			[...parseTagReply('{"tags": {"a.py:1-2:f": ["Auth", "session "]}}', ids).entries()],
			[['a.py:1-2:f', ['auth', 'session']]],
		);
		assert.throws(() => parseTagReply('{"tags": {"unknown": ["x"]}}', ids));
		assert.throws(() => parseTagReply('{"tags": []}', ids));

		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-tags-ws-'));
		try {
			const storeDir = path.join(ws, '.vinv', 'index');
			fs.mkdirSync(storeDir, { recursive: true });
			fs.writeFileSync(
				path.join(storeDir, 'tag_overrides.jsonl'),
				JSON.stringify({ id: 'a.py:1-2:f', tags: ['legacy'] }) + '\n',
			);
			const hits: IndexHit[] = [
				{
					score: 1, file: 'a.py', name: 'f', kind: 'function', lang: 'python',
					lines: [1, 2], rank: 0.5, summary: 'does f', snippet: '',
				},
			];
			const wrote = await enrichTagsFromFeedback(
				ws,
				'how does auth work?',
				hits,
				() => Promise.resolve('{"tags": {"a.py:1-2:f": ["auth"]}}'),
			);
			assert.strictEqual(wrote, 1);
			const lines = fs
				.readFileSync(path.join(storeDir, 'tag_overrides.jsonl'), 'utf8')
				.trim()
				.split('\n');
			const last = JSON.parse(lines[lines.length - 1]) as { id: string; tags: string[] };
			assert.deepStrictEqual(last.tags, ['legacy', 'auth'], 'merged, not clobbered');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});

suite('Episode verification gate (service replay)', () => {
	function seedWorkspace(command: string, port: number | null): string {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-replay-'));
		fs.mkdirSync(path.join(ws, '.vinv', 'start_commands'), { recursive: true });
		fs.writeFileSync(
			path.join(ws, '.vinv', 'start_commands', 'svc.json'),
			JSON.stringify({ verified: true, commands: [{ command }] }),
		);
		fs.writeFileSync(
			path.join(ws, '.vinv', 'services.json'),
			JSON.stringify({ services: [{ name: 'svc', port }] }),
		);
		return ws;
	}

	test('a serving foreground process passes on port evidence', async function () {
		if (process.platform === 'win32') {
			this.skip(); // the replay gate shells through /bin/bash
		}
		this.timeout(30_000);
		const port = 20000 + Math.floor(Math.random() * 20000);
		const nodeBin = JSON.stringify(process.execPath);
		const script = `${nodeBin} -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port})"`;
		const ws = seedWorkspace(script, port);
		try {
			const result = await verifyServiceReplay(ws, 'svc');
			assert.strictEqual(result.verdict, 'pass', result.reason);
			assert.ok(result.reason.includes(String(port)));
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('a crashing start command fails with the exit evidence', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		this.timeout(30_000);
		const ws = seedWorkspace('echo boom >&2; exit 3', 12345);
		try {
			const result = await verifyServiceReplay(ws, 'svc');
			assert.strictEqual(result.verdict, 'fail');
			assert.ok(result.reason.includes('exited with code 3'), result.reason);
			assert.ok((result.outputTail ?? '').includes('boom'), 'stderr captured as evidence');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('a missing verified record fails closed', async () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-replay-none-'));
		try {
			const result = await verifyServiceReplay(ws, 'svc');
			assert.strictEqual(result.verdict, 'fail');
			assert.ok(result.reason.includes('no verified start command'));
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});

suite('Session state (goal + trajectory across episodes)', () => {
	function tempWs(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-session-'));
	}

	test('fresh workspace yields the 5-episode default and no goal', () => {
		const ws = tempWs();
		try {
			const s = loadSession(ws);
			assert.strictEqual(s.episode_budget, DEFAULT_EPISODE_BUDGET);
			assert.strictEqual(DEFAULT_EPISODE_BUDGET, 5);
			assert.strictEqual(s.goal, '');
			assert.strictEqual(s.history.length, 0);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('goal change resets the trajectory counter; same goal does not', () => {
		const ws = tempWs();
		try {
			setGoal(ws, 'stabilize services');
			recordEpisodeOutcome(ws, {
				episode_id: 'e1',
				ts: 't',
				title: 'fix api',
				arm_index: 0,
				attempts: 2,
				verified: false,
				aborted: false,
				reward: 0.1,
				evidence: 'port never opened',
			});
			assert.strictEqual(loadSession(ws).episodes_used, 1);
			setGoal(ws, 'stabilize services');
			assert.strictEqual(loadSession(ws).episodes_used, 1, 'unchanged goal keeps trajectory');
			setGoal(ws, 'a different goal');
			assert.strictEqual(loadSession(ws).episodes_used, 0, 'new goal resets trajectory');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('budget is validated 1..20; invalid values are ignored', () => {
		const ws = tempWs();
		try {
			assert.strictEqual(setEpisodeBudget(ws, 8).episode_budget, 8);
			assert.strictEqual(setEpisodeBudget(ws, 0).episode_budget, 8);
			assert.strictEqual(setEpisodeBudget(ws, 99).episode_budget, 8);
			assert.strictEqual(setEpisodeBudget(ws, 2.5).episode_budget, 8);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('reset archives the old session and starts clean', () => {
		const ws = tempWs();
		try {
			setGoal(ws, 'stabilize services');
			setEpisodeBudget(ws, 9);
			recordEpisodeOutcome(ws, {
				episode_id: 'e1',
				ts: 't',
				title: 'fix api',
				arm_index: 0,
				attempts: 1,
				verified: true,
				aborted: false,
				reward: 0.9,
				evidence: 'replay passed',
			});
			const fresh = resetSession(ws);
			assert.strictEqual(fresh.goal, '');
			assert.strictEqual(fresh.episode_budget, DEFAULT_EPISODE_BUDGET);
			assert.strictEqual(fresh.episodes_used, 0);
			assert.strictEqual(fresh.history.length, 0);
			assert.strictEqual(loadSession(ws).history.length, 0, 'reset persists');
			const archives = fs.readdirSync(path.join(ws, '.vinv', 'session-archive'));
			assert.strictEqual(archives.length, 1, 'old session archived, not destroyed');
			const archived = JSON.parse(
				fs.readFileSync(path.join(ws, '.vinv', 'session-archive', archives[0]), 'utf8'),
			);
			assert.strictEqual(archived.goal, 'stabilize services');
			assert.strictEqual(archived.history.length, 1);
			// A second reset of an already-empty session adds no archive.
			resetSession(ws);
			assert.strictEqual(
				fs.readdirSync(path.join(ws, '.vinv', 'session-archive')).length,
				1,
				'empty session skips the archive',
			);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('new session parks the old one; switching back restores it whole', () => {
		const ws = tempWs();
		try {
			setGoal(ws, 'first goal');
			appendTranscriptEntry(ws, {
				kind: 'qa',
				ts: 't1',
				question: 'how does auth work?',
				answer: 'via middleware',
				mode: 'cloud',
				decisionId: 'd1',
				citations: [{ file: 'auth.ts', line: 3, name: 'auth', kind: 'static' }],
			});
			const firstId = loadSession(ws).id;
			assert.ok(firstId, 'a written session has an id');

			const fresh = startFreshSession(ws);
			assert.strictEqual(fresh.goal, '');
			assert.notStrictEqual(fresh.id, firstId);

			const listed = listSessions(ws);
			assert.strictEqual(listed.length, 2, 'active + one parked');
			assert.ok(listed[0].active, 'active session listed first');
			const parked = listed.find((s) => !s.active);
			assert.ok(parked);
			assert.strictEqual(parked.id, firstId);
			assert.strictEqual(parked.title, 'first goal', 'goal names the session');
			assert.strictEqual(parked.questions, 1);

			const back = switchToSession(ws, firstId as string);
			assert.ok(back, 'switch resolves the parked session');
			assert.strictEqual(back?.goal, 'first goal');
			assert.strictEqual(back?.transcript?.length, 1, 'transcript survives the round-trip');
			assert.strictEqual(loadSession(ws).goal, 'first goal', 'switch persists as active');
			// Switching away from the empty fresh session left no empty shell.
			assert.strictEqual(listSessions(ws).length, 1, 'no parked sessions remain');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('session titles fall back from goal to first question', () => {
		const ws = tempWs();
		try {
			appendTranscriptEntry(ws, {
				kind: 'qa',
				ts: 't1',
				question: 'where is the retry loop?',
				answer: 'in answer.ts',
				mode: 'cloud',
				decisionId: 'd1',
				citations: [],
			});
			assert.strictEqual(sessionTitle(loadSession(ws)), 'where is the retry loop?');
			setGoal(ws, 'stabilize retries');
			assert.strictEqual(sessionTitle(loadSession(ws)), 'stabilize retries', 'goal wins');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('switching to an unknown or unsafe id changes nothing', () => {
		const ws = tempWs();
		try {
			setGoal(ws, 'keep me');
			assert.strictEqual(switchToSession(ws, 'no-such-session'), undefined);
			assert.strictEqual(switchToSession(ws, '..\\..\\evil'), undefined);
			assert.strictEqual(loadSession(ws).goal, 'keep me', 'active session untouched');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('deleting a parked session archives it, never destroys it', () => {
		const ws = tempWs();
		try {
			setGoal(ws, 'old goal');
			const oldId = (() => {
				startFreshSession(ws);
				return listSessions(ws).find((s) => !s.active)?.id;
			})();
			assert.ok(oldId);
			assert.strictEqual(deleteParkedSession(ws, oldId as string), true);
			assert.strictEqual(listSessions(ws).length, 1, 'gone from the switcher');
			const archives = fs.readdirSync(path.join(ws, '.vinv', 'session-archive'));
			assert.strictEqual(archives.length, 1, 'moved to the archive');
			const archived = JSON.parse(
				fs.readFileSync(path.join(ws, '.vinv', 'session-archive', archives[0]), 'utf8'),
			);
			assert.strictEqual(archived.goal, 'old goal');
			assert.strictEqual(deleteParkedSession(ws, oldId as string), false, 'second delete is a no-op');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('background-bound writes land in their own session after a switch', () => {
		const ws = tempWs();
		try {
			setGoal(ws, 'session A');
			const aId = loadSession(ws).id as string;
			startFreshSession(ws);
			setGoal(ws, 'session B');
			// An episode dispatched under A finishes while B is active: outcome
			// and transcript note bind to A and never move the active pointer.
			recordEpisodeOutcome(
				ws,
				{
					episode_id: 'e-bg',
					ts: 't',
					title: 'background fix',
					arm_index: 0,
					attempts: 1,
					verified: true,
					aborted: false,
					reward: 0.8,
					evidence: 'replay passed',
				},
				aId,
			);
			appendTranscriptEntry(ws, { kind: 'notice', ts: 't', text: 'episode verified' }, aId);
			const active = loadSession(ws);
			assert.strictEqual(active.goal, 'session B', 'pointer did not move');
			assert.strictEqual(active.history.length, 0, 'outcome did not leak into B');
			const a = switchToSession(ws, aId);
			assert.strictEqual(a?.history.length, 1, 'outcome recorded in A');
			assert.strictEqual(a?.episodes_used, 1, 'trajectory advanced in A');
			assert.strictEqual(a?.transcript?.length, 1, 'transcript note recorded in A');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('legacy session.json and parked files migrate into the new store', () => {
		const ws = tempWs();
		try {
			// The pre-multi-session layout: one active file, one parked file.
			fs.mkdirSync(path.join(ws, '.vinv', 'sessions'), { recursive: true });
			const legacyActive = {
				version: 1,
				goal: 'legacy active goal',
				episode_budget: 5,
				episodes_used: 1,
				history: [],
				updated_at: 't1',
			};
			const legacyParked = { ...legacyActive, goal: 'legacy parked goal', episodes_used: 0 };
			fs.writeFileSync(
				path.join(ws, '.vinv', 'session.json'),
				JSON.stringify(legacyActive),
				'utf8',
			);
			fs.writeFileSync(
				path.join(ws, '.vinv', 'sessions', 'old-parked.json'),
				JSON.stringify(legacyParked),
				'utf8',
			);
			const active = loadSession(ws);
			assert.strictEqual(active.goal, 'legacy active goal', 'legacy active becomes active');
			assert.ok(active.id, 'migrated session gained an id');
			assert.ok(!fs.existsSync(path.join(ws, '.vinv', 'session.json')), 'legacy file consumed');
			assert.ok(!fs.existsSync(path.join(ws, '.vinv', 'sessions')), 'legacy dir consumed');
			const listed = listSessions(ws);
			assert.strictEqual(listed.length, 2, 'both sessions present after migration');
			const parked = listed.find((s) => !s.active);
			assert.strictEqual(parked?.id, 'old-parked', 'parked file keeps its filename id');
			assert.strictEqual(switchToSession(ws, 'old-parked')?.goal, 'legacy parked goal');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('harness directives accept natural phrasing addressed to vinv', () => {
		const out = parseHarnessDirectives(
			[
				'working on it...',
				'vinv: set episode budget to 7',
				'Vinv goal: make checkout resilient to empty carts',
				'vinv episodes 999',
				'not vinv: goal sneaky prose that merely mentions vinv mid-sentence',
			].join('\n'),
		);
		assert.strictEqual(out.episodeBudget, 7, 'natural budget phrasing parses');
		assert.strictEqual(out.goal, 'make checkout resilient to empty carts');
	});

	test('directive phrasing variants all parse; unaddressed prose never does', () => {
		assert.strictEqual(parseHarnessDirectives('VINV: SET_EPISODE_BUDGET 7').episodeBudget, 7);
		assert.strictEqual(parseHarnessDirectives('/vinv budget 12').episodeBudget, 12);
		assert.strictEqual(parseHarnessDirectives('\\vinv episodes 3').episodeBudget, 3);
		assert.strictEqual(parseHarnessDirectives('vinv, budget: 5').episodeBudget, 5);
		assert.strictEqual(parseHarnessDirectives('vinv set_goal ship it').goal, 'ship it');
		const noise = parseHarnessDirectives(
			'the vinv budget should maybe be 9 someday\nbudget 9\ngoal world domination',
		);
		assert.strictEqual(noise.episodeBudget, undefined, 'mid-sentence mention is not a directive');
		assert.strictEqual(noise.goal, undefined, 'unaddressed lines never change state');
	});

	test('dispute directives: the agent can contest the premise on the vinv channel', () => {
		assert.strictEqual(
			parseHarnessDirectives('vinv: no issue — the service starts fine locally').dispute,
			'the service starts fine locally',
		);
		assert.strictEqual(
			parseHarnessDirectives('vinv: wrong command the recorded port is stale').dispute,
			'the recorded port is stale',
		);
		assert.strictEqual(
			parseHarnessDirectives('VINV: DISPUTE').dispute,
			'the agent disputes the task premise',
			'bare dispute still registers with a default reason',
		);
		assert.strictEqual(
			parseHarnessDirectives('there is no issue with this really').dispute,
			undefined,
			'unaddressed prose never trips the circuit',
		);
	});

	test('trajectory digest lists every episode and reads the reward trend', () => {
		const ws = tempWs();
		try {
			setGoal(ws, 'green smoke tests');
			recordEpisodeOutcome(ws, {
				episode_id: 'e1',
				ts: 't1',
				title: 'first',
				arm_index: 0,
				attempts: 3,
				verified: false,
				aborted: false,
				reward: 0.1,
				evidence: 'timeout',
			});
			const s = recordEpisodeOutcome(ws, {
				episode_id: 'e2',
				ts: 't2',
				title: 'second',
				arm_index: 1,
				attempts: 1,
				verified: false,
				aborted: false,
				reward: 0.4,
				evidence: 'port opened then closed',
			});
			const digest = trajectoryDigest(s);
			assert.ok(digest.includes('episode 3 of 5'), digest);
			assert.ok(digest.includes('green smoke tests'));
			assert.ok(digest.includes('"first"') && digest.includes('"second"'));
			assert.ok(digest.includes('improving'), 'rising reward reads as improving');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('malformed session file falls back to a clean default', () => {
		const ws = tempWs();
		try {
			fs.mkdirSync(path.join(ws, '.vinv'), { recursive: true });
			fs.writeFileSync(path.join(ws, '.vinv', 'session.json'), '{"episode_budget": -3}');
			const s = loadSession(ws);
			assert.strictEqual(s.episode_budget, DEFAULT_EPISODE_BUDGET);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('trajectory report renders goal, scoreboard, disputes and rewards from recorded state', () => {
		const ws = tempWs();
		try {
			setGoal(ws, 'keep services green');
			recordEpisodeOutcome(ws, {
				episode_id: 'ep-a',
				ts: 't1',
				title: 'Fix service admin',
				arm_index: 2,
				attempts: 2,
				verified: true,
				aborted: false,
				reward: 0.85,
				evidence: 'replay passed, port accepts connections',
				pack_path: '.vinv/context/pack-ep-a.md',
			});
			recordEpisodeOutcome(ws, {
				episode_id: 'ep-b',
				ts: 't2',
				title: 'Fix bring-up of licensing',
				arm_index: 0,
				attempts: 3,
				verified: false,
				aborted: false,
				reward: -0.2,
				evidence: 'still failing after budget',
			});
			// Ledger events for the second episode: a dispute the judge escalated.
			const ledger = path.join(ws, 'episodes.jsonl');
			fs.writeFileSync(
				ledger,
				JSON.stringify({
					type: 'dispute',
					ts: 't2',
					episode_id: 'ep-b',
					dispute: 'no issue — module is a library',
					action: 'escalate',
					mutation: 'verify entrypoint exists',
				}) + '\n' + '{"torn json',
			);
			const events = readEpisodeEvents(ledger);
			assert.strictEqual(events.length, 1, 'torn tail line skipped, valid one kept');
			const report = composeTrajectoryReport(loadSession(ws), events);
			assert.ok(report.includes('keep services green'), 'goal shown');
			assert.ok(report.includes('1 verified fixed'), 'fixed count');
			assert.ok(report.includes('1 unresolved'), 'open count');
			assert.ok(report.includes('cumulative reward +0.65'), report);
			assert.ok(report.includes('pack-ep-a.md'), 'pack path cited');
			assert.ok(
				report.includes('no issue — module is a library'),
				'dispute surfaced on its episode',
			);
			assert.ok(report.includes('+0.85 → -0.20'), 'reward trajectory rendered');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

});

/**
 * A CROSS-SURFACE INVARIANT, not one report's content: no reward is ever printed
 * without saying what stood behind it.
 *
 * `reward` is renormalized over the rubric components that were AVAILABLE, and an
 * abort short-circuits scoring to a flat −1 whatever the cause. So the bare number
 * cannot distinguish a verified pass from an episode nothing could check, nor a
 * cancelled run from a proven regression — each pair prints the same magnitude.
 * This suite exists so the rule binds reward surfaces nobody has written yet,
 * rather than being buried in a test named for one digest.
 */
suite('reward reporting: every printed reward carries its provenance', () => {
	function tempWs(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-reward-'));
	}

	test('no reward line is rendered bare', () => {
		const ws = tempWs();
		try {
			recordEpisodeOutcome(ws, {
				episode_id: 'ep-verified',
				ts: 't1',
				title: 'Verified with executable evidence',
				arm_index: 0,
				attempts: 1,
				verified: true,
				aborted: false,
				reward: 0.9,
				verification_weight: 0.9,
				evidence: 'oracle + tests green',
			});
			recordEpisodeOutcome(ws, {
				episode_id: 'ep-unverified',
				ts: 't2',
				title: 'Nothing executable ran',
				arm_index: 1,
				attempts: 1,
				verified: false,
				aborted: false,
				reward: 1,
				verification_weight: 0,
				evidence: 'audit components only',
			});
			// Predates the field: UNKNOWN, which must not be asserted as a negative.
			recordEpisodeOutcome(ws, {
				episode_id: 'ep-legacy',
				ts: 't3',
				title: 'Recorded before the field existed',
				arm_index: 2,
				attempts: 1,
				verified: true,
				aborted: false,
				reward: 0.7,
				evidence: 'legacy record',
			});
			recordEpisodeOutcome(ws, {
				episode_id: 'ep-aborted',
				ts: 't4',
				title: 'Cancelled',
				arm_index: 3,
				attempts: 1,
				verified: false,
				aborted: true,
				reward: -1,
				evidence: 'harness run failed: cancelled',
			});
			const report = composeTrajectoryReport(loadSession(ws), []);
			const rewardLines = report.split('\n').filter((l) => l.includes('· reward '));
			assert.strictEqual(rewardLines.length, 4, 'every episode prints a reward line');
			for (const line of rewardLines) {
				assert.match(
					line,
					/(verification weight|UNVERIFIED|not recorded|fixed abort penalty)/,
					`a reward printed with no provenance qualifier: ${line}`,
				);
			}
			// Unknown and zero are DIFFERENT, and neither is "verified".
			assert.ok(
				rewardLines.some((l) => l.includes('not recorded')),
				'a pre-field record says its evidence is unknown, not that none ran',
			);
			assert.ok(
				rewardLines.some((l) => l.includes('UNVERIFIED')),
				'a zero-weight record says plainly that nothing executable ran',
			);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('aborted episodes are excluded from cumulative reward — and the exclusion is stated', () => {
		const ws = tempWs();
		try {
			recordEpisodeOutcome(ws, {
				episode_id: 'ep-ok',
				ts: 't1',
				title: 'A measured verdict',
				arm_index: 0,
				attempts: 1,
				verified: true,
				aborted: false,
				reward: 0.5,
				verification_weight: 0.9,
				evidence: 'oracle passed',
			});
			// An abort scores a flat −1 whatever the cause and never trains the
			// policy, so summing it into a figure a human reads as performance made
			// a cancelled run weigh as much as shipped-and-reverted code.
			recordEpisodeOutcome(ws, {
				episode_id: 'ep-abort',
				ts: 't2',
				title: 'Cancelled before any verdict',
				arm_index: 1,
				attempts: 1,
				verified: false,
				aborted: true,
				reward: -1,
				evidence: 'harness run failed: cancelled',
			});
			const report = composeTrajectoryReport(loadSession(ws), []);
			assert.ok(
				report.includes('cumulative reward +0.50 across 1 measured verdict(s)'),
				`the abort must not be summed into performance: ${report}`,
			);
			// Excluding silently would trade a wrong number for one that hides how
			// much it left out — the same defect wearing the opposite costume.
			assert.ok(
				report.includes('1 aborted episode(s) excluded'),
				'the exclusion has to be stated, not silent',
			);
			// A marked entry in the trend chain that is absent from the sum above
			// must carry its own legend, or the two figures silently disagree.
			assert.ok(report.includes('-1.00†'), 'aborts are marked in the trend chain');
			assert.ok(report.includes('`†` = aborted'), 'the marker is explained');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});

suite('Bring-up outcome classification (services view states)', () => {
	function writeRecord(dir: string, service: string, record: unknown): void {
		fs.mkdirSync(path.join(dir, '.vinv', 'start_commands'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.vinv', 'start_commands', `${service}.json`),
			JSON.stringify(record),
			'utf8',
		);
	}

	test('distinguishes unattempted / verified / library / failed', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-outcome-'));
		assert.deepStrictEqual(readBringupOutcome(dir, 'ghost'), { state: 'unattempted' });

		writeRecord(dir, 'web', { verified: true, commands: [{ command: 'run' }] });
		assert.strictEqual(readBringupOutcome(dir, 'web').state, 'verified');

		// The honest negative: agent proved there is nothing to run.
		writeRecord(dir, 'contracts', { verified: false, commands: [] });
		assert.strictEqual(readBringupOutcome(dir, 'contracts').state, 'library');

		writeRecord(dir, 'core', {
			verified: false,
			commands: [{ command: 'python -m core' }],
			failure_symptom: "ImportError: No module named core.__main__; 'core' is a package",
		});
		assert.strictEqual(readBringupOutcome(dir, 'core').state, 'library');

		// A genuine failure with a runnable command keeps nagging for setup.
		writeRecord(dir, 'api', {
			verified: false,
			commands: [{ command: 'uvicorn api:app' }],
			failure_symptom: 'port 8000 never accepted a connection within 90s',
		});
		assert.strictEqual(readBringupOutcome(dir, 'api').state, 'failed');
	});

	// The engine names this file by a slug, so a service whose name has spaces
	// or parens lands at `Admin_backend__Python_.json`. Reading it back under
	// the raw name reported a verified bring-up as never attempted.
	test('finds the record for a service name that slugs (spaces, parens)', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-outcome-slug-'));
		const service = 'Admin backend (Python)';
		fs.mkdirSync(path.join(dir, '.vinv', 'start_commands'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.vinv', 'start_commands', 'Admin_backend__Python_.json'),
			JSON.stringify({ verified: true, commands: [{ command: 'python -m uvicorn app' }] }),
			'utf8',
		);

		assert.strictEqual(readBringupOutcome(dir, service).state, 'verified');
		assert.strictEqual(isServiceStarted(dir, service), true);
		assert.strictEqual(readStartCommands(dir, service).length, 1);
	});
});

suite('Hotspot selection (Pareto head of traced time)', () => {
	test('selects by relative share, not absolute milliseconds', () => {
		const nodes = [0, 1, 2, 3].map((r) => makeNode(r));
		const overlay: Record<number, RuntimeOverlay> = {
			0: { executed: true, calls: 100, total_ms: 700, errors: 0, error_types: [], failures: [], current_errors: 0, latest_epoch: null },
			1: { executed: true, calls: 5, total_ms: 200, errors: 0, error_types: [], failures: [], current_errors: 0, latest_epoch: null },
			2: { executed: true, calls: 50, total_ms: 90, errors: 0, error_types: [], failures: [], current_errors: 0, latest_epoch: null },
			3: { executed: true, calls: 1, total_ms: 10, errors: 0, error_types: [], failures: [], current_errors: 0, latest_epoch: null },
		};
		const hot = selectHotspots(nodes, overlay, 0.8, 8);
		// 700ms alone is 70% (< 80% coverage) so the head is {0, 1}; row 2 would
		// push coverage past the target and is excluded.
		assert.deepStrictEqual(hot.map((h) => h.row), [0, 1]);
		assert.ok(Math.abs(hot[0].share - 0.7) < 1e-9);

		// The SAME distribution scaled down 1000× selects the same head — the
		// rule is relative to the app's own trace, never a fixed threshold.
		const scaled: Record<number, RuntimeOverlay> = Object.fromEntries(
			Object.entries(overlay).map(([r, rt]) => [r, { ...rt, total_ms: rt.total_ms / 1000 }]),
		);
		assert.deepStrictEqual(selectHotspots(nodes, scaled, 0.8, 8).map((h) => h.row), [0, 1]);
	});

	test('empty or zero-time traces select nothing; cap bounds the list', () => {
		const nodes = [0, 1, 2].map((r) => makeNode(r));
		assert.deepStrictEqual(selectHotspots(nodes, {}, 0.8, 8), []);
		const flat: Record<number, RuntimeOverlay> = Object.fromEntries(
			[0, 1, 2].map((r) => [r, { executed: true, calls: 1, total_ms: 100, errors: 0, error_types: [], failures: [], current_errors: 0, latest_epoch: null }]),
		);
		assert.strictEqual(selectHotspots(nodes, flat, 1, 2).length, 2);
	});

	test('error clusters carry seed rows and a content signature that dedupes exactly', () => {
		const nodes = [0, 1, 2].map((r) => makeNode(r));
		// Clusters are built from CURRENT errors (latest run) — lifetime-only
		// errors are retired history and must not cluster.
		const overlay: Record<number, RuntimeOverlay> = {
			0: { executed: true, calls: 9, total_ms: 40, errors: 3, error_types: ['KeyError'], failures: [], current_errors: 3, latest_epoch: null },
			1: { executed: true, calls: 2, total_ms: 10, errors: 0, error_types: [], failures: [], current_errors: 0, latest_epoch: null },
			2: { executed: true, calls: 5, total_ms: 20, errors: 1, error_types: ['ValueError'], failures: [], current_errors: 1, latest_epoch: null },
		};
		const { clusters, signature } = collectRuntimeErrorClusters(nodes, overlay);
		assert.deepStrictEqual(clusters.map((c) => c.row), [0, 2], 'sorted by error count, clean rows excluded');
		assert.ok(clusters[0].line.includes('KeyError') && clusters[0].line.includes('src/mod0.py'));
		// Same failure picture (different call counts) → same signature: no re-dispatch.
		const busier = {
			...overlay,
			0: { ...overlay[0], calls: 99, errors: 7 },
		};
		assert.strictEqual(collectRuntimeErrorClusters(nodes, busier).signature, signature);
		// A NEW error type re-arms the trigger.
		const newType = {
			...overlay,
			0: { ...overlay[0], error_types: ['KeyError', 'TimeoutError'], failures: [], current_errors: 0, latest_epoch: null },
		};
		assert.notStrictEqual(collectRuntimeErrorClusters(nodes, newType).signature, signature);
	});
});

suite('Stall breaker (Nash bargaining)', () => {
	test('deliberate 4xx HTTPException raises are NOT defects; real errors are', () => {
		// The live false-positive: 135 of 185 traced "errors" were handlers
		// correctly raising 4xx (delete_user 404/403, reset_password 400) —
		// clustered as defects, they handed the agent an unfixable goal.
		const fail = (error_type: string, error_message: string, count = 4) => ({
			error_type, error_message, error_stack: null, request_id: 'r',
			count, capture_epoch: null, superseded: null as null, contained: null, contained_by: null,
			caller_chain: [], args_schema: null, args_summary: null, duration_ms: 1,
		});
		const nodes = [0, 1, 2].map((r) => makeNode(r));
		const overlay: Record<number, RuntimeOverlay> = {
			// register_user: ONLY deliberate 4xx → must not cluster at all.
			0: { executed: true, calls: 20, total_ms: 40, errors: 18, error_types: ['fastapi.exceptions.HTTPException'],
				failures: [fail('fastapi.exceptions.HTTPException', '400: The user with this email already exists', 18)],
				current_errors: 18, latest_epoch: null },
			// create_user (private): real IntegrityError → clusters.
			1: { executed: true, calls: 6, total_ms: 10, errors: 4, error_types: ['sqlalchemy.exc.IntegrityError'],
				failures: [fail('sqlalchemy.exc.IntegrityError', '(psycopg.errors.UniqueViolation) duplicate key', 4)],
				current_errors: 4, latest_epoch: null },
			// mixed: a 404 rejection AND a 500-class HTTPException → clusters on the 5xx only.
			2: { executed: true, calls: 8, total_ms: 12, errors: 5, error_types: ['fastapi.exceptions.HTTPException'],
				failures: [
					fail('fastapi.exceptions.HTTPException', '404: User not found', 3),
					fail('fastapi.exceptions.HTTPException', '503: upstream unavailable', 2),
				], current_errors: 5, latest_epoch: null },
		};
		const { clusters } = collectRuntimeErrorClusters(nodes, overlay);
		assert.deepStrictEqual(clusters.map((c) => c.row), [1, 2], 'pure-4xx symbol excluded');
		assert.ok(clusters[0].line.includes('IntegrityError'));
		assert.ok(clusters[1].line.includes('2 error(s)'), 'only the 5xx failures counted');
		// The predicate itself: narrow on type AND parsed status.
		assert.strictEqual(isExpectedRejection('fastapi.exceptions.HTTPException', '404: nope'), true);
		assert.strictEqual(isExpectedRejection('fastapi.exceptions.HTTPException', '500: boom'), false);
		assert.strictEqual(isExpectedRejection('fastapi.exceptions.HTTPException', 'no status here'), false);
		assert.strictEqual(isExpectedRejection('sqlalchemy.exc.IntegrityError', '409: fake'), false);
		assert.strictEqual(isExpectedRejection('MyHTTPExceptionFactory', '404: x'), false);
	});

	test('exceptions a caller absorbed are NOT defects; escaping ones are', () => {
		// The second live false-positive, same class as the 4xx one above. The
		// embedder binds its port as a machine-wide single-instance lock, so a
		// second `serve` raises OSError(EADDRINUSE) in make_server and
		// _cmd_serve catches it and returns 0 (vinv_embedder/cli.py:91). The
		// capture recorded make_server exit=error at depth 2, _cmd_serve exit=ok
		// at depth 1, main exit=ok at depth 0 — handled control flow. It was
		// clustered as a defect and dispatched as a fix episode anyway; the
		// harness agent disputed the premise and the episode aborted at -1.00.
		const fail = (
			error_type: string,
			error_message: string,
			contained: boolean | null,
			count = 1,
		) => ({
			error_type, error_message, error_stack: null, request_id: 'r',
			count, capture_epoch: null, superseded: null as null, contained,
			contained_by: contained === true ? 'vinv_embedder.cli._cmd_serve' : null,
			caller_chain: ['vinv_embedder.cli._cmd_serve', 'vinv_embedder.cli.main'],
			args_schema: null, args_summary: null, duration_ms: 1,
		});
		const nodes = [0, 1, 2, 3].map((r) => makeNode(r));
		const overlay: Record<number, RuntimeOverlay> = {
			// make_server: raised, but _cmd_serve absorbed it → not a defect.
			0: { executed: true, calls: 1, total_ms: 1, errors: 1, error_types: ['OSError'],
				failures: [fail('OSError', '[Errno 48] Address already in use', true)],
				current_errors: 1, latest_epoch: null },
			// A genuinely escaping error → still a defect.
			1: { executed: true, calls: 3, total_ms: 5, errors: 2, error_types: ['ValueError'],
				failures: [fail('ValueError', 'bad input', false, 2)],
				current_errors: 2, latest_epoch: null },
			// Containment unknown (no ancestor exit observed) → stays a defect.
			2: { executed: true, calls: 2, total_ms: 3, errors: 1, error_types: ['KeyError'],
				failures: [fail('KeyError', 'missing', null)],
				current_errors: 1, latest_epoch: null },
			// Same identity seen both absorbed AND escaping → one escape makes it
			// a defect, so the merged verdict must be false, not true.
			3: { executed: true, calls: 4, total_ms: 6, errors: 2, error_types: ['TimeoutError'],
				failures: [fail('TimeoutError', 'timed out', false, 2)],
				current_errors: 2, latest_epoch: null },
		};
		const { clusters } = collectRuntimeErrorClusters(nodes, overlay);
		assert.deepStrictEqual(
			clusters.map((c) => c.row).sort((a, b) => a - b),
			[1, 2, 3],
			'handled-internally symbol excluded; escaping and unknown kept',
		);
		// The predicate: only an observed `true` counts as handled. Unknown must
		// never be read as handled — that would hide real failures.
		assert.strictEqual(isHandledInternally(true), true);
		assert.strictEqual(isHandledInternally(false), false);
		assert.strictEqual(isHandledInternally(null), false);
		assert.strictEqual(isHandledInternally(undefined), false);
	});

	test('the live stall-judge utilities escalate via the Nash rule', () => {
		// Verbatim from the stalled run's judge log: both stances preferred
		// escalation, so the Nash product for continue is 0 → the judgment
		// panel. The deadlock breaker DID work; the goal upstream was fake.
		const v = nashDecision({
			explorer_continue: 0.42, explorer_escalate: 0.58,
			auditor_continue: 0.18, auditor_escalate: 0.86,
			mutation: 'run clusters serially with PYTHONUNBUFFERED=1',
		});
		assert.strictEqual(v.action, 'escalate');
		assert.strictEqual(v.nash_continue, 0);
	});


	test('similarity is 1 for identical evidence and low for unrelated', () => {
		const a = 'replay failed: port 8080 never opened; ModuleNotFoundError: vinv_payment';
		assert.strictEqual(evidenceSimilarity(a, a), 1);
		assert.ok(evidenceSimilarity(a, 'lint passed, tests green, all good here') < 0.2);
	});

	test('similarity survives reordering (token-set, not prefix, comparison)', () => {
		const a = 'error connecting database timeout retry exceeded';
		const b = 'retry exceeded error timeout connecting database';
		assert.strictEqual(evidenceSimilarity(a, b), 1);
	});

	test('continue requires BOTH stances to gain over escalation', () => {
		// Both gain: Nash product positive → continue.
		assert.strictEqual(
			nashDecision({
				explorer_continue: 0.9,
				explorer_escalate: 0.2,
				auditor_continue: 0.6,
				auditor_escalate: 0.4,
				mutation: 'try the config path',
			}).action,
			'continue',
		);
		// Auditor loses: one factor ≤ 0 → escalate, however keen the explorer.
		assert.strictEqual(
			nashDecision({
				explorer_continue: 0.99,
				explorer_escalate: 0.1,
				auditor_continue: 0.3,
				auditor_escalate: 0.6,
				mutation: 'anything',
			}).action,
			'escalate',
		);
		// Indifference (no strict gain) also escalates — autonomy needs a
		// Pareto improvement over asking the human.
		assert.strictEqual(
			nashDecision({
				explorer_continue: 0.5,
				explorer_escalate: 0.5,
				auditor_continue: 0.5,
				auditor_escalate: 0.5,
				mutation: 'anything',
			}).action,
			'escalate',
		);
	});

	test('breakStall escalates on transport failure, throw, or contract miss', async () => {
		// Backend judge unavailable (old binary / missing) → null → escalate.
		assert.strictEqual((await breakStall('t', 'a', 'b', async () => null)).action, 'escalate');
		// Transport throw → escalate, never a crash.
		assert.strictEqual(
			(await breakStall('t', 'a', 'b', async () => {
				throw new Error('spawn failed');
			})).action,
			'escalate',
		);
		// Out-of-contract utilities → escalate (validation is asStallUtilities).
		assert.strictEqual(
			(await breakStall('t', 'a', 'b', async () => ({
				status: 'ok',
				explorer_continue: 1.5,
				explorer_escalate: 0,
				auditor_continue: 0.5,
				auditor_escalate: 0.3,
				mutation: 'x',
			}))).action,
			'escalate',
		);
	});

	test('breakStall applies the Nash-unanimity rule to a valid backend report', async () => {
		const verdict = await breakStall('t', 'ev-a', 'ev-b', async (payload) => {
			assert.strictEqual(payload.task, 't');
			assert.strictEqual(payload.evidence_a, 'ev-a');
			assert.strictEqual(payload.evidence_b, 'ev-b');
			return {
				status: 'ok',
				explorer_continue: 0.7,
				explorer_escalate: 0.2,
				auditor_continue: 0.5,
				auditor_escalate: 0.3,
				mutation: 'inspect the recorded start command env',
			};
		});
		assert.strictEqual(verdict.action, 'continue');
		assert.ok(verdict.mutation.includes('start command'));
	});
});

suite('Runtime analyses (memory trends + cache candidates)', () => {
	function writeTrace(ws: string, session: string, lines: string[], mtimeSec: number): void {
		const dir = path.join(ws, '.vinv', 'captures', session, 'svc');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'trace.jsonl');
		fs.writeFileSync(file, lines.join('\n'));
		fs.utimesSync(file, mtimeSec, mtimeSec);
	}
	const exit = (component: string, extra: Record<string, unknown> = {}): string =>
		JSON.stringify({ event: 'exit', component, error_type: 'None', ...extra });
	const enter = (component: string, argsHash: string): string =>
		JSON.stringify({ event: 'enter', component, args_hash: argsHash });

	test('Theil–Sen slope is the median pairwise slope and shrugs off one outlier', () => {
		assert.strictEqual(theilSenSlope([1, 2, 3, 4]), 1);
		assert.strictEqual(theilSenSlope([5, 5, 5]), 0);
		// One wild spike would wreck least-squares; the robust slope stays sane.
		assert.ok(Math.abs(theilSenSlope([1, 2, 100, 4, 5]) - 1) < 1.6);
		assert.strictEqual(theilSenSlope([]), 0);
	});

	test('leak suspects need retention EVERY session and a positive trend', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-mem-'));
		try {
			const t = Math.floor(Date.now() / 1000);
			// fn0 retains and grows across 3 sessions → suspect.
			// fn1 frees memory in session 2 → working allocator, never flagged.
			for (let s = 0; s < 3; s++) {
				writeTrace(ws, `session-${s}`, [
					exit('src.mod0.fn0', { mem_delta_bytes: 1000 * (s + 1) }),
					exit('src.mod1.fn1', { mem_delta_bytes: s === 1 ? -500 : 800 }),
				], t - 300 + s * 100);
			}
			const nodes = [makeNode(0), makeNode(1)];
			const suspects = collectMemoryTrends(ws, nodes);
			assert.strictEqual(suspects.length, 1);
			assert.strictEqual(suspects[0].row, 0);
			assert.strictEqual(suspects[0].sessions, 3);
			assert.strictEqual(suspects[0].total_retained_bytes, 6000);
			assert.strictEqual(suspects[0].slope_bytes_per_session, 1000);
			// Two sessions is not a trend: below the statistical floor → nothing.
			const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-mem2-'));
			try {
				for (let s = 0; s < 2; s++) {
					writeTrace(ws2, `s${s}`, [exit('src.mod0.fn0', { mem_delta_bytes: 1000 })], t + s);
				}
				assert.deepStrictEqual(collectMemoryTrends(ws2, nodes), []);
			} finally {
				fs.rmSync(ws2, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('cache candidates: duplicate args reclaim time; nondeterminism disqualifies', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-cache-'));
		try {
			writeTrace(ws, 's0', [
				// fn0: 4 calls, 1 distinct hash, constant result, 400ms total →
				// 300ms reclaimable (functional dependence observed).
				enter('src.mod0.fn0', 'aaaa'), exit('src.mod0.fn0', { duration_ms: 100, result_hash: 'r0' }),
				enter('src.mod0.fn0', 'aaaa'), exit('src.mod0.fn0', { duration_ms: 100, result_hash: 'r0' }),
				enter('src.mod0.fn0', 'aaaa'), exit('src.mod0.fn0', { duration_ms: 100, result_hash: 'r0' }),
				enter('src.mod0.fn0', 'aaaa'), exit('src.mod0.fn0', { duration_ms: 100, result_hash: 'r0' }),
				// fn1: duplicates BUT reads the clock → caching changes behavior.
				enter('src.mod1.fn1', 'bbbb'),
				exit('src.mod1.fn1', { duration_ms: 50, determinism_sources: ['time'] }),
				enter('src.mod1.fn1', 'bbbb'),
				exit('src.mod1.fn1', { duration_ms: 50, determinism_sources: ['time'] }),
				// fn2: every call a new hash → nothing to cache.
				enter('src.mod2.fn2', 'c1'), exit('src.mod2.fn2', { duration_ms: 30 }),
				enter('src.mod2.fn2', 'c2'), exit('src.mod2.fn2', { duration_ms: 30 }),
			], Math.floor(Date.now() / 1000));
			const nodes = [makeNode(0), makeNode(1), makeNode(2)];
			const candidates = collectCacheCandidates(ws, nodes);
			assert.strictEqual(candidates.length, 1, 'only the pure duplicate qualifies');
			assert.strictEqual(candidates[0].row, 0);
			assert.strictEqual(candidates[0].calls, 4);
			assert.strictEqual(candidates[0].distinct_args, 1);
			assert.strictEqual(Math.round(candidates[0].reclaimable_ms), 300);
			assert.strictEqual(candidates[0].share, 1);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});

suite('Workspace snapshot + revert (pre-episode safety net)', () => {
	function sh(cwd: string, cmd: string): void {
		execSync(cmd, { cwd, stdio: 'pipe' });
	}

	/** rmSync that also clears the read-only bit git sets on .git objects on Windows. */
	function rmGitWorkspace(ws: string): void {
		try {
			fs.rmSync(ws, { recursive: true, force: true });
		} catch {
			if (process.platform === 'win32') {
				execSync(`attrib -r "${ws}\\*" /s /d`, { stdio: 'pipe' });
				fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			} else {
				throw new Error(`could not remove ${ws}`);
			}
		}
	}

	test('capture → agent edits/creates/deletes → revert restores the exact state', async function () {
		// ~10 sequential git spawns; on Windows under CPU contention each can
		// take seconds, so give the whole flow generous headroom.
		this.timeout(60000);
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-snap-'));
		try {
			sh(ws, 'git init -q && git config user.email t@t && git config user.name t');
			fs.writeFileSync(path.join(ws, 'kept.txt'), 'original');
			fs.writeFileSync(path.join(ws, 'doomed.txt'), 'will be deleted by agent');
			fs.writeFileSync(path.join(ws, '.gitignore'), 'ignored.log\n');
			fs.writeFileSync(path.join(ws, 'ignored.log'), 'never touched');
			sh(ws, 'git add -A && git commit -qm base');
			// Uncommitted user edit BEFORE the episode — must survive the revert.
			fs.writeFileSync(path.join(ws, 'kept.txt'), 'user edit before episode');

			const sha = await captureWorkspaceSnapshot(ws, 'ep-test');
			assert.ok(sha, 'snapshot commits in a git repo');

			// The "agent" edits, creates, and deletes.
			fs.writeFileSync(path.join(ws, 'kept.txt'), 'agent broke this');
			fs.writeFileSync(path.join(ws, 'invented.py'), 'print("new file by agent")');
			fs.unlinkSync(path.join(ws, 'doomed.txt'));
			fs.appendFileSync(path.join(ws, 'ignored.log'), '\nagent log line');

			const result = await revertToSnapshot(ws, 'ep-test');
			assert.strictEqual(
				fs.readFileSync(path.join(ws, 'kept.txt'), 'utf8'),
				'user edit before episode',
				'pre-episode (even uncommitted) content restored',
			);
			assert.ok(fs.existsSync(path.join(ws, 'doomed.txt')), 'agent deletion undone');
			assert.ok(!fs.existsSync(path.join(ws, 'invented.py')), 'agent-created file removed');
			assert.deepStrictEqual(result.deleted, ['invented.py']);
			assert.ok(
				fs.readFileSync(path.join(ws, 'ignored.log'), 'utf8').includes('agent log line'),
				'gitignored files are never captured nor reverted',
			);
		} finally {
			rmGitWorkspace(ws);
		}
	});

	test('non-git workspace yields null (no snapshot, no revert offer)', async () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-nogit-'));
		try {
			assert.strictEqual(await captureWorkspaceSnapshot(ws, 'x'), null);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('mutated lockfile round-trip: restored from snapshot + loud drift warning', async function () {
		this.timeout(60000);
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lock-'));
		try {
			sh(ws, 'git init -q && git config user.email t@t && git config user.name t');
			fs.writeFileSync(path.join(ws, 'uv.lock'), 'locked-deps-v1');
			fs.writeFileSync(path.join(ws, 'requirements-dev.txt'), 'pytest==8.0.0');
			fs.writeFileSync(path.join(ws, 'app.py'), 'print("v1")');
			sh(ws, 'git add -A && git commit -qm base');

			const sha = await captureWorkspaceSnapshot(ws, 'ep-lock');
			assert.ok(sha, 'snapshot commits in a git repo');

			// The "agent" bumps a dependency, syncs, and edits code.
			fs.writeFileSync(path.join(ws, 'uv.lock'), 'locked-deps-v2-agent-bumped');
			fs.writeFileSync(path.join(ws, 'requirements-dev.txt'), 'pytest==9.9.9');
			fs.writeFileSync(path.join(ws, 'app.py'), 'print("v2")');

			const result = await revertToSnapshot(ws, 'ep-lock');
			assert.strictEqual(
				fs.readFileSync(path.join(ws, 'uv.lock'), 'utf8'),
				'locked-deps-v1',
				'diverged lockfile content restored from the snapshot',
			);
			assert.strictEqual(
				fs.readFileSync(path.join(ws, 'requirements-dev.txt'), 'utf8'),
				'pytest==8.0.0',
			);
			assert.deepStrictEqual(
				result.lockfilesRestored.sort(),
				['requirements-dev.txt', 'uv.lock'],
				'both diverged lockfiles verified restored to their captured hashes',
			);
			assert.ok(result.environmentWarning, 'divergence must surface a loud warning');
			assert.ok(
				/ENVIRONMENT MAY HAVE DRIFTED/.test(result.environmentWarning!),
				`warning is loud: ${result.environmentWarning}`,
			);
			assert.ok(
				result.environmentWarning!.includes('uv.lock') &&
					result.environmentWarning!.includes('requirements-dev.txt'),
				'warning names the diverged lockfiles',
			);
			assert.ok(
				/re-sync/.test(result.environmentWarning!),
				'warning tells the caller how to recover the installed environment',
			);
		} finally {
			rmGitWorkspace(ws);
		}
	});

	test('untouched lockfiles produce no environment warning', async function () {
		this.timeout(60000);
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lockok-'));
		try {
			sh(ws, 'git init -q && git config user.email t@t && git config user.name t');
			fs.writeFileSync(path.join(ws, 'package-lock.json'), '{"lockfileVersion": 3}');
			fs.writeFileSync(path.join(ws, 'app.js'), 'console.log(1)');
			sh(ws, 'git add -A && git commit -qm base');

			await captureWorkspaceSnapshot(ws, 'ep-lockok');
			fs.writeFileSync(path.join(ws, 'app.js'), 'console.log(2)'); // code only

			const result = await revertToSnapshot(ws, 'ep-lockok');
			assert.deepStrictEqual(result.lockfilesRestored, []);
			assert.strictEqual(
				result.environmentWarning,
				undefined,
				'no divergence, no drift noise',
			);
			assert.strictEqual(fs.readFileSync(path.join(ws, 'app.js'), 'utf8'), 'console.log(1)');
		} finally {
			rmGitWorkspace(ws);
		}
	});
});

suite('QnA subject section (deixis for seeded questions)', () => {
	test('seeded file yields preamble, symbols, and directed relations', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-subj-'));
		try {
			fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(ws, 'src', 'mod0.py'),
				'"""Module docstring."""\nimport os\nfrom src.mod1 import fn1\n\n\ndef fn0():\n    return fn1()\n',
			);
			const nodes = [
				makeNode(0, { start_line: 6 }),
				makeNode(1, { file: 'src/mod1.py', name: 'fn1' }),
			];
			const snapshot = makeSnapshot(nodes, [{ src: 0, dst: 1, kind: 'invoke' }]);
			snapshot.flow_edges = [
				{ src: 0, dst: 1, calls: 7, total_ms: 12, errors: 0, observed_only: false },
			];
			const section = composeSubjectSection(ws, snapshot, [0]);
			assert.ok(section.includes('The question is about `src/mod0.py`'), 'subject named');
			assert.ok(section.includes('from src.mod1 import fn1'), 'import block included verbatim');
			assert.ok(section.includes('fn0 (function) at line 6'), 'symbol list present');
			assert.ok(/calls \/ imports[\s\S]*`src\/mod1\.py`: fn1/.test(section), 'static callee listed per file');
			assert.ok(section.includes('observed ×7'), 'runtime flow direction included');
			// No seeds → no section (unseeded questions keep the old context shape).
			assert.strictEqual(composeSubjectSection(ws, snapshot, []), '');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});

suite('Episode request queue (chat → editor bridge)', () => {
	test('enqueue → read round-trips fields, drains the queue, and orders by time', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-queue-'));
		try {
			const first = enqueueEpisodeRequest(ws, {
				source: 'chat',
				kind: 'fix',
				issue: 'POST /orders 500s on empty cart',
				service: 'admin',
			});
			assert.ok(fs.existsSync(first), 'request persisted as a durable file');
			// Force a strictly later timestamp for deterministic ordering.
			const second = enqueueEpisodeRequest(ws, { source: 'chat', kind: 'hotspots' });
			const secondParsed = JSON.parse(fs.readFileSync(second, 'utf8')) as { ts: string };
			secondParsed.ts = new Date(Date.now() + 60_000).toISOString();
			fs.writeFileSync(second, JSON.stringify(secondParsed));

			const requests = readAndClearRequests(ws);
			assert.strictEqual(requests.length, 2);
			assert.strictEqual(requests[0].kind, 'fix', 'oldest request first');
			assert.strictEqual(requests[0].issue, 'POST /orders 500s on empty cart');
			assert.strictEqual(requests[0].service, 'admin');
			assert.strictEqual(requests[1].kind, 'hotspots');
			assert.deepStrictEqual(readAndClearRequests(ws), [], 'reading drains the queue');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('malformed request files are deleted, never dispatched, never wedge the queue', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-queue-'));
		try {
			const dir = requestsDir(ws);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'episode-bad.json'), '{not json');
			enqueueEpisodeRequest(ws, { source: 'chat', kind: 'memory-trends' });
			const requests = readAndClearRequests(ws);
			assert.strictEqual(requests.length, 1, 'only the valid request survives');
			assert.strictEqual(requests[0].kind, 'memory-trends');
			assert.ok(!fs.existsSync(path.join(dir, 'episode-bad.json')), 'malformed file self-healed');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('busy harness restores every unconsumed request without changing identity', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-queue-'));
		try {
			enqueueEpisodeRequest(ws, { source: 'chat', kind: 'runtime-errors' });
			enqueueEpisodeRequest(ws, { source: 'chat', kind: 'hotspots' });
			enqueueEpisodeRequest(ws, { source: 'chat', kind: 'cache-candidates' });
			const drained = readAndClearRequests(ws);
			const pending = drained.slice(1);

			restoreEpisodeRequests(ws, pending);
			const restored = readAndClearRequests(ws);

			assert.deepStrictEqual(
				restored.map(({ id, ts, kind }) => ({ id, ts, kind })),
				pending.map(({ id, ts, kind }) => ({ id, ts, kind })),
				'all unconsumed requests survive with stable ids and timestamps',
			);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('no requests directory yields an empty sweep (fresh workspace)', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-queue-'));
		try {
			assert.deepStrictEqual(readAndClearRequests(ws), []);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});

suite('Goal suggestion (dispatch-card default via the goal engine)', () => {
	test('context is ask-first with goal, trajectory, anchors, and answer evidence', () => {
		const doc = composeGoalContext({
			question: 'why is list binaries slow',
			standingGoal: 'keep the admin api fast',
			trajectory: 'Trajectory: episode 2 of 5',
			citations: [
				{ file: 'a/controller.py', line: 103, name: 'list_binaries', kind: 'runtime' },
			],
			lastAnswer: 'The endpoint spends ~8s inside list_binaries.',
		});
		const order = [
			"## Ask (the user's request, verbatim)",
			'why is list binaries slow',
			'## Current standing goal',
			'## Trajectory so far',
			'## Anchor symbols',
			'`list_binaries` (runtime) — a/controller.py:103',
			'## Most recent answer for this ask',
		];
		let at = -1;
		for (const marker of order) {
			const next = doc.indexOf(marker);
			assert.ok(next > at, `"${marker}" present and in order`);
			at = next;
		}
	});

	test('empty sections are omitted entirely', () => {
		const doc = composeGoalContext({
			question: 'q',
			standingGoal: '',
			trajectory: '',
			citations: [],
		});
		assert.ok(doc.includes('## Ask'));
		assert.ok(!doc.includes('## Current standing goal'));
		assert.ok(!doc.includes('## Trajectory'));
		assert.ok(!doc.includes('## Anchor symbols'));
		assert.ok(!doc.includes('## Most recent answer'));
	});

	test('session extraction prefers the answer to the dispatched question', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-goalctx-'));
		try {
			setGoal(ws, 'standing');
			appendTranscriptEntry(ws, {
				kind: 'qa',
				ts: 't1',
				question: 'other question',
				answer: 'other answer',
				mode: 'cloud',
				decisionId: 'd1',
				citations: [],
			});
			appendTranscriptEntry(ws, {
				kind: 'qa',
				ts: 't2',
				question: 'the ask',
				answer: 'the matching answer',
				mode: 'cloud',
				decisionId: 'd2',
				citations: [{ file: 'f.py', line: 1, name: 'fn', kind: 'static' }],
			});
			appendTranscriptEntry(ws, {
				kind: 'qa',
				ts: 't3',
				question: 'later question',
				answer: 'later answer',
				mode: 'cloud',
				decisionId: 'd3',
				citations: [],
			});
			const input = goalContextFromSession('the ask', loadSession(ws));
			assert.strictEqual(input.standingGoal, 'standing');
			assert.strictEqual(input.lastAnswer, 'the matching answer');
			assert.deepStrictEqual(input.citations.map((c) => c.name), ['fn']);
			// No match → most recent answer stands in as evidence.
			const fallback = goalContextFromSession('never asked', loadSession(ws));
			assert.strictEqual(fallback.lastAnswer, 'later answer');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('CLI output parsing: ok goal, noise tolerance, error and junk rejected', () => {
		assert.strictEqual(
			parseGoalOutput('{"status": "ok", "goal": "Eliminate the 502s.", "reasoning": "r"}'),
			'Eliminate the 502s.',
		);
		assert.strictEqual(
			parseGoalOutput('WARNING something\n{"status": "ok", "goal": "G"}'),
			'G',
			'non-JSON prefix lines are tolerated',
		);
		assert.strictEqual(parseGoalOutput('{"status": "error", "error": "boom"}'), undefined);
		assert.strictEqual(parseGoalOutput('{"status": "ok", "goal": "  "}'), undefined);
		assert.strictEqual(parseGoalOutput('not json at all'), undefined);
		assert.strictEqual(parseGoalOutput(''), undefined);
	});
});

suite('Cache soundness gates (functional dependence + ceiling cap + security guard)', () => {
	function writeTrace(ws: string, session: string, lines: string[], mtimeSec: number): void {
		const dir = path.join(ws, '.vinv', 'captures', session, 'svc');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'trace.jsonl');
		fs.writeFileSync(file, lines.join('\n'));
		fs.utimesSync(file, mtimeSec, mtimeSec);
	}
	const enter = (component: string, argsHash: string): string =>
		JSON.stringify({ event: 'enter', component, args_hash: argsHash });
	const exit = (component: string, extra: Record<string, unknown> = {}): string =>
		JSON.stringify({ event: 'exit', component, error_type: 'None', ...extra });
	/** One paired call: same args hash, chosen result hash, 100ms. */
	const call = (comp: string, args: string, result: string, ms = 100): string[] => [
		enter(comp, args),
		exit(comp, { duration_ms: ms, result_hash: result }),
	];

	test('a repeated input whose OUTPUT varied is not cacheable (arg-hash collapse defence)', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-fdep-'));
		try {
			// The real-world shape this guards: arg hashing collapsed 62 distinct
			// embedder requests to one hash, but their results differed — observed
			// same-input→different-output means caching is provably wrong.
			writeTrace(ws, 's0', [
				...call('src.mod0.fn0', 'collapsed', 'r1'),
				...call('src.mod0.fn0', 'collapsed', 'r2'),
				...call('src.mod0.fn0', 'collapsed', 'r3'),
			], Math.floor(Date.now() / 1000));
			assert.deepStrictEqual(collectCacheCandidates(ws, [makeNode(0)]), []);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('a duplicated call with NO recorded result hash is not assumed cacheable', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-nores-'));
		try {
			writeTrace(ws, 's0', [
				enter('src.mod0.fn0', 'aaaa'), exit('src.mod0.fn0', { duration_ms: 100 }),
				enter('src.mod0.fn0', 'aaaa'), exit('src.mod0.fn0', { duration_ms: 100 }),
			], Math.floor(Date.now() / 1000));
			assert.deepStrictEqual(collectCacheCandidates(ws, [makeNode(0)]), []);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('reclaimable time is capped at the NEWEST session total (the ceiling)', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-cap-'));
		try {
			const t = Math.floor(Date.now() / 1000);
			// Old session: 4 duplicate calls at 100ms → 300ms of duplication.
			writeTrace(ws, 's0', [
				...call('src.mod0.fn0', 'aaaa', 'r0'),
				...call('src.mod0.fn0', 'aaaa', 'r0'),
				...call('src.mod0.fn0', 'aaaa', 'r0'),
				...call('src.mod0.fn0', 'aaaa', 'r0'),
			], t - 100);
			// Newest session: the symbol costs only 50ms now — you cannot reclaim
			// 300ms from a symbol that currently spends 50ms.
			writeTrace(ws, 's1', [...call('src.mod0.fn0', 'aaaa', 'r0', 50)], t);
			const out = collectCacheCandidates(ws, [makeNode(0)]);
			assert.strictEqual(out.length, 1);
			assert.ok(out[0].reclaimable_ms <= 50, `capped at newest session (got ${out[0].reclaimable_ms})`);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('an entry point is never a cache candidate — its duration is lifetime, not work', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-lifetime-'));
		try {
			// The live shape this closes. `main` is the process root: same argv →
			// same exit 0 every launch, so functional dependence HOLDS, no crypto is
			// on the path, and it returns 0 rather than None — all three existing
			// soundness gates pass. The board therefore offered `main` and
			// `_cmd_serve` at "~25101ms is cacheable (1 of 2 calls repeat)", i.e.
			// memoize a server's CLI entry point, and ranked them #1/#2 of traced
			// runtime at 31.2% each. For a process root, duration is WALL-CLOCK
			// LIFETIME, not compute.
			//
			// fn0 = main at depth 0. fn1 = _cmd_serve, depth 1, spanning the whole
			// root. fn2 = real work nested under fn1 at a fraction of the root — it
			// MUST stay eligible, which is what keeps the gate narrow.
			const lines: string[] = [];
			for (const req of ['r0', 'r1']) {
				lines.push(JSON.stringify({ event: 'enter', component: 'src.mod0.fn0', args_hash: 'aaaa', request_id: req, depth: 0 }));
				lines.push(JSON.stringify({ event: 'enter', component: 'src.mod1.fn1', args_hash: 'bbbb', request_id: req, depth: 1 }));
				lines.push(JSON.stringify({ event: 'enter', component: 'src.mod2.fn2', args_hash: 'cccc', request_id: req, depth: 2 }));
				lines.push(JSON.stringify({ event: 'exit', component: 'src.mod2.fn2', error_type: 'None', request_id: req, depth: 2, duration_ms: 100, result_hash: 'h2' }));
				lines.push(JSON.stringify({ event: 'exit', component: 'src.mod1.fn1', error_type: 'None', request_id: req, depth: 1, duration_ms: 1000, result_hash: 'h1' }));
				lines.push(JSON.stringify({ event: 'exit', component: 'src.mod0.fn0', error_type: 'None', request_id: req, depth: 0, duration_ms: 1000, result_hash: 'h0' }));
			}
			writeTrace(ws, 's0', lines, Math.floor(Date.now() / 1000));
			const nodes = [makeNode(0), makeNode(1), makeNode(2)];

			const lifetime = lifetimeFrames(ws, nodes);
			assert.ok(lifetime.has(0), 'depth-0 root is a lifetime frame');
			assert.ok(lifetime.has(1), 'a pass-through spanning the whole root is a lifetime frame');
			assert.ok(!lifetime.has(2), 'nested real work is NOT a lifetime frame');
			assert.match(lifetime.get(0)!, /depth 0/);
			assert.match(lifetime.get(1)!, /spans 100% of its request root/);

			// Both entry points are duplicated (identical args across two runs) and
			// would otherwise be the two biggest cache candidates by time.
			const rows = collectCacheCandidates(ws, nodes).map((c) => c.row);
			assert.ok(!rows.includes(0), 'the process root must not be offered for memoization');
			assert.ok(!rows.includes(1), 'the pass-through must not be offered for memoization');
			assert.deepStrictEqual(rows, [2], 'only genuine nested work stays eligible');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('a hot function called many times is NOT a lifetime frame, however much of the root it adds up to', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-hotloop-'));
		try {
			// The inverse of the test above, and the case a SUM cannot distinguish
			// from it. fn1 is entered once and wraps the run (a pass-through);
			// fn2 runs 20 times at 50ms inside the same 1000ms root. Both reach
			// 100% of the root — only one of them is lifetime.
			//
			// fn2 is the shape of an N+1: the batching candidate, the fanout
			// signal and the staircase signal all live here. Excluding it would
			// blind the optimizer to its single most reclaimable target while
			// reporting nothing at all.
			const lines: string[] = [];
			for (const req of ['r0', 'r1']) {
				lines.push(JSON.stringify({ event: 'enter', component: 'src.mod0.fn0', args_hash: 'aaaa', request_id: req, depth: 0 }));
				lines.push(JSON.stringify({ event: 'enter', component: 'src.mod1.fn1', args_hash: 'bbbb', request_id: req, depth: 1 }));
				for (let i = 0; i < 20; i++) {
					lines.push(JSON.stringify({ event: 'enter', component: 'src.mod2.fn2', args_hash: 'cccc', request_id: req, depth: 2 }));
					lines.push(JSON.stringify({ event: 'exit', component: 'src.mod2.fn2', error_type: 'None', request_id: req, depth: 2, duration_ms: 50, result_hash: 'h2' }));
				}
				lines.push(JSON.stringify({ event: 'exit', component: 'src.mod1.fn1', error_type: 'None', request_id: req, depth: 1, duration_ms: 1000, result_hash: 'h1' }));
				lines.push(JSON.stringify({ event: 'exit', component: 'src.mod0.fn0', error_type: 'None', request_id: req, depth: 0, duration_ms: 1000, result_hash: 'h0' }));
			}
			writeTrace(ws, 's0', lines, Math.floor(Date.now() / 1000));
			const nodes = [makeNode(0), makeNode(1), makeNode(2)];

			const lifetime = lifetimeFrames(ws, nodes);
			// 20 × 50ms = 1000ms = 100% of the root by SUM, but no single call is
			// more than 5% of it.
			assert.ok(!lifetime.has(2), 'a function called 20x is work, not lifetime');
			// The genuine pass-through beside it must still be caught, so this
			// test cannot pass by simply disabling the gate.
			assert.ok(lifetime.has(1), 'the single-call pass-through is still a lifetime frame');
			assert.ok(lifetime.has(0), 'the depth-0 root is still a lifetime frame');
			assert.match(lifetime.get(1)!, /in a single call/);

			// And it stays dispatchable: identical args and result across both
			// requests, so it is exactly the memoization candidate.
			assert.deepStrictEqual(
				collectCacheCandidates(ws, nodes).map((c) => c.row),
				[2],
				'the hot function must remain an optimization candidate',
			);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('a duplicated call that always returns None has nothing to memoize', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-none-'));
		try {
			// The embedder's do_POST shape: constant args hash, constant result
			// hash — but the "result" is None every time; the real output is a
			// socket write the tracer never saw. No value to cache.
			const lines: string[] = [];
			for (let i = 0; i < 3; i++) {
				lines.push(enter('src.mod0.fn0', 'aaaa'));
				lines.push(exit('src.mod0.fn0', { duration_ms: 100, result_hash: 'noneh', result_schema: 'NoneType' }));
			}
			writeTrace(ws, 's0', lines, Math.floor(Date.now() / 1000));
			assert.deepStrictEqual(collectCacheCandidates(ws, [makeNode(0)]), []);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('security guard: crypto-importing files are excluded, directly and transitively', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-guard-'));
		try {
			// mod0 imports a password-hashing lib; mod1 imports mod0; mod2 is clean.
			fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
			fs.writeFileSync(path.join(ws, 'src', 'mod0.py'), 'import pwdlib\n\ndef fn0(p, h):\n    return True\n');
			fs.writeFileSync(path.join(ws, 'src', 'mod1.py'), 'from src.mod0 import fn0\n\ndef fn1(s, e):\n    return fn0(e, s)\n');
			fs.writeFileSync(path.join(ws, 'src', 'mod2.py'), 'def fn2(x):\n    return x\n');
			const nodes = [makeNode(0), makeNode(1), makeNode(2)];
			const lines: string[] = [];
			for (const comp of ['src.mod0.fn0', 'src.mod1.fn1', 'src.mod2.fn2']) {
				lines.push(...call(comp, 'aaaa', 'r0'), ...call(comp, 'aaaa', 'r0'));
			}
			writeTrace(ws, 's0', lines, Math.floor(Date.now() / 1000));

			const reasons = securityGuardReasons(ws, nodes);
			assert.ok(reasons.get(0)?.includes('pwdlib'), 'direct crypto import is guarded with the module named');
			assert.ok(reasons.get(1)?.includes('security-sensitive'), 'importing a guarded module inherits the guard');
			assert.strictEqual(reasons.get(2), undefined, 'a clean file is not guarded');

			const out = collectCacheCandidates(ws, nodes);
			assert.deepStrictEqual(out.map((c) => c.row), [2], 'only the clean symbol is offered as cacheable');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});

suite('Seam fixes (validation round)', () => {
	function writeTrace(ws: string, session: string, lines: string[], mtimeSec: number): void {
		const dir = path.join(ws, '.vinv', 'captures', session, 'svc');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'trace.jsonl');
		fs.writeFileSync(file, lines.join('\n'));
		fs.utimesSync(file, mtimeSec, mtimeSec);
	}
	const line = (o: Record<string, unknown>): string => JSON.stringify(o);

	test('blocked_ms majority rule decides io-ness ahead of the heuristics', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-blocked-'));
		try {
			const t = Math.floor(Date.now() / 1000);
			// One request, one parent with two sequential children: child A waited
			// (blocked 90% of wall — IO by the clock, no side_effects at all);
			// child B burned CPU (blocked ~0) despite a 'db' side effect claim.
			const req = { request_id: 'R', thread_id: 1 };
			writeTrace(ws, 's0', [
				line({ ...req, event: 'enter', component: 'src.mod0.fn0', depth: '0', parent_component: 'None', ts: new Date(1000).toISOString() }),
				line({ ...req, event: 'enter', component: 'src.mod1.fn1', depth: '1', parent_component: 'src.mod0.fn0', ts: new Date(1010).toISOString() }),
				line({ ...req, event: 'exit', component: 'src.mod1.fn1', depth: '1', parent_component: 'src.mod0.fn0', ts: new Date(1060).toISOString(), duration_ms: 50, blocked_ms: 45, error_type: null }),
				line({ ...req, event: 'enter', component: 'src.mod2.fn2', depth: '1', parent_component: 'src.mod0.fn0', ts: new Date(1070).toISOString() }),
				line({ ...req, event: 'exit', component: 'src.mod2.fn2', depth: '1', parent_component: 'src.mod0.fn0', ts: new Date(1130).toISOString(), duration_ms: 60, blocked_ms: 1, side_effects: ['db'], error_type: null }),
				line({ ...req, event: 'exit', component: 'src.mod0.fn0', depth: '0', parent_component: 'None', ts: new Date(1140).toISOString(), duration_ms: 140, error_type: null }),
			], t);
			const nodes = [makeNode(0), makeNode(1), makeNode(2)];
			const roots = collectRequestSpans(ws, nodes);
			assert.strictEqual(roots.length, 1);
			const [a, b] = roots[0].children;
			assert.strictEqual(a.io, true, 'blocked 45/50ms → waiting, io by the clock');
			assert.strictEqual(b.io, false, 'blocked 1/60ms → CPU-bound, the side-effect claim loses to the clock');
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('every waste signal clamps predicted_ms to the newest-session ceiling', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-clamp-'));
		try {
			const t = Math.floor(Date.now() / 1000);
			// Session 0: fn0 costs 900ms of self time across 3 calls. Session 1
			// (newest): only 90ms — a signal aggregating both sessions could
			// predict ~900ms of a symbol that now spends 90ms.
			const mk = (ms: number): string[] => [
				line({ event: 'enter', component: 'src.mod0.fn0', request_id: 'R', thread_id: 1, args_hash: `h${ms}${Math.random()}` }),
				line({ event: 'exit', component: 'src.mod0.fn0', request_id: 'R', thread_id: 1, duration_ms: ms, error_type: null }),
			];
			writeTrace(ws, 's0', [mk(300), mk(300), mk(300)].flat(), t - 100);
			writeTrace(ws, 's1', [mk(90)].flat(), t);
			const nodes = [makeNode(0)];
			const timings = collectSymbolTimings(ws, nodes);
			const list = computeOptimizationCandidates({ nodes, edges: [], timings, cacheByRow: new Map() });
			for (const c of list) {
				assert.ok(
					c.predicted_ms <= c.total_ms + 1e-9,
					`${c.name}: predicted ${c.predicted_ms} must not exceed newest-session total ${c.total_ms}`,
				);
			}
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});
});
