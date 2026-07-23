"""py-spy attach (M11 — not implemented)."""

from __future__ import annotations

from pathlib import Path


def run_attach(pid: int, output: Path, duration: str) -> None:
    _ = (pid, output, duration)
    raise SystemExit(
        "tracelens attach is not implemented in this build (requires py-spy); "
        "see README / spec §5.10 for the planned M11 contract."
    )
