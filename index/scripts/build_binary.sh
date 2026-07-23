#!/usr/bin/env bash
#
# build_binary.sh — compile `index` into a single, self-contained CLI binary.
#
# `cargo build --release` already emits a native machine-code binary; this
# script is a thin wrapper that stages it into dist/ with a stable name.
#
# Output:  dist/index   (one file, nothing else required to run)
# Install: copy that file into any directory on $PATH (e.g. /usr/local/bin),
#          then invoke it directly as:  index --help
#
# Usage:
#   scripts/build_binary.sh                              # release binary (TLS)
#   OUT_DIR=/usr/local/bin scripts/build_binary.sh       # build straight into a bin dir
#   NO_TLS=1 scripts/build_binary.sh                     # http-only, skips native crypto (ring)
#   TARGET=x86_64-unknown-linux-musl scripts/build_binary.sh   # cross/other target triple
#   MINGW_DIR=/c/tools/mingw64/bin scripts/build_binary.sh     # add a linker to PATH (Windows GNU)
#
set -euo pipefail

# --- locations -------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$PROJECT_DIR/dist}"
BIN_NAME="index"
# Windows executables carry a .exe suffix; other platforms have none.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows*) EXE=".exe" ;;
  *) EXE="" ;;
esac

cd "$PROJECT_DIR"

# --- optional toolchain shim ----------------------------------------------
# On the Windows GNU target, rustc invokes gcc/ld from a MinGW-w64 toolchain as
# the linker (and to build `ring` when TLS is on). Point MINGW_DIR at its bin/
# directory if it is not already on PATH.
if [[ -n "${MINGW_DIR:-}" ]]; then
  export PATH="$MINGW_DIR:$PATH"
fi

# --- toolchain check -------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  echo "error: 'cargo' is required (install Rust from https://rustup.rs)." >&2
  exit 1
fi

# --- feature / target selection -------------------------------------------
CARGO_FLAGS=(build --release)
if [[ -n "${NO_TLS:-}" ]]; then
  # Drops the rustls/ring dependency — pure Rust, no C-crypto compile. Only
  # http:// gateways work in this mode, which is fine for the default
  # localhost embedding sidecar.
  CARGO_FLAGS+=(--no-default-features)
  echo ">> TLS disabled (http-only build; no native crypto backend)"
fi
if [[ -n "${TARGET:-}" ]]; then
  CARGO_FLAGS+=(--target "$TARGET")
fi

# --- compile ---------------------------------------------------------------
echo ">> compiling -> $OUT_DIR/$BIN_NAME$EXE"
cargo "${CARGO_FLAGS[@]}"

# Locate the produced binary (target/<triple>/release when TARGET is set).
if [[ -n "${TARGET:-}" ]]; then
  PRODUCED="$PROJECT_DIR/target/$TARGET/release/$BIN_NAME$EXE"
else
  PRODUCED="$PROJECT_DIR/target/release/$BIN_NAME$EXE"
fi
if [[ ! -f "$PRODUCED" ]]; then
  echo "error: build did not produce $PRODUCED" >&2
  exit 1
fi

# --- stage output ----------------------------------------------------------
mkdir -p "$OUT_DIR"
cp -f "$PRODUCED" "$OUT_DIR/$BIN_NAME$EXE"
chmod +x "$OUT_DIR/$BIN_NAME$EXE" 2>/dev/null || true

echo ""
echo ">> done: $OUT_DIR/$BIN_NAME$EXE"
echo "   size:    $(du -h "$OUT_DIR/$BIN_NAME$EXE" | cut -f1)"
echo "   verify:  '$OUT_DIR/$BIN_NAME$EXE' --help"
echo "   install: cp '$OUT_DIR/$BIN_NAME$EXE' /usr/local/bin/   # then run: index --help"
