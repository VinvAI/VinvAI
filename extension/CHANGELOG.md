# Change Log

User-facing changes to the **Vinv** extension. Internal refactors, docs, tests
and CI are not listed here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [0.2.2] — 2026-07-31

### ✨ Added

- **Repos with no server are traced now.** Pointed at a toolchain, an SDK or a
  library, the pipeline produced an empty inventory and stopped before a single
  line was traced — it only knew how to describe a unit of work that starts and
  stays up. CLIs and libraries are first-class units: a CLI carries the argv
  sets the repo itself declares, a library is driven function by function rather
  than through a command someone made up, and readiness is judged on the
  expected exit code plus a non-empty trace instead of on a port that is never
  going to open.

- **Every kind of unit gets a call tree and a report.** The insight pass built
  only for HTTP routes, so CLI commands, workers, scheduled jobs, stdio servers
  and `__main__` scripts could run any number of times and still have no call
  tree to open, no report, and no row in the Flow rail or Findings. The overlay
  is now built for every unit the captures saw — including a function the
  exerciser drove directly, which is declared nowhere in the code.

- **The Traces panel says how each unit ran, not just that it ran.** Every row
  carries kind, handler, hits, coverage, p50/p95 latency, the ok/raised split
  with the exception types behind it, runtime errors, and a button that opens
  its call tree. The numbers come from the captures themselves rather than from
  an exerciser's report, so a unit nothing drove still has them, and a CLI run,
  a worker task and an HTTP request are all measured the same way. The Findings
  latency profile reads the same source, and both refresh as new traffic
  arrives instead of freezing at the last exercise run.

- **CLIs actually get driven when there is no service.** The service-free pass
  ran the contract campaign alone and called it "exercising functions and
  contracts" — accurate, and precisely the gap, because a repo with no served
  port is usually a repo whose units are console scripts. Their invocations now
  run first and unconditionally, with argv taken from what the repo declares. A
  repo with no CLI or library unit skips the step at no cost.

- **Live work is visible in the status bar.** A run in progress shows a filled
  pill and a spinning icon — red was already the item's resting colour, so it
  could never signal anything — with failing taking precedence over running, so
  a run that is producing failures keeps saying so. It also refreshes when a
  service exits, instead of spinning for up to fifteen seconds after the thing
  it is reporting on has stopped.

- **The Findings empty state offers the buttons it was describing.**
  Auto-Pilot and Run Exercise are one click away, and a headline of all zeros
  now distinguishes "we drove your services and found nothing wrong" from
  "nothing has run yet" — opposite readings that used to render identically.

- **"Run this Path" keeps its trace.** Every try-run of a dead-code section is
  now recorded and shown in that section's report: what the fresh capture
  actually executed (functions, calls, milliseconds, what it raised), the
  agent's own note about what the driver drives, and one click each to open the
  trace and the driver. Failed attempts are kept too, so a section that cannot
  be driven says so instead of inviting the same run again, and the Findings
  list marks sections that have been driven.

- **"Run this Path" now shows what the code DOES, not just that it ran.** The
  agent is asked for a set of probe cases rather than one driver — the ordinary
  input, the boundary, the input that makes it fail — and each case runs as its
  own traced process. The report shows, per case, what every symbol was called
  with and what it answered, with a raise recorded as an answer rather than a
  failed run. The values were always in the capture; the report was throwing
  them away.

- **A refusal now has to say why.** An agent that judges a dead section
  undrivable must give a reason, which is shown as the reason. A refusal without
  one no longer wears the "not drivable" badge — it leaves no driver and no
  trace, so there is nothing to weigh, and it is marked as an unanswered ask
  worth re-running. Sections that nothing calls are also no longer told to go
  looking for an existing caller: for those, having no caller is the premise.

- **CLI, worker and script runs are counted in the Traces panel.** Only HTTP
  routes ever had a hit count, so a traced `python -m handbook.cli generate`
  showed its commands at zero forever while the capture plainly held their
  calls. Non-HTTP entry points are now counted from the captures directly, and
  every cell says which unit it shows — requests for a route, invocations for
  everything else.

### 🐛 Fixed

- **"Address already in use" no longer reads as a broken service.** A port left
  held by an earlier run is now reclaimed before anything tries to bind it —
  the Run button, the episode-loop replay oracle, and bring-up's own replay
  gate all identify the holding process, kill it, and wait for the socket to
  close. When the holder cannot be freed, the message names the pid and offers
  a free port instead of failing silently. Bring-up and fix-episode prompts now
  carry the same two remedies (kill a stale copy of this service, or move the
  service to a free port and record it consistently). Set
  `VINV_RECLAIM_PORTS=0` to keep the diagnosis and skip the killing.

- **The Traces panel could stay empty on a repo full of entry points.** "No
  traced endpoints match" against an inventory holding 115 of them, 45 of them
  CLI commands: the list was loaded once when the panel opened and the refresh
  only ever updated counts, so a panel opened before discovery finished stayed
  blank until it was reopened — and the refresh bailed out entirely when no
  captures existed, which is exactly the state that needed the retry.

- **A slow import is no longer reported as a hung call.** Running a function
  worker under the tracer charged the tracer's own startup — importing
  OpenTelemetry, installing the import hook, opening the capture — to the
  module's time allowance, so a package that is merely slow to import came back
  as `ModuleTimeout`: a candidate deadlock, and a defect that was never there.
  Tracer startup is charged to the harness that asked for it.

## [0.2.1] — 2026-07-31

### 🐛 Fixed

- **Ask Vinv answered without reading your code.** While the embedder loaded its
  model — minutes, on CPU — every question came back as plain prose with no
  citations, because code search was failing and the answer pipeline treated
  that as "found nothing" rather than "could not look". The model was handed a
  context section containing no code at all, and its answer looked like any
  other. Retrieval now survives the warm-up, and a question that genuinely
  cannot be grounded says so instead of being answered anyway.

## [0.2.0] — 2026-07-31

### ✨ Added

- **Dead code is a finding, not a filter.** It now arrives in Findings as
  *sections* — connected islands of untraced symbols with the live callers that
  still reference them, a stable identity across reindexes, and a report tab
  where your coding agent explains what each section does, why it is dead, and
  what deleting it would risk.
- **"Run this Path".** Vinv generates a driver for a dead section, runs it under
  tracelens with your recorded configuration, and reports whether the section
  actually executed — counted from the trace, not inferred.
- **Every running service is exercised.** A workspace with an API, a worker and
  an admin backend no longer has two of them silently skipped; findings and
  coverage from all live targets are merged.
- **`relevant_to` MCP tool**, so your coding agent can ask what else a symbol
  implicates.

### 🔧 Changed

- **Every bounded selection states its bound as a chain**, so an earlier,
  unmentioned cap can no longer hide behind a later "6 of 11".
- The **Flow rail is four stages**, and findings say which service they came
  from.
- The **tracelens HTML report** follows the Vinv design system.

### 🐛 Fixed

- **Verification verdicts could come back empty** in any Vinv-registered
  workspace — one-shot dispatches hung loading Vinv's own MCP servers, and the
  null verdict looked like an answer.
- **A saved driver never produced a trace on Windows.** Recorded start commands
  are now normalized before replay.
- **Containment says "unknown" when the evidence is ambiguous**, instead of
  inventing an outcome that could mark a real exception as handled.
- **Unverified inferences are no longer reported as findings**, and blocked time
  is not counted toward a speedup that cannot be delivered.
- **Bring-up on Windows:** stop actually stops, ports are probed by binding, and
  a discovered launch command is re-verified after repair.
- **The right capture is overlaid** when selecting a trace.

## [0.1.5] — 2026-07-30

### ✨ Added

- **Start and stop each service from its row** in the flow view.
- **A Findings button in the toolbar**, and a compass that walks the actual
  pipeline rungs.
- **Your coding agent can report a test run back to Vinv** through the new
  `vinv-exercise` MCP server — the agent exercises your service, Vinv grades what
  came back.
- **The exerciser asks instead of failing quietly.** Configuration nothing can
  synthesise — a real API key, a base URL only you know — escalates to you in a
  panel, and the run is re-driven once you answer.
- **A provider-backed path runs without a key.** HTTP is substituted at the
  boundary, so code that calls an LLM or paid API is exercised on a stand-in.
- **Interpreter and virtual-env discovery is structural**, so Vinv finds the
  environment your project actually uses.
- **Notices for broken releases and security fixes.** Read from a static file at
  `notices.vinv.ai`, at most once every 12 hours, sending no data and no
  identifiers. Turn it off with `vinv.notices.enabled`.
- **Inbound HTTP spans are named `METHOD /path`**, and tracelens warns when an
  installed library has no instrumenter.

### 🐛 Fixed

- **A recorded start command could not be replayed on Windows** — unresolvable
  bare commands, a rejected interpreter path, and unescaped backslashes each
  broke the Run button there and nowhere else.
- **Bring-up now instruments your own libraries**, not just the web framework, so
  traces cover the code under the request path.
- **One embedder sidecar serves every workspace again**, instead of racing during
  startup.
- **A fix episode can no longer "fix" a start failure by deleting tracelens.**
- **Blocked time is no longer counted as recoverable** in optimization estimates.
- **Probes start the target service** instead of skipping the pass.
- **Claude Code workspace keys** are registered under every spelling, so the MCP
  servers attach to the workspace you opened.
- **An engines pin bump takes effect within a version**, rather than only the
  first move.

## [0.1.4] — 2026-07-28

### ✨ Added

- **Five more oracles now reach you.** The crash, differential, fault,
  concurrency and environment oracles were finding things that never surfaced;
  every runner now publishes into the findings your panel and coding agent read,
  each pointing at the artifact holding its evidence.

### 🐛 Fixed

Driven against a real 18-module repository: calls **57 → 117**, issue clusters
**20 → 1**, fabricated findings **18 → 0**.

- **18 of 20 findings were fabricated, on Windows only** — a containment shim
  broke `asyncio` imports and blamed your repo.
- **Modern type annotations crashed discovery**, so no oracles armed at all on
  any repository using current typing.
- **`argparse` entry points were all false positives** — a documented `exit 2` is
  control flow, not a crash.
- **Slow imports were reported as hangs.** The call budget now starts when the
  import finishes.
- **The learner formed preferences it had never measured.** Plays that never
  reached the target are excluded instead of rewarded.

## [0.1.3] — 2026-07-28

### 🐛 Fixed

The engines pin introduced in 0.1.2 never fired on real installs:

- **The update refused to touch the checkout it owns** — Vinv's own install
  modified it, which disqualified it every time. `~/.vinv/engines` is now forced
  onto the pin; a checkout you point at with `vinv.enginesPath` is still never
  modified.
- **The checkout would have failed anyway**, aborting on local changes.
- **A machine with no engines installed nothing** — they now arrive automatically
  at the pinned version.
- **A checkout on the right commit was assumed ready**, even with an environment
  built for a different one.

Also: an in-place fix can no longer be swallowed by its predecessor, so a fix
shipped without a version bump still runs on the installs that need it.

## [0.1.2] — 2026-07-28

### ✨ Added

- **The exerciser drives your functions, not just your HTTP surface.** A
  function-level harness runs entry points and exported functions in-process, so
  a project with no web API is no longer a blank run — and route discovery now
  sees declarative route tables and argparse CLIs, not just decorators.
- **Nothing has to be running.** Targets that assume Postgres, Redis or S3 are
  served by stand-ins built on the standards, with schema recovered from your
  repo's own metadata first.
- **Containment is enforced at the OS layer, and is the default.** Vinv picks the
  strongest wall the host actually enforces; `--no-sandbox` is the opt-out.
- **New oracles:** differential, concurrency, environment, exception policy, and
  fault injection.
- **Child processes are traced too**, with their spans merged back into one
  trace.
- **Engines are pinned to the build that drives them**, so an extension version
  and an engine commit are a reproducible pair. `vinv.engines.autoUpdate` chooses
  auto / prompt / never.

### 🐛 Fixed

An adversarial pre-production audit found 64 shipping defects; they are fixed
here.

- **Big repos no longer hang.** Planning deadlocked past roughly 44 endpoints and
  died at the 3-minute timeout — it worked on a demo and failed on every real
  service.
- **Credentials stay out of your repo and off the wire.** Response bodies were
  persisted verbatim (writing bearer tokens and plaintext passwords into
  `.vinv/`) and spliced into path params. Bodies are now redacted and only
  id-shaped values reach path params.
- **Far fewer false positives** — `NaN`-poisoned bounds, a confidence gate that
  could not reject anything, a constant-compared size relation, a collapsed
  credential axis, and a drift filter that suppressed real regressions.
- **Authenticated flows are actually exercised.** Form-encoded logins were
  JSON-encoded and `422`'d forever, and document-level OpenAPI `security` was
  ignored, which made a protected API look public.
- **Branch coverage rewards both arms** on Python 3.12/3.13.
- **Distinct failures stay distinct** — `500`/`502`/`503` on one path no longer
  collapse into one cluster.
- **Windows safety restored.** Without a real OS wall, impure targets stay
  refused rather than running behind a shim that cannot stop them.
- **The "Vinv is now open source" notice shows again on fresh installs.**
- **A target printing an emoji no longer kills the run on Windows**, workers
  stream so a hang doesn't discard completed rows, and the sandbox tree is really
  removed.

## [0.1.1] — 2026-07-26

### ✨ Added

- **Auto-measure on accept.** Accepting an optimization Vinv could not verify
  automatically now re-traces the flow and computes the real before/after itself.
  (#39)

### 🐛 Fixed

- **Trustworthy optimization verdicts.** A disputed opportunity ends as
  **Dismissed** instead of lingering "in progress", **Proven** / **Regressed**
  requires a fix that actually landed in your working tree, and memory candidates
  read in bytes rather than milliseconds. (#39)

## [0.1.0] — 2026-07-26

- **First public open-source release.** No functional changes since 0.0.13.

## [0.0.12] — 2026-07-26

### ✨ Added

- **Trace-diff verdict — proof from the run, not a promise.** Optimization fixes
  are judged by re-tracing the flow and comparing before/after traces, so a
  predicted saving only becomes proven once the run shows it.
- **Memory as a first-class dimension.** Leak suspects across sessions
  (**Analyze Memory Trends**) and duplicate-recomputation cache opportunities
  (**Analyze Cache Opportunities**), each with a fix playbook for your agent.
- **More latency detectors** — GC pauses, unexplained wait, and throughput
  ceiling.
- **Opportunity board** with a full lifecycle: eviction, hang retrial,
  exhaustion, dispatch dedup across restarts, and calibrated ranking.

### 🔧 Changed

- **Auto-Pilot budgets are configurable**, and running out asks how to proceed
  rather than silently stopping.
- **Honest tracing overhead.** Tracelens self-calibrates its observer effect, so
  measured times reflect your code, not the tracer.

### 🐛 Fixed

- **Optimize verdicts are clamped to reality** — predictions are capped to the
  newest session's measured ceiling.
- **Redundant "Measure now" button removed** from the Optimize panel.

## [0.0.11] — 2026-07-25

### ✨ Added

- **Optimize panel — recoverable time, predicted → proven.** A custom editor
  showing where time is recoverable across your traced flows, walking each
  hotspot through dispatch, re-measure and confirm.

## [0.0.10] — 2026-07-25

### 🐛 Fixed

- **The "Vinv is now open source" notice shows again on fresh installs.**

## [0.0.9] — 2026-07-25

### ✨ Added

- **Behavior exerciser.** Vinv no longer waits for traffic — it drives **every
  discovered endpoint itself** with schema-derived valid/boundary/negative
  inputs and multi-step auth scenarios, banking every response as a permanent
  regression case.
- **Journey view.** One walkthrough of everything verified — each endpoint's call
  tree, latency flamegraph, and exact inputs → outputs, plus a form to add your
  own test inputs that replay forever after.
- **Findings view.** What Vinv found and fixed, with the statistical evidence,
  and a machine-readable `findings.json` your agent can consume directly.

### 🐛 Fixed

- **Correct 4xx responses are no longer treated as defects**, so the agent is
  never handed the unfixable goal of fixing code that works.
- **Silent-but-working runs are no longer killed** — a long legitimate silence
  (auth, model spin-up) isn't mistaken for a hang.

## [0.0.8] — 2026-07-24

### 🚀 Improved

- **Trace any target venv with zero installs**, even one with neither tracelens
  nor OpenTelemetry.
- **Agent CLI problems surface immediately** — not signed in, out of quota, or
  unreachable now stops with the exact fix instead of burning fix budget.

### 🐛 Fixed

- **Webview buttons never fail silently.** Every panel action verifies the target
  file and raises an actionable error instead of doing nothing.
- **Tracing works on Python 3.14**, where no spans were previously written.

## [0.0.7] — 2026-07-24

- **Relicensed to the Apache License 2.0.**

## [0.0.6] — 2026-07-23

### 🎉 Vinv is now open source

Free and open source under the Apache License 2.0 — everything runs on your
machine, with no account, no API keys, and no telemetry.

### 🐛 Fixed

- **"Install Vinv Engines" now works on Windows**, where PowerShell rejected the
  POSIX `&&` and the install never started.

## [0.0.5] — 2026-07-23

### 🚀 Improved

- **Exhaustive service discovery** — project manifests are mined, stdio and
  scheduler services are recognized, and non-port services are verified with
  replay probes.
- **Sharper learning loop**, with golden input/output baselines and honest
  memory-field reporting behind verification verdicts.

## [0.0.4] — 2026-07-22

### 🐛 Fixed

- **Ask Vinv is clickable again.** A syntax error in the panel's markup left
  every control — Ask, sessions, feedback chips, dispatch, citation links, and
  Enter in the question box — completely dead.

## [0.0.3] — 2026-07-22

### 🐛 Fixed

- **Claude Code no longer crashes on startup after MCP registration**, and
  entries broken by earlier versions are repaired automatically.

## [0.0.1] — 2026-07-14

### 🚀 Hello, world — VinvAI is here!

Welcome, everybody! This is our very first public release, and we're thrilled
to have you along for the ride.

Thanks for trying it on day one. This is just the beginning — tell us what you
want next at [support@vinv.ai](mailto:support@vinv.ai). 💜

**Found a bug or have an idea?** Raise it on our public feedback tracker at
[VinvAI/feedback](https://github.com/VinvAI/feedback) — bug reports, feature
requests, and support questions all welcome.
