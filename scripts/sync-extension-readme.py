#!/usr/bin/env python3
"""Keep extension/README.md (Open VSX) in lockstep with the root README.md.

The marketplace listing and the GitHub landing page share one body. Only the
badge "pills" differ — Open VSX gets marketplace-oriented shields; GitHub keeps
version/tests/issues pills. Relative repo links are rewritten to absolute
GitHub URLs so they resolve when the README is rendered on open-vsx.org.

Usage:
  python3 scripts/sync-extension-readme.py          # rewrite extension/README.md
  python3 scripts/sync-extension-readme.py --check  # exit 1 if out of date
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "README.md"
DST = ROOT / "extension" / "README.md"
RAW = "https://raw.githubusercontent.com/VinvAI/VinvAI/main"
BLOB = "https://github.com/VinvAI/VinvAI/blob/main"

# Marketplace pills — the only intentional divergence from the GitHub README.
VSX_PILLS = """\
[![Editors](https://img.shields.io/badge/editors-VS%20Code%20%2B%20Cursor-D71921?style=flat-square)](https://open-vsx.org/extension/VinvAI/VinvAI)
[![Traces Python](https://img.shields.io/badge/traces-Python%2C%20zero%20edits-D71921?style=flat-square)](https://vinv.ai)
[![100% local](https://img.shields.io/badge/100%25%20local-no%20telemetry-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI#privacy)
[![License](https://img.shields.io/badge/license-Apache%202.0-D71921?style=flat-square)](https://github.com/VinvAI/VinvAI/blob/HEAD/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-VinvAI-D71921?style=flat-square&logo=github&logoColor=white)](https://github.com/VinvAI/VinvAI)
[![Support](https://img.shields.io/badge/support-support%40vinv.ai-D71921?style=flat-square)](mailto:support@vinv.ai)
[![Made by VinvAI](https://img.shields.io/badge/made%20by-VinvAI-D71921?style=flat-square)](https://vinv.ai)"""

# GitHub root pills block starts at the first shields.io line and ends before
# the Install line (or the FIND/FIX nav). Match the contiguous badge paragraph.
_PILL_BLOCK = re.compile(
    r"(?:^|\n)(?:\[!\[.*?\]\(https://img\.shields\.io/[^\n]+\)\n?)+",
    re.M,
)

# Paths that must be absolute on Open VSX (relative to repo root).
#
# The alternation is DERIVED from the repo root rather than hand-listed. The
# hand-listed version named only LICENSE, the three community files, docs/,
# extension/ and tests/ — so every engine directory (index/, tracelens/,
# exerciser/, bringup/, …) fell through and shipped as a RELATIVE link on the
# marketplace listing, which `vsce package --no-rewrite-relative-links` leaves
# untouched: nine dead links on open-vsx.org. Deriving the set means a new
# top-level directory can never reintroduce that.
#
# Longest-first so a name that prefixes another cannot shadow it.
_ROOT_NAMES = sorted(
    (entry.name for entry in ROOT.iterdir() if not entry.name.startswith(".")),
    key=len,
    reverse=True,
)
_ROOT_ALT = "|".join(re.escape(name) for name in _ROOT_NAMES)

_REL_LINK = re.compile(
    r"(?P<prefix>\[[^\]]*\]\()(?P<path>"
    rf"(?:{_ROOT_ALT})(?:/[^)#]*)?"
    r")(?P<suffix>(?:#[^)]*)?\))"
)

_REL_HREF = re.compile(
    r'(?P<prefix>href=")(?P<path>'
    rf"(?:{_ROOT_ALT})(?:/[^\"#]*)?"
    r')(?P<suffix>(?:#[^"]*)?")'
)

_REL_IMG = re.compile(r"(?P<prefix>src=\")(?P<path>docs/media/[^\"#]+)(?P<suffix>\")")


def _absolutize(text: str) -> str:
    def link_sub(m: re.Match[str]) -> str:
        path = m.group("path")
        if path.startswith("docs/media/"):
            return f'{m.group("prefix")}{RAW}/{path}{m.group("suffix")}'
        return f'{m.group("prefix")}{BLOB}/{path}{m.group("suffix")}'

    def href_sub(m: re.Match[str]) -> str:
        path = m.group("path")
        return f'{m.group("prefix")}{BLOB}/{path}{m.group("suffix")}'

    def img_sub(m: re.Match[str]) -> str:
        return f'{m.group("prefix")}{RAW}/{m.group("path")}{m.group("suffix")}'

    text = _REL_IMG.sub(img_sub, text)
    text = _REL_LINK.sub(link_sub, text)
    text = _REL_HREF.sub(href_sub, text)
    return text


def render(root_readme: str) -> str:
    match = _PILL_BLOCK.search(root_readme)
    if not match:
        raise SystemExit(
            "sync-extension-readme: no shields.io pill block found in README.md"
        )
    body = (
        root_readme[: match.start()]
        + "\n"
        + VSX_PILLS
        + "\n"
        + root_readme[match.end() :]
    )
    # Drop a leading newline introduced when the pill block started mid-file.
    if body.startswith("\n"):
        body = body[1:]
    return _absolutize(body)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="fail if extension/README.md is stale"
    )
    args = parser.parse_args()

    expected = render(SRC.read_text(encoding="utf-8"))
    if not expected.endswith("\n"):
        expected += "\n"

    if args.check:
        actual = DST.read_text(encoding="utf-8") if DST.exists() else ""
        if actual != expected:
            print(
                "extension/README.md is out of sync with README.md.\n"
                "Run: python3 scripts/sync-extension-readme.py",
                file=sys.stderr,
            )
            return 1
        print("extension/README.md matches README.md (pills excepted).")
        return 0

    DST.write_text(expected, encoding="utf-8")
    print(f"wrote {DST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
