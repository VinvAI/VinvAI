import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// A dedicated profile lets `npm test` run while a desktop VS Code is open.
	// Overridable because a deeply-nested checkout (e.g. a .claude/worktrees
	// clone) pushes the profile's IPC socket path past darwin's 103-char
	// sun_path limit and VS Code fails to boot (listen EINVAL).
	launchArgs: [
		'--user-data-dir',
		process.env.VSCODE_TEST_USER_DATA_DIR ?? '.vscode-test/user-data',
	],
});
