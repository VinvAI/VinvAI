/**
 * Reward ↔ human-feedback reconciliation — the oracle-disagreement protocol.
 *
 * The verification chain (replay oracle + agent-invisible tests + adherence
 * judge) can mark an episode verified while the HUMAN, looking at the result,
 * says it is still wrong. That is a weak-oracle event: the tests missed a
 * behavior the human cares about. The taxonomy's principle (never let the
 * producer grade itself; use independent + human oracles) demands a
 * resolution, but neither it nor the SWE-bench literature gives one — so this
 * is Vinv's protocol, and it is deliberately NOT "average two disagreeing
 * scalars" (which would be hackable and would discard the human's signal).
 *
 * Instead the human's dissatisfaction is CONVERTED INTO A REPRODUCIBLE TEST:
 *
 *   1. The human is asked ONE targeted question: what behavior is still wrong
 *      (an input, an expected-vs-actual, or a violated rule)?
 *   2. Their answer is handed to the backend author-tests agent as a
 *      "counterexample" lens — a test that must FAIL on the current
 *      (supposedly-fixed) code, encoding exactly the behavior the human says
 *      is broken.
 *   3. If that test FAILS on current code, the human found a real gap the
 *      oracle missed: the verified bit is RETRACTED, the test graduates into
 *      the episode's acceptance pool (durable regression coverage — the
 *      taxonomy's "every incident → a regression test"), and a new episode is
 *      dispatched with the strengthened oracle. This is objective negative
 *      evidence (a reproducible failing test), so it legitimately trains the
 *      bandit — unlike a bare thumbs-down.
 *   4. If the counterexample test does NOT fail on current code, the human's
 *      described behavior is actually already satisfied (or they could not
 *      articulate a failing case): the verdict stands, and the human is shown
 *      what the tests check (transparency, never a silent override).
 *   5. If the human gives NO feedback, the reward is UNCHANGED (missing-not-
 *      at-random — the same discipline the retrieval ledger uses); no
 *      fabricated signal.
 *
 * This module is the pure decision logic; the extension wires the question UI,
 * the author-tests call, and the re-dispatch.
 */

/** The human's reaction to a verified/serving result. */
export type HumanReaction = 'accept' | 'reject_no_detail' | 'reject_with_detail' | 'no_response';

/** The outcome of validating a counterexample test on the current code. */
export type CounterexampleResult = 'reproduces' | 'does_not_reproduce' | 'unavailable';

export interface ReconciliationDecision {
	/** What the loop should do next. */
	action:
		| 'stand' // verdict unchanged (accept, or non-reproducing counterexample)
		| 'ask' // ask the human for the counterexample detail
		| 'retract_and_redispatch' // human found a real gap; strengthen + re-run
		| 'unchanged'; // no response — reward stays, MNAR
	/** Whether the episode's verified bit must be retracted. */
	retractVerified: boolean;
	/** Whether the counterexample test should join the durable acceptance pool. */
	graduateTest: boolean;
	/** Human-facing explanation of the decision. */
	message: string;
}

/**
 * The reconciliation state machine. Pure: given the human's reaction (and,
 * once a counterexample test has been authored+run, its result), returns the
 * course of action. The caller drives it in two steps — first with the
 * reaction (to decide whether to ASK), then again with the counterexample
 * result (to decide whether to RETRACT).
 */
export function reconcile(
	reaction: HumanReaction,
	counterexample?: CounterexampleResult,
): ReconciliationDecision {
	if (reaction === 'accept') {
		return {
			action: 'stand',
			retractVerified: false,
			graduateTest: false,
			message: 'accepted — the verified result stands',
		};
	}
	if (reaction === 'no_response') {
		return {
			action: 'unchanged',
			retractVerified: false,
			graduateTest: false,
			message: 'no counterexample given — the verified result stands unchanged',
		};
	}
	if (reaction === 'reject_no_detail') {
		// The human disagrees but hasn't said what is wrong yet — ask once. A
		// bare rejection is too weak to retract an evidence-backed verdict.
		return {
			action: 'ask',
			retractVerified: false,
			graduateTest: false,
			message:
				'the checks passed but you flagged this — what behavior is still wrong? ' +
				'(an input, an expected-vs-actual value, or a rule it violated)',
		};
	}
	// reject_with_detail: the human described a failing behavior. The decision
	// hinges on whether a counterexample test built from it actually reproduces.
	if (counterexample === undefined) {
		return {
			action: 'ask',
			retractVerified: false,
			graduateTest: false,
			message: 'authoring a counterexample test from your description…',
		};
	}
	if (counterexample === 'reproduces') {
		return {
			action: 'retract_and_redispatch',
			retractVerified: true,
			graduateTest: true,
			message:
				'your counterexample reproduces on the current code — the oracle missed it. ' +
				'Retracting the verified result, adding your case as a permanent test, and re-dispatching.',
		};
	}
	if (counterexample === 'does_not_reproduce') {
		return {
			action: 'stand',
			retractVerified: false,
			graduateTest: false,
			message:
				'a test built from your description passes on the current code, so the behavior you ' +
				'described appears satisfied — the verdict stands. Here is what the tests check.',
		};
	}
	// unavailable: could not run the counterexample — do not silently retract on
	// an unrunnable check; keep the verdict but surface the inconclusive result.
	return {
		action: 'stand',
		retractVerified: false,
		graduateTest: false,
		message:
			'could not run a counterexample test from your description (no interpreter / harness), ' +
			'so the automated verdict is unchanged — please verify by hand.',
	};
}

/** The approach directive handed to the author-tests agent to encode a human
 * counterexample as a fail-on-current test — the "counterexample lens". */
export function counterexampleApproach(humanDescription: string): string {
	return [
		'COUNTEREXAMPLE (fail-to-pass): the automated checks passed, but a human reviewer says the',
		'code is STILL WRONG. Encode exactly the behavior they describe as a test that FAILS on the',
		'current code and would pass only when that behavior is corrected. Assert the specific',
		'expected-vs-actual the reviewer names — do not broaden it. The reviewer said:',
		humanDescription.trim(),
	].join('\n');
}
