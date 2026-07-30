/**
 * The seven observe-only runtime tools, orchestrated over the trace corpus.
 *
 * Every function here reads a completed capture and *describes* it. Nothing
 * reproduces, verifies, or edits code — that stays with the developer + their
 * agent (Claude / Cursor). Each returns a plain JSON-serializable object so the
 * MCP layer can hand it straight back to the model:
 *
 *   values_of        — B1 value profile for a symbol
 *   rank_suspects    — D1 SBFL ranking across pass/fail run spectra
 *   slice            — D4 backward slice (caller chain + values) to a symbol
 *   blast_radius     — D5 transitive callers/callees of a symbol
 *   why_did_this_run — the request roots and call paths that reached a symbol
 *   coverage_of      — what executed, how often, ok/error, timing
 *   callers_of       — the observed direct callers of a symbol
 */
import {
	cmpSessionMark,
	containmentVerdict,
	mergeContainment,
	mergeExitOutcome,
	loadCorpus,
	resolveSymbol,
	TraceCorpus,
	type ExitRow,
	type SessionMark,
} from './traceStore';
import { valuesOf } from './valueProfiles';
import { rankSuspects } from './sbfl';
import { backwardSlice, blastRadius } from './slice';
import { bodyHashForComponent } from './symbolIdentity';
import { chunkForComponent } from './indexJoin';

/**
 * Dates a symbol's runtime facts against the current index: joins the trace
 * component to its index chunk and compares the chunk's content epoch with
 * the latest epoch-tagged session that observed the symbol.
 *
 * `stale: true` means the symbol's source changed after every tagged
 * observation — the facts describe code that no longer exists. `stale` is
 * omitted (undefined) when it cannot be determined: no index chunk, no epoch
 * tags, or observations from untagged (pre-epoch) sessions.
 */
function codeState(
	workspaceRoot: string,
	corpus: TraceCorpus,
	component: string,
): Record<string, unknown> | undefined {
	const chunk = chunkForComponent(workspaceRoot, component);
	if (!chunk) {
		return undefined;
	}
	const rec = corpus.bySymbol.get(component);
	const observed = rec && !rec.observedUntagged ? rec.lastObservedEpoch : null;
	return {
		chunk_id: chunk.id,
		chunk_epoch: chunk.epoch,
		last_observed_epoch: observed ?? undefined,
		stale: observed !== null ? chunk.epoch > observed : undefined,
		note:
			observed !== null && chunk.epoch > observed
				? 'This symbol changed after these observations were captured; re-run to refresh.'
				: undefined,
	};
}

/** Shared "no capture yet" reply. */
function noCapture(): Record<string, unknown> {
	return {
		status: 'no_capture',
		message:
			'No tracelens capture found under .vinv/captures. Run a service under ' +
			'tracelens first to record a session.',
	};
}

/** Shared symbol-resolution reply for unknown/ambiguous names. */
function resolveOrExplain(
	corpus: TraceCorpus,
	symbol: string,
): { component: string } | { error: Record<string, unknown> } {
	const { match, candidates } = resolveSymbol(corpus, symbol);
	if (match) {
		return { component: match };
	}
	if (candidates.length === 0) {
		return {
			error: {
				status: 'unknown_symbol',
				message: `No symbol matching "${symbol}" ran in the capture.`,
			},
		};
	}
	return {
		error: {
			status: 'ambiguous_symbol',
			message: `"${symbol}" matches ${candidates.length} symbols; pass a fuller qualname.`,
			candidates,
		},
	};
}

/** B1 — value profile for a symbol, with its current body-hash identity. */
export function toolValuesOf(workspaceRoot: string, symbol: string): Record<string, unknown> {
	const corpus = loadCorpus(workspaceRoot);
	if (corpus.empty) {
		return noCapture();
	}
	const r = resolveOrExplain(corpus, symbol);
	if ('error' in r) {
		return r.error;
	}
	const profile = valuesOf(corpus, r.component);
	if (!profile) {
		return { status: 'unknown_symbol', message: `"${symbol}" produced no value data.` };
	}
	const identity = bodyHashForComponent(workspaceRoot, r.component);
	return {
		status: 'ok',
		symbol: r.component,
		identity: { file: identity.file, line: identity.line, body_hash: identity.hash },
		code_state: codeState(workspaceRoot, corpus, r.component),
		calls: profile.calls,
		args: profile.args,
		returns: profile.ret,
	};
}

/** D1 — SBFL suspect ranking across the run spectra. */
export function toolRankSuspects(workspaceRoot: string, limit = 20): Record<string, unknown> {
	const corpus = loadCorpus(workspaceRoot);
	if (corpus.empty) {
		return noCapture();
	}
	const result = rankSuspects(corpus, limit);
	// Date each suspect against the index so the agent knows which rankings
	// rest on observations of since-changed code.
	const suspects = result.suspects.map((s) => {
		const state = codeState(workspaceRoot, corpus, (s as { component: string }).component);
		return state?.stale === true ? { ...s, stale: true } : s;
	});
	return {
		status: 'ok',
		total_runs: result.totalRuns,
		failed_runs: result.failedRuns,
		passed_runs: result.passedRuns,
		degenerate: result.degenerate,
		note: result.degenerate
			? 'No pass/fail contrast — scores are unreliable; ranking falls back to direct errors.'
			: undefined,
		suspects,
	};
}

/** D4 — backward slice: caller chain + observed values into a symbol. */
export function toolSlice(workspaceRoot: string, symbol: string): Record<string, unknown> {
	const corpus = loadCorpus(workspaceRoot);
	if (corpus.empty) {
		return noCapture();
	}
	const r = resolveOrExplain(corpus, symbol);
	if ('error' in r) {
		return r.error;
	}
	const slice = backwardSlice(corpus, r.component);
	return {
		status: 'ok',
		symbol: r.component,
		code_state: codeState(workspaceRoot, corpus, r.component),
		paths: slice.paths,
		truncated: slice.truncated,
	};
}

/** D5 — blast radius: transitive callers/callees over the observed graph. */
export function toolBlastRadius(
	workspaceRoot: string,
	symbol: string,
	direction: 'up' | 'down' | 'both' = 'both',
): Record<string, unknown> {
	const corpus = loadCorpus(workspaceRoot);
	if (corpus.empty) {
		return noCapture();
	}
	const r = resolveOrExplain(corpus, symbol);
	if ('error' in r) {
		return r.error;
	}
	const br = blastRadius(corpus, r.component);
	return {
		status: 'ok',
		symbol: r.component,
		code_state: codeState(workspaceRoot, corpus, r.component),
		upstream: direction === 'down' ? undefined : br.upstream,
		downstream: direction === 'up' ? undefined : br.downstream,
		direct_callers: br.directCallers,
		direct_callees: br.directCallees,
	};
}

/** The request roots and call paths that reached a symbol ("why did this run?"). */
export function toolWhyDidThisRun(workspaceRoot: string, symbol: string): Record<string, unknown> {
	const corpus = loadCorpus(workspaceRoot);
	if (corpus.empty) {
		return noCapture();
	}
	const r = resolveOrExplain(corpus, symbol);
	if ('error' in r) {
		return r.error;
	}
	const rec = corpus.bySymbol.get(r.component)!;
	// Distinct request roots (triggers) that led here, with occurrence counts.
	const rootCounts = new Map<string, number>();
	for (const requestId of rec.requests) {
		const outcome = corpus.byRequest.get(requestId);
		for (const root of outcome?.roots ?? []) {
			rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
		}
	}
	const triggers = [...rootCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([root, requests]) => ({ entrypoint: root, requests }));

	const slice = backwardSlice(corpus, r.component);
	// Collapse each slice path to the sequence of component names (the "why").
	const paths = slice.paths.map((p) => ({
		request_id: p.request_id,
		path: p.frames.map((f) => f.component),
	}));

	return {
		status: 'ok',
		symbol: r.component,
		ran_in_requests: rec.requests.size,
		triggers,
		call_paths: paths,
	};
}

/** Coverage: whole-run overview, or one symbol's execution facts. */
export function toolCoverageOf(workspaceRoot: string, symbol?: string): Record<string, unknown> {
	const corpus = loadCorpus(workspaceRoot);
	if (corpus.empty) {
		return noCapture();
	}

	if (symbol) {
		const r = resolveOrExplain(corpus, symbol);
		if ('error' in r) {
			return r.error;
		}
		const rec = corpus.bySymbol.get(r.component)!;
		let ok = 0;
		let error = 0;
		let totalMs = 0;
		const errorTypes = new Set<string>();
		// Session ordering (epoch, time, path) — byte-identical to indexGraph's
		// lifecycle so this MCP tool and the graph/QnA agree on the latest
		// session, hence on current_errors and every superseded verdict.
		const sessionKey = (x: {
			source_epoch?: number | null;
			source_t?: number;
			source_path?: string;
		}): SessionMark => ({
			epoch: x.source_epoch ?? null,
			t: x.source_t ?? 0,
			path: x.source_path ?? '',
		});
		const cmpSession = cmpSessionMark;
		let latest: SessionMark | null = null;
		for (const x of rec.exits) {
			const k = sessionKey(x);
			if (!latest || cmpSession(k, latest) > 0) {
				latest = k;
			}
		}
		let currentErrors = 0;
		// Full failure identity, deduped by (type, message): the message and
		// traceback are the evidence an agent needs to say what went wrong,
		// not merely that something of this class did.
		interface CoverageFailure {
			error_type: string;
			error_message: string | null;
			error_stack: string | null;
			request_id: string;
			count: number;
			capture_epoch: number | null;
			superseded: null | 'code_changed' | 'not_reproduced';
			/** Did a caller absorb it? See traceStore.containmentVerdict. */
			contained: boolean | null;
			/** Innermost ancestor that absorbed it; null when it escaped/unknown. */
			contained_by: string | null;
			lastSeen: SessionMark;
		}
		const failures = new Map<string, CoverageFailure>();
		// Ancestor exit outcomes for containment: a parent's own exit row lives
		// on its SymbolRecord, matched on (request_id, thread_id) so concurrent
		// requests and threads never cross-contaminate. Innermost caller first.
		const ancestorExits = (
			x: ExitRow,
		): { oks: Array<boolean | null | undefined>; chain: string[] } => {
			const out: Array<boolean | null | undefined> = [];
			const chain: string[] = [];
			const seen = new Set<string>();
			let cursor = x.parent_component;
			while (cursor && out.length < 32 && !seen.has(cursor)) {
				seen.add(cursor);
				chain.push(cursor);
				// EVERY exit of this ancestor in the same (request, thread), folded
				// — not `.find`, which silently answered with whichever call
				// happened to be first. A component that ran several times with
				// mixed outcomes has no single answer here, and guessing one is
				// what let the graph overlay and this tool disagree on one capture.
				const pexits = (corpus.bySymbol.get(cursor)?.exits ?? []).filter(
					(e) => e.request_id === x.request_id && e.thread_id === x.thread_id,
				);
				let ok: boolean | null | undefined;
				for (const e of pexits) {
					ok = mergeExitOutcome(ok, e.status === 'ok');
				}
				out.push(ok);
				cursor = pexits[0]?.parent_component ?? null;
			}
			return { oks: out, chain };
		};
		for (const x of rec.exits) {
			if (x.status === 'error') {
				error += 1;
				if (latest && cmpSession(sessionKey(x), latest) === 0) {
					currentErrors += 1;
				}
				if (x.error_type) {
					errorTypes.add(x.error_type);
					const key = `${x.error_type} ${x.error_message ?? ''}`;
					const cur = failures.get(key);
					if (cur) {
						cur.count += 1;
						const anc = ancestorExits(x);
						const verdict = containmentVerdict(anc.oks);
						cur.contained = mergeContainment(cur.contained, verdict);
						cur.contained_by =
							cur.contained === true
								? (cur.contained_by ?? anc.chain[anc.oks.indexOf(true)] ?? null)
								: null;
						if (!cur.error_stack && x.error_stack) {
							cur.error_stack = x.error_stack;
						}
						if (cmpSession(sessionKey(x), cur.lastSeen) > 0) {
							cur.lastSeen = sessionKey(x);
							cur.capture_epoch = x.source_epoch ?? null;
						}
					} else {
						failures.set(key, {
							error_type: x.error_type,
							error_message: x.error_message ?? null,
							error_stack: x.error_stack ?? null,
							request_id: x.request_id,
							count: 1,
							capture_epoch: x.source_epoch ?? null,
							superseded: null,
							contained: containmentVerdict(ancestorExits(x).oks),
							contained_by: (() => {
								const a = ancestorExits(x);
								return containmentVerdict(a.oks) === true
									? (a.chain[a.oks.indexOf(true)] ?? null)
									: null;
							})(),
							lastSeen: sessionKey(x),
						});
					}
				}
			} else {
				ok += 1;
			}
			totalMs += x.duration_ms;
		}
		const state = codeState(workspaceRoot, corpus, r.component);
		const chunkEpoch =
			state && typeof state.chunk_epoch === 'number' ? (state.chunk_epoch as number) : null;
		const latestEpoch = latest?.epoch ?? null;
		for (const f of failures.values()) {
			if (latest && cmpSession(f.lastSeen, latest) < 0) {
				// A later run cleared it — but only call it verified-fixed when
				// that clean run exercised the CURRENT code. If the code changed
				// again after the clean run, it is an unverified fix.
				f.superseded =
					chunkEpoch !== null && latestEpoch !== null && chunkEpoch > latestEpoch
						? 'code_changed'
						: 'not_reproduced';
			} else if (chunkEpoch !== null && f.capture_epoch !== null && chunkEpoch > f.capture_epoch) {
				f.superseded = 'code_changed';
			}
		}
		return {
			status: 'ok',
			symbol: r.component,
			code_state: state,
			executed: true,
			calls: rec.exits.length,
			ok,
			error,
			current_errors: currentErrors,
			error_types: [...errorTypes],
			failures: [...failures.values()]
				.sort(
					(a, b) =>
						Number(a.superseded !== null) - Number(b.superseded !== null) || b.count - a.count,
				)
				.map(({ lastSeen: _lastSeen, ...f }) => f),
			total_ms: Number(totalMs.toFixed(3)),
			requests: rec.requests.size,
		};
	}

	// Whole-run coverage overview: every executed symbol with its call facts,
	// busiest first.
	const symbols = [...corpus.bySymbol.values()].map((rec) => {
		let ok = 0;
		let error = 0;
		let totalMs = 0;
		for (const x of rec.exits) {
			if (x.status === 'error') {
				error += 1;
			} else {
				ok += 1;
			}
			totalMs += x.duration_ms;
		}
		return {
			component: rec.component,
			calls: rec.exits.length,
			ok,
			error,
			total_ms: Number(totalMs.toFixed(3)),
			requests: rec.requests.size,
		};
	});
	symbols.sort((a, b) => b.calls - a.calls);
	return {
		status: 'ok',
		executed_symbols: symbols.length,
		total_requests: corpus.byRequest.size,
		sources: corpus.sources.length,
		symbols,
	};
}

/** The observed direct callers of a symbol, with call counts. */
export function toolCallersOf(workspaceRoot: string, symbol: string): Record<string, unknown> {
	const corpus = loadCorpus(workspaceRoot);
	if (corpus.empty) {
		return noCapture();
	}
	const r = resolveOrExplain(corpus, symbol);
	if ('error' in r) {
		return r.error;
	}
	const inner = corpus.callers.get(r.component);
	const callers = inner
		? [...inner.entries()]
				.map(([component, calls]) => ({ component, calls }))
				.sort((a, b) => b.calls - a.calls)
		: [];
	return {
		status: 'ok',
		symbol: r.component,
		callers,
		note: callers.length === 0 ? 'Observed as a request root or with no recorded parent.' : undefined,
	};
}
