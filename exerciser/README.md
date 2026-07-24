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
vinv-exerciser plan    <repo> [--service X] [--base-url URL] [--store-dir DIR] [--seed N]
vinv-exerciser run     <repo> --base-url http://127.0.0.1:PORT [--budget N] [--rounds K] [--seed N]
vinv-exerciser profile <repo> [--service X]
vinv-exerciser regress <repo> --base-url http://127.0.0.1:PORT
```

Artifacts land under `<repo>/.vinv/exercise/`:

| file | written by | contents |
|------|-----------|----------|
| `plan.json` | `plan` | per-endpoint input plan across three provenance layers |
| `prompts/*.json` | `plan` | harness prompts for `needs-semantics` endpoints (goal-engine pattern) |
| `results.jsonl` | `run` | every execution: endpoint, input, strategy, status, latency, shape-hash, error |
| `bandit.json` | `run` | Thompson posteriors per (endpoint, strategy) |
| `profile.json` / `profile.md` | `profile` | behavioral profile + human report (testflow Phase-10 shape) |
| `invariants.json` | `profile` | learned invariants with Laplace confidence |
| `issues.json` | `run`/`profile` | failure clusters by normalized signature (extension → episodes) |
| `baselines/*.json` | `run`/`regress` | earned golden behavior baselines (degraded/same/improved) |

## Maths

- **Coverage-guided loop:** Thompson sampling over generation strategies per
  endpoint. Each `(endpoint, strategy)` carries a `Beta(α, β)` posterior (priors
  `α₀=β₀=1`); a probe's reward bit is `1` when it covers ≥1 new symbol, `0`
  otherwise, and `α += successes, β += failures` — the same Bernoulli/Beta update
  `docs/learning.md §2` uses for the composition bandit. Selection samples
  `θ_s ~ Beta(α_s, β_s)` and plays `argmax_s θ_s` (seeded RNG → deterministic).
  The loop stops when a whole round covers no new symbol or the budget is spent.
- **Invariant confidence (Daikon-lite):** an invariant is kept only with support
  `≥5` observations and `0` counterexamples; its confidence is the Laplace
  estimate `(s+1)/(n+2)` over `n` relevant observations (`s=n` when there are no
  counterexamples).

See `docs/learning.md §7` for how these tie into the existing learning ledger.
