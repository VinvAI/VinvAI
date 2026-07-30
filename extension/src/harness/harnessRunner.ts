import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getBinPath, isBinAvailable, showEnginesMissingError } from '../tracelens/bin';
import { getHandbookEnv, getBringupEnv } from '../config/settings';
import { hiddenBackgroundOptions, killProcessTree } from '../proc';
import { evidenceSimilarity } from './stallBreaker';
import { isIdeChatAvailable, runIdeChatPrompt } from './ideChat';
import { isHandbookGenerated } from '../handbook/handbook';
import {
	auditOwnCodeTracing,
	isServicesListed,
	markUntracedBringup,
	repairRecordedTargetPackages,
	serviceSlug,
	type ServiceEntry,
} from '../bringup/bringup';
import { entrypointModule, targetPackagesFor } from '../bringup/targetPackages';

/**
 * Coding-harness adapters: instead of the bundled engines calling a cloud LLM
 * themselves, the LLM-requiring instructions (handbook generation and service
 * bring-up) are rendered by the engine binaries with `--print-prompt --portable`
 * (no LLM calls) and piped into the user's own coding-agent CLI, which does the
 * exploration and writes the same deliverable files the engines would have.
 */
export interface HarnessDef {
	id: string;
	label: string;
	/**
	 * 'cli' pipes prompts into a headless CLI; 'ide-chat' hands the task to the
	 * host editor's own agent panel via a file protocol (see ideChat.ts).
	 */
	kind: 'cli' | 'ide-chat';
	/**
	 * Executable name of the headless CLI (resolved against PATH plus well-known
	 * install dirs). Null for ide-chat harnesses (no process is spawned).
	 */
	bin: string | null;
	/**
	 * Alternate executable names to try when `bin` is absent — vendors rename
	 * their CLIs (Cursor ships `agent` now, `cursor-agent` on older installs).
	 */
	altBins?: string[];
	/** Flags for a headless, full-auto run that reads its prompt from stdin. */
	args: string;
	/**
	 * How the CLI encodes stdout. 'claude-stream-json': one JSON event per line
	 * while the agent works (assistant/tool_use/result envelopes) — decoded into
	 * the live thinking feed, with the final `result` envelope becoming the
	 * run's answer text. Absent: plain text, emitted line-by-line as-is.
	 */
	stream?: 'claude-stream-json';
	/** Shown when the CLI is missing or the chat panel is unreachable. */
	installHint: string;
	/** Copy-pasteable shell command that installs the CLI (null: not installable). */
	installCommand: string | null;
	/** The step after installing (sign-in etc.), shown in the install guide. */
	postInstall: string;
	/**
	 * The exact remediation shown when a run fails on authentication (CLI not
	 * signed in / key invalid). One actionable sentence — it is the whole
	 * notification body, so it must name the command to run.
	 */
	authRemediation?: string;
	/**
	 * Cheap auth-preflight probe: args (appended to the resolved executable)
	 * whose non-zero exit with auth-classified output proves the CLI cannot
	 * serve a dispatch. Only set where the vendor ships such a probe — a
	 * `--version` that succeeds while logged out is NOT one.
	 */
	authProbeArgs?: string[];
	/** ide-chat only: how the hand-off prompt reaches the panel. */
	chat?: {
		mechanism: 'chat-command' | 'deeplink' | 'clipboard';
		/** Host-editor test against vscode.env.appName; null = any VS Code family. */
		appPattern: RegExp | null;
		/** Extension id that must be installed for the panel to exist. */
		requiresExtension?: string;
		/**
		 * True when the editor GUARANTEES programmatic submission (Copilot's
		 * chat command). False for panels that only pre-fill or take the
		 * clipboard (Cursor's chat, Cascade): those get best-effort OS-keystroke
		 * auto-send (autoSend.ts) with a manual fallback — good enough for a
		 * human-picked dispatch, but unattended flows must not rely on it (the
		 * window may be unfocused/minimized with nobody there to fall back to).
		 */
		autoSubmit: boolean;
	};
}

// Install commands are platform-specific: Windows terminals get the vendors'
// PowerShell installers; everything else gets the shell installers. npm-based
// CLIs use the same command everywhere.
const IS_WINDOWS = process.platform === 'win32';

/**
 * Every harness offered in the picker — ALL of them, always, regardless of
 * install state or editor. Ids are persisted in ~/.vinv/config.json. CLIs and
 * Copilot Chat dispatch with zero human steps; Cursor's chat and Cascade can
 * only be pre-filled (their vendors block programmatic submission), so they
 * are marked manual in the UI and excluded from unattended auto-dispatch.
 */
export const HARNESSES: ReadonlyArray<HarnessDef> = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		kind: 'cli',
		// -p (print/headless) reads the prompt from stdin; bypassPermissions lets the
		// agent write files and run bring-up commands without interactive approval.
		// stream-json (which requires --verbose in -p mode) is the only headless
		// mode that emits output DURING the run — plain `-p` prints nothing until
		// the very end, which froze the live thinking feed for entire episodes.
		bin: 'claude',
		args: '-p --output-format stream-json --verbose --permission-mode bypassPermissions',
		stream: 'claude-stream-json',
		installHint:
			'Install the CLI with the native installer (the desktop app / IDE extension does not include it), then run `claude` once to sign in.',
		installCommand: IS_WINDOWS
			? 'irm https://claude.ai/install.ps1 | iex'
			: 'curl -fsSL https://claude.ai/install.sh | bash',
		postInstall: 'Then run `claude` once in a terminal to sign in. Note: the Claude desktop app or IDE extension does not include this CLI.',
		authRemediation:
			'Run `claude` in a terminal and sign in with `/login` (or fix ANTHROPIC_API_KEY), then retry the episode.',
		// No probe: `claude --version` succeeds while logged out, and there is no
		// documented cheap status subcommand — the run itself classifies instead.
	},
	{
		id: 'codex',
		label: 'Codex CLI',
		kind: 'cli',
		// `exec` is headless; `-` reads the prompt from stdin. --skip-git-repo-check
		// because target workspaces are not necessarily git repos.
		bin: 'codex',
		args: 'exec --full-auto --skip-git-repo-check -',
		installHint: 'Install with `npm install -g @openai/codex` and run `codex` once to sign in.',
		installCommand: 'npm install -g @openai/codex',
		postInstall: 'Then run `codex` once in a terminal to sign in.',
		authRemediation:
			'Run `codex login` in a terminal (or fix OPENAI_API_KEY), then retry the episode.',
		// `codex login status` exits non-zero with "Not logged in" when signed out.
		authProbeArgs: ['login', 'status'],
	},
	{
		id: 'cursor',
		label: 'Cursor CLI',
		kind: 'cli',
		// -p (print/headless) reads stdin; --force allows command execution.
		// Newer installers ship the binary as `agent`; older ones as `cursor-agent`.
		bin: 'cursor-agent',
		altBins: ['agent'],
		args: '-p --force',
		installHint: IS_WINDOWS
			? "Install the Cursor CLI (`irm 'https://cursor.com/install?win32=true' | iex`) and sign in with `agent login`."
			: 'Install the Cursor CLI (`curl https://cursor.com/install -fsS | bash`) and sign in with `agent login` (older installs: `cursor-agent login`).',
		installCommand: IS_WINDOWS
			? "irm 'https://cursor.com/install?win32=true' | iex"
			: 'curl https://cursor.com/install -fsS | bash',
		postInstall: 'Then sign in with `agent login` (older installs: `cursor-agent login`).',
		authRemediation:
			'Run `cursor-agent login` (newer installs: `agent login`) in a terminal, then retry the episode.',
		// `cursor-agent status` exits non-zero and prints the same
		// "Authentication required" text as a dispatch when signed out.
		authProbeArgs: ['status'],
	},
	{
		id: 'gemini',
		label: 'Gemini CLI',
		kind: 'cli',
		// Reads the prompt from stdin in non-interactive mode; --yolo auto-approves.
		bin: 'gemini',
		args: '--yolo',
		installHint: 'Install with `npm install -g @google/gemini-cli` and run `gemini` once to sign in.',
		installCommand: 'npm install -g @google/gemini-cli',
		postInstall: 'Then run `gemini` once in a terminal to sign in.',
		authRemediation:
			'Run `gemini` in a terminal and complete the Google sign-in (or fix GEMINI_API_KEY), then retry the episode.',
		// No probe: the CLI has no documented cheap logged-out status command.
	},
	// IDE-chat hand-offs: the task goes to the editor's agent panel via the
	// .vinv/handoff file protocol (see ideChat.ts). Copilot Chat's documented
	// command SUBMITS the prompt (zero-touch, like the CLIs); Cursor's chat and
	// Cascade can only be pre-filled, so they need one human Enter per task.
	{
		id: 'copilot-chat',
		label: 'GitHub Copilot Chat (this window)',
		kind: 'ide-chat',
		bin: null,
		args: '',
		installHint:
			'Requires the GitHub Copilot Chat extension in this editor — install it from the Extensions view, then retry.',
		installCommand: null,
		postInstall: 'Sign in to GitHub Copilot in this editor, then retry.',
		chat: {
			mechanism: 'chat-command',
			appPattern: null,
			requiresExtension: 'GitHub.copilot-chat',
			autoSubmit: true,
		},
	},
	{
		id: 'cursor-chat',
		label: 'Cursor chat panel (this window)',
		kind: 'ide-chat',
		bin: null,
		args: '',
		installHint:
			'Only available when this workspace is open in Cursor — open it there, or pick the Cursor CLI harness (fully automatic).',
		installCommand: null,
		postInstall: 'Open this workspace in Cursor, then retry.',
		chat: { mechanism: 'deeplink', appPattern: /cursor/i, autoSubmit: false },
	},
	{
		id: 'windsurf',
		label: 'Windsurf Cascade (this window)',
		kind: 'ide-chat',
		bin: null,
		args: '',
		installHint:
			'Only available when this workspace is open in Windsurf — open it there, or pick a CLI harness (fully automatic). ' +
			'Cascade has no programmatic prompt API, so the hand-off prompt is copied to the clipboard to paste.',
		installCommand: null,
		postInstall: 'Open this workspace in Windsurf, then retry.',
		chat: { mechanism: 'clipboard', appPattern: /windsurf/i, autoSubmit: false },
	},
];

/**
 * True when a dispatch to this harness runs start-to-finish without a human:
 * every CLI, plus ide-chat panels whose hand-off auto-submits. Cursor's chat
 * and Cascade need someone to press Enter/paste, so unattended flows
 * (auto-episodes, background triggers) must not target them — the run would
 * sit in "waiting" forever with nobody at the keyboard.
 */
export function isHarnessAutonomous(h: HarnessDef): boolean {
	return h.kind === 'cli' || !!h.chat?.autoSubmit;
}

export function getHarness(id: string): HarnessDef {
	return HARNESSES.find((h) => h.id === id) ?? HARNESSES[0];
}

// ---- infrastructure-failure classification ---------------------------------
//
// A precondition failure (CLI not signed in, key invalid/expired, quota
// exhausted, vendor unreachable) can never be fixed by retrying, mutating the
// pack, or judging a stall — every consumer of a harness run must recognize it
// on the FIRST occurrence and stop, surfacing the one remediation the human
// actually needs ("run `cursor-agent login`"). The patterns are data, kept
// here next to the HARNESSES catalog they describe.

/** Classification of a failed harness run. Only 'other' is retryable. */
export type HarnessFailureKind = 'auth' | 'quota' | 'network' | 'other';

/** A HarnessFailureKind that terminates work (everything except 'other'). */
export type HarnessInfraKind = Exclude<HarnessFailureKind, 'other'>;

interface InfraPattern {
	kind: HarnessInfraKind;
	re: RegExp;
	/**
	 * Strong patterns are unambiguous error sentences and match regardless of
	 * exit code. Weak patterns (bare env-var names, generic connectivity words)
	 * only count on a non-zero exit — an agent legitimately answering "set
	 * ANTHROPIC_API_KEY" must never classify its own success as an auth failure.
	 */
	strong: boolean;
}

/** Per-CLI (plus a few vendor-neutral) precondition-failure fingerprints. */
const INFRA_PATTERNS: ReadonlyArray<InfraPattern> = [
	// -- auth: cursor ----------------------------------------------------------
	{ kind: 'auth', re: /authentication required/i, strong: true },
	{ kind: 'auth', re: /cursor-agent login/i, strong: true },
	{ kind: 'auth', re: /CURSOR_API_KEY/, strong: false },
	// -- auth: claude ----------------------------------------------------------
	{ kind: 'auth', re: /please run \/login/i, strong: true },
	{ kind: 'auth', re: /OAuth token has expired/i, strong: true },
	{ kind: 'auth', re: /invalid api key/i, strong: true },
	{ kind: 'auth', re: /ANTHROPIC_API_KEY/, strong: false },
	// -- auth: codex -----------------------------------------------------------
	{ kind: 'auth', re: /not (?:currently )?logged in/i, strong: true },
	{ kind: 'auth', re: /\bcodex login\b/i, strong: true },
	{ kind: 'auth', re: /OPENAI_API_KEY/, strong: false },
	// -- auth: gemini ----------------------------------------------------------
	{ kind: 'auth', re: /api key not valid/i, strong: true },
	{ kind: 'auth', re: /GEMINI_API_KEY|GOOGLE_API_KEY/, strong: false },
	// -- auth: vendor-neutral --------------------------------------------------
	{ kind: 'auth', re: /api key.{0,40}\b(?:expired|revoked|disabled)\b/i, strong: true },
	{ kind: 'auth', re: /\bnot authenticated\b/i, strong: true },
	{ kind: 'auth', re: /\b(?:401|403)\b.{0,40}\bunauthorized\b|\bunauthorized\b.{0,40}\b(?:401|403)\b/i, strong: true },
	// -- quota -----------------------------------------------------------------
	{ kind: 'quota', re: /credit balance is too low/i, strong: true }, // anthropic
	{ kind: 'quota', re: /exceeded your current quota/i, strong: true }, // openai
	{ kind: 'quota', re: /insufficient_quota/i, strong: true }, // openai error code
	{ kind: 'quota', re: /RESOURCE_EXHAUSTED/, strong: true }, // google
	{ kind: 'quota', re: /quota (?:has been )?(?:exhausted|exceeded)/i, strong: true },
	{ kind: 'quota', re: /usage limit (?:reached|exceeded)/i, strong: true },
	{ kind: 'quota', re: /out of (?:free )?credits/i, strong: true },
	// -- network (vendor unreachable) ------------------------------------------
	{ kind: 'network', re: /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/, strong: true },
	{ kind: 'network', re: /getaddrinfo/i, strong: true },
	{ kind: 'network', re: /network is unreachable/i, strong: true },
	{ kind: 'network', re: /\bfetch failed\b/i, strong: false },
	{ kind: 'network', re: /(?:unable|could not|failed) to connect/i, strong: false },
];

/** Precedence when several kinds match at once: sign-in beats billing beats pipes. */
const INFRA_PRECEDENCE: ReadonlyArray<HarnessInfraKind> = ['auth', 'quota', 'network'];

/**
 * Classifies one harness run's output as an infrastructure/precondition
 * failure — 'auth' | 'quota' | 'network' — or 'other' (a normal, retryable
 * failure). Pure; safe on any consumer of run output.
 *
 * Guards against false positives:
 *  - a ZERO exit with substantial output is a real agent answer, never infra
 *    (an agent explaining "set CURSOR_API_KEY" must not classify itself);
 *  - weak patterns (bare env-var names, generic connect words) require a
 *    non-zero exit; strong ones (exact vendor error sentences) do not, because
 *    some CLIs print the auth refusal and still exit 0.
 */
export function classifyHarnessFailure(
	output: string,
	exitCode: number | null,
): HarnessFailureKind {
	const tail = output.slice(-4000);
	if (!tail.trim()) {
		return 'other';
	}
	// A clean exit that produced a real answer (not just an error line).
	if (exitCode === 0 && output.length > 2000) {
		return 'other';
	}
	const failed = exitCode !== 0; // null (killed / never ran) counts as failed
	const matched = new Set<HarnessInfraKind>();
	for (const p of INFRA_PATTERNS) {
		if ((p.strong || failed) && p.re.test(tail)) {
			matched.add(p.kind);
		}
	}
	for (const kind of INFRA_PRECEDENCE) {
		if (matched.has(kind)) {
			return kind;
		}
	}
	return 'other';
}

/** Short state label per kind — used for issue/Flow surfaces and end labels. */
export const INFRA_BLOCK_LABELS: Readonly<Record<HarnessInfraKind, string>> = {
	auth: 'blocked: agent CLI needs login',
	quota: 'blocked: agent CLI quota exhausted',
	network: 'blocked: agent CLI cannot reach its service',
};

/** The one actionable remediation sentence for a blocked harness. */
export function harnessBlockRemediation(h: HarnessDef, kind: HarnessInfraKind): string {
	if (kind === 'auth') {
		return h.authRemediation ?? `Sign in to ${h.label} in a terminal, then retry the episode. ${h.postInstall}`;
	}
	if (kind === 'quota') {
		return `${h.label} reports its usage quota or credits are exhausted — resolve billing or wait for the quota to reset, then retry the episode.`;
	}
	return `${h.label} could not reach its service — check your network/VPN/proxy, then retry the episode.`;
}

/** A harness currently known to be unable to run (precondition failure). */
export interface HarnessBlock {
	kind: HarnessInfraKind;
	/** The remediation sentence shown to the user. */
	remediation: string;
}

// Session-scoped blocked registry. A block means "do not burn attempts, tests,
// or judges on this harness until the human acts" — it is NOT a permanent
// verdict: a later dispatch re-probes (or simply re-runs) and a success clears
// it, so re-dispatching the same issue after login proceeds fresh.
const harnessBlocks = new Map<string, HarnessBlock>();
// One notification per harness+kind per session — the remediation is the same
// whichever issue tripped it; repeating it per issue is noise, not signal.
const notifiedBlocks = new Set<string>();

/** The current block for a harness, if any. */
export function getHarnessBlock(harnessId: string): HarnessBlock | undefined {
	return harnessBlocks.get(harnessId);
}

/** Clears a harness's block (a successful run or probe proves it works). */
export function clearHarnessBlock(harnessId: string): void {
	harnessBlocks.delete(harnessId);
	preflightPassed.delete(harnessId); // a fresh dispatch re-establishes it
}

/**
 * Records a precondition failure for a harness and surfaces the remediation —
 * once per session per harness+kind, never per issue. Returns the block.
 */
export function markHarnessBlocked(
	harnessId: string,
	kind: HarnessInfraKind,
	options?: { notify?: boolean },
): HarnessBlock {
	const harness = getHarness(harnessId);
	const block: HarnessBlock = { kind, remediation: harnessBlockRemediation(harness, kind) };
	harnessBlocks.set(harnessId, block);
	preflightPassed.delete(harnessId);
	const noteKey = `${harnessId}:${kind}`;
	if ((options?.notify ?? true) && !notifiedBlocks.has(noteKey)) {
		notifiedBlocks.add(noteKey);
		void vscode.window.showErrorMessage(
			`Vinv: ${harness.label} cannot run — ${INFRA_BLOCK_LABELS[kind].replace('blocked: ', '')}. ${block.remediation}`,
		);
	}
	return block;
}

/** Test hook: wipes the session block/notification/preflight state. */
export function resetHarnessBlockStateForTests(): void {
	harnessBlocks.clear();
	notifiedBlocks.clear();
	preflightPassed.clear();
}

// Harness ids whose auth preflight passed this session — a passed probe is
// cached (auth state rarely regresses mid-session); a FAILED probe is never
// cached, so the first dispatch after the human logs in re-probes and proceeds.
const preflightPassed = new Set<string>();

/** Wall-clock cap for one auth probe — it must stay cheap. */
const AUTH_PROBE_TIMEOUT_MS = 10_000;

/**
 * Cheap auth preflight for a harness: where the vendor ships a status probe
 * (see authProbeArgs), run it BEFORE spending any dispatch/test/judge work.
 * Resolves 'ok' when the harness can be dispatched (probe passed, no probe
 * exists, CLI missing — the missing-CLI path has its own message) and the
 * infra kind when the probe proves the precondition failure. A failed probe
 * marks the session block (notifying once); a passed probe clears it.
 */
export async function preflightHarnessAuth(harnessId: string): Promise<'ok' | HarnessInfraKind> {
	const harness = getHarness(harnessId);
	if (harness.kind !== 'cli' || !harness.bin || !harness.authProbeArgs?.length) {
		// No probe exists: never keep a stale block standing in the way of a
		// fresh dispatch — the run itself re-classifies in one cheap failure.
		harnessBlocks.delete(harnessId);
		return 'ok';
	}
	if (preflightPassed.has(harnessId)) {
		return 'ok';
	}
	const exe = resolveHarnessCli(harness);
	if (!exe) {
		return 'ok'; // missing CLI is handled by the existing install-hint paths
	}
	const probe = await new Promise<{ code: number | null; output: string }>((resolve) => {
		let out = '';
		let settled = false;
		const settle = (code: number | null) => {
			if (!settled) {
				settled = true;
				resolve({ code, output: out });
			}
		};
		try {
			const child = spawn(
				`"${exe}" ${harness.authProbeArgs!.join(' ')}`,
				hiddenBackgroundOptions({ shell: true, env: process.env }),
			);
			const timer = setTimeout(() => {
				killProcessTree(child, 'SIGKILL');
				settle(null);
			}, AUTH_PROBE_TIMEOUT_MS);
			const absorb = (c: string) => (out = (out + c).slice(-8000));
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', absorb);
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', absorb);
			child.on('error', () => {
				clearTimeout(timer);
				settle(null);
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				settle(code);
			});
		} catch {
			settle(null);
		}
	});
	if (probe.code !== 0) {
		const kind = classifyHarnessFailure(probe.output, probe.code);
		if (kind !== 'other') {
			markHarnessBlocked(harnessId, kind);
			return kind;
		}
		// Probe failed for an unrelated reason (unknown subcommand on an older
		// CLI, timeout): inconclusive — let the dispatch itself decide.
		harnessBlocks.delete(harnessId);
		return 'ok';
	}
	preflightPassed.add(harnessId);
	harnessBlocks.delete(harnessId);
	return 'ok';
}

/**
 * True when Vinv can kick off this harness's install from inside the editor:
 * CLI harnesses that declare an install command, plus ide-chat harnesses whose
 * only missing piece is an extension this editor family can install (a Cursor
 * deeplink panel can never be installed into VS Code, so those stay false).
 */
export function canInstallHarness(h: HarnessDef): boolean {
	if (h.kind === 'cli') {
		return !!h.installCommand;
	}
	return !!(
		h.chat?.requiresExtension &&
		(!h.chat.appPattern || h.chat.appPattern.test(vscode.env.appName))
	);
}

/**
 * Kicks off the install and returns immediately — completion is observed by
 * re-running quickScanHarnesses(), not by this call. CLI installs run visibly
 * in a fresh integrated terminal (the user watches npm work and signs in right
 * there afterwards); extension-backed chat panels go through the editor's own
 * extension installer.
 */
export function startHarnessInstall(h: HarnessDef): void {
	if (h.kind === 'cli' && h.installCommand) {
		// The command matches the platform (PowerShell installers on Windows,
		// curl|bash elsewhere) — so pin the shell too: the user's default
		// integrated terminal may be cmd/Git Bash on Windows, where `irm|iex`
		// would fail. Elsewhere the default shell is POSIX and curl|bash runs.
		const term = vscode.window.createTerminal({
			name: `Install ${h.label}`,
			shellPath: IS_WINDOWS ? 'powershell.exe' : undefined,
		});
		term.show();
		term.sendText(h.installCommand, true);
		return;
	}
	if (h.chat?.requiresExtension) {
		void vscode.commands.executeCommand(
			'workbench.extensions.installExtension',
			h.chat.requiresExtension,
		);
	}
}

/**
 * Directories where agent CLIs commonly land but which are often missing from
 * the extension host's PATH — a GUI-launched VS Code does not read the user's
 * shell profile, so "works in my terminal" and "visible to the extension"
 * regularly disagree. Checked after PATH, in this order.
 */
function wellKnownBinDirs(): string[] {
	const home = os.homedir();
	const dirs = [path.join(home, '.local', 'bin')]; // native installers (claude, cursor-agent)
	if (process.platform === 'win32') {
		if (process.env.APPDATA) {
			dirs.push(path.join(process.env.APPDATA, 'npm')); // npm -g shims (claude.cmd, …)
		}
	} else {
		dirs.push(
			'/usr/local/bin',
			'/opt/homebrew/bin',
			path.join(home, '.npm-global', 'bin'),
			path.join(home, 'bin'),
		);
		// nvm keeps each node version's global bin in its own dir.
		const nvm = path.join(home, '.nvm', 'versions', 'node');
		try {
			for (const v of fs.readdirSync(nvm)) {
				dirs.push(path.join(nvm, v, 'bin'));
			}
		} catch {
			// No nvm — fine.
		}
	}
	return dirs;
}

/**
 * Resolves a CLI name to an absolute executable path, searching PATH first and
 * then the well-known install dirs. Returns null when nothing is found. On
 * Windows, npm shims are .cmd files, so common PATHEXT variants are tried.
 */
export function findHarnessCli(bin: string): string | null {
	const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
	const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
	for (const dir of [...pathDirs, ...wellKnownBinDirs()]) {
		for (const ext of exts) {
			const candidate = path.join(dir, bin + ext);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				if (fs.statSync(candidate).isFile()) {
					return candidate;
				}
			} catch {
				// Keep looking.
			}
		}
	}
	return null;
}

/** Resolves a harness's executable, trying its primary name then any alternates. */
export function resolveHarnessCli(h: HarnessDef): string | null {
	for (const bin of [h.bin, ...(h.altBins ?? [])]) {
		if (!bin) {
			continue;
		}
		const exe = findHarnessCli(bin);
		if (exe) {
			return exe;
		}
	}
	return null;
}

/** Availability report for one harness, shown live in the Configure panel. */
export interface HarnessAvailability {
	ok: boolean;
	/** "Found: <path> (<version>)" or the reason + install hint. */
	detail: string;
}

/**
 * Checks whether a harness's CLI is actually runnable from the extension host:
 * resolves the executable (PATH + well-known dirs) and probes `--version`.
 * A resolved binary whose version probe fails is still reported ok — some CLIs
 * gate --version behind login — the path existing is the signal that matters.
 */
export async function checkHarnessAvailability(id: string): Promise<HarnessAvailability> {
	const h = getHarness(id);
	if (h.kind === 'ide-chat') {
		return isIdeChatAvailable(h)
			? {
					ok: true,
					detail: h.chat?.autoSubmit
						? `Available in this ${vscode.env.appName} window`
						: `Available in this ${vscode.env.appName} window — this editor blocks programmatic submission, so Vinv auto-sends with a guarded OS keystroke (best effort; falls back to you pressing Enter)`,
				}
			: { ok: false, detail: h.installHint };
	}
	if (!h.bin) {
		return { ok: false, detail: h.installHint };
	}
	const exe = resolveHarnessCli(h);
	if (!exe) {
		return {
			ok: false,
			detail: `The '${h.bin}' CLI was not found (searched PATH and common install dirs). ${h.installHint}`,
		};
	}
	const version = await new Promise<string>((resolve) => {
		let out = '';
		try {
			const child = spawn(`"${exe}" --version`, { shell: true, windowsHide: true });
			const timer = setTimeout(() => {
				try {
					child.kill();
				} catch {
					// Already gone.
				}
				resolve('');
			}, 5000);
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (c: string) => (out += c));
			child.on('error', () => {
				clearTimeout(timer);
				resolve('');
			});
			child.on('close', () => {
				clearTimeout(timer);
				resolve(out.trim().split('\n')[0] ?? '');
			});
		} catch {
			resolve('');
		}
	});
	return { ok: true, detail: version ? `Found ${exe} (${version})` : `Found ${exe}` };
}

/**
 * Probes every harness at once (for the Configure panel's installed/not-installed
 * option labels). Version probes run in parallel; a slow CLI can't block the rest
 * beyond its own 5s cap.
 */
export async function checkAllHarnesses(): Promise<Record<string, HarnessAvailability>> {
	const entries = await Promise.all(
		HARNESSES.map(async (h) => [h.id, await checkHarnessAvailability(h.id)] as const),
	);
	return Object.fromEntries(entries);
}

/**
 * Cheap presence-only scan (filesystem stats, no child processes) used to poll
 * for install-state changes while the Configure panel is open. Compare two
 * snapshots to decide whether the full (version-probing) sweep is worth re-running.
 */
export function quickScanHarnesses(): Record<string, boolean> {
	return Object.fromEntries(
		HARNESSES.map((h) => [
			h.id,
			h.kind === 'ide-chat' ? isIdeChatAvailable(h) : h.bin ? resolveHarnessCli(h) !== null : false,
		]),
	);
}

/** A point-in-time harness progress update (same shape the engine runners emit). */
export interface HarnessProgress {
	percent: number | null;
	label: string;
}

/**
 * Renders one engine's agent prompt by running it with `--print-prompt
 * --portable` — no LLM calls happen; stdout is the full task instruction for a
 * foreign coding agent. Rejects on a non-zero exit (e.g. bring-up prompts
 * require .vinv/vinv.md to already exist).
 */
function fetchInstructionPrompt(
	binPath: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(binPath, [...args, '--print-prompt', '--portable'], { cwd, env, windowsHide: true });
		let out = '';
		let err = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (c: string) => (out += c));
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (c: string) => (err += c));
		child.on('error', (e) => reject(new Error(`could not run ${path.basename(binPath)}: ${e.message}`)));
		child.on('close', (code) => {
			if (code !== 0) {
				const detail = err.trim().split('\n').pop() ?? '';
				reject(new Error(`${path.basename(binPath)} --print-prompt exited with code ${code}${detail ? `: ${detail}` : ''}`));
			} else if (!out.trim()) {
				reject(new Error(`${path.basename(binPath)} produced an empty prompt`));
			} else {
				resolve(out);
			}
		});
	});
}

/** Directory holding per-run harness trajectory logs: <workspace>/.vinv/logs */
function getLogDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'logs');
}

/** Absolute path to a harness run's trajectory log. */
export function getHarnessLogPath(workspaceRoot: string, name: string): string {
	return path.join(getLogDir(workspaceRoot), `harness-${name}.log`);
}

/** Opens (truncating) the trajectory log for a harness run. Best-effort. */
function openTrajectoryLog(
	workspaceRoot: string,
	name: string,
	command: string,
): fs.WriteStream | null {
	try {
		fs.mkdirSync(getLogDir(workspaceRoot), { recursive: true });
		const stream = fs.createWriteStream(getHarnessLogPath(workspaceRoot, name), { flags: 'w' });
		stream.write(`# ${new Date().toISOString()}  ${command}\n\n`);
		return stream;
	} catch {
		return null;
	}
}

interface HarnessTask {
	/** Log-file suffix and progress noun, e.g. 'handbook' or 'bringup-list'. */
	name: string;
	/** Notification title, e.g. 'Vinv: Generating handbook via Claude Code…'. */
	title: string;
	/** Engine binary that renders the instruction ('handbook' or 'bringup'). */
	promptBin: string;
	/** Engine args before --print-prompt --portable (e.g. ['generate', ws]). */
	promptArgs: string[];
	/** Env for the prompt render (engine + tracelens paths). */
	promptEnv: NodeJS.ProcessEnv;
	/** True when the deliverable file the agent must create exists and is valid. */
	deliverableReady: () => boolean;
	/** Human name of the deliverable for error messages. */
	deliverableDesc: string;
}

// How many harness runs this window has in flight.
//
// This used to be a boolean that also GATED dispatch: one run at a time,
// because every agent shared the workspace tree and would corrupt the others'
// snapshot, revert and reward diff. Isolation replaced that — each trigger
// works in its own git worktree (harness/runIsolation), so concurrent agents
// cannot see each other's edits and there is nothing left to serialize.
//
// A counter, not a flag, because runs genuinely overlap now: with a boolean,
// the first to finish cleared it while the rest were still going and
// isHarnessBusy() would report idle mid-flight. It is INFORMATIONAL only —
// nothing refuses to start on it.
let inFlight = 0;

/** How many harness runs are in flight in this window. */
export function harnessRunsInFlight(): number {
	return inFlight;
}

/** True when at least one harness run is in flight. Never gates a dispatch. */
export function isHarnessBusy(): boolean {
	return inFlight > 0;
}

/** Outcome of one raw prompt dispatch to a harness CLI. */
export interface HarnessRunResult {
	ok: boolean;
	exitCode: number | null;
	/** Everything the CLI printed (the agent's final answer in -p/exec modes). */
	stdout: string;
	/** Human-readable failure reason when ok is false. */
	detail?: string;
	/**
	 * Set when the failure is an infrastructure PRECONDITION (CLI not signed
	 * in, quota exhausted, vendor unreachable) that no retry, stall judge, or
	 * pack mutation can fix. Consumers must treat it as terminal on the first
	 * occurrence: end the work as infra-blocked (objective:false — never
	 * composition-failure evidence) and surface `detail` (the remediation).
	 */
	infra?: HarnessInfraKind;
}

/**
 * Low-level dispatch shared by QnA answers and harness episodes: pipe an
 * arbitrary prompt into the selected coding-agent CLI headlessly and collect
 * its stdout. Honors the same single-flight lock as the engine-driven tasks —
 * two agents in one workspace fight over installs, ports and git state.
 * Output is tee'd to .vinv/logs/harness-<name>.log for post-mortems.
 */
/** Wall-clock bound for one verification-agent harness reply (env-tunable). */
function agentDispatchTimeoutMs(): number {
	const raw = Number.parseFloat(process.env.VINV_AGENT_TIMEOUT_S ?? '300');
	return (Number.isFinite(raw) && raw > 0 ? raw : 300) * 1000;
}

/**
 * Lock-free, headless dispatch for the VERIFICATION agents (audit judge, test
 * authors, stall judge, goal suggestion): the goal engine renders a prompt
 * that ends with the JSON schema the reply must contain, and this function
 * pipes it into the selected coding-agent CLI and returns the reply text.
 *
 * Deliberately NOT runHarnessPrompt: it takes no part in the single-flight
 * lock (test authors fan out N in parallel, and the audit judge runs while an
 * episode owns the lock), it never shows UI, and every failure — ide-chat
 * harness (no headless channel), missing CLI, timeout, empty reply — resolves
 * null so callers degrade to their "agent unavailable" safe paths.
 */
export function dispatchAgentPrompt(
	harnessId: string,
	workspaceRoot: string,
	name: string,
	prompt: string,
	// The isolated tree this trigger works in (see harness/runIsolation). Only
	// the AGENT moves — workspaceRoot still anchors logs and .vinv state, so
	// trajectories and learning records stay in one place per workspace while
	// the edits land in one tree per trigger.
	cwd?: string,
): Promise<string | null> {
	const harness = getHarness(harnessId);
	if (harness.kind !== 'cli' || !harness.bin) {
		return Promise.resolve(null);
	}
	// A blocked harness (needs login / quota / network) cannot answer — resolve
	// null immediately so verification agents degrade to their safe paths
	// instead of fanning out N doomed spawns. The block is cleared by a later
	// successful run or preflight, so this never outlives the precondition.
	if (getHarnessBlock(harnessId)) {
		return Promise.resolve(null);
	}
	const exe = resolveHarnessCli(harness);
	if (!exe) {
		return Promise.resolve(null);
	}
	const commandLine = `"${exe}" ${harness.args}`;
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		PATH: [path.dirname(exe), ...wellKnownBinDirs(), process.env.PATH ?? '']
			.filter(Boolean)
			.join(path.delimiter),
		// Python children (pytest, uvicorn, the exerciser) block-buffer stdout
		// when piped, which starves the silence watchdog for minutes at a time
		// on long batches — the run LOOKS hung while working. Root-caused live:
		// a 17-cluster verification produced zero output for 120s and was
		// killed as hung. Unbuffered children keep the cadence signal honest.
		PYTHONUNBUFFERED: '1',
	};
	return new Promise<string | null>((resolve) => {
		let settled = false;
		const settle = (value: string | null) => {
			if (!settled) {
				settled = true;
				log?.end();
				resolve(value);
			}
		};
		const log = openTrajectoryLog(workspaceRoot, `agent-${name}`, commandLine);
		let child;
		try {
			child = spawn(commandLine, hiddenBackgroundOptions({
				cwd: cwd ?? workspaceRoot,
				env: childEnv,
				shell: true,
			}));
		} catch {
			settle(null);
			return;
		}
		child.stdin?.on('error', () => {});
		child.stdin?.write(prompt);
		child.stdin?.end();

		let out = '';
		let resultText: string | null = null;
		let assistantText = '';
		let pending = '';
		const decode = (line: string): void => {
			if (harness.stream !== 'claude-stream-json') {
				return;
			}
			try {
				const ev = JSON.parse(line) as {
					type?: string;
					message?: { content?: Array<{ type?: string; text?: unknown }> };
					result?: unknown;
				};
				if (ev.type === 'assistant') {
					for (const block of ev.message?.content ?? []) {
						if (block.type === 'text' && typeof block.text === 'string') {
							assistantText += block.text + '\n';
						}
					}
				} else if (ev.type === 'result' && typeof ev.result === 'string') {
					resultText = ev.result;
				}
			} catch {
				// Not an event line — ignore for decoding (kept in `out`).
			}
		};
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			log?.write(chunk);
			out = (out + chunk).slice(-400_000);
			pending += chunk;
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				decode(line);
			}
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => log?.write(chunk));

		const timer = setTimeout(() => {
			killProcessTree(child, 'SIGKILL');
			settle(null);
		}, agentDispatchTimeoutMs());
		child.on('error', () => {
			clearTimeout(timer);
			settle(null);
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			if (pending) {
				decode(pending);
			}
			// One doomed spawn is enough: classify precondition failures here so
			// the session block short-circuits every sibling agent immediately.
			const infra = classifyHarnessFailure(out, code);
			if (infra !== 'other') {
				markHarnessBlocked(harnessId, infra);
				settle(null);
				return;
			}
			const answer =
				harness.stream === 'claude-stream-json'
					? (resultText ?? (assistantText.trim() || ''))
					: out.trim();
			settle(answer ? answer : null);
		});
	});
}

export async function runHarnessPrompt(
	harnessId: string,
	workspaceRoot: string,
	name: string,
	prompt: string,
	options?: {
		onUpdate?: (line: string) => void;
		token?: vscode.CancellationToken;
		/** Isolated tree for this trigger; defaults to the workspace itself. */
		cwd?: string;
	},
): Promise<HarnessRunResult> {
	const harness = getHarness(harnessId);
	if (harness.kind === 'ide-chat') {
		if (!isIdeChatAvailable(harness)) {
			return {
				ok: false,
				exitCode: null,
				stdout: '',
				detail: `${harness.label} is not reachable from this window. ${harness.installHint}`,
			};
		}
		inFlight += 1;
		try {
			return await runIdeChatPrompt(harness, workspaceRoot, name, prompt, options);
		} finally {
			inFlight = Math.max(0, inFlight - 1);
		}
	}
	if (!harness.bin) {
		return {
			ok: false,
			exitCode: null,
			stdout: '',
			detail: `${harness.label} cannot run headless tasks. ${harness.installHint}`,
		};
	}
	const exe = resolveHarnessCli(harness);
	if (!exe) {
		return {
			ok: false,
			exitCode: null,
			stdout: '',
			detail: `The ${harness.label} CLI ('${harness.bin}') was not found. ${harness.installHint}`,
		};
	}
	// Known-blocked harness (auth/quota/network precondition): re-probe cheaply
	// instead of burning a dispatch. Failed probes are never cached, so the
	// first dispatch after the human logs in re-probes, passes, and proceeds
	// fresh — blocked is a state, not a dedup.
	if (getHarnessBlock(harnessId)) {
		await preflightHarnessAuth(harnessId);
		const block = getHarnessBlock(harnessId);
		if (block) {
			return {
				ok: false,
				exitCode: null,
				stdout: '',
				detail: block.remediation,
				infra: block.kind,
			};
		}
	}
	const commandLine = `"${exe}" ${harness.args}`;
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		PATH: [path.dirname(exe), ...wellKnownBinDirs(), process.env.PATH ?? '']
			.filter(Boolean)
			.join(path.delimiter),
		// Python children (pytest, uvicorn, the exerciser) block-buffer stdout
		// when piped, which starves the silence watchdog for minutes at a time
		// on long batches — the run LOOKS hung while working. Root-caused live:
		// a 17-cluster verification produced zero output for 120s and was
		// killed as hung. Unbuffered children keep the cadence signal honest.
		PYTHONUNBUFFERED: '1',
	};
	inFlight += 1;
	return new Promise<HarnessRunResult>((resolve) => {
		const log = openTrajectoryLog(workspaceRoot, name, commandLine);
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(commandLine, hiddenBackgroundOptions({
				cwd: options?.cwd ?? workspaceRoot,
				env: childEnv,
				shell: true,
			}));
		} catch (e) {
			// spawn can throw SYNCHRONOUSLY (bad cwd, EMFILE, a disconnected network
			// drive). `running` is set above and is only cleared in settle(), so an
			// unguarded throw here wedges isHarnessBusy() true for the whole session
			// and every later episode reports "another harness run is in progress".
			inFlight = Math.max(0, inFlight - 1);
			log?.end();
			resolve({
				ok: false,
				exitCode: null,
				stdout: '',
				detail: `failed to spawn harness: ${e instanceof Error ? e.message : String(e)}`,
			});
			return;
		}
		child.stdin?.on('error', () => {});
		child.stdin?.write(prompt);
		child.stdin?.end();

		const cancel = () => {
			killProcessTree(child, 'SIGTERM');
			setTimeout(() => killProcessTree(child, 'SIGKILL'), 2000);
		};
		const cancelReg = options?.token?.onCancellationRequested(cancel);

		let out = '';
		let lastLine = '';
		// claude-stream-json decode state: the final `result` envelope is the
		// run's answer; accumulated assistant text is the fallback when the
		// envelope never arrives (crash, cancellation).
		let resultText: string | null = null;
		let assistantText = '';
		interface StreamBlock {
			type?: string;
			text?: unknown;
			thinking?: unknown;
			name?: unknown;
			input?: unknown;
		}
		const decodeStreamJson = (line: string): string[] => {
			let ev: { type?: string; message?: { content?: StreamBlock[] }; result?: unknown };
			try {
				ev = JSON.parse(line);
			} catch {
				// Not an event — CLI warnings and stderr errors stay visible.
				return [line];
			}
			if (ev.type === 'assistant') {
				const human: string[] = [];
				for (const block of ev.message?.content ?? []) {
					if (block.type === 'text' && typeof block.text === 'string') {
						assistantText += block.text + '\n';
						human.push(...block.text.split('\n'));
					} else if (block.type === 'thinking' && typeof block.thinking === 'string') {
						human.push(...block.thinking.split('\n'));
					} else if (block.type === 'tool_use') {
						const args = JSON.stringify(block.input ?? {}).replace(/\s+/g, ' ');
						human.push(`→ ${String(block.name ?? 'tool')} ${args.slice(0, 120)}`);
					}
				}
				return human;
			}
			if (ev.type === 'result' && typeof ev.result === 'string') {
				resultText = ev.result;
			}
			// result / system-init / user (tool-result) envelopes: not feed material.
			return [];
		};
		// The text callers treat as the agent's final answer (directive parsing,
		// dispute evidence, QnA rendering): for stream-json harnesses that is the
		// decoded result, never the raw event JSON.
		const answerText = () => {
			if (harness.stream !== 'claude-stream-json') {
				return out;
			}
			return resultText ?? (assistantText.trim() || out);
		};
		// Line-buffered: a chunk boundary is not a line boundary, so partial
		// lines are held back and every COMPLETE line is emitted. Taking only
		// the chunk's tail (the previous behaviour) silently dropped whole
		// lines whenever the agent wrote a burst — fine for a one-line progress
		// label, but it is also the live thinking feed the chat renders.
		let pending = '';
		const emit = (raw: string) => {
			const line = raw.trim();
			if (!line) {
				return;
			}
			const human = harness.stream === 'claude-stream-json' ? decodeStreamJson(line) : [line];
			for (const h of human) {
				const t = h.trim();
				if (!t) {
					continue;
				}
				// Two consumers, two needs. `lastLine` is a ONE-LINE status label
				// (progress toast, log tail) and must stay short. `onUpdate` is the
				// live thinking feed the chat transcript renders, and must get the
				// line WHOLE — capping it there chopped every sentence the agent
				// wrote at 160 chars, mid-word, with no ellipsis. The operator read
				// a mangled answer and reasonably concluded the run was broken.
				lastLine = t.length > 160 ? `${t.slice(0, 159)}…` : t;
				observeLineForLoop(t);
				options?.onUpdate?.(t);
			}
		};
		// ---- harness-failure detectors (channel-level, repo-independent) ----
		// The docx's complaint #4 (harness terminal hangs, stuck agents) cannot
		// be fixed INSIDE the harness, but it is detectable from the dispatch
		// channel with high accuracy:
		// (1) SILENCE WATCHDOG — φ-accrual-inspired: the hang threshold adapts
		//     to THIS run's own observed output cadence (max observed gap × a
		//     multiplier, floored/ceilinged) instead of a fixed timeout, so a
		//     chatty harness is caught in minutes while a legitimately slow one
		//     is not killed. A tripped watchdog is INFRA (objective:false
		//     downstream), never oracle evidence.
		// (2) DOOM-LOOP GUARD — token-set self-similarity across consecutive
		//     output windows; only unambiguous repetition (6 consecutive
		//     near-identical 40-line windows ≈ 240 lines) trips it, warning at
		//     3 — build logs and test output stay safely below.
		let lastOutputMs = Date.now();
		let maxGapMs = 0;
		const silenceFloorMs = 120_000;
		const silenceCeilingMs =
			(Number.parseFloat(process.env.VINV_HARNESS_SILENCE_CEILING_S ?? '900') || 900) * 1000;
		let windowLines: string[] = [];
		let previousWindow = '';
		let loopStreak = 0;
		const watchdog = setInterval(() => {
			if (settled) {
				return;
			}
			const silence = Date.now() - lastOutputMs;
			// Before the FIRST byte of output there is no cadence to adapt to
			// (maxGap is still 0, so the adaptive threshold collapses to the
			// floor) — but startup is exactly when long legitimate silences
			// happen: CLI auth, model spin-up, tool discovery. Give the first
			// output a distinct, longer grace instead of judging it by a
			// cadence that does not exist yet. Root-caused live: "largest
			// prior gap was 0s" killing a working 17-cluster verification at
			// the 120s floor.
			const startupGraceMs = Math.min(
				silenceCeilingMs,
				(Number.parseFloat(process.env.VINV_HARNESS_STARTUP_GRACE_S ?? '300') || 300) * 1000,
			);
			const adaptive = maxGapMs === 0
				? startupGraceMs
				: Math.min(silenceCeilingMs, Math.max(silenceFloorMs, maxGapMs * 6));
			if (silence >= adaptive) {
				options?.onUpdate?.(
					`⚠ harness watchdog: no output for ${Math.round(silence / 1000)}s — treating the run as hung`,
				);
				cancel();
				settle({
					ok: false,
					exitCode: null,
					stdout: answerText(),
					detail: `harness produced no output for ${Math.round(silence / 1000)}s (adaptive watchdog; this run's largest prior gap was ${Math.round(maxGapMs / 1000)}s) — run treated as hung`,
				});
			}
		}, 15_000);
		const observeLineForLoop = (t: string) => {
			windowLines.push(t);
			if (windowLines.length < 40) {
				return;
			}
			// Counters/timestamps vary every iteration of a genuine loop —
			// normalize digits so "attempt 17 failed" and "attempt 18 failed"
			// compare as the same shape (found live: raw token sets let a
			// counter hold similarity below any sane threshold).
			const window = windowLines.join('\n').replace(/\d+/g, '#');
			windowLines = [];
			const similarity = previousWindow ? evidenceSimilarity(previousWindow, window) : 0;
			previousWindow = window;
			if (similarity >= 0.92) {
				loopStreak += 1;
				if (loopStreak === 3) {
					options?.onUpdate?.(
						'⚠ the agent appears to be repeating itself (doom-loop guard warning)',
					);
				}
				if (loopStreak >= 6) {
					cancel();
					settle({
						ok: false,
						exitCode: null,
						stdout: answerText(),
						detail:
							'harness output looped: 6 consecutive near-identical output windows (self-similarity ≥ 0.92) — stopped early to save the attempt budget (doom-loop guard)',
					});
				}
			} else {
				loopStreak = 0;
			}
		};
		const onData = (chunk: string) => {
			const now = Date.now();
			maxGapMs = Math.max(maxGapMs, now - lastOutputMs);
			lastOutputMs = now;
			log?.write(chunk);
			// Bounded like the sibling reader in dispatchAgentPrompt: this is fed by
			// BOTH stdout and stderr, and a long `--verbose stream-json` run otherwise
			// grows one unbounded V8 string until the extension host OOMs. The full
			// transcript is already on disk in the trajectory log.
			out = (out + chunk).slice(-400_000);
			pending += chunk;
			const lines = pending.split('\n');
			// The tail is whatever follows the last newline — an incomplete line
			// that the next chunk continues (or the flush below completes).
			pending = lines.pop() ?? '';
			for (const line of lines) {
				emit(line);
			}
		};
		// Output that never ends in a newline still has to reach `lastLine` —
		// it is the failure detail reported on a non-zero exit.
		const flush = () => {
			const tail = pending;
			pending = '';
			emit(tail);
		};
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', onData);
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', onData);

		let settled = false;
		const settle = (result: HarnessRunResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearInterval(watchdog);
			cancelReg?.dispose();
			log?.end();
			inFlight = Math.max(0, inFlight - 1);
			resolve(result);
		};
		child.on('error', (err) => {
			flush();
			settle({ ok: false, exitCode: null, stdout: answerText(), detail: err.message });
		});
		child.on('close', (code) => {
			flush();
			if (options?.token?.isCancellationRequested) {
				settle({ ok: false, exitCode: code, stdout: answerText(), detail: 'cancelled' });
				return;
			}
			// Precondition failures (not signed in, quota, vendor unreachable)
			// classify from the RAW channel output — some CLIs print the refusal
			// and still exit 0, and a stream-json refusal is a bare error line.
			// Terminal for every consumer; the detail is the remediation.
			const infra = classifyHarnessFailure(out, code);
			if (infra !== 'other') {
				const block = markHarnessBlocked(harnessId, infra);
				settle({
					ok: false,
					exitCode: code,
					stdout: answerText(),
					detail: block.remediation,
					infra,
				});
			} else if (code !== 0) {
				settle({
					ok: false,
					exitCode: code,
					stdout: answerText(),
					detail: lastLine || `exited with code ${code ?? 'null'}`,
				});
			} else {
				// A genuine success proves the precondition holds again.
				if (getHarnessBlock(harnessId)) {
					clearHarnessBlock(harnessId);
				}
				settle({ ok: true, exitCode: 0, stdout: answerText() });
			}
		});
	});
}

/**
 * Runs one LLM-requiring instruction through the selected coding harness:
 *   1. fetch the instruction prompt from the engine binary (--print-prompt
 *      --portable — no LLM calls),
 *   2. pipe it into the harness CLI headlessly (prompt via stdin, cwd = repo),
 *   3. wait for the CLI to finish and require the final deliverable file.
 *
 * Resolves true only when the harness exits cleanly *and* the deliverable landed
 * on disk. Output is tee'd to .vinv/logs/harness-<name>.log.
 */
async function runHarnessTask(
	harnessId: string,
	workspaceRoot: string,
	task: HarnessTask,
	onProgress?: (p: HarnessProgress) => void,
	extToken?: vscode.CancellationToken,
	/** Isolated tree for this trigger; defaults to the workspace itself. */
	cwd?: string,
): Promise<boolean> {
	const harness = getHarness(harnessId);
	let exe: string | null = null;
	if (harness.kind === 'ide-chat') {
		if (!isIdeChatAvailable(harness)) {
			void vscode.window.showErrorMessage(
				`Vinv: ${harness.label} is not reachable from this window. ${harness.installHint}`,
			);
			return false;
		}
	} else {
		if (!harness.bin) {
			void vscode.window.showErrorMessage(
				`Vinv: ${harness.label} cannot run headless tasks. ${harness.installHint}`,
			);
			return false;
		}
		// Preflight: resolve the CLI before doing any work, so a missing install
		// fails in one actionable message instead of an opaque mid-run exit code.
		exe = resolveHarnessCli(harness);
		if (!exe) {
			void vscode.window.showErrorMessage(
				`Vinv: The ${harness.label} CLI ('${harness.bin}') was not found on this machine. ${harness.installHint}`,
			);
			return false;
		}
		// Auth preflight: a signed-out CLI can never produce the deliverable —
		// skip the dispatch entirely (markHarnessBlocked already surfaced the
		// remediation once this session).
		if ((await preflightHarnessAuth(harnessId)) !== 'ok') {
			return false;
		}
	}
	// Spawning by absolute path sidesteps a broken PATH; the quoted form also
	// survives spaces in the install dir. Prepend the CLI's own dir (and the
	// well-known dirs) to PATH so the shim can find its node/runtime.
	const commandLine = exe ? `"${exe}" ${harness.args}` : '';
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		PATH: [exe ? path.dirname(exe) : '', ...wellKnownBinDirs(), process.env.PATH ?? '']
			.filter(Boolean)
			.join(path.delimiter),
		PYTHONUNBUFFERED: '1',
	};

	inFlight += 1;
	try {
		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: task.title,
				cancellable: true,
			},
			async (progress, token) => {
				const report = (label: string) => {
					progress.report({ message: label });
					onProgress?.({ percent: null, label });
				};

				report('Fetching instructions…');
				let prompt: string;
				try {
					prompt = await fetchInstructionPrompt(
						task.promptBin,
						task.promptArgs,
						task.promptEnv,
						workspaceRoot,
					);
				} catch (e) {
					const err = e instanceof Error ? e.message : String(e);
					void vscode.window.showErrorMessage(`Vinv: Could not fetch instructions. ${err}`);
					return false;
				}

				// IDE-chat hand-off: the panel's agent does the work; success is
				// still judged on the deliverable landing, exactly like the CLI path.
				if (harness.kind === 'ide-chat') {
					report(`Handing instructions to ${harness.label}…`);
					const cts = new vscode.CancellationTokenSource();
					token.onCancellationRequested(() => cts.cancel());
					extToken?.onCancellationRequested(() => cts.cancel());
					try {
						const run = await runIdeChatPrompt(harness, workspaceRoot, task.name, prompt, {
							token: cts.token,
							onUpdate: (line) => report(line),
						});
						if (!run.ok) {
							if (!cts.token.isCancellationRequested) {
								void vscode.window.showErrorMessage(
									`Vinv: ${harness.label} hand-off failed. ${run.detail ?? ''}`,
								);
							}
							return false;
						}
						if (!task.deliverableReady()) {
							void vscode.window.showErrorMessage(
								`Vinv: ${harness.label} finished but did not create ${task.deliverableDesc}.`,
							);
							return false;
						}
						onProgress?.({ percent: 100, label: `${task.deliverableDesc} ready` });
						return true;
					} finally {
						cts.dispose();
					}
				}

				return await new Promise<boolean>((resolve) => {
					const log = openTrajectoryLog(workspaceRoot, task.name, commandLine);
					// shell:true runs .cmd shims on Windows; the prompt travels via
					// stdin, so nothing needs shell-escaping.
					const child = spawn(commandLine, hiddenBackgroundOptions({
						cwd: cwd ?? workspaceRoot,
						env: childEnv,
						shell: true,
					}));
					// If the CLI is missing the shell dies before reading stdin — swallow
					// the resulting EPIPE; the close handler reports the real failure.
					child.stdin?.on('error', () => {});
					child.stdin?.write(prompt);
					child.stdin?.end();

					const killTree = (signal: NodeJS.Signals) => killProcessTree(child, signal);
					const cancel = () => {
						killTree('SIGTERM');
						setTimeout(() => killTree('SIGKILL'), 2000);
					};
					const extCancelReg = extToken?.onCancellationRequested(cancel);
					token.onCancellationRequested(cancel);

					let chunks = 0;
					let lastLine = '';
					// Classification ring: the last 4000 chars of raw output, so a
					// precondition refusal (auth/quota/network) is recognized on close.
					let tailRing = '';
					const onData = (chunk: string) => {
						log?.write(chunk);
						chunks += 1;
						tailRing = (tailRing + chunk).slice(-4000);
						const line = chunk.trim().split('\n').pop() ?? '';
						if (line) {
							// Status label only — marked when clipped, never silently.
							lastLine = line.length > 120 ? `${line.slice(0, 119)}…` : line;
						}
						report(`${harness.label} working… (update ${chunks})`);
					};
					child.stdout?.setEncoding('utf8');
					child.stdout?.on('data', onData);
					child.stderr?.setEncoding('utf8');
					child.stderr?.on('data', onData);

					let settled = false;
					const settle = (ok: boolean, detail?: string) => {
						if (settled) {
							return;
						}
						settled = true;
						extCancelReg?.dispose();
						log?.end();
						if (ok) {
							onProgress?.({ percent: 100, label: `${task.deliverableDesc} ready` });
						} else if (!token.isCancellationRequested && !extToken?.isCancellationRequested) {
							void vscode.window.showErrorMessage(
								`Vinv: ${harness.label} run failed. ${detail ?? ''} (see ${getHarnessLogPath(workspaceRoot, task.name)})`,
							);
						}
						resolve(ok);
					};

					report(`Sending instructions to ${harness.label}…`);
					child.on('error', (err) => settle(false, err.message));
					child.on('close', (code) => {
						if (token.isCancellationRequested || extToken?.isCancellationRequested) {
							settle(false);
							return;
						}
						// Precondition refusal: terminal, with the remediation as the
						// failure detail (markHarnessBlocked notifies once per session).
						const infra = classifyHarnessFailure(tailRing, code);
						if (infra !== 'other') {
							const block = markHarnessBlocked(harnessId, infra);
							settle(false, block.remediation);
							return;
						}
						if (code !== 0) {
							settle(
								false,
								lastLine ||
									`exited with code ${code ?? 'null'} — is the ${harness.label} CLI installed? ${harness.installHint}`,
							);
						} else if (!task.deliverableReady()) {
							settle(false, `the agent finished but did not create ${task.deliverableDesc}`);
						} else {
							settle(true);
						}
					});
				});
			},
		);
	} finally {
		inFlight = Math.max(0, inFlight - 1);
	}
}

/**
 * Harness-mode counterpart of runHandbook: the handbook engine only renders the
 * instruction; the selected coding agent explores the repo and writes
 * .vinv/vinv.md itself.
 */
export function runHandbookViaHarness(
	context: vscode.ExtensionContext,
	harnessId: string,
	workspaceRoot: string,
	onProgress?: (p: HarnessProgress) => void,
	extToken?: vscode.CancellationToken,
): Promise<boolean> {
	if (isHandbookGenerated(workspaceRoot)) {
		// Same reuse rule as the engine path: never regenerate an existing handbook.
		onProgress?.({ percent: 100, label: 'Handbook ready' });
		return Promise.resolve(true);
	}
	if (!isBinAvailable(context, 'handbook')) {
		showEnginesMissingError('handbook');
		return Promise.resolve(false);
	}
	const binPath = getBinPath(context, 'handbook');
	const harness = getHarness(harnessId);
	return runHarnessTask(
		harnessId,
		workspaceRoot,
		{
			name: 'handbook',
			title: `Vinv: Generating handbook via ${harness.label}…`,
			promptBin: binPath,
			promptArgs: ['generate', workspaceRoot],
			promptEnv: getHandbookEnv(path.dirname(binPath), workspaceRoot),
			deliverableReady: () => isHandbookGenerated(workspaceRoot),
			deliverableDesc: 'the handbook (.vinv/vinv.md)',
		},
		onProgress,
		extToken,
	);
}

/**
 * Harness-mode counterpart of runBringupList: the coding agent enumerates the
 * stack and writes .vinv/services.json. Requires the handbook to exist.
 */
export function runBringupListViaHarness(
	context: vscode.ExtensionContext,
	harnessId: string,
	workspaceRoot: string,
	onProgress?: (p: HarnessProgress) => void,
	extToken?: vscode.CancellationToken,
): Promise<boolean> {
	if (!isBinAvailable(context, 'bringup')) {
		showEnginesMissingError('bringup');
		return Promise.resolve(false);
	}
	const binPath = getBinPath(context, 'bringup');
	const harness = getHarness(harnessId);
	return runHarnessTask(
		harnessId,
		workspaceRoot,
		{
			name: 'bringup-list',
			title: `Vinv: Listing services via ${harness.label}…`,
			promptBin: binPath,
			promptArgs: ['list', workspaceRoot],
			promptEnv: getBringupEnv(path.dirname(binPath), workspaceRoot),
			deliverableReady: () => isServicesListed(workspaceRoot),
			deliverableDesc: 'the service inventory (.vinv/services.json)',
		},
		onProgress,
		extToken,
	);
}

/**
 * Harness-mode counterpart of runBringupStart: the coding agent installs,
 * starts, and verifies one service, recording the start command file.
 *
 * `startHint` (how the operator says they start the service) rides into the
 * rendered prompt the same way it rides into the in-process agent's — see
 * runBringupStart. Omitting it still picks up any recorded
 * .vinv/start_hints/<service>.json, since the engine resolves that itself.
 */
export function runBringupStartViaHarness(
	context: vscode.ExtensionContext,
	harnessId: string,
	workspaceRoot: string,
	service: ServiceEntry,
	onProgress?: (p: HarnessProgress) => void,
	extToken?: vscode.CancellationToken,
	startHint?: string,
): Promise<boolean> {
	if (!isBinAvailable(context, 'bringup')) {
		showEnginesMissingError('bringup');
		return Promise.resolve(false);
	}
	const binPath = getBinPath(context, 'bringup');
	const harness = getHarness(harnessId);
	const promptArgs = ['start', workspaceRoot, '--service', service.name];
	// NOT `service.modules` verbatim. Discovery can name the repo's distribution
	// package while the service's entrypoint lives outside it, and tracelens then
	// instruments everything except the code that serves the requests — see
	// targetPackages. The entrypoint's own package is appended when missing.
	const { packages, added } = targetPackagesFor(service);
	if (added) {
		console.warn(
			`Vinv: ${service.name} declares modules [${(service.modules ?? []).join(', ')}] but its ` +
				`start command runs '${entrypointModule(service.command ?? '')}' — instrumenting ` +
				`'${added}' as well, or its handlers would produce no spans.`,
		);
	}
	for (const m of packages) {
		promptArgs.push('--module', m);
	}
	if (startHint?.trim()) {
		promptArgs.push('--start-hint', startHint.trim());
	}
	// Named by the engine's slug, not the raw service name — see serviceSlug.
	const startCommandFile = `${serviceSlug(service.name)}.json`;
	const startCommandPath = path.join(workspaceRoot, '.vinv', 'start_commands', startCommandFile);
	return runHarnessTask(
		harnessId,
		workspaceRoot,
		{
			name: `bringup-${service.name}`,
			title: `Vinv: Starting ${service.name} via ${harness.label}…`,
			promptBin: binPath,
			promptArgs,
			promptEnv: getBringupEnv(path.dirname(binPath), workspaceRoot),
			deliverableReady: () => {
				try {
					return fs.statSync(startCommandPath).size > 0;
				} catch {
					return false;
				}
			},
			deliverableDesc: `the start command record (.vinv/start_commands/${startCommandFile})`,
		},
		onProgress,
		extToken,
	).then((ok) => {
		// A green bring-up that traced none of the service's own code is worse
		// than a red one: everything downstream reads it as usable evidence and
		// reports confident zeros. Audited here, once, so all three callers
		// (auto-setup, the Set up command, Auto-Pilot) are covered.
		if (!ok) {
			return ok;
		}
		// Repair the record BEFORE judging the capture. The agent is told to use
		// the computed --module values verbatim and does not always; when it drops
		// the entrypoint's package the recorded command is wrong in a way that
		// re-running bring-up will not reliably fix, so correct it here and say so
		// rather than reporting a failure the user cannot act on.
		const repaired = repairRecordedTargetPackages(workspaceRoot, service);
		const verdict = auditOwnCodeTracing(workspaceRoot, service);
		if (verdict.state !== 'absent') {
			if (repaired) {
				void vscode.window.showInformationMessage(
					`Vinv: ${service.name}'s recorded start command left out its own package ` +
						`'${repaired}'. Corrected — later runs will trace its own code.`,
				);
			}
			return ok;
		}
		markUntracedBringup(workspaceRoot, service.name, verdict, repaired ?? undefined);
		// ONE message, and it must not contradict the repair. Two notifications —
		// "the command has been corrected" followed by "set it up again" — told the
		// user to redo the very step that had just been fixed for them.
		void vscode.window.showWarningMessage(
			repaired
				? `Vinv: ${service.name} served ${verdict.requests} request(s) while tracing none of ` +
						`its own package '${verdict.rootPackage}' — its recorded command left ` +
						`'${repaired}' out. That is now fixed, so nothing needs setting up again: RUN ` +
						'the service to capture its own code.'
				: `Vinv: ${service.name} served ${verdict.requests} request(s) but nothing from ` +
						`'${verdict.rootPackage}' was traced — tracelens instrumented the wrong package, ` +
						'so coverage and latency would read zero. Recorded as not verified.',
		);
		return false;
	});
}
