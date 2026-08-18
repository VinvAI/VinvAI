#!/usr/bin/env bash
# Smoke: demo app + tracelens analyze. Run from repo: bash examples/demo_run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PYTHONPATH="${ROOT}/tests/integration:${PYTHONPATH:-}"
OUT="${TRACE_OUT:-${TMPDIR:-/tmp}/tracelens_demo.jsonl}"
DIAG="${TMPDIR:-/tmp}/tracelens_demo_diag.log"
rm -f "$OUT" "$DIAG"
export TRACELENS_DIAG_LOG="$DIAG"

PORT="${DEMO_PORT:-8765}"
HOST="127.0.0.1"
export TRACELENS_DEMO_HOST="$HOST"
export TRACELENS_DEMO_PORT="$PORT"
export TRACELENS_INVARIANTS="$ROOT/tests/integration/demo_invariants.yaml"
UVPY="$(cd "$ROOT" && uv run which python)"

uv run tracelens run \
  --target-package demo_app \
  --output "$OUT" \
  --sample-rate 1.0 \
  -- "$UVPY" "$ROOT/tests/integration/run_demo.py" &
UV_PID=$!

cleanup() {
  kill -TERM "$UV_PID" 2>/dev/null || true
  wait "$UV_PID" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 30); do
  if curl -sf "http://${HOST}:${PORT}/healthy" >/dev/null; then
    break
  fi
  sleep 0.2
done

# Volume: O(100+) calls per endpoint gives stable lift/metrics; override with DEMO_ENDPOINT_LOOPS.
N="${DEMO_ENDPOINT_LOOPS:-60}"
curl -sf "http://${HOST}:${PORT}/healthy" >/dev/null
for _ in $(seq 1 "$N"); do curl -sf "http://${HOST}:${PORT}/healthy" >/dev/null || true; done
for _ in $(seq 1 "$N"); do curl -sf "http://${HOST}:${PORT}/slow/2" >/dev/null || true; done
for _ in $(seq 1 "$N"); do curl -sf "http://${HOST}:${PORT}/async_ping" >/dev/null || true; done
for _ in $(seq 1 "$N"); do curl -sf "http://${HOST}:${PORT}/wrong/3" >/dev/null || true; done

kill -TERM "$UV_PID" || true
wait "$UV_PID" 2>/dev/null || true
trap - EXIT

test -s "$OUT"

uv run tracelens analyze spans "$OUT" --out "${TMPDIR:-/tmp}/spans.json"
uv run tracelens analyze depgraph "$OUT" --out "${TMPDIR:-/tmp}/depgraph.json" --min-support 1
uv run tracelens analyze outcomes "$OUT" --out "${TMPDIR:-/tmp}/outcomes.json" || true
uv run tracelens analyze metrics "$OUT" --out "${TMPDIR:-/tmp}/metrics.parquet"
uv run tracelens analyze circa --metrics "${TMPDIR:-/tmp}/metrics.parquet" --depgraph "${TMPDIR:-/tmp}/depgraph.json" --target latency_p95 --normal "1970-01-01,2099-01-01" --incident "1970-01-01,2099-01-01" --out "${TMPDIR:-/tmp}/circa.json"
uv run tracelens analyze gcm --metrics "${TMPDIR:-/tmp}/metrics.parquet" --depgraph "${TMPDIR:-/tmp}/depgraph.json" --target demo_app.main.db_lookup --metric-col latency_p95 --normal "1970-01-01,2099-01-01" --incident "1970-01-01,2099-01-01" --out "${TMPDIR:-/tmp}/gcm.json"
uv run tracelens analyze provenance --golden "$OUT" --current "$OUT" --out "${TMPDIR:-/tmp}/prov.json"
uv run tracelens analyze drift --metrics "${TMPDIR:-/tmp}/metrics.parquet" --baseline "1970-01-01,2099-01-01" --window "1970-01-01,2099-01-01" --out "${TMPDIR:-/tmp}/drift.json"
uv run tracelens report "$OUT" --out "${TMPDIR:-/tmp}/report.html"

if command -v git >/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  DEMO_REL="vinv/tracelens/tests/integration/demo_app"
  if [[ -d "$REPO_ROOT/$DEMO_REL" ]]; then
    git -C "$REPO_ROOT" diff --quiet HEAD -- "$DEMO_REL"
  elif [[ -d "$REPO_ROOT/tests/integration/demo_app" ]]; then
    git -C "$REPO_ROOT" diff --quiet HEAD -- tests/integration/demo_app
  fi
fi

echo "demo_run OK trace=$OUT"
