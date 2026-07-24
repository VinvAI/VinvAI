<div align="center">

<img src="https://github.com/VinvAI/VinvAI/raw/HEAD/extension/media/vinv-logo.png" alt="Vinv" width="80" />

# Vinv

### Runtime ground truth for your coding agent.

**Zero-edit Python tracing · Semantic Code Graph · Ask Vinv with citations · Closed-loop fix & verify · Two MCP servers · Auto-Pilot · Runs entirely on your machine**

<br/>

[![Editors](https://img.shields.io/badge/editors-VS%20Code%20%2B%20Cursor-D71921?style=flat-square)](https://open-vsx.org/extension/VinvAI/VinvAI)
[![Traces Python](https://img.shields.io/badge/traces-Python%2C%20zero%20edits-D71921?style=flat-square)](https://vinv.ai)
[![100% local](https://img.shields.io/badge/100%25%20local-no%20telemetry-D71921?style=flat-square)](#privacy--your-code-never-leaves-your-machine)
[![License](https://img.shields.io/badge/license-Apache%202.0-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI/blob/HEAD/LICENSE)
[![Made by VinvAI](https://img.shields.io/badge/made%20by-VinvAI-D71921?style=flat-square)](https://vinv.ai)

<br/>

[**Install on VS Code**](https://marketplace.visualstudio.com/items?itemName=VinvAI.VinvAI) · [**Install on Cursor / Open VSX**](https://open-vsx.org/extension/VinvAI/VinvAI) · [**Report a Bug**](https://github.com/VinvAI/VinvAI/issues) · [**Request a Feature**](https://github.com/VinvAI/VinvAI/issues/new)

</div>

---

## What is Vinv?

Vinv is a free, open-source extension for VS Code and Cursor that gives your coding agent **runtime ground truth**. Your agent writes the code — Vinv watches it run, joins every call back to source, serves that evidence over MCP, and then independently verifies the agent's "done": replayed start, live port, acceptance tests the agent never sees.

The engines it drives — the zero-edit Python tracer (`tracelens`), the semantic index (`index`, Rust), the analysis agents (`handbook`, `bringup`, `identification`, `goal`), and the local embedding sidecar (`vinv-embedder`) — live in the same monorepo and run **from source on your machine**. No accounts, no API keys, no telemetry.

**Open the Flow panel in the Vinv sidebar — that's the whole product on one rail. Or press `Cmd+Alt+R` / `Ctrl+Alt+R` to run your service under tracing.**

---

## See it in action

<img src="https://images.vinv.ai/vinv-journey.gif" alt="Vinv journey — discover the project, run it under tracing, ask questions with citations, and dispatch a verified fix" width="100%" />
<p align="center"><sub>✦ The whole loop: <b>discover</b> the project → <b>run</b> it under tracing → <b>ask</b> questions answered from real runtime evidence → <b>fix</b> what breaks and let Vinv re-run it to verify.</sub></p>

---

## Why Vinv?

| | Your coding agent alone | With Vinv |
|---|:---:|:---:|
| **Knows what actually ran** | ✗ reads static code | ✅ real timing, memory, args, returns, errors per call |
| **Joins runtime to source** | ✗ | ✅ every observed call linked back to the exact symbol |
| **Answers with evidence** | ✗ plausible guesses | ✅ Ask Vinv cites the symbols behind every claim |
| **Flags stale facts** | ✗ | ✅ runtime facts that went stale are marked |
| **Verifies "done"** | ✗ trusts the agent | ✅ replayed start, live port, acceptance tests the agent never sees |
| **Semantic code map** | Partial | ✅ persistent index + interactive Code Graph, updated on save |
| **Local code search embeddings** | Cloud keys | ✅ local model via `vinv-embedder` — nothing leaves your machine |
| **Serves agents over MCP** | ✗ | ✅ two MCP servers: semantic search + runtime observations |
| **Closed-loop fixing** | Manual copy-paste | ✅ composes an evidence pack, dispatches, re-checks by running it |
| **Model provider** | Its own | ✅ brings your own agent CLI — Vinv never calls a model itself |
| **Telemetry / accounts** | Varies | ✅ none — everything runs on your machine |

---

## How it works — the engines

Vinv's engines are open source and run entirely on your machine:

- **`tracelens`** — records what your code actually does when it runs, with **no code changes**: timing, memory, arguments, returns, errors, and the request behind each call.
- **`index`** — a searchable semantic map of every function in your project (Rust; always builds from source).
- **`vinv-embedder`** — a local embedding model for code search, so **no cloud keys** are needed.
- **Analysis agents** (`handbook`, `bringup`, `identification`, `goal`) — write the plain-language handbook, work out how each service starts, and drive the closed-loop episodes.

One click ("**Vinv: Install Engines**") runs `git clone <monorepo> ~/.vinv/engines && uv sync` in a visible terminal. Already have the monorepo checked out? Vinv finds it automatically. Requires [uv](https://docs.astral.sh/uv/getting-started/installation/) and [Rust](https://rustup.rs).

---

## Features

### 👁 Watches your code run — zero-edit tracing

Vinv traces your Python service with **no code changes**. Every call is recorded with timing, memory, arguments, returns, errors, and the request behind it — then joined back to the exact symbol in your source. Run your service under tracing with one keystroke (`Cmd+Alt+R` / `Ctrl+Alt+R`) or the **Open Trace Terminal** command.

---

### 🗺 Maps your codebase — Code Graph + semantic index

A persistent semantic index and an interactive **Code Graph**, updated incrementally on save. Embeddings come from a local model served by `vinv-embedder` — nothing leaves your machine. Open it with **Graph Explorer**, and use **Enhance Graph** to resolve ambiguous references.

---

### 💬 Ask Vinv — answers with evidence

Ask questions about your codebase and get answers grounded in the code map **plus** real runtime evidence. Ask Vinv cites the exact symbols behind every claim and marks runtime facts that have gone stale, so you always know whether an answer reflects what actually ran. The comment icon at the top of the Flow panel opens it.

---

### 🔁 Closes the loop — fix, then verify

Hand an issue to the coding agent you already use. Vinv composes the evidence pack, dispatches it (**Fix with Harness**), and then **verifies the result itself**: replayed start, live port, and acceptance tests the agent never sees. Set a standing goal for episodes, cap the episode budget, and review the trajectory of episodes, rewards, and goals. If a "verified" fix is still wrong, **dispute** it and the loop reopens.

---

### 🔌 Serves your agent — two MCP servers

Two MCP servers give any MCP client the evidence Vinv gathers:

- **Semantic code search** — find the right symbols by meaning, not just text.
- **Runtime observations** — suspect ranking, observed values, slices, coverage, and blast radius.

Register them in your agent tools with **Register Vinv MCP in Agent Tools**.

---

### 🛫 Auto-Pilot — set up, run, and fix everything

Once the engines are installed and an agent is picked, **Auto-Pilot** takes over: it scans the project (code map, handbook, service inventory), sets up each service (your agent finds the real start command, Vinv verifies it), runs everything with tracing on, and fixes what breaks — sending failures to your agent with the evidence attached and re-checking each fix by running it. The **Flow panel** pulses on whatever step it's working; when something needs you, a single **Next step** card says what and why.

---

### 🤖 Bring your own coding agent

Vinv **never calls a model provider itself**. All of its thinking runs through a coding-agent CLI you already have installed and pay for — **Claude Code, Cursor CLI, Codex, Gemini CLI, Copilot Chat, Cascade**, and others. Open **Configure Project**, pick your agent, and save. That's the last decision Vinv asks you to make.

---

### 📈 Insights & analysis

- **Build Insights Now** — call trees, flamegraphs, and health reports of where time went.
- **Run Endpoint I/O Probes** — capture real inputs and outputs at your service boundaries.
- **Optimize Latency Hotspots** — dispatch the slowest paths to your coding agent.
- **Analyze Memory Trends** — leak suspects across sessions.
- **Analyze Cache Opportunities** — duplicate recomputation worth caching.

---

## Getting Started

**1. Install the extension**
- **VS Code** — Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`) → search **Vinv** → **Install**.
- **Cursor / VSCodium / Open VSX** — same search, pulls from the [Open VSX Registry](https://open-vsx.org/extension/VinvAI/VinvAI).
- **From source** — `./install.sh` at the repo root builds the engines and installs the extension into every editor CLI it finds. (Or from `extension/`: `npm install && npm run bundle`, then `F5` for a dev host.)

**2. Open your repo.** Vinv looks for the engines at the `vinv.enginesPath` setting, then `~/.vinv/engines`, then the checkout the extension itself lives in.

**3. Install the engines** if none were found — one click (**Vinv: Install Engines**) runs `git clone <monorepo> ~/.vinv/engines && uv sync`. Requires [uv](https://docs.astral.sh/uv/getting-started/installation/) and [Rust](https://rustup.rs).

**4. Pick your coding agent** in **Configure Project**. Discovery then runs automatically — index, handbook, and service inventory.

**5. Set up a service**, run it under tracing, and explore the graph, ask questions, and dispatch fixes — all from the **Flow panel**.

---

## Commands

Every command is available from the Command Palette under the **Vinv** category.

| Command | What it does |
|---------|--------------|
| **Auto-Pilot** | Set up, run, and fix everything |
| **What Should I Do Next?** | The single next step, and why |
| **Discover Project** | Build the code map, handbook, and service inventory |
| **Ask Vinv** | Answer questions with cited runtime + code evidence |
| **Run Service** | Start your service under tracing (`Cmd/Ctrl+Alt+R`) |
| **Open Trace Terminal** | Run `tracelens` directly |
| **Open Graph Explorer** | The interactive Code Graph |
| **Build Insights Now** | Call trees, flamegraphs, health reports |
| **Fix with Harness** | Dispatch a closed-loop fix episode |
| **Show Trajectory** | Episodes, rewards, and goals |
| **Register Vinv MCP in Agent Tools** | Wire the MCP servers into your agent |
| **Export Diagnostics** | Bundle logs for support |

---

## Keyboard Shortcuts

| Action | Mac | Windows / Linux |
|--------|-----|-----------------|
| Run Service under tracing | `Cmd+Alt+R` | `Ctrl+Alt+R` |

Everything else lives in the **Flow panel** in the Vinv sidebar and the Command Palette (**Vinv:** …).

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vinv.enginesPath` | `""` | Path of the Vinv engines monorepo checkout. Leave empty to auto-detect (`~/.vinv/engines`, or the checkout the extension itself lives in). |

---

## Requirements

- VS Code `1.75.0` or higher (or a compatible editor: Cursor, VSCodium)
- A **Python** service to trace
- [uv](https://docs.astral.sh/uv/getting-started/installation/) and [Rust](https://rustup.rs) to build the engines
- A **coding-agent CLI** you already use (Claude Code, Cursor CLI, Codex, Gemini CLI, …) — Vinv drives it; it never calls a model provider itself
- Everything runs **locally**: no account, no API keys, no telemetry

---

## Privacy — your code never leaves your machine

Vinv is **local-first by design**. There is no Vinv cloud, no account, and no sign-in.

- **All data stays on your machine.** Traces, the code map, embeddings, handbooks, and episode history are written under your project and `~/.vinv/` — nothing is uploaded to us or anyone else.
- **We don't collect anything.** No telemetry, no analytics, no usage pings, no crash reports phoned home. Vinv makes no network calls to VinvAI.
- **No API keys to us.** Code-search embeddings are produced by a local model (`vinv-embedder`) — no cloud provider, no keys.
- **You bring your own agent.** Vinv never calls a model provider itself. Any request to an LLM goes through the coding-agent CLI *you* installed and configured, under your own account and terms — Vinv only hands it evidence and reads the result.
- **Open source, so you can check.** Every engine runs from source in this repository ([Apache 2.0](./LICENSE)); nothing is hidden in a binary blob.

The only network activity Vinv triggers is the install step you run explicitly (`git clone` the engines, `uv sync`, `cargo build`) and whatever your chosen coding agent does on your behalf.

---

## Development

```
npm install
npm run check    # tsc --noEmit
npm run bundle   # esbuild -> out/
npm test         # vscode-test suites
npm run package  # build the .vsix
```

The Rust `index` binary always builds from source: resolved from the engines checkout's release build (`cargo build --release` in `index/`), a `~/.vinv/config.json` override, or `PATH` — see `src/engines/resolve.ts`.

For bugs or feature requests → [open an issue](https://github.com/VinvAI/VinvAI/issues).

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE). © 2026 VinvAI.

---

<div align="center">

Built by **[VinvAI](https://vinv.ai)** — runtime ground truth for your coding agent.

<br/>

[🌐 vinv.ai](https://vinv.ai) &nbsp;·&nbsp; [GitHub](https://github.com/VinvAI/VinvAI) &nbsp;·&nbsp; [Report a Bug](https://github.com/VinvAI/VinvAI/issues)

</div>
