# The agent endpoint-testing loop

How a coding agent drives a service's endpoints, gets the result into vinv, and
acts on what vinv ranks — without a human wiring artifacts by hand.

## Why the agent tests, and vinv ranks

Splitting it any other way does not work:

- **A trace cannot find a correctness bug.** It records that `/chat` answered
  200 after 232 seconds. Nothing in it says that was wrong. The verdict — the
  *oracle* — belongs to whoever sent the request.
- **A generated-input exerciser will not think to plant a secret in one session
  and ask for it back in another**, or to assert that a stack trace in a
  response body is a security defect. Those are semantic judgments.
- **An agent cannot rank hotspots by eye.** Which symbol is 54,000× the typical
  per-call cost, and how much of that is blocked off-CPU, is a measurement.

So: the agent supplies traffic and verdicts; vinv supplies measurement and
ranking. The MCP servers are the seam.

## The loop

### 1. Capture the traffic

Start the service under tracelens so every call is recorded:

```bash
tracelens run --standard -t <your_package> -o trace.jsonl -- python -m yourapp
```

Then place the capture where vinv reads it:

```
.vinv/captures/<session-name>/<service-name>/trace.jsonl
```

Use `--full` instead of `--standard` when you care about the memory dimension.
`--standard` is latency-honest but turns tracemalloc **off**, which leaves
gc-pressure, leak trends and alloc-churn with no data at all.

> **Check the startup warnings.** If your web framework is installed but its
> OpenTelemetry instrumenter is not, tracelens now warns and no server spans are
> produced — meaning no route on anything, and per-endpoint coverage of zero.
> The fix is the `pip install` line in the warning.

### 2. Drive the endpoints

Positive, negative, corner, security. The negative and corner cases are where
services actually fail: in one real run, positive paths scored 27/27 while
negative paths failed 33 of 69.

Run each scenario **more than once**. A single pass cannot distinguish a cold
start from a real cost, and cannot see flakiness at all.

### 3. Report the run

```
vinv_ingest_run({
  source: "claude-code e2e suite",
  checks: [
    { endpoint: "POST /chat", service: "api", name: "malformed JSON body",
      category: "negative", status: 500, latency_ms: 4, passed: false,
      severity: "high", detail: "server error 500 on invalid input (should be 4xx)",
      input: {...}, output: "Traceback..." }
  ]
})
```

- `endpoint` must be `"METHOD /path"`.
- `passed` is **required**. Validation refuses a run without it rather than
  guessing an oracle.
- `service` is optional but required in practice when a repo runs more than one
  service — three apps each serving `GET /` are three endpoints, and without it
  they merge into one row with pooled latencies.

Per-endpoint code coverage is joined automatically from the captures. Nothing
about which endpoint touched which symbols needs to be declared.

### 4. Confirm it landed

```
vinv_run_status()
```

Reports capture sessions, the ingested run's provenance, endpoint and coverage
counts, and how many candidates are ranked. `endpoints_without_traces` in the
ingest reply names any endpoint no captured request matched — usually traffic
that was not sent under `tracelens run`.

### 5. Act on what was measured

```
vinv_list_candidates({ limit: 10 })
```

Each candidate carries its evidence and the shipped playbook for its waste kind
(`cache`, `fanout`, `n-plus-1`, `per-call`, `serial-async`, `wait`,
`gc-pressure`, `alloc-churn`, `mem-leak`). Read the evidence before the source:
it reports what the run actually did.

## Reading the numbers honestly

**Blocked time is not recoverable time.** A symbol waiting on a network call or
a model provider is slow for a reason no local change can fix. The per-call
estimate is discounted by the on-thread fraction for exactly this reason —
before that correction, an LLM agent's top-level `run()` (98.5% blocked) took
89.7% of the ranking budget and hid every actionable candidate beneath it.

**Coverage of 0 on a 4xx/5xx endpoint is correct.** A request rejected at the
edge never reached instrumented code. That is a fact about the request, not a
gap in the capture.

**An unbounded cost is worse than a slow one.** A p95 that swings between 21s
and 247s across identical runs is not a performance number, it is a capacity
planning hazard — usually unvalidated input reaching an expensive path.

## Current limits

- `vinv_dispatch_optimization` does not exist. An MCP server is a separate
  process and cannot invoke a VS Code command, so taking a candidate through the
  predicted→proven episode still needs the Optimize panel. Wiring it needs an
  extension-side consumer for a queued intent.
- Coverage attribution needs inbound server spans. Frameworks whose OTel
  instrumenter is absent produce none — see the startup warning.
- Ingested artifacts are stamped `source` / `ingested_by`, but nothing yet
  *enforces* that a measured run outranks a reported one. Treat provenance as
  the thing to check when a scorecard looks surprising.
