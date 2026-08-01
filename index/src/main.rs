//! `index` — a standalone semantic code-index CLI.
//!
//! Parses a repository into symbols, embeds each symbol's identifier +
//! signature + docstring (optionally an LLM summary), builds a code graph
//! over them, and stores everything in a local index that can be searched in
//! natural language (hybrid dense + BM25 retrieval with a PageRank prior).

mod bm25;
mod cli;
mod config;
mod deadcode;
mod constants;
mod embed;
mod graph;
mod parse;
mod pipeline;
mod resume;
mod search;
mod store;
mod summarize;
mod util;

use clap::Parser;

fn main() {
    let args = cli::Cli::parse();
    std::process::exit(pipeline::run(args.command));
}
