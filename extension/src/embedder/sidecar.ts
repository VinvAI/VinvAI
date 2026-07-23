/**
 * Embedding sidecar lifecycle — `vinv-embedder serve --port 8776`.
 *
 * The Rust `index` binary embeds code and queries through a local
 * OpenAI-compatible gateway served by the vinv-embedder engine; no cloud key
 * is involved. This module makes "the sidecar is up" a one-call precondition
 * for every index build/query, shared by the extension and the standalone MCP
 * index server — so it is `vscode`-free (child_process + http only).
 *
 * One instance per machine: the health endpoint is probed first, and an
 * already-healthy server (started by another window, another editor, or the
 * user) is reused rather than double-spawned. The process is only stopped on
 * deactivate when THIS process started it.
 */
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { engineCommand } from '../engines/resolve';

export const EMBEDDER_PORT = 8776;
export const EMBEDDER_BASE_URL = `http://127.0.0.1:${EMBEDDER_PORT}`;
/** The OpenAI-compatible gateway URL the index binary is pointed at. */
export const EMBEDDER_GATEWAY_URL = `${EMBEDDER_BASE_URL}/v1`;

/** How long a positive health check is trusted before re-probing. */
const HEALTH_CACHE_MS = 30_000;

/**
 * Default time to wait for a freshly-spawned sidecar to answer /health. Generous
 * because the FIRST run downloads the ~500 MB embedding model inside this window
 * (and even a cached cold start is ~30s: torch/transformers import + model
 * load). The wait loop below still fails fast if the process actually exits, so
 * a large cap only adds patience for a process that is genuinely still coming
 * up — it never masks a crash.
 */
const SPAWN_HEALTH_TIMEOUT_MS = 240_000;

let ownedChild: ChildProcess | null = null;
let lastHealthyAt = 0;
let ensureInFlight: Promise<boolean> | null = null;

/** One GET /health probe. Resolves true on any 2xx within the timeout. */
export function isEmbedderHealthy(timeoutMs = 1_500): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get(`${EMBEDDER_BASE_URL}/health`, { timeout: timeoutMs }, (res) => {
			res.resume();
			resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
		});
		req.on('error', () => resolve(false));
		req.on('timeout', () => {
			req.destroy();
			resolve(false);
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ensures the sidecar is serving: reuse a healthy instance, else spawn one and
 * wait for /health. Returns false when the engines are not installed or the
 * server never became healthy within `waitMs` (first runs may need `warmup`
 * to download the model first — see embedder/warmup.ts).
 */
export function ensureEmbedderRunning(opts?: {
	override?: string;
	extensionDir?: string;
	waitMs?: number;
}): Promise<boolean> {
	if (Date.now() - lastHealthyAt < HEALTH_CACHE_MS) {
		return Promise.resolve(true);
	}
	if (ensureInFlight) {
		return ensureInFlight;
	}
	ensureInFlight = (async () => {
		try {
			if (await isEmbedderHealthy()) {
				lastHealthyAt = Date.now();
				return true;
			}
			const cmd = engineCommand('vinv-embedder', opts);
			if (!cmd) {
				return false; // engines not installed — callers surface the install step
			}
			const child = spawn(
				cmd.file,
				[...cmd.prefixArgs, 'serve', '--port', String(EMBEDDER_PORT)],
				{ stdio: 'ignore', windowsHide: true },
			);
			child.on('error', () => {
				if (ownedChild === child) {
					ownedChild = null;
				}
			});
			child.on('exit', () => {
				if (ownedChild === child) {
					ownedChild = null;
				}
			});
			ownedChild = child;
			const deadline = Date.now() + (opts?.waitMs ?? SPAWN_HEALTH_TIMEOUT_MS);
			while (Date.now() < deadline) {
				if (await isEmbedderHealthy()) {
					lastHealthyAt = Date.now();
					return true;
				}
				if (ownedChild === null) {
					// The spawn died (port race with another window, missing model, …).
					// One more probe: if someone else won the port race, that's success.
					if (await isEmbedderHealthy()) {
						lastHealthyAt = Date.now();
						return true;
					}
					return false;
				}
				await sleep(500);
			}
			return false;
		} finally {
			ensureInFlight = null;
		}
	})();
	return ensureInFlight;
}

/** Stops the sidecar — but only when this process was the one that spawned it. */
export function stopEmbedderIfStarted(): void {
	if (ownedChild) {
		try {
			ownedChild.kill();
		} catch {
			// Already gone.
		}
		ownedChild = null;
	}
	lastHealthyAt = 0;
}
