/**
 * Extension-side engines installation: the one-click "Install Vinv engines"
 * flow and the first-run embedder warmup offer.
 *
 * Everything runs from the GitHub checkout — there are no downloads and no
 * prebuilt artifacts. Installing is `git clone <monorepo> ~/.vinv/engines`,
 * `uv sync` (Python engines), and `cargo build --release` (the Rust index),
 * executed in a visible terminal so the user sees exactly what happens on
 * their machine.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import {
	REPO_URL,
	REPO_BRANCH,
	cargoPath,
	defaultEnginesCloneDir,
	engineCommand,
	enginesRootDir,
	enginesSynced,
	resolveIndexBinary,
	uvPath,
} from './resolve';
import { ensureEmbedderRunning, isEmbedderHealthy } from '../embedder/sidecar';
import { ENGINE_REF } from './pinned';

/** Official, non-interactive installer command for a missing prerequisite. */
function installerCommand(tool: 'uv' | 'rust'): string {
	const isWin = process.platform === 'win32';
	if (tool === 'uv') {
		return isWin
			? 'powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"'
			: 'curl -LsSf https://astral.sh/uv/install.sh | sh';
	}
	// rustup — installs cargo + the default toolchain.
	return isWin
		? '$p = "$env:TEMP\\rustup-init.exe"; Invoke-WebRequest -UseBasicParsing https://win.rustup.rs/x86_64 -OutFile $p; & $p -y'
		: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y";
}

/**
 * Installs a missing prerequisite by running its official installer in a
 * terminal. The installer edits PATH persistently but the current terminals
 * won't see it until restarted, so the caller returns false and the user re-runs
 * "Install Vinv Engines" once it finishes (by then withPathPrefix also covers
 * ~/.cargo/bin and uv's dir).
 */
function installPrerequisite(tool: 'uv' | 'rust', label: string): void {
	const isWin = process.platform === 'win32';
	const terminal = vscode.window.createTerminal(
		isWin ? { name: `Install ${label}`, shellPath: 'powershell.exe' } : { name: `Install ${label}` },
	);
	terminal.show();
	terminal.sendText(installerCommand(tool));
	void vscode.window.showInformationMessage(
		`Vinv: installing ${label} in the terminal. When it finishes, run "Vinv: Install Engines" again.`,
	);
}

/**
 * Extension-side wrapper for the sidecar precondition: ensure vinv-embedder is
 * serving (reusing any healthy instance) with this window's engines-root
 * resolution. Call before any index build or query.
 */
export function ensureEmbedder(context: vscode.ExtensionContext): Promise<boolean> {
	return ensureEmbedderRunning({
		override: enginesPathSetting(),
		extensionDir: context.extensionPath,
	});
}

/** The extension's engines-root override: the vinv.enginesPath setting. */
export function enginesPathSetting(): string | undefined {
	const v = vscode.workspace.getConfiguration('vinv').get<string>('enginesPath');
	return v && v.trim().length > 0 ? v.trim() : undefined;
}

/** Engines root as the extension sees it (setting → config → clone → dev checkout). */
export function resolveEnginesRoot(context: vscode.ExtensionContext): string | null {
	return enginesRootDir({
		override: enginesPathSetting(),
		extensionDir: context.extensionPath,
	});
}

/** True when the engines are installed AND `uv sync` has produced the venv. */
export function enginesReady(context: vscode.ExtensionContext): boolean {
	const root = resolveEnginesRoot(context);
	return root !== null && enginesSynced(root);
}

/**
 * Ensures uv and cargo are present, installing whichever is missing via its
 * official installer. Returns true only when both are already available; when a
 * tool had to be installed it returns false so the caller stops and the user
 * re-runs the install once the new tool is on PATH.
 */
async function ensurePrerequisites(): Promise<boolean> {
	if (!uvPath()) {
		installPrerequisite('uv', 'uv');
		return false;
	}
	if (!cargoPath()) {
		installPrerequisite('rust', 'Rust');
		return false;
	}
	return true;
}

/** The command that builds the Rust index inside an engines checkout. */
export function cargoBuildCommand(root: string): string {
	return `cargo build --release --manifest-path "${root}/index/Cargo.toml"`;
}

/**
 * Joins shell steps so each runs only if the previous one succeeded, in the
 * syntax of `shell`.
 *
 * Windows VS Code terminals default to Windows PowerShell 5.1, where `&&` is a
 * parse error ("The token '&&' is not a valid statement separator") — so we
 * cannot use one command string across platforms. `installEngines` launches the
 * terminal with an explicit shell (PowerShell on Windows) so the syntax emitted
 * here always matches. PowerShell chains with `; if ($?) { … }`, which short-
 * circuits on `$?` (the last command's success) exactly like POSIX `&&`.
 */
function chainSteps(steps: string[], shell: 'powershell' | 'posix'): string {
	if (shell === 'posix') {
		return steps.join(' && ');
	}
	return steps.reduceRight((rest, step) => (rest ? `${step}; if ($?) { ${rest} }` : step), '');
}

/**
 * Prepends `dirs` to PATH ahead of `command`, in `shell` syntax.
 *
 * The terminal we spawn does not inherit rustup's (or uv's) PATH edits — a
 * freshly installed toolchain often isn't on the shell's PATH until it is
 * restarted. `ensurePrerequisites` still finds uv/cargo because cargoPath()/
 * uvPath() also probe their default install dirs (~/.cargo/bin, ~/.local/bin),
 * so the install proceeds and then a bare `cargo`/`uv` in the terminal fails
 * with "command not found". Putting those dirs on PATH first makes the bare
 * invocations — and cargo's toolchain neighbours (rustc, the linker) — resolve.
 */
function withPathPrefix(dirs: string[], command: string, shell: 'powershell' | 'posix'): string {
	const unique = [...new Set(dirs)];
	if (unique.length === 0) {
		return command;
	}
	if (shell === 'posix') {
		return `export PATH="${unique.join(':')}:$PATH" && ${command}`;
	}
	return `$env:Path = "${unique.join(';')};$env:Path"; ${command}`;
}

/**
 * Runs `steps` in a visible terminal, chained so each runs only if the previous
 * one succeeded, with uv's and cargo's directories on PATH.
 *
 * The terminal is launched with an explicit shell so the syntax we emit is
 * known: on Windows the default is PowerShell (where `&&` is a parse error), so
 * force powershell.exe and emit PowerShell chaining; elsewhere use the default
 * shell with POSIX `&&`. See chainSteps and withPathPrefix.
 *
 * Shared by the install and the pinned-ref update ([./update]) so both surface
 * the same way — visible, in the user's own shell, nothing hidden.
 */
export function runInEnginesTerminal(name: string, steps: string[]): void {
	const isWin = process.platform === 'win32';
	const terminal = vscode.window.createTerminal(
		isWin ? { name, shellPath: 'powershell.exe' } : { name },
	);
	terminal.show();
	const shell: 'powershell' | 'posix' = isWin ? 'powershell' : 'posix';
	const toolDirs = [uvPath(), cargoPath()]
		.filter((p): p is string => p !== null)
		.map((p) => path.dirname(p));
	terminal.sendText(withPathPrefix(toolDirs, chainSteps(steps, shell), shell));
}

/**
 * Runs the engines install (or completes a partial one) in a terminal:
 * clone the monorepo to ~/.vinv/engines when no checkout exists, then
 * `uv sync` (Python engines + embedder) and `cargo build --release` (the
 * index). Requires `uv` and `cargo`; missing tools point at their install
 * docs instead.
 */
export async function installEngines(context: vscode.ExtensionContext): Promise<void> {
	if (!(await ensurePrerequisites())) {
		return;
	}
	const existingRoot = resolveEnginesRoot(context);
	const root = existingRoot ?? defaultEnginesCloneDir();
	const steps = existingRoot
		? // Checkout present (dev checkout or previous clone) — just (re)sync + build.
			[`cd "${root}"`, 'uv sync', cargoBuildCommand(root)]
		: [
				`git clone -b ${REPO_BRANCH} ${REPO_URL} "${root}"`,
				`cd "${root}"`,
				// Land a fresh install on the ref this vsix was cut against, so it
				// runs the same engines as every other user of this build rather
				// than whatever tip-of-branch happens to be. Unstamped dev builds
				// (ENGINE_REF === '') stay on the branch. See ./pinned.
				...(ENGINE_REF ? [`git -c advice.detachedHead=false checkout --detach ${ENGINE_REF}`] : []),
				'uv sync',
				cargoBuildCommand(root),
			];
	runInEnginesTerminal('Vinv Engines Install', steps);
	void vscode.window.showInformationMessage(
		'Vinv: Installing engines in the terminal. When it finishes, discovery and tracing are ready to run.',
	);
}

/**
 * First-run model warmup: `vinv-embedder warmup` pre-downloads the embedding
 * model so the first index build doesn't stall inside the sidecar. Offered
 * once per install, only when the engines are ready and no healthy sidecar is
 * already serving (a healthy server has its model).
 */
export async function maybeOfferEmbedderWarmup(context: vscode.ExtensionContext): Promise<void> {
	const KEY = 'vinv.embedder.warmupOffered';
	if (context.globalState.get<boolean>(KEY)) {
		return;
	}
	if (!enginesReady(context)) {
		return;
	}
	if (await isEmbedderHealthy()) {
		void context.globalState.update(KEY, true);
		return;
	}
	void context.globalState.update(KEY, true);
	const choice = await vscode.window.showInformationMessage(
		'Vinv: First run — pre-download the local embedding model now? (One-time; code search needs it.)',
		'Download Model',
		'Later',
	);
	if (choice !== 'Download Model') {
		return;
	}
	const cmd = engineCommand('vinv-embedder', {
		override: enginesPathSetting(),
		extensionDir: context.extensionPath,
	});
	if (!cmd) {
		return;
	}
	const terminal = vscode.window.createTerminal({ name: 'Vinv Embedder Warmup' });
	terminal.show();
	const quoted = [cmd.file, ...cmd.prefixArgs, 'warmup']
		.map((p) => (p.includes(' ') ? `"${p}"` : p))
		.join(' ');
	terminal.sendText(quoted);
}

/**
 * Ensures the Rust `index` binary exists, offering a from-source build in a
 * terminal when it does not. Returns the resolved path, or null when the
 * build has not happened yet (callers surface their own "not ready" state).
 */
export async function ensureIndexBinary(context: vscode.ExtensionContext): Promise<string | null> {
	const existing = resolveIndexBinary({
		override: enginesPathSetting(),
		extensionDir: context.extensionPath,
	});
	if (existing) {
		return existing;
	}
	const root = resolveEnginesRoot(context);
	if (!root) {
		void vscode.window.showWarningMessage(
			'Vinv: engines checkout not found — run "Vinv: Install Engines" first.',
		);
		return null;
	}
	const cargo = cargoPath();
	if (!cargo) {
		installPrerequisite('rust', 'Rust');
		return null;
	}
	const choice = await vscode.window.showInformationMessage(
		'Vinv: the index engine has not been built yet. Build it now? (cargo build --release, one-time)',
		'Build Now',
		'Later',
	);
	if (choice === 'Build Now') {
		const isWin = process.platform === 'win32';
		const terminal = vscode.window.createTerminal(
			isWin ? { name: 'Vinv Index Build', shellPath: 'powershell.exe' } : { name: 'Vinv Index Build' },
		);
		terminal.show();
		// Put cargo's dir on PATH (see withPathPrefix) so a bare `cargo` resolves.
		terminal.sendText(
			withPathPrefix([path.dirname(cargo)], cargoBuildCommand(root), isWin ? 'powershell' : 'posix'),
		);
	}
	return null;
}

/** Registers the engines commands. */
export function registerEnginesCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('vinv-vs.installEngines', () => installEngines(context)),
	);
}
