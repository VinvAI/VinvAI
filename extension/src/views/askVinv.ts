/**
 * Ask Vinv — a chat-style QnA panel over the code graph and runtime evidence.
 *
 * Each question runs the answer pipeline (index retrieval → graph slice →
 * runtime evidence) and answers via the user's coding-harness CLI — the same
 * agent handbook/bring-up use. Answers cite symbols (click → source)
 * and label evidence static / runtime / stale. Thumbs feed the retrieval
 * bandit ledger as explicit rewards.
 */
import * as vscode from 'vscode';
import { reportWebviewError, trackUi, trackViewOpened } from '../telemetry/instrument';
import { VINV_BASE_CSS, VINV_FONT_MONO } from './webviewTheme';
import { openPathInEditor } from '../support/openDocument';
import { buildGraphSnapshot, hasIndexStore } from '../graph/indexGraph';
import {
	buildQnaPrompt,
	gatherEvidence,
	parseSufficiency,
	qnaWalkParams,
	recordNegativeTagEvidence,
	recordQnaFeedback,
	resolveMissingAnchors,
	resolveVerdictActions,
	type Citation,
	type IndexHit,
} from '../qna/answer';
import { critiqueAnswer } from '../qna/critic';
import type { CallSiteContext } from '../identification/callSiteContext';
import { appendRetrievalEvent, retrievalEpoch } from '../mcp/retrievalTelemetry';
import { indexStoreDir } from '../graph/indexGraph';
import { enrichTagsFromFeedback } from '../graph/graphEnhancer';
import { getHarnessId, qnaEscalationMode } from '../config/settings';
import { ensureEmbedder } from '../engines/install';
import { getHarness, runHarnessPrompt } from '../harness/harnessRunner';
import {
	appendTranscriptEntry,
	deleteParkedSession,
	ensureSessionPersisted,
	listSessions,
	loadSession,
	sessionTitle,
	setEpisodeBudget,
	setGoal,
	startFreshSession,
	switchToSession,
	type SessionState,
} from '../harness/session';
import { loadEpisodePolicy } from '../harness/episodeTelemetry';
import { evidenceSimilarity } from '../harness/stallBreaker';
import { canSuggestGoal, goalContextFromSession, suggestGoal } from '../harness/goalSuggest';

let panel: vscode.WebviewPanel | undefined;
/** Monotonic question counter — an answer loop aborts when superseded. */
let answerGeneration = 0;
let pendingSeedRow: number | undefined;
/** Endpoint-scoped call-path context when the question came from a Call Tree
 * view. Consumed by the next question, then cleared — it describes the node the
 * user clicked, not the panel, so it must not leak into later questions. */
let pendingCallSite: CallSiteContext | undefined;
/** Seeds of the most recent question — forwarded on dispatch-to-harness so
 * the episode pack walks from the node the user was actually looking at. */
let lastSeedRows: number[] = [];
/** Anchor rows of the FINAL evidence attempt (seeds + retrial-resolved +
 * retrieval hits). Forwarded on dispatch so the pack inherits everything the
 * answer's walk actually concluded was relevant — not a stale re-derivation
 * from the question text. */
let lastAnchorRows: number[] = [];
/** A dispatch awaiting goal review — holds the anchors captured at click time. */
let pendingDispatch: { question: string; rows: number[] } | undefined;
/**
 * The session the panel is currently SHOWING. Episode updates and finished
 * answers carry the session id they belong to; anything bound to a different
 * session is kept out of the visible transcript (it still persists to its own
 * session file) — this is what makes switching sessions safe mid-flight.
 */
let activeSessionId: string | undefined;

/** Recent answers by decision id, kept so a thumbs-up can enrich the index
 * with the question's vocabulary (the map is small and panel-scoped). */
const recentAnswers = new Map<string, { question: string; hits: IndexHit[] }>();

/**
 * The most recent answered question, kept so the NEXT question can be checked
 * for the reformulation signal: a near-identical re-ask of an ungraded answer
 * is implicit dissatisfaction (logged as an 'implicit' −0.5 reward, a source
 * the off-policy evaluator keeps separate from explicit thumbs). Structural
 * threshold, not a tuning knob: below it, consecutive questions are just a
 * conversation; at/above it, the second asks the same thing again.
 */
let lastAsk: { question: string; decisionId: string; feedbackGiven: boolean } | undefined;
const REPHRASE_SIMILARITY = 0.6;

/**
 * Which scene the loader plays. Each one names a real state of the answer
 * pipeline, not a mood: 'waiting' is the embedding model loading into memory,
 * 'dig' is retrieval + the context walk, 'send' is the question sitting with
 * the coding harness, 'hammer' is a retrial re-walking the graph after an
 * insufficient verdict, 'dance' is the answer landing. The webview CSS keys off
 * the same strings.
 */
type LoaderAct = 'waiting' | 'dig' | 'send' | 'hammer' | 'dance';

interface AskMessage {
	type:
		| 'ready'
		| 'ask'
		| 'feedback'
		| 'openSource'
		| 'dispatch'
		| 'dispatchGo'
		| 'dispatchCancel'
		| 'episodeVerdict'
		| 'disputeNote'
		| 'disputeStart'
		| 'viewPack'
		| 'newSession'
		| 'sessions'
		| 'episodeCancel'
		| 'feedbackDetail'
		| 'retractionConfirm';
	question?: string;
	decisionId?: string;
	reward?: number;
	/** One-tap follow-up on a ▼: which way the answer failed. */
	detail?: 'wrong_files' | 'misread';
	/** Episode-end block the "still wrong?" click belongs to. */
	episodeId?: string;
	/** Cited files of the answer a feedbackDetail chip belongs to. */
	files?: string[];
	/** The retraction-confirm card's outcome. */
	choice?: 'confirmed' | 'declined' | 'no_response';
	file?: string;
	line?: number;
	/** Verdict chosen on an escalation card rendered in the transcript. */
	action?: EpisodeVerdict;
	note?: string;
	/** Proposals ticked on an answer-mode card, queued as their own episodes. */
	selectedProposals?: string[];
}

/**
 * Side effects the "pure action" Ask Vinv messages trigger, injected so the
 * routing is testable without a live webview. Production binds these to the real
 * vscode surfaces; tests pass fakes and assert the exact call.
 */
export interface AskVinvActions {
	openSource: (file: string | undefined, line?: number) => Promise<void>;
	openPack: (file: string | undefined) => Promise<void>;
	runCommand: (command: string, ...args: unknown[]) => Promise<void>;
	showError: (message: string) => void;
}

/**
 * Routes the stateless "open something / run a command" Ask Vinv messages,
 * extracted from the big inline switch so the wiring is unit-tested directly.
 * Returns true when it handled the message (the caller then returns early);
 * false leaves the stateful cases (ask, dispatch, feedback, …) to the switch.
 * openSource/viewPack go through the shared opener, which resolves to absolute,
 * verifies existence, and reports a missing file instead of a silent no-op.
 */
export async function handleAskVinvAction(
	msg: AskMessage,
	actions: AskVinvActions,
): Promise<boolean> {
	switch (msg.type) {
		case 'openSource':
			await actions.openSource(msg.file, msg.line);
			return true;
		case 'viewPack':
			await actions.openPack(msg.file);
			return true;
		case 'disputeStart':
			// Inline "still wrong?" affordance — carries the clicked block's episode id.
			await actions.runCommand('vinv-vs.disputeVerified', msg.episodeId);
			return true;
		default:
			return false;
	}
}

/**
 * Dispatches a harness fix from Ask Vinv. Extracted + guarded so an empty issue
 * reports an error rather than firing a blank episode; a real issue routes to
 * the (registered, arg-tolerant) fixWithHarness command with its seed rows.
 */
export async function dispatchAskVinvFix(
	actions: Pick<AskVinvActions, 'runCommand' | 'showError'>,
	issue: string,
	rows: number[],
): Promise<void> {
	const trimmed = issue.trim();
	if (!trimmed) {
		actions.showError('Vinv: cannot dispatch a fix — the question was empty.');
		return;
	}
	await actions.runCommand('vinv-vs.fixWithHarness', { issue: trimmed, rows });
}

/** The operator's answer to an escalation raised inside the chat transcript. */
export type EpisodeVerdict = 'approve' | 'retry' | 'abort' | 'revert';

export interface EpisodeVerdictRequest {
	title: string;
	/** Full decision basis: agent output, stall/dispute reason, failure detail. */
	detail: string;
	/**
	 * 'answer' when the agent answered a QUESTION rather than attempting a fix.
	 * The card then offers "accept answer" and the agent's proposals instead of
	 * "accept as done / reject & retry" — which, for an answer, asked the
	 * operator to rule on a dispute that does not exist and gave them no way to
	 * say "yes, do the work you proposed".
	 */
	mode?: 'defect' | 'answer';
	/** Agent-proposed follow-up work, rendered as tick-boxes on the card. */
	proposals?: string[];
	packPath: string;
	canRevert: boolean;
	agent?: string;
	attempt?: number;
	attemptBudget?: number;
	/** The session the episode belongs to — the transcript only carries the
	 * card while showing that session; otherwise 'unavailable' → dialog. */
	sessionId?: string;
}

export interface EpisodeVerdictResult {
	action: EpisodeVerdict;
	note?: string;
	/** Proposals the operator ticked; each becomes its own follow-up episode. */
	selectedProposals?: string[];
}

/**
 * A verdict awaiting the operator in the transcript. Held at module scope (not
 * in the request) so a panel disposal can settle it as 'unavailable' and let
 * the caller re-raise the decision on another surface — an unanswered verdict
 * must never be silently lost, and must never hang the episode either.
 */
let pendingVerdict:
	| { resolve: (r: EpisodeVerdictResult | 'unavailable') => void; packPath: string }
	| undefined;

/** True when the chat panel exists and can carry episode state. */
export function isAskVinvOpen(): boolean {
	return panel !== undefined;
}

/**
 * Cancel hook for the currently running episode. The episode loop registers it
 * at dispatch and clears it when the episode settles, so the chat's inline
 * cancel control works even when no notification (with its Cancel button) is
 * shown. A stale click after the episode ended is a no-op.
 */
let episodeCancel: (() => void) | undefined;

export function setEpisodeCancel(cb: (() => void) | undefined): void {
	episodeCancel = cb;
}

/**
 * Appends live episode state to the transcript. No-op when the panel is
 * closed. When the update names a session other than the one on screen (the
 * user switched away mid-episode), the feed is NOT rendered — the episode
 * keeps running against its own session — except that the end of a background
 * episode surfaces as a one-line notice so the user knows it finished.
 */
export function postEpisodeUpdate(msg: {
	kind: 'start' | 'thinking' | 'note' | 'end';
	text: string;
	agent?: string;
	ok?: boolean;
	sessionId?: string;
	/** On 'end': which episode this block settles — binds the "still wrong?"
	 * dispute to the block the user actually clicked, not the newest one. */
	episodeId?: string;
}): void {
	if (!panel) {
		return;
	}
	if (msg.sessionId && activeSessionId && msg.sessionId !== activeSessionId) {
		if (msg.kind === 'end') {
			void panel.webview.postMessage({
				type: 'notice',
				text: `A background episode finished (${msg.text}) in another session — /sessions to switch back to it.`,
			});
		}
		return;
	}
	void panel.webview.postMessage({ type: 'episode', ...msg });
}

/**
 * Raises an escalation as an actionable card in the transcript and resolves
 * with the operator's verdict. Resolves 'unavailable' when the panel is closed
 * (now or before answering) so the caller can fall back to the webview dialog.
 */
export function requestEpisodeVerdict(
	req: EpisodeVerdictRequest,
): Promise<EpisodeVerdictResult | 'unavailable'> {
	if (!panel) {
		return Promise.resolve('unavailable');
	}
	// The transcript is showing a DIFFERENT session than the episode's: the
	// card would land in an unrelated conversation. Let the dialog carry it.
	if (req.sessionId && activeSessionId && req.sessionId !== activeSessionId) {
		return Promise.resolve('unavailable');
	}
	// A second escalation while one is outstanding would orphan the first;
	// settle it as unavailable so its caller re-raises rather than waits.
	pendingVerdict?.resolve('unavailable');
	return new Promise((resolve) => {
		pendingVerdict = { resolve, packPath: req.packPath };
		void panel?.webview.postMessage({ type: 'episodeVerdict', ...req });
	});
}

/** The outstanding dispute-note request (its OWN slot — reusing
 * pendingVerdict would bounce an unrelated escalation to the dialog). */
let pendingDisputeNote: { resolve: (v: string | undefined | 'unavailable') => void } | undefined;

/**
 * Asks the user for a dispute counterexample note on the Ask Vinv card
 * surface. Resolves the typed note, undefined (dismissed → no_response), or
 * 'unavailable' (panel closed → caller falls back to the input box).
 */
export function requestDisputeNote(req: {
	title: string;
	question: string;
	placeholder: string;
}): Promise<string | undefined | 'unavailable'> {
	if (!panel) {
		return Promise.resolve('unavailable');
	}
	pendingDisputeNote?.resolve('unavailable');
	return new Promise((resolve) => {
		pendingDisputeNote = { resolve };
		void panel?.webview.postMessage({ type: 'disputePrompt', ...req });
	});
}

/** The outstanding retraction-confirm request (its OWN slot — the gate must
 * never race an unrelated escalation or dispute-note card). */
let pendingRetractionConfirm:
	| { resolve: (v: 'confirmed' | 'declined' | 'no_response' | 'unavailable') => void }
	| undefined;

/**
 * Asks the user to confirm that an authored counterexample test captures
 * their report BEFORE it may retract a verified verdict (the most
 * irreversible write in the reconciliation system). Resolves the choice,
 * 'no_response' on dismissal (MNAR — verdict unchanged), or 'unavailable'
 * when the panel is closed (caller falls back to a warning message).
 */
export function requestRetractionConfirm(req: {
	title: string;
	checkLines: string[];
	stagedPath: string;
}): Promise<'confirmed' | 'declined' | 'no_response' | 'unavailable'> {
	if (!panel) {
		return Promise.resolve('unavailable');
	}
	pendingRetractionConfirm?.resolve('unavailable');
	return new Promise((resolve) => {
		pendingRetractionConfirm = { resolve };
		void panel?.webview.postMessage({ type: 'retractionPrompt', ...req });
	});
}

/**
 * Opens (or reveals) the Ask Vinv panel, optionally seeded with a graph node
 * and — when the question came from a Call Tree view — the endpoint-scoped
 * call-path context for that node.
 */
export function openAskVinv(
	context: vscode.ExtensionContext,
	options?: { seedRow?: number; callSite?: CallSiteContext },
): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		void vscode.window.showWarningMessage('Vinv: Open a folder to ask about it.');
		return;
	}
	const workspaceRoot = folder.uri.fsPath;
	pendingCallSite = options?.callSite;
	// A call-site seed already resolved the clicked frame to its row; prefer it
	// so the caller never has to pass both.
	pendingSeedRow = options?.seedRow ?? options?.callSite?.seedRow;

	if (panel) {
		panel.reveal(vscode.ViewColumn.Beside);
		postSeedLabel(workspaceRoot);
		return;
	}
	trackViewOpened('ask_vinv');
	panel = vscode.window.createWebviewPanel('vinv.askVinv', 'Ask Vinv', vscode.ViewColumn.Beside, {
		enableScripts: true,
		retainContextWhenHidden: true,
	});
	// Start the embedding sidecar NOW, not on the first question. A cached cold
	// start runs for minutes on CPU, and paying it after the user has typed is
	// what made the panel look broken: retrieval cannot embed the question until
	// the model is in memory, so the whole wait landed on question one. Opening
	// the panel is the earliest honest signal that a question is coming, so the
	// load overlaps with the user typing it. Fire-and-forget: it reports through
	// the same status channel the answer loop listens on, and a failure here is
	// surfaced by the question that needs it, not by a toast nobody asked for.
	void ensureEmbedder(context);
	panel.webview.html = getHtml();
	panel.onDidDispose(() => {
		panel = undefined;
		// An escalation was on screen when the transcript closed: hand the
		// decision back so it can be re-raised as a dialog. Closing chat is not
		// a verdict.
		pendingVerdict?.resolve('unavailable');
		pendingVerdict = undefined;
		pendingDisputeNote?.resolve('unavailable');
		pendingDisputeNote = undefined;
		pendingRetractionConfirm?.resolve('unavailable');
		pendingRetractionConfirm = undefined;
	});

	const askActions: AskVinvActions = {
		openSource: async (file, line) => {
			await openPathInEditor(file, {
				workspaceRoot,
				line: line ?? 1,
				label: 'source file',
				preview: true,
				viewColumn: vscode.ViewColumn.One,
			});
		},
		openPack: async (file) => {
			await openPathInEditor(file, { label: 'context pack', preview: false });
		},
		runCommand: async (command, ...args) => {
			await vscode.commands.executeCommand(command, ...args);
		},
		showError: (message) => void vscode.window.showErrorMessage(message),
	};

	panel.webview.onDidReceiveMessage(async (msg: AskMessage) => {
		if (!panel) {
			return;
		}
		const raw = msg as { type?: string; message?: unknown; stack?: unknown };
		if (raw.type === 'webviewError') {
			reportWebviewError('ask_vinv', raw);
			return;
		}
		trackUi('ask_vinv', raw.type ?? 'unknown');
		// Stateless open/command messages route through the extracted, tested
		// handler; the switch below owns the stateful ones.
		if (await handleAskVinvAction(msg, askActions)) {
			return;
		}
		switch (msg.type) {
			// The webview signals when its listener is live; only then are the
			// mode/seed labels delivered (posting earlier silently drops them).
			case 'ready': {
				// A freshly created panel starts blank, but the ACTIVE session may
				// carry a persisted transcript (panel was closed, window reloaded,
				// or a session was switched in) — replay it before the labels.
				// Persisting here pins the session's id, so everything dispatched
				// from this panel binds to it.
				const session = ensureSessionPersisted(workspaceRoot);
				activeSessionId = session.id;
				if (session.transcript?.length) {
					void panel.webview.postMessage({
						type: 'restore',
						entries: session.transcript,
						text: `Restored session — "${sessionTitle(session)}".`,
					});
				}
				postSeedLabel(workspaceRoot);
				postModeLabel();
				return;
			}
			// 'openSource', 'viewPack' and 'disputeStart' are handled by
			// handleAskVinvAction above (extracted + tested).
			case 'feedback':
				if (msg.decisionId && typeof msg.reward === 'number') {
					recordQnaFeedback(workspaceRoot, msg.decisionId, msg.reward);
					if (lastAsk?.decisionId === msg.decisionId) {
						// Explicit feedback exists — the rephrase signal must not
						// double-grade this decision.
						lastAsk.feedbackGiven = true;
					}
					const kept = recentAnswers.get(msg.decisionId);
					if (msg.reward > 0 && kept && kept.hits.length > 0) {
						// A confirmed-good answer is evidence the cited symbols match
						// this vocabulary: distill alias tags into the index (async,
						// best-effort — feedback logging above already succeeded).
						void enrichTagsFromFeedback(workspaceRoot, kept.question, kept.hits).catch(
							() => undefined,
						);
					}
					// A bare thumbs-DOWN stays a plain −1; negative alias evidence
					// now requires the user to confirm 'wrong files cited' via the
					// follow-up chip (feedbackDetail below) — human-confirmed beats
					// inferred-from-a-click.
				}
				return;
			case 'feedbackDetail': {
				// One-tap follow-up on a ▼: 'wrong_files' writes the negative
				// alias evidence (which files this phrasing wrongly surfaced);
				// 'misread' means the citations were right — nothing extra recorded.
				// The live map is preferred; the chip's own question/files make the
				// promise hold for answers restored after a panel reload too.
				const kept = msg.decisionId ? recentAnswers.get(msg.decisionId) : undefined;
				const question = kept?.question ?? msg.question;
				const files = kept && kept.hits.length > 0 ? kept.hits.map((h) => h.file) : (msg.files ?? []);
				if (msg.detail === 'wrong_files' && msg.decisionId && question && files.length > 0) {
					recordNegativeTagEvidence(workspaceRoot, msg.decisionId, question, files);
				}
				return;
			}
			case 'disputeNote': {
				// The card's answer: a typed counterexample note, or a dismissal.
				const settle = pendingDisputeNote?.resolve;
				pendingDisputeNote = undefined;
				settle?.(msg.note?.trim() || undefined);
				return;
			}
			case 'retractionConfirm': {
				const settle = pendingRetractionConfirm?.resolve;
				pendingRetractionConfirm = undefined;
				const choice =
					msg.choice === 'confirmed' || msg.choice === 'declined' ? msg.choice : 'no_response';
				settle?.(choice);
				return;
			}
			case 'episodeVerdict':
				if (msg.action && pendingVerdict) {
					const settle = pendingVerdict.resolve;
					pendingVerdict = undefined;
					settle({
						action: msg.action,
						note: msg.note?.trim() || undefined,
						selectedProposals: msg.selectedProposals?.length ? msg.selectedProposals : undefined,
					});
				}
				return;
			case 'dispatch':
				if (msg.question) {
					// The user's node AND the final walk anchors travel WITH the
					// dispatch — otherwise the pack re-derives seeds by string
					// matching the question text and loses both the user's focus
					// and everything the retrial loop resolved. Bounded by the
					// learned seed cap. Captured HERE, at the moment the user
					// clicked, so asking another question while the confirm card
					// is open cannot swap the anchors out from under it.
					const cap = loadEpisodePolicy().seed_cap;
					const rows = [...lastSeedRows, ...lastAnchorRows]
						.filter((r, i, all) => all.indexOf(r) === i)
						.slice(0, cap);
					pendingDispatch = { question: msg.question, rows };
					// The standing goal steers every episode (it goes into the
					// pack and the policy's arm choice) but was invisible at the
					// one moment it matters. Surface it for review/edit first.
					const session = loadSession(workspaceRoot);
					// No standing goal yet: draft one with the goal engine from
					// what this session already knows (ask, trajectory, answer
					// evidence) and stream it into the card as the DEFAULT the
					// user edits — instead of a blank textarea. An existing goal
					// is already the card's default, so it is never overwritten.
					const generating = !session.goal && canSuggestGoal(context);
					void panel.webview.postMessage({
						type: 'dispatchConfirm',
						question: msg.question,
						goal: session.goal,
						budget: session.episode_budget,
						used: session.episodes_used,
						generating,
					});
					if (generating) {
						const captured = pendingDispatch;
						void suggestGoal(
							context,
							workspaceRoot,
							goalContextFromSession(msg.question, session),
						).then((suggested) => {
							// Stale if the card was settled/replaced (dispatchGo,
							// cancel, a newer dispatch, or a session switch) — the
							// suggestion must never land on someone else's card.
							if (!panel || pendingDispatch !== captured) {
								return;
							}
							void panel.webview.postMessage({
								type: 'dispatchGoalSuggestion',
								goal: suggested ?? '',
							});
						});
					}
				}
				return;
			case 'dispatchGo': {
				const pending = pendingDispatch;
				pendingDispatch = undefined;
				if (!pending) {
					return;
				}
				// An unchanged goal is a no-op inside setGoal, so this cannot
				// silently reset episodes_used on a plain confirm.
				setGoal(workspaceRoot, (msg.note ?? '').trim());
				// Guarded, tested dispatch: an empty question reports why instead of
				// firing a blank episode.
				await dispatchAskVinvFix(askActions, pending.question, pending.rows);
				return;
			}
			case 'dispatchCancel':
				pendingDispatch = undefined;
				return;
			case 'newSession':
				startNewSession(workspaceRoot);
				return;
			case 'sessions':
				void showSessionPicker(workspaceRoot);
				return;
			case 'episodeCancel':
				episodeCancel?.();
				return;
			case 'ask':
				if (msg.question) {
					if (msg.question.startsWith('/')) {
						handleSlashCommand(workspaceRoot, msg.question);
						return;
					}
					// Reformulation signal: re-asking a near-identical question
					// without having graded the previous answer is implicit
					// dissatisfaction with that answer — logged once, as its own
					// reward source, before the fresh ask replaces lastAsk.
					if (
						lastAsk &&
						!lastAsk.feedbackGiven &&
						evidenceSimilarity(lastAsk.question, msg.question) >= REPHRASE_SIMILARITY
					) {
						recordQnaFeedback(workspaceRoot, lastAsk.decisionId, -0.5, 'implicit');
						lastAsk.feedbackGiven = true;
					}
					await answerQuestion(context, workspaceRoot, msg.question);
				}
				return;
		}
	});

}

/**
 * Drops every piece of panel-scoped state that belongs to the outgoing
 * session: in-flight question anchors, the seed chip, a half-open dispatch,
 * the feedback map. An outstanding escalation is settled 'unavailable' so its
 * episode re-raises the decision on the dialog surface instead of pointing at
 * a transcript that no longer shows it.
 */
function clearPanelSessionState(): void {
	lastSeedRows = [];
	lastAnchorRows = [];
	pendingSeedRow = undefined;
	pendingDispatch = undefined;
	recentAnswers.clear();
	// A new session's first question is never a "rephrase" of the old one.
	lastAsk = undefined;
	pendingVerdict?.resolve('unavailable');
	pendingVerdict = undefined;
	pendingDisputeNote?.resolve('unavailable');
	pendingDisputeNote = undefined;
	pendingRetractionConfirm?.resolve('unavailable');
	pendingRetractionConfirm = undefined;
}

/**
 * Starts a fresh session from the chat: PARKS the current session (goal,
 * budget, episode history, transcript — switch back any time), activates a
 * clean one, and clears the panel.
 */
function startNewSession(workspaceRoot: string): void {
	const fresh = startFreshSession(workspaceRoot);
	activeSessionId = fresh.id;
	clearPanelSessionState();
	void panel?.webview.postMessage({
		type: 'sessionCleared',
		text:
			'New session started. The previous one keeps its goal, episode history, and ' +
			'transcript — the sessions button (or /sessions) switches back to it. Anything ' +
			'still running there finishes in the background.',
	});
}

/**
 * The session switcher: a QuickPick of the active + stored sessions, plus
 * "new" and "delete" actions. Switching just moves the active pointer and
 * swaps the transcript — anything still running (an episode, an in-flight
 * answer) is bound to its own session id and keeps going in the background.
 */
async function showSessionPicker(workspaceRoot: string): Promise<void> {
	if (!panel) {
		return;
	}
	const sessions = listSessions(workspaceRoot);
	const parked = sessions.filter((s) => !s.active);
	type Item = vscode.QuickPickItem & { id?: string; action?: 'new' | 'delete' };
	const describe = (s: (typeof sessions)[number]) =>
		[
			s.goal ? `goal: ${s.goal}` : undefined,
			`${s.questions} question(s)`,
			`${s.episodes} episode(s)`,
		]
			.filter(Boolean)
			.join(' · ');
	const items: Item[] = sessions.map((s) => ({
		label: s.active ? `$(arrow-small-right) ${s.title}` : `$(history) ${s.title}`,
		description: s.active ? 'current' : new Date(s.updated_at).toLocaleString(),
		detail: describe(s),
		id: s.active ? undefined : s.id,
	}));
	items.push({
		label: '$(add) new session',
		description: 'park the current session and start clean',
		action: 'new',
	});
	if (parked.length > 0) {
		items.push({
			label: '$(trash) delete a parked session…',
			description: 'moved to .vinv/session-archive, not destroyed',
			action: 'delete',
		});
	}
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: 'Sessions — switching parks the current one; nothing is lost',
		matchOnDetail: true,
	});
	if (!pick || !panel) {
		return;
	}
	if (pick.action === 'new') {
		startNewSession(workspaceRoot);
		return;
	}
	if (pick.action === 'delete') {
		const victim = await vscode.window.showQuickPick(
			parked.map((s) => ({
				label: s.title,
				description: new Date(s.updated_at).toLocaleString(),
				detail: describe(s),
				id: s.id,
			})),
			{ placeHolder: 'Delete which parked session? (archived, never destroyed)' },
		);
		if (victim && deleteParkedSession(workspaceRoot, victim.id)) {
			void panel?.webview.postMessage({
				type: 'notice',
				text: `Deleted "${victim.label}" — archived under .vinv/session-archive/.`,
			});
		}
		return;
	}
	if (!pick.id) {
		// Picked the already-active session — nothing to switch.
		return;
	}
	const switched = switchToSession(workspaceRoot, pick.id);
	if (!switched) {
		void panel.webview.postMessage({
			type: 'notice',
			text: 'Could not load that session — its file is missing or malformed.',
		});
		return;
	}
	restoreSessionIntoPanel(switched);
}

/** Clears panel state and replays a session's transcript into the webview. */
function restoreSessionIntoPanel(session: SessionState): void {
	activeSessionId = session.id;
	clearPanelSessionState();
	void panel?.webview.postMessage({
		type: 'restore',
		entries: session.transcript ?? [],
		text: `Switched to "${sessionTitle(session)}" — other sessions keep running in the background.`,
	});
}

/**
 * Slash commands: session controls straight from the chat box, mirroring the
 * natural `vinv: …` phrasing the harness side accepts. `/goal`, `/budget`
 * (alias `/episodes`), `/session`, `/sessions` (alias `/switch`), `/fix`,
 * `/help`.
 */
function handleSlashCommand(workspaceRoot: string, raw: string): void {
	if (!panel) {
		return;
	}
	const webview = panel.webview;
	const say = (text: string) => void webview.postMessage({ type: 'notice', text });
	const m = /^\/(\w+)\s*(.*)$/.exec(raw.trim());
	if (!m) {
		say('Unrecognized command. Try /help.');
		return;
	}
	const [, cmd, rest] = m;
	switch (cmd.toLowerCase()) {
		case 'goal': {
			const s = setGoal(workspaceRoot, rest.trim());
			say(
				s.goal
					? `Goal set: "${s.goal}" — every episode will cite it (budget ${s.episode_budget}).`
					: 'Goal cleared — episodes run per-task.',
			);
			return;
		}
		case 'budget':
		case 'episodes': {
			const n = Number.parseInt(rest.trim(), 10);
			if (!Number.isInteger(n) || n < 1 || n > 20) {
				say('Usage: /budget <1-20> — episodes to spend on the current goal.');
				return;
			}
			const s = setEpisodeBudget(workspaceRoot, n);
			say(`Episode budget is now ${s.episode_budget} (${s.episodes_used} used on this goal).`);
			return;
		}
		case 'session': {
			const s = loadSession(workspaceRoot);
			say(
				`Goal: ${s.goal || '(none)'} · budget ${s.episode_budget} · used ${s.episodes_used} · ` +
					`${s.history.length} episode(s) recorded.`,
			);
			return;
		}
		case 'fix': {
			if (!rest.trim()) {
				say('Usage: /fix <describe the issue> — dispatches a closed-loop harness episode.');
				return;
			}
			void vscode.commands.executeCommand('vinv-vs.fixWithHarness', { issue: rest.trim() });
			say(`Dispatched to the harness: "${rest.trim()}".`);
			return;
		}
		case 'new':
		case 'reset':
			// Same action as the sessions picker's "new session" entry.
			startNewSession(workspaceRoot);
			return;
		case 'sessions':
		case 'switch':
			// Same action as the header's "sessions" button.
			void showSessionPicker(workspaceRoot);
			return;
		default:
			say(
				'Commands: /goal <text> · /budget <1-20> · /session · /sessions · /new · /fix <issue> — anything else is a question.',
			);
	}
}

function postSeedLabel(workspaceRoot: string): void {
	if (!panel) {
		return;
	}
	// A call-site seed names the entry point too — "handler in GET /orders" is
	// what the user actually pointed at, and it is what distinguishes this
	// question from the same symbol asked about anywhere else.
	if (pendingCallSite) {
		void panel.webview.postMessage({ type: 'seed', label: pendingCallSite.label });
		return;
	}
	if (pendingSeedRow === undefined) {
		return;
	}
	try {
		// Read only what we need — the seed's identity for the context chip.
		const snapshot = buildGraphSnapshot(workspaceRoot);
		const node = snapshot.nodes[pendingSeedRow];
		if (node) {
			void panel.webview.postMessage({
				type: 'seed',
				label: `${node.name} — ${node.file}:${node.start_line}`,
			});
		}
	} catch {
		// Seed chip is cosmetic; ignore failures.
	}
}

function postModeLabel(): void {
	if (!panel) {
		return;
	}
	const label = `answering via ${getHarness(getHarnessId()).label}`;
	void panel.webview.postMessage({ type: 'mode', label });
}

async function answerQuestion(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	question: string,
): Promise<void> {
	if (!panel) {
		return;
	}
	const webview = panel.webview;
	if (!hasIndexStore(workspaceRoot)) {
		void webview.postMessage({
			type: 'error',
			message:
				'No code index yet — run "Vinv: Discover Project" first so answers can be grounded in the graph.',
		});
		return;
	}
	// The answer binds to the session that asked, NOW: if the user switches
	// sessions while the model works, the finished answer still persists into
	// this session's transcript, and nothing is posted over the other
	// session's view (post() goes quiet on a mismatch).
	const askSessionId = ensureSessionPersisted(workspaceRoot).id;
	const post = (m: object) => {
		if (activeSessionId === askSessionId) {
			void webview.postMessage(m);
		}
	};
	const seedRows = pendingSeedRow !== undefined ? [pendingSeedRow] : [];
	const callSite = pendingCallSite;
	pendingSeedRow = undefined;
	pendingCallSite = undefined;
	// Dispatch-to-harness inherits the whole observed call path, not just the
	// clicked frame: an episode fixing this symbol needs its callers in the pack.
	lastSeedRows = [...new Set([...seedRows, ...(callSite?.anchorRows ?? [])])];
	// A newer question (or a closed panel) abandons this loop between attempts:
	// up to max_retrials LLM calls + subprocesses must not keep burning after
	// the user has moved on.
	const generation = ++answerGeneration;
	// Every thinking update carries the loader ACT it belongs to, so the panel's
	// skeleton shows what is actually happening rather than one generic spinner:
	// jumping jacks while the embedding model loads, digging while evidence is
	// gathered, throwing while the model is asked, a sledgehammer on a retrial.
	const think = (label: string, act: LoaderAct) => post({ type: 'thinking', label, act });
	// Sidecar cold start and index search are the two retrieval stages worth
	// distinguishing — the first can run for minutes, the second for seconds.
	const onProgress = (label: string, stage: 'embedder' | 'retrieval') =>
		think(label, stage === 'embedder' ? 'waiting' : 'dig');
	think('gathering evidence…', 'dig');
	try {
		// Failure-driven retrial loop: ask, read the model's own sufficiency
		// verdict AND the deterministic critic's grounding check, and when
		// evidence is missing re-walk the context graph anchored on exactly
		// what was named — bounded by the learned retrial budget. Every
		// attempt's context grows by the learned factor.
		const walk = qnaWalkParams();
		const escalation = qnaEscalationMode();
		// ONE snapshot per question: retrial anchors are raw row indices, and a
		// concurrent reindex between attempts would silently re-point them.
		const snapshot = buildGraphSnapshot(workspaceRoot);
		const ledgerEpoch = retrievalEpoch(indexStoreDir(workspaceRoot));
		const extraAnchors: number[] = [];
		let prior: { missing: string[]; note: string } | undefined;
		let evidence: Awaited<ReturnType<typeof gatherEvidence>> | undefined;
		let verdict: ReturnType<typeof parseSufficiency> | undefined;
		let critic: ReturnType<typeof critiqueAnswer> | undefined;
		let mode = 'harness';
		// Hoisted out of the loop so the finished answer can report how many
		// retrials it actually burned (a key answer-quality signal).
		let attemptsUsed = 0;
		for (let attempt = 0; attempt <= walk.max_retrials; attempt++) {
			attemptsUsed = attempt;
			evidence = await gatherEvidence(context, workspaceRoot, question, {
				seedRows,
				callSite: callSite
					? { markdown: callSite.markdown, anchorRows: callSite.anchorRows }
					: undefined,
				extraAnchorRows: extraAnchors,
				budgetGrowth: Math.pow(walk.retry_budget_growth, attempt),
				priorInsufficiency: prior,
				snapshot,
				onProgress,
			});
			// Retrieval is the ONLY anchor source for a question typed into the
			// panel — a seeded question still has the node the user clicked, but a
			// typed one has nothing else. When the index query FAILED (not
			// "matched nothing") and the walk came back empty, every attempt from
			// here hands the model a context section with no code in it, and the
			// answer that comes back reads like any other. Say what actually broke
			// instead, and do not spend the retrial budget re-running the same
			// failing query.
			if (evidence.retrievalError && evidence.hits.length === 0 && evidence.slice.length === 0) {
				throw new Error(
					`Code search is unavailable, so there is no evidence to answer from — ${evidence.retrievalError}`,
				);
			}
			const prompt = buildQnaPrompt(
				question,
				evidence,
				escalation === 'off' ? 'plain' : 'actions',
			);
			const harness = getHarness(getHarnessId());
			mode = harness.label;
			think(
				attempt === 0
					? `asking ${harness.label}…`
					: `retrial ${attempt} — asking ${harness.label} again…`,
				'send',
			);
			const run = await runHarnessPrompt(getHarnessId(), workspaceRoot, 'qna', prompt, {
				// The agent's own output keeps the 'send' act: the question is with
				// the model and this is it answering.
				onUpdate: (line) => think(line, 'send'),
			});
			if (!run.ok) {
				throw new Error(run.detail ?? 'harness run failed');
			}
			const answer = run.stdout.trim();
			if (generation !== answerGeneration) {
				return; // superseded by a newer question — stop burning budget
			}
			verdict = parseSufficiency(answer);
			// A missing/malformed verdict keeps its documented lenient default
			// (sufficient) but is no longer SILENT: the anomaly is ledgered so a
			// truncated answer can't masquerade as a clean success forever.
			if (verdict.defaulted) {
				appendRetrievalEvent({
					type: 'verdict_anomaly',
					ts: new Date().toISOString(),
					decision_id: evidence.decisionId,
					epoch: ledgerEpoch,
					surface: 'qna',
					detail: 'no well-formed sufficiency verdict found; lenient default applied',
				});
			}
			// Deterministic critic: objective grounding of the answer against
			// the evidence actually served. Ungrounded citations are objective
			// insufficiency — they trigger the SAME bounded retrial.
			critic = critiqueAnswer(snapshot, evidence, verdict.body);
			appendRetrievalEvent({
				type: 'critic',
				ts: new Date().toISOString(),
				decision_id: evidence.decisionId,
				epoch: ledgerEpoch,
				surface: 'qna',
				attempt,
				citations: critic.citations.length,
				ungrounded: critic.ungrounded,
				warnings: critic.warnings,
				actions_requested: verdict.actions,
				escalation,
			});
			const objectiveInsufficient = critic.ungrounded.length > 0;
			if ((verdict.sufficient && !objectiveInsufficient) || attempt === walk.max_retrials) {
				break;
			}
			// Corrective step: the model's named gaps — and any citations the
			// critic found ungrounded — become the next walk's anchors; the
			// reason travels with the retrial so the model knows why it is
			// being asked again.
			const missingForRetry = [...verdict.missing, ...critic.ungrounded];
			think(
				`answer reported missing evidence (${missingForRetry.join('; ') || 'unspecified'}) — re-walking the graph…`,
				'hammer',
			);
			const resolved = await resolveMissingAnchors(
				context,
				workspaceRoot,
				snapshot,
				missingForRetry,
				walk.retry_anchors_per_item,
				walk.retry_missing_cap,
			);
			// Escalation channel: typed evidence actions execute read-only when
			// 'on'; in 'shadow' they were already ledgered above and skipped.
			if (escalation === 'on' && verdict.actions.length > 0) {
				const actionRows = await resolveVerdictActions(
					context,
					workspaceRoot,
					snapshot,
					verdict.actions,
					walk.retry_anchors_per_item,
					walk.retry_missing_cap,
				);
				for (const row of actionRows) {
					if (!resolved.includes(row)) {
						resolved.push(row);
					}
				}
			}
			if (generation !== answerGeneration) {
				return;
			}
			for (const row of resolved) {
				if (!extraAnchors.includes(row)) {
					extraAnchors.push(row);
				}
			}
			prior = {
				missing: missingForRetry,
				note:
					(verdict.sufficient
						? `Attempt ${attempt + 1} cited sources not present in the index (${critic.ungrounded.join('; ')}) — cite only the provided evidence`
						: `Attempt ${attempt + 1} answered with a "sufficient": false verdict`) +
					(resolved.length
						? '.'
						: ' and none of the missing items resolved to indexed symbols — if the evidence still is not present, say precisely what capture or index step would produce it.'),
			};
		}
		if (!evidence || !verdict) {
			throw new Error('no answer produced');
		}
		lastAnchorRows = evidence.anchorRows;
		// The critic's verified bit: an objective, thumbs-independent reward for
		// the retrieval policy. Logged only when informative (citations exist):
		// +1 when a sufficient answer's citations all ground, −1 when ungrounded
		// citations survived every retrial. Source 'critic' keeps it from ever
		// colliding with the panel's explicit thumbs in the ledger.
		if (critic && critic.citations.length > 0) {
			if (verdict.sufficient && !verdict.defaulted && critic.grounded) {
				recordQnaFeedback(workspaceRoot, evidence.decisionId, 1, 'critic');
			} else if (critic.ungrounded.length > 0) {
				recordQnaFeedback(workspaceRoot, evidence.decisionId, -1, 'critic');
			}
		}
		// An exhausted retrial budget with a still-insufficient verdict is
		// surfaced, not swallowed: the user sees WHAT the answer is missing
		// (usually evidence a fresh capture or reindex would produce).
		let displayAnswer = verdict.body;
		if (!verdict.sufficient) {
			displayAnswer +=
				'\n\n---\n⚠ Answered with reservations after ' +
				`${walk.max_retrials} retrial(s) — still missing: ` +
				(verdict.missing.join('; ') || 'unspecified evidence') +
				'. A fresh trace capture or reindex may supply it.';
		}
		if (critic && critic.ungrounded.length > 0) {
			displayAnswer +=
				'\n\n---\n⚠ These citations do not resolve to any indexed file — treat them with suspicion: ' +
				critic.ungrounded.join('; ');
		}
		recentAnswers.set(evidence.decisionId, { question, hits: evidence.hits });
		// This answer is now the reformulation baseline for the NEXT question.
		lastAsk = { question, decisionId: evidence.decisionId, feedbackGiven: false };
		if (recentAnswers.size > 32) {
			const oldest = recentAnswers.keys().next().value;
			if (oldest) {
				recentAnswers.delete(oldest);
			}
		}
		const citations = dedupeCitations(evidence.citations);
		// The answer's QUALITY signals — the part that actually explains a "Vinv
		// gave me a bad answer" report. decision_id joins to the local transcript
		// (.vinv/askvinv/sessions) when the user can share it.
		// Persist the turn on the ASKING session so a panel reopen or session
		// switch restores the conversation — the decision id travels with it, so
		// late feedback on a restored answer still lands in the bandit ledger.
		appendTranscriptEntry(
			workspaceRoot,
			{
				kind: 'qa',
				ts: new Date().toISOString(),
				question,
				answer: displayAnswer,
				mode,
				decisionId: evidence.decisionId,
				citations: citations.map((c) => ({ file: c.file, line: c.line, name: c.name, kind: c.kind })),
			},
			askSessionId,
		);
		post({
			type: 'answer',
			question,
			answer: displayAnswer,
			citations,
			decisionId: evidence.decisionId,
			mode,
		});
	} catch (e) {
		post({
			type: 'error',
			message: e instanceof Error ? e.message : String(e),
		});
	}
}

function dedupeCitations(citations: Citation[]): Citation[] {
	const seen = new Set<string>();
	const out: Citation[] = [];
	for (const c of citations) {
		const key = `${c.file}:${c.line}`;
		if (!seen.has(key)) {
			seen.add(key);
			out.push(c);
		}
	}
	return out.slice(0, 16);
}

function getHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Ask Vinv</title>
	<style>
		${VINV_BASE_CSS}
		html, body { height: 100%; overflow: hidden; }
		body { display: flex; flex-direction: column; font-size: 12.5px; }
		header { flex: none; position: relative; padding: 14px 18px 10px; border-bottom: 1px solid var(--line); }
		.head-actions { position: absolute; top: 16px; right: 18px; display: flex; gap: 6px; }
		h1 {
			font-family: ${VINV_FONT_MONO}; font-weight: 400;
			font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em;
		}
		#mode { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
		#seed {
			display: none; margin-top: 8px; font-size: 10.5px; padding: 3px 8px;
			border: 1px solid var(--line-strong); color: var(--muted); width: fit-content;
		}
		#seed::before { content: 'context // '; color: var(--accent); }
		#log { flex: 1; overflow-y: auto; padding: 14px 18px; }
		.turn { margin-bottom: 20px; }
		.q { font-weight: 600; margin-bottom: 8px; }
		.q::before { content: '// '; color: var(--accent); }
		.a { line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
		.a code { background: var(--bg-2); padding: 1px 4px; font-size: 11.5px; }
		.a pre {
			background: var(--bg-2); border: 1px solid var(--line);
			padding: 10px; overflow-x: auto; font-size: 11.5px; line-height: 1.5;
		}
		.cites { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
		.cite {
			font-size: 10px; padding: 2px 7px; cursor: pointer;
			border: 1px solid var(--line-strong); color: var(--muted);
		}
		.cite:hover { border-color: var(--accent); color: var(--accent); }
		.cite .tag { color: var(--muted-2); margin-left: 5px; text-transform: uppercase; letter-spacing: 0.1em; font-size: 8.5px; }
		.cite.stale .tag { color: var(--accent); }
		.turn-actions { margin-top: 10px; display: flex; gap: 8px; align-items: center; }
		.fb { background: none; border: 1px solid var(--line-strong); color: var(--muted); cursor: pointer; padding: 3px 9px; font-size: 11px; }
		.fb:hover { border-color: var(--ink); color: var(--ink); }
		.fb.done { border-color: var(--accent); color: var(--accent); }
		.fb-chips { display: inline-flex; gap: 6px; }
		.fb-ack { color: var(--muted); font-size: 10.5px; }
		/* Dispatch is the one action that DOES something — filled brand accent so it pops. */
		.fb.dispatch { background: var(--accent); border-color: var(--accent); color: #ffffff; }
		.fb.dispatch:hover { background: var(--accent-soft); border-color: var(--accent-soft); color: #ffffff; }
		#thinking { display: none; padding: 0 18px 8px; align-items: center; gap: 12px; }
		#thinking.on { display: flex; }
		#thinking-label { color: var(--muted); font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; }
		/* The loader: five scenes stacked, only the active act displayed. Idle
		   scenes are display:none, so their keyframes cost nothing. */
		#act { position: relative; width: 74px; height: 52px; flex: none; }
		#act svg { display: none; position: absolute; inset: 0; width: 74px; height: 52px; overflow: visible; }
		#thinking[data-act="waiting"] .sc-waiting,
		#thinking[data-act="dig"] .sc-dig,
		#thinking[data-act="send"] .sc-send,
		#thinking[data-act="hammer"] .sc-hammer,
		#thinking[data-act="dance"] .sc-dance { display: block; }
		#act g, #act path, #act circle, #act rect { transform-box: view-box; }
		#act .bone { stroke: var(--muted); }
		#act .fill { fill: var(--bg-2); }
		#act .ground { stroke: var(--line-strong); }
		#act .eye { fill: var(--accent); }
		#act .dg-d1, #act .dg-d2, #act .dg-d3 { fill: var(--muted); }
		/* -- waiting: jumping jacks (the embedding model warming up) -- */
		.jj-b { transform-origin: 30px 46px; animation: jj-hop .52s cubic-bezier(.4,0,.5,1) infinite; }
		.jj-aL { transform-origin: 30px 20px; animation: jj-aL .52s ease-in-out infinite; }
		.jj-aR { transform-origin: 30px 20px; animation: jj-aR .52s ease-in-out infinite; }
		.jj-lL { transform-origin: 30px 31px; animation: jj-lL .52s ease-in-out infinite; }
		.jj-lR { transform-origin: 30px 31px; animation: jj-lR .52s ease-in-out infinite; }
		@keyframes jj-hop { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
		@keyframes jj-aL { 0%,100% { transform: rotate(0) } 50% { transform: rotate(-118deg) } }
		@keyframes jj-aR { 0%,100% { transform: rotate(0) } 50% { transform: rotate(118deg) } }
		@keyframes jj-lL { 0%,100% { transform: rotate(0) } 50% { transform: rotate(-20deg) } }
		@keyframes jj-lR { 0%,100% { transform: rotate(0) } 50% { transform: rotate(20deg) } }
		/* -- dig: gathering evidence -- */
		.dg-b { transform-origin: 16px 44px; animation: dg-pitch 1.05s cubic-bezier(.4,0,.5,1) infinite; }
		.dg-a { transform-origin: 15px 19px; animation: dg-swing 1.05s cubic-bezier(.4,0,.5,1) infinite; }
		.dg-d1 { animation: dg-f1 1.05s cubic-bezier(.2,.6,.5,1) infinite; }
		.dg-d2 { animation: dg-f2 1.05s cubic-bezier(.2,.6,.5,1) infinite; }
		.dg-d3 { animation: dg-f3 1.05s cubic-bezier(.2,.6,.5,1) infinite; }
		@keyframes dg-pitch { 0%,100% { transform: rotate(-7deg) } 34% { transform: rotate(9deg) } 60% { transform: rotate(-4deg) } }
		@keyframes dg-swing { 0%,100% { transform: rotate(-34deg) } 34% { transform: rotate(26deg) } 62% { transform: rotate(-20deg) } }
		@keyframes dg-f1 { 0%,33% { opacity: 0; transform: translate(0,0) } 40% { opacity: 1 } 100% { opacity: 0; transform: translate(9px,-17px) } }
		@keyframes dg-f2 { 0%,36% { opacity: 0; transform: translate(0,0) } 44% { opacity: 1 } 100% { opacity: 0; transform: translate(15px,-11px) } }
		@keyframes dg-f3 { 0%,38% { opacity: 0; transform: translate(0,0) } 46% { opacity: 1 } 100% { opacity: 0; transform: translate(4px,-13px) } }
		/* -- send: the question goes to the harness -- */
		.sd-b { transform-origin: 16px 44px; animation: sd-lean 2s ease-in-out infinite; }
		.sd-a { transform-origin: 16px 19px; animation: sd-throw 2s cubic-bezier(.3,0,.3,1) infinite; }
		.sd-h { transform-origin: 16px 16px; animation: sd-look 2s ease-in-out infinite; }
		.sd-p { animation: sd-fly 2s cubic-bezier(.2,.5,.4,1) infinite; }
		@keyframes sd-throw { 0%,22% { transform: rotate(52deg) } 34% { transform: rotate(-74deg) } 60%,100% { transform: rotate(52deg) } }
		@keyframes sd-lean { 0%,22% { transform: rotate(-4deg) } 36% { transform: rotate(7deg) } 60%,100% { transform: rotate(-4deg) } }
		@keyframes sd-look { 0%,22% { transform: rotate(0) } 40%,64% { transform: rotate(-13deg) } 84%,100% { transform: rotate(0) } }
		@keyframes sd-fly { 0%,30% { opacity: 1; transform: translate(0,0) rotate(0) }
			64% { opacity: 1; transform: translate(26px,-13px) rotate(-10deg) }
			78% { opacity: 0; transform: translate(38px,-19px) rotate(-14deg) }
			79%,100% { opacity: 0; transform: translate(0,0) rotate(0) } }
		/* -- hammer: a retrial re-walking the graph -- */
		.hm-s { animation: hm-shake 1.25s linear infinite; }
		.hm-b { transform-origin: 16px 44px; animation: hm-lean 1.25s cubic-bezier(.35,0,.4,1) infinite; }
		.hm-a { transform-origin: 15px 19px; animation: hm-smash 1.25s cubic-bezier(.35,0,.4,1) infinite; }
		.hm-r { transform-origin: 40px 44px; animation: hm-jolt 1.25s linear infinite; }
		.hm-k { transform-origin: 40px 37px; animation: hm-spark 1.25s linear infinite; }
		@keyframes hm-smash { 0% { transform: rotate(-120deg) } 30% { transform: rotate(-132deg) } 46% { transform: rotate(34deg) }
			58% { transform: rotate(28deg) } 100% { transform: rotate(-120deg) } }
		@keyframes hm-lean { 0%,30% { transform: rotate(-6deg) } 46% { transform: rotate(11deg) } 100% { transform: rotate(-6deg) } }
		@keyframes hm-shake { 0%,44%,54%,100% { transform: translate(0,0) } 47% { transform: translate(-1.5px,1px) } 50% { transform: translate(1.5px,-.5px) } }
		@keyframes hm-jolt { 0%,44%,100% { transform: translateY(0) scaleY(1) } 47% { transform: translateY(2px) scaleY(.88) } 56% { transform: translateY(0) scaleY(1) } }
		@keyframes hm-spark { 0%,43% { opacity: 0; transform: scale(.4) } 47% { opacity: 1; transform: scale(1) } 58%,100% { opacity: 0; transform: scale(1.5) } }
		/* -- dance: the answer landed -- */
		.dc-b { transform-origin: 30px 46px; animation: dc-hop .46s cubic-bezier(.4,0,.5,1) infinite; }
		.dc-h { transform-origin: 30px 16px; animation: dc-bop .46s ease-in-out infinite; }
		.dc-aL { transform-origin: 30px 19px; animation: dc-aL .46s ease-in-out infinite; }
		.dc-aR { transform-origin: 30px 19px; animation: dc-aR .46s ease-in-out infinite; }
		.dc-lL { transform-origin: 30px 30px; animation: dc-lL .46s ease-in-out infinite; }
		.dc-lR { transform-origin: 30px 30px; animation: dc-lR .46s ease-in-out infinite; }
		@keyframes dc-hop { 0%,100% { transform: translateY(0) rotate(-6deg) } 50% { transform: translateY(-5px) rotate(6deg) } }
		@keyframes dc-bop { 0%,100% { transform: rotate(11deg) } 50% { transform: rotate(-11deg) } }
		@keyframes dc-aL { 0%,100% { transform: rotate(74deg) } 50% { transform: rotate(-88deg) } }
		@keyframes dc-aR { 0%,100% { transform: rotate(-88deg) } 50% { transform: rotate(74deg) } }
		@keyframes dc-lL { 0%,100% { transform: rotate(-19deg) } 50% { transform: rotate(21deg) } }
		@keyframes dc-lR { 0%,100% { transform: rotate(21deg) } 50% { transform: rotate(-19deg) } }
		/* Motion is decoration here — the label always carries the same state in
		   words, so freezing every scene loses nothing. */
		@media (prefers-reduced-motion: reduce) { #act * { animation: none !important; } }
		footer { flex: none; padding: 12px 18px 16px; border-top: 1px solid var(--line); display: flex; gap: 8px; }
		#input {
			flex: 1; padding: 9px 12px; border: 1px solid var(--line-strong); border-radius: 0;
			background: var(--bg); color: var(--ink); font-family: inherit; font-size: 12.5px; resize: none;
		}
		#input:focus { outline: none; border-color: var(--accent); }
		.empty { color: var(--muted); padding: 28px 4px; line-height: 1.7; }
		.err { color: var(--accent); white-space: pre-wrap; }
		.notice { color: var(--muted); border-left: 2px solid var(--accent); padding: 4px 10px; margin-bottom: 16px; }
		#hints { display: none; padding: 0 18px 6px; }
		#hints .hint {
			display: inline-block; margin-right: 6px; margin-bottom: 4px; padding: 2px 8px;
			border: 1px solid var(--line-strong); color: var(--muted); font-size: 10.5px; cursor: pointer;
		}
		#hints .hint:hover { border-color: var(--accent); color: var(--accent); }
		/* Episode blocks: the harness working, live, inline in the transcript. */
		.episode { border-left: 2px solid var(--accent); padding: 6px 0 6px 12px; margin-bottom: 20px; }
		.ep-head { font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); }
		.ep-head b { color: var(--ink); font-weight: 600; }
		.ep-feed {
			margin: 8px 0 0; padding: 8px 10px; background: var(--bg-2); border: 1px solid var(--line);
			font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
			max-height: 200px; overflow-y: auto; color: var(--muted);
		}
		.ep-feed.collapsed { display: none; }
		.ep-toggle { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 10.5px; padding: 4px 0 0; font-family: inherit; }
		.ep-toggle:hover { color: var(--accent); }
		.ep-cancel { margin-left: 14px; color: var(--accent); }
		.ep-cancel:disabled { cursor: default; opacity: 0.6; }
		.ep-feed .n { color: var(--ink); }
		.ep-done { color: var(--accent); }
		.dispute-note { width: 100%; margin: 8px 0 4px; padding: 8px 10px; border: 1px solid var(--line-strong);
			background: var(--bg); color: var(--ink); font-family: inherit; font-size: 12.5px; resize: vertical; }
		.dispute-note:focus { outline: none; border-color: var(--accent); }
		/* Escalation: the same verdict surface as the dialog, inline and scrollable-back. */
		.verdict { border: 1px solid var(--accent); padding: 14px 16px; margin-bottom: 20px; }
		.verdict h3 { margin: 4px 0 10px; font-size: 15px; font-weight: 600; }
		.verdict .basis {
			background: var(--bg-2); border: 1px solid var(--line); padding: 10px 12px; margin: 0 0 12px;
			font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
			max-height: 300px; overflow-y: auto;
		}
		.verdict .acts { display: flex; gap: 8px; flex-wrap: wrap; }
		.verdict textarea {
			width: 100%; min-height: 56px; margin-top: 10px; padding: 8px 10px; resize: vertical;
			border: 1px solid var(--line-strong); background: var(--bg); color: var(--ink);
			font-family: inherit; font-size: 12px;
		}
		.verdict textarea:focus { outline: none; border-color: var(--accent); }
		.verdict[data-settled="1"] .acts, .verdict[data-settled="1"] textarea { display: none; }
		.verdict[data-settled="1"] .proposals { opacity: 0.55; pointer-events: none; }
		.verdict .proposals { margin: 6px 0 12px; }
		.verdict .proposals label {
			display: flex; gap: 9px; align-items: flex-start; padding: 8px 10px;
			border: 1px solid var(--line); border-bottom: none; background: var(--bg-2);
			font-size: 12px; line-height: 1.5; cursor: pointer;
		}
		.verdict .proposals label:last-child { border-bottom: 1px solid var(--line); }
		.verdict .proposals input { margin-top: 2px; flex: none; accent-color: var(--accent); }
		.verdict .chosen { color: var(--accent); font-size: 11px; margin-top: 8px; }
		.goal-label { color: var(--muted); font-size: 10.5px; margin-bottom: 2px; }
	</style>
</head>
<body>
	<header>
		<h1>Ask Vinv</h1>
		<div class="head-actions">
			<button class="v-btn" id="sessions"
				title="Sessions — switch between parked conversations, start a new one, or delete one">sessions</button>
			<button class="v-btn" id="new-session"
				title="Start a new session — parks the current goal, episode history, and transcript">new session</button>
		</div>
		<div id="mode"></div>
		<div id="seed"></div>
	</header>
	<div id="log">
		<div class="empty">Ask anything about this codebase. Answers are grounded in the code graph
		and the captured runtime evidence — every claim cites the symbols it came from, and runtime
		facts are marked when the code changed after the trace.</div>
	</div>
	<div id="thinking" data-act="dig">
		<div id="act" aria-hidden="true">
			<svg class="sc-waiting" viewBox="0 0 60 52" fill="none" stroke-width="1.7" stroke-linecap="round">
				<line class="ground" x1="6" y1="46" x2="54" y2="46" stroke-width="2"/>
				<g class="jj-b bone" stroke="currentColor">
					<circle class="fill" cx="30" cy="11" r="6.4" stroke="none"/>
					<circle cx="30" cy="11" r="6.4"/>
					<circle class="eye" cx="27.8" cy="10.6" r="1.3" stroke="none"/>
					<circle class="eye" cx="32.2" cy="10.6" r="1.3" stroke="none"/>
					<path d="M30 17.6 v14"/>
					<path d="M25.8 20 h8.4 M25.8 23.6 h8.4" stroke-width="1"/>
					<path class="jj-aL" d="M30 20 l-10 8"/>
					<path class="jj-aR" d="M30 20 l10 8"/>
					<path class="jj-lL" d="M30 31 l-5 15"/>
					<path class="jj-lR" d="M30 31 l5 15"/>
				</g>
			</svg>
			<svg class="sc-dig" viewBox="0 0 60 52" fill="none" stroke-width="1.7" stroke-linecap="round">
				<line class="ground" x1="4" y1="46" x2="56" y2="46" stroke-width="2"/>
				<path class="fill" d="M34 46 q7 -8 14 0"/>
				<circle class="dg-d1" cx="35" cy="40" r="1.5" fill="currentColor"/>
				<circle class="dg-d2" cx="37" cy="41" r="1.2" fill="currentColor"/>
				<circle class="dg-d3" cx="33.5" cy="41.5" r="1" fill="currentColor"/>
				<g class="dg-b bone" stroke="currentColor">
					<circle class="fill" cx="16" cy="9" r="6.6" stroke="none"/>
					<circle cx="16" cy="9" r="6.6"/>
					<circle class="eye" cx="13.6" cy="8.6" r="1.4" stroke="none"/>
					<circle class="eye" cx="18.6" cy="8.6" r="1.4" stroke="none"/>
					<path d="M16 16 v13"/>
					<path d="M11.6 19 h8.8 M11.6 22.6 h8.8" stroke-width="1.1"/>
					<path d="M16 29 l-5 15"/><path d="M16 29 l6 15"/>
					<g class="dg-a">
						<path d="M15 19 l11 7"/><path d="M15 22 l11 4"/>
						<path d="M15 20.5 L34 33" stroke-width="1.9"/>
						<path class="fill" d="M32 31 l6 2.5 -2.5 5 -5.5 -4 z"/>
					</g>
				</g>
			</svg>
			<svg class="sc-send" viewBox="0 0 60 52" fill="none" stroke-width="1.7" stroke-linecap="round">
				<line class="ground" x1="4" y1="46" x2="56" y2="46" stroke-width="2"/>
				<g class="sd-b bone" stroke="currentColor">
					<g class="sd-h">
						<circle class="fill" cx="16" cy="9" r="6.6" stroke="none"/>
						<circle cx="16" cy="9" r="6.6"/>
						<circle class="eye" cx="13.6" cy="8.6" r="1.4" stroke="none"/>
						<circle class="eye" cx="18.6" cy="8.6" r="1.4" stroke="none"/>
					</g>
					<path d="M16 16 v13"/>
					<path d="M11.6 19 h8.8 M11.6 22.6 h8.8" stroke-width="1.1"/>
					<path d="M16 29 l-5 15"/><path d="M16 29 l5 15"/>
					<path d="M16 19 l-7 8"/>
					<g class="sd-a">
						<path d="M16 19 l9 -6"/>
						<g class="sd-p"><path class="fill" d="M24 8 l10 4 -10 4 2 -4 z"/></g>
					</g>
				</g>
			</svg>
			<svg class="sc-hammer" viewBox="0 0 60 52" fill="none" stroke-width="1.7" stroke-linecap="round">
				<g class="hm-s">
					<line class="ground" x1="4" y1="46" x2="56" y2="46" stroke-width="2"/>
					<path class="hm-r fill" d="M34 44 l4 -7 6 1 3 6 z"/>
					<g class="hm-k"><path d="M40 34 v-5 M45 36 l5 -3 M35 36 l-5 -3" stroke="var(--accent)" stroke-width="1.3"/></g>
					<g class="hm-b bone" stroke="currentColor">
						<circle class="fill" cx="16" cy="9" r="6.6" stroke="none"/>
						<circle cx="16" cy="9" r="6.6"/>
						<circle class="eye" cx="13.6" cy="8.6" r="1.4" stroke="none"/>
						<circle class="eye" cx="18.6" cy="8.6" r="1.4" stroke="none"/>
						<path d="M16 16 v13"/>
						<path d="M11.6 19 h8.8 M11.6 22.6 h8.8" stroke-width="1.1"/>
						<path d="M16 29 l-5.5 15"/><path d="M16 29 l6.5 15"/>
						<g class="hm-a">
							<path d="M15 19 l10 6"/><path d="M15 22 l10 3"/>
							<path d="M15 20.5 L33 31" stroke-width="1.9"/>
							<rect class="fill" x="31.5" y="27.5" width="8" height="5.5" rx="1"/>
						</g>
					</g>
				</g>
			</svg>
			<svg class="sc-dance" viewBox="0 0 60 52" fill="none" stroke-width="1.7" stroke-linecap="round">
				<line class="ground" x1="6" y1="46" x2="54" y2="46" stroke-width="2"/>
				<g class="dc-b bone" stroke="currentColor">
					<g class="dc-h">
						<circle class="fill" cx="30" cy="9" r="6.6" stroke="none"/>
						<circle cx="30" cy="9" r="6.6"/>
						<circle class="eye" cx="27.6" cy="8.6" r="1.4" stroke="none"/>
						<circle class="eye" cx="32.6" cy="8.6" r="1.4" stroke="none"/>
					</g>
					<path d="M30 16 v14"/>
					<path d="M25.6 19 h8.8 M25.6 22.6 h8.8" stroke-width="1.1"/>
					<path class="dc-aL" d="M30 19 l-9 8"/>
					<path class="dc-aR" d="M30 19 l9 8"/>
					<path class="dc-lL" d="M30 30 l-6 14"/>
					<path class="dc-lR" d="M30 30 l6 14"/>
				</g>
			</svg>
		</div>
		<div id="thinking-label"></div>
	</div>
	<div id="hints"></div>
	<footer>
		<textarea id="input" rows="2" placeholder="Ask about the code — or type / for commands (goal, budget, fix…)"></textarea>
		<button class="v-btn primary" id="send">Ask</button>
	</footer>

	<script>
	const vscode = acquireVsCodeApi();
	window.addEventListener('error', function (e) { vscode.postMessage({ type: 'webviewError', message: String((e && e.message) || 'unknown'), stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : undefined }); });
	window.addEventListener('unhandledrejection', function (e) { vscode.postMessage({ type: 'webviewError', message: 'unhandledrejection: ' + String((e && e.reason) || ''), stack: e && e.reason && e.reason.stack ? String(e.reason.stack).slice(0, 2000) : undefined }); });
	const log = document.getElementById('log');
	const input = document.getElementById('input');
	const thinking = document.getElementById('thinking');
	const thinkingLabel = document.getElementById('thinking-label');
	// Timer for the one-beat dance after an answer lands; cleared whenever the
	// loader is shown or hidden again so a fast follow-up question can never be
	// cut short by the previous answer's celebration.
	let danceTimer;
	function showThinking(label, act) {
		clearTimeout(danceTimer);
		if (act) { thinking.dataset.act = act; }
		thinkingLabel.textContent = label;
		thinking.classList.add('on');
	}
	function hideThinking() {
		clearTimeout(danceTimer);
		thinking.classList.remove('on');
	}
	// The answer landed: let the skeleton dance for one beat, then clear. The
	// wait is over either way, so this can never delay anything the user needs.
	function celebrate() {
		showThinking('done', 'dance');
		danceTimer = setTimeout(function () { thinking.classList.remove('on'); }, 1200);
	}
	let busy = false;
	// The episode block currently receiving thinking lines (undefined between
	// episodes, so a stray update opens its own block rather than being lost).
	let epBlock;
	// The latest dispatch card's goal textarea + status line — the target a
	// dispatchGoalSuggestion fills in when it arrives (undefined between cards).
	let goalCard;

	function esc(t) {
		return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
	// Minimal markdown: fenced code blocks + inline code + bold. Everything else
	// stays plain text (white-space: pre-wrap preserves structure).
	function renderMd(text) {
		const parts = String(text).split(/\\n\`\`\`/);
		let html = '';
		for (let i = 0; i < parts.length; i++) {
			if (i % 2 === 1) {
				const body = parts[i].replace(/^[a-zA-Z0-9_-]*\\n?/, '');
				html += '<pre>' + esc(body) + '</pre>';
			} else {
				html += esc(parts[i])
					.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>')
					.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>');
			}
		}
		return html;
	}

	// One question turn: the // question line plus an empty answer body.
	function makeTurn(q) {
		const empty = log.querySelector('.empty');
		if (empty) { empty.remove(); }
		const turn = document.createElement('div');
		turn.className = 'turn';
		turn.innerHTML = '<div class="q">' + esc(q) + '</div><div class="a"></div>';
		log.appendChild(turn);
		return turn;
	}

	// Fills a turn with an answer + citation chips + feedback/dispatch actions.
	// Shared by the live 'answer' path and session-transcript restore, so a
	// restored answer keeps working chips, feedback, and dispatch.
	function fillAnswer(turn, msg) {
		turn.querySelector('.a').innerHTML = renderMd(msg.answer);
		const cites = document.createElement('div');
		cites.className = 'cites';
		for (const c of msg.citations || []) {
			const el = document.createElement('span');
			el.className = 'cite' + (c.kind === 'stale' ? ' stale' : '');
			el.innerHTML = esc(c.file + ':' + c.line) + '<span class="tag">' + esc(c.kind) + '</span>';
			el.title = c.name;
			el.addEventListener('click', () => vscode.postMessage({ type: 'openSource', file: c.file, line: c.line }));
			cites.appendChild(el);
		}
		turn.appendChild(cites);
		const actions = document.createElement('div');
		actions.className = 'turn-actions';
		const up = document.createElement('button');
		up.className = 'fb'; up.textContent = '▲ helpful';
		const down = document.createElement('button');
		down.className = 'fb'; down.textContent = '▼ wrong';
		const dispatch = document.createElement('button');
		dispatch.className = 'fb dispatch'; dispatch.textContent = '⇢ dispatch to harness';
		dispatch.title = 'Turn this question into a harness episode (the agent investigates and fixes it)';
		const settle = (el2, reward) => {
			if (up.classList.contains('done') || down.classList.contains('done')) { return; }
			el2.classList.add('done');
			vscode.postMessage({ type: 'feedback', decisionId: msg.decisionId, reward });
			if (reward > 0) {
				// Make the learning loop visible: this click tunes future retrieval.
				el2.textContent = '▲ noted — tunes retrieval';
				return;
			}
			// A bare ▼ is a dead end — ask ONE targeted follow-up as one-tap
			// chips. 'wrong files cited' human-confirms the negative alias evidence
			// (which files this phrasing wrongly surfaced); 'answer misread them'
			// keeps the plain −1 — the citations were right, the reading was not.
			el2.textContent = '▼ noted';
			const chips = document.createElement('span');
			chips.className = 'fb-chips';
			const mkChip = (label, detail, ack) => {
				const b = document.createElement('button');
				b.className = 'fb';
				b.textContent = label;
				b.addEventListener('click', () => {
					vscode.postMessage({ type: 'feedbackDetail', decisionId: msg.decisionId, detail, question: msg.question, files: (msg.citations || []).map((c) => c.file) });
					const done = document.createElement('span');
					done.className = 'fb-ack';
					done.textContent = ack;
					chips.replaceWith(done);
				});
				chips.appendChild(b);
			};
			mkChip('wrong files cited', 'wrong_files', 'noted — retrieval will distrust these files for this phrasing');
			mkChip('answer misread them', 'misread', 'noted');
			actions.appendChild(chips);
		};
		up.addEventListener('click', () => settle(up, 1));
		down.addEventListener('click', () => settle(down, -1));
		dispatch.addEventListener('click', () => vscode.postMessage({ type: 'dispatch', question: msg.question }));
		actions.appendChild(up); actions.appendChild(down); actions.appendChild(dispatch);
		turn.appendChild(actions);
	}

	function addNotice(text) {
		const el = document.createElement('div');
		el.className = 'notice';
		el.textContent = text;
		log.appendChild(el);
	}

	function ask() {
		const q = input.value.trim();
		if (!q || busy) { return; }
		input.value = '';
		hints.style.display = 'none';
		if (q.startsWith('/')) {
			// Slash commands answer instantly with a notice — no model turn.
			const empty = log.querySelector('.empty');
			if (empty) { empty.remove(); }
			vscode.postMessage({ type: 'ask', question: q });
			return;
		}
		busy = true;
		makeTurn(q);
		log.scrollTop = log.scrollHeight;
		showThinking('gathering evidence…', 'dig');
		vscode.postMessage({ type: 'ask', question: q });
	}
	document.getElementById('send').addEventListener('click', ask);
	document.getElementById('new-session').addEventListener('click', () => {
		vscode.postMessage({ type: 'newSession' });
	});
	document.getElementById('sessions').addEventListener('click', () => {
		vscode.postMessage({ type: 'sessions' });
	});
	input.addEventListener('keydown', (ev) => {
		if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ask(); }
	});

	// Slash suggestions: typing "/" surfaces the session commands as chips.
	const hints = document.getElementById('hints');
	const COMMANDS = [
		['/goal ', 'set the standing goal for episodes'],
		['/budget ', 'episodes to spend on the goal (1-20)'],
		['/session', 'show goal, budget, and history'],
		['/sessions', 'switch between parked sessions'],
		['/new', 'start a new session (parks the current one)'],
		['/fix ', 'dispatch an issue to the coding harness'],
	];
	input.addEventListener('input', () => {
		const v = input.value;
		if (v.startsWith('/') && !v.includes('\\n')) {
			hints.innerHTML = '';
			for (const [cmd, desc] of COMMANDS) {
				if (!cmd.startsWith(v.trim().split(' ')[0]) && v.trim() !== '/') { continue; }
				const el = document.createElement('span');
				el.className = 'hint';
				el.textContent = cmd.trim() + ' — ' + desc;
				el.addEventListener('click', () => { input.value = cmd; input.focus(); hints.style.display = 'none'; });
				hints.appendChild(el);
			}
			hints.style.display = hints.children.length ? 'block' : 'none';
		} else {
			hints.style.display = 'none';
		}
	});

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'mode') {
			document.getElementById('mode').textContent = msg.label;
		} else if (msg.type === 'seed') {
			const el = document.getElementById('seed');
			el.textContent = msg.label;
			el.style.display = 'block';
		} else if (msg.type === 'thinking') {
			showThinking(msg.label, msg.act);
		} else if (msg.type === 'answer') {
			busy = false;
			celebrate();
			document.getElementById('seed').style.display = 'none';
			const turns = log.querySelectorAll('.turn');
			let turn = turns[turns.length - 1];
			// No open turn (or the last one is already answered — e.g. the user
			// switched sessions away and back while this answer was in flight):
			// give the answer its own turn instead of overwriting one.
			if (!turn || turn.querySelector('.a').innerHTML !== '') { turn = makeTurn(msg.question); }
			fillAnswer(turn, msg);
			log.scrollTop = log.scrollHeight;
		} else if (msg.type === 'restore') {
			// A session's persisted transcript replaces the panel content whole:
			// on panel open (resuming the active session) or a session switch.
			busy = false;
			epBlock = undefined;
			hideThinking();
			document.getElementById('seed').style.display = 'none';
			log.innerHTML = '';
			for (const e of msg.entries || []) {
				if (e.kind === 'qa') {
					fillAnswer(makeTurn(e.question), {
						answer: e.answer, citations: e.citations,
						decisionId: e.decisionId, question: e.question,
					});
				} else {
					addNotice(e.text);
				}
			}
			if (msg.text) { addNotice(msg.text); }
			log.scrollTop = log.scrollHeight;
		} else if (msg.type === 'episode') {
			const empty = log.querySelector('.empty');
			if (empty) { empty.remove(); }
			if (msg.kind === 'start' || !epBlock) {
				epBlock = document.createElement('div');
				epBlock.className = 'episode';
				const head = document.createElement('div');
				head.className = 'ep-head';
				head.innerHTML = '<b>' + esc(msg.text) + '</b>' + (msg.agent ? ' // via ' + esc(msg.agent) : '');
				const feed = document.createElement('pre');
				feed.className = 'ep-feed';
				const toggle = document.createElement('button');
				toggle.className = 'ep-toggle';
				toggle.textContent = 'hide thinking';
				toggle.addEventListener('click', () => {
					const hidden = feed.classList.toggle('collapsed');
					toggle.textContent = hidden ? 'show thinking' : 'hide thinking';
				});
				// The episode's own cancel — with the panel open there is no
				// notification toast, so this is THE way to stop the run.
				const cancel = document.createElement('button');
				cancel.className = 'ep-toggle ep-cancel';
				cancel.textContent = 'cancel episode';
				cancel.addEventListener('click', () => {
					cancel.textContent = 'cancelling…';
					cancel.disabled = true;
					vscode.postMessage({ type: 'episodeCancel' });
				});
				epBlock.appendChild(head); epBlock.appendChild(feed);
				epBlock.appendChild(toggle); epBlock.appendChild(cancel);
				log.appendChild(epBlock);
				if (msg.kind === 'start') { log.scrollTop = log.scrollHeight; return; }
			}
			const feed = epBlock.querySelector('.ep-feed');
			if (msg.kind === 'end') {
				const head = epBlock.querySelector('.ep-head');
				head.innerHTML += ' // <span class="ep-done">' + esc(msg.text) + '</span>';
				if (msg.ok === true) {
					const btn = document.createElement('button');
					btn.className = 'ep-toggle';
					btn.textContent = 'still wrong?';
					btn.title = 'Dispute this verified result — describe the behavior that is still broken and Vinv will turn it into a counterexample test';
					btn.addEventListener('click', () => { btn.disabled = true; btn.textContent = 'disputing…'; vscode.postMessage({ type: 'disputeStart', episodeId: msg.episodeId }); });
					head.appendChild(document.createTextNode(' '));
					head.appendChild(btn);
				}
				const cancel = epBlock.querySelector('.ep-cancel');
				if (cancel) { cancel.remove(); }
				epBlock = undefined;
			} else {
				// Bounded: an agent can emit thousands of lines and the transcript
				// has to stay responsive. Oldest lines fall off the top.
				const line = document.createElement('span');
				if (msg.kind === 'note') { line.className = 'n'; }
				line.textContent = msg.text + '\\n';
				feed.appendChild(line);
				while (feed.childNodes.length > 300) { feed.removeChild(feed.firstChild); }
				// Only chase the tail when the user has not scrolled up to read.
				const pinned = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 24;
				if (pinned) { feed.scrollTop = feed.scrollHeight; }
			}
			const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 60;
			if (atBottom) { log.scrollTop = log.scrollHeight; }
		} else if (msg.type === 'disputePrompt') {
			const empty0 = log.querySelector('.empty');
			if (empty0) { empty0.remove(); }
			const card = document.createElement('div');
			card.className = 'verdict';
			card.innerHTML =
				'<div class="ep-head">vinv needs your counterexample // ' + esc(msg.title) + '</div>' +
				'<p>' + esc(msg.question) + '</p>' +
				'<textarea class="dispute-note" rows="3" placeholder="' + esc(msg.placeholder) + '"></textarea>' +
				'<div class="verdict-actions">' +
				'<button class="v-primary" data-dispute="send">send counterexample</button>' +
				'<button data-dispute="dismiss">never mind</button>' +
				'</div>';
			const settleCard = (note) => {
				card.querySelectorAll('button').forEach((b) => (b.disabled = true));
				vscode.postMessage({ type: 'disputeNote', note });
			};
			card.querySelector('[data-dispute="send"]').addEventListener('click', () => {
				settleCard(card.querySelector('.dispute-note').value);
			});
			card.querySelector('[data-dispute="dismiss"]').addEventListener('click', () => settleCard(''));
			log.appendChild(card);
			card.querySelector('.dispute-note').focus();
			log.scrollTop = log.scrollHeight;
		} else if (msg.type === 'retractionPrompt') {
			// Confirm-before-retract: the verdict relabel is the most irreversible
			// write in the system, so the human sees the authored test's checks
			// before it fires. Dismissal is MNAR: verdict unchanged.
			const empty1 = log.querySelector('.empty');
			if (empty1) { empty1.remove(); }
			const card = document.createElement('div');
			card.className = 'verdict';
			card.innerHTML =
				'<div class="ep-head">confirm before retracting // ' + esc(msg.title) + '</div>' +
				'<p>This test was built from your report and fails on the current code. Do its checks match what you reported?</p>' +
				'<pre class="basis">' + esc((msg.checkLines || []).join('\\n')) + '</pre>' +
				'<div class="verdict-actions">' +
				'<button class="v-primary" data-retract="confirmed">retract — it matches</button>' +
				'<button data-retract="declined">keep verdict — that\\'s not what I meant</button>' +
				'<button data-retract="open">open the full test</button>' +
				'</div>';
			const settleRetract = (choice) => {
				card.querySelectorAll('button').forEach((b) => (b.disabled = true));
				const chosen = document.createElement('div');
				chosen.className = 'chosen';
				chosen.textContent = choice === 'confirmed' ? '\u25b8 retracting \u2014 the test joins the permanent oracle' : '\u25b8 verdict kept \u2014 nothing was merged';
				card.appendChild(chosen);
				vscode.postMessage({ type: 'retractionConfirm', choice });
			};
			card.querySelector('[data-retract="confirmed"]').addEventListener('click', () => settleRetract('confirmed'));
			card.querySelector('[data-retract="declined"]').addEventListener('click', () => settleRetract('declined'));
			card.querySelector('[data-retract="open"]').addEventListener('click', () => {
				vscode.postMessage({ type: 'openSource', file: msg.stagedPath, line: 1 });
			});
			log.appendChild(card);
			log.scrollTop = log.scrollHeight;
		} else if (msg.type === 'episodeVerdict') {
			const empty = log.querySelector('.empty');
			if (empty) { empty.remove(); }
			const card = document.createElement('div');
			card.className = 'verdict';
			const meta = [];
			if (msg.agent) { meta.push('agent: ' + msg.agent); }
			if (msg.attempt) { meta.push('attempt ' + msg.attempt + ' of ' + (msg.attemptBudget || '?')); }
			const answerMode = msg.mode === 'answer';
			const proposals = msg.proposals || [];
			card.innerHTML =
				'<div class="ep-head">' + (answerMode ? 'vinv answered — what next?' : 'vinv needs your judgment') + (meta.length ? ' // ' + esc(meta.join(' // ')) : '') + '</div>' +
				'<h3>' + esc(msg.title) + '</h3>' +
				'<pre class="basis">' + esc(msg.detail) + '</pre>';
			// The agent's "want me to implement #1 and #2?" made actionable. Before
			// this the operator could only accept or reject, and either way the work
			// the agent had already scoped was discarded.
			const boxes = [];
			if (proposals.length) {
				const head = document.createElement('div');
				head.className = 'ep-head';
				head.textContent = 'proposed work — tick what you want done';
				card.appendChild(head);
				const list = document.createElement('div');
				list.className = 'proposals';
				proposals.forEach((p) => {
					const row = document.createElement('label');
					const box = document.createElement('input');
					box.type = 'checkbox';
					box.value = p;
					boxes.push(box);
					const span = document.createElement('span');
					span.textContent = p;
					row.appendChild(box);
					row.appendChild(span);
					list.appendChild(row);
				});
				card.appendChild(list);
			}
			const selected = () => boxes.filter((b) => b.checked).map((b) => b.value);
			const acts = document.createElement('div');
			acts.className = 'acts';
			const note = document.createElement('textarea');
			note.placeholder = answerMode
				? 'Optional: ask a follow-up question, or redirect the agent.'
				: 'Optional: type an instruction for the agent — it is injected into the next attempt as authoritative direction.';
			const choose = (action, label) => {
				card.dataset.settled = '1';
				const picked = selected();
				const chosen = document.createElement('div');
				chosen.className = 'chosen';
				chosen.textContent = '▸ ' + label +
					(picked.length ? ' — queued: ' + picked.join('; ') : '') +
					(note.value.trim() ? ' — "' + note.value.trim() + '"' : '');
				card.appendChild(chosen);
				vscode.postMessage({ type: 'episodeVerdict', action: action, note: note.value, selectedProposals: picked });
			};
			const btn = (label, action, cls) => {
				const b = document.createElement('button');
				b.className = 'v-btn' + (cls ? ' ' + cls : '');
				b.textContent = label;
				b.addEventListener('click', () => choose(action, label));
				acts.appendChild(b);
			};
			if (answerMode) {
				btn(proposals.length ? 'accept answer & queue selected' : 'accept answer', 'approve', 'primary');
				btn('ask a follow-up', 'retry');
			} else {
				btn('accept as done', 'approve', 'primary');
				btn('reject & retry', 'retry');
			}
			if (msg.canRevert) { btn('revert & abort', 'revert'); }
			btn('abort episode', 'abort');
			const viewPack = document.createElement('button');
			viewPack.className = 'v-btn';
			viewPack.textContent = 'open context pack';
			viewPack.addEventListener('click', () => vscode.postMessage({ type: 'viewPack', file: msg.packPath }));
			acts.appendChild(viewPack);
			card.appendChild(acts);
			card.appendChild(note);
			log.appendChild(card);
			log.scrollTop = log.scrollHeight;
		} else if (msg.type === 'dispatchConfirm') {
			const card = document.createElement('div');
			card.className = 'verdict';
			card.innerHTML =
				'<div class="ep-head">dispatch to harness // episode ' + (msg.used + 1) + ' of ' + msg.budget + '</div>' +
				'<h3>' + esc(msg.question) + '</h3>' +
				'<div class="goal-label">standing goal — steers what the agent optimises for, and is sent with every episode. editing it starts a fresh budget (the episode counter resets)</div>';
			const goal = document.createElement('textarea');
			goal.value = msg.goal || '';
			goal.placeholder = 'No standing goal set. Leave empty for per-task mode, or state what episodes should work toward.';
			// Anything the user types wins over a late-arriving suggestion.
			goal.addEventListener('input', () => { goal.dataset.dirty = '1'; });
			card.appendChild(goal);
			let goalStatus;
			if (msg.generating) {
				goalStatus = document.createElement('div');
				goalStatus.className = 'goal-label';
				goalStatus.textContent = 'drafting a suggested goal from this session\\u2019s evidence\\u2026 (edit or dispatch any time)';
				card.appendChild(goalStatus);
			}
			goalCard = { card: card, goal: goal, status: goalStatus };
			const acts = document.createElement('div');
			acts.className = 'acts';
			const go = document.createElement('button');
			go.className = 'v-btn primary';
			go.textContent = 'dispatch';
			const cancel = document.createElement('button');
			cancel.className = 'v-btn';
			cancel.textContent = 'cancel';
			const close = (label) => {
				card.dataset.settled = '1';
				const chosen = document.createElement('div');
				chosen.className = 'chosen';
				chosen.textContent = '▸ ' + label;
				card.appendChild(chosen);
			};
			go.addEventListener('click', () => {
				// Changing the goal here resets the episode counter (a new goal
				// gets a fresh budget) — that is setGoal's rule, not ours.
				vscode.postMessage({ type: 'dispatchGo', note: goal.value });
				close('dispatched' + (goal.value.trim() ? ' — goal: ' + goal.value.trim() : ''));
			});
			cancel.addEventListener('click', () => {
				vscode.postMessage({ type: 'dispatchCancel' });
				close('cancelled');
			});
			acts.appendChild(go); acts.appendChild(cancel);
			card.appendChild(acts);
			log.appendChild(card);
			log.scrollTop = log.scrollHeight;
			goal.focus();
		} else if (msg.type === 'dispatchGoalSuggestion') {
			// The drafted goal for the open dispatch card. Only a DEFAULT: it
			// fills the textarea when the user has not typed there; a settled,
			// replaced, or edited card ignores it (the extension side already
			// drops suggestions for superseded dispatches).
			const t = goalCard;
			if (!t || t.card.dataset.settled === '1' || !document.body.contains(t.card)) {
				return;
			}
			if (msg.goal && !t.goal.dataset.dirty && !t.goal.value.trim()) {
				t.goal.value = msg.goal;
				if (t.status) { t.status.textContent = 'suggested by the goal engine \\u2014 edit freely, this is only a default'; }
			} else if (t.status) {
				// No suggestion (engine failed) or the user got there first.
				t.status.remove();
				t.status = undefined;
			}
		} else if (msg.type === 'sessionCleared') {
			// Full reset of the panel's visible state: transcript, in-flight
			// question, episode block, seed chip. The extension side already
			// reset the persisted session and its own module state.
			busy = false;
			epBlock = undefined;
			goalCard = undefined;
			hideThinking();
			document.getElementById('seed').style.display = 'none';
			log.innerHTML = '';
			addNotice(msg.text);
		} else if (msg.type === 'notice') {
			const empty = log.querySelector('.empty');
			if (empty) { empty.remove(); }
			addNotice(msg.text);
			log.scrollTop = log.scrollHeight;
		} else if (msg.type === 'error') {
			busy = false;
			hideThinking();
			const turns = log.querySelectorAll('.turn');
			const turn = turns[turns.length - 1];
			if (turn) {
				turn.querySelector('.a').innerHTML = '<span class="err">' + esc(msg.message) + '</span>';
			}
		}
	});
	vscode.postMessage({ type: 'ready' });
	input.focus();
	</script>
</body>
</html>`;
}
