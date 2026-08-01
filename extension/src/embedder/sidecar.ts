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
import { spawn, execFile, type ChildProcess } from 'child_process';
import { engineCommand } from '../engines/resolve';

export const EMBEDDER_PORT = 8776;
export const EMBEDDER_BASE_URL = `http://127.0.0.1:${EMBEDDER_PORT}`;
/** The OpenAI-compatible gateway URL the index binary is pointed at. */
export const EMBEDDER_GATEWAY_URL = `${EMBEDDER_BASE_URL}/v1`;

/** How long a positive health check is trusted before re-probing. */
const HEALTH_CACHE_MS = 30_000;

/**
 * Default time to wait for a sidecar to answer /health with a 2xx. Generous
 * because the FIRST run downloads the ~500 MB embedding model inside this
 * window, and because a plain cached cold start is far slower than it sounds:
 * measured on a CPU-only Windows box, torch → transformers →
 * sentence_transformers import plus the model load runs past five minutes and
 * peaks over 1 GB RSS. The old 4-minute cap expired mid-load and reported
 * failure for a sidecar that was working correctly — then left it running as
 * an orphan nothing tracked. The wait loop below still fails fast if the
 * process actually exits, so a large cap only adds patience for a process that
 * is genuinely still coming up — it never masks a crash.
 */
const SPAWN_HEALTH_TIMEOUT_MS = 600_000;

/**
 * Narration channel for a caller that owns a progress surface (the Ask Vinv
 * thinking line, an index-build notification). Called with one human-readable
 * line whenever the sidecar's state changes or the wait ticks on.
 */
export type EmbedderStatus = (label: string) => void;

/**
 * Everyone currently listening to the wait, not just the caller that won the
 * `ensureInFlight` race.
 *
 * The panel warms the sidecar on open (silently) and then narrates the first
 * question — with a single stored callback the silent warm would win, and the
 * question would sit through the whole multi-minute load with nothing to show
 * for it. Listeners are registered for the duration of one call and always
 * removed, so a closed panel's callback cannot outlive it.
 */
const statusListeners = new Set<EmbedderStatus>();

function announce(label: string): void {
	for (const listener of statusListeners) {
		try {
			listener(label);
		} catch {
			// A listener that throws (disposed webview) must not abort the wait.
		}
	}
}

let ownedChild: ChildProcess | null = null;
let lastHealthyAt = 0;
let ensureInFlight: Promise<boolean> | null = null;
let lastStderr = '';

/** Tail of the last spawned sidecar's stderr — the only clue when it wedges. */
export function lastEmbedderStderr(): string {
	return lastStderr;
}

/**
 * PIDs of `vinv-embedder` processes already on this machine, ours or not.
 *
 * The health probe alone cannot tell "nothing is running" from "something is
 * running but has not bound the port yet": both look like a refused
 * connection. Spawning on that ambiguity is how a machine ends up with a pile
 * of 4 MB processes owned by extension hosts that exited long ago — each
 * failed attempt leaves one behind and nothing ever reaps it.
 */
function findEmbedderPids(): Promise<number[]> {
	return new Promise((resolve) => {
		const file: string = process.platform === 'win32' ? 'tasklist' : 'pgrep';
		const args: string[] =
			process.platform === 'win32'
				? ['/FI', 'IMAGENAME eq vinv-embedder.exe', '/FO', 'CSV', '/NH']
				: ['-f', 'vinv-embedder'];
		execFile(file, args, { timeout: 5_000, windowsHide: true }, (err, stdout) => {
			if (err || !stdout) {
				resolve([]); // No lister, no matches, or a filter that matched nothing.
				return;
			}
			const pids: number[] = [];
			for (const line of stdout.split('\n')) {
				// tasklist CSV: "image","pid",… — elsewhere pgrep prints bare pids.
				const found = process.platform === 'win32' ? /"[^"]*","(\d+)"/.exec(line) : /^(\d+)$/.exec(line.trim());
				if (found) {
					pids.push(Number(found[1]));
				}
			}
			resolve(pids.filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid));
		});
	});
}

/**
 * True when something owns the port but is not serving yet — the engine
 * answering 503 `loading` while the model loads (it binds before loading, see
 * embedder/cli.py). A refused connection cannot tell "coming up" from "nothing
 * there"; any reply at all can.
 */
export function isEmbedderStarting(timeoutMs = 1_500): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get(`${EMBEDDER_BASE_URL}/health`, { timeout: timeoutMs }, (res) => {
			res.resume();
			resolve(true);
		});
		req.on('error', () => resolve(false));
		req.on('timeout', () => {
			req.destroy();
			resolve(false);
		});
	});
}

/**
 * Polls /health until it answers or the deadline passes, narrating the wait to
 * `onStatus` roughly once a second.
 *
 * The narration is not decoration: a cached cold start runs for minutes (see
 * SPAWN_HEALTH_TIMEOUT_MS), and a caller that shows nothing for that long is
 * indistinguishable from one that has hung. The elapsed seconds travel with the
 * label so the reader can see it is progressing, not stuck.
 */
async function waitForHealth(deadline: number): Promise<boolean> {
	const startedAt = Date.now();
	let announcedAt = 0;
	while (Date.now() < deadline) {
		if (await isEmbedderHealthy()) {
			lastHealthyAt = Date.now();
			return true;
		}
		const elapsed = Math.round((Date.now() - startedAt) / 1000);
		if (Date.now() - announcedAt >= 1_000) {
			announcedAt = Date.now();
			announce(`loading the embedding model — first run takes a few minutes (${elapsed}s)`);
		}
		await sleep(500);
	}
	return false;
}

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
	/** Narrates the wait (see EmbedderStatus). Omitted by silent callers. */
	onStatus?: EmbedderStatus;
}): Promise<boolean> {
	if (Date.now() - lastHealthyAt < HEALTH_CACHE_MS) {
		return Promise.resolve(true);
	}
	// Registered around the WHOLE call — including the branch that joins an
	// already-in-flight ensure — so a caller that arrives mid-load still hears
	// the rest of the wait instead of blocking silently.
	if (opts?.onStatus) {
		statusListeners.add(opts.onStatus);
	}
	const unlisten = () => {
		if (opts?.onStatus) {
			statusListeners.delete(opts.onStatus);
		}
	};
	if (ensureInFlight) {
		return ensureInFlight.finally(unlisten);
	}
	ensureInFlight = (async () => {
		try {
			if (await isEmbedderHealthy()) {
				lastHealthyAt = Date.now();
				return true;
			}
			const deadline = Date.now() + (opts?.waitMs ?? SPAWN_HEALTH_TIMEOUT_MS);

			// Something is already coming up: wait on it rather than stacking a
			// second `serve`. A duplicate cannot make the first finish loading any
			// sooner — it just loads a second copy of the model and slows both
			// down. Two signals because they cover different engine versions: a
			// port that answers at all is the current engine reporting `loading`,
			// and a live process is the fallback for an older engine that binds
			// only once the model is already in memory.
			//
			// Deliberately never kills what it finds. A sidecar that has not
			// answered yet is far more likely to be mid-load (minutes, on CPU)
			// than wedged, and killing it would restart that load from zero.
			if ((await isEmbedderStarting()) || (await findEmbedderPids()).length > 0) {
				announce('the embedding model is already loading — waiting for it');
				return waitForHealth(deadline);
			}

			const cmd = engineCommand('vinv-embedder', opts);
			if (!cmd) {
				return false; // engines not installed — callers surface the install step
			}
			announce('starting the local embedding sidecar…');
			const child = spawn(
				cmd.file,
				[...cmd.prefixArgs, 'serve', '--port', String(EMBEDDER_PORT)],
				{ stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
			);
			// A sidecar that dies or hangs with stdio discarded is undiagnosable —
			// keep the tail so callers can show WHY rather than just "not ready".
			lastStderr = '';
			child.stderr?.on('data', (chunk: Buffer) => {
				lastStderr = `${lastStderr}${chunk.toString()}`.slice(-4096);
			});
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
			const spawnedAt = Date.now();
			let announcedAt = 0;
			while (Date.now() < deadline) {
				if (await isEmbedderHealthy()) {
					lastHealthyAt = Date.now();
					return true;
				}
				if (Date.now() - announcedAt >= 1_000) {
					announcedAt = Date.now();
					announce(
						'loading the embedding model — first run takes a few minutes ' +
							`(${Math.round((Date.now() - spawnedAt) / 1000)}s)`,
					);
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
			// Our own spawn used the whole window without serving. Kill it here
			// rather than leaving it for deactivate: a host that crashes or is
			// force-closed never runs deactivate, and that is exactly how these
			// accumulate across sessions.
			stopEmbedderIfStarted();
			return false;
		} finally {
			ensureInFlight = null;
		}
	})();
	// The stored promise stays raw so joiners can attach their OWN unlisten;
	// this caller's listener is dropped when its own await settles.
	return ensureInFlight.finally(unlisten);
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
