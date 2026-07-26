# eval — retrieval quality harness

Measures whether a change to `index` (representation mode, PageRank weight,
parsing, …) actually improves retrieval, instead of guessing.

## How it works

Each entry is categorized as `behavior`, `identifier`, `doc`, or `graph` and
contains a natural-language query with a known answer:

```json
{ "q": "how are stored memories ranked by relevance?",
  "file": "memory/persistent.py",
  "symbol": "find_relevant",
  "category": "behavior" }
```

The compact schema above represents one binary-relevance answer. For queries
with several acceptable or graded answers, use:

```json
{ "q": "where is request authentication implemented?",
  "category": "graph",
  "answers": [
    { "file": "api/auth.py", "symbol": "authenticate", "relevance": 2 },
    { "file": "api/middleware.py", "symbol": "AuthMiddleware", "relevance": 1 }
  ] }
```

The harness runs each query through `index query`, then scores overall and for
each category:

- **file-level** hit@1/@5/@10, MRR, and nDCG — did the correct *file* appear in the top-k
  (the fair cross-tool metric; tools chunk differently).
- **symbol-level** hit@1/@5/@10, MRR, and nDCG — did the exact *function* appear.
- **latency** — p50 and p95 per-query wall-clock.
- **context budget** — estimated returned-context tokens (UTF-8 JSON characters
  divided by four) at mean, p50, and p95. This is a stable comparative proxy,
  not provider billing telemetry.

Path matching is separator-normalized and requires complete path-component
boundaries, so an absolute result path can safely match a repo-relative gold
path without accepting unrelated string suffixes.

## Run

Build the index first (`cargo build --release` in `index/`, which produces
`./target/release/index` — this dev harness uses that binary directly, not the
packaged `dist/index` from `scripts/build_binary.sh`). The `--store-dir` below is
this harness's own scratch store under `~/.vinv_index/<repo-slug>`, separate from
a repo's runtime `<repo>/.vinv/index`. Then:

```bash
# gateway comes from the usual env (INDEX_GATEWAY_URL — defaults to the local sidecar)
python eval/bench_retrieval.py \
  --index-bin ./target/release/index \
  --store-dir ~/.vinv_index/<repo-slug> \
  --questions eval/questions.vinv.json
```

Tune only on `questions.vinv.json`. Run the separately frozen, target-disjoint
holdout once a candidate is selected:

```bash
python eval/bench_retrieval.py \
  --index-bin ./target/release/index \
  --store-dir ~/.vinv_index/<repo-slug> \
  --questions eval/questions.vinv.holdout.json \
  --split holdout \
  --json-output holdout-metrics.json
```

Use `--json-output metrics.json` for machine-readable output. Pass
`--score-decomposition` to summarize optional numeric `score_components` or
`score_decomposition` objects emitted by a backend. The current `index` output
does not expose internal dense/sparse/RRF contributions, so this reports zero
coverage without changing production ranking behavior.

Run the gateway-independent evaluation tests with:

```bash
python -m unittest discover -s eval -p 'test_*.py'
```

To compare representation modes and PageRank weights without touching the
holdout during tuning:

```bash
python eval/sweep_retrieval.py \
  --index-bin ./target/release/index \
  --repo . \
  --work-dir /tmp/vinv-retrieval-sweep \
  --json-output /tmp/vinv-retrieval-sweep.json
```

The first policy is the shipping baseline (`docstring`, rank weight `0.02`).
The script selects on development utility (symbol nDCG minus a configurable
context-token penalty), then reports a deterministic paired-bootstrap 95%
interval on the unopened holdout. Do not promote a candidate whose holdout
interval includes a material regression.

## Offline policy evaluation

The packaged index MCP logs epoch-scoped decisions and explicit
`vinv_feedback` rewards to `~/.vinv/telemetry/retrieval.jsonl`. Evaluate a
candidate context-size policy with:

```bash
python eval/off_policy.py \
  --telemetry ~/.vinv/telemetry/retrieval.jsonl \
  --epoch <store-epoch> \
  --baseline-top-k 5 \
  --target-top-k 5 \
  --json-output /tmp/top-k-5-ope.json \
  --policy-output ~/.vinv/retrieval-policy.json
```

The report includes cross-fitted direct, IPS, self-normalized IPS, and doubly
robust estimates (folds stratified by action), a BCa bootstrap interval
(near-nominal coverage from n≈20, where percentile intervals undercover),
overlap, importance-weight diagnostics, and effective sample size. It refuses
promotion (`promotable=false`) with fewer than 40 rewarded decisions
(`--min-samples`), an effective sample size below 25 (`--min-ess`), or fewer
than 8 logged pulls of a compared action. These gates are calibrated for the
two-stage design: at ESS 25 the binary-reward standard error is ~0.09, so the
LCB ≥ 0 rule only clears deltas ≳ 0.15 — the offline gate is a do-no-harm +
plausible-win filter, and the 5% canary with auto-rollback is the actual
test. (The previous 200/100 gates were per-epoch and could never fire at
observed volumes — a broken gate, not a conservative one.) Raw action overlap
is reported as a diagnostic but is not a gate, because a rare epsilon-greedy
arm with correct propensities is still identified. The importance-weight clip
defaults to 1/min(logged propensity), so nothing is clipped and the estimate
stays unbiased; an explicit `--weight-clip` reports `clipped_fraction` and
blocks promotion when nonzero. Decisions flagged `fallback` (a canary draw
that failed and was served as baseline) are excluded. Rewards come from
`--reward-source`: `explicit` (`vinv_feedback`), `auxiliary` (edit-overlap
rewards the MCP settles automatically), or `any`. Missing explicit feedback
is treated as missing-not-at-random: the report carries the logged-decision
denominator (`explicit_feedback_rate`).

Epochs pool with `--epoch all`: the top-k action's semantics are stable
across index epochs, so IPS/DR stay unbiased over the historical context
mixture (Waudby-Smith et al., arXiv:2210.10768); a per-epoch consistency
guard (`epoch_consistency`) fails promotion when any epoch with ≥20 samples
contradicts the pooled delta by more than 0.1 — the Simpson-artifact guard.
A pooled promotion writes an epoch-agnostic policy (`"epoch": "any"`), which
`loadPolicyForEpoch` accepts across index updates; exact-epoch policies
remain valid for single-epoch runs. The extension now runs this evaluation
automatically (`src/mcp/opeEvaluator.ts`, a math mirror of this module) at
MCP-server start and after every 25 rewarded feedback events.

The MCP explores when `VINV_RETRIEVAL_POLICY_MODE=explore`: epsilon-greedy
over `VINV_RETRIEVAL_ACTIONS` (default `3,5,8,10`) at rate
`VINV_RETRIEVAL_EPSILON` (default `0.1`) with exact per-action propensities.
In the default shadow mode the counterfactual query is also executed (results
discarded, content-safe metrics logged) so shadow traffic still feeds
evaluation. Rollback state and pending decisions persist in
`~/.vinv/telemetry/state.json`, so an MCP restart cannot resurrect a
rolled-back canary.
The policy file is written atomically only when the candidate's doubly robust
reward delta has a non-negative 95% lower bound against the baseline. The MCP
starts it in shadow mode by default; `VINV_RETRIEVAL_POLICY_MODE=canary`
enables at most 5% exposure and rolls back on a query error or three consecutive
negative canary rewards.

## Tuning the levers this exists to measure

Re-index (or re-query) under different settings and compare:

- `INDEX_EMBED_MODE` = `signature` | `docstring` (default) | `full` — the
  document-representation knob. `docstring` favors exact-symbol precision;
  `signature` favors file-level recall (measured trade-off).
- `INDEX_RANK_WEIGHT` — weight of the PageRank importance prior (default 0.02).
  Sweep it here to confirm it helps rather than being inert or overpowering RRF.

## Notes

- Use a **real** embedding gateway for meaningful absolute numbers; a general
  code model gives indicative-but-not-production accuracy.
- `questions.vinv.json` is a repository-grounded 50-question baseline balanced
  across behavior, identifier, documentation, and graph-oriented retrieval.
- `questions.vinv.holdout.json` adds 24 explicit holdout questions, balanced
  across the same categories and disjoint from development targets.
- Answers (`file`/`symbol`) must match how `index` reports them: `file` is the
  repo-relative path; `symbol` is the function/method name.
