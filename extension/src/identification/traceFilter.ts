import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/** An absolute wall-clock window (epoch seconds) to keep trace spans within. */
export interface TraceTimeRange {
	/** Inclusive lower bound, epoch seconds. */
	fromSec: number;
	/** Inclusive upper bound, epoch seconds. */
	toSec: number;
}

/**
 * The trace.jsonl the `tracesummary` binary probes by default:
 * <root>/.vinv/captures/vinv-bringup/<service>/trace.jsonl — the first service
 * subdir that has one. Returns undefined when no capture exists.
 */
export function probeTraceFile(workspaceRoot: string): string | undefined {
	const base = path.join(workspaceRoot, '.vinv', 'captures', 'vinv-bringup');
	let services: string[];
	try {
		services = fs.readdirSync(base);
	} catch {
		return undefined;
	}
	for (const svc of services) {
		const f = path.join(base, svc, 'trace.jsonl');
		if (fs.existsSync(f)) {
			return f;
		}
	}
	return undefined;
}

/**
 * Capture start (epoch seconds) from the sibling trace.summary.json. Spans in
 * trace.jsonl carry only a relative `started_at` (seconds from capture start),
 * so this anchor is what maps them onto the wall clock.
 */
function readCapturedAt(traceFile: string): number | undefined {
	try {
		const summary = JSON.parse(
			fs.readFileSync(path.join(path.dirname(traceFile), 'trace.summary.json'), 'utf8'),
		) as { captured_at?: unknown };
		return typeof summary.captured_at === 'number' ? summary.captured_at : undefined;
	} catch {
		return undefined;
	}
}

/** A span reduced to just what filtering needs: its wall-clock interval + raw line. */
interface SpanEntry {
	start: number;
	end: number;
	line: string;
}

/** Parsed trace index, cached so a poll doesn't re-read/re-parse an unchanged file. */
interface TraceIndex {
	size: number;
	mtimeMs: number;
	spans: SpanEntry[];
}

// Keyed by trace-file path. Steady state (file unchanged between 1s polls) reuses
// the parsed index, so each poll is a cheap numeric re-filter rather than a full
// JSON parse of a possibly-large trace — this is what keeps filtering ~instant.
const indexCache = new Map<string, TraceIndex>();
// Signature of the last temp file written per output path, so we don't rewrite
// (and don't force the binary to re-read) when the kept span set hasn't changed.
const lastWriteSig = new Map<string, string>();

// Pull the two numeric fields we need without a full JSON.parse of every line —
// much faster on large traces. Falls back to 0 when a field is absent.
const STARTED_RE = /"started_at"\s*:\s*(-?\d+(?:\.\d+)?)/;
const DURATION_RE = /"duration_ms"\s*:\s*(-?\d+(?:\.\d+)?)/;

function loadIndex(traceFile: string): TraceIndex | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(traceFile);
	} catch {
		return undefined;
	}
	const cached = indexCache.get(traceFile);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
		return cached;
	}

	let raw: string;
	try {
		raw = fs.readFileSync(traceFile, 'utf8');
	} catch {
		return undefined;
	}

	// First pass: pull each span's relative offset/duration (seconds from capture
	// start) and track how far the latest span reaches — needed to anchor the
	// trace on the wall clock.
	const rel: { startRel: number; endRel: number; line: string }[] = [];
	let maxEndRel = 0;
	for (const line of raw.split('\n')) {
		const s = line.trim();
		if (!s) {
			continue;
		}
		const sm = STARTED_RE.exec(s);
		const dm = DURATION_RE.exec(s);
		const startRel = sm ? parseFloat(sm[1]) : 0;
		const endRel = startRel + (dm ? parseFloat(dm[1]) : 0) / 1000;
		if (endRel > maxEndRel) {
			maxEndRel = endRel;
		}
		rel.push({ startRel, endRel, line: s });
	}

	// Anchor relative offsets onto the wall clock. Prefer the capture's recorded
	// start (trace.summary.json); when that's missing — e.g. a live/in-progress
	// capture with no summary yet — fall back to the trace file's mtime, treating
	// the newest span as ending at the last write. Without this fallback the whole
	// filter silently no-ops (returns undefined → unfiltered counts).
	const summaryAt = readCapturedAt(traceFile);
	const capturedAt = summaryAt !== undefined ? summaryAt : stat.mtimeMs / 1000 - maxEndRel;

	const spans: SpanEntry[] = rel.map((r) => ({
		start: capturedAt + r.startRel,
		end: capturedAt + r.endRel,
		line: r.line,
	}));

	const index: TraceIndex = { size: stat.size, mtimeMs: stat.mtimeMs, spans };
	indexCache.set(traceFile, index);
	return index;
}

/**
 * Writes a trace.jsonl holding only the spans whose wall-clock interval overlaps
 * [range.fromSec, range.toSec] and returns its path — so the existing
 * `tracesummary` binary, pointed at it via --trace, recounts hits for just that
 * window while still doing all the endpoint attribution.
 *
 * A span's absolute interval is [captured_at + started_at, +duration_ms]. Keeping
 * a span whenever its interval overlaps the window also keeps its ancestors
 * (which fully contain it in time), so the request tree the binary counts on
 * stays connected without a separate ancestor pass.
 *
 * Fast by construction: the trace is parsed once and cached (keyed on file
 * size+mtime); each subsequent poll only re-filters cached numbers and rewrites
 * the temp file when the kept set actually changed. Returns undefined when there
 * is no capture or no captured_at anchor to map offsets to wall-clock time — the
 * caller then falls back to the unfiltered summary.
 */
export function buildFilteredTrace(
	workspaceRoot: string,
	range: TraceTimeRange,
): string | undefined {
	const traceFile = probeTraceFile(workspaceRoot);
	if (!traceFile) {
		return undefined;
	}
	const index = loadIndex(traceFile);
	if (!index) {
		return undefined;
	}

	const kept: string[] = [];
	for (const span of index.spans) {
		if (span.start <= range.toSec && span.end >= range.fromSec) {
			kept.push(span.line);
		}
	}

	// One stable temp file per workspace (overwritten in place) so filtered traces
	// don't pile up in the temp dir.
	const key = crypto.createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 12);
	const out = path.join(os.tmpdir(), `vinv-trace-filter-${key}.jsonl`);

	// Skip the write when nothing changed: same source file and same kept slice
	// means the binary would read an identical trace.
	const sig = `${index.mtimeMs}:${kept.length}:${kept.length ? kept[0].length + '/' + kept[kept.length - 1].length : '0'}`;
	if (lastWriteSig.get(out) === sig && fs.existsSync(out)) {
		return out;
	}
	try {
		fs.writeFileSync(out, kept.length ? kept.join('\n') + '\n' : '');
	} catch {
		return undefined;
	}
	lastWriteSig.set(out, sig);
	return out;
}
