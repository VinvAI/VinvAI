/**
 * The PostHog sender, behind VS Code's own TelemetrySender interface.
 *
 * Nothing outside this file imports the SDK, which is what makes "does the MCP
 * server bundle posthog-node?" answerable with one grep — and enforceable in
 * scripts/test-packaged.mjs.
 *
 * The governing constraint is that telemetry is NEVER worth a user-visible
 * failure. Vinv's job is running and verifying services; an analytics endpoint
 * having a bad day must be invisible. So:
 *
 *   - capture is fire-and-forget, never awaited, and cannot throw;
 *   - one internal throw permanently silences the session rather than
 *     retrying into a hole;
 *   - the SDK is required lazily, so a build that never sends never even
 *     evaluates it;
 *   - a per-session event ceiling and a per-name token bucket bound the damage
 *     from a runaway producer. That is not hypothetical: six webviews attach
 *     window.onerror, and a renderer throwing every frame would otherwise emit
 *     tens of thousands of events a minute.
 */
import type { PostHog } from 'posthog-node';
import { getDistinctId, POSTHOG_HOST, POSTHOG_KEY } from './common';
import { sanitizeProps } from './sanitize';

/**
 * Hard ceiling per window. Well above any legitimate session — a busy hour of
 * real use is a few hundred events — and low enough that a runaway loop cannot
 * exhaust a PostHog quota before the window closes.
 */
const MAX_EVENTS_PER_SESSION = 500;

/** Per-event-name ceiling, so one pathological producer cannot crowd out the rest. */
const MAX_PER_EVENT_NAME = 100;

/** Matches notices.ts TIMEOUT_MS — the house figure for "a request that must not linger". */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * How long a batch may sit unsent. Short on purpose: the events that matter
 * most (an install dying at the engines step) come from windows that are about
 * to be closed, and anything still queued at that point is usually lost.
 */
const FLUSH_INTERVAL_MS = 10_000;

/** The last N payloads actually handed to the SDK, for the diagnostics dump. */
const RECENT_LIMIT = 50;

export interface SentRecord {
	at: string;
	event: string;
	properties: Record<string, unknown>;
}

export class PostHogSender {
	private client: PostHog | null = null;
	private broken = false;
	private sent = 0;
	private perName = new Map<string, number>();
	private recent: SentRecord[] = [];

	constructor() {
		try {
			// Lazily required, so a build with no key — or a host that has
			// telemetry switched off — never loads the SDK at all and pays
			// nothing for it at activation.
			const { PostHog: Ctor } = require('posthog-node') as typeof import('posthog-node');
			this.client = new Ctor(POSTHOG_KEY, {
				host: POSTHOG_HOST,
				flushAt: 20,
				flushInterval: FLUSH_INTERVAL_MS,
				requestTimeout: REQUEST_TIMEOUT_MS,
				// Stops PostHog inferring a location from the request IP.
				// IP-derived geolocation is personal data, and leaving it on
				// would quietly undo the anonymity the rest of this is for.
				disableGeoip: true,
			});
		} catch {
			// A missing or broken SDK is not an error worth surfacing: the
			// extension works identically without telemetry.
			this.broken = true;
		}
	}

	/** The TelemetrySender contract. Must not throw, must not return a promise. */
	sendEventData(eventName: string, data?: Record<string, unknown>): void {
		if (this.broken || !this.client) {
			return;
		}
		if (this.sent >= MAX_EVENTS_PER_SESSION) {
			return;
		}
		const seen = this.perName.get(eventName) ?? 0;
		if (seen >= MAX_PER_EVENT_NAME) {
			return;
		}
		try {
			// Lenient: this is the last gate before the wire, and by here VS
			// Code's own cleaner has already had a pass. Dropping a field beats
			// dropping the event; the strict check happened back at `track`.
			const properties = sanitizeProps(data ?? {}, false);
			this.sent++;
			this.perName.set(eventName, seen + 1);
			this.remember(eventName, properties);
			this.client.capture({
				distinctId: getDistinctId(),
				event: eventName,
				properties,
			});
		} catch {
			// One failure is enough. Retrying into a broken client would turn a
			// silent non-problem into a busy one.
			this.broken = true;
		}
	}

	/**
	 * Deliberately empty.
	 *
	 * VS Code calls this from `TelemetryLogger.logError(Error)`, handing over the
	 * raw Error — including a stack full of absolute paths, and a message that
	 * may quote the user's source. That is exactly what must not be transmitted,
	 * and it would also be unbounded-cardinality data that makes the PostHog
	 * project useless. Error EVENTS go through logUsage with a pre-classified
	 * `error_class` and, where grouping matters, a one-way `digest`.
	 *
	 * Left as an empty implementation with this comment rather than omitted, so
	 * that anyone reaching for logError finds out why it does nothing.
	 */
	sendErrorData(): void {
		/* intentionally not implemented — see the comment above */
	}

	/** What was actually sent this session, newest last. For the diagnostics dump. */
	recentlySent(): ReadonlyArray<SentRecord> {
		return this.recent;
	}

	/**
	 * Flushes and closes, bounded. VS Code gives `deactivate` a short and
	 * unguaranteed window, and losing a queued event is always preferable to
	 * delaying the shutdown of the embedder sidecar and the exercise engine,
	 * which is what else is happening at that moment.
	 */
	async shutdown(timeoutMs: number): Promise<void> {
		const client = this.client;
		this.client = null;
		if (!client) {
			return;
		}
		try {
			await Promise.race([
				client.shutdown(),
				new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
			]);
		} catch {
			// Nothing useful to do: the window is closing either way.
		}
	}

	/** Drops everything queued without sending it. */
	discard(): void {
		this.broken = true;
		const client = this.client;
		this.client = null;
		try {
			void client?.shutdown();
		} catch {
			// Best effort.
		}
	}

	private remember(event: string, properties: Record<string, unknown>): void {
		this.recent.push({ at: new Date().toISOString(), event, properties });
		if (this.recent.length > RECENT_LIMIT) {
			this.recent.shift();
		}
	}
}
