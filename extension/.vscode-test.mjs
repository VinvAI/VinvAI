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

export default defineConfig({
	files: 'out/test/**/*.test.js',
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
