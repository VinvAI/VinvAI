/**
 * Which Python package must be instrumented for a service's own code to appear
 * in its trace.
 *
 * Discovery records `modules` per service — the packages tracelens rewrites via
 * `--target-package`. On a repo whose services live outside its distribution
 * package that list can be right about the repo and wrong about the service:
 * smolagents recorded `modules: ["smolagents"]` for four services whose
 * entrypoints are `examples.server.main`, `examples.async_agent.main`, and so
 * on. tracelens then instrumented the library and not one handler, so every
 * inbound span had zero application frames under it — endpoint coverage 0%,
 * no per-endpoint latency, and an empty call-tree overlay, with nothing
 * anywhere reporting a problem. Bring-up still passed: spans existed, they were
 * simply all somebody else's.
 *
 * Pure string work over the recorded command, so it runs before anything starts
 * and is unit-testable without a repo.
 */

/** Server runners whose app lives in a positional `module:attr` spec. */
const APP_SPEC_RUNNERS = new Set([
	'uvicorn',
	'gunicorn',
	'hypercorn',
	'daphne',
	'granian',
]);

/** Splits a command into tokens, honouring simple quoting. */
function tokenize(command: string): string[] {
	return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, '')) ?? [];
}

/** True for a dotted Python module path (no slashes, no colons, no dashes). */
function looksLikeModule(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(token);
}

/**
 * The module a `.py` path resolves to, or null for a top-level script.
 *
 * A script with no directory part runs as `__main__` and belongs to no package,
 * so there is nothing to name in `--target-package` — reporting its stem would
 * produce a target that matches no span.
 */
function moduleFromScript(token: string): string | null {
	const norm = token.replace(/\\/g, '/');
	if (!norm.endsWith('.py')) {
		return null;
	}
	const parts = norm.slice(0, -3).split('/').filter((p) => p && p !== '.');
	if (parts.length < 2 || parts.some((p) => !looksLikeModule(p))) {
		return null;
	}
	return parts.join('.');
}

/**
 * The dotted module a start command actually runs, or null when it cannot be
 * determined confidently.
 *
 * Null is the honest answer for anything ambiguous (a console script, a bare
 * top-level file, a `flask run`): callers treat it as "no opinion" rather than
 * guessing a package that would silence a real mismatch or invent a false one.
 */
export function entrypointModule(command: string): string | null {
	const tokens = tokenize(command);
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		// `-m <target>`: either the app module itself, or a runner whose app is
		// named in the following positional (`-m uvicorn pkg.api:app`).
		if (t === '-m') {
			const target = tokens[i + 1];
			if (!target) {
				return null;
			}
			if (APP_SPEC_RUNNERS.has(target)) {
				return appSpecModule(tokens.slice(i + 2));
			}
			return looksLikeModule(target) ? target : null;
		}
		// The same runners invoked as console scripts rather than via `-m`.
		const base = t.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/, '') ?? '';
		if (APP_SPEC_RUNNERS.has(base)) {
			return appSpecModule(tokens.slice(i + 1));
		}
		if (t.endsWith('.py')) {
			return moduleFromScript(t);
		}
	}
	return null;
}

/** First non-flag positional read as `module:attr` — uvicorn's app spec. */
function appSpecModule(rest: string[]): string | null {
	for (let i = 0; i < rest.length; i++) {
		const t = rest[i];
		if (t.startsWith('-')) {
			// Skip a flag's value too, unless it was written `--flag=value`.
			if (!t.includes('=') && rest[i + 1] && !rest[i + 1].startsWith('-')) {
				i++;
			}
			continue;
		}
		const mod = t.split(':')[0];
		return looksLikeModule(mod) ? mod : moduleFromScript(t);
	}
	return null;
}

/** The top-level import package of a dotted module. */
export function rootPackage(module: string): string {
	return module.split('.')[0];
}

/**
 * The `--target-package` list to actually instrument this service with.
 *
 * The recorded `modules` are kept verbatim and in order — they are the repo's
 * own answer and may legitimately name libraries worth tracing — with the
 * entrypoint's root package appended when it is missing. Appending rather than
 * replacing matters: a service can genuinely need both its own package and the
 * library it drives, and dropping either loses half the call tree.
 */
export function targetPackagesFor(service: {
	command?: string;
	modules?: string[];
}): { packages: string[]; added: string | null } {
	const declared = (service.modules ?? []).filter((m) => m && looksLikeModule(m));
	const entry = service.command ? entrypointModule(service.command) : null;
	if (!entry) {
		return { packages: declared, added: null };
	}
	const root = rootPackage(entry);
	if (declared.includes(root)) {
		return { packages: declared, added: null };
	}
	return { packages: [...declared, root], added: root };
}

/**
 * Which service serves the endpoint defined in `file`.
 *
 * The overlay needs this to pick the right capture. Without it the engine falls
 * back to "the freshest trace.jsonl anywhere under .vinv/captures", which in a
 * repo with four traced services is whichever one ran last — so a call tree for
 * `examples/server/main.py` could be overlaid against the gradio UI's trace and
 * still report `status: ok`, with an empty overlay and no explanation.
 *
 * Matched on the entrypoint module, exactly first and by root package second.
 * Returns null when the join is not unambiguous, which restores the previous
 * behaviour rather than guessing a service and confidently overlaying the
 * wrong trace.
 */
export function serviceForEndpointFile(
	services: ReadonlyArray<{ name: string; command?: string }>,
	file: string,
): string | null {
	const target = moduleFromScript(file) ?? file.replace(/\\/g, '/').replace(/\.py$/, '').replace(/\//g, '.');
	if (!target) {
		return null;
	}
	const entries = services
		.map((s) => ({ name: s.name, module: s.command ? entrypointModule(s.command) : null }))
		.filter((e): e is { name: string; module: string } => !!e.module);

	const exact = entries.filter((e) => e.module === target);
	if (exact.length === 1) {
		return exact[0].name;
	}
	const sameRoot = entries.filter((e) => rootPackage(e.module) === rootPackage(target));
	return sameRoot.length === 1 ? sameRoot[0].name : null;
}

/**
 * The `--target-package` values a recorded start command actually carries.
 * Both spellings tracelens accepts, matching tracedRun's own parsing.
 */
export function recordedTargetPackages(command: string): string[] {
	return [...command.matchAll(/(?:--target-package|-t)\s+(\S+)/g)].map((m) => m[1]);
}

/**
 * The package a recorded start command fails to instrument, or null when it is
 * fine (or unknowable).
 *
 * Checked BEFORE a run, from the record alone — no trace needed. The bring-up
 * path now appends the entrypoint's package (targetPackagesFor), but that only
 * governs what a NEW bring-up records: `.vinv/start_commands/<service>.json`
 * lives outside the repo and is replayed verbatim, so a service brought up by an
 * older build keeps instrumenting the wrong package indefinitely. Every capture
 * it produces then has inbound spans and not one application frame, which reads
 * downstream as 0% coverage on a green service.
 */
export function missingTargetPackage(
	command: string,
	service: { command?: string; modules?: string[] },
): string | null {
	const entry = service.command ? entrypointModule(service.command) : null;
	if (!entry) {
		return null;
	}
	const recorded = recordedTargetPackages(command);
	// No flags at all means tracelens is not wrapping this command — a service
	// started without tracing is a different problem, not a wrong target.
	if (recorded.length === 0) {
		return null;
	}
	const root = rootPackage(entry);
	return recorded.includes(root) ? null : root;
}

/**
 * The same command with `pkg` added to its `--target-package` flags.
 *
 * Purely additive, and that is what makes repairing a recorded command safe to
 * do without asking: instrumenting MORE code cannot stop a service starting, and
 * the flag list is computed, not judged. The extension already passes the right
 * `--module` values to `bringup start` and the prompt says to use them verbatim —
 * but an agent that drops one produces a record which comes up green forever
 * while tracing none of the service's own code. A deterministic fact should not
 * depend on a model repeating it correctly.
 *
 * Inserted after the LAST existing target flag, which is always before the `--`
 * separator, so the appended flag lands on tracelens and never on the child.
 */
export function withTargetPackage(command: string, pkg: string): string {
	const flags = [...command.matchAll(/(?:--target-package|-t)\s+\S+/g)];
	if (flags.length === 0) {
		return command; // not a tracelens invocation — nothing to extend
	}
	const last = flags[flags.length - 1];
	const end = (last.index ?? 0) + last[0].length;
	return `${command.slice(0, end)} --target-package ${pkg}${command.slice(end)}`;
}

/**
 * Whether a trace shows the service's OWN code running, and can say so.
 *
 * Answers three ways on purpose. `unknown` (no entrypoint package, or no
 * inbound request in the trace) must never be reported as a failure: a
 * port-only bring-up probe legitimately serves nothing, and a console-script
 * entrypoint has no package to look for. Only "requests were served AND not one
 * of them ran a line of this service's code" is a real defect — which is
 * exactly the shape the target-package mismatch produces.
 */
export type OwnCodeVerdict =
	| { state: 'traced'; ownFrames: number }
	| { state: 'absent'; requests: number; rootPackage: string }
	| { state: 'unknown'; why: string };

/**
 * A request ROOT span: `METHOD /path`, and nothing after the path.
 *
 * The trailing anchor is load-bearing. ASGI emits message sub-spans named
 * `POST /chat http receive` under each request, so a looser prefix match counts
 * one request as two or three and reports an inflated number back to the user.
 */
const INBOUND_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S*$/;

/**
 * Classifies trace span component names against the service's own root package.
 * Takes the components rather than a path so it stays pure — the caller streams
 * the file.
 */
export function judgeOwnCode(
	components: Iterable<string>,
	entrypoint: string | null,
): OwnCodeVerdict {
	if (!entrypoint) {
		return { state: 'unknown', why: 'the start command names no importable module' };
	}
	const root = rootPackage(entrypoint);
	let requests = 0;
	let ownFrames = 0;
	for (const comp of components) {
		if (INBOUND_RE.test(comp)) {
			requests++;
		} else if (comp === root || comp.startsWith(`${root}.`)) {
			ownFrames++;
		}
	}
	if (ownFrames > 0) {
		return { state: 'traced', ownFrames };
	}
	if (requests === 0) {
		return { state: 'unknown', why: 'no request reached the service while it was traced' };
	}
	return { state: 'absent', requests, rootPackage: root };
}
