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
import type { SessionState } from './session';
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
	const totalReward = session.history.reduce((s, h) => s + h.reward, 0);
	lines.push('## Scoreboard');
	lines.push('');
	lines.push(
		`${session.history.length} episode(s) · ${fixed.length} verified fixed · ` +
			`${open.length} unresolved · ${aborted.length} aborted · ` +
			`cumulative reward ${fmtReward(totalReward)}`,
	);
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
			`- **${status}** · ${h.ts} · arm #${h.arm_index} · ${h.attempts} attempt(s) · reward ${fmtReward(h.reward)}`,
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
	lines.push(
		'Reward per episode: ' + session.history.map((h) => fmtReward(h.reward)).join(' → '),
	);
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
