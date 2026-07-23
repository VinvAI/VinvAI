/**
 * A2 — Body-hash symbol identity.
 *
 * The trace keys everything by a symbol's dotted qualname (`component`). But a
 * name is not an identity: if you edit a function's body and re-run, the name is
 * unchanged, so name-keyed runtime facts from the old and new runs look like the
 * same thing — and a rename makes the *same* code look like two things. A hash of
 * the function's source *body* fixes both: same name + changed body → different
 * hash (facts from before the edit are distinguishable), and a moved/renamed
 * function with an unchanged body keeps its hash.
 *
 * Trimmed scope: just a stable body hash resolved from source on demand. No
 * signature/AST-graph identity, no version graph, no bitemporal formalism — those
 * are platform concerns, not what a dev needs to tell "did this code change
 * between my two runs".
 *
 * Resolution is best-effort and static: given a qualname, find the Python `def`
 * in the workspace and hash the indented block beneath it. vscode-free (fs/path
 * /crypto only) so the standalone MCP server can call it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface BodyHash {
	/** The qualname we resolved. */
	component: string;
	/** Short (last-segment) function name. */
	name: string;
	/** Resolved source file, workspace-relative; null when unresolved. */
	file: string | null;
	/** 1-based line of the `def`; null when unresolved. */
	line: number | null;
	/** 16-hex-char sha256 prefix of the normalized body; null when unresolved. */
	hash: string | null;
	/** First non-blank body lines, for a human to eyeball. */
	excerpt: string[];
	/** True when several files/defs matched and we picked the first. */
	ambiguous: boolean;
}

const IGNORE_DIRS = new Set([
	'.git',
	'.vinv',
	'node_modules',
	'.venv',
	'venv',
	'__pycache__',
	'.mypy_cache',
	'.pytest_cache',
	'dist',
	'build',
	'.tox',
]);

/** All workspace `.py` files (bounded recursion, skipping vendor/build dirs). */
function pythonFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 12) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (!IGNORE_DIRS.has(e.name)) {
					walk(path.join(dir, e.name), depth + 1);
				}
			} else if (e.isFile() && e.name.endsWith('.py')) {
				out.push(path.join(dir, e.name));
			}
		}
	};
	walk(root, 0);
	return out;
}

/** Leading-whitespace width of a line (tabs counted as one column each). */
function indentOf(line: string): number {
	let i = 0;
	while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
		i += 1;
	}
	return i;
}

/**
 * Extracts the body block of `def <name>` starting at `defLineIdx`: every line
 * after the signature that is more-indented than the `def` (blank lines allowed),
 * stopping at the first line that dedents to or past the `def`'s own indent.
 * Returns the body lines with the `def`'s indentation stripped so the hash is
 * insensitive to where the function sits (a moved-but-unchanged function keeps
 * its hash).
 */
function extractBody(lines: string[], defLineIdx: number): string[] {
	const defIndent = indentOf(lines[defLineIdx]);
	// Skip a possibly multi-line signature: advance until the line ending the
	// signature (a line whose stripped text ends with ':').
	let i = defLineIdx;
	while (i < lines.length && !lines[i].replace(/\s+$/, '').endsWith(':')) {
		i += 1;
	}
	i += 1; // first body line
	const body: string[] = [];
	for (; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim() === '') {
			body.push('');
			continue;
		}
		if (indentOf(line) <= defIndent) {
			break;
		}
		body.push(line.slice(defIndent));
	}
	// Trim trailing blank lines so a whitespace-only edit at the tail doesn't
	// change identity.
	while (body.length && body[body.length - 1].trim() === '') {
		body.pop();
	}
	return body;
}

function hashBody(body: string[]): string {
	// Normalize line endings and strip trailing whitespace per line so cosmetic
	// reflows don't churn identity, but real code changes do.
	const normalized = body.map((l) => l.replace(/\s+$/, '')).join('\n');
	return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Resolves a qualname to a source `def` and hashes its body. Uses the qualname's
 * module segments (everything before the final name) as a path hint to prefer the
 * right file when several define the same function name.
 */
export function bodyHashForComponent(workspaceRoot: string, component: string): BodyHash {
	const name = component.includes('.') ? component.slice(component.lastIndexOf('.') + 1) : component;
	const moduleHint = component.includes('.')
		? component.slice(0, component.lastIndexOf('.')).replace(/\./g, path.sep)
		: '';

	const defRe = new RegExp(`^[ \\t]*(async[ \\t]+)?def[ \\t]+${escapeRe(name)}[ \\t]*\\(`);

	const matches: { file: string; idx: number; lines: string[] }[] = [];
	for (const file of pythonFiles(workspaceRoot)) {
		let text: string;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i += 1) {
			if (defRe.test(lines[i])) {
				matches.push({ file, idx: i, lines });
			}
		}
	}

	if (matches.length === 0) {
		return { component, name, file: null, line: null, hash: null, excerpt: [], ambiguous: false };
	}

	// Prefer a file whose path contains the module hint.
	let chosen = matches[0];
	if (moduleHint) {
		const hinted = matches.find((m) => m.file.includes(moduleHint));
		if (hinted) {
			chosen = hinted;
		}
	}

	const body = extractBody(chosen.lines, chosen.idx);
	const excerpt = body.filter((l) => l.trim() !== '').slice(0, 5);
	return {
		component,
		name,
		file: path.relative(workspaceRoot, chosen.file),
		line: chosen.idx + 1,
		hash: hashBody(body),
		excerpt,
		ambiguous: matches.length > 1,
	};
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
