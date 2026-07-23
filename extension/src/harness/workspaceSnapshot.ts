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
 */
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
		const sha = (
			await git(workspaceRoot, [
				'commit-tree',
				tree,
				...parentArgs,
				'-m',
				`vinv pre-episode snapshot ${episodeId}`,
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
}

/**
 * Restores the workspace to the snapshot: every snapshot file back to its
 * captured content, every non-ignored file created since then removed.
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
	return { restored: snapshotFiles.size, deleted };
}
