/**
 * Per-service replay statistics — the learned half of the adaptive replay
 * budget (the systemd/Kubernetes startup lesson applied to episode
 * verification).
 *
 * A fixed replay budget mislabels slow-but-working services: a boot that
 * takes longer than the constant is recorded as an OBJECTIVE oracle rejection
 * and trains the composition bandit on an infrastructure artifact. Kubernetes
 * hit exactly this with fixed initialDelaySeconds and answered with
 * startupProbe (budget derived from what the workload actually needs);
 * systemd answered with EXTEND_TIMEOUT_USEC (a service showing progress earns
 * more time). Both halves are implemented here and in verifyServiceReplay:
 *
 *  - LEARNED SOFT BUDGET: every objectively-verified boot records its
 *    time-to-serve here (.vinv/replay-stats/<service>.json, bounded ring).
 *    The soft budget is max(floor, observed-quantile × multiplier) — a
 *    service that historically serves in 8s is probed on an 8s-scale budget,
 *    one that takes 6 minutes gets a 6-minute-scale budget, with no constant
 *    to mis-tune.
 *  - PROGRESS EXTENSION: past the soft budget the replay keeps waiting only
 *    while the process shows progress (recent output activity), up to a hard
 *    ceiling. A silent, never-serving process fails at the soft budget (it is
 *    hung); an actively-booting one is given the time it is visibly using.
 *
 * All numbers live in the episode policy as validated priors
 * (ReplayParams in episodeTelemetry.ts) — nothing here is a frozen constant,
 * per the repo doctrine that every number is a learnable prior.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ReplayStats {
	version: 1;
	/** Observed time-to-serve of objectively verified boots, seconds. */
	durations_s: number[];
	updated_at?: string;
}

/** Ring size for recorded boot durations — enough for a stable quantile,
 * small enough that a service's behavior a hundred boots ago stops mattering. */
const MAX_DURATIONS = 32;

function statsPath(workspaceRoot: string, service: string): string {
	// Service names come from services.json/start_commands filenames; keep the
	// same normalization contract (they are already filesystem-safe there).
	return path.join(workspaceRoot, '.vinv', 'replay-stats', `${service}.json`);
}

/** Loads recorded boot durations; missing/corrupt files are an empty record. */
export function readReplayStats(workspaceRoot: string, service: string): ReplayStats {
	try {
		const raw = JSON.parse(
			fs.readFileSync(statsPath(workspaceRoot, service), 'utf8'),
		) as Partial<ReplayStats>;
		if (
			raw.version === 1 &&
			Array.isArray(raw.durations_s) &&
			raw.durations_s.every((d) => typeof d === 'number' && Number.isFinite(d) && d >= 0)
		) {
			return { version: 1, durations_s: raw.durations_s.slice(-MAX_DURATIONS) };
		}
	} catch {
		// Fall through to the empty record.
	}
	return { version: 1, durations_s: [] };
}

/** Records one observed time-to-serve (objectively verified boots only). */
export function recordReplayDuration(
	workspaceRoot: string,
	service: string,
	durationSeconds: number,
): void {
	if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
		return;
	}
	const stats = readReplayStats(workspaceRoot, service);
	stats.durations_s = [...stats.durations_s, Math.round(durationSeconds * 10) / 10].slice(
		-MAX_DURATIONS,
	);
	stats.updated_at = new Date().toISOString();
	const target = statsPath(workspaceRoot, service);
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const tmp = `${target}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(stats, null, '\t')}\n`);
		fs.renameSync(tmp, target);
	} catch {
		// Stats are an optimization; failing to record must never fail a verify.
	}
}

/** Nearest-rank quantile of the recorded durations (0 with no observations). */
export function durationQuantile(stats: ReplayStats, q: number): number {
	if (stats.durations_s.length === 0) {
		return 0;
	}
	const sorted = [...stats.durations_s].sort((a, b) => a - b);
	const rank = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(q * sorted.length) - 1),
	);
	return sorted[rank];
}

/** The learned-parameter block consumed here (subset of the episode policy). */
export interface ReplayBudgetParams {
	/** Soft-budget floor, seconds — no service is probed on less than this. */
	floor_s: number;
	/** Hard ceiling, seconds — no replay waits longer, progress or not. */
	ceiling_s: number;
	/** Safety multiplier over the observed boot-time quantile. */
	multiplier: number;
	/** Quantile of recorded durations the soft budget must cover. */
	quantile: number;
	/** Output silence (seconds) past the soft budget that means "hung". */
	activity_window_s: number;
	/** Survival (seconds) a portless service must show for a heuristic pass. */
	portless_grace_s: number;
}

/**
 * The soft budget in milliseconds: max(floor, observed-quantile × multiplier).
 * With no recorded boots this is the floor — first contact with a service is
 * probed on the prior, and every verified boot thereafter tightens or widens
 * the budget to the service's own scale.
 */
export function softBudgetMs(stats: ReplayStats, params: ReplayBudgetParams): number {
	const learned = durationQuantile(stats, params.quantile) * params.multiplier;
	return Math.max(params.floor_s, learned) * 1000;
}

/**
 * The hard ceiling in milliseconds. The environment override
 * (VINV_EPISODE_REPLAY_BUDGET_S — kept for back-compat with the old fixed
 * budget) wins when set; the ceiling is never below the soft budget.
 */
export function ceilingMs(softMs: number, params: ReplayBudgetParams): number {
	const raw = Number.parseFloat(process.env.VINV_EPISODE_REPLAY_BUDGET_S ?? '');
	const ceiling =
		Number.isFinite(raw) && raw > 0 ? raw * 1000 : params.ceiling_s * 1000;
	return Math.max(ceiling, softMs);
}
