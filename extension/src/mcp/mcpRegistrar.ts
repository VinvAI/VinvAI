/**
 * Client-agnostic MCP registrar.
 *
 * The two Vinv MCP stdio servers (`vinv-index` static code search, `vinv-runtime`
 * observe-only runtime tools) are just Node programs launched with a
 * command/args/env. Every agent that speaks MCP wants that same launch spec, only
 * in its own config dialect and file location. This module:
 *
 *   1. builds the launch spec for both servers once, and
 *   2. detects which agents the developer actually uses — by the config folders
 *      they leave behind (`.cursor/`, `.claude/`, `~/.codex/`, …) — and writes
 *      each one's MCP config in the right format.
 *
 * Detection is folder-based on purpose: if `~/.codex` exists the user runs Codex,
 * so we wire Codex up; if it doesn't, we leave it alone. All writes are idempotent
 * merges that never touch config the user set for other servers, and every target
 * has a matching remove() so registration is fully reversible.
 *
 * The launch spec contains machine-specific absolute paths (the editor binary,
 * the installed extension dir), so it must only ever land in per-machine config.
 * That is why Claude Code registration goes to local scope inside ~/.claude.json
 * rather than the repo-tracked .mcp.json (which would break for teammates and
 * additionally sits behind Claude Code's per-project approval prompt), and why
 * VS Code uses the native McpServerDefinitionProvider API when the host has it,
 * with .vscode/mcp.json only as the pre-1.101 fallback.
 *
 * Launch command: we reuse the host editor's own binary (`process.execPath`) with
 * `ELECTRON_RUN_AS_NODE=1`, exactly as the original Cursor registrar did — it is a
 * stable absolute path that behaves as a Node interpreter, and it's guaranteed to
 * exist because we're running inside it. That keeps a single spec working across
 * every client without hunting for a system `node`.
 */
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const INDEX_KEY = 'vinv-index';
const RUNTIME_KEY = 'vinv-runtime';
/** The write half: reports an external endpoint-test run back into .vinv. */
const EXERCISE_KEY = 'vinv-exercise';
/** Server keys written by older extension versions, stripped on every write. */
const LEGACY_KEYS = ['vinv-ahsi'];
/** Every key we own. Removal must cover all of them or teardown leaves orphans. */
const MANAGED_KEYS = [INDEX_KEY, RUNTIME_KEY, EXERCISE_KEY, ...LEGACY_KEYS];
/** The keys a fully-registered config carries (legacy names excluded). */
const CURRENT_KEYS = [INDEX_KEY, RUNTIME_KEY, EXERCISE_KEY];

/** One MCP server's launch spec, in the neutral shape every client maps from. */
export interface McpServerSpec {
	key: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

/** Builds the launch specs for both Vinv servers for a workspace. */
export function buildServerSpecs(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): McpServerSpec[] {
	const indexScript = path.join(context.extensionPath, 'out', 'mcp', 'indexServer.js');
	const runtimeScript = path.join(context.extensionPath, 'out', 'mcp', 'runtimeServer.js');
	const exerciseScript = path.join(context.extensionPath, 'out', 'mcp', 'exerciseServer.js');

	// Neither server carries secrets in its launch spec: the API key would
	// otherwise be serialized into repo-tracked config (.mcp.json, .cursor/mcp.json)
	// and is trivially committed. The index server instead reads its embedding
	// credentials from ~/.vinv/config.json at runtime; the runtime server needs
	// only the Electron-as-Node shim.
	const indexEnv: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };

	return [
		{ key: INDEX_KEY, command: process.execPath, args: [indexScript, workspaceRoot], env: indexEnv },
		{
			key: RUNTIME_KEY,
			command: process.execPath,
			args: [runtimeScript, workspaceRoot],
			env: { ELECTRON_RUN_AS_NODE: '1' },
		},
		{
			key: EXERCISE_KEY,
			command: process.execPath,
			args: [exerciseScript, workspaceRoot],
			env: { ELECTRON_RUN_AS_NODE: '1' },
		},
	];
}

/** A registration target: one agent's config file, format, and detection rule. */
export interface McpClientTarget {
	id: string;
	label: string;
	/** True when this agent appears to be in use for the given workspace. */
	detect(workspaceRoot: string): boolean;
	/** Absolute path of the config file we manage for this agent. */
	configPath(workspaceRoot: string): string;
	/** Merge the specs into the config (idempotent). Returns true if the file changed. */
	write(specs: McpServerSpec[], workspaceRoot: string): boolean;
	/** Remove our entries. Returns true if the file changed. */
	remove(workspaceRoot: string): boolean;
	/** True when our entries are already present. */
	isRegistered(workspaceRoot: string): boolean;
}

// ---------------------------------------------------------------------------
// JSON targets ({"mcpServers": {...}} and VS Code's {"servers": {...}})
// ---------------------------------------------------------------------------

interface JsonMcpConfig {
	mcpServers?: Record<string, unknown>;
	servers?: Record<string, unknown>;
}

function readJson(file: string): JsonMcpConfig {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonMcpConfig;
	} catch {
		return {};
	}
}

/**
 * Reads a JSON object, distinguishing "missing" (fresh `{}`) from "unreadable
 * or corrupt" (`null`). Callers that rewrite a file owned by another program
 * (~/.claude.json holds all of Claude Code's own state) must abort on `null`
 * rather than clobber it with a config that contains only our entries.
 */
function readJsonObjectStrict(file: string): Record<string, unknown> | null {
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch {
		return fs.existsSync(file) ? null : {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Writes `content` to `file` (creating parents) only when it differs on disk. */
function writeIfChanged(file: string, content: string): boolean {
	try {
		if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) {
			return false;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content, 'utf8');
		return true;
	} catch {
		return false;
	}
}

/**
 * Builds a JSON MCP target. `containerKey` is `mcpServers` (Cursor/Claude Code)
 * or `servers` (VS Code); `stdioType` adds the `"type": "stdio"` field VS Code
 * requires on each entry.
 */
function jsonTarget(opts: {
	id: string;
	label: string;
	containerKey: 'mcpServers' | 'servers';
	stdioType: boolean;
	detect: (workspaceRoot: string) => boolean;
	configPath: (workspaceRoot: string) => string;
}): McpClientTarget {
	const entryOf = (spec: McpServerSpec): Record<string, unknown> => {
		const entry: Record<string, unknown> = {
			command: spec.command,
			args: spec.args,
			env: spec.env,
		};
		if (opts.stdioType) {
			entry.type = 'stdio';
		}
		return entry;
	};

	return {
		id: opts.id,
		label: opts.label,
		detect: opts.detect,
		configPath: opts.configPath,
		write(specs, workspaceRoot) {
			const file = opts.configPath(workspaceRoot);
			const config = readJson(file);
			const container = (config[opts.containerKey] ?? {}) as Record<string, unknown>;
			// Drop entries a previous extension version registered under old names.
			for (const key of LEGACY_KEYS) {
				delete container[key];
			}
			for (const spec of specs) {
				container[spec.key] = entryOf(spec);
			}
			config[opts.containerKey] = container;
			return writeIfChanged(file, JSON.stringify(config, null, 2) + '\n');
		},
		remove(workspaceRoot) {
			const file = opts.configPath(workspaceRoot);
			if (!fs.existsSync(file)) {
				return false;
			}
			const config = readJson(file);
			const container = config[opts.containerKey];
			if (!container) {
				return false;
			}
			let changed = false;
			for (const key of MANAGED_KEYS) {
				if (key in container) {
					delete container[key];
					changed = true;
				}
			}
			return changed ? writeIfChanged(file, JSON.stringify(config, null, 2) + '\n') : false;
		},
		isRegistered(workspaceRoot) {
			const config = readJson(opts.configPath(workspaceRoot));
			const container = config[opts.containerKey];
			return !!container && CURRENT_KEYS.every((k) => k in container);
		},
	};
}

// ---------------------------------------------------------------------------
// Codex TOML target (~/.codex/config.toml)
// ---------------------------------------------------------------------------

function tomlEscape(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tomlArray(items: string[]): string {
	return '[' + items.map((i) => `"${tomlEscape(i)}"`).join(', ') + ']';
}

/** Renders one server as `[mcp_servers.<key>]` plus an `.env` subtable. */
function codexBlock(spec: McpServerSpec): string {
	const lines = [
		`[mcp_servers.${spec.key}]`,
		`command = "${tomlEscape(spec.command)}"`,
		`args = ${tomlArray(spec.args)}`,
	];
	const envKeys = Object.keys(spec.env);
	if (envKeys.length) {
		lines.push('', `[mcp_servers.${spec.key}.env]`);
		for (const k of envKeys) {
			lines.push(`${k} = "${tomlEscape(spec.env[k])}"`);
		}
	}
	return lines.join('\n');
}

/**
 * Strips any existing `[mcp_servers.<key>]` block (and its `.env` subtable) for
 * our keys from a TOML document, so a rewrite doesn't duplicate them. Walks
 * top-level tables: a section is dropped when its header is one of ours, up to the
 * next top-level `[` header or EOF.
 */
function stripCodexBlocks(toml: string): string {
	const lines = toml.split('\n');
	const out: string[] = [];
	const ours = new Set(
		MANAGED_KEYS.flatMap((key) => [`[mcp_servers.${key}]`, `[mcp_servers.${key}.env]`]),
	);
	let skipping = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('[')) {
			skipping = ours.has(trimmed);
		}
		if (!skipping) {
			out.push(line);
		}
	}
	return out.join('\n');
}

function codexTarget(): McpClientTarget {
	const configPath = (): string => path.join(os.homedir(), '.codex', 'config.toml');
	return {
		id: 'codex',
		label: 'Codex',
		detect: () => fs.existsSync(path.join(os.homedir(), '.codex')),
		configPath,
		write(specs) {
			const file = configPath();
			let existing = '';
			try {
				existing = fs.readFileSync(file, 'utf8');
			} catch {
				existing = '';
			}
			let body = stripCodexBlocks(existing).replace(/\s+$/, '');
			const blocks = specs.map(codexBlock).join('\n\n');
			body = body ? `${body}\n\n${blocks}\n` : `${blocks}\n`;
			return writeIfChanged(file, body);
		},
		remove() {
			const file = configPath();
			if (!fs.existsSync(file)) {
				return false;
			}
			let existing: string;
			try {
				existing = fs.readFileSync(file, 'utf8');
			} catch {
				return false;
			}
			const stripped = stripCodexBlocks(existing).replace(/\s+$/, '') + '\n';
			return writeIfChanged(file, stripped);
		},
		isRegistered() {
			try {
				const toml = fs.readFileSync(configPath(), 'utf8');
				return CURRENT_KEYS.every((k) => toml.includes(`[mcp_servers.${k}]`));
			} catch {
				return false;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Claude Code target (~/.claude.json → projects.<root>.mcpServers, local scope)
// ---------------------------------------------------------------------------

/** Path equality as Claude Code keys its projects map (case-blind on Windows). */
function sameWorkspacePath(a: string, b: string): boolean {
	const normalize = (p: string): string => {
		const resolved = path.resolve(p);
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	};
	return normalize(a) === normalize(b);
}

/**
 * Strips our entries from the repo-tracked .mcp.json that older extension
 * versions wrote for Claude Code. If the file then holds nothing but an empty
 * `mcpServers` container (i.e. we created it), it is deleted outright.
 */
function stripLegacyProjectMcpJson(workspaceRoot: string): boolean {
	const file = path.join(workspaceRoot, '.mcp.json');
	if (!fs.existsSync(file)) {
		return false;
	}
	const config = readJsonObjectStrict(file);
	const servers = config?.mcpServers;
	if (!config || !servers || typeof servers !== 'object') {
		return false;
	}
	let changed = false;
	for (const key of [INDEX_KEY, RUNTIME_KEY, ...LEGACY_KEYS]) {
		if (key in (servers as Record<string, unknown>)) {
			delete (servers as Record<string, unknown>)[key];
			changed = true;
		}
	}
	if (!changed) {
		return false;
	}
	if (Object.keys(servers).length === 0 && Object.keys(config).length === 1) {
		try {
			fs.unlinkSync(file);
			return true;
		} catch {
			return false;
		}
	}
	return writeIfChanged(file, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Claude Code reads per-project ("local" scope) MCP servers from ~/.claude.json
 * under projects[<absolute workspace path>].mcpServers. Registering there keeps
 * the machine-specific launch spec out of the repo AND skips the approval
 * prompt Claude Code raises for project-scoped .mcp.json servers, so the tools
 * are available the moment a session starts. ~/.claude.json is Claude Code's
 * own state file: every write here merges into the parsed document and aborts
 * if the file cannot be parsed, so we never destroy state we don't own.
 */
function claudeTarget(): McpClientTarget {
	const configPath = (): string => path.join(os.homedir(), '.claude.json');

	/**
	 * Every projects-map key that denotes this workspace, falling back to the
	 * literal root when Claude Code has no entry yet.
	 *
	 * Claude Code creates one entry per distinct cwd *spelling* it is launched
	 * with and looks its project up by exact string, so the same directory
	 * routinely accumulates several keys (`c:\p`, `C:\p`, `C:/p`, …). VS Code
	 * hands us a lowercased drive letter in `fsPath`, so writing only the first
	 * match would register a spelling no shell-launched session ever reads. We
	 * write them all; we never invent spellings that aren't already present.
	 */
	const keysFor = (projects: Record<string, unknown>, workspaceRoot: string): string[] => {
		const matches = Object.keys(projects).filter((k) => sameWorkspacePath(k, workspaceRoot));
		return matches.length ? matches : [workspaceRoot];
	};

	/** The mcpServers container of each key denoting this workspace, if any. */
	const serversOf = (
		config: Record<string, unknown>,
		workspaceRoot: string,
	): Record<string, unknown>[] => {
		const projects = config.projects;
		if (!projects || typeof projects !== 'object') {
			return [];
		}
		const map = projects as Record<string, unknown>;
		return keysFor(map, workspaceRoot)
			.map((key) => {
				const project = map[key];
				if (!project || typeof project !== 'object') {
					return undefined;
				}
				const servers = (project as Record<string, unknown>).mcpServers;
				return servers && typeof servers === 'object'
					? (servers as Record<string, unknown>)
					: undefined;
			})
			.filter((s): s is Record<string, unknown> => s !== undefined);
	};

	return {
		id: 'claude',
		label: 'Claude Code',
		// Claude Code leaves a .claude/ in the project and/or home, plus ~/.claude.json.
		detect: (root) =>
			fs.existsSync(path.join(root, '.claude')) ||
			fs.existsSync(path.join(os.homedir(), '.claude')) ||
			fs.existsSync(configPath()),
		configPath,
		write(specs, workspaceRoot) {
			const file = configPath();
			const config = readJsonObjectStrict(file);
			if (config === null) {
				return false; // unparseable: leave Claude Code's state alone
			}
			const projects =
				config.projects && typeof config.projects === 'object'
					? (config.projects as Record<string, unknown>)
					: {};
			for (const key of keysFor(projects, workspaceRoot)) {
				const project =
					projects[key] && typeof projects[key] === 'object'
						? (projects[key] as Record<string, unknown>)
						: {};
				const servers =
					project.mcpServers && typeof project.mcpServers === 'object'
						? (project.mcpServers as Record<string, unknown>)
						: {};
				for (const legacy of LEGACY_KEYS) {
					delete servers[legacy];
				}
				for (const spec of specs) {
					servers[spec.key] = { command: spec.command, args: spec.args, env: spec.env };
				}
				project.mcpServers = servers;
				projects[key] = project;
			}
			config.projects = projects;
			const changedHome = writeIfChanged(file, JSON.stringify(config, null, 2) + '\n');
			const changedRepo = stripLegacyProjectMcpJson(workspaceRoot);
			return changedHome || changedRepo;
		},
		remove(workspaceRoot) {
			let changed = stripLegacyProjectMcpJson(workspaceRoot);
			const file = configPath();
			if (!fs.existsSync(file)) {
				return changed;
			}
			const config = readJsonObjectStrict(file);
			if (config === null) {
				return changed;
			}
			let removedAny = false;
			for (const servers of serversOf(config, workspaceRoot)) {
				for (const key of MANAGED_KEYS) {
					if (key in servers) {
						delete servers[key];
						removedAny = true;
					}
				}
			}
			if (removedAny) {
				changed = writeIfChanged(file, JSON.stringify(config, null, 2) + '\n') || changed;
			}
			return changed;
		},
		// Registered only when *every* spelling of this workspace carries the
		// servers: a session launched with an unregistered spelling sees none.
		isRegistered(workspaceRoot) {
			const config = readJsonObjectStrict(configPath());
			if (!config) {
				return false;
			}
			const all = serversOf(config, workspaceRoot);
			return all.length > 0 && all.every((s) => CURRENT_KEYS.every((k) => k in s));
		},
	};
}

// ---------------------------------------------------------------------------
// Native VS Code provider (vscode.lm.registerMcpServerDefinitionProvider)
// ---------------------------------------------------------------------------

interface NativeMcpApi {
	register: (
		id: string,
		provider: { provideMcpServerDefinitions: () => unknown[] },
	) => vscode.Disposable;
	StdioDefinition: new (
		label: string,
		command: string,
		args: string[],
		env: Record<string, string>,
	) => unknown;
}

/**
 * The stable MCP provider API (VS Code ≥ 1.101), or null on older hosts and
 * forks that lack it. Accessed through casts because we compile against the
 * 1.75 API surface to stay installable on those hosts.
 */
function nativeMcpApi(): NativeMcpApi | null {
	const api = vscode as unknown as {
		lm?: { registerMcpServerDefinitionProvider?: NativeMcpApi['register'] };
		McpStdioServerDefinition?: NativeMcpApi['StdioDefinition'];
	};
	const register = api.lm?.registerMcpServerDefinitionProvider;
	if (typeof register !== 'function' || typeof api.McpStdioServerDefinition !== 'function') {
		return null;
	}
	return { register: register.bind(api.lm), StdioDefinition: api.McpStdioServerDefinition };
}

/**
 * Registers the Vinv servers through the host's native MCP provider API, so
 * they appear in agent mode with no config file written into the workspace.
 * Definitions are computed lazily per call, following the current workspace
 * folder and the `enabled` toggle. Returns false when the host lacks the API
 * (the .vscode/mcp.json file target in MCP_TARGETS then covers VS Code).
 */
export function registerNativeVsCodeProvider(
	context: vscode.ExtensionContext,
	enabled: () => boolean,
): boolean {
	const api = nativeMcpApi();
	if (!api) {
		return false;
	}
	try {
		context.subscriptions.push(
			api.register('vinv.mcp', {
				provideMcpServerDefinitions: () => {
					const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (!root || !enabled()) {
						return [];
					}
					return buildServerSpecs(context, root).map(
						(spec) => new api.StdioDefinition(spec.key, spec.command, spec.args, spec.env),
					);
				},
			}),
		);
	} catch {
		return false; // e.g. contribution point mismatch: fall back to the file target
	}
	// The provider supersedes .vscode/mcp.json; drop entries an older version wrote.
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (root) {
		try {
			MCP_TARGETS.find((t) => t.id === 'vscode')?.remove(root);
		} catch {
			// best-effort cleanup
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// The target registry + detection
// ---------------------------------------------------------------------------

function isCursorHost(): boolean {
	return /cursor/i.test(vscode.env.appName);
}

function isVsCodeHost(): boolean {
	return /visual studio code/i.test(vscode.env.appName);
}

/** All known registration targets. */
export const MCP_TARGETS: McpClientTarget[] = [
	jsonTarget({
		id: 'cursor',
		label: 'Cursor',
		containerKey: 'mcpServers',
		stdioType: false,
		// The host is Cursor, or the workspace carries a .cursor/ dir.
		detect: (root) => isCursorHost() || fs.existsSync(path.join(root, '.cursor')),
		configPath: (root) => path.join(root, '.cursor', 'mcp.json'),
	}),
	jsonTarget({
		id: 'windsurf',
		label: 'Windsurf',
		containerKey: 'mcpServers',
		stdioType: false,
		// Windsurf (Codeium) keeps its global MCP config under ~/.codeium/windsurf.
		detect: () => fs.existsSync(path.join(os.homedir(), '.codeium', 'windsurf')),
		configPath: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
	}),
	claudeTarget(),
	jsonTarget({
		id: 'vscode',
		label: 'VS Code',
		containerKey: 'servers',
		stdioType: true,
		// Only when the host actually is VS Code (Cursor also has a .vscode/ dir)
		// AND it predates the native provider API that supersedes this file.
		detect: (root) =>
			isVsCodeHost() && !nativeMcpApi() && fs.existsSync(path.join(root, '.vscode')),
		configPath: (root) => path.join(root, '.vscode', 'mcp.json'),
	}),
	codexTarget(),
];

/** The subset of targets that appear to be in use for this workspace. */
export function detectTargets(workspaceRoot: string): McpClientTarget[] {
	return MCP_TARGETS.filter((t) => {
		try {
			return t.detect(workspaceRoot);
		} catch {
			return false;
		}
	});
}

/** Result of a registration sweep, one row per detected client. */
export interface RegistrationOutcome {
	id: string;
	label: string;
	configPath: string;
	changed: boolean;
}

/**
 * Detects every agent in use for the workspace and writes both Vinv MCP servers
 * into each one's config. Idempotent: re-running only rewrites a file when its
 * content actually differs. Returns one outcome per detected client.
 */
export function registerDetectedTargets(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): RegistrationOutcome[] {
	const specs = buildServerSpecs(context, workspaceRoot);
	const outcomes = detectTargets(workspaceRoot).map((t) => ({
		id: t.id,
		label: t.label,
		configPath: t.configPath(workspaceRoot),
		changed: t.write(specs, workspaceRoot),
	}));
	return outcomes;
}

/** Removes the Vinv MCP servers from every target's config (used on teardown). */
export function unregisterAllTargets(workspaceRoot: string): void {
	for (const t of MCP_TARGETS) {
		try {
			t.remove(workspaceRoot);
		} catch {
			// best-effort cleanup
		}
	}
}
