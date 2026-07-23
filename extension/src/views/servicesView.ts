import * as vscode from 'vscode';
import {
	readServices,
	isServiceStarted,
	readBringupOutcome,
	type ServiceEntry,
} from '../bringup/bringup';
import { isServiceRunning } from '../bringup/serviceRunner';
import { onDiscoveryStateChange } from '../index/discovery';

/**
 * Lists this workspace's services (from .vinv/services.json) in the sidebar, with
 * per-row run/stop so the user can start observability without opening the
 * Configure panel — the most common action once a project is set up. Each row's
 * contextValue selects its inline action (Run / Stop / Set up).
 */
export class ServicesProvider implements vscode.TreeDataProvider<ServiceItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ServiceItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(
			// Discovery writes services.json; debug sessions start/stop change the
			// running state — refresh on any of those so the list stays accurate.
			onDiscoveryStateChange(() => this.refresh()),
			vscode.debug.onDidStartDebugSession(() => this.refresh()),
			vscode.debug.onDidTerminateDebugSession(() => this.refresh()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
		);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ServiceItem): vscode.TreeItem {
		return element;
	}

	getChildren(): ServiceItem[] {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return [];
		}
		return readServices(root).map((s) => new ServiceItem(s, root));
	}
}

/**
 * One service row. State is derived from disk (verified start command) plus the
 * live debug sessions:
 *   - running   → green dot, inline Stop
 *   - ready     → outline dot, inline Run (verified; runs the recorded command)
 *   - not set up→ faint dot, inline Set up (brings it up under tracelens first)
 */
class ServiceItem extends vscode.TreeItem {
	readonly serviceName: string;

	constructor(entry: ServiceEntry, root: string) {
		super(entry.name, vscode.TreeItemCollapsibleState.None);
		this.serviceName = entry.name;
		this.id = entry.name;

		const running = isServiceRunning(entry.name);
		const verified = isServiceStarted(root, entry.name);

		if (running) {
			this.iconPath = new vscode.ThemeIcon(
				'circle-filled',
				new vscode.ThemeColor('testing.iconPassed'),
			);
			this.contextValue = 'vinv.service.running';
			this.description = 'running';
		} else if (verified) {
			this.iconPath = new vscode.ThemeIcon('circle-outline');
			this.contextValue = 'vinv.service.ready';
			this.description = 'ready';
		} else {
			// Distinguish "never tried" from the honest negative the bring-up agent
			// recorded: a pure library module with nothing to run isn't "not set up",
			// it's simply not a service — don't nag the user to set it up forever.
			const outcome = readBringupOutcome(root, entry.name);
			if (outcome.state === 'library') {
				this.iconPath = new vscode.ThemeIcon('library');
				this.contextValue = 'vinv.service.library';
				this.description = 'library — nothing to run';
			} else {
				this.iconPath = new vscode.ThemeIcon('circle-large-outline');
				this.contextValue = 'vinv.service.unverified';
				this.description = outcome.state === 'failed' ? 'bring-up failed — set up again' : 'not set up';
			}
		}

		const meta = entry.working_directory || (entry.port ? `:${entry.port}` : '');
		const outcomeNote =
			this.contextValue === 'vinv.service.library'
				? '\nThe bring-up agent verified this module is a library with no server entry point.'
				: '';
		this.tooltip = (meta ? `${entry.name} — ${meta}` : entry.name) + outcomeNote;
	}
}
