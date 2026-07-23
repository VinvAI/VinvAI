//! Symbol summarization via an OpenAI-compatible chat endpoint
//! (`POST /chat/completions`). Opt-in via `--summarize`: when enabled, a
//! one-sentence description of each symbol joins the embedded text. The
//! default (no summaries) embeds the symbol's identifier, signature, and
//! docstring, and requires no chat-capable endpoint at all.

use std::time::Duration;

use serde_json::Value;

use crate::config::GatewayConfig;

const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ATTEMPTS: u32 = 3;

/// Character bound on the code shown to the summary model.
/// `INDEX_SUMMARY_INPUT_CHARS`, default 24000 (~6k tokens) — sized so a full
/// budget-length chunk fits; the old 3000-char cut hid most of large bodies.
fn summary_input_chars() -> usize {
    std::env::var("INDEX_SUMMARY_INPUT_CHARS")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .filter(|&n| n >= 500)
        .unwrap_or(24_000)
}

/// Return a one-line description of a symbol.
///
/// Two distinct failure classes get two distinct retries:
/// * transport/HTTP failures back off and retry the same request — feeding an
///   HTTP 429 back to the model would be meaningless;
/// * content violations (empty reply, code fences, rambling) retry with the
///   rejected reply and the rejection reason appended to the conversation, so
///   the model can correct itself instead of repeating the mistake.
///
/// A hard failure after all attempts is returned to the caller, which must
/// mark the chunk pending rather than silently embedding a heuristic.
pub fn summarize(
    cfg: &GatewayConfig,
    lang: &str,
    kind: &str,
    name: &str,
    snippet: &str,
) -> Result<String, String> {
    let mut rejection: Option<(String, String)> = None; // (previous reply, reason)
    let mut last_error = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(500 * (1 << attempt)));
        }
        match summarize_once(cfg, lang, kind, name, snippet, rejection.as_ref()) {
            Ok(text) => match validate_summary(&text) {
                Ok(clean) => return Ok(clean),
                Err(reason) => {
                    last_error = format!("rejected summary: {reason}");
                    rejection = Some((text, reason));
                }
            },
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// Mechanical acceptance check for a summary reply. Rejects what would poison
/// the embedding: emptiness, markdown/code fences, and unbounded rambling.
fn validate_summary(text: &str) -> Result<String, String> {
    let flat = text.trim().replace('\n', " ");
    if flat.is_empty() {
        return Err("the reply was empty".to_string());
    }
    if flat.contains("```") {
        return Err("the reply contained a code fence".to_string());
    }
    if flat.chars().count() > 600 {
        return Err("the reply exceeded 600 characters; one sentence only".to_string());
    }
    Ok(flat)
}

fn summarize_once(
    cfg: &GatewayConfig,
    lang: &str,
    kind: &str,
    name: &str,
    snippet: &str,
    rejection: Option<&(String, String)>,
) -> Result<String, String> {
    let max_chars = summary_input_chars();
    let code = if snippet.chars().count() > max_chars {
        snippet.chars().take(max_chars).collect::<String>()
    } else {
        snippet.to_string()
    };

    let system = crate::constants::SUMMARY_SYSTEM_PROMPT;
    // Substitute in a fixed order (code last) so an inserted value can never
    // be rescanned for a later placeholder.
    let user = crate::constants::SUMMARY_USER_TEMPLATE.to_string()
        .replace("{lang}", lang)
        .replace("{kind}", kind)
        .replace("{name}", name)
        .replace("{code}", &code);

    let mut messages = vec![
        serde_json::json!({ "role": "system", "content": system }),
        serde_json::json!({ "role": "user", "content": user }),
    ];
    // Feed a content rejection back so the retry corrects rather than repeats.
    if let Some((previous, reason)) = rejection {
        messages.push(serde_json::json!({ "role": "assistant", "content": previous }));
        messages.push(serde_json::json!({
            "role": "user",
            "content": crate::constants::SUMMARY_REPAIR_INSTRUCTION.replace("{reason}", reason),
        }));
    }

    let body = serde_json::json!({
        "model": cfg.summary_model,
        "temperature": 0,
        "messages": messages,
    });

    let url = cfg.endpoint("chat/completions");
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).build();
    let mut req = agent.post(&url).set("Content-Type", "application/json");
    if !cfg.api_key.is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", cfg.api_key));
    }

    let resp = match req.send_json(body) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let msg = r.into_string().unwrap_or_default();
            return Err(format!("chat HTTP {code}: {}", truncate(&msg, 200)));
        }
        Err(ureq::Error::Transport(t)) => return Err(format!("chat request failed: {t}")),
    };

    let data: Value = resp.into_json().map_err(|e| format!("chat: invalid JSON: {e}"))?;
    let text = data
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| "chat: response missing choices[0].message.content".to_string())?;

    Ok(text.trim().replace('\n', " "))
}

/// Heuristic one-liner used when summaries are disabled or the model call fails:
/// the symbol's first meaningful line (its signature), trimmed.
pub fn heuristic(kind: &str, name: &str, snippet: &str) -> String {
    let signature = snippet
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_end_matches('{')
        .trim();
    if signature.is_empty() {
        format!("{kind} {name}")
    } else {
        format!("{kind} {name}: {signature}")
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
    use super::validate_summary;

    #[test]
    fn accepts_a_plain_sentence_and_flattens_newlines() {
        assert_eq!(
            validate_summary("Loads the store\nfrom disk.").unwrap(),
            "Loads the store from disk."
        );
    }

    #[test]
    fn rejects_empty_fenced_and_rambling_replies() {
        assert!(validate_summary("   \n  ").is_err());
        assert!(validate_summary("```rust\nfn x() {}\n```").is_err());
        assert!(validate_summary(&"word ".repeat(200)).is_err());
    }
}
