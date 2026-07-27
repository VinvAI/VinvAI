/**
 * Reward engine — the impure half of the multi-signal episode reward
 * (rewardSignals.ts holds the pure math and contracts).
 *
 * Orchestrates, per episode:
 *  1. ACCEPTANCE-TEST GENERATION (once, before the fix is dispatched): the
 *     user's own harness authors a test file from the issue + goal + graph
 *     context; Vinv extracts it from the reply and stores it OUTSIDE the
 *     workspace (~/.vinv/acceptance/<episode>/), where the fixing agent
 *     cannot read or edit it. The tests are then executed on the PRE-fix
 *     code and must FAIL deterministically (twice) to count — the SWE-bench
 *     fail-to-pass discipline: a test that passes on broken code proves
 *     nothing and is discarded.
 *  2. POST-FIX TEST RUNS: the same file re-run (twice, must agree) after an
 *     attempt — pass is objective evidence the fix meets the issue, which
 *     gives GENERAL (non-service) episodes the objective oracle they never
 *     had; fail feeds concrete evidence into the next attempt's pack.
 *  3. DIFF AUDIT: deterministic anti-cheat flags over `git diff` against the
 *     pre-episode snapshot ref (plus untracked files).
 *  4. LLM JUDGE (bounded): summoned only when flags exist or a pass is
 *     heuristic; can push toward scrutiny, never rescue a failed gate.
 *
 * Every step degrades to 'unavailable' rather than to a verdict — the same
 * infra-vs-oracle honesty rule the replay oracle follows.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import type * as vscode from 'vscode';
import { vinvHomeDir } from '../vinvHome';
import { hiddenBackgroundOptions, killProcessTree, resolveBash } from '../proc';
import { snapshotRef } from './workspaceSnapshot';
import { getHarness, runHarnessPrompt } from './harnessRunner';
import { runGoalAgent, asAuthoredTests, asJudgeReport, type AgentSpawn } from './binaryAgents';
import { counterexampleApproach } from './reconciliation';
import { mergeCandidates } from './testSwarm';
import {
	auditChangedFiles,
	buildTestGenPrompt,
	classifyFailureOutput,
	classifyRunFailure,
	classifyTestRun,
	combineTestRuns,
	describeRunFailure,
	extractCheckLines,
	extractAcceptanceTestFile,
	parseUnifiedDiff,
	type AuditFlag,
	type JudgeReport,
	type TestSignal,
} from './rewardSignals';

/** Bounded-run infrastructure limit (not a behavioral knob): one test run may
 * not exceed this wall clock. Env-tunable for pathological suites. */
function testTimeoutMs(): number {
	const raw = Number.parseFloat(process.env.VINV_ACCEPTANCE_TIMEOUT_S ?? '120');
	return (Number.isFinite(raw) && raw > 0 ? raw : 120) * 1000;
}

export interface AcceptanceState {
	status: 'ready' | 'not_discriminating' | 'unavailable' | 'disabled';
	/** Absolute path of the stored test file (outside the workspace). */
	path?: string;
	/** Pre-fix failure output — proof the tests reproduce the issue. */
	preRunOutput?: string;
	/** Why generation/validation did not produce a usable oracle. */
	detail?: string;
	/** Oracle-provenance grade of the set (A best; see testSwarm.OracleGrade).
	 * A human counterexample lifts the set to 'A'. */
	grade?: import('./testSwarm').OracleGrade;
}

interface BoundedRun {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
}

function runBounded(
	argv: string[],
	cwd: string,
	timeoutMs: number,
	extraEnv: NodeJS.ProcessEnv = {},
): Promise<BoundedRun> {
	return new Promise((resolve) => {
		if (argv.length === 0) {
			resolve({ exitCode: null, output: 'no command', timedOut: false });
			return;
		}
		const child = spawn(
			argv[0],
			argv.slice(1),
			hiddenBackgroundOptions({
				cwd,
				env: {
					...process.env,
					// Path isolation (PYTHONSAFEPATH, 3.11+): the script's directory
					// and cwd are NOT auto-prepended to sys.path, so nothing in the
					// run's cwd can shadow stdlib/site-packages. The interpreter is
					// launched from an isolated empty dir and the workspace is
					// APPENDED inside the runner (lowest priority) — a fix that
					// drops pytest.py / sitecustomize.py / conftest.py in the
					// workspace can no longer hijack the run.
					PYTHONSAFEPATH: '1',
					// A fresh bytecode-cache prefix per run: CPython's pyc header is
					// (mtime-seconds, size), so a fix that edits a file within the
					// same second without changing its size — exactly what a fast
					// fix loop does — would otherwise execute STALE pre-fix bytecode
					// from __pycache__ and grade the wrong code (found live).
					PYTHONPYCACHEPREFIX: fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-pyc-')),
					...extraEnv,
				},
			}),
		);
		let output = '';
		let timedOut = false;
		const absorb = (c: string) => {
			// Bounded ring — test output is evidence, not a transcript.
			output = (output + c).slice(-20_000);
		};
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', absorb);
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', absorb);
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(child, 'SIGKILL');
		}, timeoutMs);
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code, output, timedOut });
		});
		child.on('error', () => {
			clearTimeout(timer);
			resolve({ exitCode: null, output, timedOut });
		});
	});
}

/**
 * The unified test runner, injected into the interpreter as `-c`. It is the
 * SINGLE point that runs authored tests, for both pytest-present and
 * pytest-absent environments, and it is written for import-shadow safety:
 *
 *  - argv[1] = a `os.pathsep`-joined list of workspace import roots (root and
 *    root/src when a src-layout exists). They are APPENDED to sys.path AFTER
 *    real stdlib/site-packages and AFTER pytest is imported, so a workspace
 *    `pytest.py` / `os.py` can never shadow the real module, and (combined
 *    with PYTHONSAFEPATH + an isolated cwd) `sitecustomize.py` in the
 *    workspace never runs.
 *  - argv[2] = the test file (outside the workspace).
 *  - The model's own `__main__` runner (if any) is inert: pytest collects the
 *    functions, or the runpy path loads under a non-__main__ name.
 *  - Exit codes match classifyTestRun (0 pass, 1 failures, 5 nothing
 *    collected, other → unavailable).
 *
 * A function that REQUIRES arguments (e.g. an un-expanded parametrized test on
 * the pytest-absent path) is skipped as un-runnable, NOT counted as a failure
 * — a missing-argument TypeError is an infrastructure gap, not a fix defect.
 */
export const UNIFIED_RUNNER = [
	'import sys, os, runpy, traceback, inspect',
	'roots = [p for p in sys.argv[1].split(os.pathsep) if p]',
	'testfile = sys.argv[2]',
	'try:',
	'    import pytest',
	'    have_pytest = True',
	'except Exception:',
	'    have_pytest = False',
	'    import types, contextlib',
	"    shim = types.ModuleType('pytest')",
	'    @contextlib.contextmanager',
	'    def _raises(exc, *a, **k):',
	'        try:',
	'            yield types.SimpleNamespace(value=None)',
	'        except exc:',
	'            return',
	"        raise AssertionError(f'{exc!r} was not raised')",
	'    shim.raises = _raises',
	'    class _Approx:',
	'        def __init__(self, v, rel=None, abs=None):',
	'            self.v, self.rel, self.abs = v, (rel if rel is not None else 1e-6), abs',
	'        def __eq__(self, other):',
	'            try:',
	'                tol = self.abs if self.abs is not None else abs(self.v) * self.rel + 1e-12',
	'                return abs(other - self.v) <= tol',
	'            except Exception:',
	'                return NotImplemented',
	'    shim.approx = _Approx',
	'    class _Mark:',
	'        def __getattr__(self, _name):',
	// parametrize is EXPANDED, not inert: authors use it constantly (found
	// live), and an inert decorator strands an arg-requiring function.
	"            if _name == 'parametrize':",
	'                def parametrize(argnames, argvalues, **_k):',
	'                    def deco(fn):',
	"                        names = [a.strip() for a in argnames.split(',')] if isinstance(argnames, str) else list(argnames)",
	'                        cases = [tuple(v) if isinstance(v, (tuple, list)) else (v,) for v in argvalues]',
	"                        fn._vinv_params = getattr(fn, '_vinv_params', []) + [cases]",
	'                        return fn',
	'                    return deco',
	'                return parametrize',
	'            def deco(*a, **k):',
	'                return a[0] if a and callable(a[0]) else deco',
	'            return deco',
	'    shim.mark = _Mark()',
	'    def _skip(*a, **k):',
	"        raise AssertionError('pytest.skip is unavailable under the vinv runner')",
	'    shim.skip = _skip',
	"    sys.modules['pytest'] = shim",
	// Workspace roots appended only NOW — after the real pytest is bound.
	'for r in roots:',
	'    if r not in sys.path:',
	'        sys.path.append(r)',
	'if have_pytest:',
	// rootdir pinned to the test file's own dir so pytest never discovers a
	// workspace conftest.py (cwd is already isolated and off the workspace).
	"    sys.exit(pytest.main(['-x', '-q', '-p', 'no:cacheprovider', '--rootdir', os.path.dirname(testfile), testfile]))",
	"ns = runpy.run_path(testfile, run_name='vinv_acceptance')",
	// Two authored styles must both run (models emit either, regardless of
	// instruction — found live): top-level `def test_*` functions, AND
	// unittest.TestCase classes (whose `def test_*(self)` methods satisfy the
	// textual contract but need a class harness to execute).
	'import unittest',
	"fns = [v for k, v in sorted(ns.items()) if k.startswith('test_') and callable(v) and not isinstance(v, type)]",
	'cases = [v for k, v in sorted(ns.items()) if isinstance(v, type) and issubclass(v, unittest.TestCase) and v is not unittest.TestCase]',
	'failed = 0',
	'ran = 0',
	'import itertools',
	'for fn in fns:',
	"    param_sets = getattr(fn, '_vinv_params', None)",
	'    if param_sets:',
	// Shim-parametrized: run the cartesian product of attached case sets
	// (stacked decorators multiply, matching pytest semantics).
	'        for combo in itertools.product(*param_sets):',
	'            args = tuple(x for case in combo for x in case)',
	'            ran += 1',
	'            try:',
	'                fn(*args)',
	'            except Exception:',
	'                failed += 1',
	'                traceback.print_exc()',
	'        continue',
	'    try:',
	'        params = [p for p in inspect.signature(fn).parameters.values() if p.default is p.empty and p.kind in (p.POSITIONAL_OR_KEYWORD, p.POSITIONAL_ONLY)]',
	'    except (TypeError, ValueError):',
	'        params = []',
	'    if params:',
	// Un-runnable without pytest to supply fixtures: skip, do not fail.
	"        print(f'SKIP {fn.__name__}: requires arguments (no pytest to supply them)')",
	'        continue',
	'    ran += 1',
	'    try:',
	'        fn()',
	'    except Exception:',
	'        failed += 1',
	'        traceback.print_exc()',
	'if cases:',
	'    loader = unittest.TestLoader()',
	'    suite = unittest.TestSuite([loader.loadTestsFromTestCase(c) for c in cases])',
	'    result = unittest.TextTestRunner(verbosity=1).run(suite)',
	'    ran += result.testsRun',
	'    failed += len(result.failures) + len(result.errors)',
	'sys.exit(5 if ran == 0 else (1 if failed else 0))',
].join('\n');

/** A directory name that could be a virtualenv. The name is only a cheap
 * pre-filter — the real test is whether `<dir>/bin/python` exists — so this is
 * deliberately permissive: `.venv`, `venv`, `.venv-smol`, `venv311`,
 * `my-virtualenv`, `env` are all created by real tooling (uv, poetry --local,
 * pdm --in-project, virtualenv, hand-rolled) and all put the interpreter in
 * the same place. */
function looksLikeVenvDir(name: string): boolean {
	return /venv|virtualenv/i.test(name) || name === 'env' || name === '.env';
}

/**
 * Every python interpreter worth trying for a workspace, best first.
 *
 * The old resolver only knew `.venv` and `venv` and otherwise fell through to
 * a bare `python3`. Found live on a repo whose env is named `.venv-smol`: the
 * fall-through interpreter could not import the package under test, so the
 * acceptance oracle came back 'unavailable' and a CORRECT fix could not
 * self-certify. Discovery is therefore shape-based (any root-level directory
 * holding `bin/python`), not name-based, which also picks up uv / poetry
 * --local / pdm --in-project envs for free.
 *
 * Order is deterministic — never readdir order — so the same workspace always
 * resolves the same way: explicit override, the activated env, `.venv`, `venv`,
 * then any other venv-shaped directory alphabetically, then PATH.
 */
export function discoverPythonCandidates(workspaceRoot: string): string[] {
	const isWin = process.platform === 'win32';
	const venvPython = (dir: string): string =>
		isWin ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
	const candidates: string[] = [];
	const push = (p: string | undefined | null): void => {
		if (p && !candidates.includes(p)) {
			candidates.push(p);
		}
	};
	push(process.env.VINV_TEST_PYTHON);
	if (process.env.VIRTUAL_ENV) {
		push(venvPython(process.env.VIRTUAL_ENV));
	}
	for (const name of ['.venv', 'venv']) {
		push(venvPython(path.join(workspaceRoot, name)));
	}
	let entries: string[] = [];
	try {
		entries = fs
			.readdirSync(workspaceRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory() || d.isSymbolicLink())
			.map((d) => d.name)
			.filter(looksLikeVenvDir)
			.sort();
	} catch {
		// Unreadable workspace root: the fixed candidates still apply.
	}
	for (const name of entries) {
		const python = venvPython(path.join(workspaceRoot, name));
		if (fs.existsSync(python)) {
			push(python);
		}
	}
	// PATH lookups last (Windows commonly ships only `python`).
	push(isWin ? 'python' : 'python3');
	push(isWin ? 'python3' : 'python');
	return candidates;
}

/** Resolves the python interpreter for running tests, WITHOUT probing: the
 * first candidate that exists on disk, else the PATH name. Used by the static
 * pre-gate and the mutation smoke, which only need to run stdlib-only scripts
 * (`ast.parse`) and so do not care whether the workspace's deps are importable.
 * Test execution uses resolveTestInterpreter, which probes. */
export function resolveTestPython(workspaceRoot: string): string | null {
	for (const c of discoverPythonCandidates(workspaceRoot)) {
		// An absolute path must exist; a bare name is left for PATH resolution
		// (unchanged from the original contract: python3 first on posix).
		if (!path.isAbsolute(c) || fs.existsSync(c)) {
			return c;
		}
	}
	return process.platform === 'win32' ? 'python' : 'python3';
}

/** Directory names that are never the package under test. */
const NON_PACKAGE_DIRS = new Set([
	'test',
	'tests',
	'testing',
	'docs',
	'doc',
	'examples',
	'example',
	'benchmarks',
	'scripts',
	'build',
	'dist',
	'node_modules',
	'site-packages',
]);

/**
 * The importable top-level PACKAGES a workspace ships (directories holding an
 * `__init__.py`, under the root and under `src/`). These are the probe targets
 * — "can this interpreter import the code under test?" is the question that
 * actually decides whether an acceptance run will produce a verdict.
 *
 * Packages only, never loose top-level modules: importing a package's
 * `__init__` is what the authored tests do anyway, whereas importing a stray
 * root-level script would execute code the test run never would.
 */
export function workspacePackageNames(workspaceRoot: string): string[] {
	const names: string[] = [];
	for (const base of [path.join(workspaceRoot, 'src'), workspaceRoot]) {
		let entries: string[];
		try {
			entries = fs
				.readdirSync(base, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name)
				.sort();
		} catch {
			continue;
		}
		for (const name of entries) {
			if (name.startsWith('.') || NON_PACKAGE_DIRS.has(name.toLowerCase()) || looksLikeVenvDir(name)) {
				continue;
			}
			if (fs.existsSync(path.join(base, name, '__init__.py')) && !names.includes(name)) {
				names.push(name);
			}
		}
		if (names.length) {
			// A src-layout repo's packages live in src/ — do not also treat
			// root-level package dirs (tooling, plugins) as probe targets.
			break;
		}
	}
	return names.slice(0, 3);
}

/** Probe script: append the workspace import roots, import each named package,
 * report pytest availability. Exits 0 when everything imported, 3 otherwise. */
const IMPORT_PROBE = [
	'import sys, os, importlib',
	'for r in [p for p in sys.argv[1].split(os.pathsep) if p]:',
	'    if r not in sys.path:',
	'        sys.path.append(r)',
	'missing = []',
	"for name in [n for n in sys.argv[2].split(',') if n]:",
	'    try:',
	'        importlib.import_module(name)',
	'    except BaseException as e:',
	"        missing.append(f'{name}: {type(e).__name__}: {e}')",
	'try:',
	'    import pytest',
	'    has_pytest = 1',
	'except Exception:',
	'    has_pytest = 0',
	"print(f'VINV_PROBE pytest={has_pytest}')",
	'for m in missing:',
	"    print(f'VINV_MISSING {m}')",
	'sys.exit(3 if missing else 0)',
].join('\n');

export interface ResolvedInterpreter {
	/** The interpreter test runs should use. */
	python: string;
	/** Whether it can import the workspace's own packages ('unprobed' when the
	 * workspace ships no importable package, so there was nothing to check). */
	imports: 'ok' | 'failed' | 'unprobed';
	/** Whether pytest is importable under the chosen interpreter. */
	hasPytest: boolean;
	/** Per-candidate probe failures — the evidence behind an 'unavailable'. */
	tried: Array<{ python: string; error: string }>;
}

/** Probes are cached per workspace: an episode runs the acceptance file many
 * times (double-run flake guard × attempts × mutation smoke) and the answer
 * cannot change mid-episode. */
const interpreterCache = new Map<string, ResolvedInterpreter>();

/** Test seam — drops the memoized probe results. */
export function resetInterpreterCache(): void {
	interpreterCache.clear();
}

/** A single-line diagnostic for one failed probe (bounded). */
function probeError(run: BoundedRun): string {
	if (run.timedOut) {
		return 'probe timed out';
	}
	const missing = run.output
		.split('\n')
		.filter((l) => l.startsWith('VINV_MISSING '))
		.map((l) => l.slice('VINV_MISSING '.length).trim());
	if (missing.length) {
		return missing.join('; ').slice(0, 300);
	}
	if (run.exitCode === null) {
		return 'interpreter could not be launched';
	}
	return (run.output.trim().split('\n').slice(-2).join(' ') || `exit ${run.exitCode}`).slice(0, 300);
}

/**
 * Chooses the interpreter for TEST EXECUTION by asking each candidate whether
 * it can actually import the code under test, preferring one that also has
 * pytest. No amount of name ordering can answer that question — a repo may
 * have a stale `.venv` next to the real env, or none at all — so the choice is
 * made by evidence, exactly like every other gate in this engine.
 *
 * When nothing imports the workspace, this does NOT fabricate a working setup:
 * it returns the best-effort interpreter with imports:'failed' and the per
 * candidate errors, so the caller can report WHY the oracle was unavailable
 * instead of shrugging.
 */
export async function resolveTestInterpreter(workspaceRoot: string): Promise<ResolvedInterpreter> {
	const cached = interpreterCache.get(workspaceRoot);
	if (cached) {
		return cached;
	}
	const candidates = discoverPythonCandidates(workspaceRoot);
	const packages = workspacePackageNames(workspaceRoot);
	const fallback: ResolvedInterpreter = {
		python: resolveTestPython(workspaceRoot) ?? candidates[0] ?? 'python3',
		imports: packages.length ? 'failed' : 'unprobed',
		hasPytest: false,
		tried: [],
	};
	if (packages.length === 0) {
		// Nothing importable to probe (flat script layout): keep the historical
		// existence-ordered choice rather than spend processes proving nothing.
		interpreterCache.set(workspaceRoot, fallback);
		return fallback;
	}
	const roots = workspaceImportRoots(workspaceRoot);
	const tried: Array<{ python: string; error: string }> = [];
	let firstImporting: ResolvedInterpreter | null = null;
	const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-probe-'));
	try {
		for (const python of candidates) {
			if (path.isAbsolute(python) && !fs.existsSync(python)) {
				continue;
			}
			const run = await runBounded([python, '-c', IMPORT_PROBE, roots, packages.join(',')], isolated, 60_000);
			if (run.exitCode !== 0) {
				tried.push({ python, error: probeError(run) });
				continue;
			}
			const hasPytest = /VINV_PROBE pytest=1/.test(run.output);
			const resolved: ResolvedInterpreter = { python, imports: 'ok', hasPytest, tried };
			if (hasPytest) {
				interpreterCache.set(workspaceRoot, resolved);
				return resolved;
			}
			firstImporting ??= resolved;
		}
	} finally {
		try {
			fs.rmSync(isolated, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best-effort.
		}
	}
	const chosen = firstImporting ?? { ...fallback, tried };
	interpreterCache.set(workspaceRoot, chosen);
	return chosen;
}

/** The import roots for a workspace: the root, plus root/src for src-layout. */
function workspaceImportRoots(workspaceRoot: string): string {
	const roots = [workspaceRoot];
	const src = path.join(workspaceRoot, 'src');
	if (fs.existsSync(src)) {
		roots.push(src);
	}
	return roots.join(path.delimiter);
}

/** One classified test run in an ISOLATED cwd (never the workspace), so a
 * workspace-dropped pytest.py / conftest.py / sitecustomize.py cannot hijack
 * it (see UNIFIED_RUNNER). */
async function runTestFileOnce(
	workspaceRoot: string,
	testFile: string,
): Promise<{ signal: 'pass' | 'fail' | 'unavailable'; output: string; detail?: string }> {
	const interpreter = await resolveTestInterpreter(workspaceRoot);
	const python = interpreter.python;
	if (!python) {
		return { signal: 'unavailable', output: '', detail: 'no python interpreter found' };
	}
	const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-run-'));
	try {
		const run = await runBounded(
			[python, '-c', UNIFIED_RUNNER, workspaceImportRoots(workspaceRoot), testFile],
			isolatedCwd,
			testTimeoutMs(),
		);
		const signal = classifyTestRun(run.exitCode, run.output, run.timedOut);
		if (signal !== 'unavailable') {
			return { signal, output: run.output };
		}
		return {
			signal,
			output: run.output,
			detail: explainUnavailable(run, interpreter),
		};
	} finally {
		try {
			fs.rmSync(isolatedCwd, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best-effort.
		}
	}
}

/**
 * The operator-facing WHY behind an 'unavailable' run: the diagnosis, the
 * interpreter that produced it, what the interpreter probe found, and the
 * output tail. 'unavailable' with no explanation is what let a correct fix go
 * uncertified — the message has to be actionable, not merely honest.
 */
function explainUnavailable(run: BoundedRun, interpreter: ResolvedInterpreter): string {
	const kind = classifyRunFailure(run.exitCode, run.output, run.timedOut) ?? 'crash';
	const parts = [`${describeRunFailure(kind)} [${kind}]`, `interpreter: ${interpreter.python}`];
	if (interpreter.imports === 'failed') {
		const probes = interpreter.tried
			.map((t) => `${t.python} → ${t.error}`)
			.slice(0, 3)
			.join(' | ');
		parts.push(
			`no discovered interpreter could import the workspace package${probes ? ` (tried: ${probes})` : ''}`,
		);
	} else if (!interpreter.hasPytest) {
		parts.push('pytest not importable — ran under the built-in fallback runner');
	}
	const tail = run.output.trim().split('\n').slice(-4).join(' / ').slice(-400);
	if (tail) {
		parts.push(`output tail: ${tail}`);
	}
	return parts.join('; ');
}

/** Two runs, must agree (flake guard). Returns the last run's output, and the
 * diagnostic of whichever run could not produce a verdict. */
export async function runAcceptanceTests(
	workspaceRoot: string,
	testFile: string,
): Promise<{ signal: TestSignal; output: string; detail?: string }> {
	const first = await runTestFileOnce(workspaceRoot, testFile);
	const second = await runTestFileOnce(workspaceRoot, testFile);
	return {
		signal: combineTestRuns(first.signal, second.signal),
		output: second.output,
		detail: second.detail ?? first.detail,
	};
}

/**
 * The storage directory for one episode's acceptance tests — under the user's
 * home, not the workspace, keyed by an OPAQUE random token (not the episode
 * id, which is discoverable from the pre-episode git ref). This keeps the
 * tests off the workspace AND uncorrelated with any agent-visible identifier.
 *
 * Honest scope: Vinv does not sandbox the coding harness, so a same-uid agent
 * that enumerates ~/.vinv/acceptance can still read tests it has no legitimate
 * reason to. This is defense-in-depth (raising the bar, per ImpossibleBench's
 * finding that even workspace-hiding collapses cheat rates), not an access
 * boundary — the execution-gated fail-to-pass validation and the anti-cheat
 * audit are the real guarantees, not test secrecy.
 */
export function acceptanceDir(storageToken: string): string {
	return path.join(vinvHomeDir(), 'acceptance', storageToken);
}

/** A fresh opaque token for one episode's acceptance store. */
export function newAcceptanceToken(): string {
	return crypto.randomBytes(9).toString('hex');
}

/**
 * Generates and validates the acceptance oracle for an episode. CLI harnesses
 * only (an IDE chat panel cannot return the file); any failure is
 * 'unavailable', never a fabricated verdict.
 */
export async function generateAcceptanceTests(
	harnessId: string,
	workspaceRoot: string,
	title: string,
	issue: string,
	goal: string | undefined,
	symbolContext: string,
	episodeId: string,
	token?: vscode.CancellationToken,
): Promise<AcceptanceState> {
	const harness = getHarness(harnessId);
	if (harness.kind !== 'cli') {
		return {
			status: 'unavailable',
			detail: `${harness.label} is an IDE chat panel — test generation needs a CLI harness`,
		};
	}
	const prompt = buildTestGenPrompt(title, issue, goal, symbolContext);
	const run = await runHarnessPrompt(harnessId, workspaceRoot, 'acceptance-tests', prompt, {
		token,
	});
	if (!run.ok) {
		return { status: 'unavailable', detail: `test generation run failed: ${run.detail ?? 'unknown'}` };
	}
	const body = extractAcceptanceTestFile(run.stdout);
	if (!body) {
		return {
			status: 'unavailable',
			detail: 'the generator returned no usable python-acceptance block',
		};
	}
	const dir = acceptanceDir(episodeId);
	fs.mkdirSync(dir, { recursive: true });
	const testFile = path.join(dir, 'test_acceptance.py');
	fs.writeFileSync(testFile, body, { mode: 0o600 });

	// Fail-to-pass gate, pre side: the tests must FAIL on the current (broken)
	// code, deterministically. Passing here means they cannot discriminate the
	// fix and are discarded — this is also the tautology screen (a tautology
	// cannot fail), which is why no SMT machinery is needed for it.
	const pre = await runAcceptanceTests(workspaceRoot, testFile);
	if (pre.signal === 'fail') {
		return { status: 'ready', path: testFile, preRunOutput: pre.output.slice(-4000) };
	}
	if (pre.signal === 'pass') {
		return {
			status: 'not_discriminating',
			path: testFile,
			detail: 'generated tests pass on the pre-fix code — they cannot discriminate a fix',
		};
	}
	return {
		status: 'unavailable',
		path: testFile,
		detail: `pre-fix validation was ${pre.signal}: ${pre.detail ?? pre.output.slice(-400)}`,
	};
}

/**
 * Reconciliation: turn a human's "it's still wrong" note into a counterexample
 * acceptance test. With deferMerge unset (episode retry paths — the operator
 * is mid-loop and the next attempt is simply verified against their case), a
 * reproducing counterexample is merged into the acceptance oracle immediately,
 * as before. With deferMerge set (the post-completion DISPUTE path), a
 * reproducing counterexample is STAGED only: the caller must obtain the
 * human's confirmation and then call mergeCounterexampleIntoOracle — merging
 * before confirmation would pollute the permanent oracle with a test the
 * human never endorsed (ateam: the merge-deferral is the load-bearing part
 * of the confirm gate, not the click). Any failure (no agent, contract miss,
 * unrunnable) returns 'unavailable' — never a fabricated retract.
 */
export interface CounterexampleResult {
	signal: 'reproduces' | 'does_not_reproduce' | 'unavailable';
	mergedPath?: string;
	/** The counterexample's failing output on current code (evidence seed). */
	failingOutput?: string;
	/** The staged (possibly unmerged) counterexample file, when authored. */
	stagedPath?: string;
	/** On a reproducing run: whether the failure is the test's own check
	 * ('assertion') or a crash before the check ('exception'). Retraction
	 * requires 'assertion'. */
	failureClass?: 'assertion' | 'exception';
	/** The authored test's check lines — the confirm card's evidence echo. */
	checkLines?: string[];
}

export async function strengthenAcceptanceFromNote(
	spawnInfo: AgentSpawn | null,
	workspaceRoot: string,
	issue: string,
	humanNote: string,
	acceptancePath: string | undefined,
	storageDir: string,
	options?: { deferMerge?: boolean },
): Promise<CounterexampleResult> {
	if (!spawnInfo || !humanNote.trim()) {
		return { signal: 'unavailable' };
	}
	const authored = asAuthoredTests(
		await runGoalAgent(spawnInfo, 'author-tests', {
			approach: counterexampleApproach(humanNote),
			issue,
			symbols: '',
			runtime_evidence: '',
		}),
	);
	if (!authored) {
		return { signal: 'unavailable' };
	}
	// Contract parity with the generator path (extractAcceptanceTestFile): a
	// test with no assert/raise can never discriminate — and it makes the
	// confirm card's "no check lines" case unrepresentable.
	if (!/\bassert\b|\braise\b/.test(authored.test_code)) {
		return { signal: 'unavailable' };
	}
	try {
		fs.mkdirSync(storageDir, { recursive: true });
		const cxFile = path.join(storageDir, 'test_counterexample.py');
		fs.writeFileSync(cxFile, authored.test_code, { mode: 0o600 });
		const checkLines = extractCheckLines(authored.test_code);
		const pre = await runAcceptanceTests(workspaceRoot, cxFile);
		if (pre.signal !== 'fail') {
			// Does not reproduce (passes) or could not run — do not retract.
			return {
				signal: pre.signal === 'pass' ? 'does_not_reproduce' : 'unavailable',
				stagedPath: cxFile,
				checkLines,
			};
		}
		const failureClass = classifyFailureOutput(pre.output);
		if (options?.deferMerge) {
			return {
				signal: 'reproduces',
				stagedPath: cxFile,
				failingOutput: pre.output.slice(-4000),
				failureClass,
				checkLines,
			};
		}
		const mergedPath = mergeCounterexampleIntoOracle(cxFile, acceptancePath, storageDir);
		return {
			signal: 'reproduces',
			mergedPath,
			stagedPath: cxFile,
			failingOutput: pre.output.slice(-4000),
			failureClass,
			checkLines,
		};
	} catch {
		// A write/run failure must never overstate the oracle's state.
		return { signal: 'unavailable' };
	}
}

/**
 * Merges a staged counterexample into the acceptance oracle and lifts the
 * set's manifest to Grade A (a human-endorsed counterexample is a
 * stated-requirement oracle). mergeCandidates dedups by (test name,
 * normalized asserts), so a repeated note cannot grow the file unboundedly; a
 * MISSING acceptance file is created — the human's case IS the oracle then.
 * On the dispute path this runs ONLY after the human confirmed the test
 * captures their report.
 */
export function mergeCounterexampleIntoOracle(
	stagedPath: string,
	acceptancePath: string | undefined,
	storageDir: string,
): string {
	const target =
		acceptancePath && fs.existsSync(acceptancePath)
			? acceptancePath
			: path.join(storageDir, 'test_acceptance.py');
	const staged = fs.readFileSync(stagedPath, 'utf8');
	const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
	const merged = mergeCandidates(existing ? [existing, staged] : [staged]);
	fs.writeFileSync(target, merged, { mode: 0o600 });
	try {
		const manifestPath = path.join(path.dirname(target), 'manifest.json');
		if (fs.existsSync(manifestPath)) {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
			manifest.acceptance = target;
			manifest.acceptance_grade = 'A';
			fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`, { mode: 0o600 });
		}
	} catch {
		// Grade lifting is metadata; its failure never blocks the merge.
	}
	return target;
}

function git(root: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{ cwd: root, maxBuffer: 64 * 1024 * 1024 },
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
	});
}

/**
 * The deterministic anti-cheat audit for an episode: parses `git diff
 * <snapshot-ref>` (what the agent changed) plus the untracked file list, and
 * runs the pure pattern audit. No git repo / no snapshot → empty (the audit
 * is an extra guard, not a gate on using Vinv outside git).
 */
export async function auditWorkspaceDiff(
	workspaceRoot: string,
	episodeId: string,
): Promise<AuditFlag[]> {
	try {
		const ref = snapshotRef(episodeId);
		const [diffText, untrackedRaw] = await Promise.all([
			git(workspaceRoot, ['diff', ref, '--']),
			git(workspaceRoot, ['ls-files', '--others', '--exclude-standard']),
		]);
		const untracked = untrackedRaw.split('\n').filter(Boolean);
		return auditChangedFiles(parseUnifiedDiff(diffText), untracked);
	} catch {
		return [];
	}
}

/**
 * The bounded LLM judge over the episode diff — an ENGINE-rendered agent
 * (goal engine `judge-diff` renders the prompt; the coding harness answers
 * it), never a free-form chat completion composed in the extension. Render
 * failure, dispatch failure, or a contract miss all return null — the judge
 * silently missing can never decide anything, and composeRewardBreakdown
 * treats null as "soft flags ride to the human".
 */
export async function judgeEpisodeDiff(
	workspaceRoot: string,
	episodeId: string,
	_title: string,
	issue: string,
	flags: AuditFlag[],
	spawnInfo: AgentSpawn | null,
	goal?: string,
	successCriteria?: string[],
): Promise<JudgeReport | null> {
	if (!spawnInfo) {
		return null;
	}
	let diffText = '';
	try {
		diffText = await git(workspaceRoot, ['diff', snapshotRef(episodeId), '--']);
	} catch {
		return null;
	}
	const raw = await runGoalAgent(spawnInfo, 'judge-diff', {
		issue: issue.slice(0, 8000),
		diff: diffText.slice(0, 24_000),
		flags: flags.map((f) => `[${f.severity}] ${f.kind}: ${f.detail} (${f.file})`),
		goal: goal ?? '',
		success_criteria: successCriteria ?? [],
	});
	const report = asJudgeReport(raw);
	// Defensive guard (ateam finding): when NO criteria were sent, any
	// criteria_verdicts the model fabricated must be dropped — the "no criteria
	// ⇒ behaves exactly as before" guarantee cannot rest on model obedience.
	if (report && (successCriteria ?? []).length === 0) {
		report.criteria_verdicts = [];
	}
	return report;
}

/** Result of the static pre-gate over the episode's changed python files. */
export interface PreGateResult {
	ok: boolean;
	/** Per-file parse failures (empty when ok or when nothing checkable). */
	failures: Array<{ file: string; error: string }>;
	checkedFiles: number;
}

/** Bounded batch: at most this many changed files are parse-checked. */
const PRE_GATE_MAX_FILES = 50;

/**
 * The static pre-gate (taxonomy §4/§41/§70): every changed/added python file
 * must PARSE before any replay or test budget is spent on the attempt. Pure
 * `ast.parse` in one bounded python invocation — no imports are executed
 * (importing arbitrary user modules runs their side effects; parsing does
 * not), no bytecode cache is touched, no configuration is read, so the gate
 * is safe and identical on every codebase. Absence of python3 or of a git
 * snapshot degrades to ok (gate unavailable, never a fabricated verdict).
 */
export async function staticPreGate(
	workspaceRoot: string,
	episodeId: string,
): Promise<PreGateResult> {
	let changed: string[] = [];
	try {
		const [diffNames, untracked] = await Promise.all([
			git(workspaceRoot, ['diff', '--name-only', snapshotRef(episodeId), '--']),
			git(workspaceRoot, ['ls-files', '--others', '--exclude-standard']),
		]);
		changed = [...diffNames.split('\n'), ...untracked.split('\n')]
			.map((l) => l.trim())
			.filter((l) => l.endsWith('.py'))
			.filter((l, i, all) => all.indexOf(l) === i)
			.slice(0, PRE_GATE_MAX_FILES);
	} catch {
		return { ok: true, failures: [], checkedFiles: 0 };
	}
	const existing = changed.filter((f) => fs.existsSync(path.join(workspaceRoot, f)));
	if (existing.length === 0) {
		return { ok: true, failures: [], checkedFiles: 0 };
	}
	const checker = [
		'import ast, json, sys',
		'failures = []',
		'for name in sys.argv[1:]:',
		'    try:',
		"        ast.parse(open(name, encoding='utf-8', errors='replace').read(), filename=name)",
		'    except SyntaxError as e:',
		"        failures.append({'file': name, 'error': f'{e.msg} (line {e.lineno})'})",
		'    except OSError as e:',
		"        failures.append({'file': name, 'error': str(e)})",
		'print(json.dumps(failures))',
	].join('\n');
	const python = resolveTestPython(workspaceRoot);
	if (!python) {
		return { ok: true, failures: [], checkedFiles: 0 };
	}
	// Parse only — the files are passed as argv, the interpreter runs from an
	// isolated cwd (PYTHONSAFEPATH set by runBounded), and ast.parse imports
	// nothing, so a hostile workspace cannot influence the gate.
	const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-gate-'));
	let run: BoundedRun;
	try {
		run = await runBounded(
			[python, '-c', checker, ...existing.map((f) => path.join(workspaceRoot, f))],
			isolatedCwd,
			30_000,
		);
	} finally {
		try {
			fs.rmSync(isolatedCwd, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
	if (run.exitCode !== 0 || run.timedOut) {
		return { ok: true, failures: [], checkedFiles: 0 };
	}
	try {
		const failures = JSON.parse(run.output.trim().split('\n').pop() ?? '[]') as Array<{
			file: string;
			error: string;
		}>;
		return { ok: failures.length === 0, failures, checkedFiles: existing.length };
	} catch {
		return { ok: true, failures: [], checkedFiles: 0 };
	}
}

// ---- diff-scoped mutation smoke (advisory oracle-strength signal) ----------

/**
 * Stdlib-only mutation script: given [{file, ranges:[[start,count],…]}] and a
 * seed, finds functions overlapping the changed ranges, enumerates small
 * semantic mutations (comparison flips, +/-, and/or, int ±1, bool flip), and
 * emits ≤ max_mutants of them (seeded, deterministic) as JSON with the FULL
 * mutated source per mutant. Requires ast.unparse (3.9+) — exit 7 maps to
 * 'unavailable', never a fabricated score.
 */
export const MUTATION_SMOKE_SCRIPT = [
	'import ast, json, random, sys',
	"spec = json.loads(sys.argv[1]); max_mutants = int(sys.argv[2]); seed = int(sys.argv[3])",
	"hasattr(ast, 'unparse') or sys.exit(7)",
	'FLIP_CMP = {ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Lt: ast.LtE, ast.LtE: ast.Lt, ast.Gt: ast.GtE, ast.GtE: ast.Gt}',
	'FLIP_BIN = {ast.Add: ast.Sub, ast.Sub: ast.Add}',
	'mutants = []',
	'for entry in spec:',
	'    try:',
	"        src = open(entry['file'], encoding='utf-8', errors='replace').read()",
	"        tree = ast.parse(src, filename=entry['file'])",
	'    except (SyntaxError, OSError):',
	'        continue',
	"    ranges = [(r[0], r[0] + max(1, r[1]) - 1) for r in entry['ranges']]",
	'    for node in ast.walk(tree):',
	'        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):',
	'            continue',
	"        end = getattr(node, 'end_lineno', node.lineno)",
	'        if not any(a <= end and node.lineno <= b for a, b in ranges):',
	'            continue',
	'        for sub in ast.walk(node):',
	'            sites = []',
	'            if isinstance(sub, ast.Compare) and len(sub.ops) == 1 and type(sub.ops[0]) in FLIP_CMP:',
	"                sites.append(('cmp', sub))",
	'            elif isinstance(sub, ast.BinOp) and type(sub.op) in FLIP_BIN:',
	"                sites.append(('bin', sub))",
	'            elif isinstance(sub, ast.BoolOp):',
	"                sites.append(('bool', sub))",
	'            elif isinstance(sub, ast.Constant) and type(sub.value) is int:',
	"                sites.append(('int', sub))",
	'            elif isinstance(sub, ast.Constant) and type(sub.value) is bool:',
	"                sites.append(('boolc', sub))",
	'            for kind, site in sites:',
	"                mutants.append({'file': entry['file'], 'line': site.lineno, 'kind': kind, 'node': site, 'tree': tree, 'src': src})",
	'random.Random(seed).shuffle(mutants)',
	'out = []',
	'for m in mutants:',
	'    if len(out) >= max_mutants:',
	'        break',
	"    node = m['node']; kind = m['kind']",
	'    original = ast.unparse(node)',
	"    if kind == 'cmp':",
	'        node.ops = [FLIP_CMP[type(node.ops[0])]()]',
	"    elif kind == 'bin':",
	'        node.op = FLIP_BIN[type(node.op)]()',
	"    elif kind == 'bool':",
	'        node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()',
	"    elif kind == 'int':",
	'        node.value = node.value + 1',
	'    else:',
	'        node.value = not node.value',
	'    try:',
	"        mutated_source = ast.unparse(ast.fix_missing_locations(m['tree']))",
	'    except Exception:',
	'        continue',
	"    out.append({'file': m['file'], 'line': m['line'], 'original': original, 'mutated': ast.unparse(node), 'full_mutated_source': mutated_source})",
	'    # Restore by re-parsing pristine source for the next mutant.',
	"    m['tree'] = ast.parse(m['src'])",
	'print(json.dumps(out))',
].join('\n');

export interface MutationSmokeResult {
	status: 'ok' | 'unavailable';
	mutants: number;
	killed: number;
	survivors: Array<{ file: string; line: number; original: string; mutated: string }>;
}

/** Max mutants per attempt — a smoke signal, not a mutation campaign. */
const MUTATION_MAX = 8;

/**
 * Advisory mutation smoke: perturb the CHANGED functions and check the
 * acceptance set notices. Surviving mutants = the fix's neighborhood is
 * unpoliced (weak assertions). ADVISORY ONLY: logged + judged context, never
 * a gate, and — Goodhart guard — never revealed to the fixing agent's pack.
 * Each mutant is written, tested once (single run — smoke, the flake guard
 * does not apply to an advisory), and the original file restored with a
 * byte-identity check; any restore anomaly aborts to 'unavailable'.
 */
export async function runMutationSmoke(
	workspaceRoot: string,
	changed: Array<{ path: string; hunks?: Array<{ start: number; count: number }> }>,
	acceptancePath: string,
	seed = 7,
): Promise<MutationSmokeResult> {
	const python = resolveTestPython(workspaceRoot);
	const spec = changed
		.filter((c) => c.path.endsWith('.py') && c.hunks?.length)
		.map((c) => ({
			file: path.join(workspaceRoot, c.path),
			ranges: (c.hunks ?? []).map((h) => [h.start, h.count]),
		}))
		.filter((c) => fs.existsSync(c.file));
	if (!python || spec.length === 0) {
		return { status: 'unavailable', mutants: 0, killed: 0, survivors: [] };
	}
	const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-mut-'));
	try {
		const gen = await runBounded(
			[python, '-c', MUTATION_SMOKE_SCRIPT, JSON.stringify(spec), String(MUTATION_MAX), String(seed)],
			isolated,
			30_000,
		);
		if (gen.exitCode !== 0 || gen.timedOut) {
			return { status: 'unavailable', mutants: 0, killed: 0, survivors: [] };
		}
		let mutants: Array<{ file: string; line: number; original: string; mutated: string; full_mutated_source: string }>;
		try {
			mutants = JSON.parse(gen.output.trim().split('\n').pop() ?? '[]');
		} catch {
			return { status: 'unavailable', mutants: 0, killed: 0, survivors: [] };
		}
		let killed = 0;
		const survivors: MutationSmokeResult['survivors'] = [];
		for (const m of mutants) {
			const originalBytes = fs.readFileSync(m.file);
			try {
				fs.writeFileSync(m.file, m.full_mutated_source);
				const run = await runTestFileOnce(workspaceRoot, acceptancePath);
				if (run.signal === 'fail') {
					killed += 1;
				} else {
					survivors.push({ file: m.file, line: m.line, original: m.original, mutated: m.mutated });
				}
			} finally {
				fs.writeFileSync(m.file, originalBytes);
				// Byte-identity restore check — a mutation smoke must NEVER leave
				// the workspace altered; any anomaly voids the whole signal.
				if (!fs.readFileSync(m.file).equals(originalBytes)) {
					return { status: 'unavailable', mutants: 0, killed: 0, survivors: [] };
				}
			}
		}
		return { status: 'ok', mutants: mutants.length, killed, survivors };
	} finally {
		try {
			fs.rmSync(isolated, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

// ---- per-test pool-events stats plane (data for future pool management) ----

/**
 * Appends one per-test-run event to the pool ledger. Raw events, not baked
 * weights (OPE doctrine: log everything, choose the estimator later) — this
 * is the data plane the ateam-approved (LATER) bandit pool manager needs;
 * recording nothing today is training data lost forever. Only DETERMINISTIC
 * signals are logged as evidence; 'unavailable' runs are logged with
 * signal null so denominator accounting stays honest.
 */
export function appendPoolEvent(event: {
	episode_id: string;
	attempt: number;
	epoch: number;
	role: 'acceptance' | 'regression' | 'counterexample';
	file: string;
	signal: 'pass' | 'fail' | null;
	grade?: string;
	/** Wall-clock of the (double) test run — the cost half of any future
	 * value/cost selection posterior; without it that bandit is untrainable. */
	duration_ms?: number;
}): void {
	try {
		const target = path.join(vinvHomeDir(), 'acceptance', 'pool-events.jsonl');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		let testKeys: string[] = [];
		let fileSig = '';
		try {
			const body = fs.readFileSync(event.file, 'utf8');
			fileSig = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
			testKeys = require('./testSwarm').testDedupKeys(body) as string[];
		} catch {
			// Missing file: log the event without content identity.
		}
		const descriptor = fs.openSync(target, 'a', 0o600);
		try {
			fs.writeSync(
				descriptor,
				`${JSON.stringify({ v: 1, ts: new Date().toISOString(), ...event, file_sig: fileSig, test_keys: testKeys })}\n`,
			);
		} finally {
			fs.closeSync(descriptor);
		}
	} catch {
		// Telemetry must never affect the loop.
	}
}
