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
import { readServices, readStartCommands } from '../bringup/bringup';

/** tracelens + interpreter + target packages, parsed from the start command. */
interface TracedConfig {
	tracelens: string;
	python: string;
	targetPackages: string[];
	cwd: string;
}

/** Strips one layer of surrounding quotes from a shell token. */
function unquote(s: string): string {
	return s.replace(/^["']|["']$/g, '');
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
	const cmd = command ?? '';
	const runIdx = cmd.indexOf(' run ');
	const dashIdx = cmd.indexOf(' -- ');
	if (!/tracelens/i.test(cmd) || runIdx < 0 || dashIdx < 0) {
		return null;
	}
	const tracelens = unquote(cmd.slice(0, runIdx).trim());
	const flags = cmd.slice(runIdx + 5, dashIdx);
	const targetPackages = [...flags.matchAll(/--target-package\s+(\S+)/g)].map((m) => unquote(m[1]));
	const after = cmd.slice(dashIdx + 4).trim();
	const python = unquote(after.split(/\s+/)[0] ?? '');
	if (!tracelens || !python) {
		return null;
	}
	return { tracelens, python, targetPackages, cwd: workingDirectory ?? fallbackCwd };
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
			child = spawn(argv[0], argv.slice(1), { cwd: cfg.cwd, env: process.env, windowsHide: true });
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
