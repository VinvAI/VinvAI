/**
 * Run a Python DRIVER under tracelens to capture a fresh trace — the
 * measurement source for the trace-diff verdict. Unlike an HTTP probe replay
 * (which needs a running service and a healthy response), a traced driver run
 * works on a flow that raises: the functions that execute are still traced with
 * per-call duration and memory, so an optimization can be measured on a failing
 * flow, and memory (bytes) can be measured at all.
 *
 * The tracelens invocation, the interpreter, and the target package(s) are
 * lifted from the workspace's OWN recorded start command (the one bring-up
 * verified: `tracelens run -t <pkg> -o <trace> -- <python> ...`), so this uses
 * the exact configuration that already produces this project's captures — just
 * with the user command swapped for `python <driver>` and a fresh output path.
 *
 * IMPORTANT: tracelens degrades AST coverage for `python -c "<inline>"` — it
 * wants a real script FILE or `python -m module`. Drivers are therefore written
 * to a temp .py file, never passed inline (verified: an inline `-c` traced 0
 * user functions; a script file traced them fully).
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { readServices, readStartCommands } from '../bringup/bringup';

/** tracelens + interpreter + target packages, parsed from the start command. */
interface TracedConfig {
	tracelens: string;
	python: string;
	targetPackages: string[];
	cwd: string;
	/** Leading `VAR=value` assignments the recorded command carried (see below). */
	env: Record<string, string>;
}

/** Strips one layer of surrounding quotes from a shell token. */
function unquote(s: string): string {
	return s.replace(/^["']|["']$/g, '');
}

/** One leading `VAR=value` shell assignment, quoted or bare. */
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s+/;

/**
 * Splits the leading `VAR=value` assignments off a recorded command.
 *
 * Bring-up records what it ran in a SHELL, and what it ran routinely begins
 * `PATH="…/.venv/Scripts:$PATH" /path/to/tracelens run …`. A shell reads that
 * prefix as environment; `spawn` does not — it took the whole string as the
 * program name and failed ENOENT, so a driver that was written, saved and ready
 * to run never produced a trace. Observed live on the first end-to-end try-run.
 */
export function splitEnvPrefix(command: string): { env: Record<string, string>; rest: string } {
	const env: Record<string, string> = {};
	let rest = command.trimStart();
	for (let m = ENV_ASSIGNMENT.exec(rest); m; m = ENV_ASSIGNMENT.exec(rest)) {
		env[m[1]] = unquote(m[2]);
		rest = rest.slice(m[0].length);
	}
	return { env, rest };
}

/**
 * Rewrites an MSYS/Git-Bash absolute path (`/c/Anshul/…`) as a native Windows
 * one (`C:\Anshul\…`). Identity everywhere else, and on anything that is not a
 * single-letter drive root — a genuine POSIX path must survive untouched.
 *
 * Same root cause as the env prefix: bring-up drives Git Bash on Windows, so
 * the commands it records are spelled the way bash spells them, and
 * CreateProcess cannot resolve that spelling.
 */
export function nativePath(p: string): string {
	if (process.platform !== 'win32') {
		return p;
	}
	const m = /^\/([A-Za-z])\/(.*)$/.exec(p);
	return m ? path.win32.join(`${m[1].toUpperCase()}:\\`, m[2]) : p;
}

/** Env var names whose values are `:`-separated path lists in a shell. */
const PATH_LIST = /(^|_)PATH$/;

/**
 * Resolves one recorded assignment against the live environment: expands `$VAR`
 * / `${VAR}` (only a shell would have done it), rewrites MSYS spellings, and
 * re-joins list-valued vars with the platform's own separator.
 */
function resolveEnvValue(name: string, value: string, base: NodeJS.ProcessEnv): string {
	const expand = (v: string): string =>
		v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, a, b) =>
			base[a ?? b] ?? '',
		);
	if (!PATH_LIST.test(name)) {
		return nativePath(expand(value));
	}
	// Split BEFORE expanding: an expanded $PATH already uses the platform
	// separator, and re-splitting it on ':' would cut every `C:\` in half.
	return value
		.split(':')
		.map((seg) => expand(seg))
		.filter((seg) => seg.length > 0)
		.map((seg) => (seg.includes(path.delimiter) ? seg : nativePath(seg)))
		.join(path.delimiter);
}

/**
 * Parses ONE recorded start command into its traced-run pieces. Pure (no disk)
 * so the parse is unit-tested directly. Returns null when the command is not a
 * `tracelens run … -- <python> …` invocation.
 */
export function parseTracedCommand(
	command: string,
	workingDirectory: string | undefined,
	fallbackCwd: string,
): TracedConfig | null {
	const { env, rest: cmd } = splitEnvPrefix(command ?? '');
	const runIdx = cmd.indexOf(' run ');
	const dashIdx = cmd.indexOf(' -- ');
	if (!/tracelens/i.test(cmd) || runIdx < 0 || dashIdx < 0) {
		return null;
	}
	const tracelens = nativePath(unquote(cmd.slice(0, runIdx).trim()));
	const flags = cmd.slice(runIdx + 5, dashIdx);
	// Both spellings tracelens accepts (launcher/run.py: `("--target-package", "-t")`).
	// Matching only the long form silently yielded ZERO target packages for a
	// `-t`-spelled start command — a traced run that instruments nothing.
	const targetPackages = [...flags.matchAll(/(?:--target-package|-t)\s+(\S+)/g)].map((m) =>
		unquote(m[1]),
	);
	const after = cmd.slice(dashIdx + 4).trim();
	const python = nativePath(unquote(after.split(/\s+/)[0] ?? ''));
	if (!tracelens || !python) {
		return null;
	}
	return {
		tracelens,
		python,
		targetPackages,
		cwd: nativePath(workingDirectory ?? fallbackCwd),
		env,
	};
}

/**
 * Reconstructs the traced-run configuration from a verified tracelens start
 * command. Returns null when no service records a tracelens-wrapped command
 * (nothing to trace against).
 */
export function tracedConfig(workspaceRoot: string): TracedConfig | null {
	for (const s of readServices(workspaceRoot)) {
		for (const c of readStartCommands(workspaceRoot, s.name)) {
			const parsed = parseTracedCommand(c.command ?? '', c.working_directory, workspaceRoot);
			if (parsed) {
				return parsed;
			}
		}
	}
	return null;
}

/** Bounded wall clock for a traced driver run (env-tunable). */
function driverTimeoutMs(): number {
	const raw = Number.parseFloat(process.env.VINV_TRACED_RUN_TIMEOUT_S ?? '150');
	return (Number.isFinite(raw) && raw > 0 ? raw : 150) * 1000;
}

/** The result of one traced driver run. */
export interface TracedRunResult {
	/** True when a non-empty trace landed at `traceFile`. */
	ok: boolean;
	traceFile: string;
	exitCode: number | null;
	timedOut: boolean;
	/** Tail of combined stdout/stderr, for evidence. */
	outputTail: string;
}

/**
 * Runs `python <driverScript> <args>` under tracelens, capturing to `outTrace`.
 * Best-effort and bounded — never throws; reports `ok` from whether a non-empty
 * trace was produced (a driver that RAISES still traces the functions that ran,
 * which is the whole point). The caller supplies the driver (e.g. the acceptance
 * test runner) and reads the trace with collectCallSamples.
 */
export async function runDriverUnderTracing(
	workspaceRoot: string,
	driverScript: string,
	args: string[],
	outTrace: string,
): Promise<TracedRunResult> {
	const base: TracedRunResult = { ok: false, traceFile: outTrace, exitCode: null, timedOut: false, outputTail: '' };
	const cfg = tracedConfig(workspaceRoot);
	if (!cfg) {
		return { ...base, outputTail: 'no tracelens-wrapped start command recorded for this workspace' };
	}
	const targetFlags = cfg.targetPackages.flatMap((p) => ['-t', p]);
	// tracelens flags BEFORE `--`, then the unmodified user command AFTER it.
	const argv = [
		cfg.tracelens,
		'run',
		...targetFlags,
		'-o',
		outTrace,
		'--standard',
		'--',
		cfg.python,
		driverScript,
		...args,
	];
	try {
		fs.rmSync(outTrace, { force: true });
	} catch {
		// nothing to clear
	}
	return new Promise<TracedRunResult>((resolve) => {
		let child;
		try {
			// The recorded command's own env prefix, resolved against this process's
			// environment — that prefix is usually what puts the venv's Scripts dir
			// ahead of everything else, which is how tracelens finds the interpreter
			// and its DLLs.
			const childEnv: NodeJS.ProcessEnv = { ...process.env };
			for (const [k, v] of Object.entries(cfg.env)) {
				childEnv[k] = resolveEnvValue(k, v, process.env);
			}
			child = spawn(argv[0], argv.slice(1), { cwd: cfg.cwd, env: childEnv, windowsHide: true });
		} catch (e) {
			resolve({ ...base, outputTail: e instanceof Error ? e.message : String(e) });
			return;
		}
		let tail = '';
		const absorb = (c: Buffer): void => {
			tail = (tail + c.toString('utf8')).slice(-8000);
		};
		child.stdout?.on('data', absorb);
		child.stderr?.on('data', absorb);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill('SIGKILL');
			} catch {
				// already gone
			}
		}, driverTimeoutMs());
		child.on('exit', (code) => {
			clearTimeout(timer);
			let ok = false;
			try {
				ok = fs.statSync(outTrace).size > 0;
			} catch {
				ok = false;
			}
			resolve({ ok, traceFile: outTrace, exitCode: code, timedOut, outputTail: tail });
		});
		child.on('error', (e) => {
			clearTimeout(timer);
			resolve({ ...base, outputTail: e instanceof Error ? e.message : String(e) });
		});
	});
}
