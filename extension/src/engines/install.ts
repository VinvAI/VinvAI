/**
 * Extension-side engines installation: the one-click "Install Vinv engines"
 * flow and the first-run embedder warmup offer.
 *
 * Everything runs from the GitHub checkout — there are no downloads and no
 * prebuilt artifacts. Installing is `git clone <monorepo> ~/.vinv/engines`,
 * `uv sync` (Python engines), and `cargo build --release` (the Rust index),
 * executed in a visible terminal so the user sees exactly what happens on
 * their machine. Any missing prerequisite (uv, Rust) installs as the first
 * steps of that same terminal chain, so the whole thing is one click.
 */
import * as vscode from 'vscode';
import { registerTrackedCommand } from '../telemetry/instrument';
import { bucketCount, track } from '../telemetry';
import * as fs from 'fs';
import * as path from 'path';
import {
	REPO_URL,
	REPO_BRANCH,
	cargoPath,
	defaultEnginesCloneDir,
	engineCommand,
	engineRunDonePath,
	engineSyncStampPath,
	gitPath,
	engineOnPath,
	defaultToolDirs,
	enginesRootDir,
	enginesSynced,
	resolveIndexBinary,
	uvPath,
} from './resolve';
import { ensureEmbedderRunning, isEmbedderHealthy, type EmbedderStatus } from '../embedder/sidecar';
import { ENGINE_REF, ENGINE_WHEEL } from './pinned';
import { resolveBash } from '../proc';
import { executableFileName } from '../vinvHome';

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
 * Installs a missing prerequisite by running its official installer in its own
 * terminal, for callers that need the tool but have nothing to chain it to.
 *
 * The installer runs asynchronously and edits PATH only for future shells, so
 * the tool is not usable when this returns — the caller has to stop and let the
 * user re-run. `installEngines` does NOT use this: it folds the same installer
 * commands into its own terminal chain so one click finishes the job.
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
export function ensureEmbedder(
	context: vscode.ExtensionContext,
	// Narrates the wait for a caller with a progress surface (the Ask Vinv
	// thinking line). Omitted by background callers, which stay silent.
	onStatus?: EmbedderStatus,
): Promise<boolean> {
	return ensureEmbedderRunning({
		override: enginesPathSetting(),
		extensionDir: context.extensionPath,
		onStatus,
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
/** When the user last kicked off an engines install, for the settle check below. */
const INSTALL_STARTED_KEY = 'vinv.telemetry.enginesInstallStarted';

/** How long an unfinished install waits before it counts as abandoned. */
const INSTALL_ABANDON_MS = 24 * 60 * 60 * 1000;

/**
 * Reports whether an engines install that started ever actually finished.
 *
 * The install runs in a terminal the extension hands work to and never hears
 * back from, so there is no completion callback to hook. Instead this runs on a
 * later activation and reconciles: engines present now means the attempt landed;
 * still absent a day later means the user gave up. Either way it fires once and
 * clears the stamp.
 *
 * This is the number that decides whether the terminal-based installer survives.
 */
export function reconcileEnginesInstall(context: vscode.ExtensionContext): void {
	try {
		const startedAt = context.globalState.get<number>(INSTALL_STARTED_KEY);
		if (typeof startedAt !== 'number' || startedAt <= 0) {
			return;
		}
		const elapsed = Date.now() - startedAt;
		// Re-probed at SETTLE time, not reused from the start event: an install
		// that abandons with uv or Rust still missing failed for a reason we can
		// act on, and one that abandons with everything present failed for a
		// reason we cannot yet see. Those need different fixes and used to be the
		// same row.
		const prereqs = {
			has_git: !!gitPath(),
			has_uv: !!uvPath(),
			has_rust: !!cargoPath(),
		};
		if (enginesReady(context)) {
			track('engines_install_settled', {
				outcome: 'ready',
				minutes_bucket: bucketCount(Math.round(elapsed / 60_000)),
				...prereqs,
			});
		} else if (elapsed > INSTALL_ABANDON_MS) {
			track('engines_install_settled', {
				outcome: 'abandoned',
				minutes_bucket: bucketCount(Math.round(elapsed / 60_000)),
				...prereqs,
			});
		} else {
			// Still plausibly in flight — leave the stamp and look again next time.
			return;
		}
		void context.globalState.update(INSTALL_STARTED_KEY, undefined);
	} catch {
		// Reporting must never break activation.
	}
}

/**
 * True when the engines are usable — by EITHER route.
 *
 * This used to mean only "the checkout's venv exists", which quietly became
 * wrong in two directions once the wheel existed. A wheel install has no
 * checkout at all, so a perfectly working machine reported not-ready and got
 * prompted to install forever. And a checkout whose `uv sync` succeeded but
 * whose `cargo build` failed reported READY while the index binary — the thing
 * discovery actually needs — was never produced. Both routes are now checked
 * for the artifacts that matter rather than for the shape of the install.
 */
export function enginesReady(context: vscode.ExtensionContext): boolean {
	if (wheelEnginesReady()) {
		return true;
	}
	const root = resolveEnginesRoot(context);
	return root !== null && enginesSynced(root);
}

/**
 * True when the `vinv` wheel has put both halves of the engines on PATH.
 *
 * Both are required: the wheel ships the Python engines and the compiled Rust
 * `index` together, so seeing one without the other means a partial or shadowed
 * install rather than a usable one.
 */
export function wheelEnginesReady(): boolean {
	return engineOnPath('index') !== null && engineOnPath('tracelens') !== null;
}

/**
 * Installer steps for whichever prerequisites are missing, to run ahead of the
 * install itself in the SAME terminal.
 *
 * This used to install a missing tool in its own terminal and return false, so
 * the user had to notice a toast and re-run "Install Vinv Engines" — twice on a
 * clean machine (once for uv, once for Rust), each stop leaving the engines
 * absent and looking like a failed install. Emitting the installers as ordinary
 * chained steps makes it one click: the shell runs them in order, so each tool
 * exists by the time the step that needs it runs.
 */
function prerequisiteSteps(opts?: { needsRust?: boolean }): string[] {
	const needsRust = opts?.needsRust !== false;
	const steps: string[] = [];
	// 'absent' throughout: these probes resolve a binary and do not compare a
	// version, so a tool that is present but too old is not a case this gate can
	// currently produce. The field exists so that when a version floor is added
	// it does not read, in the data, as a tool the user never installed.
	if (!uvPath()) {
		track('engines_prereq_missing', { tool: 'uv', reason: 'absent' });
		steps.push(installerCommand('uv'));
	}
	// Only the source route needs a Rust toolchain. Installing one for the wheel
	// route would be worse than pointless: on Windows `rustup-init -y` lands the
	// MSVC toolchain and suppresses the prompt warning that no linker is
	// present, so it manufactures exactly the broken state the wheel avoids.
	if (needsRust && !cargoPath()) {
		track('engines_prereq_missing', { tool: 'rust', reason: 'absent' });
		steps.push(installerCommand('rust'));
	}
	// Git was reported at install-start but never as a blocker, so a machine
	// without it produced an install that simply failed with nothing to explain
	// it — the clone is the first step and cannot run. The wheel route needs no
	// clone, so this is only a blocker for the source route.
	if (needsRust && !gitPath()) {
		track('engines_prereq_missing', { tool: 'git', reason: 'absent' });
	}
	return steps;
}

/** The command that builds the Rust index inside an engines checkout. */
export function cargoBuildCommand(root: string): string {
	return `cargo build --release --manifest-path "${root}/index/Cargo.toml"`;
}

/**
 * Records that the engines were materialised for the commit now on disk — the
 * last step of every terminal that syncs or builds them, so it runs only if all
 * the steps before it succeeded (see chainSteps).
 *
 * The mtime is the signal (see engineSyncStampPath); the sha is written so the
 * file explains itself to anyone who finds it. `>` redirects a native command's
 * stdout in PowerShell and POSIX shells alike, so one spelling covers both.
 */
export function syncStampCommand(root: string): string {
	return `git -C "${root}" rev-parse HEAD > "${engineSyncStampPath(root)}"`;
}

/**
 * Announces that the terminal is done, whatever happened in it. Sent as its own
 * line rather than chained onto the steps, so the shell runs it after the chain
 * regardless of how the chain ended — including a chain the user interrupted.
 */
function runDoneCommand(root: string): string {
	return `echo vinv-engines-run-finished > "${engineRunDonePath(root)}"`;
}

/** How long to wait on a running engines terminal, and how often to look. */
const RUN_WAIT_MS = 45 * 60_000;
const RUN_POLL_MS = 5_000;

/**
 * Resolves when the engines terminal launched most recently has finished. Always
 * Promise.resolve() when none was launched, so callers can await it
 * unconditionally.
 */
let terminalRun: Promise<void> = Promise.resolve();

/**
 * Awaits the engines terminal, if one is running.
 *
 * "Finished" means the shell got to the end of the command line — a failed sync,
 * a failed build and a successful one all resolve this, and so does the ceiling
 * below. It deliberately reports nothing about the outcome: callers wait so they
 * are not racing a checkout mid-flight, and a build that failed is a state they
 * still have to cope with. Whether the engines came out usable is a question for
 * the filesystem (enginesMatchPin), not for this.
 */
export function awaitEnginesTerminal(): Promise<void> {
	return terminalRun;
}

/** Polls for the done marker, giving up — and resolving anyway — at the ceiling. */
function watchForRunDone(root: string): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = engineRunDonePath(root);
		const deadline = Date.now() + RUN_WAIT_MS;
		const tick = (): void => {
			if (fs.existsSync(done) || Date.now() >= deadline) {
				resolve();
				return;
			}
			setTimeout(tick, RUN_POLL_MS);
		};
		setTimeout(tick, RUN_POLL_MS);
	});
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
 * restarted, so a bare `cargo`/`uv` fails with "command not found". Putting
 * those dirs on PATH first makes the bare invocations — and cargo's toolchain
 * neighbours (rustc, the linker) — resolve.
 *
 * Callers pass the default install dirs (defaultToolDirs) even for a tool that
 * is absent right now: the same chain may install it a step earlier, and a dir
 * derived from a lookup that returned null cannot cover that case.
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
 *
 * `stampRoot` makes the run observable, and every caller whose steps materialise
 * the engines (sync, build, or both) should pass it. Two markers come out of it:
 * the sync stamp, chained so it lands only on success, and the done marker, sent
 * as a separate line so it lands however the run ended. Doing both here rather
 * than at each call site is what keeps a new caller from silently leaving the
 * engines looking permanently stale, or leaving a waiter hanging on a run it
 * cannot see the end of.
 */
export function runInEnginesTerminal(
	name: string,
	steps: string[],
	stampRoot?: string,
	opts?: {
		/**
		 * A command sent as its OWN line after the chain, so it runs however the
		 * chain ended. Must be self-guarding: it fires on success too, and has to
		 * decide for itself that there is nothing to do.
		 */
		recovery?: string;
		/** Which install route this terminal is running, for telemetry. */
		route?: 'wheel' | 'source';
	},
): void {
	const isWin = process.platform === 'win32';
	const terminal = vscode.window.createTerminal(
		isWin ? { name, shellPath: 'powershell.exe' } : { name },
	);
	terminal.show();
	const shell: 'powershell' | 'posix' = isWin ? 'powershell' : 'posix';
	// Resolved dirs first (a tool installed somewhere non-default still wins),
	// then the defaults, which are the only way to cover a tool this very run is
	// about to install.
	const toolDirs = [
		...[uvPath(), cargoPath()].filter((p): p is string => p !== null).map((p) => path.dirname(p)),
		...defaultToolDirs(),
	];
	const all = stampRoot ? [...steps, syncStampCommand(stampRoot)] : steps;
	if (stampRoot) {
		// Clear the previous run's marker BEFORE the shell can write this one's,
		// or a waiter would read "finished" off a run that ended hours ago.
		try {
			fs.rmSync(engineRunDonePath(stampRoot), { force: true });
		} catch {
			// Unwritable engines root: the wait falls back to its ceiling.
		}
	}
	terminal.sendText(withPathPrefix(toolDirs, chainSteps(all, shell), shell));
	if (opts?.route) {
		track('engines_install_route', { route: opts.route, has_recovery: !!opts.recovery });
	}
	if (opts?.recovery) {
		// Its own line, like the done marker below: the shell reads it only once
		// the chain returns, so it runs whether that chain succeeded or failed.
		// A chained step could not — `&&`/`if ($?)` short-circuit on the failure
		// this is here to recover from. The PATH prefix set by the line above
		// persists for the session, so uv/cargo still resolve here.
		terminal.sendText(opts.recovery);
	}
	if (stampRoot) {
		// A second line, not a chained step: the shell reads it only once the
		// command above returns, so it runs whether that command succeeded, failed,
		// or was interrupted — which is exactly what "the terminal is done" means.
		terminal.sendText(runDoneCommand(stampRoot));
		terminalRun = watchForRunDone(stampRoot);
	}
}

/**
 * Runs the engines install (or completes a partial one) in a terminal:
 * clone the monorepo to ~/.vinv/engines when no checkout exists, then
 * `uv sync` (Python engines + embedder) and `cargo build --release` (the
 * index). Requires `uv` and `cargo`; missing tools point at their install
 * docs instead.
 */
export async function installEngines(context: vscode.ExtensionContext): Promise<void> {
	// Recorded BEFORE the prerequisite gate, so an install that never gets past
	// a missing tool still counts as an attempt — otherwise the denominator
	// silently excludes exactly the users who were blocked first.
	track('engines_install_started', {
		has_git: !!gitPath(),
		has_uv: !!uvPath(),
		has_rust: !!cargoPath(),
		has_bash: !!resolveBash(),
	});
	// Stamped so a later activation can tell whether this attempt ever landed —
	// the terminal itself reports nothing back, which is why the outcome of the
	// single most important onboarding step has never been observable.
	void context.globalState.update(INSTALL_STARTED_KEY, Date.now());

	const existingRoot = resolveEnginesRoot(context);
	const root = existingRoot ?? defaultEnginesCloneDir();

	// THE WHEEL IS THE PRIMARY ROUTE. It carries every Python engine and a
	// prebuilt `index`, so it needs no git, no Rust and no C linker — which is
	// what makes it the right default rather than merely the easier one. Source
	// builds need a linker the platform may not have: Windows ships none, and
	// `rustup-init -y` installs the MSVC toolchain while suppressing the prompt
	// that would have told the user their machine cannot link. That combination
	// produced a machine with cargo installed, `uv sync` succeeded, and no index
	// binary — the failure this ordering exists to remove.
	//
	// A DEV CHECKOUT STILL WINS: someone with their own tree is working on the
	// engines, and pulling a published wheel over the top of that is never what
	// they meant. Unstamped builds (ENGINE_WHEEL === '') skip the wheel for the
	// same reason. See ./pinned.
	const useWheel = ENGINE_WHEEL !== '' && existingRoot === null;

	// Missing tools install as the first steps of the same chain rather than
	// aborting the run — see prerequisiteSteps. The wheel route needs only uv,
	// so it never asks for Rust: requesting a toolchain the install does not use
	// is how the old flow turned a missing linker into a blocked onboarding.
	const prereqs = prerequisiteSteps({ needsRust: !useWheel });

	if (useWheel) {
		// Version-pinned, for the reason ENGINE_REF is: a frozen extension must
		// not silently pair with a newer engine. See ./pinned.
		const steps = [`uv tool install --force "vinv==${ENGINE_WHEEL}"`];
		runInEnginesTerminal('Vinv Engines Install', [...prereqs, ...steps], root, {
			// Sent as its own line so it runs even though the chain above failed —
			// which is the entire point of a fallback. Self-guarding, so it stays
			// inert when the wheel worked.
			recovery: sourceFallbackCommand(root),
			route: 'wheel',
		});
		void vscode.window.showInformationMessage(
			'Vinv: Installing the engines in the terminal (prebuilt — no Rust toolchain needed). When it finishes, discovery and tracing are ready to run.',
		);
		return;
	}

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
	runInEnginesTerminal('Vinv Engines Install', [...prereqs, ...steps], root, {
		// The mirror of the above: when the source build is the chosen route and
		// its linker step dies, the prebuilt wheel is the way out. Only offered
		// for a stamped build, so a dev checkout is never overwritten by a wheel.
		recovery: ENGINE_WHEEL ? wheelFallbackCommand(root) : undefined,
		route: 'source',
	});
	void vscode.window.showInformationMessage(
		prereqs.length > 0
			? 'Vinv: Installing the missing prerequisites and then the engines, in the terminal. When it finishes, discovery and tracing are ready to run.'
			: 'Vinv: Installing engines in the terminal. When it finishes, discovery and tracing are ready to run.',
	);
}

/** Shell test for "the checkout's index binary exists". */
function builtIndexPath(root: string): string {
	return path.join(root, 'index', 'target', 'release', executableFileName('index'));
}

/**
 * Recovery for the WHEEL route: build from source when the wheel did not land.
 *
 * Guarded on the binary rather than on the previous command's exit code,
 * because the thing that matters is whether an `index` exists, not whether a
 * particular step reported success.
 */
function sourceFallbackCommand(root: string): string {
	const clone = `git clone -b ${REPO_BRANCH} ${REPO_URL} "${root}"`;
	const build = `cd "${root}"; uv sync; ${cargoBuildCommand(root)}`;
	if (process.platform === 'win32') {
		return `if (-not (Get-Command index -ErrorAction SilentlyContinue)) { Write-Host "Vinv: the prebuilt engines did not install — falling back to a source build."; if (-not (Test-Path "${root}")) { ${clone} }; ${build} }`;
	}
	return `command -v index >/dev/null 2>&1 || { echo "Vinv: the prebuilt engines did not install — falling back to a source build."; [ -d "${root}" ] || ${clone}; cd "${root}" && uv sync && ${cargoBuildCommand(root)}; }`;
}

/**
 * Recovery for the SOURCE route: install the prebuilt wheel when the build
 * produced no binary — overwhelmingly a missing C linker.
 */
function wheelFallbackCommand(root: string): string {
	const built = builtIndexPath(root);
	const install = `uv tool install --force "vinv==${ENGINE_WHEEL}"`;
	if (process.platform === 'win32') {
		return `if (-not (Test-Path "${built}")) { Write-Host "Vinv: the source build produced no index binary — installing the prebuilt engines instead."; ${install} }`;
	}
	return `[ -x "${built}" ] || { echo "Vinv: the source build produced no index binary — installing the prebuilt engines instead."; ${install}; }`;
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
		registerTrackedCommand('vinv-vs.installEngines', () => installEngines(context)),
	);
}
