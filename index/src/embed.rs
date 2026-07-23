//! Embedding via an OpenAI-compatible embeddings API (`POST /embeddings`).
//!
//! The default endpoint is the local embedding sidecar
//! (`vinv-embedder serve`, http://127.0.0.1:8776/v1) serving
//! `nomic-ai/CodeRankEmbed`; `INDEX_GATEWAY_URL` / `LITELLM_BASE_URL` point it
//! anywhere else. The [`Embedder`] owns the passage-vs-query distinction:
//! passages are embedded verbatim, queries get the CodeRankEmbed retrieval
//! instruction prefix.
//!
//! Connection failures and 429/5xx responses are retried with exponential
//! backoff for a bounded time (`INDEX_EMBED_MAX_RETRIES`), then surfaced with
//! an actionable error, so a briefly restarting sidecar does not kill an
//! hours-long indexing run.

use std::time::Duration;

use serde_json::Value;

use crate::config::{self, GatewayConfig};
use crate::constants;

const TIMEOUT: Duration = Duration::from_secs(120);

/// The embedding backend for one command run (an OpenAI-compatible gateway).
pub struct Embedder {
    cfg: GatewayConfig,
}

impl Embedder {
    /// Build the backend from the environment (never fails — defaults to the
    /// local sidecar with no API key).
    pub fn from_env() -> Self {
        Self { cfg: GatewayConfig::from_env() }
    }

    /// Backend tag persisted in the store (`meta.json`) so `query` can detect
    /// an index built with a different backend.
    pub fn backend(&self) -> &'static str {
        "gateway"
    }

    /// Model identifier recorded in the store's `embedding_model`.
    pub fn model_id(&self) -> String {
        self.cfg.embedding_model.clone()
    }

    /// Embed documents/passages (no query instruction), preserving input order.
    pub fn embed_passages(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>, String> {
        embed_all(&self.cfg, inputs)
    }

    /// Embed a single query. The CodeRankEmbed retrieval instruction is applied
    /// here so callers pass the raw query text.
    pub fn embed_query(&self, text: &str) -> Result<Vec<f32>, String> {
        let prefixed = format!("{}{}", constants::EMBED_QUERY_PREFIX, text);
        embed_one(&self.cfg, &prefixed)
    }
}

/// Embed every input, batching requests (`INDEX_EMBED_BATCH`, default 64).
/// Preserves input order. All rows are guaranteed to have the same dimension
/// (the first row's length).
pub fn embed_all(cfg: &GatewayConfig, inputs: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(inputs.len());
    for group in inputs.chunks(config::embed_batch()) {
        out.extend(embed_batch(cfg, group)?);
    }
    if let Some(dim) = out.first().map(Vec::len) {
        for (i, row) in out.iter().enumerate() {
            if row.len() != dim {
                return Err(format!(
                    "embedding dim mismatch at row {i}: {} vs {dim} (is the embedding model consistent?)",
                    row.len()
                ));
            }
        }
    }
    Ok(out)
}

/// Embed a single query string.
pub fn embed_one(cfg: &GatewayConfig, text: &str) -> Result<Vec<f32>, String> {
    let mut rows = embed_batch(cfg, std::slice::from_ref(&text.to_string()))?;
    rows.pop().ok_or_else(|| "embeddings: empty response".to_string())
}

fn embed_batch(cfg: &GatewayConfig, inputs: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let url = cfg.endpoint("embeddings");
    let body = serde_json::json!({ "model": cfg.embedding_model, "input": inputs });

    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).build();
    let attempts = config::embed_max_retries().saturating_add(1);
    let mut delay = Duration::from_millis(500);
    let mut last_error = String::new();

    for attempt in 1..=attempts {
        if attempt > 1 {
            std::thread::sleep(delay);
            delay = delay.saturating_mul(2).min(Duration::from_secs(8));
        }
        let mut req = agent.post(&url).set("Content-Type", "application/json");
        if !cfg.api_key.is_empty() {
            req = req.set("Authorization", &format!("Bearer {}", cfg.api_key));
        }
        match req.send_json(body.clone()) {
            Ok(resp) => {
                let data: Value =
                    resp.into_json().map_err(|e| format!("embeddings: invalid JSON: {e}"))?;
                return parse_embeddings(&data, inputs.len());
            }
            // Retryable: the server is overloaded or briefly down.
            Err(ureq::Error::Status(code, r)) if code == 429 || code >= 500 => {
                let msg = r.into_string().unwrap_or_default();
                last_error = format!("embeddings HTTP {code}: {}", truncate(&msg, 300));
            }
            // Any other HTTP status is a hard error (bad request, auth, ...).
            Err(ureq::Error::Status(code, r)) => {
                let msg = r.into_string().unwrap_or_default();
                return Err(format!("embeddings HTTP {code}: {}", truncate(&msg, 300)));
            }
            // Retryable: connection refused/reset, DNS, timeout.
            Err(ureq::Error::Transport(t)) => {
                last_error = format!("embeddings request failed: {t}");
            }
        }
    }

    Err(format!(
        "{last_error} (after {attempts} attempts against {url}) — no embedding server \
         reachable. Start the local sidecar with `vinv-embedder serve`, or point \
         {} (or {}) at an OpenAI-compatible embeddings endpoint. An interrupted \
         indexing run resumes from the last completed batch when re-run.",
        constants::ENV_GATEWAY_URL,
        constants::ENV_GATEWAY_URL_FALLBACK,
    ))
}

fn parse_embeddings(data: &Value, expected: usize) -> Result<Vec<Vec<f32>>, String> {
    let arr = data
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "embeddings: response missing `data` array".to_string())?;
    if arr.len() != expected {
        return Err(format!(
            "embeddings: expected {expected} vectors, got {}",
            arr.len()
        ));
    }
    // Require the server-reported indices to be an exact permutation so a
    // malformed response can never attach a vector to the wrong input.
    let mut rows: Vec<Option<Vec<f32>>> = vec![None; expected];
    let mut dimension: Option<usize> = None;
    for item in arr {
        let raw_idx = item
            .get("index")
            .and_then(Value::as_u64)
            .ok_or_else(|| "embeddings: item missing non-negative integer `index`".to_string())?;
        let idx = usize::try_from(raw_idx)
            .map_err(|_| format!("embeddings: index {raw_idx} cannot fit this platform"))?;
        if idx >= expected {
            return Err(format!(
                "embeddings: index {idx} outside expected range 0..{expected}"
            ));
        }
        if rows[idx].is_some() {
            return Err(format!("embeddings: duplicate index {idx}"));
        }
        let emb = item
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| "embeddings: item missing `embedding`".to_string())?;
        if emb.is_empty() {
            return Err(format!("embeddings: vector at index {idx} has zero dimensions"));
        }
        match dimension {
            Some(expected_dim) if emb.len() != expected_dim => {
                return Err(format!(
                    "embeddings: vector at index {idx} has dimension {}, expected {expected_dim}",
                    emb.len()
                ));
            }
            None => dimension = Some(emb.len()),
            _ => {}
        }
        let mut vector = Vec::with_capacity(emb.len());
        for (coordinate, value) in emb.iter().enumerate() {
            let numeric = value.as_f64().ok_or_else(|| {
                format!("embeddings: coordinate {coordinate} at index {idx} is not numeric")
            })?;
            let narrowed = numeric as f32;
            if !numeric.is_finite() || !narrowed.is_finite() {
                return Err(format!(
                    "embeddings: coordinate {coordinate} at index {idx} is not finite"
                ));
            }
            vector.push(narrowed);
        }
        rows[idx] = Some(vector);
    }
    rows.into_iter()
        .enumerate()
        .map(|(idx, row)| row.ok_or_else(|| format!("embeddings: missing index {idx}")))
        .collect()
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

    #[test]
    fn embedding_response_accepts_an_out_of_order_permutation() {
        let data = serde_json::json!({
            "data": [
                {"index": 1, "embedding": [3.0, 4.0]},
                {"index": 0, "embedding": [1.0, 2.0]}
            ]
        });
        assert_eq!(
            parse_embeddings(&data, 2).unwrap(),
            vec![vec![1.0, 2.0], vec![3.0, 4.0]]
        );
    }

    #[test]
    fn embedding_response_rejects_duplicate_or_out_of_range_indices() {
        for data in [
            serde_json::json!({
                "data": [
                    {"index": 0, "embedding": [1.0]},
                    {"index": 0, "embedding": [2.0]}
                ]
            }),
            serde_json::json!({
                "data": [
                    {"index": 0, "embedding": [1.0]},
                    {"index": 2, "embedding": [2.0]}
                ]
            }),
        ] {
            assert!(parse_embeddings(&data, 2).is_err());
        }
    }

    #[test]
    fn embedding_response_rejects_missing_or_non_numeric_indices() {
        for data in [
            serde_json::json!({"data": [{"embedding": [1.0]}]}),
            serde_json::json!({"data": [{"index": "0", "embedding": [1.0]}]}),
        ] {
            assert!(parse_embeddings(&data, 1).is_err());
        }
    }

    #[test]
    fn embedding_response_rejects_non_numeric_coordinates() {
        let data = serde_json::json!({
            "data": [{"index": 0, "embedding": [1.0, "not-a-number"]}]
        });
        assert!(parse_embeddings(&data, 1).is_err());
    }

    #[test]
    fn embedding_response_requires_nonzero_consistent_dimensions() {
        for data in [
            serde_json::json!({"data": [{"index": 0, "embedding": []}]}),
            serde_json::json!({
                "data": [
                    {"index": 0, "embedding": [1.0]},
                    {"index": 1, "embedding": [2.0, 3.0]}
                ]
            }),
        ] {
            assert!(parse_embeddings(&data, data["data"].as_array().unwrap().len()).is_err());
        }
    }
}
