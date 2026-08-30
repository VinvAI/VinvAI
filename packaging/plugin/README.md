# vinv — Agent Plugin

The [Agent Plugins](https://agent-plugins.org) packaging of the Vinv MCP server,
for the **Cursor Marketplace** and any Agent-Plugins-aware client.

It declares one stdio MCP server that runs the published `vinv-mcp` npm package:

```
npx -y vinv-mcp
```

- `plugin.json` — plugin identity (Agent Plugins v1 manifest)
- `mcp.json` — the stdio MCP server definition

The server needs the Vinv engines on `PATH` (`pip install vinv`). Full tool list
and configuration: [`../mcp/README.md`](../mcp/README.md).

Apache-2.0 · [vinv.ai](https://vinv.ai) · [github.com/VinvAI/VinvAI](https://github.com/VinvAI/VinvAI)
