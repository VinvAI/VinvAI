// Stamps src/engines/pinned.ts with the engines ref this vsix is being cut
// against. Runs from `vscode:prepublish`, so every packaged extension carries a
// pin and every local `npm run bundle` (which does not run prepublish) leaves
// the checked-in '' — unpinned, update logic inert. See src/engines/pinned.ts.
//
// Inputs, all optional:
//   VINV_ENGINE_REF     — ref to stamp. Default: the exact tag on HEAD if there
//                         is one, else HEAD's full sha.
//   VINV_ENGINE_UPDATE  — auto | prompt | never. Default: prompt.
//
// The rewritten file is expected to be committed with the release: it is the
// record of which engines that vsix pairs with.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PINNED = path.join(HERE, '..', 'src', 'engines', 'pinned.ts');
// The monorepo root — the extension lives one level inside it.
const REPO = path.join(HERE, '..', '..');

const MODES = ['auto', 'prompt', 'never'];

function git(args) {
	// stderr ignored: `describe --exact-match` failing is an expected probe, and
	// its "fatal: no tag exactly matches" would read as a build error otherwise.
	return execFileSync('git', args, {
		cwd: REPO,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	}).trim();
}

function resolveRef() {
	const override = (process.env.VINV_ENGINE_REF ?? '').trim();
	if (override) {
		return override;
	}
	try {
		// An exact tag is the friendlier pin: it survives a force-push of the
		// branch and reads as a version in the terminal the user watches.
		return git(['describe', '--tags', '--exact-match', 'HEAD']);
	} catch {
		return git(['rev-parse', 'HEAD']);
	}
}

/**
 * Refuses a ref users could not reach. The pin is fetched from origin on their
 * machines, so stamping a local-only commit — a release cut from a feature
 * branch, an unpushed tag — ships a vsix whose every update attempt fails.
 * Checked against the local origin/main, so `git fetch` first if it is stale;
 * VINV_ENGINE_ALLOW_UNREACHABLE=1 overrides for a deliberate pre-push build.
 */
function assertReachable(ref) {
	if (process.env.VINV_ENGINE_ALLOW_UNREACHABLE === '1') {
		return;
	}
	let commit;
	try {
		commit = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
	} catch {
		throw new Error(`engines ref "${ref}" does not resolve in this checkout`);
	}
	try {
		git(['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
	} catch {
		return; // no origin/main locally — nothing to check against
	}
	try {
		git(['merge-base', '--is-ancestor', commit, 'origin/main']);
	} catch {
		throw new Error(
			`engines ref "${ref}" (${commit.slice(0, 7)}) is not reachable from origin/main, so ` +
				'installs could not fetch it. Merge and push first, set VINV_ENGINE_REF to a ' +
				'released tag, or set VINV_ENGINE_ALLOW_UNREACHABLE=1 if this is deliberate.',
		);
	}
}

/**
 * The `vinv` wheel version this vsix pairs with.
 *
 * Default: the version declared by packaging/vinv/pyproject.toml in this
 * checkout, so a release stamps the wheel that was cut from the same tree
 * rather than whatever is newest on PyPI. VINV_ENGINE_WHEEL overrides it, and
 * an explicit empty string disables the wheel route (source build only).
 */
function resolveWheel() {
	const override = process.env.VINV_ENGINE_WHEEL;
	if (override !== undefined) {
		return override.trim();
	}
	try {
		const pyproject = readFileSync(
			path.join(REPO, 'packaging', 'vinv', 'pyproject.toml'),
			'utf8',
		);
		const m = /^version = "([^"]+)"$/m.exec(pyproject);
		return m ? m[1] : '';
	} catch {
		// No packaging tree (a checkout without it) — ship source-only rather
		// than guessing a version that may not exist on PyPI.
		return '';
	}
}

const ref = resolveRef();
const wheel = resolveWheel();
const mode = (process.env.VINV_ENGINE_UPDATE ?? 'prompt').trim();
if (!MODES.includes(mode)) {
	throw new Error(`VINV_ENGINE_UPDATE must be one of ${MODES.join(' | ')} (got "${mode}")`);
}
if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
	// The ref is interpolated into a shell command line in the update terminal.
	throw new Error(`refusing to stamp an unsafe engines ref: "${ref}"`);
}
if (wheel && !/^[A-Za-z0-9.+!-]+$/.test(wheel)) {
	// Interpolated into the `uv tool install "vinv==<version>"` command line.
	throw new Error(`refusing to stamp an unsafe wheel version: "${wheel}"`);
}
assertReachable(ref);

const source = readFileSync(PINNED, 'utf8');
const stamped = source
	.replace(/export const ENGINE_REF = '[^']*';/, `export const ENGINE_REF = '${ref}';`)
	.replace(
		/export const ENGINE_UPDATE_DEFAULT: 'auto' \| 'prompt' \| 'never' = '[^']*';/,
		`export const ENGINE_UPDATE_DEFAULT: 'auto' | 'prompt' | 'never' = '${mode}';`,
	)
	.replace(
		/export const ENGINE_WHEEL: string = '[^']*';/,
		`export const ENGINE_WHEEL: string = '${wheel}';`,
	);
if (stamped === source && !source.includes(`= '${ref}';`)) {
	throw new Error(`could not stamp ${PINNED} — its generated declarations no longer match`);
}
writeFileSync(PINNED, stamped, 'utf8');
console.log(`stamped engines pin: ref=${ref} wheel=${wheel || '(none)'} update=${mode}`);
