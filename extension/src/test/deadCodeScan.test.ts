import * as assert from 'assert';
import { renderMarkdown, type DeadCodeScan, type DeadSymbol } from '../index/deadCodeScan';

function sym(file: string, name: string, line: number, extra: Partial<DeadSymbol> = {}): DeadSymbol {
	return { file, name, line, end: line, kind: 'function', ambiguous: false, deadCallers: [], ...extra };
}

function scan(over: Partial<DeadCodeScan> = {}): DeadCodeScan {
	return {
		schemaVersion: 1,
		generatedAt: '2026-08-01T12:00:00.000Z',
		files: 134,
		definitions: 1623,
		unreachable: [],
		testOnly: [],
		probable: 0,
		...over,
	};
}

suite('dead code report: the markdown a human reads', () => {
	test('an empty scan says nothing is dead rather than rendering empty headings', () => {
		const md = renderMarkdown(scan());
		assert.ok(md.includes('## Unreachable (0)'), md.slice(0, 400));
		assert.ok(md.includes('## Test-only (0)'));
		// Two sections, each explicitly empty — a heading with nothing under it
		// reads as a truncated report rather than a clean result.
		assert.strictEqual((md.match(/_Nothing\._/g) ?? []).length, 2);
	});

	test('symbols are grouped by file and ordered by line within it', () => {
		const md = renderMarkdown(
			scan({
				unreachable: [
					sym('b/second.py', 'late', 90),
					sym('a/first.py', 'beta', 20),
					sym('a/first.py', 'alpha', 5),
				],
			}),
		);
		// Files sorted, so a/ precedes b/ regardless of input order.
		assert.ok(md.indexOf('**a/first.py**') < md.indexOf('**b/second.py**'), md);
		// Within a file, source order — the order someone reads the file in.
		assert.ok(md.indexOf('`alpha`') < md.indexOf('`beta`'), md);
		assert.ok(md.includes('- `alpha` — function, line 5'));
		assert.ok(md.includes('- `late` — function, line 90'));
	});

	test('the count in each heading matches the rows beneath it', () => {
		const md = renderMarkdown(
			scan({
				unreachable: [sym('a.py', 'x', 1), sym('a.py', 'y', 2)],
				testOnly: [sym('b.py', 'z', 3)],
			}),
		);
		assert.ok(md.includes('## Unreachable (2)'), md);
		assert.ok(md.includes('## Test-only (1)'), md);
	});

	test('an ambiguous name is marked, because it is the one row not to act on blindly', () => {
		const md = renderMarkdown(
			scan({ unreachable: [sym('a.py', 'emit', 164, { ambiguous: true })] }),
		);
		assert.ok(md.includes('`emit`'), md);
		assert.ok(md.includes('name not unique'), md);
	});

	test('a clean symbol carries no ambiguity note', () => {
		const md = renderMarkdown(scan({ unreachable: [sym('a.py', 'plain', 3)] }));
		assert.ok(!md.includes('name not unique'), md);
	});

	test('kind and bucket are preserved — a class is not reported as a function', () => {
		const md = renderMarkdown(
			scan({ testOnly: [sym('a.py', 'Widget', 8, { kind: 'class' })] }),
		);
		assert.ok(md.includes('- `Widget` — class, line 8'), md);
	});

	test('the report states its limits, so the list is not read as proof', () => {
		const md = renderMarkdown(scan({ probable: 12 }));
		// The two caveats that decide whether a row is safe to delete.
		assert.ok(md.includes('12 method(s) that may be overrides'), md);
		assert.ok(/reflection/.test(md), md);
		// Test-only is a judgement queue: deleting one takes its tests with it.
		assert.ok(md.includes('takes its tests with it'), md);
	});

	test('the header carries the scale the numbers came from', () => {
		const md = renderMarkdown(scan({ files: 134, definitions: 1623 }));
		assert.ok(md.includes('1623 definitions'), md);
		assert.ok(md.includes('134 Python files'), md);
		assert.ok(md.startsWith('# Dead code'), md.slice(0, 80));
	});
});
