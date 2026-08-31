# vinv — Agent Plugin

Plugin packaging of the Vinv MCP server, for the **Cursor Marketplace** (via
[Agent Plugins](https://agent-plugins.org)) and for **Claude Code**, whose
plugin marketplace is declared at `../../.claude-plugin/marketplace.json` and
points its one entry here.

It declares one stdio MCP server that runs the published `vinv-mcp` npm package:

```
npx -y vinv-mcp
```

- `plugin.json` — plugin identity (Agent Plugins v1 manifest)
- `mcp.json` — the stdio MCP server definition
- `.claude-plugin/plugin.json` — the same identity in Claude Code's manifest format
- `.mcp.json` — the same server definition, in the location Claude Code reads

Both manifest pairs describe the identical server; the duplication exists only
because the two ecosystems read different filenames. Keep the `version` fields
in `plugin.json` and `.claude-plugin/plugin.json` in step.

Install in Claude Code:

```
claude plugin marketplace add VinvAI/VinvAI
claude plugin install vinv@vinvai
```

The server needs the Vinv engines on `PATH` (`pip install vinv`). Full tool list
and configuration: [`../mcp/README.md`](../mcp/README.md).

Apache-2.0 · [vinv.ai](https://vinv.ai) · [github.com/VinvAI/VinvAI](https://github.com/VinvAI/VinvAI)
