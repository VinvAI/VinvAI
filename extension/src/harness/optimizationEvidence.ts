/**
 * Offloaded optimization evidence — the context-offload half of the pack
 * composer's offload/reload protocol.
 *
 * An optimization episode's heavy evidence (the candidate's span proof and the
 * persisted prior-attempt history) is written ONCE per opportunity signature to
 * `.vinv/context/opt-<signature>.md`; every context pack for that opportunity
 * carries only a one-line summary plus the file path (offload), and the harness
 * agent reads the file when it needs depth (reload). One file per signature —
 * re-dispatches refresh it in place rather than duplicating the evidence into
 * every pack.
 *
 * Expiry rides the attempt store's session-relative rule (never wall-clock):
 * when `recordCandidateSightings` expires an attempt key — its signature absent
 * from the ranked candidates for ATTEMPT_EXPIRY_SESSIONS fresh capture
 * sessions — it calls `removeExpiredOptimizationEvidence` with the expired
 * signatures and the evidence file is deleted alongside the attempts. One
 * expiry mechanism, two artifacts.
 *
 * This module is import-leaf on purpose (fs/path only): contextPack (writes),
 * optimizationAnalysis (expires), and the MCP playbook slice (links) all
 * consume it without a cycle.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Workspace-relative path of the evidence file (what pack bodies print). */
export function optimizationEvidenceRelPath(signature: string): string {
	return path.join('.vinv', 'context', `opt-${signature}.md`);
}

/** Absolute path of the evidence file for one opportunity signature. */
export function optimizationEvidencePath(workspaceRoot: string, signature: string): string {
	return path.join(workspaceRoot, optimizationEvidenceRelPath(signature));
}

/** The heavy evidence a pack offloads instead of inlining. */
export interface OptimizationEvidence {
	/** Opportunity signature (optimizationAnalysis.opportunitySignature) — the
	 * file's identity AND its expiry key in the attempt store. */
	signature: string;
	/** Episode title, for the file header. */
	title: string;
	/** The candidate's span proof: the ranked evidence lines — waste kind,
	 * measured cost, structural reason — that justify the dispatch. */
	span_proof?: string;
	/** Persisted prior-attempt history (composePriorAttemptSeed output). */
	attempt_history?: string;
}

/**
 * Writes (or refreshes) the evidence file for a signature and returns its
 * absolute path. Deliberately a full rewrite, not an append: the file is a
 * SNAPSHOT of the dispatch-time evidence, one per signature, so a re-dispatch
 * replaces stale numbers instead of accreting them.
 */
export function writeOptimizationEvidence(
	workspaceRoot: string,
	evidence: OptimizationEvidence,
): string {
	const target = optimizationEvidencePath(workspaceRoot, evidence.signature);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const lines: string[] = [];
	lines.push(`# Offloaded optimization evidence — ${evidence.title}`);
	lines.push('');
	lines.push(
		`> Opportunity signature \`${evidence.signature}\` · written ${new Date().toISOString()} · ` +
			'this file expires with its attempt-store key (signature absent from fresh evidence ' +
			'for 3 consecutive capture sessions).',
	);
	lines.push('');
	if (evidence.span_proof) {
		lines.push('## Span proof (the measured evidence behind the dispatch)');
		lines.push('');
		lines.push(evidence.span_proof.trim());
		lines.push('');
	}
	if (evidence.attempt_history) {
		lines.push('## Prior attempt history (do not repeat these approaches)');
		lines.push('');
		lines.push(evidence.attempt_history.trim());
		lines.push('');
	}
	if (!evidence.span_proof && !evidence.attempt_history) {
		lines.push('(no span proof or attempt history was available at dispatch time)');
		lines.push('');
	}
	fs.writeFileSync(target, lines.join('\n'), 'utf8');
	return target;
}

/**
 * Deletes the evidence files of expired signatures; returns the paths actually
 * removed. Missing files are not an error (a signature may have expired before
 * any pack offloaded evidence for it) — but an unreadable/undeletable file
 * throws: expiry that silently fails would grow `.vinv/context` forever.
 */
export function removeExpiredOptimizationEvidence(
	workspaceRoot: string,
	signatures: Iterable<string>,
): string[] {
	const removed: string[] = [];
	for (const signature of signatures) {
		const target = optimizationEvidencePath(workspaceRoot, signature);
		if (!fs.existsSync(target)) {
			continue;
		}
		fs.unlinkSync(target);
		removed.push(target);
	}
	return removed;
}
