"""Compile the Rust `index` binary and bundle it into the vinv wheel.

Runs during the wheel build (hatchling custom build hook) and produces a
PLATFORM-specific wheel. `pip install vinv` then drops the `index` executable
onto PATH next to the Python engine console scripts, so `index index`, semantic
search, and every engine that reads the index store work with **no Rust
toolchain on the user's machine**.

The binary path is always computed from the repo root (two levels up from this
package), so it is correct regardless of the build's working directory. In CI
(cibuildwheel) `cargo`'s `target/` dir persists across the per-Python wheel
builds on a platform, so Rust is compiled once and reused.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        # packaging/vinv/ → the repo root is two levels up.
        repo = Path(self.root).resolve().parents[1]
        exe = "index.exe" if os.name == "nt" else "index"
        built = repo / "index" / "target" / "release" / exe

        # Optional override (absolute, or relative to the repo root).
        override = os.environ.get("VINV_INDEX_BIN", "").strip()
        if override:
            o = Path(override)
            built = (o if o.is_absolute() else repo / o).resolve()

        if not built.exists():
            manifest = repo / "index" / "Cargo.toml"
            if not manifest.exists():
                raise RuntimeError(f"index/Cargo.toml not found at {manifest}")
            print(
                f"[vinv] compiling the Rust index: cargo build --release ({manifest})",
                file=sys.stderr,
            )
            subprocess.run(
                ["cargo", "build", "--release", "--manifest-path", str(manifest)],
                check=True,
            )

        if not built.exists():
            raise RuntimeError(f"index binary not found after build: {built}")

        # Ship it as a script → installed onto the venv's bin/Scripts dir (PATH).
        build_data["shared_scripts"][str(built)] = exe
        # The wheel now carries a native binary: tag it for THIS platform.
        build_data["pure_python"] = False
        build_data["infer_tag"] = True
