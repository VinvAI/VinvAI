# bringup

> **The boot stage.** Before Vinv can watch your code run, something has to run it — `bringup` works out what your repo's services are and starts them with tracing switched on.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![python](https://img.shields.io/badge/python-services-0a0a0a?style=flat-square)

Two commands, run in order:

| Command | Purpose |
| --- | --- |
| `bringup list <repo>` | Read the repo's handbook and write an inventory of its services to `.vinv/services.json`. Installs nothing, starts nothing. |
| `bringup start <repo> --service NAME` | Install that service's dependencies and start it under the tracer, so every call lands in a trace for later analysis. |

## `// 00 · what counts as a service`

Tracelens instruments a **process**, not a server, so the inventory is not
limited to things that stay up. Six kinds, and the discriminator between the
first four and the last two is whether the entrypoint **blocks** — never whether
it declares a console script:

| kind | what it is | readiness probe |
| --- | --- | --- |
| `python_web` | serves HTTP | the port accepts a connection |
| `python_worker` | queue/background consumer | alive past the grace window |
| `python_stdio` | stdio JSON-RPC (MCP-style) | an `initialize` round-trip |
| `python_scheduler` | beat/cron process | alive past the grace window |
| `python_cli` | console script that runs to completion | **exit code + a non-empty trace** |
| `python_library` | importable package, no entrypoint of its own | as above, driven by the exerciser |

The last two matter more than they look: in a toolchain, a SDK or a framework
they are the *only* units of work there are, and an inventory that omits them
traces nothing at all. A `python_cli` entry carries `invocations` (the argv sets
the repo declares); a `python_library` entry carries **no `command`** — the
harness supplies the exerciser's function driver rather than let one be
fabricated.

### Many ways to run one unit

A server has one way to start. A CLI has one per subcommand, a library one per
entry point — and `commands` in the recorded start file cannot express that,
because it is a **sequence** (a dependency, then the unit) that every replayer
joins with `&&`. Alternatives live in a separate `invocations` array, each with
a stable `id`, its own `expect_exit` and its own trace path:

```json
"invocations": [
  {"id": "report", "default": true, "expect_exit": 0,
   "command": "… -- python -m acme_tool report --since {since}",
   "params": [{"name": "since", "type": "string", "default": "7d"}],
   "verification": {"exit_code": 0, "trace_lines": 812,
                    "rendered_command": "… report --since 7d"}},
  {"id": "check", "expect_exit": 1,
   "command": "… -- python -m acme_tool check ./sample"}
]
```

Three consumers read that array and behave differently on purpose: the Run
button asks a human (prefilled with defaults, remembered per invocation in
`.vinv/run_args/`), the exercise pass decides for itself and never prompts, and
the replay gate takes the `default` one silently. **Bring-up replays every entry
and the file passes only if they all do** — recording five ways to drive a unit
and proving one verifies whichever happened to be first.

`params` turns a command into a template. The rule that keeps `verified: true`
honest is that rendering an invocation with all of its defaults must reproduce
`verification.rendered_command` byte for byte; the validator rejects the file
otherwise, since a drifted default means the record attests to a command nobody
ran. An invocation that declares no `params` is run verbatim, braces and all, so
a legitimate `--format '{json}'` is never mangled. The rendering rules are pinned
for all three implementations by `contracts/vectors/invocation_render.json`.

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
