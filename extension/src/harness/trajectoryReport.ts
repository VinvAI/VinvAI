/**
 * Trajectory report — the cross-episode ledger made visible.
 *
 * Answers, from recorded data only, the questions a user actually asks after
 * a few episodes: what was the goal, what did each episode try (which arm the
 * bandit chose), what did it earn (reward), what evidence closed it, which
 * issues are FIXED vs still open, did the policy learn anything (arm moves,
 * epsilon decay), and where are the full artifacts (context packs).
 *
 * Pure composition over the active session (.vinv/askvinv/sessions/) +
 * ~/.vinv/telemetry/episodes.jsonl;
 * nothing here re-derives or invents state, so the report can be trusted as
 * the audit trail of the closed loop.
 */
import * as fs from 'fs';
import type { EpisodeOutcome, SessionState } from './session';
import { loadSession } from './session';
import { episodeLedgerPath, type EpisodeEvent } from './episodeTelemetry';

/** Reads every ledger event, tolerating a missing or partially-torn file. */
export function readEpisodeEvents(ledgerPath = episodeLedgerPath()): EpisodeEvent[] {
	let raw: string;
	try {
		raw = fs.readFileSync(ledgerPath, 'utf8');
	} catch {
		return [];
	}
	const out: EpisodeEvent[] = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			out.push(JSON.parse(line) as EpisodeEvent);
		} catch {
			// A torn tail line (crash mid-append) is skipped, never fatal.
		}
	}
	return out;
}

function fmtReward(r: number): string {
	return (r >= 0 ? '+' : '') + r.toFixed(2);
}

/**
 * Says what executable evidence stood behind a reward, because the number alone
 * cannot.
 *
 * `reward` is renormalized over the rubric components that were AVAILABLE —
 * correct handling, since a check that could not run is not a verdict and
 * scoring it 0 would punish an agent for missing infrastructure. The cost is
 * that a clean verified pass, an episode where nothing could be checked, and an
 * episode whose acceptance tests were discarded as non-discriminating all print
 * the same 1.00. This is the line a human reads to decide whether the loop
 * works, so the qualifier travels with every reward we print.
 *
 * `undefined` is UNKNOWN (records predating the field) and is marked as such —
 * never silently rendered as though it were verified.
 */
function rewardQualifier(h: EpisodeOutcome): string {
	// An abort short-circuits scoring entirely: episodeReward returns a flat −1
	// whatever the cause — the operator rejected a disputed premise, the run was
	// cancelled, a revert fired. That is the SAME magnitude a proven regression
	// or a human retraction earns, so the trajectory reads as though a cancelled
	// run were as bad as shipped-and-reverted code. It also does not train the
	// policy (aborted episodes are recorded objective:false), which is exactly
	// the kind of thing the number alone cannot say.
	if (h.aborted) {
		return ' (fixed abort penalty — not a measured verdict, and not used for learning)';
	}
	if (h.verification_weight === undefined) {
		return ' (verification evidence not recorded)';
	}
	if (h.verification_weight <= 0) {
		return ' — UNVERIFIED: no oracle, tests or regression ran, so this is the audit components alone';
	}
	return ` (verification weight ${h.verification_weight.toFixed(2)})`;
}

/**
 * The markdown report. `events` supplies attempt/stall/dispute detail keyed
 * by episode id; `session` supplies the authoritative outcomes and goal.
 */
export function composeTrajectoryReport(
	session: SessionState,
	events: EpisodeEvent[],
): string {
	const lines: string[] = [];
	lines.push('# Vinv Trajectory');
	lines.push('');
	lines.push(`> Generated ${new Date().toISOString()}`);
	lines.push('');
	lines.push('## Goal');
	lines.push('');
	lines.push(
		session.goal
			? `**${session.goal}** — episode ${session.episodes_used} of ${session.episode_budget} spent.`
			: `No standing goal set — episodes run per-task. Budget: ${session.episode_budget}.`,
	);
	lines.push('');

	if (session.history.length === 0) {
		lines.push('No episodes recorded yet. Dispatch one from a failing service (▶ exit), ');
		lines.push('the smoke report, a graph node ("Fix with Coding Agent"), or "Optimize Hotspots".');
		return lines.join('\n') + '\n';
	}

	const fixed = session.history.filter((h) => h.verified);
	const open = session.history.filter((h) => !h.verified && !h.aborted);
	const aborted = session.history.filter((h) => h.aborted);
	// An abort scores a FIXED −1 whatever the cause (operator rejected a disputed
	// premise, run cancelled, revert fired) and is recorded objective:false, so it
	// never trains the policy. Summing that penalty into a figure a human reads as
	// performance made a cancelled run weigh exactly as much as shipped-and-
	// reverted code. Measured verdicts only — but the exclusion is STATED, because
	// silently dropping them trades a wrong number for a number that hides how
	// much it left out.
	const measured = session.history.filter((h) => !h.aborted);
	const totalReward = measured.reduce((s, h) => s + h.reward, 0);
	lines.push('## Scoreboard');
	lines.push('');
	lines.push(
		`${session.history.length} episode(s) · ${fixed.length} verified fixed · ` +
			`${open.length} unresolved · ${aborted.length} aborted · ` +
			`cumulative reward ${fmtReward(totalReward)} across ${measured.length} measured verdict(s)` +
			(aborted.length > 0
				? `; ${aborted.length} aborted episode(s) excluded (fixed penalty, not a measured outcome)`
				: ''),
	);
	// Summing rewards of differing provenance is the same incomparability one
	// level up: an unverified 1.00 adds as much to the total as a verified one.
	const unverified = session.history.filter((h) => h.verification_weight === 0).length;
	if (unverified > 0) {
		lines.push('');
		lines.push(
			`> ${unverified} of these episode(s) ran NO executable verification — no oracle, ` +
				'no acceptance tests, no regression. Their reward reflects the audit components ' +
				'alone and is not comparable to a verified pass, so the cumulative figure above ' +
				'sums rewards of different provenance.',
		);
	}
	lines.push('');

	// Per-episode detail, oldest first (the trajectory reads top-down).
	const byEpisode = new Map<string, EpisodeEvent[]>();
	for (const e of events) {
		if (typeof e.episode_id === 'string') {
			const list = byEpisode.get(e.episode_id) ?? [];
			list.push(e);
			byEpisode.set(e.episode_id, list);
		}
	}
	lines.push('## Episodes');
	for (const h of session.history) {
		lines.push('');
		const status = h.verified ? 'VERIFIED' : h.aborted ? 'ABORTED' : 'FAILED';
		lines.push(`### ${h.title}`);
		lines.push('');
		lines.push(
			`- **${status}** · ${h.ts} · arm #${h.arm_index} · ${h.attempts} attempt(s) · ` +
				`reward ${fmtReward(h.reward)}${rewardQualifier(h)}`,
		);
		lines.push(`- Evidence: ${h.evidence}`);
		if (h.pack_path) {
			lines.push(`- Full context pack: \`${h.pack_path}\``);
		}
		const detail = byEpisode.get(h.episode_id) ?? [];
		const stalls = detail.filter((e) => e.type === 'stall');
		const disputes = detail.filter((e) => e.type === 'dispute');
		for (const s of stalls) {
			lines.push(
				`- Stall negotiated (similarity ${String(s.similarity ?? '?')}): ${String(s.action)} — mutation: ${String(s.mutation ?? '')}`,
			);
		}
		for (const d of disputes) {
			lines.push(
				`- Agent disputed the premise: "${String(d.dispute ?? '')}" → ${String(d.action)}`,
			);
		}
	}

	// Reward over episodes, and what the policy learned. (Not headed
	// "Trajectory" — the report itself is the trajectory now.)
	lines.push('');
	lines.push('## Reward Trend');
	lines.push('');
	// A bare arrow chain invites reading a trend across numbers that may not share
	// a denominator, so an unverified reward is marked inline rather than in a
	// legend the reader has to go find.
	lines.push(
		'Reward per episode: ' +
			session.history
				.map(
					(h) =>
						fmtReward(h.reward) +
						(h.aborted ? '†' : h.verification_weight === 0 ? '*' : ''),
				)
				.join(' → '),
	);
	// A marked entry in the chain that is NOT in the cumulative figure above has to
	// say so here, or the two numbers silently disagree.
	if (session.history.some((h) => h.verification_weight === 0 && !h.aborted)) {
		lines.push('');
		lines.push('`*` = unverified: nothing executable ran behind that reward.');
	}
	if (aborted.length > 0) {
		lines.push('');
		lines.push(
			'`†` = aborted: a fixed penalty rather than a measured verdict — excluded from ' +
				'the cumulative figure above, and never used for learning.',
		);
	}
	const policyUpdates = events.filter((e) => e.type === 'policy_updated');
	if (policyUpdates.length > 0) {
		const last = policyUpdates[policyUpdates.length - 1];
		lines.push('');
		lines.push(
			`Policy updated ${policyUpdates.length} time(s); latest: ${JSON.stringify(
				Object.fromEntries(Object.entries(last).filter(([k]) => k !== 'type' && k !== 'ts')),
			)}`,
		);
	} else {
		lines.push('');
		lines.push(
			'Policy not yet re-estimated (updates land after episodes accrue in the ledger).',
		);
	}
	return lines.join('\n') + '\n';
}

/** Loads state and composes the report for a workspace. */
export function buildTrajectoryReport(workspaceRoot: string): string {
	return composeTrajectoryReport(loadSession(workspaceRoot), readEpisodeEvents());
}
