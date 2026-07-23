import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// A dedicated profile lets `npm test` run while a desktop VS Code is open.
	launchArgs: ['--user-data-dir', '.vscode-test/user-data'],
});
