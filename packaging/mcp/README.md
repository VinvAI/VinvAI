# vinv-mcp

**Give your AI agent runtime evidence.** One MCP server exposing all of
[Vinv](https://vinv.ai)'s tools — semantic code search, fault localization over
real runs, live values/slices/coverage, and the verify/optimize loop — to any
MCP client (Claude Code, Claude Desktop, Cursor, …).

Vinv runs, tests, and finds issues in your Python services with zero code
changes. `vinv-mcp` hands that evidence to the agent you already use.

## Prerequisite

The MCP server drives the Vinv engines, which ship on PyPI. Install them so they
are on your `PATH`:

```bash
pip install vinv
# or:
uv tool install vinv
```

## Configure your MCP client

Add `vinv-mcp` to your client's MCP config (it runs over stdio via `npx`, no
global install needed):

```json
{
  "mcpServers": {
    "vinv": {
      "command": "npx",
      "args": ["-y", "vinv-mcp"],
      "env": { "VINV_WORKSPACE": "/absolute/path/to/your/repo" }
    }
  }
}
```

`VINV_WORKSPACE` is optional — it defaults to the current working directory. You
can also pass the repo path as the first argument instead of the env var.

- **Claude Code:** `claude mcp add vinv -- npx -y vinv-mcp`
- **Cursor / Claude Desktop / others:** add the JSON block above to the client's
  MCP settings.

## Tools

`vinv-mcp` exposes the full Vinv tool set in one server:

| Area | Tools |
|---|---|
| **Code index** | `vinv_query` (semantic search), `vinv_feedback`, `vinv_session` |
| **Runtime** | `rank_suspects`, `values_of`, `slice`, `coverage_of`, `callers_of`, `blast_radius`, `why_did_this_run`, `relevant_to` |
| **Exercise** | `vinv_ingest_run`, `vinv_run_status`, `vinv_list_candidates` |

## How it works

`vinv-mcp` multiplexes Vinv's three focused MCP servers (index / runtime /
exercise) into a single stdio server: `tools/list` merges every tool and
`tools/call` routes to the one that owns it. All analysis runs **locally**, on
your machine — no API keys, no telemetry.

## Links

- [vinv.ai](https://vinv.ai)
- [github.com/VinvAI/VinvAI](https://github.com/VinvAI/VinvAI)

Apache-2.0.
