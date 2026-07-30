/**
 * The engines commit THIS build of the extension was cut against.
 *
 * GENERATED — `scripts/stamp-engine-pin.mjs` rewrites this file during
 * `vscode:prepublish`, and the result is committed as part of the release. Do
 * not hand-edit the values; change the build inputs instead (see the script).
 *
 * WHY A PIN AND NOT "LATEST": the engines are not shipped inside the vsix —
 * they are a checkout of the monorepo at ~/.vinv/engines (see ./install). If an
 * installed extension always pulled tip-of-main, a frozen extension would be
 * talking to a moving engine, and the contracts between them are versioned
 * (the index store format, the MCP payload shapes, the recorded start
 * commands). Stamping the ref at package time makes "extension version" ⇒
 * "engine commit" a reproducible 1:1 pair: every user on a given extension
 * version runs the same engines, and updating the vsix is what moves them.
 */

/**
 * Monorepo ref (tag or commit sha) the engines should sit at, or '' for an
 * unstamped build. Unstamped means unpinned: ./update stays completely inert,
 * which is what a local `npm run bundle` dev build wants — the developer's
 * checkout is theirs to move.
 */
export const ENGINE_REF = '2ced3e37938a0fd853d942c91e5ecaaeb97ab771';

/**
 * What an unconfigured install does when the stamped ref and the checkout
 * disagree. The `vinv.engines.autoUpdate` setting overrides it per user.
 *
 *   'auto'   — update without asking (the shipped default: the extension forces
 *              its own engines checkout onto the pin, and the multi-minute
 *              `cargo build` is an accepted cost of not running skewed engines)
 *   'prompt' — offer it once per extension version
 *   'never'  — leave the checkout alone
 */
export const ENGINE_UPDATE_DEFAULT: 'auto' | 'prompt' | 'never' = 'auto';
