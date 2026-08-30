//! Plain compile-time constants: env-var names, defaults, and prompt text.
//!
//! Everything here used to live in an encrypted "vault" sealed at build time.
//! The open-source build has nothing to hide — these are ordinary constants.

// --- Gateway / model selection -------------------------------------------

/// OpenAI-compatible gateway base URL (including any `/v1` path).
pub const ENV_GATEWAY_URL: &str = "INDEX_GATEWAY_URL";
/// Fallback for people already pointing `LITELLM_BASE_URL` at their own endpoint.
pub const ENV_GATEWAY_URL_FALLBACK: &str = "LITELLM_BASE_URL";
/// Optional API key. When unset, requests carry no Authorization header.
pub const ENV_GATEWAY_KEY: &str = "INDEX_GATEWAY_KEY";
pub const ENV_GATEWAY_KEY_FALLBACK: &str = "LITELLM_API_KEY";
pub const ENV_EMBEDDING_MODEL: &str = "INDEX_EMBEDDING_MODEL";
pub const ENV_SUMMARY_MODEL: &str = "INDEX_SUMMARY_MODEL";
pub const ENV_STORE_DIR: &str = "INDEX_STORE_DIR";
/// Embedding request batch size (default [`DEFAULT_EMBED_BATCH`]).
pub const ENV_EMBED_BATCH: &str = "INDEX_EMBED_BATCH";
/// Retries per embedding batch on transport / 429 / 5xx failures (default 5).
pub const ENV_EMBED_MAX_RETRIES: &str = "INDEX_EMBED_MAX_RETRIES";

/// The local embedding sidecar (`vinv-embedder serve`) listens here by default.
pub const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:8776/v1";
/// Default embedding model. granite-embedding-small-english-r2 (47M, 384-dim,
/// 8192-ctx, code-aware) replaced nomic-ai/CodeRankEmbed (137M, 768-dim): ~3x
/// smaller per embedder worker for the same retrieval quality on the repo eval
/// (holdout file MRR 0.81 vs 0.64), so the CPU embed pool can run wider. Set
/// `INDEX_EMBEDDING_MODEL` to override (e.g. back to nomic-ai/CodeRankEmbed).
pub const DEFAULT_EMBEDDING_MODEL: &str = "ibm-granite/granite-embedding-small-english-r2";
pub const DEFAULT_SUMMARY_MODEL: &str = "gpt-4o-mini";
pub const DEFAULT_EMBED_BATCH: usize = 64;

/// Query-side retrieval instruction. Queries are embedded with exactly this
/// prefix; documents/passages are embedded WITHOUT any prefix. Retained across
/// the granite migration (the eval that cleared granite used it) — a per-model
/// instruction is a live tuning knob, not a fixed CodeRankEmbed requirement.
pub const EMBED_QUERY_PREFIX: &str = "Represent this query for searching relevant code: ";

// --- LLM summaries (opt-in via --summarize) ------------------------------

pub const SUMMARY_SYSTEM_PROMPT: &str = "You describe code symbols so they can be found by \
natural-language search. Reply with ONE plain sentence describing what the symbol does. \
No preamble, no code, no markdown.";

pub const SUMMARY_USER_TEMPLATE: &str =
    "Language: {lang}\nSymbol: {kind} `{name}`\n\n```{lang}\n{code}\n```";

pub const SUMMARY_REPAIR_INSTRUCTION: &str = "That reply was rejected: {reason}. Reply again \
with exactly ONE plain sentence describing what the symbol does — no markdown, no code.";

// --- Query output ---------------------------------------------------------

/// Key holding the per-modality score breakdown under `--explain`.
pub const SCORE_COMPONENTS_KEY: &str = "score_components";
/// Component field names, in the order search::Hit exposes them.
pub const SCORE_COMPONENT_KEYS: [&str; 6] =
    ["dense_rrf", "sparse_rrf", "rank_prior", "structural_boost", "path_prior", "module_prior"];
