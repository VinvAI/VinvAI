#!/usr/bin/env python3
"""Assert the vinv-mcp version agrees everywhere it is written.

One release of the MCP server restates its version in seven places across five
files: the npm package and its lockfile, the MCP-registry manifest (twice), the
`serverInfo` string the server reports over the wire, and the two plugin
manifests (Agent Plugins for the Cursor Marketplace, and Claude Code's). None of
this is generated — every bump is done by hand, and nothing in CI checks that
the hand touched all seven.

It has already drifted: package-lock.json sat at 0.0.1 through five releases,
and a release commit bumped the repo to 0.0.6 while both npm and the MCP
registry stayed on 0.0.5, so the manifests advertised a version no client could
install. A client reads whichever copy it happens to read, so a partial bump
ships a server that misreports itself.

Run standalone, or via the pre-commit hook when a version-bearing file is
staged:

    python scripts/check-mcp-versions.py

Exits non-zero listing every file whose version disagrees with the npm
package's, which is treated as the source of truth.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

PKG = REPO / "packaging" / "mcp" / "package.json"
LOCK = REPO / "packaging" / "mcp" / "package-lock.json"
SERVER_JSON = REPO / "packaging" / "mcp" / "server.json"
SERVER_TS = REPO / "packaging" / "mcp" / "src" / "server.ts"
PLUGIN = REPO / "packaging" / "plugin" / "plugin.json"
CLAUDE_PLUGIN = REPO / "packaging" / "plugin" / ".claude-plugin" / "plugin.json"

# The `serverInfo` version the running server reports to its client.
SERVER_INFO_RE = re.compile(r"serverInfo:\s*\{[^}]*version:\s*'([^']+)'")


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _found() -> list[tuple[str, str | None]]:
    """(label, version) for every place the version is written, or None if absent."""
    lock = _json(LOCK)
    # npm writes the root package's version twice: top level and packages[""].
    lock_root = lock.get("packages", {}).get("", {}).get("version")
    server_json = _json(SERVER_JSON)
    packages = server_json.get("packages") or [{}]
    m = SERVER_INFO_RE.search(SERVER_TS.read_text(encoding="utf-8"))

    return [
        ("packaging/mcp/package-lock.json (version)", lock.get("version")),
        ('packaging/mcp/package-lock.json (packages[""])', lock_root),
        ("packaging/mcp/server.json (version)", server_json.get("version")),
        ("packaging/mcp/server.json (packages[0].version)", packages[0].get("version")),
        ("packaging/mcp/src/server.ts (serverInfo)", m.group(1) if m else None),
        ("packaging/plugin/plugin.json", _json(PLUGIN).get("version")),
        (
            "packaging/plugin/.claude-plugin/plugin.json",
            _json(CLAUDE_PLUGIN).get("version"),
        ),
    ]


def main() -> int:
    expected = _json(PKG).get("version")
    if not expected:
        print("✗ packaging/mcp/package.json has no version field")
        return 1

    bad = [(label, got) for label, got in _found() if got != expected]
    if not bad:
        print(f"✓ vinv-mcp version {expected} agrees across all 7 places")
        return 0

    print(f"✗ vinv-mcp version disagrees. packaging/mcp/package.json says {expected}:")
    for label, got in bad:
        print(f"    {label}: {got if got is not None else '(not found)'}")
    print()
    print("  Bump every one of them together, then re-run. For the lockfile,")
    print("  `npm install` in packaging/mcp/ rewrites it from package.json.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
