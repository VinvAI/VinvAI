/**
 * Vinv's usage telemetry — the only public surface of this module.
 *
 * WHY THIS EXISTS. Vinv has no feedback channel. Issues and reviews do not
 * arrive, so nobody knows whether an install ever reaches a working state,
 * which step kills the ones that do not, or what errors people actually hit.
 * Several of the most important failures are literally invisible today: the
 * engines install runs in a terminal and never reports back, and two real
 * failure paths end in a `console.error` nobody will ever read. This turns that
 * into three answerable questions — where users get blocked, what they do, and
 * what breaks.
 *
 * WHAT IT SENDS. Event names, outcomes, bucketed durations and counts, and
 * error CATEGORIES. Never file paths, never code, never repository names, never
 * raw error text, never URLs. The guarantee is mechanical, not editorial: every
 * property crosses the allowlist in sanitize.ts, which drops anything that
 * cannot be spelled without a slash, a space or a quote.
 *
 * WHAT GATES IT. Telemetry is on by default. Two conditions still apply, and
 * neither is a Vinv-specific consent gate:
 *
 *   - `vscode.env.isTelemetryEnabled` — the editor's own global switch, honoured
 *     for free by `createTelemetryLogger`. Ignoring it would violate the
 *     Marketplace publisher requirements and would mean writing extra code to
 *     override a machine-wide refusal the user already expressed.
 *   - production builds only — a data-quality filter, not a user protection.
 *     `@vscode/test-cli` runs the suite in Test mode and contributors run F5
 *     sessions in Development mode; without this, synthetic events from CI and
 *     from the people writing the code would swamp the funnel numbers this
 *     exists to produce.
 *
 * FAILURE POSTURE. Telemetry is never worth a user-visible failure. `track` and
 * `initTelemetry` cannot throw and are never awaited; a dead endpoint costs
 * nothing because nothing waits on it. This mirrors the discipline already
 * established for the one other outbound request in the extension — see the
 * header of src/notices/notices.ts.
 */
import * as vscode from 'vscode';
import type { EventName, EventProps } from './events';
import { PostHogSender, type SentRecord } from './client';
import {
	initCommonProps,
	installAgeDays,
	installAgeHours,
	markFirstSeen,
	POSTHOG_KEY,
	withCommonProps,
} from './common';
import { sanitizeProps, setSanitizerStrict } from './sanitize';

export type { ErrorClass } from './sanitize';
export { allowlist, bucketCount, bucketMs, classifyError, messageDigest } from './sanitize';
export { isFirstEverInstall, installAgeDays, installAgeHours } from './common';
export type { DiscoveryStage, ErrorCode, EventName, LongOpId, Outcome, WebviewId } from './events';

/** The key a build ships when nobody replaced the placeholder. */
const PLACEHOLDER_KEY = 'phc_REPLACE_WITH_PROJECT_KEY';

/**
 * Debug builds only. When true (set with `VINV_TELEMETRY_FORCE=1` at build
 * time), `track` hands events straight to the PostHog sender, bypassing the
 * `vscode.env.isTelemetryEnabled` gate that `createTelemetryLogger` enforces.
 *
 * This exists for one narrow purpose: a build handed to a specific user who has
 * raised an issue, so their diagnostics arrive even if their editor's telemetry
 * is switched off. It also lets telemetry initialise in a non-production build,
 * so the Extension Development Host can be used to reproduce. A normal
 * `npm run package` leaves the flag empty, and consent is respected as before.
 */
const FORCE_SEND = process.env.VINV_TELEMETRY_FORCE === '1';

let logger: vscode.TelemetryLogger | undefined;
let sender: PostHogSender | undefined;
/** Why telemetry is inactive, when it is. Surfaced in the diagnostics dump. */
let inactiveReason = 'not-initialised';

/**
 * Wires telemetry up. Returns synchronously and never throws — call it with
 * `initTelemetry(context)` from `activate`, not with `await`.
 */
export function initTelemetry(context: vscode.ExtensionContext): void {
	try {
		const production = context.extensionMode === vscode.ExtensionMode.Production;
		// Strict sanitising outside production: a call site that would leak
		// should break the author's test run, loudly, on their machine.
		setSanitizerStrict(!production);

		initCommonProps(context);
		const isFirstEver = markFirstSeen(context);

		if (!production && !FORCE_SEND) {
			inactiveReason = 'dev-build';
			return;
		}
		if (!POSTHOG_KEY || POSTHOG_KEY === PLACEHOLDER_KEY) {
			inactiveReason = 'no-key';
			return;
		}

		sender = new PostHogSender();
		logger = vscode.env.createTelemetryLogger(sender, {
			// Vinv computes its own common properties (see common.ts) and every
			// one of them is a bare snake_case key. The built-ins arrive as
			// dotted `common.*` keys, which the allowlist would reject and
			// which would duplicate what is already there.
			ignoreBuiltInCommonProperties: true,
		});
		context.subscriptions.push(logger);
		inactiveReason = '';

		if (isFirstEver) {
			track('install_first_seen', {
				editor: String(withCommonProps({}).editor ?? 'other'),
				platform: process.platform,
			});
		}
	} catch {
		// Telemetry must never be the reason activation fails.
		inactiveReason = 'init-failed';
		logger = undefined;
		sender = undefined;
	}
}

/**
 * Records one event. Fire-and-forget by construction: no return value, no
 * promise, and no path out of here that throws in production.
 */
export function track<K extends EventName>(name: K, props: EventProps[K]): void {
	if (!logger && !(FORCE_SEND && sender)) {
		return;
	}
	try {
		// The authoring boundary. In a dev build an unsafe property throws here,
		// naming the event and the field, which is the moment it is cheapest to
		// fix. In production the offending field is simply dropped.
		const safe = sanitizeProps(withCommonProps(props as Record<string, unknown>));
		if (FORCE_SEND && sender) {
			// Debug build: skip the editor's telemetry switch and hand the event
			// straight to the sender. See FORCE_SEND.
			sender.sendEventData(name, safe);
		} else if (logger) {
			// logUsage, never logError: VS Code's error path would hand the sender
			// a raw Error with an absolute-path stack. See PostHogSender.sendErrorData.
			logger.logUsage(name, safe);
		}
	} catch {
		// Never let an instrumentation bug break the feature it instruments.
	}
}

/** True when events are actually being sent. */
export function isTelemetryActive(): boolean {
	// A debug build reports regardless of the editor's telemetry switch.
	if (FORCE_SEND) {
		return sender !== undefined;
	}
	return logger !== undefined && vscode.env.isTelemetryEnabled;
}

/**
 * A human-readable account of the current state, for `Vinv: Export Diagnostics`.
 * Shows what is being sent, so a user filing a bug can see it for themselves.
 */
export function telemetryDiagnostics(): string {
	const lines = [
		`active:            ${isTelemetryActive()}`,
		`host_telemetry:    ${vscode.env.isTelemetryEnabled}`,
		`force_send:        ${FORCE_SEND}`,
		`inactive_reason:   ${inactiveReason || '(none)'}`,
	];
	const recent: ReadonlyArray<SentRecord> = sender?.recentlySent() ?? [];
	lines.push(`events_sent:       ${recent.length}${recent.length === 50 ? '+ (last 50)' : ''}`);
	for (const r of recent) {
		lines.push(`  ${r.at} ${r.event} ${JSON.stringify(r.properties)}`);
	}
	return lines.join('\n');
}

/**
 * Flushes and closes, bounded. Called from `deactivate`, where the window is
 * short and not guaranteed — losing queued events is the expected case, not a
 * bug to engineer around.
 */
export async function shutdownTelemetry(timeoutMs = 1500): Promise<void> {
	const s = sender;
	logger = undefined;
	sender = undefined;
	await s?.shutdown(timeoutMs);
}
