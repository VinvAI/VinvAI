/**
 * Best-effort OS-level auto-send for chat panels whose editors refuse
 * programmatic submission (Cursor's deeplink only pre-fills; Cascade has no
 * prompt API): after the prompt is placed in the panel's input, a real
 * keystroke (optionally Ctrl/Cmd+V first, then Enter) is injected through the
 * platform's automation facility — SendKeys via PowerShell on Windows,
 * System Events via osascript on macOS, xdotool on Linux (when installed).
 *
 * Safety: keys are ONLY sent after verifying the frontmost application is the
 * expected editor — a stray Enter must never land in another app. Every
 * failure (wrong foreground app, missing accessibility permission, no
 * xdotool) resolves false and the caller falls back to the manual
 * "press Enter" flow; nothing here throws.
 */
import { spawn } from 'child_process';

export interface AutoSendPlan {
	/**
	 * Name the frontmost app must contain (case-insensitively where the
	 * platform allows), e.g. 'Cursor' or 'Windsurf'. Matches the process name
	 * on Windows/macOS and the active window title on Linux.
	 */
	appHint: string;
	/** Inject Ctrl/Cmd+V (paste from clipboard) before the Enter. */
	paste: boolean;
}

/** Runs a command with args; resolves true only on a clean 0 exit within 8s. */
function run(cmd: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
			const timer = setTimeout(() => {
				try {
					child.kill();
				} catch {
					// Already gone.
				}
				resolve(false);
			}, 8000);
			child.on('error', () => {
				clearTimeout(timer);
				resolve(false);
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				resolve(code === 0);
			});
		} catch {
			resolve(false);
		}
	});
}

function windowsSend(plan: AutoSendPlan): Promise<boolean> {
	// $pid is a reserved automatic variable in PowerShell — hence $procId.
	// -match is case-insensitive by default. Exit 3 = wrong foreground app.
	const paste = plan.paste
		? "[System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 250; "
		: '';
	const script =
		"$ErrorActionPreference='Stop'; " +
		'Add-Type -AssemblyName System.Windows.Forms; ' +
		"Add-Type -Namespace VinvNative -Name User32 -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint procId);'; " +
		'$hwnd=[VinvNative.User32]::GetForegroundWindow(); ' +
		'$procId=[uint32]0; ' +
		'[void][VinvNative.User32]::GetWindowThreadProcessId($hwnd,[ref]$procId); ' +
		'$name=(Get-Process -Id $procId).ProcessName; ' +
		`if ($name -notmatch '${plan.appHint}') { exit 3 }; ` +
		paste +
		"[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')";
	return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function macSend(plan: AutoSendPlan): Promise<boolean> {
	// Requires the editor to have macOS Accessibility permission; without it
	// osascript exits non-zero and the caller falls back to manual.
	const lines = [
		'tell application "System Events"',
		'set frontName to name of first application process whose frontmost is true',
		`if frontName does not contain "${plan.appHint}" then error "wrong app" number 3`,
		...(plan.paste ? ['keystroke "v" using {command down}', 'delay 0.25'] : []),
		'keystroke return',
		'end tell',
	];
	return run(
		'osascript',
		lines.flatMap((l) => ['-e', l]),
	);
}

function linuxSend(plan: AutoSendPlan): Promise<boolean> {
	// xdotool covers X11 (and XWayland). Editor window titles end with the
	// app name ("… — Cursor"), so the active window title is the app check.
	const paste = plan.paste ? 'xdotool key --clearmodifiers ctrl+v; sleep 0.25; ' : '';
	const script =
		'command -v xdotool >/dev/null 2>&1 || exit 4; ' +
		'active=$(xdotool getactivewindow getwindowname 2>/dev/null) || exit 4; ' +
		`printf '%s' "$active" | grep -qi '${plan.appHint}' || exit 3; ` +
		paste +
		'xdotool key --clearmodifiers Return';
	return run('sh', ['-c', script]);
}

/**
 * Injects the submit keystrokes for the current platform. Resolves true when
 * the keys were sent to the expected editor; false on any failure or doubt.
 */
export function injectSubmitKeys(plan: AutoSendPlan): Promise<boolean> {
	switch (process.platform) {
		case 'win32':
			return windowsSend(plan);
		case 'darwin':
			return macSend(plan);
		default:
			return linuxSend(plan);
	}
}
