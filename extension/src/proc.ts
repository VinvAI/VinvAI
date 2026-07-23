import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

let cachedBashPath: string | null | undefined;

/** PATH directories, split on the platform's delimiter, empties dropped. */
function pathDirs(): string[] {
	return (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
}

/**
 * Resolves the bash executable used to run recorded start commands, on any
 * platform. The bring-up engine records commands in POSIX/Git-Bash syntax
 * (`PATH="..." ...`, `/c/...` paths).
 *
 * macOS/Linux: `/bin/bash` normally, with fallbacks for distros/setups that
 * keep bash elsewhere (Alpine, Nix, Homebrew) via well-known paths and PATH.
 *
 * Windows: Git for Windows' bash — never WSL's `System32\bash.exe`, which
 * mounts drives at `/mnt/c` and can't resolve `/c/...` paths. Found via the
 * standard install roots, a non-WSL bash.exe on PATH, or derived from git.exe
 * on PATH (<install>\cmd\git.exe → <install>\bin\bash.exe).
 *
 * Returns null when no suitable bash exists (e.g. Windows without Git).
 */
export function resolveBash(): string | null {
	if (cachedBashPath !== undefined) {
		return cachedBashPath;
	}
	const candidates: string[] = [];
	if (process.platform === 'win32') {
		for (const root of [
			process.env['ProgramFiles'],
			process.env['ProgramFiles(x86)'],
			process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs'),
		]) {
			if (root) {
				candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
			}
		}
		for (const dir of pathDirs()) {
			if (/\\system32\b/i.test(dir)) {
				continue; // WSL's bash.exe
			}
			candidates.push(path.join(dir, 'bash.exe'));
			if (existsSync(path.join(dir, 'git.exe'))) {
				candidates.push(path.join(dir, '..', 'bin', 'bash.exe'));
			}
		}
	} else {
		candidates.push('/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash');
		for (const dir of pathDirs()) {
			candidates.push(path.join(dir, 'bash'));
		}
	}
	cachedBashPath = candidates.find((c) => existsSync(c)) ?? null;
	return cachedBashPath;
}

/**
 * Spawn options for running a bundled engine as a *hidden background* process.
 *
 * POSIX: detach into a new process group so killProcessTree can tear down the whole
 * subtree (the engines' ReAct agents spawn terminals and helper processes) with a
 * single negative-pid signal.
 *
 * Windows has no POSIX process groups, and there `detached: true` means "give the
 * child its own console window" (CREATE_NEW_CONSOLE) — which pops a visible command
 * prompt and leaves the child exiting with STATUS_CONTROL_C_EXIT (0xC000013A) when
 * that console is torn down. A bundled engine is a headless CLI, so on Windows we
 * keep the child attached-but-windowless (windowsHide) and tear its tree down with
 * taskkill instead. This is why the same spawn needs opposite `detached` values per
 * platform — hence a single helper rather than a hard-coded flag.
 */
export function hiddenBackgroundOptions<T extends SpawnOptions>(opts: T): T {
	return { ...opts, detached: process.platform !== 'win32', windowsHide: true };
}

/**
 * Terminates a spawned child and its entire subtree, cross-platform. On Windows
 * `taskkill /T /F` walks the PID tree (there is no process group to signal); on
 * POSIX we signal the negative pid (the whole process group) and fall back to the
 * child alone. Best-effort: a child that is already gone is not an error.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) {
		return;
	}
	if (process.platform === 'win32') {
		try {
			// /T = tree (child included), /F = force. Hidden so taskkill itself
			// doesn't flash a console. The requested POSIX signal has no Windows
			// analogue, so a stop is always a forced kill of the tree.
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
		} catch {
			try {
				child.kill();
			} catch {
				// Already gone.
			}
		}
		return;
	}
	try {
		process.kill(-child.pid, signal); // negative pid → whole process group
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
	}
}
