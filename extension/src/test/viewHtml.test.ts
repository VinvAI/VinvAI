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
 *     trigger (optimize.jsonl episodes).
 */

import * as assert from 'assert';
import { getJourneyHtml } from '../views/journeyView';
import { getOptimizationReportHtml } from '../views/optimizationReportView';
import { getFindingsHtml } from '../views/findingsView';
import { getDeadSectionHtml } from '../views/deadCodeReportView';

type Listener = (ev: unknown) => void;

interface ElStub {
	textContent: string;
	innerHTML: string;
	disabled: boolean;
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
		assert.ok(html.includes('title="Typical response time'), 'p50 column tooltip');
		assert.ok(html.includes('title="The slow tail'), 'p95 column tooltip');
		assert.ok(html.includes('Data the tests created'), 'ledger section title is plain');
		assert.ok(html.includes('>still there</span>'), 'uncleaned row is a sentence a non-expert reads');
		assert.ok(html.includes('fingerprint') || findings.issues.length === 0, 'issue id labeled fingerprint');
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
});
