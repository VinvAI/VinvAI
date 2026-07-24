# Vinv — VS Code extension

**Runtime ground truth for your coding agent.** Your agent writes the code — Vinv watches it run, joins every call to source, serves that evidence over MCP, and independently verifies the agent's "done".

This is the editor front-end of the open-source Vinv monorepo (Apache License 2.0). The engines it drives — the zero-edit Python tracer (`tracelens`), the semantic index (`index`, Rust), the analysis agents (`handbook`, `bringup`, `identification`, `goal`), and the local embedding sidecar (`vinv-embedder`) — live in this same repository and run from source on your machine. No accounts, no API keys, no telemetry.

## What it does

- **Watches your code run** — traces your Python service with zero code changes: timing, memory, arguments, returns, errors, and the request behind each call.
- **Maps your codebase** — a persistent semantic index + interactive Code Graph, updated incrementally on save. Embeddings come from a local model served by `vinv-embedder` — nothing leaves your machine.
- **Answers with evidence** — Ask Vinv cites the exact symbols behind every claim and marks runtime facts that went stale.
- **Closes the loop** — hand an issue to the coding agent you already use (Claude Code, Codex CLI, Cursor, Gemini CLI, Copilot Chat, Cascade); Vinv composes the evidence pack, dispatches it, and verifies the result itself: replayed start, live port, acceptance tests the agent never sees.
- **Serves your agent** — two MCP servers give any MCP client semantic code search plus runtime observations (suspect ranking, observed values, slices, coverage, blast radius).

## Getting started

1. **Install everything** — `./install.sh` at the repo root builds the engines and installs this extension into every editor CLI it finds. (Or from this folder: `npm install && npm run bundle`, then F5 for a dev host.)
2. **Open your repo.** Vinv looks for the engines at the `vinv.enginesPath` setting, then `~/.vinv/engines`, then the checkout the extension itself lives in (this monorepo).
3. **Install the engines** if none were found — one click ("Vinv: Install Engines") runs `git clone <monorepo> ~/.vinv/engines && uv sync && cargo build --release` in a terminal. Requires [uv](https://docs.astral.sh/uv/getting-started/installation/) and [Rust](https://rustup.rs).
4. **Discovery runs automatically** — index, handbook, and service inventory. Analysis runs through your own coding-agent CLI; pick which one in Configure.
5. **Set up a service**, run it under tracing, and explore the graph / ask questions / dispatch fixes.

The Rust `index` binary always builds from source: resolved from the engines checkout's release build (`cargo build --release` in `index/`), a `~/.vinv/config.json` override, or `PATH` — see `src/engines/resolve.ts`.

## Development

```
npm install
npm run check    # tsc --noEmit
npm run bundle   # esbuild -> out/
npm test         # vscode-test suites
```

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
