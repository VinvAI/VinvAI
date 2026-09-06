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
#
# Steps 3-4 are for working on the extension itself. To build only the engines
# — the Python and Rust halves the CLI and the MCP server use — pass
# --engines-only; npm is then not required at all.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'USAGE'
Usage: ./install.sh [--engines-only]

  --engines-only, --no-extension
        Build the Python engines and the Rust index only. Skips packaging the
        editor extension and skips installing it into your editors, so npm is
        not required.

  -h, --help
        Show this message.

You do not need this script to use Vinv. The editor extension installs from the
marketplace and builds the engines itself on first run, and the MCP server is
`pip install vinv` plus `npx -y vinv-mcp`. Build from source to work on Vinv.
USAGE
}

with_extension=1
while [ $# -gt 0 ]; do
  case "$1" in
    --engines-only | --no-extension) with_extension=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# npm is a prerequisite of step 3 only, so --engines-only must not demand it.
# Everything still required is checked up front: a missing tool should surface
# now, not three minutes into a release build of the Rust index.
missing=()
command -v uv >/dev/null || missing+=("uv    → https://docs.astral.sh/uv/getting-started/installation/")
command -v cargo >/dev/null || missing+=("cargo → https://rustup.rs")
if [ "$with_extension" -eq 1 ]; then
  command -v npm >/dev/null || missing+=("npm   → https://nodejs.org  (or pass --engines-only)")
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing prerequisites:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

steps=4
[ "$with_extension" -eq 1 ] || steps=2

echo "==> [1/$steps] Python engines (uv sync)"
uv sync

echo "==> [2/$steps] Rust index (cargo build --release)"
cargo build --release --manifest-path index/Cargo.toml

if [ "$with_extension" -eq 0 ]; then
  echo
  echo "Done — engines only. The CLI and the MCP server can use them now."
  echo "(First index build downloads the local embedding model once, ~500 MB.)"
  exit 0
fi

echo "==> [3/$steps] Editor extension (npm install + package)"
npm install --prefix extension --no-fund --no-audit
(cd extension && npx --yes @vscode/vsce package --no-rewrite-relative-links -o ../vinv.vsix >/dev/null)
echo "    built vinv.vsix"

# Detect first and say so before overwriting anything: --force replaces an
# already-installed Vinv, including one from the marketplace, with this local
# build. Announcing the list beforehand is what makes that a choice.
echo "==> [4/$steps] Installing the extension into detected editors"
editors=()
for editor in code cursor windsurf codium trae; do
  if command -v "$editor" >/dev/null 2>&1; then
    editors+=("$editor")
  fi
done

if [ ${#editors[@]} -eq 0 ]; then
  echo "    no editor CLI found — install manually: Extensions → ⋯ → Install from VSIX… → $(pwd)/vinv.vsix"
else
  echo "    replacing any installed Vinv in: ${editors[*]}"
  echo "    (skip this step with --engines-only; restore the released build with"
  echo "     <editor> --install-extension VinvAI.VinvAI)"
  for editor in "${editors[@]}"; do
    echo "    $editor --install-extension vinv.vsix"
    "$editor" --install-extension "$(pwd)/vinv.vsix" --force >/dev/null || true
  done
fi

echo
echo "Done. Open your repo in the editor — the Vinv panel takes it from here."
echo "(First index build downloads the local embedding model once, ~500 MB.)"
