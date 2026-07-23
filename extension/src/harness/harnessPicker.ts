/**
 * The harness dropdown shown on every click-driven "send to harness" action:
 * nothing dispatches to a silently-configured default — the user picks the
 * agent each time, with the last choice preselected and remembered (it also
 * seeds background dispatches like auto-episodes, which cannot ask).
 *
 * Options are grouped ready-first (installed CLIs / reachable chat panels,
 * then everything missing), and each missing-but-installable harness carries
 * an inline install button: it launches the install (terminal for CLIs, the
 * editor's extension installer for chat panels), the picker waits for the
 * binary/extension to appear, and then resolves with that harness — install
 * flows straight into use.
 */
import * as vscode from 'vscode';
import {
	HARNESSES,
	canInstallHarness,
	quickScanHarnesses,
	startHarnessInstall,
	type HarnessDef,
} from './harnessRunner';
import { getHarnessId, hasChosenHarness, setHarnessId } from '../config/settings';

interface HarnessQuickPickItem extends vscode.QuickPickItem {
	/** Absent on separator rows. */
	id?: string;
}

/** How often the open picker re-scans the filesystem for a finished install. */
const INSTALL_POLL_MS = 2000;

function buildItems(
	availability: Record<string, boolean>,
	installing: ReadonlySet<string>,
): HarnessQuickPickItem[] {
	const describe = (h: HarnessDef): string => {
		if (installing.has(h.id)) {
			return 'installing… (waiting for it to appear)';
		}
		if (availability[h.id]) {
			if (h.kind !== 'ide-chat') {
				return 'installed';
			}
			return h.chat?.autoSubmit
				? 'available in this window'
				: 'available in this window — auto-send, best effort';
		}
		return h.kind === 'ide-chat' ? 'not available in this editor' : 'not installed';
	};
	const toItem = (h: HarnessDef): HarnessQuickPickItem => ({
		id: h.id,
		label: h.label,
		description: describe(h),
		buttons:
			!availability[h.id] && !installing.has(h.id) && canInstallHarness(h)
				? [
						{
							iconPath: new vscode.ThemeIcon('cloud-download'),
							tooltip: `Install ${h.label} and use it for this task`,
						},
					]
				: [],
	});
	const ready = HARNESSES.filter((h) => availability[h.id]);
	const missing = HARNESSES.filter((h) => !availability[h.id]);
	const items: HarnessQuickPickItem[] = [];
	if (ready.length) {
		items.push({ label: 'installed / available', kind: vscode.QuickPickItemKind.Separator });
		items.push(...ready.map(toItem));
	}
	if (missing.length) {
		items.push({ label: 'not installed', kind: vscode.QuickPickItemKind.Separator });
		items.push(...missing.map(toItem));
	}
	return items;
}

/**
 * Shows the harness QuickPick and returns the chosen harness id, or null when
 * dismissed. The choice is persisted as the remembered harness. A pick can
 * also arrive via the install button: the freshly installed harness is
 * auto-selected the moment its CLI/extension shows up.
 */
export async function pickHarness(
	placeHolder = 'Send this task to which coding agent?',
): Promise<string | null> {
	const remembered = getHarnessId();
	const installing = new Set<string>();
	let availability = quickScanHarnesses();

	const picked = await new Promise<HarnessQuickPickItem | undefined>((resolve) => {
		const qp = vscode.window.createQuickPick<HarnessQuickPickItem>();
		qp.placeholder = placeHolder;
		let pollTimer: ReturnType<typeof setInterval> | undefined;
		const render = (activeId?: string) => {
			const current = qp.activeItems[0]?.id;
			qp.items = buildItems(availability, installing);
			const target = activeId ?? current ?? remembered;
			const active = qp.items.find((i) => i.id === target);
			if (active) {
				qp.activeItems = [active];
			}
		};
		render();
		qp.onDidTriggerItemButton((e) => {
			const h = e.item.id ? HARNESSES.find((x) => x.id === e.item.id) : undefined;
			if (!h || installing.has(h.id)) {
				return;
			}
			startHarnessInstall(h);
			installing.add(h.id);
			qp.busy = true;
			render(h.id);
			// Installs finish while the picker is open (npm exits, the extension
			// activates); poll the cheap presence scan and resolve with the fresh
			// harness so "install" flows straight into "use". Escaping the picker
			// stops the watch but not the install — the terminal keeps running and
			// the next picker open sees the CLI in the installed group.
			pollTimer ??= setInterval(() => {
				availability = quickScanHarnesses();
				const done = [...installing].find((id) => availability[id]);
				if (!done) {
					render();
					return;
				}
				const installed = HARNESSES.find((x) => x.id === done);
				if (installed) {
					void vscode.window.showInformationMessage(
						`Vinv: ${installed.label} installed — using it for this task. ${installed.postInstall}`,
					);
				}
				resolve({ id: done, label: installed?.label ?? done });
				qp.hide();
			}, INSTALL_POLL_MS);
		});
		qp.onDidAccept(() => {
			resolve(qp.selectedItems[0]);
			qp.hide();
		});
		qp.onDidHide(() => {
			if (pollTimer) {
				clearInterval(pollTimer);
			}
			resolve(undefined);
			qp.dispose();
		});
		qp.show();
	});
	if (!picked?.id) {
		return null;
	}
	try {
		setHarnessId(picked.id);
	} catch {
		// Remembering the choice is best-effort; the dispatch still proceeds.
	}
	return picked.id;
}

/**
 * The chosen harness for an automatic (non-click) flow like discovery: asks
 * ONCE via the picker the first time — so the user selects from their installed
 * agents instead of silently getting the claude-code default — then remembers
 * it, staying silent on every later run. Returns null only when the user
 * dismisses that first-time picker (the caller then skips its LLM stages).
 */
export async function ensureHarnessChosen(
	placeHolder = 'Which coding agent should Vinv use? (change anytime in Configure)',
): Promise<string | null> {
	if (hasChosenHarness()) {
		return getHarnessId();
	}
	return pickHarness(placeHolder);
}
