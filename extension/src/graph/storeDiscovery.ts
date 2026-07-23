/**
 * Discovery of Vinv stores (.vinv directories) within a workspace, and the
 * provenance facts every evidence reply should carry.
 *
 * The MCP servers were launched with a single positional root and assumed
 * `<root>/.vinv` was THE store. That assumption silently splits evidence when
 * the user opens a parent folder containing repos that each carry their own
 * .vinv (verified live: the parent's near-empty store answered "no issues"
 * while a child repo's store held four currently-failing symbols). Discovery
 * replaces the positional assumption with an observed fact: every store under
 * the root is found, described, and reported with provenance — never silently
 * aggregated (stores have independent epoch counters; mixing them would
 * corrupt the epoch join).
 *
 * Deliberately vscode-free: imported by the standalone MCP stdio servers.
 */
import * as fs from 'fs';
import * as path from 'path';

/** One discovered store root (the directory CONTAINING .vinv). */
export interface DiscoveredStore {
	/** Workspace-like root that owns the .vinv directory. */
	root: string;
	/** True when .vinv/index/meta.json parses. */
	hasIndex: boolean;
	/** Index epoch from meta.json (0 when absent). */
	epoch: number;
	/** meta.updated_unix when present (0 otherwise). */
	updatedUnix: number;
	/** Number of non-empty trace.jsonl capture files. */
	captureCount: number;
	/** Newest capture mtime in ms (0 when none). */
	newestCaptureMs: number;
	/**
	 * True when every capture session with a summary reports
	 * modules_rewritten === 0 — the tracer ran but instrumented nothing, so
	 * the captures structurally cannot contain symbol evidence.
	 */
	allCapturesUninstrumented: boolean;
}

// Directories that can never contain a project the user meant to observe.
// This is a structural skip-list (package caches, VCS internals), not a
// tunable threshold.
const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.hg',
	'.svn',
	'venv',
	'.venv',
	'__pycache__',
	'dist',
	'out',
	'target',
	'.vinv',
]);

function describeStore(root: string): DiscoveredStore {
	let hasIndex = false;
	let epoch = 0;
	let updatedUnix = 0;
	try {
		const meta = JSON.parse(
			fs.readFileSync(path.join(root, '.vinv', 'index', 'meta.json'), 'utf8'),
		) as { epoch?: number; updated_unix?: number };
		hasIndex = true;
		epoch = typeof meta.epoch === 'number' ? meta.epoch : 0;
		updatedUnix = typeof meta.updated_unix === 'number' ? meta.updated_unix : 0;
	} catch {
		// No readable index — still a store if captures exist.
	}
	let captureCount = 0;
	let newestCaptureMs = 0;
	let sessionsWithSummary = 0;
	let uninstrumentedSessions = 0;
	const capturesRoot = path.join(root, '.vinv', 'captures');
	const walkCaptures = (dir: string, depth: number): void => {
		if (depth > 6) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				walkCaptures(full, depth + 1);
			} else if (e.isFile() && e.name === 'trace.jsonl') {
				try {
					const st = fs.statSync(full);
					if (st.size > 0) {
						captureCount += 1;
						newestCaptureMs = Math.max(newestCaptureMs, st.mtimeMs);
					}
				} catch {
					// Vanished between listing and stat.
				}
			} else if (e.isFile() && e.name === 'trace.jsonl.summary.json') {
				try {
					const summary = JSON.parse(fs.readFileSync(full, 'utf8')) as {
						coverage?: { modules_rewritten?: number };
					};
					if (typeof summary.coverage?.modules_rewritten === 'number') {
						sessionsWithSummary += 1;
						if (summary.coverage.modules_rewritten === 0) {
							uninstrumentedSessions += 1;
						}
					}
				} catch {
					// Unreadable summary — no instrumentation verdict from it.
				}
			}
		}
	};
	walkCaptures(capturesRoot, 0);
	return {
		root,
		hasIndex,
		epoch,
		updatedUnix,
		captureCount,
		newestCaptureMs,
		allCapturesUninstrumented:
			sessionsWithSummary > 0 && uninstrumentedSessions === sessionsWithSummary,
	};
}

/**
 * Every store at or under `root` (bounded walk, symlink-safe, never ascends).
 * The root's own store (when present) is always FIRST; the rest follow by
 * evidence recency — capture recency first (runtime evidence is what the
 * read-side tools serve), then index update time, then path for determinism.
 */
export function discoverStores(root: string, maxDepth = 3): DiscoveredStore[] {
	const found: DiscoveredStore[] = [];
	const seen = new Set<string>();
	const visit = (dir: string, depth: number): void => {
		let real: string;
		try {
			real = fs.realpathSync(dir);
		} catch {
			return;
		}
		if (seen.has(real)) {
			return;
		}
		seen.add(real);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((e) => e.isDirectory() && e.name === '.vinv')) {
			found.push(describeStore(dir));
		}
		if (depth >= maxDepth) {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
				visit(path.join(dir, e.name), depth + 1);
			}
		}
	};
	visit(root, 0);
	const rootStore = found.filter((s) => s.root === root);
	const rest = found
		.filter((s) => s.root !== root)
		.sort(
			(a, b) =>
				b.newestCaptureMs - a.newestCaptureMs ||
				b.updatedUnix - a.updatedUnix ||
				a.root.localeCompare(b.root),
		);
	return [...rootStore, ...rest];
}

/**
 * One provenance line for a store — stating WHAT was read is the difference
 * between "no issues" meaning healthy and "no issues" meaning wrong store.
 */
export function describeProvenance(s: DiscoveredStore, nowMs: number): string {
	const parts = [
		`store ${s.root}`,
		s.hasIndex ? `index epoch ${s.epoch}` : 'no index',
		`${s.captureCount} capture(s)`,
	];
	if (s.captureCount > 0 && s.newestCaptureMs > 0) {
		const ageH = Math.max(0, (nowMs - s.newestCaptureMs) / 3_600_000);
		parts.push(`newest capture ${ageH < 48 ? `${ageH.toFixed(1)}h` : `${(ageH / 24).toFixed(1)}d`} old`);
	}
	if (s.allCapturesUninstrumented) {
		parts.push(
			'WARNING: the tracer instrumented 0 modules in every summarized session — captures hold no symbol-level evidence (re-run the service under tracing)',
		);
	}
	return parts.join(', ');
}
