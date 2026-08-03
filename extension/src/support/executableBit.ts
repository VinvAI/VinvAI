/**
 * Marks an engine binary executable, once per path per window.
 *
 * The engines are cloned/copied outside the vsix, and neither git nor a plain
 * copy reliably preserves the executable bit — so every spawn site defensively
 * chmod'ed before launching. That is a synchronous filesystem call on the
 * extension host, and the tracemap/tracesummary pollers invoke their binaries
 * once a second per open view, so a permission bit that only ever changes at
 * install time was being rewritten continuously.
 *
 * Once per (path, window) is the right frequency: the bit cannot change under
 * us without a reinstall, and a reinstall replaces the window's engines anyway.
 *
 * No-op on Windows, where the mode bits carry no meaning.
 */
import * as fs from 'fs';

const marked = new Set<string>();

export function ensureExecutableOnce(binPath: string): void {
	if (process.platform === 'win32' || marked.has(binPath)) {
		return;
	}
	try {
		fs.chmodSync(binPath, 0o755);
	} catch {
		// Non-fatal: a real failure surfaces when the command actually runs.
	}
	marked.add(binPath);
}

/** Drops the memo — for tests that assert the chmod happens. */
export function resetExecutableBitCache(): void {
	marked.clear();
}
