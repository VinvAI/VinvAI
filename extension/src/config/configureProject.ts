import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { VINV_BASE_CSS, VINV_FONT_SERIF } from '../views/webviewTheme';
import {
	getHarnessId,
	setHarnessId,
	isAutoDiscoverEnabled,
	setAutoDiscoverEnabled,
	isAutoEpisodesEnabled,
	setAutoEpisodesEnabled,
	isAutoPilotEnabled,
	setAutoPilotEnabled,
	isAcceptanceTestsEnabled,
	setAcceptanceTestsEnabled,
	isMcpEnabled,
	setMcpEnabled,
} from './settings';
import {
	HARNESSES,
	canInstallHarness,
	checkAllHarnesses,
	quickScanHarnesses,
	startHarnessInstall,
} from '../harness/harnessRunner';
import { maybeAutoDiscover } from '../index/discovery';
import {
	detectTargets,
	registerDetectedTargets,
	unregisterAllTargets,
} from '../mcp/mcpRegistrar';

interface InboundMessage {
	type:
		| 'saveHarness'
		| 'toggleMcp'
		| 'toggleAutoDiscover'
		| 'toggleAutoPilot'
		| 'toggleAutoEpisodes'
		| 'toggleAcceptanceTests'
		| 'checkHarnesses'
		| 'installHarness'
		| 'installEngines';
	enabled?: boolean;
	harnessId?: string;
}

export function openConfigureForm(context: vscode.ExtensionContext): void {
	const panel = vscode.window.createWebviewPanel(
		'vinv.configure',
		'Configure Vinv Project',
		vscode.ViewColumn.Active,
		{ enableScripts: true },
	);

	const folder = vscode.workspace.workspaceFolders?.[0];
	const detected = folder ? detectTargets(folder.uri.fsPath).map((t) => t.label) : [];
	const mcp = {
		supported: detected.length > 0,
		enabled: isMcpEnabled(),
		clients: detected,
	};
	const harnesses = HARNESSES.map((h) => ({
		id: h.id,
		label: h.label,
		installCommand: h.installCommand,
		postInstall: h.postInstall,
		installable: canInstallHarness(h),
	}));
	const nonce = crypto.randomBytes(16).toString('base64');
	panel.webview.html = getFormHtml(
		getHarnessId(),
		harnesses,
		mcp,
		isAutoDiscoverEnabled(),
		isAutoPilotEnabled(),
		isAutoEpisodesEnabled(),
		isAcceptanceTestsEnabled(),
		panel.webview.cspSource,
		nonce,
	);

	// Availability sweep across every harness: resolves each CLI on PATH +
	// well-known install dirs (with a version probe), so the dropdown can label
	// options installed/not-installed and the guide can react to the selection.
	let lastQuickScan = '';
	const postHarnessSweep = async (): Promise<void> => {
		lastQuickScan = JSON.stringify(quickScanHarnesses());
		const results = await checkAllHarnesses();
		void panel.webview.postMessage({ type: 'harnesses', results });
	};
	// The one-shot sweep goes stale the moment the user installs a CLI with the
	// panel open ("but I just installed claude!"). Poll cheaply (fs stats only)
	// while the panel is visible and re-run the full sweep only on a change; also
	// re-check whenever the panel regains visibility.
	const pollTimer = setInterval(() => {
		if (!panel.visible) {
			return;
		}
		const quick = JSON.stringify(quickScanHarnesses());
		if (quick !== lastQuickScan) {
			void postHarnessSweep();
		}
	}, 5000);
	panel.onDidChangeViewState(
		(e) => {
			if (e.webviewPanel.visible) {
				void postHarnessSweep();
			}
		},
		undefined,
		context.subscriptions,
	);
	panel.onDidDispose(() => clearInterval(pollTimer), undefined, context.subscriptions);

	panel.webview.onDidReceiveMessage(
		async (message: InboundMessage) => {
			switch (message.type) {
				case 'saveHarness': {
					if (message.harnessId) {
						setHarnessId(message.harnessId);
						void vscode.window.showInformationMessage('Vinv: Configuration saved.');
						// Kick off discovery now that the harness is chosen. maybeAutoDiscover
						// self-gates: it only runs when auto-discover is on, a folder is
						// open, and the project isn't already discovered.
						void maybeAutoDiscover(context);
					}
					return;
				}

				case 'checkHarnesses': {
					await postHarnessSweep();
					return;
				}

				case 'installHarness': {
					// Fire-and-forget: the visible-panel quick-scan poll notices the
					// CLI/extension appearing and re-runs the full sweep, which flips
					// the option into the installed group and clears the guide.
					const h = HARNESSES.find((x) => x.id === message.harnessId);
					if (h && canInstallHarness(h)) {
						startHarnessInstall(h);
					}
					return;
				}

				case 'installEngines': {
					void vscode.commands.executeCommand('vinv-vs.installEngines');
					return;
				}

				case 'toggleAutoDiscover': {
					await setAutoDiscoverEnabled(!!message.enabled);
					void panel.webview.postMessage({ type: 'autoDiscover', enabled: !!message.enabled });
					return;
				}

				case 'toggleAutoPilot': {
					await setAutoPilotEnabled(!!message.enabled);
					void panel.webview.postMessage({ type: 'autoPilot', enabled: !!message.enabled });
					return;
				}

				case 'toggleAutoEpisodes': {
					await setAutoEpisodesEnabled(!!message.enabled);
					void panel.webview.postMessage({ type: 'autoEpisodes', enabled: !!message.enabled });
					return;
				}

				case 'toggleAcceptanceTests': {
					await setAcceptanceTestsEnabled(!!message.enabled);
					void panel.webview.postMessage({
						type: 'acceptanceTests',
						enabled: !!message.enabled,
					});
					return;
				}

				case 'toggleMcp': {
					if (!folder) {
						void panel.webview.postMessage({ type: 'mcp', enabled: false });
						return;
					}
					await setMcpEnabled(!!message.enabled);
					if (message.enabled) {
						const outcomes = registerDetectedTargets(context, folder.uri.fsPath);
						if (outcomes.length) {
							const labels = outcomes.map((o) => o.label).join(', ');
							void vscode.window.showInformationMessage(
								`Vinv: Registered MCP servers for ${labels}. Reload the agent to load them.`,
							);
						} else {
							void vscode.window.showInformationMessage(
								'Vinv: No agent tools detected to register (looked for Cursor, Claude Code, VS Code, Codex).',
							);
						}
						void panel.webview.postMessage({ type: 'mcp', enabled: true });
					} else {
						unregisterAllTargets(folder.uri.fsPath);
						void panel.webview.postMessage({ type: 'mcp', enabled: false });
					}
					return;
				}
			}
		},
		undefined,
		context.subscriptions,
	);
}

function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function getFormHtml(
	selectedHarness: string,
	harnesses: Array<{
		id: string;
		label: string;
		installCommand: string | null;
		postInstall: string;
		installable: boolean;
	}>,
	mcp: { supported: boolean; enabled: boolean; clients: string[] },
	autoDiscover: boolean,
	autoPilot: boolean,
	autoEpisodes: boolean,
	acceptanceTests: boolean,
	cspSource: string,
	nonce: string,
): string {
	const clientList = mcp.clients.length ? mcp.clients.join(', ') : 'detected agent tools';
	const csp = [
		`default-src 'none'`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		`img-src ${cspSource}`,
	].join('; ');
	const harnessOptions = harnesses
		.map((h) => `<option value="${esc(h.id)}"${selectedHarness === h.id ? ' selected' : ''}>${esc(h.label)}</option>`)
		.join('');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Configure Vinv Project</title>
	<style>
		${VINV_BASE_CSS}
		html, body { height: 100%; }
		body { font-size: 12px; }
		.layout { display: flex; min-height: 100vh; position: relative; z-index: 1; }
		nav { flex: none; width: 210px; padding: 24px 14px; border-right: 1px solid var(--line); box-sizing: border-box; }
		nav .brand {
			display: flex; align-items: center; gap: 8px;
			font-size: 11px; font-weight: 600; letter-spacing: 0.24em; text-transform: uppercase;
			padding: 0 10px 18px; color: var(--ink);
		}
		nav .brand::before {
			content: ''; width: 7px; height: 7px; border-radius: 50%; flex: none;
			background: var(--accent); box-shadow: 0 0 0 4px rgba(215, 25, 33, 0.18);
			animation: v-pulse 2.4s ease-in-out infinite;
		}
		.tab {
			display: block; width: 100%; text-align: left; padding: 8px 10px;
			border: none; border-left: 2px solid transparent; border-radius: 0;
			background: transparent; color: var(--muted); cursor: pointer; margin-bottom: 2px;
			font-family: inherit; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase;
			transition: color 0.2s, border-color 0.2s;
		}
		.tab:hover { color: var(--ink); }
		.tab.active { border-left-color: var(--accent); color: var(--ink); background: var(--bg-2); }
		main { flex: 1; padding: 32px 36px; min-width: 0; }
		.pane { display: none; max-width: 760px; }
		.pane.active { display: block; }
		h2 {
			font-family: ${VINV_FONT_SERIF}; font-style: italic; font-weight: 400;
			font-size: 30px; line-height: 1.05; letter-spacing: -0.01em; margin: 0 0 8px;
		}
		h3 {
			font-size: 10px; font-weight: 400; letter-spacing: 0.26em; text-transform: uppercase;
			color: var(--muted); margin: 32px 0 6px; padding-top: 12px;
			border-top: 1px solid var(--ink); display: inline-block;
		}
		h3::before { content: '// '; color: var(--accent); }
		p.lead { color: var(--muted); margin: 0 0 24px; font-size: 12px; line-height: 1.7; }
		p.sub { color: var(--muted); margin: 0 0 12px; font-size: 11.5px; line-height: 1.7; }
		label { display: block; font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--muted); margin: 18px 0 6px; }
		select {
			width: 100%; box-sizing: border-box; padding: 8px 10px;
			background: var(--bg); color: var(--ink);
			border: 1px solid var(--line-strong); border-radius: 0;
			font-family: inherit; font-size: 12px; cursor: pointer;
			transition: border-color 0.2s;
		}
		select:hover { border-color: var(--ink); }
		select:focus { outline: none; border-color: var(--accent); }
		button {
			padding: 10px 20px; border-radius: 0; cursor: pointer;
			font-family: inherit; font-size: 10px; font-weight: 500;
			letter-spacing: 0.22em; text-transform: uppercase;
			transition: background 0.2s, color 0.2s, border-color 0.2s, letter-spacing 0.25s;
		}
		button.primary { background: var(--ink); color: var(--bg); border: 1px solid var(--ink); }
		button.primary:hover { background: var(--accent); border-color: var(--accent); color: #ffffff; }
		button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line-strong); }
		button.secondary:hover { border-color: var(--ink); letter-spacing: 0.26em; }
		button:disabled { opacity: 0.5; cursor: default; }
		.row { display: flex; align-items: center; gap: 12px; margin-top: 20px; }
		.help { color: var(--muted-2); margin: 6px 0 0; font-size: 11px; line-height: 1.6; }
		.eg { color: var(--muted); }
		.status { font-size: 11px; margin: 12px 0 0; min-height: 16px; color: var(--muted); }
		.status.err { color: var(--accent); }
		.toggle { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
		.toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
		.track {
			width: 34px; height: 18px; border-radius: 0;
			background: var(--bg-2); border: 1px solid var(--line-strong);
			position: relative; transition: background 0.15s ease, border-color 0.15s ease; flex: none;
			box-sizing: border-box;
		}
		.track::after {
			content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
			border-radius: 0; background: var(--muted); transition: transform 0.15s ease, background 0.15s ease;
		}
		.toggle input:checked + .track { background: var(--ink); border-color: var(--ink); }
		.toggle input:checked + .track::after { transform: translateX(16px); background: var(--bg); }
		.toggle input:focus-visible + .track { outline: 1px solid var(--accent); outline-offset: 2px; }
		.guide { margin-top: 14px; padding: 14px 16px; border: 1px dashed var(--line-strong); }
		.guide .guide-title { font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
		.guide pre {
			margin: 0 0 8px; padding: 10px 12px; overflow-x: auto;
			background: var(--bg-2); border: 1px solid var(--line);
			font-family: inherit; font-size: 12px; color: var(--ink);
		}
	</style>
</head>
<body>
	<div class="layout">
		<nav>
			<div class="brand">Configure Vinv</div>
			<button class="tab active" data-tab="agent">Coding Agent</button>
			<button class="tab" data-tab="settings">Settings</button>
		</nav>

		<main>
			<section class="pane active" id="pane-agent">
				<h2>Coding Agent</h2>
				<p class="lead">Vinv sends its analysis instructions (project handbook, service bring-up, fix episodes) to a coding agent CLI you already use — no API keys, no extra spend. Code search runs on a local embedding model.</p>

				<h3>Harness</h3>
				<label for="harness">Coding harness</label>
				<select id="harness">${harnessOptions}</select>
				<p class="status" id="harness-status"></p>
				<div class="guide" id="harness-guide" style="display:none;">
					<p class="guide-title" id="guide-title">How to install</p>
					<pre id="guide-cmd"></pre>
					<p class="help" id="guide-note"></p>
					<div class="row" style="margin-top:12px;">
						<button type="button" class="primary" id="harness-install" style="display:none;">Install it for me</button>
						<button type="button" class="secondary" id="harness-recheck">I installed it — re-check</button>
					</div>
				</div>
				<p class="help">Vinv renders its instructions and sends them to this agent, then waits for the deliverables (<span class="eg">.vinv/vinv.md</span>, <span class="eg">services.json</span>, start commands). The CLI must be installed and signed in.</p>

				<div class="row">
					<button type="button" class="primary" id="save-btn">Save configuration</button>
				</div>
			</section>

			<section class="pane" id="pane-settings">
				<h2>Settings</h2>
				<p class="lead">Control how Vinv behaves for this and future workspaces.</p>

				<h3>Automatic discovery</h3>
				<p class="sub">When enabled, Vinv indexes a workspace automatically as soon as it opens. Already-discovered projects are skipped.</p>
				<label class="toggle">
					<input type="checkbox" id="auto-toggle" ${autoDiscover ? 'checked' : ''} />
					<span class="track"></span>
					<span id="auto-label">${autoDiscover ? 'Auto-discover on (runs on open)' : 'Auto-discover off (manual only)'}</span>
				</label>

				<h3>Auto-Pilot</h3>
				<p class="sub">After discovery lists the services, Auto-Pilot drives everything to green on its own: set up each service, run it under tracing, verify it serves, and dispatch fix episodes when a step fails — retrying within a per-service budget. Turn this off to use the manual per-service buttons instead.</p>
				<label class="toggle">
					<input type="checkbox" id="pilot-toggle" ${autoPilot ? 'checked' : ''} />
					<span class="track"></span>
					<span id="pilot-label">${autoPilot ? 'Auto-Pilot on (drives to green after discovery)' : 'Auto-Pilot off (manual per-service setup)'}</span>
				</label>

				<h3>Fix episodes</h3>
				<p class="sub">When a traced service fails, Vinv composes a context pack and dispatches it to your coding harness automatically. Turn this off to approve each dispatch first.</p>
				<label class="toggle">
					<input type="checkbox" id="episodes-toggle" ${autoEpisodes ? 'checked' : ''} />
					<span class="track"></span>
					<span id="episodes-label">${autoEpisodes ? 'Auto-dispatch on (fixes start on failure)' : 'Auto-dispatch off (asks before each fix)'}</span>
				</label>

				<h3>Acceptance tests</h3>
				<p class="sub">Episodes generate agent-invisible acceptance tests as an objective oracle: the fix must flip them from fail to pass. Turn this off to skip the extra generation dispatch.</p>
				<label class="toggle">
					<input type="checkbox" id="acceptance-toggle" ${acceptanceTests ? 'checked' : ''} />
					<span class="track"></span>
					<span id="acceptance-label">${acceptanceTests ? 'Acceptance tests on (fail-to-pass gated)' : 'Acceptance tests off'}</span>
				</label>

				<div id="mcp-section" style="display:${mcp.supported ? 'block' : 'none'};">
					<h3>Agent Integration</h3>
					<p class="sub">Register Vinv's code-search and runtime-observation tools into the agent tools detected on this machine: ${esc(clientList)}. Registration is idempotent and applies to this and future workspaces.</p>
					<label class="toggle">
						<input type="checkbox" id="mcp-toggle" ${mcp.enabled ? 'checked' : ''} />
						<span class="track"></span>
						<span id="mcp-label">${mcp.enabled ? `Registered for ${esc(clientList)}` : 'Not registered'}</span>
					</label>
				</div>

				<h3>Engines</h3>
				<p class="sub">The open-source Vinv engines (tracer, indexer, analysis agents) run from a local checkout. Re-run the installer to update or repair them.</p>
				<div class="row" style="margin-top:8px;">
					<button type="button" class="secondary" id="engines-install">Install / update engines</button>
				</div>
			</section>
		</main>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const mcpClientList = ${JSON.stringify(clientList)};
		const harnesses = ${JSON.stringify(harnesses)};

		const $ = (id) => document.getElementById(id);

		// Probe every harness CLI once on open, so missing installs show up right
		// here in the form — installed/not-installed labels on each option plus an
		// install guide for the selection — not as a failure when discovery runs.
		const harnessStatus = $('harness-status');
		const harnessSel = $('harness');
		let harnessAvail = null; // id → {ok, detail}, filled by the extension's sweep
		function requestHarnessCheck() {
			harnessStatus.className = 'status';
			harnessStatus.textContent = 'Checking installed CLIs…';
			vscode.postMessage({ type: 'checkHarnesses' });
		}
		function harnessMeta(id) { return harnesses.find((h) => h.id === id); }
		let harnessInstalling = null; // id of the harness whose install we kicked off
		function renderHarnessStatus() {
			const meta = harnessMeta(harnessSel.value);
			const avail = harnessAvail && harnessAvail[harnessSel.value];
			const guide = $('harness-guide');
			if (!avail) {
				guide.style.display = 'none';
				return; // sweep still in flight — status already says "Checking…"
			}
			if (avail.ok) {
				harnessStatus.className = 'status';
				harnessStatus.textContent = avail.detail;
				guide.style.display = 'none';
				return;
			}
			const installable = !!(meta && meta.installable);
			const showCmd = !!(meta && meta.installCommand);
			const installingThis = harnessInstalling === harnessSel.value;
			harnessStatus.className = 'status err';
			harnessStatus.textContent = installingThis
				? 'Installing… this updates by itself once the install lands.'
				: installable
					? 'Not installed — install it below, or run the command yourself:'
					: 'Not supported for automated runs.';
			$('guide-cmd').style.display = showCmd ? 'block' : 'none';
			if (showCmd) { $('guide-cmd').textContent = meta.installCommand; }
			$('guide-note').textContent = meta ? meta.postInstall : '';
			$('harness-install').style.display = installable && !installingThis ? 'inline-block' : 'none';
			guide.style.display = 'block';
		}
		// Ready harnesses first, missing ones after — as native optgroups, so the
		// dropdown itself says which agents can run right now.
		function regroupHarnessOptions() {
			const current = harnessSel.value;
			harnessSel.innerHTML = '';
			const groups = [
				{ label: 'Installed / available', pass: (a) => a && a.ok },
				{ label: 'Not installed', pass: (a) => !a || !a.ok },
			];
			for (const g of groups) {
				const members = harnesses.filter((h) => g.pass(harnessAvail && harnessAvail[h.id]));
				if (!members.length) continue;
				const og = document.createElement('optgroup');
				og.label = g.label;
				for (const h of members) {
					const o = document.createElement('option');
					o.value = h.id; o.textContent = h.label;
					if (h.id === current) o.selected = true;
					og.appendChild(o);
				}
				harnessSel.appendChild(og);
			}
			// A finished install flips its harness into the ready group; keep it
			// selected so saving uses the agent that was just set up.
			if (harnessInstalling && harnessAvail && harnessAvail[harnessInstalling]
				&& harnessAvail[harnessInstalling].ok) {
				harnessInstalling = null;
			}
		}
		harnessSel.addEventListener('change', renderHarnessStatus);
		$('harness-recheck').addEventListener('click', requestHarnessCheck);
		$('harness-install').addEventListener('click', () => {
			harnessInstalling = harnessSel.value;
			vscode.postMessage({ type: 'installHarness', harnessId: harnessSel.value });
			renderHarnessStatus();
		});
		requestHarnessCheck();

		// --- tab navigation ---
		const tabs = [...document.querySelectorAll('.tab')];
		const panes = [...document.querySelectorAll('.pane')];
		tabs.forEach((tab) => {
			tab.addEventListener('click', () => {
				tabs.forEach((t) => t.classList.remove('active'));
				panes.forEach((p) => p.classList.remove('active'));
				tab.classList.add('active');
				$('pane-' + tab.dataset.tab).classList.add('active');
			});
		});

		// --- save ---
		$('save-btn').addEventListener('click', () => {
			vscode.postMessage({ type: 'saveHarness', harnessId: harnessSel.value });
		});

		// --- engines ---
		$('engines-install').addEventListener('click', () => {
			vscode.postMessage({ type: 'installEngines' });
		});

		// --- toggles ---
		const autoToggle = $('auto-toggle'); const autoLabel = $('auto-label');
		if (autoToggle) { autoToggle.addEventListener('change', () => vscode.postMessage({ type: 'toggleAutoDiscover', enabled: autoToggle.checked })); }
		const pilotToggle = $('pilot-toggle'); const pilotLabel = $('pilot-label');
		if (pilotToggle) { pilotToggle.addEventListener('change', () => vscode.postMessage({ type: 'toggleAutoPilot', enabled: pilotToggle.checked })); }
		const episodesToggle = $('episodes-toggle'); const episodesLabel = $('episodes-label');
		if (episodesToggle) { episodesToggle.addEventListener('change', () => vscode.postMessage({ type: 'toggleAutoEpisodes', enabled: episodesToggle.checked })); }
		const acceptanceToggle = $('acceptance-toggle'); const acceptanceLabel = $('acceptance-label');
		if (acceptanceToggle) { acceptanceToggle.addEventListener('change', () => vscode.postMessage({ type: 'toggleAcceptanceTests', enabled: acceptanceToggle.checked })); }
		const mcpToggle = $('mcp-toggle'); const mcpLabel = $('mcp-label');
		if (mcpToggle) { mcpToggle.addEventListener('change', () => vscode.postMessage({ type: 'toggleMcp', enabled: mcpToggle.checked })); }

		// --- inbound messages ---
		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.type === 'harnesses') {
				harnessAvail = msg.results;
				regroupHarnessOptions();
				renderHarnessStatus();
			} else if (msg.type === 'mcp') {
				if (mcpToggle) { mcpToggle.checked = msg.enabled; }
				if (mcpLabel) { mcpLabel.textContent = msg.enabled ? 'Registered for ' + mcpClientList : 'Not registered'; }
			} else if (msg.type === 'autoDiscover') {
				if (autoToggle) { autoToggle.checked = msg.enabled; }
				if (autoLabel) { autoLabel.textContent = msg.enabled ? 'Auto-discover on (runs on open)' : 'Auto-discover off (manual only)'; }
			} else if (msg.type === 'autoPilot') {
				if (pilotToggle) { pilotToggle.checked = msg.enabled; }
				if (pilotLabel) { pilotLabel.textContent = msg.enabled ? 'Auto-Pilot on (drives to green after discovery)' : 'Auto-Pilot off (manual per-service setup)'; }
			} else if (msg.type === 'autoEpisodes') {
				if (episodesToggle) { episodesToggle.checked = msg.enabled; }
				if (episodesLabel) { episodesLabel.textContent = msg.enabled ? 'Auto-dispatch on (fixes start on failure)' : 'Auto-dispatch off (asks before each fix)'; }
			} else if (msg.type === 'acceptanceTests') {
				if (acceptanceToggle) { acceptanceToggle.checked = msg.enabled; }
				if (acceptanceLabel) { acceptanceLabel.textContent = msg.enabled ? 'Acceptance tests on (fail-to-pass gated)' : 'Acceptance tests off'; }
			}
		});
	</script>
</body>
</html>`;
}
