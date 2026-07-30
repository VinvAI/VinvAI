/**
 * Cross-episode session state — the memory that makes episodes a TRAJECTORY
 * toward a goal instead of isolated shots.
 *
 * Each session carries:
 * - the standing GOAL (set by the user in VS Code, or relayed through the
 *   harness chat — the pack instructs the agent to forward the user's words),
 * - the episode budget for that goal (default 5, adjustable by the user from
 *   either side: a VS Code command, or a `VINV: SET_EPISODE_BUDGET n` line the
 *   harness emits when the user asks for more/fewer episodes in chat),
 * - the full episode history for the goal (id, arm, reward, verdict, evidence
 *   digest), which the next pack cites so the agent sees what was already
 *   tried and how it scored — comparison across runs, not amnesia.
 *
 * Nothing is truncated: history is complete and append-only; a digest of it
 * (not a slice of it) is what enters the pack, computed per entry.
 *
 * SESSIONS ARE PLURAL, AND EVERY ONE IS A FILE: each session lives at
 * `.vinv/askvinv/sessions/<id>.json`, and `.vinv/askvinv/active.json` names
 * the active one. Switching is just moving the pointer — no copying, no
 * parking dance — so it is safe WHILE work runs: an episode or answer binds
 * to the session id it started under and keeps writing there (by-id
 * variants of the mutators below), regardless of what the user is looking
 * at. loadSession() resolves the pointer, so every existing reader — episode
 * loop, MCP server, trajectory report — keeps working untouched. The chat
 * transcript is persisted on the session itself so a switch restores the
 * conversation, not just the goal. Deleting a session moves it to
 * `.vinv/session-archive/` — history stays append-only even at the session
 * granularity. Legacy stores (`.vinv/session.json`, `.vinv/sessions/`) are
 * migrated in on first read.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface EpisodeOutcome {
	episode_id: string;
	ts: string;
	title: string;
	arm_index: number;
	attempts: number;
	verified: boolean;
	aborted: boolean;
	reward: number;
	/**
	 * Executable-evidence weight behind `reward` (oracle + acceptance tests +
	 * regression, before renormalization). 0 means NOTHING executable ran, so the
	 * reward is the audit/adherence components alone.
	 *
	 * Persisted because `reward` is renormalized over the components that were
	 * AVAILABLE — correct MNAR handling, since an unrunnable check is not a
	 * verdict — which makes the bare number incomparable across episodes: a clean
	 * verified pass and an episode where nothing could be checked both render
	 * 1.00. Optional: records written before this field carry `undefined`, which
	 * means UNKNOWN and must never be displayed as if it were verified.
	 */
	verification_weight?: number;
	/** One-line evidence digest of the final verdict (what happened, why). */
	evidence: string;
	/** Path to the last context pack — the full-evidence artifact for this
	 * episode, cited in later packs so nothing is lost to the digest. */
	pack_path?: string;
	/** The full issue text (optional — enables post-completion dispute: the
	 * issue signature locates the episode's test set, and a re-dispatch needs
	 * the verbatim issue). Absent on records written before reconciliation. */
	issue?: string;
	/** Service name for service-fix episodes (re-dispatch needs it). */
	service?: string;
}

/**
 * Amends one recorded episode outcome (reconciliation: a retraction flips
 * verified→false after a human counterexample reproduced). Returns true when
 * the episode was found and amended.
 */
export function amendEpisodeOutcome(
	workspaceRoot: string,
	episodeId: string,
	patch: Partial<Pick<EpisodeOutcome, 'verified' | 'evidence'>>,
	sessionId?: string,
): boolean {
	const session = sessionId
		? (loadSessionById(workspaceRoot, sessionId) ?? loadSession(workspaceRoot))
		: loadSession(workspaceRoot);
	const outcome = session.history.find((e) => e.episode_id === episodeId);
	if (!outcome) {
		return false;
	}
	Object.assign(outcome, patch);
	if (sessionId && session.id === sessionId) {
		writeSessionFile(workspaceRoot, session);
	} else {
		saveSession(workspaceRoot, session);
	}
	return true;
}

/** A citation kept with a persisted answer, enough to re-render its chip. */
export interface TranscriptCitation {
	file: string;
	line: number;
	name: string;
	kind: string;
}

/**
 * One persisted chat event. QnA turns carry everything the webview needs to
 * re-render the answer (citations, decision id for late feedback); notices are
 * one-liners worth keeping across a switch (dispatches, session events).
 */
export type TranscriptEntry =
	| {
			kind: 'qa';
			ts: string;
			question: string;
			answer: string;
			mode: string;
			decisionId: string;
			citations: TranscriptCitation[];
	  }
	| { kind: 'notice'; ts: string; text: string };

export interface SessionState {
	version: 1;
	/** Stable identity used for parking/switching. Assigned lazily so legacy
	 * session.json files (which predate ids) stay valid until first written. */
	id?: string;
	created_at?: string;
	/** The user's standing goal, in their own words. Empty = per-task mode. */
	goal: string;
	/** Episodes the trajectory may spend on the goal before a hard stop. */
	episode_budget: number;
	/** Episodes spent on the CURRENT goal (reset when the goal changes). */
	episodes_used: number;
	/** Complete outcome history, oldest first. */
	history: EpisodeOutcome[];
	/** Persisted chat transcript, oldest first — restored on panel open and
	 * session switch. Absent on legacy files; treated as empty. */
	transcript?: TranscriptEntry[];
	updated_at: string;
}

export const DEFAULT_EPISODE_BUDGET = 5;

/** Legacy single-session file — read only to migrate it into the new store. */
export function sessionFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'session.json');
}

/** Legacy parked-session dir — read only to migrate it into the new store. */
function legacyParkedDirPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'sessions');
}

/** Every session lives here, one file per session, active included. */
export function sessionsDirPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'askvinv', 'sessions');
}

/** The pointer naming the active session — switching sessions moves ONLY this. */
function activePointerPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'askvinv', 'active.json');
}

/** Ids come from randomUUID; anything else (or a path-shaped string) is refused
 * before it can name a file. */
function isSafeSessionId(id: string): boolean {
	return /^[\w-]+$/.test(id);
}

function sessionFileById(workspaceRoot: string, id: string): string {
	return path.join(sessionsDirPath(workspaceRoot), `${id}.json`);
}

function readActiveId(workspaceRoot: string): string | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(activePointerPath(workspaceRoot), 'utf8')) as {
			id?: unknown;
		};
		if (typeof raw.id === 'string' && isSafeSessionId(raw.id)) {
			return raw.id;
		}
	} catch {
		// Missing or unreadable pointer — no active session on disk yet.
	}
	return undefined;
}

function writeActivePointer(workspaceRoot: string, id: string): void {
	const target = activePointerPath(workspaceRoot);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${JSON.stringify({ id }, null, '\t')}\n`, 'utf8');
}

function emptySession(): SessionState {
	const now = new Date().toISOString();
	return {
		version: 1,
		id: crypto.randomUUID(),
		created_at: now,
		goal: '',
		episode_budget: DEFAULT_EPISODE_BUDGET,
		episodes_used: 0,
		history: [],
		transcript: [],
		updated_at: now,
	};
}

/** Schema gate shared by the active file and parked session files. */
function validateSession(raw: Partial<SessionState>): SessionState | undefined {
	if (
		raw.version === 1 &&
		typeof raw.goal === 'string' &&
		Number.isInteger(raw.episode_budget) &&
		(raw.episode_budget as number) >= 1 &&
		Number.isInteger(raw.episodes_used) &&
		Array.isArray(raw.history)
	) {
		return raw as SessionState;
	}
	return undefined;
}

/**
 * One-time migration from the two legacy layouts: the single-session
 * `.vinv/session.json` becomes the active session in the new store, and any
 * `.vinv/sessions/*.json` parked files move over keeping their ids. Runs on
 * every load but is a couple of existence checks once migrated.
 */
function migrateLegacyStore(workspaceRoot: string): void {
	const oldDir = legacyParkedDirPath(workspaceRoot);
	if (fs.existsSync(oldDir)) {
		try {
			for (const name of fs.readdirSync(oldDir)) {
				if (!name.endsWith('.json')) {
					continue;
				}
				const oldFile = path.join(oldDir, name);
				try {
					const valid = validateSession(
						JSON.parse(fs.readFileSync(oldFile, 'utf8')) as Partial<SessionState>,
					);
					if (valid) {
						valid.id = name.slice(0, -5);
						writeSessionFile(workspaceRoot, valid);
					}
					fs.unlinkSync(oldFile);
				} catch {
					// A malformed parked file stays behind; it never blocked anything.
				}
			}
			fs.rmdirSync(oldDir);
		} catch {
			// Dir not fully drainable — retry on the next load.
		}
	}
	if (readActiveId(workspaceRoot) === undefined && fs.existsSync(sessionFilePath(workspaceRoot))) {
		try {
			const valid = validateSession(
				JSON.parse(fs.readFileSync(sessionFilePath(workspaceRoot), 'utf8')) as Partial<SessionState>,
			);
			if (valid) {
				writeSessionFile(workspaceRoot, valid);
				writeActivePointer(workspaceRoot, valid.id as string);
				fs.unlinkSync(sessionFilePath(workspaceRoot));
			}
		} catch {
			// Malformed legacy file: leave it in place, start clean.
		}
	}
}

/** Loads the ACTIVE session, tolerating absence and malformed files whole. */
export function loadSession(workspaceRoot: string): SessionState {
	migrateLegacyStore(workspaceRoot);
	const id = readActiveId(workspaceRoot);
	if (id) {
		const session = loadSessionById(workspaceRoot, id);
		if (session) {
			return session;
		}
	}
	return emptySession();
}

/** Loads any session by id; undefined when unknown or malformed. */
export function loadSessionById(workspaceRoot: string, id: string): SessionState | undefined {
	if (!isSafeSessionId(id)) {
		return undefined;
	}
	try {
		const valid = validateSession(
			JSON.parse(fs.readFileSync(sessionFileById(workspaceRoot, id), 'utf8')) as
				Partial<SessionState>,
		);
		if (valid) {
			// The file NAME is the identity — a body that lost its id still loads.
			valid.id = id;
			return valid;
		}
	} catch {
		// Missing or unreadable.
	}
	return undefined;
}

/**
 * Writes a session's own file WITHOUT touching the active pointer — the write
 * path for background (by-id) mutations, so an episode finishing in a parked
 * session can never hijack what the user is looking at.
 */
function writeSessionFile(workspaceRoot: string, session: SessionState): void {
	if (!session.id) {
		session.id = crypto.randomUUID();
	}
	if (!session.created_at) {
		session.created_at = new Date().toISOString();
	}
	session.updated_at = new Date().toISOString();
	const target = sessionFileById(workspaceRoot, session.id);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const payload = `${JSON.stringify(session, null, '\t')}\n`;
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, payload, 'utf8');
	try {
		fs.renameSync(tmp, target);
	} catch {
		// Windows: rename over a file another process holds open fails with
		// EPERM (same hazard the Rust store's two-phase commit works around).
		// This is a single small file, so a direct rewrite is a safe fallback —
		// loadSession validates the schema and falls back to defaults on a tear.
		fs.writeFileSync(target, payload, 'utf8');
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Leftover tmp is harmless.
		}
	}
}

/** Saves the session AND makes it active. For background writes that must not
 * move the pointer, the by-id mutators below use writeSessionFile directly. */
export function saveSession(workspaceRoot: string, session: SessionState): void {
	writeSessionFile(workspaceRoot, session);
	writeActivePointer(workspaceRoot, session.id as string);
}

/**
 * Guarantees the active session exists ON DISK with a stable id and returns
 * it. Called at the moments work binds to a session — panel open, question
 * asked, episode dispatched — so the binding id survives later loads.
 */
export function ensureSessionPersisted(workspaceRoot: string): SessionState {
	const session = loadSession(workspaceRoot);
	if (
		!session.id ||
		readActiveId(workspaceRoot) !== session.id ||
		!fs.existsSync(sessionFileById(workspaceRoot, session.id))
	) {
		saveSession(workspaceRoot, session);
	}
	return session;
}

/** True when the session carries anything worth keeping across a switch/reset. */
function hasContent(session: SessionState): boolean {
	return (
		session.goal !== '' ||
		session.episodes_used > 0 ||
		session.history.length > 0 ||
		(session.transcript?.length ?? 0) > 0
	);
}

/** Best-effort copy into the append-only session archive. */
function archiveSessionSnapshot(workspaceRoot: string, session: SessionState): void {
	try {
		const dir = path.join(workspaceRoot, '.vinv', 'session-archive');
		fs.mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		fs.writeFileSync(
			path.join(dir, `session-${stamp}${session.id ? `-${session.id}` : ''}.json`),
			`${JSON.stringify(session, null, '\t')}\n`,
			'utf8',
		);
	} catch {
		// Archive is best-effort; the caller's operation still proceeds.
	}
}

function dropSessionFile(workspaceRoot: string, id: string): void {
	try {
		fs.unlinkSync(sessionFileById(workspaceRoot, id));
	} catch {
		// Already gone.
	}
}

/**
 * HARD reset: the current session is archived to session-archive (history is
 * append-only, so a reset moves it aside, never destroys it), removed from
 * the switcher, and a clean session becomes active. An already-empty session
 * skips the archive but its empty shell is still dropped.
 */
export function resetSession(workspaceRoot: string): SessionState {
	const current = loadSession(workspaceRoot);
	if (hasContent(current)) {
		archiveSessionSnapshot(workspaceRoot, current);
	}
	if (current.id) {
		dropSessionFile(workspaceRoot, current.id);
	}
	const fresh = emptySession();
	saveSession(workspaceRoot, fresh);
	return fresh;
}

/**
 * "New session": a clean session becomes active; the current one simply stays
 * in the store, switchable any time — its file was never anywhere else. An
 * EMPTY current session is dropped instead, so repeatedly clicking "new
 * session" cannot accumulate blank shells.
 */
export function startFreshSession(workspaceRoot: string): SessionState {
	const current = loadSession(workspaceRoot);
	if (current.id) {
		if (hasContent(current)) {
			writeSessionFile(workspaceRoot, current);
		} else {
			dropSessionFile(workspaceRoot, current.id);
		}
	}
	const fresh = emptySession();
	saveSession(workspaceRoot, fresh);
	return fresh;
}

/** Display name: the goal, else the first question asked, else the birth date. */
export function sessionTitle(session: SessionState): string {
	if (session.goal) {
		return session.goal.length > 60 ? `${session.goal.slice(0, 57)}…` : session.goal;
	}
	const firstQa = session.transcript?.find((t) => t.kind === 'qa');
	if (firstQa && firstQa.kind === 'qa') {
		return firstQa.question.length > 60 ? `${firstQa.question.slice(0, 57)}…` : firstQa.question;
	}
	return session.created_at ? `session of ${session.created_at.slice(0, 10)}` : 'untitled session';
}

export interface SessionSummary {
	id: string;
	title: string;
	goal: string;
	active: boolean;
	episodes: number;
	questions: number;
	updated_at: string;
}

/** The active session plus every other stored one, active first then newest
 * first. Empty non-active shells are hidden (and reaped on switch). */
export function listSessions(workspaceRoot: string): SessionSummary[] {
	const summarize = (s: SessionState, active: boolean): SessionSummary => ({
		id: s.id ?? '',
		title: sessionTitle(s),
		goal: s.goal,
		active,
		episodes: s.history.length,
		questions: s.transcript?.filter((t) => t.kind === 'qa').length ?? 0,
		updated_at: s.updated_at,
	});
	const active = loadSession(workspaceRoot);
	const out: SessionSummary[] = [summarize(active, true)];
	const rest: SessionSummary[] = [];
	try {
		for (const name of fs.readdirSync(sessionsDirPath(workspaceRoot))) {
			if (!name.endsWith('.json') || name.slice(0, -5) === active.id) {
				continue;
			}
			const session = loadSessionById(workspaceRoot, name.slice(0, -5));
			if (session && hasContent(session)) {
				rest.push(summarize(session, false));
			}
		}
	} catch {
		// No sessions dir yet — only the active session exists.
	}
	rest.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
	out.push(...rest);
	return out;
}

/**
 * Makes session `id` active by moving the pointer — the outgoing session's
 * file stays exactly where it is, which is what makes switching safe while an
 * episode or answer is still running against it: their by-id writes keep
 * landing in that file. Returns undefined (and changes nothing) when the id
 * is unknown or malformed.
 */
export function switchToSession(workspaceRoot: string, id: string): SessionState | undefined {
	const target = loadSessionById(workspaceRoot, id);
	if (!target) {
		return undefined;
	}
	const current = loadSession(workspaceRoot);
	if (current.id && current.id !== id && !hasContent(current)) {
		// Leaving an untouched fresh session: reap the shell.
		dropSessionFile(workspaceRoot, current.id);
	}
	writeActivePointer(workspaceRoot, id);
	return target;
}

/**
 * Removes a non-active session from the switcher by moving it to
 * session-archive — the same append-only afterlife resetSession uses, so
 * "delete" never destroys history. Refuses the active session and unknown ids.
 */
export function deleteParkedSession(workspaceRoot: string, id: string): boolean {
	if (!isSafeSessionId(id) || readActiveId(workspaceRoot) === id) {
		return false;
	}
	const session = loadSessionById(workspaceRoot, id);
	if (!session) {
		return false;
	}
	try {
		archiveSessionSnapshot(workspaceRoot, session);
		fs.unlinkSync(sessionFileById(workspaceRoot, id));
		return true;
	} catch {
		return false;
	}
}

/**
 * Appends one chat event to a session's persisted transcript. With a
 * sessionId, the write is BOUND to that session (an answer that finished
 * after the user switched away lands in the session that asked, and never
 * moves the active pointer); without one it targets the active session.
 */
export function appendTranscriptEntry(
	workspaceRoot: string,
	entry: TranscriptEntry,
	sessionId?: string,
): void {
	const session = sessionId
		? loadSessionById(workspaceRoot, sessionId)
		: loadSession(workspaceRoot);
	if (!session) {
		return;
	}
	(session.transcript ??= []).push(entry);
	if (sessionId) {
		writeSessionFile(workspaceRoot, session);
	} else {
		saveSession(workspaceRoot, session);
	}
}

/** Sets (or clears) the standing goal; a changed goal resets the trajectory. */
/**
 * Sets the standing goal. `resetCounter` (default true for a USER-initiated
 * change) zeroes episodes_used so a fresh goal gets a fresh budget. An
 * AGENT-relayed change (harness stdout directive) MUST pass false: otherwise an
 * agent that emits a new goal each episode resets the counter every time and
 * escapes the episode budget entirely — an autonomy/injection hole.
 */
export function setGoal(
	workspaceRoot: string,
	goal: string,
	resetCounter = true,
	sessionId?: string,
): SessionState {
	const session = sessionId
		? (loadSessionById(workspaceRoot, sessionId) ?? loadSession(workspaceRoot))
		: loadSession(workspaceRoot);
	if (session.goal !== goal) {
		session.goal = goal;
		if (resetCounter) {
			session.episodes_used = 0;
		}
	}
	if (sessionId && session.id === sessionId) {
		writeSessionFile(workspaceRoot, session);
	} else {
		saveSession(workspaceRoot, session);
	}
	return session;
}

/** Sets the episode budget (validated 1..20; source: user, either side).
 * A sessionId binds the write to that session without moving the pointer. */
export function setEpisodeBudget(
	workspaceRoot: string,
	budget: number,
	sessionId?: string,
): SessionState {
	const session = sessionId
		? (loadSessionById(workspaceRoot, sessionId) ?? loadSession(workspaceRoot))
		: loadSession(workspaceRoot);
	if (Number.isInteger(budget) && budget >= 1 && budget <= 20) {
		session.episode_budget = budget;
	}
	if (sessionId && session.id === sessionId) {
		writeSessionFile(workspaceRoot, session);
	} else {
		saveSession(workspaceRoot, session);
	}
	return session;
}

/**
 * Records an episode outcome and advances the trajectory counter. Episodes
 * pass the sessionId they were DISPATCHED under, so an outcome that arrives
 * after the user switched sessions still lands in the trajectory it belongs
 * to — the enabling detail for switching sessions while episodes run.
 */
export function recordEpisodeOutcome(
	workspaceRoot: string,
	outcome: EpisodeOutcome,
	sessionId?: string,
): SessionState {
	const session = sessionId
		? (loadSessionById(workspaceRoot, sessionId) ?? loadSession(workspaceRoot))
		: loadSession(workspaceRoot);
	session.history.push(outcome);
	session.episodes_used += 1;
	if (sessionId && session.id === sessionId) {
		writeSessionFile(workspaceRoot, session);
	} else {
		saveSession(workspaceRoot, session);
	}
	return session;
}

/**
 * Directives the harness may emit when the USER asks for them in its chat —
 * the harness-side half of the tri-directional channel. Parsed from the run's
 * stdout; values are validated, never trusted raw.
 *
 * The interface is NATURAL, not a rigid all-caps token: any line addressed to
 * vinv (`vinv`, `Vinv:`, `/vinv`, `\vinv`, `VINV,` …) whose intent is
 * recognizable counts. Accepted phrasings (case-insensitive):
 *   vinv: set episode budget to 7        vinv episodes 7
 *   VINV: SET_EPISODE_BUDGET 7           /vinv budget 7
 *   vinv: set goal make checkout fast    vinv goal: keep services green
 * A line must still be ADDRESSED to vinv — free prose never triggers state
 * changes, which keeps prompt-injection surface at "explicit address" only.
 *
 * The DISPUTE channel is how the two agentic systems disagree productively:
 * when the coding agent concludes the premise is wrong ("there is no issue",
 * "the command vinv recorded is wrong"), it says so on this channel instead
 * of pretending to fix a non-problem. Vinv feeds the dispute into the Nash
 * stall-breaker, which either trips the circuit (escalate to the human) or
 * continues with a concrete approach mutation — never a blind retry.
 *
 * The PROPOSAL channel (`vinv: proposal <one line>`) is the constructive
 * counterpart: work the agent believes is worth doing but has not done. It
 * exists because a dispute was previously the only way for an agent to say
 * anything other than "done" — so an answered question with three good
 * optimizations attached arrived at the operator as a conflict to arbitrate
 * rather than as work to approve. Proposals surface as tick-boxes at the
 * judgment; each ticked one becomes its own defect-intent episode.
 */
export function parseHarnessDirectives(stdout: string): {
	episodeBudget?: number;
	goal?: string;
	dispute?: string;
	proposals: string[];
} {
	const out: {
		episodeBudget?: number;
		goal?: string;
		dispute?: string;
		proposals: string[];
	} = { proposals: [] };
	// "addressed to vinv": optional slash/backslash, the word vinv, optional
	// separator. Everything after it is the directive body.
	const address = /^\s*[/\\]?vinv\b[:,]?\s*(.*)$/i;
	const lines = stdout.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const hit = address.exec(lines[i]);
		if (!hit) {
			continue;
		}
		const body = hit[1].trim();
		const budget =
			/^set[_ ]?episode[_ ]?budget(?:\s+to)?\s+(\d{1,2})\b/i.exec(body) ??
			/^(?:episode[_ ]?budget|episodes|budget)(?:\s+to|\s*[:=])?\s+(\d{1,2})\b/i.exec(body);
		if (budget) {
			const n = Number.parseInt(budget[1], 10);
			if (n >= 1 && n <= 20) {
				out.episodeBudget = n;
			}
			continue;
		}
		const goal = /^(?:set[_ ]?goal|goal)(?:\s+to)?[: ]\s*(.+)$/i.exec(body);
		if (goal && goal[1].trim().length > 0) {
			out.goal = goal[1].trim();
			continue;
		}
		// Proposal channel: work the agent thinks is worth doing but did NOT do.
		// Each becomes a selectable follow-up episode at the judgment, so an
		// agent that answers a question and spots three optimizations no longer
		// has to route that work through a dispute to be heard.
		const proposal = /^(?:proposal|propose|suggest(?:ion)?)\b[:,]?\s*(.+)$/i.exec(body);
		if (proposal) {
			const text = stripLeadingPunctuation(proposal[1]);
			if (text) {
				out.proposals.push(text);
			}
			continue;
		}
		const dispute =
			/^(?:dispute|no[_ -]?issue|wrong[_ -]?command|premise[_ -]?wrong)\b[:,]?\s*(.*)$/i.exec(
				body,
			);
		if (dispute) {
			// A dispute is PROSE, and prose wraps. Capturing only the matched
			// line truncated every real explanation mid-sentence — the operator
			// then judged the episode on a fragment that died mid-word. Consume
			// the continuation lines too, stopping at a blank line or the next
			// line addressed to vinv (which is a different directive).
			const parts = [stripLeadingPunctuation(dispute[1])];
			let k = i + 1;
			for (; k < lines.length; k += 1) {
				const next = lines[k];
				if (!next.trim() || address.test(next)) {
					break;
				}
				parts.push(next.trim());
			}
			i = k - 1;
			out.dispute = parts.filter(Boolean).join('\n') || 'the agent disputes the task premise';
		}
	}
	return out;
}

/**
 * Trims separator punctuation left over after a directive keyword is stripped.
 * `vinv: no issue — this was a question` captured `— this was a question`, so
 * the escalation rendered a sentence opening on a dangling em dash.
 */
function stripLeadingPunctuation(s: string): string {
	return s.replace(/^[\s:,.;\-–—]+/, '').trim();
}

/**
 * The trajectory digest for the next context pack: every prior episode on this
 * goal with its arm, verdict, reward and evidence line — the agent sees the
 * whole trajectory and must not repeat a failed approach verbatim.
 */
export function trajectoryDigest(session: SessionState): string {
	if (session.history.length === 0) {
		return '';
	}
	const lines: string[] = [];
	lines.push(
		`Trajectory: episode ${session.episodes_used + 1} of ${session.episode_budget}` +
			(session.goal ? ` toward the goal: ${session.goal}` : ''),
	);
	for (const h of session.history) {
		lines.push(
			`- ${h.ts} "${h.title}" — ${h.verified ? 'VERIFIED' : h.aborted ? 'ABORTED' : 'failed'}, ` +
				`${h.attempts} attempt(s), reward ${h.reward.toFixed(2)}: ${h.evidence}` +
				(h.pack_path ? ` (full evidence: ${h.pack_path})` : ''),
		);
	}
	// Trend comparison: is the trajectory improving?
	if (session.history.length >= 2) {
		const last = session.history[session.history.length - 1].reward;
		const previous = session.history[session.history.length - 2].reward;
		lines.push(
			last > previous
				? 'Trend: improving — build on the last episode\u2019s direction.'
				: last < previous
					? 'Trend: regressing — the last change made things worse; reconsider it.'
					: 'Trend: flat — a different approach is needed, not a retry.',
		);
	}
	return lines.join('\n');
}
