# Change Log

User-facing changes to the **Vinv** extension. Internal refactors, docs, tests
and CI are not listed here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [0.2.5] — 2026-08-19

Maintenance only — no behaviour changes.

## [0.2.4] — 2026-08-02

Maintenance only — no behaviour changes.

## [0.2.3] — 2026-08-02

### ✨ Added

- **Dead Code** — identify dead code in your workspace using the AST, verify it's really dead via your agent, and compare the diff.
- **CLI & library driving** — a Run button for every CLI subcommand with an argument form, and drive exported library functions one at a time.

### 🔧 Changed

- **Sharper dead-code & indexing** — dead chains fold into one finding, and the index queue is trimmed by measured repo facts and adjudicated from shard files.

### 🐛 Fixed

- **Reliable unit runs** — stable ids keep a unit's history when you add invocations, and every recorded invocation is verified.

## [0.2.2] — 2026-07-31

### ✨ Added

- **Serverless tracing** — CLIs, libraries, workers, jobs and scripts are traced as first-class units, each with a call tree and report, no server needed.
- **Richer Traces panel** — per unit: kind, hits, coverage, latency, the ok/raised split and errors, with live status in the status bar.
- **Try-run traces** — every dead-section run records what executed and its values, and a refusal must give a reason.

### 🐛 Fixed

- **Steadier runs** — reclaims a held port, populates the panel as discovery finishes, and stops charging slow imports as hangs.

## [0.2.1] — 2026-07-31

### 🐛 Fixed

- **Grounded Ask Vinv** — retrieval survives the embedder warm-up, so answers cite your code instead of guessing.

## [0.2.0] — 2026-07-31

### ✨ Added

- **Dead-code sections** — untraced islands with their live callers and an agent explanation, plus "Run this Path" to check whether a section runs.
- **All services exercised** — findings and coverage merge across every live target, and a new `relevant_to` MCP tool asks what a symbol implicates.

### 🔧 Changed

- **Clearer surfaces** — bounds are stated as chains, the Flow rail is four stages, and the tracelens report follows the Vinv design system.

### 🐛 Fixed

- **Trustworthy verdicts** — no empty verdicts, honest containment, no unverified findings, and Windows bring-up and driver traces work.

## [0.1.5] — 2026-07-30

### ✨ Added

- **Service control & reporting** — start/stop each service from its row, a Findings toolbar, and a `vinv-exercise` MCP server your agent reports runs back to.
- **Runs without keys or setup** — a keyless provider path, structural env discovery, an exerciser that escalates missing config, and broken-release notices.

### 🐛 Fixed

- **Windows & tracing** — replayable start commands, your own libraries instrumented, one embedder sidecar, and no self-sabotaging fixes.

## [0.1.4] — 2026-07-28

### ✨ Added

- **Five oracles surface** — crash, differential, fault, concurrency and environment now publish findings.

### 🐛 Fixed

- **Fewer false findings** — no Windows fabrication, modern typing survives discovery, `argparse` exits aren't crashes, and slow imports aren't hangs.

## [0.1.3] — 2026-07-28

### 🐛 Fixed

- **Engine pin works** — it fires on real installs (`~/.vinv/engines`) and isn't assumed ready with a stale environment.

## [0.1.2] — 2026-07-28

### ✨ Added

- **Function-level exercising** — runs entry points and functions in-process, with Postgres/Redis/S3 stand-ins so nothing has to be running.
- **OS-enforced containment** — the strongest wall the host offers, on by default, with new oracles and child-process tracing.

### 🐛 Fixed

- **64 audit defects** — hangs, credential leakage, false positives, auth flows and Windows safety.

## [0.1.1] — 2026-07-26

### ✨ Added

- **Auto-measure on accept** — an unverifiable optimization is re-traced for the real before/after. (#39)

### 🐛 Fixed

- **Trustworthy verdicts** — "proven" requires a fix that actually landed. (#39)

## [0.1.0] — 2026-07-26

First public open-source release — no functional changes since 0.0.13.

## [0.0.12] — 2026-07-26

### ✨ Added

- **Memory & optimization** — trace-diff verdicts, leak suspects, cache opportunities, more latency detectors, and an opportunity board.

### 🔧 Changed

- **Honest measurement** — configurable Auto-Pilot budgets and self-calibrated tracing overhead.

### 🐛 Fixed

- **Realistic verdicts** — predictions clamped to the measured ceiling, and a redundant button removed.

## [0.0.11] — 2026-07-25

### ✨ Added

- **Optimize panel** — recoverable time across your flows, predicted → proven.

## [0.0.10] — 2026-07-25

### 🐛 Fixed

- **Open-source notice** — shows again on fresh installs.

## [0.0.9] — 2026-07-25

### ✨ Added

- **Exercise, Journey & Findings** — drive every endpoint, walk each one's call tree and inputs → outputs, and read what was found and fixed.

### 🐛 Fixed

- **Fewer false alarms** — correct 4xx aren't defects, and legitimate silence isn't a hang.

## [0.0.8] — 2026-07-24

### 🚀 Improved

- **Zero-install tracing & fast failures** — trace any venv, and surface agent-CLI problems immediately.

### 🐛 Fixed

- **Reliability** — webview buttons never fail silently, and tracing works on Python 3.14.

## [0.0.7] — 2026-07-24

Relicensed to the Apache License 2.0.

## [0.0.6] — 2026-07-23

### 🎉 Vinv is now open source

- **Apache 2.0** — everything local, no account, no keys, no telemetry; and the Windows engine install works.

## [0.0.5] — 2026-07-23

### 🚀 Improved

- **Discovery & learning** — exhaustive service discovery, golden I/O baselines, and honest memory reporting.

## [0.0.4] — 2026-07-22

### 🐛 Fixed

- **Ask Vinv clickable** — a markup error had killed every control in the panel.

## [0.0.3] — 2026-07-22

### 🐛 Fixed

- **No MCP-registration crash** — Claude Code no longer crashes, and broken entries self-repair.

## [0.0.1] — 2026-07-14

First public release.
