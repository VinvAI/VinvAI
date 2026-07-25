# tracelens

> **The trace half of runtime ground truth.** Coding agents only ever see source — `tracelens` gives them the other half: every function call of your own run, recorded without touching a line of code.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![python](https://img.shields.io/badge/python-3.12%2B-0a0a0a?style=flat-square)

Trace a Python service **you do not modify**: `tracelens run` wraps your process, records every call — timing, memory, inputs and outputs — into a `trace.jsonl` you can analyze offline or feed to your coding agent through Vinv.

## `// 01 · install`

```bash
cd tracelens
pip install -e .
```

## `// 03 · trace a run`

```bash
tracelens run --target-package myapp --output trace.jsonl -- python -m myapp
```

1. `--target-package` names the package(s) to record (repeat the flag for more than one).
2. Everything after `--` is your normal start command.
3. Exercise the app, then stop it — your run is in `trace.jsonl`.

Useful switches:

| Flag / env | Effect |
| --- | --- |
| `--minimal` / `--standard` / `--full` | How much to record. `--standard` (default) is latency-honest: calls with cpu/blocked timing, tracemalloc off; `--full` adds memory and determinism capture; `--minimal` is bare calls only. `TRACELENS_PRESET=memory` selects the memory-focused preset (full tracemalloc, no determinism). |
| `--memory` / `--no-memory` | Per-call memory on or off (tracemalloc; distorts user-code latency — every run's `tracer_calibration` header records the active axes). |
| `--capture-determinism` / `--no-capture-determinism` | Record time/random reads alongside the trace. |
| `--instrument-third-party` | Also record installed libraries, not just your packages. |
| `TRACELENS_DISABLED=1` | Turns tracing into a no-op without changing your command. |

**Tip:** keep your app in one Python process while tracing (`python -m yourpkg` / `python script.py`). Process-replacing launchers can drop instrumentation — the demo in `examples/demo_run.sh` shows the recommended shape.

You can also assert behaviour without editing code: point `TRACELENS_INVARIANTS` at a small YAML file of `function: expression` checks and violations are recorded on the trace. See `tests/integration/demo_invariants.yaml`.

## `// 04 · analyze the run`

```bash
tracelens report trace.jsonl --out report.html   # one-shot HTML report
```

Or run the individual analyses — each reads `trace.jsonl` and writes a file:

```bash
tracelens analyze spans     trace.jsonl    # per-request call trees
tracelens analyze depgraph  trace.jsonl    # who-calls-whom graph of the run
tracelens analyze metrics   trace.jsonl    # latency/error aggregates over time
tracelens analyze outcomes  trace.jsonl    # results + invariant violations
tracelens analyze symbol-stats trace.jsonl # per-function totals + projected CPU-time cost
```

Further subcommands (`provenance` to diff two runs, `drift`, `circa`/`gcm` root-cause helpers, `dynamic-static-diff`, `corpus`) are listed under `tracelens analyze --help`.

## `// 05 · what you get`

| File | Contents |
| --- | --- |
| `trace.jsonl` | The run — one record per call enter/exit. |
| `trace.jsonl.summary.json` | Run summary: counts, errors, latency. |
| `trace.jsonl.determinism.jsonl` | Time/random reads captured during the run. |
| `report.html` | Everything above, readable in a browser. |

`tracelens attach` and `tracelens proxy` are not available in this build.

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
