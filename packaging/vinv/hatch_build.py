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
import sysconfig
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

        # Ship the binary inside the package (vinv/_bin/) so the `index` console
        # entry point (vinv._index:main) can exec it — this is what makes `index`
        # available under pip/pipx/uvx/uv-tool, not just a bare `pip install`.
        build_data["force_include"][str(built)] = f"vinv/_bin/{exe}"

        # No Python C-extension here (pure Python + a standalone binary), so the
        # wheel is Python-AGNOSTIC but platform-specific: one `py3-none-<platform>`
        # wheel per OS installs on any supported Python 3.x — not just the version
        # it was built with.
        plat = sysconfig.get_platform().replace("-", "_").replace(".", "_")
        build_data["pure_python"] = False
        build_data["tag"] = f"py3-none-{plat}"
