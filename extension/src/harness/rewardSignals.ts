/**
 * Reward signals — the pure math and contracts of the multi-signal episode
 * reward. No I/O, no vscode: everything here is unit-testable on synthetic
 * inputs, mirroring the contextWalk/critic pattern.
 *
 * The design follows the anti-reward-hacking literature rather than a single
 * hackable score (see "The Verification Horizon", arXiv 2606.26300; RLEF's
 * held-out-test gating, arXiv 2410.02089; ImpossibleBench's finding that
 * hiding test files from the agent collapses cheat rates, arXiv 2510.20270;
 * METR/OpenAI reward-hacking catalogs):
 *
 *  - HARD DETERMINISTIC GATES first (oracle replay; acceptance tests that the
 *    agent NEVER SEES, validated fail-on-pre / pass-on-post so tautological
 *    tests are rejected mechanically); soft signals can flag but never rescue
 *    a failed gate.
 *  - At least one signal the agent cannot observe: the acceptance tests live
 *    OUTSIDE the workspace and are generated before the fix is dispatched.
 *  - The LLM judge is bounded to one direction: it can push an outcome toward
 *    MORE scrutiny (fail/escalate with reasons), never from fail to pass —
 *    the "judge scores capped so they cannot dominate execution evidence"
 *    principle.
 *  - Every signal contributes REASONS and DIRECTIVES, so a low reward tells
 *    the next attempt exactly what to change (explicit rubric aggregation).
 *
 * A note on Z3 (checked deliberately): the z3-solver npm WASM build is usable
 * in the extension host, and its bounded use here would be assertion-vacuity
 * screening (assert P satisfiable AND ¬P satisfiable). That check is
 * behaviorally subsumed by the executable fail-on-pre gate — a tautological
 * test cannot fail on the pre-fix code, so it is rejected as
 * non-discriminating without any solver — at zero bundle cost, so Z3 is not
 * embedded. If a future signal needs real constraint solving (small pure
 * functions, boundary properties), z3-solver is the vetted path.
 */

/** Where a signal landed for one attempt. */
export type OracleSignal = 'pass_objective' | 'pass_heuristic' | 'fail' | 'unavailable' | 'none';
export type TestSignal = 'pass' | 'fail' | 'not_discriminating' | 'unavailable' | 'disabled';

/** One deterministic audit finding on the episode's workspace diff. */
export interface AuditFlag {
	kind:
		| 'test_edit'
		| 'except_swallow'
		| 'exit_zero'
		| 'skip_marker'
		| 'start_command_edit'
		| 'vinv_state_edit'
		| 'shadow_module'
		| 'danger_pattern'
		| 'syntax_error';
	file: string;
	detail: string;
	/** Hard flags fail the attempt outright; soft flags summon the judge. */
	severity: 'hard' | 'soft';
}

/** One success criterion's adherence verdict from the goal-adherence judge. */
export interface CriterionVerdict {
	criterion: string;
	verdict: 'met' | 'not_met' | 'unverifiable';
	reason: string;
}

/** The LLM judge's contract-validated report (null = judge unavailable). */
export interface JudgeReport {
	/** P(the diff games the checks rather than fixing the issue), [0,1]. */
	cheat_likelihood: number;
	/** P(the diff actually addresses the stated issue/goal), [0,1]. */
	goal_alignment: number;
	/** Per-success-criterion adherence — the "almost right but not what was
	 * specified" check. Empty when no criteria were given. */
	criteria_verdicts: CriterionVerdict[];
	/** How far the diff strays beyond the goal's implied scope (drift). */
	scope_drift: 'none' | 'minor' | 'major';
	concerns: string[];
	/** Concrete instructions that would raise the reward next attempt. */
	directives: string[];
}

export interface RewardBreakdown {
	oracle: OracleSignal;
	tests: TestSignal;
	/** Pass-to-pass regression tests (neighbor behavior pinned pre-fix). */
	regression: TestSignal;
	flags: AuditFlag[];
	judge: JudgeReport | null;
	/** Scalar reward in [0,1] over the available signals (explicit rubric). */
	reward: number;
	/** Whether this attempt's PASS may count as a verified, objective outcome. */
	verifiedEligible: boolean;
	/**
	 * WHY verified-eligibility was blocked (when it was): 'hard_flag'/'cheat'
	 * are conduct findings ("gaming the checks"); 'criteria' is a spec finding
	 * ("right code, wrong goal") — callers must not mislabel one as the other.
	 */
	verifiedBlockCause: 'none' | 'hard_flag' | 'cheat' | 'criteria';
	reasons: string[];
	directives: string[];
}

// ---- acceptance-test extraction -------------------------------------------

/**
 * Extracts the acceptance-test file from the generator's output: the LAST
 * fenced block labeled `python-acceptance`. The file must contain at least
 * one test function and one assert to be considered at all — an empty or
 * assert-free file can never discriminate.
 */
export function extractAcceptanceTestFile(stdout: string): string | null {
	const fences = [...stdout.matchAll(/```python-acceptance\s*\n([\s\S]*?)```/g)];
	if (fences.length === 0) {
		return null;
	}
	const body = fences[fences.length - 1][1];
	if (!/def test_\w+/.test(body) || !/\bassert\b|\braise\b/.test(body)) {
		return null;
	}
	return body;
}

// ---- test-run classification ----------------------------------------------

/**
 * Classifies one bounded test run. Follows pytest's exit-code contract
 * (0 = all passed, 1 = tests failed, 2 = interrupted/collection error,
 * 3 = internal error, 4 = usage error, 5 = nothing collected): only a clean
 * pass or a genuine test failure is evidence; everything else — import
 * errors, missing interpreter, collection failures, timeouts — is
 * 'unavailable' (infrastructure, not a verdict), mirroring the oracle's
 * infra-vs-rejection distinction.
 */
export function classifyTestRun(
	exitCode: number | null,
	output: string,
	timedOut: boolean,
): 'pass' | 'fail' | 'unavailable' {
	if (timedOut || exitCode === null) {
		return 'unavailable';
	}
	if (exitCode === 0) {
		return 'pass';
	}
	if (exitCode === 1) {
		// Exit 1 with collection-phase errors is not a test verdict.
		return /error(s)? during collection|ERROR collecting|ImportError|ModuleNotFoundError/i.test(
			output,
		)
			? 'unavailable'
			: 'fail';
	}
	// Plain-python fallback runs (no pytest) exit with arbitrary nonzero codes
	// on assertion failure; treat a clean AssertionError as a genuine fail.
	if (/AssertionError|Traceback \(most recent call last\)/.test(output)) {
		return /ImportError|ModuleNotFoundError/.test(output) ? 'unavailable' : 'fail';
	}
	return 'unavailable';
}

/**
 * WHY a run classified 'unavailable' — the diagnosis behind the verdict.
 *
 * 'unavailable' is honest but opaque: an episode that reports it tells the
 * operator nothing about whether the oracle is unfixable (a genuinely
 * unrunnable test) or one line of setup away (the wrong interpreter). Found
 * live: a correct fix could not self-certify because the tests ran under a
 * bare `python3` that could not import the workspace package — the failure was
 * fully diagnosable from the output and was reported as a generic shrug.
 * Returns null when the run DID produce a verdict (pass/fail).
 */
export type RunFailureKind =
	| 'timeout'
	| 'import_error'
	| 'nothing_collected'
	| 'spawn_failed'
	| 'crash';

export function classifyRunFailure(
	exitCode: number | null,
	output: string,
	timedOut: boolean,
): RunFailureKind | null {
	if (timedOut) {
		return 'timeout';
	}
	if (exitCode === null) {
		return 'spawn_failed';
	}
	if (classifyTestRun(exitCode, output, timedOut) !== 'unavailable') {
		return null;
	}
	// Import failures are checked BEFORE the exit-5 shape: pytest reports a
	// collection ImportError as exit 2, and the plain-python path surfaces it
	// as an uncaught ModuleNotFoundError (exit 1) — same cause, same fix.
	if (/ModuleNotFoundError|ImportError|error(s)? during collection|ERROR collecting/i.test(output)) {
		return 'import_error';
	}
	if (exitCode === 5 || /no tests ran|collected 0 items/i.test(output)) {
		return 'nothing_collected';
	}
	return 'crash';
}

/** One-line, operator-readable rendering of a run-failure diagnosis. */
export function describeRunFailure(kind: RunFailureKind): string {
	switch (kind) {
		case 'timeout':
			return 'the test run exceeded its time budget';
		case 'import_error':
			return 'the interpreter could not import the code under test';
		case 'nothing_collected':
			return 'the file ran but no test was collected';
		case 'spawn_failed':
			return 'the interpreter could not be launched';
		default:
			return 'the test run crashed before producing a verdict';
	}
}

/**
 * Classifies a FAILING run's output by failure class: 'assertion' when the
 * test's own check fired (AssertionError, a pytest-rewritten `E  assert`
 * diff, or a DID-NOT-RAISE from raises()), 'exception' when the test crashed
 * before reaching its check (TypeError on a hallucinated API, KeyError, a
 * fixture ConnectionError…). Retracting a verified verdict requires the
 * 'assertion' class: a crash proves the test cannot run — not that the
 * disputed behavior exists. Both fail deterministically twice, so the flake
 * guard is blind to the difference; this classifier is not.
 */
export function classifyFailureOutput(output: string): 'assertion' | 'exception' {
	return /AssertionError|DID NOT RAISE|^E\s+assert\b/m.test(output) ? 'assertion' : 'exception';
}

/**
 * The check lines of an authored test — what a human must read to confirm a
 * counterexample captures their report before it may retract a verdict.
 * Assert statements, raise statements, raises() contexts, and unittest-style
 * self.assert* calls; capped so the confirm card stays readable.
 */
export function extractCheckLines(testCode: string): string[] {
	return testCode
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => /^assert\b|^raise\b|pytest\.raises|\bself\.assert\w*\(/.test(l))
		.slice(0, 12);
}

/**
 * Two runs must agree to count (flake guard — the SWE-bench literature puts
 * suite flakiness at ~11%, and a flaky signal is worse than none).
 */
export function combineTestRuns(
	first: 'pass' | 'fail' | 'unavailable',
	second: 'pass' | 'fail' | 'unavailable',
): 'pass' | 'fail' | 'unavailable' {
	return first === second ? first : 'unavailable';
}

// ---- deterministic diff audit ---------------------------------------------

export interface ChangedFile {
	path: string;
	/** Lines ADDED by the diff (no +/- prefixes). */
	addedLines: string[];
	/** New-file-side hunk ranges from @@ headers (for diff-scoped mutation). */
	hunks?: Array<{ start: number; count: number }>;
}

const TEST_PATH = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;

/** Module names a fix could drop to shadow the real pytest / hijack the
 * interpreter at startup. The runner is already shadow-safe (isolated cwd +
 * appended workspace + PYTHONSAFEPATH), so this is defense-in-depth AND a
 * strong reward-hacking signal: a genuine fix never adds one of these. */
const SHADOW_MODULE = /(^|\/)(pytest|sitecustomize|usercustomize)\.py$/;

/**
 * The deterministic anti-cheat audit over the episode's workspace diff.
 * These are FLAGS, not verdicts: each names a pattern from the documented
 * reward-hacking taxonomy (test tampering, exception swallowing, exit-code
 * games, skip markers, oracle-input tampering). Hard flags fail the attempt;
 * soft flags summon the judge and ride into the escalation text. Pure over
 * pre-parsed diff data so every pattern is unit-testable.
 */
export function auditChangedFiles(changed: ChangedFile[], untracked: string[]): AuditFlag[] {
	const flags: AuditFlag[] = [];
	const consider = [
		...changed,
		...untracked.map((p) => ({ path: p, addedLines: [] as string[] })),
	];
	for (const f of consider) {
		const p = f.path.replace(/\\/g, '/');
		if (p.startsWith('.vinv/start_commands/')) {
			// The replay oracle's input. Editing it is sometimes legitimate (the
			// pack explicitly allows correcting a wrong command) — but it is also
			// the direct route to a port-squatting hack, so it always surfaces.
			flags.push({
				kind: 'start_command_edit',
				file: f.path,
				detail: 'the recorded start command (the replay oracle’s input) was modified',
				severity: 'soft',
			});
			continue;
		}
		if (p.startsWith('.vinv/replay-stats/') || p.startsWith('.vinv/acceptance/')) {
			// Verification state itself — no fix has business here.
			flags.push({
				kind: 'vinv_state_edit',
				file: f.path,
				detail: 'verification state under .vinv was modified by the fix',
				severity: 'hard',
			});
			continue;
		}
		if (SHADOW_MODULE.test(p)) {
			// A pytest.py / sitecustomize.py / usercustomize.py added by a fix is
			// an interpreter-shadow attempt — a hard cheat, never legitimate.
			flags.push({
				kind: 'shadow_module',
				file: f.path,
				detail: 'a fix added a module that can shadow pytest or hijack interpreter startup',
				severity: 'hard',
			});
			continue;
		}
		if (TEST_PATH.test(p)) {
			flags.push({
				kind: 'test_edit',
				file: f.path,
				detail: 'a test file was modified or added by a fix episode',
				severity: 'soft',
			});
		}
		for (const line of f.addedLines) {
			// Danger patterns (taxonomy §22/§64, diff-scoped): agent-introduced
			// dynamic execution, shell injection surface, or disabled TLS on
			// ADDED lines only — a legacy codebase full of eval is not flagged,
			// only a fix that ADDS one.
			if (/\b(eval|exec)\s*\(/.test(line) && !/#.*\b(eval|exec)/.test(line)) {
				flags.push({
					kind: 'danger_pattern',
					file: f.path,
					detail: `dynamic execution added: "${line.trim().slice(0, 80)}"`,
					severity: 'soft',
				});
			}
			if (/shell\s*=\s*True|os\.system\s*\(/.test(line)) {
				flags.push({
					kind: 'danger_pattern',
					file: f.path,
					detail: `shell execution added: "${line.trim().slice(0, 80)}"`,
					severity: 'soft',
				});
			}
			if (/verify\s*=\s*False/.test(line)) {
				flags.push({
					kind: 'danger_pattern',
					file: f.path,
					detail: `TLS verification disabled: "${line.trim().slice(0, 80)}"`,
					severity: 'soft',
				});
			}
			if (/except\s*(Exception|BaseException)?\s*:\s*(pass|return(\s|$)|\.\.\.)?\s*$/.test(line.trim()) && /except/.test(line)) {
				flags.push({
					kind: 'except_swallow',
					file: f.path,
					detail: `broad exception swallowing added: "${line.trim().slice(0, 80)}"`,
					severity: 'soft',
				});
			}
			if (/\b(sys\.exit\(0\)|os\._exit\(0\))/.test(line)) {
				flags.push({
					kind: 'exit_zero',
					file: f.path,
					detail: `forced success exit added: "${line.trim().slice(0, 80)}"`,
					severity: 'soft',
				});
			}
			if (/pytest\.(skip|xfail)|@pytest\.mark\.(skip|skipif|xfail)|unittest\.skip/.test(line)) {
				flags.push({
					kind: 'skip_marker',
					file: f.path,
					detail: `test-skip marker added: "${line.trim().slice(0, 80)}"`,
					severity: 'soft',
				});
			}
		}
	}
	return flags;
}

/** Parses `git diff <ref>` unified output into per-file added lines. */
export function parseUnifiedDiff(diffText: string): ChangedFile[] {
	const files: ChangedFile[] = [];
	let current: ChangedFile | undefined;
	for (const line of diffText.split('\n')) {
		const header = line.match(/^diff --git a\/(.*) b\/(.*)$/);
		if (header) {
			current = { path: header[2], addedLines: [] };
			files.push(current);
			continue;
		}
		const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (current && hunk) {
			(current.hunks ??= []).push({
				start: Number.parseInt(hunk[1], 10),
				count: hunk[2] !== undefined ? Number.parseInt(hunk[2], 10) : 1,
			});
			continue;
		}
		if (current && line.startsWith('+') && !line.startsWith('+++')) {
			current.addedLines.push(line.slice(1));
		}
	}
	return files;
}

// ---- judge contract --------------------------------------------------------
//
// The JudgeReport TYPE stays here (it is the reward-composition input), but the
// judge PROMPT and its reply parser live in the backend goal binary
// (Vinv/goal/src/goal/agents.py :: judge_diff) — the prompt is IP and must not
// ship in readable extension JS. The extension receives an already-validated
// report via binaryAgents.asJudgeReport; there is no frontend judge prompt.

// ---- reward composition ----------------------------------------------------

/** Default judge threshold above which a soft-flagged pass is failed
 * outright. The judge can only move outcomes toward scrutiny (never fail →
 * pass), so a threshold here caps its power at exactly that one direction.
 * This is the PRIOR — the live value is `policy.judge_cheat_threshold`, a
 * learnable prior passed into composeRewardBreakdown. */
export const JUDGE_CHEAT_THRESHOLD = 0.7;

/**
 * Explicit rubric aggregation over the AVAILABLE signals (weights renormalize
 * when a signal is unavailable/disabled, so a missing signal is missing — not
 * silently counted as passed). The scalar is the ledger/report number; the
 * bandit still trains on the binary verified bit (a shaped scalar would be a
 * softer, more hackable target — see episodePolicyUpdater's doctrine).
 */
export function composeRewardBreakdown(
	oracle: OracleSignal,
	tests: TestSignal,
	flags: AuditFlag[],
	judge: JudgeReport | null,
	regression: TestSignal = 'disabled',
	judgeCheatThreshold: number = JUDGE_CHEAT_THRESHOLD,
	/** How many stated success criteria the task carried (for the
	 * adherence-unchecked visibility reason when the judge is unavailable). */
	statedCriteriaCount = 0,
	/** Oracle-provenance grade of the acceptance set (A best; absent = full
	 * weight for back-compat with pre-grade manifests). A characterization
	 * (E) oracle pins behavior but cannot certify correctness, so its passing
	 * weighs less — anti-self-grading, structurally. */
	acceptanceGrade?: 'A' | 'B' | 'C' | 'D' | 'E',
): RewardBreakdown {
	const reasons: string[] = [];
	const directives: string[] = [];
	const hardFlags = flags.filter((f) => f.severity === 'hard');
	const softFlags = flags.filter((f) => f.severity === 'soft');

	// Rubric components in [0,1] with weights; null weight = signal absent.
	const components: Array<{ score: number; weight: number } | null> = [];

	if (oracle === 'none' || oracle === 'unavailable') {
		components.push(null);
	} else {
		const score = oracle === 'pass_objective' ? 1 : oracle === 'pass_heuristic' ? 0.5 : 0;
		components.push({ score, weight: 0.4 });
		if (oracle === 'fail') {
			reasons.push('oracle: the service replay rejected the fix');
			directives.push('make the recorded start command serve on its port before finishing');
		} else if (oracle === 'pass_heuristic') {
			reasons.push('oracle: portless survival only — not objectively verified');
		}
	}

	if (tests === 'disabled' || tests === 'unavailable' || tests === 'not_discriminating') {
		components.push(null);
		if (tests === 'not_discriminating') {
			reasons.push(
				'tests: generated acceptance tests passed on the BROKEN code — discarded as non-discriminating',
			);
		}
	} else {
		// Grade-weighted tests slice: expected values copied from the
		// implementation (E) certify far less than requirement-derived ones
		// (A). Structural constants, not tuning knobs — the ORDER is the
		// contract; absent grade = full weight (old manifests).
		const GRADE_FACTOR: Record<'A' | 'B' | 'C' | 'D' | 'E', number> = {
			A: 1.0,
			B: 0.9,
			C: 0.9,
			D: 0.85,
			E: 0.6,
		};
		const gradeFactor = acceptanceGrade ? GRADE_FACTOR[acceptanceGrade] : 1.0;
		components.push({ score: tests === 'pass' ? 1 : 0, weight: 0.35 * gradeFactor });
		if (acceptanceGrade && acceptanceGrade > 'A' && tests === 'pass') {
			reasons.push(
				`tests: oracle provenance grade ${acceptanceGrade} — expected values are not fully requirement-derived; passing certifies proportionally less`,
			);
		}
		if (tests === 'fail') {
			reasons.push('tests: the pre-generated acceptance tests still fail after the fix');
			directives.push(
				'the fix does not produce the behavior the issue asks for — address the symptom named in the issue, not only the crash',
			);
		}
	}

	// Regression (pass-to-pass): tests that pinned currently-correct neighbor
	// behavior pre-fix and must still pass. A fail is collateral damage.
	if (regression === 'disabled' || regression === 'unavailable' || regression === 'not_discriminating') {
		components.push(null);
	} else {
		components.push({ score: regression === 'pass' ? 1 : 0, weight: 0.15 });
		if (regression === 'fail') {
			reasons.push(
				'regression: pre-fix-passing tests on neighboring symbols now FAIL — the fix broke behavior it was not asked to change',
			);
			directives.push(
				'restore the neighboring behavior the regression tests pin — fix the issue without collateral changes',
			);
		}
	}

	// Audit cleanliness is always available.
	const auditScore = hardFlags.length > 0 ? 0 : softFlags.length > 0 ? 0.5 : 1;
	components.push({ score: auditScore, weight: 0.1 });
	for (const f of flags) {
		reasons.push(`audit[${f.severity}]: ${f.kind} — ${f.detail} (${f.file})`);
	}
	if (hardFlags.length > 0) {
		directives.push('remove all changes to Vinv verification state under .vinv/');
	}

	// Goal adherence (the "almost right but not what was specified" gate): a
	// stated success criterion the judge reads as not_met is an intent failure
	// even when the code runs and generic tests pass. It contributes a rubric
	// component AND blocks verified-eligibility — a fix that solves a different
	// problem than asked must not count as verified.
	let unmetCriteria = 0;
	if (judge) {
		if (judge.cheat_likelihood >= judgeCheatThreshold) {
			reasons.push(
				`judge: cheat likelihood ${judge.cheat_likelihood.toFixed(2)} — ${judge.concerns.join('; ') || 'no detail'}`,
			);
		}
		if (judge.criteria_verdicts.length > 0) {
			unmetCriteria = judge.criteria_verdicts.filter((c) => c.verdict === 'not_met').length;
			const met = judge.criteria_verdicts.filter((c) => c.verdict === 'met').length;
			// Adherence score = fraction of stated criteria met; unverifiable
			// criteria are excluded from the denominator (missing evidence, not a
			// failure) so the score reflects only what could be judged.
			const judged = judge.criteria_verdicts.filter((c) => c.verdict !== 'unverifiable').length;
			if (judged > 0) {
				components.push({ score: met / judged, weight: 0.2 });
			}
			for (const c of judge.criteria_verdicts) {
				if (c.verdict === 'not_met') {
					reasons.push(`goal: criterion NOT MET — "${c.criterion}": ${c.reason}`);
					directives.push(`meet the stated criterion: ${c.criterion}`);
				}
			}
		}
		if (judge.scope_drift === 'major') {
			reasons.push('goal: the change strays well beyond the goal’s scope (instruction drift)');
			directives.push('keep the change within the goal’s scope — revert unrelated edits');
		}
		directives.push(...judge.directives);
	} else if (statedCriteriaCount > 0) {
		// Criteria existed but no judge could run (old binary / no LM): the pass
		// is NOT blocked (MNAR — an unrunnable check is not a verdict), but it
		// must be visibly distinguishable from an adherence-judged pass.
		reasons.push(
			`goal-adherence unchecked: ${statedCriteriaCount} stated criteria could not be judged (adherence judge unavailable)`,
		);
	}

	const available = components.filter((c): c is { score: number; weight: number } => c !== null);
	const totalWeight = available.reduce((a, c) => a + c.weight, 0);
	const reward =
		totalWeight > 0 ? available.reduce((a, c) => a + c.score * c.weight, 0) / totalWeight : 0;

	// A pass may count as verified+objective only when: no hard flags, the judge
	// (when it ran) did not cross the cheat threshold, AND no stated success
	// criterion is not_met. Soft flags alone do not block — they were either
	// judged below threshold or the judge was unavailable, in which case they
	// ride into the escalation text instead.
	const verifiedEligible =
		hardFlags.length === 0 &&
		unmetCriteria === 0 &&
		(judge === null || judge.cheat_likelihood < judgeCheatThreshold);
	// Precedence: conduct findings outrank spec findings (a cheating change
	// that also misses a criterion is reported as cheating).
	const verifiedBlockCause: RewardBreakdown['verifiedBlockCause'] = verifiedEligible
		? 'none'
		: hardFlags.length > 0
			? 'hard_flag'
			: judge !== null && judge.cheat_likelihood >= judgeCheatThreshold
				? 'cheat'
				: 'criteria';

	return {
		oracle,
		tests,
		regression,
		flags,
		judge,
		reward: Math.round(reward * 1000) / 1000,
		verifiedEligible,
		verifiedBlockCause,
		reasons,
		directives: [...new Set(directives)],
	};
}

/** Renders the breakdown as the pack's reward report (why the score is what
 * it is, and exactly what raises it) — the feedback half of the loop. */
export function renderRewardReport(b: RewardBreakdown): string {
	const lines: string[] = [];
	const unmet = b.judge?.criteria_verdicts.filter((c) => c.verdict === 'not_met').length ?? 0;
	lines.push(
		`reward ${b.reward.toFixed(2)} — oracle: ${b.oracle}; tests: ${b.tests}; regression: ${b.regression}; ` +
			`unmet criteria: ${unmet}; audit flags: ${b.flags.length}`,
	);
	if (b.reasons.length) {
		lines.push('why:');
		for (const r of b.reasons) {
			lines.push(`- ${r}`);
		}
	}
	if (b.directives.length) {
		lines.push('to raise the reward, the next attempt must:');
		for (const d of b.directives) {
			lines.push(`- ${d}`);
		}
	}
	return lines.join('\n');
}

// ---- test-generation prompt ------------------------------------------------

/**
 * The acceptance-test generation prompt. Approach-guided rather than
 * rule-hardcoded: it teaches HOW to derive a discriminating test (reproduce
 * the symptom; assert the specific post-fix behavior; AssertFlip inversion
 * when direct assertion is awkward — arXiv 2507.17542), and the mechanical
 * gate (must fail on current code) does the enforcement. The generated file
 * is written OUTSIDE the workspace by Vinv and never shown to the fixing
 * agent (ImpossibleBench: hiding tests collapses cheat rates).
 */
export function buildTestGenPrompt(
	title: string,
	issue: string,
	goal: string | undefined,
	symbolContext: string,
): string {
	const lines: string[] = [];
	lines.push(`You are the acceptance-test author for an automated fix loop. Task: ${title}`);
	lines.push('');
	lines.push('A coding agent will attempt a fix AFTER you write these tests. Your tests are the');
	lines.push('oracle deciding whether that fix actually meets the issue, so they must be tests the');
	lines.push('CURRENT (broken) code FAILS and a genuinely fixed code passes.');
	lines.push('');
	lines.push('## Issue');
	lines.push(issue);
	lines.push('');
	if (goal) {
		lines.push('## Standing goal');
		lines.push(goal);
		lines.push('');
	}
	lines.push('## Relevant symbols (import the narrowest of these directly)');
	lines.push(symbolContext);
	lines.push('');
	lines.push('## How to approach it');
	lines.push('1. Reproduce the SYMPTOM the issue names, at the narrowest scope that shows it:');
	lines.push('   import the specific function/module above rather than booting the whole service.');
	lines.push('2. Assert the specific behavior a correct fix produces (the value, the absence of the');
	lines.push('   named exception, the shape of the result) — not vague truths like "is not None".');
	lines.push('3. If asserting the fixed behavior directly is awkward, write the test that PASSES on');
	lines.push('   the broken code by exercising the bug, then INVERT the assertion so it fails now');
	lines.push('   and passes when fixed.');
	lines.push('4. Deterministic only: no network, no sleeping on timing, no randomness without a seed,');
	lines.push('   no dependence on global state you did not set up.');
	lines.push('5. Every test must be ABLE to fail — an assertion that any implementation satisfies is');
	lines.push('   worthless and will be discarded.');
	lines.push('');
	lines.push('## Output contract (strict)');
	lines.push('- Do NOT create, modify, or delete ANY file in the repository.');
	lines.push('- Output the complete test file as ONE fenced code block labeled `python-acceptance`.');
	lines.push('- Use plain pytest-style `def test_*` functions with `assert`, plus this exact footer so');
	lines.push('  the file also runs without pytest:');
	lines.push('```');
	lines.push('if __name__ == "__main__":');
	lines.push('    import sys, traceback');
	lines.push('    failed = 0');
	lines.push('    for name, fn in sorted(globals().items()):');
	lines.push('        if name.startswith("test_") and callable(fn):');
	lines.push('            try:');
	lines.push('                fn()');
	lines.push('            except Exception:');
	lines.push('                failed += 1');
	lines.push('                traceback.print_exc()');
	lines.push('    sys.exit(1 if failed else 0)');
	lines.push('```');
	return lines.join('\n');
}
