import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { vinvHomeDir } from '../vinvHome';

export interface RetrievalEvent {
	type:
		| 'decision'
		| 'feedback'
		| 'shadow'
		| 'policy_invalidated'
		| 'rollback'
		// QnA answer-quality telemetry: the deterministic critic's report per
		// attempt, and the anomaly of a missing/malformed sufficiency verdict.
		| 'critic'
		| 'verdict_anomaly'
		// One automatic off-policy evaluation over the pooled ledger: the
		// per-candidate DR deltas, gates, and what (if anything) was promoted.
		| 'ope_evaluation'
		// A thumbs-down answer's surfaced files — accumulated negative alias
		// evidence consumed by tag enrichment (never acted on singly).
		| 'negative_tag_evidence';
	ts: string;
	decision_id?: string;
	epoch: string;
	[key: string]: unknown;
}

export interface RetrievalPolicy {
	version: 1;
	epoch: string;
	top_k: number;
	canary_fraction: number;
}

export interface PolicyDecision {
	topK: number;
	propensity: number;
	policy: 'baseline' | 'canary' | 'active' | 'explore';
	shadowTopK: number | null;
}

/** A decision awaiting explicit or auxiliary (edit-overlap) feedback. */
export interface PendingDecision {
	decision_id: string;
	epoch: string;
	ts: string;
	canary: boolean;
	files: string[];
}

/** Durable MCP learning state — survives server restarts so a rolled-back
 * canary stays rolled back and pending decisions still receive feedback. */
export interface TelemetryState {
	version: 1;
	policy_disabled: boolean;
	consecutive_canary_losses: number;
	pending: PendingDecision[];
}

/**
 * The discrete action set for top-k exploration. Env-tunable via
 * VINV_RETRIEVAL_ACTIONS (comma-separated); the requested top_k is always a
 * member so the greedy arm has non-zero propensity.
 */
export function retrievalActionSet(requestedTopK: number): number[] {
	const raw = process.env.VINV_RETRIEVAL_ACTIONS ?? '3,5,8,10';
	const parsed = raw
		.split(',')
		.map((value) => Number.parseInt(value.trim(), 10))
		.filter((value) => Number.isInteger(value) && value >= 1 && value <= 20);
	const actions = parsed.length > 0 ? parsed : [3, 5, 8, 10];
	if (!actions.includes(requestedTopK)) {
		actions.push(requestedTopK);
	}
	return [...new Set(actions)].sort((a, b) => a - b);
}

/** Exploration rate for epsilon-greedy logging (VINV_RETRIEVAL_EPSILON). */
export function explorationEpsilon(): number {
	const raw = Number.parseFloat(process.env.VINV_RETRIEVAL_EPSILON ?? '0.1');
	return Number.isFinite(raw) && raw >= 0 && raw <= 0.5 ? raw : 0.1;
}

export function retrievalEpoch(storeDir: string): string {
	const hash = crypto.createHash('sha256');
	for (const filename of ['meta.json', 'manifest.json']) {
		try {
			hash.update(fs.readFileSync(path.join(storeDir, filename)));
		} catch {
			hash.update(`${filename}:missing`);
		}
	}
	return hash.digest('hex').slice(0, 24);
}

export function queryFeatures(query: string): Record<string, number | boolean | string> {
	const words = query.trim().split(/\s+/).filter(Boolean);
	return {
		query_hash: crypto.createHash('sha256').update(query).digest('hex').slice(0, 24),
		char_count: query.length,
		token_estimate: Math.ceil(query.length / 4),
		word_count: words.length,
		has_code_identifier: words.some((word) => /[_:.()[\]{}]/.test(word)),
	};
}

export function appendRetrievalEvent(event: RetrievalEvent): void {
	const directory = path.join(vinvHomeDir(), 'telemetry');
	const target = path.join(directory, 'retrieval.jsonl');
	fs.mkdirSync(directory, { recursive: true });
	const descriptor = fs.openSync(target, 'a', 0o600);
	try {
		fs.writeSync(descriptor, `${JSON.stringify(event)}\n`);
	} finally {
		fs.closeSync(descriptor);
	}
	try {
		fs.chmodSync(target, 0o600);
	} catch {
		// chmod is not meaningful on every platform.
	}
}

export function loadPolicyForEpoch(epoch: string): RetrievalPolicy | null {
	const target = path.join(vinvHomeDir(), 'retrieval-policy.json');
	try {
		const policy = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<RetrievalPolicy>;
		if (
			policy.version !== 1 ||
			// 'any' = an epoch-agnostic policy from a POOLED evaluation (the
			// top-k action's semantics are epoch-stable). The previous
			// exact-match-only rule meant every promoted policy died on the
			// next index update, making promotion structurally pointless.
			(policy.epoch !== epoch && policy.epoch !== 'any') ||
			typeof policy.top_k !== 'number' ||
			!Number.isInteger(policy.top_k) ||
			policy.top_k < 1 ||
			policy.top_k > 20 ||
			(policy.canary_fraction !== undefined &&
				(typeof policy.canary_fraction !== 'number' ||
					policy.canary_fraction <= 0 ||
					policy.canary_fraction > 0.1))
		) {
			appendRetrievalEvent({
				type: 'policy_invalidated',
				ts: new Date().toISOString(),
				epoch,
				stored_epoch: policy.epoch ?? null,
			});
			return null;
		}
		return {
			version: 1,
			epoch,
			top_k: policy.top_k,
			canary_fraction: policy.canary_fraction ?? 0.05,
		};
	} catch {
		return null;
	}
}

export function selectRetrievalAction(
	requestedTopK: number,
	policy: RetrievalPolicy | null,
	mode: string,
	randomValue: number = Math.random(),
): PolicyDecision {
	if (mode === 'explore') {
		// Epsilon-greedy over the discrete action set with exact propensities:
		// with probability 1-eps serve the requested top_k, otherwise a uniform
		// draw over the set. propensity(a) = eps/|A| + (1-eps)*[a == requested],
		// which identifies IPS/SNIPS/DR for every action in the set.
		const actions = retrievalActionSet(requestedTopK);
		const epsilon = explorationEpsilon();
		let chosen = requestedTopK;
		if (epsilon > 0 && randomValue < epsilon) {
			// Given randomValue < eps, randomValue/eps is uniform on [0,1).
			const index = Math.min(
				Math.floor((randomValue / epsilon) * actions.length),
				actions.length - 1,
			);
			chosen = actions[index];
		}
		const propensity =
			epsilon / actions.length + (chosen === requestedTopK ? 1 - epsilon : 0);
		return {
			topK: chosen,
			propensity,
			policy: chosen === requestedTopK ? 'baseline' : 'explore',
			shadowTopK: policy && policy.top_k !== chosen ? policy.top_k : null,
		};
	}
	if (!policy || mode === 'off') {
		return { topK: requestedTopK, propensity: 1, policy: 'baseline', shadowTopK: null };
	}
	if (mode === 'active') {
		return { topK: policy.top_k, propensity: 1, policy: 'active', shadowTopK: null };
	}
	if (mode === 'canary' && policy.top_k !== requestedTopK) {
		const useCanary = randomValue < policy.canary_fraction;
		return useCanary
			? {
					topK: policy.top_k,
					propensity: policy.canary_fraction,
					policy: 'canary',
					shadowTopK: null,
				}
			: {
					topK: requestedTopK,
					propensity: 1 - policy.canary_fraction,
					policy: 'baseline',
					shadowTopK: policy.top_k,
				};
	}
	return {
		topK: requestedTopK,
		propensity: 1,
		policy: 'baseline',
		shadowTopK: policy.top_k,
	};
}

const EMPTY_STATE: TelemetryState = {
	version: 1,
	policy_disabled: false,
	consecutive_canary_losses: 0,
	pending: [],
};

function stateFilePath(): string {
	return path.join(vinvHomeDir(), 'telemetry', 'state.json');
}

/** Load durable learning state; a missing or corrupt file yields a clean slate. */
export function loadTelemetryState(): TelemetryState {
	try {
		const raw = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')) as Partial<TelemetryState>;
		if (raw.version !== 1) {
			return { ...EMPTY_STATE, pending: [] };
		}
		return {
			version: 1,
			policy_disabled: raw.policy_disabled === true,
			consecutive_canary_losses:
				typeof raw.consecutive_canary_losses === 'number' &&
				Number.isInteger(raw.consecutive_canary_losses) &&
				raw.consecutive_canary_losses >= 0
					? raw.consecutive_canary_losses
					: 0,
			pending: Array.isArray(raw.pending)
				? raw.pending.filter(
						(entry): entry is PendingDecision =>
							typeof entry === 'object' &&
							entry !== null &&
							typeof (entry as PendingDecision).decision_id === 'string' &&
							typeof (entry as PendingDecision).epoch === 'string' &&
							typeof (entry as PendingDecision).ts === 'string' &&
							Array.isArray((entry as PendingDecision).files),
					)
				: [],
		};
	} catch {
		return { ...EMPTY_STATE, pending: [] };
	}
}

/** Atomically persist learning state so an MCP restart cannot resurrect a
 * rolled-back canary or orphan pending decisions. */
export function saveTelemetryState(state: TelemetryState): void {
	const target = stateFilePath();
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
	fs.renameSync(temporary, target);
}
