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

Add `vinv-mcp` to your client's MCP config **once, globally** (it runs over
stdio via `npx`, no global install needed) — no per-repo path required:

```json
{
  "mcpServers": {
    "vinv": {
      "command": "npx",
      "args": ["-y", "vinv-mcp"]
    }
  }
}
```

The server discovers which folder to analyze automatically: it asks your client
for its open workspace via **MCP roots** (Claude Code, Cursor, VS Code), so one
config follows whatever repo you have open. Resolution order is
`VINV_WORKSPACE` → MCP roots → current working directory. Set
`VINV_WORKSPACE` (or pass the path as the first argument) only to pin a
specific repo — e.g. in a client that does not expose roots.

- **Claude Code:** `claude mcp add vinv -- npx -y vinv-mcp`
- **Cursor / VS Code / others:** add the JSON block above to the client's MCP
  settings.
- **Claude Desktop** (no open-folder concept): pin the repo with
  `"env": { "VINV_WORKSPACE": "/absolute/path/to/your/repo" }`.

## Indexing

The semantic-search index builds itself in the **background** the moment the
server starts on a workspace (the first build also downloads the local
embedding model, ~500 MB, once). Nothing blocks: `vinv_query` returns a "still
indexing" notice and you fall back to text search until it is ready. Call
`vinv_index` any time to start/refresh the index or check status, or
`vinv_index` with `rebuild: true` to force a full rebuild.

## Tools

`vinv-mcp` exposes the full Vinv tool set in one server:

| Area | Tools |
|---|---|
| **Code index** | `vinv_query` (semantic search), `vinv_index` (build/refresh), `vinv_deadcode` (unreferenced code), `vinv_feedback`, `vinv_session` |
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
