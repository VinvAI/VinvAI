/**
 * What the operator actually asked for.
 *
 * Vinv used to have exactly one noun — `issue`. Every entry point (the palette,
 * the QnA dispatch, the MCP `fix` tool, the auto-triggers) funnelled its text
 * into a task whose success criteria asserted that a defect existed and had to
 * be resolved by a change. A question ("what does the license API do and how
 * can we optimize it?") therefore arrived at the agent with a criterion it
 * could not honestly tick, because nothing was broken. The only exit the loop
 * offered was the dispute channel — so correct behaviour (investigate, report,
 * propose) was escalated to the human as a premise conflict, with buttons that
 * read "agree there is no issue" / "the issue is real". Neither is what the
 * operator wanted: they wanted the answer, and then the proposed work.
 *
 * Classifying up front is what makes the rest of the loop honest: criteria that
 * can be satisfied, an `answered` terminal state that counts as success, and a
 * proposal channel instead of a dispute.
 */
export type TaskIntent = 'question' | 'defect';

/**
 * Words that open a request for understanding rather than repair. Matched only
 * at the START of the text (or of a clause after "and"/"also") — "explain" mid
 * sentence ("the crash is hard to explain") is not a question.
 */
const QUESTION_OPENERS =
	/(?:^|\band\s+|\balso\s+|\bthen\s+)(?:what|how|why|when|where|which|who|whose|does|do|did|is|are|was|were|can|could|should|would|explain|describe|walk\s+me\s+through|tell\s+me)\b/i;

/**
 * Concrete failure nouns. Their presence means there is real evidence of
 * something broken, so an interrogative framing ("why does the server crash?")
 * is a request to DIAGNOSE a defect, not a request for a tour of the code.
 */
const DEFECT_SIGNALS =
	/\b(?:fix|broken|breaks?|broke|fails?|failed|failing|failure|crash(?:e[sd])?|error|errors|exception|traceback|stack\s*trace|regression|hang(?:s|ing)?|deadlock|leak(?:s|ing)?|times?\s*out|timeout|not\s+working|doesn'?t\s+work|won'?t\s+start|500|503|segfault|panic)\b/i;

/**
 * Classifies free operator text into the intent the loop should run under.
 *
 * The rule, in order:
 *   1. Real failure evidence present  -> 'defect', even when phrased as a
 *      question ("why does bringup fail?" is a diagnosis request).
 *   2. Otherwise an interrogative opening or a trailing '?' -> 'question'.
 *   3. Otherwise 'defect' — a bare imperative ("optimize the license API",
 *      "add a cache") expects a change, and that is the status quo behaviour.
 *
 * Deliberately a pure heuristic over the text, not an LLM call: task
 * construction is on the dispatch path, must be deterministic for the ledger,
 * and must stay unit-testable.
 */
export function classifyIntent(text: string): TaskIntent {
	const t = text.trim();
	if (!t) {
		return 'defect';
	}
	if (DEFECT_SIGNALS.test(t)) {
		return 'defect';
	}
	if (QUESTION_OPENERS.test(t) || /\?\s*$/.test(t)) {
		return 'question';
	}
	return 'defect';
}

/**
 * The success criteria for a task, derived from its intent.
 *
 * A question's criteria must be satisfiable WITHOUT changing code — that is the
 * whole point. They also tell the agent explicitly to propose rather than
 * apply, which is what feeds the proposal channel (see `parseHarnessProposals`)
 * and lets the operator pick the follow-up work instead of arbitrating a
 * dispute.
 */
export function criteriaFor(intent: TaskIntent, service?: string): string[] {
	if (service) {
		return [
			`The recorded start command in .vinv/start_commands/${service}.json starts the service in the foreground and it keeps running`,
			'The service accepts connections on its recorded port (when one is recorded)',
		];
	}
	if (intent === 'question') {
		return [
			'The question is answered directly, grounded in the indexed symbols and files the answer names',
			'Findings that would require a code change are PROPOSED (see the vinv: proposal channel), not applied',
			'If nothing is wrong, saying so plainly is a complete and correct answer',
		];
	}
	// A free-text defect gets NO criteria: these would only ever be generic
	// restatements of the issue, and a generic criterion that cannot be checked
	// hard-gates an otherwise-verified pass. Scope-drift and regression tests
	// cover this case instead.
	return [];
}
