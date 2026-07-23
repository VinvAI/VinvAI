/**
 * Transport for the verification agents (goal engine subcommands).
 *
 * The episode loop's agents — audit judge, test authors, stall judge — are
 * prompt renderers in the Python goal engine (goal/src/goal/agents.py in the
 * engines monorepo): each subcommand takes its payload on stdin
 * (`--payload-file -`) and prints the full agent prompt, ending with the
 * exact JSON object schema the reply must contain. The extension dispatches
 * that prompt to the user's coding-agent CLI (the injected `dispatch`) and
 * parses the reply itself. Every invocation is its own render + dispatch, so
 * N authors fan out in true parallel with no shared state.
 *
 * This module is deliberately free of `vscode`: callers resolve the engine
 * path, env, and harness dispatch themselves and pass them in, so the
 * transport is unit-testable with a stub executable. Every failure mode —
 * engine missing, timeout, empty prompt, dispatch failure, malformed reply —
 * returns null; the callers' safe paths (judge unavailable → flags ride to
 * the human; author unavailable → harness fallback or 'unavailable') already
 * handle null. An agent transport must never fabricate a verdict.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import { hiddenBackgroundOptions, killProcessTree } from '../proc';

export interface AgentSpawn {
	binPath: string;
	env: NodeJS.ProcessEnv;
	cwd: string;
	/**
	 * Sends a rendered agent prompt to the coding harness; resolves the reply
	 * text, or null on any failure (see harnessRunner.dispatchAgentPrompt).
	 */
	dispatch: (name: string, prompt: string) => Promise<string | null>;
}

/** Wall-clock bound for the prompt RENDER (no LLM runs — this is fast). */
function renderTimeoutMs(): number {
	const raw = Number.parseFloat(process.env.VINV_AGENT_RENDER_TIMEOUT_S ?? '60');
	return (Number.isFinite(raw) && raw > 0 ? raw : 60) * 1000;
}

/** Renders one agent subcommand's prompt (payload on stdin → prompt on stdout). */
function renderAgentPrompt(
	spawnInfo: AgentSpawn,
	subcommand: string,
	payload: Record<string, unknown>,
): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: string | null) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let child;
		try {
			child = spawn(
				spawnInfo.binPath,
				[subcommand, '--payload-file', '-'],
				hiddenBackgroundOptions({ cwd: spawnInfo.cwd, env: spawnInfo.env }),
			);
		} catch {
			settle(null);
			return;
		}
		let out = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (c: string) => (out = (out + c).slice(-400_000)));
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', () => undefined);
		const timer = setTimeout(() => {
			killProcessTree(child, 'SIGKILL');
			settle(null);
		}, renderTimeoutMs());
		child.on('error', () => {
			clearTimeout(timer);
			settle(null);
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			// An engine without the subcommand prints usage/error text and exits
			// non-zero — both resolve null (agent unavailable).
			settle(code === 0 && out.trim() ? out : null);
		});
		try {
			child.stdin?.write(JSON.stringify(payload));
			child.stdin?.end();
		} catch {
			// A dead stdin surfaces via exit/error above.
		}
	});
}

/**
 * Extracts the JSON object a harness reply must contain: a fenced ```json
 * block when present, else the outermost `{…}` span. Null on any parse miss.
 */
export function parseAgentReply(reply: string): Record<string, unknown> | null {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(reply);
	const candidates: string[] = [];
	if (fenced) {
		candidates.push(fenced[1]);
	}
	const start = reply.indexOf('{');
	const end = reply.lastIndexOf('}');
	if (start !== -1 && end > start) {
		candidates.push(reply.slice(start, end + 1));
	}
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

/**
 * Runs one goal-engine agent: renders the subcommand's prompt (payload on
 * stdin), dispatches it to the coding harness, and returns the parsed JSON
 * object from the reply — or null on ANY failure.
 */
export async function runGoalAgent(
	spawnInfo: AgentSpawn,
	subcommand: 'judge-diff' | 'author-tests' | 'judge-stall',
	payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	if (!spawnInfo.binPath || !fs.existsSync(spawnInfo.binPath)) {
		return null;
	}
	const prompt = await renderAgentPrompt(spawnInfo, subcommand, payload);
	if (!prompt) {
		return null;
	}
	let reply: string | null;
	try {
		reply = await spawnInfo.dispatch(subcommand, prompt);
	} catch {
		reply = null;
	}
	if (!reply) {
		return null;
	}
	return parseAgentReply(reply);
}

/** Contract-validated judge report from a raw agent result (null-safe). */
export function asJudgeReport(raw: Record<string, unknown> | null): {
	cheat_likelihood: number;
	goal_alignment: number;
	criteria_verdicts: Array<{ criterion: string; verdict: 'met' | 'not_met' | 'unverifiable'; reason: string }>;
	scope_drift: 'none' | 'minor' | 'major';
	concerns: string[];
	directives: string[];
} | null {
	if (!raw) {
		return null;
	}
	const unit = (v: unknown): v is number =>
		typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
	if (!unit(raw.cheat_likelihood) || !unit(raw.goal_alignment)) {
		return null;
	}
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 8) : [];
	// criteria_verdicts + scope_drift are optional (an older binary omits them);
	// absence degrades to "no adherence signal", never to a fabricated verdict.
	const verdicts = Array.isArray(raw.criteria_verdicts)
		? raw.criteria_verdicts
				.filter(
					(c): c is { criterion: string; verdict: 'met' | 'not_met' | 'unverifiable'; reason: string } =>
						typeof c === 'object' &&
						c !== null &&
						['met', 'not_met', 'unverifiable'].includes((c as { verdict?: string }).verdict ?? ''),
				)
				.slice(0, 20)
		: [];
	const scope = raw.scope_drift;
	return {
		cheat_likelihood: raw.cheat_likelihood,
		goal_alignment: raw.goal_alignment,
		criteria_verdicts: verdicts,
		scope_drift: scope === 'minor' || scope === 'major' ? scope : 'none',
		concerns: strings(raw.concerns),
		directives: strings(raw.directives),
	};
}

/** Contract-validated stall utilities from a raw agent result (null-safe). */
export function asStallUtilities(raw: Record<string, unknown> | null): {
	explorer_continue: number;
	explorer_escalate: number;
	auditor_continue: number;
	auditor_escalate: number;
	mutation: string;
} | null {
	if (!raw) {
		return null;
	}
	const unit = (v: unknown): v is number =>
		typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
	const names = [
		'explorer_continue',
		'explorer_escalate',
		'auditor_continue',
		'auditor_escalate',
	] as const;
	for (const n of names) {
		if (!unit(raw[n])) {
			return null;
		}
	}
	if (typeof raw.mutation !== 'string' || !raw.mutation.trim()) {
		return null;
	}
	return {
		explorer_continue: raw.explorer_continue as number,
		explorer_escalate: raw.explorer_escalate as number,
		auditor_continue: raw.auditor_continue as number,
		auditor_escalate: raw.auditor_escalate as number,
		mutation: raw.mutation.trim(),
	};
}

/** The authored test file from a raw agent result (null on contract miss). */
export function asAuthoredTests(raw: Record<string, unknown> | null): {
	test_code: string;
	rationale: string;
} | null {
	if (!raw || typeof raw.test_code !== 'string' || !/def test_\w+/.test(raw.test_code)) {
		return null;
	}
	return {
		test_code: raw.test_code,
		rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
	};
}
