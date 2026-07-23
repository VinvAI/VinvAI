/**
 * Golden I/O baselines for endpoint probes — the missing half of "optimize
 * without degrading output" (requirement: input/output regression map).
 *
 * The probe runner replays synthesized/authored requests against the live
 * service (probeRunner.ts). This module persists what a HEALTHY run of each
 * endpoint looked like — per probe: status class, handler provenance, and a
 * RESPONSE SHAPE HASH (structure, not values) — into
 * `.vinv/probes/baselines/<api-id>.json`, and diffs every later probe pass
 * against it. After an optimization/fix episode the re-run probes therefore
 * carry a per-endpoint verdict: `degraded` / `same` / `improved`, which is an
 * objective regression signal no LLM judge can hand-wave.
 *
 * Shape, not bytes: a JSON body hashes its STRUCTURE (sorted keys + value
 * types, arrays collapsed to their element-shape union) so timestamps, ids and
 * counters do not churn the hash, while a dropped/renamed field or a
 * type change does. Non-JSON bodies hash to their content-type class only —
 * honest coarse equality rather than fake precision on opaque bytes.
 *
 * Baseline discipline (golden = earned, never overwritten silently):
 *  - a baseline entry is recorded the first time a probe PASSES;
 *  - later runs only COMPARE — a degraded run never rewrites its own baseline
 *    (that would define the regression away);
 *  - an IMPROVED run (baseline was failing-class, now clean) upgrades the
 *    baseline, so the ratchet only ever moves toward better behavior.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ---- response shape hashing -------------------------------------------------

/** Canonical structural signature of a parsed JSON value (values erased). */
export function jsonShapeSignature(value: unknown, depth = 0): string {
	if (depth > 8) {
		return '…';
	}
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		// Union of element shapes, order-insensitive: a list of homogeneous
		// records keeps one signature no matter how many rows came back.
		const shapes = [...new Set(value.map((v) => jsonShapeSignature(v, depth + 1)))].sort();
		return `[${shapes.join('|')}]`;
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${k}:${jsonShapeSignature(v, depth + 1)}`);
		return `{${entries.join(',')}}`;
	}
	return typeof value; // string | number | boolean
}

/**
 * The shape hash of a response body. JSON bodies hash their structure;
 * non-JSON bodies hash their content-type class; an empty body is 'empty'.
 */
export function responseShapeHash(body: string, contentType?: string): string {
	if (!body) {
		return 'empty';
	}
	const looksJson =
		(contentType ?? '').includes('json') || /^[\s]*[[{"]/.test(body.slice(0, 64));
	if (looksJson) {
		try {
			const sig = jsonShapeSignature(JSON.parse(body));
			return `json:${crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16)}`;
		} catch {
			// Fall through to the coarse class.
		}
	}
	const klass = (contentType ?? 'unknown').split(';')[0].trim() || 'unknown';
	return `raw:${klass}`;
}

// ---- baseline model ---------------------------------------------------------

/** Coarse status class of an observed response. Order = goodness. */
export type StatusClass = '2xx-3xx' | '4xx' | '5xx' | 'no-response';

export function statusClassOf(status: number | null): StatusClass {
	if (status === null) {
		return 'no-response';
	}
	if (status >= 500) {
		return '5xx';
	}
	if (status >= 400) {
		return '4xx';
	}
	return '2xx-3xx';
}

/** Goodness rank of a status class (higher is better). */
const CLASS_RANK: Record<StatusClass, number> = {
	'2xx-3xx': 3,
	'4xx': 2,
	'5xx': 1,
	'no-response': 0,
};

/** One probe's golden record: request identity → expected response shape. */
export interface BaselineEntry {
	/** Probe id (endpoint id + method+path hash) — the request identity. */
	probeId: string;
	method: string;
	path: string;
	statusClass: StatusClass;
	httpStatus: number | null;
	/** Handler symbol the traced request resolved to (provenance). */
	handler: string | null;
	/** Structural hash of the response body (see responseShapeHash). */
	shapeHash: string;
	capturedAt: string;
}

/** The persisted golden baseline for one endpoint (api id). */
export interface BaselineFile {
	version: 1;
	endpointId: string;
	entries: Record<string, BaselineEntry>;
}

function safeApiId(apiId: string): string {
	return apiId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** .vinv/probes/baselines/<api-id>.json */
export function baselineFilePath(workspaceRoot: string, endpointId: string): string {
	return path.join(workspaceRoot, '.vinv', 'probes', 'baselines', `${safeApiId(endpointId)}.json`);
}

/** Reads an endpoint's baseline, or null when absent/unreadable. */
export function readBaseline(workspaceRoot: string, endpointId: string): BaselineFile | null {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(baselineFilePath(workspaceRoot, endpointId), 'utf8'),
		) as BaselineFile;
		return parsed && parsed.version === 1 && parsed.entries ? parsed : null;
	} catch {
		return null;
	}
}

function writeBaseline(workspaceRoot: string, file: BaselineFile): void {
	const target = baselineFilePath(workspaceRoot, file.endpointId);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(file, null, '\t')}\n`, 'utf8');
	fs.renameSync(tmp, target);
}

// ---- comparison -------------------------------------------------------------

/** Per-probe baseline verdict (additive to the probe outcome). */
export type BaselineVerdict = 'degraded' | 'same' | 'improved' | 'recorded';

export interface BaselineComparison {
	verdict: BaselineVerdict;
	detail?: string;
}

/** What one executed probe observed (the runner supplies this). */
export interface ObservedResponse {
	probeId: string;
	endpointId: string;
	method: string;
	path: string;
	httpStatus: number | null;
	handler: string | null;
	shapeHash: string;
}

/**
 * Compares one observation against its golden entry. Pure.
 *  - status class worsened → degraded;
 *  - status class improved → improved (the ratchet will re-record);
 *  - same class but the response STRUCTURE changed on a healthy endpoint →
 *    degraded (the output contract moved — exactly what an "optimization"
 *    must not do silently);
 *  - otherwise same.
 */
export function compareObservation(
	baseline: BaselineEntry,
	observed: ObservedResponse,
): BaselineComparison {
	const before = CLASS_RANK[baseline.statusClass];
	const after = CLASS_RANK[statusClassOf(observed.httpStatus)];
	if (after < before) {
		return {
			verdict: 'degraded',
			detail:
				`status degraded: baseline ${baseline.statusClass} (HTTP ${baseline.httpStatus}) → ` +
				`${statusClassOf(observed.httpStatus)} (HTTP ${observed.httpStatus ?? 'none'})`,
		};
	}
	if (after > before) {
		return {
			verdict: 'improved',
			detail: `status improved: baseline ${baseline.statusClass} → ${statusClassOf(observed.httpStatus)}`,
		};
	}
	if (baseline.statusClass === '2xx-3xx' && baseline.shapeHash !== observed.shapeHash) {
		return {
			verdict: 'degraded',
			detail: `response shape changed: ${baseline.shapeHash} → ${observed.shapeHash}`,
		};
	}
	return { verdict: 'same' };
}

/**
 * Applies the baseline pass to one probe run's observations, grouped by
 * endpoint: records golden entries for first-seen PASSING probes, compares
 * everything else, and upgrades entries on improvement. Returns the per-probe
 * verdicts keyed by probe id. Never throws — a baseline failure must not fail
 * the probe pass (fs errors degrade to no verdict for that endpoint).
 */
export function applyBaselines(
	workspaceRoot: string,
	observations: ObservedResponse[],
): Map<string, BaselineComparison> {
	const verdicts = new Map<string, BaselineComparison>();
	const byEndpoint = new Map<string, ObservedResponse[]>();
	for (const o of observations) {
		const list = byEndpoint.get(o.endpointId) ?? [];
		list.push(o);
		byEndpoint.set(o.endpointId, list);
	}
	for (const [endpointId, group] of byEndpoint) {
		try {
			const existing = readBaseline(workspaceRoot, endpointId) ?? {
				version: 1 as const,
				endpointId,
				entries: {},
			};
			let dirty = false;
			for (const o of group) {
				const entry = existing.entries[o.probeId];
				if (!entry) {
					// Golden = earned: only a healthy response seeds a baseline. A
					// failing first observation stays unbaselined so the eventual
					// fix records the healthy contract, not the broken one.
					if (statusClassOf(o.httpStatus) === '2xx-3xx') {
						existing.entries[o.probeId] = {
							probeId: o.probeId,
							method: o.method,
							path: o.path,
							statusClass: statusClassOf(o.httpStatus),
							httpStatus: o.httpStatus,
							handler: o.handler,
							shapeHash: o.shapeHash,
							capturedAt: new Date().toISOString(),
						};
						dirty = true;
						verdicts.set(o.probeId, { verdict: 'recorded' });
					}
					continue;
				}
				const cmp = compareObservation(entry, o);
				verdicts.set(o.probeId, cmp);
				if (cmp.verdict === 'improved') {
					// Ratchet: the baseline only ever moves toward better behavior.
					existing.entries[o.probeId] = {
						...entry,
						statusClass: statusClassOf(o.httpStatus),
						httpStatus: o.httpStatus,
						shapeHash: o.shapeHash,
						capturedAt: new Date().toISOString(),
					};
					dirty = true;
				}
			}
			if (dirty) {
				writeBaseline(workspaceRoot, existing);
			}
		} catch {
			// Baseline IO is additive evidence; its failure never fails probing.
		}
	}
	return verdicts;
}
