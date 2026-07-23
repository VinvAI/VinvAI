//! Runtime configuration, resolved from environment variables.
//!
//! Configuration is under the `INDEX_` prefix. For convenience in existing
//! deployments, the gateway URL/key also fall back to the generic `LITELLM_*`
//! names, but `INDEX_*` takes precedence. When nothing is set, the gateway
//! defaults to the local embedding sidecar (`vinv-embedder serve`) at
//! `http://127.0.0.1:8776/v1`, with no API key.

use std::path::PathBuf;

use crate::constants;

/// Gateway connection + model selection for embeddings and summaries.
pub struct GatewayConfig {
    pub base_url: String,
    /// Empty means "send no Authorization header" — the local sidecar (and
    /// many self-hosted endpoints) require none.
    pub api_key: String,
    pub embedding_model: String,
    pub summary_model: String,
}

impl GatewayConfig {
    /// Resolve from the environment. Never fails: with nothing set, the
    /// gateway is the local embedding sidecar and no API key is sent.
    pub fn from_env() -> Self {
        let base_url = env_nonempty(constants::ENV_GATEWAY_URL)
            .or_else(|| env_nonempty(constants::ENV_GATEWAY_URL_FALLBACK))
            .unwrap_or_else(|| constants::DEFAULT_GATEWAY_URL.to_string());
        let api_key = env_nonempty(constants::ENV_GATEWAY_KEY)
            .or_else(|| env_nonempty(constants::ENV_GATEWAY_KEY_FALLBACK))
            .unwrap_or_default();
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            embedding_model: env_nonempty(constants::ENV_EMBEDDING_MODEL)
                .unwrap_or_else(|| constants::DEFAULT_EMBEDDING_MODEL.to_string()),
            summary_model: env_nonempty(constants::ENV_SUMMARY_MODEL)
                .unwrap_or_else(|| constants::DEFAULT_SUMMARY_MODEL.to_string()),
        }
    }

    /// Full URL for an OpenAI-style sub-path, e.g. `chat/completions`.
    pub fn endpoint(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path.trim_start_matches('/'))
    }
}

/// Legacy root directory used only when callers explicitly configure it.
pub fn store_root() -> PathBuf {
    if let Some(dir) = env_nonempty(constants::ENV_STORE_DIR) {
        return PathBuf::from(dir);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".vinv_index")
}

/// Resolve the concrete store directory for a repo.
///
/// An explicit `--store-dir` wins. Production's canonical default is kept
/// inside the repository at `<repo>/.vinv/index`; `INDEX_STORE_DIR` remains a
/// compatibility override for existing deployments.
pub fn resolve_store_dir(flag: Option<&str>, repo: &std::path::Path) -> PathBuf {
    if let Some(f) = flag {
        if !f.trim().is_empty() {
            return PathBuf::from(f);
        }
    }
    if std::env::var_os(constants::ENV_STORE_DIR).is_some() {
        return store_root().join(crate::store::repo_slug(repo));
    }
    repo.join(".vinv").join("index")
}

/// Weight of the PageRank importance prior in ranking, applied to
/// `ln(1 + rank)` so only genuine hubs move materially. Default 0.02 (a hub
/// with rank 0.6 gains about half a top RRF slot; the long tail gains ~1e-4).
/// Tune via `INDEX_RANK_WEIGHT` against an eval set; 0 disables it.
pub fn rank_weight() -> f32 {
    env_nonempty("INDEX_RANK_WEIGHT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.02)
}

/// Multiplier applied to the fused score of test-path chunks when the query
/// is not itself about tests (test names literally contain behavioral query
/// phrases and otherwise outrank the implementation they exercise).
/// `INDEX_TEST_PENALTY`, default 0.55; 1.0 disables the demotion.
pub fn test_penalty() -> f32 {
    env_nonempty("INDEX_TEST_PENALTY")
        .and_then(|v| v.parse().ok())
        .filter(|&v: &f32| (0.0..=1.0).contains(&v))
        .unwrap_or(0.55)
}

/// Module-vs-symbol representation swap (see `search::hybrid`): when a
/// synthetic whole-module chunk outranks the best specific symbol of the same
/// file, their fused scores are swapped so the symbol represents the file —
/// on vague behavioral queries the module blob's header docstring and
/// import/constant text otherwise outrank the exact function. The swap
/// preserves the score multiset, so file-level ranking is unchanged by
/// construction.
///
/// `INDEX_MODULE_SWAP_RATIO` is the evidence floor: the symbol must carry at
/// least this fraction of the blob's fused score to be promoted (a guard
/// against attributing the file's evidence to a pure-noise match, and against
/// demoting module chunks that are themselves the answer). `off` (or any
/// negative value) disables the swap entirely.
///
/// Default 0.5, chosen on the questions.vinv.json bench (2026-07-23, self
/// store at 4.3k symbols): symbol MRR 0.412 -> 0.507 on dev and
/// 0.373 -> 0.394 on holdout with no metric regressing on either split; the
/// more aggressive 0.0 scored higher on dev (0.527) but pushed a module-gold
/// holdout answer out of top-5.
pub fn module_swap_ratio() -> Option<f32> {
    const DEFAULT: f32 = 0.5;
    match env_nonempty("INDEX_MODULE_SWAP_RATIO") {
        Some(v) if matches!(v.as_str(), "off" | "none") => None,
        Some(v) => match v.parse::<f32>() {
            Ok(r) if r < 0.0 => None,
            Ok(r) => Some(r.min(1.0)),
            Err(_) => Some(DEFAULT),
        },
        None => Some(DEFAULT),
    }
}

/// When true, results keep only the best-scoring slice per (file, symbol) —
/// an oversized class split into linked continuations otherwise fills several
/// top-k slots with the same container. `INDEX_SPLIT_DEDUP`, default on;
/// set 0 to disable.
pub fn split_dedup() -> bool {
    env_nonempty("INDEX_SPLIT_DEDUP").as_deref() != Some("0")
}

/// How much of a symbol to embed. Default `docstring` (best exact-symbol
/// retrieval in benchmarks); `signature` favors file-level recall; `full` adds a
/// body head.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EmbedMode {
    Signature,
    Docstring,
    Full,
}

impl EmbedMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Signature => "signature",
            Self::Docstring => "docstring",
            Self::Full => "full",
        }
    }
}

pub fn embed_mode() -> EmbedMode {
    match env_nonempty("INDEX_EMBED_MODE").as_deref() {
        Some("signature") | Some("sig") => EmbedMode::Signature,
        Some("full") | Some("body") => EmbedMode::Full,
        _ => EmbedMode::Docstring,
    }
}

/// Concurrency for LLM symbol summarization. Default 8; `INDEX_SUMMARY_WORKERS`.
pub fn summary_workers() -> usize {
    env_nonempty("INDEX_SUMMARY_WORKERS")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(8)
}

/// Line budget per chunk before AST-aware continuation splitting kicks in.
/// `INDEX_MAX_SNIPPET_LINES`, default 300. Oversized symbols are split at
/// child-node boundaries into linked continuation chunks — never truncated.
pub fn max_snippet_lines() -> usize {
    env_nonempty("INDEX_MAX_SNIPPET_LINES")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 20)
        .unwrap_or(300)
}

/// RRF constant `K` in `1/(K + rank)`. `INDEX_RRF_K`, default 60 (the value
/// from the original RRF paper; sweep it against the eval set before changing).
pub fn rrf_k() -> f32 {
    env_nonempty("INDEX_RRF_K")
        .and_then(|v| v.parse().ok())
        .filter(|&v: &f32| v > 0.0)
        .unwrap_or(60.0)
}

/// Per-modality candidate cutoff for RRF. `INDEX_RRF_CANDIDATES`, default 200.
pub fn rrf_candidates() -> usize {
    env_nonempty("INDEX_RRF_CANDIDATES")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(200)
}

/// Boost added when a chunk is itself a `--context-symbols` seed.
/// `INDEX_CONTEXT_BOOST`, default 0.03.
pub fn context_boost() -> f32 {
    env_nonempty("INDEX_CONTEXT_BOOST")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.03)
}

/// Boost added when a chunk is graph-adjacent to a context seed.
/// `INDEX_ADJACENT_BOOST`, default 0.015.
pub fn adjacent_boost() -> f32 {
    env_nonempty("INDEX_ADJACENT_BOOST")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.015)
}

/// Estimated-token budget for per-hit graph context (neighbors), spent on the
/// highest personalized-PageRank neighbors first. `INDEX_CONTEXT_TOKEN_BUDGET`,
/// default 160 — sized to match the historical neighbors=8 output.
pub fn context_token_budget() -> usize {
    env_nonempty("INDEX_CONTEXT_TOKEN_BUDGET")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(320)
}

/// Hard cap on neighbors per hit regardless of budget. `INDEX_NEIGHBOR_CAP`,
/// default 8 (the historical value; raise together with the token budget).
pub fn neighbor_cap() -> usize {
    env_nonempty("INDEX_NEIGHBOR_CAP")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(12)
}

/// Slots reserved for direct callees (`calls`) before any other relation may
/// take one. `INDEX_CALLS_FLOOR`, default 6; clamped to `neighbor_cap()` at use.
/// Set to 0 to restore pure PageRank ordering across all relations.
pub fn calls_floor() -> usize {
    env_nonempty("INDEX_CALLS_FLOOR")
        .and_then(|v| v.parse().ok())
        .unwrap_or(6)
}

/// Whether to synthesize per-file module chunks (top-level imports/constants).
/// `INDEX_MODULE_CHUNKS` in {0,false,off} disables; default on. Kept as a knob
/// so the retrieval sweep can decide, not a hardcoded belief.
pub fn module_chunks() -> bool {
    !matches!(
        env_nonempty("INDEX_MODULE_CHUNKS").as_deref(),
        Some("0") | Some("false") | Some("off") | Some("no")
    )
}

/// Cap on parent-context entries per hit. `INDEX_PARENT_CAP`, default 8.
pub fn parent_cap() -> usize {
    env_nonempty("INDEX_PARENT_CAP")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(8)
}

/// Characters of the snippet echoed in query output. `INDEX_SNIPPET_OUT_CHARS`,
/// default 1200.
pub fn snippet_out_chars() -> usize {
    env_nonempty("INDEX_SNIPPET_OUT_CHARS")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 100)
        .unwrap_or(1200)
}

/// Docstring characters included in the embed input. `INDEX_EMBED_DOC_CHARS`,
/// default 600. Shapes what the embedding model sees, so retrieval quality —
/// tune together with the eval set, not by feel.
pub fn embed_doc_chars() -> usize {
    env_nonempty("INDEX_EMBED_DOC_CHARS")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 100)
        .unwrap_or(600)
}

/// Body lines appended in `EmbedMode::Full`. `INDEX_EMBED_BODY_LINES`, default 16.
pub fn embed_body_lines() -> usize {
    env_nonempty("INDEX_EMBED_BODY_LINES")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(16)
}

/// Total embed-input character ceiling in `EmbedMode::Full`.
/// `INDEX_EMBED_BODY_CHARS`, default 900.
pub fn embed_body_chars() -> usize {
    env_nonempty("INDEX_EMBED_BODY_CHARS")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 200)
        .unwrap_or(900)
}

/// How deep into a snippet the docstring scanner looks for an opening
/// delimiter. `INDEX_DOCSTRING_SCAN_CHARS`, default 400 — proportionally more
/// for files with long signatures/decorators is a legitimate override.
pub fn docstring_scan_chars() -> usize {
    env_nonempty("INDEX_DOCSTRING_SCAN_CHARS")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 100)
        .unwrap_or(400)
}

/// Leading lines scanned for JS/TS doc comments. `INDEX_COMMENT_DOC_LINES`,
/// default 6.
pub fn comment_doc_lines() -> usize {
    env_nonempty("INDEX_COMMENT_DOC_LINES")
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(6)
}

/// Hop radius for the local subgraph expansion. `INDEX_GRAPH_HOPS`, default 2.
/// Larger budgets can raise this to pull deeper context; the token budget and
/// neighbor cap still bound the result.
pub fn graph_hops() -> usize {
    env_nonempty("INDEX_GRAPH_HOPS")
        .and_then(|v| v.parse().ok())
        .filter(|&n| (1..=6).contains(&n))
        .unwrap_or(2)
}

/// Inputs per embeddings request. `INDEX_EMBED_BATCH`, default 64. Also the
/// durability granularity of resumable indexing (progress is fsynced per batch).
pub fn embed_batch() -> usize {
    env_nonempty(constants::ENV_EMBED_BATCH)
        .and_then(|v| v.parse().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(constants::DEFAULT_EMBED_BATCH)
}

/// Retries per embedding batch on connection / 429 / 5xx failures, with
/// exponential backoff. `INDEX_EMBED_MAX_RETRIES`, default 5 (~15s total).
pub fn embed_max_retries() -> u32 {
    env_nonempty(constants::ENV_EMBED_MAX_RETRIES)
        .and_then(|v| v.parse().ok())
        .unwrap_or(5)
}

fn env_nonempty(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_store_dir;
    use crate::constants;
    use std::path::{Path, PathBuf};

    #[test]
    fn explicit_store_wins() {
        assert_eq!(
            resolve_store_dir(Some("/tmp/custom-index"), Path::new("/repo")),
            PathBuf::from("/tmp/custom-index")
        );
    }

    #[test]
    fn repo_local_store_is_the_default() {
        if std::env::var_os(constants::ENV_STORE_DIR).is_none() {
            assert_eq!(
                resolve_store_dir(None, Path::new("/repo")),
                PathBuf::from("/repo/.vinv/index")
            );
        }
    }
}
