# AGENTS.md

Machine-readable contributor guide for AI coding agents (Claude Code, Cursor,
Codex, and friends). Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md)
— this file is the same rules in a form an agent can load automatically.

Vinv makes agent-written code more honest: it traces real behavior and produces
evidence naming the exact symbol and line. Hold yourself to that standard here.

## What this repo is

A single monorepo:

- **Python engines** — a [uv](https://docs.astral.sh/uv/) workspace. Members:
  `contracts`, `core`, `tracelens`, `identification`, `handbook`, `bringup`,
  `goal`, `embedder`, `exerciser`.
- **Rust semantic index** — `index/`.
- **TypeScript editor extension** — `extension/`.

## Code map — edit the source, not the artifacts

- Each Python engine is its own package: source in `<engine>/src/`, tests in
  `<engine>/tests/`. Edit there.
- **`.venv/bin/` CLIs and any binaries under `~/.vinv/` are BUILT ARTIFACTS.**
  Never edit them to change behavior — your change will be silently overwritten
  on the next build and does not reflect the source. Find the real source in
  `<engine>/src/`.
- Rust index: `index/`. Extension: `extension/`.
- Keep a change inside one workspace member unless it genuinely spans engines.

## Setup

```bash
uv sync                        # all Python engines + the embedder sidecar
(cd index && cargo build)      # the Rust semantic index
(cd extension && npm install)  # the editor extension
```

## Verify before you hand back a diff

Run these — do not just claim they pass. Match the check to what you touched.

- **Python lint**: `uv run ruff check` and `uv run ruff format --check` in the
  package you touched (line-length 100, rules `E,F,I,UP,B`).
- **Python tests**: `uv run pytest` in the package you touched (or repo root for
  everything).
- **Rust**: `cargo test` in `index/`.
- **Extension**: `npm run check && npm run bundle` in `extension/`.
- **End-to-end (the honesty contract)**:
  `python tests/e2e/planted_bug_golden/run.py`. It plants a real bug, traces
  it, and asserts the evidence names the exact symbol and line. It MUST stay
  green. Never make it pass by loosening an assertion — that breaks the
  product, not the test.

## Hard constraints — these are product promises, not style

Any change that violates one of these is a bug, not a feature. Reviewers will
reject it.

1. **No runtime network calls** except the one-time embedding-model download
   and optional prebuilt `index` artifacts. Everything runs locally. Do not add
   HTTP clients, metrics pings, or cloud API calls.
2. **No telemetry.** None. Do not add any.
3. **No new required configuration.** If a feature needs an API key, it routes
   through the user's coding-agent harness — it does not add a required env var
   or setting.
4. **Keep the tracer zero-edit.** Users never modify their own code to use Vinv.
   Reject any design that requires them to.

Before finishing, grep your own diff for: new imports of HTTP/network clients,
new environment-variable reads, and new required settings. If you find one,
stop and reconsider.

## Code quality: modularize, no dead code, no slop

Vinv is about honest, minimal evidence — write code the same way. These are the
agent failure modes reviewers watch for most.

**Modularization**
- Fit the existing structure. Find the module/function that already does the
  related thing and extend it; don't drop a new 200-line function into an
  unrelated file.
- Reuse before you write. Search the package for an existing helper before
  adding your own — duplicated logic is a defect here, not a convenience.
- One responsibility per function/module. If you're passing a `mode` flag to
  branch a function into two behaviors, write two functions.
- Respect engine boundaries. Cross-engine coupling goes through `contracts`,
  not by reaching into another engine's internals.

**No dead code — leave nothing you didn't wire up**
- Every function, class, import, and parameter you add must be reached by
  shipping code or a test. Delete anything that isn't.
- No commented-out code, no "keep just in case" blocks, no orphaned imports.
- No speculative generality (YAGNI): don't add config knobs, hooks, or
  abstraction layers for a future that isn't in this change. Solve the actual
  task.
- No dead branches: unreachable `else`, unused kwargs, backward-compat shims for
  code that never shipped. Remove them.
- Ruff's `F` (unused) and `B` (bugbear) rules catch some of this — run it, but
  don't rely on it to catch design-level dead code.

**No AI slop**
- Comments explain *why*, never *what*. Delete comments that restate the code
  (`# increment i`), docstrings that just echo the signature, and section-banner
  comments.
- No hedging or narration left in code: `# This might need to...`, `# TODO:
  maybe`, `# Note: we do X` where X is obvious. If it's a real TODO, file it or
  do it; don't leave a breadcrumb.
- No defensive `try/except` that swallows errors to make a run "pass." Let real
  failures surface — silent except-and-continue is the opposite of honest
  evidence.
- No re-implementing the standard library or an existing dependency.
- Match the surrounding code's naming, error handling, and logging. Don't
  introduce a second style in a file that already has one.
- No marketing voice, emoji, or exclamation in code or comments. Plain and
  precise.

Before handing back a diff, re-read it and cut anything that isn't load-bearing.
If a reviewer would ask "why is this here?", answer it now or remove it.

## Docs, images & repo hygiene — don't take the easy shortcut

The shortcut that's quick for you now but leaves a mess in the repo. Real
lessons from past PRs:

- **README / marketplace images load from the `images.vinv.ai` CDN — never a
  `github.com/.../raw/...` or `raw.githubusercontent.com` URL.** If the CDN
  doesn't have your image yet, that is NOT a reason to hardcode a GitHub-raw
  link — flag it so the file gets uploaded to the CDN. The CDN maps
  filename→filename with `.github/assets/` but does **not** auto-sync (there's
  no CDN workflow), so a committed asset can be missing or stale on the CDN;
  verify with `curl` before relying on it. (Badge images from img.shields.io
  are fine — the rule is about content images.)
- **Never commit runtime or local state.** Files an engine or the extension
  writes at runtime — install-dir markers, generated reports, per-workspace
  config, anything under `.vinv/` — are local state, not source. Gitignore
  them. A committed marker that gates a one-time action silently disables that
  action for every fresh checkout.
- **Don't commit unused assets.** An image or file referenced by nothing is
  dead weight — wire it up or don't add it.
- **Editing a heading breaks its anchor.** Every `##` heading owns a link
  anchor; renaming one — *including removing an emoji* — changes `#the-anchor`.
  Grep for links to the old anchor in both READMEs and in cross-repo
  `github.com/VinvAI/VinvAI#...` links, and fix them. A dangling `#-…` anchor
  (leading dash left over from an emoji heading) is the classic tell.
- **Don't rename brand identifiers as a side effect.** Marketing copy,
  description, and keywords are fair game; the `displayName`, publisher,
  package name, and the "VinvAI" brand are not — get sign-off before changing
  them.

## Don't hallucinate the tree

Before referencing a function, flag, module, or file, confirm it exists in the
current checkout. Do not invent plausible-looking symbols or APIs. If you're
unsure whether something exists, search for it rather than assuming.

## Commits & PRs

- [Conventional Commits](https://www.conventionalcommits.org) with a scope
  naming the engine/area: `feat(exerciser): …`, `fix(tracelens): …`,
  `docs(readme): …`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`,
  `chore`. Imperative, specific subject — say what changed and why.
- One logical change per commit. Do not bundle "while I was in here" cleanups.
- Branch names mirror commit types: `feat/<slug>`, `fix/<slug>`. Never push to
  `main`; every change goes through a PR reviewed by the Engineering team
  (`.github/CODEOWNERS`).
- The human contributor owns the diff. Write a PR description that states what
  changed, why, and how it was verified.
