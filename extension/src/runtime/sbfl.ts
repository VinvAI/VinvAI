/**
 * D1 — Spectrum-Based Fault Localization (SBFL), Ochiai.
 *
 * Given many requests in the trace, each is a "run" that either passed or failed
 * (a run fails when any call in it exited with `status: "error"`). A symbol that
 * runs in most *failed* runs but rarely in *passed* runs is a strong suspect;
 * one that runs everywhere (passing and failing alike) is not. SBFL turns those
 * co-occurrence counts into a suspiciousness score, ranking the symbols an agent
 * should look at first — purely by observing the run spectra, changing nothing.
 *
 * Ochiai:  suspiciousness = ef / sqrt((ef + nf) * (ef + ep))
 *   ef = failed runs the symbol executed in
 *   ep = passed runs the symbol executed in
 *   nf = failed runs the symbol did NOT execute in
 *   (ef + nf) = total failed runs;  (ef + ep) = total runs the symbol executed in
 */
import { TraceCorpus } from './traceStore';

export interface Suspect {
	component: string;
	/** Ochiai suspiciousness in [0, 1]; higher = look here first. */
	score: number;
	/** Failed runs this symbol executed in. */
	failedWith: number;
	/** Passed runs this symbol executed in. */
	passedWith: number;
	/** Runs in which this symbol itself raised (direct error observations). */
	directErrors: number;
	/** Distinct error types observed directly on this symbol. */
	errorTypes: string[];
	/** Distinct "Type: message" identities observed directly on this symbol. */
	errorMessages: string[];
}

export interface SbflResult {
	totalRuns: number;
	failedRuns: number;
	passedRuns: number;
	/** True when there's no contrast to rank on (no failures, or only one class). */
	degenerate: boolean;
	suspects: Suspect[];
}

/**
 * Ranks symbols by Ochiai suspiciousness over the corpus's per-request pass/fail
 * spectra. When there are no failed runs (or no passed runs to contrast against)
 * the ranking is degenerate — we still return per-symbol error counts so the
 * caller can fall back to "symbols that directly errored".
 */
export function rankSuspects(corpus: TraceCorpus, limit = 20): SbflResult {
	const runs = [...corpus.byRequest.values()];
	const totalRuns = runs.length;
	const failedRuns = runs.filter((r) => r.failed).length;
	const passedRuns = totalRuns - failedRuns;

	// Per-symbol executed-in-failed / executed-in-passed tallies.
	const failedWith = new Map<string, number>();
	const passedWith = new Map<string, number>();
	for (const run of runs) {
		const bucket = run.failed ? failedWith : passedWith;
		for (const component of run.components) {
			bucket.set(component, (bucket.get(component) ?? 0) + 1);
		}
	}

	// Direct error observations per symbol (a call that itself raised). The
	// message travels with the type: a suspect list that can say "[Errno 5]
	// Input/output error" localizes a fault; one that can only say "OSError"
	// merely names a class.
	const directErrors = new Map<string, number>();
	const errorTypes = new Map<string, Set<string>>();
	const errorMessages = new Map<string, Set<string>>();
	for (const [component, rec] of corpus.bySymbol) {
		for (const exit of rec.exits) {
			if (exit.status === 'error') {
				directErrors.set(component, (directErrors.get(component) ?? 0) + 1);
				if (exit.error_type) {
					let set = errorTypes.get(component);
					if (!set) {
						set = new Set();
						errorTypes.set(component, set);
					}
					set.add(exit.error_type);
					if (exit.error_message) {
						let msgs = errorMessages.get(component);
						if (!msgs) {
							msgs = new Set();
							errorMessages.set(component, msgs);
						}
						msgs.add(`${exit.error_type}: ${exit.error_message}`);
					}
				}
			}
		}
	}

	const components = new Set<string>([...failedWith.keys(), ...passedWith.keys()]);
	const suspects: Suspect[] = [];
	for (const component of components) {
		const ef = failedWith.get(component) ?? 0;
		const ep = passedWith.get(component) ?? 0;
		const denom = Math.sqrt(failedRuns * (ef + ep));
		const score = denom > 0 ? ef / denom : 0;
		suspects.push({
			component,
			score,
			failedWith: ef,
			passedWith: ep,
			directErrors: directErrors.get(component) ?? 0,
			errorTypes: [...(errorTypes.get(component) ?? [])],
			errorMessages: [...(errorMessages.get(component) ?? [])],
		});
	}

	// Primary sort by Ochiai; break ties by direct errors then breadth of failure
	// involvement so the most concretely-implicated symbol wins.
	suspects.sort(
		(a, b) =>
			b.score - a.score ||
			b.directErrors - a.directErrors ||
			b.failedWith - a.failedWith,
	);

	return {
		totalRuns,
		failedRuns,
		passedRuns,
		degenerate: failedRuns === 0 || passedRuns === 0,
		suspects: suspects.slice(0, limit),
	};
}
