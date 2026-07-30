import { defineConfig } from '@vscode/test-cli';

/**
 * Electron cannot start its own sandbox on a headless Linux runner.
 *
 * GitHub's `ubuntu-latest` is Ubuntu 24.04, which restricts unprivileged user
 * namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns`).
 * Chromium's SUID sandbox needs exactly that capability, so a VS Code launched
 * under xvfb dies before the extension host starts — the failure is a
 * namespace/sandbox error, not a test failure, and it takes the whole suite
 * with it. `--disable-gpu` is the matching concern: there is no GPU behind
 * xvfb, and the GPU process retries and logs noisily without it.
 *
 * Scoped to Linux rather than to CI: the constraint is the platform's, and a
 * developer running these tests on a headless Linux box hits the identical
 * wall. macOS and Windows keep the real sandbox, so nothing local is weakened.
 */
const headlessLinuxArgs =
	process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];

/**
 * Mocha's 2000ms default is too tight for this suite, which is I/O bound.
 *
 * These tests are not unit tests over in-memory data: most of them mkdtemp a
 * workspace, write real capture and index files, and read them back through the
 * same code paths the extension uses. Under full-suite load that routinely
 * exceeds 2s on Windows, where every file operation carries Defender's
 * inspection and directory deletes contend with open handles.
 *
 * The failure mode is what makes it worth fixing rather than tolerating: it is
 * LOAD-dependent, not test-dependent, so a different test trips each run — four
 * distinct ones observed (contextGraph lifecycle ordering, contextGraph failure
 * dedupe, targetPackages command repair, opportunityBoard eviction) — and every
 * one of them passes in isolation. That is indistinguishable at a glance from a
 * real regression, and it costs a full re-run to tell apart. It also matters now
 * in a way it did not before: PR 42 put this suite in CI for the first time, so
 * a timeout here fails the build rather than one developer's local run.
 *
 * 20s is chosen to be far above the slowest legitimate test (the real-python
 * F2P e2e sets its own 60s) while still failing a genuine hang in reasonable
 * time. Raising the ceiling does not hide a slow test — the reporter prints
 * per-test durations either way.
 */
export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: { timeout: 20_000 },
	// A dedicated profile lets `npm test` run while a desktop VS Code is open.
	// Overridable because a deeply-nested checkout (e.g. a .claude/worktrees
	// clone) pushes the profile's IPC socket path past darwin's 103-char
	// sun_path limit and VS Code fails to boot (listen EINVAL).
	launchArgs: [
		'--user-data-dir',
		process.env.VSCODE_TEST_USER_DATA_DIR ?? '.vscode-test/user-data',
		...headlessLinuxArgs,
	],
});
