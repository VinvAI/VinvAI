# How Vinv learns: the reward, propensity, and gating math

This document maps the learning machinery that actually ships in this tree —
every claim carries a `file:line` reference, and the numbers in the
[off-policy results](#measured-off-policy-results) section come from running
the evaluator on this repository's own telemetry (2026-07-23).

## 1. The episode loop's reward signal

An episode = one dispatched fix attempt against the user's own coding harness.
Its reward is composed from independent signals, each of which can honestly be
*absent* (`unavailable` renormalizes the rubric — it is never imputed as a
pass):

- **Acceptance oracle (fail-to-pass):** the harness authors a test file from
  the issue; it is stored *outside* the workspace under an opaque token
  (`extension/src/harness/rewardEngine.ts:355-362`) and must FAIL
  deterministically twice on the pre-fix code
  (`rewardEngine.ts:409-424`; flake guard `runAcceptanceTests`,
  `rewardEngine.ts:333-340`). A test that passes on broken code is discarded —
  the SWE-bench fail-to-pass discipline.
- **Static pre-gate:** every changed `.py` must `ast.parse` before any test or
  replay budget is spent (`rewardEngine.ts:657-725`).
- **Anti-cheat diff audit:** deterministic pattern flags over
  `git diff <snapshot-ref>` + untracked files (`rewardEngine.ts:576-591`;
  patterns in `rewardSignals.ts` — test edits, `except` swallows, interpreter
  shadow modules, `.vinv` state tampering). Hard flags block
  verified-eligibility outright.
- **LLM judge (bounded):** engine-rendered `judge-diff` agent
  (`rewardEngine.ts:601-635`). Contract: it can push toward *scrutiny*, never
  rescue a failed gate — a `null` judge decides nothing.
- **Mutation smoke (advisory):** ≤ 8 seeded AST mutations of the changed
  functions must be noticed by the acceptance set
  (`rewardEngine.ts:817-879`); survivors are logged and judged context, never
  a gate, and never revealed to the fixing agent (Goodhart guard).

`composeRewardBreakdown` (`extension/src/harness/rewardSignals.ts:381`)
aggregates these into `reward ∈ [0,1]` plus a `verifiedEligible` bit; the
episode-level reward discounts extra attempts and scores a user abort −1
(`episodeTelemetry.ts:667-681`):

```
reward = -1                     if aborted
       =  0                     if unverified (MNAR — never assumed bad)
       =  max(0, 1 − (attempts−1)/budget)   if verified
```

## 2. Propensity logging and the composition bandit

Context-pack composition is a factored 2^3 arm grid (slice depth ×
runtime-evidence inclusion × snippet budget, `episodeTelemetry.ts:40-92`).
Selection is **Thompson sampling over per-arm Beta posteriors with an ε-floor
mixture** (`selectEpisodeArm`, `episodeTelemetry.ts:607-629`):

```
P(play a) = ε/|A| + (1−ε)·P_TS(a)
```

- `P_TS(a)` is estimated by 800 Monte-Carlo Thompson draws
  (`thompsonPropensities`, `episodeTelemetry.ts:557-567`) and the **exact
  mixture propensity is logged with the decision** — the requirement for
  unbiased IPS/SNIPS/DR later.
- The ε-floor (`effectiveEpsilon`, `episodeTelemetry.ts:467-471`) decays as
  `clamp(c·|A|/√N, ε_min, ε₀)` but never reaches 0: every arm keeps non-zero
  propensity, so importance weights stay bounded.
- Posterior update (`episodePolicyUpdater.ts:292-349`): per arm,
  `α = prior + #verified`, `β = prior + #unverified`, counting **only
  objective episodes** — a user abort or an "approve as done" click is not
  evidence about arm quality (`CompletedEpisode.objective`,
  `episodePolicyUpdater.ts:84-92`). Retractions from a reproducing human
  counterexample re-label the episode `verified=false, objective=true,
  reward=−1` (`episodePolicyUpdater.ts:168-179`).
- Attribution is **exact Shapley** over the 2^|F| grid of posterior means
  (`shapleyAttribution`, `episodePolicyUpdater.ts:244-276`) — "did runtime
  evidence help" is a computed number.
- The attempt budget is the learned `attempt_quantile` of attempts-to-success
  plus one margin (`episodePolicyUpdater.ts:339-346`).
- Per-test pool events (raw, not baked weights) are appended for a future
  bandit pool manager (`appendPoolEvent`, `rewardEngine.ts:891-927`) — OPE
  doctrine: log everything, choose the estimator later.

The adaptive replay budget (`replayStats.ts`) removes the one fixed constant
that used to poison this ledger: a service's soft boot budget is
`max(floor, observed-quantile × multiplier)` from its own recorded
time-to-serve (`softBudgetMs`, `replayStats.ts:128-131`), with progress-gated
extension up to a ceiling (`ceilingMs`, `replayStats.ts:138-143`).

Tests: the full synthetic walk — reward values → ledger → posterior counts →
preferred arm and attempt budget — is asserted in
`extension/src/test/rewardAndOpe.test.ts` (suite "Episode walk: reward →
ledger → policy update → OPE gate"), alongside the pre-existing reward,
audit, replay-budget, retraction, and F2P-against-a-real-interpreter suites
(288 extension tests green).

## 3. The retrieval config walk and its OPE gate

Retrieval serving (top-k) is a *separate* contextual bandit with its own
ledger (`~/.vinv/telemetry/retrieval.jsonl`, written by
`extension/src/mcp/indexServer.ts` and `retrievalTelemetry.ts`). A candidate
configuration is **never** promoted on a hunch; the walk is:

1. **Log** every decision with epoch, action, exact propensity, and result
   hashes; join explicit `vinv_feedback` (and critic/auxiliary/implicit
   sources) as rewards (`index/eval/off_policy.py:45-127`).
2. **Estimate** the candidate policy's value offline with cross-fitted
   DM/IPS/SNIPS/DR (folds stratified by action, `off_policy.py:130-249`).
3. **Gate:** promotable only when ALL hold (`off_policy.py:461-468`):
   ESS ≥ 25, n ≥ 40 joined samples, ≥ 8 logged pulls per compared action,
   BCa-bootstrap 95% LCB of the DR delta ≥ 0 (`off_policy.py:314-365`), zero
   clipped weights, and no epoch contradicting the pooled delta
   (`off_policy.py:368-390` — the Simpson-artifact guard).
4. **Canary:** a promoted policy serves at 5% only
   (`off_policy.py:472-489`), and three consecutive negative canary rewards
   auto-roll it back (`indexServer.ts:734-746`). A failed canary draw is
   served as baseline but logged as its true draw and *excluded* from
   estimation (`off_policy.py:80-82`) — its served action no longer matches
   its logged propensity.

The same math runs live in the extension (`extension/src/mcp/opeEvaluator.ts`,
byte-for-math mirror; evaluation fires every 25 rewarded events,
`opeEvaluator.ts:42,425`). The offline `sweep_retrieval.py` is the *manual*
config walk over representation modes × rank weights: it tunes on
`questions.vinv.json`, refuses target-file leakage into the frozen holdout
(`sweep_retrieval.py:assert_holdout_disjoint`), and opens the holdout once —
so retrieval configuration only ever changes on a measured, holdout-confirmed
or OPE-gated win.

### Measured off-policy results

Run on this repo's own ledger (800 logged decisions, 770 joined samples, 96%
explicit-feedback rate; pooled across 12 index epochs; baseline top-k = 5):

| candidate | DR (candidate) | DR delta | 95% BCa CI | ESS | promotable |
|---|---|---|---|---|---|
| top-k 10 | 0.974 | **+0.173** | [+0.081, +0.317] | 577 | **yes** |
| top-k 3  | 0.882 | +0.081 | [−0.057, +0.226] | 68 | no (LCB < 0, epoch guard fails) |
| top-k 20 | — | +0.148 | [+0.062, +0.283] | 0 | no (zero support — never logged) |

Baseline top-k 5: DR 0.801, ESS 51. The gate admits exactly the measured
winner and blocks both the uncertain and the unsupported candidate — the
behavior the unit tests pin synthetically
(`rewardAndOpe.test.ts`: "a consistent, supported, positive candidate is
promotable", "the OPE gate blocks a WORSE candidate policy outright",
"epoch consistency fails …").

Retrieval quality on the self-index store (`.vinv/index`, 4036 symbols,
CodeRankEmbed, 50 dev questions, `bench_retrieval.py`): file hit@5 0.82,
hit@10 0.90, MRR 0.69; symbol MRR 0.41; p50 latency 91 ms.

## 4. The input/output regression map (endpoint golden baselines)

Probes are synthesized deterministically from traces (method + concrete path
from observed argument values, `probeRunner.ts:synthesizeProbeSpecs`) and
replayed against the live service. New in this change, every probe pass now
diffs against a **golden I/O baseline** per endpoint
(`extension/src/harness/probeBaseline.ts`):

- `.vinv/probes/baselines/<api-id>.json` stores, per request:
  `{status class, handler provenance, response shape hash}` — the shape hash
  is *structural* (sorted keys + value types, arrays collapsed to their
  element-shape union), so values/ids/timestamps never churn it while a
  dropped field or type change always does (`responseShapeHash`).
- Baselines are **earned**: only a healthy (2xx/3xx) response seeds one, a
  degraded run never rewrites the contract it just broke, and an improvement
  ratchets the baseline upward (`applyBaselines`).
- Every probe outcome now carries `baseline: degraded|same|improved|recorded`
  (+ detail) and the run summary counts `degraded`/`improved`
  (`pipelineState.ts:162-168,180-182`; wiring in `probeRunner.ts:697-706`).

This is what makes "optimize without degrading output" *testable*: after a
fix/optimization episode the probe pass re-runs the recorded inputs and any
endpoint whose status class or response structure regressed is flagged
`degraded` — an objective per-endpoint verdict, unit-tested against a stub
HTTP server end-to-end (`extension/src/test/probeBaseline.test.ts`).

## 5. Per-symbol memory attribution

- Capture: `tracelens` wraps every instrumented call and records the **net
  tracemalloc byte delta** (`tracelens.mem_delta_bytes`) around the call —
  allocations that survived minus frees
  (`tracelens/src/tracelens/runtime/trace_fn.py:34-61`). On by default
  (`standard` preset, `launcher/run.py:42-44`); RSS/peak are *not* captured —
  the per-symbol data is alloc deltas only.
- Export: exit rows carry `mem_delta_bytes`
  (`tracelens/src/tracelens/otel/exporter.py:248-252`). Fixed here: a
  memory-off capture now exports `null` instead of a `0` indistinguishable
  from a true zero-delta call (`tests/test_exporter_memory_field.py`).
- Consumption: the extension aggregates per-symbol memory from the raw
  capture (`extension/src/identification/traceMemory.ts:60-135`) and overlays
  it onto the call tree; the flamegraph's memory metric renders from exactly
  this data (`callTreeView.ts:490-724`), omitting the axis entirely when
  attribution was off. Cross-session leak trends (Theil–Sen slope over net
  deltas) live in `harness/runtimeAnalysis.ts`.
- Verified live: a traced run of a small workload shows
  `retain_two_megabytes → +2,097,241 B` per call and
  `scratch_allocation → +60 B` (buffer freed), landing in the JSONL and in
  the aggregation (`extension/src/test/traceMemory.test.ts`).

## 6. Why symbol-level + runtime-join context is ahead

The chain Vinv serves to an agent is
`symbol name → exact snippet at file:lines → observed runtime facts`:
`index query` returns ranked symbols with their real definition snippet and
line span (verified: `wrap_call` → `tracelens/src/tracelens/runtime/trace_fn.py:117-127`
with the actual `def` body and 12 graph neighbors), the MCP server passes
that payload through intact with a logged decision id
(`extension/src/mcp/indexServer.ts:530-560`), and the runtime MCP joins the
same symbols to captured argument values, error exemplars, and call structure
(`extension/src/mcp/runtimeServer.ts`).

Comparable systems structure context differently:
[Sourcegraph Cody](https://sourcegraph.com/blog/how-cody-understands-your-codebase)
retrieves embedding/BM25-ranked *chunks* (plus code-graph context on
enterprise), [Aider's repo map](https://aider.chat/2023/10/22/repomap.html)
ranks tree-sitter *signatures* with PageRank over the def/ref graph but sends
declarations rather than bodies, and
[Copilot's workspace index](https://dzone.com/articles/github-copilot-multi-file-context-internal-architecture)
blends embeddings of file chunks with editor state (open files, imports,
recency). All three stop at *static* text: none joins retrieval to what the
code **did at runtime**. Vinv's units are whole symbols (not arbitrary
chunks), carry exact line provenance, and arrive already joined to trace
evidence — which is why a fix episode's context pack can cite the failing
argument values next to the definition it retrieves. The gap worth an issue:
ranked retrieval is still snippet-per-symbol (no Cody-style multi-hop chunk
expansion inside very large symbol bodies), and module-level doc blobs can
outrank function symbols on vague behavioral queries (observed on
"who wraps a function call…" — the module doc won; the identifier-phrased
query returned the function).
