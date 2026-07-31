import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import {
	readServices,
	readStartCommands,
	repairRecordedTargetPackages,
	serviceSlug,
	servicePort,
	type StartCommand,
} from './bringup';
import { missingTargetPackage } from './targetPackages';
import { hiddenBackgroundOptions, killProcessTree, resolveBash } from '../proc';
import { findFreePort, reclaimPort } from '../support/ports';

/**
 * Debug type for Vinv services. Running a service as a debug *session* (rather
 * than a bare terminal) is what makes VS Code surface its native debug toolbar —
 * with stop/restart controls and, when several services run at once, the session
 * picker. There is no public API for a custom floating toolbar, so we piggy-back
 * on the real one by registering an inline debug adapter for this type.
 */
const DEBUG_TYPE = 'vinv-service';

/** The launch config we hand to vscode.debug.startDebugging for a service. */
interface VinvDebugConfig extends vscode.DebugConfiguration {
	service: string;
	workspaceRoot: string;
}

/** Active service sessions, keyed by service name, for run-state queries. */
const sessions = new Map<string, vscode.DebugSession>();

/** What a service run left behind when it ended — the auto-trigger evidence. */
export interface ServiceExitEvent {
	service: string;
	workspaceRoot: string;
	exitCode: number | null;
	/** True when the command exited with 0 almost immediately (backgrounding smell). */
	instantExit: boolean;
	/** Last ~4KB of the service's combined output. */
	outputTail: string;
}

type ServiceExitListener = (event: ServiceExitEvent) => void;
const exitListeners = new Set<ServiceExitListener>();

/**
 * Registers a listener for service exits (any exit — listeners decide what
 * counts as a failure). This is the hook the closed-loop harness episodes
 * attach to: a crash can offer (or auto-start) a fix episode with the exit
 * evidence already in hand.
 */
export function onServiceExit(listener: ServiceExitListener): vscode.Disposable {
	exitListeners.add(listener);
	return { dispose: () => exitListeners.delete(listener) };
}

function emitServiceExit(event: ServiceExitEvent): void {
	for (const listener of exitListeners) {
		try {
			listener(event);
		} catch {
			// A faulty listener never breaks the debug adapter.
		}
	}
}

/**
 * Minimal inline Debug Adapter Protocol implementation that runs a service's
 * recorded start command(s) as the "debuggee". It speaks just enough DAP for VS
 * Code to show the session in the debug toolbar and drive it:
 *   - initialize  → advertise restart/terminate support, then `initialized`
 *   - launch      → spawn the command(s); stream stdout/stderr to the Debug Console
 *   - restart     → kill the current process group and re-spawn (toolbar ↻)
 *   - terminate   → kill and end the session (toolbar ◼)
 *   - disconnect  → kill (session teardown)
 * Process exit emits `exited`+`terminated` so the session closes on its own when
 * the server dies. A generation counter invalidates a superseded child's exit
 * handler so a restart's kill doesn't end the new session.
 */
class VinvServiceDebugAdapter implements vscode.DebugAdapter {
	private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage = this.sendEmitter.event;
	private child?: ChildProcess;
	private generation = 0;

	constructor(private readonly config: VinvDebugConfig) {}

	handleMessage(message: vscode.DebugProtocolMessage): void {
		// DebugProtocolMessage is opaque to the editor types; we model the subset
		// of DAP we actually handle.
		const msg = message as { type: string; command?: string };
		if (msg.type !== 'request' || !msg.command) {
			return;
		}
		switch (msg.command) {
			case 'initialize':
				this.respond(msg, {
					supportsRestartRequest: true,
					supportsTerminateRequest: true,
				});
				this.event('initialized');
				break;
			case 'launch':
				void this.launch();
				this.respond(msg);
				break;
			case 'configurationDone':
				this.respond(msg);
				break;
			case 'threads':
				// A single dummy thread keeps clients that probe for threads happy.
				this.respond(msg, { threads: [{ id: 1, name: this.config.service }] });
				break;
			case 'restart':
				this.respond(msg);
				this.kill();
				void this.launch();
				break;
			case 'terminate':
				this.respond(msg);
				this.kill();
				this.event('terminated');
				break;
			case 'disconnect':
				this.respond(msg);
				this.kill();
				break;
			default:
				this.respond(msg);
		}
	}

	dispose(): void {
		this.kill();
	}

	private async launch(): Promise<void> {
		const commands = readStartCommands(this.config.workspaceRoot, this.config.service);
		if (commands.length === 0) {
			this.output('No verified start command. Bring the service up first.\n', 'stderr');
			this.event('terminated');
			return;
		}
		// Earlier entries are usually detached dependency starts (e.g. `docker
		// compose up -d`) that return immediately; the final entry is the
		// long-running server. Chaining with `&&` in one shell preserves that order
		// and leaves the server in the foreground so its exit ends the session.
		const script = commands
			.map((c) =>
				c.working_directory
					? `cd ${JSON.stringify(c.working_directory)} && ${c.command}`
					: c.command,
			)
			.join(' && ');

		const bash = resolveBash();
		if (!bash) {
			this.output(
				process.platform === 'win32'
					? 'No bash found to run the start command. Install Git for Windows ' +
						'(https://git-scm.com/download/win) — its bundled bash is required ' +
						'to run recorded start commands.\n'
					: 'No bash found to run the start command. Install bash and ensure ' +
						'it is on PATH.\n',
				'stderr',
			);
			this.event('terminated');
			return;
		}
		const gen = ++this.generation;
		// The port comes back BEFORE the bind is attempted. A recorded command
		// binds a fixed port, so a survivor of an earlier run (on Windows, the
		// reparented subtree the Git-Bash stub leaves behind) makes this launch
		// die with "address already in use" — a failure of the machine's state,
		// not of the service, and one the user can do nothing about from here.
		await this.reclaimRecordedPort();
		if (gen !== this.generation) {
			return; // stopped or restarted while we were freeing the port
		}
		const launchedAt = Date.now();
		// Rolling tail of combined output — the failure evidence a harness
		// episode gets when this run dies.
		let outputTail = '';
		const absorbTail = (chunk: string): void => {
			outputTail = (outputTail + chunk).slice(-4000);
		};
		const child = spawn(bash, ['-lc', script], hiddenBackgroundOptions({
			cwd: commands[0].working_directory ?? this.config.workspaceRoot,
			env: process.env,
		}));
		this.child = child;
		this.event('process', { name: this.config.service, systemProcessId: child.pid });
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (c: string) => {
			absorbTail(c);
			this.output(c, 'stdout');
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (c: string) => {
			absorbTail(c);
			this.output(c, 'stderr');
		});
		child.on('error', (err) => {
			if (gen !== this.generation) {
				return;
			}
			this.output(`Failed to start: ${err.message}\n`, 'stderr');
			this.event('terminated');
		});
		child.on('exit', (code) => {
			// The recorded command is contractually a foreground server, but a
			// malformed one (trailing `&`) can background the real process and let
			// bash exit instantly — reap the whole group so nothing survives as an
			// orphan squatting the service's port for the next launch.
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch {
					// Group already empty — the normal foreground case.
				}
			}
			// Ignore the exit of a child we deliberately superseded (restart/stop).
			if (gen !== this.generation) {
				return;
			}
			const instantExit = code === 0 && Date.now() - launchedAt < 5000;
			if (instantExit) {
				this.output(
					'Start command exited immediately with code 0 — it likely backgrounds ' +
						"itself (trailing '&' or 'nohup'). Re-run the service's setup so " +
						'bring-up records a foreground start command.\n',
					'stderr',
				);
			}
			this.output(`\n[${this.config.service}] exited with code ${code ?? 'null'}\n`, 'console');
			// Outcome only — never the output tail, which is the client's own
			// application output (kept local for the episode evidence).
			this.event('exited', { exitCode: code ?? 0 });
			this.event('terminated');
			// A self-terminated run (not a deliberate stop — those bump the
			// generation first) is auto-trigger evidence for a fix episode.
			emitServiceExit({
				service: this.config.service,
				workspaceRoot: this.config.workspaceRoot,
				exitCode: code,
				instantExit,
				outputTail,
			});
		});
	}

	/**
	 * Gets this service's recorded port back before the start command binds it.
	 *
	 * Never blocks the launch: a port we could not free is reported with the
	 * holder's pid and the next free port, and the command still runs — the
	 * server's own bind error is the ground truth, and refusing to start
	 * because `netstat` said something we did not understand would be a worse
	 * failure than the one this exists to prevent.
	 */
	private async reclaimRecordedPort(): Promise<void> {
		const port = servicePort(this.config.workspaceRoot, this.config.service);
		if (port === null) {
			return;
		}
		let outcome;
		try {
			outcome = await reclaimPort(port);
		} catch {
			return; // diagnosis is a courtesy; never let it break a launch
		}
		if (!outcome.wasServing) {
			return;
		}
		if (outcome.freed) {
			this.output(
				`[vinv] ${outcome.detail} — that was a leftover holder of ${this.config.service}'s ` +
					'port; starting fresh.\n',
				'console',
			);
			return;
		}
		const free = await findFreePort(port + 1);
		this.output(
			`[vinv] ${outcome.detail}. Starting anyway — if this exits with "address already in ` +
				`use", either stop that process or move ${this.config.service} to a free port` +
				(free !== null ? ` (e.g. ${free})` : '') +
				`, updating .vinv/services.json and .vinv/start_commands/${serviceSlug(this.config.service)}.json together.\n`,
			'stderr',
		);
	}

	/** Kills the current process group and invalidates its exit handler. */
	private kill(): void {
		const child = this.child;
		this.child = undefined;
		this.generation++; // stale-out the outgoing child's exit/error handlers
		if (!child || child.pid === undefined) {
			return;
		}
		killProcessTree(child, 'SIGTERM');
	}

	private respond(request: { command?: string }, body?: unknown): void {
		const req = request as { seq: number; command: string };
		this.sendEmitter.fire({
			type: 'response',
			request_seq: req.seq,
			success: true,
			command: req.command,
			body,
		} as unknown as vscode.DebugProtocolMessage);
	}

	private event(event: string, body?: unknown): void {
		this.sendEmitter.fire({
			type: 'event',
			event,
			body,
		} as unknown as vscode.DebugProtocolMessage);
	}

	private output(text: string, category: 'stdout' | 'stderr' | 'console'): void {
		this.event('output', { category, output: text });
	}
}

/** Supplies an inline adapter instance for each `vinv-service` debug session. */
class VinvServiceAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(
		session: vscode.DebugSession,
	): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(
			new VinvServiceDebugAdapter(session.configuration as VinvDebugConfig),
		);
	}
}

/**
 * Registers the service debug adapter and tracks live sessions. Must be called
 * once during activation. With the factory registered, starting a service spins
 * up a real debug session, so VS Code shows its native debug toolbar (stop /
 * restart / session picker) — the multi-service "running" UI the user wants.
 */
export function initServiceRunner(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory(
			DEBUG_TYPE,
			new VinvServiceAdapterFactory(),
		),
		vscode.debug.onDidStartDebugSession((s) => {
			if (s.type === DEBUG_TYPE) {
				sessions.set((s.configuration as VinvDebugConfig).service, s);
			}
		}),
		vscode.debug.onDidTerminateDebugSession((s) => {
			if (s.type === DEBUG_TYPE) {
				sessions.delete((s.configuration as VinvDebugConfig).service);
			}
		}),
	);
}

/**
 * Runs a service's verified start command(s) as a debug session — the "play" step
 * of the debug-style flow. If the service is already running, its session is
 * focused instead of launching a duplicate. Returns false when nothing is
 * recorded yet (bring the service up first).
 */
/** Services already warned about this session — one notice, not one per start. */
const staleTargetWarned = new Set<string>();

/**
 * Tells the user when the recorded command instruments the wrong package, and
 * offers the one action that repairs it (re-running bring-up re-records it).
 */
function warnOnStaleTargetPackage(
	workspaceRoot: string,
	service: string,
	commands: StartCommand[],
): void {
	if (staleTargetWarned.has(service)) {
		return;
	}
	const entry = readServices(workspaceRoot).find((s) => s.name === service);
	if (!entry) {
		return;
	}
	const missing = commands
		.map((c) => missingTargetPackage(c.command, entry))
		.find((m): m is string => !!m);
	if (!missing) {
		return;
	}
	staleTargetWarned.add(service);
	// Repaired, not merely reported. This run is the one the user asked for, and
	// starting it under the wrong target package wastes it — the capture would
	// hold inbound spans and no application frames, which every surface
	// downstream reads as 0% coverage on a healthy service.
	const added = repairRecordedTargetPackages(workspaceRoot, entry);
	void vscode.window.showWarningMessage(
		added
			? `Vinv: ${service}'s recorded start command left out its own package '${added}' — its ` +
					'handlers would have produced no spans. Corrected before starting, so this run ' +
					'traces its own code.'
			: `Vinv: ${service} is about to be traced without its own package '${missing}', so its ` +
					'handlers will produce no spans. The recorded command could not be corrected ' +
					`automatically — add '--target-package ${missing}' to ` +
					`.vinv/start_commands/${serviceSlug(service)}.json.`,
	);
}

export function startService(workspaceRoot: string, service: string): boolean {
	if (sessions.has(service)) {
		// Already running — its session is in the toolbar; don't launch a duplicate.
		return true;
	}
	const commands = readStartCommands(workspaceRoot, service);
	if (commands.length === 0) {
		void vscode.window.showWarningMessage(
			`Vinv: No verified start command for ${service}. Bring it up first.`,
		);
		return false;
	}
	// The recorded command is replayed verbatim, so a stale `--target-package`
	// survives every later fix: the service comes up green and traces none of its
	// own code, which downstream reads as 0% coverage rather than as a defect.
	// Warn rather than block — the run is still useful, and re-recording the
	// command means re-running bring-up, which is the user's call.
	warnOnStaleTargetPackage(workspaceRoot, service, commands);
	const config: VinvDebugConfig = {
		type: DEBUG_TYPE,
		name: `Vinv: ${service}`,
		request: 'launch',
		service,
		workspaceRoot,
	};
	// suppressDebugView keeps the user on the Vinv sidebar instead of switching
	// focus to the Run and Debug view; the floating debug toolbar (stop/restart)
	// still appears, which is the part we actually want.
	void vscode.debug.startDebugging(
		vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspaceRoot)),
		config,
		{ suppressDebugView: true },
	);
	return true;
}

/** Stops a running service by ending its debug session. */
export function stopService(name: string): void {
	const session = sessions.get(name);
	if (session) {
		void vscode.debug.stopDebugging(session);
	}
}

/** True when a service has a live debug session. */
export function isServiceRunning(name: string): boolean {
	return sessions.has(name);
}

/** Names of all currently-running services. */
export function runningServiceNames(): string[] {
	return [...sessions.keys()];
}
