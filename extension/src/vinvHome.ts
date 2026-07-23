/**
 * Shared on-disk state under ~/.vinv — the contract the extension shares with
 * the Vinv engine CLIs and the standalone MCP stdio servers.
 *
 * This module is deliberately free of any `vscode` dependency so the MCP
 * servers (out/mcp/*.js, launched directly by Cursor/Claude/Codex) can import
 * it too. It only touches the filesystem and os.
 *
 * Files:
 *   config.json  — the user's Vinv configuration (see VinvConfig below)
 *   bin/         — the downloaded prebuilt `index` binary (see engines/)
 *   engines/     — the default clone of the open-source engines monorepo
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Root of the shared state dir. Honors VINV_HOME so the extension and the
 * engine CLIs agree on where shared state lives.
 */
export function vinvHomeDir(): string {
	const override = process.env.VINV_HOME?.trim();
	return override && override.length > 0 ? override : path.join(os.homedir(), '.vinv');
}

/** Shared directory for downloaded prebuilt binaries (currently just `index`). */
export function binaryDirPath(): string {
	return path.join(vinvHomeDir(), 'bin');
}

/**
 * Platform-correct on-disk filename for an engine executable. Windows cannot
 * spawn an extension-less PE image — `CreateProcess`/libuv append `.exe` to a
 * bare path and a file literally named `handbook` fails with ENOENT — so on
 * win32 every engine lands as `<name>.exe`. Elsewhere the bare name is the
 * executable.
 */
export function executableFileName(name: string): string {
	return process.platform === 'win32' ? `${name}.exe` : name;
}

/** Absolute path of a binary in the shared ~/.vinv/bin dir. */
export function binaryFilePath(name: string): string {
	if (!name || path.basename(name) !== name) {
		throw new Error(`Invalid binary name: ${name}`);
	}
	return path.join(binaryDirPath(), executableFileName(name));
}

export const configFilePath = (): string => path.join(vinvHomeDir(), 'config.json');

function readJson(file: string): Record<string, unknown> {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Writes JSON atomically with owner-only permissions (0600). */
function writeJsonSecure(file: string, obj: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// chmod is a no-op flag on Windows; ignore.
	}
}

/**
 * The user's Vinv configuration, stored in ~/.vinv/config.json (owner-only)
 * rather than in VS Code settings — so the config travels with the CLIs + MCP
 * servers, which read the same dir. Managed through the "Configure Vinv
 * Project" panel.
 */
export interface VinvConfig {
	/** Selected coding-harness id (e.g. 'claude-code') — the agent CLI Vinv dispatches to. */
	harness?: string;
	/** Path of the engines monorepo checkout; overrides auto-detection. */
	enginesPath?: string;
	/** Explicit path of the Rust `index` binary; overrides resolution. */
	indexBinaryPath?: string;
	autoDiscover?: boolean;
	mcpEnabled?: boolean;
	/** When true, service failures dispatch a fix episode to the harness without asking. */
	autoEpisodes?: boolean;
	/** When true (default), Auto-Pilot drives the workspace to green on its own
	 * after discovery: set up every service, run under tracing, fix on failure. */
	autoPilot?: boolean;
	/** When true (default), episodes generate agent-invisible acceptance tests
	 * as an additional objective oracle (fail-to-pass gated). */
	acceptanceTests?: boolean;
	/** QnA escalation channel: 'off' (default) | 'shadow' (log actions) | 'on' (execute). */
	qnaEscalation?: string;
}

export function readVinvConfig(): VinvConfig {
	return readJson(configFilePath()) as VinvConfig;
}

/** Merges a partial update into ~/.vinv/config.json (owner-only). */
export function updateVinvConfig(patch: Partial<VinvConfig>): void {
	writeJsonSecure(configFilePath(), { ...readVinvConfig(), ...patch });
}
