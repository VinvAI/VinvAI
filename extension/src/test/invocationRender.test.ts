/**
 * The rendering contract, driven by the vectors all three implementations share.
 *
 * The Run button fills a command template here, in TypeScript; the exercise pass
 * fills the same template in Python; bring-up verified it in Python again. The
 * whole value of the record is that all three produce the SAME string — nothing
 * in the type system enforces that, so contracts/vectors/invocation_render.json
 * does. A change made on one side and not the others fails here.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	InvocationRenderError,
	buildLaunchPlan,
	defaultArgs,
	defaultInvocation,
	defaultsMatchVerified,
	readInvocations,
	readRunArgs,
	renderInvocation,
	resolvedCommand,
	shellQuote,
	toBashPath,
	writeRunArgs,
	type Invocation,
} from '../bringup/invocations';

const VECTORS = path.resolve(
	__dirname,
	'..',
	'..',
	'..',
	'contracts',
	'vectors',
	'invocation_render.json',
);

interface RenderCase {
	name: string;
	invocation: Invocation;
	args: Record<string, string>;
	expected: string;
}
interface ErrorCase {
	name: string;
	invocation: Invocation;
	args: Record<string, string>;
	message: string;
}

function vectors(): { render: RenderCase[]; error: ErrorCase[] } {
	return JSON.parse(fs.readFileSync(VECTORS, 'utf8')) as {
		render: RenderCase[];
		error: ErrorCase[];
	};
}

suite('invocations: the shared rendering contract', () => {
	test('the vectors file is where all three suites look for it', () => {
		// Without this, a moved file turns every case below into zero assertions,
		// which reads as a pass.
		assert.ok(fs.existsSync(VECTORS), `shared render vectors missing at ${VECTORS}`);
		const v = vectors();
		assert.ok(v.render.length > 0 && v.error.length > 0);
	});

	test('every render vector produces the same string Python produces', () => {
		for (const c of vectors().render) {
			assert.strictEqual(renderInvocation(c.invocation, c.args), c.expected, c.name);
		}
	});

	test('every error vector is refused rather than rendered past', () => {
		for (const c of vectors().error) {
			assert.throws(
				() => renderInvocation(c.invocation, c.args),
				(e: unknown) =>
					e instanceof InvocationRenderError && String((e as Error).message).includes(c.message),
				c.name,
			);
		}
	});
});

suite('invocations: quoting and path spelling', () => {
	test('an ordinary argv token is left bare so defaults stay byte-identical', () => {
		assert.strictEqual(shellQuote('--since'), '--since');
		assert.strictEqual(shellQuote('7d'), '7d');
		assert.strictEqual(
			shellQuote('/c/repo/.venv/Scripts/python.exe'),
			'/c/repo/.venv/Scripts/python.exe',
		);
		assert.strictEqual(shellQuote('two words'), "'two words'");
	});

	test('drive-letter paths convert by shape, never by host platform', () => {
		// The vectors run on Linux CI and Windows dev machines alike.
		assert.strictEqual(toBashPath('C:\\Users\\dev'), '/c/Users/dev');
		assert.strictEqual(toBashPath('C:/Users/dev'), '/c/Users/dev');
		assert.strictEqual(toBashPath('/already/posix'), '/already/posix');
	});
});

suite('invocations: what "verified" attests to', () => {
	const inv: Invocation = {
		id: 'report',
		command: 'acme-tool report --since {since}',
		params: [{ name: 'since', default: '7d' }],
		verification: { rendered_command: 'acme-tool report --since 7d' },
	};

	test('rendering the defaults reproduces the string bring-up ran', () => {
		assert.strictEqual(renderInvocation(inv, defaultArgs(inv)), 'acme-tool report --since 7d');
		assert.ok(defaultsMatchVerified(inv));
	});

	test('a changed default breaks the claim rather than quietly widening it', () => {
		// The command on file was proven to work with 7d. Editing the default to
		// 30d means `verified: true` now attests to a command nobody ever ran.
		assert.ok(!defaultsMatchVerified({ ...inv, params: [{ name: 'since', default: '30d' }] }));
	});

	test('a record from before parameters existed makes no claim and still runs', () => {
		assert.ok(defaultsMatchVerified({ id: 'old', command: 'acme-tool report' }));
	});
});

suite('invocations: reading the record and remembering arguments', () => {
	function workspace(doc: unknown): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-inv-'));
		const dir = path.join(root, '.vinv', 'start_commands');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'acme-tool.json'), JSON.stringify(doc), 'utf8');
		return root;
	}

	test('a verified record yields its invocations, with the flagged one default', () => {
		const root = workspace({
			service: 'acme-tool',
			verified: true,
			commands: [{ command: 'acme-tool report' }],
			invocations: [
				{ id: 'check', command: 'acme-tool check', expect_exit: 1 },
				{ id: 'report', command: 'acme-tool report', default: true },
			],
		});
		const list = readInvocations(root, 'acme-tool');
		assert.deepStrictEqual(
			list.map((i) => i.id),
			['check', 'report'],
		);
		assert.strictEqual(defaultInvocation(list)?.id, 'report');
	});

	test('with none flagged, the first entry is what headless consumers run', () => {
		const root = workspace({
			service: 'acme-tool',
			verified: true,
			invocations: [{ id: 'check', command: 'acme-tool check' }, { id: 'report', command: 'x' }],
		});
		assert.strictEqual(defaultInvocation(readInvocations(root, 'acme-tool'))?.id, 'check');
	});

	test('a failed bring-up offers nothing — those commands are not known-good', () => {
		const root = workspace({
			service: 'acme-tool',
			verified: false,
			invocations: [{ id: 'report', command: 'acme-tool report' }],
		});
		assert.deepStrictEqual(readInvocations(root, 'acme-tool'), []);
	});

	test('an entry with no id gets a stable one rather than falling back to position', () => {
		const root = workspace({
			service: 'acme-tool',
			verified: true,
			invocations: [{ command: 'acme-tool report' }],
		});
		assert.strictEqual(readInvocations(root, 'acme-tool')[0].id, 'run-1');
	});

	test('a parameterless command is run verbatim, literal braces and all', () => {
		// Only an invocation that DECLARES parameters opts into templating; a
		// recorded `--format '{json}'` must not raise on a placeholder nobody
		// meant to write.
		assert.strictEqual(
			resolvedCommand({ id: 'fmt', command: "acme-tool fmt --template '{name}'" }),
			"acme-tool fmt --template '{name}'",
		);
	});

	test('last-used arguments survive to the next run, per invocation', () => {
		const root = workspace({ service: 'acme-tool', verified: true, invocations: [] });
		assert.deepStrictEqual(readRunArgs(root, 'acme-tool', 'report'), {});
		writeRunArgs(root, 'acme-tool', 'report', { since: '30d' });
		writeRunArgs(root, 'acme-tool', 'check', { strict: 'true' });
		assert.deepStrictEqual(readRunArgs(root, 'acme-tool', 'report'), { since: '30d' });
		assert.deepStrictEqual(readRunArgs(root, 'acme-tool', 'check'), { strict: 'true' });
	});
});

suite('invocations: what a Run actually executes', () => {
	function workspace(doc: unknown): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-plan-'));
		const dir = path.join(root, '.vinv', 'start_commands');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'acme-tool.json'), JSON.stringify(doc), 'utf8');
		return root;
	}

	test('with no invocations recorded, the whole chain runs exactly as before', () => {
		const root = workspace({
			service: 'acme-tool',
			verified: true,
			commands: [
				{ command: 'docker compose up -d db', working_directory: '/repo' },
				{ command: 'acme-tool report', working_directory: '/repo' },
			],
		});
		const plan = buildLaunchPlan(root, 'acme-tool');
		assert.strictEqual(
			plan?.script,
			'cd "/repo" && docker compose up -d db && cd "/repo" && acme-tool report',
		);
		assert.strictEqual(plan?.expectExit, null, 'a plain chain makes no completion claim');
	});

	test('a chosen invocation replaces the unit but keeps its dependencies', () => {
		// `commands` is a SEQUENCE and `invocations` a set of ALTERNATIVES for the
		// last entry. Conflating them would either drop the database or run every
		// subcommand at once.
		const root = workspace({
			service: 'acme-tool',
			verified: true,
			commands: [
				{ command: 'docker compose up -d db', working_directory: '/repo' },
				{ command: 'acme-tool report --since 7d', working_directory: '/repo' },
			],
			invocations: [
				{ id: 'report', default: true, command: 'acme-tool report --since {since}',
				  params: [{ name: 'since', default: '7d' }] },
				{ id: 'check', command: 'acme-tool check ./sample', expect_exit: 1 },
			],
		});

		const dflt = buildLaunchPlan(root, 'acme-tool');
		assert.strictEqual(
			dflt?.script,
			'cd "/repo" && docker compose up -d db && cd "/repo" && acme-tool report --since 7d',
		);
		assert.strictEqual(dflt?.invocation?.id, 'report');
		assert.strictEqual(dflt?.expectExit, 0);

		const chosen = buildLaunchPlan(root, 'acme-tool', {
			invocation: 'check',
		});
		assert.ok(chosen?.script.includes('docker compose up -d db'), 'the dependency was dropped');
		assert.ok(chosen?.script.endsWith('acme-tool check ./sample'));
		// The chosen invocation's own contract, not the file-level probe: a linter
		// that exits 1 on findings is doing its job, and reading one shared exit
		// code for both would dispatch a fix episode against it.
		assert.strictEqual(chosen?.expectExit, 1);
	});

	test('supplied arguments reach the script', () => {
		const root = workspace({
			service: 'acme-tool',
			verified: true,
			commands: [{ command: 'acme-tool report --since 7d' }],
			invocations: [
				{ id: 'report', command: 'acme-tool report --since {since}',
				  params: [{ name: 'since', default: '7d' }] },
			],
		});
		assert.strictEqual(
			buildLaunchPlan(root, 'acme-tool', { invocation: 'report', args: { since: '90d' } })?.script,
			'acme-tool report --since 90d',
		);
	});

	test('an edited default is reported rather than silently honoured', () => {
		// `verified: true` attested to the command bring-up ran. Editing the
		// default afterwards means it now attests to one nobody ever ran — the run
		// still proceeds (the operator may know better) but it says so.
		const root = workspace({
			service: 'acme-tool',
			verified: true,
			commands: [{ command: 'acme-tool report --since 7d' }],
			invocations: [
				{
					id: 'report',
					command: 'acme-tool report --since {since}',
					params: [{ name: 'since', default: '30d' }],
					verification: { rendered_command: 'acme-tool report --since 7d' },
				},
			],
		});
		const plan = buildLaunchPlan(root, 'acme-tool');
		assert.ok(plan?.warning?.includes('no longer renders'));
		assert.strictEqual(plan?.script, 'acme-tool report --since 30d');
	});

	test('a template that cannot be filled comes back as a warning, never a throw', () => {
		// probeRunner and Auto-Pilot call through here headless; an exception would
		// take down the pipeline over a malformed record.
		const root = workspace({
			service: 'acme-tool',
			verified: true,
			commands: [{ command: 'acme-tool report' }],
			invocations: [
				{ id: 'report', command: 'acme-tool report --since {since}',
				  params: [{ name: 'other', default: 'x' }] },
			],
		});
		const plan = buildLaunchPlan(root, 'acme-tool');
		assert.ok(plan?.warning?.includes('could not be filled in'));
	});

	test('nothing recorded means nothing to run', () => {
		const root = workspace({ service: 'acme-tool', verified: false, commands: [] });
		assert.strictEqual(buildLaunchPlan(root, 'acme-tool'), null);
	});
});
