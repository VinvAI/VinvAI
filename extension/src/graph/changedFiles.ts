/**
 * What "changed" means for diff impact.
 *
 * It used to mean "this chunk's content epoch equals the store epoch". That is
 * the right predicate for invalidating runtime captures (a trace taken at epoch
 * E is stale for a symbol whose content moved past E), but it is the WRONG
 * predicate for showing a developer their working change: on the first index of
 * a repo every chunk is assigned epoch 1 and the store epoch is 1, so every
 * symbol matched and the Graph Explorer lit up the entire map as "changed".
 *
 * Diff impact now asks the question the user actually means:
 *
 *   git repo      → the uncommitted working set (staged + unstaged + untracked,
 *                   i.e. everything `git status --porcelain` reports)
 *   no git repo   → files whose mtime falls inside a recent window (30 minutes)
 *
 * Both answers are FILE level. Symbol-level narrowing would need the index's
 * line ranges to agree with the working tree's line numbers, and they drift
 * between a save and the next reindex — a file-level answer is never wrong in
 * the way a line-level one would be.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** How the changed set was determined. */
export type ChangeSource = 'git' | 'recent' | 'none';

export interface ChangedFileSet {
	source: ChangeSource;
	/** Workspace-relative, forward-slashed paths — the same shape as GraphNode.file. */
	files: Set<string>;
	/** Window in minutes, on the `recent` fallback only. */
	windowMinutes?: number;
}

/** The non-git fallback window: files touched in the last 30 minutes. */
export const RECENT_WINDOW_MINUTES = 30;

const EMPTY: ChangedFileSet = { source: 'none', files: new Set() };

function git(root: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
		timeout: 6000,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'ignore'],
	});
}

/**
 * Parses `git status --porcelain -z` output — PURE (unit tested).
 *
 * Entries are NUL-terminated `XY <path>`; a rename/copy (`R`/`C` in either
 * status column) is followed by a second NUL-terminated token holding the
 * ORIGINAL path. Both sides of a rename are reported changed: the new path is
 * what exists now, the old one is what a not-yet-refreshed index still has.
 *
 * `prefix` is the workspace's path relative to the repo root (`git rev-parse
 * --show-prefix`); status paths are repo-root relative, so entries outside the
 * workspace are dropped and the rest are rebased onto it.
 */
export function parsePorcelain(out: string, prefix = ''): Set<string> {
	const files = new Set<string>();
	const tokens = out.split('\0');
	const add = (raw: string): void => {
		const p = raw.replace(/\\/g, '/');
		if (prefix && !p.startsWith(prefix)) {
			return; // outside this workspace folder
		}
		const rel = prefix ? p.slice(prefix.length) : p;
		if (rel) {
			files.add(rel);
		}
	};
	for (let i = 0; i < tokens.length; i += 1) {
		const entry = tokens[i];
		if (entry.length < 4) {
			continue; // trailing empty token from the final NUL
		}
		const status = entry.slice(0, 2);
		add(entry.slice(3));
		if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
			i += 1; // the next token is the rename/copy source
			if (tokens[i]) {
				add(tokens[i]);
			}
		}
	}
	return files;
}

/** Files whose mtime is inside the window — PURE (unit tested). */
export function withinWindow(
	stats: ReadonlyArray<{ file: string; mtimeMs: number }>,
	nowMs: number,
	windowMinutes = RECENT_WINDOW_MINUTES,
): Set<string> {
	const floor = nowMs - windowMinutes * 60_000;
	const files = new Set<string>();
	for (const s of stats) {
		if (s.mtimeMs >= floor) {
			files.add(s.file);
		}
	}
	return files;
}

/**
 * The uncommitted working set, or null when `root` is not inside a git work
 * tree (or git is unavailable / too slow to answer).
 */
export function gitChangedFiles(root: string): Set<string> | null {
	let prefix = '';
	try {
		if (git(root, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
			return null;
		}
		prefix = git(root, ['rev-parse', '--show-prefix']).trim().replace(/\\/g, '/');
	} catch {
		return null; // not a repo, or no git on PATH
	}
	try {
		// -uall lists untracked files individually rather than collapsing them
		// into a directory entry, which the index's per-file view needs.
		return parsePorcelain(git(root, ['status', '--porcelain', '-z', '-uall']), prefix);
	} catch {
		return null;
	}
}

/**
 * Detection costs three `git` spawns (~0.5s on a mid-size repo), and
 * buildGraphSnapshot — which every view, the QnA pipeline and the episode loop
 * call — would otherwise pay that on each build, sometimes several times inside
 * one refresh. A 2s memo collapses those bursts while staying far below the
 * 8s reindex debounce, so no user-visible change is ever masked.
 */
const MEMO_TTL_MS = 2_000;
const memo = new Map<string, { at: number; value: ChangedFileSet }>();

/**
 * The changed-file set for diff impact: git's uncommitted working set when the
 * workspace is a repo, otherwise the recently-touched files among those the
 * index knows about. Only `indexedFiles` are ever stat'ed, so the fallback
 * costs one stat per indexed file and never walks the tree. Never throws.
 *
 * Passing `nowMs` explicitly bypasses the memo (deterministic tests).
 */
export function detectChangedFiles(
	root: string,
	indexedFiles: Iterable<string>,
	nowMs?: number,
): ChangedFileSet {
	const live = nowMs === undefined;
	const now = nowMs ?? Date.now();
	if (live) {
		const hit = memo.get(root);
		if (hit && now - hit.at < MEMO_TTL_MS) {
			return hit.value;
		}
	}
	const value = computeChangedFiles(root, indexedFiles, now);
	if (live) {
		memo.set(root, { at: now, value });
	}
	return value;
}

function computeChangedFiles(
	root: string,
	indexedFiles: Iterable<string>,
	nowMs: number,
): ChangedFileSet {
	try {
		const tracked = gitChangedFiles(root);
		if (tracked) {
			// Keep only what the index actually has a node for; a changed file the
			// index has never seen has no symbol to light up.
			const indexed = new Set(indexedFiles);
			const files = new Set<string>();
			for (const f of tracked) {
				if (indexed.has(f)) {
					files.add(f);
				}
			}
			return { source: 'git', files };
		}
		const stats: Array<{ file: string; mtimeMs: number }> = [];
		for (const file of indexedFiles) {
			try {
				stats.push({ file, mtimeMs: fs.statSync(path.join(root, file)).mtimeMs });
			} catch {
				// Indexed file no longer on disk — not a change we can date.
			}
		}
		return {
			source: 'recent',
			files: withinWindow(stats, nowMs),
			windowMinutes: RECENT_WINDOW_MINUTES,
		};
	} catch {
		return EMPTY;
	}
}
