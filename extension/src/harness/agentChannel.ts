/**
 * Drain the engine's agent channels — the half of the contract that was missing.
 *
 * Several oracles reach a question no amount of structure answers, because the
 * answer lives in intent rather than syntax: what IS the type contract of this
 * boundary (`faults`), what does a row of this table plausibly hold
 * (`services`), what value does this environment variable want (`envconfig`).
 * `exerciser/agent_loop.py` renders each one into
 * `.vinv/exercise/agent_<topic>.json` — deduplicated by shape, cached forever,
 * budgeted — and its module docstring describes the transport as "the
 * extension (or any agent) dispatches them and writes back a verdict".
 *
 * Nothing ever did. A grep of `extension/src` for any `agent_*.json` returns
 * nothing, so every question those three oracles have ever raised was written
 * to disk and left there. The engine side has been complete and inert: the
 * fault oracle asks for a contract it never receives, the fixture questions
 * seed placeholder rows forever, and configuration escalated to "the harness
 * will answer" escalated into a void.
 *
 * This is that consumer. One dispatcher serves every topic, because the channel
 * format is already uniform — a topic-specific dispatcher would be three copies
 * of one loop, which is the mistake `_worker.py` was written to undo.
 *
 * Three properties it has to have:
 *
 *  - **batched.** Every pending question across every topic goes in ONE harness
 *    run. A run per question is a bill that grows with the repo, and the whole
 *    reason the channel deduplicates by shape is to keep that bill flat.
 *  - **idempotent.** Answered questions are never re-asked; the engine already
 *    caches them, and re-answering would overwrite a human's correction with a
 *    model's guess.
 *  - **honest on failure.** A harness that is not installed, not signed in, or
 *    that answers nothing leaves the questions pending and says so. Writing a
 *    fabricated answer to clear the queue would be strictly worse than leaving
 *    it — the oracle would proceed on invented data believing it was told.
 */

import * as fs from 'fs';
import * as path from 'path';

/** One question as `agent_loop.Question.to_json` writes it. */
export interface ChannelQuestion {
	key: string;
	topic: string;
	subject: string;
	prompt: string;
	reply_schema: string;
	context?: Record<string, unknown>;
	answer?: unknown;
}

export interface ChannelFile {
	path: string;
	topic: string;
	questions: Record<string, ChannelQuestion>;
}

export interface DrainReport {
	/** Questions that were pending before this run. */
	pending: number;
	/** Questions this run wrote an answer for. */
	answered: number;
	/** Topics touched, for the status line. */
	topics: string[];
	/** Why nothing was answered, when nothing was. Never empty on a no-op. */
	detail: string;
	ok: boolean;
}

/** The subset of `runHarnessPrompt` this needs, injected so it is testable. */
export type PromptRunner = (
	name: string,
	prompt: string,
) => Promise<{ ok: boolean; stdout: string; detail?: string }>;

const CHANNEL_PREFIX = 'agent_';
const CHANNEL_SUFFIX = '.json';

/** Cap on questions per harness run — a prompt has to stay readable to answer well. */
const MAX_QUESTIONS_PER_RUN = 25;

export function exerciseDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'exercise');
}

/** Every channel file in a workspace, with its questions parsed. */
export function readChannels(workspaceRoot: string): ChannelFile[] {
	const dir = exerciseDir(workspaceRoot);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: ChannelFile[] = [];
	for (const name of names.sort()) {
		if (!name.startsWith(CHANNEL_PREFIX) || !name.endsWith(CHANNEL_SUFFIX)) {continue;}
		const full = path.join(dir, name);
		try {
			const doc = JSON.parse(fs.readFileSync(full, 'utf8')) as {
				topic?: string;
				questions?: Record<string, ChannelQuestion>;
			};
			out.push({
				path: full,
				topic: doc.topic ?? name.slice(CHANNEL_PREFIX.length, -CHANNEL_SUFFIX.length),
				questions: doc.questions ?? {},
			});
		} catch {
			// A malformed or half-written channel file contributes nothing. It is
			// not an error here: the engine may be mid-write, and the next drain
			// picks it up.
			continue;
		}
	}
	return out;
}

/** Questions still waiting for an answer, across every topic. */
export function pendingQuestions(channels: ChannelFile[]): ChannelQuestion[] {
	const out: ChannelQuestion[] = [];
	for (const channel of channels) {
		for (const question of Object.values(channel.questions)) {
			// `null` and absent both mean unanswered; anything else is an answer,
			// including `false` and `0`, which are legitimate replies.
			if (question && (question.answer === null || question.answer === undefined)) {
				out.push(question);
			}
		}
	}
	return out;
}

/**
 * One prompt carrying every pending question.
 *
 * The reply is asked for as a single JSON object keyed by question id, so one
 * run answers everything and the parse has an unambiguous shape to look for.
 * Each question keeps its own `reply_schema` inline — they differ per topic and
 * the engine validates against them.
 */
export function buildPrompt(questions: ChannelQuestion[]): string {
	const blocks = questions.map((q, i) => {
		const context = q.context && Object.keys(q.context).length
			? `\ncontext: ${JSON.stringify(q.context)}`
			: '';
		return [
			`### ${i + 1}. id \`${q.key}\`  (topic: ${q.topic}, subject: ${q.subject})`,
			q.prompt,
			`${context}`,
			`reply shape for this one: ${q.reply_schema}`,
		].join('\n');
	});
	return [
		'Vinv could not answer the following questions structurally — each needs',
		'intent, not syntax. Answer them from THIS repository: read the code, the',
		'README, the settings classes and the docs. They are cached permanently,',
		'so an answer given once is never asked again.',
		'',
		'Rules:',
		'- Answer only what the repository actually supports. A wrong answer is',
		'  worse than none, because the oracle proceeds believing it was told.',
		'- If you cannot determine one, omit its id entirely rather than guessing.',
		'- Never invent a credential. If a question needs a real secret, answer with',
		'  the documented shape and leave the value null.',
		'',
		...blocks,
		'',
		'Reply with ONE json object and nothing else, mapping each id you answered',
		'to its reply, exactly in this envelope:',
		'{"answers": {"<id>": <reply matching that question\'s shape>, ...}}',
	].join('\n');
}

/**
 * The `{"answers": {...}}` object out of a harness's reply.
 *
 * Harnesses wrap JSON in prose and fences at will, so the last balanced object
 * containing an `answers` key is taken rather than assuming the whole stdout
 * parses. Returns an empty map when nothing usable is present — never throws,
 * because an unparseable reply must leave the queue pending rather than
 * take down the run.
 */
export function parseAnswers(stdout: string): Record<string, unknown> {
	if (!stdout) {return {};}
	const candidates: string[] = [];
	// Fenced blocks first — the common shape — then the raw text.
	const fence = /```(?:json)?\s*([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = fence.exec(stdout)) !== null) {candidates.push(match[1]);}
	candidates.push(stdout);

	for (const text of candidates.reverse()) {
		const start = text.indexOf('{');
		if (start < 0) {continue;}
		// Scan for the balanced close rather than regexing — replies nest.
		let depth = 0;
		let inString = false;
		let escape = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (escape) { escape = false; continue; }
			if (ch === '\\') { escape = true; continue; }
			if (ch === '"') { inString = !inString; continue; }
			if (inString) {continue;}
			if (ch === '{') {depth++;}
			else if (ch === '}') {
				depth--;
				if (depth === 0) {
					try {
						const parsed = JSON.parse(text.slice(start, i + 1)) as {
							answers?: Record<string, unknown>;
						};
						if (parsed && typeof parsed === 'object' && parsed.answers) {
							return parsed.answers;
						}
					} catch {
						// Keep scanning: a later candidate may parse.
					}
					break;
				}
			}
		}
	}
	return {};
}

/** Write answers back into their channel files. Returns how many landed. */
export function applyAnswers(
	channels: ChannelFile[],
	answers: Record<string, unknown>,
): number {
	let written = 0;
	for (const channel of channels) {
		let touched = false;
		for (const [key, question] of Object.entries(channel.questions)) {
			const answer = answers[key];
			if (answer === undefined) {continue;}
			// Never overwrite an existing answer. The engine caches permanently and
			// a human may have corrected one; a later model run must not undo that.
			if (question.answer !== null && question.answer !== undefined) {continue;}
			question.answer = answer;
			touched = true;
			written++;
		}
		if (!touched) {continue;}
		try {
			const doc = JSON.parse(fs.readFileSync(channel.path, 'utf8')) as Record<string, unknown>;
			doc.questions = channel.questions;
			fs.writeFileSync(channel.path, JSON.stringify(doc, null, 2), 'utf8');
		} catch {
			// A file that cannot be written back means those answers did not land.
			written -= Object.keys(channel.questions).length;
		}
	}
	return Math.max(0, written);
}

/**
 * Ask the harness every pending question and write back what it answers.
 *
 * Returns without running anything when the queue is empty, which is the common
 * case and must stay free.
 */
export async function drainAgentChannels(
	workspaceRoot: string,
	run: PromptRunner,
): Promise<DrainReport> {
	const channels = readChannels(workspaceRoot);
	const pending = pendingQuestions(channels);
	const topics = [...new Set(pending.map((q) => q.topic))].sort();

	if (pending.length === 0) {
		return { pending: 0, answered: 0, topics: [], detail: 'no questions pending', ok: true };
	}

	const batch = pending.slice(0, MAX_QUESTIONS_PER_RUN);
	const result = await run('vinv: answer engine questions', buildPrompt(batch));
	if (!result.ok) {
		return {
			pending: pending.length,
			answered: 0,
			topics,
			detail: result.detail || 'the harness run failed',
			ok: false,
		};
	}

	const answers = parseAnswers(result.stdout);
	const answered = applyAnswers(channels, answers);
	return {
		pending: pending.length,
		answered,
		topics,
		detail: answered
			? `answered ${answered}/${pending.length} across ${topics.join(', ')}`
			: 'the harness answered nothing usable — questions stay pending',
		ok: answered > 0,
	};
}
