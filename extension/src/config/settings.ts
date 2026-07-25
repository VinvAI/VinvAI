import * as path from 'path';
import { readVinvConfig, updateVinvConfig } from '../vinvHome';
import { resolveIndexBinary } from '../engines/resolve';
import { EMBEDDER_GATEWAY_URL } from '../embedder/sidecar';

/**
 * Vinv's LLM work (handbook, bring-up, QnA, episodes) always runs through the
 * user's own coding-agent CLI — the harness. The one AI choice that remains is
 * WHICH harness; embeddings come from the local vinv-embedder sidecar, so no
 * provider keys or model pickers exist.
 */

/** The remembered coding-harness id (see HARNESSES); defaults to claude-code. */
export function getHarnessId(): string {
	return (readVinvConfig().harness ?? 'claude-code').trim() || 'claude-code';
}

/**
 * True when the user has explicitly chosen a harness (as opposed to falling back
 * to the claude-code default). Lets callers ask once, then stay silent — see
 * ensureHarnessChosen.
 */
export function hasChosenHarness(): boolean {
	const h = readVinvConfig().harness;
	return typeof h === 'string' && h.trim().length > 0;
}

/**
 * Persists the remembered harness choice — the picker's last selection, which
 * seeds the next picker and drives background (non-click) dispatches.
 */
export function setHarnessId(id: string): void {
	updateVinvConfig({ harness: id });
}

/** True when discovery should run automatically on opening/refreshing a workspace. */
export function isAutoDiscoverEnabled(): boolean {
	return readVinvConfig().autoDiscover ?? true;
}

/** Persists the auto-discover toggle. */
export async function setAutoDiscoverEnabled(enabled: boolean): Promise<void> {
	updateVinvConfig({ autoDiscover: enabled });
}

/** True when Vinv should auto-register its MCP servers into detected agent tools. */
export function isMcpEnabled(): boolean {
	return readVinvConfig().mcpEnabled ?? true;
}

/** Allowed values for the QnA escalation (tool-capable retrial) channel. */
export const QNA_ESCALATION_MODES = ['off', 'shadow', 'on'] as const;
export type QnaEscalationMode = (typeof QNA_ESCALATION_MODES)[number];

/**
 * The QnA escalation channel: 'off' (default) keeps today's verdict protocol
 * untouched; 'shadow' asks the model for typed evidence actions and LOGS them
 * without executing (the counterfactual record the eval plan needs); 'on'
 * executes them read-only between retrial attempts. Default-off by verdict of
 * the design debate: accuracy claims for the loop are not yet provable at the
 * available benchmark size, so it ships as measurable infrastructure, not as
 * asserted improvement.
 */
export function qnaEscalationMode(): QnaEscalationMode {
	const v = (readVinvConfig().qnaEscalation ?? 'off').trim().toLowerCase();
	return (QNA_ESCALATION_MODES as readonly string[]).includes(v)
		? (v as QnaEscalationMode)
		: 'off';
}

/**
 * True when service failures should dispatch a fix episode to the coding
 * harness automatically. Default ON — the closed loop is the product; a user
 * who wants confirmation before each dispatch turns it off in Configure.
 */
export function isAutoEpisodesEnabled(): boolean {
	return readVinvConfig().autoEpisodes ?? true;
}

/**
 * True when episodes should generate agent-invisible acceptance tests as an
 * additional (and, for general tasks, the only) objective oracle. Default ON:
 * the fail-to-pass gate is what turns "the service boots" into "the fix does
 * what the issue asked" — a user who finds the extra generation dispatch too
 * costly turns it off in Configure.
 */
export function isAcceptanceTestsEnabled(): boolean {
	return readVinvConfig().acceptanceTests ?? true;
}

/** Persists the acceptance-tests toggle. */
export async function setAcceptanceTestsEnabled(enabled: boolean): Promise<void> {
	updateVinvConfig({ acceptanceTests: enabled });
}

/** Persists the auto-episodes toggle. */
export async function setAutoEpisodesEnabled(enabled: boolean): Promise<void> {
	updateVinvConfig({ autoEpisodes: enabled });
}

/**
 * True when Auto-Pilot should start on its own once discovery completes and
 * services are listed: set up every service, run each under tracing, and
 * dispatch fixes when steps fail. Default ON — hands-off is the product; the
 * manual per-service ladder stays available when this is off.
 */
export function isAutoPilotEnabled(): boolean {
	return readVinvConfig().autoPilot ?? true;
}

/**
 * Auto-Pilot's effort budgets, merged over the engine defaults. These bound how
 * hard an unattended run tries before handing the problem back: retries per
 * service setup, fix episodes per distinct failure signature, and an absolute
 * per-service cap that catches failures whose signature shifts every attempt.
 */
export function getAutoPilotBudgets(): {
	setupAttempts: number;
	fixEpisodesPerSignature: number;
	totalFixEpisodes: number;
} {
	const saved = readVinvConfig().autoPilotBudgets ?? {};
	const clamp = (v: unknown, fallback: number): number =>
		typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
	return {
		setupAttempts: clamp(saved.setupAttempts, 3),
		fixEpisodesPerSignature: clamp(saved.fixEpisodesPerSignature, 2),
		totalFixEpisodes: clamp(saved.totalFixEpisodes, 6),
	};
}

/** Persists explicit budget values from the Configure form (clamped on read). */
export function setAutoPilotBudgets(budgets: {
	setupAttempts: number;
	fixEpisodesPerSignature: number;
	totalFixEpisodes: number;
}): void {
	const safe = (v: number, lo: number, hi: number, fallback: number): number =>
		Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : fallback;
	updateVinvConfig({
		autoPilotBudgets: {
			setupAttempts: safe(budgets.setupAttempts, 1, 20, 3),
			fixEpisodesPerSignature: safe(budgets.fixEpisodesPerSignature, 1, 20, 2),
			totalFixEpisodes: safe(budgets.totalFixEpisodes, 1, 50, 6),
		},
	});
}

/**
 * Raises the budgets by `extra` episodes (and one more setup attempt), persisting
 * the new level. Called when the user tops up an exhausted run, so the choice
 * carries into later runs instead of prompting for the same service every time.
 */
export function extendAutoPilotBudgets(extra: number): void {
	const cur = getAutoPilotBudgets();
	updateVinvConfig({
		autoPilotBudgets: {
			setupAttempts: cur.setupAttempts + 1,
			fixEpisodesPerSignature: cur.fixEpisodesPerSignature + extra,
			totalFixEpisodes: cur.totalFixEpisodes + extra,
		},
	});
}

/** Persists the Auto-Pilot toggle. */
export async function setAutoPilotEnabled(enabled: boolean): Promise<void> {
	updateVinvConfig({ autoPilot: enabled });
}

/** Persists the MCP auto-register toggle. */
export async function setMcpEnabled(enabled: boolean): Promise<void> {
	updateVinvConfig({ mcpEnabled: enabled });
}

/**
 * Environment for the engines. Embeddings route to the local vinv-embedder
 * sidecar's OpenAI-compatible gateway — the index binary defaults to it and
 * needs no key. No cloud endpoints, no provider credentials.
 */
export function getIndexEnv(binDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
		INDEX_GATEWAY_URL: EMBEDDER_GATEWAY_URL,
	};

	// The Python engines (handbook, bringup, identification) shell out to the
	// index binary; point them at the resolved copy so PATH probing for the
	// generic name `index` never picks up an unrelated executable.
	const indexBin = resolveIndexBinary();
	if (indexBin) {
		env.VINV_INDEX_BINARY = indexBin;
	}

	return env;
}

/**
 * Environment for the handbook engine: the shared engine env plus the project
 * root the rendered instructions cite.
 */
export function getHandbookEnv(binDir: string, workspaceRoot: string): NodeJS.ProcessEnv {
	const env = getIndexEnv(binDir);
	env.VINV_ENGINE_PROJECT_ROOT = workspaceRoot;
	return env;
}

/**
 * Environment for the bringup engine: same as handbook, plus a per-workspace
 * captures dir. (Bringup resolves tracelens itself from the engines venv —
 * the runbooks it records always use the source install.)
 */
export function getBringupEnv(binDir: string, workspaceRoot: string): NodeJS.ProcessEnv {
	const env = getHandbookEnv(binDir, workspaceRoot);
	env.VINV_CAPTURES_DIR = path.join(workspaceRoot, '.vinv', 'captures');
	return env;
}
