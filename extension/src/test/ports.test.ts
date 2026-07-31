/**
 * Port occupancy: the three listener probes' PARSING, and the free-port search.
 *
 * The parsing is what silently breaks — a `netstat` column shifted by a locale,
 * an IPv6 row spelled `[::]:8000`, an `ss` line whose pid rides inside
 * `users:(("uvicorn",pid=123,fd=7))`. Every one of those turns "who holds the
 * port" into "nobody", and the caller then reports a port it cannot free as a
 * mystery. Killing itself is not exercised here (it needs a real process); it
 * is the parse that decides whether the kill is even aimed at anything.
 */

import * as assert from 'assert';
import * as net from 'net';

import {
	findFreePort,
	isPortReclaimEnabled,
	parseLsofListeners,
	parseNetstatListeners,
	parseSsListeners,
	portIsBindable,
	portIsServing,
	describeHolders,
} from '../support/ports';

suite('ports: identifying the holder', () => {
	const NETSTAT = [
		'',
		'Active Connections',
		'',
		'  Proto  Local Address          Foreign Address        State           PID',
		'  TCP    0.0.0.0:8000           0.0.0.0:0              LISTENING       13376',
		'  TCP    127.0.0.1:8000         127.0.0.1:51544        ESTABLISHED     991',
		'  TCP    [::]:8000              [::]:0                 LISTENING       13376',
		'  TCP    0.0.0.0:8001           0.0.0.0:0              LISTENING       4242',
		'  UDP    0.0.0.0:8000           *:*                                    777',
	].join('\r\n');

	test('netstat: only LISTENING TCP rows for THIS port, both address families', () => {
		assert.deepStrictEqual(parseNetstatListeners(NETSTAT, 8000), [13376]);
		assert.deepStrictEqual(parseNetstatListeners(NETSTAT, 8001), [4242]);
		assert.deepStrictEqual(parseNetstatListeners(NETSTAT, 9999), []);
	});

	test('netstat: a port that is a SUFFIX of another is not a match', () => {
		// `:18000` ends with "8000" as a string; the parse must not claim it.
		const out = '  TCP    0.0.0.0:18000          0.0.0.0:0              LISTENING       55';
		assert.deepStrictEqual(parseNetstatListeners(out, 18000), [55]);
		assert.deepStrictEqual(
			parseNetstatListeners(out, 8000),
			[],
			'the local-address column must match on the :port boundary',
		);
	});

	test('lsof -t: bare pids, blanks and noise dropped', () => {
		assert.deepStrictEqual(parseLsofListeners('4321\n4321\n\n  8765  \n'), [4321, 8765]);
		assert.deepStrictEqual(parseLsofListeners('lsof: command not found'), []);
	});

	test('ss: pids come out of the users:(( … )) column, for the right port only', () => {
		const out = [
			'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
			'LISTEN 0      2048         0.0.0.0:8000       0.0.0.0:*     users:(("uvicorn",pid=13376,fd=7))',
			'LISTEN 0      4096            [::]:9100          [::]:*     users:(("node",pid=222,fd=20))',
		].join('\n');
		assert.deepStrictEqual(parseSsListeners(out, 8000), [13376]);
		assert.deepStrictEqual(parseSsListeners(out, 9100), [222]);
		assert.deepStrictEqual(parseSsListeners(out, 8080), []);
	});

	test('holders render as something a message can name', () => {
		assert.strictEqual(describeHolders([]), 'no identifiable process');
		assert.strictEqual(describeHolders([{ pid: 7, description: 'python.exe' }]), 'pid 7 (python.exe)');
		assert.strictEqual(
			describeHolders([
				{ pid: 7, description: 'python' },
				{ pid: 9, description: 'node' },
			]),
			'pids 7 (python), 9 (node)',
		);
	});
});

suite('ports: occupancy and relocation', () => {
	test('a listening socket is serving, is not bindable, and is skipped by findFreePort', async () => {
		const server = net.createServer();
		const port: number = await new Promise((resolve) => {
			server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
		});
		try {
			assert.strictEqual(await portIsServing(port), true);
			assert.strictEqual(await portIsBindable(port), false);
			const free = await findFreePort(port);
			assert.ok(free !== null && free > port, 'the relocation candidate skips the taken port');
		} finally {
			await new Promise((r) => server.close(r));
		}
	});

	test('a closed port answers nothing and is offered as free', async () => {
		const server = net.createServer();
		const port: number = await new Promise((resolve) => {
			server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
		});
		await new Promise((r) => server.close(r));
		assert.strictEqual(await portIsServing(port, '127.0.0.1', 300), false);
		assert.strictEqual(await findFreePort(port), port);
	});

	test('reclaiming is on by default and off by env', () => {
		const saved = process.env.VINV_RECLAIM_PORTS;
		try {
			delete process.env.VINV_RECLAIM_PORTS;
			assert.strictEqual(isPortReclaimEnabled(), true);
			process.env.VINV_RECLAIM_PORTS = '0';
			assert.strictEqual(isPortReclaimEnabled(), false);
			process.env.VINV_RECLAIM_PORTS = 'false';
			assert.strictEqual(isPortReclaimEnabled(), false);
			process.env.VINV_RECLAIM_PORTS = '1';
			assert.strictEqual(isPortReclaimEnabled(), true);
		} finally {
			if (saved === undefined) {
				delete process.env.VINV_RECLAIM_PORTS;
			} else {
				process.env.VINV_RECLAIM_PORTS = saved;
			}
		}
	});
});
