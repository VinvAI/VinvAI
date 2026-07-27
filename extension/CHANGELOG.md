# Change Log

All notable changes to the **Vinv** extension are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [0.1.2] — 2026-07-28

### ✨ Added

- **The exerciser drives your functions, not just your HTTP surface.** A
  function-level harness runs entry points and exported functions in-process,
  so a project with no web API is no longer a blank run. Route discovery gained
  an AST extractor for declarative route tables (plain Starlette `Route`/`Mount`,
  `APIRouter(routes=[...])`, aiohttp, tornado) and for argparse CLIs — these were
  invisible to the decorator-shaped patterns, which made a real repo look like a
  clean zero-endpoint run. An empty inventory is now loudly diagnosed instead of
  passing silently.
- **Nothing has to be running.** A target that assumes Postgres, Redis, or S3 is
  now served by stand-ins built on the standards rather than the wire protocols —
  one PEP 249 adapter covers every conforming driver, SQLAlchemy URLs are
  rewritten, and schema is recovered from the repo's own metadata and DDL first,
  then induced from the database's own errors. Previously those calls simply
  failed to connect and were never exercised.
- **Containment is enforced at the OS layer, and it is the default route.** Vinv
  probes what the host actually enforces (sandbox-exec on macOS, bwrap or unshare
  on Linux) and picks the strongest wall, instead of relying on a Python-level
  shim that a C extension could walk straight through. Verified-pure code runs
  in-process; anything unverifiable or impure is contained automatically;
  `--no-sandbox` is the opt-out.
- **New oracles.** Differential (evaluators compared against their reference
  implementation, over a researched 378-case corpus), concurrency, environment
  (upstream signature drift and the dependency-resolution matrix), exception
  policy, and fault injection with adversarial-but-legal boundary shapes.
- **Child processes are traced too.** A `sitecustomize` bootstrap follows the run
  into its children and merges the sidecar spans back into one trace.
- **Engines are pinned to the build that drives them.** Each release stamps the
  engines commit it was cut against, so an extension version and an engine commit
  are a reproducible pair rather than a frozen client talking to a moving server.
  When the checkout has drifted, the update is offered once per extension version
  — the new `vinv.engines.autoUpdate` setting chooses auto / prompt / never, and a
  checkout you point at yourself with `vinv.enginesPath` is never touched.

### 🐛 Fixed

An adversarial pre-production audit found 64 shipping defects; they are fixed
here, with ~290 new tests weighted toward proving what must *not* be flagged.

- **Big repos no longer hang.** The exercise runner never drained the child's
  stdout, so planning deadlocked on any repo past roughly 44 endpoints and was
  killed at the 3-minute timeout — it worked on a demo and failed on every real
  service. Killing a run also orphaned the Python child mid-probe, and a crashed
  step silently reported the *previous* pass's numbers as this pass's success.
- **Credentials stay out of your repo and off the wire.** Response bodies were
  persisted verbatim, so a login `200` wrote its bearer token and plaintext
  password into `.vinv/`. Harvested scalars were also spliced into path params,
  issuing requests like `DELETE /users/<jwt>` and leaking the token into the
  target's access log. Bodies are redacted (shape and types preserved) and only
  id-shaped values reach path params.
- **Far fewer false positives.** `NaN` poisoned numeric bounds three ways
  (including making `invariants.json` unparseable); the confidence gate could not
  reject anything and is replaced with Daikon's statistical justification test;
  a size relation was checked against a constant, so it fired on every replay;
  the credential axis collapsed every identity onto one probe id, producing a
  permanent self-inflicted "regression"; and the drift filter was suppressing
  real regressions.
- **Authenticated flows are actually exercised.** Form-encoded endpoints
  (FastAPI's OAuth2 password login) were JSON-encoded and `422`'d forever, so the
  whole authenticated pass was skipped for want of a token, and document-level
  OpenAPI `security` was ignored, which made a fully protected API look public.
- **Branch coverage rewards both arms.** On Python 3.12/3.13 only one arm per
  conditional was recorded, so flipping a condition earned no reward — removing
  the exploration gradient the feature exists for.
- **Distinct failures stay distinct.** `500`/`502`/`503` on one path collapsed
  into a single cluster, so one fix episode was dispatched against a
  mischaracterised failure.
- **Windows safety restored.** Containment had been defaulted on where no OS
  mechanism exists, so previously-refused impure targets started executing behind
  a shim that cannot stop them. Without a real OS wall they stay refused.
- **The "Vinv is now open source" notice shows again on fresh installs.** Its
  one-time marker was being packaged into the vsix — the sibling markers were
  excluded but this one was not — so every new install started out already
  marked as notified. Same symptom as the 0.0.10 fix, reached by a different
  route.
- **Operational fixes.** Worker pipes are explicitly UTF-8 both directions (a
  target printing an emoji used to kill the run on Windows), workers stream
  instead of batching so a hang no longer discards completed rows, and the
  sandbox tree is really removed rather than reported as removed.

### 🔧 Maintenance

- **RL loop redesign.** The action space is richer, the bandit is rewarded for
  oracle violations rather than coverage (new coverage keeps a small bonus), each
  defect is credited once, and the defect/refusal boundary is learned instead of
  hardcoded against exception names.
- **One agent channel**, asked once, cached forever, and budgeted.
- One shared cluster builder replaces five drifting copies; ~50 lines of dead
  code removed; the repo-wide ruff debt is cleared.
- Docs: both READMEs now lead with what Vinv does to agent-written code, with the
  loop diagram served from the image CDN, and four claims corrected against the
  code.
- CI no longer requires an OS containment wall by default, and a host-shaped
  assertion is unpinned.

## [0.1.1] — 2026-07-26

### 🐛 Fixed

- **Trustworthy optimization verdicts.** The Optimize panel no longer shows
  misleading outcomes. A disputed opportunity now ends with a clear
  **Dismissed — not a real opportunity** marker (verdict badge + a "Dismissed"
  tile) instead of lingering as "in progress." The session-timing watcher only
  reports **Proven** / **Regressed** when a fix actually landed in your working
  tree — verified by a dispatch-time diff signature that also recognizes fixes in
  a symbol's **callee** files — so ordinary run-to-run variance (e.g. a cold vs
  warm connection) can no longer be mistaken for a real speedup. Byte-unit
  (memory) candidates now read in bytes, not milliseconds. (#39)
- **tracelens:** `build_metrics` now emits an explicit ISO-8601 timestamp format.

### ✨ Added

- **Auto-measure on accept.** When you accept an optimization that vinv could not
  verify automatically, it now re-traces the flow to compute the real
  before/after itself, instead of waiting for a manual **Measure Optimization**
  click. (#39)

### 🔧 Maintenance

- Pinned the uv workspace to Python 3.13 and made `requires-python` consistent
  across the engine packages; added `[project.urls]` metadata. (#16, #17)
- Docs: a README FAQ plus editors/agents and license entries, a `tests/README`,
  a `CITATION.cff`, a Windows-interpreter note in the planted-bug e2e README, and
  removal of two stale ADRs. (#18, #19, #20, #21, #38)
- Dropped a flaky wall-clock timing assertion in the tracelens tests. (#37)

## [0.1.0] — 2026-07-26

### Changed

- First public open-source release. Refreshed the marketplace listing and product
  description — "The RL loop that makes your coding agents smarter and their
  written code production-ready." No functional changes to the extension since
  0.0.13.

## [0.0.13] — 2026-07-26

### Changed

- Repository and documentation polish ahead of the open-source release: GitHub
  issue templates, sidebar links, and README badges. No functional changes to
  the extension.

## [0.0.12] — 2026-07-26

### ✨ Added

- **Trace-diff verdict — proof from the run, not a promise.** Optimization
  fixes are now judged by re-tracing the flow and comparing the before/after
  traces directly: the verdict measures the actual recovered time on the failed
  flow, from the trace itself, and feeds it into the dispatch fallback so a
  "predicted" saving only becomes "proven" once the run shows it.
- **Memory as a first-class dimension.** Vinv now detects and surfaces memory
  waste in bytes alongside latency — leak suspects across sessions
  (**Analyze Memory Trends**) and duplicate-recomputation cache opportunities
  (**Analyze Cache Opportunities**), each with a per-kind fix playbook shipped
  to your agent.
- **More latency detectors.** GC pauses are now attributed as a latency source,
  and new "unexplained wait" and "throughput ceiling" waste kinds are detected
  and dispatched.
- **Opportunity board.** A single detection path with cross-restart dispatch
  dedup and a full lifecycle — eviction, hang retrial, and exhaustion — plus
  outcome events, attempt lineage, doom-loop memory, and calibrated ranking that
  trains the bandit from real optimization verdicts.

### 🔧 Changed

- **Auto-Pilot budgets are configurable, and running out asks instead of
  quitting.** When the episode budget is exhausted, Vinv now pauses and asks how
  to proceed rather than silently stopping.
- **Honest tracing overhead.** Tracelens self-calibrates its observer effect,
  keeps enrichment out of the timed window, records `blocked_ms`, and ships a
  latency-honest standard preset — so measured times reflect your code, not the
  tracer.
- **Trace-primary coverage.** Coverage now joins on the trace first and survives
  legacy rows and display-form handler names; live report mirrors and
  history-derived probe deadlines make verdicts steadier.

### 🐛 Fixed

- **Optimize verdicts are clamped to reality.** Every waste signal's prediction
  is capped to the newest session's measured ceiling, the request span forest is
  rebuilt structurally rather than by line order, and the cache detector gained a
  None-return gate, observed-dependence check, and a structural security guard.
- **Redundant "Measure now" button removed** from the Optimize panel — measuring
  is part of the verdict flow.
- **Flaky device-tune test stabilized.** The embedder auto-tune test compared
  real wall-clock throughput with too small a margin and failed intermittently on
  CI's Apple-Silicon runners; the margin is now wide enough to be
  jitter-proof.

## [0.0.11] — 2026-07-25

### ✨ Added

- **Optimize panel — recoverable time, predicted → proven.** A new custom editor
  over `optimization.json` shows where time is recoverable across your traced
  flows and walks each hotspot through the predicted→proven loop: dispatch a fix
  to your coding agent, re-measure, and confirm the saving.

### 🔧 Changed

- **Marketplace listing corrected.** The README now states the real split (four
  bugs, one optimization), drops dead badges while restoring the download count,
  and points at Open VSX.

## [0.0.10] — 2026-07-25

### 🔧 Changed

- **Marketplace listing refreshed.** New description and keywords around the
  runtime-context / "context bandits" / doom-loop framing for discoverability.
  Extension behavior is unchanged.

### 🐛 Fixed

- **The "Vinv is now open source" notice shows again on fresh installs.** Its
  one-time marker had been committed to the repo, which suppressed the notice
  for every new checkout; the marker is now written only at runtime, as intended.

## [0.0.9] — 2026-07-25

### ✨ Added

- **Behavior exerciser.** Vinv no longer waits for traffic — it drives **every
  discovered endpoint itself** with schema-derived valid/boundary/negative
  inputs, values mined from real traces, and multi-step auth scenarios, picking
  strategies with a coverage-rewarded Thompson-sampling bandit and banking every
  response as a permanent regression case.
- **Journey view.** One walkthrough of everything verified — every service, then
  each endpoint's call tree, latency flamegraph, and the exact inputs → outputs
  exercised, with a form to add your own test inputs that replay forever after.
- **Findings view.** What Vinv found and fixed, with the statistical evidence —
  issue clusters, optimization episodes with paired-bootstrap confidence
  intervals, regression diff kinds, and a machine-readable `findings.json` your
  agent can consume directly.

### 🐛 Fixed

- **Correct 4xx responses are no longer treated as defects.** Handlers that
  deliberately raise `HTTPException` with a 4xx status are normal control flow,
  not errors — they're excluded from the runtime-error clusters, so the agent is
  never handed the unfixable goal of "fixing" code that works.
- **Silent-but-working runs are no longer killed.** The watchdog gives the first
  output a startup grace period, and Python children run unbuffered, so a long
  legitimate silence (auth, model spin-up) isn't mistaken for a hang.

## [0.0.8] — 2026-07-24

### 🐛 Fixed

- **Webview buttons never fail silently.** Every panel action (Flow, Graph
  Explorer, Call Tree, Ask Vinv, and the judgment card) now resolves and
  verifies the target file before opening it, and raises an actionable error
  instead of doing nothing when a path is missing, relative, or moved.
- **Tracing works on Python 3.14.** The tracer set up its TracerProvider through
  OpenTelemetry's contrib loader, which imports the removed `pkg_resources` on
  3.14; the error was swallowed and no spans were ever written. Tracelens now
  configures its provider directly, so capture keeps working — and a missing
  core SDK produces one clear message instead of a traceback.

### 🚀 Improved

- **Trace any target venv with zero installs.** A service whose virtualenv has
  neither tracelens nor OpenTelemetry installed can now be traced without
  installing anything into it.
- **Agent CLI problems surface immediately.** When your coding-agent CLI isn't
  signed in, is out of quota, or can't reach its service, Vinv now stops right
  away with the exact fix to apply (for example, `cursor-agent login`) instead
  of burning retries and fix budget on attempts that cannot succeed.

## [0.0.7] — 2026-07-24

### Changed

- **Relicensed to the Apache License 2.0.** Vinv is now open source under Apache
  2.0 (previously the Elastic License 2.0).

## [0.0.6] — 2026-07-23

### 🎉 Vinv is now open source

Vinv is free and open source under the Apache License 2.0 — everything runs on your
machine, with no account, no API keys, and no telemetry.

- **Added** a one-time welcome notice announcing the open-source release, with
  quick links to star the repo on GitHub and open Get Started.

### 🐛 Fixed

- **"Install Vinv Engines" now works on Windows.** The install ran `git clone …
  && uv sync && cargo build …` in the terminal, but Windows PowerShell rejects
  `&&` ("The token '&&' is not a valid statement separator"), so the install
  never started. The command is now emitted in PowerShell-native syntax on
  Windows (POSIX `&&` elsewhere) and still stops at the first failed step.

## [0.0.5] — 2026-07-23

### 🚀 Improved

- **Exhaustive service discovery.** Enumeration now mines project manifests,
  recognizes stdio and scheduler service kinds (not just HTTP ports), and
  verifies non-port services with replay probes.
- **Sharper learning loop.** Golden input/output probe baselines and honest
  memory-field reporting make verification verdicts more trustworthy.

## [0.0.4] — 2026-07-22

### 🐛 Fixed

- **Ask Vinv is clickable again.** Every control in the panel — Ask, sessions,
  new session, the ▲/▼ feedback chips, dispatch to harness, citation links —
  did nothing when clicked. Two malformed escape sequences in the panel's
  generated markup left its script with a syntax error, so the browser refused
  to run any of it and no button was ever wired up. Pressing Enter in the
  question box was broken for the same reason. Both escapes are corrected and
  the panel is fully interactive again.

## [0.0.3] — 2026-07-22

### 🐛 Fixed

- **Claude Code no longer crashes on startup after MCP registration.** On
  machines where the workspace had never been opened in Claude Code, the
  extension created a project entry in `~/.claude.json` without the
  `allowedTools` field, which made every `claude` launch fail with
  `TypeError: B.allowedTools is not iterable`. The entry is now created with
  `allowedTools: []`, and entries broken by earlier versions are repaired
  automatically the next time the extension registers its servers.

## [0.0.1] — 2026-07-14

### 🚀 Hello, world — VinvAI is here!

Welcome, everybody! This is our very first public release, and we're thrilled
to have you along for the ride.

Thanks for trying it on day one. This is just the beginning — tell us what you
want next at [support@vinv.ai](mailto:support@vinv.ai). 💜

**Found a bug or have an idea?** Raise it on our public feedback tracker at
[VinvAI/feedback](https://github.com/VinvAI/feedback) — bug reports, feature
requests, and support questions all welcome.
