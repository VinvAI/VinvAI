/**
 * The test-author swarm: deterministic lens selection → parallel backend
 * authors → MECHANICAL fan-in.
 *
 * Which tests to write is decided by EVIDENCE, not by an LLM and not by a
 * fixed list: each lens has a deterministic precondition on the episode's
 * goal/issue/modules/graph/runtime evidence, so the swarm size adapts to
 * what is actually known about the problem (finite by construction — at most
 * one author per lens, |lenses| = 3):
 *
 *  - SYMPTOM (acceptance, fail-to-pass): always eligible — every episode has
 *    an issue statement to reproduce.
 *  - BOUNDARY (acceptance, fail-to-pass): eligible only when observed runtime
 *    value profiles exist for the seed symbols — boundaries come from real
 *    traced argument distributions (types, ranges, null-rates), never from
 *    literal numeric heuristics, so this lens cannot hallucinate boundaries
 *    on repos it knows nothing about.
 *  - REGRESSION (pass-to-pass): eligible only when the graph slice contains
 *    neighbor symbols with observed SUCCESSFUL calls — currently-correct
 *    behavior worth pinning. Validation is inverted: these must PASS on
 *    pre-fix code and STILL PASS after the fix (scope-creep detection).
 *
 * Fan-in is mechanical: every candidate file is executed twice on the pre-fix
 * code; acceptance keeps deterministic failers, regression keeps
 * deterministic passers, everything else is discarded with the reason
 * recorded. No LLM votes on test quality — execution does.
 *
 * The kept set is written OUTSIDE the workspace with a manifest binding it to
 * the issue signature + index epoch: a later episode may reuse the set only
 * for the same signature at the same epoch AND only after re-validating the
 * pre-run gates (code drift silently invalidates tests; revalidation is the
 * expiry mechanism).
 *
 * vscode-free: callers supply the agent spawn info and evidence strings.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runGoalAgent, asAuthoredTests, type AgentSpawn } from './binaryAgents';

export type LensName = 'symptom' | 'boundary' | 'regression';

export interface LensPlan {
	lens: LensName;
	/** The approach directive handed to the backend author. */
	approach: string;
	/** Evidence block for this lens (value profiles / neighbor behavior). */
	runtime_evidence: string;
}

export interface SwarmEvidence {
	/** Symbol context lines (name, kind, file:line, summary) for imports. */
	symbols: string;
	/** Failure exemplars text (symptom lens grounding); '' when none. */
	failures: string;
	/** Observed value-profile text for seed symbols; '' when none. */
	valueProfiles: string;
	/** Neighbor symbols with observed successful behavior; '' when none. */
	healthyNeighbors: string;
	/** Seed (symptom) symbol names — a regression candidate that references
	 * one pins behavior the fix is EXPECTED to change and must be dropped
	 * (found live: a P2P test asserting the broken add() rejected a good fix). */
	seedNames?: string[];
}

/**
 * Deterministic lens selection — the "which tests are needed" decision.
 * Preconditions are evidence-existence checks, so an episode on a repo with
 * no traces gets exactly the symptom lens, and richer evidence widens the
 * swarm. Never fewer than one lens, never more than three.
 */
export function selectLenses(evidence: SwarmEvidence): LensPlan[] {
	const plans: LensPlan[] = [
		{
			lens: 'symptom',
			approach:
				'ACCEPTANCE (fail-to-pass): reproduce the SPECIFIC symptom the issue names, at the ' +
				'narrowest scope that shows it, and assert the behavior a correct fix produces. The ' +
				'tests MUST FAIL on the current (broken) code and pass only when the cause is fixed.',
			runtime_evidence: evidence.failures,
		},
	];
	if (evidence.valueProfiles.trim()) {
		plans.push({
			lens: 'boundary',
			approach:
				'ACCEPTANCE (fail-to-pass): test the issue at the OBSERVED boundaries of the real ' +
				'runtime data below — nulls where the null-rate is nonzero, the extremes of observed ' +
				'ranges, empty collections where lengths reach zero. Every boundary you use must come ' +
				'from the observed profiles, never invented. The tests MUST FAIL on the current code ' +
				'via the same defect the issue names.',
			runtime_evidence: evidence.valueProfiles,
		});
	}
	if (evidence.healthyNeighbors.trim()) {
		plans.push({
			lens: 'regression',
			approach:
				'REGRESSION (pass-to-pass): pin the CURRENTLY-CORRECT observed behavior of the ' +
				'neighbor symbols below, which the fix must NOT change. These tests MUST PASS on the ' +
				'current code exactly as it is — do not test the broken behavior, do not test the ' +
				'fix — and they will be re-run after the fix to detect collateral damage.',
			runtime_evidence: evidence.healthyNeighbors,
		});
	}
	return plans;
}

/**
 * Oracle-provenance grade — WHERE a test's expected values came from
 * (anti-self-grading, per the ReAct-testing research doc's §6 model):
 * A = stated requirement / human-provided example (dispute counterexamples),
 * B = mathematical/formal invariant, C = independent reference,
 * D = metamorphic relation, E = characterization (copied from what the code
 * DID — the regression lens by construction). Grade E can pin behavior but
 * cannot certify correctness and must never be the sole basis for a retract.
 */
export type OracleGrade = 'A' | 'B' | 'C' | 'D' | 'E';

/** Structural lens→grade map: the symptom lens asserts the ISSUE's stated
 * behavior (A); the boundary lens asserts invariants at observed boundaries
 * (B); the regression lens characterizes current behavior (E). */
export const LENS_GRADE: Record<LensName, OracleGrade> = {
	symptom: 'A',
	boundary: 'B',
	regression: 'E',
};

export interface CandidateResult {
	lens: LensName;
	role: 'acceptance' | 'regression';
	kept: boolean;
	reason: string;
	path?: string;
	/** Oracle-provenance grade of this candidate (absent on old manifests). */
	grade?: OracleGrade;
	/** Why a discarded candidate was discarded, categorized — 'candidate_defect'
	 * (a regression author expected current behavior to pass and it FAILED:
	 * a possible latent bug adjacent to the fix) is preserved, never deleted. */
	triage?: 'not_discriminating' | 'infra' | 'candidate_defect';
}

export interface SwarmOutcome {
	/** Kept acceptance file (merged F2P survivors), if any. */
	acceptancePath?: string;
	/** Kept regression file (merged P2P survivors), if any. */
	regressionPath?: string;
	/** Strongest oracle grade among surviving acceptance tests (A best). */
	acceptanceGrade?: OracleGrade;
	candidates: CandidateResult[];
	/** Pre-fix failure output of the acceptance set (proof it reproduces). */
	preRunOutput?: string;
}

export interface SwarmManifest {
	version: 1;
	issue_sig: string;
	epoch: number;
	created_at: string;
	acceptance?: string;
	regression?: string;
	/** Strongest oracle grade among surviving acceptance tests (A best). The
	 * reward rubric weights the tests slice by this; absent (old manifests)
	 * defaults to full weight. */
	acceptance_grade?: OracleGrade;
	candidates: CandidateResult[];
}

/** Content signature binding a test set to its issue (same hashing family as
 * the error-cluster dedup: content-derived, stable across attempts). */
export function issueSignature(issue: string): string {
	return crypto.createHash('sha256').update(issue.trim()).digest('hex').slice(0, 24);
}

/** Normalized dedup key for one test function body: name + assert lines. */
export function testDedupKeys(code: string): string[] {
	const keys: string[] = [];
	const parts = code.split(/^def (test_\w+)/m);
	for (let i = 1; i < parts.length; i += 2) {
		const name = parts[i];
		const body = parts[i + 1] ?? '';
		const asserts = body
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.startsWith('assert') || l.startsWith('with pytest.raises'))
			.join('|');
		keys.push(`${name}::${crypto.createHash('sha256').update(asserts).digest('hex').slice(0, 12)}`);
	}
	return keys;
}

/**
 * Merges surviving candidate files of one role into a single test file,
 * dropping duplicate test functions (same name + normalized asserts across
 * authors — two lenses often re-derive the same core case).
 */
export function mergeCandidates(files: string[]): string {
	const seen = new Set<string>();
	const blocks: string[] = [];
	for (const code of files) {
		const keys = testDedupKeys(code);
		const fresh = keys.some((k) => !seen.has(k));
		if (!fresh) {
			continue;
		}
		keys.forEach((k) => seen.add(k));
		blocks.push(code.trim());
	}
	return `${blocks.join('\n\n\n')}\n`;
}

export interface SwarmDeps {
	spawnInfo: AgentSpawn;
	/** Runs a test file twice on the CURRENT (pre-fix) code — the caller's
	 * runAcceptanceTests, injected so the swarm is unit-testable. */
	preRun: (testFile: string) => Promise<{ signal: string; output: string }>;
	storageDir: string;
	issue: string;
	goal?: string;
	epoch: number;
	onNote?: (text: string) => void;
	/** Author override for tests — production uses the backend binary agent. */
	author?: (plan: LensPlan) => Promise<{ test_code: string; rationale: string } | null>;
}

/**
 * Runs the swarm end to end: fan-out (parallel backend authors, one process
 * each), mechanical fan-in (pre-run gates + dedup + merge), manifest write.
 */
export async function runTestSwarm(
	evidence: SwarmEvidence,
	deps: SwarmDeps,
): Promise<SwarmOutcome> {
	const plans = selectLenses(evidence);
	deps.onNote?.(
		`test swarm: ${plans.length} author(s) — ${plans.map((p) => p.lens).join(', ')} (lens preconditions decide, evidence-driven)`,
	);
	fs.mkdirSync(deps.storageDir, { recursive: true });
	const author =
		deps.author ??
		(async (plan: LensPlan) =>
			asAuthoredTests(
				await runGoalAgent(deps.spawnInfo, 'author-tests', {
					approach: plan.approach,
					issue: deps.issue,
					goal: deps.goal ?? '',
					symbols: evidence.symbols,
					runtime_evidence: plan.runtime_evidence,
				}),
			));
	const authored = await Promise.all(
		plans.map(async (plan) => ({ plan, result: await author(plan) })),
	);

	const candidates: CandidateResult[] = [];
	const keptAcceptance: string[] = [];
	const keptRegression: string[] = [];
	let acceptancePreOutput: string | undefined;
	// Pre-run validation is concurrent too — each candidate in its own file.
	await Promise.all(
		authored.map(async ({ plan, result }, index) => {
			const role = plan.lens === 'regression' ? 'regression' : 'acceptance';
			const grade = LENS_GRADE[plan.lens];
			if (!result) {
				candidates.push({ lens: plan.lens, role, grade, kept: false, reason: 'author unavailable or contract miss', triage: 'infra' });
				return;
			}
			const candidateFile = path.join(deps.storageDir, `candidate-${index}-${plan.lens}.py`);
			fs.writeFileSync(candidateFile, result.test_code, { mode: 0o600 });
			const pre = await deps.preRun(candidateFile);
			if (role === 'acceptance') {
				if (pre.signal === 'fail') {
					keptAcceptance.push(result.test_code);
					acceptancePreOutput = pre.output.slice(-4000);
					candidates.push({ lens: plan.lens, role, grade, kept: true, reason: 'fails on pre-fix code (discriminating)', path: candidateFile });
				} else {
					candidates.push({
						lens: plan.lens,
						role,
						grade,
						kept: false,
						reason: pre.signal === 'pass' ? 'passes on pre-fix code — cannot discriminate' : `pre-run ${pre.signal}`,
						triage: pre.signal === 'pass' ? 'not_discriminating' : 'infra',
						path: candidateFile,
					});
				}
			} else {
				// Mechanical guard: regression tests must pin NEIGHBOR behavior,
				// never the symptom symbols themselves (whose behavior the fix
				// will change — pinning them auto-rejects every good fix).
				const seedRef = (evidence.seedNames ?? []).find((n) =>
					n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(result.test_code),
				);
				if (seedRef) {
					candidates.push({
						lens: plan.lens,
						role,
						grade,
						kept: false,
						reason: `references symptom symbol \`${seedRef}\` — behavior the fix is expected to change`,
						triage: 'not_discriminating',
						path: candidateFile,
					});
					return;
				}
				if (pre.signal === 'pass') {
					keptRegression.push(result.test_code);
					candidates.push({ lens: plan.lens, role, grade, kept: true, reason: 'passes on pre-fix code (pins current behavior)', path: candidateFile });
				} else {
					// A regression author expected CURRENT behavior to pass and it
					// failed — possibly a real latent defect adjacent to the fix.
					// Preserved (file kept, outside the workspace), never deleted,
					// advisory only: it must not block the episode.
					candidates.push({
						lens: plan.lens,
						role,
						grade,
						kept: false,
						reason:
							pre.signal === 'fail'
								? 'author expected this to pass on current code — preserved as a candidate latent defect (advisory)'
								: `pre-run ${pre.signal}`,
						triage: pre.signal === 'fail' ? 'candidate_defect' : 'infra',
						path: candidateFile,
					});
				}
			}
		}),
	);

	const outcome: SwarmOutcome = { candidates, preRunOutput: acceptancePreOutput };
	if (keptAcceptance.length) {
		const target = path.join(deps.storageDir, 'test_acceptance.py');
		fs.writeFileSync(target, mergeCandidates(keptAcceptance), { mode: 0o600 });
		outcome.acceptancePath = target;
		// Strongest grade among the kept acceptance candidates ('A' outranks
		// 'B' outranks … 'E' — lexicographic order IS the grade order).
		outcome.acceptanceGrade = candidates
			.filter((c) => c.kept && c.role === 'acceptance' && c.grade)
			.map((c) => c.grade as OracleGrade)
			.sort()[0];
	}
	if (keptRegression.length) {
		const target = path.join(deps.storageDir, 'test_regression.py');
		fs.writeFileSync(target, mergeCandidates(keptRegression), { mode: 0o600 });
		outcome.regressionPath = target;
	}
	const manifest: SwarmManifest = {
		version: 1,
		issue_sig: issueSignature(deps.issue),
		epoch: deps.epoch,
		created_at: new Date().toISOString(),
		acceptance: outcome.acceptancePath,
		regression: outcome.regressionPath,
		acceptance_grade: outcome.acceptanceGrade,
		candidates,
	};
	fs.writeFileSync(path.join(deps.storageDir, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`, { mode: 0o600 });
	return outcome;
}

/**
 * Reuse-with-expiry: a prior episode's kept set for the SAME issue signature
 * at the SAME index epoch may be reused — but only after the caller
 * re-validates its pre-run gates (the caller re-runs and discards on flip).
 * Any epoch difference is expiry: code drift invalidates tests silently, so
 * they are never trusted across epochs.
 */
export function findReusableSet(
	acceptanceRoot: string,
	issue: string,
	epoch: number,
): SwarmManifest | null {
	const sig = issueSignature(issue);
	let best: SwarmManifest | null = null;
	let entries: string[];
	try {
		entries = fs.readdirSync(acceptanceRoot);
	} catch {
		return null;
	}
	for (const entry of entries) {
		try {
			const raw = JSON.parse(
				fs.readFileSync(path.join(acceptanceRoot, entry, 'manifest.json'), 'utf8'),
			) as SwarmManifest;
			if (
				raw.version === 1 &&
				raw.issue_sig === sig &&
				raw.epoch === epoch &&
				(raw.acceptance || raw.regression) &&
				(!best || raw.created_at > best.created_at)
			) {
				best = raw;
			}
		} catch {
			continue;
		}
	}
	return best;
}
