# exerciser — the behavioral testing engine

Vinv profiles the traffic it happens to see. `exerciser` is the missing organ: it
**exercises every discovered endpoint itself**, so an endpoint that no request
ever hit still gets real coverage, a behavioral profile, learned invariants, and
a regression baseline.

It extends the existing Vinv pipeline rather than duplicating it — it consumes
identification's `apis.json` and call-tree/tracemap machinery, executes probes
against the *live traced service*, joins the freshly-captured spans back onto the
static call trees for per-endpoint symbol coverage, and feeds the same
degraded/same/improved baseline and issue→episode mechanisms the trace-derived
probes already use.

## Pipeline (mirrors identification's CLI shape)

```
vinv-exerciser plan        <repo> [--service X] [--base-url URL] [--store-dir DIR] [--seed N]
vinv-exerciser run         <repo> --base-url http://127.0.0.1:PORT [--budget N] [--rounds K] [--seed N]
vinv-exerciser invocations <repo> [--service X] [--timeout S] [--no-trace]
vinv-exerciser profile     <repo> [--service X]
vinv-exerciser regress     <repo> --base-url http://127.0.0.1:PORT
```

**Not every repo has endpoints.** A toolchain, a SDK or a framework exposes CLIs
and importable functions and nothing else, so there is no base URL to send
anything to. Those are exercised by the other two oracles, and both wrap the
work in `tracelens run` so a driven CLI or a called function produces spans
exactly as a served request does:

| unit | inventoried as | driven by | capture |
|------|----------------|-----------|---------|
| HTTP endpoint | `python_web` | `run --base-url …` | the service's own bring-up trace |
| CLI invocation | `python_cli` | `invocations` | `.vinv/captures/vinv-exerciser/<service>/invocations/` |
| exported function | `python_library` | `functions` | `.vinv/captures/vinv-exerciser/<service>/functions/` |

A CLI's argv comes from the `invocations` its `.vinv/services.json` entry
records; a library has no entrypoint of its own, so the function driver is what
runs it. The verdict for an invocation is the **expected** exit code, not
"non-zero is bad" — a check command that exits 1 on findings is working.

Each invocation is one **unit**, keyed `<service>#<id>` by its stable id rather
than its position, so inserting one does not rename the rest and orphan their
history. An invocation whose command carries `{name}` slots is run once with the
declared defaults (`input_class: "declared"`) and once per value the inventory
itself enumerated in `choices` or `examples` (`input_class: "generated"`),
varying one parameter at a time. It stops there deliberately: this oracle
**executes** what it builds, so unlike the HTTP generator — whose invented body
meets a running service's validation layer — it never invents argv. `--force`
and `--delete` are flags too, and nothing in the schema tells them from
`--verbose`.

Artifacts land under `<repo>/.vinv/exercise/`:

| file | written by | contents |
|------|-----------|----------|
| `plan.json` | `plan` | per-endpoint input plan across three provenance layers |
| `prompts/*.json` | `plan` | harness prompts for `needs-semantics` endpoints (goal-engine pattern) |
| `results.jsonl` | `run` | every execution: endpoint, input, strategy, status, latency, shape-hash, error |
| `invocations.json` / `invocation_results.jsonl` | `invocations` | one row per CLI run: command, exit code vs expected, duration, stdout/stderr tails, spans captured |
| `bandit.json` | `run` | Thompson posteriors per (endpoint, strategy) |
| `profile.json` / `profile.md` | `profile` | behavioral profile + human report (testflow Phase-10 shape) |
| `invariants.json` | `profile` | learned invariants with Laplace confidence |
| `issues.json` | `run`/`profile` | failure clusters by normalized signature (extension → episodes) |
| `baselines/*.json` | `run`/`regress` | earned golden behavior baselines (degraded/same/improved) |
| `scorecard.json` / `scorecard.md` | `scorecard` | per-service scorecard assembled from the artifacts above: endpoints n/m, coverage before→after, invariants, issues, latency (plus optimization deltas when a cycle ran) |

## Maths

- **Coverage-guided loop:** Thompson sampling over generation strategies per
  endpoint. Each `(endpoint, strategy)` carries a `Beta(α, β)` posterior (priors
  `α₀=β₀=1`); a probe's reward bit is `1` when it covers ≥1 new symbol or branch arm, `0`
  otherwise, and `α += successes, β += failures` — the same Bernoulli/Beta update
  `docs/learning.md §2` uses for the composition bandit. Selection samples
  `θ_s ~ Beta(α_s, β_s)` and plays `argmax_s θ_s` (seeded RNG → deterministic).
  The loop stops when a whole round covers no new symbol/branch or the budget is spent.
- **Invariant confidence (Daikon-lite):** an invariant is kept only with support
  `≥5` observations and `0` counterexamples; its confidence is the Laplace
  estimate `(s+1)/(n+2)` over `n` relevant observations (`s=n` when there are no
  counterexamples).

See `docs/learning.md §7` for how these tie into the existing learning ledger.

## What persists across runs (and what expires)

Everything the engine learns lives under `<repo>/.vinv/exercise/` and survives
restarts, new sessions, and machine reboots:

| Artifact | Persistence | Expiry |
| --- | --- | --- |
| `plan.json` | rewritten by `plan` | superseded by the next plan |
| `prompts/*.json` | harness replies preserved across re-plans | a reply expires (`reply_expired`, fingerprint-bound) when its scenario fails live; a fresh reply auto-revives it |
| `results.jsonl` | append-only IO record of every probe (input, status, shape, latency) | never; regress rebuilds its suite newest-wins |
| `baselines/` | golden behavior per probe | re-goldened newest-wins each run |
| `bandit.json` | strategy posteriors | warm-starts the next run with evidence DECAYED 50% per run — learned preferences persist but cannot outlive the environment they were learned in |
| `state_ledger.jsonl` | append-only record of state the engine planted | rows marked `cleaned` when teardown unwinds them; uncleaned rows drive regress's environment-drift classification forever |
| `invariants.json`, `profile.json`, `scorecard.json` | rewritten per profile/scorecard | superseded |

Credentials are the deliberate exception: tokens captured by scenarios are used
in-memory (sweep + teardown) and re-captured fresh by `regress` from the
scenario setup chains — they are never written to disk.

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
