/**
 * Goal suggestion — drafts the standing goal a dispatch card asks the user
 * for. `goal create` renders the suggestion prompt (context on stdin, prompt
 * on stdout — no LLM runs in the engine); the prompt is dispatched to the
 * user's coding-agent CLI and the goal is parsed from its JSON reply.
 *
 * The suggestion is a DEFAULT, never a decision: the card renders it into the
 * editable goal textarea and the user's edit/confirm still flows through the
 * same dispatchGo → setGoal path. Every failure mode (binary missing, LM
 * error, timeout) resolves to undefined so the card degrades to today's
 * empty-textarea behavior.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { getBinPath, isBinAvailable } from '../tracelens/bin';
import { getHandbookEnv, getHarnessId } from '../config/settings';
import { dispatchAgentPrompt } from './harnessRunner';
import { hiddenBackgroundOptions, killProcessTree } from '../proc';
import { trajectoryDigest, type SessionState, type TranscriptCitation } from './session';

/** Bound on the prompt render (no LLM — this is fast). */
const RENDER_TIMEOUT_MS = 30_000;
/** Head of the answer carried as evidence — the goal is a distillation, and
 * the answer's opening (finding + verdict) is where its signal lives. */
const ANSWER_EVIDENCE_CHARS = 4_000;
/** Citation rows forwarded as anchor symbols. */
const CITATION_CAP = 12;

export interface GoalContextInput {
	/** The user's ask, verbatim — the question being dispatched. */
	question: string;
	/** The current standing goal ('' when unset). */
	standingGoal: string;
	/** Trajectory digest of the session's episode history ('' when empty). */
	trajectory: string;
	/** Symbols the answer actually cited — name/kind/file:line anchors. */
	citations: TranscriptCitation[];
	/** The answer the user is dispatching from (evidence for the goal). */
	lastAnswer?: string;
}

/**
 * Composes the context document fed to `goal create`. Ordered ask-first
 * because the engine keeps the HEAD on its 80k-char truncation — the ask must
 * survive, the answer tail is the first thing sacrificed. Pure, for tests.
 */
export function composeGoalContext(input: GoalContextInput): string {
	const parts: string[] = [
		"## Ask (the user's request, verbatim)",
		'',
		input.question,
		'',
	];
	if (input.standingGoal) {
		parts.push(
			'## Current standing goal (may be stale — the ask supersedes it)',
			'',
			input.standingGoal,
			'',
		);
	}
	if (input.trajectory) {
		parts.push('## Trajectory so far', '', input.trajectory, '');
	}
	if (input.citations.length > 0) {
		parts.push('## Anchor symbols (cited by the answer to this ask)', '');
		for (const c of input.citations.slice(0, CITATION_CAP)) {
			parts.push(`- \`${c.name}\` (${c.kind}) — ${c.file}:${c.line}`);
		}
		parts.push('');
	}
	if (input.lastAnswer) {
		parts.push(
			'## Most recent answer for this ask (evidence — unverified until an episode confirms it)',
			'',
			input.lastAnswer.slice(0, ANSWER_EVIDENCE_CHARS),
			'',
		);
	}
	return parts.join('\n');
}

/**
 * Pulls the goal-context inputs out of the session: the trajectory digest and
 * the transcript's answer for this exact question (falling back to the most
 * recent answer — dispatch is only offered on an answered turn, but a restored
 * legacy transcript may not carry the match).
 */
export function goalContextFromSession(question: string, session: SessionState): GoalContextInput {
	let answer: { answer: string; citations: TranscriptCitation[] } | undefined;
	let matched = false;
	for (const entry of session.transcript ?? []) {
		if (entry.kind !== 'qa') {
			continue;
		}
		if (entry.question === question) {
			// The (latest) answer to this exact question always wins.
			answer = { answer: entry.answer, citations: entry.citations };
			matched = true;
		} else if (!matched) {
			// No match seen yet: keep tracking the MOST RECENT answer as the
			// stand-in (the old `|| answer === undefined` froze the FIRST one).
			answer = { answer: entry.answer, citations: entry.citations };
		}
	}
	return {
		question,
		standingGoal: session.goal,
		trajectory: trajectoryDigest(session),
		citations: answer?.citations ?? [],
		lastAnswer: answer?.answer,
	};
}

/** True when the goal engine is installed and a suggestion can be attempted. */
export function canSuggestGoal(context: vscode.ExtensionContext): boolean {
	return isBinAvailable(context, 'goal');
}

/**
 * Renders `goal create --context-file -` (context on stdin, prompt on stdout),
 * dispatches the prompt to the coding harness, and resolves the suggested
 * goal string — or undefined on ANY failure. A suggestion is best-effort
 * chrome around the dispatch card, never a blocker for it.
 */
export async function suggestGoal(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	input: GoalContextInput,
): Promise<string | undefined> {
	if (!canSuggestGoal(context)) {
		return undefined;
	}
	const binPath = getBinPath(context, 'goal');
	const contextDoc = composeGoalContext(input);

	const prompt = await new Promise<string | undefined>((resolve) => {
		let settled = false;
		const settle = (value: string | undefined) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let child: ChildProcess | undefined;
		try {
			child = spawn(
				binPath,
				['create', '--context-file', '-'],
				hiddenBackgroundOptions({
					cwd: workspaceRoot,
					env: getHandbookEnv(path.dirname(binPath), workspaceRoot),
					stdio: ['pipe', 'pipe', 'pipe'],
				}),
			);
		} catch {
			child = undefined;
		}
		if (!child) {
			settle(undefined);
			return;
		}
		const proc = child;

		const timer = setTimeout(() => {
			killProcessTree(proc, 'SIGKILL');
			settle(undefined);
		}, RENDER_TIMEOUT_MS);

		let stdout = '';
		proc.stdout?.on('data', (d: Buffer) => {
			stdout += d.toString('utf8');
		});
		// stderr is logging only; consume it so the pipe never back-pressures.
		proc.stderr?.on('data', () => {});
		proc.on('error', () => {
			clearTimeout(timer);
			settle(undefined);
		});
		proc.on('close', (code) => {
			clearTimeout(timer);
			settle(code === 0 && stdout.trim() ? stdout : undefined);
		});

		proc.stdin?.on('error', () => {
			// EPIPE from an engine that died before reading — 'close' settles it.
		});
		proc.stdin?.write(contextDoc, 'utf8');
		proc.stdin?.end();
	});
	if (!prompt) {
		return undefined;
	}
	const reply = await dispatchAgentPrompt(getHarnessId(), workspaceRoot, 'goal-suggest', prompt);
	return reply ? parseGoalOutput(reply) : undefined;
}

/**
 * Extracts the goal from the harness's JSON reply. Tolerates non-JSON
 * prefix/suffix text (prose around a JSON object) by parsing from the first
 * `{` to the last `}`. A legacy `status` field, when present, must be "ok".
 */
export function parseGoalOutput(reply: string): string | undefined {
	const start = reply.indexOf('{');
	const end = reply.lastIndexOf('}');
	if (start === -1 || end <= start) {
		return undefined;
	}
	try {
		const payload = JSON.parse(reply.slice(start, end + 1)) as {
			status?: string;
			goal?: string;
		};
		if (payload.status !== undefined && payload.status !== 'ok') {
			return undefined;
		}
		const goal = (payload.goal ?? '').trim();
		return goal.length > 0 ? goal : undefined;
	} catch {
		return undefined;
	}
}
