//! Command-line surface: `index`, `query`, `update`.

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "index",
    version,
    about = "Semantic code index — build, search, and update a natural-language \
             searchable index of a repository."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Build (or rebuild) the index for a repository.
    Index {
        /// Path to the repository to index.
        path: String,
        /// Index store directory (overrides the configured default).
        #[arg(long = "store-dir")]
        store_dir: Option<String>,
        /// Restrict to a comma-separated language list (e.g. `python,typescript`).
        #[arg(long)]
        languages: Option<String>,
        /// Rebuild from scratch even if an index already exists.
        #[arg(long)]
        force: bool,
        /// Also generate one-sentence LLM summaries per symbol via the
        /// gateway's `chat/completions` (needs a chat-capable endpoint —
        /// point INDEX_GATEWAY_URL / LITELLM_BASE_URL at one). Off by
        /// default: the local embedding sidecar serves embeddings only.
        #[arg(long)]
        summarize: bool,
    },

    /// Search the index with a natural-language query.
    Query {
        /// The natural-language query.
        text: String,
        /// Path of the repository whose index to search.
        #[arg(long = "repo-path")]
        repo_path: Option<String>,
        /// Index store directory (overrides --repo-path resolution).
        #[arg(long = "store-dir")]
        store_dir: Option<String>,
        /// Number of results to return.
        #[arg(long = "top-k", default_value_t = 8)]
        top_k: usize,
        /// Comma-separated symbol names for structural (graph) boosting.
        #[arg(long = "context-symbols")]
        context_symbols: Option<String>,
        /// Emit the internal per-modality score breakdown for each hit
        /// (debug/eval aid).
        #[arg(long = "explain", hide = true)]
        explain: bool,
    },

    /// Incrementally sync the index with the current repo state.
    Update {
        /// Path to the repository to sync.
        path: String,
        /// Index store directory (overrides the configured default).
        #[arg(long = "store-dir")]
        store_dir: Option<String>,
        /// Restrict to a comma-separated language list.
        #[arg(long)]
        languages: Option<String>,
        /// Generate LLM summaries for re-processed symbols (see `index --summarize`).
        #[arg(long)]
        summarize: bool,
        /// Diff only: report what changed without re-embedding (dry run).
        #[arg(long = "skip-embeddings")]
        skip_embeddings: bool,
    },
}
