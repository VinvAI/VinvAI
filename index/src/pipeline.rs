//! Command orchestration for `index` / `query` / `update`.
//!
//! Every command prints a one-line JSON result and exits non-zero on error.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

use ignore::WalkBuilder;
use serde_json::{json, Value};

use crate::bm25::{self, Bm25};
use crate::cli::Command;
use crate::config::{self, EmbedMode, GatewayConfig};
use crate::embed::Embedder;
use crate::graph;
use crate::parse::{self, lang_for_extension};
use crate::resume;
use crate::search;
use crate::store::{Chunk, Store, STORE_VERSION};
use crate::summarize;
use crate::util::{self, sha256_hex};

/// A parsed file awaiting summarization/embedding.
struct ParsedFile {
    rel: String,
    lang: &'static str,
    symbols: Vec<parse::Symbol>,
}

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", ".venv", "venv", "dist", "build", "target",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea",
    ".vscode", "vendor", ".next", "coverage",
    // Vinv's own metadata dir: the index store, captures, logs — and anything
    // an agent parks there (e.g. a bring-up venv) — must never be indexed.
    ".vinv",
];

struct SourceFile {
    rel: String,
    abs: PathBuf,
    lang: &'static str,
}

/// Phase timing to stderr, opt-in via `INDEX_TIMING=1` — used to attribute
/// index/update wall time to pipeline phases (parse, embed, graph, BM25, IO)
/// without a profiler. Output lines: `TIMING <label>: <ms>ms`.
fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let t0 = std::time::Instant::now();
    let out = f();
    if std::env::var("INDEX_TIMING").ok().as_deref() == Some("1") {
        eprintln!("TIMING {label}: {:.1}ms", t0.elapsed().as_secs_f64() * 1000.0);
    }
    out
}

pub fn run(cmd: Command) -> i32 {
    let result = match cmd {
        Command::Index { path, store_dir, languages, force, summarize } => {
            cmd_index(&path, store_dir.as_deref(), languages, force, !summarize)
        }
        Command::Deadcode { path, include, show_probable, reasons, json } => {
            crate::deadcode::run(&path, include.as_deref(), show_probable, reasons, json)
        }
        Command::Query { text, repo_path, store_dir, top_k, context_symbols, explain } => {
            cmd_query(&text, repo_path.as_deref(), store_dir.as_deref(), top_k, context_symbols.as_deref(), explain)
        }
        Command::Update { path, store_dir, languages, summarize, skip_embeddings } => {
            cmd_update(&path, store_dir.as_deref(), languages, !summarize, skip_embeddings)
        }
    };

    match result {
        // A command that already wrote its own report returns Null rather than
        // a document; printing `null` after it is noise.
        Ok(Value::Null) => 0,
        Ok(v) => {
            util::print_json(&v);
            0
        }
        Err(e) => {
            util::print_error(&e);
            1
        }
    }
}

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

fn cmd_index(
    path: &str,
    store_dir: Option<&str>,
    languages: Option<String>,
    force: bool,
    no_summarize: bool,
) -> Result<Value, String> {
    let repo = fs::canonicalize(path).map_err(|e| format!("repo path {path:?}: {e}"))?;
    let summary_cfg = summary_config(no_summarize);
    let embedder = Embedder::from_env();
    let langs = parse_langs(languages.as_deref());
    let dir = config::resolve_store_dir(store_dir, &repo);

    // Cache-aware: without --force, reuse an existing index's unchanged files
    // (only new/changed files are re-embedded). --force does a full rebuild.
    // An unreadable/corrupt store is treated like a missing one — fall through
    // to the full build below rather than failing every retry at load.
    if !force {
        if let Some(old) = load_or_rebuild(&dir) {
            return incremental(
                &repo,
                &dir,
                &embedder,
                old,
                IncrementalOptions {
                    summary_cfg: summary_cfg.as_ref(),
                    langs: &langs,
                    no_summarize,
                    operation: "index",
                },
            );
        }
    }

    // Full build.
    let files = timed("collect_files", || collect_files(&repo, &langs));
    let (parsed, manifest) = timed("read+parse", || read_and_parse_all(&files));

    let representation_mode = config::embed_mode();
    let (mut chunks, inputs) = timed("build_chunks", || build_chunks(
        parsed,
        summary_cfg.as_ref(),
        no_summarize,
        representation_mode,
    ));
    // Resumable: progress is persisted per batch, so an interrupted run (a
    // crash, or the embedding sidecar going down) continues from the last
    // durable row on the next invocation instead of starting over.
    let vectors = timed("embed", || resume::embed_with_resume(&embedder, &dir, &chunks, &inputs))?;
    let dim = vectors.first().map(Vec::len).unwrap_or(0);

    // Even a --force rebuild carries epochs over for content-identical chunks,
    // so a rebuild without code changes does not invalidate runtime captures.
    let previous = timed("reload_previous", || Store::load(dir.clone()).ok().flatten());
    let epoch = assign_epochs(&mut chunks, previous.as_ref());

    let overrides = load_edge_overrides(&dir, &chunks);
    let (edges, ranks, pending_edges, graph_stats) =
        timed("graph_build", || graph::build_with_stats(&chunks, &overrides));
    write_pending_edges(&dir, &chunks, &pending_edges);
    apply_ranks(&mut chunks, &ranks);
    apply_tag_overrides(&dir, &mut chunks);
    let bm25 = timed("bm25_build", || build_bm25(&chunks));

    let mut store = Store::empty(
        dir.clone(),
        repo.to_string_lossy().into_owned(),
        embedder.model_id(),
        summary_model_name(summary_cfg.as_ref()),
        Some(embedder.backend().to_string()),
        representation_mode.as_str().to_string(),
    );
    store.epoch = epoch;
    store.dim = dim;
    store.chunks = chunks;
    store.vectors = vectors.into_iter().flatten().collect();
    store.edges = edges;
    store.manifest = manifest;
    store.bm25 = Some(bm25);
    timed("store_save", || store.save())?;
    // The committed store supersedes the embedding progress files.
    resume::clear(&dir);

    Ok(json!({
        "status": "ok",
        "operation": "index",
        "epoch": epoch,
        "repo": repo.to_string_lossy(),
        "index_dir": dir.to_string_lossy(),
        "files": files.len(),
        "symbols": store.chunks.len(),
        "edges": store.edges.len(),
        "dim": dim,
        "pending_edges": pending_edges.len(),
        "pending_suppressed": suppression_json(&graph_stats),
    }))
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

fn cmd_query(
    text: &str,
    repo_path: Option<&str>,
    store_dir: Option<&str>,
    top_k: usize,
    context_symbols: Option<&str>,
    explain: bool,
) -> Result<Value, String> {
    let dir = resolve_query_dir(repo_path, store_dir)?;

    let store = Store::load(dir)?
        .ok_or_else(|| "no index found — run `index index <path>` first".to_string())?;

    // Indexes built by old proprietary builds with the in-process local
    // embedder cannot be queried through the gateway (different vector space).
    if store.embedding_backend.as_deref() == Some("local") {
        return Err(
            "this index was built with the removed in-process local embedder — rebuild it \
             with `index index <repo> --force`"
                .to_string(),
        );
    }
    // The embedder applies its own query instruction; the raw text still feeds BM25.
    let embedder = Embedder::from_env();
    let query_model = embedder.model_id();
    if store.embedding_model != query_model {
        return Err(format!(
            "query embedding model {query_model} does not match index model {} — rebuild with \
             `index index --force` (or set INDEX_EMBEDDING_MODEL to match)",
            store.embedding_model
        ));
    }
    let qvec = embedder.embed_query(text)?;
    if store.dim != 0 && qvec.len() != store.dim {
        return Err(format!(
            "query embedding dim {} != index dim {} — the embedding model changed; rebuild with `index index --force`",
            qvec.len(),
            store.dim
        ));
    }

    // Resolve --context-symbols names to chunk indices.
    let context = resolve_context(&store, context_symbols);

    let hits = search::hybrid(&store, &qvec, text, top_k, &context);
    let results: Vec<Value> = hits.iter().map(|hit| render_hit(&store, hit, explain)).collect();

    Ok(json!({
        "status": "ok",
        "operation": "query",
        "query": text,
        "count": results.len(),
        "results": results,
    }))
}

fn render_hit(store: &Store, hit: &search::Hit, explain: bool) -> Value {
    let c = &store.chunks[hit.index];
    let neighbors: Vec<Value> = graph::neighbors(
        hit.index,
        &store.chunks,
        &store.edges,
        config::neighbor_cap(),
        config::context_token_budget(),
    )
    .into_iter()
    .map(|(j, rel)| {
        let nc = &store.chunks[j];
        json!({ "name": nc.name, "kind": nc.kind, "file": nc.file, "relation": rel })
    })
    .collect();
    let parents: Vec<Value> = graph::parent_context(
        hit.index,
        &store.chunks,
        &store.edges,
        config::parent_cap(),
    )
        .into_iter()
        .map(|j| {
            let pc = &store.chunks[j];
            json!({ "name": pc.name, "kind": pc.kind, "file": pc.file, "lines": [pc.start_line, pc.end_line] })
        })
        .collect();

    let mut out = json!({
        "score": hit.score,
        "file": c.file,
        "name": c.name,
        "kind": c.kind,
        "lang": c.lang,
        "lines": [c.start_line, c.end_line],
        "rank": c.rank,
        "summary": c.summary,
        "snippet": truncate(&c.text, config::snippet_out_chars()),
        "parent_context": parents,
        "neighbors": neighbors,
    });

    // The per-modality score breakdown (dense/sparse RRF + priors) is a
    // debug/eval aid, emitted only under `--explain`.
    if explain {
        let vals = [
            hit.dense_rrf,
            hit.sparse_rrf,
            hit.rank_prior,
            hit.structural_boost,
            hit.path_prior,
            hit.module_prior,
        ];
        let mut comp = serde_json::Map::new();
        for (k, v) in crate::constants::SCORE_COMPONENT_KEYS.iter().zip(vals) {
            comp.insert(k.to_string(), json!(v));
        }
        if let Some(obj) = out.as_object_mut() {
            obj.insert(crate::constants::SCORE_COMPONENTS_KEY.to_string(), Value::Object(comp));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

fn cmd_update(
    path: &str,
    store_dir: Option<&str>,
    languages: Option<String>,
    no_summarize: bool,
    skip_embeddings: bool,
) -> Result<Value, String> {
    let repo = fs::canonicalize(path).map_err(|e| format!("repo path {path:?}: {e}"))?;
    let langs = parse_langs(languages.as_deref());
    let dir = config::resolve_store_dir(store_dir, &repo);

    let old = load_or_rebuild(&dir);

    // Dry-run: report the diff without embedding or writing.
    if skip_embeddings {
        let files = collect_files(&repo, &langs);
        let empty = BTreeMap::new();
        let manifest = old.as_ref().map(|s| &s.manifest).unwrap_or(&empty);
        let mut added = 0;
        let mut changed = 0;
        let mut current_rels: HashSet<String> = HashSet::new();
        for sf in &files {
            let sha = match read_and_hash(&sf.abs) {
                Some((_, s)) => s,
                None => continue,
            };
            current_rels.insert(sf.rel.clone());
            match manifest.get(&sf.rel) {
                Some(old_sha) if *old_sha == sha => {}
                Some(_) => changed += 1,
                None => added += 1,
            }
        }
        let removed = manifest.keys().filter(|k| !current_rels.contains(k.as_str())).count();
        return Ok(json!({
            "status": "ok",
            "operation": "update",
            "dry_run": true,
            "repo": repo.to_string_lossy(),
            "files": current_rels.len(),
            "added": added,
            "changed": changed,
            "removed": removed,
        }));
    }

    let summary_cfg = summary_config(no_summarize);
    match old {
        Some(s) => {
            let embedder = Embedder::from_env();
            incremental(
                &repo,
                &dir,
                &embedder,
                s,
                IncrementalOptions {
                    summary_cfg: summary_cfg.as_ref(),
                    langs: &langs,
                    no_summarize,
                    operation: "update",
                },
            )
        }
        // No existing store — fall through to a full build.
        None => cmd_index(path, store_dir, languages, false, no_summarize),
    }
}

/// Incremental (re)build: reuse unchanged files' chunks/vectors from `old`,
/// re-process only new/changed files (their summaries run on the worker pool),
/// then rebuild the graph and BM25 over the merged set. Shared by
/// `update` and by `index` without `--force`.
struct IncrementalOptions<'a> {
    summary_cfg: Option<&'a GatewayConfig>,
    langs: &'a Option<Vec<&'static str>>,
    no_summarize: bool,
    operation: &'a str,
}

fn vectors_are_reusable(
    old: &Store,
    embedding_model: &str,
    embedding_backend: &str,
    representation_mode: EmbedMode,
) -> bool {
    old.embedding_model == embedding_model
        && old.embedding_backend.as_deref() == Some(embedding_backend)
        && old.representation_mode == representation_mode.as_str()
}

/// Rebuild an unchanged file's chunks from a fresh parse, grafting each old
/// chunk's summary, pending flag and embedding vector onto the new symbol by
/// chunk id. This is the format-migration path (e.g. v4 → v5, which changed
/// only the parse-derived `calls` field): summaries and vectors are functions
/// of the snippet and summary text, neither of which a structural change
/// touches, so regenerating them through the gateway would spend hours of
/// API calls to reproduce byte-identical data.
///
/// Returns `None` when old and new chunking disagree (a chunk id without a
/// match on the other side) — the caller must reprocess the file wholesale,
/// embedding included, rather than guess.
fn graft_file(
    rel: &str,
    lang: &str,
    symbols: Vec<parse::Symbol>,
    old_entries: Option<&Vec<(Chunk, Vec<f32>)>>,
) -> Option<Vec<(Chunk, Vec<f32>)>> {
    let entries = old_entries?;
    if entries.len() != symbols.len() {
        return None;
    }
    let by_id: HashMap<&str, &(Chunk, Vec<f32>)> =
        entries.iter().map(|entry| (entry.0.id.as_str(), entry)).collect();
    let mut out = Vec::with_capacity(symbols.len());
    for sym in symbols {
        let id = format!("{}:{}-{}:{}", rel, sym.start_line, sym.end_line, sym.name);
        let (old_chunk, row) = by_id.get(id.as_str())?;
        out.push((
            Chunk {
                id,
                file: rel.to_string(),
                lang: lang.to_string(),
                kind: sym.kind,
                name: sym.name,
                start_line: sym.start_line,
                end_line: sym.end_line,
                sha: sha256_hex(sym.snippet.as_bytes()),
                summary: old_chunk.summary.clone(),
                text: sym.snippet,
                parent: sym.parent,
                calls: sym.calls,
                bases: sym.bases,
                // Learned tags survive a structural refresh: the symbol is the
                // same, only the store format changed.
                tags: old_chunk.tags.clone(),
                rank: 0.0,
                summary_pending: old_chunk.summary_pending,
                epoch: 0, // assigned by assign_epochs before save
            },
            row.clone(),
        ));
    }
    Some(out)
}

fn incremental(
    repo: &Path,
    dir: &Path,
    embedder: &Embedder,
    mut old: Store,
    options: IncrementalOptions<'_>,
) -> Result<Value, String> {
    let IncrementalOptions { summary_cfg, langs, no_summarize, operation } = options;
    let embedding_model = embedder.model_id();
    let embedding_backend = embedder.backend();
    let representation_mode = config::embed_mode();
    let can_reuse = vectors_are_reusable(
        &old,
        &embedding_model,
        embedding_backend,
        representation_mode,
    );
    // Same embeddings, older store format: unchanged files take the structural
    // refresh below — a fresh local parse with the old summary and vector
    // grafted on — instead of verbatim chunk reuse, which would carry the old
    // format's stale parse fields (v4's receiver-stripped `calls`) forward
    // under a current version stamp.
    let verbatim_reuse = can_reuse && old.version == STORE_VERSION;
    let mut old_by_file: BTreeMap<String, Vec<(Chunk, Vec<f32>)>> = BTreeMap::new();
    if can_reuse {
        timed("clone_old_store", || {
            for (i, c) in old.chunks.iter().enumerate() {
                old_by_file.entry(c.file.clone()).or_default().push((c.clone(), old.row(i).to_vec()));
            }
        });
    }

    let files = timed("collect_files", || collect_files(repo, langs));
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut vectors: Vec<f32> = Vec::new();
    let mut manifest: BTreeMap<String, String> = BTreeMap::new();
    let mut dim = if can_reuse { old.dim } else { 0 };
    let mut reused = 0usize;
    let mut refreshed = 0usize;
    let mut reprocessed = 0usize;
    let mut changed: Vec<ParsedFile> = Vec::new();

    // Files whose chunks carry a pending (heuristic) summary are re-queued
    // even when their content hash matches: LLM failure degrades temporarily,
    // never permanently.
    let pending_files: HashSet<&str> = old
        .chunks
        .iter()
        .filter(|c| c.summary_pending)
        .map(|c| c.file.as_str())
        .collect();

    let t_scan = std::time::Instant::now();
    for sf in &files {
        let (content, sha) = match read_and_hash(&sf.abs) {
            Some(pair) => pair,
            None => continue,
        };
        manifest.insert(sf.rel.clone(), sha.clone());
        let requeue = !no_summarize && pending_files.contains(sf.rel.as_str());
        let unchanged = can_reuse && !requeue && old.manifest.get(&sf.rel) == Some(&sha);
        if unchanged && verbatim_reuse {
            reused += 1;
            if let Some(entries) = old_by_file.get(&sf.rel) {
                for (chunk, row) in entries {
                    chunks.push(chunk.clone());
                    vectors.extend_from_slice(row);
                }
            }
            continue;
        }
        if unchanged {
            // Format migration: re-parse locally, keep the paid-for artifacts.
            let symbols = parse::extract(sf.lang, &content, &module_name(&sf.rel));
            match graft_file(&sf.rel, sf.lang, symbols, old_by_file.get(&sf.rel)) {
                Some(grafted) => {
                    refreshed += 1;
                    for (chunk, row) in grafted {
                        chunks.push(chunk);
                        vectors.extend_from_slice(&row);
                    }
                    continue;
                }
                None => {
                    // Chunking disagreed across versions — reprocess this file.
                }
            }
        }
        reprocessed += 1;
        changed.push(ParsedFile { rel: sf.rel.clone(), lang: sf.lang, symbols: parse::extract(sf.lang, &content, &module_name(&sf.rel)) });
    }
    if std::env::var("INDEX_TIMING").ok().as_deref() == Some("1") {
        eprintln!("TIMING scan+reuse: {:.1}ms", t_scan.elapsed().as_secs_f64() * 1000.0);
    }

    if !changed.is_empty() {
        let (new_chunks, inputs) =
            build_chunks(changed, summary_cfg, no_summarize, representation_mode);
        if !inputs.is_empty() {
            // Resumable, like the full build: an interrupted update continues
            // from the last durable row on the next invocation.
            let new_vectors = resume::embed_with_resume(embedder, dir, &new_chunks, &inputs)?;
            let nd = new_vectors.first().map(Vec::len).unwrap_or(dim);
            if dim == 0 {
                dim = nd;
            } else if nd != 0 && nd != dim {
                return Err(format!(
                    "embedding dim changed ({nd} vs {dim}) — rebuild with `index index --force`"
                ));
            }
            for (chunk, vec) in new_chunks.into_iter().zip(new_vectors) {
                chunks.push(chunk);
                vectors.extend(vec);
            }
        }
    }

    let epoch = assign_epochs(&mut chunks, Some(&old));

    let overrides = load_edge_overrides(dir, &chunks);
    let (edges, ranks, pending_edges, graph_stats) =
        timed("graph_build", || graph::build_with_stats(&chunks, &overrides));
    write_pending_edges(dir, &chunks, &pending_edges);
    apply_ranks(&mut chunks, &ranks);
    apply_tag_overrides(dir, &mut chunks);
    // Maintain the BM25 index incrementally: subtract the changed/deleted
    // docs' postings, add the new ones, and renumber slots to the new row
    // order. Rebuilding from scratch was the dominant cost of an update
    // (~170ms of ~270ms at 4k symbols) and grew linearly with the corpus;
    // the incremental path costs O(changed docs) tokenization plus an
    // integer slot remap. Any inconsistency falls back to a full rebuild.
    let bm25 = match timed("bm25_incremental", || incremental_bm25(&mut old, &chunks)) {
        Some(prev) => prev,
        None => timed("bm25_build", || build_bm25(&chunks)),
    };

    let mut store = Store::empty(
        dir.to_path_buf(),
        repo.to_string_lossy().into_owned(),
        embedding_model,
        summary_model_name(summary_cfg),
        Some(embedding_backend.to_string()),
        representation_mode.as_str().to_string(),
    );
    store.epoch = epoch;
    store.dim = dim;
    store.chunks = chunks;
    store.vectors = vectors;
    store.edges = edges;
    store.manifest = manifest;
    store.bm25 = Some(bm25);
    timed("store_save", || store.save())?;
    // The committed store supersedes the embedding progress files.
    resume::clear(dir);

    Ok(json!({
        "status": "ok",
        "operation": operation,
        "epoch": epoch,
        "repo": repo.to_string_lossy(),
        "index_dir": dir.to_string_lossy(),
        "files": files.len(),
        "reused_files": reused,
        "refreshed_files": refreshed,
        "reprocessed_files": reprocessed,
        "symbols": store.chunks.len(),
        "edges": store.edges.len(),
        "dim": dim,
        "pending_edges": pending_edges.len(),
        "pending_suppressed": suppression_json(&graph_stats),
    }))
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/// References the graph deliberately kept out of `pending_edges.jsonl`, by
/// reason. Reported on every index/update so a queue that shrinks by two
/// thirds can account for it — an unexplained drop reads as a broken index.
fn suppression_json(stats: &graph::BuildStats) -> Value {
    json!({
        "cross_lang": stats.cross_lang,
        "external_receiver": stats.external_receiver,
        "generic_name": stats.generic_name,
        "resolved_by_lang": stats.resolved_by_lang,
    })
}

fn apply_ranks(chunks: &mut [Chunk], ranks: &[f32]) {
    for (c, r) in chunks.iter_mut().zip(ranks) {
        c.rank = *r;
    }
}

/// Assign content epochs and return the store epoch.
///
/// A chunk keeps its previous epoch when its content (`id` + `sha`) is
/// unchanged; new or changed chunks get `previous store epoch + 1`. The store
/// epoch only advances when some chunk actually changed (or one disappeared),
/// so re-running index/update over unchanged code is epoch-neutral and does
/// not invalidate runtime captures.
fn assign_epochs(chunks: &mut [Chunk], previous: Option<&Store>) -> u64 {
    let (prev_epoch, prev_chunks) = match previous {
        Some(s) => (s.epoch, s.chunks.as_slice()),
        None => (0, &[][..]),
    };
    let old: HashMap<(&str, &str), u64> =
        prev_chunks.iter().map(|c| ((c.id.as_str(), c.sha.as_str()), c.epoch)).collect();
    let candidate = prev_epoch + 1;
    let mut changed = chunks.len() != prev_chunks.len();
    for c in chunks.iter_mut() {
        match old.get(&(c.id.as_str(), c.sha.as_str())) {
            Some(&e) => c.epoch = e,
            None => {
                c.epoch = candidate;
                changed = true;
            }
        }
    }
    if changed {
        candidate
    } else {
        prev_epoch
    }
}

/// `Store::load` for the (re)build paths, demoting an unreadable or corrupt
/// store to "no store" with a warning. Building must fall back to a full
/// rebuild in that case — propagating the load error made every retry fail
/// deterministically at load, which is how a single torn save used to become
/// a permanent "corrupt index" loop. Query paths still propagate load errors:
/// they have no rebuild to fall back to.
fn load_or_rebuild(dir: &Path) -> Option<Store> {
    match timed("store_load", || Store::load(dir.to_path_buf())) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "index: warning — existing store at {} is unreadable ({e}); \
                 falling back to a full rebuild",
                dir.display()
            );
            None
        }
    }
}

fn resolve_query_dir(repo_path: Option<&str>, store_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(sd) = store_dir {
        if !sd.trim().is_empty() {
            return Ok(PathBuf::from(sd));
        }
    }
    if let Some(rp) = repo_path {
        let repo = fs::canonicalize(rp).map_err(|e| format!("repo path {rp:?}: {e}"))?;
        return Ok(config::resolve_store_dir(None, &repo));
    }
    Err("provide --repo-path or --store-dir".to_string())
}

fn resolve_context(store: &Store, context_symbols: Option<&str>) -> HashSet<usize> {
    let mut out = HashSet::new();
    let spec = match context_symbols {
        Some(s) if !s.trim().is_empty() => s,
        _ => return out,
    };
    let wanted: HashSet<String> = spec.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    for (i, c) in store.chunks.iter().enumerate() {
        if wanted.contains(&c.name) {
            out.insert(i);
        }
    }
    out
}

/// Gateway config for LLM summaries. Only present when `--summarize` was
/// passed — the default build needs no chat-capable endpoint at all.
fn summary_config(no_summarize: bool) -> Option<GatewayConfig> {
    if no_summarize {
        None
    } else {
        Some(GatewayConfig::from_env())
    }
}

/// Summary model name to record in the store (empty when not summarizing).
fn summary_model_name(cfg: Option<&GatewayConfig>) -> String {
    cfg.map(|c| c.summary_model.clone()).unwrap_or_default()
}

/// Parse → parallel-summarize → build aligned (chunk, embed-input) pairs for a
/// batch of already-parsed files. Summaries run across the whole batch on a
/// bounded worker pool (the dominant cost of a full index).
fn build_chunks(
    parsed: Vec<ParsedFile>,
    summary_cfg: Option<&GatewayConfig>,
    no_summarize: bool,
    mode: EmbedMode,
) -> (Vec<Chunk>, Vec<String>) {
    let mut summaries = parallel_summaries(&parsed, summary_cfg, no_summarize);
    let total: usize = parsed.iter().map(|p| p.symbols.len()).sum();
    let mut chunks = Vec::with_capacity(total);
    let mut inputs = Vec::with_capacity(total);

    let mut ji = 0usize;
    for pf in parsed {
        let rel = pf.rel;
        let lang = pf.lang;
        for sym in pf.symbols {
            let (summary, summary_pending) = std::mem::take(&mut summaries[ji]);
            ji += 1;
            let id = format!("{}:{}-{}:{}", rel, sym.start_line, sym.end_line, sym.name);
            inputs.push(build_embed_text(&mode, &sym.kind, &sym.name, sym.parent.as_deref(), &summary, &sym.snippet));
            chunks.push(Chunk {
                id,
                file: rel.clone(),
                lang: lang.to_string(),
                kind: sym.kind,
                name: sym.name,
                start_line: sym.start_line,
                end_line: sym.end_line,
                sha: sha256_hex(sym.snippet.as_bytes()),
                summary,
                text: sym.snippet,
                parent: sym.parent,
                calls: sym.calls,
                bases: sym.bases,
                tags: Vec::new(), // merged from tag_overrides.jsonl before save
                rank: 0.0,
                summary_pending,
                epoch: 0, // assigned by assign_epochs before save

            });
        }
    }

    (chunks, inputs)
}

/// Summarize every symbol across `parsed`, concurrently over a bounded worker
/// pool. Doc chunks embed their own natural-language text (a summary of prose
/// adds nothing), and `no_summarize` is an explicit caller choice — neither is
/// pending. An LLM *failure* after bounded retries embeds the heuristic but
/// marks the chunk `summary_pending`, so the next `update` re-queues the file
/// instead of freezing the degradation in place. Output order is aligned to
/// the flattened (file, symbol) order.
fn parallel_summaries(
    parsed: &[ParsedFile],
    summary_cfg: Option<&GatewayConfig>,
    no_summarize: bool,
) -> Vec<(String, bool)> {
    let flat: Vec<(&'static str, &str, &str, &str, bool)> = parsed
        .iter()
        .flat_map(|pf| {
            let is_doc = !parse::is_code(pf.lang);
            pf.symbols
                .iter()
                .map(move |s| (pf.lang, s.kind.as_str(), s.name.as_str(), s.snippet.as_str(), is_doc))
        })
        .collect();
    let n = flat.len();
    if n == 0 {
        return Vec::new();
    }
    // No LLM summaries unless explicitly requested (`--summarize`): the
    // heuristic is the caller's explicit choice here, not a silent degradation.
    let cfg = match summary_cfg {
        Some(_) if !no_summarize => summary_cfg.unwrap(),
        _ => {
            return flat
                .iter()
                .map(|(_, k, nm, sn, _)| (summarize::heuristic(k, nm, sn), false))
                .collect()
        }
    };

    let mut out = vec![(String::new(), false); n];
    let counter = AtomicUsize::new(0);
    let fallbacks = AtomicUsize::new(0);
    let workers = config::summary_workers().min(n);
    let (tx, rx) = mpsc::channel::<(usize, String, bool)>();

    std::thread::scope(|scope| {
        for _ in 0..workers {
            let tx = tx.clone();
            let flat = &flat;
            let counter = &counter;
            let fallbacks = &fallbacks;
            scope.spawn(move || loop {
                let i = counter.fetch_add(1, Ordering::Relaxed);
                if i >= n {
                    break;
                }
                let (lang, kind, name, snippet, is_doc) = flat[i];
                let (summary, pending) = if is_doc {
                    (summarize::heuristic(kind, name, snippet), false)
                } else {
                    match summarize::summarize(cfg, lang, kind, name, snippet) {
                        Ok(s) if !s.is_empty() => (s, false),
                        _ => {
                            fallbacks.fetch_add(1, Ordering::Relaxed);
                            (summarize::heuristic(kind, name, snippet), true)
                        }
                    }
                };
                let _ = tx.send((i, summary, pending));
            });
        }
        drop(tx);
        for (i, s, pending) in rx {
            out[i] = (s, pending);
        }
    });

    let fb = fallbacks.load(Ordering::Relaxed);
    if fb > 0 {
        eprintln!(
            "index: warning — {fb} summaries failed after retries; their chunks are \
             marked pending and will be re-queued on the next update"
        );
    }
    out
}

/// Adjudicated edge overrides from the agent layer:
/// `<store>/edge_overrides.jsonl`, one `{"src_id", "dst_id", "kind"?}` per
/// line. Chunk ids that no longer exist are skipped — the reference re-appears
/// in `pending_edges.jsonl` and gets re-adjudicated.
fn load_edge_overrides(dir: &Path, chunks: &[Chunk]) -> Vec<crate::store::Edge> {
    let path = dir.join("edge_overrides.jsonl");
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let by_id: BTreeMap<&str, usize> =
        chunks.iter().enumerate().map(|(i, c)| (c.id.as_str(), i)).collect();
    let mut out = Vec::new();
    for line in content.lines() {
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let src = value.get("src_id").and_then(Value::as_str).and_then(|id| by_id.get(id));
        let dst = value.get("dst_id").and_then(Value::as_str).and_then(|id| by_id.get(id));
        if let (Some(&src), Some(&dst)) = (src, dst) {
            let kind = value
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("invoke")
                .to_string();
            out.push(crate::store::Edge { src, dst, kind });
        }
    }
    out
}

/// Publish unresolved cross-file references for the adjudication layer:
/// `<store>/pending_edges.jsonl`, one record per ambiguous reference with the
/// caller chunk and every candidate definition.
fn write_pending_edges(dir: &Path, chunks: &[Chunk], pending: &[graph::PendingEdge]) {
    let path = dir.join("pending_edges.jsonl");
    if pending.is_empty() {
        let _ = fs::remove_file(&path);
        return;
    }
    let mut lines = String::new();
    for p in pending {
        let src = &chunks[p.src];
        let record = json!({
            "src_id": src.id,
            "src_file": src.file,
            "src_name": src.name,
            "src_lang": src.lang,
            "name": p.name,
            "candidates": p.candidates.iter().map(|&i| {
                let c = &chunks[i];
                json!({
                    "id": c.id,
                    "file": c.file,
                    "kind": c.kind,
                    "lang": c.lang,
                    "summary": c.summary,
                })
            }).collect::<Vec<_>>(),
        });
        lines.push_str(&record.to_string());
        lines.push('\n');
    }
    if fs::create_dir_all(dir).is_ok() {
        let _ = fs::write(&path, lines);
    }
}

/// True when two chunks produce byte-identical BM25 documents — exactly the
/// fields `bm25::doc_for` concatenates.
fn bm25_docs_identical(o: &Chunk, c: &Chunk) -> bool {
    o.name == c.name && o.summary == c.summary && o.text == c.text && o.tags == c.tags
}

/// Update the previous store's BM25 index in place to match `chunks`, instead
/// of rebuilding it from scratch.
///
/// The on-disk BM25 is slot-aligned with the old store's rows (every save
/// finishes with a `remap` to row order), so the diff is computed by chunk id:
/// a new chunk whose id exists in the old store with an identical BM25
/// document keeps that slot; everything else is removed (old side) or added
/// (new side), then slots are renumbered to the new row order. Only the
/// changed documents are tokenized — the remap is pure integer work.
///
/// Returns `None` — meaning the caller must do a full rebuild — when the old
/// store's format is stale, the BM25 is missing or misaligned, or any postings
/// arithmetic fails verification (`remove_doc` cross-checks every term count
/// against the stored postings, so a corrupt store degrades to a rebuild, not
/// to silently wrong scores).
fn incremental_bm25(old: &mut Store, chunks: &[Chunk]) -> Option<Bm25> {
    if old.version != STORE_VERSION {
        return None;
    }
    let mut bm25 = old.bm25.take()?;
    if !bm25.is_current_format() || bm25.doc_count() != old.chunks.len() {
        return None;
    }
    let old_by_id: HashMap<&str, usize> =
        old.chunks.iter().enumerate().map(|(i, c)| (c.id.as_str(), i)).collect();
    if old_by_id.len() != old.chunks.len() {
        return None; // duplicate ids — positional diffing would be ambiguous
    }

    // Plan each new row: keep an old slot, or add as a fresh document.
    let mut survived = vec![false; old.chunks.len()];
    let mut kept_slot: Vec<Option<usize>> = Vec::with_capacity(chunks.len());
    for c in chunks {
        let slot = match old_by_id.get(c.id.as_str()) {
            Some(&r) if !survived[r] && bm25_docs_identical(&old.chunks[r], c) => {
                survived[r] = true;
                Some(r)
            }
            _ => None,
        };
        kept_slot.push(slot);
    }

    // Fast path: byte-identical corpus in the same order — nothing to do.
    let identity = chunks.len() == old.chunks.len()
        && kept_slot.iter().enumerate().all(|(row, slot)| *slot == Some(row));
    if identity {
        return Some(bm25);
    }

    // Subtract removed/changed docs (tokenizing their exact old text), then
    // append the new/changed ones; fresh slots are handed out sequentially.
    let mut new_row_of_slot: Vec<Option<u32>> = vec![None; old.chunks.len()];
    for (r, c) in old.chunks.iter().enumerate() {
        if !survived[r] {
            let text = bm25::doc_for(&c.name, &c.summary, &c.text, &c.tags);
            if let Err(e) = bm25.remove_doc(r, &text) {
                eprintln!("index: warning — BM25 incremental update failed ({e}); rebuilding");
                return None;
            }
        }
    }
    for (row, (slot, c)) in kept_slot.iter().zip(chunks).enumerate() {
        let slot = match slot {
            Some(s) => *s,
            None => bm25.add_doc(&bm25::doc_for(&c.name, &c.summary, &c.text, &c.tags)),
        };
        if slot >= new_row_of_slot.len() {
            new_row_of_slot.resize(slot + 1, None);
        }
        new_row_of_slot[slot] = Some(row as u32);
    }
    if let Err(e) = bm25.remap(&new_row_of_slot, chunks.len()) {
        eprintln!("index: warning — BM25 incremental update failed ({e}); rebuilding");
        return None;
    }
    Some(bm25)
}

/// Build the BM25 lexical index over the chunk set (once, at index time).
fn build_bm25(chunks: &[Chunk]) -> Bm25 {
    let docs: Vec<String> =
        chunks.iter().map(|c| bm25::doc_for(&c.name, &c.summary, &c.text, &c.tags)).collect();
    Bm25::build(&docs)
}

/// Learned lexical aliases from the retrieval-feedback agent:
/// `<store>/tag_overrides.jsonl`, one `{"id", "tags": [..]}` per line (later
/// lines for the same id replace earlier ones, so the file is append-friendly).
/// Applied to the chunk set before the BM25 build, so feedback vocabulary
/// becomes searchable on the next index/update. Ids that no longer exist fall
/// back to a (file, name) match only when that pair is unambiguous — a moved
/// symbol keeps its aliases, a duplicated name never guesses.
///
/// The override file is the single source of truth: every chunk's tags are
/// cleared first, so deleting a line (or the file) actually removes the alias
/// on the next update instead of surviving forever in reused chunks.
fn apply_tag_overrides(dir: &Path, chunks: &mut [Chunk]) -> usize {
    for c in chunks.iter_mut() {
        c.tags.clear();
    }
    let path = dir.join("tag_overrides.jsonl");
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return 0,
    };
    let by_id: BTreeMap<String, usize> =
        chunks.iter().enumerate().map(|(i, c)| (c.id.clone(), i)).collect();
    // (file, name) -> row, with ambiguous pairs poisoned to usize::MAX.
    let mut by_loc: BTreeMap<(String, String), usize> = BTreeMap::new();
    for (i, c) in chunks.iter().enumerate() {
        by_loc
            .entry((c.file.clone(), c.name.clone()))
            .and_modify(|v| *v = usize::MAX)
            .or_insert(i);
    }
    let mut applied = 0usize;
    for line in content.lines() {
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let tags: Vec<String> = match value.get("tags").and_then(Value::as_array) {
            Some(list) => list
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect(),
            None => continue,
        };
        let id = match value.get("id").and_then(Value::as_str) {
            Some(id) => id,
            None => continue,
        };
        let row = by_id.get(id).copied().or_else(|| {
            // "file:start-end:name" — recover (file, name) for the loose match.
            let (file, rest) = id.split_once(':')?;
            let (_, name) = rest.rsplit_once(':')?;
            match by_loc.get(&(file.to_string(), name.to_string())) {
                Some(&r) if r != usize::MAX => Some(r),
                _ => None,
            }
        });
        if let Some(row) = row {
            chunks[row].tags = tags;
            applied += 1;
        }
    }
    applied
}

/// Build the text embedded for a symbol: identifier + enclosing container +
/// signature + docstring (+ a real LLM summary when present). The docstring is
/// the natural-language intent that behavioral queries match against; the raw
/// body is deliberately NOT included — it dilutes the match with code tokens.
fn build_embed_text(mode: &EmbedMode, kind: &str, name: &str, parent: Option<&str>, summary: &str, snippet: &str) -> String {
    let mut s = String::new();
    s.push_str(kind);
    s.push(' ');
    s.push_str(name);
    if let Some(p) = parent {
        s.push_str(" in ");
        s.push_str(p);
    }
    s.push('\n');

    // Signature (first non-empty line of the snippet) — always included.
    let sig = snippet.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if !sig.is_empty() {
        s.push_str(sig);
        s.push('\n');
    }
    if matches!(mode, EmbedMode::Signature) {
        return s;
    }

    // A genuine LLM summary adds intent; skip the heuristic "kind name: sig"
    // form, which just repeats the signature.
    let heuristic_prefix = format!("{kind} {name}");
    if !summary.is_empty() && !summary.starts_with(&heuristic_prefix) {
        s.push_str(summary);
        s.push('\n');
    }

    // Docstring / leading doc comment (bounded by config, not a literal —
    // these budgets shape the embedding and therefore retrieval quality).
    let doc = extract_docstring(snippet);
    if !doc.is_empty() {
        let doc: String = doc.chars().take(config::embed_doc_chars()).collect();
        s.push_str(&doc);
        s.push('\n');
    }

    // `full` mode also appends a bounded head of the body.
    if matches!(mode, EmbedMode::Full) {
        let max_lines = config::embed_body_lines();
        let max_chars = config::embed_body_chars();
        for (i, line) in snippet.lines().enumerate() {
            if i >= max_lines || s.len() > max_chars {
                break;
            }
            s.push_str(line);
            s.push('\n');
        }
    }
    s
}

/// Extract the first docstring-like block near the top of a snippet: a Python
/// triple-quoted string or a JS/TS block/line doc comment. Empty if none.
fn extract_docstring(snippet: &str) -> String {
    for delim in ["\"\"\"", "'''"] {
        if let Some(start) = snippet.find(delim) {
            if start < config::docstring_scan_chars() {
                let after = &snippet[start + delim.len()..];
                if let Some(end) = after.find(delim) {
                    let doc = after[..end].trim();
                    if !doc.is_empty() {
                        return doc.to_string();
                    }
                }
            }
        }
    }
    // JS/TS: a leading /** ... */ or // comment among the first lines.
    let mut comment = String::new();
    for line in snippet.lines().take(config::comment_doc_lines()) {
        let t = line.trim();
        let cleaned = t
            .trim_start_matches("/**")
            .trim_start_matches("*/")
            .trim_start_matches("///")
            .trim_start_matches("//")
            .trim_start_matches('*')
            .trim();
        if (t.starts_with("//") || t.starts_with("/*") || t.starts_with('*')) && !cleaned.is_empty() {
            if !comment.is_empty() {
                comment.push(' ');
            }
            comment.push_str(cleaned);
        }
    }
    comment
}

/// Name for a file's synthetic module chunk: the file stem.
fn module_name(rel: &str) -> String {
    Path::new(rel)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("module")
        .to_string()
}

/// Read, hash, and parse every source file, in parallel across a worker pool
/// (Tree-sitter parsing is CPU-bound and per-file independent; this stage was
/// the dominant non-embedding cost of a full build when run sequentially).
/// Output preserves `files` order exactly — chunk order is store row order.
fn read_and_parse_all(files: &[SourceFile]) -> (Vec<ParsedFile>, BTreeMap<String, String>) {
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(files.len().max(1));
    let mut slots: Vec<Option<(ParsedFile, String)>> = Vec::with_capacity(files.len());
    slots.resize_with(files.len(), || None);

    if workers <= 1 {
        for (slot, sf) in slots.iter_mut().zip(files) {
            *slot = read_hash_parse(sf);
        }
    } else {
        // Work-stealing via a shared atomic cursor; results flow back over a
        // channel and are placed into their ordered slot by the main thread.
        let counter = AtomicUsize::new(0);
        let (tx, rx) = mpsc::channel::<(usize, Option<(ParsedFile, String)>)>();
        std::thread::scope(|scope| {
            for _ in 0..workers {
                let tx = tx.clone();
                let counter = &counter;
                scope.spawn(move || loop {
                    let i = counter.fetch_add(1, Ordering::Relaxed);
                    if i >= files.len() {
                        break;
                    }
                    let _ = tx.send((i, read_hash_parse(&files[i])));
                });
            }
            drop(tx);
            for (i, parsed) in rx {
                slots[i] = parsed;
            }
        });
    }

    let mut parsed = Vec::with_capacity(files.len());
    let mut manifest = BTreeMap::new();
    for slot in slots {
        if let Some((pf, sha)) = slot {
            manifest.insert(pf.rel.clone(), sha);
            parsed.push(pf);
        }
    }
    (parsed, manifest)
}

fn read_hash_parse(sf: &SourceFile) -> Option<(ParsedFile, String)> {
    let (content, sha) = read_and_hash(&sf.abs)?;
    let symbols = parse::extract(sf.lang, &content, &module_name(&sf.rel));
    Some((ParsedFile { rel: sf.rel.clone(), lang: sf.lang, symbols }, sha))
}

fn read_and_hash(path: &Path) -> Option<(String, String)> {
    let bytes = fs::read(path).ok()?;
    let sha = sha256_hex(&bytes);
    Some((String::from_utf8_lossy(&bytes).into_owned(), sha))
}

fn collect_files(repo: &Path, langs: &Option<Vec<&'static str>>) -> Vec<SourceFile> {
    let mut out = Vec::new();
    let mut builder = WalkBuilder::new(repo);
    // The selected root may contain multiple repositories. Honor each nested
    // .gitignore even when the root itself is not a Git repository; otherwise
    // downloaded runtimes such as vinv-vs/.vscode-test become bogus source.
    builder
        .hidden(false)
        .require_git(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(|entry| {
            !entry.file_type().is_some_and(|kind| {
                kind.is_dir() && SKIP_DIRS.contains(&entry.file_name().to_str().unwrap_or(""))
            })
        });

    for entry in builder.build().flatten() {
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let ext = match entry.path().extension().and_then(|s| s.to_str()) {
            Some(e) => e,
            None => continue,
        };
        let lang = match lang_for_extension(ext) {
            Some(l) => l,
            None => continue,
        };
        if let Some(allow) = langs {
            if !allow.contains(&lang) {
                continue;
            }
        }
        let rel = match entry.path().strip_prefix(repo) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => entry.path().to_string_lossy().replace('\\', "/"),
        };
        out.push(SourceFile { rel, abs: entry.path().to_path_buf(), lang });
    }

    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

/// Parse a `--languages a,b` value into a normalized allow-list. `doc` is
/// included implicitly unless the user restricts languages.
fn parse_langs(spec: Option<&str>) -> Option<Vec<&'static str>> {
    let spec = spec?;
    let mut langs = Vec::new();
    for token in spec.split(',') {
        let name = match token.trim().to_ascii_lowercase().as_str() {
            "python" | "py" => Some("python"),
            "javascript" | "js" => Some("javascript"),
            "typescript" | "ts" => Some("typescript"),
            "tsx" => Some("tsx"),
            "doc" | "docs" | "markdown" | "md" => Some("doc"),
            _ => None,
        };
        if let Some(l) = name {
            if !langs.contains(&l) {
                langs.push(l);
            }
            if l == "typescript" && !langs.contains(&"tsx") {
                langs.push("tsx");
            }
        }
    }
    if langs.is_empty() {
        None
    } else {
        Some(langs)
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk_with(id: &str, sha: &str, epoch: u64) -> Chunk {
        Chunk {
            id: id.to_string(),
            file: "f.py".to_string(),
            lang: "python".to_string(),
            kind: "function".to_string(),
            name: id.to_string(),
            start_line: 1,
            end_line: 2,
            sha: sha.to_string(),
            summary: String::new(),
            text: String::new(),
            parent: None,
            calls: Vec::new(),
            bases: Vec::new(),
            tags: Vec::new(),
            rank: 0.0,
            summary_pending: false,
            epoch,
        }
    }

    #[test]
    fn tag_overrides_apply_by_id_then_unambiguous_location_and_last_line_wins() {
        let dir = std::env::temp_dir().join(format!("vinv-tags-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // Ids follow the real "file:start-end:name" shape so the loose match
        // can recover (file, name) when an edit moved the symbol.
        let mut a = chunk_with("a.py:1-2:alpha", "s", 0);
        a.file = "a.py".to_string();
        a.name = "alpha".to_string();
        let mut b = chunk_with("b.py:5-9:beta", "s", 0);
        b.file = "b.py".to_string();
        b.name = "beta".to_string();
        // Two chunks share (file, name): the loose match must refuse to guess.
        // c1 also carries a stale tag from a previous run — with no override
        // line for it, the tag must be CLEARED (the file is the only truth).
        let mut c1 = chunk_with("c.py:1-3:gamma", "s", 0);
        c1.file = "c.py".to_string();
        c1.name = "gamma".to_string();
        c1.tags = vec!["stale-from-last-run".to_string()];
        let mut c2 = chunk_with("c.py:7-9:gamma", "s", 0);
        c2.file = "c.py".to_string();
        c2.name = "gamma".to_string();
        let mut chunks = vec![a, b, c1, c2];

        fs::write(
            dir.join("tag_overrides.jsonl"),
            concat!(
                "{\"id\": \"a.py:1-2:alpha\", \"tags\": [\"stale\"]}\n",
                "{\"id\": \"a.py:1-2:alpha\", \"tags\": [\"auth\", \"login\"]}\n",
                "{\"id\": \"b.py:1-1:beta\", \"tags\": [\"moved\"]}\n",
                "{\"id\": \"c.py:1-1:gamma\", \"tags\": [\"never\"]}\n",
                "not json\n",
            ),
        )
        .unwrap();

        let applied = apply_tag_overrides(&dir, &mut chunks);
        assert_eq!(applied, 3, "two exact-id lines (last wins) + one loose match");
        assert_eq!(chunks[0].tags, vec!["auth", "login"], "later line replaced the earlier");
        assert_eq!(chunks[1].tags, vec!["moved"], "stale id recovered via (file, name)");
        assert!(
            chunks[2].tags.is_empty() && chunks[3].tags.is_empty(),
            "ambiguous never guesses, and tags absent from the file are cleared"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn structural_refresh_grafts_summaries_and_vectors_onto_fresh_parse() {
        let mut old_chunk = chunk_with("f.py:1-2:handler", "oldsha", 3);
        old_chunk.name = "handler".to_string();
        old_chunk.summary = "keeps this summary".to_string();
        old_chunk.calls = vec!["get_binary".to_string()]; // v4: receiver stripped
        old_chunk.summary_pending = true;
        let entries = vec![(old_chunk, vec![0.5f32, 0.25])];
        let symbols = vec![parse::Symbol {
            kind: "function".to_string(),
            name: "handler".to_string(),
            start_line: 1,
            end_line: 2,
            snippet: "def handler(): ...".to_string(),
            parent: None,
            calls: vec!["binary_controller.get_binary".to_string()], // v5
            bases: Vec::new(),
        }];

        let grafted = graft_file("f.py", "python", symbols, Some(&entries)).unwrap();

        assert_eq!(grafted.len(), 1);
        let (chunk, row) = &grafted[0];
        assert_eq!(chunk.summary, "keeps this summary", "paid-for summary survives");
        assert!(chunk.summary_pending, "pending flag survives so requeue still fires");
        assert_eq!(row, &vec![0.5f32, 0.25], "paid-for vector survives");
        assert_eq!(
            chunk.calls,
            vec!["binary_controller.get_binary"],
            "parse-derived fields come from the fresh parse"
        );
        assert_eq!(chunk.sha, sha256_hex("def handler(): ...".as_bytes()));

        // Chunking disagreement (id without a match) must refuse to graft so
        // the caller reprocesses the file instead of dropping its vector.
        let moved = vec![parse::Symbol {
            kind: "function".to_string(),
            name: "handler".to_string(),
            start_line: 3,
            end_line: 4,
            snippet: String::new(),
            parent: None,
            calls: Vec::new(),
            bases: Vec::new(),
        }];
        assert!(graft_file("f.py", "python", moved, Some(&entries)).is_none());
    }

    #[test]
    fn epochs_advance_only_when_content_changes() {
        let mut prev_store = Store::empty(
            PathBuf::from("/tmp/index"),
            "/repo".to_string(),
            "m".to_string(),
            "s".to_string(),
            Some("gateway".to_string()),
            "docstring".to_string(),
        );
        prev_store.epoch = 3;
        prev_store.chunks = vec![chunk_with("a", "sha-a", 1), chunk_with("b", "sha-b", 3)];

        // Unchanged content: epochs carried over, store epoch stays put.
        let mut same = vec![chunk_with("a", "sha-a", 0), chunk_with("b", "sha-b", 0)];
        assert_eq!(assign_epochs(&mut same, Some(&prev_store)), 3);
        assert_eq!(same[0].epoch, 1);
        assert_eq!(same[1].epoch, 3);

        // One chunk's body changed: it gets epoch 4, the other keeps its own.
        let mut edited = vec![chunk_with("a", "sha-a2", 0), chunk_with("b", "sha-b", 0)];
        assert_eq!(assign_epochs(&mut edited, Some(&prev_store)), 4);
        assert_eq!(edited[0].epoch, 4);
        assert_eq!(edited[1].epoch, 3);

        // A removed chunk also advances the store epoch.
        let mut removed = vec![chunk_with("a", "sha-a", 0)];
        assert_eq!(assign_epochs(&mut removed, Some(&prev_store)), 4);

        // First build with no previous store starts at epoch 1.
        let mut fresh = vec![chunk_with("a", "sha-a", 0)];
        assert_eq!(assign_epochs(&mut fresh, None), 1);
        assert_eq!(fresh[0].epoch, 1);
    }

    fn store_with_bm25(chunks: Vec<Chunk>) -> Store {
        let mut store = Store::empty(
            PathBuf::from("/tmp/index"),
            "/repo".to_string(),
            "m".to_string(),
            String::new(),
            Some("gateway".to_string()),
            "docstring".to_string(),
        );
        store.bm25 = Some(build_bm25(&chunks));
        store.chunks = chunks;
        store
    }

    #[test]
    fn incremental_bm25_handles_edit_delete_add_and_reorder() {
        let mut a = chunk_with("f.py:1-2:a", "sha-a", 1);
        a.text = "def a(): parse_config()".to_string();
        let mut b = chunk_with("f.py:4-6:b", "sha-b", 1);
        b.text = "def b(): send_email()".to_string();
        let mut store = store_with_bm25(vec![a.clone(), b.clone()]);

        // Edit a, delete b, add c, and put the new doc first.
        let mut a2 = a.clone();
        a2.text = "def a(): parse_config(path)".to_string();
        a2.sha = "sha-a2".to_string();
        let mut c = chunk_with("g.py:1-2:c", "sha-c", 2);
        c.text = "def c(): retry_gateway()".to_string();
        let new_chunks = vec![c, a2];

        let updated = incremental_bm25(&mut store, &new_chunks).expect("incremental path");
        assert_eq!(updated, build_bm25(&new_chunks), "must equal a from-scratch build");
        // Sanity: the updated index actually scores the new content.
        assert!(updated.scores("retry_gateway")[0] > 0.0);
        assert_eq!(updated.scores("send_email"), vec![0.0, 0.0], "deleted doc is gone");
    }

    #[test]
    fn incremental_bm25_identity_returns_prebuilt_index_untouched() {
        let mut a = chunk_with("f.py:1-2:a", "sha-a", 1);
        a.text = "def a(): pass".to_string();
        let mut store = store_with_bm25(vec![a.clone()]);
        let reused = incremental_bm25(&mut store, std::slice::from_ref(&a)).unwrap();
        assert_eq!(reused, build_bm25(std::slice::from_ref(&a)));
        assert!(store.bm25.is_none(), "the index is moved out of the old store");
    }

    #[test]
    fn incremental_bm25_refuses_stale_or_misaligned_stores() {
        let mut a = chunk_with("f.py:1-2:a", "sha-a", 1);
        a.text = "def a(): pass".to_string();

        // Old store format version: full rebuild.
        let mut store = store_with_bm25(vec![a.clone()]);
        store.version = STORE_VERSION - 1;
        assert!(incremental_bm25(&mut store, std::slice::from_ref(&a)).is_none());

        // No prebuilt BM25 at all.
        let mut store = store_with_bm25(vec![a.clone()]);
        store.bm25 = None;
        assert!(incremental_bm25(&mut store, std::slice::from_ref(&a)).is_none());

        // BM25 doc count misaligned with the store's chunk rows.
        let mut store = store_with_bm25(vec![a.clone()]);
        store.chunks.push(chunk_with("g.py:1-1:b", "sha-b", 1));
        assert!(incremental_bm25(&mut store, std::slice::from_ref(&a)).is_none());
    }

    /// Deterministic xorshift PRNG — no test-only rand dependency.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn random_text(rng: &mut Rng) -> String {
        const VOCAB: [&str; 12] = [
            "parse", "config", "retryGateway", "send_email", "HTTPServer", "token",
            "index", "query", "update", "chunk", "score", "def",
        ];
        let words: Vec<&str> = (0..3 + rng.below(20)).map(|_| VOCAB[rng.below(VOCAB.len())]).collect();
        words.join(" ")
    }

    /// Property: over random edit sequences (edit / delete / insert, with the
    /// row order shifting every step), the incrementally maintained BM25 is
    /// exactly equal to a from-scratch build over the surviving corpus.
    #[test]
    fn incremental_bm25_equals_full_rebuild_over_random_edit_sequences() {
        for seed in 1..=5u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15));
            let mut next_id = 0usize;
            let mut fresh_chunk = |rng: &mut Rng| {
                let id = next_id;
                next_id += 1;
                let mut c = chunk_with(&format!("f{}.py:1-2:sym{id}", id % 7), "sha", 1);
                c.text = random_text(rng);
                c.summary = random_text(rng);
                c
            };
            let mut corpus: Vec<Chunk> = (0..12).map(|_| fresh_chunk(&mut rng)).collect();
            let mut store = store_with_bm25(corpus.clone());

            for _step in 0..10 {
                for _edit in 0..1 + rng.below(4) {
                    match rng.below(3) {
                        0 if !corpus.is_empty() => {
                            // Edit: new text under the same id (same row).
                            let i = rng.below(corpus.len());
                            corpus[i].text = random_text(&mut rng);
                        }
                        1 if !corpus.is_empty() => {
                            corpus.remove(rng.below(corpus.len()));
                        }
                        _ => {
                            // Insert at an arbitrary row, shifting later rows.
                            let at = rng.below(corpus.len() + 1);
                            let c = fresh_chunk(&mut rng);
                            corpus.insert(at, c);
                        }
                    }
                }
                let updated = incremental_bm25(&mut store, &corpus)
                    .expect("aligned store must take the incremental path");
                let scratch = build_bm25(&corpus);
                assert_eq!(updated, scratch, "seed {seed}: incremental != from-scratch");
                store = store_with_bm25(corpus.clone());
                store.bm25 = Some(updated);
            }
        }
    }

    #[test]
    fn parallel_read_and_parse_preserves_collect_order() {
        let root = std::env::temp_dir().join(format!("vinv-par-parse-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        // Enough files to exercise the worker pool, with distinct symbols.
        for i in 0..40 {
            fs::write(
                root.join(format!("f{i:02}.py")),
                format!("def fn_{i:02}():\n    return {i}\n"),
            )
            .unwrap();
        }
        let files = collect_files(&root, &None);
        let (parsed, manifest) = read_and_parse_all(&files);
        assert_eq!(parsed.len(), 40);
        assert_eq!(manifest.len(), 40);
        let rels: Vec<&str> = parsed.iter().map(|p| p.rel.as_str()).collect();
        let expected: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, expected, "parsed output must preserve sorted file order");
        // Each file's symbols came from that file (module chunk + function).
        assert!(parsed[7].symbols.iter().any(|s| s.name == "fn_07"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn query_and_index_share_the_same_default_store() {
        let repo = fs::canonicalize(".").unwrap();
        assert_eq!(
            resolve_query_dir(Some("."), None).unwrap(),
            config::resolve_store_dir(None, &repo)
        );
    }

    #[test]
    fn vector_reuse_requires_exact_embedding_identity() {
        let store = Store::empty(
            PathBuf::from("/tmp/index"),
            "/repo".to_string(),
            "model-a".to_string(),
            "summary".to_string(),
            Some("gateway".to_string()),
            "docstring".to_string(),
        );
        assert!(vectors_are_reusable(
            &store,
            "model-a",
            "gateway",
            EmbedMode::Docstring
        ));
        assert!(!vectors_are_reusable(
            &store,
            "model-b",
            "gateway",
            EmbedMode::Docstring
        ));
        assert!(!vectors_are_reusable(
            &store,
            "model-a",
            "local",
            EmbedMode::Docstring
        ));
        assert!(!vectors_are_reusable(
            &store,
            "model-a",
            "gateway",
            EmbedMode::Full
        ));
    }

    #[test]
    fn legacy_metadata_cannot_reuse_vectors() {
        let store = Store::empty(
            PathBuf::from("/tmp/index"),
            "/repo".to_string(),
            "model-a".to_string(),
            "summary".to_string(),
            None,
            "unknown".to_string(),
        );
        assert!(!vectors_are_reusable(
            &store,
            "model-a",
            "gateway",
            EmbedMode::Docstring
        ));
    }

    #[test]
    fn collection_honors_nested_gitignores_outside_a_git_root() {
        let root =
            std::env::temp_dir().join(format!("vinv-index-ignore-{}", uuid::Uuid::new_v4()));
        let repo = root.join("extension");
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::create_dir_all(repo.join(".vscode-test/runtime")).unwrap();
        fs::write(repo.join(".gitignore"), ".vscode-test/\nout/\n").unwrap();
        fs::write(repo.join("src/extension.ts"), "export function activate() {}\n").unwrap();
        fs::write(
            repo.join(".vscode-test/runtime/workbench.js"),
            "function generatedRuntimeSymbol() {}\n",
        )
        .unwrap();

        let files = collect_files(&root, &None);
        let paths: Vec<&str> = files.iter().map(|file| file.rel.as_str()).collect();
        assert!(paths.contains(&"extension/src/extension.ts"));
        assert!(!paths.iter().any(|path| path.contains(".vscode-test")));

        fs::remove_dir_all(root).unwrap();
    }
}
