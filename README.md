<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://images.vinv.ai/vinv-banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://images.vinv.ai/vinv-banner-light.svg">
  <img src="https://images.vinv.ai/vinv-banner-dark.svg" alt="Vinv — gives vibe coders and their coding agents eyes. Your agent says it's done. Vinv says prove it." width="720">
</picture>

<br><br>

**Vinv records a real run of your Python backend and checks your coding agent's "done" — replayed start, live port, acceptance tests the agent never sees.**

[**vinv.ai**](https://vinv.ai) · **Free & source-available · Elastic License 2.0** · Python first · TS & Go next

**No account. No API keys. No telemetry. Everything runs on your machine.**

</div>

---

Your agent has never watched your code run — it edits the wrong handler, invents return shapes, then grades its own homework: *"Done — all tests pass"* while the server won't even start.

Vinv records the run, ties every request to the exact line that served it, hands that evidence to your agent — and when the agent claims a fix, **Vinv checks it independently**: replayed start, live port, acceptance tests the agent never sees. One click reverts everything an episode touched — untracked files included.

`// the loop, for real — installed, discovered, traced, broken, fixed, verified — on this very repo`

<div align="center">
<img src="https://images.vinv.ai/vinv-journey.gif" alt="The real Vinv flow, captured from vinv running on its own repository: one-command install, Auto-Pilot discovering and starting every service, the 4,000-symbol Code Graph, live traces, a real BrokenPipeError caught and auto-dispatched to the agent, the verified fix, and all services green" width="720">
</div>

<sub>Eight real captures of vinv running on <b>its own repository</b>: ① <code>./install.sh</code> — one command, everything builds from source · ② Auto-Pilot discovers all 4 services (HTTP sidecar, dev server, two stdio MCP servers) and sets them up unaided · ③ the Code Graph — 4,036 symbols, live runtime overlay · ④ real traced traffic with per-endpoint health reports · ⑤ served to your agent over MCP — semantic search and fault-ranked suspects, real round-trips · ⑥ a <i>real</i> production bug (<code>BrokenPipeError</code> in live runs) detected and auto-dispatched — "Fix sent, agent working" · ⑦ input/output probes re-verify the fix against golden baselines · ⑧ everything green, zero clicks. Runtime tracing is Python-first, so trace/flamegraph frames show the Python service; the JS services get discovery, verified starts, and stdio/port probes.</sub>

## `// WHAT VINV DOES`

- **Watches your code run** — a zero-edit Python tracer records your code's calls as they happen: timing, memory, arguments, returns, errors, and the request that triggered each one.
- **Maps your codebase** — a persistent semantic index + interactive Code Graph, built with a **local embedding model** ([CodeRankEmbed](https://huggingface.co/nomic-ai/CodeRankEmbed), MIT, 137M params — downloaded once, runs on your GPU/CPU), updated incrementally on save.
- **Answers with evidence** — Ask Vinv cites the exact symbols behind every claim and marks runtime facts that went stale when the code changed.
- **Closes the loop** — hand an issue to your own coding agent; Vinv composes the evidence pack, dispatches it, and **verifies the result itself**.
- **Works with the agent you already use** — Claude Code, Codex CLI, Cursor (CLI & chat), Gemini CLI, Copilot Chat, Windsurf Cascade — over MCP and headless dispatch. **Your agent is also Vinv's only LLM**: every analysis step routes through the coding-agent CLI you already pay for. No provider keys, no model picker.

## `// INSTALL`

Everything runs from this repository — no marketplace, no downloads, no accounts:

```bash
git clone https://github.com/VinvAI/VinvAI ~/.vinv/engines
cd ~/.vinv/engines && ./install.sh
```

`install.sh` builds the Python engines ([uv](https://docs.astral.sh/uv/)), the Rust index ([rustup](https://rustup.rs)), packages the editor extension (node), and installs it into every editor CLI it finds (VS Code, Cursor, Windsurf, VSCodium, Trae). Then **open your repo** — Auto-Pilot takes it from there, zero clicks: the embedding model downloads (~500 MB once) and auto-tunes to your hardware, the index builds, every service is discovered, set up through your coding agent, started under tracing, and verified serving. Problems found along the way are dispatched to your agent and re-verified automatically.

> **Honest scope:** Python backends first — other stacks get the index, graph, and QnA, but no runtime evidence (TS & Go next) · v0.0.x · works with six agents over MCP and headless dispatch · Vinv does **not** do cost metering, security scanning of generated code, or production deployment.

## `// PROVEN ON ITSELF — EVERY CLAIM MEASURED`

Vinv's release gate is Vinv: the loop above ran against this repository, and these numbers come from that run —

- **Zero-click Auto-Pilot** — discover → set up every service via your agent → start under tracing → build insights → probe → fix → re-verify, until green or budget. All 4 of this repo's services (an HTTP sidecar, a dev server, two stdio MCP servers) came up unaided; run-to-completion CLIs are recognized and skipped, never retry-looped.
- **Measured, not assumed** — the embedder benchmarks your actual hardware once and persists the winner (`~/.vinv/embedder_tuned.json`). On an M-series Mac that verdict was CPU at 15.3 texts/s vs 0.2 on the GPU — a 70× trap the old "prefer GPU" default walked straight into.
- **Crash-proof by proof** — we killed the indexer mid-run (resumed at row 448 exactly), killed the embedder mid-build (indexer rode it out), and killed a traced service with SIGKILL (supervisor exits in 0s, trace intact).
- **Finds what nobody filed** — running its own analyzers on its own traces surfaced five unfiled issues, including 83% duplicate compute (now cached) and an 80%-noise LLM adjudication queue (now culled).
- **Optimizes without regressing** — every endpoint gets golden input/output baselines; a "faster" change that drops a response field is flagged **degraded**. Retrieval config changes only on off-policy-evaluation wins (doubly-robust, bootstrap CI, 5% canary, auto-rollback).
- **Search that names the line** — hybrid local retrieval: file hit@10 0.90, symbol MRR 0.51, 81ms median — and every answer is a real symbol with its `def` body and line numbers, joined to what actually ran.

## `// THE CONTEXT GRAPH`

Four artefacts, one join. Vinv indexes **the code** (every symbol and call edge) and generates — from your own run — **the traces** (one span per call), **the logs** (timestamped call events from that same trace), and **the metrics** (per-symbol latency & memory), then ties all four to the *exact function that handled each request*. The artefacts are commodities; **the join is not**. One graph, served to your agent, instead of four tools it has to guess between.

## `// HOW IT WORKS`

1. **Trace** — run your Python service under the bundled tracer: no SDK, no code changes, no dashboards. Calls are recorded with real values (summarized and redacted — see [Data & privacy](#-data--privacy)).
2. **Index** — every function and class is embedded locally and ranked into a semantic index with a call/inheritance graph; incremental updates on save keep it current. Embeddings come from a local sidecar (`vinv-embedder`) that auto-sizes batches to your device (CUDA → Apple Silicon → CPU) and resumes cleanly after a crash.
3. **Serve** — two MCP servers hand the context graph to your agent: semantic code search, fault-localization rankings, observed values, call slices, coverage, blast radius.
4. **Verify** — after a dispatched fix, Vinv replays the recorded start command in a fresh process, requires the port to actually serve, and runs acceptance tests generated *before* the fix that the agent never sees. Failures feed the next attempt; inconclusive evidence escalates to your judgment card.
5. **Learn** — every decision and outcome is propensity-logged; retrieval and context-pack composition update only when off-policy evaluation shows a real win over your baseline (local, never uploaded).

## `// REPO LAYOUT`

| Directory | What it is |
|---|---|
| [`extension/`](extension/) | The VS Code/Cursor/Windsurf extension (TypeScript) — UI, MCP servers, episode loop |
| [`index/`](index/) | Rust semantic code index — tree-sitter parse, local embeddings, hybrid BM25+dense search, code graph |
| [`embedder/`](embedder/) | Local embedding sidecar — CodeRankEmbed via sentence-transformers, device-aware batching, crash-safe |
| [`tracelens/`](tracelens/) | Zero-edit Python tracer + offline analyzers |
| [`identification/`](identification/) | Deterministic join: entry points, call trees, trace↔source overlay |
| [`handbook/`](handbook/) | Repo discovery — writes the plain-language handbook (`.vinv/vinv.md`) via your harness |
| [`bringup/`](bringup/) | Service inventory + verified start commands, wrapped under the tracer |
| [`goal/`](goal/) | Goal authoring for closed-loop episodes |
| [`core/`](core/), [`contracts/`](contracts/) | Shared agent runtime and typed event contracts |
| [`tests/e2e/`](tests/e2e/) | The planted-bug golden e2e: plants a real bug, traces it, asserts the evidence names the exact line |

Python engines are a single [uv](https://docs.astral.sh/uv/) workspace — `uv sync` at the repo root sets up everything.

## `// MCP TOOLS REFERENCE`

**`vinv-index`** — the codebase and the session:

| Tool | Returns | Ask it when |
|---|---|---|
| `vinv_query` | Ranked symbols with paths + a decision id | Any by-meaning code search — before grep |
| `vinv_feedback` | ack | Once after acting on results (reward −1..1) — trains retrieval |
| `vinv_session` | `trajectory` · `status` · `issues` · `hotspots` · `memory_trends` · `cache_candidates`; actions `fix` · `run_sweep` · `set_goal` · `set_budget` | Read Vinv's live state — or queue fixes/sweeps — from chat |

**`vinv-runtime`** — the captured runs (read-only, provenance-stamped):

| Tool | Returns | Ask it when |
|---|---|---|
| `rank_suspects` | Symbols ranked by fault-localization score over pass/fail requests, real error messages attached | **First**, on any failure — before reading source |
| `values_of` | Observed argument/return types, null-rates, ranges, top values | "What does this function actually receive?" |
| `slice` | The observed caller chain from request root to the symbol, values at each frame | "How did this bad value get here?" |
| `coverage_of` | What ran, how often, ok/error, timing | "Did my change even execute?" |
| `callers_of` / `blast_radius` / `why_did_this_run` | Observed callers · transitive impact · entry-point paths | "Who calls this / what breaks if it's wrong / why did it run?" |

## `// DATA & PRIVACY`

- **Everything lives on your machine**: per-repo state in `.vinv/` (auto-gitignored), per-machine state in `~/.vinv/`. Learning ledgers are local and never uploaded.
- **No telemetry. None.** The extension makes no network calls of its own; the only download is the embedding model (Hugging Face, once). Everything else builds from this repository.
- Traces store bounded **summaries**, not raw values: strings become length + hash prefix; parameters with sensitive names (`password`, `token`, `api_key`, `secret`, `authorization`, `credential`) are flagged redacted and never have contents captured; everything is capped at 256 bytes by default.
- Your code never leaves your machine — the only LLM Vinv talks to is the coding-agent CLI **you** configured, through its own auth.

## `// CONTRIBUTING`

See [CONTRIBUTING.md](CONTRIBUTING.md). Quick version: `uv sync` for the Python engines, `cargo build` in `index/`, `npm install && npm run check` in `extension/`, and `python tests/e2e/planted_bug_golden/run.py` must stay green. Good first issues are labeled.

## `// LICENSE`

[Elastic License 2.0](LICENSE) © 2026 VinvAI.

<div align="center">
<sub>Python first, TS & Go next · <b>Your agent says it's done. Vinv says prove it.</b></sub>
</div>
