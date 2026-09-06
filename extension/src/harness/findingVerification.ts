/**
 * Finding triage — the gate between "the tooling noticed something" and "a
 * human is told about it".
 *
 * Exercise and auto-insight report symptoms: a non-2xx status, an exception
 * reaching a boundary, a probe that timed out. Some of those are defects and
 * some are the endpoint behaving exactly as documented, and the difference is
 * not decidable from the symptom alone. Every finding used to go straight into
 * the Findings view as it was produced, so the list a developer read was a
 * mixture, and the false ones cost the true ones their credibility.
 *
 * Findings are now held until a batch can be judged:
 *
 *   1. Each new finding marks the workspace pending and restarts a quiet timer.
 *   2. The batch is judged when the exercise pass finishes, or when nothing new
 *      has arrived for the quiet period — whichever comes first. The timer is
 *      the fallback for a pass that never lands a completion (crash, cancel, a
 *      service that hangs), not the normal path.
 *   3. One judge-findings agent judges the whole batch and returns a verdict
 *      per finding signature.
 *   4. Verdicts are stored; the view shows the real ones and hides the false
 *      positives.
 *
 * Nothing is deleted. Verdicts live in `.vinv/exercise/verdicts.json` keyed by
 * the finding signature the exerciser already assigns, NOT inside issues.json:
 * every exercise pass rewrites issues.json from the per-service documents, so a
 * verdict written there is erased by the next pass over the same workspace. A
 * sidecar keyed by signature survives that, and re-attaches to a finding that
 * reappears — a false positive stays hidden across passes instead of being
 * re-judged, and re-paid for, every time.
 *
 * Safety runs one way throughout. An unjudged finding is SHOWN. A judge that is
 * unavailable, blocked, times out, or replies with anything malformed produces
 * no verdicts at all, and the view falls back to showing everything — the
 * behaviour that predates this module. Only an explicit `false_positive` from a
 * well-formed reply hides anything, because a wrongly hidden finding is one
 * nobody ever sees again.
 */
import * as fs from 'fs';
import * as path from 'path';

import { asFindingVerdicts, runGoalAgent, type AgentSpawn } from './binaryAgents';

/** A stored verdict: the agent's judgement plus when and by whom. */
export interface StoredVerdict {
	verdict: 'real' | 'false_positive';
	confidence: number;
	reason: string;
	/** ISO timestamp, so a stale verdict is recognisable as one. */
	verified_at: string;
	/** The harness that judged it, for provenance in the UI. */
	harness: string;
}

/** The verdict sidecar: signature → verdict. */
export type VerdictStore = Record<string, StoredVerdict>;

/** One finding handed to the judge. */
export interface JudgeableFinding {
	/** The exerciser's own cluster signature — the join key for the verdict. */
	signature: string;
	kind: string;
	title: string;
	/** Whatever evidence the caller can supply; the renderer clips it. */
	evidence: string;
}

/** How long with no new finding before the batch is judged anyway. */
const DEFAULT_QUIET_PERIOD_MS = 10 * 60 * 1000;

/** Cap on one batch, so a pathological pass cannot render an unbounded prompt. */
const MAX_BATCH = 60;

export function verdictStorePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'exercise', 'verdicts.json');
}

/** Reads the verdict sidecar. Missing or corrupt reads as empty, never throws. */
export function readVerdicts(workspaceRoot: string): VerdictStore {
	try {
		const raw = JSON.parse(fs.readFileSync(verdictStorePath(workspaceRoot), 'utf8')) as unknown;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return {};
		}
		const doc = (raw as Record<string, unknown>).verdicts;
		if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
			return {};
		}
		const out: VerdictStore = {};
		for (const [sig, value] of Object.entries(doc as Record<string, unknown>)) {
			const row = value as Record<string, unknown>;
			if (row?.verdict === 'real' || row?.verdict === 'false_positive') {
				out[sig] = {
					verdict: row.verdict,
					confidence: typeof row.confidence === 'number' ? row.confidence : 0,
					reason: typeof row.reason === 'string' ? row.reason : '',
					verified_at: typeof row.verified_at === 'string' ? row.verified_at : '',
					harness: typeof row.harness === 'string' ? row.harness : '',
				};
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Merges new verdicts into the sidecar.
 *
 * Written temp + rename like every other artifact under .vinv, because the
 * Findings view reads this on a watcher and must never see half a document.
 */
export function writeVerdicts(workspaceRoot: string, added: VerdictStore): void {
	const merged = { ...readVerdicts(workspaceRoot), ...added };
	const dest = verdictStorePath(workspaceRoot);
	const tmp = `${dest}.tmp`;
	try {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify({ verdicts: merged }, null, 2), 'utf8');
		fs.renameSync(tmp, dest);
	} catch {
		// Best-effort: losing a verdict costs one re-judge, and must never break
		// the pass that produced the findings.
	}
}

/** True when this finding has been judged a false positive and should be hidden. */
export function isHiddenFinding(store: VerdictStore, signature: string): boolean {
	return store[signature]?.verdict === 'false_positive';
}

/** True when this finding has no verdict yet — shown, but marked as pending. */
export function isPendingFinding(store: VerdictStore, signature: string): boolean {
	return signature.length > 0 && store[signature] === undefined;
}

/**
 * Judges a batch of findings. Resolves the verdicts that were obtained, which
 * may be fewer than were asked for — a finding the agent skipped or mangled
 * stays unjudged, and therefore stays visible.
 *
 * Resolves an empty store (not null) when there was nothing to judge, and null
 * when the judge could not be reached at all, so a caller can tell "nothing to
 * do" from "the agent is unavailable" without inspecting the transport.
 */
export async function judgeFindings(
	spawnInfo: AgentSpawn,
	harnessId: string,
	findings: readonly JudgeableFinding[],
	// Injected so the batching, the id guard and the stamping are testable
	// without a stub executable on disk; production always uses runGoalAgent.
	run: (
		s: AgentSpawn,
		subcommand: 'judge-findings',
		payload: Record<string, unknown>,
	) => Promise<Record<string, unknown> | null> = runGoalAgent,
): Promise<VerdictStore | null> {
	const batch = findings.filter((f) => f.signature.trim().length > 0).slice(0, MAX_BATCH);
	if (batch.length === 0) {
		return {};
	}
	const raw = await run(spawnInfo, 'judge-findings', {
		findings: batch.map((f) => ({
			id: f.signature,
			kind: f.kind,
			title: f.title,
			evidence: f.evidence,
		})),
	});
	const verdicts = asFindingVerdicts(raw);
	if (!verdicts) {
		return null;
	}
	// Only ids we actually asked about are accepted: an agent that invents a
	// signature must not be able to hide a finding that was never in the batch.
	const asked = new Set(batch.map((f) => f.signature));
	const verified_at = new Date().toISOString();
	const out: VerdictStore = {};
	for (const v of verdicts) {
		if (asked.has(v.id)) {
			out[v.id] = {
				verdict: v.verdict,
				confidence: v.confidence,
				reason: v.reason,
				verified_at,
				harness: harnessId,
			};
		}
	}
	return out;
}

/**
 * The per-workspace quiet timer.
 *
 * Module state rather than a class because there is one of these per window and
 * the extension host owns its lifetime; `disposeVerificationTimers` clears them
 * on deactivate so a pending timer cannot outlive the window that armed it.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function quietPeriodMs(configured?: number): number {
	return configured !== undefined && Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_QUIET_PERIOD_MS;
}

/**
 * Records that new findings landed, and (re)arms the quiet timer.
 *
 * Each call pushes the deadline out: the batch is judged once the workspace has
 * been quiet for the whole period, not on a fixed schedule from the first
 * finding, so a long pass that keeps producing findings is judged once at the
 * end rather than in arbitrary slices.
 */
export function noteFindingsChanged(
	workspaceRoot: string,
	onQuiet: () => void,
	configuredMs?: number,
): void {
	cancelQuietTimer(workspaceRoot);
	const timer = setTimeout(() => {
		timers.delete(workspaceRoot);
		onQuiet();
	}, quietPeriodMs(configuredMs));
	// Never hold the host open for a timer whose only job is a follow-up pass.
	timer.unref?.();
	timers.set(workspaceRoot, timer);
}

/** Cancels a pending quiet timer — called when the pass finishes first. */
export function cancelQuietTimer(workspaceRoot: string): void {
	const existing = timers.get(workspaceRoot);
	if (existing) {
		clearTimeout(existing);
		timers.delete(workspaceRoot);
	}
}

/** Clears every armed timer. For deactivate. */
export function disposeVerificationTimers(): void {
	for (const timer of timers.values()) {
		clearTimeout(timer);
	}
	timers.clear();
}
