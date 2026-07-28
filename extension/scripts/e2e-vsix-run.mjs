/**
 * The acceptance test: package the VSIX, install it into a real VS Code, open a
 * real project, run the pipeline, and check what landed on disk.
 *
 * Everything else in this repo tests a seam. `npm test` loads the extension from
 * SOURCE into a VS Code instance; `test:packaged` proves the VSIX installs and
 * its MCP server answers. Neither runs the product: neither packages the code a
 * user installs, points it at a project, presses the button, and looks at the
 * result. So the failures that only exist in the assembled whole — an engine the
 * extension cannot find, a command that never activates, a stage that stops
 * before the one that matters — had nowhere to show up.
 *
 * What this does, in order:
 *
 *   1. `vsce package`                  the artifact a user actually installs
 *   2. `--install-extension`           into a clean profile, no dev path
 *   3. build a fixture project         real Python, pre-seeded discovery state
 *   4. launch VS Code on it            the installed extension, no source
 *   5. run `vinv-vs.autoPilot`         the product's own entry point
 *   6. assert `.vinv/exercise/*`       written by the REAL engine
 *
 * The engine is real: `vinv.enginesPath` points at this checkout, so the
 * extension resolves `<repo>/.venv/bin/exerciser` exactly as it would resolve a
 * user's. Nothing here is stubbed except the discovery state, which is seeded so
 * the run is deterministic and does not depend on the index engine having been
 * built — that is a different engine's acceptance test, not this one's.
 *
 * Run with `npm run test:e2e`. Skips with a clear message, rather than failing,
 * when the engines venv is absent — a machine that has not run `uv sync` cannot
 * run the product either, and a red test would be reporting the wrong thing.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTests, runVSCodeCommand } from '@vscode/test-electron';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-e2e-vsix-'));

// `vscode:prepublish` STAMPS the engine ref into a tracked source file. Correct
// for a release build and unacceptable as a test's residue: running the suite
// must not leave the checkout dirty, or the next `git status` blames the test.
const pinnedFile = path.join(extensionRoot, 'src', 'engines', 'pinned.ts');
const pinnedBefore = fs.readFileSync(pinnedFile, 'utf8');

const vsix = path.join(temporary, 'vinv.vsix');
const profile = path.join(temporary, 'profile');
const extensions = path.join(temporary, 'extensions');
const workspace = path.join(temporary, 'project');

/** The engine console scripts the extension resolves, per platform. */
function enginesVenvBin(name) {
	return process.platform === 'win32'
		? path.join(repoRoot, '.venv', 'Scripts', `${name}.exe`)
		: path.join(repoRoot, '.venv', 'bin', name);
}

async function main() {
	if (!fs.existsSync(enginesVenvBin('exerciser'))) {
		process.stdout.write(
			'SKIP: no engines venv at <repo>/.venv — run `uv sync` at the repo root first.\n',
		);
		return;
	}

	buildFixtureProject(workspace);

	// 1 + 2: the artifact a user installs, into a profile that has nothing else.
	run(path.join(extensionRoot, 'node_modules', '.bin', 'vsce'), [
		'package',
		'--no-rewrite-relative-links',
		'--out',
		vsix,
	]);
	await runVSCodeCommand([
		'--install-extension',
		vsix,
		'--force',
		'--user-data-dir',
		profile,
		'--extensions-dir',
		extensions,
	]);
	// AFTER packaging, deliberately. `vscode:prepublish` runs the bundler, and
	// the bundler starts from a clean `out/` — so anything compiled before this
	// point is deleted by the very step that builds the VSIX. Compiling the
	// in-editor half here is the only ordering that survives it.
	run(path.join(extensionRoot, 'node_modules', '.bin', 'tsc'), ['-p', '.']);
	assert.ok(
		fs.existsSync(path.resolve(extensionRoot, 'out', 'e2e', 'index.js')),
		'the in-editor half did not compile',
	);

	const installed = fs
		.readdirSync(extensions, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith('vinvai.vinvai-'));
	assert.equal(installed.length, 1, 'the VSIX did not install into the clean profile');
	process.stdout.write(`installed ${installed[0].name}\n`);

	// 3 + 4 + 5: drive the INSTALLED extension against the fixture. No
	// `--extensionDevelopmentPath`: the code under test is the packaged code.
	const code = await runTests({
		extensionTestsPath: path.resolve(extensionRoot, 'out', 'e2e', 'index.js'),
		// Points at the installed VSIX rather than this checkout's source.
		extensionTestsEnv: {
			VINV_E2E_WORKSPACE: workspace,
			VINV_E2E_ENGINES: repoRoot,
		},
		launchArgs: [
			workspace,
			'--user-data-dir',
			profile,
			'--extensions-dir',
			extensions,
			'--disable-workspace-trust',
			'--skip-welcome',
			'--skip-release-notes',
		],
	});
	assert.equal(code, 0, 'the in-editor acceptance run failed');
	process.stdout.write('packaged VSIX end-to-end run passed\n');
}

/**
 * A real Python project, plus the discovery state the pipeline gates on.
 *
 * `isProjectDiscovered` wants an index (`meta.json` + `vectors.f32`), a handbook
 * and a services list. Those are three other engines' output; seeding them keeps
 * this test about the exercise path rather than about whether the Rust indexer
 * was built on this machine. `chunks.jsonl` is real, because the exerciser reads
 * it to find targets, and the whole point is that the engine does real work.
 */
function buildFixtureProject(root) {
	const pkg = path.join(root, 'src', 'acceptance_demo');
	fs.mkdirSync(pkg, { recursive: true });
	fs.writeFileSync(path.join(pkg, '__init__.py'), '', 'utf8');

	const module = [
		'"""A library: nothing to serve, which is the case this pipeline added."""',
		'',
		'',
		'def add(a: int, b: int) -> int:',
		'    return a + b',
		'',
		'',
		'def divide(a: int, b: int) -> float:',
		'    """The boundary input class includes 0, so this is a real defect."""',
		'    return a / b',
		'',
	].join('\n');
	fs.writeFileSync(path.join(pkg, 'calc.py'), module, 'utf8');
	fs.writeFileSync(
		path.join(root, 'pyproject.toml'),
		'[project]\nname = "acceptance-demo"\nversion = "0.1.0"\n',
		'utf8',
	);

	const vinv = path.join(root, '.vinv');
	fs.mkdirSync(path.join(vinv, 'index'), { recursive: true });
	const chunks = ['add', 'divide'].map((name, i) =>
		JSON.stringify({
			id: `src/acceptance_demo/calc.py:${name}`,
			file: 'src/acceptance_demo/calc.py',
			lang: 'python',
			kind: 'function',
			name,
			start_line: 4 + i * 5,
			end_line: 6 + i * 5,
			parent: null,
		}),
	);
	fs.writeFileSync(path.join(vinv, 'index', 'chunks.jsonl'), `${chunks.join('\n')}\n`, 'utf8');
	// Enough for `isProjectIndexed`; the exerciser never reads these two.
	fs.writeFileSync(
		path.join(vinv, 'index', 'meta.json'),
		JSON.stringify({ version: 5, chunks: chunks.length }),
		'utf8',
	);
	fs.writeFileSync(path.join(vinv, 'index', 'vectors.f32'), Buffer.alloc(4));
	fs.writeFileSync(path.join(vinv, 'vinv.md'), '# acceptance-demo\n\nA library.\n', 'utf8');
	// A library: no service, which is exactly the workspace that used to do
	// nothing at all after discovery.
	fs.writeFileSync(
		path.join(vinv, 'services.json'),
		JSON.stringify({ services: [] }, null, 2),
		'utf8',
	);

	fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.vscode', 'settings.json'),
		JSON.stringify(
			{
				// The REAL engines, resolved the way a user's are.
				'vinv.enginesPath': repoRoot,
				// No coding-harness dispatch: this asserts the pipeline reaches the
				// findings, not that an agent is signed in.
				'vinv.autoEpisodes': false,
			},
			null,
			2,
		),
		'utf8',
	);
}

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: extensionRoot,
		encoding: 'utf8',
		shell: process.platform === 'win32',
		env: {
			...process.env,
			// `vscode:prepublish` refuses to stamp an engine ref that is not
			// reachable from origin/main, because a published VSIX pinned to an
			// unmerged commit cannot fetch its engines. Correct for a release and
			// wrong for this: the VSIX built here is installed into a throwaway
			// profile, asserted on, and deleted. The guard's own documented escape.
			VINV_ENGINE_ALLOW_UNREACHABLE: '1',
		},
	});
	if (result.status !== 0) {
		throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
	}
}

try {
	await main();
} finally {
	// Restored unconditionally: a failed run must not dirty the tree either.
	if (fs.readFileSync(pinnedFile, 'utf8') !== pinnedBefore) {
		fs.writeFileSync(pinnedFile, pinnedBefore, 'utf8');
	}
	fs.rmSync(temporary, { recursive: true, force: true });
}
