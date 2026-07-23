//! Resumable embedding: crash recovery for the (long) embedding stage.
//!
//! Embedding a large repository takes minutes-to-hours against a local
//! sidecar. If the process dies mid-way (or the sidecar goes down and the
//! bounded retries run out), all completed work must survive: progress is
//! persisted per batch under `<store>/embed_progress/` as
//!
//!   * `progress.json` — model id, vector dim, and a fingerprint of the exact
//!     input set (chunk ids + content SHAs + embed-input texts);
//!   * `vectors.f32`   — packed little-endian f32 rows, appended and fsynced
//!     per batch;
//!   * `chunks.jsonl`  — one `{"id","sha"}` per embedded row, appended and
//!     fsynced per batch (row-aligned with `vectors.f32`).
//!
//! On the next run the fingerprint is recomputed: on a match, the aligned
//! prefix is loaded and embedding continues from the first missing row.
//! Self-healing on load:
//!   * a torn trailing partial row in `vectors.f32` (crash mid-append) is
//!     detected and truncated;
//!   * a row-count mismatch between `vectors.f32` and `chunks.jsonl` heals to
//!     the shorter prefix;
//!   * per-row `{id, sha}` records are verified against the recomputed chunk
//!     list — the first divergent row truncates the prefix there.
//! A fingerprint mismatch (the repo, model, or embed inputs changed — e.g.
//! `--summarize` produced different summaries) discards the partial state and
//! starts clean; resumption is only ever exact, never approximate.
//!
//! The caller deletes the progress dir (`clear`) only after the real store has
//! been committed, so a crash between "all rows embedded" and "store saved"
//! still resumes for free.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config;
use crate::embed::Embedder;
use crate::store::Chunk;
use crate::util::sha256_hex;

const PROGRESS_DIR: &str = "embed_progress";

#[derive(Serialize, Deserialize)]
struct ProgressMeta {
    fingerprint: String,
    model: String,
    dim: usize,
}

fn progress_dir(store_dir: &Path) -> PathBuf {
    store_dir.join(PROGRESS_DIR)
}

/// Remove any embedding progress state. Called after the store has been
/// durably saved (the saved store supersedes the partial), or when starting
/// over with a different input set.
pub fn clear(store_dir: &Path) {
    let _ = fs::remove_dir_all(progress_dir(store_dir));
}

/// Fingerprint of the exact embedding work: model identity plus every row's
/// chunk id, content SHA, and embed-input text. Any difference (edited file,
/// different model, different summaries) changes the fingerprint and voids
/// the partial state.
fn fingerprint(model: &str, chunks: &[Chunk], inputs: &[String]) -> String {
    let mut buf = Vec::new();
    buf.extend_from_slice(model.as_bytes());
    buf.push(0);
    for (c, input) in chunks.iter().zip(inputs) {
        buf.extend_from_slice(c.id.as_bytes());
        buf.push(0);
        buf.extend_from_slice(c.sha.as_bytes());
        buf.push(0);
        buf.extend_from_slice(input.as_bytes());
        buf.push(0);
    }
    sha256_hex(&buf)
}

/// Embed `inputs` (row-aligned with `chunks`), resuming from durable progress
/// when the previous run over the identical input set was interrupted.
/// Progress is flushed and fsynced per batch (`INDEX_EMBED_BATCH`).
pub fn embed_with_resume(
    embedder: &Embedder,
    store_dir: &Path,
    chunks: &[Chunk],
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    debug_assert_eq!(chunks.len(), inputs.len());
    if inputs.is_empty() {
        clear(store_dir);
        return Ok(Vec::new());
    }

    let model = embedder.model_id();
    let fp = fingerprint(&model, chunks, inputs);
    let dir = progress_dir(store_dir);

    let (mut rows, mut dim) = match load_progress(&dir, &fp, chunks) {
        Some(loaded) => loaded,
        None => {
            // Missing, unreadable, or from a different input set: start clean.
            let _ = fs::remove_dir_all(&dir);
            (Vec::new(), 0)
        }
    };
    if !rows.is_empty() {
        eprintln!(
            "index: resuming embedding from durable progress — {}/{} rows already done",
            rows.len(),
            inputs.len()
        );
    }
    if rows.len() >= inputs.len() {
        return Ok(rows);
    }

    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let mut vectors_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("vectors.f32"))
        .map_err(|e| format!("open progress vectors.f32: {e}"))?;
    let mut chunks_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("chunks.jsonl"))
        .map_err(|e| format!("open progress chunks.jsonl: {e}"))?;

    let batch = config::embed_batch();
    let mut done = rows.len();
    while done < inputs.len() {
        let end = (done + batch).min(inputs.len());
        let batch_rows = embedder.embed_passages(&inputs[done..end])?;
        if batch_rows.len() != end - done {
            return Err(format!(
                "embeddings: expected {} vectors, got {}",
                end - done,
                batch_rows.len()
            ));
        }

        if dim == 0 {
            dim = batch_rows.first().map(Vec::len).unwrap_or(0);
            if dim == 0 {
                return Err("embeddings: server returned zero-dimensional vectors".to_string());
            }
            // Commit the meta (fingerprint + dim) before any row data exists,
            // so rows on disk are always interpretable.
            write_meta(&dir, &ProgressMeta { fingerprint: fp.clone(), model: model.clone(), dim })?;
        }
        for row in &batch_rows {
            if row.len() != dim {
                return Err(format!(
                    "embedding dim mismatch: {} vs {dim} (is the embedding model consistent?)",
                    row.len()
                ));
            }
        }

        // Durably append the batch: vector bytes first, then the row-aligned
        // chunk records. A crash between the two syncs leaves vectors ahead of
        // chunks — load self-heals to the shorter (chunks) prefix.
        let mut bytes = Vec::with_capacity(batch_rows.len() * dim * 4);
        for row in &batch_rows {
            for v in row {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        vectors_file.write_all(&bytes).map_err(|e| format!("append progress vectors: {e}"))?;
        vectors_file.sync_data().map_err(|e| format!("fsync progress vectors: {e}"))?;

        let mut lines = String::new();
        for c in &chunks[done..end] {
            lines.push_str(
                &serde_json::json!({ "id": c.id, "sha": c.sha }).to_string(),
            );
            lines.push('\n');
        }
        chunks_file.write_all(lines.as_bytes()).map_err(|e| format!("append progress chunks: {e}"))?;
        chunks_file.sync_data().map_err(|e| format!("fsync progress chunks: {e}"))?;

        rows.extend(batch_rows);
        done = end;
    }

    Ok(rows)
}

fn write_meta(dir: &Path, meta: &ProgressMeta) -> Result<(), String> {
    let path = dir.join("progress.json");
    let tmp = dir.join("progress.json.tmp");
    let body = serde_json::to_vec(meta).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(&tmp).map_err(|e| format!("write progress meta: {e}"))?;
    f.write_all(&body).map_err(|e| format!("write progress meta: {e}"))?;
    f.sync_data().map_err(|e| format!("fsync progress meta: {e}"))?;
    drop(f);
    fs::rename(&tmp, &path).map_err(|e| format!("commit progress meta: {e}"))?;
    Ok(())
}

/// Load the resumable prefix: `Some((rows, dim))` when the on-disk progress
/// belongs to exactly this input set, `None` otherwise. Self-heals torn tails
/// and row-count misalignment down to the longest verified prefix, truncating
/// the on-disk files to match so subsequent appends stay aligned.
fn load_progress(dir: &Path, fp: &str, chunks: &[Chunk]) -> Option<(Vec<Vec<f32>>, usize)> {
    let meta: ProgressMeta =
        serde_json::from_str(&fs::read_to_string(dir.join("progress.json")).ok()?).ok()?;
    if meta.fingerprint != fp || meta.dim == 0 {
        return None;
    }
    let dim = meta.dim;
    let row_bytes = dim * 4;

    let vec_path = dir.join("vectors.f32");
    let bytes = fs::read(&vec_path).unwrap_or_default();
    // Torn trailing partial row (crash mid-append): drop the tail.
    let vec_rows = bytes.len() / row_bytes;

    // Row-aligned chunk records; verify each against the recomputed chunk
    // list and stop at the first divergence.
    let recorded = fs::read_to_string(dir.join("chunks.jsonl")).unwrap_or_default();
    let mut verified = 0usize;
    for line in recorded.lines() {
        if verified >= vec_rows || verified >= chunks.len() {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { break };
        let id = v.get("id").and_then(Value::as_str);
        let sha = v.get("sha").and_then(Value::as_str);
        if id != Some(chunks[verified].id.as_str()) || sha != Some(chunks[verified].sha.as_str()) {
            break;
        }
        verified += 1;
    }

    // Self-heal the files to the verified prefix so appends resume aligned.
    if bytes.len() != verified * row_bytes {
        let f = OpenOptions::new().write(true).open(&vec_path).ok()?;
        f.set_len((verified * row_bytes) as u64).ok()?;
        f.sync_data().ok()?;
    }
    let kept: String = recorded
        .lines()
        .take(verified)
        .flat_map(|l| [l, "\n"])
        .collect();
    if kept.len() != recorded.len() {
        fs::write(dir.join("chunks.jsonl"), &kept).ok()?;
    }

    let mut rows = Vec::with_capacity(verified);
    for r in 0..verified {
        let mut row = Vec::with_capacity(dim);
        for c in bytes[r * row_bytes..(r + 1) * row_bytes].chunks_exact(4) {
            row.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
        }
        rows.push(row);
    }
    Some((rows, dim))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, sha: &str) -> Chunk {
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
            epoch: 0,
        }
    }

    fn write_progress(dir: &Path, fp: &str, dim: usize, rows: &[Vec<f32>], chunks: &[Chunk]) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("progress.json"),
            serde_json::to_vec(&ProgressMeta {
                fingerprint: fp.to_string(),
                model: "m".to_string(),
                dim,
            })
            .unwrap(),
        )
        .unwrap();
        let mut bytes = Vec::new();
        for row in rows {
            for v in row {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        fs::write(dir.join("vectors.f32"), &bytes).unwrap();
        let mut lines = String::new();
        for c in chunks {
            lines.push_str(&serde_json::json!({"id": c.id, "sha": c.sha}).to_string());
            lines.push('\n');
        }
        fs::write(dir.join("chunks.jsonl"), lines).unwrap();
    }

    fn test_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vinv-resume-{tag}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn torn_trailing_row_is_truncated_and_files_healed() {
        let dir = test_dir("torn");
        let chunks = vec![chunk("a", "s1"), chunk("b", "s2"), chunk("c", "s3")];
        let inputs: Vec<String> = ["ia", "ib", "ic"].iter().map(|s| s.to_string()).collect();
        let fp = fingerprint("m", &chunks, &inputs);
        write_progress(&dir, &fp, 2, &[vec![1.0, 2.0], vec![3.0, 4.0]], &chunks[..2]);
        // Torn partial third row: 3 stray bytes.
        let mut f = OpenOptions::new().append(true).open(dir.join("vectors.f32")).unwrap();
        f.write_all(&[9, 9, 9]).unwrap();
        drop(f);

        let (rows, dim) = load_progress(&dir, &fp, &chunks).unwrap();
        assert_eq!(dim, 2);
        assert_eq!(rows, vec![vec![1.0, 2.0], vec![3.0, 4.0]]);
        assert_eq!(fs::metadata(dir.join("vectors.f32")).unwrap().len(), 16, "torn tail truncated");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn misaligned_files_heal_to_the_shorter_prefix() {
        let dir = test_dir("misaligned");
        let chunks = vec![chunk("a", "s1"), chunk("b", "s2"), chunk("c", "s3")];
        let inputs: Vec<String> = ["ia", "ib", "ic"].iter().map(|s| s.to_string()).collect();
        let fp = fingerprint("m", &chunks, &inputs);
        // Two full vector rows but only one recorded chunk line (crash between
        // the vector fsync and the chunk fsync).
        write_progress(&dir, &fp, 2, &[vec![1.0, 2.0], vec![3.0, 4.0]], &chunks[..1]);

        let (rows, _) = load_progress(&dir, &fp, &chunks).unwrap();
        assert_eq!(rows, vec![vec![1.0, 2.0]], "healed to the shorter (chunks) prefix");
        assert_eq!(fs::metadata(dir.join("vectors.f32")).unwrap().len(), 8);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn changed_inputs_or_content_void_the_partial_state() {
        let dir = test_dir("fingerprint");
        let chunks = vec![chunk("a", "s1")];
        let inputs = vec!["ia".to_string()];
        let fp = fingerprint("m", &chunks, &inputs);
        write_progress(&dir, &fp, 2, &[vec![1.0, 2.0]], &chunks);

        // Same ids, different content SHA -> different fingerprint -> no resume.
        let edited = vec![chunk("a", "s1-edited")];
        let fp2 = fingerprint("m", &edited, &inputs);
        assert_ne!(fp, fp2);
        assert!(load_progress(&dir, &fp2, &edited).is_none());

        // A divergent recorded row truncates the verified prefix even when the
        // fingerprint matches (defense in depth).
        fs::write(
            dir.join("chunks.jsonl"),
            serde_json::json!({"id": "other", "sha": "s1"}).to_string() + "\n",
        )
        .unwrap();
        let (rows, _) = load_progress(&dir, &fp, &chunks).unwrap();
        assert!(rows.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
