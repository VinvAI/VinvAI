/**
 * Per-trigger run isolation — what lets several agents work one workspace at
 * once.
 *
 * The old rule was one harness run per window, enforced by a module-level
 * boolean. That was never really about throughput: every dispatch ran with
 * `cwd: workspaceRoot`, and the episode machinery OWNS that tree. Pre-episode
 * snapshot captures the whole working state and revert deletes every
 * non-ignored file that did not exist at capture — so two concurrent episodes
 * meant one reverting the other's new files out from under it. The reward and
 * anti-cheat signals have the same root problem: both read `git diff` against
 * a baseline and would attribute each agent's edits to the other.
 *
 * So isolation, not locking, is the thing that actually makes concurrency
 * safe. Every dispatch gets an id and its own git worktree:
 *
 *     .vinv/runs/<triggerId>/
 *       meta.json          kind, harness, task, origin, started/ended
 *       tree/              the worktree — the agent's cwd, its own HEAD
 *       trajectory.jsonl   this run's steps
 *       reward.json        verdict + diff audit, scoped to this tree
 *
 * Snapshot, revert, diff and reward keep their exact semantics — they just
 * take the run's tree as their root instead of the shared one. Two triggers
 * can no longer see each other's edits at all, which is a stronger guarantee
 * than the lock ever gave (it never held across windows anyway).
 *
 * LEARNING STILL AGGREGATES. Per-run records are the isolated part; the root
 * `.vinv/trajectory.jsonl` and `.vinv/episodes.jsonl` are the combined view
 * every policy reads. A finished run appends exactly ONE line to each, and a
 * lone append-mode write does not interleave with another process's — which
 * is why the aggregates need no lock either. Readers already tolerate a torn
 * trailing line.
 *
 * The branch is deliberately LEFT BEHIND (`vinv/run/<id>`). With several
 * agents in flight, auto-merging turns a conflict into surprise breakage in a
 * tree the user is actively working in; leaving branches makes every run
 * reviewable and cherry-pickable on the user's schedule.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

/** Where all per-run state lives, under the workspace's own .vinv. */
export function runsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.vinv', 'runs');
}

/** The combined, append-only records every learning pass reads. */
export function aggregatePath(workspaceRoot: string, name: string): string {
	return path.join(workspaceRoot, '.vinv', name);
}

/** One isolated dispatch. */
export interface TriggerRun {
	id: string;
	/** `.vinv/runs/<id>` — this run's private storage. */
	dir: string;
	/**
	 * The agent's cwd. A per-run worktree when isolation succeeded, and the
	 * workspace root itself when it could not (see `isolated`).
	 */
	tree: string;
	/** Branch the worktree sits on, or null when not isolated. */
	branch: string | null;
	/**
	 * False when this run shares the workspace tree — no git, a repo too old
	 * for `worktree`, or a failed add. Callers that mutate the tree must treat
	 * a non-isolated run as exclusive, because the old collision risk is back.
	 */
	isolated: boolean;
	/** Why isolation was skipped, for the meta record and error surfaces. */
	isolationSkipped?: string;
}

export interface OpenRunOptions {
	/** 'episode' | 'chat' | 'bringup' | … — recorded, and used for filtering. */
	kind: string;
	/** Harness id this run dispatches to. */
	harness?: string;
	/** Short human description of the task. */
	task?: string;
	/**
	 * Skip the worktree and run in the workspace itself. For read-only work
	 * (adjudication chats, QnA) a checkout is pure cost — nothing is written,
	 * so nothing can collide.
	 */
	shared?: boolean;
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{ cwd, maxBuffer: 32 * 1024 * 1024 },
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

/** A fresh trigger id. Every dispatch gets one, episode or not. */
export function newTriggerId(): string {
	return crypto.randomUUID();
}

export function runBranch(triggerId: string): string {
	return `vinv/run/${triggerId}`;
}

/**
 * Appends one JSON row to an append-only aggregate.
 *
 * Single write, append mode, one line: concurrent runs — in this window, in
 * another window, or from an external dispatcher — cannot interleave inside
 * it. This is what replaces the lock for the shared learning records.
 */
export function appendAggregate(workspaceRoot: string, name: string, row: unknown): void {
	const target = aggregatePath(workspaceRoot, name);
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.appendFileSync(target, `${JSON.stringify(row)}\n`, 'utf8');
	} catch {
		// Learning records are best-effort: losing a row must never fail a run
		// that otherwise succeeded.
	}
}

function writeMeta(run: TriggerRun, patch: Record<string, unknown>): void {
	const file = path.join(run.dir, 'meta.json');
	let current: Record<string, unknown> = {};
	try {
		current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {
		// First write, or unreadable — start clean.
	}
	try {
		fs.writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, '\t')}\n`, 'utf8');
	} catch {
		// Non-fatal: meta is an audit aid, not a dependency of the run.
	}
}

/**
 * Opens an isolated run: private storage plus, unless `shared`, a git worktree
 * branched off HEAD for the agent to work in.
 *
 * Never throws for want of isolation. A workspace that is not a git repo is a
 * perfectly ordinary thing to dispatch against, and refusing would be a
 * regression — such a run comes back with `isolated: false` and the caller
 * decides whether that is acceptable for what it is about to do.
 */
export async function openRun(
	workspaceRoot: string,
	options: OpenRunOptions,
): Promise<TriggerRun> {
	const id = newTriggerId();
	const dir = path.join(runsDir(workspaceRoot), id);
	fs.mkdirSync(dir, { recursive: true });

	const run: TriggerRun = {
		id,
		dir,
		tree: workspaceRoot,
		branch: null,
		isolated: false,
	};

	if (!options.shared) {
		const tree = path.join(dir, 'tree');
		const branch = runBranch(id);
		try {
			// Off HEAD, not off a named branch: the agent should start from what
			// the user is actually looking at, including commits not yet pushed.
			await git(workspaceRoot, ['worktree', 'add', '-b', branch, tree, 'HEAD']);
			run.tree = tree;
			run.branch = branch;
			run.isolated = true;
		} catch (e) {
			run.isolationSkipped = e instanceof Error ? e.message : String(e);
		}
	} else {
		run.isolationSkipped = 'read-only run: shares the workspace tree by design';
	}

	writeMeta(run, {
		id,
		kind: options.kind,
		harness: options.harness,
		task: options.task,
		tree: run.tree,
		branch: run.branch,
		isolated: run.isolated,
		isolation_skipped: run.isolationSkipped,
		// Which window opened it — with no lock, several may be live at once and
		// "who started this" stops being obvious from context alone.
		origin_pid: process.pid,
		started_at: new Date().toISOString(),
	});
	return run;
}

/**
 * Closes a run: stamps meta and appends the finished record to the root
 * aggregates so learning sees every trigger, isolated or not.
 */
export function closeRun(
	workspaceRoot: string,
	run: TriggerRun,
	record: Record<string, unknown>,
): void {
	const endedAt = new Date().toISOString();
	writeMeta(run, { ended_at: endedAt, ...record });
	appendAggregate(workspaceRoot, 'episodes.jsonl', {
		trigger_id: run.id,
		branch: run.branch,
		isolated: run.isolated,
		ended_at: endedAt,
		...record,
	});
}

/** Appends one step to this run's own trajectory AND the root aggregate. */
export function recordStep(
	workspaceRoot: string,
	run: TriggerRun,
	step: Record<string, unknown>,
): void {
	const row = { trigger_id: run.id, at: new Date().toISOString(), ...step };
	try {
		fs.appendFileSync(path.join(run.dir, 'trajectory.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
	} catch {
		// Best-effort, same as the aggregate below.
	}
	appendAggregate(workspaceRoot, 'trajectory.jsonl', row);
}

/**
 * Releases the worktree, keeping the branch.
 *
 * The checkout is the expensive part and is pure scratch once the run ends;
 * the branch is the actual deliverable and is what the user reviews or
 * cherry-picks. `--force` because an agent routinely leaves build output
 * behind, and refusing to clean up over untracked artifacts would strand
 * gigabytes per run.
 */
export async function releaseRun(workspaceRoot: string, run: TriggerRun): Promise<void> {
	if (!run.isolated) {
		return;
	}
	try {
		await git(workspaceRoot, ['worktree', 'remove', '--force', run.tree]);
	} catch {
		// Already gone, or the user is sitting in it — prune will collect it.
		try {
			await git(workspaceRoot, ['worktree', 'prune']);
		} catch {
			// Nothing more to try; the stale entry is cosmetic.
		}
	}
}

/** Every run directory currently on disk, newest first. */
export function listRuns(workspaceRoot: string): Array<Record<string, unknown>> {
	let names: string[];
	try {
		names = fs.readdirSync(runsDir(workspaceRoot));
	} catch {
		return [];
	}
	const rows: Array<Record<string, unknown>> = [];
	for (const name of names) {
		try {
			rows.push(
				JSON.parse(
					fs.readFileSync(path.join(runsDir(workspaceRoot), name, 'meta.json'), 'utf8'),
				) as Record<string, unknown>,
			);
		} catch {
			// A run dir without readable meta is mid-creation or half-deleted.
		}
	}
	rows.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
	return rows;
}
