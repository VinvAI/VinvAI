# identification

> **The join, made inspectable.** Vinv's core move is connecting your code to your run — `identification` is that join as a CLI: list a repo's entry points, build the call tree behind each one, and overlay a recorded run to see what actually executed.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![deterministic](https://img.shields.io/badge/deterministic-same_input_→_same_output-0a0a0a?style=flat-square)

Fully deterministic — no server, no agent, no LLM. It reads the Rust code index
from `<repo>/.vinv/index` and, where a trace exists, a recorded run.

| Command | Purpose |
| --- | --- |
| `identification consolidate <repo>` | List every entry point the code defines — HTTP routes, CLI commands, background and scheduled tasks — with its handler. |
| `identification calltree <repo> --api-id ID` | Build the call tree behind one entry point (or `--symbol module:qualname` for an undeclared function). |
| `identification tracemap <repo> --api-id ID` | Overlay a recorded run on that tree: what executed, how often, how long — and what never ran. Takes `--symbol` too. |
| `identification tracesummary <repo>` | Rank every endpoint by how hard the recorded run exercised it. |

## `// 01 · install`

```bash
cd identification
uv sync
uv run identification --help
```

Prerequisites: the repo has been indexed (`index index <repo> --store-dir
<repo>/.vinv/index`), and for `tracemap` / `tracesummary` a run has been
recorded (via `bringup` or `tracelens run`).

## `// 02 · use`

```bash
# 1 · list entry points
uv run identification consolidate /path/to/repo --service my-service

# 2 · the call tree behind one of them
uv run identification calltree /path/to/repo --api-id POST_checkout

# 3 · overlay the recorded run
uv run identification tracemap /path/to/repo --api-id POST_checkout

# 4 · which endpoints did the run actually hit, busiest first
uv run identification tracesummary /path/to/repo --service my-service
```

Results are written under `<repo>/.vinv/identification/` and printed as JSON (add `--json` for machine-readable trees).

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
