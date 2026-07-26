# tests

Repo-level tests. Most of Vinv's tests are **per-engine unit suites** that live
next to their code, not here — this directory holds the cross-cutting
**end-to-end** test.

## Layout

- **`e2e/planted_bug_golden/`** — the end-to-end honesty contract. `run.py`
  plants a real bug in a fixture service (`fixture_repo/planted_app/`), runs it
  under the tracer, and asserts the evidence names the exact failing symbol and
  line. If this passes, the core promise of the product holds. It also drives a
  small Rust harness (`rust_harness/`) and a fixed question set
  (`questions.planted.json`). See `e2e/planted_bug_golden/README.md` for details.

## Where the unit tests are

Each engine keeps its own suite under `<engine>/tests/` (run with
`uv run pytest` inside that package, or from the repo root for everything):

`contracts/`, `core/`, `tracelens/`, `identification/`, `handbook/`, `bringup/`,
`goal/`, `embedder/`, `exerciser/`. The Rust index has its own tests
(`cargo test` in `index/`).

## Running

```bash
# the end-to-end golden test (needs the engines synced + the Rust index built)
uv run python tests/e2e/planted_bug_golden/run.py

# every engine's unit suite, from the repo root
uv run pytest
```

CI runs both on every PR — see [`.github/workflows/test.yml`](../.github/workflows/test.yml).

## The bigger picture

For the full test ontology — what artifacts exist, what produces each, and the
walk order that tells an agent it has covered everything — read
[`docs/testing-ontology.md`](../docs/testing-ontology.md).
