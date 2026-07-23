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

## Before you send a PR

- **Python**: `uv run pytest` inside the package you touched (or at the root
  for everything).
- **Rust**: `cargo test` in `index/`.
- **Extension**: `npm run check && npm run bundle` in `extension/`.
- **End-to-end**: `python tests/e2e/planted_bug_golden/run.py` — plants a real
  bug, traces it, and asserts the evidence names the exact symbol and line.
  This is the honesty contract of the whole product; it must stay green.

## Ground rules

- No network calls at runtime except: the one-time embedding-model download,
  and optional prebuilt `index` artifacts. Anything else is a bug — Vinv's
  promise is that everything runs locally.
- No telemetry. Don't add any.
- No new required configuration. If a feature needs an API key to work, it
  routes through the user's coding-agent harness instead.
- Keep the tracer zero-edit: users never modify their own code to use Vinv.

## License

By contributing you agree your contributions are licensed under the
[Elastic License 2.0](LICENSE).
