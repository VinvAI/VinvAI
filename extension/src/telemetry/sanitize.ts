/**
 * The redaction layer — the thing that makes analytics on a code tool safe.
 *
 * Vinv sees absolute paths, repository names, source lines, tracebacks and the
 * output of the user's own agent CLI. None of that may leave the machine, and
 * "remember not to send it" is not a mechanism. So every property crossing into
 * PostHog passes through `sanitizeProps`, which is an ALLOWLIST:
 *
 *   - booleans and finite numbers pass;
 *   - strings pass only if they match SAFE_TOKEN — short, and drawn from an
 *     alphabet with no `/`, `\`, space, quote or `@` in it, so no path, URL,
 *     repo name, email or sentence can be spelled in it;
 *   - everything else is dropped.
 *
 * An allowlist matters because the failure directions are not symmetric. A
 * blocklist ("strip anything that looks like a path") fails OPEN: the day
 * someone writes `track('x', { path: file })` with a shape the patterns miss, it
 * ships and it leaks. This fails CLOSED — the property is dropped — and in a
 * dev or test build it THROWS, so the offending call site breaks a unit test on
 * the author's machine instead of leaking from a user's.
 *
 * It is also what keeps the data usable. PostHog charges for, and chokes on,
 * unbounded property cardinality; one free-text property (a raw error message, a
 * raw `appName`) turns a groupable funnel into a million singleton rows.
 *
 * This module deliberately imports NOTHING — not `vscode`, not the harness — so
 * it is directly unit-testable and so nothing here can accidentally reach into
 * the parts of the extension that hold the sensitive data.
 */

/** Property names: lowercase snake_case, bounded. Keeps the PostHog schema legible. */
const SAFE_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The only string shape that may be sent. Note what is NOT in this character
 * class: `/`, `\`, space, `'`, `"`, `@`. That exclusion is the actual privacy
 * guarantee — a POSIX path, a Windows path, a URL, a git remote, an email
 * address and an English sentence all require at least one of them.
 */
const SAFE_TOKEN = /^[a-z0-9_.:-]{1,64}$/i;

/** PostHog's own `$`-prefixed controls (e.g. `$geoip_disable`) bypass SAFE_KEY. */
const POSTHOG_CONTROL = /^\$[a-z][a-z0-9_]{0,39}$/;

/**
 * Whether a rejected property is a loud failure or a silent drop. Defaults to
 * strict so a unit test importing this module directly gets the throwing
 * behaviour; `initTelemetry` turns it off for production builds.
 */
let defaultStrict = true;

/** Called by initTelemetry: production drops silently, dev/test throws. */
export function setSanitizerStrict(value: boolean): void {
	defaultStrict = value;
}

export type SafeValue = string | number | boolean;

/**
 * Filters a property bag down to what may be transmitted.
 *
 * Runs at two boundaries, with different strictness on purpose. At the AUTHORING
 * boundary (`track`) it is strict in dev builds, so a call site that would leak
 * fails the author's test run rather than a user's privacy. At the EGRESS
 * boundary (the sender) it is always lenient, because by then dropping one
 * field beats dropping the event — and because VS Code's own telemetry cleaner
 * has run in between and may have rewritten a value into a form this would
 * otherwise reject.
 */
export function sanitizeProps(
	raw: Record<string, unknown>,
	strict: boolean = defaultStrict,
): Record<string, SafeValue> {
	const reject = (key: string, why: string): void => {
		if (strict) {
			throw new Error(`telemetry: unsafe property "${key}" (${why})`);
		}
	};
	const out: Record<string, SafeValue> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (v === undefined) {
			// Optional properties left unset are normal, not a violation.
			continue;
		}
		if (!SAFE_KEY.test(k) && !POSTHOG_CONTROL.test(k)) {
			reject(k, 'key is not lowercase snake_case');
			continue;
		}
		if (typeof v === 'boolean') {
			out[k] = v;
			continue;
		}
		if (typeof v === 'number') {
			if (!Number.isFinite(v)) {
				reject(k, 'non-finite number');
				continue;
			}
			out[k] = v;
			continue;
		}
		if (typeof v === 'string') {
			if (!SAFE_TOKEN.test(v)) {
				reject(k, 'string is not a short opaque token');
				continue;
			}
			out[k] = v;
			continue;
		}
		reject(k, `unsupported type ${typeof v}`);
	}
	return out;
}

/**
 * The error taxonomy. The first three are exactly `HarnessInfraKind` from
 * harnessRunner, reused rather than re-invented so a harness failure and a
 * generic failure land in the same bucket and stay comparable.
 */
export type ErrorClass =
	| 'auth'
	| 'quota'
	| 'network'
	| 'enoent'
	| 'eacces'
	| 'eperm'
	| 'ebusy'
	| 'timeout'
	| 'cancelled'
	| 'parse'
	| 'spawn'
	| 'disk'
	| 'oom'
	| 'other';

/** Node errno → class. Checked first: a `code` is authoritative where a message is a guess. */
const ERRNO: Readonly<Record<string, ErrorClass>> = {
	ENOENT: 'enoent',
	EACCES: 'eacces',
	EPERM: 'eperm',
	EBUSY: 'ebusy',
	ETIMEDOUT: 'timeout',
	ENOSPC: 'disk',
	EDQUOT: 'disk',
	ENOMEM: 'oom',
	ENOTFOUND: 'network',
	ECONNREFUSED: 'network',
	ECONNRESET: 'network',
	EAI_AGAIN: 'network',
	EHOSTUNREACH: 'network',
	ENETUNREACH: 'network',
	EPIPE: 'spawn',
};

/**
 * Message fingerprints, applied only when there is no errno. Ordered: the first
 * match wins, so the specific precedes the generic.
 */
const MESSAGE_PATTERNS: ReadonlyArray<readonly [RegExp, ErrorClass]> = [
	[/\b(?:401|403)\b|unauthorized|not authenticated|invalid api key|please run \/login/i, 'auth'],
	[/quota|credit balance|usage limit|rate.?limit|RESOURCE_EXHAUSTED/i, 'quota'],
	[/getaddrinfo|network is unreachable|fetch failed|failed to connect/i, 'network'],
	[/\btimed? ?out\b|deadline exceeded/i, 'timeout'],
	[/\bcancell?ed\b|\baborted\b/i, 'cancelled'],
	[/unexpected token|JSON|cannot parse|malformed|SyntaxError/i, 'parse'],
	[/spawn|ENOEXEC|exited with code/i, 'spawn'],
	[/no space left|disk full/i, 'disk'],
	[/out of memory|heap out of memory/i, 'oom'],
];

/**
 * Buckets any thrown value into one class. Total: an unrecognised error is
 * 'other', never an exception, because this runs inside `catch` blocks whose
 * whole job is to not make things worse.
 */
export function classifyError(e: unknown): ErrorClass {
	const code = (e as { code?: unknown } | null)?.code;
	if (typeof code === 'string') {
		const byErrno = ERRNO[code.toUpperCase()];
		if (byErrno) {
			return byErrno;
		}
	}
	const message = errorMessage(e);
	if (!message) {
		return 'other';
	}
	for (const [re, kind] of MESSAGE_PATTERNS) {
		if (re.test(message)) {
			return kind;
		}
	}
	return 'other';
}

/** The message text, for local classification only. NEVER a property value. */
function errorMessage(e: unknown): string {
	if (typeof e === 'string') {
		return e;
	}
	const m = (e as { message?: unknown } | null)?.message;
	return typeof m === 'string' ? m : '';
}

/**
 * Salt for message digests. A BUILD constant, deliberately NOT the machine id:
 * salting per user would give every install a different digest for the same
 * bug, which is exactly the grouping the digest exists to provide.
 */
const DIGEST_SALT = 'vinv-telemetry-v1';

/**
 * A short one-way fingerprint of an error message.
 *
 * This is how error telemetry stays useful without transmitting text: two users
 * hitting the same bug report the same digest, so it is countable and
 * rankable, while the message it was computed from never leaves the machine and
 * cannot be recovered from the digest.
 *
 * Normalised first, so incidental variation (a pid, a port, a path, a hex
 * address) does not split one bug into a hundred digests.
 */
export function messageDigest(message: string): string {
	if (!message) {
		return 'none';
	}
	const normalised = message
		.toLowerCase()
		.replace(/[a-z]:\\[^\s'"]*|\/[^\s'"]{2,}/g, '<path>')
		.replace(/0x[0-9a-f]+/g, '<addr>')
		.replace(/\b\d+\b/g, '<n>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
	// FNV-1a, 32-bit, twice over with different offsets — enough spread for
	// grouping and small enough to read in a PostHog table. No crypto import:
	// this is a grouping key, not a security primitive.
	return `${fnv1a(DIGEST_SALT + normalised, 0x811c9dc5)}${fnv1a(normalised + DIGEST_SALT, 0x01000193)}`;
}

function fnv1a(input: string, offset: number): string {
	let hash = offset >>> 0;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * Coerces an untrusted string to a member of a closed set, or 'other'.
 *
 * The escape hatch for values that are technically short and token-shaped but
 * semantically unbounded — the clearest case being `ServiceEntry.kind`, which is
 * produced by an LLM and would sail through SAFE_TOKEN while contributing
 * unbounded cardinality. Anything not explicitly enumerated becomes 'other'.
 */
export function allowlist<T extends string>(
	value: string | undefined,
	allowed: ReadonlyArray<T>,
): T | 'other' {
	const v = (value ?? '').trim().toLowerCase();
	return (allowed as ReadonlyArray<string>).includes(v) ? (v as T) : 'other';
}

/**
 * Rounds a duration into a coarse bucket.
 *
 * Not for privacy — for cardinality and for honesty about precision. Exact
 * millisecond durations make every event unique and invite reading noise as
 * signal; what the funnel actually needs is "seconds or minutes".
 */
export function bucketMs(ms: number): number {
	if (!Number.isFinite(ms) || ms < 0) {
		return -1;
	}
	if (ms < 1000) {
		return Math.round(ms / 100) * 100;
	}
	if (ms < 60_000) {
		return Math.round(ms / 1000) * 1000;
	}
	if (ms < 3_600_000) {
		return Math.round(ms / 30_000) * 30_000;
	}
	return Math.round(ms / 600_000) * 600_000;
}

/** Coarse count bucket, for the same reason as bucketMs. */
export function bucketCount(n: number): number {
	if (!Number.isFinite(n) || n < 0) {
		return -1;
	}
	if (n <= 10) {
		return Math.round(n);
	}
	if (n <= 100) {
		return Math.round(n / 10) * 10;
	}
	if (n <= 1000) {
		return Math.round(n / 100) * 100;
	}
	return Math.round(n / 1000) * 1000;
}
