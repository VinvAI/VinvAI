<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://images.vinv.ai/vinv-banner-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://images.vinv.ai/vinv-banner-light.png">
  <img src="https://images.vinv.ai/vinv-banner-light.png" alt="Vinv — automatically discovers, tests, and observes your services with zero code changes, then helps your AI agent fix what breaks and proves it." width="880">
</picture>

<br><br>

**Vinv automatically discovers, tests, and observes your services — with zero code changes.**

It watches a real run of your Python services and hands your coding agent the actual execution evidence — traces, argument values, the failing frame — instead of leaving it to guess from static text. Then it won't let a fix land until that fix passes acceptance tests written *before* it, that the agent never sees. All local, through the agent you already pay for.

<sub>Python first — services and APIs. TS & Go next.<br>No account. No API keys. No telemetry. Everything runs on your machine.</sub>

<br><br>

<a href="https://www.youtube.com/watch?v=EkUjPWKHAvI"><img src="https://raw.githubusercontent.com/VinvAI/VinvAI/main/docs/media/vinv-demo-poster.jpg" alt="Watch the 2-minute Vinv demo — discover, test, and observe your services with zero code changes" width="820"></a>

<sub><a href="https://www.youtube.com/watch?v=EkUjPWKHAvI"><b>▶ Watch the 2-minute demo</b></a> — from a cold repo to a proven fix</sub>

<br><br>

<img src="https://images.vinv.ai/vinv-loop.svg" alt="From cold repo to production-ready: Vinv's nine stages around your coding agent — bring up, trace, index, map, exercise, find, dispatch, verify, learn — each annotated with what it does and which engine runs it" width="900">

<sub>One command starts it. Vinv drives the other eight stages — every arrow is evidence, not a guess.</sub>

<br><br>

[![Editors](https://img.shields.io/badge/editors-VS%20Code%20%2B%20Cursor-D71921?style=flat-square)](https://open-vsx.org/extension/VinvAI/VinvAI)
[![Traces Python](https://img.shields.io/badge/traces-Python%2C%20zero%20edits-D71921?style=flat-square)](https://vinv.ai)
[![100% local](https://img.shields.io/badge/100%25%20local-no%20telemetry-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI#privacy)
[![License](https://img.shields.io/badge/license-Apache%202.0-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI/blob/HEAD/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-VinvAI-D71921?style=flat-square&logo=github&logoColor=white)](https://github.com/VinvAI/VinvAI)
[![Support](https://img.shields.io/badge/support-support%40vinv.ai-D71921?style=flat-square)](mailto:support@vinv.ai)
[![Made by VinvAI](https://img.shields.io/badge/made%20by-VinvAI-D71921?style=flat-square)](https://vinv.ai)

**Install:** [**Open VSX**](https://open-vsx.org/extension/VinvAI/VinvAI) · [**one-click, pick your editor**](https://vinv.ai/#install)

**[01 FIND](#01-find--what-actually-ran) · [02 FIX](#02-fix--through-the-agent-you-already-pay-for) · [03 PROVE](#03-prove--or-revert-it) · [04 LEARN](#04-learn--from-what-survived)**

</div>

## What you get, in one loop

**Discover · Test · Observe — then Prove.** Point Vinv at a Python repo; it does the rest — no code changes, no API keys.

- **🔍 Discover** — finds every service and endpoint in your repo automatically, and works out how each one starts.
- **🧪 Test** — drives real requests through them (valid, boundary, negative, authenticated), traps crashes and slow paths, and banks every response as a regression case.
- **👁️ Observe** — traces the real run with zero edits to your code: timings, arguments, return values, call trees — each joined to the exact source line that produced it.
- **✅ Prove** — hands that evidence to the agent you already use (Claude Code, Cursor, Copilot…), then verifies its fix against acceptance tests written *before* the fix that it never sees. A "faster" change that alters any output is auto-reverted.

<sub>Your agent is the only LLM — no new bill, no model picker, no provider keys. Everything runs on your machine.</sub>

## Context beats model size

Receipts first — then how the loop produces them.

Vinv found **four bugs and one performance problem** in [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) (~44k★). Same five issues, same prompts, Vinv grading every run:

| Setup | Fixed |
|---|---|
| **Cheap commodity model + Vinv evidence** | **4 bugs + 1 optimization** |
| Frontier model, working blind | 1 bug |
| Cheap commodity model, working blind | nothing |

One trial per condition — a **demonstration, not a benchmark**. Blind, the commodity model scored zero. Hand it the failing frame, the caller chain, and the real argument values, and it beats a stronger model guessing from static code. **The evidence is what moved, not the weights.**

On that same pristine template the optimization loop later detected — from live traces alone — that the app's default database pool makes requests **queue for connection checkouts** under concurrent load, dispatched the pool-sizing fix, and proved it: sustained-load median **75.6ms → 41.2ms, 45.4% faster (95% CI [36.3%, 45.8%])**, responses byte-identical. Two earlier attempts whose measurement windows couldn't certify the win were **auto-reverted** — the accept landed only when the evidence did.

<div align="center">
<img src="https://images.vinv.ai/vinv-pool-optimization-proof-light.gif" alt="Vinv on the FastAPI template: detects connection-pool starvation, proves 45.4% sustained-load median improvement with a paired-bootstrap 95% CI, auto-reverts uncertified attempts" width="720">
</div>

### Same discipline, upstream on Hugging Face

Pointed at [huggingface/smolagents](https://github.com/huggingface/smolagents) (~28.5k★) — a public Apache-2.0 agent framework, no affiliation — the allocation loop found and proved a fast-path in `sanitize_for_rich`. Benchmarked with `tracemalloc` on a realistic 4&nbsp;KB log line: transient per-call allocation **36.27&nbsp;KB → 0.00&nbsp;KB (~37,137× less)**; end-to-end on `log_task`, **~615.7&nbsp;KB → ~125&nbsp;B** across 3 calls; output byte-identical across **2,015** inputs. Upstream as [**PR #2572**](https://github.com/huggingface/smolagents/pull/2572).

<div align="center">
<a href="https://github.com/huggingface/smolagents/pull/2572"><img src="https://raw.githubusercontent.com/VinvAI/VinvAI/main/docs/media/smolagents-pr-2572.png" alt="PR #2572 on huggingface/smolagents — benchmarked perf fast-path for sanitize_for_rich" width="720"></a>
<br>
<img src="https://raw.githubusercontent.com/VinvAI/VinvAI/main/docs/media/smolagents-pr-2572-diff.png" alt="Light-theme GitHub Files changed view for smolagents PR #2572 — the fast-path in src/smolagents/utils.py" width="720">
<br><sub><a href="https://github.com/huggingface/smolagents/pull/2572">huggingface/smolagents#2572</a> · benchmarked allocation improvement · reproducible proof in the PR</sub>
</div>

That is *how come after it*: oracles find the waste, your agent proposes the edit, paired-bootstrap + byte-identical replay decide accept or revert, and only then does anything go upstream. The rest of this README is the machinery behind those receipts.

## Install

One click from the marketplace — [**Open VSX**](https://open-vsx.org/extension/VinvAI/VinvAI) — or straight from your editor's CLI:

| Editor | Command |
|---|---|
| VS Code | `code --install-extension VinvAI.VinvAI` |
| Cursor | `cursor --install-extension VinvAI.VinvAI` |
| Windsurf | `windsurf --install-extension VinvAI.VinvAI` |
| VSCodium | `codium --install-extension VinvAI.VinvAI` |
| Trae | `trae --install-extension VinvAI.VinvAI` |
| VS Code Insiders | `code-insiders --install-extension VinvAI.VinvAI` |

<sub>First run builds the engines — about 4 minutes: it compiles the Rust index and fetches a one-time ~500 MB local embedding model ([uv](https://docs.astral.sh/uv/) and [Rust](https://rustup.rs) required). First trace lands about a minute after that; everything after is seconds.</sub>

```bash
git clone https://github.com/VinvAI/VinvAI ~/.vinv/engines && cd ~/.vinv/engines && ./install.sh
```

<sub>Windows (PowerShell):</sub>

```powershell
git clone https://github.com/VinvAI/VinvAI $HOME\.vinv\engines; cd $HOME\.vinv\engines; .\install.ps1
```

## The problem

84% of developers now use or plan to use AI coding tools. More of them **actively distrust** the output (46%) than trust it (33%) — and distrust nearly doubled in a year ([Stack Overflow 2025, 49k developers](https://survey.stackoverflow.co/2025/ai/)). You know why: the agent edits the wrong handler, invents return shapes, then grades its own homework while the server won't even start.

Or it gets stuck — test fails, agent edits the same function, test fails the same way, agent edits it again, burning your context window on "let me verify." Anthropic's own research documents agents "stuck in loops, repeating the same failed approach" when they lack codebase context.

Both failures have one root cause: **the agent has never watched your code run.** It argues from static text.

The industry automated *writing* and left *proving* entirely manual. Vinv automates the proving — and only then the finding and the fixing.

## Under the hood: the oracle roster

The **Test** stage above isn't one tester — it's a set of oracles, each hunting a different class of defect, all writing into the same findings and the same fix-dispatch path. You never need to think about them to use Vinv; open this if you want the full list and how the budget is spent.

<details><summary><b>The full oracle roster, the budget dispatcher, and the sandbox</b></summary>

<br>

| Oracle | What it finds | Finding kinds |
|---|---|---|
| **HTTP exerciser** | Drives every discovered endpoint itself — schema-valid, boundary, negative, values mined from real traces, multi-step auth scenarios | `server-error` · `crash` · `invariant-violation` |
| **Differential oracle** | Compares a service handler or evaluator against a reference implementation. For an evaluator or parser, the reference is CPython itself — disagreement *is* the bug report | `differential-mismatch` |
| **Fault injection** | Adversarial-but-**legal** shapes at a dependency boundary (`None`, `""`, lone surrogate, reordered list), plus a sweep of every chunk-split point on a stream | `fault-crash` · `fault-divergence` |
| **Concurrency oracle** | Deterministic interleavings and timeout injection — shared state that corrupts under parallel calls, and lock orderings that deadlock | `concurrency-divergence` · `concurrency-hang` |
| **Environment oracle** | A dependency-resolution matrix, and upstream symbols whose signature moved under you | `signature-drift` *(reported, never dispatched — no edit here fixes it)* |
| **Golden I/O baselines** | A "faster" change that quietly dropped a response field or changed a status class | `baseline-degraded` |
| **Dead code** | Untraced **islands** — connected sections nothing executed in any recorded run — with the live callers that still reference them | dead sections |
| **Runtime analysis** | Latency hotspots from live spans, memory-leak suspects (Theil–Sen slope), duplicate recomputation worth caching, throughput ceiling (USL fit) | hotspots · leaks · cache candidates · `throughput-ceiling` |

**The dispatcher is real, and it is a bandit.** `exerciser campaign` allocates **one budget** across every *armed* oracle by Thompson sampling over `(target × technique × oracle)` — rather than driving each one exhaustively. Cost is *measured* (wall-clock normalized to probe-equivalents plus subprocesses spawned), so an oracle that takes forty seconds to find what another finds in one loses. Credit is paid **once per defect signature**, within a run and across runs, so a deterministic oracle can't re-earn credit for the same bug forever. Posteriors persist in `campaign.json` — *which technique pays on your repo* is learned.

The campaign dispatches **six** oracles (`default_runners`): crash/function, differential, fault, concurrency, HTTP, and environment — each *armed* only when it applies to your repo (no `--base-url` and the HTTP oracle stays dark; no boundaries and the fault oracle does). The **dead-code** and **runtime-analysis** families (leaks, hotspots, cache candidates) and the **golden-I/O baselines** in the table below run from the editor and the regression path, not this budget loop.

Unverified code runs behind a **containment ladder**: a kernel-enforced OS sandbox (`sandbox-exec` / `bwrap` / `unshare`) where the host offers one, otherwise a process shim — always with a disposable repo copy, redirected `HOME`/`TMPDIR`, blocked network and subprocess spawning. Tier is decided by a *probe* that verifies a write outside the root really failed, never by a binary being on `PATH`. Postgres, Redis and S3 are substituted **inside** the jail so code that needs them runs instead of failing to connect.

</details>

## Dead code, from what actually ran

Static tools (Vulture, `deadcode`, Knip, ts-prune) can only prove *"nothing statically references this."* They can't see dynamic dispatch, feature flags, registries or environment drift — so they emit candidates a human has to adjudicate, which is why the cleanup never happens.

Vinv can say something they can't:

> **"No capture ever executed this. Here is what still references it, here is the traced neighbourhood it would wire back into, and here is what your agent thinks it is."**

The unit is a **section** — a connected island of untraced symbols — not a lint row, because dead code is almost never one function. Each section gets:

- **Reachability evidence** — `REACHED FROM LIVE CODE` (executing code references it; the path was never taken — usually a guard or an unshipped feature) versus `NO REFERENCES` at all. Opposite verdicts, and a filtered canvas can't tell you which.
- **The live neighbourhood** — Personalized PageRank seeded at the section's symbols over the code graph, keeping the highest-mass **traced** symbols. HippoRAG's retrieval idea, run over a graph Vinv already has. That's the place an integration would wire into.
- **Your agent's verdict** — `integrate` · `reimagine` · `delete` · `keep` · `unclear`, each with what it does, why nothing reaches it, and what breaks if it's removed. Sections travel five to a prompt so the agent can say *"this is the older copy of the section below"* — a judgment a per-section run structurally cannot reach.

Two things it refuses to do: call anything dead with **no trace on disk** (with zero captures every symbol is untraced, so the list would be your codebase), and drop anything silently — both caps are recorded as lineage, so "12 sections" is distinguishable from "12 is the cap and 300 were dropped".

And the second-order reason to care: **dead code makes your coding agent worse.** Every unused module competes for the context window, burns tokens, and offers wrong patterns to copy.

## The four acts

### 01 FIND — what actually ran

Static scanners guess. Vinv records a real run and ranks what failed, what never executed, and what was slow. No "possible issue" — every finding names a symbol, a line, and the trace behind it.

```bash
# with a service up — Auto-Pilot's path: plan every endpoint, then drive them
exerciser plan <repo> --base-url http://127.0.0.1:PORT && exerciser run <repo> --base-url http://127.0.0.1:PORT
# allocate budget across armed oracles (HTTP + the rest that apply to that run)
exerciser campaign <repo> --budget 20
```

### 02 FIX — through the agent you already pay for

Findings become evidence packs and go to your own agent — Claude Code, Codex, Cursor, Gemini CLI, Copilot Chat, Windsurf Cascade. **Your agent is Vinv's only LLM.** No new bill, no model picker, no provider keys.

The pack is composed from a **context graph**: your code, your traces, and the metrics derived from them, joined on the exact function that handled each request. The artefacts are commodities; the join is not.

### 03 PROVE — or revert it

Replayed start. Live port. Acceptance tests authored **before** the fix, stored outside the workspace under an opaque token, and required to fail deterministically *twice* on the pre-fix code — the SWE-bench fail-to-pass discipline. A test that passes on broken code is discarded.

Around that: a static pre-gate (every changed `.py` must `ast.parse` before a test budget is spent), a deterministic **anti-cheat diff audit** over the snapshot ref plus untracked files (test edits, `except` swallows, interpreter shadow modules, `.vinv` tampering — hard flags block eligibility outright), a **bounded LLM judge** that can push toward scrutiny but can never rescue a failed gate, and an advisory **mutation smoke** whose survivors are never revealed to the fixing agent — the Goodhart guard.

One click reverts everything an episode touched, untracked files included.

### 04 LEARN — from what survived

Two ledgers, both local, neither uploaded.

**Context-pack composition** is a factored `2²` arm grid (graph-slice depth × runtime-evidence inclusion). Selection is Thompson sampling with an ε-floor mixture, and the **exact mixture propensity is logged with each decision** — the requirement for unbiased IPS/SNIPS/DR later. The ε-floor decays but never reaches zero, so importance weights stay bounded. Posteriors count **only objective episodes** — a user abort or an "approve as done" click is not evidence about arm quality. Attribution is a **COMA-style counterfactual** per feature over the grid of posterior means: *"did runtime evidence help"* is a computed number, not a claim.

**Retrieval serving** is a separate ε-greedy bandit (over the top-k action set) with its own ledger. A candidate config is promotable only when *all* hold: ESS ≥ 25, n ≥ 40 joined samples, ≥ 8 logged pulls per compared action, BCa-bootstrap 95% lower bound of the doubly-robust delta ≥ 0, zero clipped weights, and no epoch contradicting the pooled delta (the Simpson-artifact guard). A promoted policy then serves at **5% canary only**, and three consecutive negative canary rewards roll it back automatically.

Measured on this repo's own ledger (800 logged decisions, 770 joined, 12 index epochs — [`docs/learning.md`](https://github.com/VinvAI/VinvAI/blob/main/docs/learning.md)):

| candidate | DR delta | 95% BCa CI | ESS | promoted |
|---|---|---|---|---|
| top-k 10 | **+0.173** | [+0.081, +0.317] | 577 | **yes** |
| top-k 3 | +0.081 | [−0.057, +0.226] | 68 | no — LCB < 0, epoch guard fails |
| top-k 20 | +0.148 | [+0.062, +0.283] | 0 | no — zero support, never logged |

**The gate admitted exactly the measured winner and blocked both the uncertain and the unsupported candidate.** That is what "closed-loop" is being asked to mean here — and the parts that are *not* online learning (the referee's thresholds, the oracle catalogue, the fault shapes) are fixed policy, deliberately.

## If any of these is your open tab

| Symptom | Which oracle answers it |
|---|---|
| *"claude code says done but tests fail"* | the referee: replayed start, live port, acceptance tests the agent never sees |
| *"cursor agent stuck in a loop"* | doom-loop guard — token-set self-similarity catches a repeating agent and forces a different approach |
| *"how to find dead code in python from real usage"* | dead-code sections: never executed in any capture, with live callers and an agent verdict |
| *"how to test fastapi endpoints automatically"* | the HTTP exerciser — schema/boundary/negative/auth inputs, every response banked as a regression case |
| *"python deadlock only under load"* | the concurrency oracle — deterministic schedules and timeout injection |
| *"my parser accepts input CPython rejects"* | the differential oracle — disagreement with the reference *is* the bug report |
| *"AI broke code that was working"* | byte-identical behavior replay gates every change; one-click revert of everything an episode touched |
| *"find memory leak python without profiler"* | Theil–Sen slope over per-session retention — names the functions holding memory, from real runs |
| *"why is my api slow"* | per-call flamegraphs from live traffic, Pareto hotspots, and a USL fit that names the throughput ceiling |
| *"my dependency changed and nothing told me"* | the environment oracle — resolution matrix plus upstream signature drift |

## What Vinv does

Give your coding agent runtime context — one loop, these capabilities:

- **Semantic code search** — ask by meaning, get ranked symbols with `def` bodies and line numbers, embedded by a local model (no cloud keys).<br><img src="https://images.vinv.ai/semantic-code-search-light.gif?v=2" alt="semantic code search MCP in action" width="640">
- **Code Graph** — a persistent map of every symbol and call edge, updated incrementally on save, with a live runtime overlay.<br><img src="https://images.vinv.ai/code-graph-light.gif" alt="interactive Code Graph" width="640">
- **Runtime tracing** — zero-edit runtime tracing for AI coding agents: timing, memory, args, returns, errors — per call, joined to source.<br><img src="https://images.vinv.ai/runtime-tracing-light.gif?v=2" alt="zero-edit Python tracing" width="640">
- **Rank suspects** — on any failure, symbols ranked by fault-localization score over real pass/fail requests, error messages attached.<br><img src="https://images.vinv.ai/rank-suspects-light.gif?v=2" alt="fault-ranked suspects" width="640">
- **Verified fixes** — verify AI-generated code actually works: replayed start, live port, acceptance tests the agent never sees. One click reverts everything an episode touched.<br><img src="https://images.vinv.ai/verified-fixes-light.gif?v=2" alt="independent fix verification" width="640">
- **Dead code sections** — *"View Dead Code"* explains every untraced island. Sections split into **no references** and **reached from live code but never taken**, each with the callers that still point at it and a keep-or-cut verdict with its reasoning.<br><img src="https://images.vinv.ai/dead-code.gif" alt="a dead-code section report: reachable but untested, the live code that references it, and the keep-or-cut verdict with reasoning" width="640">
- **Recoverable time** — latency hotspots ranked by the milliseconds you would actually get back, each dispatched as a predicted-then-proven optimization instead of a guess about what is slow.<br><img src="https://images.vinv.ai/optimize.gif" alt="the Optimize panel: open opportunities, recoverable milliseconds, and per-call latency against the whole-flow ceiling" width="640">
- **Ask Vinv** — ask anything about your running system in plain English; every answer cites the exact trace spans and source lines it came from, and a **deterministic critic** blocks any claim the evidence can't back — grounded Q&A, not confident guessing.
- **Behavior exerciser** — Vinv doesn't wait for traffic: it drives **every discovered service endpoint itself**, picks strategies with a Thompson-sampling bandit rewarded by oracle violations first and new coverage only as a bonus, and turns every response into a permanent regression case.
- **Journey** — one walkthrough of everything verified: every service, then every endpoint's call tree, latency flamegraph, and the exact inputs → outputs exercised — with a form to add your own test inputs that the engine replays forever after.<br><img src="https://images.vinv.ai/journey-walkthrough.gif" alt="Vinv Journey walkthrough: overview, then every endpoint's call tree, latency flamegraph, and exercised inputs and outputs, stepped with Next" width="640">
- **Auto-Pilot & the red ring** — one click drives discover → set up → trace → exercise → fix → verify until green or budget; when new trace errors land, the fix episode is *already dispatched* by the time you see the red ring in the graph. The budget is yours: set attempts per service in **Configure**, and when a run exhausts them Vinv asks whether to grant more instead of quietly giving up.
- **Agent babysitting** — a doom-loop guard (token-set self-similarity) catches a repeating agent, an adaptive silence watchdog catches a hung one, and **"Dispute a Verified Fix"** keeps even the verifier accountable.
- **Findings** — what Vinv found and what it fixed, with the statistical evidence: issue clusters, optimization episodes with paired-bootstrap confidence intervals, regression diff kinds, and a machine-readable `findings.json` your agent can consume directly.<br><img src="https://images.vinv.ai/findings-tour.gif" alt="Vinv Findings tour: issue clusters, optimization episodes with 95% confidence intervals, regression replay kinds, latency profile per endpoint, and the state ledger" width="640">

> **Honest scope:** Python first — **services and APIs**. Auto-Pilot discovers runnable services, brings them up under tracelens, and exercises their HTTP (and related) entrypoints. Other languages get the index, graph and grounded QnA, but no runtime evidence yet. TypeScript and Go next.

## Why agents don't reward-hack under Vinv

Vinv ties **every runtime trace to the exact code segment that produced it** and hands your agent a context graph built from that join — so the agent argues from evidence, not vibes. And when the agent claims victory, Vinv doesn't take its word:

- **Acceptance tests are authored *before* the fix**, stored outside the workspace under an opaque token, and must fail deterministically twice on the broken code — it can't train to the test, and a test that passes pre-fix is thrown away.
- **A "faster" fix that changes any observable output is auto-reverted** — the behavior suite must replay byte-identical, and the speedup's paired-bootstrap 95% CI must exclude zero. Faster-but-wrong never lands.
- **Deliberate 4xx rejections aren't "errors" to fix** — the defect classifier knows the difference between a service saying *no* correctly and a service breaking, so the agent is never handed a fake goal it can only game. Same rule in the newer oracles: a sandbox that refuses `nonlocal` is enforcing a documented limit, not failing.
- **Silent-wrong-value findings dispatch with value-shaped criteria** — for `differential-mismatch`, `fault-divergence`, `concurrency-divergence`, `invariant-violation` and `baseline-degraded`, "these calls no longer raise" would be vacuous, because the target never raised. The criterion is the *value*.
- **When two attempts stop making progress, a Nash-bargaining stall judge decides** — continue only if both an explorer stance *and* an auditor stance strictly prefer it to asking you. Otherwise you get a judgment panel, not a token bonfire.

## Exerciser on the FastAPI template

Traffic only shows you the code paths users happen to hit. The behavior exerciser drives the rest — same [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template), one run:

| Metric | Traffic only | Exercised |
|---|---|---|
| Endpoints executed | 0 / 23 | **23 / 23** |
| Endpoints with symbol coverage | — | 6 → **16 / 23** (auth sweep) |
| Symbols covered | — | 18 → **37 / 44** |
| Regression cases banked | 0 | **125** (replayable forever) |

The **authenticated sweep** (every endpoint replayed under credentials the login scenario captured, with freshly created resource IDs fed to the by-id endpoints) surfaced **four real bugs** that anonymous traffic can never reach:

1. `GET /api/v1/users/` → **HTTP 500** — an invalid email stored by an unvalidated private endpoint poisons response serialization
2. `POST /api/v1/private/users/` → **IntegrityError escapes as a 500** — `email: str` instead of `EmailStr`, no duplicate guard
3. `POST /api/v1/utils/test-email/` → **HTTP 500** — `assert settings.emails_enabled` crashes instead of degrading
4. `POST /api/v1/password-recovery-html-content/{email}` → **connection killed** — unsanitized header rendering

The harness then **fixed all four**, and the regression suite now distinguishes *your code regressed* from *the test engine's own leftover data changed the world* (the state ledger) — so a re-run doesn't cry wolf. Phantom perf regressions are gone too: a latency diff must survive a median of 5 replays before it's reported.

<div align="center">
<img src="https://images.vinv.ai/journey-endpoint.png" alt="Vinv Journey deep-dive on POST /users/signup: call tree with runtime counts and errors, latency flamegraph, and all 15 exercised inputs with their outputs" width="720">
<br><sub>One endpoint after the run: call tree with live runtime, latency flamegraph, and every input Vinv drove with the output it got back.</sub>
</div>

## Works with your agent

Vinv is an MCP server for Claude Code and Cursor — and every other MCP client you already use. One command (**Register Vinv MCP in Agent Tools**) writes the servers into every agent it detects:

| Agent | Fix dispatch | MCP tools |
|---|:---:|:---:|
| Claude Code | ✅ | ✅ auto |
| Cursor (CLI + chat) | ✅ | ✅ auto |
| Codex CLI | ✅ | ✅ auto |
| Gemini CLI | ✅ | ✅ manual |
| Copilot Chat (VS Code) | ✅ | ✅ auto |
| Windsurf Cascade | ✅ | ✅ auto |

<details><summary><b>Where the config lands, per client — and how to verify</b></summary>

Registration is idempotent and never commits secrets. The servers (`vinv-index`, `vinv-runtime`, `vinv-exercise`) launch over stdio via the editor's own runtime.

- **Claude Code** — `~/.claude.json`, project-local scope (no trust prompt). Verify: `claude mcp list` shows the Vinv servers.
- **Cursor** — `<repo>/.cursor/mcp.json`. Verify: Settings → MCP shows them green.
- **Codex CLI** — `~/.codex/config.toml` under `[mcp_servers.vinv-index]` / `[mcp_servers.vinv-runtime]`.
- **Copilot Chat** — native VS Code MCP provider (auto), `.vscode/mcp.json` on older builds.
- **Windsurf Cascade** — `~/.codeium/windsurf/mcp_config.json`.
- **Gemini CLI** — dispatch works out of the box; for MCP tools, add the same stdio servers to `~/.gemini/settings.json`.

**Your agent is also Vinv's only LLM** — every analysis step routes through the coding-agent CLI you already pay for. No provider keys, no model picker.
</details>

## Agent without Vinv vs with Vinv

| | Agent alone | Agent + Vinv |
|---|---|---|
| Finding code | greps and guesses files | ranked symbols with line numbers, by meaning |
| "Done" | claims it, grades its own homework | replayed start, live port, unseen acceptance tests |
| Memory | forgets every session | persistent index + graph, updated on save |
| Runtime | can't see it | real traces, values, flamegraphs per call |
| Debugging | reads source, speculates | fault-ranked suspects with real error messages |
| Dead code | can't tell used from unused | never-executed islands with live callers and a keep-or-cut verdict |
| Bad fix | you diff and pray | one-click revert of everything the episode touched |
| API testing | writes tests it then grades itself | exercises every service endpoint, banks each response as an unseen regression case |
| Perf claims | "should be faster now" | paired-bootstrap 95% CI must exclude zero, behavior byte-identical, or auto-revert |
| Test data | pollutes your dev DB and forgets | state ledger: created resources tracked, torn down via your own API, drift labeled |
| Cost | burns tokens re-exploring | evidence pack composed once, locally; the bandit learns which pack composition pays |

## Proven on itself

Vinv's release gate is Vinv — these numbers come from running the loop on this repository:

| Metric | Result |
|---|---|
| Index | 4,036 symbols |
| Search | file hit@10 **0.90** · symbol MRR 0.51 · p50 81ms |
| Crash recovery | indexer, embedder, and traced service all kill-tested mid-run |
| Self-found waste | 83% duplicate compute found → now cached |
| Retrieval tuning | off-policy evaluation (doubly-robust, BCa bootstrap) over 800 logged decisions promoted **top-k 10** (+0.173, 95% CI [+0.081, +0.317]) and blocked both other candidates — one for an uncertain lower bound, one for zero support |
| Test suite | **2,376 tests** — 1,575 Python · 801 extension |

## How it works

```mermaid
flowchart LR
  T[Trace] --> I[Index] --> S[Serve MCP] --> V[Verify] --> L[Learn] --> T
```

1. **Trace** — run your Python service under the bundled tracer: no SDK, no code changes. (No service? The function, differential, fault, concurrency and environment oracles need none.)
2. **Index** — every function embedded locally into a semantic index + call graph.
3. **Serve** — MCP servers hand the evidence to your agent.
4. **Verify** — replayed start, live port, acceptance tests generated *before* the fix.
5. **Learn** — propensity-logged decisions; retrieval and pack composition update only on off-policy-evaluation wins, behind a 5% canary with automatic rollback.

<details><summary><b>🧠 The algorithms, named (for the skeptics)</b></summary>

No black boxes — every decision Vinv makes has a published method behind it, and each one exists to keep the loop honest, not clever:

| Decision | Algorithm | Why |
|---|---|---|
| Which oracle to spend the next unit of budget on | **Thompson sampling** over `(target × technique × oracle)`, cost measured in probe-equivalents, credit paid once per defect signature | which technique pays is a property of *your* repo, learned across runs — not a fixed running order |
| Which input strategy to try next, per endpoint | **Thompson sampling** over Beta posteriors; reward = oracle violations, with new coverage worth a **0.25 bonus** so exploring stays subordinate to finding; posteriors persist with **50% evidence decay** | explores boundary/negative/auth inputs where they pay — the loop can't be captured by a cheap coverage treadmill, and old lessons expire instead of ossifying |
| Which live code a dead section belongs to | **Personalized PageRank** seeded at the section's symbols, keeping traced neighbours (HippoRAG's retrieval step over the code graph) | single-hop similarity misses the associative neighbourhood an integration would wire into |
| Accept or revert an optimization | **Paired bootstrap** 95% CI on relative improvement **and** byte-identical behavior replay | "faster" must be statistically real and observably harmless |
| Throughput ceiling | **Universal Scalability Law** fit (Gunther) over a bounded concurrency sweep — contention σ and coherency κ | names *why* it stops scaling, not just that it did |
| Behavioral invariants | **Daikon-style** dynamic invariants, support ≥ 5, zero counterexamples, **Laplace** `(s+1)/(n+2)` confidence | properties earn their confidence from evidence, not assertion |
| Memory-leak suspects | **Theil–Sen** slope over per-session retention (robust to 29% outliers) | one noisy session can't fabricate or hide a leak |
| Cache opportunities | argument-hash distinctness × time share, **Pareto-relative** — no absolute thresholds | "expensive" is defined by *your* app's trace, 5ms service or 5s batch job |
| Hung harness detection | **adaptive silence watchdog** — a cadence-relative timeout with a startup grace | a slow run isn't killed; a dead one doesn't spin |
| Stall deadlock-breaking | **Nash-bargaining** unanimity: continue only if explorer *and* auditor stances both beat escalation | autonomy exactly when it's justified; a human panel when it's not |
| Context-pack composition | **Thompson sampling** with ε-floor over a `2²` arm grid, exact propensity logged, **COMA-style counterfactual** attribution | "did runtime evidence help" is computed, not asserted |
| Retrieval config promotion | **Off-policy evaluation** (cross-fitted DM/IPS/SNIPS/DR) behind ESS, support, BCa-LCB and Simpson guards; 5% canary, auto-rollback | the learner can't grade its own homework either |
| Fault localization | spectrum-based suspect ranking over real pass/fail requests | suspects come from executions, not embeddings |

The full learning walk — reward, propensity, gating math, with `file:line` for every claim — is [`docs/learning.md`](https://github.com/VinvAI/VinvAI/blob/main/docs/learning.md). The test ontology is [`docs/testing-ontology.md`](https://github.com/VinvAI/VinvAI/blob/main/docs/testing-ontology.md).
</details>

<details><summary><b>Deeper: the context graph, Auto-Pilot, and repo layout</b></summary>

Vinv indexes **the code** and generates — from your own run — **the traces** and **the metrics derived from them**, then ties all three to the exact function that handled each request. The artefacts are commodities; **the join is not.** Auto-Pilot drives the whole loop unaided: discover services → set up via your agent → start under tracing → exercise → fix → re-verify, until green or budget. Layout: [`extension/`](https://github.com/VinvAI/VinvAI/blob/main/extension/) (editor UI + MCP servers), [`index/`](https://github.com/VinvAI/VinvAI/blob/main/index/) (Rust semantic index), [`embedder/`](https://github.com/VinvAI/VinvAI/blob/main/embedder/) (local [CodeRankEmbed](https://huggingface.co/nomic-ai/CodeRankEmbed) sidecar), [`tracelens/`](https://github.com/VinvAI/VinvAI/blob/main/tracelens/) (zero-edit tracer), [`exerciser/`](https://github.com/VinvAI/VinvAI/blob/main/exerciser/) (the oracle swarm + campaign bandit), [`identification/`](https://github.com/VinvAI/VinvAI/blob/main/identification/) (trace↔source join), [`handbook/`](https://github.com/VinvAI/VinvAI/blob/main/handbook/) · [`bringup/`](https://github.com/VinvAI/VinvAI/blob/main/bringup/) · [`goal/`](https://github.com/VinvAI/VinvAI/blob/main/goal/) (discovery & episodes), [`tests/e2e/`](https://github.com/VinvAI/VinvAI/blob/main/tests/e2e/) (planted-bug golden test). Python engines are one [uv](https://docs.astral.sh/uv/) workspace.
</details>

## After install: the things to try

1. **Hunt without a server** — `exerciser campaign <repo> --budget 20`. No service, no `--base-url`: the function, differential, fault, concurrency and environment oracles do the work, and the bandit reports which technique paid.
2. **Exercise your API** — `exerciser plan <repo> && exerciser run <repo> --base-url http://127.0.0.1:PORT` (or let Auto-Pilot's `exercise` phase do it). An **environment canary** first dry-runs your login chains and tells you *loudly* if the database was reset or credentials unseeded — no more silently-401 runs.
3. **Find your dead code** — Command Palette → **"Vinv: View Dead Code"**: every untraced section, split into never-referenced vs reachable-but-never-taken, with the live callers that still point at it and a keep-or-cut verdict.
4. **Walk everything** — **"Vinv: Open Journey"**. Overview first (services, coverage, open issues), then `Next`/`→` through every endpoint: call tree with live runtime, flamegraph, and the exact inputs → outputs driven. Hover anything cryptic — every marker explains itself.
5. **Add your own test input** — on any Journey endpoint step, fill body/params/expected status and hit *Add input*. It lands in the same plan layer the AI-authored scenarios use, runs with the endpoint's auth setup on the next exercise, and becomes a permanent regression case.
6. **See what got fixed** — **"Vinv: Open Findings"**: issue clusters, optimization episodes with their confidence intervals, regression diffs by kind, latency profile, cleanup ledger. The backing file `.vinv/reports/findings.json` is the same data, machine-readable — point your agent at it.
7. **Regress after any change** — `exerciser regress <repo> --base-url …` replays all banked cases (re-capturing fresh credentials itself) and reports **behavior / contract / perf / environment** diffs separately, so environment drift never masquerades as a code regression.
8. **Hunt waste on demand** — **"Optimize Latency Hotspots"**, **"Analyze Memory Trends"** (Theil–Sen leak suspects), and **"Analyze Cache Opportunities"** each turn one command into an evidence-seeded fix episode — accepted only if the paired-bootstrap CI clears and behavior stays byte-identical.

## Engine CLI reference

<details><summary><b><code>exerciser</code> — the oracle swarm, runnable standalone</b></summary>

| Command | What it does |
|---|---|
| `exerciser campaign <repo> [--base-url URL] [--budget N]` | **Start here.** One budget across every armed oracle by Thompson sampling; reports which technique paid |
| `exerciser plan <repo> [--base-url URL]` | Per-endpoint input plan (schema + observed + semantic layers) |
| `exerciser run <repo> --base-url URL` | Execute the plan against the live traced service, coverage-guided |
| `exerciser functions <repo> [--require-tier os-sandbox]` | Drive entry points and exported functions in process, contained |
| `exerciser differential <repo> [--target M:f --reference cpython-exec]` | Compare a function against a reference implementation |
| `exerciser faults <repo> [--auto-target M:f]` | Legal-but-adversarial shapes at a dependency boundary |
| `exerciser concurrency <repo> --target M:f` | Deterministic schedules + timeout injection |
| `exerciser environment <repo>` | Dependency-resolution matrix + upstream signature drift |
| `exerciser containment` | Which containment tier *this host* can actually provide, and why — decided by probe |
| `exerciser throughput-sweep <repo> --base-url URL` | Concurrency sweep + USL fit → `throughput-ceiling` opportunities |
| `exerciser profile <repo>` | Behavioral profile + learned invariants |
| `exerciser regress <repo> --base-url URL` | Replay the accumulated behavior suite, report diffs by kind |
| `exerciser scorecard <repo>` | Per-service scorecard: coverage before→after, invariants, issues, latency |

Requires `identification consolidate` first for `apis.json`, and — for real coverage — a service running under `tracelens`.
</details>

## MCP tools reference

<details><summary><b>Few tool names on purpose — agents pick better from short menus; the session tool multiplexes</b></summary>

**`vinv-index`** — your services' code and the session:

| Tool | Returns |
|---|---|
| `vinv_query` | Ranked symbols with paths + a decision id — any by-meaning search, before grep |
| `vinv_feedback` | ack — reward −1..1 after acting on results; trains retrieval |
| `vinv_session` | **10 actions in one tool** — read: trajectory · status · issues · hotspots · memory_trends · cache_candidates; act: `fix` (dispatch an evidence-seeded episode) · `run_sweep` · `set_goal` · `set_budget` — your agent can drive the whole verify/optimize loop from chat |

**`vinv-runtime`** — the captured runs (read-only, provenance-stamped):

| Tool | Returns |
|---|---|
| `rank_suspects` | Fault-ranked symbols over pass/fail requests, real errors attached — **first**, on any failure |
| `values_of` | Observed argument/return types, null-rates, ranges |
| `slice` | Observed caller chain from request root, values at each frame |
| `coverage_of` | What ran, how often, ok/error, timing |
| `callers_of` / `blast_radius` / `why_did_this_run` | Observed callers · transitive impact · entry-point paths |

**`vinv-exercise`** — closes the endpoint-testing loop: your agent exercises your service and reports the run back, and Vinv grades what came back.
</details>

## FAQ

<details><summary><b>Do I need my own API keys?</b></summary>
No. Vinv runs everything locally. The semantic index and code embedder run on your machine without requiring any provider keys. Your agent CLI (like Claude Code or Cursor) handles its own LLM communication using the authentication you already set up.
</details>

<details><summary><b>Is there any telemetry or data collection?</b></summary>
No telemetry, no analytics, no usage pings, no crash reports. Vinv stores per-repo state in <code>.vinv/</code> and per-machine state in <code>~/.vinv/</code>, and sensitive data in traces is redacted and never sent anywhere. The extension makes exactly <b>one</b> outbound request of its own: a GET of a static file at <code>notices.vinv.ai</code> on activation, so a release that leaves your install broken can tell you. No query string, no identifiers, no version, nothing uploaded — all filtering happens on your machine, at most once every 12 hours. Turn it off with <code>vinv.notices.enabled</code>.
</details>

<details><summary><b>What does Auto-Pilot exercise today?</b></summary>
<strong>Services and APIs.</strong> Auto-Pilot discovers runnable Python services, brings them up under tracelens, and drives their HTTP (and related) entrypoints. Plain library / in-process function driving is not the Auto-Pilot surface right now — the product path is services you can start and call.
</details>

<details><summary><b>Is untrusted exercise code sandboxed?</b></summary>
Yes. Targets the purity guard can't verify are routed through a containment ladder: a kernel-enforced OS sandbox (<code>sandbox-exec</code>, <code>bwrap</code>, <code>unshare</code>) where the host offers one, otherwise the Python process shim — always with a disposable copy of the repo, redirected <code>HOME</code>/<code>TMPDIR</code>/<code>XDG_*</code>, blocked network and subprocess spawning, and POSIX rlimits. Which tier you got is decided by a probe that checks a write outside the root really failed, and it's reported honestly. <code>--no-sandbox</code> leaves that set refused and undriven; it never runs them loose. <code>exerciser containment</code> tells you what your host can provide.
</details>

<details><summary><b>Why is the first run slow? (Build time)</b></summary>
The first run takes around 4 minutes because Vinv needs to compile the Rust index and fetch the ~500 MB local embedding model. Subsequent runs and traces will start in seconds.
</details>

<details><summary><b>Does Vinv modify my code?</b></summary>
No. Vinv uses a zero-edit tracer. It instruments your Python backend at runtime without requiring any SDK integrations, decorators, or modifications to your source code.
</details>

<details><summary><b>Which languages are supported?</b></summary>
Runtime evidence — tracing, the oracle swarm, verified fixes — is Python today, for <strong>services and APIs</strong>. Other stacks still get the semantic index, code graph, and grounded QnA. TypeScript and Go are next.
</details>

<details><summary><b>How does it know if a fix worked?</b></summary>
Acceptance tests are authored before the fix, stored outside your workspace under an opaque token, and required to fail deterministically twice on the broken code — a test that passes pre-fix is discarded. The fix must then pass them, with a replayed start, a live port, and every other observable behavior byte-identical. A deterministic anti-cheat audit over the diff blocks test edits, swallowed exceptions and shadow modules outright.
</details>

<details><summary><b>Which editors and coding agents work?</b></summary>
Editors: VS Code, Cursor, Windsurf, VSCodium, Trae, VS Code Insiders. Agents it drives: Claude Code, Cursor CLI, Codex CLI, Gemini CLI, Copilot Chat, Windsurf Cascade. See <a href="#works-with-your-agent">Works with your agent</a>.
</details>

<details><summary><b>Is it really free and open source?</b></summary>
Yes — <a href="https://github.com/VinvAI/VinvAI/blob/main/LICENSE">Apache 2.0</a>, every engine builds from source in this repo.
</details>

## Privacy

- **Everything on your machine** — per-repo state in `.vinv/` (auto-gitignored), per-machine in `~/.vinv/`. No account, no API keys, **no telemetry — none.**
- **One outbound request, and you can read it**: a GET of a static JSON file at `notices.vinv.ai` on activation, for broken-release and security notices only. No query string, no identifiers, no version, nothing uploaded; at most once per 12 hours; the URL is a constant no setting can repoint; disable with `vinv.notices.enabled`.
- The only download is the embedding model (Hugging Face, once, ~500 MB); everything else builds from this repo.
- Traces store bounded **summaries**, not raw values; sensitive parameter names (`password`, `token`, `api_key`, …) are redacted, never captured.
- The only LLM Vinv talks to is the coding-agent CLI **you** configured, through its own auth.

## Contributing & license

See [CONTRIBUTING.md](https://github.com/VinvAI/VinvAI/blob/main/CONTRIBUTING.md) — `uv sync`, `cargo build` in `index/`, `npm install && npm run check` in `extension/`, keep `tests/e2e/planted_bug_golden/run.py` green. Good first issues are labeled. By taking part you agree to our [Code of Conduct](https://github.com/VinvAI/VinvAI/blob/main/CODE_OF_CONDUCT.md); to report a vulnerability, see [SECURITY.md](https://github.com/VinvAI/VinvAI/blob/main/SECURITY.md). [Apache License 2.0](https://github.com/VinvAI/VinvAI/blob/main/LICENSE) © 2026 VinvAI.

<div align="center">

**Your agent says it's done. Vinv says prove it.**

<sub>If Vinv caught something your agent missed — <a href="https://open-vsx.org/extension/VinvAI/VinvAI/reviews">leave a review on Open VSX</a> and ⭐ star this repo.</sub>

<sub><a href="https://vinv.ai">vinv.ai</a> · <a href="https://open-vsx.org/extension/VinvAI/VinvAI">Open VSX</a> · <a href="https://www.linkedin.com/company/vinvai/">LinkedIn</a> · <a href="mailto:support@vinv.ai">support@vinv.ai</a> · Python first, TS &amp; Go next · <b>Context beats model size.</b></sub>
</div>
