"""Fixture MCP stdio server — serves JSON-RPC over stdin/stdout, no port."""

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("mini-mcp")


@mcp.tool()
def ping() -> str:
    return "pong"


def main() -> None:
    mcp.run(transport="stdio")
