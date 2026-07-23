import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/** The entry we keep in the workspace .gitignore so Vinv's local artifacts aren't committed. */
const VINV_IGNORE_ENTRY = '.vinv/';

/**
 * Ensures each workspace folder's .gitignore excludes the `.vinv/` directory
 * (captures, identification index, reports) — the same way tools like Claude keep
 * `.claude/` out of source control.
 *
 * Idempotent and conservative: only touches a folder that is a git repo (has a
 * `.git`), appends the entry only when it isn't already present, creates the
 * .gitignore if missing, and never rewrites unrelated lines.
 */
export function ensureVinvGitignored(): void {
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		try {
			ensureForFolder(folder.uri.fsPath);
		} catch {
			// Best-effort: a failure here must never block activation.
		}
	}
}

function ensureForFolder(root: string): void {
	// Only manage .gitignore for actual git repos — don't create one where the
	// user hasn't opted into git.
	if (!fs.existsSync(path.join(root, '.git'))) {
		return;
	}

	const gitignorePath = path.join(root, '.gitignore');
	let content = '';
	try {
		content = fs.readFileSync(gitignorePath, 'utf8');
	} catch {
		content = ''; // missing file → we'll create it
	}

	// Already ignored? Accept common equivalent spellings so we don't double-add.
	const present = content
		.split('\n')
		.map((l) => l.trim())
		.some((l) => l === '.vinv' || l === '.vinv/' || l === '/.vinv' || l === '/.vinv/');
	if (present) {
		return;
	}

	const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
	const block = `${prefix}\n# Vinv local artifacts (captures, index, reports)\n${VINV_IGNORE_ENTRY}\n`;
	fs.writeFileSync(gitignorePath, content + block, 'utf8');
}
