# Contributing to Vinv

Thanks for wanting to make agent-written code more honest. This repo is a
single monorepo: Python engines (a [uv](https://docs.astral.sh/uv/) workspace),
a Rust index, and a TypeScript extension. (The vinv.ai site is just a pointer to this repo and lives outside it.)

## Dev setup

```bash
git clone https://github.com/VinvAI/VinvAI
cd VinvAI
uv sync                        # all Python engines + the embedder sidecar
(cd index && cargo build)      # the Rust semantic index
(cd extension && npm install)  # the editor extension
```

Open `extension/` in VS Code and hit F5 to run the extension against the
engines in your checkout — a dev checkout is auto-detected, no extra config.

## Where the code lives

The Python engines are a uv workspace; each is its own package under its own
directory (`tracelens`, `identification`, `handbook`, `bringup`,
`goal`, `embedder`, `exerciser`, `contracts`). Source lives in
`<engine>/src/`, tests in `<engine>/tests/`. Edit the source there — the
`.venv/bin/` CLIs and any binaries under `~/.vinv/` are built artifacts, not
the source of truth. The Rust semantic index is in `index/`, the editor
extension in `extension/`.

## Branches

- Fork the repo (or branch directly if you have write access) — never push to
  `main`. `main` is protected and every change goes through a PR.
- Name branches `<type>/<short-slug>`, matching the commit types below:
  `feat/exerciser-auth-sweep`, `fix/index-torn-store`, `docs/contributing-agents`.
- Keep one logical change per branch. Rebase on `main` before opening the PR
  so CI runs against current code.

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org) with a
scope naming the engine or area you touched — this is already the house style
(`git log` shows it):

```
feat(exerciser): behavioral testing engine — exercise every endpoint
fix(tracelens): foreign target venv needs ZERO installs to be traced
docs(readme): five engines → eight capabilities
```

- Type is one of `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`.
- Scope is the package/area (`tracelens`, `extension`, `index`, `harness`, …).
- Subject is imperative and specific. Say what changed and why it matters, not
  "update code."
- Keep commits focused; don't bundle an unrelated refactor into a fix.

## Before you send a PR

- **Lint (Python)**: `uv run ruff check` and `uv run ruff format --check` in the
  package you touched. Config lives in each engine's `pyproject.toml`
  (line-length 100, rules `E,F,I,UP,B`).
- **Python tests**: `uv run pytest` inside the package you touched (or at the
  root for everything).
- **Rust**: `cargo test` in `index/`.
- **Extension**: `npm run check && npm run bundle` in `extension/`.
- **End-to-end**: `python tests/e2e/planted_bug_golden/run.py` — plants a real
  bug, traces it, and asserts the evidence names the exact symbol and line.
  This is the honesty contract of the whole product; it must stay green.

CI (`.github/workflows/test.yml`) runs the engine suites, the Rust index, the
extension typecheck/bundle, and the planted-bug e2e on every PR. Every change
requires review from the Engineering team (see `.github/CODEOWNERS`).

### Opening the PR

- Describe **what** changed and **why**, and note how you verified it (which of
  the checks above you ran, and any manual testing).
- Link the issue it closes, if any.
- Keep the diff reviewable — call out anything unusual, and flag if you used an
  AI agent to write it (see below) so reviewers know where to look hardest.

## Docs & assets

Small shortcuts here cause outsized breakage, so a few hard rules:

- **Images load from the `images.vinv.ai` CDN — never a `github.com/.../raw/…`
  URL.** If the CDN doesn't have your image, don't hardcode a GitHub link as a
  workaround — get the file uploaded to the CDN. The CDN doesn't auto-sync from
  the repo, so a committed asset can still be missing/stale there; verify before
  relying on it. (img.shields.io badges are fine.)
- **Never commit runtime or local state** — install-dir markers, generated
  reports, per-workspace config, anything under `.vinv/`. Gitignore it. A
  committed one-time marker disables its feature on every fresh checkout.
- **No unused assets.** A file referenced by nothing is dead weight — wire it up
  or don't add it.
- **Renaming a heading breaks its anchor** (removing an emoji counts). Update
  every link to the old `#anchor`, in both READMEs and cross-repo
  `github.com/VinvAI/VinvAI#…` links.
- **Don't rename brand identifiers** (`displayName`, publisher, package name,
  the "VinvAI" brand) as a side effect of a copy change — that needs sign-off.

## Ground rules

These are load-bearing — they're the product's promises, not style preferences.

- No network calls at runtime except: the one-time embedding-model download,
  and optional prebuilt `index` artifacts. Anything else is a bug — Vinv's
  promise is that everything runs locally.
- No telemetry. Don't add any.
- No new required configuration. If a feature needs an API key to work, it
  routes through the user's coding-agent harness instead.
- Keep the tracer zero-edit: users never modify their own code to use Vinv.

## Working with AI coding agents

Most contributions now come through Claude Code, Cursor, Codex, and similar
agents — that's welcome, and fitting for a project about keeping agents honest.
But *you* are the contributor, not the agent: you sign off on the diff, and the
[ground rules](#ground-rules) above are hard constraints an agent can't see
unless you tell it. Use this section to steer one, and to review what it hands
back.

### Give the agent the context it needs

Paste or point the agent at:

- **This file**, especially the ground rules and the "Where the code lives"
  map. Agents will otherwise happily edit a built `.venv/bin/` CLI or a
  `~/.vinv/` binary instead of the real source — those are artifacts.
- **The engine you're touching** — one uv workspace member under its own
  directory, source in `src/`, tests in `tests/`. Keep the agent inside that
  package unless the change genuinely spans engines.
- **The nearest existing code.** Ask it to match the surrounding style, the
  logging, and the test patterns already in that package rather than inventing
  new conventions.

### Hold it to the same bar as a human PR

Before you commit what an agent wrote, check it yourself:

- **Read every line.** If you can't explain what a change does or why it's
  there, don't ship it — ask the agent to justify it or cut it.
- **No new network calls, telemetry, or required config.** Agents reach for
  these reflexively (a metrics ping, a config flag, a cloud API). All three
  violate the ground rules. Grep the diff for new imports of HTTP clients,
  new env-var reads, and new settings.
- **Run the checks, don't trust the claim.** Agents will confidently say
  "tests pass." Actually run the lint, the package tests, and — for anything
  touching tracing or evidence — the planted-bug e2e. That golden test is the
  honesty contract; an agent that "fixed" a test by loosening its assertion has
  broken the product, not fixed the test.
- **Watch for invented APIs and files.** If the agent references a function,
  flag, or module, confirm it actually exists in the current tree before
  trusting it — don't take a plausible-looking symbol on faith.
- **Keep the tracer zero-edit.** Reject any change that would make users touch
  their own code to use Vinv, however convenient the agent found it.

### Modularize, delete dead code, cut the slop

These are the three things agents get wrong most. Check the diff for all of them
before committing (there's a fuller checklist in [AGENTS.md](AGENTS.md)):

- **Modularize.** Extend the function or module that already does the related
  thing; reuse existing helpers instead of duplicating them; one responsibility
  per function. Cross-engine calls go through `contracts`, not into another
  engine's internals.
- **No dead code.** Everything the agent added — functions, imports, params,
  branches — must be reached by shipping code or a test. Delete unused helpers,
  commented-out blocks, orphaned imports, and "just in case" abstractions.
  Reject speculative config knobs and future-proofing (YAGNI): solve the task in
  front of you.
- **No AI slop.** Comments say *why*, not *what* — cut ones that restate the
  code or echo the signature. No hedging/TODO breadcrumbs, no `try/except` that
  silently swallows errors to force a green run, no re-implemented stdlib, no
  marketing voice or emoji. Match the file's existing style, don't add a second
  one.

If a reviewer would ask "why is this line here?", answer it now or remove it.

### Commit hygiene with an agent

- Write commit messages in the Conventional Commit style above. If the agent
  drafts them, edit them so the subject reflects the real change.
- One logical change per commit — don't let an agent's "while I was in here"
  cleanups ride along silently. Split them or drop them.
- You're accountable for the diff under your name. Review as if you wrote it,
  because as far as the project is concerned, you did.

Repo-level agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`,
etc.) are welcome — if you find yourself repeating the same context to an
agent, propose one in a PR so the next contributor gets it for free.

## Code of Conduct

Participation in this project is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md). Be respectful; report unacceptable
behavior to support@vinv.ai.

## Security

Found a vulnerability? **Don't open a public issue** — follow
[SECURITY.md](SECURITY.md) for private disclosure.

## License

By contributing you agree your contributions are licensed under the
[Apache License 2.0](LICENSE).
