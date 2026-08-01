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
import { getDeadCodeHtml } from '../views/deadCodeView';
import { getJourneyHtml } from '../views/journeyView';
import { getOptimizationReportHtml } from '../views/optimizationReportView';
import { getFindingsHtml } from '../views/findingsView';
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
	/** Classes the script toggles — modal open/close state is read from here. */
	classes: Set<string>;
	classList: { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, on?: boolean) => void };
	/** Arbitrary data-* the script stashes on an element (button labels). */
	dataset: Record<string, string>;
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
			classes: new Set<string>(),
			classList: {
				add: (c: string) => void el.classes.add(c),
				remove: (c: string) => void el.classes.delete(c),
				toggle: (c: string, on?: boolean) => {
					const want = on ?? !el.classes.has(c);
					if (want) { el.classes.add(c); } else { el.classes.delete(c); }
				},
			},
			dataset: {},
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

	test('what ran leads the page, not what went wrong', () => {
		// The page used to open on dead code — a list of what did NOT run — with
		// the latency profile six sections below it. After a run, the successful
		// half was the part you had to scroll for. Dead code has since moved to a
		// panel of its own; the ordering rule it forced is what survives here.
		const html = rendered({
			...mixedUnits,
		});
		const latency = html.indexOf('Latency profile');
		const issues = html.indexOf('Issue clusters');
		assert.ok(latency > -1 && issues > -1, 'both sections render');
		assert.ok(latency < issues, 'what ran comes before what went wrong');
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
				p50: 8,
				p95: 1400,
				ok: 11,
				raised: 1,
				errorTypes: ['KeyError'],
				errors: 2,
				built: true,
			},
		]);
		assert.ok(html.includes('30%') && html.includes('12/40 symbols'), 'coverage is shown with its denominator');
		assert.ok(html.includes('8ms'), 'p50 is rendered');
		assert.ok(html.includes('1.4s'), 'a slow p95 is rendered in seconds, not four digits of ms');
		assert.ok(html.includes('class="num slow"'), 'and reads as slow');
		assert.ok(html.includes('ok ×11') && html.includes('raised ×1'), 'the outcome of every invocation is on the row');
		assert.ok(html.includes('chip bad') && html.includes('KeyError'), 'a raise names its exception and does not read as a success');
		assert.ok(html.includes('Call tree'), 'every row can open its call tree');
	});

	test('a unit the captures never timed shows dashes, never invented zeros', () => {
		// 0ms and "0 ok" would both be claims about measurements nobody made.
		const html = rendered([{ ...cliRow, coveragePct: 40, coverageText: '2/5' }]);
		assert.ok(html.includes('bar-t mid'), 'coverage still renders as a bar');
		assert.ok(!html.includes('0ms'), 'no latency is not zero latency');
		assert.ok(html.includes('dash'), 'the empty cells are dashes');
	});
});

suite('dead code panel: the report as a browsable surface', () => {
	function sym(name: string, file: string, line: number, extra: Record<string, unknown> = {}) {
		return { name, file, line, end: line + 4, kind: 'function', ambiguous: false, ...extra };
	}
	const scan = {
		schemaVersion: 1,
		generatedAt: '2026-08-02T09:00:00.000Z',
		files: 134,
		definitions: 1623,
		unreachable: [sym('run_worker', 'exerciser/_worker.py', 78)],
		testOnly: [sym('workdir_for', 'exerciser/envconfig.py', 300, { ambiguous: true })],
		probable: 12,
	};

	function loaded(report: unknown): ReturnType<typeof evalWebviewScript> {
		const sb = evalWebviewScript(getDeadCodeHtml(), []);
		// The stub select has no value until one is chosen; the real element
		// starts on its first option.
		sb.els.bucket = sb.els.bucket ?? ({} as never);
		sb.els.bucket.value = 'all';
		sb.els.q.value = '';
		sb.winListeners.message({ data: { type: 'report', scan: report, repo: 'vinv' } });
		return sb;
	}

	test('no report on disk says the analysis has not run, not that nothing is dead', () => {
		const { els } = loaded(null);
		assert.ok(els.detail.innerHTML.includes('Dead code analysis not done yet'), els.detail.innerHTML);
		// An empty list plus a zeroed tile row would read as a clean result.
		assert.strictEqual(els.tiles.innerHTML, '');
		assert.strictEqual(els.list.innerHTML, '');
	});

	test('the tiles count each bucket and the rows that need checking', () => {
		const { els } = loaded(scan);
		const h = els.tiles.innerHTML;
		assert.ok(h.includes('Total dead code'), h);
		assert.ok(/Bucket: unreachable[\s\S]*?1/.test(h), h);
		assert.ok(/Bucket: test-only[\s\S]*?1/.test(h), h);
		assert.ok(/Flagged ambiguous[\s\S]*?1/.test(h), h);
	});

	test('every symbol is listed with its bucket and location', () => {
		const { els } = loaded(scan);
		assert.ok(els.list.innerHTML.includes('run_worker'), els.list.innerHTML);
		assert.ok(els.list.innerHTML.includes('UNREACHABLE'));
		assert.ok(els.list.innerHTML.includes('TEST-ONLY'));
		assert.ok(els.list.innerHTML.includes('exerciser/_worker.py:78'));
		assert.ok(els.count.textContent.includes('2'), els.count.textContent);
	});

	test('the detail pane explains what the bucket means for deletion', () => {
		const { els } = loaded(scan);
		const d = els.detail.innerHTML;
		assert.ok(d.includes('run_worker'), d);
		// The caveat is the point of the pane: unreachable is safe-ish, test-only
		// takes its tests with it.
		assert.ok(d.includes('Nothing in the repository calls this'), d);
	});

	test('the bucket filter narrows the list', () => {
		const { els } = loaded(scan);
		els.bucket.value = 'testOnly';
		els.bucket.listeners.change({} as never);
		assert.ok(!els.list.innerHTML.includes('run_worker'), els.list.innerHTML);
		assert.ok(els.list.innerHTML.includes('workdir_for'));
	});

	test('search matches symbol name and file path', () => {
		const { els } = loaded(scan);
		els.q.value = 'envconfig';
		els.q.listeners.input({} as never);
		assert.ok(els.list.innerHTML.includes('workdir_for'), els.list.innerHTML);
		assert.ok(!els.list.innerHTML.includes('run_worker'));
	});

	test('an ambiguous symbol is marked in the list, not silently listed', () => {
		const { els } = loaded(scan);
		assert.ok(els.list.innerHTML.includes('name not unique'), els.list.innerHTML);
	});
});

suite('dead code panel: the two agent actions', () => {
	function sym(name: string, file: string, line: number) {
		return { name, file, line, end: line + 4, kind: 'function', ambiguous: false };
	}
	const scan = {
		schemaVersion: 1,
		generatedAt: '2026-08-02T09:00:00.000Z',
		files: 10,
		definitions: 100,
		unreachable: [sym('run_worker', 'exerciser/_worker.py', 78)],
		testOnly: [],
		probable: 0,
	};
	const key = 'exerciser/_worker.py:78:run_worker';

	function loaded(history: unknown, findings: unknown = {}) {
		const sb = evalWebviewScript(getDeadCodeHtml(), []);
		sb.els.bucket.value = 'all';
		sb.els.q.value = '';
		sb.winListeners.message({ data: { type: 'report', scan, repo: 'vinv' } });
		sb.winListeners.message({ data: { type: 'context', key, history, findings } });
		return sb;
	}
	const lost = { reason: 'lost its calls', born: '2026-07-28', commits: 2, recent: [], ambiguous: false };
	const never = { reason: 'never wired', born: '2026-07-28', commits: 1, recent: [], ambiguous: false };

	test('verify is always offered', () => {
		const { els } = loaded(never);
		assert.ok(els.actions.innerHTML.includes('Verify with agent'), els.actions.innerHTML);
	});

	test('compare diff is offered only when the callers were removed', () => {
		assert.ok(loaded(lost).els.actions.innerHTML.includes('Compare diff'));
		// A symbol that never had a caller has no removal to explain, and asking
		// invites an invented commit.
		assert.ok(!loaded(never).els.actions.innerHTML.includes('Compare diff'));
	});

	test('an unreliable history is labelled rather than presented as fact', () => {
		const { els } = loaded({ ...lost, ambiguous: true });
		assert.ok(els.actions.innerHTML.includes('history may be another symbol'), els.actions.innerHTML);
	});

	test('clicking verify disables the button so a second agent is not queued', () => {
		const { els } = loaded(never);
		els['act-verify'].listeners.click({} as never);
		assert.strictEqual(els['act-verify'].disabled, true);
		assert.ok(els['act-verify'].textContent.includes('Asking the agent'), els['act-verify'].textContent);
	});

	test('a verdict opens the report and re-enables the button', () => {
		const { els, winListeners } = loaded(never);
		els['act-verify'].listeners.click({} as never);
		winListeners.message({
			data: {
				type: 'verifyResult',
				key,
				result: { what: 'spawns a worker', verdict: 'confirmed-dead', why: 'no callers', risk: 'none', safeToDelete: true, confidence: 'high', checkedAt: 'now' },
			},
		});
		assert.ok(els.overlay.classes.has('open'), 'the verdict modal opens');
		assert.ok(els.mbody.innerHTML.includes('spawns a worker'), els.mbody.innerHTML);
		assert.ok(els.mbody.innerHTML.includes('yes'), 'safe-to-delete is stated');
		assert.strictEqual(els['act-verify'].disabled, false);
	});

	test('a removal report shows both flows side by side', () => {
		const { els, winListeners } = loaded(lost);
		els['act-removal'].listeners.click({} as never);
		winListeners.message({
			data: {
				type: 'removalResult',
				key,
				result: { commit: '53da72c', why: 'moved to v2', replacement: 'run_v2', oldFlow: 'a -> run_worker', newFlow: 'a -> run_v2', checkedAt: 'now' },
			},
		});
		const b = els.mbody.innerHTML;
		assert.ok(b.includes('53da72c'), b);
		assert.ok(b.includes('a -&gt; run_worker') && b.includes('a -&gt; run_v2'), b);
	});

	test('a harness that answers nothing says so instead of spinning', () => {
		const { els, winListeners } = loaded(never);
		els['act-verify'].listeners.click({} as never);
		winListeners.message({ data: { type: 'verifyResult', key, result: null } });
		assert.ok(els.mbody.innerHTML.includes('returned nothing usable'), els.mbody.innerHTML);
		assert.strictEqual(els['act-verify'].disabled, false);
	});

	test('a stored finding is re-openable without asking again', () => {
		const { els } = loaded(never, { verdict: { what: 'w', verdict: 'unclear', confidence: 'low', safeToDelete: false } });
		assert.ok(els.actions.innerHTML.includes('View last verdict'), els.actions.innerHTML);
	});
});

suite('dead code panel: regenerating the report', () => {
	const scan = {
		schemaVersion: 1,
		generatedAt: '2026-08-02T09:15:30.000Z',
		files: 10,
		definitions: 100,
		unreachable: [{ name: 'x', file: 'a.py', line: 1, end: 3, kind: 'function', ambiguous: false }],
		testOnly: [],
		probable: 0,
	};

	function loaded(report: unknown) {
		const sb = evalWebviewScript(getDeadCodeHtml(), []);
		sb.els.bucket.value = 'all';
		sb.els.q.value = '';
		sb.winListeners.message({ data: { type: 'report', scan: report, repo: 'vinv' } });
		return sb;
	}

	test('the timestamp of the last scan is shown beside the button', () => {
		const { els } = loaded(scan);
		assert.ok(els.lastscan.textContent.includes('2026-08-02 09:15:30'), els.lastscan.textContent);
	});

	test('a workspace that has never been scanned says so', () => {
		const { els } = loaded(null);
		assert.strictEqual(els.lastscan.textContent, 'never scanned');
	});

	test('clicking regenerate disables the button so a second scan is not spawned', () => {
		const { els } = loaded(scan);
		els.regen.listeners.click({} as never);
		assert.strictEqual(els.regen.disabled, true);
		assert.ok(els.regen.textContent.includes('Scanning'), els.regen.textContent);
	});

	test('engine progress is surfaced on the button itself', () => {
		const { els, winListeners } = loaded(scan);
		els.regen.listeners.click({} as never);
		winListeners.message({ data: { type: 'scanProgress', label: '17 unreachable, 34 test-only' } });
		assert.ok(els.regen.textContent.includes('17 unreachable'), els.regen.textContent);
	});

	test('a fresh report re-enables the button and restamps the time', () => {
		const { els, winListeners } = loaded(scan);
		els.regen.listeners.click({} as never);
		winListeners.message({
			data: { type: 'report', scan: { ...scan, generatedAt: '2026-08-02T10:00:00.000Z' }, repo: 'vinv' },
		});
		assert.strictEqual(els.regen.disabled, false);
		assert.strictEqual(els.regen.textContent, 'Regenerate report');
		assert.ok(els.lastscan.textContent.includes('2026-08-02 10:00:00'), els.lastscan.textContent);
	});

	test('a failed scan says the previous report is untouched, and frees the button', () => {
		const { els, winListeners } = loaded(scan);
		els.regen.listeners.click({} as never);
		winListeners.message({ data: { type: 'scanFailed' } });
		assert.strictEqual(els.regen.disabled, false);
		assert.ok(els.mbody.innerHTML.includes('untouched'), els.mbody.innerHTML);
	});
});

suite('dead code panel: a chain is one finding, not several', () => {
	function sym(name: string, line: number, deadCallers: string[] = []) {
		return { name, file: 'gaia_scorer.py', line, end: line + 4, kind: 'function', ambiguous: false, deadCallers };
	}
	// question_scorer is the top; the other two are reached only from it.
	const scan = {
		schemaVersion: 1,
		generatedAt: '2026-08-02T09:00:00.000Z',
		files: 48,
		definitions: 735,
		unreachable: [
			sym('question_scorer', 34),
			sym('normalize_number_str', 6, ['gaia_scorer.py:34:question_scorer']),
			sym('normalize_str', 104, ['gaia_scorer.py:34:question_scorer']),
		],
		testOnly: [],
		probable: 0,
	};

	function loaded() {
		const sb = evalWebviewScript(getDeadCodeHtml(), []);
		sb.els.bucket.value = 'all';
		sb.els.q.value = '';
		sb.winListeners.message({ data: { type: 'report', scan, repo: 'smolagents' } });
		return sb;
	}

	test('only the top of the chain is listed', () => {
		const { els } = loaded();
		assert.ok(els.list.innerHTML.includes('question_scorer'), els.list.innerHTML);
		// These are not separate decisions — they go when their caller goes.
		assert.ok(!els.list.innerHTML.includes('normalize_number_str'), els.list.innerHTML);
		assert.ok(els.count.textContent.includes('1'), els.count.textContent);
	});

	test('the tile counts chains and says how many were folded in', () => {
		const { els } = loaded();
		assert.ok(els.tiles.innerHTML.includes('+2 folded in'), els.tiles.innerHTML);
	});

	test('the detail pane names what would be deleted alongside', () => {
		const { els } = loaded();
		const d = els.detail.innerHTML;
		assert.ok(d.includes('Goes with it (2)'), d);
		assert.ok(d.includes('normalize_number_str') && d.includes('normalize_str'), d);
	});
});
