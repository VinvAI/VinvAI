/**
 * Target-package selection: the check that keeps tracelens pointed at the code
 * that actually serves the requests.
 *
 * The bug these cover, from a real repo: four services recorded
 * `modules: ["smolagents"]` while their entrypoints were `examples.server.main`
 * and friends. tracelens instrumented the library, every inbound span had zero
 * application frames under it, and the whole pipeline reported confident zeros
 * — endpoint coverage 0%, no latency, empty call-tree overlay — with nothing
 * anywhere raising an error.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	entrypointModule,
	judgeOwnCode,
	missingTargetPackage,
	recordedTargetPackages,
	rootPackage,
	serviceForEndpointFile,
	targetPackagesFor,
	withTargetPackage,
} from '../bringup/targetPackages';
import {
	auditOwnCodeTracing,
	markUntracedBringup,
	readBringupOutcome,
	repairRecordedTargetPackages,
} from '../bringup/bringup';
import { probesAreActionable } from '../views/nextStep';

suite('targetPackages: reading the entrypoint out of a start command', () => {
	test('an ASGI app spec behind `-m uvicorn` is the app module, not uvicorn', () => {
		assert.strictEqual(
			entrypointModule('python -m uvicorn examples.server.main:app --host 0.0.0.0 --port 8001'),
			'examples.server.main',
		);
	});

	test('the real recorded command, venv paths and inline PATH and all', () => {
		const cmd =
			'PATH="/c/p/.venv/Scripts:$PATH" /c/p/.venv/Scripts/tracelens run ' +
			'--target-package smolagents --output C:/p/.vinv/captures/x/trace.jsonl --sample-rate 1.0 ' +
			'-- /c/p/.venv/Scripts/python.exe -m uvicorn examples.server.main:app --host 0.0.0.0 --port 8001';
		assert.strictEqual(entrypointModule(cmd), 'examples.server.main');
	});

	test('flag values are not mistaken for the app spec', () => {
		assert.strictEqual(
			entrypointModule('gunicorn --workers 4 --bind 0.0.0.0:8000 acme.wsgi:application'),
			'acme.wsgi',
		);
		assert.strictEqual(
			entrypointModule('python -m uvicorn --port 8000 pkg.api:app'),
			'pkg.api',
		);
	});

	test('a plain `-m module` entrypoint', () => {
		assert.strictEqual(entrypointModule('python -m acme_payment.main'), 'acme_payment.main');
	});

	test('a script inside a package resolves to its dotted module', () => {
		assert.strictEqual(entrypointModule('python examples/gradio_ui.py'), 'examples.gradio_ui');
		assert.strictEqual(entrypointModule('python examples\\gradio_ui.py'), 'examples.gradio_ui');
	});

	// A bare script runs as `__main__` and belongs to no package, so there is
	// nothing to name in --target-package. Guessing "app" would produce a target
	// matching no span, and would mask the real mismatch behind a fake fix.
	test('a top-level script and other ambiguous forms yield no opinion', () => {
		assert.strictEqual(entrypointModule('python app.py'), null);
		assert.strictEqual(entrypointModule('flask run --port 5000'), null);
		assert.strictEqual(entrypointModule('./start.sh'), null);
		assert.strictEqual(entrypointModule('python -m'), null);
	});

	test('rootPackage takes the top-level import package', () => {
		assert.strictEqual(rootPackage('examples.server.main'), 'examples');
		assert.strictEqual(rootPackage('acme'), 'acme');
	});
});

suite('targetPackages: what actually gets instrumented', () => {
	test('the entrypoint package is appended when discovery omitted it', () => {
		const { packages, added } = targetPackagesFor({
			command: 'python -m uvicorn examples.server.main:app --port 8001',
			modules: ['smolagents'],
		});
		// Appended, not substituted: the service genuinely drives smolagents, and
		// dropping it would lose half the call tree.
		assert.deepStrictEqual(packages, ['smolagents', 'examples']);
		assert.strictEqual(added, 'examples');
	});

	test('a correctly declared service is left exactly as it was', () => {
		const { packages, added } = targetPackagesFor({
			command: 'python -m uvicorn acme_payment.main:app',
			modules: ['acme_payment'],
		});
		assert.deepStrictEqual(packages, ['acme_payment']);
		assert.strictEqual(added, null, 'nothing to add — no spurious warning');
	});

	test('an unreadable command changes nothing', () => {
		const { packages, added } = targetPackagesFor({ command: 'python app.py', modules: ['acme'] });
		assert.deepStrictEqual(packages, ['acme']);
		assert.strictEqual(added, null);
	});
});

// The compass told a manual driver to "Run probes" on a workspace with no
// endpoint traffic. Probes replay requests a capture already recorded, so the
// pass skipped on arrival and put the user straight back on the same rung. The
// Auto-Pilot scheduler had already been fixed for this (probes re-arm after
// exercise); the compass had not, while its own comment claimed it walked the
// same path.
suite('compass: probes only lead when there is traffic to replay', () => {
	function repo(opts: { probes?: boolean; observed?: number }): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-compass-'));
		if (opts.probes) {
			const d = path.join(root, '.vinv', 'probes');
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(path.join(d, 'api.json'), '{}', 'utf8');
		}
		if (opts.observed !== undefined) {
			const d = path.join(root, '.vinv', 'reports');
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(
				path.join(d, 'index.json'),
				JSON.stringify({
					version: 1,
					endpoints: Array.from({ length: opts.observed }, (_, i) => ({ id: `E${i}` })),
				}),
				'utf8',
			);
		}
		return root;
	}

	test('no traffic observed yet: the rung stands down so exercise can lead', () => {
		// The exact state that produced the complaint: an empty probes dir and a
		// manifest the insight pass rewrote with zero endpoints.
		assert.strictEqual(probesAreActionable(repo({ observed: 0 })), false);
		// And with no manifest at all (nothing has ever run).
		assert.strictEqual(probesAreActionable(repo({})), false);
	});

	test('traffic observed and probes outstanding: the rung leads', () => {
		assert.strictEqual(probesAreActionable(repo({ observed: 2 })), true);
	});

	test('probes already run: the rung is done regardless of traffic', () => {
		assert.strictEqual(probesAreActionable(repo({ probes: true, observed: 2 })), false);
		assert.strictEqual(probesAreActionable(repo({ probes: true, observed: 0 })), false);
	});
});

suite('targetPackages: which capture an endpoint should overlay', () => {
	// Four services, four captures. Without this join the engine overlays "the
	// freshest trace.jsonl anywhere", so the call tree for a main.py endpoint
	// gets whichever service ran last — and still reports status: ok.
	const services = [
		{ name: 'smolagents-mcp-server', command: 'python -m uvicorn examples.server.main:app --port 8001' },
		{ name: 'smolagents-async-agent', command: 'python -m uvicorn examples.async_agent.main:app --port 8000' },
		{ name: 'smolagents-gradio-ui', command: 'python examples/gradio_ui.py' },
	];

	test('an endpoint resolves to the service whose entrypoint defines it', () => {
		assert.strictEqual(
			serviceForEndpointFile(services, 'examples/server/main.py'),
			'smolagents-mcp-server',
		);
		assert.strictEqual(
			serviceForEndpointFile(services, 'examples/async_agent/main.py'),
			'smolagents-async-agent',
		);
	});

	// All three share the root package `examples`, so a root-only match is
	// ambiguous — and guessing would overlay the wrong trace with full confidence.
	test('an unmatched file in a shared root package yields no guess', () => {
		assert.strictEqual(serviceForEndpointFile(services, 'examples/other/thing.py'), null);
	});

	test('a unique root package still resolves when the module differs', () => {
		assert.strictEqual(
			serviceForEndpointFile([{ name: 'api', command: 'python -m uvicorn acme.api:app' }], 'acme/routes/users.py'),
			'api',
		);
	});
});

// targetPackagesFor governs what a NEW bring-up records. The recorded command
// lives outside the repo and is replayed verbatim, so a service brought up by an
// older build keeps instrumenting the wrong package forever — green every time,
// and zero coverage every time. This is the pre-run check for that.
suite('targetPackages: a recorded command that instruments the wrong package', () => {
	const service = {
		command: 'python -m uvicorn examples.async_agent.main:app --host 0.0.0.0 --port 8000',
		modules: ['smolagents'],
	};

	test('the real recorded command names the package it is missing', () => {
		const recorded =
			'PATH="/c/p/.venv/Scripts:$PATH" /c/p/.venv/Scripts/tracelens run ' +
			'--target-package smolagents --output C:/p/.vinv/captures/x/trace.jsonl --sample-rate 1.0 ' +
			'-- /c/p/.venv/Scripts/python.exe -m uvicorn examples.async_agent.main:app --port 8000';
		assert.strictEqual(missingTargetPackage(recorded, service), 'examples');
	});

	test('a command that already instruments the entrypoint package is fine', () => {
		const recorded =
			'tracelens run --target-package smolagents --target-package examples -o t.jsonl ' +
			'-- python -m uvicorn examples.async_agent.main:app';
		assert.strictEqual(missingTargetPackage(recorded, service), null);
	});

	test('the -t spelling counts too', () => {
		assert.strictEqual(
			missingTargetPackage('tracelens run -t examples -- python -m uvicorn examples.async_agent.main:app', service),
			null,
		);
	});

	// No tracelens wrapper is a different defect (untraced service), and reporting
	// a "wrong target package" for it would send the user at the wrong repair.
	test('a command with no target flags at all is not a wrong-target report', () => {
		assert.strictEqual(
			missingTargetPackage('python -m uvicorn examples.async_agent.main:app', service),
			null,
		);
	});

	test('an unreadable entrypoint yields no opinion', () => {
		assert.strictEqual(
			missingTargetPackage('tracelens run -t acme -- python app.py', { command: 'python app.py' }),
			null,
		);
	});

	test('recordedTargetPackages reads both spellings, in order', () => {
		assert.deepStrictEqual(
			recordedTargetPackages('tracelens run -t a --target-package b -t c -o x.jsonl -- py m.py'),
			['a', 'b', 'c'],
		);
	});
});

// The extension computes the right --module values and the bring-up prompt says
// to use them verbatim. An agent dropped one on three of four services in a real
// workspace, and the resulting record starts the service green while tracing none
// of its own code — forever, because the record is replayed exactly as written.
// A derived value must not depend on a model repeating it.
suite('targetPackages: repairing a recorded command in place', () => {
	const service = {
		name: 'api',
		command: 'python -m uvicorn examples.async_agent.main:app --host 0.0.0.0 --port 8000',
		modules: ['smolagents'],
	};
	const recorded =
		'PATH="/c/p/.venv/Scripts:$PATH" /c/p/.venv/Scripts/tracelens run ' +
		'--target-package smolagents --output C:/p/.vinv/captures/x/trace.jsonl --sample-rate 1.0 ' +
		'-- /c/p/.venv/Scripts/python.exe -m uvicorn examples.async_agent.main:app --port 8000';

	test('the flag lands on tracelens, never past the `--` separator', () => {
		const fixed = withTargetPackage(recorded, 'examples');
		const sep = fixed.indexOf(' -- ');
		assert.ok(
			fixed.indexOf('--target-package examples') < sep,
			`the added flag must precede the child command:\n${fixed}`,
		);
		// Additive: the original target survives.
		assert.ok(fixed.includes('--target-package smolagents'));
		assert.strictEqual(missingTargetPackage(fixed, service), null, 'and the gap is closed');
	});

	test('a command with no target flags is left alone', () => {
		const plain = 'python -m uvicorn examples.async_agent.main:app';
		assert.strictEqual(withTargetPackage(plain, 'examples'), plain);
	});

	test('the record on disk is rewritten, and the repair is idempotent', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-repair-'));
		const file = path.join(root, '.vinv', 'start_commands', 'api.json');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({ service: 'api', verified: true, commands: [{ command: recorded }] }),
			'utf8',
		);

		assert.strictEqual(repairRecordedTargetPackages(root, service), 'examples');
		const after = JSON.parse(fs.readFileSync(file, 'utf8'));
		assert.ok(after.commands[0].command.includes('--target-package examples'));
		// Untouched fields survive the rewrite — this file drives the Run button.
		assert.strictEqual(after.verified, true);
		assert.strictEqual(after.service, 'api');

		// Second pass has nothing to do, and must not stack duplicate flags.
		assert.strictEqual(repairRecordedTargetPackages(root, service), null);
		const twice = JSON.parse(fs.readFileSync(file, 'utf8'));
		assert.strictEqual(
			(twice.commands[0].command.match(/--target-package examples/g) ?? []).length,
			1,
		);
	});

	test('a missing record is not a crash', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-repair-none-'));
		assert.strictEqual(repairRecordedTargetPackages(root, service), null);
	});
});

suite('targetPackages: did the service trace its own code', () => {
	const spans = (...c: string[]) => c;

	test('own frames under a request means traced', () => {
		const v = judgeOwnCode(
			spans('POST /chat', 'examples.server.main.chat', 'smolagents.agents.run'),
			'examples.server.main',
		);
		assert.strictEqual(v.state, 'traced');
	});

	// The exact smolagents signature: inbound spans land, library frames land,
	// the handler never appears.
	test('requests served with no own frames is the real defect', () => {
		const v = judgeOwnCode(
			spans('POST /chat', 'POST /chat http receive', 'smolagents.agents.MultiStepAgent.run'),
			'examples.server.main',
		);
		assert.strictEqual(v.state, 'absent');
		assert.strictEqual(v.state === 'absent' && v.rootPackage, 'examples');
		// One request, not two: `POST /chat http receive` is an ASGI message
		// sub-span of the same request, and counting it inflates what we tell
		// the user happened.
		assert.strictEqual(v.state === 'absent' && v.requests, 1);
	});

	// A port-only bring-up probe serves nothing, so there is nothing to conclude
	// — calling that a failure would red-flag every healthy stdio service.
	test('no request served is unknown, never a failure', () => {
		const v = judgeOwnCode(spans('smolagents.tools.validate_after_init'), 'examples.server.main');
		assert.strictEqual(v.state, 'unknown');
	});

	test('no determinable entrypoint is unknown, never a failure', () => {
		assert.strictEqual(judgeOwnCode(spans('GET /'), null).state, 'unknown');
	});
});

suite('targetPackages: the audit downgrades an untraced bring-up', () => {
	function repo(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-tracecheck-'));
	}

	function seed(root: string, spans: string[]): void {
		const trace = path.join(root, '.vinv', 'captures', 'vinv-bringup', 'api', 'trace.jsonl');
		fs.mkdirSync(path.dirname(trace), { recursive: true });
		fs.writeFileSync(
			trace,
			spans.map((c) => JSON.stringify({ component: c, event: 'enter' })).join('\n') + '\n',
			'utf8',
		);
		const rec = path.join(root, '.vinv', 'start_commands', 'api.json');
		fs.mkdirSync(path.dirname(rec), { recursive: true });
		fs.writeFileSync(
			rec,
			JSON.stringify({
				service: 'api',
				verified: true,
				verification: { trace_jsonl: trace, http_status: 200 },
				commands: [{ command: 'tracelens run --target-package smolagents -- python -m uvicorn examples.server.main:app' }],
			}),
			'utf8',
		);
	}

	const service = {
		name: 'api',
		command: 'python -m uvicorn examples.server.main:app --port 8001',
		modules: ['smolagents'],
	};

	test('a green bring-up that traced nothing of its own is recorded as failed', () => {
		const root = repo();
		seed(root, ['POST /chat', 'smolagents.agents.run']);

		const verdict = auditOwnCodeTracing(root, service);
		assert.strictEqual(verdict.state, 'absent');

		assert.strictEqual(readBringupOutcome(root, 'api').state, 'verified', 'green before the audit');
		markUntracedBringup(root, 'api', verdict as Extract<typeof verdict, { state: 'absent' }>);
		const after = readBringupOutcome(root, 'api');
		// 'failed' (repair it), never 'library' (nothing to run here). The
		// symptom necessarily talks about modules and start commands, which is
		// exactly what the outcome reader's library heuristic pattern-matches on.
		assert.strictEqual(after.state, 'failed');
		// The symptom is what the fixing agent reads — it must name the flag and
		// the package, not just say something went wrong.
		assert.match(String(after.symptom), /--target-package/);
		assert.match(String(after.symptom), /'examples'/);
	});

	// The audit reported "served 4 request(s)" for 2 real requests: it scanned the
	// file for `"component"` and tracelens writes an enter AND an exit for every
	// span, so every root was counted twice. A number we put in front of the user
	// has to be the number that happened.
	test('a request is counted once, not once per span event', () => {
		const root = repo();
		const dir = path.join(root, '.vinv', 'captures', 'vinv-bringup', 'api');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'trace.jsonl'),
			[
				// Two requests, each with its enter/exit pair and ASGI sub-spans.
				{ component: 'POST /run-agent', event: 'enter' },
				{ component: 'POST /run-agent http receive', event: 'enter' },
				{ component: 'smolagents.agents.run', event: 'enter' },
				{ component: 'smolagents.agents.run', event: 'exit' },
				{ component: 'POST /run-agent http receive', event: 'exit' },
				{ component: 'POST /run-agent', event: 'exit' },
				{ component: 'POST /run-agent', event: 'enter' },
				{ component: 'POST /run-agent', event: 'exit' },
			]
				.map((e) => JSON.stringify(e))
				.join('\n') + '\n',
			'utf8',
		);
		const rec = path.join(root, '.vinv', 'start_commands', 'api.json');
		fs.mkdirSync(path.dirname(rec), { recursive: true });
		fs.writeFileSync(rec, JSON.stringify({ verified: true, commands: [] }), 'utf8');

		const verdict = auditOwnCodeTracing(root, service);
		assert.strictEqual(verdict.state, 'absent');
		assert.strictEqual(
			verdict.state === 'absent' && verdict.requests,
			2,
			'two requests were served, not four span events',
		);
	});

	test('a bring-up that DID trace its own code is left verified', () => {
		const root = repo();
		seed(root, ['POST /chat', 'examples.server.main.chat']);
		assert.strictEqual(auditOwnCodeTracing(root, service).state, 'traced');
		assert.strictEqual(readBringupOutcome(root, 'api').state, 'verified');
	});
});
