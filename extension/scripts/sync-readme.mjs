// Runs scripts/sync-extension-readme.py through whichever Python this machine
// actually has.
//
// `python3` is not a portable spelling. On Windows it resolves to the Microsoft
// Store's app-execution alias — a stub that prints "Python was not found" and
// exits 9009 — even when Python is installed and on PATH as `python`. Since
// `vscode:prepublish` calls this, the spelling decided whether `npm run package`
// could build a vsix at all, and it could not on Windows. CI runs on Linux and
// never saw it.
import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', '..', 'scripts', 'sync-extension-readme.py');
const args = process.argv.slice(2);

// `py -3` first on Windows: the official launcher is the one spelling that is
// never a Store stub. Elsewhere `python3` is correct and `python` is the
// fallback for environments that only ship the unsuffixed name.
const CANDIDATES =
	process.platform === 'win32'
		? [
				['py', ['-3']],
				['python', []],
				['python3', []],
			]
		: [
				['python3', []],
				['python', []],
			];

for (const [exe, prefix] of CANDIDATES) {
	const run = spawnSync(exe, [...prefix, SCRIPT, ...args], { stdio: 'inherit' });
	if (run.error) {
		continue; // not installed under this name — try the next spelling
	}
	// 9009 is cmd's "not recognized", which is what the Store alias stub exits
	// with after printing its install advert. The sync script itself only ever
	// exits 0 or 1, so this cannot swallow a real result.
	if (run.status === 9009) {
		continue;
	}
	process.exit(run.status ?? 1);
}

console.error(
	`sync-readme: no working Python found (tried ${CANDIDATES.map(([e]) => e).join(', ')}). ` +
		'Install Python 3, or run scripts/sync-extension-readme.py yourself.',
);
process.exit(1);
