//! Test-only executable that drives the production Rust parser/store/search modules.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::thread;

#[path = "../../../../../index/src/bm25.rs"]
mod bm25;
#[path = "../../../../../index/src/config.rs"]
mod config;
#[path = "../../../../../index/src/constants.rs"]
mod constants;
#[path = "../../../../../index/src/embed.rs"]
mod embed;
#[path = "../../../../../index/src/graph.rs"]
mod graph;
#[path = "../../../../../index/src/parse.rs"]
mod parse;
#[path = "../../../../../index/src/search.rs"]
mod search;
#[path = "../../../../../index/src/store.rs"]
mod store;
#[path = "../../../../../index/src/util.rs"]
mod util;

// The production `config` module is included directly (it is self-contained
// and env-driven with deterministic defaults); the fake gateway below is wired
// in via an explicit `GatewayConfig`, so no `INDEX_*` env vars are needed.

fn embedding(text: &str) -> Vec<f32> {
    let lower = text.to_ascii_lowercase();
    if lower.contains("empty") || lower.contains("zero") || lower.contains("compute_total") {
        vec![1.0, 0.0, 0.0]
    } else if lower.contains("checkout") {
        vec![0.7, 0.3, 0.0]
    } else {
        vec![0.0, 1.0, 0.0]
    }
}

fn serve_fake_gateway(listener: TcpListener, request_count: usize) {
    for stream in listener.incoming().take(request_count) {
        let mut stream = stream.expect("accept fake gateway connection");
        let mut raw = Vec::new();
        let mut buf = [0_u8; 4096];
        loop {
            let n = stream.read(&mut buf).expect("read fake gateway request");
            raw.extend_from_slice(&buf[..n]);
            if let Some(split) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&raw[..split + 4]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if raw.len() >= split + 4 + length {
                    break;
                }
            }
        }
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let request: serde_json::Value =
            serde_json::from_slice(&raw[split..]).expect("parse embedding request");
        let inputs = request["input"].as_array().expect("embedding input array");
        let data: Vec<_> = inputs
            .iter()
            .enumerate()
            .map(|(index, value)| {
                serde_json::json!({
                    "index": index,
                    "embedding": embedding(value.as_str().unwrap_or_default())
                })
            })
            .collect();
        let body = serde_json::json!({"object": "list", "data": data}).to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("write fake gateway response");
    }
}

fn main() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixture_repo/planted_app/service.py");
    let source = fs::read_to_string(&fixture).expect("read planted fixture");
    let symbols = parse::extract("python", &source, "service");
    assert!(symbols.iter().any(|s| s.name == "compute_total"));
    assert!(symbols.iter().any(|s| s.name == "checkout"));
    let checkout = symbols.iter().find(|s| s.name == "checkout").unwrap();
    assert!(checkout.calls.iter().any(|name| name == "compute_total"));

    let mut chunks: Vec<store::Chunk> = symbols
        .into_iter()
        .map(|s| store::Chunk {
            id: format!("service.py:{}:{}", s.start_line, s.name),
            file: "planted_app/service.py".into(),
            lang: "python".into(),
            kind: s.kind,
            name: s.name,
            start_line: s.start_line,
            end_line: s.end_line,
            sha: util::sha256_hex(s.snippet.as_bytes()),
            summary: s.snippet.clone(),
            text: s.snippet,
            parent: s.parent,
            calls: s.calls,
            bases: s.bases,
            tags: Vec::new(),
            rank: 0.0,
            summary_pending: false,
            epoch: 0,
        })
        .collect();

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake gateway");
    let address = listener.local_addr().unwrap();
    let gateway = thread::spawn(move || serve_fake_gateway(listener, 2));
    let cfg = config::GatewayConfig {
        base_url: format!("http://{address}/v1"),
        api_key: "deterministic-test-key".into(),
        embedding_model: "fake-golden-embedding".into(),
        summary_model: "unused".into(),
    };
    let documents: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
    let vectors = embed::embed_all(&cfg, &documents).expect("index embeddings");
    let query = "empty checkout crashes with division by zero";
    let query_vector = embed::embed_one(&cfg, query).expect("query embedding");
    gateway.join().expect("fake gateway thread");

    let (edges, ranks, _pending) = graph::build(&chunks, &[]);
    for (chunk, rank) in chunks.iter_mut().zip(ranks) {
        chunk.rank = rank;
    }
    let docs: Vec<String> = chunks
        .iter()
        .map(|c| bm25::doc_for(&c.name, &c.summary, &c.text, &c.tags))
        .collect();
    let temp = std::env::temp_dir().join(format!("vinv-planted-index-{}", std::process::id()));
    let _ = fs::remove_dir_all(&temp);
    let mut index = store::Store::empty(
        temp.clone(),
        fixture.parent().unwrap().to_string_lossy().into_owned(),
        cfg.embedding_model,
        cfg.summary_model,
        Some("gateway".into()),
        "docstring".into(),
    );
    index.dim = 3;
    index.chunks = chunks;
    index.vectors = vectors.into_iter().flatten().collect();
    index.edges = edges;
    index.manifest = BTreeMap::from([(
        "planted_app/service.py".into(),
        util::sha256_hex(source.as_bytes()),
    )]);
    index.bm25 = Some(bm25::Bm25::build(&docs));
    index.save().expect("persist Rust index store");

    let loaded = store::Store::load(temp.clone())
        .expect("load Rust index store")
        .expect("stored index exists");
    let hits = search::hybrid(&loaded, &query_vector, query, 3, &HashSet::new());
    let names: HashSet<&str> = loaded.chunks.iter().map(|c| c.name.as_str()).collect();
    assert!(!hits.is_empty());
    let root = &loaded.chunks[hits[0].index];
    assert_eq!(root.name, "compute_total", "wrong root-cause symbol");
    assert_eq!(root.file, "planted_app/service.py", "wrong root-cause file");
    assert!(hits.iter().all(|hit| names.contains(loaded.chunks[hit.index].name.as_str())));
    fs::remove_dir_all(temp).expect("clean temporary Rust store");

    println!(
        "{}",
        serde_json::json!({
            "status": "ok",
            "parser": true,
            "store_roundtrip": true,
            "fake_gateway_requests": 2,
            "query_root": {"file": root.file, "symbol": root.name}
        })
    );
}
