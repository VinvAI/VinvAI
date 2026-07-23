/**
 * B1 — Value profiles.
 *
 * tracelens records a bounded *per-call* summary of every argument and return
 * value (the `args_summary` / `result_summary` fields), but a single call tells
 * you little. A value *profile* aggregates every call of a symbol into a compact
 * per-parameter (and per-return) picture: how often it was null, what types
 * flowed through, the numeric range, string-length range, and the most common
 * distinct values. That is the "what does this function actually see at runtime"
 * fact an agent needs to reason about a bug without re-running anything.
 *
 * Scope is deliberately trimmed for a *dev* run: a handful of thousands of calls,
 * not billions — so plain exact aggregation (ranges, a bounded distinct set,
 * top-k, null-rate, type mix) is enough. No t-digest / HyperLogLog / streaming
 * sketches; those buy nothing at this scale and only add complexity.
 */
import { SummaryDict, SymbolRecord, TraceCorpus } from './traceStore';

const TOPK = 8;
const DISTINCT_CAP = 64;

/** The aggregate for one role: a single parameter, or the return value. */
export interface ValueProfile {
	/** Total observations (calls that carried this role). */
	count: number;
	/** How many observations were None. */
	nullCount: number;
	/** Observed summary "type" → count (NoneType, int, float, str, list, …). */
	typeMix: Record<string, number>;
	/** Numeric range across scalar (`v`) observations, when any were numeric. */
	numeric?: { min: number; max: number; count: number };
	/** Length range across sized values (str/list/dict/bytes). */
	length?: { min: number; max: number; count: number };
	/** Most common distinct rendered values, most frequent first. */
	topValues: { value: string; count: number }[];
	/** True when the distinct-value set was capped (cardinality is only a lower bound). */
	distinctCapped: boolean;
	/** How many observations were dropped by the byte cap / summary errors. */
	unsummarized: number;
}

/** A symbol's full value picture: one profile per parameter, plus the return. */
export interface SymbolValueProfile {
	component: string;
	calls: number;
	args: Record<string, ValueProfile>;
	ret: ValueProfile;
}

function emptyProfile(): ValueProfile {
	return {
		count: 0,
		nullCount: 0,
		typeMix: {},
		topValues: [],
		distinctCapped: false,
		unsummarized: 0,
	};
}

/** Classifies a summary dict into a coarse type label for the type-mix histogram. */
function typeLabel(s: SummaryDict): string {
	if (s.type) {
		// "NoneType" or an opaque class name.
		return s.type;
	}
	if (typeof s.v === 'boolean') {
		return 'bool';
	}
	if (typeof s.v === 'number') {
		return Number.isInteger(s.v) ? 'int' : 'float';
	}
	if (s.head !== undefined) {
		return 'str';
	}
	if (s.elem_type !== undefined) {
		return 'list';
	}
	if (s.keys_head !== undefined) {
		return 'dict';
	}
	if (s.dtype !== undefined) {
		return 'ndarray';
	}
	if (s.cols_head !== undefined) {
		return 'DataFrame';
	}
	if (s.len !== undefined) {
		return 'sized';
	}
	return 'unknown';
}

/** Renders a summary dict to a short stable string for distinct-value counting. */
function renderValue(s: SummaryDict): string | null {
	if (s.type === 'NoneType') {
		return 'None';
	}
	if (typeof s.v === 'boolean') {
		return s.v ? 'True' : 'False';
	}
	if (typeof s.v === 'number') {
		return String(s.v);
	}
	if (s.head !== undefined) {
		return JSON.stringify(s.head) + (s.len !== undefined ? `/len=${s.len}` : '');
	}
	if (s.elem_type !== undefined) {
		return `list[${s.elem_type ?? '?'}]/len=${s.len ?? '?'}`;
	}
	if (s.keys_head !== undefined) {
		return `dict{${(s.keys_head ?? []).join(',')}}/len=${s.len ?? '?'}`;
	}
	if (s.dtype !== undefined) {
		return `ndarray[${s.dtype}]${s.shape ? JSON.stringify(s.shape) : ''}`;
	}
	if (s.cols_head !== undefined) {
		return `DataFrame${s.shape ? JSON.stringify(s.shape) : ''}`;
	}
	if (s.type) {
		return s.type;
	}
	if (s.len !== undefined) {
		return `len=${s.len}`;
	}
	return null;
}

function observe(profile: ValueProfile, s: SummaryDict | null | undefined, distinct: Map<string, number>): void {
	profile.count += 1;
	if (!s || typeof s !== 'object') {
		profile.unsummarized += 1;
		return;
	}
	if (s.truncated || s.summary_error) {
		profile.unsummarized += 1;
		return;
	}
	const label = typeLabel(s);
	profile.typeMix[label] = (profile.typeMix[label] ?? 0) + 1;
	if (s.type === 'NoneType') {
		profile.nullCount += 1;
	}
	if (typeof s.v === 'number') {
		if (!profile.numeric) {
			profile.numeric = { min: s.v, max: s.v, count: 0 };
		}
		profile.numeric.min = Math.min(profile.numeric.min, s.v);
		profile.numeric.max = Math.max(profile.numeric.max, s.v);
		profile.numeric.count += 1;
	}
	if (typeof s.len === 'number') {
		if (!profile.length) {
			profile.length = { min: s.len, max: s.len, count: 0 };
		}
		profile.length.min = Math.min(profile.length.min, s.len);
		profile.length.max = Math.max(profile.length.max, s.len);
		profile.length.count += 1;
	}
	const rendered = renderValue(s);
	if (rendered !== null) {
		if (distinct.has(rendered)) {
			distinct.set(rendered, (distinct.get(rendered) ?? 0) + 1);
		} else if (distinct.size < DISTINCT_CAP) {
			distinct.set(rendered, 1);
		} else {
			profile.distinctCapped = true;
		}
	}
}

function finalize(profile: ValueProfile, distinct: Map<string, number>): void {
	profile.topValues = [...distinct.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, TOPK)
		.map(([value, count]) => ({ value, count }));
}

/** Aggregates all calls of one symbol into per-parameter and return profiles. */
export function profileSymbol(record: SymbolRecord): SymbolValueProfile {
	const args = new Map<string, ValueProfile>();
	const argDistinct = new Map<string, Map<string, number>>();
	const ret = emptyProfile();
	const retDistinct = new Map<string, number>();

	for (const enter of record.enters) {
		for (const [param, summary] of Object.entries(enter.args_summary)) {
			let p = args.get(param);
			if (!p) {
				p = emptyProfile();
				args.set(param, p);
				argDistinct.set(param, new Map());
			}
			observe(p, summary, argDistinct.get(param) as Map<string, number>);
		}
	}
	for (const exit of record.exits) {
		observe(ret, exit.result_summary, retDistinct);
	}

	for (const [param, p] of args) {
		finalize(p, argDistinct.get(param) as Map<string, number>);
	}
	finalize(ret, retDistinct);

	return {
		component: record.component,
		calls: Math.max(record.enters.length, record.exits.length),
		args: Object.fromEntries(args),
		ret,
	};
}

/** Value profile for a single resolved symbol; null when it never ran. */
export function valuesOf(corpus: TraceCorpus, component: string): SymbolValueProfile | null {
	const record = corpus.bySymbol.get(component);
	if (!record) {
		return null;
	}
	return profileSymbol(record);
}
