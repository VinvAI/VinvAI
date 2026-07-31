# Why Vinv found one optimization in smolagents and none of the 279 issues

**Date:** 2026-07-27 · **Subject:** huggingface/smolagents (279 open issues) vs Vinv main @ `9a93dce` · **Reference design:** `testflow.md`

---

## The short answer

**Vinv did not fail to detect these bugs. It never got to try.**

On smolagents the exercise plan was **empty — zero endpoints**. Not "few". Zero. Every input Vinv can generate travels as an HTTP request to a discovered route, and route discovery found no routes in this repo. The one finding it did produce (PR #2572, the `sanitize_for_rich` allocation fix) came from *passively watching* organic traffic — allocation churn visible in any trace — which is precisely the single evidence class that requires no chosen input at all.

That is the whole story in one line: **Vinv currently finds what a running program reveals about itself; it does not yet explore what a program does when you push on it.**

Two independent causes, one immediate and one architectural:

| | Cause | Severity |
|---|---|---|
| **1** | **Route discovery is decorator-shaped.** smolagents uses declarative Starlette `Route("/chat", chat, methods=["POST"])`. All four Python route regexes (`identification/runner.py:75-117`) match decorators, `.route`, `.add_api_route`, or Django `path()`. Declarative `routes=[...]` lists match none. Plain Starlette also serves no `/openapi.json`, so the OpenAPI fallback finds nothing either. **Result: 0-endpoint plan on a repo that genuinely has HTTP services.** | **Bug — fix this week** |
| **2** | **HTTP is the only input channel that exists.** There is no function-level harness anywhere. `generators.py:23-25` explicitly parks CrossHair as "a function-level path orthogonal to exercising HTTP endpoints." Identification *catalogs* `CLI_*`, `TASK_*`, `MAIN_*`, `STDIO_*` entry points (`runner.py:1035-1052`) but **no driver consumes them.** | **Architecture** |

Even with cause 1 fixed, cause 2 caps the ceiling: smolagents is a **library**. Its bugs live in `local_python_executor`, `models`, `memory`, `tools`, `mcp_client` — reachable over HTTP only through one narrow corridor (`CodeAgent.run` → model call → memory append), and only for whatever the LLM happens to emit that run.

---

## What the 279 issues actually are

Two independent taxonomists classified all 279. Merged:

| Class | ~N | Could HTTP probing ever trigger it? |
|---|---|---|
| Feature requests / capability gaps | 62 | No — absence of a feature never raises |
| Docs, examples, repo hygiene | 25 | No |
| Third-party promotion / off-topic | 19 | No |
| **Provider adapters: response-shape & tool translation** | **25** | Partially — needs a *stubbed* model to be deterministic |
| **Python executor: semantics, limits, sandbox** | **17** | Partially — needs control of the executed source |
| **Agent memory lifecycle & message-format contracts** | **18** | Partially — needs long multi-turn sessions |
| **Multi-agent orchestration & partial-failure propagation** | **17** | Partially — needs injected sub-agent failure |
| **Observability / logging / telemetry fidelity** | **17** | Partially |
| **Tool definition, schema introspection, validation** | **17** | No — schema generation never runs on the HTTP path |
| **Stateful lifecycle & resource leaks (connect/disconnect/reset)** | **10** | Partially |
| **Concurrency, timeout, hang/deadlock** | **6** | Partially, and dangerously (a hang stalls the probe run) |
| **Boundary / falsy-value / interpreter-flag (`python -O`)** | **6** | **No** |
| **Sandbox escape / untrusted input** | **5** | Partially (SSRF only) |
| **Third-party version drift & dependency resolution** | **4** | **No** — install/import-time |

**~173 are genuine defects.** Of those, the number that Vinv's *current* design could autonomously surface on this repo is **approximately zero** — not because the detectors are weak, but because (a) the plan was empty, and (b) nearly every class needs one of: chosen function inputs, an injected fault, a value-level oracle, an environment matrix, or a concurrency schedule. Vinv has none of those.

---

## The five structural gaps (with code anchors)

### G1 — No function-level input channel
`execute.py:94-153` is a stdlib `urllib` driver; `scenario.py`, `throughput.py`, `regress.py` and the auth sweep all funnel through the same `execute_probe`. Nothing in the repo imports target code and calls it.
**Blocks:** AST-interpreter bugs, boundary/falsy bugs, tool-schema extraction, `python -O` behavior — every class where the bug is in a function you must *call*, not a route you must *request*.

### G2 — No wrong-value oracle (the loop is 90% built and not connected)
This is the most consequential and the cheapest to fix.
- Spans record `status=ok`; issue clusters require 5xx/crash (`issues.py:77-85`).
- Golden baselines **erase values**: `_shape_signature` keeps sorted keys + value *types* and discards values (`execute.py:60-77`), and "Golden = earned" — **the first 2xx becomes the gold, right or wrong** (`baseline.py:108`).
- Daikon-lite invariants are learned over HTTP response bodies only… **and never enforced**: the `invariant_violation` flag that `issues.py:77` reads **has no writer anywhere in the repo.**
- Every autonomous episode trigger in `autoTrigger.ts` is exception-, 5xx-, perf-, or memory-shaped.

**Consequence:** a function that returns a *plausibly-shaped wrong answer* is invisible end-to-end. That is the single largest defect class in any library.

### G3 — Coverage is function-entry, not branch
`coverage.py:96-115` marks a symbol covered if a span shows it *entered*. The Thompson-sampling bandit's reward is "newly covered symbols" — so **the reward saturates after one call per function**, long before the input space is explored. The RL loop is optimizing a metric that stops moving while behavior space is still wide open.

### G4 — No sandbox, no fault injection, no environment matrix
testflow Phase 5 is unimplemented. The service runs once, in the user's own environment, against the real network and DB. `determinism_capture` *records* clock/RNG but never *perturbs* them. There is no dependency-version matrix — so the 4 version-drift issues are structurally undetectable no matter how much runtime evidence accumulates.

### G5 — Single-process, serial observation
Child processes are not captured (`cli.py:93-95`), `site-packages` is skipped by default (`import_hook.py:50-54`), generator bodies are uninstrumented (`import_hook.py:368-372`), and probes are strictly serial ("Bounded concurrency 1"). Subprocess executors, third-party internals, races and deadlocks are all out of view.

---

## Scored against `testflow.md`

| Phase | State | Gap |
|---|---|---|
| 1 Discovery | 🟡 | HTTP decorators only; non-HTTP kinds catalogued but never driven |
| 2 Static analysis | 🟡 | Call graph yes; no CFG/DFG/type-graph; no CodeQL/Joern/Semgrep |
| 3 Semantic understanding | 🟢 | LLM-authored scenarios — genuinely implemented |
| **4 Input generation** | 🔴 | **1 of 6 strategies.** Schema + observed + LLM. No symbolic execution, no coverage-guided fuzzing, no grammar fuzzing; property-based deferred |
| **5 Execution sandbox** | 🔴 | **Not implemented** |
| 6 Runtime profiling | 🟢 | Vinv's strongest phase — better than the doc asks |
| 7 Behavioral learning | 🟡 | Daikon-lite over HTTP responses only |
| **8 Automatic assertions** | 🔴 | **Learned but never enforced** (dead flag) |
| 9 Coverage feedback | 🟡 | Function-entry, not branch |
| 10 Behavioral profile | 🟢 | Implemented |

The gap is concentrated in **4, 5, 8** — exactly the phases that let you *choose inputs* and *judge outputs*. Vinv built the observation half of testflow beautifully and the exploration half barely at all.

---

## What to build (ordered by value ÷ effort)

### P0.1 — Fix route discovery *(days)*
Add declarative `Route(...)`/`Mount` lists, `argparse` CLIs, and framework variants. Ship an **AST-based route extractor** to replace regexes. Add a loud diagnostic: *"0 endpoints discovered — Vinv cannot exercise this repo"* instead of silently producing an empty plan. **A silent zero must never look like a clean run.**

### P0.2 — Wire the oracle that already exists *(days)*
Give `invariant_violation` a writer: enforce learned invariants on every replay and emit a violation as a first-class issue kind. Stop erasing values in baselines — keep a value-level digest alongside the shape hash. Add an `assert`-shaped episode trigger for "output changed but nothing raised."
**This alone converts Vinv from an error-detector into a behavior-detector.**

### P0.3 — Branch coverage *(1–2 weeks)*
Use `sys.monitoring` (3.12+) or `coverage.py` to feed branch-level reward into the bandit. The RL loop only becomes real when its reward keeps moving.

### P1.1 — Function-level harness *(the big unlock, ~1 month)*
Drive catalogued entry points **in-process**: import the module, call the function, record args/returns/exceptions. This turns `entrypoints` from inventory into a target set, and immediately makes ~60 issues reachable.
Pair with **Hypothesis** for property-based generation (already an optional dep).

### P1.2 — Differential oracle *(highest single-technique yield here)*
For any function with a reference implementation, compare. For `LocalPythonExecutor` the reference is **CPython `exec` itself** — a differential corpus over `ast` node types would have caught #2555, #2552, #2090, #1649, #1998 mechanically. Generalizes to: previous released version (regression), sibling provider adapters (conformance), documented spec (contract).
**New agent:** a *reference-finder* that, given a symbol, proposes its differential oracle and the corpus generator.

### P1.3 — Boundary fault injection *(catches ~30 issues)*
A model-provider stub replaying adversarial-but-legal shapes: missing `tool_calls`, `content=None`, truncated `</code` fences, duplicate stream indices, and a **chunk-boundary sweep** (for a canonical stream of length L, emit all L split points and assert the aggregator converges). Same pattern for MCP, HTTP deps, filesystem.
**New agent:** a *fault-cataloguer* deriving the adversarial-shape set from a boundary's type contract.

### P2 — Environment & concurrency
Nightly **dependency-resolution matrix** (`uv lock --resolution lowest-direct|highest` × python versions × extras) plus **signature-drift assertions** (`inspect.signature()` on every upstream entry point actually called — would have caught the gradio_client and vLLM breaks the day they shipped). Deterministic concurrency schedules and timeout injection for the hang/deadlock class. Child-process tracing.

---

## What this means for the RL design

The current loop is: *Thompson sampling over input strategies, rewarded by newly covered symbols.* Three things are wrong with that as stated:

1. **The reward saturates** (G3) — fix with branch coverage.
2. **The action space is too small.** Arms are input *strategies* for one HTTP endpoint. The real action space is `(entry point × input-generation technique × oracle)` — including "call this function directly with a Hypothesis strategy and check against CPython."
3. **The objective is coverage, not defect discovery.** Coverage is a proxy. With a value-level oracle (P0.2) the loop can be rewarded on *oracle violations found per unit cost* — the thing we actually want — with coverage as the exploration bonus rather than the goal.

That is the honest through-line: **Vinv's observation and verification machinery is genuinely strong** — the paired-bootstrap gate, byte-identical replay, the opportunity board, the dispute/escalation path all work and are proven. What is missing is the *exploration* half: the ability to choose an input, perturb an environment, and judge a value. Until those land, Vinv will keep finding real-but-narrow wins like #2572 and keep missing the 173.

---

## Appendix — verification notes

- Issue corpus: 279 open issues (PRs excluded), fetched 2026-07-27, `gapanalysis/issues.json`.
- Route-discovery failure **verified directly**: `smolagents/examples/server/main.py:210-211` uses `Route("/", homepage)` / `Route("/chat", chat, methods=["POST"])`; the four regexes at `identification/runner.py:75-117` are decorator/`add_api_route`/Django-shaped.
- The `invariant_violation` dead flag **verified by repo-wide grep**: read at `issues.py:77`, written nowhere.
- The two Gradio example services expose no repo-source routes at all (their HTTP surface is Gradio's own FastAPI inside `site-packages`), so they appear only as `MAIN_*` entries — which the exerciser never drives.
