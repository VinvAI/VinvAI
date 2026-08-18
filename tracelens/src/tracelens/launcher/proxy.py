"""mitmproxy proxy — not implemented."""

from __future__ import annotations

from pathlib import Path


def run_proxy(port: int, output: Path, passthrough: list[str]) -> None:
    _ = (port, output, passthrough)
    raise SystemExit(
        "tracelens proxy is not implemented in this build (requires mitmproxy); "
        "see the tracelens README for the planned contract."
    )
