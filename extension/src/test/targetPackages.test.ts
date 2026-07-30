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
	rootPackage,
	serviceForEndpointFile,
	targetPackagesFor,
} from '../bringup/targetPackages';
import { auditOwnCodeTracing, markUntracedBringup, readBringupOutcome } from '../bringup/bringup';

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

	test('a bring-up that DID trace its own code is left verified', () => {
		const root = repo();
		seed(root, ['POST /chat', 'examples.server.main.chat']);
		assert.strictEqual(auditOwnCodeTracing(root, service).state, 'traced');
		assert.strictEqual(readBringupOutcome(root, 'api').state, 'verified');
	});
});
