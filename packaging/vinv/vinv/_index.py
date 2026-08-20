"""Console-script entry point for the bundled Rust `index` binary.

The binary ships inside the package at ``vinv/_bin/index`` (or ``index.exe`` on
Windows). Exposing it as a `[project.scripts]` entry point — rather than only a
wheel data-script — means `pip`, `pipx`, `uvx` and `uv tool` all put an `index`
command on PATH, exactly like the Python engine commands.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path


def _binary() -> Path:
    exe = "index.exe" if os.name == "nt" else "index"
    return Path(__file__).resolve().parent / "_bin" / exe


def main() -> None:
    binary = _binary()
    if not binary.exists():
        sys.exit(f"vinv: bundled index binary not found at {binary}")

    # Defensive: ensure the executable bit survived packaging on POSIX.
    if os.name != "nt":
        try:
            mode = binary.stat().st_mode
            if not mode & stat.S_IXUSR:
                binary.chmod(mode | 0o111)
        except OSError:
            pass

    argv = [str(binary), *sys.argv[1:]]
    if os.name == "nt":
        import subprocess

        raise SystemExit(subprocess.call(argv))
    os.execv(str(binary), argv)
