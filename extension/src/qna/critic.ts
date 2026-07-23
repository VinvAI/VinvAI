/**
 * Deterministic answer critic: objective, zero-LLM checks of an Ask Vinv
 * answer against the evidence that was actually served.
 *
 * The retrial loop currently escalates only on the model's SELF-reported
 * insufficiency — self-report the literature pegs as unreliable (11–57%
 * citation hallucination across deployed systems). The critic adds the checks
 * that need no judgment call:
 *
 *  - CITATION GROUNDING (retrial-triggering): every `path:line` citation in
 *    the answer must name a file the index knows. A cited file absent from
 *    the graph is objectively not grounded in the served evidence — either
 *    hallucinated or outside the indexed tree — and becomes a `missing` item
 *    for the next (existing, bounded) retrial. Line numbers are deliberately
 *    NOT checked: indexed line spans drift against live files by design.
 *
 *  - RUNTIME-TENSE and STALENESS warnings (telemetry-only): cited symbols
 *    whose failures are all superseded but whose error type the answer still
 *    discusses, and cited stale-flagged symbols the answer never hedges.
 *    These involve reading tense from prose, so they are logged for
 *    precision measurement — they never trigger retrials and never feed
 *    rewards until the ledger shows they deserve to (the same promotion
 *    discipline every other prior follows).
 *
 * Pure functions over the evidence bundle — headless-testable, no vscode.
 */
import type { GraphSnapshot } from '../graph/indexGraph';
import type { QnaEvidence } from './answer';

export interface CriticReport {
	/** `path:line` citations found in the answer body. */
	citations: string[];
	/** Citations whose file resolves to no node file in the snapshot. */
	ungrounded: string[];
	/** Telemetry-only observations (tense/staleness heuristics). */
	warnings: string[];
	/** True when at least one citation exists and all of them ground. */
	grounded: boolean;
}

/** Matches `some/path/file.ext:123` (optionally `:123-456`). */
const CITATION_RE = /([A-Za-z0-9_\-./]+\.[A-Za-z0-9_]+):(\d+)(?:-\d+)?/g;

/**
 * Path-suffix match with separator alignment: `auth.py` must not match
 * `oauth.py`. Answers cite paths at whatever depth the prompt showed, so the
 * cited path may be a suffix of the indexed path or vice versa.
 */
function fileMatches(cited: string, indexed: string): boolean {
	if (cited === indexed) {
		return true;
	}
	return (
		(indexed.length > cited.length && indexed.endsWith('/' + cited)) ||
		(cited.length > indexed.length && cited.endsWith('/' + indexed))
	);
}

/** Runs every check; see the module doc for which ones may trigger retrials. */
export function critiqueAnswer(
	snapshot: GraphSnapshot,
	evidence: QnaEvidence,
	answerBody: string,
): CriticReport {
	const files = [...new Set(snapshot.nodes.map((n) => n.file).filter(Boolean))];
	const citations: string[] = [];
	const ungrounded: string[] = [];
	const seen = new Set<string>();
	for (const m of answerBody.matchAll(CITATION_RE)) {
		const cite = `${m[1]}:${m[2]}`;
		if (seen.has(cite)) {
			continue;
		}
		seen.add(cite);
		citations.push(cite);
		const cited = m[1].replace(/^\.\//, '');
		if (!files.some((f) => fileMatches(cited, f))) {
			ungrounded.push(cite);
		}
	}

	const warnings: string[] = [];
	for (const n of evidence.slice) {
		const rt = snapshot.runtime[n.row];
		if (!rt || !answerBody.includes(n.name)) {
			continue;
		}
		const allSuperseded =
			rt.failures.length > 0 &&
			rt.failures.every((f) => f.superseded !== null) &&
			rt.current_errors === 0;
		if (allSuperseded) {
			for (const f of rt.failures) {
				if (f.error_type && answerBody.includes(f.error_type)) {
					warnings.push(
						`tense: answer discusses ${f.error_type} of ${n.name} whose failures are all superseded`,
					);
					break;
				}
			}
		}
		const stale = snapshot.store_epoch > 0 && n.epoch === snapshot.store_epoch;
		if (stale && rt.calls > 0 && !/stale|changed since|may be outdated/i.test(answerBody)) {
			warnings.push(`staleness: answer cites ${n.name} whose runtime facts are stale, without hedging`);
		}
	}

	return {
		citations,
		ungrounded,
		warnings,
		grounded: citations.length > 0 && ungrounded.length === 0,
	};
}
