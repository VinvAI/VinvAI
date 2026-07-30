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
import {
	optimizationEvidencePath,
	optimizationEvidenceRelPath,
	writeOptimizationEvidence,
} from './optimizationEvidence';
import { loadOpportunityBoard, opportunityBoardPath } from './opportunityBoard';
import {
	loadOptimizationCalibration,
	loadPriorOptimizeAttempts,
	opportunitySignature,
	optimizationCalibrationPath,
	optimizeAttemptsPath,
} from './optimizationAnalysis';

/**
 * Per-symbol summary budget in the pack.
 *
 * A FIXED constant, deliberately. This was a learnable bandit feature and the
 * measurement showed why that was wrong: summaries here top out at 696 chars
 * (median 76, p99 160), so neither of the old 800/1600 levels ever cut anything
 * and the bit the bandit spent half its arm space exploring was inert. Making it
 * learnable again would repeat that. 800 preserves today's behaviour exactly —
 * it is above the observed maximum, so it truncates nothing — while leaving a
 * bound in place for a summariser that later emits longer text.
 */
const PACK_SUMMARY_CHARS = 800;

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
	/**
	 * Optimization-episode context offload: when set, the heavy evidence (the
	 * candidate's span proof + persisted attempt history) is written ONCE to
	 * `.vinv/context/opt-<signature>.md` and the pack body carries only the
	 * one-line summary plus the file path — the harness agent reads the file
	 * when it needs depth. The file expires with the attempt store's
	 * session-relative rule (see optimizationEvidence.ts).
	 */
	optimization?: OptimizationOffload;
}

/** The offload payload an optimization dispatch attaches to its task. */
export interface OptimizationOffload {
	/** Opportunity signature (optimizationAnalysis.opportunitySignature). */
	signature: string;
	/** One-line summary printed in the pack body next to the link. */
	summary: string;
	/** Heavy evidence: the ranked candidates' span proof (offloaded). */
	span_proof?: string;
	/** Heavy evidence: prior-attempt history (offloaded). */
	attempt_history?: string;
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
	if (task.optimization) {
		// Context offload: the pack links the evidence file instead of inlining
		// it. writeContextPack writes/refreshes the file; this section is the
		// reload instruction the agent follows when it needs depth.
		lines.push('## Offloaded evidence (read on demand)');
		lines.push('');
		lines.push(
			`- \`${optimizationEvidenceRelPath(task.optimization.signature)}\` — ${task.optimization.summary}`,
		);
		lines.push('');
		lines.push(
			'That file holds the full span proof and the prior-attempt history for this ' +
				'opportunity. This pack deliberately carries only the one-line summary — read the ' +
				'file (workspace-relative path above) when you need the measured evidence or what ' +
				'earlier attempts already tried.',
		);
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
			entry += `\n  ${n.summary.slice(0, PACK_SUMMARY_CHARS)}`;
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
		lines.push('');
		// Without this, the cheapest way to make a broken `tracelens run …`
		// command start is to delete the wrapper — which passes every criterion
		// while silently ending tracing, and tracing is the entire point.
		lines.push(
			'**If the recorded command wraps the process in `tracelens run`, it MUST STILL wrap it after ' +
				'your fix.** That wrapper is what produces the runtime evidence everything downstream is ' +
				'built from; a service that starts green with no traces is a WORSE outcome than one that ' +
				'does not start, because nothing reports it. Keep the `--target-package` flags and the ' +
				'`--output` path exactly as recorded. Never "fix" a start failure by removing tracelens, ' +
				'and never drop it because it is hard to resolve.',
		);
		lines.push(
			'A `tracelens: command not found` (exit 127) means the command relies on a PATH it does not ' +
				'carry — Vinv’s bring-up shell had the engine `bin/` prepended, and nothing that replays ' +
				'the command does. Make the recorded string self-contained instead of removing the wrapper: ' +
				'prepend the service venv’s `bin/` to `PATH` INLINE in the command (an absolute path to ' +
				'`tracelens` alone is not enough — it shells out to `opentelemetry-instrument`, which lives ' +
				'in that same `bin/`), and name the interpreter explicitly rather than a bare `python`. ' +
				'`tracelens` must also be importable BY that interpreter: the child hook is injected through ' +
				'`sitecustomize` and swallows a failed `import tracelens` silently, leaving parent-process ' +
				'spans only and no error. Verify with `<venv>/bin/python -c "import tracelens"`.',
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
	if (task.optimization) {
		// Offload BEFORE the pack lands: the pack links this file, so the link
		// must never dangle for the agent that reads the pack a moment later.
		writeOptimizationEvidence(workspaceRoot, {
			signature: task.optimization.signature,
			title: task.title,
			span_proof: task.optimization.span_proof,
			attempt_history: task.optimization.attempt_history,
		});
	}
	const target = path.join(dir, `pack-${id}.md`);
	fs.writeFileSync(target, content, 'utf8');
	return { id, path: target, content, sliceRows };
}

// ---- knowledge slices: optimization playbooks -------------------------------
//
// The playbooks are distilled practitioner guidance per waste kind, shipped as
// DATA with the extension (extension/resources/playbooks/<kind>.md — that
// directory is not .vscodeignore'd, so it lands in the .vsix next to out/).
// The MCP `vinv_session action="playbook"` surface serves a slice through
// composePlaybookSlice below: the playbook text PLUS the live artifact paths
// holding this workspace's current evidence for that kind.

/** Every playbook kind that ships. Detector provenance, on this HEAD:
 * cache/n-plus-1/serial-async/fanout/per-call are extension waste kinds
 * (optimizationAnalysis), wait is the tracelens blocked_ms signal, and
 * throughput-ceiling is the exerciser USL sweep; gc-pressure has no dedicated
 * detector yet and is reached from per-call/memory evidence. */
export const PLAYBOOK_KINDS = [
	'cache',
	'n-plus-1',
	'serial-async',
	'fanout',
	'per-call',
	'wait',
	'gc-pressure',
	'throughput-ceiling',
	// memory dimension (bytes): the allocation/retention waste kinds.
	'alloc-churn',
	'mem-leak',
] as const;

export type PlaybookKind = (typeof PLAYBOOK_KINDS)[number];

/** Where the shipped playbooks live, given the installed extension dir. */
export function playbooksDir(extensionDir: string): string {
	return path.join(extensionDir, 'resources', 'playbooks');
}

/**
 * Loads one playbook. Loud on both failure modes: an unknown kind lists the
 * valid ones (agent typo), a missing file names the path (packaging bug) —
 * neither may degrade to an empty slice that looks like guidance.
 */
export function loadPlaybook(extensionDir: string, kind: string): string {
	if (!(PLAYBOOK_KINDS as readonly string[]).includes(kind)) {
		throw new Error(
			`unknown playbook kind '${kind}' — valid kinds: ${PLAYBOOK_KINDS.join(', ')}`,
		);
	}
	const file = path.join(playbooksDir(extensionDir), `${kind}.md`);
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		throw new Error(`playbook file missing at ${file} — the extension package is incomplete`);
	}
}

/** The sweep-level attempt signature that dispatches this kind's candidates
 * (autoTrigger's OptimizeOpportunity construction: cache rides the cache
 * sweep, every other board kind rides the hotspot sweep). */
function sweepSignatureFor(kind: string): { label: string; signature: string } {
	return kind === 'cache'
		? {
				label: 'cache sweep',
				signature: opportunitySignature({ kind: 'cache-sweep', endpoint_id: 'cache-candidates' }),
			}
		: {
				label: 'hotspot sweep',
				signature: opportunitySignature({ kind: 'hotspot-sweep', endpoint_id: 'hotspots' }),
			};
}

/**
 * The playbook slice the MCP `playbook` action returns: the shipped guidance
 * for `kind` plus the live artifact paths carrying this workspace's current
 * evidence — the board entries of that kind, the persisted attempt history
 * behind their signatures, the offloaded evidence files, and the learned
 * calibration ratio. Pure reads; throws (loudly) only on an unknown kind or a
 * missing playbook file.
 */
export function composePlaybookSlice(
	workspaceRoot: string,
	extensionDir: string,
	kind: string,
): string {
	const playbook = loadPlaybook(extensionDir, kind);
	const lines: string[] = [playbook.trimEnd(), '', '---', ''];
	lines.push(`## Live evidence for kind '${kind}' in this workspace`);
	lines.push('');

	// Board entries of this kind (full lifecycle — the agent sees held ones too).
	const board = loadOpportunityBoard(workspaceRoot).filter((e) => e.kind === kind);
	lines.push(`Opportunity board (${opportunityBoardPath(workspaceRoot)}):`);
	if (board.length === 0) {
		lines.push(
			`- no board entries of kind '${kind}' right now — the analyzer posts them as trace evidence arrives`,
		);
	}
	for (const e of board) {
		lines.push(
			`- [${e.status}] ${e.name} at ${e.file}:${e.line} — ~${Math.round(e.predicted_ms)}ms predicted: ` +
				`${e.evidence}${e.resolution ? ` → ${e.resolution}` : ''} (id ${e.id})`,
		);
	}
	lines.push('');

	// Attempt history for those candidates' dispatch signatures + the sweep key.
	const attemptsFile = optimizeAttemptsPath(workspaceRoot);
	lines.push(`Attempt history (${attemptsFile}):`);
	let attemptLines = 0;
	for (const e of board) {
		const signature = opportunitySignature({ kind: e.kind, endpoint_id: e.name });
		const attempts = loadPriorOptimizeAttempts(workspaceRoot, e.row, signature);
		if (attempts.length > 0) {
			attemptLines += 1;
			lines.push(
				`- ${e.name}: ${attempts.length} prior attempt(s) — ` +
					attempts.map((a) => a.verdict).join(', ') +
					`; offloaded evidence: ${optimizationEvidencePath(workspaceRoot, signature)}` +
					(fs.existsSync(optimizationEvidencePath(workspaceRoot, signature))
						? ''
						: ' (not written yet)'),
			);
		}
	}
	const sweep = sweepSignatureFor(kind);
	const sweepAttempts = loadPriorOptimizeAttempts(workspaceRoot, undefined, sweep.signature);
	if (sweepAttempts.length > 0) {
		attemptLines += 1;
		lines.push(
			`- ${sweep.label}: ${sweepAttempts.length} prior attempt(s) — ` +
				sweepAttempts.map((a) => a.verdict).join(', '),
		);
	}
	if (attemptLines === 0) {
		lines.push(`- no persisted attempts for kind '${kind}' yet`);
	}
	lines.push('');

	// Learned calibration for this kind's predictions.
	const calibration = loadOptimizationCalibration(workspaceRoot);
	const ratio = calibration?.[kind];
	lines.push(`Calibration (${optimizationCalibrationPath(workspaceRoot)}):`);
	lines.push(
		ratio !== undefined
			? `- learned ratio ${ratio.toFixed(3)} — '${kind}' predictions have historically delivered ` +
					`${(ratio * 100).toFixed(0)}% of the predicted ms; ranking already applies this deflation`
			: `- no learned ratio for '${kind}' yet — predictions are taken at face value until outcomes accrue`,
	);
	lines.push('');

	// Episode verdicts + kind-specific extras.
	lines.push('Episode verdicts:');
	lines.push(
		`- ${path.join(workspaceRoot, '.vinv', 'exercise', 'optimize.jsonl')} — one row per finished ` +
			'optimization episode (attempts, paired-bootstrap CIs, accept/revert)',
	);
	if (kind === 'throughput-ceiling') {
		lines.push(
			`- ${path.join(workspaceRoot, '.vinv', 'exercise', 'throughput_sweep.json')} — the USL ` +
				'concurrency-sweep fit this kind is detected from (re-run the sweep to verify a fix)',
		);
	}
	return lines.join('\n');
}
