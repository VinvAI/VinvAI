/**
 * Stall breaker — how a loop ENDS when it stops making progress, without a
 * dumb retry counter and without an infinite spin.
 *
 * Detection: two consecutive failures whose evidence is near-identical
 * (token-set Jaccard over the full evidence text — a similarity measure, not
 * a truncation) mean the agent is walking in a circle.
 *
 * Decision: a two-stance judgement between —
 *   EXPLORER: values another attempt IF the approach changes (information
 *   gain, chance of success);
 *   AUDITOR: values the user's time, API spend, and the risk of compounding
 *   a bad change.
 * An LLM judge (strict JSON contract, retry-on-violation, abstain =
 * escalate) reads the actual evidence and reports each stance's utility for
 * each action in [0,1], plus a concrete approach mutation. The rule is the
 * Nash-product argmax ∏(u_i − d_i) over the disagreement point d = escalate,
 * but note this is the DEGENERATE two-point case (continue vs escalate, and
 * escalate IS the disagreement point), so the "bargaining" collapses to a
 * plain UNANIMITY / Pareto test: continue iff BOTH stances strictly prefer it
 * to asking the human — which is exactly when autonomy is justified. It is not
 * a surplus-splitting bargain (the two agents are cooperative, not adversarial,
 * per the SOTA critique); the product's magnitude is logged but only its sign
 * decides. Ties or contract exhaustion escalate; the system never spins.
 *
 * The verdict can also EXTEND the attempt budget (agent-analyzed budget, up
 * to the policy ceiling) when the judge shows both stances gain from one
 * more, mutated attempt.
 */
import { asStallUtilities } from './binaryAgents';

/** Tokenizes for similarity: lowercase word/number runs, order-free. */
function tokenSet(text: string): Set<string> {
	return new Set((text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 1));
}

/** Jaccard similarity of the token sets of two evidence texts, in [0,1]. */
export function evidenceSimilarity(a: string, b: string): number {
	const sa = tokenSet(a);
	const sb = tokenSet(b);
	if (sa.size === 0 && sb.size === 0) {
		return 1;
	}
	let intersection = 0;
	for (const t of sa) {
		if (sb.has(t)) {
			intersection += 1;
		}
	}
	const union = sa.size + sb.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** The judge's utility report — validated against this exact contract. */
export interface StallUtilities {
	/** Explorer's utility for one more (mutated) attempt vs escalating now. */
	explorer_continue: number;
	explorer_escalate: number;
	/** Auditor's utility for the same two actions. */
	auditor_continue: number;
	auditor_escalate: number;
	/** The concrete approach change a continued attempt MUST adopt. */
	mutation: string;
}

export interface StallVerdict {
	action: 'continue' | 'escalate';
	/** Nash products for both actions (logged for the ledger). */
	nash_continue: number;
	nash_escalate: number;
	/** Approach mutation injected into the next pack when continuing. */
	mutation: string;
}

// The stall judge PROMPT and reply parser live in the backend goal binary
// (Vinv/goal/src/goal/agents.py :: judge_stall) — IP stays out of readable
// extension JS. The extension validates the backend's utilities via
// binaryAgents.asStallUtilities; the StallUtilities type is the Nash rule's
// input, kept here.

/**
 * The Nash bargaining decision given the judge's utilities. Disagreement
 * point = escalation (its utilities are the baseline both stances fall back
 * to), so continuing needs BOTH stances strictly above their escalation
 * utility; otherwise a factor of the Nash product is ≤ 0 and escalate wins.
 */
export function nashDecision(u: StallUtilities): StallVerdict {
	const gainExplorer = u.explorer_continue - u.explorer_escalate;
	const gainAuditor = u.auditor_continue - u.auditor_escalate;
	const nashContinue = gainExplorer > 0 && gainAuditor > 0 ? gainExplorer * gainAuditor : 0;
	// Escalation is the disagreement point itself: product of zero gains.
	const nashEscalate = 0;
	return {
		action: nashContinue > nashEscalate ? 'continue' : 'escalate',
		nash_continue: nashContinue,
		nash_escalate: nashEscalate,
		mutation: u.mutation,
	};
}

/** The transport a stall adjudication uses: a backend-agent invocation that
 * resolves the raw `judge-stall` result or null. Injectable for tests. */
export type StallJudgeTransport = (payload: {
	task: string;
	evidence_a: string;
	evidence_b: string;
}) => Promise<Record<string, unknown> | null>;

/**
 * Full stall adjudication: the ENGINE-side stall judge (goal engine
 * `judge-stall`, never an extension-side chat completion) reports the two
 * stances' utilities; the Nash-unanimity decision is applied here. Transport
 * failure, an old engine, or a contract miss escalate — the safe disagreement
 * outcome.
 */
export async function breakStall(
	taskTitle: string,
	evidenceA: string,
	evidenceB: string,
	judge: StallJudgeTransport,
): Promise<StallVerdict> {
	let raw: Record<string, unknown> | null = null;
	try {
		raw = await judge({ task: taskTitle, evidence_a: evidenceA, evidence_b: evidenceB });
	} catch {
		raw = null;
	}
	const utilities = asStallUtilities(raw);
	if (!utilities) {
		return {
			action: 'escalate',
			nash_continue: 0,
			nash_escalate: 0,
			mutation: 'judge unavailable — escalating to the user',
		};
	}
	return nashDecision(utilities);
}
