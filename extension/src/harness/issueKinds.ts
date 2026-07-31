/**
 * What a behavioral failure cluster's `kind` means — shape, actionability, and
 * where its evidence lives.
 *
 * Pure (no vscode import) on purpose. These three questions are asked by the
 * dispatch path (exerciseRunner, which owns the harness and therefore vscode)
 * AND by the Findings surface, which is a pure filesystem read unit-tested on
 * fixtures. Keeping the answers here is what lets both ask the same one.
 */

/**
 * Kinds where the code ANSWERED and the answer was wrong — no exception, no 5xx.
 *
 * The HTTP oracle contributes two. The five newer oracles contribute three more,
 * and getting them into this set is not cosmetic: an error-shaped dispatch tells
 * the fixing agent "these calls no longer raise", which is VACUOUS against a
 * silent wrong value — the target never raised in the first place, so the
 * criterion is satisfied by changing nothing.
 */
const ASSERT_SHAPED_KINDS: ReadonlySet<string> = new Set([
	'invariant-violation', // learned invariant broken on a 2xx
	'baseline-degraded', // value changed against a value-stable golden
	'differential-mismatch', // computed a different value than the reference
	'fault-divergence', // aggregate differs by chunk-split point
	'concurrency-divergence', // concurrent results collapse vs the serial baseline
]);

/**
 * Assert-shaped cluster kinds: the service ANSWERED (usually 2xx) but its
 * output broke a learned invariant or regressed against the golden baseline —
 * "output changed but nothing raised". These dispatch with value-shaped
 * success criteria; "no longer produces these errors" would be vacuous.
 */
export function isAssertShapedKind(kind: string): boolean {
	return ASSERT_SHAPED_KINDS.has(kind);
}

/**
 * Kinds that are DIAGNOSTICS about the environment, never defects in this repo —
 * so they must never become a fix episode.
 *
 * `signature-drift` is an upstream dependency changing its own API. There is no
 * edit to this repo that "fixes" it, and dispatching an agent at it burns a fix
 * budget on something it cannot resolve. It still belongs in issues.json as
 * evidence; it just must not be actioned.
 */
const NON_DISPATCHABLE_KINDS: ReadonlySet<string> = new Set(['signature-drift']);

/** Whether a cluster kind should become a fix episode at all. */
export function isDispatchableKind(kind: string): boolean {
	return !NON_DISPATCHABLE_KINDS.has(kind);
}

/**
 * Where the evidence for a cluster kind actually lives.
 *
 * The dispatch text used to hardcode "results.jsonl" for everything, which is
 * the HTTP oracle's artifact. Pointing a fixing agent at an empty file is worse
 * than pointing it nowhere — it reads the miss as "no evidence exists".
 */
export function evidenceFileForKind(kind: string): string {
	switch (kind) {
		case 'function-crash':
		case 'function-sandboxed':
		// An import failure is produced by the FUNCTION oracle and its rows live
		// in that oracle's artifact, like every other kind here. Missing from
		// this switch, it fell through to the HTTP oracle's `results.jsonl` —
		// the exact "points a fixing agent at an empty file" failure this
		// function was written to stop, reproduced for the one kind that fires
		// most on an unconfigured repo.
		case 'import-error':
			return 'function_results.jsonl';
		// The invocation oracle drives a `python_cli` / `python_library` unit —
		// a repo with no service to send requests to. Its rows are the only
		// evidence such a repo produces, and `results.jsonl` there is empty.
		case 'invocation-failure':
		case 'invocation-timeout':
			return 'invocation_results.jsonl';
		case 'differential-mismatch':
			return 'differential_results.jsonl';
		case 'fault-crash':
		case 'fault-divergence':
			return 'fault_results.jsonl';
		case 'concurrency-divergence':
		case 'concurrency-hang':
			return 'concurrency_results.jsonl';
		case 'signature-drift':
			return 'signatures.json';
		default:
			return 'results.jsonl';
	}
}
