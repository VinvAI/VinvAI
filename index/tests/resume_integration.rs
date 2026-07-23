//! End-to-end crash-recovery test for the embedding stage.
//!
//! Drives the real `index` binary against a stub OpenAI-compatible embeddings
//! server (deterministic vectors, no network). The first run's server dies
//! after two batches, leaving durable partial progress; the progress file is
//! then torn (a partial trailing row plus one unverifiable full row appended);
//! the second run must self-heal the partial state and resume — embedding only
//! the missing rows — and produce a complete, queryable store.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const DIM: usize = 4;

/// Deterministic embedding for an input string.
fn vector_for(input: &str) -> [f32; DIM] {
    let sum: u32 = input.bytes().map(u32::from).sum();
    [input.len() as f32, (sum % 97) as f32, 1.0, 2.0]
}

/// Minimal one-request-per-connection HTTP server for `POST .../embeddings`.
/// Serves `ok_requests` successful responses, then HTTP 500 forever.
/// `embedded` counts the total inputs embedded successfully.
fn start_server(ok_requests: usize, embedded: Arc<AtomicUsize>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub server");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let mut served = 0usize;
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            served += 1;
            handle(stream, served <= ok_requests, &embedded);
        }
    });
    port
}

fn handle(mut stream: TcpStream, ok: bool, embedded: &AtomicUsize) {
    // Read headers.
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(1) => buf.push(byte[0]),
            _ => return,
        }
    }
    let headers = String::from_utf8_lossy(&buf).to_string();
    let content_length: usize = headers
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("content-length").then(|| v.trim().parse().ok())?
        })
        .unwrap_or(0);
    let mut body = vec![0u8; content_length];
    if content_length > 0 && stream.read_exact(&mut body).is_err() {
        return;
    }

    if !ok {
        let resp = "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 9\r\nConnection: close\r\n\r\nsimulated";
        let _ = stream.write_all(resp.as_bytes());
        return;
    }

    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return,
    };
    let inputs: Vec<String> = parsed["input"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    embedded.fetch_add(inputs.len(), Ordering::SeqCst);

    let data: Vec<serde_json::Value> = inputs
        .iter()
        .enumerate()
        .map(|(i, input)| {
            serde_json::json!({ "index": i, "embedding": vector_for(input).to_vec() })
        })
        .collect();
    let body = serde_json::json!({ "data": data }).to_string();
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
}

fn run_index(args: &[&str], port: u16) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_index"))
        .args(args)
        .env("INDEX_GATEWAY_URL", format!("http://127.0.0.1:{port}/v1"))
        .env_remove("INDEX_GATEWAY_KEY")
        .env_remove("LITELLM_BASE_URL")
        .env_remove("LITELLM_API_KEY")
        .env("INDEX_EMBED_BATCH", "2")
        .env("INDEX_EMBED_MAX_RETRIES", "0")
        .output()
        .expect("spawn index binary")
}

fn write_repo(repo: &Path) {
    fs::create_dir_all(repo).unwrap();
    for (name, tag) in [("alpha", "first"), ("beta", "second"), ("gamma", "third")] {
        fs::write(
            repo.join(format!("{name}.py")),
            format!(
                "def load_{name}(path):\n    \"\"\"Load the {tag} widget from disk.\"\"\"\n    return path\n\n\
                 def save_{name}(obj):\n    \"\"\"Persist the {tag} widget to disk.\"\"\"\n    return obj\n"
            ),
        )
        .unwrap();
    }
}

#[test]
fn interrupted_embedding_self_heals_and_resumes() {
    let root: PathBuf =
        std::env::temp_dir().join(format!("vinv-index-resume-e2e-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    let store = root.join("store");
    write_repo(&repo);
    let repo_arg = repo.to_str().unwrap();
    let store_arg = store.to_str().unwrap();

    // --- Run 1: the sidecar dies after two batches (2 inputs each). ---------
    let embedded1 = Arc::new(AtomicUsize::new(0));
    let port1 = start_server(2, embedded1.clone());
    let out = run_index(&["index", repo_arg, "--store-dir", store_arg], port1);
    assert!(!out.status.success(), "run 1 must fail when the server goes down");
    let stderr = String::from_utf8_lossy(&out.stderr).to_string()
        + &String::from_utf8_lossy(&out.stdout);
    assert!(
        stderr.contains("vinv-embedder serve"),
        "failure must point at the sidecar: {stderr}"
    );
    assert_eq!(embedded1.load(Ordering::SeqCst), 4, "two batches of two rows embedded");

    // Durable progress: 4 aligned rows on disk.
    let progress = store.join("embed_progress");
    let vec_path = progress.join("vectors.f32");
    let row_bytes = DIM * 4;
    assert_eq!(
        fs::metadata(&vec_path).unwrap().len(),
        (4 * row_bytes) as u64,
        "per-batch fsync left exactly the completed rows"
    );

    // --- Tear the partial state: one full junk row (no matching chunk record)
    // plus a torn trailing partial row. -------------------------------------
    let mut bytes = fs::read(&vec_path).unwrap();
    bytes.extend_from_slice(&[0xAB; DIM * 4]); // unverifiable full row
    bytes.extend_from_slice(&[0xCD; 3]); // torn partial row
    fs::write(&vec_path, &bytes).unwrap();

    // --- Run 2: healthy server; must resume from row 4, not restart. --------
    let embedded2 = Arc::new(AtomicUsize::new(0));
    let port2 = start_server(usize::MAX, embedded2.clone());
    let out = run_index(&["index", repo_arg, "--store-dir", store_arg], port2);
    assert!(
        out.status.success(),
        "run 2 must succeed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // The committed store is complete and consistent.
    let meta: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(store.join("meta.json")).unwrap()).unwrap();
    let count = meta["count"].as_u64().unwrap() as usize;
    let dim = meta["dim"].as_u64().unwrap() as usize;
    assert_eq!(dim, DIM);
    assert!(count > 4, "test repo must span more than the two surviving batches");
    assert_eq!(
        fs::metadata(store.join("vectors.f32")).unwrap().len(),
        (count * row_bytes) as u64
    );
    // Resume: only the missing rows were re-embedded (junk row + torn tail
    // healed away; the 4 verified rows were never re-sent).
    assert_eq!(embedded2.load(Ordering::SeqCst), count - 4);
    assert!(!progress.exists(), "progress files are cleared after a durable save");

    // Chunk rows carry the vectors computed for their embed inputs: every
    // stored row must be a plausible deterministic vector, not junk.
    let stored = fs::read(store.join("vectors.f32")).unwrap();
    for row in stored.chunks_exact(row_bytes) {
        let third = f32::from_le_bytes([row[8], row[9], row[10], row[11]]);
        let fourth = f32::from_le_bytes([row[12], row[13], row[14], row[15]]);
        assert_eq!((third, fourth), (1.0, 2.0), "stored vector does not match the stub's shape");
    }

    // --- The healed index is queryable end-to-end. --------------------------
    let out = run_index(
        &["query", "load the first widget from disk", "--store-dir", store_arg],
        port2,
    );
    assert!(
        out.status.success(),
        "query must succeed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let reply: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(reply["count"].as_u64().unwrap() > 0, "query returned no results");

    let _ = fs::remove_dir_all(&root);
}
