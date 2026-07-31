/**
 * The full list of units a workspace can show numbers for.
 *
 * `identification consolidate` finds what the code DECLARES — routes, CLI
 * commands, workers, scheduled jobs, hooks, `__main__` scripts. That is most of
 * the inventory but not all of it: a function the exerciser drove directly is
 * declared nowhere, which is precisely why driving it needed a harness. Those
 * units have traces like any other, and listing only the declared ones left the
 * Traces panel unable to show a single one of them.
 *
 * So the declared inventory is unioned with the units named in the exercise
 * plan. The plan is used ONLY for identity — an id, a label, and enough to
 * recognise the unit's spans. Every number stays trace-derived; nothing here
 * reads a latency, a status or a coverage figure out of an exerciser's report.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { EntryPoint } from '../identification/identification';

/** One row of `.vinv/exercise/plan.json`'s endpoint list. */
interface PlanUnit {
	api_id?: string;
	unit_kind?: string;
	method?: string;
	path?: string;
	handler?: string | null;
}

/** An entry point plus the exact component to match, when it has one. */
export type InventoryUnit = EntryPoint & { component?: string };

/** The entry-point `kind` a plan unit's oracle implies. */
function kindOf(unitKind: string | undefined): string {
	if (unitKind === 'function_call') {
		return 'function';
	}
	return unitKind === 'cli_invocation' ? 'cli_command' : 'http_api';
}

/**
 * Merges plan units into the declared inventory, keeping declarations first.
 *
 * A plan unit whose id (or label) already names a declared entry point is
 * dropped: the declaration knows the handler's real file, which makes for a
 * better span match than a synthesized one.
 */
export function mergeUnits(declared: EntryPoint[], plan: PlanUnit[]): InventoryUnit[] {
	const out: InventoryUnit[] = [...declared];
	const byId = new Set(declared.map((e) => e.id));
	const byTrigger = new Set(declared.map((e) => e.trigger));
	for (const u of plan) {
		const target = (u.path ?? '').trim();
		const id = (u.api_id ?? '').trim() || target;
		if (!id || !target || byId.has(id)) {
			continue;
		}
		const label = `${(u.method ?? '').trim()} ${target}`.trim();
		if (byTrigger.has(label) || byTrigger.has(target)) {
			continue;
		}
		const kind = kindOf(u.unit_kind);
		// Only driven CALLS are added. A driven call IS its dotted target, so its
		// spans are matched by name exactly. A plan's `RUN acme-tool --check` is a
		// command LINE, not a symbol — it carries no handler and no file, so
		// nothing in a capture can be attributed to it; the CLI command it invoked
		// is already in the declared inventory, with a handler, and that is the row
		// its spans belong to. Adding the command line too would list a second row
		// that could never hold a number.
		if (kind !== 'function') {
			continue;
		}
		const component = target.replace(/:/g, '.');
		out.push({
			kind,
			id,
			trigger: label || target,
			handler: u.handler ?? (component ? component.split('.').pop() ?? null : null),
			file: '',
			line: 0,
			framework: 'exerciser',
			component,
		});
		byId.add(id);
	}
	return out;
}

/**
 * Reads the exerciser's unit list from `plan.json` and `profile.json`.
 *
 * Both are read because both exist and either can be the fresher one: the plan
 * is written before a pass runs, the profile after it. Deduped by the caller.
 */
export function readPlanUnits(workspaceRoot: string): PlanUnit[] {
	const out: PlanUnit[] = [];
	for (const name of ['plan.json', 'profile.json']) {
		try {
			const raw = fs.readFileSync(path.join(workspaceRoot, '.vinv', 'exercise', name), 'utf8');
			const parsed = JSON.parse(raw) as { endpoints?: PlanUnit[] };
			if (Array.isArray(parsed.endpoints)) {
				out.push(...parsed.endpoints);
			}
		} catch {
			// Absent or unreadable: the declared inventory stands on its own.
		}
	}
	return out;
}

/** The declared inventory plus any exerciser-driven unit it does not name. */
export function readUnitInventory(workspaceRoot: string, declared: EntryPoint[]): InventoryUnit[] {
	return mergeUnits(declared, readPlanUnits(workspaceRoot));
}
