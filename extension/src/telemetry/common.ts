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
import { getHarnessId, hasChosenHarness } from '../config/settings';
import { allowlist, bucketCount, messageDigest } from './sanitize';

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

/**
 * Editors that ship the VS Code extension API, as (id, appName substring) pairs.
 *
 * ORDER MATTERS, and the generic `visual studio code` match is deliberately
 * LAST. Forks routinely keep the upstream name somewhere in `appName`, so a
 * first-match-wins list that leads with the generic pattern files every one of
 * them as plain VS Code.
 *
 * `code - oss` needs its own row for the opposite reason: the open-source build
 * of VS Code does NOT contain the string `visual studio code`, so it fell
 * through to 'other' — the bucket meant for editors we have never heard of.
 */
const EDITOR_MATCHERS: ReadonlyArray<readonly [id: string, needle: string]> = [
	['cursor', 'cursor'],
	['windsurf', 'windsurf'],
	['vscodium', 'vscodium'],
	['positron', 'positron'],
	['trae', 'trae'],
	['kiro', 'kiro'],
	['antigravity', 'antigravity'],
	['void', 'void'],
	['firebase_studio', 'firebase studio'],
	['theia', 'theia'],
	['code_server', 'code-server'],
	['openvscode', 'openvscode'],
	['code_oss', 'code - oss'],
	['code', 'visual studio code'],
];

/** Maps the (user-editable, unbounded) appName onto a closed set. */
function editorId(): string {
	const name = vscode.env.appName.toLowerCase();
	for (const [id, needle] of EDITOR_MATCHERS) {
		if (name.includes(needle)) {
			return id;
		}
	}
	return 'other';
}

/**
 * A one-way fingerprint of the raw `appName`, so 'other' stays GROUPABLE.
 *
 * The closed set above is what keeps cardinality bounded, but it has a cost
 * that only shows up in the data: every unrecognised editor collapses into one
 * 'other' bucket, and there is then no way to tell whether that bucket is one
 * fork or five — or which one to add to the list next. The digest restores that
 * without sending the string: identical editors share a digest, and the name it
 * was computed from never leaves the machine.
 */
function editorDigest(): string {
	return messageDigest(vscode.env.appName);
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
		editor_digest: editorDigest(),
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

/**
 * The common bag, plus the values that genuinely do change during a window.
 *
 * `harness_chosen` travels beside `harness_id` because `getHarnessId` FALLS BACK
 * to claude-code when nothing is configured (see config/settings.ts). Without
 * the flag the two states are one value in the data: a user who picked
 * claude-code and a user who has picked nothing at all report identically, so
 * every rate broken down by harness silently folds the second group into the
 * first — and the second group is the one that never gets past the first-run
 * picker.
 */
export function withCommonProps(props: Record<string, unknown>): Record<string, unknown> {
	return {
		...commonProps,
		harness_id: getHarnessId(),
		harness_chosen: hasChosenHarness(),
		install_age_days: bucketCount(installAgeDays()),
		...props,
	};
}
