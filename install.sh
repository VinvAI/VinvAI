#!/usr/bin/env bash
# Vinv — one-command install from a clone of this repo.
#
#   git clone https://github.com/VinvAI/VinvAI ~/.vinv/engines
#   cd ~/.vinv/engines && ./install.sh
#
# Builds everything from source (no downloads, no accounts):
#   1. uv sync                — Python engines + the local embedding sidecar
#   2. cargo build --release  — the Rust semantic index
#   3. npm install + package  — the editor extension (VSIX)
#   4. installs the VSIX into every detected editor CLI
set -euo pipefail
cd "$(dirname "$0")"

missing=()
command -v uv >/dev/null || missing+=("uv    → https://docs.astral.sh/uv/getting-started/installation/")
command -v cargo >/dev/null || missing+=("cargo → https://rustup.rs")
command -v npm >/dev/null || missing+=("npm   → https://nodejs.org")
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing prerequisites:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "==> [1/4] Python engines (uv sync)"
uv sync

echo "==> [2/4] Rust index (cargo build --release)"
cargo build --release --manifest-path index/Cargo.toml

echo "==> [3/4] Editor extension (npm install + package)"
npm install --prefix extension --no-fund --no-audit
(cd extension && npx --yes @vscode/vsce package --no-rewrite-relative-links -o ../vinv.vsix >/dev/null)
echo "    built vinv.vsix"

echo "==> [4/4] Installing the extension into detected editors"
installed=0
for editor in code cursor windsurf codium trae; do
  if command -v "$editor" >/dev/null 2>&1; then
    echo "    $editor --install-extension vinv.vsix"
    "$editor" --install-extension "$(pwd)/vinv.vsix" --force >/dev/null && installed=$((installed + 1)) || true
  fi
done
if [ "$installed" -eq 0 ]; then
  echo "    no editor CLI found — install manually: Extensions → ⋯ → Install from VSIX… → $(pwd)/vinv.vsix"
fi

echo
echo "Done. Open your repo in the editor — the Vinv panel takes it from here."
echo "(First index build downloads the local embedding model once, ~500 MB.)"
