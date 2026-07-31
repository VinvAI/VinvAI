/**
 * Ports: who is holding one, how to get it back, and where to move if we cannot.
 *
 * Every surface that starts a service replays a command that BINDS a fixed port
 * — the Run button, the episode-loop replay oracle, the probe runner, bring-up's
 * own replay gate. When a previous run survived its teardown (the recurring
 * Windows case: the Git-Bash launcher stub exits, its real subtree is reparented
 * and keeps the socket), every one of those fails with "address already in use",
 * and the failure is reported as if the FIX were broken. It is not: the port is
 * simply occupied.
 *
 * So a busy port is treated as a recoverable condition with two ordered
 * remedies, in the order a person would try them:
 *
 *   1. RECLAIM — find the listening pid and kill it. The port is the one this
 *      workspace's own inventory assigns to this service, and whatever is
 *      sitting on it is blocking the run the user just asked for.
 *   2. RELOCATE — when the holder cannot be killed (another user's process, a
 *      protected service), report the pid and offer the next free port, so the
 *      caller can move the service instead of failing.
 *
 * Reclaiming kills a process, so it is never silent: every call reports which
 * pids it killed and how it identified them, and `VINV_RECLAIM_PORTS=0` turns
 * the killing off entirely, leaving the diagnosis (who holds the port) intact.
 *
 * vscode-free and pure where it counts: the three listener probes are parsed by
 * exported pure functions, because the parsing — not the spawning — is what
 * silently breaks between platforms and OS versions.
 */

import { execFile } from 'child_process';
import * as net from 'net';

/** One process found holding a port. */
export interface PortHolder {
	pid: number;
	/** Executable name or full command line, as far as the platform will say. */
	description: string;
}

/** What one reclaim attempt did. */
export interface PortReclaim {
	port: number;
	/** True when something answered on the port before we touched anything. */
	wasServing: boolean;
	/** True when nothing is serving the port any more (including "never was"). */
	freed: boolean;
	/** Processes actually killed. */
	killed: PortHolder[];
	/** Holders found but left alive (kill refused, or reclaiming disabled). */
	survivors: PortHolder[];
	/** One line naming what happened, suitable for a message or a log. */
	detail: string;
}

/** Reclaiming is on unless explicitly disabled — see the module doc. */
export function isPortReclaimEnabled(): boolean {
	const raw = (process.env.VINV_RECLAIM_PORTS ?? '').trim().toLowerCase();
	return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/**
 * One TCP connect to `host:port` — the same liveness check every caller used to
 * carry its own copy of.
 */
export function portIsServing(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port, timeout: timeoutMs });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		const fail = (): void => {
			socket.destroy();
			resolve(false);
		};
		socket.once('error', fail);
		socket.once('timeout', fail);
	});
}

/** Runs a command, returning its stdout — never throws, never rejects. */
function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
	return new Promise((resolve) => {
		try {
			execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (_err, stdout) => {
				resolve(String(stdout ?? ''));
			});
		} catch {
			resolve('');
		}
	});
}

/**
 * LISTENING pids for `port` from `netstat -ano` output (Windows).
 *
 * Matched on the local-address column ending in `:<port>` so both `0.0.0.0:8000`
 * and `[::]:8000` are found: a server bound on IPv6 only is invisible to a
 * v4-address match, and that is exactly the case that leaves a "free" port
 * refusing to bind.
 */
export function parseNetstatListeners(stdout: string, port: number): number[] {
	const pids = new Set<number>();
	for (const line of stdout.split(/\r?\n/)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') {
			continue;
		}
		if (!parts[1].endsWith(`:${port}`) || parts[3].toUpperCase() !== 'LISTENING') {
			continue;
		}
		const pid = Number(parts[4]);
		if (Number.isInteger(pid) && pid > 0) {
			pids.add(pid);
		}
	}
	return [...pids];
}

/** Pids from `lsof -t` output (one bare pid per line). */
export function parseLsofListeners(stdout: string): number[] {
	const pids = new Set<number>();
	for (const line of stdout.split(/\r?\n/)) {
		const pid = Number(line.trim());
		if (Number.isInteger(pid) && pid > 0) {
			pids.add(pid);
		}
	}
	return [...pids];
}

/** Pids from `ss -ltnp` output, which spells them `users:(("uvicorn",pid=123,fd=7))`. */
export function parseSsListeners(stdout: string, port: number): number[] {
	const pids = new Set<number>();
	for (const line of stdout.split(/\r?\n/)) {
		if (!new RegExp(`[:.]${port}\\b`).test(line)) {
			continue;
		}
		for (const m of line.matchAll(/pid=(\d+)/g)) {
			const pid = Number(m[1]);
			if (Number.isInteger(pid) && pid > 0) {
				pids.add(pid);
			}
		}
	}
	return [...pids];
}

/**
 * Pids LISTENING on `port`, best effort.
 *
 * POSIX tries `lsof` then `ss`, because neither is guaranteed present: minimal
 * containers ship iproute2 without lsof, and macOS ships lsof without ss. An
 * empty result means "could not tell", never "nothing is there" — callers must
 * keep the port probe as the source of truth about occupancy.
 */
export async function listeningPids(port: number): Promise<number[]> {
	if (process.platform === 'win32') {
		return parseNetstatListeners(await run('netstat', ['-ano']), port);
	}
	const lsof = parseLsofListeners(
		await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']),
	);
	if (lsof.length > 0) {
		return lsof;
	}
	return parseSsListeners(await run('ss', ['-ltnp']), port);
}

/** Executable name (Windows) or full argv (POSIX) for a pid; '' when unknown. */
export async function describePid(pid: number): Promise<string> {
	if (process.platform === 'win32') {
		const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
		const first = out.split(/\r?\n/).find((l) => l.trim().startsWith('"'));
		return first ? (first.split('","')[0] ?? '').replace(/^"|"$/g, '') : '';
	}
	return (await run('ps', ['-p', String(pid), '-o', 'args='])).trim().split('\n')[0] ?? '';
}

/**
 * Kills a pid and the tree under it. Windows has no process groups, so the
 * whole tree goes through `taskkill /T /F`; POSIX asks politely first, because
 * a server that gets SIGTERM closes its socket immediately, while SIGKILL can
 * leave the port in a state where the next bind still trips over it.
 */
export async function killPid(pid: number): Promise<void> {
	if (process.platform === 'win32') {
		await run('taskkill', ['/PID', String(pid), '/T', '/F']);
		return;
	}
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		return; // already gone
	}
	await new Promise((r) => setTimeout(r, 1500));
	try {
		process.kill(pid, 0); // still alive?
		process.kill(pid, 'SIGKILL');
	} catch {
		// exited on the TERM — the good case
	}
}

/** Holders of `port` with their descriptions, for a message or a decision. */
export async function portHolders(port: number): Promise<PortHolder[]> {
	const pids = (await listeningPids(port)).filter((pid) => pid !== process.pid);
	return Promise.all(
		pids.map(async (pid) => ({ pid, description: (await describePid(pid)) || 'unknown process' })),
	);
}

/**
 * Frees `port` by killing whatever is listening on it, then waits for the port
 * to stop answering.
 *
 * The wait matters: `taskkill` returns as soon as the kill is *requested*, and
 * a caller that binds immediately after still loses the race with the dying
 * socket. Returns freed=false rather than throwing — a caller that cannot get
 * its port back has a second remedy (`findFreePort`) and a report to make.
 */
export async function reclaimPort(port: number, waitMs = 8000): Promise<PortReclaim> {
	const base: PortReclaim = {
		port,
		wasServing: false,
		freed: true,
		killed: [],
		survivors: [],
		detail: `port ${port} was free`,
	};
	if (!(await portIsServing(port))) {
		return base;
	}
	base.wasServing = true;
	const holders = await portHolders(port);
	if (!isPortReclaimEnabled()) {
		return {
			...base,
			freed: false,
			survivors: holders,
			detail:
				`port ${port} is held by ${describeHolders(holders)} and automatic reclaiming is off ` +
				'(VINV_RECLAIM_PORTS=0) — stop that process, or move the service to another port',
		};
	}
	if (holders.length === 0) {
		return {
			...base,
			freed: false,
			detail:
				`port ${port} is serving but no listening pid could be identified ` +
				`(${process.platform === 'win32' ? 'netstat' : 'lsof/ss'} reported none) — ` +
				'it may belong to another user, a container, or WSL',
		};
	}
	for (const holder of holders) {
		await killPid(holder.pid);
	}
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (!(await portIsServing(port))) {
			return {
				...base,
				freed: true,
				killed: holders,
				detail: `freed port ${port} by killing ${describeHolders(holders)}`,
			};
		}
		if (Date.now() >= deadline) {
			return {
				...base,
				freed: false,
				survivors: holders,
				detail:
					`port ${port} is still serving ${(waitMs / 1000).toFixed(0)}s after killing ` +
					`${describeHolders(holders)} — the holder survived the kill, or another process ` +
					'took the port immediately',
			};
		}
		await new Promise((r) => setTimeout(r, 300));
	}
}

/** "pid 1234 (python.exe)" / "pids 1234 (python), 5678 (node)" for a message. */
export function describeHolders(holders: PortHolder[]): string {
	if (holders.length === 0) {
		return 'no identifiable process';
	}
	const listed = holders.map((h) => `${h.pid} (${h.description})`).join(', ');
	return `${holders.length === 1 ? 'pid' : 'pids'} ${listed}`;
}

/** True when nothing can bind `port` — checked by binding, not by connecting. */
export function portIsBindable(port: number, host = '127.0.0.1'): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => server.close(() => resolve(true)));
		try {
			server.listen(port, host);
		} catch {
			resolve(false);
		}
	});
}

/**
 * The first bindable port at or above `preferred` — the relocation remedy when
 * a port cannot be reclaimed. Bind-tested rather than connect-tested: a socket
 * in TIME_WAIT, or one bound to a different interface, refuses a bind while
 * answering no connection, and offering such a port as "free" only moves the
 * failure one step later.
 */
export async function findFreePort(preferred: number, tries = 64): Promise<number | null> {
	for (let port = preferred; port < preferred + tries && port < 65536; port++) {
		if (await portIsBindable(port)) {
			return port;
		}
	}
	return null;
}
