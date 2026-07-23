//! Hybrid retrieval: dense (cosine) + lexical (BM25), fused with Reciprocal
//! Rank Fusion, then adjusted by a small PageRank importance prior and optional
//! structural (`--context-symbols`) boosting.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

use crate::bm25::{self, Bm25};
use crate::config;
use crate::graph;
use crate::store::Store;

pub struct Hit {
    pub index: usize,
    pub score: f32,
    pub dense_rrf: f32,
    pub sparse_rrf: f32,
    pub rank_prior: f32,
    pub structural_boost: f32,
    /// Negative adjustment applied to test/fixture chunks on non-test queries
    /// (0.0 when the chunk is not demoted), so components still sum to `score`.
    pub path_prior: f32,
    /// Negative adjustment applied to a whole-module chunk when a specific
    /// symbol in the same file also matched (0.0 otherwise), so components
    /// still sum to `score`.
    pub module_prior: f32,
}

/// Rank chunks for a query. `context` holds chunk indices named via
/// `--context-symbols`; empty disables structural boosting.
pub fn hybrid(
    store: &Store,
    query_vec: &[f32],
    query_text: &str,
    k: usize,
    context: &HashSet<usize>,
) -> Vec<Hit> {
    let n = store.chunks.len();
    if n == 0 {
        return Vec::new();
    }

    // Dense cosine.
    let mut dense = vec![0.0f32; n];
    if store.dim > 0 && query_vec.len() == store.dim {
        let qn = norm(query_vec);
        if qn > 0.0 {
            for (i, score) in dense.iter_mut().enumerate() {
                let row = store.row(i);
                let rn = norm(row);
                *score = if rn > 0.0 { dot(query_vec, row) / (qn * rn) } else { 0.0 };
            }
        }
    }

    // Lexical BM25: use the prebuilt index if present, else rebuild (older store).
    let sparse = match &store.bm25 {
        Some(b) => b.scores(query_text),
        None => {
            let docs: Vec<String> = store
                .chunks
                .iter()
                .map(|c| bm25::doc_for(&c.name, &c.summary, &c.text, &c.tags))
                .collect();
            Bm25::build(&docs).scores(query_text)
        }
    };

    // Reciprocal Rank Fusion of the two rankings.
    let dense_rrf = rrf(&dense, false);
    let sparse_rrf = rrf(&sparse, true);
    let mut rank_prior = vec![0.0f32; n];
    let mut structural_boost = vec![0.0f32; n];
    let mut fused: Vec<f32> = dense_rrf
        .iter()
        .zip(&sparse_rrf)
        .map(|(dense_score, sparse_score)| dense_score + sparse_score)
        .collect();

    // PageRank importance prior (weight is tunable via INDEX_RANK_WEIGHT).
    // Log-scaled so genuine hubs (rank ≫ typical) gain a few RRF positions
    // while the long tail of ordinary chunks is barely nudged.
    let rank_weight = config::rank_weight();
    if rank_weight != 0.0 {
        for (i, c) in store.chunks.iter().enumerate() {
            rank_prior[i] = rank_weight * (1.0 + c.rank).ln();
            fused[i] += rank_prior[i];
        }
    }

    // Behavioral queries want the implementation, not the tests that exercise
    // it — test files literally contain the query's phrases in their names and
    // otherwise outrank the code they test. Demote test-path chunks unless the
    // query itself is about tests. Multiplicative, so order within test files
    // is preserved; recorded as a negative component to keep the sum invariant.
    let mut path_prior = vec![0.0f32; n];
    let test_penalty = config::test_penalty();
    if test_penalty < 1.0 && !query_mentions_tests(query_text) {
        for (i, c) in store.chunks.iter().enumerate() {
            if is_test_path(&c.file) {
                let demoted = fused[i] * test_penalty;
                path_prior[i] = demoted - fused[i];
                fused[i] = demoted;
            }
        }
    }

    // Vague behavioral queries surface synthetic whole-module chunks above the
    // exact symbol: the module blob's file-header docstring matches broad
    // queries densely, and its import/constant text matches many query terms
    // lexically. Much of that evidence is really about the FILE, so when a
    // specific (non-module) chunk in the same file also matched, attribute the
    // file's top position to that symbol: swap the module chunk's fused score
    // with the file's best specific chunk when the blob outranks it. Swapping
    // preserves the score multiset — cross-file (file-level) ranking is
    // untouched, only which chunk represents the file changes. Files where
    // ONLY the module chunk matched (imports, constants) keep it in place. A
    // blanket multiplicative demotion was benchmarked first and rejected: it
    // lifted symbol MRR but sank file MRR 0.70 -> 0.61 by pushing gold files
    // down the cross-file order.
    let mut module_prior = vec![0.0f32; n];
    if let Some(ratio) = config::module_swap_ratio() {
        let mut best_module: HashMap<&str, usize> = HashMap::new();
        let mut best_symbol: HashMap<&str, usize> = HashMap::new();
        for (i, c) in store.chunks.iter().enumerate() {
            if fused[i] <= 0.0 {
                continue;
            }
            let best = if c.kind == "module" { &mut best_module } else { &mut best_symbol };
            match best.entry(c.file.as_str()) {
                Entry::Vacant(e) => {
                    e.insert(i);
                }
                Entry::Occupied(mut e) => {
                    // Argmax by fused score; ties keep the lower row (stable).
                    if fused[i] > fused[*e.get()] {
                        e.insert(i);
                    }
                }
            }
        }
        for (file, &mi) in &best_module {
            if let Some(&si) = best_symbol.get(file) {
                // Swap only when the blob outranks the symbol AND the symbol
                // carries at least `ratio` of the blob's evidence (a floor
                // against promoting matches that are pure noise).
                if fused[mi] > fused[si] && fused[si] >= ratio * fused[mi] {
                    let delta = fused[mi] - fused[si];
                    module_prior[mi] = -delta;
                    module_prior[si] = delta;
                    fused.swap(mi, si);
                }
            }
        }
    }

    // Structural boosting from --context-symbols.
    if !context.is_empty() {
        let context_boost = config::context_boost();
        let adjacent_boost = config::adjacent_boost();
        let adjacent = graph::adjacent_to(context, &store.edges);
        for (i, score) in fused.iter_mut().enumerate() {
            if context.contains(&i) {
                structural_boost[i] = context_boost;
                *score += structural_boost[i];
            } else if adjacent.contains(&i) {
                structural_boost[i] = adjacent_boost;
                *score += structural_boost[i];
            }
        }
    }

    let mut hits: Vec<Hit> = (0..n)
        .map(|i| Hit {
            index: i,
            score: fused[i],
            dense_rrf: dense_rrf[i],
            sparse_rrf: sparse_rrf[i],
            rank_prior: rank_prior[i],
            structural_boost: structural_boost[i],
            path_prior: path_prior[i],
            module_prior: module_prior[i],
        })
        .collect();
    // Deterministic ordering: equal scores tie-break on chunk index so the
    // same store and query always produce the same result list.
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.index.cmp(&b.index))
    });
    shape_results(&mut hits, store);
    hits.truncate(k);
    hits
}

/// Post-rank shaping: an oversized symbol is indexed as linked continuation
/// slices sharing (file, name); keeping only the best-scoring slice stops one
/// giant class from filling several top-k slots, and the freed slots go to
/// distinct answers.
///
/// Child-over-container promotion was tried here and benchmarked WORSE on the
/// apprise ground-truth set (it lifted plausible-but-wrong siblings above true
/// answers, e.g. HIT@1 6→5); don't reintroduce it without an eval win.
fn shape_results(hits: &mut Vec<Hit>, store: &Store) {
    if config::split_dedup() {
        let mut seen: HashSet<(&str, &str)> = HashSet::new();
        hits.retain(|h| {
            let c = &store.chunks[h.index];
            seen.insert((c.file.as_str(), c.name.as_str()))
        });
    }
}

/// RRF contribution per document: `1/(K + rank)` for the top candidates by
/// score (both knobs env-tunable; see `config::rrf_k`/`rrf_candidates`). When
/// `require_positive`, documents with a non-positive score (no lexical match)
/// are skipped. Ranking within a modality tie-breaks on document index.
fn rrf(scores: &[f32], require_positive: bool) -> Vec<f32> {
    let n = scores.len();
    let rrf_k = config::rrf_k();
    let candidates = config::rrf_candidates();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        scores[b]
            .partial_cmp(&scores[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.cmp(&b))
    });

    let mut contrib = vec![0.0f32; n];
    for (pos, &i) in order.iter().take(candidates).enumerate() {
        if require_positive && scores[i] <= 0.0 {
            continue;
        }
        contrib[i] = 1.0 / (rrf_k + pos as f32 + 1.0);
    }
    contrib
}

/// True when the query is itself about tests, in which case test files are
/// exactly what the user wants and no demotion applies.
fn query_mentions_tests(query: &str) -> bool {
    let q = query.to_lowercase();
    q.split(|ch: char| !ch.is_alphanumeric())
        .any(|w| matches!(w, "test" | "tests" | "testing" | "spec" | "specs" | "fixture" | "fixtures"))
}

/// Path-based test detection across the indexed languages: a `tests/` or
/// `__tests__/` directory segment, or a `test_*` / `*_test` / `*.test.*` /
/// `*.spec.*` file basename.
fn is_test_path(file: &str) -> bool {
    let lower = file.to_lowercase();
    let normalized = lower.replace('\\', "/");
    if normalized
        .split('/')
        .rev()
        .skip(1)
        .any(|seg| matches!(seg, "test" | "tests" | "__tests__" | "testing"))
    {
        return true;
    }
    let base = normalized.rsplit('/').next().unwrap_or(&normalized);
    let stem = base.split('.').next().unwrap_or(base);
    stem.starts_with("test_")
        || stem.ends_with("_test")
        || base.contains(".test.")
        || base.contains(".spec.")
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn norm(a: &[f32]) -> f32 {
    a.iter().map(|x| x * x).sum::<f32>().sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Chunk;
    use std::path::PathBuf;

    fn test_store(names: &[&str], vectors: Vec<Vec<f32>>) -> Store {
        let chunks: Vec<Chunk> = names
            .iter()
            .map(|name| Chunk {
                id: format!("f.py:{name}"),
                file: "f.py".to_string(),
                lang: "python".to_string(),
                kind: "function".to_string(),
                name: name.to_string(),
                start_line: 1,
                end_line: 2,
                sha: String::new(),
                summary: format!("does {name}"),
                text: format!("def {name}(): pass"),
                parent: None,
                calls: Vec::new(),
                bases: Vec::new(),
                tags: Vec::new(),
                rank: 0.0,
                summary_pending: false,
                epoch: 0,
            })
            .collect();
        let docs: Vec<String> = chunks
            .iter()
            .map(|c| bm25::doc_for(&c.name, &c.summary, &c.text, &c.tags))
            .collect();
        let mut store = Store::empty(
            PathBuf::from("/tmp/search-test"),
            "/repo".to_string(),
            "test-model".to_string(),
            String::new(),
            Some("gateway".to_string()),
            "docstring".to_string(),
        );
        store.dim = vectors.first().map(Vec::len).unwrap_or(0);
        store.vectors = vectors.into_iter().flatten().collect();
        store.bm25 = Some(Bm25::build(&docs));
        store.chunks = chunks;
        store
    }

    #[test]
    fn hybrid_fuses_dense_and_lexical_evidence() {
        // Chunk 0 wins dense; chunk 1 wins lexically for its own name; both
        // signals must surface their winner at the top for their query.
        let store = test_store(
            &["cosine_favorite", "parse_config"],
            vec![vec![1.0, 0.0], vec![0.0, 1.0]],
        );
        let hits = hybrid(&store, &[1.0, 0.0], "parse_config", 2, &HashSet::new());
        assert_eq!(hits.len(), 2);
        // Lexical exact-name match beats pure dense similarity here because
        // chunk 1 also gets a dense rank position while chunk 0 gets no
        // lexical contribution.
        assert_eq!(hits[0].index, 1);
        assert!(hits[0].sparse_rrf > 0.0);
        assert!(hits[1].sparse_rrf == 0.0);
    }

    #[test]
    fn split_slices_dedup_to_best_and_free_slots() {
        // Three slices of one oversized class + one distinct helper. Without
        // dedup the slices crowd the top; with it only the best slice stays
        // and the helper enters the k=2 window.
        let mut store = test_store(
            &["BigClass", "BigClass", "BigClass", "helper"],
            vec![vec![1.0, 0.0], vec![0.9, 0.1], vec![0.8, 0.2], vec![0.5, 0.5]],
        );
        for i in 0..3 {
            store.chunks[i].file = "pkg/big.py".to_string();
        }
        let hits = hybrid(&store, &[1.0, 0.0], "big class behavior", 3, &HashSet::new());
        let names: Vec<&str> = hits
            .iter()
            .map(|h| store.chunks[h.index].name.as_str())
            .collect();
        assert_eq!(
            names.iter().filter(|n| **n == "BigClass").count(),
            1,
            "one slice per symbol: {names:?}"
        );
        assert!(names.contains(&"helper"), "freed slot goes to the next answer");
    }

    #[test]
    fn test_chunks_demote_on_behavioral_queries_only() {
        let mut store = test_store(
            &["convert_between", "test_convert_between"],
            vec![vec![1.0, 0.0], vec![1.0, 0.0]],
        );
        store.chunks[1].file = "tests/test_conversion.py".to_string();
        // Identical dense evidence; the test file matches lexically at least as
        // well — without demotion it ties or wins, with demotion the
        // implementation must lead.
        let hits = hybrid(&store, &[1.0, 0.0], "convert between formats", 2, &HashSet::new());
        assert_eq!(hits[0].index, 0, "implementation outranks its test");
        assert!(hits[1].path_prior < 0.0, "demotion recorded as a component");
        // A query about tests must NOT demote test files.
        let hits = hybrid(&store, &[1.0, 0.0], "tests for convert between", 2, &HashSet::new());
        assert!(hits.iter().all(|h| h.path_prior == 0.0));
    }

    #[test]
    fn is_test_path_covers_common_layouts() {
        for p in [
            "tests/test_plugin_email.py",
            "pkg/__tests__/thing.ts",
            "src/foo.test.ts",
            "src/foo.spec.js",
            "test_util.py",
            "internal/util_test.go",
        ] {
            assert!(is_test_path(p), "{p} should be a test path");
        }
        for p in ["apprise/conversion.py", "src/latest.ts", "contest/entry.py", "attest.py"] {
            assert!(!is_test_path(p), "{p} should NOT be a test path");
        }
    }

    #[test]
    fn module_blob_swaps_below_the_files_best_symbol() {
        // Row 0: the synthetic module chunk of pkg/convert.py, best dense
        // match (its header docstring matches the vague query). Row 1: the
        // actual function in the same file, second-best. Row 2: a module
        // chunk of a file with NO matching symbol — must stay put.
        let mut store = test_store(
            &["convert", "convert_between", "lonely"],
            vec![vec![1.0, 0.0], vec![0.9, 0.1], vec![0.5, 0.5]],
        );
        store.chunks[0].kind = "module".to_string();
        store.chunks[0].file = "pkg/convert.py".to_string();
        store.chunks[1].file = "pkg/convert.py".to_string();
        store.chunks[2].kind = "module".to_string();
        store.chunks[2].file = "pkg/lonely.py".to_string();

        let hits = hybrid(&store, &[1.0, 0.0], "no lexical overlap", 3, &HashSet::new());
        assert_eq!(hits[0].index, 1, "the file's best symbol takes the blob's rank");
        assert_eq!(hits[1].index, 0, "the blob takes the symbol's old rank");
        assert!(hits[0].module_prior > 0.0 && hits[1].module_prior < 0.0);
        assert!(
            (hits[0].module_prior + hits[1].module_prior).abs() < 1e-6,
            "the swap conserves total score — file-level ranking is untouched"
        );
        let lonely = hits.iter().find(|h| h.index == 2).unwrap();
        assert_eq!(lonely.module_prior, 0.0, "module without a matching symbol keeps its rank");
    }

    #[test]
    fn equal_scores_tie_break_deterministically_by_index() {
        let store = test_store(
            &["twin_one", "twin_two", "twin_three"],
            vec![vec![1.0, 0.0], vec![1.0, 0.0], vec![1.0, 0.0]],
        );
        // A query matching nothing lexically and equidistant densely: dense
        // RRF positions differ but re-running must give identical order.
        let first = hybrid(&store, &[0.0, 1.0], "unrelated words", 3, &HashSet::new());
        let second = hybrid(&store, &[0.0, 1.0], "unrelated words", 3, &HashSet::new());
        let order_a: Vec<usize> = first.iter().map(|h| h.index).collect();
        let order_b: Vec<usize> = second.iter().map(|h| h.index).collect();
        assert_eq!(order_a, order_b);
    }
}
