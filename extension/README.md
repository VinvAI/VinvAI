<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://images.vinv.ai/vinv-banner-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://images.vinv.ai/vinv-banner-light.png">
  <img src="https://images.vinv.ai/vinv-banner-light.png" alt="Vinv wordmark and tagline" width="700" />
</picture>

### An autonomous swarm that finds bugs, dead code and performance issues in your codebase — and fixes them with closed-loop RL.

Nine oracles hunt a real run of your code. Findings go to the coding agent you already pay for. Nothing lands unless it survives acceptance tests written **before** the fix that the agent never sees — and every outcome trains what the swarm hunts next, on your machine.

<sub>Python first — services **and** plain libraries. Judgement comes from what the code actually did, not from what the agent claims.</sub>

<img src="https://images.vinv.ai/vinv-loop.svg" alt="From cold repo to production-ready: Vinv's nine stages around your coding agent — bring up, trace, index, map, exercise, find, dispatch, verify, learn" width="820" />

<sub>One command starts it. Vinv drives the other eight stages.</sub>

**Zero-edit Python tracing · Code Graph · Dead-code sections · Nine hunting oracles · Answers with citations · Fix &amp; verify loop · MCP servers · Auto-Pilot · Entirely local**

<br/>

[![Editors](https://img.shields.io/badge/editors-VS%20Code%20%2B%20Cursor-D71921?style=flat-square)](https://open-vsx.org/extension/VinvAI/VinvAI)
[![Traces Python](https://img.shields.io/badge/traces-Python%2C%20zero%20edits-D71921?style=flat-square)](https://vinv.ai)
[![100% local](https://img.shields.io/badge/100%25%20local-no%20telemetry-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI#privacy)
[![License](https://img.shields.io/badge/license-Apache%202.0-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI/blob/HEAD/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-VinvAI-D71921?style=flat-square&logo=github&logoColor=white)](https://github.com/VinvAI/VinvAI)
[![Support](https://img.shields.io/badge/support-support%40vinv.ai-D71921?style=flat-square)](mailto:support@vinv.ai)
[![Made by VinvAI](https://img.shields.io/badge/made%20by-VinvAI-D71921?style=flat-square)](https://vinv.ai)

<br/>

[**Install from Open VSX**](https://open-vsx.org/extension/VinvAI/VinvAI) · [**Report a Bug**](https://github.com/VinvAI/VinvAI/issues) · [**Request a Feature**](https://github.com/VinvAI/VinvAI/issues/new)

</div>

---

## What is Vinv?

Vinv is a free, open-source extension that hunts your Python code for real defects and then **proves** the fixes. It runs your project under a zero-edit tracer, builds one context graph from what actually executed, drives your endpoints *and* your functions itself, and grades your agent's fix against acceptance tests written before the fix that the agent never sees.

**Your agent says it's done. Vinv says prove it.**

### The swarm, named

Nine oracles, each with a distinct way of breaking your code, all writing into the same findings list and the same fix-dispatch path:

| Oracle | What it finds |
|---|---|
| **HTTP exerciser** | Drives every endpoint itself — schema-valid, boundary, negative, values mined from real traces, multi-step auth scenarios |
| **Function harness** | Calls your functions **in process** — no routes, no server. This is what makes a plain **library** testable |
| **Differential oracle** | Compares a function against a reference implementation — for an evaluator or parser, CPython itself. Disagreement *is* the bug report |
| **Fault injection** | Adversarial-but-**legal** shapes at a dependency boundary, plus a sweep of every chunk-split point on a stream |
| **Concurrency oracle** | Deterministic interleavings and timeout injection — shared state that corrupts in parallel, lock orderings that deadlock |
| **Environment oracle** | Dependency-resolution matrix, and upstream symbols whose signature moved under you |
| **Golden I/O baselines** | A "faster" change that quietly dropped a response field or changed a status class |
| **Dead code** | Untraced *islands* — connected sections nothing executed in any recorded run — with the live callers that still reference them |
| **Runtime analysis** | Latency hotspots, memory-leak suspects, duplicate recomputation worth caching, throughput ceiling |

They don't all run flat out. **One budget is allocated across every armed oracle by Thompson sampling** over `(target × technique × oracle)`, cost is measured rather than assumed, credit is paid once per defect signature, and the posteriors persist — so *which technique pays on your repo* is learned across runs.

### Context beats model size

Receipts first. One local run against [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) (~44k★) took it from **0 of 23 endpoints executed to 23 of 23**, symbol coverage **18 → 37 of 44**, and banked **125 replayable regression cases**. It surfaced **four bugs and one performance problem** — all behind auth.

Same five issues, same prompts, Vinv grading:

| Setup | Fixed |
|---|---|
| **Cheap commodity model + Vinv evidence** | **4 bugs + 1 optimization** |
| Frontier model, working blind | 1 bug |
| Cheap commodity model, working blind | nothing |

One trial per condition — a demonstration, not a benchmark. [Full story →](https://github.com/VinvAI/VinvAI#context-beats-model-size)

On the same template: live traces showed the default DB pool making requests **queue for connection checkouts** under load — sustained-load median **75.6ms → 41.2ms (45.4% faster, 95% CI [36.3%, 45.8%])**, responses byte-identical; two uncertified attempts auto-reverted.

<img src="https://images.vinv.ai/vinv-pool-optimization-proof-light.gif" alt="Vinv on the FastAPI template: 45.4% sustained-load median improvement with paired-bootstrap 95% CI" width="720" />

Same discipline on [huggingface/smolagents](https://github.com/huggingface/smolagents) (~28.5k★): benchmarked allocation fast-path in `sanitize_for_rich` — `tracemalloc` on a 4&nbsp;KB log line **36.27&nbsp;KB → 0.00&nbsp;KB (~37,137× less)**; `log_task` **~615.7&nbsp;KB → ~125&nbsp;B** across 3 calls; byte-identical across 2,015 inputs. Upstream as [**PR #2572**](https://github.com/huggingface/smolagents/pull/2572).

<p align="center">
<a href="https://github.com/huggingface/smolagents/pull/2572"><img src="https://raw.githubusercontent.com/VinvAI/VinvAI/main/docs/media/smolagents-pr-2572.png" alt="PR #2572 on huggingface/smolagents — benchmarked perf fast-path" width="720"></a><br>
<img src="https://raw.githubusercontent.com/VinvAI/VinvAI/main/docs/media/smolagents-pr-2572-diff.png" alt="Light-theme Files changed view for smolagents PR #2572" width="720">
</p>

**Before you install:** the extension is one click, but Vinv builds its engines on first run (`git clone` + `uv sync` + `cargo build` in a terminal you can watch) and fetches a one-time ~500 MB local embedding model. You need [uv](https://docs.astral.sh/uv/) and [Rust](https://rustup.rs), plus a coding-agent CLI you already pay for. No account, no API keys, about four minutes.

The engines it drives — the zero-edit Python tracer (`tracelens`), the semantic index (`index`, Rust), the oracle swarm (`exerciser`), the analysis agents (`handbook`, `bringup`, `identification`, `goal`), and the local embedding sidecar (`vinv-embedder`) — live in the same monorepo and run **from source on your machine**.

**Open the Flow panel in the Vinv sidebar — that's the whole product on one rail. Or press `Cmd+Alt+R` / `Ctrl+Alt+R` to run your service under tracing.**

---

## See it in action

<img src="https://images.vinv.ai/vinv-journey-light.gif" alt="Vinv journey — discover the project, run it under tracing, ask questions with citations, and dispatch a verified fix" width="100%" />
<p align="center"><sub>✦ The whole loop: <b>discover</b> the project → <b>run</b> it under tracing → <b>ask</b> questions answered from real runtime evidence → <b>fix</b> what breaks and let Vinv re-run it to verify.</sub></p>

---

## Why Vinv?

| | Your coding agent alone | With Vinv |
|---|:---:|:---:|
| **Knows what actually ran** | ✗ reads static code | ✅ real timing, memory, args, returns, errors per call |
| **Joins runtime to source** | ✗ | ✅ every observed call linked back to the exact symbol |
| **Finds dead code** | ✗ can't tell used from unused | ✅ never-executed islands, live callers, and a try-run driver |
| **Answers with evidence** | ✗ plausible guesses | ✅ Ask Vinv cites the symbols behind every claim |
| **Flags stale facts** | ✗ | ✅ runtime facts that went stale are marked |
| **Verifies "done"** | ✗ trusts the agent | ✅ replayed start, live port, acceptance tests the agent never sees |
| **Tests a library** | writes unit tests from the signature | ✅ drives real functions in a sandbox, diffs against a reference |
| **Semantic code map** | Partial | ✅ persistent index + interactive Code Graph, updated on save |
| **Local code search embeddings** | Cloud keys | ✅ local model via `vinv-embedder` — nothing leaves your machine |
| **Serves agents over MCP** | ✗ | ✅ MCP servers: semantic search, runtime observations, exercise reporting |
| **Closed-loop fixing** | Manual copy-paste | ✅ composes an evidence pack, dispatches, re-checks by running it |
| **Model provider** | Its own | ✅ brings your own agent CLI — Vinv never calls a model itself |
| **Telemetry / accounts** | Varies | ✅ none — everything runs on your machine |

---

## How it works — the engines

Vinv's engines are open source and run entirely on your machine:

- **`tracelens`** — records what your code actually does when it runs, with **no code changes**: timing, memory, arguments, returns, errors, and the request behind each call.
- **`index`** — a searchable semantic map of every function in your project (Rust; always builds from source).
- **`exerciser`** — the oracle swarm and the budget bandit that allocates across it.
- **`vinv-embedder`** — a local embedding model for code search, so **no cloud keys** are needed.
- **Analysis agents** (`handbook`, `bringup`, `identification`, `goal`) — write the plain-language handbook, work out how each service starts, and drive the closed-loop episodes.

Already have the monorepo checked out? Vinv finds it automatically.

---

## Features

### 👁 Watches your code run — zero-edit tracing

<img src="https://images.vinv.ai/runtime-tracing-light.gif" alt="Zero-edit Python tracing: timing, memory, arguments, returns and errors per call" width="720" />

Vinv traces your Python service with **no code changes**. Every call is recorded with timing, memory, arguments, returns, errors, and the request behind it — then joined back to the exact symbol in your source. Run your service under tracing with one keystroke (`Cmd+Alt+R` / `Ctrl+Alt+R`) or the **Open Trace Terminal** command.

---

### 🪦 Finds dead code from what actually ran *(new)*

<img src="https://images.vinv.ai/dead-code.gif" alt="A dead-code section report: reachable but untested, the live code that still references it, and the agent's keep-or-cut verdict with its reasoning" width="720" />

Static tools can only prove *"nothing statically references this"* — they can't see dynamic dispatch, feature flags or registries, so they emit candidates a human has to adjudicate. Vinv says something else:

> **"No capture ever executed this. Here's what still references it, here's the traced neighbourhood it would wire back into, and here's what your agent thinks it is."**

The unit is a **section** — a connected island of untraced symbols — not a lint row, because dead code is almost never one function. Each section carries its reachability evidence (`REACHED FROM LIVE CODE` versus `NO REFERENCES` — opposite verdicts), the live neighbourhood retrieved by a graph walk, and your agent's judgment: `integrate` · `reimagine` · `delete` · `keep` · `unclear`, with what breaks if it goes.

- **Vinv: Analyze Dead Code** — explains every section, in batches so the agent can spot *"this is the older copy of the section below"*.
- **Vinv: Try Run Dead Code** — asks your agent to write a driver for one section, runs it under the tracer, and **counts** which symbols came alive.

It refuses to call anything dead with no trace on disk, and it never drops a section silently — the caps are shown, so "12 sections" is distinguishable from "12 is the cap".

---

### 🗺 Maps your codebase — Code Graph + semantic index

<img src="https://images.vinv.ai/code-graph-light.gif" alt="The interactive Code Graph: every symbol and call edge, with a live runtime overlay" width="720" />

A persistent semantic index and an interactive **Code Graph**, updated incrementally on save. Embeddings come from a local model served by `vinv-embedder` — nothing leaves your machine. Open it with **Graph Explorer**, and use **Enhance Graph** to resolve ambiguous references.

---

### 💬 Ask Vinv — answers with evidence

<img src="https://images.vinv.ai/semantic-code-search-light.gif" alt="Semantic code search: ask by meaning, get ranked symbols with line numbers" width="720" />

Ask questions about your codebase and get answers grounded in the code map **plus** real runtime evidence. Ask Vinv cites the exact symbols behind every claim and marks runtime facts that have gone stale, so you always know whether an answer reflects what actually ran. The comment icon at the top of the Flow panel opens it.

---

### 🔁 Closes the loop — fix, then verify

<img src="https://images.vinv.ai/verified-fixes-light.gif" alt="Independent fix verification: replayed start, live port, tests the agent never sees" width="720" />

Hand an issue to the coding agent you already use. Vinv composes the evidence pack, dispatches it (**Fix with Harness**), and then **verifies the result itself**: replayed start, live port, and acceptance tests the agent never sees — stored outside your workspace under an opaque token and required to fail deterministically *twice* on the broken code, so a test that passes pre-fix is thrown away. A deterministic anti-cheat audit over the diff blocks test edits, swallowed exceptions and shadow modules outright. If a "verified" fix is still wrong, **dispute** it and the loop reopens.

---

### 🧨 Exercises everything — endpoints *and* functions *(new)*

Traffic only covers what users happen to hit, and routes only cover what a request can reach. So Vinv drives both:

- **Every endpoint** — schema-derived valid/boundary/negative inputs, values mined from real traces, multi-step auth scenarios; strategy picked per endpoint by a Thompson-sampling bandit rewarded by oracle violations, with new coverage worth only a 0.25 bonus so exploring never outranks finding.
- **Every exported function**, in process — which is how a repo with **no service at all** still gets hunted. Targets the purity guard can't verify run behind a **containment ladder**: a kernel-enforced OS sandbox where your host offers one, otherwise a process shim, always with a disposable repo copy, redirected `HOME`/`TMPDIR`, and blocked network and subprocess spawning. Postgres, Redis and S3 are substituted *inside* the jail so code that needs them runs instead of failing to connect.

Every response becomes a permanent regression case; a state ledger tears down what the tests created and separates *your code regressed* from *test residue changed the world*.

### 🧭 Journey & Findings — walk everything, see what got fixed

**Vinv: Open Journey** steps through every verified service and endpoint — call tree with live runtime, latency flamegraph, the exact inputs → outputs exercised, and a form to add your own test inputs (replayed forever after). **Vinv: Open Findings** shows issue clusters, optimization episodes with paired-bootstrap 95% confidence intervals, regression diffs by kind, and writes the same data machine-readable to `.vinv/reports/findings.json` for your agent.

<img src="https://images.vinv.ai/journey-walkthrough.gif" alt="Vinv Journey walkthrough of a FastAPI app: coverage, call trees, flamegraphs, exercised inputs and outputs" width="720" />

<img src="https://images.vinv.ai/findings-tour.gif" alt="Vinv Findings: issue clusters, optimization episodes with confidence intervals, regression kinds, latency profile and the cleanup ledger" width="720" />

### 🎚 Effort budget — you decide how hard it tries

Auto-Pilot works inside a budget: attempts per service setup, fix episodes per distinct failure, and a total cap that catches errors whose signature shifts every attempt. All three are fields in **Configure**. When a run spends them, Vinv asks whether to grant more — answer once and the new level is saved for later runs, and the run continues from where it stopped rather than starting over.

### 🛫 Auto-Pilot — set up, run, and fix everything

Once the engines are installed and an agent is picked, **Auto-Pilot** takes over: it scans the project (code map, handbook, service inventory), sets up each service (your agent finds the real start command, Vinv verifies it), runs everything with tracing on, turns the swarm loose, and fixes what breaks — sending failures to your agent with the evidence attached and re-checking each fix by running it. The **Flow panel** pulses on whatever step it's working; when something needs you, a single **Next step** card says what and why.

### 🤖 Bring your own coding agent

Vinv **never calls a model provider itself**. All of its thinking runs through a coding-agent CLI you already have installed and pay for — **Claude Code, Cursor CLI, Codex, Gemini CLI, Copilot Chat, Cascade**, and others. Open **Configure Project**, pick your agent, and save. That's the last decision Vinv asks you to make.

### 🔌 Serves your agent — MCP servers

- **Semantic code search** — find the right symbols by meaning, not just text.
- **Runtime observations** — suspect ranking, observed values, slices, coverage, and blast radius.
- **Exercise reporting** — your agent can run your service's tests and report the result back, and Vinv grades what came back.

Register them in your agent tools with **Register Vinv MCP in Agent Tools**.

### 🛡 No reward hacking, no doom loops

Acceptance tests are authored **before** the fix and never shown to the agent; an advisory mutation smoke runs against them and its survivors are never revealed either — the Goodhart guard. A "faster" change that alters any observable output is auto-reverted (byte-identical replay + CI must exclude zero). A **doom-loop guard** catches an agent repeating itself; an adaptive silence watchdog catches a hung one; and when two attempts stop progressing, a **Nash-bargaining stall judge** either forces a genuinely different approach or hands you a judgment panel — never a token bonfire. Wrongly "verified"? **Vinv: Dispute a Verified Fix** feeds it back as evidence.

### 📈 Insights & analysis

<img src="https://images.vinv.ai/rank-suspects-light.gif" alt="Fault-ranked suspects over real pass/fail requests, with the error messages attached" width="720" />

- **Build Insights Now** — call trees, flamegraphs, and health reports of where time went.
- **Run Endpoint I/O Probes** — capture real inputs and outputs at your service boundaries.
- **Optimize Latency Hotspots** — dispatch the slowest paths to your coding agent.
- **Analyze Memory Trends** — leak suspects across sessions (Theil–Sen slope, robust to a noisy outlier).
- **Analyze Cache Opportunities** — duplicate recomputation worth caching.

The **Optimize** panel ranks candidates by the time you would actually get back, and every dispatch goes out as *predicted* and comes back *proven* — or reverted.

<img src="https://images.vinv.ai/optimize.gif" alt="The Optimize panel: open opportunities, recoverable milliseconds, and per-call latency measured against the whole-flow ceiling" width="720" />

---

## Getting Started

**1. Install the extension**
- **VS Code** — Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`) → search **Vinv** → **Install**.
- **Cursor / VSCodium / Open VSX** — same search, pulls from the [Open VSX Registry](https://open-vsx.org/extension/VinvAI/VinvAI).
- **From source** — `./install.sh` at the repo root builds the engines and installs the extension into every editor CLI it finds. (Or from `extension/`: `npm install && npm run bundle`, then `F5` for a dev host.)

**2. Open your repo.** Vinv looks for the engines at the `vinv.enginesPath` setting, then `~/.vinv/engines`, then the checkout the extension itself lives in.

**3. Install the engines** if none were found — one click (**Vinv: Install Engines**) runs `git clone <monorepo> ~/.vinv/engines && uv sync`. Requires [uv](https://docs.astral.sh/uv/getting-started/installation/) and [Rust](https://rustup.rs).

**4. Pick your coding agent** in **Configure Project**. Discovery then runs automatically — index, handbook, and service inventory.

**5. Set up a service**, run it under tracing, and explore the graph, ask questions, and dispatch fixes — all from the **Flow panel**. No service to run? Auto-Pilot still turns the service-free oracles loose on your code.

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
| **Test Every Endpoint (Behavioral Exercise)** | Turn the oracle swarm loose |
| **Analyze Dead Code** | Ask your agent what every untraced section actually is |
| **Try Run Dead Code** | Drive one dead section under trace and count what came alive |
| **Open Trace Terminal** | Run `tracelens` directly |
| **Open Graph Explorer** | The interactive Code Graph |
| **Open Journey / Open Findings** | Walk the verified flow · what was found and fixed |
| **Build Insights Now** | Call trees, flamegraphs, health reports |
| **Fix with Harness** | Dispatch a closed-loop fix episode |
| **Dispute a Verified Fix** | It's still wrong — reopen the loop |
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
| `vinv.notices.enabled` | `true` | Check `notices.vinv.ai` on activation for broken-release and security notices. See [Privacy](#privacy--your-code-never-leaves-your-machine). |

---

## Requirements

- VS Code `1.75.0` or higher (or a compatible editor: Cursor, VSCodium, Windsurf, Trae)
- A **Python** project — a service to trace, or just a library to drive
- [uv](https://docs.astral.sh/uv/getting-started/installation/) and [Rust](https://rustup.rs) to build the engines
- A **coding-agent CLI** you already use (Claude Code, Cursor CLI, Codex, Gemini CLI, …) — Vinv drives it; it never calls a model provider itself
- Everything runs **locally**: no account, no API keys, no telemetry

---

## Privacy — your code never leaves your machine

Vinv is **local-first by design**. There is no Vinv cloud, no account, and no sign-in.

- **All data stays on your machine.** Traces, the code map, embeddings, handbooks, and episode history are written under your project and `~/.vinv/` — nothing is uploaded to us or anyone else.
- **We don't collect anything.** No telemetry, no analytics, no usage pings, no crash reports phoned home.
- **One outbound request, and you can read the code that makes it.** On activation the extension GETs a static JSON file at `notices.vinv.ai`, so a release that leaves your install broken has some way to tell you. It is for broken releases and security notices only — no query string, no identifiers, no version, nothing uploaded; all filtering happens on your machine; at most once every 12 hours; it follows no redirects and the URL is a constant no setting can repoint. Turn it off with `vinv.notices.enabled`.
- **No API keys to us.** Code-search embeddings are produced by a local model (`vinv-embedder`) — no cloud provider, no keys.
- **You bring your own agent.** Vinv never calls a model provider itself. Any request to an LLM goes through the coding-agent CLI *you* installed and configured, under your own account and terms — Vinv only hands it evidence and reads the result.
- **Your code runs where you can see it.** Function-level exercising runs unverified targets in a sandbox with a disposable copy of your repo, blocked network, and blocked subprocess spawning — and reports honestly which containment tier your host actually provided.
- **Open source, so you can check.** Every engine runs from source in this repository ([Apache 2.0](./LICENSE)); nothing is hidden in a binary blob.

The only other network activity Vinv triggers is the install step you run explicitly (`git clone` the engines, `uv sync`, `cargo build`, the one-time embedding-model download) and whatever your chosen coding agent does on your behalf.

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

**Your agent says it's done. Vinv says prove it.**

Built by **[VinvAI](https://vinv.ai)** · [LinkedIn](https://www.linkedin.com/company/vinvai/) · [GitHub](https://github.com/VinvAI/VinvAI)

Context beats model size.

<br/>

[🌐 vinv.ai](https://vinv.ai) &nbsp;·&nbsp; [Open VSX](https://open-vsx.org/extension/VinvAI/VinvAI) &nbsp;·&nbsp; [GitHub](https://github.com/VinvAI/VinvAI) &nbsp;·&nbsp; [LinkedIn](https://www.linkedin.com/company/vinvai/) &nbsp;·&nbsp; [support@vinv.ai](mailto:support@vinv.ai) &nbsp;·&nbsp; [Report a Bug](https://github.com/VinvAI/VinvAI/issues)

</div>
