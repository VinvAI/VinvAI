<div align="center">

<img src="https://images.vinv.ai/vinv-banner-light.png" alt="Vinv" width="820">

# `pip install vinv`

**Vinv runs, tests, and finds issues in your services — with zero code changes.**

[![PyPI](https://img.shields.io/pypi/v/vinv?style=flat-square&color=D71921&label=pypi)](https://pypi.org/project/vinv/)
[![Python](https://img.shields.io/pypi/pyversions/vinv?style=flat-square&color=D71921)](https://pypi.org/project/vinv/)
[![License](https://img.shields.io/badge/license-Apache--2.0-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI/blob/main/LICENSE)
[![100% local](https://img.shields.io/badge/100%25%20local-no%20telemetry-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI#privacy)

<sub>Python services & APIs · runs on your machine · no account, no API keys, no telemetry</sub>

</div>

---

Vinv watches a **real run** of your Python services and hands your AI coding agent the
actual execution evidence — traces, argument values, the failing frame — instead of
leaving it to guess from static text. Then it **won't let a fix land** until it passes
acceptance tests written *before* the fix that the agent never sees.

Your coding agent (Claude Code, Cursor, Copilot…) is the only LLM. **No new bill, no
provider keys.**

## Install

```bash
pip install vinv
```

Or run any engine with **zero install** via [uv](https://docs.astral.sh/uv/):

```bash
uvx --from vinv exerciser campaign ./my-service --budget 20
```

<sub>First run fetches a one-time ~500&nbsp;MB local embedding model. Python 3.12–3.14.</sub>

## Context beats model size

Vinv found **four bugs and one performance problem** in
[fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template)
(~44k★). Same five issues, same prompts, Vinv grading every run:

| Setup | Fixed |
|---|---|
| **Cheap commodity model + Vinv evidence** | **4 bugs + 1 optimization** |
| Frontier model, working blind | 1 bug |
| Cheap commodity model, working blind | nothing |

<sub>One trial per condition — a demonstration, not a benchmark. The evidence is what
moved, not the weights.</sub>

On the same template the optimization loop detected connection-pool starvation from live
traces alone, dispatched the fix, and **proved** it: sustained-load median
**75.6ms → 41.2ms, 45.4% faster** (95% CI [36.3%, 45.8%]), responses byte-identical.
Upstream on Hugging Face, it found and proved an allocation fast-path in
[smolagents](https://github.com/huggingface/smolagents) — **~37,000× less** transient
allocation, output byte-identical across 2,015 inputs
([PR #2572](https://github.com/huggingface/smolagents/pull/2572)).

## What you get — Run · Test · Find · Prove

- **🏃 Run** — brings every service in your repo up under tracing with **zero edits** to your code: timings, arguments, return values, call trees, from the real run.
- **🧪 Test** — drives real requests through every endpoint (valid, boundary, negative, authenticated) and banks each response as a permanent regression case.
- **🔎 Find** — surfaces what actually broke or slowed down: server errors, crashes, latency hotspots, memory leaks, and dead code — each tied to the exact source line.
- **✅ Prove** — hands that evidence to your coding agent, then verifies its fix against acceptance tests it never sees. A "faster" change that alters any output is auto-reverted.

## The engines

`pip install vinv` installs one package that ships every engine as a console script:

| Command | What it does |
|---|---|
| `exerciser campaign <repo> --budget N` | **Start here.** One budget across every armed oracle; reports which technique paid |
| `tracelens run -- <cmd>` | Zero-edit runtime tracing of a Python service or CLI |
| `identification consolidate <repo>` | Join traces to source; produce the API/call-graph map |
| `bringup …` · `goal …` · `handbook …` | Service discovery, fix episodes, and the codebase handbook |
| `vinv-embedder` | The local embedding sidecar (no cloud keys) |

## Works with any MCP client

Vinv is also an **MCP server** — point Claude Code, Cursor, or any MCP-compatible agent at
it and your agent gets `vinv_query` (semantic code search), `rank_suspects` (fault
localization over real runs), runtime `values_of` / `slice` / `coverage_of`, and a
`vinv_session` tool that drives the whole verify/optimize loop from chat.

## Privacy

100% local. No telemetry, no analytics, no usage pings. Traces stay on your machine and
sensitive values are redacted. Apache-2.0.

---

<div align="center">
<sub><b><a href="https://vinv.ai">vinv.ai</a></b> · <a href="https://github.com/VinvAI/VinvAI">github.com/VinvAI/VinvAI</a> · Python first — TypeScript & Go next</sub>
</div>
