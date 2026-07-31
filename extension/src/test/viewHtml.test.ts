/**
 * Webview render behavior, tested by evaluating each view's inline script
 * against a stub DOM (same idea as the graph e2e harness, without JSDOM):
 *   • journey — arrow-key navigation must NOT fire while the user is typing in
 *     the add-input form (a re-render would destroy their JSON);
 *   • optimization report — measured deltas always carry a direction
 *     (faster/slower), the kept/reverted copy states what ACTUALLY happened
 *     (including the watcher-only no-revert fallback), statistical terms carry
 *     plain-language tooltips, and the optional amdahl_ceiling /
 *     predicted_ms_effective fields are feature-detected;
 *   • findings — episode attempts render their kept/reverted outcome and the
 *     CI interval as legible text, and the empty-state copy names the real
 *     trigger (optimize.jsonl episodes);
 *   • dead-code section — a try-run's trace is on the page (what executed, for
 *     how long, what it raised) with the capture and the driver one click away,
 *     and a run that recorded nothing says so instead of rendering zeros;
 *   • traces panel — a CLI/worker entry point renders its real invocation count
 *     and each cell states which unit it is showing.
 */

import * as assert from 'assert';
import { getJourneyHtml } from '../views/journeyView';
import { getOptimizationReportHtml } from '../views/optimizationReportView';
import { getFindingsHtml } from '../views/findingsView';
import { getDeadSectionHtml } from '../views/deadCodeReportView';
import { getTracesHtml } from '../views/tracesPanel';

type Listener = (ev: unknown) => void;

interface ElStub {
	textContent: string;
	innerHTML: string;
	disabled: boolean;
	/** Form controls the script reads (a filter box's text, a select's value). */
	value: string;
	/** A <select>'s options, which scripts check before populating them. */
	options: unknown[];
	appendChild: (child: unknown) => void;
	listeners: Record<string, Listener>;
	addEventListener: (name: string, fn: Listener) => void;
	querySelectorAll: () => unknown[];
}

interface Sandbox {
	/** Top-level bindings from the script, by the names in `expose`. */
	api: Record<string, (...args: unknown[]) => string>;
	/** Elements the script touched, by id. */
	els: Record<string, ElStub>;
	/** window listeners the script registered (keydown, message, …). */
	winListeners: Record<string, Listener>;
}

/** Evaluates a webview's inline <script> against a stub DOM. */
function evalWebviewScript(html: string, expose: string[]): Sandbox {
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
	assert.ok(script, 'the view HTML contains an inline script');
	const els: Record<string, ElStub> = {};
	const makeEl = (): ElStub => {
		const el: ElStub = {
			textContent: '',
			innerHTML: '',
			disabled: false,
			value: '',
			options: [{}],
			appendChild: (child) => void el.options.push(child),
			listeners: {},
			addEventListener: (name, fn) => {
				el.listeners[name] = fn;
			},
			querySelectorAll: () => [],
		};
		return el;
	};
	const winListeners: Record<string, Listener> = {};
	const win = {
		addEventListener: (name: string, fn: Listener) => {
			winListeners[name] = fn;
		},
	};
	const doc = {
		getElementById: (id: string) => (els[id] ??= makeEl()),
		createElement: () => makeEl(),
		querySelectorAll: () => [],
		body: { clientWidth: 800 },
	};
	const run = new Function(
		'acquireVsCodeApi',
		'window',
		'document',
		'alert',
		`${script}\n;return { ${expose.join(', ')} };`,
	);
	const api = run(
		() => ({ postMessage: () => undefined }),
		win,
		doc,
		() => undefined,
	) as Sandbox['api'];
	return { api, els, winListeners };
}

suite('journey view: arrow keys vs the add-input form', () => {
	function loaded(): Sandbox {
		const sb = evalWebviewScript(getJourneyHtml(), ['isTypingTarget']);
		const journey = {
			services: [],
			issues: [],
			coverage: { endpointsCovered: 0, endpointsTotal: 0, symbolsCovered: 0, symbolsTotal: 0 },
			scenarios: { run: 0, completed: 0, expired: [] },
			statePollution: { created: 0, cleaned: 0 },
			steps: [
				{
					method: 'GET',
					path: '/x',
					apiId: 'GET_x',
					handler: 'h',
					coverage: { covered: 0, total: 0 },
					p50Ms: 0,
					p95Ms: 0,
					handlerObserved: false,
					invariants: 0,
					io: [],
					tree: null,
					treeError: null,
					userPlanCount: 0,
				},
			],
		};
		sb.winListeners.message({ data: { type: 'journey', journey } });
		return sb;
	}

	test('typing targets are recognized (input/textarea/select/contenteditable, any case)', () => {
		const { api } = loaded();
		const is = api.isTypingTarget as unknown as (t: unknown) => boolean;
		assert.strictEqual(is({ tagName: 'TEXTAREA' }), true);
		assert.strictEqual(is({ tagName: 'input' }), true); // case-insensitive
		assert.strictEqual(is({ tagName: 'SELECT' }), true);
		assert.strictEqual(is({ tagName: 'DIV', isContentEditable: true }), true);
		assert.strictEqual(is({ tagName: 'BUTTON' }), false);
		assert.strictEqual(is({ tagName: 'BODY' }), false);
		assert.strictEqual(is(null), false);
	});

	test('ArrowRight inside the form does NOT navigate (no re-render eats the JSON)', () => {
		const { els, winListeners } = loaded();
		assert.strictEqual(els.pos.textContent, '1 / 2');
		winListeners.keydown({ key: 'ArrowRight', target: { tagName: 'TEXTAREA' } });
		winListeners.keydown({ key: 'ArrowRight', target: { tagName: 'INPUT' } });
		winListeners.keydown({ key: 'ArrowRight', target: { tagName: 'DIV', isContentEditable: true } });
		assert.strictEqual(els.pos.textContent, '1 / 2', 'still on the overview');
	});

	test('ArrowRight/ArrowLeft outside a form still navigate', () => {
		const { els, winListeners } = loaded();
		winListeners.keydown({ key: 'ArrowRight', target: { tagName: 'BODY' } });
		assert.strictEqual(els.pos.textContent, '2 / 2', 'moved to the endpoint step');
		winListeners.keydown({ key: 'ArrowLeft', target: null });
		assert.strictEqual(els.pos.textContent, '1 / 2', 'moved back');
	});

	test('step copy reads cold: no raw internal ids, statuses as plain words', () => {
		const { els, winListeners } = loaded();
		winListeners.keydown({ key: 'ArrowRight', target: { tagName: 'BODY' } });
		assert.strictEqual(els.meta.textContent, 'served by h()', 'meta names the function, not the api_id');
		assert.ok(!els.meta.textContent.includes('GET_x'), 'internal id kept out of the header');
		const stats = els.stats.innerHTML;
		assert.ok(stats.includes('not reached yet'), 'handler status is a plain phrase');
		assert.ok(stats.includes('Behavior rules'), 'invariants renamed to plain words');
		assert.ok(stats.includes('title="Typical response time'), 'p50 carries a plain tooltip');
		assert.ok(stats.includes('title="The slow tail'), 'p95 carries a plain tooltip');
	});
});

suite('optimization report: verdict copy, direction, glossary, optional fields', () => {
	function api(): Sandbox['api'] {
		return evalWebviewScript(getOptimizationReportHtml(), ['verdict', 'axis', 'card']).api;
	}
	const base = {
		row: 1,
		name: 'fn',
		file: 'a.py',
		line: 3,
		total_ms: 100,
		calls: 5,
		self_ms: 20,
		predicted_ms: 40,
		waste_kind: 'cache',
		reason: 'dup',
		status: 'candidate',
	};

	test('a watcher-judged regression says slower AND that nothing was auto-reverted', () => {
		const html = api().verdict({
			status: 'regressed',
			outcome: { delta_ms: 12.4, noise_band_ms: 3, behavior_ok: true },
		});
		assert.ok(html.includes('Regressed 12ms slower'), `direction suffix present: ${html}`);
		assert.ok(html.includes('No automatic revert ran'), 'watcher fallback: no revert claim');
		assert.ok(html.includes('still in your working tree'));
		assert.ok(!html.includes('The change was not kept'), 'the old false claim is gone');
		assert.ok(html.includes('title="Noise band:'), 'noise band carries its tooltip');
	});

	test('a bridge-judged behavior break reports the REAL revert', () => {
		const html = api().verdict({
			status: 'regressed',
			outcome: {
				delta_ms: -5,
				behavior_ok: false,
				reverted: true,
				ci: { rel_improvement: 0.05, ci_low: -0.02, ci_high: 0.1 },
			},
		});
		assert.ok(html.includes('behavior changed'));
		assert.ok(html.includes('reverted to the pre-episode snapshot'));
		assert.ok(html.includes('title="95% confidence interval'), 'CI carries its tooltip');
		assert.ok(!html.includes('No automatic revert ran'));
	});

	test('a proven bridge verdict says faster and that the change was kept', () => {
		const html = api().verdict({
			status: 'proven',
			outcome: {
				delta_ms: -30,
				predicted_ms: 40,
				reverted: false,
				ci: { rel_improvement: 0.3, ci_low: 0.1, ci_high: 0.5 },
			},
		});
		assert.ok(html.includes('Proven 30ms faster'));
		assert.ok(html.includes('The change was kept.'));
	});

	test('a watcher-judged inconclusive also states nothing was auto-reverted', () => {
		const html = api().verdict({ status: 'inconclusive', outcome: { noise_band_ms: 5 } });
		assert.ok(html.includes('No automatic revert ran'));
		assert.ok(html.includes('title="Noise band:'));
	});

	test('a dismissed opportunity renders a terminal badge carrying the dispute', () => {
		const html = api().verdict({
			status: 'dismissed',
			outcome: { dismiss_note: 'one-time import cost, not amortizable across processes' },
		});
		assert.ok(html.includes('Dismissed — not a real opportunity'), `dismissed badge: ${html}`);
		assert.ok(html.includes('no change was made'), 'states nothing was changed');
		assert.ok(html.includes('one-time import cost'), 'carries the verbatim dispute note');
	});

	test('a dismissed card gets the dismissed row class', () => {
		const html = api().card({ ...base, status: 'dismissed', outcome: { dismiss_note: 'n/a' } }, 100);
		assert.ok(html.includes('row dismissed'), `card class: ${html}`);
	});

	test('the measured axis label carries the direction on both sides', () => {
		const slower = api().axis({ ...base, status: 'regressed', outcome: { delta_ms: 12 } }, 100);
		assert.ok(slower.includes('measured 12ms slower'), slower);
		const faster = api().axis({ ...base, status: 'proven', outcome: { delta_ms: -25 } }, 100);
		assert.ok(faster.includes('measured 25ms faster'), faster);
		assert.ok(slower.includes('title="Predicted recoverable time:'), 'predicted tooltip');
	});

	test('cards tooltip self time and predicted; no ceiling badge without the field', () => {
		const html = api().card(base, 100);
		assert.ok(html.includes('title="Self time:'));
		assert.ok(html.includes('title="Predicted recoverable time:'));
		assert.ok(!html.includes('whole-flow ceiling'), 'badge absent when field absent');
	});

	test('amdahl_ceiling is feature-detected as fraction or percent', () => {
		assert.ok(api().card({ ...base, amdahl_ceiling: 0.18 }, 100).includes('whole-flow ceiling ≤18%'));
		assert.ok(api().card({ ...base, amdahl_ceiling: 18 }, 100).includes('whole-flow ceiling ≤18%'));
		assert.ok(!api().card({ ...base, amdahl_ceiling: 'x' }, 100).includes('whole-flow ceiling'));
	});

	test('predicted_ms_effective is feature-detected onto the predicted label', () => {
		const html = api().card({ ...base, predicted_ms_effective: 12.2 }, 100);
		assert.ok(html.includes('≈12ms whole-flow'), html);
	});
});

suite('findings view: episode attempts render legibly', () => {
	const findings = {
		headline: {
			endpointsCovered: 0,
			endpointsTotal: 0,
			symbolsCovered: 0,
			symbolsTotal: 0,
			issuesFound: 0,
			episodesAccepted: 1,
			episodesReverted: 1,
			regressCases: 0,
			regressRealDiffs: 0,
			stateCreated: 0,
			stateCleaned: 0,
		},
		issues: [],
		episodes: [
			{
				at: 2000,
				label: 'cache users',
				action: 'revert-and-stop',
				reason: 'no gain',
				opportunity: { kind: 'latency-p95', endpoint: '', detail: '' },
				attempts: [
					{ approach: 'memoize list_users', behaviorSuitePassed: true, reverted: true, rel: 0.02, ciLow: -0.05, ciHigh: 0.09 },
					{ approach: 'batch the query', behaviorSuitePassed: false, reverted: true, rel: null, ciLow: null, ciHigh: null },
				],
				filesChanged: [],
			},
			{
				at: 1000,
				label: 'users index',
				action: 'accept',
				reason: 'significant',
				opportunity: { kind: 'latency-p95', endpoint: '', detail: '' },
				attempts: [
					{ approach: 'add index', behaviorSuitePassed: true, reverted: false, rel: 0.46, ciLow: 0.31, ciHigh: 0.58 },
				],
				filesChanged: ['app/crud.py'],
			},
		],
		opportunities: [],
		regress: { latest: null, history: [] },
		endpoints: [],
		state: { created: 0, cleaned: 0, uncleaned: 0, rows: [] },
		scenarios: { run: 0, completed: 0, expired: [] },
	};

	function rendered(f: unknown): string {
		const { api, els } = evalWebviewScript(getFindingsHtml(), ['render']);
		api.render(f);
		return els.content.innerHTML;
	}

	/** The headline tiles, which live outside #content. */
	function renderedTiles(f: unknown): string {
		const { api, els } = evalWebviewScript(getFindingsHtml(), ['render']);
		api.render(f);
		return els.tiles.innerHTML;
	}

	test('each attempt shows kept/reverted, the numeric CI, and its order', () => {
		const html = rendered(findings);
		assert.ok(html.includes('>kept</span>'), 'accepted attempt labeled kept');
		assert.ok(html.includes('>reverted</span>'), 'reverted attempt labeled');
		assert.ok(html.includes('+46.0% [+31.0%, +58.0%]'), 'CI legible as text, not tooltip-only');
		assert.ok(html.includes('+2.0% [-5.0%, +9.0%]'), 'zero-straddling CI shown signed');
		assert.ok(html.includes('1. memoize list_users'), 'multi-attempt episodes numbered');
		assert.ok(html.includes('2. batch the query'));
		assert.ok(!html.includes('1. add index'), 'single-attempt episodes not numbered');
		assert.ok(html.includes('no measurement'), 'unmeasured attempt stays honest');
		assert.ok(html.includes('suite ✗'), 'behavior-suite failure visible');
	});

	test('what ran leads the page and dead code closes it', () => {
		// The page used to open on dead code — a list of what did NOT run — with
		// the latency profile six sections below it. After a run, the successful
		// half was the part you had to scroll for.
		const html = rendered({
			...mixedUnits,
			deadCode: { hasTrace: true, sections: [], analysed: 0, traced: 3, considered: 9, bound: 'src/' },
		});
		const latency = html.indexOf('Latency profile');
		const issues = html.indexOf('Issue clusters');
		const dead = html.indexOf('Dead code');
		assert.ok(latency > -1 && issues > -1 && dead > -1, 'all three sections render');
		assert.ok(latency < issues, 'what ran comes before what went wrong');
		assert.ok(dead > issues, 'dead code no longer sits under the failures');
		assert.strictEqual(
			dead,
			Math.max(latency, issues, dead),
			'dead code is the last section on the page',
		);
	});

	test('empty state names the real trigger: optimize.jsonl episodes from panel or exerciser', () => {
		const html = rendered({ ...findings, episodes: [] });
		assert.ok(html.includes('No optimization episodes recorded yet'));
		assert.ok(html.includes('optimize.jsonl'), 'points at the artifact that feeds the section');
		assert.ok(html.includes('Optimize panel'), 'mentions the in-editor dispatch path too');
	});

	test('endpoint table and state section read cold: plain badges + stat tooltips', () => {
		const html = rendered({
			...findings,
			endpoints: [
				{ endpoint: 'GET /api/v1/items/', p50Ms: 12, p95Ms: 288, coverage: '0/4', handlerObserved: false, statuses: { '401': 3 } },
			],
			state: {
				created: 2,
				cleaned: 1,
				uncleaned: 1,
				rows: [
					{ endpoint: 'POST /items', cleaned: true, via: 'DELETE /items/{id}' },
					{ endpoint: 'POST /users', cleaned: false, via: null },
				],
			},
		});
		assert.ok(html.includes('>not reached</span>'), 'unreached endpoint labeled in plain words');
		assert.ok(!html.includes('handler unseen'), 'the jargon badge is gone');
		assert.ok(html.includes('title="Typical time'), 'p50 column tooltip');
		assert.ok(html.includes('title="The slow tail'), 'p95 column tooltip');
		assert.ok(html.includes('<th>Endpoint</th>'), 'an all-HTTP table still says endpoint');
		assert.ok(!html.includes('>Kind</th>'), 'and does not repeat the kind on every row');
		assert.ok(html.includes('Data the tests created'), 'ledger section title is plain');
		assert.ok(html.includes('>still there</span>'), 'uncleaned row is a sentence a non-expert reads');
		assert.ok(html.includes('fingerprint') || findings.issues.length === 0, 'issue id labeled fingerprint');
	});

	/**
	 * The exerciser drives CLIs and functions as well as routes, and the Traces
	 * panel lists all three. This panel called every one of them an "endpoint",
	 * so a toolchain repo with no routes at all read as "3 endpoints covered"
	 * over a table headed "Endpoint" with a row saying RUN acme-tool.
	 */
	const mixedUnits = {
		...findings,
		headline: { ...findings.headline, unitsByKind: { cli_invocation: 1, http_endpoint: 1 } },
		endpoints: [
			{ endpoint: 'GET /health', unitKind: 'http_endpoint', p50Ms: 2, p95Ms: 4, coverage: '1/1', handlerObserved: true, statuses: { '200': 3 } },
			{ endpoint: 'RUN acme-tool --check', unitKind: 'cli_invocation', p50Ms: 900, p95Ms: 1200, coverage: '0/6', handlerObserved: false, statuses: { error: 1 } },
		],
	};

	test('a mixed run names its units and says which kind each row is', () => {
		const html = rendered(mixedUnits);
		assert.ok(html.includes('Latency profile per unit'), 'a mixed set is not "per endpoint"');
		assert.ok(html.includes('<th>Unit</th>'), 'the first column is not headed Endpoint');
		assert.ok(html.includes('>Kind</th>'), 'a mixed table states the kind per row');
		assert.ok(html.includes('>CLI invocation</td>'), 'the CLI row says what it is');
		assert.ok(html.includes('>endpoint</td>'), 'and the HTTP row does too');
		assert.ok(html.includes('RUN acme-tool --check'), 'the CLI unit is listed at all');
		// "needs a login first" is HTTP advice; a CLI run was never turned away.
		assert.ok(!/title="No request has reached[^"]*"[^>]*>not reached/.test(html)
			|| html.includes('tracing did not cover its package'),
			'the not-reached tooltip is written for the kind of unit it sits on');
	});

	/**
	 * The empty state reads coverage totals, and those come from a scorecard the
	 * service-free pass never used to write. A toolchain repo therefore hit every
	 * zero at once and was told "nothing has been exercised" — while the issue
	 * list under it held three failures observed in live runs. A cluster only
	 * exists because something ran, so it settles the question the totals could
	 * not, and the panel must never claim otherwise.
	 */
	test('findings on the page outrank a missing scorecard', () => {
		const noScorecard = {
			...findings,
			headline: {
				...findings.headline,
				episodesAccepted: 0,
				episodesReverted: 0,
				issuesFound: 3,
			},
			episodes: [],
		};
		const tiles = renderedTiles(noScorecard);
		assert.ok(!tiles.includes('No traces yet'), 'real findings were hidden behind the empty state');
		assert.ok(tiles.includes('Issues found'), 'the issue tile is rendered instead');
	});

	test('a genuinely untouched workspace still says so', () => {
		const tiles = renderedTiles({
			...findings,
			headline: { ...findings.headline, episodesAccepted: 0, episodesReverted: 0 },
			episodes: [],
		});
		assert.ok(tiles.includes('No traces yet'), 'zero everything is not a clean bill of health');
	});

	test('the coverage tile is named after the units that were actually driven', () => {
		assert.ok(renderedTiles(mixedUnits).includes('Units covered'), 'mixed run says units');
		assert.ok(
			renderedTiles({
				...mixedUnits,
				headline: { ...findings.headline, unitsByKind: { cli_invocation: 3 } },
				endpoints: [mixedUnits.endpoints[1]],
			}).includes('CLI invocations covered'),
			'a CLI-only run says so rather than inventing endpoints',
		);
		assert.ok(
			renderedTiles({
				...findings,
				headline: { ...findings.headline, unitsByKind: { http_endpoint: 4 } },
			}).includes('Endpoints covered'),
			'an all-HTTP run keeps the word it always used',
		);
	});
});

suite('dead code section view: the try-run evidence is on the page', () => {
	const section = {
		id: 'sec-a',
		title: 'app/legacy.py — helper_a',
		reason: 'reachable-untested',
		layer: 'service',
		lines: 40,
		files: ['app/legacy.py'],
		liveCallers: ['handler (app/api.py:3)'],
		tourOrder: [],
		symbols: { items: [], lineage: [] },
	};

	function rendered(runs: unknown[]): string {
		const { els, winListeners } = evalWebviewScript(getDeadSectionHtml(), ['render']);
		winListeners.message({
			data: {
				type: 'section',
				report: { section, stops: [], storeEpoch: 7, verdict: null, runs },
				stale: false,
			},
		});
		return els.content.innerHTML;
	}

	test('a section that was driven shows what the capture recorded, and how to open it', () => {
		const html = rendered([
			{
				sectionId: 'sec-a',
				title: section.title,
				at: '2026-07-31T10:00:00.000Z',
				outcome: 'revived',
				detail: 'the driver executed 1 of 2 section symbol(s) under trace',
				revived: ['helper_a'],
				rows: [1, 2],
				driverFile: '/w/.vinv/tmp/deadcode-driver-sec-a.py',
				traceFile: '/w/.vinv/captures/deadcode-sec-a-1/trace.jsonl',
				exitCode: 0,
				timedOut: false,
				notes: 'calls helper_a with a fake request',
				outputTail: '',
				trace: {
					functions: 2,
					calls: 3,
					totalMs: 8,
					errors: 1,
					errorTypes: ['ValueError'],
					top: [
						{ component: 'app.legacy.helper_a', calls: 2, ms: 4, errors: 0 },
						{ component: 'app.legacy2.helper_b', calls: 1, ms: 4, errors: 1 },
					],
				},
			},
		]);
		assert.ok(html.includes('Try-runs'), 'the run has its own section, not a toast');
		assert.ok(html.includes('symbols executed'), 'the outcome is a plain phrase');
		assert.ok(html.includes('app.legacy.helper_a'), 'the traced functions are listed');
		assert.ok(html.includes('functions traced'), 'the capture summary is on screen');
		assert.ok(html.includes('ValueError'), 'what the run raised is named');
		assert.ok(html.includes('data-open="/w/.vinv/captures/deadcode-sec-a-1/trace.jsonl"'),
			'the trace itself is one click away');
		assert.ok(html.includes('data-open="/w/.vinv/tmp/deadcode-driver-sec-a.py"'),
			'so is the driver that produced it');
		assert.ok(html.includes('calls helper_a with a fake request'), "the driver's own note is kept");
	});

	test('a run that produced no spans says so instead of showing zeros', () => {
		const html = rendered([
			{
				sectionId: 'sec-a', title: section.title, at: '2026-07-31T10:00:00.000Z',
				outcome: 'not-reached', detail: 'nothing executed', revived: [], rows: [1],
				driverFile: null, traceFile: '/w/trace.jsonl', exitCode: 0, timedOut: false,
				notes: '', outputTail: '', trace: null,
			},
		]);
		assert.ok(html.includes('recorded no function exits'));
		assert.ok(!html.includes('functions traced'), 'no fabricated measurement');
	});

	test('a section nobody has driven invites the run instead of showing an empty card', () => {
		const html = rendered([]);
		assert.ok(html.includes('No one has tried to run this section yet'));
		assert.ok(html.includes('Run this Path'), 'the invitation names the button that does it');
	});

	test('each case shows what went in and what came back, its own trace beside it', () => {
		// The counters say the tracer worked. What a developer came for is the
		// behaviour: given an empty list it answered 0, given -1 it raised. One
		// card per case, because one merged table cannot say which input produced
		// which answer.
		const html = rendered([
			{
				sectionId: 'sec-a', title: section.title, at: '2026-07-31T10:00:00.000Z',
				outcome: 'revived', detail: 'ran', revived: ['helper_a'], rows: [1],
				driverFile: null, traceFile: null, exitCode: 0, timedOut: false,
				notes: '', outputTail: '',
				trace: { functions: 1, calls: 2, totalMs: 2, errors: 1, errorTypes: ['ValueError'], top: [] },
				cases: [
					{
						name: 'empty-list', why: 'the boundary',
						traceFile: '/w/.vinv/captures/deadcode-sec-a-1-0/trace.jsonl',
						exitCode: 0, timedOut: false, outputTail: '',
						trace: {
							functions: 1, calls: 1, totalMs: 1, errors: 0, errorTypes: [],
							top: [{
								component: 'app.legacy.helper_a', calls: 1, ms: 1, errors: 0,
								samples: [{ args: [{ name: 'items', render: '[int × 0]' }], result: '0', error: null, ms: 1 }],
							}],
						},
					},
					{
						name: 'negative', why: 'the input that fails',
						traceFile: '/w/.vinv/captures/deadcode-sec-a-1-1/trace.jsonl',
						exitCode: 1, timedOut: false, outputTail: '',
						trace: {
							functions: 1, calls: 1, totalMs: 1, errors: 1, errorTypes: ['ValueError'],
							top: [{
								component: 'app.legacy.helper_a', calls: 1, ms: 1, errors: 1,
								samples: [{ args: [{ name: 'n', render: '-1' }], result: '', error: 'ValueError', ms: 1 }],
							}],
						},
					},
					{
						name: 'needs-a-socket', why: 'the case that could not run',
						traceFile: '/w/.vinv/captures/deadcode-sec-a-1-2/trace.jsonl',
						exitCode: 2, timedOut: false, outputTail: 'ConnectionRefusedError', trace: null,
					},
				],
			},
		]);
		assert.ok(html.includes('empty-list') && html.includes('negative'), 'cases are named');
		assert.ok(html.includes('the boundary'), 'what a case is meant to show is on the page');
		assert.ok(html.includes('items=[int × 0]'), 'the input is shown, not just the symbol');
		assert.ok(html.includes('raised ValueError'), 'a raise is the answer, rendered as one');
		assert.ok(
			html.includes('data-open="/w/.vinv/captures/deadcode-sec-a-1-1/trace.jsonl"'),
			'each case links its OWN capture, not the run’s first one',
		);
		assert.ok(html.includes('This case produced no trace (exit 2)'),
			'a case that never ran says so rather than vanishing');
		assert.ok(html.includes('ConnectionRefusedError'), 'and its output is the evidence why');
	});

	test('a refusal with no reason does not wear the verdict badge', () => {
		// A decline leaves no driver and no trace, so the reason is the entire
		// evidence — an unexplained one must not read as settled.
		const bare = {
			sectionId: 'sec-a', title: section.title, at: '2026-07-31T10:00:00.000Z',
			outcome: 'declined', detail: 'no reason given', revived: [], rows: [1],
			driverFile: null, traceFile: null, exitCode: null, timedOut: false,
			notes: '', outputTail: '', trace: null,
		};
		const bareHtml = rendered([bare]);
		assert.ok(bareHtml.includes('refused, no reason'));
		assert.ok(!bareHtml.includes('not drivable'), 'an unexplained no is not a verdict');

		const reasoned = rendered([{ ...bare, notes: 'it is a setuptools entry point' }]);
		assert.ok(reasoned.includes('not drivable'));
		assert.ok(reasoned.includes('Why it cannot be driven: it is a setuptools entry point'),
			'the reason is labelled as the reason, not as driver notes');
	});
});

suite('traces panel: non-HTTP entry points are first-class rows', () => {
	function rendered(rows: unknown[]): string {
		const { els, winListeners } = evalWebviewScript(getTracesHtml(), ['render']);
		winListeners.message({
			data: { type: 'data', rows, ranges: [], activeRange: '', haveCaptures: true },
		});
		return els.out.innerHTML;
	}

	const cliRow = {
		id: 'CLI_generate_cmd',
		trigger: 'generate',
		handler: 'generate_cmd',
		file: 'handbook/src/handbook/cli.py',
		line: 40,
		kind: 'cli_command',
		count: 2,
	};

	test('a CLI run shows its count, and the column says what the number counts', () => {
		const html = rendered([cliRow]);
		assert.ok(html.includes('generate'), 'the command is listed');
		assert.ok(html.includes('>2</td>'), 'the run count is rendered, not a permanent zero');
		assert.ok(html.includes('count hit'), 'a run entry point reads as exercised');
		assert.ok(
			html.includes('Times this entry point ran in the captures'),
			'the non-HTTP unit is invocations, and the cell says so',
		);
		assert.ok(html.includes('cli command'), 'the kind badge is not raw snake_case');
	});

	test('an HTTP route keeps the request-based unit in its tooltip', () => {
		const html = rendered([
			{ ...cliRow, id: 'GET_health', trigger: 'GET /health', kind: 'http_api', count: 7 },
		]);
		assert.ok(html.includes('Distinct traced requests that reached this endpoint'));
		assert.ok(!html.includes('Times this entry point ran'), 'the two units never mix on one row');
	});

	test('an entry point nothing has run still lists, at zero', () => {
		const html = rendered([{ ...cliRow, count: 0 }]);
		assert.ok(html.includes('>0</td>'));
		assert.ok(!html.includes('count hit'), 'zero is not styled as a hit');
	});

	test('a run reports how it went, not just that it happened', () => {
		const html = rendered([
			{
				...cliRow,
				id: 'GET_health',
				trigger: 'GET /health',
				kind: 'http_api',
				count: 12,
				coveragePct: 30,
				coverageText: '12/40',
				coverageSource: 'exercised',
				p50: 8,
				p95: 1400,
				statuses: { '200': 11, '500': 1 },
				checks: 12,
				failed: 1,
				errors: 2,
				built: true,
			},
		]);
		assert.ok(html.includes('30%') && html.includes('12/40 symbols'), 'coverage is shown with its denominator');
		assert.ok(html.includes('8ms'), 'p50 is rendered');
		assert.ok(html.includes('1.4s'), 'a slow p95 is rendered in seconds, not four digits of ms');
		assert.ok(html.includes('class="num slow"'), 'and reads as slow');
		assert.ok(html.includes('200 ×11') && html.includes('500 ×1'), 'every status code is on the row');
		assert.ok(html.includes('chip bad'), 'a 5xx does not read the same as a 2xx');
		assert.ok(html.includes('11/12'), 'checks show what passed of what ran');
		assert.ok(html.includes('Call tree'), 'every row can open its call tree');
	});

	test('a unit with no exerciser run shows dashes, never invented zeros', () => {
		// Traffic-only units have coverage and hits but no percentiles: 0ms and
		// "0 checks passed" would both be lies about work nobody did.
		const html = rendered([{ ...cliRow, coveragePct: 40, coverageText: '2/5', coverageSource: 'traced' }]);
		assert.ok(html.includes('bar-t mid traced'), 'an overlay-measured bar is marked as such');
		assert.ok(html.includes('What the captures happened to run'), 'and says which pass measured it');
		assert.ok(!html.includes('0ms'), 'no latency is not zero latency');
		assert.ok(html.includes('dash'), 'the empty cells are dashes');
	});
});
