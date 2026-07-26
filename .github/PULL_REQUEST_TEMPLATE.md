<!--
Thanks for contributing to Vinv. Keep the diff reviewable and one logical
change per PR. See CONTRIBUTING.md (and AGENTS.md if an agent wrote any of this).
-->

## What & why

<!-- What does this change do, and why does it matter? Link the issue it closes, if any. -->

Closes #

## How it was verified

<!-- Check what you actually ran for the area you touched. Don't claim — run it. -->

- [ ] Python lint — `uv run ruff check` and `uv run ruff format --check` in the package I touched
- [ ] Python tests — `uv run pytest` in the package I touched (or repo root)
- [ ] Rust — `cargo test` in `index/` (if the index changed)
- [ ] Extension — `npm run check && npm run bundle` in `extension/` (if the extension changed)
- [ ] End-to-end honesty contract — `python tests/e2e/planted_bug_golden/run.py` stays green
- [ ] Manual testing (describe below)

<!-- Notes on manual testing / anything a reviewer should look at hardest: -->

## Ground rules (product promises — must stay true)

- [ ] No new runtime network calls (beyond the one-time embedding-model download / optional prebuilt index artifacts)
- [ ] No telemetry
- [ ] No new required configuration or env var (feature-level keys route through the user's coding-agent harness)
- [ ] Tracer stays zero-edit (users never modify their own code to use Vinv)

## AI-assisted?

<!-- If an agent wrote part of this, say so and flag where reviewers should look hardest.
     You own the diff regardless — see CONTRIBUTING.md → "Working with AI coding agents". -->
