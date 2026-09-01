/**
 * Engines-root resolution — where the open-source Vinv engines live on this
 * machine and how their executables are found.
 *
 * The engines (tracelens, identification, handbook, bringup, goal,
 * vinv-embedder — Python, run from source via a uv workspace) and the Rust
 * `index` binary ship in the Vinv monorepo, not inside the extension. This
 * module answers "where is that checkout" and "where is engine X" for both the
 * extension and the standalone MCP stdio servers, so it is deliberately free
 * of any `vscode` dependency (filesystem + os only).
 *
 * Resolution order for the engines root:
 *   1. an explicit override (the `vinv.enginesPath` VS Code setting, passed in
 *      by the extension; or `enginesPath` in ~/.vinv/config.json, which the
 *      MCP servers can read directly),
 *   2. ~/.vinv/engines — a clone of the monorepo made by "Install Vinv engines",
 *   3. dev-checkout detection — the extension living inside the monorepo
 *      itself, in which case `<extension>/..` IS the engines root. This is the
 *      primary path for both development and users who cloned the repo.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { executableFileName, readVinvConfig, vinvHomeDir } from '../vinvHome';

/**
 * The public monorepo — the single source everything runs from. Used by the
 * "Install Vinv engines" flow (git clone); there are no other distribution
 * channels: no downloads, no releases, no binaries.
 */
// Current (pre-open-source) home of the engines monorepo. Private for now, so
// the install clone requires the user to be authenticated to VinvAI. Switch to
// the public repo (https://github.com/VinvAI/VinvAI) at open-source launch.
export const REPO_URL = 'https://github.com/VinvAI/VinvAI';

// Branch to clone from the public repo. The open-source release lives on the
// default branch, `main`.
export const REPO_BRANCH = 'main';

/** True when `dir` looks like a checkout of the Vinv monorepo. */
function looksLikeEnginesRoot(dir: string): boolean {
	try {
		return (
			fs.existsSync(path.join(dir, 'tracelens', 'pyproject.toml')) ||
			fs.existsSync(path.join(dir, 'pyproject.toml')) && fs.existsSync(path.join(dir, 'index'))
		);
	} catch {
		return false;
	}
}

/** The default machine-wide engines clone location: ~/.vinv/engines. */
export function defaultEnginesCloneDir(): string {
	return path.join(vinvHomeDir(), 'engines');
}

/**
 * Resolves the engines root, or null when none is found (→ the UI offers
 * "Install Vinv engines").
 *
 * `override` is an explicit path (e.g. the vinv.enginesPath VS Code setting);
 * `extensionDir` enables dev-checkout detection and is the extension's install
 * dir (context.extensionPath in the extension, `__dirname/../..` in the
 * bundled MCP servers).
 */
export function enginesRootDir(opts?: {
	override?: string;
	extensionDir?: string;
}): string | null {
	const override = (opts?.override ?? readVinvConfig().enginesPath ?? '').trim();
	if (override) {
		const resolved = override.startsWith('~')
			? path.join(os.homedir(), override.slice(1))
			: override;
		if (fs.existsSync(resolved)) {
			return resolved;
		}
	}
	const clone = defaultEnginesCloneDir();
	if (looksLikeEnginesRoot(clone)) {
		return clone;
	}
	if (opts?.extensionDir) {
		const parent = path.dirname(path.resolve(opts.extensionDir));
		if (looksLikeEnginesRoot(parent)) {
			return parent;
		}
	}
	return null;
}

/** The uv-workspace venv's executables dir for an engines root. */
export function enginesVenvBinDir(enginesRoot: string): string {
	return path.join(enginesRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
}

/**
 * Stable absolute path of a Python engine's console script inside the uv
 * workspace venv (created by `uv sync` at the monorepo root). This path is
 * what bring-up bakes into recorded start commands, so it must not move
 * between sessions — prefer it over `uv run` whenever it exists.
 */
export function pythonEnginePath(enginesRoot: string, name: string): string {
	return path.join(enginesVenvBinDir(enginesRoot), executableFileName(name));
}

/** True when `uv sync` has been run for the engines root (venv scripts exist). */
export function enginesSynced(enginesRoot: string): boolean {
	return fs.existsSync(pythonEnginePath(enginesRoot, 'tracelens'));
}

/**
 * Marker every successful sync/build terminal touches as its LAST step, so its
 * mtime is "the moment the engines were last materialised for the commit on
 * disk". Untracked, so `git checkout --force` leaves it alone.
 *
 * It exists because the venv could not answer that question. `uv sync` only
 * rewrites a console script when the package's entry points actually change, so
 * a sync that legitimately had nothing to do left tracelens older than the
 * `.git/HEAD` every checkout rewrites — an "environment built for a different
 * commit" verdict that no amount of re-syncing could clear, on engines that were
 * in fact correct. A stamp the terminal writes on success says what happened
 * rather than inferring it from a file uv had no reason to touch.
 */
export function engineSyncStampPath(enginesRoot: string): string {
	return path.join(enginesRoot, '.vinv-engines-synced');
}

/**
 * Marker an engines terminal writes when it has FINISHED — whether the sync and
 * build succeeded, failed, or were interrupted. Distinct from the sync stamp
 * above, which only lands on success: this one answers "is a build still running
 * in that terminal?", which is what anything waiting on the engines needs, and
 * an answer of "it finished badly" is still an answer.
 *
 * Deleted immediately before each run, so a previous run's marker can never be
 * mistaken for this one's.
 */
export function engineRunDonePath(enginesRoot: string): string {
	return path.join(enginesRoot, '.vinv-engines-run-done');
}

/** Scans PATH (plus uv's default install dirs) for an executable. */
function findOnPath(name: string, extraDirs: string[] = []): string | null {
	const exe = executableFileName(name);
	const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs];
	for (const dir of dirs) {
		if (!dir) {
			continue;
		}
		const candidate = path.join(dir, exe);
		try {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				return candidate;
			}
		} catch {
			// Unreadable PATH entry — skip.
		}
	}
	return null;
}

/** Absolute path of the `uv` CLI, or null when it is not installed. */
export function uvPath(): string | null {
	return findOnPath('uv', [
		path.join(os.homedir(), '.local', 'bin'),
		path.join(os.homedir(), '.cargo', 'bin'),
	]);
}

/**
 * Absolute path of `git`, or null when it is not installed.
 *
 * Not a prerequisite the installer offers to fix (unlike uv and Rust, git has no
 * safe one-liner installer), but it is required for the clone — so a machine
 * without it fails the install in a way that looks like a network problem.
 * Worth being able to count.
 */
export function gitPath(): string | null {
	return findOnPath('git');
}

/** Absolute path of the `cargo` CLI, or null when Rust is not installed. */
export function cargoPath(): string | null {
	return findOnPath('cargo', [path.join(os.homedir(), '.cargo', 'bin')]);
}

/**
 * A spawnable command for a Python engine: the venv console script when
 * `uv sync` has produced one, else `uv run --project <root> <name>` as the
 * fallback. Null when neither is possible (no engines root, or no uv).
 */
export function engineCommand(
	name: string,
	opts?: { override?: string; extensionDir?: string },
): { file: string; prefixArgs: string[] } | null {
	const root = enginesRootDir(opts);
	if (root) {
		const script = pythonEnginePath(root, name);
		if (fs.existsSync(script)) {
			return { file: script, prefixArgs: [] };
		}
		const uv = uvPath();
		if (uv) {
			return { file: uv, prefixArgs: ['run', '--project', root, name] };
		}
	}
	// PATH fallback: `pip install vinv` / `uv tool install vinv` put the engine
	// console scripts on PATH. This is how the standalone MCP server (paired
	// with the PyPI package) finds them — no monorepo checkout required.
	const onPath = findOnPath(name);
	if (onPath) {
		return { file: onPath, prefixArgs: [] };
	}
	return null;
}

/**
 * Resolves the Rust `index` binary — always built from source:
 *   1. explicit config override (`indexBinaryPath` in ~/.vinv/config.json),
 *   2. the engines checkout's own release build (`cargo build --release`),
 *   3. PATH.
 * Null when it has not been built yet (→ the UI offers to run cargo).
 */
export function resolveIndexBinary(opts?: {
	override?: string;
	extensionDir?: string;
}): string | null {
	const cfg = readVinvConfig();
	const configured = (cfg.indexBinaryPath ?? '').trim();
	if (configured && fs.existsSync(configured)) {
		return configured;
	}
	const root = enginesRootDir(opts);
	if (root) {
		const built = path.join(root, 'index', 'target', 'release', executableFileName('index'));
		if (fs.existsSync(built)) {
			return built;
		}
	}
	return findOnPath('index');
}
