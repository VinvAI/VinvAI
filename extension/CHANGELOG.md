# Change Log

All notable changes to the **Vinv** extension are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

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
