/**
 * The two questions a dead-code finding raises that static analysis cannot answer.
 *
 * The scan proves only that nothing in the repository references a symbol. It
 * cannot say whether that is safe (reflection, a plugin registry, a name built
 * at runtime all defeat it), nor why the callers went away. Both are readings
 * of the code and its history, so both are asked of the coding harness:
 *
 *   VERIFY  — is this really dead, what does it do, is it safe to delete.
 *   REMOVAL — its callers were removed; find the commit that did it, why, and
 *             what replaced the old flow.
 *
 * REMOVAL is offered only for a symbol whose history says it LOST its callers.
 * For one that never had any there is no removal to explain, and asking anyway
 * invites the agent to invent a story about a commit that does not exist.
 *
 * Dispatch is injected rather than imported so the prompts, the parsing and the
 * persistence are testable without spawning an agent: a live CLI run costs
 * tokens and proves nothing about the code under test.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { parseEnvelope } from './agentChannel';
import type { DeadSymbol } from '../index/deadCodeScan';

/** The harness call, narrowed to what this module needs. */
export type AgentDispatch = (name: string, prompt: string) => Promise<string | null>;

export interface SymbolHistory {
	/**
	 * 'lost its calls' — the name's occurrence count changed in later commits,
	 * so references existed and were removed. 'never wired' — it appears in one
	 * commit only and never had a caller to lose.
	 */
	reason: 'never wired' | 'lost its calls';
	/** First commit that introduced the name in this file; '' when unknown. */
	born: string;
	/** Commits in which the name's occurrence count changed. */
	commits: number;
	/** Newest commits that touched it, `sha date subject`, newest first. */
	recent: string[];
	/**
	 * True when the name is not unique in the project. `git log -S` cannot tell
	 * two same-named symbols apart, so the history above may describe the other
	 * one — the panel says so rather than presenting it as fact.
	 */
	ambiguous: boolean;
}

function git(workspaceRoot: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn('git', ['-C', workspaceRoot, ...args], { windowsHide: true });
		let out = '';
		child.stdout?.on('data', (d: Buffer) => {
			out += d.toString();
		});
		child.stderr?.resume();
		child.on('error', () => resolve(''));
		child.on('close', () => resolve(out.trim()));
	});
}

/**
 * What history says about a symbol, for ONE symbol on demand.
 *
 * Word-bounded on purpose: a plain `-S name` is a substring search, so
 * `Decision` matches every commit that touched `PolicyDecision` and the verdict
 * flips. Run per selection rather than for the whole report — two git calls is
 * nothing for one symbol and minutes for fifty.
 */
export async function symbolHistory(workspaceRoot: string, sym: DeadSymbol): Promise<SymbolHistory> {
	const word = `\\b${sym.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
	const [born, touched] = await Promise.all([
		git(workspaceRoot, ['log', '--reverse', '--format=%ad', '--date=short', '--pickaxe-regex', '-S', word, '--', sym.file]),
		git(workspaceRoot, ['log', '--format=%h %ad %s', '--date=short', '--pickaxe-regex', '-S', word]),
	]);
	const lines = touched.split('\n').filter((l) => l.trim().length > 0);
	return {
		reason: lines.length <= 1 ? 'never wired' : 'lost its calls',
		born: born.split('\n')[0] ?? '',
		commits: lines.length,
		recent: lines.slice(0, 5),
		ambiguous: !!sym.ambiguous,
	};
}

// ---------------------------------------------------------------------------
// verify: is it really dead
// ---------------------------------------------------------------------------

export interface DeadVerdict {
	/** What the code does, in plain language. */
	what: string;
	/** The agent's call on the scan's claim. */
	verdict: 'confirmed-dead' | 'still-used' | 'unclear';
	/** How it concluded that — the reachability it checked. */
	why: string;
	/** What breaks or is lost if it is removed. */
	risk: string;
	safeToDelete: boolean;
	confidence: 'high' | 'medium' | 'low';
	checkedAt: string;
}

export function buildVerifyPrompt(sym: DeadSymbol, source: string, history: SymbolHistory): string {
	return [
		`Vinv's dead-code scan reports \`${sym.name}\` (${sym.kind}) in ${sym.file}:${sym.line} as unreferenced.`,
		'',
		'The scan is STATIC and name-based. It parses every Python file, attributes',
		'references to the scope that made them, and reports a symbol when no',
		'reference to it survives. It cannot see reflection, getattr, plugin',
		'registries, entry points declared outside Python, or a name assembled at',
		'runtime. Your job is to check the claim, not to restate it.',
		'',
		sym.deadCallers && sym.deadCallers.length
			? [
					'IMPORTANT — this symbol IS called. Its callers are:',
					...sym.deadCallers.map((c) => `  ${c}`),
					'',
					'It is reported because every one of those callers is ITSELF unreferenced,',
					'so the whole chain is unreachable. Finding one of them and concluding',
					'"still used" would be wrong: the question is whether anything reaches the',
					'TOP of that chain. Check that, not the immediate call site.',
				].join('\n')
			: 'Nothing in the repository references it — this is the top of its chain.',
		`History: ${history.reason}, first seen ${history.born || 'unknown'}, occurrences changed in ${history.commits} commit(s).`,
		history.ambiguous
			? 'NOTE: the name is not unique in this project, so the history above may describe a different symbol of the same name. Weigh it accordingly.'
			: '',
		'',
		'The code:',
		'```python',
		source,
		'```',
		'',
		'Read the repository — open the file, follow its imports, search for the',
		'name in configuration, templates, entry points and non-Python files, and',
		'check whether anything constructs it dynamically.',
		'',
		'Rules:',
		'- Ground every claim in what you actually found. Cite the file you looked in.',
		'- "I could not find a caller" is NOT the same as "it is safe to delete".',
		'  Say safe_to_delete only when you positively established redundancy.',
		'- If you cannot tell, answer "unclear" and say what would settle it.',
		'',
		'Reply with ONE json object and nothing else:',
		'{"verdict": {',
		'  "what": "what this code does, in plain language",',
		'  "verdict": "confirmed-dead" | "still-used" | "unclear",',
		'  "why": "how you checked, and what you found",',
		'  "risk": "what breaks or is lost if this is removed",',
		'  "safe_to_delete": true | false,',
		'  "confidence": "high" | "medium" | "low"',
		'}}',
	]
		.filter((l) => l !== '')
		.join('\n');
}

export function parseVerdict(stdout: string, now = new Date().toISOString()): DeadVerdict | null {
	const raw = parseEnvelope(stdout, 'verdict');
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const v = raw as Record<string, unknown>;
	const what = String(v.what ?? '').trim();
	if (!what) {
		// "What does it do" is the one answer with no useful default; a reply
		// missing it is not a verdict.
		return null;
	}
	const verdict = String(v.verdict ?? '').trim().toLowerCase();
	const confidence = String(v.confidence ?? '').trim().toLowerCase();
	return {
		what,
		verdict:
			verdict === 'confirmed-dead' || verdict === 'still-used' ? verdict : 'unclear',
		why: String(v.why ?? '').trim(),
		risk: String(v.risk ?? '').trim(),
		// Deletion is the irreversible action, so it is opt-in: anything other
		// than an explicit true reads as false.
		safeToDelete: v.safe_to_delete === true,
		confidence:
			confidence === 'high' || confidence === 'medium' || confidence === 'low'
				? confidence
				: 'low',
		checkedAt: now,
	};
}

// ---------------------------------------------------------------------------
// removal: why the callers went away
// ---------------------------------------------------------------------------

export interface RemovalStory {
	/** The commit that dropped the last call, `sha date subject` when found. */
	commit: string;
	/** Why the callers were removed, as the history shows. */
	why: string;
	/** What took over, or '' when nothing did. */
	replacement: string;
	/** The call path before the change. */
	oldFlow: string;
	/** The call path after it. */
	newFlow: string;
	checkedAt: string;
}

export function buildRemovalPrompt(sym: DeadSymbol, source: string, history: SymbolHistory): string {
	return [
		`\`${sym.name}\` (${sym.file}:${sym.line}) is unreferenced today, but it HAD callers:`,
		`its occurrences changed in ${history.commits} commits since ${history.born || 'unknown'}.`,
		'',
		'Find out what happened to them.',
		'',
		'Recent commits that changed how often the name appears (newest first):',
		...history.recent.map((l) => `  ${l}`),
		history.ambiguous
			? 'NOTE: the name is not unique in this project, so some of those commits may belong to a different symbol of the same name. Verify before relying on one.'
			: '',
		'',
		'The code as it stands:',
		'```python',
		source,
		'```',
		'',
		'Use git history — `git log -S`, `git show`, `git log -p` on the files that',
		'used to call it. Identify the commit that removed the last call, read the',
		'diff, and work out whether the behaviour moved somewhere else or was',
		'dropped outright.',
		'',
		'Rules:',
		'- Name the actual commit. If you cannot find one, say so and leave the',
		'  field empty rather than guessing a plausible sha.',
		'- Describe the OLD and NEW call paths concretely — which function called',
		'  which — not "the code was refactored".',
		'- If nothing replaced it, say so. A capability that was simply removed is',
		'  a different finding from one that was superseded.',
		'',
		'Reply with ONE json object and nothing else:',
		'{"removal": {',
		'  "commit": "<sha date subject>, or empty when not found",',
		'  "why": "why the callers were removed",',
		'  "replacement": "what took over, or empty if nothing did",',
		'  "old_flow": "the call path before the change",',
		'  "new_flow": "the call path after it"',
		'}}',
	]
		.filter((l) => l !== '')
		.join('\n');
}

export function parseRemoval(stdout: string, now = new Date().toISOString()): RemovalStory | null {
	const raw = parseEnvelope(stdout, 'removal');
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const r = raw as Record<string, unknown>;
	const why = String(r.why ?? '').trim();
	if (!why) {
		return null;
	}
	return {
		commit: String(r.commit ?? '').trim(),
		why,
		replacement: String(r.replacement ?? '').trim(),
		oldFlow: String(r.old_flow ?? '').trim(),
		newFlow: String(r.new_flow ?? '').trim(),
		checkedAt: now,
	};
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

export interface SymbolFindings {
	verdict?: DeadVerdict;
	removal?: RemovalStory;
}

export interface DeadCodeFindings {
	schemaVersion: 1;
	/** Keyed by `file:line:name` — see symbolKey. */
	symbols: Record<string, SymbolFindings>;
}

/**
 * Keyed on identity rather than position alone: a symbol that moved keeps its
 * verdict, and a different symbol that lands on the old line does not inherit
 * one written about something else.
 */
export function symbolKey(sym: DeadSymbol): string {
	return `${sym.file}:${sym.line}:${sym.name}`;
}

export function findingsPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'reports', 'deadcode_findings.json');
}

export function readFindings(workspaceRoot: string): DeadCodeFindings {
	try {
		const doc = JSON.parse(fs.readFileSync(findingsPath(workspaceRoot), 'utf8')) as DeadCodeFindings;
		if (doc && typeof doc === 'object' && doc.symbols) {
			return doc;
		}
	} catch {
		// No findings yet, or an unreadable file — either way, start empty.
	}
	return { schemaVersion: 1, symbols: {} };
}

/** Merges one symbol's result over what is stored. Never replaces the file. */
export function writeFinding(workspaceRoot: string, key: string, patch: SymbolFindings): DeadCodeFindings {
	const doc = readFindings(workspaceRoot);
	doc.symbols[key] = { ...(doc.symbols[key] ?? {}), ...patch };
	const file = findingsPath(workspaceRoot);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
	return doc;
}

// ---------------------------------------------------------------------------
// the two actions
// ---------------------------------------------------------------------------

export async function verifyDeadSymbol(
	workspaceRoot: string,
	sym: DeadSymbol,
	source: string,
	history: SymbolHistory,
	dispatch: AgentDispatch,
): Promise<DeadVerdict | null> {
	const reply = await dispatch(`deadcode-verify-${sym.name}`, buildVerifyPrompt(sym, source, history));
	const verdict = reply ? parseVerdict(reply) : null;
	if (verdict) {
		writeFinding(workspaceRoot, symbolKey(sym), { verdict });
	}
	return verdict;
}

export async function explainRemoval(
	workspaceRoot: string,
	sym: DeadSymbol,
	source: string,
	history: SymbolHistory,
	dispatch: AgentDispatch,
): Promise<RemovalStory | null> {
	const reply = await dispatch(`deadcode-removal-${sym.name}`, buildRemovalPrompt(sym, source, history));
	const removal = reply ? parseRemoval(reply) : null;
	if (removal) {
		writeFinding(workspaceRoot, symbolKey(sym), { removal });
	}
	return removal;
}
