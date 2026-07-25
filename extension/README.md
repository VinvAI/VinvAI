<div align="center">

<img src="https://images.vinv.ai/vinv-banner-dark.png" alt="Vinv wordmark and tagline" width="700" />

### Vinv runs your code and hands your agent what actually happened.

**Zero-edit Python tracing · Code Graph · Behavior exerciser · Answers with citations · Fix &amp; verify loop · Two MCP servers · Auto-Pilot · Entirely local**

<br/>

[![Editors](https://img.shields.io/badge/editors-VS%20Code%20%2B%20Cursor-D71921?style=flat-square)](https://open-vsx.org/extension/VinvAI/VinvAI)
[![Traces Python](https://img.shields.io/badge/traces-Python%2C%20zero%20edits-D71921?style=flat-square)](https://vinv.ai)
[![100% local](https://img.shields.io/badge/100%25%20local-no%20telemetry-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI#privacy)
[![License](https://img.shields.io/badge/license-Apache%202.0-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI/blob/HEAD/LICENSE)
[![Made by VinvAI](https://img.shields.io/badge/made%20by-VinvAI-D71921?style=flat-square)](https://vinv.ai)

<br/>

[**Install from Open VSX**](https://open-vsx.org/extension/VinvAI/VinvAI) · [**Report a Bug**](https://github.com/VinvAI/VinvAI/issues) · [**Request a Feature**](https://github.com/VinvAI/VinvAI/issues/new)

</div>

---

## What is Vinv?

Vinv is a free, open-source extension that puts a verification loop around the coding agent you already use. It runs your service under tracing, builds context from what actually executed, exercises every endpoint itself, then grades your agent's fix against acceptance tests written before the fix that the agent never sees.

### Context beats model size — on a repo you know

One local run against [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) (35k★) took it from **0 of 23 endpoints executed to 23 of 23**, symbol coverage **18 → 37 of 44**, and banked **125 replayable regression cases**. It surfaced **four bugs and one performance problem** — all behind auth, which is why ordinary traffic never reached them.

Handed those same five issues to each setup, same prompts, Vinv grading every run:

| Setup | Fixed |
|---|---|
| **Cheap commodity model + Vinv context** | **4 bugs + 1 optimization** |
| Frontier model, working blind | 1 bug |
| Cheap commodity model, working blind | nothing |

One trial per condition — a demonstration, not a benchmark. [Full story and screenshots →](https://github.com/VinvAI/VinvAI#case-study-commodity-models-out-fix-frontier-ones)

**Before you install:** the extension is one click, but Vinv builds its engines on first run (`git clone` + `uv sync` + `cargo build` in a terminal you can watch) and fetches a one-time ~500 MB local embedding model. You need [uv](https://docs.astral.sh/uv/) and [Rust](https://rustup.rs), plus a coding-agent CLI you already pay for. No account, no API keys, about four minutes.

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

<img src="https://images.vinv.ai/runtime-tracing.gif" alt="Zero-edit Python tracing: timing, memory, arguments, returns and errors per call" width="720" />

Vinv traces your Python service with **no code changes**. Every call is recorded with timing, memory, arguments, returns, errors, and the request behind it — then joined back to the exact symbol in your source. Run your service under tracing with one keystroke (`Cmd+Alt+R` / `Ctrl+Alt+R`) or the **Open Trace Terminal** command.

---

### 🗺 Maps your codebase — Code Graph + semantic index

<img src="https://images.vinv.ai/code-graph.gif" alt="The interactive Code Graph: every symbol and call edge, with a live runtime overlay" width="720" />

A persistent semantic index and an interactive **Code Graph**, updated incrementally on save. Embeddings come from a local model served by `vinv-embedder` — nothing leaves your machine. Open it with **Graph Explorer**, and use **Enhance Graph** to resolve ambiguous references.

---

### 💬 Ask Vinv — answers with evidence

<img src="https://images.vinv.ai/semantic-code-search.gif" alt="Semantic code search: ask by meaning, get ranked symbols with line numbers" width="720" />

Ask questions about your codebase and get answers grounded in the code map **plus** real runtime evidence. Ask Vinv cites the exact symbols behind every claim and marks runtime facts that have gone stale, so you always know whether an answer reflects what actually ran. The comment icon at the top of the Flow panel opens it.

---

### 🔁 Closes the loop — fix, then verify

<img src="https://images.vinv.ai/verified-fixes.gif" alt="Independent fix verification: replayed start, live port, tests the agent never sees" width="720" />

Hand an issue to the coding agent you already use. Vinv composes the evidence pack, dispatches it (**Fix with Harness**), and then **verifies the result itself**: replayed start, live port, and acceptance tests the agent never sees. Set a standing goal for episodes, cap the episode budget, and review the trajectory of episodes, rewards, and goals. If a "verified" fix is still wrong, **dispute** it and the loop reopens.

---

### 🔌 Serves your agent — two MCP servers

Two MCP servers give any MCP client the evidence Vinv gathers:

- **Semantic code search** — find the right symbols by meaning, not just text.
- **Runtime observations** — suspect ranking, observed values, slices, coverage, and blast radius.

Register them in your agent tools with **Register Vinv MCP in Agent Tools**.

---

### 🎚 Effort budget — you decide how hard it tries

Auto-Pilot works inside a budget: attempts per service setup, fix episodes per distinct failure, and a total cap that catches errors whose signature shifts every attempt. All three are fields in **Configure**. When a run spends them, Vinv asks whether to grant more — answer once and the new level is saved for later runs, and the run continues from where it stopped rather than starting over.

### 🛫 Auto-Pilot — set up, run, and fix everything

Once the engines are installed and an agent is picked, **Auto-Pilot** takes over: it scans the project (code map, handbook, service inventory), sets up each service (your agent finds the real start command, Vinv verifies it), runs everything with tracing on, and fixes what breaks — sending failures to your agent with the evidence attached and re-checking each fix by running it. The **Flow panel** pulses on whatever step it's working; when something needs you, a single **Next step** card says what and why.

---

### 🤖 Bring your own coding agent

Vinv **never calls a model provider itself**. All of its thinking runs through a coding-agent CLI you already have installed and pay for — **Claude Code, Cursor CLI, Codex, Gemini CLI, Copilot Chat, Cascade**, and others. Open **Configure Project**, pick your agent, and save. That's the last decision Vinv asks you to make.

---

### 🧨 Exercises your API — no traffic needed *(new)*

Traffic only covers what users happen to hit. The **behavior exerciser** drives every endpoint itself: schema-derived valid/boundary/negative inputs, values mined from real traces, and multi-step auth scenarios — strategy picked per endpoint by a Thompson-sampling bandit rewarded by newly covered code. Every response becomes a permanent regression case; a state ledger tears down what the tests created and separates *your code regressed* from *test residue changed the world*.

### 🧭 Journey & Findings — walk everything, see what got fixed *(new)*

**Vinv: Open Journey** steps through every verified service and endpoint — call tree with live runtime, latency flamegraph, the exact inputs → outputs exercised, and a form to add your own test inputs (replayed forever after). **Vinv: Open Findings** shows issue clusters, optimization episodes with paired-bootstrap 95% confidence intervals, regression diffs by kind, and writes the same data machine-readable to `.vinv/reports/findings.json` for your agent.

<img src="https://images.vinv.ai/journey-walkthrough.gif" alt="Vinv Journey walkthrough of a FastAPI app: coverage, call trees, flamegraphs, exercised inputs and outputs" width="720" />

<img src="https://images.vinv.ai/findings-tour.gif" alt="Vinv Findings: issue clusters, optimization episodes with confidence intervals, regression kinds, latency profile and the cleanup ledger" width="720" />

### 🛡 No reward hacking, no doom loops

Acceptance tests are authored **before** the fix and never shown to the agent. A "faster" change that alters any observable output is auto-reverted (byte-identical replay + CI must exclude zero). A **doom-loop guard** catches an agent repeating itself; an adaptive silence watchdog catches a hung one; and when two attempts stop progressing, a **Nash-bargaining stall judge** either forces a genuinely different approach or hands you a judgment panel — never a token bonfire. Wrongly "verified"? **Vinv: Dispute a Verified Fix** feeds it back as evidence.

### 📈 Insights & analysis

<img src="https://images.vinv.ai/rank-suspects.gif" alt="Fault-ranked suspects over real pass/fail requests, with the error messages attached" width="720" />

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

Built by **[VinvAI](https://vinv.ai)** · [LinkedIn](https://www.linkedin.com/company/vinvai/) · [GitHub](https://github.com/VinvAI/VinvAI)

Context beats model size.

<br/>

[🌐 vinv.ai](https://vinv.ai) &nbsp;·&nbsp; [Open VSX](https://open-vsx.org/extension/VinvAI/VinvAI) &nbsp;·&nbsp; [GitHub](https://github.com/VinvAI/VinvAI) &nbsp;·&nbsp; [LinkedIn](https://www.linkedin.com/company/vinvai/) &nbsp;·&nbsp; [support@vinv.ai](mailto:support@vinv.ai) &nbsp;·&nbsp; [Report a Bug](https://github.com/VinvAI/VinvAI/issues)

</div>
