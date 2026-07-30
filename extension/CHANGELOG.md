# Change Log

All notable changes to the **Vinv** extension are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-07-31

### ✨ Added

- **Dead code is a finding you can act on, not a filter on the graph.** The old
  Dead Code button could say *where* untraced nodes were and nothing else. Dead
  code now arrives in Findings as **sections** — connected islands of untraced
  symbols, not lint rows — each with the live callers that still reference it,
  a stable identity that survives a reindex, and its own report tab with a
  stop-by-stop walkthrough over the stored source the ranking actually
  describes. Your coding agent answers what each section does, why it is dead,
  how it would integrate, and what the risk is; sections are asked in batches so
  the bill does not grow one run per section, and a section the agent never
  answered keeps **no** verdict rather than a fabricated "probably safe to
  delete".
- **"Run this Path" — prove a dead section executable, or prove it is not.**
  Analysis asks what code *is*; this asks the one thing analysis cannot settle.
  The harness writes a Python driver for the section, Vinv runs it under
  tracelens with your workspace's own recorded configuration, and the capture
  lands where every scan already looks. The verdict is **counted, not inferred**:
  a green run that never reached the section reports "not reached", and a run
  that raised but did reach it reports the section revived. When there is no
  driver, the reason is now specific — the harness never answered, the agent
  judged the section undrivable, or the reply did not parse — each with the
  transcript path to read.
- **Every running service gets exercised.** Target selection returned one
  service, so a workspace running an API, a worker and an admin backend had two
  of the three silently unexercised behind a confident clean scorecard. All live
  targets are now driven, with each service's findings and coverage folded into
  the union before the next service overwrites them, and a service that fails to
  run no longer discards its siblings' results.
- **`relevant_to` for coding agents.** The relevance walk that powers Vinv's own
  context is exposed as an MCP tool, so your agent can ask what else is
  implicated by a symbol — and gets back what the walk reached, what it returned,
  and what stopped it.

### 🔁 Changed

- **Every bounded selection now states its bound, and states it as a chain.** A
  panel reporting "6 of 11" while an earlier, unmentioned cap had already removed
  20 is the failure this closes. Selections carry a lineage from the source
  population through every stage that dropped something, each residual carrying
  magnitude as well as count, and a cap anywhere makes the whole chain say so.
  The Optimize report was the last surface printing a bare count; it now renders
  the bound like the MCP tools and Ask Vinv already did.
- **The Flow rail is four stages**, findings are attributed to the service they
  came from, and the compass no longer offers an "Install Vinv engines" rung —
  the startup pin check already does that job, and does it knowing which commit
  this build needs.
- **The tracelens HTML report** follows the Vinv design system.
- **Vinv is described as what it is:** an autonomous swarm of nine oracles that
  finds bugs, dead code and performance problems and proves every fix. Both
  READMEs and the marketplace listing were rewritten around the named roster.

### 🐛 Fixed

- **Every verification verdict in a Vinv-registered workspace could come back
  empty.** One-shot dispatches — the audit judge, test authors, stall judge,
  driver authoring — loaded the workspace's MCP servers, including the three
  Vinv registers itself. A 61-byte prompt produced zero output in 240 seconds,
  the dispatch cap expired, and the null verdict looked like an answer. Those
  dispatches now run with an empty MCP config. Fix episodes keep their servers:
  an agent that is editing your code genuinely wants them.
- **A driver that was written, saved and ready to run never produced a trace.**
  Bring-up records the command it verified *in a shell*, so it routinely begins
  `PATH="…/.venv/Scripts:$PATH"` and names `/c/…` paths. Vinv now peels the
  environment prefix off, resolves it against the live environment, and rewrites
  Git-Bash path spellings the OS cannot open.
- **Containment says "unknown" when the evidence is ambiguous.** A component that
  ran more than once in one request had no single exit outcome, and two code
  paths were each quietly inventing a different one — which could mark a real,
  propagating exception as handled and stop any fix from ever being dispatched
  for it.
- **The engine stops reporting unverified inferences as findings**, the UI says
  what the evidence actually supports, and blocked time is no longer counted
  toward a speedup that cannot be delivered.
- **Bring-up on Windows.** A stop path that actually stops, probing by binding
  rather than by guess, `taskkill` spelled the way Git Bash needs, the entrypoint
  package derived in the engine instead of only the extension, tracelens targets
  no longer deleted when the tracer accepts them, a discovered launch command
  passed through and re-verified after repair, and requests counted once.
- **The right capture is overlaid.** Trace selection reads every capture for a
  repo-wide summary, passes the capture service on the poll that rewrites the
  snapshot, and lets probes run at all.
- **The extension suite no longer fails on load rather than on defect** — an
  I/O-bound suite was tripping Mocha's 2 s default under full-suite load on
  Windows, failing a different test each run — and the extension host now starts
  on a headless Linux CI runner.

## [0.1.5] — 2026-07-30

### ✨ Added

- **Start and stop each service from the row itself.** The flow view gained a
  play/stop control per service, so bringing one up no longer means finding the
  right command in a terminal.
- **A Findings button in the toolbar**, and a compass that walks the actual
  pipeline rungs instead of parking on "Enhance the graph".
- **Your coding agent can report a test run back to Vinv** through the new
  `vinv-exercise` MCP server, which closes the endpoint-testing loop: the agent
  exercises your service and Vinv grades what came back.
- **The exerciser asks when it genuinely cannot proceed, instead of failing
  quietly.** Configuration nothing can synthesise — a real API key, a base URL
  only you know — now escalates: first to the harness, and then to you in a
  panel, with the run re-driven once the answers arrive. The engine's agent
  channels are dispatched and drained, which was the missing half of that
  contract, and the panel shows the engine's actual verdict rather than only a
  cluster count.
- **A provider-backed path runs without a key.** HTTP is substituted at the
  boundary, so code that calls an LLM or a paid API is exercised on a stand-in
  instead of being skipped.
- **Interpreter and virtual-env discovery is structural, not name-based.** Vinv
  finds the environment your project actually uses — including layouts the old
  name whitelist missed — and honours a declared working directory when running
  your code.
- **Notices for broken releases and security fixes.** If a release breaks your
  install, nothing inside it can tell you — so the extension now reads a static
  file at `notices.vinv.ai` on startup and may show one message. It sends no data
  and no identifiers, checks at most once every 12 hours, and goes quiet when the
  endpoint is unreachable. Turn it off with `vinv.notices.enabled`.
- **Inbound HTTP spans are named `METHOD /path`**, and tracelens now warns when a
  library you have installed has no instrumenter, instead of silently capturing
  nothing for it.

### 🐛 Fixed

- **A recorded start command could not be replayed on Windows.** Bring-up writes
  the verified command to `.vinv/start_commands/<service>.json`, and the Run
  button replays that string through `bash -lc` in a fresh shell. Three separate
  defects made it fail there and nowhere else — and because the file lives
  outside your repo, no later fix pass could repair it:
  - a bare `tracelens` / `python` resolved only in the agent's own activated
    shell, so replay died with `exit 127 command not found`;
  - the interpreter was recorded as `<venv>/Scripts/python`, which tracelens
    rejected as missing — a Windows venv ships only `python.exe`, and the check
    was stricter than the launch, which appends the extension itself;
  - paths were written with single backslashes, which are not valid JSON escapes
    (so the file did not parse) and are eaten by bash (so `--output` pointed at a
    relative path and the trace landed where nothing reads it — an empty baseline
    with no error to explain it).
- **Bring-up instrumented the web framework but not your own libraries**, so
  traces covered the request path and missed the code under it. It now bootstraps
  the instrumenters for the service's own dependencies too.
- **One embedder sidecar can serve everyone again** — it binds its port before
  loading the model, so a second workspace no longer races it during startup.
- **A service-fix episode could "fix" a start failure by deleting tracelens.**
  That path is closed: the wrapper is not a candidate for removal.
- **Blocked time is no longer counted as recoverable** in optimization estimates,
  so a function that spends its time waiting is not reported as a speedup
  opportunity it cannot deliver.
- **Probes start the target service** instead of skipping the pass when it is not
  already up.
- **Claude Code workspace keys** are registered under every spelling the
  projects map uses, so the MCP servers attach to the workspace you actually
  opened.
- **An engines pin bump now takes effect within a version.** The "already
  settled" marker was keyed on the extension version alone, so the second and
  later pin moves inside one version were silently ignored and the checkout stayed
  wherever it was. It is keyed on the ref as well.

### 🔧 Maintenance

- Each harness trigger runs in its own git worktree rather than taking a lock, so
  two triggers no longer serialize behind each other.
- Insights is no longer a scheduled pipeline stage in either flow, and the
  Services and Sessions trees are gone from the sidebar — the flow view covers
  both.

## [0.1.4] — 2026-07-28

### ✨ Added

- **Five more oracles now reach you.** Vinv's crash, differential, fault,
  concurrency and environment oracles were running and finding things, but each
  wrote its own artifact while the panel and your coding agent read only one
  (`issues.json`) — so their results went nowhere. Every runner now publishes its
  clusters into that file, deduped, and the exercise pass gained the campaign
  step that drives them. Each finding also points at the artifact holding its
  evidence, instead of at the HTTP oracle's file regardless of kind.

### 🐛 Fixed

Driven against a real 18-module repository rather than the suite's own small,
cleanly-typed fixtures, the harness broke in five ways that no fixture could
reach. On that repository: calls **57 → 117**, issue clusters **20 → 1**,
fabricated findings **18 → 0**, and the one survivor is a genuine bug.

- **18 of 20 findings were fabricated, on Windows only.** The containment shim
  replaced `subprocess.Popen` — a class — with a function, so any module doing
  `class Popen(subprocess.Popen)` failed at import with a `TypeError` from the
  standard library. `asyncio` does exactly that, so every module that imports it
  failed, and each failure was reported as an import-error defect *in your repo*.
- **Modern type annotations crashed discovery.** A nested union such as
  `list[Step | None]` recursed forever, so no actions armed at all and the run
  reported "oracles unavailable" — on any repository with current typing.
- **`argparse` entry points were all false positives.** `SystemExit` was
  classified as a crash, but `ArgumentParser.error` is documented to exit 2. A
  `BaseException` that is not an `Exception` is a control-flow signal, not a
  correctness claim.
- **Slow imports were reported as hangs.** Import cost and call cost shared one
  30-second deadline, so a module that takes 27 seconds to import cold was killed
  mid-import and recorded as "a call hung" for a call that never happened. The
  call budget now starts when the import finishes.
- **The learner formed preferences it had never measured.** Every play claimed
  coverage before doing any work, so a play whose worker never even imported the
  target still earned its exploration bonus and updated the model. Those plays
  are now inconclusive: billed, surfaced as a diagnostic, and excluded.

## [0.1.3] — 2026-07-28

### 🐛 Fixed

0.1.2 introduced the engines pin — each build knows the engines commit it was
cut against, and moves your checkout onto it. On real installs it never fired.
Four separate reasons, each of which alone was enough to stop it:

- **The update refused to touch the checkout it owns.** Any tracked
  modification made Vinv leave `~/.vinv/engines` alone and warn instead. But
  `uv sync` — which Vinv's own install runs — rewrites the tracked `uv.lock`, so
  every checkout disqualified itself the first time it was installed. That
  directory is an artifact directory the extension owns, not a working tree, and
  it is now forced onto the pin regardless of what is in it. A checkout you point
  at with `vinv.enginesPath`, or a monorepo you cloned yourself, is still never
  modified.
- **The checkout would have failed even without that guard.** It ran without
  `--force`, and `uv.lock` differs between almost any two pins, so git aborted
  with "local changes would be overwritten."
- **A machine with no engines installed nothing.** Activation returned before the
  update mode was even read, so the engines only ever arrived by clicking a
  button. Vinv now installs them itself when they are missing, cloning straight
  to the pinned version.
- **A checkout on the right commit was assumed ready.** The commit is not what
  makes the engines runnable — `uv sync` and `cargo build` are, and neither is
  implied by a checkout. A checkout moved by hand sat on the correct commit with
  an environment built for a different one. Vinv now re-syncs when the
  environment predates the checkout.

Also: an in-place fix can no longer be swallowed by its predecessor. The
"already handled this version" markers now record which logic wrote them, so a
fix shipped without a version bump still runs on the installs that need it.

### 🔧 Maintenance

- The engines-update default is documented as what it actually is (`auto`), and
  the update prompt now says it resets Vinv's own engines checkout.

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
  2.0.

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
