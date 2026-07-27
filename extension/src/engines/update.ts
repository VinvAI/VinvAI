/**
 * Keeping the engines checkout in step with the extension that drives it.
 *
 * The engines are not in the vsix — they are a monorepo checkout at
 * ~/.vinv/engines (see ./install). Updating the extension therefore does NOT
 * update them, and without this module a user who installed months ago runs a
 * new extension against old engines, while a user installing today gets
 * whatever tip-of-branch is. The contracts between the two are versioned (index
 * store format, MCP payload shapes), so that skew shows up as a cryptic failure
 * deep inside an engine rather than as "your engines are old".
 *
 * So each build stamps the ref it was cut against (./pinned) and, once per
 * extension version, this compares that ref against the checkout's HEAD and
 * offers to move it: fetch, `checkout --detach <ref>`, `uv sync`, and — only
 * when index/ actually changed between the two commits — `cargo build
 * --release`, which is the multi-minute step worth skipping.
 *
 * WHAT IT WILL NOT TOUCH: anything that is not the clone we made ourselves. A
 * dev checkout, or a root pointed at by `vinv.enginesPath`, is the user's
 * working tree — a checkout there could throw away work in progress. Same for
 * our own clone when it has tracked modifications. Both cases warn and stop.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { defaultEnginesCloneDir } from './resolve';
import { cargoBuildCommand, resolveEnginesRoot, runInEnginesTerminal } from './install';
import { ENGINE_REF, ENGINE_UPDATE_DEFAULT } from './pinned';

export type EngineUpdateMode = 'auto' | 'prompt' | 'never';

/**
 * Extension version whose pin check is already settled — set when the user
 * declines, or when the checkout is up to date or not ours to move. Deliberately
 * NOT set when an update is launched: the terminal is fire-and-forget, so a
 * failed build simply leaves HEAD where it was and the next window re-offers,
 * while a successful one goes quiet on its own because HEAD now matches.
 */
const SETTLED_KEY = 'vinv.engines.pinSettledFor';

/** `<version>:<count>` — how many times 'auto' has launched for this build. */
const ATTEMPTS_KEY = 'vinv.engines.autoAttempts';

/** After this many silent auto-updates for one version, start asking instead. */
const MAX_AUTO_ATTEMPTS = 2;

/**
 * Runs git in `root`, capturing stdout.
 *
 * GIT_TERMINAL_PROMPT=0 matters: the engines repo may require auth, and a
 * credential prompt on a non-interactive child would hang activation instead of
 * failing. Every caller treats a rejection as "unknown" and degrades.
 */
function git(root: string, args: string[], timeoutMs = 15_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{
				cwd: root,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
				timeout: timeoutMs,
				windowsHide: true,
			},
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
				} else {
					resolve(stdout);
				}
			},
		);
	});
}

/** The commit `ref` names in this checkout, or null when it cannot be resolved. */
async function resolveCommit(root: string, ref: string): Promise<string | null> {
	try {
		return (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
	} catch {
		return null;
	}
}

/** True when the checkout has modifications to tracked files. */
async function hasLocalChanges(root: string): Promise<boolean> {
	// --untracked-files=no on purpose: a synced, built checkout is full of
	// untracked-but-ignored output (.venv/, index/target/), and even a stray
	// scratch file is not a reason to refuse. Tracked edits are the real risk,
	// because those are what a checkout would overwrite.
	const out = await git(root, ['status', '--porcelain', '--untracked-files=no']);
	return out.trim().length > 0;
}

/** The clone this extension created and therefore owns. */
function isManagedClone(root: string): boolean {
	return path.resolve(root).toLowerCase() === path.resolve(defaultEnginesCloneDir()).toLowerCase();
}

/** The effective update mode: user setting when set, else this build's default. */
export function engineUpdateMode(): EngineUpdateMode {
	const configured = vscode.workspace
		.getConfiguration('vinv')
		.get<string>('engines.autoUpdate', '')
		.trim();
	if (configured === 'auto' || configured === 'prompt' || configured === 'never') {
		return configured;
	}
	return ENGINE_UPDATE_DEFAULT;
}

function attemptsFor(context: vscode.ExtensionContext, version: string): number {
	const raw = context.globalState.get<string>(ATTEMPTS_KEY) ?? '';
	const [storedVersion, count] = raw.split(':');
	return storedVersion === version ? (Number(count) || 0) : 0;
}

/**
 * Whether the pin is worth looking at at all — the cheap gates, before any git
 * call. Pure so the "does this nag on every window reload" question has an
 * answer that can be tested rather than argued about.
 */
export function shouldRunPinCheck(input: {
	ref: string;
	mode: EngineUpdateMode;
	force: boolean;
	settled: boolean;
}): boolean {
	if (!input.ref) {
		return false; // unstamped dev build: unpinned, nothing to compare
	}
	if (input.force) {
		return true; // the explicit command ignores mode and the settled marker
	}
	return input.mode !== 'never' && !input.settled;
}

/** What to do once the checkout's actual state is known. */
export type EnginePinAction =
	/** HEAD is already the pinned commit — record it and go quiet. */
	| { kind: 'up-to-date' }
	/** A dev checkout or `vinv.enginesPath` root: warn, never modify. */
	| { kind: 'foreign' }
	/** Our clone, but with tracked edits: warn, never modify. */
	| { kind: 'dirty' }
	/** Offer the update first. */
	| { kind: 'ask' }
	/** Go straight to updating. */
	| { kind: 'update' };

/**
 * The pin decision, given everything known about the checkout.
 *
 * `managed` is the load-bearing one: it is the difference between updating an
 * artifact directory this extension owns and running `git checkout` over
 * someone's working tree.
 */
export function decidePinAction(input: {
	head: string;
	pinnedCommit: string | null;
	managed: boolean;
	dirty: boolean;
	mode: EngineUpdateMode;
	force: boolean;
	autoAttempts: number;
}): EnginePinAction {
	if (input.pinnedCommit !== null && input.pinnedCommit === input.head) {
		return { kind: 'up-to-date' };
	}
	if (!input.managed) {
		return { kind: 'foreign' };
	}
	if (input.dirty) {
		return { kind: 'dirty' };
	}
	// 'auto' updates silently — until it has already relaunched a couple of
	// times for this version, which means the build keeps failing and silently
	// reopening a terminal every window is not helping anyone.
	if (input.force) {
		return input.mode === 'auto' ? { kind: 'update' } : { kind: 'ask' };
	}
	if (input.mode === 'auto' && input.autoAttempts < MAX_AUTO_ATTEMPTS) {
		return { kind: 'update' };
	}
	return { kind: 'ask' };
}

/**
 * Moves the managed clone onto the pinned ref, in a visible terminal.
 *
 * `fetched` says whether the ref is already in the checkout's object store, so
 * the terminal can skip a redundant network round trip; `rebuildIndex` carries
 * the index/-changed decision (see maybeUpdateEngines).
 */
function launchUpdate(
	root: string,
	target: string,
	opts: { fetched: boolean; rebuildIndex: boolean },
): void {
	const steps = [
		`cd "${root}"`,
		...(opts.fetched ? [] : ['git fetch --tags --force origin']),
		// Detached on purpose: this clone is an artifact directory pinned to a
		// commit, not a branch anyone develops on. advice.detachedHead is off so
		// the user watching the terminal sees the build, not git's warning wall.
		`git -c advice.detachedHead=false checkout --detach ${target}`,
		'uv sync',
		...(opts.rebuildIndex ? [cargoBuildCommand(root)] : []),
	];
	runInEnginesTerminal('Vinv Engines Update', steps);
}

/**
 * Compares the checkout against this build's pinned ref and, depending on the
 * update mode, updates it, offers to, or warns.
 *
 * Called on activation (gated to once per extension version) and by the
 * "Vinv: Update Engines" command, which passes `force` to re-run the check and
 * to ignore an update mode of 'never'.
 */
export async function maybeUpdateEngines(
	context: vscode.ExtensionContext,
	opts: { force?: boolean } = {},
): Promise<void> {
	const force = opts.force === true;
	const mode = engineUpdateMode();
	const version = String(context.extension.packageJSON.version ?? '');
	const settled = context.globalState.get<string>(SETTLED_KEY) === version;
	if (!shouldRunPinCheck({ ref: ENGINE_REF, mode, force, settled })) {
		if (force && !ENGINE_REF) {
			// Unstamped dev build — nothing to compare against, and the
			// developer's checkout is theirs to move.
			void vscode.window.showInformationMessage(
				'Vinv: this build is not pinned to an engines version, so there is nothing to update to. Use "Vinv: Install Engines" to re-sync and rebuild the checkout you have.',
			);
		}
		return;
	}

	const root = resolveEnginesRoot(context);
	if (!root) {
		// Nothing installed yet — the next-step ladder already points at
		// "Install Engines", and that clone lands on the pin by itself.
		return;
	}

	let head: string;
	try {
		head = (await git(root, ['rev-parse', 'HEAD'])).trim();
	} catch {
		// Not a git checkout (or no git on PATH): a tarball copy, or a path the
		// user assembled by hand. Not ours to reason about.
		if (force) {
			void vscode.window.showWarningMessage(
				`Vinv: ${root} is not a git checkout, so the engines version cannot be compared or updated.`,
			);
		}
		return;
	}

	const settle = (): void => void context.globalState.update(SETTLED_KEY, version);
	const managed = isManagedClone(root);
	const autoAttempts = attemptsFor(context, version);
	const action = decidePinAction({
		head,
		pinnedCommit: await resolveCommit(root, ENGINE_REF),
		managed,
		// Only meaningful for our own clone, and only asked for there.
		dirty: managed ? await hasLocalChanges(root) : false,
		mode,
		force,
		autoAttempts,
	});

	// Up to date: settling skips the git reads on every window reload until the
	// next extension update.
	if (action.kind === 'up-to-date') {
		settle();
		return;
	}

	if (action.kind === 'foreign') {
		// A dev checkout or a `vinv.enginesPath` root: the user's working tree.
		// Say what is expected and let them move it themselves.
		settle();
		const choice = await vscode.window.showWarningMessage(
			`Vinv ${version} expects the engines at ${ENGINE_REF}, but the checkout at ${root} is at ${head.slice(0, 7)}. Update it yourself to avoid version-skew failures.`,
			'Copy Command',
			'Dismiss',
		);
		if (choice === 'Copy Command') {
			await vscode.env.clipboard.writeText(
				`git -C "${root}" fetch --tags && git -C "${root}" checkout ${ENGINE_REF} && uv sync && ${cargoBuildCommand(root)}`,
			);
		}
		return;
	}

	if (action.kind === 'dirty') {
		settle();
		const choice = await vscode.window.showWarningMessage(
			`Vinv: the engines checkout at ${root} has local changes, so it was left alone — it is ${head.slice(0, 7)} and this build expects ${ENGINE_REF}.`,
			'Open Folder',
			'Dismiss',
		);
		if (choice === 'Open Folder') {
			await vscode.env.openExternal(vscode.Uri.file(root));
		}
		return;
	}

	// Ask before spending the user's machine on it, unless this build (or the
	// user) chose 'auto'.
	if (action.kind === 'ask') {
		const choice = await vscode.window.showInformationMessage(
			`Vinv ${version} ships with engines ${ENGINE_REF}; yours are at ${head.slice(0, 7)}. Update them now? (Runs uv sync, and rebuilds the index engine if it changed.)`,
			'Update Now',
			'Later',
			'Never',
		);
		if (choice === 'Never') {
			await vscode.workspace
				.getConfiguration('vinv')
				.update('engines.autoUpdate', 'never', vscode.ConfigurationTarget.Global);
			settle();
			return;
		}
		if (choice !== 'Update Now') {
			settle();
			return;
		}
	}

	// Fetch here rather than in the terminal so the index/-changed decision can
	// be made against real commits. Best effort: on failure the terminal fetches
	// instead and we conservatively rebuild.
	let fetched = false;
	try {
		await git(root, ['fetch', '--tags', '--force', 'origin'], 120_000);
		fetched = true;
	} catch {
		// Offline, or auth required — the terminal is interactive and can prompt.
	}

	const target = fetched ? await resolveCommit(root, ENGINE_REF) : null;
	// Rebuild the Rust index only when index/ actually differs between the two
	// commits; it is a multi-minute build and most extension bumps never touch
	// it. Anything unknown (no fetch, unresolvable ref, diff failed) rebuilds.
	let rebuildIndex = true;
	if (target) {
		try {
			const changed = await git(root, ['diff', '--name-only', head, target, '--', 'index/']);
			rebuildIndex = changed.trim().length > 0;
		} catch {
			rebuildIndex = true;
		}
	}

	// Count only unattended launches: the cap exists so a build that keeps
	// failing stops silently reopening a terminal on every window, and a user
	// who clicked "Update Now" is not the case it guards against.
	if (action.kind === 'update') {
		await context.globalState.update(ATTEMPTS_KEY, `${version}:${autoAttempts + 1}`);
	}
	launchUpdate(root, target ?? ENGINE_REF, { fetched, rebuildIndex });
	void vscode.window.showInformationMessage(
		`Vinv: updating the engines to ${ENGINE_REF} in the terminal.${
			rebuildIndex ? ' The index engine changed, so this includes a Rust rebuild.' : ''
		}`,
	);
}

/** Registers the engines-update command. */
export function registerEngineUpdate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('vinv-vs.updateEngines', () =>
			maybeUpdateEngines(context, { force: true }),
		),
	);
}
