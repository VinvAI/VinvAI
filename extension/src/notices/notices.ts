/**
 * Reaching users who already installed — the one thing a marketplace changelog
 * cannot do.
 *
 * When a release fixes something that leaves the installed build broken (an
 * engines pin that never settles, a sidecar that reports "not running" while it
 * loads), the user on the broken version has no way to learn that. The
 * changelog is read by nobody and GitHub reaches contributors, not users. So
 * this polls a static JSON file at a Vinv-controlled endpoint on activation and
 * surfaces at most one toast.
 *
 * IT IS FOR BROKEN RELEASES AND SECURITY NOTICES. Not announcements, not
 * features, not anything the user would call marketing — that is the failure
 * mode that gets an extension one-starred, and every gate below exists to make
 * the spam case hard to build by accident:
 *
 *   - version-gated: an "update now" notice must never fire at someone who
 *     already updated, which is exactly the audience that did the right thing;
 *   - once per id, persisted in globalState, so a reload never repeats one;
 *   - expiring, client-side, so a notice that outlives its reason goes quiet
 *     even if the endpoint keeps serving it;
 *   - one per activation, and off with a single setting.
 *
 * THIS IS THE EXTENSION'S ONLY OUTBOUND REQUEST. It is a GET of a static file:
 * no query string, no identifiers, no version, nothing uploaded. All filtering
 * happens here, on the client, precisely so the request carries nothing. It
 * follows no redirects, and the URL is a constant no setting can repoint.
 *
 * THE PAYLOAD IS UNTRUSTED. It cannot name a VS Code command — the file picks
 * from the closed set in `resolveAction`, and link targets are https on an
 * allowlisted host. A hijacked endpoint gets to show a toast, and nothing else.
 */
import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';

/** Where notices are published. Deliberately not configurable — see the header. */
const NOTICES_URL = 'https://notices.vinv.ai/notices.json';

/** Ids already shown, so a notice never repeats across windows. */
const SEEN_KEY = 'vinv.notices.seen';

/** Epoch ms of the last fetch attempt — successful or not. */
const LAST_FETCH_KEY = 'vinv.notices.lastFetch';

/**
 * Minimum gap between fetches. Activation runs on every window, and a user with
 * six windows open reloading all day must not turn into six requests an hour.
 */
const MIN_FETCH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Response cap. A notices file is a few KB; anything larger is not one. */
const MAX_BYTES = 64 * 1024;

/** Request timeout. Activation never waits on this, but the socket should not leak. */
const TIMEOUT_MS = 5_000;

/** Caps on the payload, so a hostile file cannot produce an unreadable toast. */
const MAX_NOTICES = 20;
const MAX_ID = 80;
const MAX_TITLE = 120;
const MAX_BODY = 300;
const MAX_LABEL = 40;
const MAX_RANGE = 80;

/**
 * Buttons a notice may carry, before the dismiss button. VS Code renders these
 * inline and starts truncating labels past three, and dismiss always occupies
 * one — so two is what fits, not an arbitrary limit.
 */
const MAX_ACTIONS = 2;

/** How many seen ids to retain — enough that an expired notice never re-fires. */
const MAX_SEEN = 100;

/** The permanent off switch on every notice. Never supplied by the payload. */
const DISMISS_LABEL = "Don't Show Notices";

/** Hosts a notice may link to. Anything else is dropped along with the action. */
const ALLOWED_LINK_HOSTS = new Set([
	'vinv.ai',
	'www.vinv.ai',
	'github.com',
	'open-vsx.org',
	'marketplace.visualstudio.com',
]);

export type NoticeSeverity = 'info' | 'warning';

/**
 * Where a notice's button goes. The notice writes its own call to action — the
 * label, the order, and which of these it points at — but not the behaviour.
 *
 * Three, and it is a closed set NOT a command id, which is the whole point: the
 * payload picks a destination, so the worst a compromised endpoint can do is
 * send someone to the wrong one of three harmless places. A command name taken
 * from a remote file would be remote execution —
 * `workbench.action.terminal.sendSequence` on its own runs whatever text it is
 * handed. Adding a kind here is a deliberate act; reading one out of the file
 * never is.
 */
export type NoticeActionKind = 'checkForUpdates' | 'updateEngines';

export type NoticeAction =
	| { kind: NoticeActionKind; label: string }
	| { kind: 'open'; label: string; url: string };

export interface Notice {
	/** Stable id — the once-only key. Changing it re-shows the notice. */
	id: string;
	severity: NoticeSeverity;
	/** Version range this applies to, e.g. `<0.1.5` or `>=0.1.0 <0.2.0`. */
	appliesTo: string;
	title: string;
	body: string;
	/** ISO date after which the notice is dropped client-side. */
	expires: string;
	/** The notice's own buttons, in the order it wants them. May be empty. */
	actions: NoticeAction[];
}

/** True when the user has not turned notices off. */
function noticesEnabled(): boolean {
	return vscode.workspace.getConfiguration('vinv').get<boolean>('notices.enabled', true);
}

/** Collapses whitespace and trims to `max`, so payload text cannot break the toast. */
function text(value: unknown, max: number): string {
	if (typeof value !== 'string') {
		return '';
	}
	return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** `x.y.z` as a comparable tuple, or null when it is not a version at all. */
function parseVersion(value: string): [number, number, number] | null {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether `version` falls in `range`.
 *
 * A deliberately small subset of semver — `*`, a bare version meaning exact, the
 * five comparators, and space-joined conjunctions — hand-rolled rather than
 * pulling in `semver`, because the vsix has no runtime dependencies at all and a
 * notice range is not the reason to acquire the first one.
 *
 * Anything it cannot parse returns false, so an unsupported range means the
 * notice does not apply. That is the safe direction: a notice nobody sees beats
 * a notice everybody sees.
 */
export function versionSatisfies(version: string, range: string): boolean {
	const current = parseVersion(version);
	if (!current) {
		return false;
	}
	const spec = range.trim();
	if (spec === '*') {
		return true;
	}
	const clauses = spec.split(/\s+/).filter((c) => c.length > 0);
	if (clauses.length === 0) {
		return false;
	}
	return clauses.every((clause) => {
		const m = /^(<=|>=|<|>|=)?\s*(\d+\.\d+\.\d+)$/.exec(clause);
		if (!m) {
			return false;
		}
		const target = parseVersion(m[2]);
		if (!target) {
			return false;
		}
		const c = compare(current, target);
		switch (m[1] ?? '=') {
			case '<':
				return c < 0;
			case '<=':
				return c <= 0;
			case '>':
				return c > 0;
			case '>=':
				return c >= 0;
			default:
				return c === 0;
		}
	});
}

/**
 * One action, or undefined when the notice gave neither a command nor a usable
 * link. Undefined is not an error — the notice still shows, one button lighter.
 */
function resolveAction(raw: unknown): NoticeAction | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const source = raw as Record<string, unknown>;
	const label = text(source.label, MAX_LABEL);
	if (!label || label === DISMISS_LABEL) {
		// A button that impersonates the dismiss button would make the user's
		// choice unreadable — the API answers with a label, not an index.
		return undefined;
	}

	switch (source.kind) {
		case 'checkForUpdates':
		case 'updateEngines':
			return { kind: source.kind, label };
		case 'open': {
			const url = typeof source.url === 'string' ? source.url.trim() : '';
			try {
				const parsed = new URL(url);
				// https only, and only somewhere Vinv actually publishes. A notice
				// that could link anywhere is a phishing primitive.
				if (parsed.protocol !== 'https:' || !ALLOWED_LINK_HOSTS.has(parsed.hostname)) {
					return undefined;
				}
			} catch {
				return undefined;
			}
			return { kind: 'open', label, url };
		}
		default:
			return undefined;
	}
}

/**
 * The notice's buttons, in its own order. Duplicate labels are dropped rather
 * than rendered twice: two buttons reading the same thing cannot be told apart
 * in the answer, so the second one would be dead.
 */
function resolveActions(raw: unknown): NoticeAction[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const actions: NoticeAction[] = [];
	const labels = new Set<string>();
	for (const entry of raw) {
		if (actions.length >= MAX_ACTIONS) {
			break;
		}
		const action = resolveAction(entry);
		if (action && !labels.has(action.label)) {
			labels.add(action.label);
			actions.push(action);
		}
	}
	return actions;
}

/**
 * The notices in a payload, dropping anything malformed rather than throwing.
 *
 * Every field is required except `action` and `body`: a notice with no expiry or
 * no range is a notice that would show forever, to everyone, which is the thing
 * this module exists to prevent.
 */
export function parseNotices(raw: string): Notice[] {
	if (raw.length > MAX_BYTES) {
		return [];
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return [];
	}
	const list = (payload as { notices?: unknown } | null)?.notices;
	if (!Array.isArray(list)) {
		return [];
	}
	const notices: Notice[] = [];
	for (const entry of list.slice(0, MAX_NOTICES)) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const source = entry as Record<string, unknown>;
		const id = text(source.id, MAX_ID);
		const title = text(source.title, MAX_TITLE);
		const appliesTo = text(source.appliesTo, MAX_RANGE);
		const expires = text(source.expires, 40);
		if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || !title || !appliesTo) {
			continue;
		}
		if (!expires || Number.isNaN(Date.parse(expires))) {
			continue;
		}
		notices.push({
			id,
			severity: source.severity === 'warning' ? 'warning' : 'info',
			appliesTo,
			title,
			body: text(source.body, MAX_BODY),
			expires,
			actions: resolveActions(source.actions),
		});
	}
	return notices;
}

/**
 * The one notice to show, or null. Warnings win over info; otherwise the file's
 * own order decides, so whoever publishes it controls precedence.
 */
export function selectNotice(input: {
	notices: Notice[];
	version: string;
	seenIds: readonly string[];
	now: number;
}): Notice | null {
	const seen = new Set(input.seenIds);
	const eligible = input.notices.filter(
		(n) =>
			!seen.has(n.id) &&
			Date.parse(n.expires) > input.now &&
			versionSatisfies(input.version, n.appliesTo),
	);
	return eligible.find((n) => n.severity === 'warning') ?? eligible[0] ?? null;
}

/**
 * GETs `url`, or resolves null on anything at all going wrong — offline, DNS
 * failure, 404, a body over the cap. The endpoint being unreachable is a normal
 * state, not an error worth a word to the user.
 *
 * No redirects are followed: a redirect is how a fetch pinned to one host ends
 * up talking to another.
 */
function download(url: string): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: string | null): void => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		try {
			// http is reachable only through VINV_NOTICES_URL, which exists so the
			// flow can be exercised against a local file without a live endpoint.
			const client = url.startsWith('http://') ? http : https;
			const request = client.get(url, { timeout: TIMEOUT_MS }, (response) => {
				if (response.statusCode !== 200) {
					response.destroy();
					finish(null);
					return;
				}
				let body = '';
				let bytes = 0;
				response.setEncoding('utf8');
				response.on('data', (chunk: string) => {
					bytes += Buffer.byteLength(chunk, 'utf8');
					if (bytes > MAX_BYTES) {
						response.destroy();
						finish(null);
						return;
					}
					body += chunk;
				});
				response.on('end', () => finish(body));
				response.on('error', () => finish(null));
			});
			request.on('timeout', () => {
				request.destroy();
				finish(null);
			});
			request.on('error', () => finish(null));
		} catch {
			finish(null);
		}
	});
}

/** Runs a resolved action. Every branch is a fixed behaviour — see resolveAction. */
async function runAction(action: NoticeAction): Promise<void> {
	switch (action.kind) {
		case 'checkForUpdates':
			await vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates');
			return;
		case 'updateEngines':
			await vscode.commands.executeCommand('vinv-vs.updateEngines');
			return;
		case 'open':
			await vscode.env.openExternal(vscode.Uri.parse(action.url));
			return;
	}
}

/**
 * Fetches the notices file and shows at most one notice.
 *
 * Called on activation and never awaited: a slow endpoint must not delay the
 * window, and a missing one must not say anything.
 */
export async function maybeShowNotices(context: vscode.ExtensionContext): Promise<void> {
	if (!noticesEnabled()) {
		return;
	}
	const now = Date.now();
	const last = context.globalState.get<number>(LAST_FETCH_KEY) ?? 0;
	if (now - last < MIN_FETCH_INTERVAL_MS) {
		return;
	}
	// Stamped before the request, not after: an endpoint that hangs or 500s must
	// cost one attempt per interval, not one per window reload.
	await context.globalState.update(LAST_FETCH_KEY, now);

	const raw = await download(process.env.VINV_NOTICES_URL?.trim() || NOTICES_URL);
	if (raw === null) {
		return;
	}

	const seenIds = context.globalState.get<string[]>(SEEN_KEY) ?? [];
	const notice = selectNotice({
		notices: parseNotices(raw),
		version: String(context.extension.packageJSON.version ?? ''),
		seenIds,
		now,
	});
	if (!notice) {
		return;
	}

	// Marked seen before the toast is awaited, so a window reload while it sits
	// unanswered does not show it twice.
	await context.globalState.update(SEEN_KEY, [...seenIds, notice.id].slice(-MAX_SEEN));

	// "Vinv:" is prefixed here rather than taken from the payload — the file does
	// not get to choose whose voice the toast speaks in.
	const message = notice.body ? `Vinv: ${notice.title} — ${notice.body}` : `Vinv: ${notice.title}`;
	const buttons = [...notice.actions.map((a) => a.label), DISMISS_LABEL];
	const choice =
		notice.severity === 'warning'
			? await vscode.window.showWarningMessage(message, ...buttons)
			: await vscode.window.showInformationMessage(message, ...buttons);

	if (choice === DISMISS_LABEL) {
		await vscode.workspace
			.getConfiguration('vinv')
			.update('notices.enabled', false, vscode.ConfigurationTarget.Global);
		return;
	}
	// Labels are deduplicated at parse time, so a label identifies one action.
	const chosen = notice.actions.find((a) => a.label === choice);
	if (chosen) {
		await runAction(chosen);
	}
}
