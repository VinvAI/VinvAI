/**
 * Context Pack Composer — the dual-audience artifact of a harness episode.
 *
 * A pack is a markdown file under <workspace>/.vinv/context/pack-<id>.md that
 * both the coding harness (fed on stdin as its task) and the human (draggable
 * / @-referenceable into the host chat) consume: the issue, explicit success
 * criteria, a budgeted graph slice with summaries, runtime evidence with
 * staleness marks, epoch stamps, and — on re-dispatch — the observed failure
 * of the previous attempt. Composition parameters (slice depth, runtime
 * inclusion, snippet budget) are the episode bandit's arm.
 *
 * Free of `vscode` so it is unit-testable with a synthetic snapshot.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { GraphSnapshot } from '../graph/indexGraph';
import { contextWalk, groundSymbolMentions, type WalkAnchor } from '../graph/contextWalk';
import { walkParams, type EpisodeArm, type EpisodePolicy } from './episodeTelemetry';
import type { TaskIntent } from './taskIntent';

/** Composition budgets from the learned policy — nothing here is a constant. */
export interface PackBudgets {
	/** Graph-slice node budget. */
	slice_budget: number;
	/** Max seed symbols derived from issue text. */
	seed_cap: number;
	/** Chars of prior-failure evidence carried into the next pack. */
	failure_evidence_chars: number;
	/** Context-walk parameters (typed-edge personalized PageRank). */
	walk: ReturnType<typeof walkParams>;
}

/** Extracts the pack budgets from the learned episode policy. */
export function packBudgets(policy: EpisodePolicy): PackBudgets {
	return {
		slice_budget: policy.slice_budget,
		seed_cap: policy.seed_cap,
		failure_evidence_chars: policy.failure_evidence_chars,
		walk: walkParams(policy),
	};
}

export interface PackTask {
	/** Short title, e.g. "Fix service 'api' crash on startup". */
	title: string;
	/**
	 * What the operator asked for: 'defect' (something is broken, a change is
	 * expected) or 'question' (an explanation is expected, and any change is
	 * proposed rather than applied). Absent means 'defect' — the historical
	 * behaviour, kept so existing callers and stored packs stay valid.
	 */
	intent?: TaskIntent;
	/** The issue statement — failure output, error evidence, or user request. */
	issue: string;
	/** Explicit, checkable success criteria the agent must satisfy. */
	successCriteria: string[];
	/** Seed symbol rows for the graph slice (optional; derived when absent). */
	seedRows?: number[];
	/** Service name when this is a service-fix episode. */
	service?: string;
	/** The user's standing goal, verbatim (from .vinv/session.json). */
	goal?: string;
	/** Trajectory digest: every prior episode on this goal + trend read. */
	trajectory?: string;
	/** Stall-breaker mutation the next attempt MUST adopt. */
	mutation?: string;
	/**
	 * Free-text instruction the operator typed at an escalation ("Something
	 * else…"). Authoritative — it is the human overseeing the episode steering
	 * the next attempt, and persists until they replace it.
	 */
	operator_note?: string;
	/**
	 * The previous attempt's multi-signal reward report (rendered by
	 * rewardSignals.renderRewardReport): the score, per-signal reasons, and the
	 * exact directives that raise it. The feedback half of the reward loop —
	 * a low reward always arrives with WHY and WHAT TO CHANGE.
	 */
	reward_report?: string;
}

export interface ComposedPack {
	id: string;
	path: string;
	content: string;
	/** Rows actually included in the slice (for telemetry features). */
	sliceRows: number[];
}

/** The directory context packs land in. */
export function contextPackDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'context');
}

/**
 * Derives seed rows from the issue text when the caller has none: symbols
 * whose name appears verbatim in the issue/output are almost always the ones
 * involved (stack traces and log lines carry function and file names).
 */
export function deriveSeedRows(snapshot: GraphSnapshot, issue: string, cap: number): number[] {
	// One grounding mechanism for every surface (QnA retrials use the same):
	// word-aligned symbol mentions with (file, name) homonym resolution.
	return groundSymbolMentions(snapshot.nodes, issue, cap);
}

/**
 * Composes the pack content from a snapshot + task + arm. Pure — no disk IO —
 * so tests can assert exact structure. `priorFailure` extends the pack with
 * the evidence of the previous attempt (the re-prompt loop's feedback).
 */
export function composePackContent(
	snapshot: GraphSnapshot,
	task: PackTask,
	arm: EpisodeArm,
	budgets: PackBudgets,
	attempt: number,
	priorFailure?: string,
): { content: string; sliceRows: number[] } {
	const seeds =
		task.seedRows && task.seedRows.length > 0
			? task.seedRows
			: deriveSeedRows(snapshot, task.issue, budgets.seed_cap);
	// The slice is the same typed-edge personalized-PageRank walk QnA uses —
	// one relevance math end to end. The arm's slice_depth keeps its literal
	// bandit meaning as the walk's hop bound on admission (depth 0 = seeds
	// only), so the two arm levels remain genuinely different compositions.
	const anchors: WalkAnchor[] = seeds.map((row) => ({ row, weight: 1 }));
	const walked = contextWalk(
		snapshot.nodes,
		snapshot.edges,
		snapshot.flow_edges,
		anchors,
		budgets.walk,
		arm.slice_depth > 0 ? budgets.slice_budget : seeds.length,
		arm.slice_depth > 0 ? arm.slice_depth : 0,
	);
	const slice = walked.rows.map((row) => snapshot.nodes[row]).filter(Boolean);
	const sliceRowSet = new Set(walked.rows);

	const lines: string[] = [];
	lines.push(`# Vinv Context Pack — ${task.title}`);
	lines.push('');
	lines.push(
		`> Generated by Vinv at ${new Date().toISOString()} · index epoch ${snapshot.store_epoch} · attempt ${attempt}`,
	);
	lines.push('');
	if (task.goal) {
		lines.push('## Standing goal (set by the user — every episode serves it)');
		lines.push('');
		lines.push(task.goal.trim());
		lines.push('');
	}
	// A question is NOT an issue. Labelling it one is what used to force an
	// honest agent into the dispute channel: it was handed "resolve the issue"
	// for a codebase with nothing wrong in it, and saying so read as a refusal.
	if (task.intent === 'question') {
		lines.push('## Question');
		lines.push('');
		lines.push(task.issue.trim());
		lines.push('');
		lines.push(
			'This is a QUESTION, not a defect report. Nothing is known to be broken. Answer it from ' +
				'the evidence below. Do NOT change code to manufacture a fix — if the answer is "this ' +
				'already works correctly", that is a complete and successful outcome. Optimizations or ' +
				'fixes you spot along the way belong on the proposal channel (below), where the operator ' +
				'chooses which ones become their own episode.',
		);
		lines.push('');
		lines.push('## Proposal channel');
		lines.push('');
		lines.push(
			'If you find work worth doing, emit one line per item on stdout so Vinv can offer it to ' +
				'the operator as selectable follow-up work:',
		);
		lines.push('');
		lines.push('```');
		lines.push('vinv: proposal <one-line description of the change>');
		lines.push('```');
		lines.push('');
		lines.push(
			'List them in priority order. Do not use the dispute channel to report that nothing is ' +
				'broken — for a question, that is an answer, not a dispute.',
		);
		lines.push('');
	} else {
		lines.push('## Issue');
		lines.push('');
		lines.push(task.issue.trim());
		lines.push('');
	}
	if (task.operator_note) {
		lines.push('## Operator direction (the human overseeing this episode — authoritative)');
		lines.push('');
		lines.push(
			'The operator reviewed a stuck attempt and gave this explicit instruction. Treat it as ' +
				'the highest-priority steer for this attempt — follow it directly, over any inferred approach:',
		);
		lines.push('');
		lines.push(task.operator_note.trim());
		lines.push('');
	}
	if (task.trajectory) {
		lines.push('## Trajectory so far (do not repeat a failed approach verbatim)');
		lines.push('');
		lines.push(task.trajectory.trim());
		lines.push('');
	}
	if (task.mutation) {
		lines.push('## Required approach change (negotiated after a stall)');
		lines.push('');
		lines.push(
			'The previous attempts produced near-identical failures. This attempt MUST adopt the ' +
				'following change of approach — a verbatim retry will be rejected:',
		);
		lines.push('');
		lines.push(task.mutation.trim());
		lines.push('');
	}
	if (priorFailure) {
		lines.push('## ⚠ Previous attempt failed verification');
		lines.push('');
		lines.push(
			'A prior agent attempt at this task did NOT pass verification. Diagnose why before repeating it:',
		);
		lines.push('');
		lines.push('```');
		lines.push(priorFailure.slice(-budgets.failure_evidence_chars));
		lines.push('```');
		lines.push('');
	}
	if (task.reward_report) {
		lines.push('## Reward report — how the previous attempt scored, and what raises it');
		lines.push('');
		lines.push(
			'Vinv scores every attempt on independent signals (service oracle, pre-generated acceptance ' +
				'tests you cannot see, an anti-gaming audit of your diff). The previous attempt scored:',
		);
		lines.push('');
		lines.push('```');
		lines.push(task.reward_report.trim());
		lines.push('```');
		lines.push('');
	}
	lines.push('## Success criteria (all must hold)');
	lines.push('');
	for (const c of task.successCriteria) {
		lines.push(`- [ ] ${c}`);
	}
	lines.push('');
	lines.push(
		`## Relevant symbols (context walk, ${slice.length} symbols by personalized-PageRank relevance from ${seeds.length} seed(s))`,
	);
	lines.push('');
	for (const n of slice) {
		const mass = walked.mass.get(n.row);
		let entry = `- \`${n.name}\` (${n.kind}, ${n.layer}) — ${n.file}:${n.start_line}`;
		if (mass !== undefined) {
			entry += ` (walk mass ${mass.toExponential(2)})`;
		}
		if (n.summary) {
			entry += `\n  ${n.summary.slice(0, arm.snippet_chars)}`;
		}
		if (arm.include_runtime) {
			const rt = snapshot.runtime[n.row];
			if (rt) {
				const stale = snapshot.store_epoch > 0 && n.epoch === snapshot.store_epoch;
				entry += `\n  runtime: ×${rt.calls} calls, ${Math.round(rt.total_ms)}ms total`;
				if (rt.errors > 0) {
					entry += `, ${rt.errors} lifetime error(s): ${rt.error_types.join(', ')}`;
					entry += `; latest run: ${rt.current_errors} error(s)`;
				}
				if (stale) {
					entry += ' — STALE: this symbol changed after the trace was captured';
				}
				// Current failures carry full evidence; superseded ones one line
				// of history so a fixed error can never be mistaken for live.
				const ordered = [...rt.failures].sort(
					(a, b) =>
						Number(a.superseded !== null) - Number(b.superseded !== null) ||
						b.count - a.count,
				);
				for (const f of ordered.slice(0, budgets.walk.failure_exemplars)) {
					if (f.superseded === 'not_reproduced') {
						entry += `\n  [RESOLVED] ${f.error_type}${f.error_message ? `: ${f.error_message}` : ''} — a later run completed without it (last seen epoch ${f.capture_epoch ?? '?'})`;
						continue;
					}
					if (f.superseded === 'code_changed') {
						entry += `\n  [UNVERIFIED FIX] ${f.error_type}${f.error_message ? `: ${f.error_message}` : ''} — code changed after this failure; re-run to confirm (epoch ${f.capture_epoch ?? '?'})`;
						continue;
					}
					entry += `\n  observed failure: ${f.error_type}${f.error_message ? `: ${f.error_message}` : ''} (×${f.count}, request ${f.request_id || 'unknown'})`;
					if (f.caller_chain.length) {
						entry += `\n    call path: ${[...f.caller_chain].reverse().join(' → ')} → \`${n.name}\``;
					}
					if (f.args_schema || f.args_summary) {
						entry += `\n    failing-call args: ${f.args_schema ?? ''}${f.args_summary ? ` ${JSON.stringify(f.args_summary)}` : ''}`;
					}
					if (f.error_stack) {
						entry += `\n    traceback (tail):\n\`\`\`\n${f.error_stack.trim()}\n\`\`\``;
					}
				}
			}
		}
		lines.push(entry);
	}
	lines.push('');
	// The slice's own typed adjacency: the agent receives the GRAPH, not just
	// a flat list — which symbol calls which, and what flow was observed live.
	const edgeLines: string[] = [];
	for (const e of snapshot.edges) {
		if (e.kind === 'contains' || !sliceRowSet.has(e.src) || !sliceRowSet.has(e.dst)) {
			continue;
		}
		edgeLines.push(
			`- \`${snapshot.nodes[e.src].name}\` —${e.kind}→ \`${snapshot.nodes[e.dst].name}\``,
		);
	}
	for (const f of snapshot.flow_edges) {
		if (!sliceRowSet.has(f.src) || !sliceRowSet.has(f.dst)) {
			continue;
		}
		edgeLines.push(
			`- \`${snapshot.nodes[f.src].name}\` —observed ×${f.calls}${f.errors ? ` (${f.errors} err)` : ''}${f.observed_only ? ', runtime-only' : ''}→ \`${snapshot.nodes[f.dst].name}\``,
		);
	}
	if (edgeLines.length) {
		lines.push('## Graph edges within this slice (typed; static and observed)');
		lines.push('');
		lines.push(...edgeLines);
		lines.push('');
	}
	lines.push('## Rehydrate more context on demand');
	lines.push('');
	lines.push(
		'This pack is the seed, not the ceiling. The `vinv-index` and `vinv-runtime` MCP servers are ' +
			'live in this workspace: use `vinv_query` for semantic code search, and `rank_suspects`, ' +
			'`slice`, `values_of`, `callers_of`, `why_did_this_run`, `coverage_of`, `blast_radius` for ' +
			'runtime ground truth (observed values, caller chains, fault ranking) on any symbol named above.',
	);
	lines.push('');
	lines.push('## Instructions');
	lines.push('');
	lines.push(
		'Work inside this repository. Investigate using the symbols above as entry points, make the ' +
			'minimal correct change, and verify it yourself before finishing. Do not refactor beyond the fix.',
	);
	lines.push('');
	lines.push(
		'If the USER (in your chat) asks to change how many fix episodes Vinv may spend, or states a ' +
			'new standing goal, relay it by printing a line addressed to vinv, e.g. ' +
			'`vinv: episodes 8` or `vinv: goal keep every service green` — natural phrasing is fine as ' +
			'long as the line starts with "vinv". Vinv parses your output and updates its session state.',
	);
	lines.push('');
	lines.push(
		'If your investigation concludes the PREMISE of this task is wrong — there is no real issue, ' +
			'or the command/evidence Vinv recorded is incorrect — do NOT invent a fix. Say so on the same ' +
			'channel: print `vinv: no issue <why>` or `vinv: wrong command <what is wrong>`. ' +
			'Vinv adjudicates your dispute against its own evidence and either stops the loop or ' +
			'comes back with a changed approach; a false "fixed it" wastes everyone\u2019s budget.',
	);
	if (task.service) {
		lines.push('');
		lines.push(
			`This concerns the service \`${task.service}\`. Its verified start command is recorded in ` +
				`\`.vinv/start_commands/${task.service}.json\`. After your change, the recorded command must ` +
				'start the service successfully IN THE FOREGROUND (no trailing `&`, no `nohup`, no output ' +
				'redirection) — the harness will replay it exactly as recorded to verify your fix. If the ' +
				'start command itself must change, update that JSON file with the corrected plain foreground form.',
		);
	}
	return { content: lines.join('\n') + '\n', sliceRows: slice.map((n) => n.row) };
}

/** Composes and writes a pack to .vinv/context/pack-<id>.md. */
export function writeContextPack(
	workspaceRoot: string,
	snapshot: GraphSnapshot,
	task: PackTask,
	arm: EpisodeArm,
	budgets: PackBudgets,
	attempt: number,
	priorFailure?: string,
): ComposedPack {
	const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
		.randomBytes(3)
		.toString('hex')}`;
	const { content, sliceRows } = composePackContent(
		snapshot,
		task,
		arm,
		budgets,
		attempt,
		priorFailure,
	);
	const dir = contextPackDir(workspaceRoot);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, `pack-${id}.md`);
	fs.writeFileSync(target, content, 'utf8');
	return { id, path: target, content, sliceRows };
}
