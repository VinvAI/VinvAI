/**
 * The operator escape hatch for a failed bring-up: ASK how they start the
 * service, then let the bring-up agent do the rest.
 *
 * Working out *which* command starts a service is the hardest and most
 * failure-prone half of bring-up — the agent infers it from the handbook, the
 * Dockerfile, and the repo's scripts, and when that inference is wrong there is
 * nothing in the repo that would tell it otherwise. But the human sitting there
 * types that command every day. So when bring-up fails, asking them is both the
 * cheapest and the highest-signal move available, and it runs BEFORE the
 * expensive fix-episode path (see offerEpisodeForBringupFailure): an episode
 * that re-derives a command the operator could have just told us is a bad
 * trade, and the answer is reusable forever after.
 *
 * What the hint does NOT do is lower the bar. It seeds WHICH command to trace;
 * the agent still has to verify it, wrap it in tracelens, and prove the wrapped
 * form serves before recording `verified: true`. An untraced start command is
 * still a failed bring-up — a Run button that produces no trace defeats the
 * point of bringing the service up at all.
 */
import * as vscode from 'vscode';
import {
	readBringupOutcome,
	readStartHint,
	writeStartHint,
	type ServiceEntry,
} from './bringup';
import { runBringupStartViaHarness } from '../harness/harnessRunner';
import { getHarnessId } from '../config/settings';

/**
 * Prompts for the operator's start command and re-runs bring-up with it.
 *
 * Returns true when a hinted retry actually ran (whatever its verdict), so the
 * caller knows the failure has been acted on. Returns false when there was
 * nothing to fix, the operator dismissed the prompt, or the hint could not be
 * persisted — in every one of those cases the caller should fall through to its
 * normal failure handling.
 */
export async function offerHintedRetry(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	service: ServiceEntry,
): Promise<boolean> {
	const outcome = readBringupOutcome(workspaceRoot, service.name);
	// 'verified' needs no help; 'library' is an honest negative (the agent proved
	// there is nothing to start), and asking how to start a library would invite
	// a command that shouldn't exist. Only a real failure earns the prompt.
	if (outcome.state !== 'failed') {
		return false;
	}
	// An 'untraced' failure is NOT a start failure: the service started and
	// served — what failed is that tracelens instrumented the wrong code. Asking
	// the operator how they start it cannot fix that, and in practice produced
	// the worst loop this flow can make: the user was asked for a command the
	// inventory already recorded, typed it back verbatim, the retry failed the
	// same way, and the follow-up toast blamed "your command". The recorded
	// symptom already names the actual remedy (re-run, or diagnose tracelens),
	// so fall through to normal failure handling instead of interrogating the
	// one person who cannot help.
	if (outcome.kind === 'untraced') {
		return false;
	}

	// Prefill with the best guess we have, in order of authority: what the
	// operator told us last time, then the inventory's command. The agent's own
	// failed attempt is deliberately NOT offered — it already didn't work, and
	// prefilling it invites an Enter-key retry of the same failure.
	const previous = readStartHint(workspaceRoot, service.name);
	const hint = await vscode.window.showInputBox({
		title: `Vinv: How do you start '${service.name}'?`,
		prompt:
			`Vinv could not bring '${service.name}' up on its own. Paste the command YOU use to ` +
			'start it — Vinv will verify it, then record the tracelens-wrapped version so runs ' +
			'produce traces.',
		placeHolder: 'e.g. make run-api   ·   npm run dev   ·   python -m app.main --port 8000',
		value: previous ?? service.command ?? '',
		ignoreFocusOut: true,
		validateInput: (value) =>
			value.trim() ? null : 'Enter the command you use to start this service, or press Escape to skip.',
	});
	if (!hint?.trim()) {
		return false; // dismissed — caller falls through to the episode offer
	}

	// Persist BEFORE the retry, and treat a failed write as fatal to this flow:
	// the whole point of the hint is that it outlives this attempt, and the
	// engine resolves it from disk when no flag is passed. Reporting "saved"
	// over a failed write would strand the operator re-answering forever.
	let hintPath: string;
	try {
		hintPath = writeStartHint(workspaceRoot, service.name, hint);
	} catch (e) {
		void vscode.window.showErrorMessage(
			`Vinv: Could not save your start command for '${service.name}': ` +
				`${e instanceof Error ? e.message : String(e)}`,
		);
		return false;
	}

	await runBringupStartViaHarness(
		context,
		getHarnessId(),
		workspaceRoot,
		service,
		undefined,
		undefined,
		hint,
	);

	// Report on the ARTIFACT, not the exit code: the run is only a success if it
	// left a verified, traced start command behind.
	const after = readBringupOutcome(workspaceRoot, service.name);
	if (after.state === 'verified') {
		void vscode.window.showInformationMessage(
			`Vinv: '${service.name}' is ready — your command now runs under tracelens. ` +
				'Vinv will reuse it for this service from now on.',
		);
	} else {
		const symptom = after.state === 'unattempted' ? undefined : after.symptom;
		void vscode.window.showWarningMessage(
			`Vinv: '${service.name}' still did not come up under tracelens with your command` +
				`${symptom ? ` — ${symptom.slice(0, 160)}` : '.'}` +
				` Your command is saved and will be reused; you can edit it at ${hintPath}.`,
		);
	}
	return true;
}
