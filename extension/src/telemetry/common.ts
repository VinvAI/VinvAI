/**
 * Identity and environment — the properties attached to every event.
 *
 * The model here is `src/support/diagnostics.ts`, which already worked out what
 * environment surface is worth capturing when a user reports a bug. The one
 * deliberate difference: diagnostics prints the raw `machineId` into a local
 * file the user reads and chooses to share; telemetry sends only a hash of it,
 * so the value that travels cannot be joined against anything else that sees a
 * VS Code machine id.
 *
 * Everything user-controlled is either hashed or forced through an allowlist.
 * `appName`, in particular, is editable by any fork and is never sent raw.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { getHarnessId } from '../config/settings';
import { allowlist, bucketCount } from './sanitize';

/**
 * The PostHog project API key.
 *
 * Public and write-only by design — PostHog client keys are meant to ship
 * inside the client, and possessing one grants nothing but the ability to
 * write events. Baked in as a constant so a plain `npm run bundle` produces a
 * working build with no extra setup; overridable at BUILD time (see the
 * `define` block in esbuild.mjs) so a dev build can be pointed at a scratch
 * project instead of polluting production data.
 */
export const POSTHOG_KEY =
	process.env.VINV_POSTHOG_KEY || 'phc_nJPFyhrR2SowGbCxrgA8VSgpMKNPx4WE4mu94vKRwqkD';

/**
 * Ingest host. MUST be set explicitly and MUST match the region the project was
 * created in: PostHog keys are region-bound, and pointing an EU key at the US
 * default fails silently at ingest — no error, no events, nothing to notice.
 */
export const POSTHOG_HOST = process.env.VINV_POSTHOG_HOST || 'https://eu.i.posthog.com';

/**
 * Salt for identity hashes. A build constant, not a secret: it exists so the
 * ids Vinv reports are specific to Vinv and cannot be correlated with any other
 * extension that also hashes `machineId`.
 */
const ID_SALT = 'vinv-telemetry-v1';

/** Key under which the first-activation timestamp is stamped, for cohort age. */
const FIRST_SEEN_KEY = 'vinv.telemetry.firstSeen';

function hash(value: string, length: number): string {
	return crypto
		.createHash('sha256')
		.update(`${ID_SALT}:${value}`)
		.digest('hex')
		.slice(0, length);
}

/** Editors that ship the VS Code extension API. Anything else is 'other'. */
const KNOWN_EDITORS = ['code', 'cursor', 'windsurf', 'vscodium', 'positron'] as const;

/** Maps the (user-editable, unbounded) appName onto a closed set. */
function editorId(): string {
	const name = vscode.env.appName.toLowerCase();
	for (const known of KNOWN_EDITORS) {
		if (name.includes(known === 'code' ? 'visual studio code' : known)) {
			return known;
		}
	}
	return 'other';
}

let commonProps: Record<string, string | number | boolean> = {};
let distinctId = '';
let firstSeenMs = 0;
let firstEver = false;

/**
 * True when this window is the first activation this install has ever had.
 *
 * Distinct from the `.vinv-welcomed` marker in the extension's install
 * directory, which VS Code wipes on every update: this is stamped in
 * globalState, so it survives updates and answers "new user" rather than
 * "new build".
 */
export function isFirstEverInstall(): boolean {
	return firstEver;
}

/** The stable per-install id. Empty until initTelemetry has run. */
export function getDistinctId(): string {
	return distinctId;
}

/** Whole days since this install first activated. Cohort analysis without a signup date. */
export function installAgeDays(): number {
	if (!firstSeenMs) {
		return 0;
	}
	return Math.max(0, Math.floor((Date.now() - firstSeenMs) / 86_400_000));
}

/** Hours since first activation — finer than days, for the early funnel. */
export function installAgeHours(): number {
	if (!firstSeenMs) {
		return 0;
	}
	return Math.max(0, Math.floor((Date.now() - firstSeenMs) / 3_600_000));
}

/**
 * True when this activation is the first this install has ever seen. Stamps the
 * clock as a side effect, so it is true exactly once.
 */
export function markFirstSeen(context: vscode.ExtensionContext): boolean {
	const existing = context.globalState.get<number>(FIRST_SEEN_KEY);
	if (typeof existing === 'number' && existing > 0) {
		firstSeenMs = existing;
		firstEver = false;
		return false;
	}
	firstSeenMs = Date.now();
	firstEver = true;
	void context.globalState.update(FIRST_SEEN_KEY, firstSeenMs);
	return true;
}

/**
 * Computes the property bag merged into every event. Called once, at init:
 * these values do not change within a window, and recomputing them per event
 * would put `readVinvConfig`'s file read on the hot path.
 */
export function initCommonProps(context: vscode.ExtensionContext): void {
	distinctId = hash(vscode.env.machineId, 32);
	const folder = vscode.workspace.workspaceFolders?.[0];
	commonProps = {
		// A per-window id, so six open windows can be collapsed downstream
		// rather than counted as six users.
		window_id: hash(vscode.env.sessionId, 16),
		// Salted with the machine id as well as the path, so the same repo on
		// two machines hashes differently — it groups one user's projects and
		// can never identify a project.
		workspace_id: folder ? hash(`${vscode.env.machineId}:${folder.uri.fsPath}`, 16) : 'none',
		extension_version: String(context.extension.packageJSON.version ?? 'unknown'),
		vscode_version: vscode.version,
		editor: editorId(),
		app_host: allowlist(vscode.env.appHost, ['desktop', 'web', 'codespaces'] as const),
		ui_kind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
		// Whether the workspace is remote, never which remote — the name can
		// carry a hostname.
		remote: vscode.env.remoteName !== undefined && vscode.env.remoteName !== null,
		platform: process.platform,
		arch: process.arch,
		node_major: Number(process.versions.node.split('.')[0]),
		// Tells PostHog not to derive a location from the request IP. Without
		// it, "anonymous" quietly stops being true.
		$geoip_disable: true,
	};
}

/** The common bag, plus the values that genuinely do change during a window. */
export function withCommonProps(props: Record<string, unknown>): Record<string, unknown> {
	return {
		...commonProps,
		harness_id: getHarnessId(),
		install_age_days: bucketCount(installAgeDays()),
		...props,
	};
}
