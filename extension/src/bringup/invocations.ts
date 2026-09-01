/**
 * Parameterized invocations: the many ways one run-to-completion unit is driven.
 *
 * A server has ONE way to start; a CLI has as many as it has subcommands, and a
 * library has as many as it has entry points. The recorded `commands` list in
 * .vinv/start_commands/<slug>.json cannot express that — it is a SEQUENCE (a
 * dependency, then the unit) that the runner joins with `&&`, not a set of
 * alternatives. So a CLI with five subcommands got one Run button that always
 * ran the same one, and its arguments were frozen at whatever bring-up happened
 * to verify.
 *
 * `invocations` is that missing axis. Each entry is a named, already-verified
 * command carrying a template plus the parameters that fill it, so the SAME
 * record serves three consumers that must not behave alike:
 *
 *   - the Run button asks a human, prefilled with defaults;
 *   - the exercise pass decides on its own and never prompts;
 *   - the replay gate / Auto-Pilot take the defaults, silently.
 *
 * **The invariant that keeps `verified: true` honest:** rendering an invocation
 * with all of its defaults must reproduce, byte for byte, the string bring-up
 * actually ran (`verification.rendered_command`). Without that check, adding a
 * parameter silently re-defines what "verified" attested to — the command on
 * record would no longer be the command that was proven to work.
 *
 * The rendering rules here are mirrored EXACTLY by `exerciser.invocation_render`
 * and `bringup.invocation_render` in Python. All three read the same vectors in
 * contracts/vectors/invocation_render.json; a change on one side that the others
 * do not make fails those suites rather than silently producing a different
 * command on the Run button than in the exercise pass.
 */
import * as fs from 'fs';
import * as path from 'path';

import { readStartCommands, serviceSlug, type StartCommand } from './bringup';

/** What kind of value a parameter holds — drives validation and rendering. */
export type ParamType = 'string' | 'int' | 'float' | 'enum' | 'path' | 'flag';

/** One fillable slot in an invocation's command template. */
export interface InvocationParam {
	/** Placeholder key: `{name}` in the command template. */
	name: string;
	type?: ParamType;
	/** The value used when nobody supplies one. Always a string. */
	default?: string;
	/** An empty value is refused rather than rendered away. */
	required?: boolean;
	/** Allowed values for `type: "enum"`. */
	choices?: string[];
	/**
	 * Resolve the choice list at prompt time instead of freezing it into the
	 * record. `entrypoints` reads the library's exported callables, which change
	 * with every index build — pinning them here would go stale on the first
	 * refactor and offer the user functions that no longer exist.
	 */
	choices_from?: 'entrypoints';
	help?: string;
	/**
	 * How a non-empty value joins the command, as a template containing
	 * `{value}` — e.g. `"--target {value}"`. Without it the value is substituted
	 * on its own. An EMPTY value renders the whole thing away, which is how
	 * "drive every entry point" is spelled: the flag disappears entirely rather
	 * than being passed with an empty argument.
	 */
	render?: string;
}

/** One verified way to drive a run-to-completion unit. */
export interface Invocation {
	/** Stable slug — the unit identity downstream, so never positional. */
	id: string;
	purpose?: string;
	/** The one the Run button and every headless consumer take. */
	default?: boolean;
	/** Command template; `{name}` placeholders are filled from `params`. */
	command: string;
	/** The exit code that means success — non-zero is legitimate for a linter. */
	expect_exit?: number;
	working_directory?: string;
	params?: InvocationParam[];
	verification?: {
		exit_code?: number;
		trace_lines?: number;
		trace_jsonl?: string;
		/** The exact string bring-up ran. Rendering the defaults must equal it. */
		rendered_command?: string;
	};
}

/** Raised when a template and its parameters disagree — never rendered past. */
export class InvocationRenderError extends Error {}

/**
 * Shell-quotes one value for the `bash -lc` the recorded command runs under.
 *
 * Left bare when it is an ordinary argv token, because that is what keeps the
 * defaults render byte-identical to the string bring-up verified — quoting
 * everything would be safe and would break the identity check on every existing
 * record.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(value: string): string {
	if (SAFE_TOKEN.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Rewrites a Windows drive-letter path into the `/c/…` spelling Git Bash reads.
 *
 * The recorded commands are bash-spelled by contract (a `C:\…` value arrives at
 * the program with the backslashes eaten as escapes, and a `C:/…` value has its
 * colon read as a PATH separator). Keyed off the SHAPE of the value, not the
 * host platform, so the shared vectors give the same answer everywhere.
 */
export function toBashPath(value: string): string {
	const drive = /^([A-Za-z]):[\\/](.*)$/.exec(value);
	if (drive) {
		return `/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
	}
	return value.replace(/\\/g, '/');
}

/** Values a `flag` parameter treats as "on". Anything else omits the flag. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** The text one parameter contributes, already quoted — '' means "omit". */
/**
 * `inQuotes` says the placeholder already sits inside a quoted span in the
 * template (`--vault "{vault}"`). Quoting again nests one set inside the other
 * and the program receives a value with literal quote characters in it: a path
 * under a directory with a space in its name became
 * `"'/Users/me/SEO - from Scratch/vault'"`, which no filesystem has, and every
 * parameterised invocation on that repo exited 2. The template's quotes are
 * already doing the job, so the value goes in bare.
 */
function substitute(param: InvocationParam, raw: string, inQuotes = false): string {
	const value = param.type === 'path' ? toBashPath(raw.trim()) : raw.trim();
	if (param.type === 'flag') {
		if (!TRUTHY.has(value.toLowerCase())) {
			return '';
		}
		return param.render ? param.render.replace(/\{value\}/g, '').trim() : `--${param.name}`;
	}
	if (value === '') {
		if (param.required) {
			throw new InvocationRenderError(`'${param.name}' is required but empty`);
		}
		return '';
	}
	if (param.type === 'enum' && param.choices && param.choices.length > 0) {
		if (!param.choices.includes(value)) {
			throw new InvocationRenderError(
				`'${param.name}' must be one of ${param.choices.join(', ')} (got '${value}')`,
			);
		}
	}
	if (param.type === 'int' && !/^-?\d+$/.test(value)) {
		throw new InvocationRenderError(`'${param.name}' must be a whole number (got '${value}')`);
	}
	if (param.type === 'float' && !/^-?\d+(\.\d+)?$/.test(value)) {
		throw new InvocationRenderError(`'${param.name}' must be a number (got '${value}')`);
	}
	const quoted = inQuotes ? value : shellQuote(value);
	return param.render ? param.render.replace(/\{value\}/g, quoted) : quoted;
}

/** Matches an escape (`{{` / `}}`) or a placeholder, in one pass. */
const TOKEN = /\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Fills an invocation's template with `args`, falling back to each parameter's
 * default. Throws rather than guessing: an unknown placeholder or a declared
 * parameter the template never uses is a malformed record, and rendering past it
 * would produce a command nobody verified.
 */
export function renderInvocation(
	invocation: Invocation,
	args: Record<string, string> = {},
): string {
	const params = new Map((invocation.params ?? []).map((p) => [p.name, p]));
	const used = new Set<string>();
	let out = '';
	let last = 0;
	TOKEN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TOKEN.exec(invocation.command)) !== null) {
		out += invocation.command.slice(last, match.index);
		last = match.index + match[0].length;
		if (match[0] === '{{' || match[0] === '}}') {
			out += match[0][0];
			continue;
		}
		const name = match[1];
		const param = params.get(name);
		if (!param) {
			throw new InvocationRenderError(
				`command uses {${name}} but no such parameter is declared on invocation '${invocation.id}'`,
			);
		}
		used.add(name);
		// Is this placeholder already inside a quoted span? Look at the
		// characters either side of it in the TEMPLATE, not at the value.
		const before = match.index > 0 ? invocation.command[match.index - 1] : '';
		const afterAt = match.index + match[0].length;
		const after = afterAt < invocation.command.length ? invocation.command[afterAt] : '';
		const inQuotes = before === after && (before === "'" || before === '"');
		const text = substitute(param, args[name] ?? param.default ?? '', inQuotes);
		if (text === '') {
			// An omitted parameter takes its own separating space with it, so the
			// defaults render stays byte-identical to the verified string instead of
			// leaving a tell-tale double space behind.
			out = out.replace(/ $/, '');
			continue;
		}
		out += text;
	}
	out += invocation.command.slice(last);
	for (const name of params.keys()) {
		if (!used.has(name)) {
			throw new InvocationRenderError(
				`invocation '${invocation.id}' declares parameter '${name}' but its command has no {${name}}`,
			);
		}
	}
	return out;
}

/**
 * The command to actually run, with any parameters filled in.
 *
 * A parameterless invocation is returned VERBATIM rather than rendered. That is
 * not an optimization: a recorded command may legitimately contain a literal
 * brace (`--format '{json}'`), and rendering it would raise on a placeholder
 * nobody meant to write. Only an invocation that declares parameters opts into
 * templating. Mirrors `exerciser.invocations.resolved_command`.
 */
export function resolvedCommand(
	invocation: Invocation,
	args?: Record<string, string>,
): string {
	if (!invocation.params || invocation.params.length === 0) {
		return invocation.command;
	}
	return renderInvocation(invocation, args);
}

/** Every parameter's default, the argument set every headless consumer uses. */
export function defaultArgs(invocation: Invocation): Record<string, string> {
	const out: Record<string, string> = {};
	for (const p of invocation.params ?? []) {
		out[p.name] = p.default ?? '';
	}
	return out;
}

/**
 * True when rendering the defaults reproduces the string bring-up verified.
 *
 * Returns true when no `rendered_command` was recorded — an older record simply
 * makes no claim, and refusing to run it would break every service brought up
 * before parameters existed.
 */
export function defaultsMatchVerified(invocation: Invocation): boolean {
	const recorded = invocation.verification?.rendered_command;
	if (typeof recorded !== 'string' || !recorded) {
		return true;
	}
	try {
		return renderInvocation(invocation, defaultArgs(invocation)) === recorded;
	} catch {
		return false;
	}
}

/** Filesystem-safe id for an invocation, mirroring the Python side. */
export function invocationSlug(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, '_') || 'invocation';
}

/** Reads and normalizes the `invocations` recorded for a service. */
export function readInvocations(workspaceRoot: string, service: string): Invocation[] {
	let parsed: { verified?: boolean; invocations?: unknown };
	try {
		parsed = JSON.parse(
			fs.readFileSync(
				path.join(workspaceRoot, '.vinv', 'start_commands', `${serviceSlug(service)}.json`),
				'utf8',
			),
		) as typeof parsed;
	} catch {
		return [];
	}
	// Same rule as readStartCommands: a `verified: false` file holds what a FAILED
	// bring-up tried, which is not known-good and must never reach the Run button.
	if (parsed.verified !== true || !Array.isArray(parsed.invocations)) {
		return [];
	}
	const out: Invocation[] = [];
	parsed.invocations.forEach((raw, index) => {
		if (typeof raw !== 'object' || raw === null) {
			return;
		}
		const entry = raw as Partial<Invocation>;
		if (typeof entry.command !== 'string' || !entry.command.trim()) {
			return;
		}
		out.push({
			...entry,
			// A missing id would otherwise fall back to position, which is exactly
			// the instability `invocations` exists to remove.
			id: invocationSlug(typeof entry.id === 'string' && entry.id ? entry.id : `run-${index + 1}`),
			command: entry.command,
			params: Array.isArray(entry.params)
				? entry.params.filter((p): p is InvocationParam => !!p && typeof p.name === 'string')
				: undefined,
		});
	});
	return out;
}

/**
 * The invocation a headless consumer runs: the one flagged `default`, else the
 * first. Never a prompt — probeRunner and Auto-Pilot call this with nobody
 * watching, and a modal there would hang the whole pipeline.
 */
export function defaultInvocation(invocations: Invocation[]): Invocation | undefined {
	return invocations.find((i) => i.default === true) ?? invocations[0];
}

/** What a launch will actually run, and what its exit is contracted to be. */
export interface LaunchPlan {
	/** The full `bash -lc` script: dependency entries, then the unit. */
	script: string;
	/** Working directory for the spawn. */
	cwd?: string;
	/** The invocation chosen, when this unit has any. */
	invocation?: Invocation;
	/** Arguments it was rendered with — recorded so a re-run repeats it. */
	args?: Record<string, string>;
	/**
	 * The exit code that means success, or null for a long-running server. Read
	 * from the chosen invocation rather than the file-level probe, because with
	 * several invocations there is no longer ONE contracted exit code: a repo's
	 * `report` exits 0 and its `check` exits 1, and reading the file-level value
	 * for both would dispatch a fix episode against a linter doing its job.
	 */
	expectExit: number | null;
	/** A record whose defaults no longer render to what bring-up verified. */
	warning?: string;
}

/** Joins the recorded entries into one script, preserving their order. */
function chain(commands: StartCommand[]): string {
	return commands
		.map((c) =>
			c.working_directory ? `cd ${JSON.stringify(c.working_directory)} && ${c.command}` : c.command,
		)
		.join(' && ');
}

/**
 * Works out what a Run should execute — the single decision point for
 * "which command, with which arguments".
 *
 * The two lists in the record answer different questions and must not be
 * conflated: `commands` is a SEQUENCE (bring a dependency up, then the unit),
 * while `invocations` is a set of ALTERNATIVES for the unit itself. So a chosen
 * invocation replaces the LAST entry of the chain — the unit — and leaves every
 * dependency entry before it in place. Without invocations this is exactly the
 * old behaviour: the whole chain, verbatim.
 *
 * Never prompts and never throws: probeRunner and Auto-Pilot call through here
 * with nobody watching. A template that will not render comes back as a plan
 * carrying the failure in `warning` rather than as an exception that would take
 * down the pipeline.
 */
export function buildLaunchPlan(
	workspaceRoot: string,
	service: string,
	opts?: { invocation?: string; args?: Record<string, string> },
): LaunchPlan | null {
	const commands = readStartCommands(workspaceRoot, service);
	if (commands.length === 0) {
		return null;
	}
	const invocations = readInvocations(workspaceRoot, service);
	if (invocations.length === 0) {
		return { script: chain(commands), cwd: commands[0].working_directory, expectExit: null };
	}
	const chosen =
		(opts?.invocation ? invocations.find((i) => i.id === opts.invocation) : undefined) ??
		defaultInvocation(invocations)!;
	const args = { ...defaultArgs(chosen), ...(opts?.args ?? {}) };
	const unit: StartCommand = {
		purpose: chosen.purpose,
		command: chosen.command,
		working_directory: chosen.working_directory ?? commands[commands.length - 1].working_directory,
	};
	let warning: string | undefined;
	try {
		unit.command = resolvedCommand(chosen, args);
	} catch (e) {
		warning =
			`'${service}' invocation '${chosen.id}' could not be filled in: ` +
			`${e instanceof Error ? e.message : String(e)}`;
	}
	if (!warning && !defaultsMatchVerified(chosen)) {
		warning =
			`'${service}' invocation '${chosen.id}' no longer renders to the command bring-up ` +
			'verified — its defaults were edited after the fact, so "verified" attests to a ' +
			'command that was never run. Set it up again to re-verify.';
	}
	const entries = [...commands.slice(0, -1), unit];
	return {
		script: chain(entries),
		cwd: entries[0].working_directory,
		invocation: chosen,
		args,
		// Run-to-completion by definition: `invocations` only ever appears on a
		// python_cli / python_library entry.
		expectExit: typeof chosen.expect_exit === 'number' ? chosen.expect_exit : 0,
		warning,
	};
}

/** Last-used arguments, per service: .vinv/run_args/<slug>.json */
interface RunArgsFile {
	service: string;
	last_invocation?: string;
	args?: Record<string, Record<string, string>>;
}

function runArgsPath(workspaceRoot: string, service: string): string {
	return path.join(workspaceRoot, '.vinv', 'run_args', `${serviceSlug(service)}.json`);
}

function readRunArgsFile(workspaceRoot: string, service: string): RunArgsFile {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(runArgsPath(workspaceRoot, service), 'utf8'),
		) as RunArgsFile;
		return { ...parsed, service };
	} catch {
		return { service };
	}
}

/**
 * What the user last ran this invocation with, or {} the first time.
 *
 * On disk rather than in workspaceState so the values survive a reload and can
 * be read, edited and committed like every other Vinv artifact — a fiddly argv
 * that took three tries to get right is worth sharing with the next person.
 */
export function readRunArgs(
	workspaceRoot: string,
	service: string,
	invocationId: string,
): Record<string, string> {
	return readRunArgsFile(workspaceRoot, service).args?.[invocationId] ?? {};
}

/** The invocation this service was last run as, if any. */
export function readLastInvocation(workspaceRoot: string, service: string): string | undefined {
	return readRunArgsFile(workspaceRoot, service).last_invocation;
}

/** Records the choice so the next run of a fiddly command is one click. */
export function writeRunArgs(
	workspaceRoot: string,
	service: string,
	invocationId: string,
	args: Record<string, string>,
): void {
	const file = readRunArgsFile(workspaceRoot, service);
	file.last_invocation = invocationId;
	file.args = { ...(file.args ?? {}), [invocationId]: args };
	try {
		const target = runArgsPath(workspaceRoot, service);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
	} catch {
		// A prefill we could not persist is a lost convenience, never a failed run.
	}
}
