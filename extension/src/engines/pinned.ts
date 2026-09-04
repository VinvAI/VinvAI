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
export const ENGINE_REF = 'ed77214';

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

/**
 * The `vinv` wheel version THIS build of the extension pairs with, or '' for an
 * unstamped build.
 *
 * GENERATED alongside ENGINE_REF — see scripts/stamp-engine-pin.mjs.
 *
 * WHY A SECOND PIN: the wheel is the PRIMARY way the engines are installed —
 * one prebuilt distribution carrying every Python engine and the compiled Rust
 * `index`, so no user needs a Rust toolchain or a C linker to run Vinv. But it
 * is released on its own `pypi-v*` tag, independent of the monorepo commit
 * ENGINE_REF names, so "install vinv" without a version would resolve to
 * whatever is latest at install time — the exact moving-engine problem
 * ENGINE_REF exists to prevent, just via PyPI instead of git.
 *
 * Empty means unstamped, and unstamped means the wheel path is SKIPPED: a local
 * `npm run bundle` dev build goes straight to the source checkout, which is what
 * a developer with their own tree wants.
 */
export const ENGINE_WHEEL: string = '0.0.5';
