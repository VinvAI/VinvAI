# index

> **The code index as one fast native binary.** Make your whole repo searchable in natural language — shipped as a single self-contained executable.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![rust](https://img.shields.io/badge/rust-native_binary-0a0a0a?style=flat-square)

Index a repository, then search it in plain English. Results come back with the code snippet and its surrounding context, ranked by relevance and importance (hybrid dense + BM25 retrieval fused with RRF, plus a PageRank prior over the code graph).

| Command | Purpose |
| --- | --- |
| `index index` | Build (or rebuild) the index for a repository. |
| `index query` | Search the index with a natural-language question. |
| `index update` | Sync the index after you edit code. |

## `// 01 · build`

Requires the Rust toolchain ([rustup.rs](https://rustup.rs)):

```bash
cd index
scripts/build_binary.sh        # -> dist/index
./dist/index --help
```

## `// 02 · embeddings`

By default, `index` talks to the **local embedding sidecar** at
`http://127.0.0.1:8776/v1` — an OpenAI-compatible embeddings server running
`ibm-granite/granite-embedding-small-english-r2` on your machine. No API key, no cloud:

```bash
vinv-embedder serve        # start the sidecar, then index away
```

Alternatively, point `INDEX_GATEWAY_URL` (or `LITELLM_BASE_URL`) at any
OpenAI-compatible embeddings endpoint and set `INDEX_EMBEDDING_MODEL`.

| Variable | Meaning | Default |
| --- | --- | --- |
| `INDEX_GATEWAY_URL` | OpenAI-compatible gateway base URL (including `/v1`). | `http://127.0.0.1:8776/v1` (falls back to `LITELLM_BASE_URL`) |
| `INDEX_GATEWAY_KEY` | API key for that gateway. Unset = no Authorization header. | — (falls back to `LITELLM_API_KEY`) |
| `INDEX_EMBEDDING_MODEL` | Embedding model id. | `ibm-granite/granite-embedding-small-english-r2` |
| `INDEX_SUMMARY_MODEL` | Chat model for `--summarize`. | `gpt-4o-mini` |
| `INDEX_EMBED_BATCH` | Inputs per embeddings request (also the resume granularity). | `64` |
| `INDEX_EMBED_MAX_RETRIES` | Retries per batch on connection/429/5xx failures. | `5` |
| `INDEX_STORE_DIR` | Compatibility override for the index root. | `<repo>/.vinv/index` |
| `INDEX_RANK_WEIGHT` | Weight of the graph-centrality prior, applied to `ln(1 + rank)`; 0 disables. | `0.02` |
| `INDEX_TEST_PENALTY` | Score multiplier for test-path chunks on non-test queries; 1.0 disables. | `0.55` |
| `INDEX_SPLIT_DEDUP` | Keep only the best-scoring slice per (file, symbol) in results; 0 disables. | on |

## `// 03 · use`

```bash
# index a repo (embeds identifier + signature + docstring per symbol)
index index /path/to/repo

# only certain languages
index index /path/to/repo --languages python,typescript

# opt-in: one-sentence LLM summaries per symbol (needs a chat-capable gateway)
index index /path/to/repo --summarize

# ask a question
index query "where is the retry logic for the gateway" --repo-path /path/to/repo --top-k 8

# nudge results toward code near symbols you care about
index query "how is a token checked" --repo-path /path/to/repo --context-symbols TokenStore

# keep the index current after edits
index update /path/to/repo
```

Every command prints a JSON result and exits non-zero on error. Supported: Python, JavaScript, TypeScript, plus docs (`.md` / `.rst` / `.txt`).

**Crash recovery.** The embedding stage checkpoints its progress per batch
(fsynced into `<store>/embed_progress/`). If the process dies mid-index — or
the sidecar goes down and the bounded retries run out — just re-run
`index index <repo>`: it resumes from the last durably written row instead of
starting over. Torn or misaligned partial files are detected and self-healed
to the longest verified prefix.

## `// 04 · Python compatibility`

Production Python callers use `core.index`, which discovers the binary from
`VINV_INDEX_BINARY`, `vinv-index`/`index` on `PATH`, or the source checkout's
`index/dist/index`. It always invokes the executable with an argv list and
parses its JSON response.

The adapter retains the former `retrieve_code`, `index_codebase`, and
`sync_index` call names for agent compatibility, while new callers can use
`query_index`, `index_repository`, and `update_index`. The store lives at
`<repo>/.vinv/index`; `INDEX_STORE_DIR` and explicit `--store-dir` remain
available for deployments that need an external-store layout. Backend
discovery reads `VINV_INDEX_LANGUAGES`.

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
