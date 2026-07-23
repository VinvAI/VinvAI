//! The on-disk index format.
//!
//! A store is a directory `<root>/<repo-slug>/` holding:
//!   * `meta.json`      — models, vector dimension, counts, timestamps.
//!   * `chunks.jsonl`   — one JSON symbol record per line (order == vector row).
//!   * `vectors.f32`    — packed little-endian f32, `count * dim` values.
//!   * `edges.jsonl`    — code-graph edges (src/dst chunk index + kind).
//!   * `manifest.json`  — repo-relative path -> content SHA, for incremental
//!     updates.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::bm25::Bm25;
use crate::util::sha256_hex;

/// One indexed symbol.
#[derive(Serialize, Deserialize, Clone)]
pub struct Chunk {
    pub id: String,
    pub file: String,
    pub lang: String,
    pub kind: String,
    pub name: String,
    pub start_line: usize,
    pub end_line: usize,
    /// SHA-256 of the symbol's source snippet (change detection).
    pub sha: String,
    pub summary: String,
    /// The source snippet (kept for lexical BM25 search and result display).
    #[serde(default)]
    pub text: String,
    /// Enclosing class/function name.
    #[serde(default)]
    pub parent: Option<String>,
    /// Callee identifiers (source of `invoke` edges).
    #[serde(default)]
    pub calls: Vec<String>,
    /// Base classes / supertypes (source of `inherit` edges).
    #[serde(default)]
    pub bases: Vec<String>,
    /// Learned lexical aliases from the retrieval-feedback loop
    /// (`<store>/tag_overrides.jsonl`), merged at index/update time. They join
    /// the BM25 document so vocabulary the code never uses ("auth", "login")
    /// can still find the symbol. Keyed by chunk id, so an edit that moves the
    /// symbol sheds its tags — stale aliases decay instead of sticking.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// PageRank importance in [0,1]-ish, filled at build time.
    #[serde(default)]
    pub rank: f32,
    /// True when the LLM summary failed and a heuristic stand-in was embedded.
    /// Pending chunks are re-queued (their file is reprocessed) on the next
    /// `update`, so degradation is visible and temporary — never silent.
    #[serde(default)]
    pub summary_pending: bool,
    /// Index epoch at which this chunk's content (`sha`) last changed. Joined
    /// against epoch-tagged runtime captures: a trace observed at epoch E is
    /// stale for this symbol iff `epoch > E`.
    #[serde(default)]
    pub epoch: u64,
}

/// A directed code-graph edge between two chunk rows.
#[derive(Serialize, Deserialize, Clone)]
pub struct Edge {
    pub src: usize,
    pub dst: usize,
    pub kind: String, // contains | invoke | inherit
}

/// Store format version.
///
/// v5: `Chunk::calls` records the callee path with its receiver
/// (`binary_controller.get_binary`) instead of only the last segment. v4 and
/// earlier dropped the receiver, which made a call indistinguishable from
/// recursion into a same-named caller and silently deleted every
/// delegation edge. Consumers that resolve calls must reject v4 rather than
/// read those bare names as if they were whole.
pub const STORE_VERSION: u32 = 5;

#[derive(Serialize, Deserialize)]
struct Meta {
    version: u32,
    repo_path: String,
    embedding_model: String,
    summary_model: String,
    /// Which backend produced the vectors: `"gateway"` or `"local"`. Absent on
    /// pre-v3 stores (defaults to `None`, treated as gateway).
    #[serde(default)]
    embedding_backend: Option<String>,
    /// Text representation embedded for each symbol. Missing on old stores;
    /// `"unknown"` forces one safe rebuild before vectors can be reused.
    #[serde(default = "unknown_representation_mode")]
    representation_mode: String,
    dim: usize,
    count: usize,
    updated_unix: u64,
    /// Monotonic content epoch: bumped on every save where any chunk content
    /// changed. Consumers (extension trace tagging) read this to timestamp
    /// captures against index state. Absent on old stores (0).
    #[serde(default)]
    epoch: u64,
}

/// An in-memory index, loaded from or about to be written to a store directory.
pub struct Store {
    pub dir: PathBuf,
    /// Store format version (see `STORE_VERSION`). Read back from `meta.json`
    /// so a stale layout can be detected instead of silently reused.
    pub version: u32,
    pub repo_path: String,
    pub embedding_model: String,
    pub summary_model: String,
    /// Backend that produced the vectors: `Some("gateway")` / `Some("local")`,
    /// or `None` on older stores. Lets `query` auto-route to the right embedder.
    pub embedding_backend: Option<String>,
    pub representation_mode: String,
    /// Content epoch of this store (see `Meta::epoch`).
    pub epoch: u64,
    pub dim: usize,
    pub chunks: Vec<Chunk>,
    /// Flattened row-major: `vectors[i*dim .. (i+1)*dim]` is `chunks[i]`.
    pub vectors: Vec<f32>,
    pub edges: Vec<Edge>,
    pub manifest: BTreeMap<String, String>,
    /// Prebuilt BM25 lexical index (built at index/update time; `None` on older
    /// stores, in which case search rebuilds it).
    pub bm25: Option<Bm25>,
}

impl Store {
    pub fn empty(
        dir: PathBuf,
        repo_path: String,
        embedding_model: String,
        summary_model: String,
        embedding_backend: Option<String>,
        representation_mode: String,
    ) -> Self {
        Self {
            dir,
            version: STORE_VERSION,
            repo_path,
            embedding_model,
            summary_model,
            embedding_backend,
            representation_mode,
            epoch: 0,
            dim: 0,
            chunks: Vec::new(),
            vectors: Vec::new(),
            edges: Vec::new(),
            manifest: BTreeMap::new(),
            bm25: None,
        }
    }

    /// The vector for chunk `i`, or an empty slice if out of range.
    pub fn row(&self, i: usize) -> &[f32] {
        if self.dim == 0 {
            return &[];
        }
        let start = i * self.dim;
        self.vectors.get(start..start + self.dim).unwrap_or(&[])
    }

    /// Load an existing store, or `Ok(None)` if none exists at `dir`.
    pub fn load(dir: PathBuf) -> Result<Option<Store>, String> {
        let meta_path = dir.join("meta.json");
        if !meta_path.exists() {
            return Ok(None);
        }
        let meta: Meta = serde_json::from_str(
            &fs::read_to_string(&meta_path).map_err(|e| format!("read meta.json: {e}"))?,
        )
        .map_err(|e| format!("parse meta.json: {e}"))?;

        let chunks = read_chunks(&dir.join("chunks.jsonl"))?;
        let mut vectors = read_vectors(&dir.join("vectors.f32"))?;
        let mut edges = read_edges(&dir.join("edges.jsonl"))?;
        let manifest = read_manifest(&dir.join("manifest.json"))?;
        // A BM25 payload from an older structure format either fails to parse
        // (missing fields) or fails the explicit format check; both demote to
        // `None`, which queries answer with an in-memory build and the next
        // index/update replaces with a freshly persisted current-format index.
        let mut bm25: Option<Bm25> = fs::read(dir.join("bm25.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Bm25>(&b).ok())
            .filter(Bm25::is_current_format);

        let expected = chunks.len() * meta.dim;
        if vectors.len() != expected {
            // An interrupted `save` can leave the new generation's fully
            // written vector file as `vectors.tmp` beside a stale
            // `vectors.f32` (the commit rename failed or the process died
            // mid-sequence). When the tmp file matches this chunk count
            // exactly, complete the commit instead of declaring the store
            // corrupt. Edges and BM25 are from the stale generation — their
            // row indices no longer line up — so they are dropped here and
            // rebuilt by the next save.
            match complete_interrupted_commit(&dir, expected) {
                Some(healed) => {
                    eprintln!(
                        "index: warning — store at {} was torn by an interrupted save; \
                         completed the commit from vectors.tmp ({} rows) and dropped the \
                         stale graph/BM25 (rebuilt on the next index/update)",
                        dir.display(),
                        expected / meta.dim.max(1),
                    );
                    vectors = healed;
                    edges = Vec::new();
                    bm25 = None;
                }
                None => {
                    return Err(format!(
                        "corrupt index: {} vector values for {} chunks × dim {} (expected {})",
                        vectors.len(),
                        chunks.len(),
                        meta.dim,
                        expected
                    ));
                }
            }
        }

        Ok(Some(Store {
            dir,
            version: meta.version,
            repo_path: meta.repo_path,
            embedding_model: meta.embedding_model,
            summary_model: meta.summary_model,
            embedding_backend: meta.embedding_backend,
            representation_mode: meta.representation_mode,
            epoch: meta.epoch,
            dim: meta.dim,
            chunks,
            vectors,
            edges,
            manifest,
            bm25,
        }))
    }

    /// Persist every file in a two-phase commit.
    ///
    /// Phase 1 stages every payload to a `.tmp` sibling; phase 2 renames them
    /// into place in one tight sequence, `meta.json` last as the commit
    /// marker. Staging first keeps slow serialization/IO out of the rename
    /// window, and `rename_with_retry` rides out the transient Windows file
    /// locks (concurrent store readers, antivirus scans of fresh files) that
    /// can otherwise abort the sequence halfway and tear the store. If
    /// `vectors.f32` still fails to commit after `chunks.jsonl` did, the
    /// fully staged `vectors.tmp` is left behind and `load` completes the
    /// commit from it.
    pub fn save(&self) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| format!("create store dir: {e}"))?;

        let mut jsonl = String::new();
        for c in &self.chunks {
            jsonl.push_str(&serde_json::to_string(c).map_err(|e| e.to_string())?);
            jsonl.push('\n');
        }

        let mut vec_bytes = Vec::with_capacity(self.vectors.len() * 4);
        for v in &self.vectors {
            vec_bytes.extend_from_slice(&v.to_le_bytes());
        }

        let mut edges = String::new();
        for e in &self.edges {
            edges.push_str(&serde_json::to_string(e).map_err(|e| e.to_string())?);
            edges.push('\n');
        }

        let manifest = serde_json::to_string(&self.manifest).map_err(|e| e.to_string())?;

        let meta = Meta {
            version: STORE_VERSION,
            repo_path: self.repo_path.clone(),
            embedding_model: self.embedding_model.clone(),
            summary_model: self.summary_model.clone(),
            embedding_backend: self.embedding_backend.clone(),
            representation_mode: self.representation_mode.clone(),
            dim: self.dim,
            count: self.chunks.len(),
            updated_unix: now_unix(),
            epoch: self.epoch,
        };
        let meta = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;

        let mut files: Vec<(&str, Vec<u8>)> = vec![
            ("chunks.jsonl", jsonl.into_bytes()),
            ("vectors.f32", vec_bytes),
            ("edges.jsonl", edges.into_bytes()),
            ("manifest.json", manifest.into_bytes()),
        ];
        if let Some(b) = &self.bm25 {
            files.push(("bm25.json", serde_json::to_vec(b).map_err(|e| e.to_string())?));
        }
        files.push(("meta.json", meta.into_bytes()));

        // Phase 1: stage everything.
        let mut staged: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(files.len());
        for (name, bytes) in &files {
            let dst = self.dir.join(name);
            let tmp = dst.with_extension("tmp");
            fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
            staged.push((tmp, dst));
        }

        // Phase 2: commit (meta.json last).
        for (tmp, dst) in &staged {
            rename_with_retry(tmp, dst).map_err(|e| format!("rename {}: {e}", dst.display()))?;
        }
        Ok(())
    }
}

fn unknown_representation_mode() -> String {
    "unknown".to_string()
}

/// Directory name for a repo: basename plus a short hash of the absolute path.
pub fn repo_slug(repo_path: &Path) -> String {
    let abs = fs::canonicalize(repo_path).unwrap_or_else(|_| repo_path.to_path_buf());
    let base = abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string());
    let hash = sha256_hex(abs.to_string_lossy().as_bytes());
    let safe: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("{safe}-{}", &hash[..12])
}

fn read_chunks(path: &Path) -> Result<Vec<Chunk>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read chunks.jsonl: {e}"))?;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        out.push(
            serde_json::from_str(line)
                .map_err(|e| format!("parse chunks.jsonl line {}: {e}", i + 1))?,
        );
    }
    Ok(out)
}

fn read_vectors(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = fs::read(path).map_err(|e| format!("read vectors.f32: {e}"))?;
    if bytes.len() % 4 != 0 {
        return Err("corrupt vectors.f32: length not a multiple of 4".to_string());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(out)
}

fn read_edges(path: &Path) -> Result<Vec<Edge>, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(e) = serde_json::from_str(line) {
            out.push(e);
        }
    }
    Ok(out)
}

fn read_manifest(path: &Path) -> Result<BTreeMap<String, String>, String> {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("parse manifest.json: {e}")),
        Err(_) => Ok(BTreeMap::new()),
    }
}

/// Rename with bounded backoff on transient Windows file locks.
///
/// On Windows, renaming onto (or from) a file another process holds open
/// without `FILE_SHARE_DELETE` fails with `ERROR_ACCESS_DENIED` (5) or
/// `ERROR_SHARING_VIOLATION` (32) / `ERROR_LOCK_VIOLATION` (33). Store
/// readers (concurrent queries, the MCP server) and antivirus scans of
/// freshly written files hold such handles for milliseconds; a couple of
/// seconds of backoff outlives them. Non-lock errors fail immediately.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    const MAX_ATTEMPTS: u32 = 8;
    let mut delay = std::time::Duration::from_millis(40);
    for attempt in 1.. {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let transient = matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
                    || e.kind() == std::io::ErrorKind::PermissionDenied;
                if !transient || attempt >= MAX_ATTEMPTS {
                    return Err(e);
                }
            }
        }
        std::thread::sleep(delay);
        delay = delay.saturating_mul(2).min(std::time::Duration::from_millis(500));
    }
    unreachable!("loop returns on success or final attempt")
}

/// Try to finish an interrupted save by promoting a fully staged
/// `vectors.tmp` over the stale `vectors.f32`. Only fires when the tmp file's
/// size matches the loaded chunk count exactly (`expected` f32 values), so a
/// partial write can never be promoted. Returns the healed vectors, or `None`
/// when no usable tmp file exists. Racing loads are safe: rename is atomic,
/// and the loser falls back to re-reading the destination the winner just
/// committed.
fn complete_interrupted_commit(dir: &Path, expected: usize) -> Option<Vec<f32>> {
    let tmp = dir.join("vectors.tmp");
    let size = fs::metadata(&tmp).ok()?.len();
    if size != (expected as u64) * 4 {
        return None;
    }
    let dst = dir.join("vectors.f32");
    let _ = rename_with_retry(&tmp, &dst);
    let vectors = read_vectors(&dst).ok()?;
    (vectors.len() == expected).then_some(vectors)
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vinv-index-store-{tag}-{}", uuid::Uuid::new_v4()))
    }

    fn chunk(id: &str) -> Chunk {
        Chunk {
            id: id.to_string(),
            file: "f.py".to_string(),
            lang: "python".to_string(),
            kind: "function".to_string(),
            name: id.to_string(),
            start_line: 1,
            end_line: 2,
            sha: "sha".to_string(),
            summary: String::new(),
            text: String::new(),
            parent: None,
            calls: Vec::new(),
            bases: Vec::new(),
            tags: Vec::new(),
            rank: 0.0,
            summary_pending: false,
            epoch: 0,
        }
    }

    fn store_with(dir: PathBuf, chunks: usize, dim: usize) -> Store {
        let mut s = Store::empty(
            dir,
            "repo".to_string(),
            "model".to_string(),
            "summarizer".to_string(),
            Some("gateway".to_string()),
            "mode".to_string(),
        );
        s.dim = dim;
        for i in 0..chunks {
            s.chunks.push(chunk(&format!("c{i}")));
            s.vectors.extend((0..dim).map(|j| (i * dim + j) as f32));
        }
        s
    }

    fn chunks_jsonl(n: usize) -> String {
        (0..n)
            .map(|i| serde_json::to_string(&chunk(&format!("c{i}"))).unwrap() + "\n")
            .collect()
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = test_dir("roundtrip");
        store_with(dir.clone(), 2, 3).save().unwrap();
        let loaded = Store::load(dir.clone()).unwrap().unwrap();
        assert_eq!(loaded.chunks.len(), 2);
        assert_eq!(loaded.vectors.len(), 6);
        assert_eq!(loaded.dim, 3);
        let _ = fs::remove_dir_all(&dir);
    }

    // A torn store (chunks one generation ahead of vectors) with no staged
    // vector file must be reported corrupt, not silently loaded misaligned.
    #[test]
    fn torn_store_without_staged_vectors_is_corrupt() {
        let dir = test_dir("torn");
        store_with(dir.clone(), 2, 3).save().unwrap();
        fs::write(dir.join("chunks.jsonl"), chunks_jsonl(3)).unwrap();
        let err = expect_load_err(&dir);
        assert!(err.contains("corrupt index"), "unexpected error: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    fn expect_load_err(dir: &Path) -> String {
        match Store::load(dir.to_path_buf()) {
            Err(e) => e,
            Ok(_) => panic!("expected a corrupt-store error"),
        }
    }

    // An interrupted commit — new chunks.jsonl landed, vectors.tmp fully
    // staged, vectors.f32 still the old generation — must self-heal on load,
    // dropping the stale (misaligned) graph and BM25.
    #[test]
    fn interrupted_commit_heals_from_staged_vectors() {
        let dir = test_dir("heal");
        let mut old = store_with(dir.clone(), 2, 3);
        old.edges.push(Edge { src: 0, dst: 1, kind: "invoke".to_string() });
        old.save().unwrap();

        fs::write(dir.join("chunks.jsonl"), chunks_jsonl(3)).unwrap();
        let staged: Vec<u8> = (0..9u32).flat_map(|v| (v as f32).to_le_bytes()).collect();
        fs::write(dir.join("vectors.tmp"), &staged).unwrap();

        let healed = Store::load(dir.clone()).unwrap().unwrap();
        assert_eq!(healed.chunks.len(), 3);
        assert_eq!(healed.vectors.len(), 9);
        assert_eq!(healed.vectors[8], 8.0);
        assert!(healed.edges.is_empty(), "stale edges must be dropped");
        assert!(healed.bm25.is_none(), "stale bm25 must be dropped");
        assert!(!dir.join("vectors.tmp").exists(), "tmp must be promoted");
        let _ = fs::remove_dir_all(&dir);
    }

    // A partial vectors.tmp (wrong size) must never be promoted.
    #[test]
    fn partial_staged_vectors_are_not_promoted() {
        let dir = test_dir("partial");
        store_with(dir.clone(), 2, 3).save().unwrap();
        fs::write(dir.join("chunks.jsonl"), chunks_jsonl(3)).unwrap();
        fs::write(dir.join("vectors.tmp"), [0u8; 20]).unwrap();
        let err = expect_load_err(&dir);
        assert!(err.contains("corrupt index"), "unexpected error: {err}");
        assert!(dir.join("vectors.tmp").exists(), "partial tmp must be left alone");
        let _ = fs::remove_dir_all(&dir);
    }
}
