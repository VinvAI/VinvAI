/**
 * The proactive time-saver line: its count comes from the opportunity board's
 * actionable (posted) entries only — dispatched/resolved/expired entries never
 * re-nag — and the copy reads as one quiet sentence.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { actionableOpportunityCount, timeSaverLine } from '../views/optimizationPanel';
import { opportunityBoardPath } from '../harness/opportunityBoard';

function tmpRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'vinv-nudge-'));
}

function writeBoard(root: string, entries: Array<Record<string, unknown>>): void {
	const file = opportunityBoardPath(root);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
}

suite('optimization nudge: actionable count and copy', () => {
	test('counts only posted entries; other statuses never re-nag', () => {
		const root = tmpRepo();
		const base = { row: 1, name: 'f', file: 'a.py', line: 1, predicted_ms: 10, evidence: 'e', source: 't', posted_at: 1, updated_at: 1 };
		writeBoard(root, [
			{ ...base, id: 'a1', status: 'posted' },
			{ ...base, id: 'b2', status: 'posted' },
			{ ...base, id: 'c3', status: 'dispatched' },
			{ ...base, id: 'd4', status: 'resolved' },
			{ ...base, id: 'e5', status: 'expired' },
		]);
		assert.strictEqual(actionableOpportunityCount(root), 2);
	});

	test('newest-status-wins: a posted entry later dispatched stops counting', () => {
		const root = tmpRepo();
		const base = { row: 1, name: 'f', file: 'a.py', line: 1, predicted_ms: 10, evidence: 'e', source: 't', posted_at: 1 };
		writeBoard(root, [
			{ ...base, id: 'a1', status: 'posted', updated_at: 1 },
			{ ...base, id: 'a1', status: 'dispatched', updated_at: 2 },
		]);
		assert.strictEqual(actionableOpportunityCount(root), 0);
	});

	test('no board file means zero — silence, not an error', () => {
		assert.strictEqual(actionableOpportunityCount(tmpRepo()), 0);
	});

	test('the line is one quiet sentence, singular and plural', () => {
		assert.strictEqual(timeSaverLine(3), '3 verified time-savers found — open Optimize');
		assert.strictEqual(timeSaverLine(1), '1 verified time-saver found — open Optimize');
	});
});
