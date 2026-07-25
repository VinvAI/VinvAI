/**
 * The pure statistics behind an optimization verdict — a paired bootstrap CI
 * over before/after sample vectors (a port of optimize.py). Deliberately
 * vscode-free and dependency-light so BOTH the probe verdict engine
 * (exerciseOptimize) and the trace-diff verdict (traceDiff) share one
 * implementation, and so the maths is unit-testable in isolation.
 *
 * The comparison is UNIT-AGNOSTIC: it takes two number vectors and reports a
 * RELATIVE improvement, so the same code judges milliseconds (latency) and
 * bytes (memory) identically — the 10% minimum-effect threshold is a fraction
 * either way.
 */

/** Minimum practical relative improvement for an optimization to count (10%). */
export const DEFAULT_MIN_EFFECT = 0.1;
/** Bootstrap resamples for the CI. */
const BOOTSTRAP_N = 2000;

/** A paired before/after metric comparison with a bootstrap CI. */
export interface MetricComparison {
	before_median: number;
	after_median: number;
	/** (before - after) / before, positive = improved (faster / lighter). */
	rel_improvement: number;
	ci_low: number;
	ci_high: number;
	/** effect >= min AND CI excludes zero (positive). */
	improved: boolean;
}

/** JSON shape identical to optimize.py's MetricComparison.to_json(). */
export function comparisonToJson(c: MetricComparison): Record<string, number | boolean> {
	const r = (v: number, d: number): number => {
		const f = 10 ** d;
		return Math.round(v * f) / f;
	};
	return {
		before_median: r(c.before_median, 3),
		after_median: r(c.after_median, 3),
		rel_improvement: r(c.rel_improvement, 4),
		ci_low: r(c.ci_low, 4),
		ci_high: r(c.ci_high, 4),
		improved: c.improved,
	};
}

export function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Deterministic PRNG (xmur3 string seed → mulberry32) for the bootstrap. */
export function seededRng(seed: string): () => number {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i += 1) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	let a = (h ^= h >>> 16) >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Relative improvement of `after` over `before` with a bootstrap 95% CI.
 * Paired: before[i] and after[i] are the SAME unit of work measured twice, so
 * resampling draws index sets and keeps the pairing. `improved` is true only
 * when the point estimate meets the minimum practical effect AND the CI lower
 * bound is > 0.
 */
export function pairedBootstrapImprovement(
	before: number[],
	after: number[],
	options: { minEffect?: number; seed?: number; resamples?: number } = {},
): MetricComparison {
	const minEffect = options.minEffect ?? DEFAULT_MIN_EFFECT;
	const resamples = options.resamples ?? BOOTSTRAP_N;
	const n = Math.min(before.length, after.length);
	if (n === 0) {
		return {
			before_median: 0,
			after_median: 0,
			rel_improvement: 0,
			ci_low: 0,
			ci_high: 0,
			improved: false,
		};
	}
	const b = before.slice(0, n);
	const a = after.slice(0, n);
	const bMed = median(b);
	const aMed = median(a);
	const point = bMed > 0 ? (bMed - aMed) / bMed : 0;

	const rng = seededRng(`opt ${options.seed ?? 1729}`);
	const stats: number[] = [];
	for (let r = 0; r < resamples; r += 1) {
		const bb: number[] = [];
		const aa: number[] = [];
		for (let i = 0; i < n; i += 1) {
			const idx = Math.floor(rng() * n);
			bb.push(b[idx]);
			aa.push(a[idx]);
		}
		const bm = median(bb);
		stats.push(bm > 0 ? (bm - median(aa)) / bm : 0);
	}
	stats.sort((x, y) => x - y);
	const lo = stats[Math.floor(0.025 * stats.length)];
	const hi = stats[Math.min(stats.length - 1, Math.floor(0.975 * stats.length))];
	return {
		before_median: bMed,
		after_median: aMed,
		rel_improvement: point,
		ci_low: lo,
		ci_high: hi,
		improved: point >= minEffect && lo > 0,
	};
}
