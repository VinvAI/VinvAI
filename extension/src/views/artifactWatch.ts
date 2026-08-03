/**
 * What a `.vinv` change is allowed to mean to a background source.
 *
 * Two sources watch the artifact directory wholesale — FlowStateSource and
 * ReportMirrorSource — and both re-derive their whole model on any event. That
 * made two problems the sources could not see individually:
 *
 * 1. VOLUME. `.vinv/runs/**` holds one full git checkout per isolated harness
 *    run plus a per-run trajectory log, and `.vinv/logs/**` streams agent
 *    output line by line. Neither contributes a single fact to either model,
 *    yet an agent working for a minute produced thousands of events, each
 *    re-arming a debounce that then ran a full recompute.
 *
 * 2. FEEDBACK. Each source excluded only its OWN outputs, so FlowStateSource's
 *    mirror write woke ReportMirrorSource and vice versa. The pair converged
 *    (both writes are change-gated) but paid an extra full round of both models
 *    on every artifact change.
 *
 * One shared predicate fixes both: a source's model is only ever rebuilt for a
 * path that some model actually reads.
 */
import * as path from 'path';

/**
 * Subtrees of `.vinv` that no view model derives from.
 *
 * `runs` and `logs` are per-run scratch and audit output. `tmp` is exactly what
 * it says. They are matched as path SEGMENTS, so a capture that happens to have
 * "logs" in a service name is unaffected.
 */
const IGNORED_SUBTREES = new Set(['runs', 'logs', 'tmp']);

/**
 * Files the background sources WRITE. A source must never rebuild because
 * another source published — that is a feedback loop, not new evidence.
 */
const SOURCE_OUTPUTS = new Set(['flow_state.json', 'findings.json', 'journey.json']);

/**
 * True when a changed path under `.vinv` should rebuild a background model.
 *
 * Takes the absolute path of the changed file; anything outside a `.vinv`
 * directory is treated as relevant (the caller's glob already scoped it, and
 * refusing an unrecognised path would silently freeze a model).
 */
export function isModelRelevantArtifact(fsPath: string): boolean {
	const normalized = fsPath.replace(/\\/g, '/');
	if (SOURCE_OUTPUTS.has(path.basename(normalized))) {
		return false;
	}
	const segments = normalized.split('/');
	const vinvAt = segments.lastIndexOf('.vinv');
	if (vinvAt === -1) {
		return true;
	}
	const subtree = segments[vinvAt + 1];
	return subtree === undefined || !IGNORED_SUBTREES.has(subtree);
}
