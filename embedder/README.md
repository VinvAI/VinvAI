# embedder

> **The local embedding sidecar.** An OpenAI-compatible `/v1/embeddings` server that runs the code-embedding model on your own machine — no API key, no cloud. The index engine talks to this instead of a hosted gateway.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![python](https://img.shields.io/badge/python-3.10%2B-0a0a0a?style=flat-square)

`vinv-embedder` loads `ibm-granite/granite-embedding-small-english-r2` locally and serves embeddings over HTTP on `127.0.0.1` only (no auth by design). It picks the fastest available device automatically, batches and coalesces requests, and is safe to kill and restart at any time — the index owns durability.

| Command | Purpose |
| --- | --- |
| `vinv-embedder serve` | Start the embeddings server (localhost only). |
| `vinv-embedder warmup` | Download the model (with progress) and benchmark devices, then exit. |
| `vinv-embedder status` | Query a running server's `/health`. |

## `// 01 · install`

```bash
cd embedder
uv sync
uv run vinv-embedder --help
```

## `// 02 · run the server`

```bash
uv run vinv-embedder serve                 # http://127.0.0.1:8776/v1
uv run vinv-embedder serve --port 8776     # override the port
uv run vinv-embedder serve --device cpu    # force a device: auto | cuda | mps | cpu
```

The server binds `127.0.0.1` only and exposes:

| Route | Purpose |
| --- | --- |
| `POST /v1/embeddings` (also `/embeddings`) | OpenAI-shaped request: `{"model": str, "input": str \| [str, ...]}`. |
| `GET /health` | `{"status": "ok", "model", "device", "queue_depth", "warming"}`. |

A second `serve` on a port that already has a healthy server just reuses it rather than splitting traffic.

## `// 03 · the model`

On first run the sidecar downloads `ibm-granite/granite-embedding-small-english-r2` (~100 MB) from Hugging Face into `~/.vinv/models`, then serves from that cache. The default (native ModernBERT) needs no `trust_remote_code`. The optional `nomic-ai/CodeRankEmbed` override ships custom modeling code, so it alone is loaded with `trust_remote_code` at a pinned revision.

To download ahead of time (and pick the fastest device once) without starting the server:

```bash
uv run vinv-embedder warmup
```

`serve --device auto` also benchmarks each available device on the first start and remembers the winner in `~/.vinv/embedder_tuned.json` — the static `cuda > mps > cpu` order is only a guess (a small model can be several times faster on CPU than on Apple-Silicon MPS).

## `// 04 · config`

Everything has a sensible default; override with environment variables:

| Variable | Meaning | Default |
| --- | --- | --- |
| `VINV_HOME` | Base dir for Vinv state (model cache, tune verdict). | `~/.vinv` |
| `VINV_EMBED_DEVICE` | Force device: `cuda` \| `mps` \| `cpu`. | auto-detect |
| `VINV_EMBED_BATCH` | Force encode batch size. | per-device policy |
| `VINV_EMBED_WORKERS` | CPU multi-process pool size. | `cpu_count/2 - 1` (≤4) |
| `VINV_EMBED_MAX_SEQ` | Token cap per input; `0` = model default. | `1024` |
| `VINV_EMBED_MAX_ITEMS` | Max texts per request (else 413). | `2048` |
| `VINV_EMBED_NORMALIZE` | `0` to disable L2-normalized embeddings. | on |
| `VINV_EMBED_REVISION` | Override the pinned HF revision. | pinned |

Ports and cache directory are `--port` and `VINV_HOME`; the remaining `VINV_EMBED_*` knobs (queue depth, body size, CPU threads, result cache) are documented in `src/vinv_embedder/config.py`.

## `// 05 · how the index & extension consume it`

The index binary defaults to this sidecar: it embeds against `http://127.0.0.1:8776/v1`. Start the server, then index away:

```bash
uv run vinv-embedder serve      # in one terminal
index index /path/to/repo       # in another — no cloud, no key
```

Point `index` at a different endpoint with `INDEX_GATEWAY_URL` / `INDEX_EMBEDDING_MODEL` (see `../index/README.md`). The VS Code extension starts and health-checks this sidecar for you as part of indexing.

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
