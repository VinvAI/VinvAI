# bringup

> **The boot stage.** Before Vinv can watch your code run, something has to run it — `bringup` works out what your repo's services are and starts them with tracing switched on.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![python](https://img.shields.io/badge/python-services-0a0a0a?style=flat-square)

Two commands, run in order:

| Command | Purpose |
| --- | --- |
| `bringup list <repo>` | Read the repo's handbook and write an inventory of its services to `.vinv/services.json`. Installs nothing, starts nothing. |
| `bringup start <repo> --service NAME` | Install that service's dependencies and start it under the tracer, so every call lands in a trace for later analysis. |

## `// 01 · install`

```bash
cd bringup
uv sync
uv run bringup --help
```

## `// 02 · use`

Both commands print a fully rendered runbook — no LLM calls are made. Pipe the output into any coding agent (Claude Code, Cursor, Windsurf, …) to have *its* model do the bring-up:

```bash
# 1 · the enumeration runbook (needs <repo>/.vinv/vinv.md — run `handbook generate` first)
uv run bringup list /path/to/repo | your-coding-agent

# 2 · the runbook that boots one service with tracing on
uv run bringup start /path/to/repo --service api --module app --session-id my-session | your-coding-agent

# tool-agnostic wording (no Vinv-specific tool names) for a foreign agent
uv run bringup start /path/to/repo --service api --module app --portable
```

`--module` names the Python package(s) to record; `--session-id` groups the traces of one session. Bring services up one at a time — one `start` per service.

If the agent cannot work out how to start a service, tell it — that is usually the whole problem:

```bash
uv run bringup start /path/to/repo --service api --module app --start-hint 'make run-api'
```

The runbook has the agent run your command, confirm it serves, then record the **tracelens-wrapped** equivalent. The hint says *which* command to trace; it does not lower the bar — `verified: true` still requires the wrapped form to serve with a non-zero trace, so an untraced command is still a failed bring-up. The hint is remembered at `.vinv/start_hints/<service>.json` and reused by later `start` runs for that service, so you only say it once (the VS Code extension writes this file for you when a bring-up fails). Edit or delete that file to change your answer.

The printed runbook instructs the agent to write the `.vinv/services.json` / `.vinv/start_commands/<service>.json` deliverables, so the rest of the pipeline reads their output unchanged. (`handbook generate [--portable]` does the same for Stage 1.)

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
