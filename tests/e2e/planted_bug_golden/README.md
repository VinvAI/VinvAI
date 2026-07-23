# Planted-bug golden E2E

This isolated fixture proves that Vinv can connect a reproducible runtime failure
to the exact indexed symbol and source line without using production services or
credentials. Production modules are imported as-is; all doubles live here.

The planted defect is an empty-cart division by zero in
`fixture_repo/planted_app/service.py::compute_total`.

## Run

```bash
python3 tests/e2e/planted_bug_golden/run.py
```

The default run is secret-free and:

1. runs a Rust harness, when `cargo` is available, against the production index
   parser, graph, BM25, store, embedding client, and hybrid query modules;
2. serves deterministic OpenAI-compatible `/v1/embeddings` responses to that
   harness and asserts `compute_total` is the top result;
3. executes healthy and failing requests while capturing actual calls into
   Tracelens-compatible JSONL (a standard-library fallback requiring no packages);
4. builds a synthetic Rust-index store from the real fixture AST, then runs the
   production identification Rust-store adapter, consolidate, call-tree, and
   trace-map join;
5. asserts the evidence cites `planted_app/service.py::compute_total`, verifies
   the cited source line, observes `ZeroDivisionError`, and rejects any symbol
   absent from the index.

Unavailable toolchains are reported as explicit skipped stages. A skipped stage
does not weaken another stage's assertions.

## Optional real capture and agent stages

Prefer the Tracelens project venv (has `click` and other deps):

```bash
./tracelens/.venv/bin/python tests/e2e/planted_bug_golden/run.py --real-tracelens
```

The runner auto-selects `tracelens/.venv/bin/python` when present. The fixture
supplies a local test-only licensing shim for this E2E process. It does not
alter or bypass production module code.

Live retrieval baseline for this fixture (requires an OpenAI-compatible gateway):

```bash
INDEX_GATEWAY_URL=… INDEX_GATEWAY_KEY=… \
  ./index/dist/index index tests/e2e/planted_bug_golden/fixture_repo \
    --store-dir /tmp/planted-index --languages python --force
INDEX_GATEWAY_URL=… INDEX_GATEWAY_KEY=… \
  python3 index/eval/bench_retrieval.py \
    --index-bin ./index/dist/index \
    --store-dir /tmp/planted-index \
    --questions tests/e2e/planted_bug_golden/questions.planted.json
```

Full handbook/bringup agent execution is intentionally opt-in because it needs
an LLM credential and deployment-specific command:

```bash
export LITELLM_API_KEY=...
export VINV_E2E_AGENT_COMMAND='python -m your_agent_entrypoint ...'
python3 tests/e2e/planted_bug_golden/run.py --with-agent-stages
```

`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` also satisfy the explicit secret check.
The runner never invents a default agent command.
