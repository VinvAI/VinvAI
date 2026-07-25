/**
 * Pre-episode workspace snapshots and one-click revert.
 *
 * Before an episode's first attempt, the ENTIRE working state (tracked edits
 * AND untracked non-ignored files) is committed to a hidden ref
 * `refs/vinv/pre-episode/<id>` using a throwaway index — the user's real
 * index, HEAD, and branches are never touched, and ignored artifacts
 * (node_modules, build output) are never captured or deleted.
 *
 * Revert = restore every file in the snapshot tree, then delete non-ignored
 * files that exist now but did not exist at snapshot time (files the agent
 * created). This is exact bookkeeping against git's own object store — not a
 * heuristic diff — so it also reverts deletions and mode changes. The refs
 * stay behind as an audit trail; they are ordinary commits and can be
 * inspected (`git show refs/vinv/pre-episode/<id>`) or deleted at will.
 *
 * ENVIRONMENT DRIFT: file restore cannot undo an installed environment. If an
 * episode edits a lockfile (uv.lock, package-lock.json, poetry.lock,
 * requirements*.txt at the repo root) and syncs it, site-packages/node_modules
 * (gitignored, never captured) keep the episode's dependency set even after a
 * perfect file revert. So capture records each root lockfile's hash plus an
 * interpreter fingerprint inside the snapshot commit's message; revert
 * compares, verifies the diverged lockfiles were restored to their captured
 * hashes, and carries a LOUD `environmentWarning` in the result whenever the
 * installed environment may have drifted beyond what file restore fixes.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{ cwd: root, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
				} else {
					resolve(stdout);
				}
			},
		);
	});
}

export function snapshotRef(episodeId: string): string {
	return `refs/vinv/pre-episode/${episodeId}`;
}

/** Root-level dependency lockfiles whose hashes anchor the env fingerprint. */
const LOCKFILE_NAMES = new Set(['uv.lock', 'package-lock.json', 'poetry.lock']);
const REQUIREMENTS_RE = /^requirements[^/\\]*\.txt$/;

/** Marker line carrying the environment metadata in the snapshot commit message. */
const ENV_MARKER = 'vinv-env: ';

interface SnapshotEnvironment {
	/** repo-relative lockfile path → sha256 of its content at capture. */
	lockfiles: Record<string, string>;
	/** Best-effort interpreter fingerprint (node + python versions). */
	interpreter: string;
}

function isLockfileName(name: string): boolean {
	return LOCKFILE_NAMES.has(name) || REQUIREMENTS_RE.test(name);
}

function rootLockfiles(workspaceRoot: string): string[] {
	try {
		return fs.readdirSync(workspaceRoot).filter(isLockfileName).sort();
	} catch {
		return [];
	}
}

function sha256File(filePath: string): string | null {
	try {
		return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
	} catch {
		return null; // absent or unreadable — recorded as such, compared as such
	}
}

/**
 * Best-effort interpreter fingerprint: the extension host's node plus the
 * first python on PATH. A changed fingerprint at revert time means the
 * runtime itself moved under the episode — file restore cannot fix that.
 */
async function interpreterFingerprint(workspaceRoot: string): Promise<string> {
	const parts = [`node ${process.version}`];
	for (const cmd of ['python3', 'python']) {
		try {
			const out = await new Promise<string>((resolve, reject) => {
				execFile(cmd, ['--version'], { cwd: workspaceRoot, timeout: 5000 }, (err, stdout, stderr) =>
					err ? reject(err) : resolve((stdout || stderr).trim()),
				);
			});
			if (out) {
				parts.push(out);
				break;
			}
		} catch {
			// Not installed — try the next name.
		}
	}
	return parts.join('; ');
}

function captureEnvironment(workspaceRoot: string, interpreter: string): SnapshotEnvironment {
	const lockfiles: Record<string, string> = {};
	for (const name of rootLockfiles(workspaceRoot)) {
		const hash = sha256File(path.join(workspaceRoot, name));
		if (hash) {
			lockfiles[name] = hash;
		}
	}
	return { lockfiles, interpreter };
}

function parseEnvironment(commitMessage: string): SnapshotEnvironment | null {
	for (const line of commitMessage.split('\n')) {
		if (line.startsWith(ENV_MARKER)) {
			try {
				const parsed = JSON.parse(line.slice(ENV_MARKER.length)) as SnapshotEnvironment;
				if (parsed && typeof parsed === 'object' && parsed.lockfiles) {
					return parsed;
				}
			} catch {
				return null;
			}
		}
	}
	return null; // pre-metadata snapshot — env comparison silently unavailable
}

/**
 * Captures the working state into the episode's snapshot ref. Returns the
 * commit sha, or null when the workspace is not a git repository (no
 * snapshot ⇒ no revert offer; nothing else changes).
 */
export async function captureWorkspaceSnapshot(
	workspaceRoot: string,
	episodeId: string,
): Promise<string | null> {
	try {
		await git(workspaceRoot, ['rev-parse', '--git-dir']);
	} catch {
		return null;
	}
	const tmpIndex = path.join(os.tmpdir(), `vinv-snap-${episodeId}-${process.pid}`);
	const env = { GIT_INDEX_FILE: tmpIndex };
	try {
		// Stage EVERYTHING (tracked + untracked, .gitignore respected) into the
		// throwaway index, write the tree, and commit it against HEAD (if any).
		await git(workspaceRoot, ['add', '-A'], env);
		const tree = (await git(workspaceRoot, ['write-tree'], env)).trim();
		let parentArgs: string[] = [];
		try {
			const head = (await git(workspaceRoot, ['rev-parse', 'HEAD'])).trim();
			parentArgs = ['-p', head];
		} catch {
			// Unborn branch (no commits yet): snapshot stands alone.
		}
		// Environment fingerprint rides in the commit message itself — no side
		// files, and it is inspectable with plain `git show`.
		const snapshotEnv = captureEnvironment(
			workspaceRoot,
			await interpreterFingerprint(workspaceRoot),
		);
		const sha = (
			await git(workspaceRoot, [
				'commit-tree',
				tree,
				...parentArgs,
				'-m',
				`vinv pre-episode snapshot ${episodeId}\n\n${ENV_MARKER}${JSON.stringify(snapshotEnv)}`,
			])
		).trim();
		await git(workspaceRoot, ['update-ref', snapshotRef(episodeId), sha]);
		return sha;
	} finally {
		try {
			fs.unlinkSync(tmpIndex);
		} catch {
			// Temp index already gone.
		}
	}
}

export interface RevertResult {
	restored: number;
	deleted: string[];
	/** Root lockfiles that diverged during the episode and were restored to their captured content. */
	lockfilesRestored: string[];
	/**
	 * LOUD drift warning: present when the installed environment (packages,
	 * interpreter) may no longer match the restored files — a condition file
	 * restore cannot fix. Callers should surface this verbatim.
	 */
	environmentWarning?: string;
}

/**
 * Restores the workspace to the snapshot: every snapshot file back to its
 * captured content, every non-ignored file created since then removed.
 * Diverged lockfiles are verified restored and any possible installed-package
 * drift is reported loudly in the result.
 */
export async function revertToSnapshot(
	workspaceRoot: string,
	episodeId: string,
): Promise<RevertResult> {
	const ref = snapshotRef(episodeId);
	const snapshotFiles = new Set(
		(await git(workspaceRoot, ['ls-tree', '-r', '--name-only', ref]))
			.split('\n')
			.filter(Boolean),
	);
	// Environment fingerprint captured with the snapshot (null for pre-metadata refs).
	const capturedEnv = parseEnvironment(await git(workspaceRoot, ['log', '-1', '--format=%B', ref]));
	// Lockfile divergence must be measured BEFORE the restore rewrites them:
	// every captured lockfile plus any lockfile the episode created.
	const lockfileSet = new Set<string>([
		...Object.keys(capturedEnv?.lockfiles ?? {}),
		...rootLockfiles(workspaceRoot),
	]);
	const divergedLockfiles: string[] = [];
	if (capturedEnv) {
		for (const rel of lockfileSet) {
			const nowHash = sha256File(path.join(workspaceRoot, rel));
			if (nowHash !== (capturedEnv.lockfiles[rel] ?? null)) {
				divergedLockfiles.push(rel);
			}
		}
	}
	// Non-ignored files present NOW (tracked + others), for the deletion diff.
	const nowFiles = (
		await git(workspaceRoot, ['ls-files', '-co', '--exclude-standard'])
	)
		.split('\n')
		.filter(Boolean);
	// Restore everything the snapshot holds (content, deletions, modes).
	await git(workspaceRoot, ['restore', '--source', ref, '--worktree', '--', ':/']);
	// Delete files born after the snapshot. Paths come from git itself, are
	// repo-relative, and were re-checked against the snapshot tree — nothing
	// ignored or outside the repo can be touched.
	const deleted: string[] = [];
	for (const rel of nowFiles) {
		if (!snapshotFiles.has(rel)) {
			try {
				fs.unlinkSync(path.join(workspaceRoot, rel));
				deleted.push(rel);
			} catch {
				// Already gone or held open — skip; restore still succeeded.
			}
		}
	}
	// Verify each diverged lockfile actually came back to its captured hash
	// (a gitignored lockfile is hash-tracked but not in the tree — unfixable).
	const lockfilesRestored: string[] = [];
	const lockfilesUnrestored: string[] = [];
	for (const rel of divergedLockfiles) {
		const nowHash = sha256File(path.join(workspaceRoot, rel));
		if (nowHash === (capturedEnv?.lockfiles[rel] ?? null)) {
			lockfilesRestored.push(rel);
		} else {
			lockfilesUnrestored.push(rel);
		}
	}
	let environmentWarning: string | undefined;
	if (capturedEnv) {
		const interpreterNow = await interpreterFingerprint(workspaceRoot);
		const interpreterDrift =
			capturedEnv.interpreter && capturedEnv.interpreter !== interpreterNow
				? `interpreter fingerprint changed ("${capturedEnv.interpreter}" -> "${interpreterNow}")`
				: null;
		const pieces: string[] = [];
		if (divergedLockfiles.length) {
			pieces.push(
				`lockfile(s) ${divergedLockfiles.join(', ')} changed during the episode` +
					(lockfilesUnrestored.length
						? ` and ${lockfilesUnrestored.join(', ')} could NOT be restored from the snapshot`
						: ' and were restored from the snapshot') +
					'; installed packages (site-packages/node_modules) are not captured and may still reflect the ' +
					'episode dependency set — re-sync the environment (uv sync / npm ci) before trusting behavior',
			);
		}
		if (interpreterDrift) {
			pieces.push(interpreterDrift);
		}
		if (pieces.length) {
			environmentWarning = `ENVIRONMENT MAY HAVE DRIFTED beyond file restore: ${pieces.join('; ')}.`;
		}
	}
	return { restored: snapshotFiles.size, deleted, lockfilesRestored, environmentWarning };
}
