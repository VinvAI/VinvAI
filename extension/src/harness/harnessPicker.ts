/**
 * The harness dropdown shown on every click-driven "send to harness" action:
 * nothing dispatches to a silently-configured default — the user picks the
 * agent each time, with the last choice preselected and remembered (it also
 * seeds background dispatches like auto-episodes, which cannot ask).
 *
 * Options are grouped ready-first (installed CLIs / reachable chat panels,
 * then everything missing). Choosing a missing-but-installable harness — by
 * its inline install button OR simply by selecting the row — launches the
 * install (a visible terminal for CLIs, the editor's extension installer for
 * chat panels), and the picker waits for the binary/extension to appear before
 * resolving with that harness: install flows straight into use, and no caller
 * ever receives an agent that is not actually there.
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
import { track } from '../telemetry';

/**
 * Flattens a presence scan into one boolean per harness.
 *
 * Property VALUES are bounded tokens (see telemetry/sanitize.ts), so a list
 * cannot travel — and would not be worth much if it could. A column per harness
 * is what makes "how many users have any agent at all", and "which agent is
 * missing when discovery dies", single queries instead of string parsing.
 *
 * Keep in sync with HARNESSES; `scanned_count` on the event is what exposes it
 * when this falls behind.
 */
function availabilityProps(availability: Record<string, boolean>): {
	avail_claude_code: boolean;
	avail_codex: boolean;
	avail_cursor: boolean;
	avail_gemini: boolean;
	avail_copilot_chat: boolean;
	avail_cursor_chat: boolean;
	avail_windsurf: boolean;
} {
	const has = (id: string): boolean => availability[id] === true;
	return {
		avail_claude_code: has('claude-code'),
		avail_codex: has('codex'),
		avail_cursor: has('cursor'),
		avail_gemini: has('gemini'),
		avail_copilot_chat: has('copilot-chat'),
		avail_cursor_chat: has('cursor-chat'),
		avail_windsurf: has('windsurf'),
	};
}

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
		if (h.kind === 'ide-chat') {
			return canInstallHarness(h) ? 'not installed — select to install' : 'not available in this editor';
		}
		return canInstallHarness(h) ? 'not installed — select to install it here' : 'not installed';
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
	reason: 'first_run' | 'explicit' = 'explicit',
): Promise<string | null> {
	const remembered = getHarnessId();
	const installing = new Set<string>();
	let availability = quickScanHarnesses();

	// What the user was actually offered. Emitted BEFORE they answer, so a
	// dismissal still leaves a record of the choice they were looking at —
	// without this, the most common first-run dead end (no agent installed, so
	// nothing in the list is usable) produces no event at all.
	track('harness_picker_shown', {
		reason,
		remembered_id: remembered,
		harness_chosen: hasChosenHarness(),
		ready_count: Object.values(availability).filter(Boolean).length,
		scanned_count: HARNESSES.length,
		...availabilityProps(availability),
	});

	/** Set when the pick came from an install finishing while the picker was open. */
	let viaInstall = false;

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
		// Shared by the inline install button and by accepting a not-installed
		// row: kick the install off in a visible integrated terminal (the user
		// watches it run and signs in right there) and keep the picker open
		// until the binary/extension shows up.
		const beginInstall = (h: HarnessDef): void => {
			if (installing.has(h.id)) {
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
				viaInstall = true;
				resolve({ id: done, label: installed?.label ?? done });
				qp.hide();
			}, INSTALL_POLL_MS);
		};
		qp.onDidTriggerItemButton((e) => {
			const h = e.item.id ? HARNESSES.find((x) => x.id === e.item.id) : undefined;
			if (h) {
				beginInstall(h);
			}
		});
		qp.onDidAccept(() => {
			const sel = qp.selectedItems[0];
			const h = sel?.id ? HARNESSES.find((x) => x.id === sel.id) : undefined;
			// Choosing a not-installed agent means "use this one", not "fail on the
			// first dispatch": install it instead of resolving with a harness that
			// is not there yet. Same terminal-visible flow as the install button —
			// only harnesses we can actually install take this path; the rest
			// resolve as before and the caller reports what is missing.
			if (h && !availability[h.id] && canInstallHarness(h)) {
				beginInstall(h);
				return;
			}
			resolve(sel);
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
	// The dismissal rate is the first-run drop-off, and it was previously
	// unmeasurable: a dismissed picker returns null, the caller skips its LLM
	// stages, and nothing anywhere records that a user was asked and said no.
	track('harness_picker_resolved', {
		reason,
		outcome: !picked?.id ? 'dismissed' : viaInstall ? 'installed' : 'picked',
		harness_id: picked?.id ?? 'none',
		was_missing: picked?.id ? availability[picked.id] !== true : false,
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
	return pickHarness(placeHolder, 'first_run');
}
